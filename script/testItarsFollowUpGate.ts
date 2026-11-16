/**
 * 아이타 의회 교환 후속 처리(2TF 무료 광산 → 트랙 전진) 동안 다른 사람 행동을 막는지 — 회귀 테스트.
 *
 * 사용자 제보(2026-11-16, ffsntyqn R4): "아이타가 의회 능력으로 타일 3개 가져오는 사이에 란티다가 액션을 해버렸다.
 *   2삽 타일 가져오면서 발생한 일" · "광산 건설까지 완료해야 아이타 의회 행동 종료야"
 *   → 아이타가 2TF+무료광산 타일을 고르면 교환 대기 표시가 꺼져, 라운드 첫 차례(란티다)가 리벨리온을 썼다.
 *
 * 판: 아이타(p_itars)는 교환 중, 다른 사람(p_other)이 라운드 첫 차례(currentPlayerIndex).
 *   ① 2TF+Mine 고름 → 다른 사람의 메인 액션·무료 행동·턴 종료·패스·턴 리셋은 막힘, 파워 받기·수입·채팅은 통과.
 *      아이타 본인의 광산 건설·트랙 전진은 통과.
 *   ② 무료 광산 건설 후(트랙 전진 대기) → 여전히 막힘.
 *   ③ 트랙 전진 후 남은 토큰 교환 대기 → 기존 가드(교환 대기)로 넘어가고, 남은 토큰이 없으면 전부 풀림.
 *   ④ 실제 소켓 입구: 서버를 띄워 막는 대상 아닌 이벤트의 응답(ack)이 그대로 오는지(socket.use 가 흐름을 끊지 않는지).
 *
 * 사용: PORT=5096 npx tsx script/testItarsFollowUpGate.ts
 */
import { io as connect } from 'socket.io-client';
import { executeSelectTechTile, executeBuildMine, executeAdvanceTech } from '../server/gameState';
import { itarsFollowUpBlockMessage, itarsCouncilFollowUpOwner } from '../shared/itarsCouncil';
import { createInitialPlayerState, generateMap, getDistance, getEffectiveBaseRange, getTerraformStepsForFaction, HOME_PLANETS } from '../shared/gameConfig';

const ioStub: any = { to: () => ({ emit: () => { }, except: () => ({ emit: () => { } }) }), emit: () => { } };
const ITARS = 'p_itars', OTHER = 'p_other';
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
setTimeout(() => { console.log('시간 초과'); process.exit(1); }, 60_000);

function makeGame(remaining: number): any {
	const itars = createInitialPlayerState('디애박') as any;
	itars.faction = 'itars';
	itars.research = { terraforming: 0, navigation: 2, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0 };
	itars.ore = 4; itars.credits = 10; itars.knowledge = 2;
	const other = createInitialPlayerState('구오') as any;
	other.faction = 'lantids';
	return {
		id: 'test-itars-gate-' + remaining,
		players: { [ITARS]: itars, [OTHER]: other },
		map: generateMap(),
		turnOrder: [OTHER, ITARS], currentPlayerIndex: 0, // 라운드 첫 차례 = 다른 사람(실제 판의 란티다)
		roundNumber: 4, hasDoneMainAction: false, gameLog: [], satellites: {}, roundScoringTiles: [], finalScoringTiles: [],
		availableBonusTiles: [], passingOrder: [], powerActions: [],
		currentPhase: 'main',
		pendingTechTileSelection: { playerId: ITARS, tileId: '', structureType: 'itars_pi_exchange' },
		itarsGaiaformerRemainingAfterTech: remaining,
		availableShipTechTileIds: ['ship-tech-2tf-mine'], shipTechPool: { 'ship-tech-2tf-mine': 4 },
	};
}

/** 아이타 기준 2스텝 행성 + 사거리 안 앵커 광산 */
function twoStepTarget(game: any): any {
	const range = getEffectiveBaseRange(game.players[ITARS]);
	const planets = game.map.filter((t: any) => HOME_PLANETS.includes(t.type) && !t.structure && !t.ownerId);
	for (const t of planets) {
		if (getTerraformStepsForFaction(game, 'itars', t.type) !== 2) continue;
		const a = planets.find((x: any) => x !== t && getDistance(x, t) <= range);
		if (!a) continue;
		a.ownerId = ITARS; a.structure = 'mine';
		return t;
	}
	return null;
}

const OTHER_BLOCKED = ['use_ship_action', 'build_mine', 'upgrade_structure', 'advance_tech', 'use_power_action', 'convert_resource', 'end_turn', 'pass_round', 'reset_turn', 'select_bonus_tile'];
const OTHER_ALLOWED = ['respond_power_offer', 'accept_all_power_offers', 'send_chat', 'select_income_item', 'respond_rollback', 'get_game'];
const blockedAll = (g: any) => OTHER_BLOCKED.every((ev) => !!itarsFollowUpBlockMessage(g, ev, OTHER));
const allowedAll = (g: any) => OTHER_ALLOWED.every((ev) => itarsFollowUpBlockMessage(g, ev, OTHER) === null);

for (const remaining of [0, 4]) {
	console.log(`-- 남은 토큰 ${remaining}`);
	const g = makeGame(remaining);
	check(itarsCouncilFollowUpOwner(g) === null, '교환 타일 고르기 전엔 후속 처리 없음(그 구간은 기존 가드 담당)');
	executeSelectTechTile(ioStub, g, ITARS, 'ship-tech-2tf-mine');
	check(g.itarsExchangeResumeAfterShipMine === true && g.pendingShipTechMine?.playerId === ITARS, '① 2TF+Mine 선택 → 무료 광산 대기');
	check(blockedAll(g), `① 다른 사람의 행동 차단: ${OTHER_BLOCKED.filter((ev) => !itarsFollowUpBlockMessage(g, ev, OTHER)).join(', ') || '전부 막힘'}`);
	check(allowedAll(g), '① 파워 받기·수입·채팅·롤백 투표는 통과');
	check(itarsFollowUpBlockMessage(g, 'build_mine', ITARS) === null && itarsFollowUpBlockMessage(g, 'advance_tech', ITARS) === null, '① 아이타 본인 광산·트랙은 통과');
	check(/디애박님의 아이타 의회/.test(itarsFollowUpBlockMessage(g, 'use_ship_action', OTHER) ?? ''), `① 안내 문구에 아이타 이름: ${itarsFollowUpBlockMessage(g, 'use_ship_action', OTHER)}`);

	const t = twoStepTarget(g);
	check(!!t, '2스텝 행성 준비(하니스)');
	if (!t) continue;
	check(executeBuildMine(ioStub, g, ITARS, t.id) === true && t.ownerId === ITARS, '② 아이타 무료 광산 건설');
	check(g.pendingShipTechTrackAdvance?.playerId === ITARS && blockedAll(g), '② 트랙 전진 대기 중에도 다른 사람 차단(광산·트랙까지가 의회 행동)');
	check(executeAdvanceTech(ioStub, g, ITARS, 'terraforming') === true, '③ 아이타 트랙 전진');
	check(itarsCouncilFollowUpOwner(g) === null, '③ 후속 처리 끝 → 이 차단은 풀림');
	if (remaining >= 4) check(g.pendingItarsGaiaformerExchange?.tokensRemaining === 4, '③ 남은 토큰 교환 대기로 이어짐(기존 교환 가드가 계속 막음)');
	else check(!g.pendingItarsGaiaformerExchange && allowedAll(g) && OTHER_BLOCKED.every((ev) => itarsFollowUpBlockMessage(g, ev, OTHER) === null), '③ 남은 토큰 없음 → 다른 사람 행동 열림');
}

// ④ 실제 소켓 입구(socket.use)가 막지 않는 이벤트는 그대로 흘려보내는지
{
	const port = Number(process.env.PORT ?? 5096);
	await new Promise((r) => setTimeout(r, 1500));
	const s = connect(`http://localhost:${port}`, { transports: ['websocket'] });
	await new Promise((r) => s.on('connect', r as any));
	const pong: any = await new Promise((r) => { s.emit('client_ping', { gameId: 'none' }, r); setTimeout(() => r(null), 3000); });
	check(pong?.ok === true, `④ 소켓 입구 통과: client_ping 응답 ${JSON.stringify(pong)}`);
	const list: any = await new Promise((r) => { s.emit('list_games', r); setTimeout(() => r('timeout'), 3000); });
	check(Array.isArray(list?.games ?? list), `④ 인자 없이 콜백만 받는 list_games 도 정상 응답 (${typeof list})`);
	s.close();
}

console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
process.exit(bad === 0 ? 0 : 1);
