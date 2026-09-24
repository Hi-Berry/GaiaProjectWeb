// [롤백 표시 2026-09-23 사용자] e2e: 롤백으로 되돌린 로그가 사라지지 않고 rolledBack 표시로 남는지 실제 서버로 확인.
//   사용자 제보: "롤백하면 있던 로그가 사라져서 헷갈린다 — 빨간 배경이나 엑스로 남겨 달라."
//   검증 항목 ①되돌린 엔트리가 로그에 남아 있다 ②rolledBack=true가 붙어 있다 ③살아 있는(표시 안 된) 엔트리 수는 줄었다
//            ④되돌린 지점 이후 새 행동이 붙어도 표시분은 그대로다 ⑤새 로그는 표시 엔트리 '뒤에' 정상으로 쌓이고 seq 단조 증가
//            ⑥저장 gameLog는 표시 제외(종전과 동일)·fullGameLog에는 표시 기록
//   사용: 1) PORT=5140 npx tsx server/index.ts   2) URL=http://localhost:5140 node script/testRollbackLogMark.mjs
import { io } from 'socket.io-client';
const URL = process.env.URL || 'http://localhost:5140';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const conn = () => new Promise((res, rej) => { const s = io(URL, { transports: ['websocket'] }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const call = (s, ev, p) => new Promise(res => s.emit(ev, p, (r) => res(r)));
const fail = (m) => { console.log('FAIL: ' + m); process.exit(1); };

const A = await conn();
const HOMEP = { terran: 'terra', lantids: 'terra', hadsch_hallas: 'volcanic', ivits: 'volcanic', geodens: 'volcanic',
  bal_tak: 'volcanic', xenos: 'desert', gleens: 'desert', taklons: 'swamp', ambas: 'swamp', bescods: 'titanium',
  firaks: 'titanium', itars: 'ice', nevlas: 'ice', moweyip: 'oxide', space_giants: 'oxide', tinkeroids: 'oxide', darkanians: 'terra' };
await call(A, 'admin_set_mcts_time_ms', { timeMs: 50 });
await call(A, 'admin_set_bot_delay_ms', { delayMs: 0 });
const c = await call(A, 'create_game', { playerName: 'RollbackTester' });
const gameId = c.gameId, me = c.playerId;
if (!gameId) fail('create_game 실패');
A.emit('auto_setup_test', { gameId });
await sleep(3000);
const get = async () => (await call(A, 'get_game', { gameId })).game;

// 시작 광산 단계: 내 차례가 오면 모행성 빈 칸에 놓는다(봇은 알아서 놓는다)
const HOME = { terran: 'terra', lantids: 'terra', hadsch_hallas: 'volcanic', ivits: 'volcanic', geodens: 'volcanic',
  bal_tak: 'volcanic', xenos: 'desert', gleens: 'desert', taklons: 'swamp', ambas: 'swamp', bescods: 'titanium',
  firaks: 'titanium', itars: 'ice', nevlas: 'ice', moweyip: 'oxide', space_giants: 'oxide', tinkeroids: 'oxide', darkanians: 'terra' };
for (let i = 0; i < 40; i++) {
  const gg = await get();
  if (gg.currentPhase !== 'startingMines') break;
  const meP = gg.players[me];
  const home = HOME[meP?.faction] ?? meP?.homePlanet;
  const free = (gg.map || []).find(t => t.type === home && !t.ownerId && !t.structure);
  if (free) A.emit('place_starting_mine', { gameId, tileId: free.id });
  await sleep(500);
}
await sleep(3000);

let g = await get();
const alive = (gg) => (gg.gameLog || []).filter(e => !e.rolledBack);
const marked = (gg) => (gg.gameLog || []).filter(e => e.rolledBack);
console.log(`시작: phase=${g.currentPhase} 로그 ${g.gameLog?.length ?? 0}개 (표시 ${marked(g).length})`);
if (!g.gameLog?.length) fail('로그가 비어 있음 — auto_setup 실패');

// 되돌릴 지점: 내 턴 시작 seq 중 하나(뒤에서 세 번째 정도)
const mine = (g.gameLog || []).filter(e => typeof e.seq === 'number');
const target = mine[Math.max(0, mine.length - 4)];
if (!target) fail('롤백 대상 로그 없음');
const beforeAlive = alive(g).length, beforeTotal = (g.gameLog || []).length;
const beforeKeys = new Set((g.gameLog || []).map(e => `${e.seq}|${e.playerId}|${e.action}`));
// 봇이 롤백 직후 즉시 새 행동으로 빈자리를 메우면 '살아있는 로그가 줄었는지'를 못 본다 → 잠시 멈춘다.
await call(A, 'admin_set_bot_delay_ms', { delayMs: 20000 });
console.log(`롤백 요청 → seq ${target.seq} (${target.playerName}: ${target.action})`);
const rb = await call(A, 'request_rollback', { gameId, seq: target.seq });
if (rb?.error) fail('request_rollback 거부: ' + rb.error);
await sleep(2500);

g = await get();
const afterAlive = alive(g).length, afterMarked = marked(g).length, afterTotal = (g.gameLog || []).length;
console.log(`롤백 후: 전체 ${afterTotal} (살아있음 ${afterAlive}, 표시 ${afterMarked}) | 롤백 전: 전체 ${beforeTotal}, 살아있음 ${beforeAlive}`);
console.log('  표시된 항목:', marked(g).slice(0, 5).map(e => `R${e.round} ${e.playerName}:${e.action}`).join(' / ') || '(없음)');

if (afterMarked === 0) fail('되돌린 로그가 표시되지 않음(종전처럼 삭제된 듯)');
if (afterAlive >= beforeAlive) fail(`살아있는 로그가 안 줄었다(${beforeAlive} → ${afterAlive})`);
if (afterTotal < beforeTotal) fail(`로그가 사라졌다(${beforeTotal} → ${afterTotal}) — 표시 보존 실패`);
if (!marked(g).every(e => e.rolledBack === true)) fail('rolledBack 플래그가 true가 아님');
const orphan = marked(g).filter(e => !beforeKeys.has(`${e.seq}|${e.playerId}|${e.action}`));
if (orphan.length) fail(`표시된 항목이 롤백 전 로그에 없던 것: ${orphan.length}건`);

// 롤백 이후 새 행동이 붙어도 표시분은 유지되는가 (봇 재개)
await call(A, 'admin_set_bot_delay_ms', { delayMs: 0 });
await sleep(4000);
const g2 = await get();
const m2 = marked(g2).length;
console.log(`새 행동 진행 후: 전체 ${(g2.gameLog || []).length} (살아있음 ${alive(g2).length}, 표시 ${m2})`);
if (m2 < afterMarked) fail(`표시분이 줄었다(${afterMarked} → ${m2})`);

// ⑤ 롤백 이후에도 새 로그가 '정상 엔트리'로 뒤에 쌓이는가 (사용자: "뒤에도 정상적으로 로그 쌓이는지 봐줘")
const markedBefore = marked(g2).length;
const idsBefore = new Set((g2.gameLog || []).map(e => `${e.timestamp}|${e.seq}|${e.action}`));
for (let i = 0; i < 40; i++) {
  const gg = await get();
  if (gg.currentPhase === 'startingMines') {
    const home = HOMEP[gg.players[me]?.faction];
    const free = (gg.map || []).find(t => t.type === home && !t.ownerId && !t.structure);
    if (free) A.emit('place_starting_mine', { gameId, tileId: free.id });
  } else if (gg.currentPhase === 'bonusSelection' && !gg.players[me]?.bonusTile) {
    const t = (gg.availableBonusTiles || [])[0]; if (t) A.emit('select_bonus_tile', { gameId, tileId: t.id });
  } else if (gg.currentPhase === 'main' && gg.turnOrder?.[gg.currentPlayerIndex] === me) {
    A.emit('pass_round', { gameId });
  }
  await sleep(400);
  const added = (await get()).gameLog.filter(e => !idsBefore.has(`${e.timestamp}|${e.seq}|${e.action}`));
  if (added.length >= 5) break;
}
const g3 = await get();
const all3 = g3.gameLog || [];
const fresh = all3.filter(e => !idsBefore.has(`${e.timestamp}|${e.seq}|${e.action}`));
const lastMarkedIdx = all3.map(e => !!e.rolledBack).lastIndexOf(true);
const freshIdx = fresh.map(e => all3.indexOf(e));
console.log(`롤백 후 진행: 새 로그 ${fresh.length}개 | 전체 ${all3.length} (표시 ${marked(g3).length}) | 새 로그 예: ${fresh.slice(0,4).map(e => `${e.playerName}:${e.action}`).join(' / ')}`);
if (fresh.length === 0) fail('롤백 이후 새 로그가 전혀 안 쌓였다');
if (fresh.some(e => e.rolledBack)) fail('새 로그에 롤백 표시가 잘못 붙었다');
if (marked(g3).length !== markedBefore) fail(`표시 개수가 변했다(${markedBefore} → ${marked(g3).length})`);
if (Math.min(...freshIdx) <= lastMarkedIdx) fail('새 로그가 표시 엔트리보다 앞에 끼어들었다(순서 깨짐)');
const seqs = all3.filter(e => !e.rolledBack && typeof e.seq === 'number').map(e => e.seq);
if (seqs.some((v, i) => i > 0 && v < seqs[i - 1])) fail('살아있는 로그의 seq가 역행한다');
console.log('PASS: 롤백 이후 새 로그가 표시 엔트리 뒤에 정상(표시 없음)으로 쌓이고 seq도 단조 증가');

// ⑥ 저장 파일(gameLog)에는 표시 엔트리가 빠지고, 분석용 fullGameLog에는 표시가 남는가
const snap = await call(A, 'export_game_snapshot', { gameId });
const pay = snap?.payload;
if (!pay) fail('export_game_snapshot 실패: ' + (snap?.error ?? '응답 없음'));
const savedMarked = (pay.gameLog || []).filter(e => e.rolledBack).length;
const fullMarked = (pay.fullGameLog || []).filter(e => e.rolledBack).length;
console.log(`저장 payload: gameLog ${pay.gameLog?.length ?? 0}개(표시 ${savedMarked}) · fullGameLog ${pay.fullGameLog?.length ?? 0}개(표시 ${fullMarked})`);
if (savedMarked !== 0) fail('저장 gameLog에 표시 엔트리가 섞였다 — 뱃지/통계가 안 한 행동을 센다');
if ((pay.gameLog || []).length !== alive(g3).length) fail(`저장 gameLog 수가 살아있는 로그 수와 다르다(${pay.gameLog?.length} vs ${alive(g3).length})`);
if (fullMarked === 0) fail('fullGameLog에 롤백 표시가 없다 — 사후 분석이 유령 행동을 못 거른다');

console.log('PASS: 되돌린 로그가 rolledBack 표시로 보존되고, 살아있는 로그만 줄었으며, 이후 진행에도 표시가 유지됨');
console.log('PASS: 저장 gameLog는 종전과 동일(표시 제외) · 분석용 fullGameLog에는 롤백 표시 기록');
process.exit(0);
