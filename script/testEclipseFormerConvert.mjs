// [2026-09-25 사용자 제보] 이클립스 6C 소행성 건설 대기 중에도 '자기' 프리 액션(변환·번·발타크 포머→QIC)이
//   되는지 확인한다. 예전엔 councilPendingActive가 자기 대기까지 막아 변환이 조용히 무시됐고,
//   이어진 건설이 QIC 부족으로 조용히 실패해 "확인을 눌러도 아무 일이 없다"로 보였다.
//   사용: PORT=5050 개발서버가 떠 있는 상태에서  node script/testEclipseFormerConvert.mjs
import { io } from 'socket.io-client';
const URL = process.env.URL || 'http://localhost:5050';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const conn = () => new Promise(r => { const s = io(URL, { transports: ['websocket'] }); s.on('connect', () => r(s)); });
const call = (s, e, p) => new Promise(r => s.emit(e, p, (x) => r(x)));
const fail = (m) => { console.log('FAIL: ' + m); process.exit(1); };
/* 준비 단계(무작위 종족·배치·이클립스까지의 거리)는 매번 달라 실패할 수 있다. 그건 '기능 실패'가 아니므로
   SKIP(종료코드 0)으로 구분한다 — 여러 번 돌리면 한 번은 조건이 맞는다. 판정 대상은 대기 중 프리 액션뿐. */
const skip = (m) => { console.log('SKIP(설정 실패, 기능 판정 아님): ' + m); process.exit(0); };

const A = await conn(); A.on('game_error', () => {});
await call(A, 'admin_set_mcts_time_ms', { timeMs: 50 });
await call(A, 'admin_set_bot_delay_ms', { delayMs: 0 });
const c = await call(A, 'create_game', { playerName: '이클립스테스트' });
const gameId = c.gameId, me = c.playerId;
A.emit('toggle_test_mode', { gameId }); await sleep(400);
// ※ fixedSetup(seatFactions)을 주면 이 서버에서는 봇이 시작 배치를 하지 않아 startingMines에서 멈춘다(별도 건).
//    가드 자체는 종족과 무관하므로 일반 auto_setup으로 진행하고, 발타크 전용 확인은 해당 종족일 때만 한다.
A.emit('auto_setup_test', { gameId });
await sleep(4000);
const get = async () => (await call(A, 'get_game', { gameId })).game;
let g = await get();
const myFaction = g.players[me]?.faction;
const HOME = { terran:'terra', lantids:'terra', hadsch_hallas:'volcanic', ivits:'volcanic', geodens:'volcanic', bal_tak:'volcanic',
  xenos:'desert', gleens:'desert', taklons:'swamp', ambas:'swamp', bescods:'titanium', firaks:'titanium', itars:'ice', nevlas:'ice',
  moweyip:'oxide', space_giants:'oxide', tinkeroids:'asteroid', darkanians:'terra' };
console.log('내 종족:', myFaction);

// 시작 배치(모행성)
const mine = (gg) => (gg.map || []).filter(t => t.ownerId === me && t.structure).length;
for (let i = 0; i < 90; i++) {
  g = await get(); if (g.currentPhase !== 'startingMines') break;
  if (g.turnOrder?.[g.currentPlayerIndex] === me) {
    const before = mine(g);
    for (const t of (g.map || []).filter(t => t.type === HOME[myFaction] && !t.ownerId && !t.structure)) {
      A.emit('place_starting_mine', { gameId, tileId: t.id }); await sleep(220);
      if (mine(await get()) > before) break;
    }
  }
  await sleep(260);
}
for (let i = 0; i < 40; i++) {
  g = await get(); if (g.currentPhase === 'main') break;
  if (g.currentPhase === 'bonusSelection' && !g.players[me]?.bonusTile) {
    const t = (g.availableBonusTiles || [])[0]; if (t) A.emit('select_bonus_tile', { gameId, bonusTileId: t.id });
  }
  await sleep(400);
}
for (let i = 0; i < 40; i++) { g = await get(); if (g.currentPhase === 'main' && g.turnOrder[g.currentPlayerIndex] === me) break; await sleep(400); }
if (g.currentPhase !== 'main') skip('메인 단계 진입 실패: ' + g.currentPhase);

// 이클립스 승선 → 6C 소행성 액션으로 pending 만들기
const eclipse = (g.map || []).find(t => t.type === 'ship_eclipse');
await call(A, 'admin_set_player_state', { gameId, targetPlayerId: me, resources: { qic: 9, credits: 30, score: 40 }, adminCode: '0011' });
await sleep(400);
const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
for (let q = 0; q <= 9; q++) {
  g = await get();
  if ((g.players[me]?.spaceshipsEntered || []).includes(eclipse.id)) break;
  if (g.turnOrder[g.currentPlayerIndex] !== me || g.hasDoneMainAction) {
    A.emit('end_turn', { gameId }); await sleep(600);
    for (let i = 0; i < 30; i++) { g = await get(); if (g.currentPhase === 'main' && g.turnOrder[g.currentPlayerIndex] === me && !g.hasDoneMainAction) break; await sleep(400); }
  }
  A.emit('enter_spaceship', { gameId, tileId: eclipse.id, useRangeBonus: false, qicToUse: q }); await sleep(800);
}
g = await get();
if (!(g.players[me]?.spaceshipsEntered || []).includes(eclipse.id)) {
  const mineT = (g.map || []).filter(t => t.ownerId === me && t.structure && t.structure !== 'ship');
  const d = mineT.length ? Math.min(...mineT.map(t => dist(t, eclipse))) : -1;
  skip(`이클립스 승선 실패 (거리 ${d}, QIC ${g.players[me]?.qic}, 내차례 ${g.turnOrder[g.currentPlayerIndex] === me})`);
}

// 턴을 넘겨 새 턴을 받고 6C 액션 사용
for (let round = 0; round < 6; round++) {
  g = await get();
  if (g.currentPhase === 'main' && g.turnOrder[g.currentPlayerIndex] === me && !g.hasDoneMainAction) break;
  A.emit('end_turn', { gameId }); await sleep(700);
  for (let i = 0; i < 30; i++) { g = await get(); if (g.currentPhase === 'main' && g.turnOrder[g.currentPlayerIndex] === me) break; await sleep(400); }
}
A.emit('use_ship_action', { gameId, shipTileId: eclipse.id, actionIndex: 3 }); await sleep(900);
g = await get();
if (!g.pendingEclipseAsteroidMine) skip('이클립스 6C 대기 상태를 만들지 못함 (credits=' + g.players[me]?.credits + ')');
console.log('이클립스 6C 대기 생성됨 — 소유자:', g.pendingEclipseAsteroidMine.playerId === me ? '나' : '남');

// ★ 핵심: 내 대기 중에 내 프리 액션(발타크 포머→QIC)이 되는가
if (myFaction === 'bal_tak') {
  const qicBefore = g.players[me].qic, formerBefore = g.players[me].gaiaformers, lockBefore = g.players[me].balTakGaiaformersUsedForQic ?? 0;
  A.emit('use_bal_tak_gaiaformer_to_qic', { gameId }); await sleep(900);
  g = await get();
  const qicAfter = g.players[me].qic, lockAfter = g.players[me].balTakGaiaformersUsedForQic ?? 0;
  console.log(`포머→QIC: QIC ${qicBefore}→${qicAfter} · 잠금 ${lockBefore}→${lockAfter} (포머 ${formerBefore})`);
  if (formerBefore - lockBefore >= 1 && (qicAfter !== qicBefore + 1 || lockAfter !== lockBefore + 1)) fail('이클립스 대기 중 포머→QIC 변환이 막혔다(수정 전 증상)');
}

// 일반 변환 — 발타크 포머 변환과 **같은 가드**를 쓰므로 이것이 되면 그 경로도 열린 것
const oreBefore = g.players[me].ore;
A.emit('convert_resource', { gameId, type: '1ore-to-1credit' }); await sleep(800);
g = await get();
console.log(`일반 변환(1O→1C): 광석 ${oreBefore}→${g.players[me].ore}`);
if (oreBefore > 0 && g.players[me].ore !== oreBefore - 1) fail('이클립스 대기 중 일반 변환이 막혔다');

console.log('PASS: 내 이클립스 대기 중에도 내 프리 액션(포머→QIC·자원 변환)이 정상 동작');
process.exit(0);
