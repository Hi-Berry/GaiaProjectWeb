/**
 * 한 턴에 같은 사람에게 파워 제안이 두 번 생길 때 단계별로 처리하는지 — 서버 함수 직접 호출 회귀 테스트.
 *
 * 사용자 요청(2026-11-10): "연구소/아카데미 짓고 2삽 무료 광산·잊혀진 행성을 놓으면 누군가 파워를 두 번 받는데 순서가 안 맞다.
 *   연구소 몫을 먼저 받고 그 결과로 다음 파워를 받아야 한다. 첫 창을 받고 난 뒤에 광산 위치가 드러나고 두 번째 창이 뜨면 좋겠다."(2번 안)
 *
 * 판: A(행동) 교역소 근처엔 B(사람) 교역소, 빈 우주칸 근처엔 B 광산. A가 교역소→연구소(B에게 파워 2) 후 잊혀진 행성(B에게 파워 1)을 놓는다.
 * B 그릇 0/2/0 (최대 2 충전).
 *   ① 턴 종료 → B에게 연구소 몫만 창(2파워·1VP). 잊혀진 행성 몫은 아직 안 들어감(예전엔 무료 1파워가 먼저 자동 수락됐다).
 *      남에게 감출 칸·로그 경계(powerRevealHold)가 잊혀진 행성 칸·그 로그 줄을 가리킨다.
 *   ② B 수락 → 0/0/2·1VP 지불, 잊혀진 행성 몫은 여력 0이라 묻지 않고 턴이 넘어간다. 감춤 해제.
 *   ③ (다른 판) B 거절 → 잊혀진 행성 몫 1파워(무료)가 그때 자동으로 들어가 0/1/1.
 *
 * 사용: PORT=5097 npx tsx script/testPowerOfferStages.ts
 */
import { executeUpgradeStructure, executePlaceLostPlanet, executeEndTurn, executeRespondPowerOffer } from '../server/gameState';

let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const noop: any = new Proxy(function () {}, { get: () => noop, apply: () => noop });

function makeGame(id: string): any {
	const P = (pid: string, name: string, faction: string, extra: any = {}) => ({
		id: pid, name, faction, score: 10, ore: 20, credits: 20, knowledge: 5, qic: 3, power1: 0, power2: 0, power3: 0,
		techTiles: [], research: { terraforming: 0, navigation: 0, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0 },
		gaiaformers: 0, hasPassed: false, artifacts: [], federations: [], usedSpecialActions: [], ...extra,
	});
	return {
		id, currentPhase: 'main', roundNumber: 2, turnOrder: ['A', 'B'], currentPlayerIndex: 0, hasDoneMainAction: false,
		players: { A: P('A', '알파', 'terran'), B: P('B', '베타', 'nevlas', { power2: 2 }) },
		map: [
			// 연구소(0,0) 근처엔 B 교역소(파워 2)만, 잊혀진 행성(-2,0) 근처엔 B 광산(파워 1)만 걸리게 둔다
			{ id: 'a-ts', q: 0, r: 0, type: 'terra', sector: 0, ownerId: 'A', structure: 'trading_station' },
			{ id: 'b-ts', q: 2, r: 0, type: 'ice', sector: 0, ownerId: 'B', structure: 'trading_station' },
			{ id: 'b-mine', q: -3, r: 0, type: 'ice', sector: 0, ownerId: 'B', structure: 'mine' },
			{ id: 'space-1', q: -2, r: 0, type: 'space', sector: 0, ownerId: null, structure: null },
			{ id: 'far', q: 5, r: 5, type: 'space', sector: 1, ownerId: null, structure: null },
		],
		gameLog: [], gameLogSeq: 0, botPlayerIds: [], turnMark: { A: 0, B: 0 }, roundMissions: [], roundScoringTiles: [], finalScoringTiles: [], availableTechTiles: [],
		powerActions: [], satellites: {}, queuedPowerOffers: [], pendingPowerOffers: [],
	};
}

function playTurn(g: any) {
	const okLab = executeUpgradeStructure(noop, g, 'A', 'a-ts', 'research_lab' as any);
	g.pendingTechTileSelection = null; g.availableShipTechTileIds = []; // 기술 타일 고르기는 이 시험의 관심 밖
	g.pendingLostPlanet = { playerId: 'A' };
	const okLp = executePlaceLostPlanet(noop, g, 'A', 'space-1');
	const okEnd = executeEndTurn(noop, g, 'A');
	return { okLab, okLp, okEnd };
}

const bowls = (p: any) => `${p.power1}/${p.power2}/${p.power3}`;
process.on('uncaughtException', (e) => { console.log('ERROR', e?.stack ?? e); process.exit(1); });
setTimeout(() => { console.log('시간 초과'); process.exit(1); }, 60_000);

// ①② 수락
{
	const g = makeGame('stage-accept');
	const r = playTurn(g);
	const pend = (g.pendingPowerOffers ?? []).filter((o: any) => !o.responded);
	const lpLog = g.gameLog.find((e: any) => e.tileId === 'space-1' && /Lost Planet/.test(e.action));
	check(r.okLab && r.okLp && r.okEnd, `연구소·잊혀진 행성·턴 종료 실행 (${JSON.stringify(r)})`);
	check(pend.length === 1 && pend[0].targetPlayerId === 'B' && pend[0].sourceTileId === 'a-ts' && pend[0].amount === 2 && pend[0].vpCost === 1,
		`① 턴 종료 뒤 B에게 연구소 몫만 창: ${pend.map((o: any) => `${o.sourceTileId} ${o.amount}P/${o.vpCost}VP`).join(', ')}`);
	check(bowls(g.players.B) === '0/2/0', `① 잊혀진 행성 몫(무료 1)이 먼저 들어가지 않았다 — B 그릇 ${bowls(g.players.B)}`);
	check(!!g.powerRevealHold && g.powerRevealHold.tiles.some((t: any) => t.id === 'space-1' && !t.structure) && g.powerRevealHold.fromSeq === lpLog?.seq,
		`① 남에게 감출 칸·로그: ${JSON.stringify(g.powerRevealHold && { fromSeq: g.powerRevealHold.fromSeq, tiles: g.powerRevealHold.tiles.map((t: any) => `${t.id}:${t.structure}`) })} (잊혀진 행성 줄 seq ${lpLog?.seq})`);
	executeRespondPowerOffer(noop, g, 'B', pend[0].id, true);
	check(bowls(g.players.B) === '0/0/2' && g.players.B.score === 9, `② B 수락 → 그릇 ${bowls(g.players.B)}, 점수 ${g.players.B.score}`);
	check(!g.pendingTurnEndPlayerId && (g.pendingPowerOffers ?? []).length === 0 && g.currentPlayerIndex === 1 && !g.powerRevealHold,
		`② 잊혀진 행성 몫은 여력 0이라 묻지 않고 턴이 넘어감 (차례 ${g.turnOrder[g.currentPlayerIndex]}, 감춤 ${JSON.stringify(g.powerRevealHold ?? null)})`);
	const labLine = g.gameLog.find((e: any) => e.tileId === 'a-ts');
	check(!!labLine?.subLogs?.some((s: any) => /Received Power \+2P/.test(s.text)), `② 수령 기록이 연구소 줄에 붙었다: ${JSON.stringify(labLine?.subLogs?.map((s: any) => s.text))}`);
}
// ③ 거절
{
	const g = makeGame('stage-decline');
	playTurn(g);
	const pend = (g.pendingPowerOffers ?? []).filter((o: any) => !o.responded);
	executeRespondPowerOffer(noop, g, 'B', pend[0].id, false);
	check(bowls(g.players.B) === '0/1/1' && g.players.B.score === 10 && g.currentPlayerIndex === 1,
		`③ B 거절 → 잊혀진 행성 몫 1파워(무료)가 그때 들어감: 그릇 ${bowls(g.players.B)}, 점수 ${g.players.B.score}, 차례 ${g.turnOrder[g.currentPlayerIndex]}`);
	const lpLine = g.gameLog.find((e: any) => e.tileId === 'space-1' && /Lost Planet/.test(e.action));
	check(!!lpLine?.subLogs?.some((s: any) => /Received Power \+1P/.test(s.text)), `③ 그 수령 기록은 잊혀진 행성 줄에: ${JSON.stringify(lpLine?.subLogs?.map((s: any) => s.text))}`);
}
console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
process.exit(bad === 0 ? 0 : 1);
