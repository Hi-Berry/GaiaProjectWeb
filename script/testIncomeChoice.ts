/**
 * 수익 받는 순서가 갈릴 때 두 결과 중 고르기 — 실서버 회귀 테스트.
 *
 * 사용자 요청(2026-11-06): "토큰 자동화에서 최적이 '파워 많이 받기'와 '3그릇으로 많이 보내기' 두 가지로 갈리면
 *   2가지 보여주고 수익 때 고르라고 해 줘."
 *   실측: JJC 11/05 매안 R4 — 1/1/0 + 의회 토큰 2·충전 4 → '충전 먼저' 2/0/2(지금 파워 2, 충전 1 버림)
 *   vs '토큰 먼저' 0/3/1(충전 다 받음). 자동 정리는 3그릇이 많은 쪽을 무조건 골랐다.
 *
 * 엠바스(의회 수익: 충전 4 + 토큰 2) 1명 + 봇 3. 시험용으로 자원을 넉넉히 줘 1라운드에 교역소 → 의회를 짓고,
 * 그릇을 1/1/0 으로 맞춘 뒤 패스(충전 없는 보너스 타일).
 *   ① 2라운드 수익에서 자동으로 받지 않고 두 선택지(now / charge)가 온다
 *   ② 'charge' 를 고르면 그 순서로 받고 수익 단계가 끝난다(그릇이 선택지 결과와 같다)
 *   ③ 로그에 '선택: 충전 모두 받기'가 남고 '최적 대비 손해' 문구는 없다
 *
 * 사용: 서버를 5050에 띄운 뒤 npx tsx script/testIncomeChoice.ts   (exit 2 = 다시 실행)
 */
import { io, type Socket } from 'socket.io-client';
import { FACTIONS, getIncomeOrderChoices, getNextRoundIncomePreview } from '@shared/gameConfig';

const URL = process.env.URL ?? 'http://localhost:5050';
const A = io(URL, { transports: ['websocket'] });
const call = (s: Socket, ev: string, p: any) => new Promise<any>((res) => s.emit(ev, p, res));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
setTimeout(() => { console.log('RETRY 시간 초과'); process.exit(2); }, 240_000);
let gameId = '', me = '';
const get = async () => (await call(A, 'get_game', { gameId })).game;
const myTurnMain = (g: any) => g.currentPhase === 'main' && g.turnOrder[g.currentPlayerIndex] === me && !g.pendingIncomeOrder && !g.pendingTurnEndPlayerId;
const POWER_TILES = new Set(['bon-2pw-range3', 'bon-4pw-bigbuilding', 'bon-2pw-gaiaproject', 'bon-1o-2tokens']);

async function waitFor(pred: (g: any) => boolean, ms: number) {
	const t = Date.now();
	while (Date.now() - t < ms) { const g = await get(); if (pred(g)) return g; await sleep(250); }
	return null;
}

A.on('connect', async () => {
	await call(A, 'admin_set_mcts_time_ms', { timeMs: 50 });
	await call(A, 'admin_set_bot_delay_ms', { delayMs: 150 });
	const c = await call(A, 'create_game', { playerName: 'Host' }); gameId = c.gameId; me = c.playerId;
	A.emit('auto_setup_test', { gameId, fixedSetup: { seatFactions: ['ambas', 'terran', 'xenos', 'geodens'] } });

	// 시작 광산·보너스 (보너스는 충전·토큰 없는 것)
	let g: any = null;
	for (let i = 0; i < 300; i++) {
		g = await get();
		if (myTurnMain(g)) break;
		if (g.turnOrder?.[g.currentPlayerIndex] === me) {
			if (g.currentPhase === 'startingMines') {
				const home = FACTIONS.find((f: any) => f.id === g.players[me].faction)?.homePlanet;
				const t = g.map.find((x: any) => !x.ownerId && x.type === home); if (t) A.emit('place_starting_mine', { gameId, tileId: t.id, factionId: g.players[me].faction });
			} else if (g.currentPhase === 'bonusSelection') {
				const b = (g.availableBonusTiles || []).map((x: any) => x.id ?? x).find((id: string) => !POWER_TILES.has(id)) ?? g.availableBonusTiles?.[0];
				if (b) A.emit('select_bonus_tile', { gameId, bonusTileId: b.id ?? b });
			}
		}
		await sleep(250);
	}
	if (!g || g.players[me].faction !== 'ambas') { console.log('RETRY 엠바스 좌석이 아니다:', g?.players?.[me]?.faction); process.exit(2); }
	if (!myTurnMain(g)) { console.log('RETRY 내 차례가 안 왔다'); process.exit(2); }

	console.log('  · 1라운드 내 차례 도착');
	// 교역소 → 의회 (시험용 자원 지급)
	const myMine = () => g.map.find((t: any) => t.ownerId === me && t.structure === 'mine');
	await call(A, 'admin_set_player_state', { gameId, targetPlayerId: me, adminCode: '0011', resources: { ore: 30, credits: 40 } });
	const mineTile = myMine(); if (!mineTile) { console.log('RETRY 광산 없음'); process.exit(2); }
	A.emit('upgrade_structure', { gameId, tileId: mineTile.id, target: 'trading_station' }); await sleep(600);
	A.emit('end_turn', { gameId }); await sleep(600);
	g = await waitFor((gg) => myTurnMain(gg), 60_000); if (!g) { console.log('RETRY 둘째 차례 안 옴'); process.exit(2); }
	A.emit('upgrade_structure', { gameId, tileId: mineTile.id, target: 'planetary_institute' }); await sleep(600);
	g = await get();
	if (g.pendingTechTileSelection?.playerId === me || g.map.find((t: any) => t.id === mineTile.id)?.structure !== 'planetary_institute') {
		console.log('RETRY 의회 건설 실패:', g.map.find((t: any) => t.id === mineTile.id)?.structure); process.exit(2);
	}
	A.emit('end_turn', { gameId }); await sleep(600);
	g = await waitFor((gg) => myTurnMain(gg), 60_000); if (!g) { console.log('RETRY 셋째 차례 안 옴'); process.exit(2); }

	console.log('  · 의회 건설 완료');
	// 다음 라운드 수익 미리 계산 → 갈리는 그릇 찾기(1/1/0 부터)
	const pass = (g.availableBonusTiles || []).map((x: any) => x.id ?? x).find((id: string) => !POWER_TILES.has(id));
	const prev = getNextRoundIncomePreview(me, { ...g, players: { ...g.players, [me]: { ...g.players[me], bonusTile: pass } } } as any);
	const items = [{ type: 'power', amount: 4, id: 'pi-p' }, { type: 'tokens', amount: 2, id: 'pi-t' }] as any[];
	if (prev.powerCharge > 4) items.push({ type: 'power', amount: prev.powerCharge - 4, id: 'etc-p' });
	let bowls: number[] | null = null;
	for (const cand of [[1, 1, 0], [0, 3, 1], [1, 3, 0], [2, 1, 0], [1, 2, 0], [0, 2, 0], [2, 2, 0]]) {
		if (getIncomeOrderChoices({ faction: 'ambas', power1: cand[0], power2: cand[1], power3: cand[2] } as any, items).length >= 2) { bowls = cand; break; }
	}
	if (!bowls) { console.log('RETRY 갈리는 그릇을 못 찾음', JSON.stringify(prev)); process.exit(2); }
	await call(A, 'admin_set_player_state', { gameId, targetPlayerId: me, adminCode: '0011', resources: { power1: bowls[0], power2: bowls[1], power3: bowls[2] } });
	A.emit('pass_round', { gameId, newBonusTileId: pass }); await sleep(400);

	// ① 2라운드 수익: 내게 두 선택지
	g = await waitFor((gg) => gg.pendingIncomeOrder?.playerId === me || (gg.roundNumber >= 2 && gg.currentPhase === 'main' && !gg.pendingIncomeOrder), 90_000);
	const po = g?.pendingIncomeOrder;
	const kinds = (po?.choices ?? []).map((x: any) => `${x.kind} ${x.p1}/${x.p2}/${x.p3} 지금${x.nowPower} 버림${x.wastedCharge}`);
	check(po?.playerId === me && (po.choices ?? []).length === 2, `① 그릇 ${bowls.join('/')}에서 2라운드 수익 → 자동 대신 두 선택지: ${kinds.join(' | ') || '(없음)'}`);
	if (!po?.choices) { console.log('\n1건 이상 실패'); process.exit(1); }

	// ② 'charge' 선택
	const want = po.choices.find((x: any) => x.kind === 'charge');
	const r = await call(A, 'choose_income_option', { gameId, kind: 'charge' });
	await sleep(500);
	g = await get();
	const p = g.players[me];
	check(!!r?.ok && g.pendingIncomeOrder?.playerId !== me && p.power1 === want.p1 && p.power2 === want.p2 && p.power3 === want.p3,
		`② '충전 모두 받기' 선택 → 그릇 ${p.power1}/${p.power2}/${p.power3} (선택지 ${want.p1}/${want.p2}/${want.p3}), 수익 단계 넘어감`);

	// ③ 로그
	const lg = (g.gameLog || []).filter((e: any) => e.playerId === me && e.action === 'Income Order').pop();
	check(!!lg && /선택: 충전 모두 받기/.test(lg.details) && !/최적 대비/.test(lg.details), `③ 로그: "${lg?.details}"`);

	console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
	process.exit(bad === 0 ? 0 : 1);
});
