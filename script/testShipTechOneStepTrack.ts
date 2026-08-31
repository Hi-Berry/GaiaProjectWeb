/**
 * 회귀 테스트: 우주선 기술 타일 선택 시 트랙까지 한 번에(one-step) 전송하는 UX (사용자 요청 2026-08-31).
 *
 * 배경: 예전엔 우주선 타일을 고르면 pendingShipTechTrackAdvance만 걸리고 모달이 닫혀
 *   R창을 다시 열어 트랙을 골라야 했다(아이타 가이아 교환에서 특히 혼란).
 *   이제 select_tech_tile에 trackId가 같이 오면 서버가 즉시 트랙 전진까지 해소한다.
 *
 * 시나리오:
 *   A) 아이타 교환 + 1O3K + trackId: 즉시효과 + 트랙 전진 + pending 해소 + 잔여 토큰 체인 재개 + 메인 액션 미소모.
 *   B) 아이타 교환 + 1O3K + trackId 없음(기존 경로): pending 유지 — 종전 흐름 회귀 없음.
 *   C) 5레벨 진입 가드: 트랙이 4레벨이고 advanceToLevel5 미확인이면 즉시 전진하지 않고 pending 유지.
 *   D) 일반(연구소 건설 등) 메인 액션 유래 + trackId: 전진 + hasDoneMainAction 소모.
 *   E) 2TF+Mine은 trackId가 와도 광산 먼저(기존 흐름) — 즉시 전진하지 않음.
 *
 * 사용: npx tsx script/testShipTechOneStepTrack.ts
 */
import { executeSelectTechTile } from '../server/gameState';
import { createInitialPlayerState, generateMap, HOME_PLANETS } from '../shared/gameConfig';

const ioStub: any = { to: () => ({ emit: () => { }, except: () => ({ emit: () => { } }) }), emit: () => { } };

const ITARS = 'p_itars';
const OTHER = 'p_other';

function makeGame(opts: { structureType?: string; phase?: string; itarsIsCurrent?: boolean } = {}): any {
	const itars = createInitialPlayerState('Itars') as any;
	itars.faction = 'itars';
	itars.research = { terraforming: 0, navigation: 2, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0 };
	itars.ore = 4; itars.credits = 10; itars.knowledge = 2;

	const other = createInitialPlayerState('Other') as any;
	other.faction = 'terran';

	const game: any = {
		id: 'test-shiptech-onestep',
		players: { [ITARS]: itars, [OTHER]: other },
		map: generateMap(),
		turnOrder: [ITARS, OTHER],
		currentPlayerIndex: opts.itarsIsCurrent ? 0 : 1,
		roundNumber: 3,
		hasDoneMainAction: false,
		gameLog: [],
		satellites: {},
		roundScoringTiles: [],
		finalScoringTiles: [],
		availableBonusTiles: [],
		passingOrder: [],
		powerActions: [],
		currentPhase: opts.phase ?? 'gaiaPhase',
		pendingTechTileSelection: { playerId: ITARS, tileId: '', structureType: opts.structureType ?? 'itars_pi_exchange' },
		itarsGaiaformerRemainingAfterTech: opts.structureType === 'itars_pi_exchange' || !opts.structureType ? 4 : undefined,
		availableShipTechTileIds: ['ship-tech-2tf-mine', 'ship-tech-1o3k', 'ship-tech-nav+1'],
		shipTechPool: { 'ship-tech-2tf-mine': 4, 'ship-tech-1o3k': 4, 'ship-tech-nav+1': 4 },
	};
	const anchor = game.map.find((t: any) => HOME_PLANETS.includes(t.type) && !t.structure);
	anchor.ownerId = ITARS; anchor.structure = 'mine';
	return game;
}

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
	console.log(`  ${cond ? 'OK  ' : '실패'} ${name}${detail ? ` — ${detail}` : ''}`);
	if (!cond) failed++;
};

console.log('A) 아이타 교환 + 1O3K + trackId(economy) — 한 번에 해소');
{
	const game = makeGame();
	const p = game.players[ITARS];
	const ore0 = p.ore, k0 = p.knowledge;
	executeSelectTechTile(ioStub, game, ITARS, 'ship-tech-1o3k', 'economy');
	check('즉시효과 +1O +3K', p.ore === ore0 + 1 && p.knowledge === k0 + 3, `ore ${ore0}→${p.ore}, k ${k0}→${p.knowledge}`);
	check('트랙 즉시 전진', p.research.economy === 1, `economy=${p.research.economy}`);
	check('트랙 pending 없음(즉시 해소)', game.pendingShipTechTrackAdvance == null, JSON.stringify(game.pendingShipTechTrackAdvance));
	check('잔여 4토큰 교환 재개', game.pendingItarsGaiaformerExchange?.tokensRemaining === 4, JSON.stringify(game.pendingItarsGaiaformerExchange));
	check('메인 액션 미소모', game.hasDoneMainAction === false, `hasDoneMainAction=${game.hasDoneMainAction}`);
}

console.log('B) 아이타 교환 + 1O3K + trackId 없음 — 기존 2단계 경로 유지');
{
	const game = makeGame();
	executeSelectTechTile(ioStub, game, ITARS, 'ship-tech-1o3k');
	check('트랙 pending 유지(fromItars)', game.pendingShipTechTrackAdvance?.playerId === ITARS && game.pendingShipTechTrackAdvance?.fromItars === true,
		JSON.stringify(game.pendingShipTechTrackAdvance));
}

console.log('C) 5레벨 진입 가드 — economy 4레벨 + advanceToLevel5 미확인이면 즉시 전진 안 함');
{
	const game = makeGame();
	const p = game.players[ITARS];
	p.research.economy = 4;
	executeSelectTechTile(ioStub, game, ITARS, 'ship-tech-1o3k', 'economy');
	check('전진 안 됨(4레벨 유지)', p.research.economy === 4, `economy=${p.research.economy}`);
	check('트랙 pending 유지(기존 경로로 선택)', game.pendingShipTechTrackAdvance?.playerId === ITARS, JSON.stringify(game.pendingShipTechTrackAdvance));
}

console.log('D) 일반 메인 액션 유래(연구소) + trackId — 전진 + 메인 액션 소모');
{
	const game = makeGame({ structureType: 'research_lab', phase: 'main', itarsIsCurrent: true });
	const p = game.players[ITARS];
	executeSelectTechTile(ioStub, game, ITARS, 'ship-tech-nav+1', 'science');
	check('트랙 즉시 전진', p.research.science === 1, `science=${p.research.science}`);
	check('트랙 pending 없음', game.pendingShipTechTrackAdvance == null, JSON.stringify(game.pendingShipTechTrackAdvance));
	check('메인 액션 소모(본인 턴·비교환)', game.hasDoneMainAction === true, `hasDoneMainAction=${game.hasDoneMainAction}`);
}

console.log('E) 2TF+Mine + trackId — 광산 먼저(기존 흐름), 즉시 전진 안 함');
{
	const game = makeGame();
	const p = game.players[ITARS];
	executeSelectTechTile(ioStub, game, ITARS, 'ship-tech-2tf-mine', 'terraforming');
	check('광산 pending 우선', game.pendingShipTechMine?.playerId === ITARS, JSON.stringify(game.pendingShipTechMine));
	check('트랙 전진 안 됨', p.research.terraforming === 0, `tf=${p.research.terraforming}`);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 우주선 기술 타일 one-step(타일+트랙 동시) 경로가 정상 동작합니다.');
process.exit(0);
