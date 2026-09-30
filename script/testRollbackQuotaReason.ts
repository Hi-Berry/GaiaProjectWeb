/**
 * 롤백 횟수 제한 + 요청 사유 — 실서버 회귀 테스트.
 *
 * 사용자 요청(2026-09-30):
 *   "롤백 요청하면 (1/3) → (2/3) → (3/3) → 다음엔 '롤백 사용 횟수를 모두 사용했습니다'.
 *    어드민에 잔여 횟수 표기·수정. 요청 창에 사유(파워 수락 여부 변경 … 기타 직접 입력)를 골라
 *    다른 사람들이 보고 수락/거절."
 *
 * 사람 좌석 둘(알파·베타)을 직접 몰아 라운드 2까지 진행한 뒤 확인한다.
 *   ① 사유 없이 요청 → 거부         ② 기타인데 빈 글 → 거부
 *   ③ 사유를 골라 요청 → 베타 화면에 사유·(1/3)이 실린다
 *   ④ 베타가 거절 → 횟수 그대로(다음 요청도 1/3)
 *   ⑤ 동의 받아 3번 실행 → used 3, 네 번째 요청은 '모두 사용했습니다'
 *   ⑥ 관리자: 틀린 비번 거부 · 잔여 1로 고치면 다시 요청 가능(4/4)
 *
 * 사용: 서버를 5050에 띄운 뒤 npx tsx script/testRollbackQuotaReason.ts
 */
import { io, type Socket } from 'socket.io-client';
import { FACTIONS, ROLLBACK_LIMIT_PER_PLAYER, getRollbackQuota } from '@shared/gameConfig';

const URL = process.env.URL ?? 'http://localhost:5050';
const A = io(URL, { transports: ['websocket'] });
const B = io(URL, { transports: ['websocket'] });
let gameId = '', aId = '', bId = '';
let lastA: any = null, lastB: any = null;
let driving = true;
const placed = new Set<string>();
const picked = new Set<string>();
let lastPass: Record<string, number> = {};
const incomeKey: Record<string, string> = {};

let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const finish = (extra?: string) => { if (extra) console.log(extra); console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`); A.close(); B.close(); process.exit(bad === 0 ? 0 : 1); };
setTimeout(() => { console.log('시간 초과'); bad++; finish(); }, 240_000);

const emit = <T = any>(s: Socket, ev: string, payload: any) => new Promise<T>(res => s.emit(ev, payload, (r: T) => res(r)));

/** 사람 좌석 진행 — 시작 광산·보너스·수입 처리, 메인에서는 바로 패스(라운드를 굴려 스냅샷을 쌓는다) */
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
		return;
	}
	if (g.currentPhase === 'bonusSelection' && !picked.has(me)) {
		const t = (g.availableBonusTiles || [])[0];
		if (t) { picked.add(me); sock.emit('select_bonus_tile', { gameId, bonusTileId: t.id ?? t }); }
		return;
	}
	if (g.currentPhase === 'main' && !g.players[me]?.hasPassed && Date.now() - (lastPass[me] ?? 0) > 1200) {
		const t = (g.availableBonusTiles || [])[0];
		if (t) { lastPass[me] = Date.now(); sock.emit('pass_round', { gameId, newBonusTileId: t.id ?? t }); }
	}
}
A.on('game_updated', (g: any) => { lastA = g; drive(A, aId, g); });
B.on('game_updated', (g: any) => { lastB = g; drive(B, bId, g); });
setInterval(() => { if (lastA) drive(A, aId, lastA); if (lastB) drive(B, bId, lastB); }, 700);

/** 되돌릴 지점: 롤백 표시가 안 붙은 로그 중 가장 최근 seq */
const targetSeq = (g: any) => Math.max(...(g.gameLog ?? []).filter((e: any) => !e.rolledBack && typeof e.seq === 'number').map((e: any) => e.seq));
const waitFor = async (pred: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await sleep(100); return pred(); };

A.on('connect', async () => {
	await emit(A, 'admin_set_mcts_time_ms', { timeMs: 50 });
	await emit(A, 'admin_set_bot_delay_ms', { delayMs: 0 });
	const r = await emit<any>(A, 'create_game', { playerName: 'Alpha' });
	gameId = r.gameId; aId = r.playerId;
	const r2 = await emit<any>(B, 'join_game', { gameId, playerName: 'Beta' });
	bId = r2.playerId;
	A.emit('auto_setup_test', { gameId, selfPlay: false });

	// 라운드 2 메인까지 굴려 스냅샷을 넉넉히 쌓는다
	const ok = await waitFor(() => lastA?.currentPhase === 'main' && (lastA?.roundNumber ?? 0) >= 2, 150_000);
	if (!ok) { bad++; finish(`라운드 2에 못 갔다 (지금 ${lastA?.currentPhase} R${lastA?.roundNumber})`); return; }
	driving = false; // 이제부터는 롤백만 본다
	await sleep(800);

	check(getRollbackQuota(lastA, aId).limit === ROLLBACK_LIMIT_PER_PLAYER, `기본 한도가 ${ROLLBACK_LIMIT_PER_PLAYER}회로 내려온다 (게임 상태 rollbackUsage)`);

	// ① 사유 없음
	let res = await emit<any>(A, 'request_rollback', { gameId, seq: targetSeq(lastA) });
	check(res?.error === '롤백 사유를 골라 주세요.', `① 사유 없이 요청하면 거부 ("${res?.error}")`);
	// ② 기타인데 빈 글
	res = await emit<any>(A, 'request_rollback', { gameId, seq: targetSeq(lastA), reason: { code: 'custom', text: '   ' } });
	check(res?.error === '기타 사유를 입력해 주세요.', `② 기타 사유가 비어 있으면 거부 ("${res?.error}")`);

	// ③ 사유 골라 요청 → 베타 화면에 실린다
	res = await emit<any>(A, 'request_rollback', { gameId, seq: targetSeq(lastA), reason: { code: 'techTile' } });
	check(!!res?.ok, `③ 사유(기술 타일 변경)를 골라 요청하면 접수 (${res?.error ?? 'ok'})`);
	await waitFor(() => !!lastB?.pendingRollback);
	const pr = lastB?.pendingRollback;
	check(pr?.reason?.code === 'techTile', `③ 베타가 받은 요청에 사유가 실린다 (${JSON.stringify(pr?.reason)})`);
	check(pr?.ordinal === 1 && pr?.limit === ROLLBACK_LIMIT_PER_PLAYER, `③ 몇 번째인지 표기 (${pr?.ordinal}/${pr?.limit})`);

	// ④ 거절 → 횟수 그대로
	res = await emit<any>(B, 'respond_rollback', { gameId, accept: false, playerId: bId });
	await waitFor(() => !lastA?.pendingRollback);
	check(getRollbackQuota(lastA, aId).used === 0, `④ 거절되면 횟수를 쓰지 않는다 (used=${getRollbackQuota(lastA, aId).used})`);

	// ⑤ 동의 받아 한도까지 실행
	const reasons = ['power', 'freeAction', 'custom'];
	for (let i = 0; i < ROLLBACK_LIMIT_PER_PLAYER; i++) {
		const code = reasons[i % reasons.length];
		const reason = code === 'custom' ? { code, text: `테스트 사유 ${i + 1}` } : { code };
		res = await emit<any>(A, 'request_rollback', { gameId, seq: targetSeq(lastA), reason });
		if (res?.error) { check(false, `⑤ ${i + 1}번째 요청 접수 (${res.error})`); break; }
		await waitFor(() => !!lastB?.pendingRollback);
		const p = lastB?.pendingRollback;
		check(p?.ordinal === i + 1, `⑤ ${i + 1}번째 요청이 (${p?.ordinal}/${p?.limit})로 표기된다`);
		if (code === 'custom') check(p?.reason?.text === `테스트 사유 ${i + 1}`, `⑤ 직접 입력한 사유가 그대로 간다 ("${p?.reason?.text}")`);
		await emit<any>(B, 'respond_rollback', { gameId, accept: true, playerId: bId });
		await waitFor(() => getRollbackQuota(lastA, aId).used === i + 1 && !lastA?.pendingRollback);
		check(getRollbackQuota(lastA, aId).used === i + 1, `⑤ 실행 후 used=${getRollbackQuota(lastA, aId).used} (롤백이 게임을 되감아도 횟수는 안 되감긴다)`);
		await sleep(400);
	}
	check(getRollbackQuota(lastA, aId).exhausted, `⑤ 한도를 다 쓰면 소진 상태 (잔여 ${getRollbackQuota(lastA, aId).remaining})`);
	res = await emit<any>(A, 'request_rollback', { gameId, seq: targetSeq(lastA), reason: { code: 'power' } });
	check(res?.error === '롤백 사용 횟수를 모두 사용했습니다.', `⑤ 네 번째 요청은 막힌다 ("${res?.error}")`);
	check(getRollbackQuota(lastA, bId).used === 0, `⑤ 베타의 횟수는 따로 센다 (베타 used=${getRollbackQuota(lastA, bId).used})`);

	// ⑥ 관리자
	res = await emit<any>(A, 'admin_set_rollback_remaining', { gameId, adminCode: 'wrong', targetPlayerId: aId, remaining: 1 });
	check(!!res?.error, `⑥ 틀린 관리자 비번은 거부 ("${res?.error}")`);
	res = await emit<any>(A, 'admin_set_rollback_remaining', { gameId, adminCode: '0011', targetPlayerId: aId, remaining: 1 });
	await waitFor(() => getRollbackQuota(lastA, aId).remaining === 1);
	const q = getRollbackQuota(lastA, aId);
	check(res?.ok && q.remaining === 1 && q.limit === ROLLBACK_LIMIT_PER_PLAYER + 1, `⑥ 잔여 1로 고치면 한도 ${q.limit}·잔여 ${q.remaining}`);
	res = await emit<any>(A, 'request_rollback', { gameId, seq: targetSeq(lastA), reason: { code: 'otherAction' } });
	await waitFor(() => !!lastB?.pendingRollback);
	check(!!res?.ok && lastB?.pendingRollback?.ordinal === ROLLBACK_LIMIT_PER_PLAYER + 1, `⑥ 다시 요청 가능 — (${lastB?.pendingRollback?.ordinal}/${lastB?.pendingRollback?.limit})`);
	await emit<any>(B, 'respond_rollback', { gameId, accept: false, playerId: bId });
	res = await emit<any>(A, 'admin_set_rollback_remaining', { gameId, adminCode: '0011', targetPlayerId: aId, remaining: -1 });
	check(!!res?.error, `⑥ 음수 잔여는 거부 ("${res?.error}")`);

	finish();
});
