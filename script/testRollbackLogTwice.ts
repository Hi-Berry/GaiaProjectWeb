/**
 * 롤백을 겹쳐 할 때 되돌린 로그가 빠짐없이 ✕ 로 표시되는지 — 실서버 회귀 테스트.
 *
 * 사용자 제보(2026-10-05): "리셋했을 때 로그가 깔끔하게 안 남는다. 3턴 돌렸을 때 리셋한 로그 2개만 ✕ 표시되고…"
 *   서버는 'seq 차이 = 되돌릴 줄 수'로 보고 로그 꼬리에서 그만큼 잘랐다. 그런데 롤백한 줄은 ✕ 로 꼬리에 남으므로,
 *   이전 롤백보다 앞 지점으로 다시 롤백하면 꼬리의 ✕ 줄을 다시 세고 정작 되돌린 줄은 '실제 행동'처럼 남았다
 *   (재현: 25번 지점 롤백 → 21번 지점 롤백 → 21~24번 4줄이 ✕ 없이 잔류).
 *
 * 사람 1 + 봇 3 (다른 사람이 없어 롤백 요청이 투표 없이 바로 실행된다).
 *   ① 1차 롤백: 지점 이후 살아 있던 줄이 전부 ✕
 *   ② 2차 롤백(1차보다 앞): 지점 이후 '살아 있는' 줄이 하나도 없다 · ✕ 가 되돌린 줄 수만큼 늘었다
 *   ③ 그 뒤 새 행동이 정상 줄로 쌓이고, 살아 있는 줄의 seq 가 단조 증가한다
 *
 * 사용: 서버를 5050에 띄운 뒤 npx tsx script/testRollbackLogTwice.ts   (exit 2 = 다시 실행)
 */
import { io } from 'socket.io-client';
import { FACTIONS } from '@shared/gameConfig';

const A = io(process.env.URL ?? 'http://localhost:5050', { transports: ['websocket'] });
const call = (ev: string, p: any) => new Promise<any>((res) => A.emit(ev, p, res));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
setTimeout(() => { console.log('RETRY 시간 초과'); process.exit(2); }, 240_000);
let gameId = '', me = '';
const get = async () => (await call('get_game', { gameId })).game;
const live = (g: any) => (g.gameLog || []).filter((e: any) => !e.rolledBack && typeof e.seq === 'number');
const marked = (g: any) => (g.gameLog || []).filter((e: any) => e.rolledBack);
const show = (e: any) => `#${e.seq} ${e.playerName}:${e.action}`;

async function progressUntil(pred: (g: any) => boolean, ms: number) {
	const t = Date.now();
	while (Date.now() - t < ms) {
		const g = await get();
		if (pred(g)) return g;
		if (g.pendingIncomeOrder?.playerId === me) { A.emit('select_all_income_items', { gameId }); await sleep(100); A.emit('finish_income_selection', { gameId }); }
		else if (g.turnOrder?.[g.currentPlayerIndex] === me) {
			if (g.currentPhase === 'startingMines') {
				const home = FACTIONS.find((f: any) => f.id === g.players[me]?.faction)?.homePlanet;
				const t2 = g.map.find((x: any) => !x.ownerId && x.type === home);
				if (t2) A.emit('place_starting_mine', { gameId, tileId: t2.id, factionId: g.players[me].faction });
			} else if (g.currentPhase === 'bonusSelection') {
				const b = (g.availableBonusTiles || [])[0]; if (b) A.emit('select_bonus_tile', { gameId, bonusTileId: b.id ?? b });
			} else if (g.currentPhase === 'main' && !g.players[me]?.hasPassed) {
				const b = (g.availableBonusTiles || [])[0]; A.emit('pass_round', { gameId, newBonusTileId: b?.id ?? b });
			}
		}
		await sleep(300);
	}
	return null;
}

A.on('connect', async () => {
	await call('admin_set_mcts_time_ms', { timeMs: 50 });
	await call('admin_set_bot_delay_ms', { delayMs: 150 });
	const c = await call('create_game', { playerName: 'Solo' }); gameId = c.gameId; me = c.playerId;
	A.emit('auto_setup_test', { gameId, selfPlay: false });
	if (!await progressUntil((g) => g.currentPhase === 'main' && live(g).length >= 30, 150_000)) { console.log('RETRY 로그가 충분히 안 쌓였다'); process.exit(2); }
	await call('admin_set_bot_delay_ms', { delayMs: 60_000 }); await sleep(800);

	// ① 1차 롤백 — 끝에서 6번째 줄 지점
	let g = await get();
	let L = live(g);
	const p1 = L[L.length - 6];
	const liveAfterP1Before = L.filter((e: any) => e.seq >= p1.seq).length;
	const r1 = await call('request_rollback', { gameId, seq: p1.seq, reason: { code: 'otherAction' } });
	if (r1?.error) { console.log('RETRY 1차 롤백 거부:', r1.error); process.exit(2); }
	await sleep(1200);
	g = await get();
	const x1 = marked(g).length;
	check(x1 >= liveAfterP1Before && live(g).every((e: any) => e.seq < p1.seq),
		`① 1차 롤백(${show(p1)} 지점): ✕ ${x1}줄, 지점 이후 살아 있는 줄 ${live(g).filter((e: any) => e.seq >= p1.seq).length}개`);

	// ② 2차 롤백 — 1차에서 ✕ 된 첫 줄보다 4줄 앞. 롤백은 그 줄이 속한 '턴의 시작'으로 가므로 그 앞줄까지 되돌 수 있다.
	//    봇이 롤백 직후 바로 움직여야 ③을 볼 수 있으니 대기를 먼저 푼다 — 비교는 seq 가 아니라 줄 식별자로 한다.
	const key = (e: any) => `${e.timestamp}|${e.seq}|${e.playerId}|${e.action}`;
	const firstX = Math.min(...marked(g).map((e: any) => e.seq));
	L = live(g);
	const before = L.filter((e: any) => e.seq < firstX);
	const p0 = before[before.length - 4];
	const liveBefore = new Map(L.map((e: any) => [key(e), e]));
	await call('admin_set_bot_delay_ms', { delayMs: 150 });
	const r2 = await call('request_rollback', { gameId, seq: p0.seq, reason: { code: 'otherAction' } });
	if (r2?.error) { console.log('RETRY 2차 롤백 거부:', r2.error); process.exit(2); }
	await sleep(600);
	g = await get();
	const liveNow = new Set(live(g).map(key));
	const markedNow = new Set(marked(g).map(key));
	const undone = [...liveBefore.values()].filter((e: any) => !liveNow.has(key(e)));
	const ghosts = [...liveBefore.values()].filter((e: any) => e.seq >= p0.seq && liveNow.has(key(e)));
	check(ghosts.length === 0, `② 2차 롤백(${show(p0)} 지점, 1차보다 앞) 뒤 고른 줄 이후가 '살아 있는' 채로 남은 줄 ${ghosts.length}개 ${ghosts.slice(0, 6).map(show).join(', ')}`);
	check(undone.length >= 4 && undone.every((e: any) => markedNow.has(key(e))), `② 되돌린 ${undone.length}줄이 모두 ✕ 로 남았다 (${undone.map(show).join(', ')})`);

	// ③ 이후 새 행동이 정상 줄로 쌓인다
	const liveN = live(g).length - [...liveNow].filter((k) => !liveBefore.has(k)).length; // 롤백 직후 이미 붙은 새 줄 제외
	const g3 = await progressUntil((gg) => live(gg).length >= liveN + 3, 40_000);
	if (!g3) { console.log('RETRY 롤백 뒤 새 행동이 안 쌓였다'); process.exit(2); }
	const seqs = live(g3).map((e: any) => e.seq);
	check(seqs.every((v: number, i: number) => i === 0 || v > seqs[i - 1]), `③ 롤백 뒤 새 줄 ${live(g3).length - liveN}개가 정상으로 쌓이고 살아 있는 줄의 seq 가 단조 증가`);

	console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
	process.exit(bad === 0 ? 0 : 1);
});
