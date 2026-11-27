/**
 * 아이타 의회 + 테란 의회가 같은 가이아 단계에 있을 때, 아이타가 교환으로 고른 2TF+무료광산을 지을 수 있는지 — 회귀 테스트.
 *
 * 사용자 제보(2026-11-27): "아이타 / 테란 의회 2개 동시에 있는데 아이타 의회 능력으로 2삽 광산 고르니까
 *   테란 의회 차례라고 지을 수 없는 버그"
 *   → 테란 대기열(terranCouncilQueueAfterItars)이 아이타 뒤에서 기다리는 동안 councilPendingActive가 참이라
 *     build_mine·advance_tech 입구가 아이타 본인의 후속 단계까지 '테란 의회 선택을 기다리는 중'으로 막았다.
 *
 * 확인: ① 2TF+Mine 선택 뒤 의회 대기 문구는 여전히 '테란'(다른 사람에겐 막힘)이지만 아이타 본인은 입구 면제,
 *       테란·다른 사람은 면제 아님. ② 광산 → 트랙 전진까지 아이타가 마치면 ③ 테란 의회 선택으로 넘어간다.
 *
 * 사용: PORT=5391 npx tsx script/testItarsTerranCouncilMine.ts
 */
import { executeSelectTechTile, executeBuildMine, executeAdvanceTech, ownItarsShipFollowUp, mainActionWaitReason } from '../server/gameState';
import { createInitialPlayerState, generateMap, getDistance, getEffectiveBaseRange, getTerraformStepsForFaction, HOME_PLANETS } from '../shared/gameConfig';

const ioStub: any = { to: () => ({ emit: () => { }, except: () => ({ emit: () => { } }) }), emit: () => { } };
const ITARS = 'p_itars', TERRAN = 'p_terran', OTHER = 'p_other';
let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
setTimeout(() => { console.log('시간 초과'); process.exit(1); }, 60_000);

const itars = createInitialPlayerState('디애박') as any;
itars.faction = 'itars';
itars.research = { terraforming: 0, navigation: 2, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0 };
itars.ore = 4; itars.credits = 10; itars.knowledge = 2;
const terran = createInitialPlayerState('구구') as any;
terran.faction = 'terrans';
const other = createInitialPlayerState('구오') as any;
other.faction = 'lantids';
const g: any = {
	id: 'test-itars-terran-mine',
	players: { [ITARS]: itars, [TERRAN]: terran, [OTHER]: other },
	map: generateMap(),
	turnOrder: [OTHER, TERRAN, ITARS], currentPlayerIndex: 0,
	roundNumber: 3, hasDoneMainAction: false, gameLog: [], satellites: {}, roundScoringTiles: [], finalScoringTiles: [],
	availableBonusTiles: [], passingOrder: [], powerActions: [],
	currentPhase: 'gaia',
	pendingTechTileSelection: { playerId: ITARS, tileId: '', structureType: 'itars_pi_exchange' },
	itarsGaiaformerRemainingAfterTech: 0,
	terranCouncilQueueAfterItars: [{ playerId: TERRAN, tokenCount: 3 }],
	availableShipTechTileIds: ['ship-tech-2tf-mine'], shipTechPool: { 'ship-tech-2tf-mine': 4 },
};

executeSelectTechTile(ioStub, g, ITARS, 'ship-tech-2tf-mine');
check(g.itarsExchangeResumeAfterShipMine === true && g.pendingShipTechMine?.playerId === ITARS, '① 2TF+Mine 선택 → 무료 광산 대기');
const wait = mainActionWaitReason(g);
check(/테란 의회/.test(wait ?? ''), `① 의회 대기 판정은 그대로(테란 대기열): ${wait}`);
check(ownItarsShipFollowUp(g, ITARS), '① 아이타 본인은 광산·트랙 입구에서 의회 대기 면제');
check(!ownItarsShipFollowUp(g, TERRAN) && !ownItarsShipFollowUp(g, OTHER), '① 테란·다른 사람은 면제 아님(계속 막힘)');

const range = getEffectiveBaseRange(itars);
const planets = g.map.filter((t: any) => HOME_PLANETS.includes(t.type) && !t.structure && !t.ownerId);
let target: any = null;
for (const t of planets) {
	if (getTerraformStepsForFaction(g, 'itars', t.type) !== 2) continue;
	const a = planets.find((x: any) => x !== t && getDistance(x, t) <= range);
	if (!a) continue;
	a.ownerId = ITARS; a.structure = 'mine'; target = t; break;
}
check(!!target, '2스텝 행성 준비(하니스)');
if (target) {
	check(executeBuildMine(ioStub, g, ITARS, target.id) === true && target.ownerId === ITARS, '② 아이타 무료 광산 건설');
	check(g.pendingShipTechTrackAdvance?.playerId === ITARS && ownItarsShipFollowUp(g, ITARS), '② 트랙 전진 대기 — 여전히 아이타 본인 면제');
	check(executeAdvanceTech(ioStub, g, ITARS, 'terraforming') === true, '② 아이타 트랙 전진');
	check(g.pendingTerranCouncilBenefit?.playerId === TERRAN && !g.terranCouncilQueueAfterItars, `③ 테란 의회 선택으로 넘어감 (pendingTerranCouncilBenefit=${g.pendingTerranCouncilBenefit?.playerId})`);
	check(!ownItarsShipFollowUp(g, ITARS), '③ 아이타 후속 처리 끝 → 면제 해제');
}

console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
setTimeout(() => process.exit(bad === 0 ? 0 : 1), 50);
