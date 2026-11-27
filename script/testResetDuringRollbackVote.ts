/**
 * 롤백 투표 중 리셋·되돌리기 차단 — 실서버 회귀 테스트.
 *
 * 사용자 제보(2026-11-27 "최신 게임 시간 버그", bluef9el): 롤백 투표 중 차례인 사람이 '리셋'을 누르면 턴 시작
 * 스냅샷(투표 전)이 통째로 복원되며 투표가 사라졌고, 투표 끝 표시(pause_end)가 안 찍혀 게임 끝까지 모두의 사용 시간이 멈췄다.
 * ① 투표 중 reset_turn / undo_free_action → 거부 메시지, 투표 유지
 * ② 투표 거절 뒤 리셋은 정상 동작
 *
 * 사용: 서버를 띄운 뒤 URL=http://localhost:포트 npx tsx script/testResetDuringRollbackVote.ts
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
const errs: string[] = [];
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

A.on('game_error', (e: any) => errs.push(`A:${e?.message}`));
B.on('game_error', (e: any) => errs.push(`B:${e?.message}`));

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
	const [cur, other] = curId === aId ? [A, B] : [B, A];
	const curTag = curId === aId ? 'A' : 'B';

	// 롤백 대상: 지금 살아 있는 마지막 줄(그 줄 직전 턴 시작으로)
	const target = [...live()].reverse().find((e: any) => typeof e.seq === 'number');
	const rr = await emit<any>(other, 'request_rollback', { gameId, seq: target.seq, reason: REASON });
	check(!rr?.error, `롤백 요청 (${rr?.error ?? 'ok'})`);
	await sleep(400);
	check(!!lastA.pendingRollback, '롤백 투표가 열림');

	// ① 투표 중 리셋·되돌리기
	errs.length = 0;
	cur.emit('reset_turn', { gameId });
	await sleep(600);
	check(!!lastA.pendingRollback, '투표 중 리셋 → 투표가 그대로 남아 있음');
	check(errs.some((m) => m.startsWith(curTag) && /롤백 투표 중에는 리셋/.test(m)), `리셋 거부 안내 (${errs.join(' | ')})`);
	errs.length = 0;
	cur.emit('undo_free_action', { gameId });
	await sleep(600);
	check(!!lastA.pendingRollback, '투표 중 되돌리기 → 투표가 그대로 남아 있음');
	check(errs.some((m) => m.startsWith(curTag) && /롤백 투표 중에는 되돌릴/.test(m)), `되돌리기 거부 안내 (${errs.join(' | ')})`);

	// ② 거절로 투표를 닫은 뒤엔 리셋이 다시 된다(막지 않음)
	await emit(cur, 'respond_rollback', { gameId, accept: false, playerId: curId });
	await sleep(600);
	check(!lastA.pendingRollback, '거절 → 투표 닫힘');
	errs.length = 0;
	cur.emit('reset_turn', { gameId });
	await sleep(600);
	check(!errs.some((m) => /롤백 투표 중/.test(m)), `투표 뒤 리셋은 막히지 않음 (${errs.join(' | ') || '오류 없음'})`);
	finish();
});
