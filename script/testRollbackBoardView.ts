/**
 * 롤백 뒤 보드 화면이 옛 상태에 멈추지 않는지 — 실서버 회귀 테스트.
 *
 * 사용자 제보(2026-10-01): "간혹 롤백하면 롤백 이후 액션이랑 보드판 이미지가 안 맞는다.
 *   1번에 짓고 롤백하고 2번에 지어도 1번에 광산이 있다. 새로고침하면 2번에 있는 것으로 나온다."
 *
 * 남의 턴 동안 보드를 그 턴 시작 시점으로 고정하는 화면 규칙(viewGame)을 실제 브로드캐스트에 그대로 적용한다.
 *   ① 베타가 광산 A를 교역소로 올리고 턴 종료   → 화면: A=교역소
 *   ② 베타가 롤백 요청, 알파 동의               → 서버: A=광산
 *   ③ 베타가 이번엔 광산 B를 교역소로 올리고 턴 종료
 *   → 화면이 A=광산, B=교역소여야 한다(새로고침 없이). 관전자 화면과 베타 본인 화면 둘 다 본다.
 *
 * 사용: 서버를 5050에 띄운 뒤 npx tsx script/testRollbackBoardView.ts
 *   종료 코드 2 = 이 판은 시험 조건이 안 맞음(시작 광산 1개 종족·특수 선택 대기) — 다시 돌리면 된다.
 */
import { io, type Socket } from 'socket.io-client';
import { FACTIONS } from '@shared/gameConfig';
import { createViewFreeze } from '@/lib/turnCommit';

const URL = process.env.URL ?? 'http://localhost:5050';
const A = io(URL, { transports: ['websocket'] });
const B = io(URL, { transports: ['websocket'] });
const V = io(URL, { transports: ['websocket'] }); // 관전자(화면 재현용)
let gameId = '', aId = '', bId = '';
let lastA: any = null, lastB: any = null;
let driving = true;
const placed = new Set<string>(); const picked = new Set<string>(); const incomeKey: Record<string, string> = {};

let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const finish = (extra?: string) => { if (extra) console.log(extra); console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`); A.close(); B.close(); V.close(); process.exit(bad === 0 ? 0 : 1); };
setTimeout(() => { console.log('시간 초과'); bad++; finish(); }, 240_000);
const emit = <T = any>(s: Socket, ev: string, p: any) => new Promise<T>(res => s.emit(ev, p, (r: T) => res(r)));
const waitFor = async (pred: () => boolean, ms = 30000) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await sleep(100); return pred(); };

// ── 화면 재현: 클라이언트처럼 로그 꼬리를 이어 붙이고, 화면과 같은 고정 규칙으로 보이는 상태를 고른다 ──
let fullLog: any[] = [];
let live: any = null;
const freezeSpectator = createViewFreeze();
const freezeBeta = createViewFreeze();
let shownSpectator: any = null, shownBeta: any = null;
V.on('game_updated', (g: any) => {
	if (!g?.players) return;
	const start = typeof g.gameLogStart === 'number' ? g.gameLogStart : 0;
	fullLog = fullLog.slice(0, start).concat(g.gameLog ?? []);
	live = { ...g, gameLog: fullLog };
	shownSpectator = freezeSpectator.view(live, null);
	shownBeta = freezeBeta.view(live, bId);
});
const structAt = (g: any, tileId: string) => g?.map?.find((t: any) => t.id === tileId)?.structure ?? null;

/** 사람 좌석 진행(준비 단계만) — 메인에서는 시나리오가 직접 움직인다 */
function drive(sock: Socket, me: string, g: any) {
	if (!g?.players) return;
	if (g.pendingIncomeOrder?.playerId === me) {
		const k = JSON.stringify(g.pendingIncomeOrder.incomeItems ?? []);
		if (incomeKey[me] !== k) { incomeKey[me] = k; sock.emit('select_all_income_items', { gameId }); setTimeout(() => sock.emit('finish_income_selection', { gameId }), 120); }
		return;
	}
	// 리치 제안은 바로 거절 — 턴 종료 대기를 오래 끌지 않게
	const offer = (g.pendingPowerOffers ?? []).find((o: any) => o && !o.responded && o.targetPlayerId === me);
	if (offer) { sock.emit('respond_power_offer', { gameId, offerId: offer.id, accept: false }); return; }
	if (!driving || g.turnOrder?.[g.currentPlayerIndex] !== me) return;
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
B.on('game_updated', (g: any) => { lastB = g; drive(B, bId, g); });
setInterval(() => { if (lastA) drive(A, aId, lastA); if (lastB) drive(B, bId, lastB); }, 600);
if (process.env.VERBOSE) setInterval(() => {
	const g = lastA; if (!g) return;
	const cur = g.turnOrder?.[g.currentPlayerIndex];
	const pend = Object.keys(g).filter(k => k.startsWith('pending') && g[k] && (Array.isArray(g[k]) ? g[k].length : true));
	console.log(`  [상태] ${g.currentPhase} R${g.roundNumber} 차례=${cur === aId ? '알파' : cur === bId ? '베타' : g.players?.[cur]?.name} main=${g.hasDoneMainAction} 대기=${pend.join(',') || '-'}`);
}, 5000);

const isTurn = (g: any, id: string) => g?.currentPhase === 'main' && g.turnOrder?.[g.currentPlayerIndex] === id && !g.pendingTurnEndPlayerId;
/** 베타가 tile 을 교역소로 올리고 턴을 끝낸다 → 그 턴이 실제로 넘어갈 때까지 기다린다 */
async function betaUpgradeAndEnd(tileId: string) {
	await waitFor(() => isTurn(lastB, bId) && !lastB.hasDoneMainAction);
	B.emit('upgrade_structure', { gameId, tileId, target: 'trading_station' });
	await waitFor(() => structAt(lastB, tileId) === 'trading_station');
	B.emit('end_turn', { gameId });
	await waitFor(() => lastB?.turnOrder?.[lastB.currentPlayerIndex] !== bId && !lastB?.pendingTurnEndPlayerId);
	await sleep(600);
}

V.on('connect', () => {});
B.on('game_error', (e: any) => console.log('  [베타 오류]', e?.message));
A.on('game_error', (e: any) => { if (process.env.VERBOSE) console.log('  [알파 오류]', e?.message); });
A.on('connect', async () => {
	await emit(A, 'admin_set_mcts_time_ms', { timeMs: 50 });
	await emit(A, 'admin_set_bot_delay_ms', { delayMs: 400 });
	const r = await emit<any>(A, 'create_game', { playerName: 'Alpha' }); gameId = r.gameId; aId = r.playerId;
	const r2 = await emit<any>(B, 'join_game', { gameId, playerName: 'Beta' }); bId = r2.playerId;
	await emit(V, 'watch_game', { gameId, name: '---' });
	A.emit('auto_setup_test', { gameId, selfPlay: false });
	// 알파는 메인 단계에서 자기 차례가 오면 바로 패스한다 — 시나리오와 무관한 턴을 넘기기 위해(안 하면 게임이 멈춘다)
	setInterval(() => {
		if (isTurn(lastA, aId) && !lastA.players[aId]?.hasPassed) { const t = (lastA.availableBonusTiles || [])[0]; if (t) A.emit('pass_round', { gameId, newBonusTileId: t.id ?? t }); }
	}, 800);

	if (!(await waitFor(() => isTurn(lastB, bId), 150_000))) {
		// 이 도구가 몰 줄 모르는 종족 선택(팅커로이드 특수 등)에 걸린 판 — 테스트 대상과 무관하니 새 판으로
		const pend = Object.keys(lastA ?? {}).filter((k) => k.startsWith('pending') && lastA[k]);
		console.log(`RETRY 베타의 메인 턴이 오지 않았다 (${lastA?.currentPhase}, 대기: ${pend.join(',') || '-'}) — 새 판으로`);
		A.close(); B.close(); V.close(); process.exit(2);
	}
	driving = false;

	const mines = (lastB.map || []).filter((t: any) => t.ownerId === bId && t.structure === 'mine').map((t: any) => t.id);
	if (mines.length < 2) { console.log('RETRY 베타 광산이 2개 미만(이 종족은 시작 광산이 하나) — 새 판으로'); A.close(); B.close(); V.close(); process.exit(2); }
	const [tA, tB] = mines;
	console.log(`광산 A=${tA}, B=${tB}`);

	// ① A를 교역소로
	await betaUpgradeAndEnd(tA);
	check(structAt(live, tA) === 'trading_station', `① 서버: A=교역소`);
	check(structAt(shownSpectator, tA) === 'trading_station', `① 관전자 화면: A=교역소 (${structAt(shownSpectator, tA)})`);

	// ② 롤백 — 베타의 업그레이드 줄로
	const upSeq = Math.max(...fullLog.filter((e: any) => !e.rolledBack && e.playerId === bId && /Trading Station/.test(e.action ?? '')).map((e: any) => e.seq));
	const rr = await emit<any>(B, 'request_rollback', { gameId, seq: upSeq, reason: { code: 'otherAction' } });
	if (rr?.error) { bad++; finish(`롤백 요청 실패: ${rr.error}`); return; }
	await waitFor(() => !!lastA?.pendingRollback);
	await emit(A, 'respond_rollback', { gameId, accept: true, playerId: aId });
	await waitFor(() => structAt(live, tA) === 'mine' && !live?.pendingRollback);
	check(structAt(live, tA) === 'mine', `② 서버: 롤백 후 A=광산`);

	// ③ 이번엔 B를 교역소로
	await betaUpgradeAndEnd(tB);
	check(structAt(live, tA) === 'mine' && structAt(live, tB) === 'trading_station', `③ 서버: A=광산, B=교역소`);
	check(structAt(shownSpectator, tA) === 'mine' && structAt(shownSpectator, tB) === 'trading_station',
		`③ 관전자 화면: A=${structAt(shownSpectator, tA)}, B=${structAt(shownSpectator, tB)} (기대 mine / trading_station)`);
	check(structAt(shownBeta, tA) === 'mine' && structAt(shownBeta, tB) === 'trading_station',
		`③ 베타 본인 화면(턴 넘긴 뒤): A=${structAt(shownBeta, tA)}, B=${structAt(shownBeta, tB)} (기대 mine / trading_station)`);
	finish();
});
