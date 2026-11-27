/**
 * 롤백 취소 — 실서버 회귀 테스트.
 *
 * 사용자 요청(2026-11-27): "롤백으로 롤백했는데 그 롤백 아무거나 찍고 롤백 취소 요청하면 그 부분 삭제되고 다시 하던 대로.
 *   (아직 턴 아무도 안 한 마지막 롤백에서만 사용할 수 있어)"
 *
 * ① 사람 차례에 패스 → 다른 사람이 그 패스 직전으로 롤백 → 롤백 취소 요청 → 동의 → 패스한 상태로 복귀,
 *    ✕ 표시가 풀리고, 원래 롤백 요청자의 롤백 횟수가 돌려받아진다.
 * ② 다시 롤백한 뒤 누군가 행동하면 → 롤백 취소 요청이 거부된다.
 *
 * 사용: 서버를 띄운 뒤 URL=http://localhost:포트 npx tsx script/testRollbackUndo.ts
 */
import { io, type Socket } from 'socket.io-client';
import { FACTIONS, ROLLBACK_REASONS } from '@shared/gameConfig';

const URL = process.env.URL ?? 'http://localhost:5050';
const A = io(URL, { transports: ['websocket'] });
const B = io(URL, { transports: ['websocket'] });
let gameId = '', aId = '', bId = '';
let lastA: any = null, driving = true;
const placed = new Set<string>(); const picked = new Set<string>(); const incomeKey: Record<string, string> = {};
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emit = <T = any>(s: Socket, ev: string, p: any) => new Promise<T>((res) => s.emit(ev, p, (r: T) => res(r)));
const finish = () => { console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`); A.close(); B.close(); process.exit(bad === 0 ? 0 : 1); };
setTimeout(() => { console.log('RETRY 시간 초과'); process.exit(2); }, 180_000);
const REASON = { code: ROLLBACK_REASONS[0].code, text: ROLLBACK_REASONS[0].code === 'custom' ? '테스트' : undefined };

function drive(sock: Socket, me: string, g: any) {
	if (!driving || !g?.players) return;
	if (g.pendingIncomeOrder?.playerId === me) {
		const k = JSON.stringify(g.pendingIncomeOrder.incomeItems ?? []);
		if (incomeKey[me] !== k) { incomeKey[me] = k; sock.emit('select_all_income_items', { gameId }); setTimeout(() => sock.emit('finish_income_selection', { gameId }), 120); }
		return;
	}
	if (g.turnOrder?.[g.currentPlayerIndex] !== me) return;
	if (g.currentPhase === 'startingMines') {
		const home = FACTIONS.find((f: any) => f.id === g.players[me]?.faction)?.homePlanet;
		const t = (g.map || []).find((x: any) => !x.ownerId && x.type === home && !placed.has(x.id));
		if (t) { placed.add(t.id); sock.emit('place_starting_mine', { gameId, tileId: t.id, factionId: g.players[me]?.faction }); }
	} else if (g.currentPhase === 'bonusSelection' && !picked.has(me)) {
		const t = (g.availableBonusTiles || [])[0];
		if (t) { picked.add(me); sock.emit('select_bonus_tile', { gameId, bonusTileId: t.id ?? t }); }
	}
}
A.on('game_updated', (g: any) => { lastA = g; drive(A, aId, g); });
B.on('game_updated', (g: any) => { drive(B, bId, g); });
setInterval(() => { if (lastA) { drive(A, aId, lastA); drive(B, bId, lastA); } }, 600);

const live = () => (lastA?.gameLog ?? []).filter((e: any) => !e.rolledBack);
const used = (id: string) => lastA?.rollbackUsage?.used?.[id] ?? 0;

A.on('connect', async () => {
	await emit(A, 'admin_set_mcts_time_ms', { timeMs: 50 });
	await emit(A, 'admin_set_bot_delay_ms', { delayMs: 4000 });
	const r = await emit<any>(A, 'create_game', { playerName: 'Alpha' }); gameId = r.gameId; aId = r.playerId;
	bId = (await emit<any>(B, 'join_game', { gameId, playerName: 'Beta' })).playerId;
	A.emit('auto_setup_test', { gameId, selfPlay: false });

	const isHumanTurn = () => lastA?.currentPhase === 'main' && [aId, bId].includes(lastA.turnOrder?.[lastA.currentPlayerIndex]) && !lastA.pendingIncomeOrder && !lastA.pendingTurnEndPlayerId && !lastA.hasDoneMainAction;
	const t0 = Date.now(); while (!isHumanTurn() && Date.now() - t0 < 120_000) await sleep(200);
	if (!isHumanTurn()) { console.log('RETRY 사람 메인 차례가 오지 않았다'); process.exit(2); }
	driving = false;
	const curId = lastA.turnOrder[lastA.currentPlayerIndex];
	const [cur, other, otherId] = curId === aId ? [A, B, bId] : [B, A, aId];
	console.log(`현재 차례: ${curId === aId ? 'Alpha' : 'Beta'}`);

	// ① 패스 → 롤백 → 롤백 취소
	const tile = (lastA.availableBonusTiles || [])[0];
	cur.emit('pass_round', { gameId, newBonusTileId: tile.id ?? tile });
	await sleep(1200);
	check(!!lastA.players[curId].hasPassed, '패스함');
	const passLine = [...live()].reverse().find((e: any) => e.playerId === curId && typeof e.seq === 'number');
	const liveCountBefore = live().length;
	const usedBefore = used(otherId);
	const rr = await emit<any>(other, 'request_rollback', { gameId, seq: passLine.seq, reason: REASON });
	check(!rr?.error, `롤백 요청 (${rr?.error ?? 'ok'})`);
	await sleep(300);
	await emit(cur, 'respond_rollback', { gameId, accept: true, playerId: curId });
	await sleep(1000);
	check(!lastA.players[curId].hasPassed, '롤백 → 패스 전으로 돌아감');
	check(used(otherId) === usedBefore + 1, `롤백 횟수 1 사용 (${usedBefore}→${used(otherId)})`);
	const ru = lastA.rollbackUndo;
	check(!!ru && ru.seqs.length > 0 && ru.seqs.includes(passLine.seq), `롤백 취소 가능 표시 + ✕ 줄 seq 포함 (${JSON.stringify(ru?.seqs)})`);

	// 화면 확인용: STOP_AFTER_ROLLBACK=1이면 여기서 멈추고 좌석 링크를 찍는다(소켓 유지)
	if (process.env.STOP_AFTER_ROLLBACK) { console.log(`STOP ${URL}/game/${gameId}?as=${curId} other=${otherId}`); return; }
	const ur = await emit<any>(cur, 'request_rollback_undo', { gameId });
	check(!ur?.error, `롤백 취소 요청 (${ur?.error ?? 'ok'})`);
	await sleep(300);
	check(lastA.pendingRollback?.kind === 'undo', '롤백 취소 투표가 열림');
	await emit(other, 'respond_rollback', { gameId, accept: true, playerId: otherId });
	await sleep(1200);
	check(!!lastA.players[curId].hasPassed, '롤백 취소 → 다시 패스한 상태');
	check(!lastA.gameLog.some((e: any) => e.rolledBack && e.seq === passLine.seq && e.playerId === curId && e.action === passLine.action), '패스 줄의 ✕ 표시가 풀림');
	const undoLog = [...lastA.gameLog].reverse().find((e: any) => e.action === 'Rollback');
	check(!!undoLog && /롤백 취소/.test(undoLog.details ?? ''), `롤백 취소 로그 (${undoLog?.details})`);
	check(used(otherId) === usedBefore, `롤백 횟수 돌려받음 (${used(otherId)})`);
	check(!lastA.rollbackUndo, '롤백 취소 후엔 다시 취소할 롤백 없음');
	check(live().length >= liveCountBefore, `살아 있는 로그 줄 복구 (${liveCountBefore}→${live().length})`);

	// ② 다시 롤백 → 누군가 행동 → 롤백 취소 거부
	await sleep(500);
	const rr2 = await emit<any>(other, 'request_rollback', { gameId, seq: passLine.seq, reason: REASON });
	check(!rr2?.error, `두 번째 롤백 요청 (${rr2?.error ?? 'ok'})`);
	await sleep(300);
	await emit(cur, 'respond_rollback', { gameId, accept: true, playerId: curId });
	await sleep(1000);
	check(!!lastA.rollbackUndo, '두 번째 롤백 뒤 취소 가능');
	const tile2 = (lastA.availableBonusTiles || [])[0];
	cur.emit('pass_round', { gameId, newBonusTileId: tile2.id ?? tile2 });
	await sleep(1200);
	check(!lastA.rollbackUndo, '롤백 뒤 행동하면 취소 표시가 사라짐');
	const ur2 = await emit<any>(other, 'request_rollback_undo', { gameId });
	check(!!ur2?.error, `행동 뒤 롤백 취소 요청은 거부 (${ur2?.error})`);
	finish();
});
