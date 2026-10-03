/**
 * 대기 중 메인 액션 차단 — 실서버 회귀 테스트.
 *
 * 사용자 제보(2026-10-03): "수익 단계 전 팅커/테란/아이타 하는 중에 간헐적으로 액션을 하는 경우가 있다.
 *   우주선 액션도 된다는 말이 있다."
 *   메인 액션 다섯 곳(특수 액션·파이락 다운그레이드·우주선 입장·보너스 액션·하이브 우주정거장)에 대기 검사가
 *   빠져 있었다. 이제 모든 메인 액션 입구가 mainActionWaitReason 하나로 묻는다.
 *
 * 의회·팅커 대기는 판을 그 상태로 만들 도구가 없어, 같은 함수가 막는 '롤백 투표 대기'로 실서버에서 확인한다
 * (mainActionWaitReason = 의회·팅커 대기 || 수익·파워·롤백 대기 — 입구가 이 함수 하나라 어느 대기든 같은 길을 탄다).
 * 의회 대기 쪽 판정 자체는 script/testFiraksDowngradeReason.ts·script/testTurnCommitGate.ts 와 아래 직접 호출로 본다.
 *
 * 사용: 서버를 5050에 띄운 뒤 npx tsx script/testMainActionWaitGuard.ts
 */
import { io, type Socket } from 'socket.io-client';
import { FACTIONS } from '@shared/gameConfig';

const URL = process.env.URL ?? 'http://localhost:5050';
const A = io(URL, { transports: ['websocket'] });
const B = io(URL, { transports: ['websocket'] });
let gameId = '', aId = '', bId = '';
let lastA: any = null, lastB: any = null, driving = true;
const placed = new Set<string>(); const picked = new Set<string>(); const incomeKey: Record<string, string> = {};
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const emit = <T = any>(s: Socket, ev: string, p: any) => new Promise<T>((res) => s.emit(ev, p, (r: T) => res(r)));
const finish = () => { console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`); A.close(); B.close(); process.exit(bad === 0 ? 0 : 1); };
setTimeout(() => { console.log('RETRY 시간 초과'); process.exit(2); }, 150_000);

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
B.on('game_updated', (g: any) => { lastB = g; drive(B, bId, g); });
setInterval(() => { if (lastA) drive(A, aId, lastA); if (lastB) drive(B, bId, lastB); }, 600);

/** 이 소켓이 다음에 받는 game_error 문구(없으면 null) */
const nextError = (s: Socket, ms = 700) => new Promise<string | null>((res) => {
	const on = (e: any) => { clearTimeout(t); res(e?.message ?? String(e)); };
	const t = setTimeout(() => { s.off('game_error', on); res(null); }, ms);
	s.once('game_error', on);
});

A.on('connect', async () => {
	await emit(A, 'admin_set_mcts_time_ms', { timeMs: 50 });
	await emit(A, 'admin_set_bot_delay_ms', { delayMs: 4000 }); // 봇 차례가 금방 넘어가지 않게
	const r = await emit<any>(A, 'create_game', { playerName: 'Alpha' }); gameId = r.gameId; aId = r.playerId;
	bId = (await emit<any>(B, 'join_game', { gameId, playerName: 'Beta' })).playerId;
	A.emit('auto_setup_test', { gameId, selfPlay: false });

	// 사람(알파·베타) 중 한 명이 메인 차례인 순간을 잡는다
	const isHumanTurn = () => lastA?.currentPhase === 'main' && [aId, bId].includes(lastA.turnOrder?.[lastA.currentPlayerIndex]) && !lastA.pendingIncomeOrder && !lastA.pendingTurnEndPlayerId;
	const t0 = Date.now(); while (!isHumanTurn() && Date.now() - t0 < 120_000) await sleep(200);
	if (!isHumanTurn()) { console.log('RETRY 사람 메인 차례가 오지 않았다'); process.exit(2); }
	driving = false;
	const curId = lastA.turnOrder[lastA.currentPlayerIndex];
	const [cur, other, otherId] = curId === aId ? [A, B, bId] : [B, A, aId];
	console.log(`현재 차례: ${curId === aId ? 'Alpha' : 'Beta'}`);

	// 대기 상태 만들기 — 다른 사람이 롤백 요청(투표 대기 = mainActionWaitReason 이 막는 대기)
	const seq = Math.max(...(lastA.gameLog ?? []).filter((e: any) => !e.rolledBack && typeof e.seq === 'number').map((e: any) => e.seq));
	const rr = await emit<any>(other, 'request_rollback', { gameId, seq, reason: { code: 'otherAction' } });
	if (rr?.error) { console.log(`RETRY 롤백 요청 실패: ${rr.error}`); process.exit(2); }
	await sleep(500);
	check(!!lastA?.pendingRollback, '대기 상태(롤백 투표 중)를 만들었다');

	const WAIT = '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.';
	const ship = (lastA.map || []).find((t: any) => String(t.type).startsWith('ship_'));
	const attempts: Array<[string, string, any]> = [
		['특수 액션(아카데미 QIC)', 'use_special_action', { gameId, actionId: 'academy-qic' }],
		['파이락 다운그레이드', 'firaks_downgrade', { gameId, tileId: 'x', trackId: 'science' }],
		['우주선 입장', 'enter_spaceship', { gameId, tileId: ship?.id ?? 'x' }],
		['보너스 타일 액션', 'use_bonus_action', { gameId }],
		['하이브 우주정거장', 'place_ivits_space_station', { gameId, tileId: 'x' }],
		['우주선 액션', 'use_ship_action', { gameId, shipTileId: ship?.id ?? 'x', actionIndex: 1 }],
		['파워 액션(원래 막히던 것)', 'use_power_action', { gameId, actionId: 'power-1' }],
	];
	for (const [name, ev, payload] of attempts) {
		const p = nextError(cur);
		cur.emit(ev, payload);
		const msg = await p;
		const okMsg = msg === WAIT || (ev === 'firaks_downgrade' && msg === `다운그레이드 불가: ${WAIT}`);
		check(okMsg, `대기 중 ${name} → "${msg ?? '(반응 없음)'}"`);
	}
	const before = JSON.stringify(lastA.players[curId]);
	await sleep(400);
	check(JSON.stringify(lastA.players[curId]) === before && !lastA.hasDoneMainAction, '대기 중 시도들로 자원·메인 액션 상태가 바뀌지 않았다');

	// 대기를 풀면(거절) 같은 특수 액션은 더 이상 '대기' 사유로 막히지 않는다(다른 사유가 있으면 그 사유)
	await emit(cur, 'respond_rollback', { gameId, accept: false, playerId: curId });
	await sleep(500);
	const p2 = nextError(cur);
	cur.emit('use_special_action', { gameId, actionId: 'academy-qic' });
	const after = await p2;
	check(after !== WAIT, `대기가 풀린 뒤엔 대기 사유로 막지 않는다 ("${after ?? '실행됨'}")`);
	finish();
});
