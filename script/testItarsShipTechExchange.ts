/**
 * 회귀 테스트: 아이타(Itars) 의회 4토큰 교환 → 우주선 기술 타일 체인 (사용자 재검증 요청 2026-08-24).
 *
 * 시나리오 (모두 가이아 단계 = 액션 단계 시작 전, '아무의 턴도 아닌' 시점):
 *   A) 1O3K: 즉시효과 지급 + 트랙 전진 pending(fromItars) → 내 턴 아니어도 전진 가능, 메인 액션 미소모,
 *      잔여 토큰 교환 체인 재개.
 *   B) 2TF+FreeMine: pendingShipTechMine + 2스텝 + 무료광산 → 가이아 단계·남의 턴에도 2TF 행성에 건설
 *      (비용 0), 이어서 트랙 전진, 그 후 체인 재개(itarsExchangeResumeAfterShipMine 소비).
 *   C) 1O3K를 아이타가 시작 플레이어(currentPlayerIndex=본인)일 때 → hasDoneMainAction 미소모(첫 턴 보존).
 *
 * 사용: PORT=5098 npx tsx script/testItarsShipTechExchange.ts
 *   (server/gameState 임포트로 HTTP 서버가 뜨므로 빈 포트 지정, 끝에서 명시적 종료)
 */
import {
	executeSelectTechTile,
	executeBuildMine,
	executeAdvanceTech,
} from '../server/gameState';
import {
	createInitialPlayerState, generateMap, getDistance, getEffectiveBaseRange,
	getTerraformStepsForFaction, HOME_PLANETS,
} from '../shared/gameConfig';

const ioStub: any = { to: () => ({ emit: () => { }, except: () => ({ emit: () => { } }) }), emit: () => { } };

const ITARS = 'p_itars';
const OTHER = 'p_other';

function makeGame(opts: { itarsIsCurrent?: boolean } = {}): any {
	const itars = createInitialPlayerState('Itars') as any;
	itars.faction = 'itars';
	itars.research = { terraforming: 0, navigation: 2, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0 };
	itars.ore = 4; itars.credits = 10; itars.knowledge = 2;

	const other = createInitialPlayerState('Other') as any;
	other.faction = 'terran';

	const game: any = {
		id: 'test-itars-shiptech',
		players: { [ITARS]: itars, [OTHER]: other },
		map: generateMap(),
		turnOrder: [ITARS, OTHER],
		currentPlayerIndex: opts.itarsIsCurrent ? 0 : 1, // 기본: 아이타 턴이 아님
		roundNumber: 3,
		hasDoneMainAction: false,
		gameLog: [],
		satellites: {},
		roundScoringTiles: [],
		finalScoringTiles: [],
		availableBonusTiles: [],
		passingOrder: [],
		powerActions: [],
		currentPhase: 'gaiaPhase', // 교환은 액션 단계 시작 전
		// 아이타 의회 4토큰 교환에서 타일 선택 중 (잔여 4개 → 체인이 helperProceed 없이 교환 재개로 감)
		pendingTechTileSelection: { playerId: ITARS, tileId: '', structureType: 'itars_pi_exchange' },
		itarsGaiaformerRemainingAfterTech: 4,
		availableShipTechTileIds: ['ship-tech-2tf-mine', 'ship-tech-1o3k', 'ship-tech-nav+1'],
		shipTechPool: { 'ship-tech-2tf-mine': 4, 'ship-tech-1o3k': 4, 'ship-tech-nav+1': 4 },
	};

	// 사거리 기준점: 아무 행성 하나를 아이타 광산으로 (건설 테스트는 findTwoStepTarget이 앵커를 다시 놓음)
	const anchor = game.map.find((t: any) => HOME_PLANETS.includes(t.type) && !t.structure);
	anchor.ownerId = ITARS; anchor.structure = 'mine';
	return game;
}

/** 아이타 기준 정확히 2스텝 행성을 먼저 고르고, 그 사거리 안 행성에 아이타 광산(앵커)을 놓는다.
 *  무작위 맵에서 '기존 앵커 근처에 2스텝 행성' 조건이 자주 비어 실패하던 하니스 한계 회피. */
function findTwoStepTarget(game: any): any {
	const itars = game.players[ITARS];
	const range = getEffectiveBaseRange(itars);
	const planets = game.map.filter((t: any) => HOME_PLANETS.includes(t.type) && !t.structure && !t.ownerId);
	for (const t of planets) {
		if (getTerraformStepsForFaction(game, 'itars', t.type) !== 2) continue;
		const anchor = planets.find((a: any) => a !== t && getDistance(a, t) <= range);
		if (!anchor) continue;
		anchor.ownerId = ITARS; anchor.structure = 'mine';
		return t;
	}
	return null;
}

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
	console.log(`  ${cond ? 'OK  ' : '실패'} ${name}${detail ? ` — ${detail}` : ''}`);
	if (!cond) failed++;
};

console.log('A) 1O3K — 가이아 단계 · 아이타 턴 아님');
{
	const game = makeGame();
	const p = game.players[ITARS];
	const ore0 = p.ore, k0 = p.knowledge;
	executeSelectTechTile(ioStub, game, ITARS, 'ship-tech-1o3k');
	check('즉시효과 +1O +3K', p.ore === ore0 + 1 && p.knowledge === k0 + 3, `ore ${ore0}→${p.ore}, k ${k0}→${p.knowledge}`);
	check('트랙 전진 pending(fromItars)', game.pendingShipTechTrackAdvance?.playerId === ITARS && game.pendingShipTechTrackAdvance?.fromItars === true,
		JSON.stringify(game.pendingShipTechTrackAdvance));
	check('잔여 4토큰 교환 재개', game.pendingItarsGaiaformerExchange?.tokensRemaining === 4,
		JSON.stringify(game.pendingItarsGaiaformerExchange));
	const adv = executeAdvanceTech(ioStub, game, ITARS, 'economy');
	check('남의 턴·가이아 단계에도 트랙 전진 성공', adv === true && p.research.economy === 1, `advanced=${adv} economy=${p.research.economy}`);
	check('pending 해소', game.pendingShipTechTrackAdvance == null);
	check('메인 액션 미소모', game.hasDoneMainAction === false, `hasDoneMainAction=${game.hasDoneMainAction}`);
}

console.log('B) 2TF+FreeMine — 가이아 단계 · 아이타 턴 아님 · 2스텝 행성에 무료 건설');
{
	const game = makeGame();
	const p = game.players[ITARS];
	executeSelectTechTile(ioStub, game, ITARS, 'ship-tech-2tf-mine');
	check('2TF 스텝 + 무료광산 + 광산 pending', p.pendingTerraformSteps === 2 && p.nextMineFreeFromShipTech === true
		&& game.pendingShipTechMine?.playerId === ITARS,
		`steps=${p.pendingTerraformSteps} free=${p.nextMineFreeFromShipTech} pendingMine=${JSON.stringify(game.pendingShipTechMine)}`);
	check('체인 이연 플래그(잔여 보존)', (game as any).itarsExchangeResumeAfterShipMine === true && game.itarsGaiaformerRemainingAfterTech === 4,
		`resume=${(game as any).itarsExchangeResumeAfterShipMine} remaining=${game.itarsGaiaformerRemainingAfterTech}`);
	check('교환 모달은 아직 안 옴(광산 먼저)', game.pendingItarsGaiaformerExchange == null);

	const target = findTwoStepTarget(game);
	check('2스텝 대상 행성 존재(하니스)', !!target, target ? `${target.id} (${target.type})` : '맵에 없음');
	if (target) {
		const ore0 = p.ore, cr0 = p.credits;
		const built = executeBuildMine(ioStub, game, ITARS, target.id);
		check('남의 턴·가이아 단계에 건설 성공', built === true, `built=${built}`);
		check('광산 배치됨', target.ownerId === ITARS && target.structure === 'mine');
		check('무료(광물·크레딧 불변)', p.ore === ore0 && p.credits === cr0, `ore ${ore0}→${p.ore}, cr ${cr0}→${p.credits}`);
		check('테라폼 스텝 소진', (p.pendingTerraformSteps ?? 0) === 0, `steps=${p.pendingTerraformSteps}`);
		check('광산 pending 해소 → 트랙 전진 pending', game.pendingShipTechMine == null && game.pendingShipTechTrackAdvance?.playerId === ITARS,
			`mine=${JSON.stringify(game.pendingShipTechMine)} track=${JSON.stringify(game.pendingShipTechTrackAdvance)}`);
		const adv = executeAdvanceTech(ioStub, game, ITARS, 'terraforming');
		check('트랙 전진 성공', adv === true && p.research.terraforming === 1, `advanced=${adv} tf=${p.research.terraforming}`);
		check('트랙 후 체인 재개(교환 모달 복귀)', (game as any).itarsExchangeResumeAfterShipMine === false
			&& game.pendingItarsGaiaformerExchange?.tokensRemaining === 4,
			`resume=${(game as any).itarsExchangeResumeAfterShipMine} exchange=${JSON.stringify(game.pendingItarsGaiaformerExchange)}`);
		check('메인 액션 미소모', game.hasDoneMainAction === false, `hasDoneMainAction=${game.hasDoneMainAction}`);
	}
}

console.log('C) 1O3K — 아이타가 시작 플레이어(교환 시점에 currentPlayerIndex=본인)');
{
	const game = makeGame({ itarsIsCurrent: true });
	const p = game.players[ITARS];
	executeSelectTechTile(ioStub, game, ITARS, 'ship-tech-1o3k');
	const adv = executeAdvanceTech(ioStub, game, ITARS, 'science');
	check('트랙 전진 성공', adv === true && p.research.science === 1, `advanced=${adv} science=${p.research.science}`);
	check('첫 턴 보존(hasDoneMainAction === false)', game.hasDoneMainAction === false,
		`hasDoneMainAction=${game.hasDoneMainAction} (true면 액션 단계에서 첫 턴이 날아감)`);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 아이타 교환 우주선 기술 체인(1O3K·2TF+FreeMine)이 서버에서 정상 동작합니다.');
process.exit(0);
