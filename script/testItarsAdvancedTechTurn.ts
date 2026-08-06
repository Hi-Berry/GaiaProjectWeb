/**
 * 회귀 테스트: 아이타(Itars) 의회 교환으로 고급 기술 타일을 받았을 때 첫 턴이 날아가지 않는지.
 *
 * 사용자 관측(2026-08-06): "아이타가 의회 능력으로 고급 기술(즉시 점수 주는 타일) 먹었을 때,
 *   1턴이었는데 자기 액션 없이 그냥 바로 2턴으로 넘어갔다."
 *
 * 원인: 아이타 의회 교환은 '가이아 단계'(액션 단계 시작 전)에 일어난다. 그런데 교환자가 시작 플레이어면
 *   그 시점에도 turnOrder[currentPlayerIndex] === 본인이라 executeAdvanceTech의 isMyTurn이 true가 되고,
 *   고급 타일 후속 트랙 전진이 game.hasDoneMainAction = true를 세워버렸다.
 *   라운드 시작은 이 플래그를 리셋하지 않으므로(리셋은 턴 종료 시점) 첫 턴이 통째로 소모됐다.
 *
 * 검사:
 *   1) 아이타 교환 유래 고급 타일 → 트랙 전진 후에도 hasDoneMainAction === false (첫 턴 보존)
 *   2) 대조군: 평범한 트랙4 고급 타일(자기 액션 중) → hasDoneMainAction === true (기존 동작 유지)
 *
 * 사용: PORT=5099 npx tsx script/testItarsAdvancedTechTurn.ts
 *   (server/gameState를 임포트하면 server/index가 딸려와 HTTP 서버가 뜬다 → 빈 포트를 주고 끝에서 명시적 종료)
 */
import {
	executeSelectAdvancedTechTile,
	executeCoverAdvancedTechTile,
	executeAdvanceTech,
} from '../server/gameState';
import { createInitialPlayerState, generateMap } from '../shared/gameConfig';

const ioStub: any = { to: () => ({ emit: () => { } }), emit: () => { } };

const ADV_TILE = 'adv-imm-2vp-mine'; // 즉시 점수형 고급 타일 (사용자 사례와 동일 계열)
const ITARS = 'p_itars';
const OTHER = 'p_other';

function makeGame(opts: { fromItarsExchange: boolean }): any {
	const itars = createInitialPlayerState('Itars') as any;
	itars.faction = 'itars';
	itars.techTiles = ['tech-1o'];                 // 덮을 일반 타일 1개 (커버 대상)
	itars.coveredTechTiles = [];
	itars.federations = [{ rewardId: 'fed-8vp', isGreen: true }]; // 고급 타일 획득에 초록 연방 1개 필요
	itars.research = { terraforming: 0, navigation: 0, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 4 };

	const other = createInitialPlayerState('Other') as any;
	other.faction = 'terran';

	const game: any = {
		id: 'test-itars',
		players: { [ITARS]: itars, [OTHER]: other },
		map: generateMap(),
		turnOrder: [ITARS, OTHER],   // 아이타가 시작 플레이어(= 사용자 사례의 '1턴')
		currentPlayerIndex: 0,       // → isMyTurn === true 인 상태
		roundNumber: 2,
		hasDoneMainAction: false,
		advancedTechTilesByTrack: { science: { id: ADV_TILE, label: '', description: '', isAdvanced: true } },
		gameLog: [],
		satellites: {},
		roundScoringTiles: [],   // applyRoundMissionScore가 참조
		finalScoringTiles: [],
		availableBonusTiles: [],
		passingOrder: [],
		powerActions: [],
		// 아이타 교환 케이스: 가이아 단계에서 교환이 진행 중 (액션 단계 전)
		currentPhase: opts.fromItarsExchange ? 'gaiaPhase' : 'main',
		pendingTechTileSelection: {
			playerId: ITARS,
			tileId: '',
			structureType: opts.fromItarsExchange ? 'itars_pi_exchange' : 'research_lab',
		},
	};
	return game;
}

/** 고급 타일 선택 → 커버 → 트랙 1칸 전진까지 실제 서버 함수로 진행 */
function runFlow(game: any): { selected: boolean; covered: boolean; advanced: boolean } {
	// 소켓 경로(사람)는 phase 게이트가 없다. 봇/서버 공용 함수는 main 전용이라, 교환 케이스는
	// 소켓 경로와 동일하게 동작시키기 위해 선택 단계에서만 phase를 main으로 맞춰 준다.
	const realPhase = game.currentPhase;
	game.currentPhase = 'main';
	const selected = executeSelectAdvancedTechTile(ioStub, game, ITARS, ADV_TILE, 'science');
	const covered = executeCoverAdvancedTechTile(ioStub, game, ITARS, 'tech-1o');
	// 트랙 전진은 가이아 단계에서도 해소 가능(2026-08-05 수정) → 실제 상황대로 되돌린다
	game.currentPhase = realPhase;
	const advanced = executeAdvanceTech(ioStub, game, ITARS, 'navigation');
	return { selected, covered, advanced };
}

let failed = 0;
const check = (name: string, cond: boolean, detail: string) => {
	console.log(`  ${cond ? 'OK  ' : '실패'} ${name} — ${detail}`);
	if (!cond) failed++;
};

console.log('1) 아이타 의회 교환으로 받은 고급 타일 (가이아 단계, 본인이 시작 플레이어)');
{
	const game = makeGame({ fromItarsExchange: true });
	const r = runFlow(game);
	check('선택/커버/트랙전진 진행', r.selected && r.covered && r.advanced,
		`selected=${r.selected} covered=${r.covered} advanced=${r.advanced}`);
	check('교환 유래 표시 전달', game.players[ITARS].techTiles.includes(ADV_TILE),
		`techTiles=${JSON.stringify(game.players[ITARS].techTiles)}`);
	check('첫 턴이 보존됨 (hasDoneMainAction === false)', game.hasDoneMainAction === false,
		`hasDoneMainAction=${game.hasDoneMainAction} (true면 액션 단계 시작 시 첫 턴이 통째로 스킵됨)`);
}

console.log('2) 대조군: 평범한 고급 타일 획득(자기 액션 중)');
{
	const game = makeGame({ fromItarsExchange: false });
	const r = runFlow(game);
	check('선택/커버/트랙전진 진행', r.selected && r.covered && r.advanced,
		`selected=${r.selected} covered=${r.covered} advanced=${r.advanced}`);
	check('메인 액션 소모 유지 (hasDoneMainAction === true)', game.hasDoneMainAction === true,
		`hasDoneMainAction=${game.hasDoneMainAction}`);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 아이타 교환 고급 타일은 첫 턴을 소모하지 않고, 일반 획득은 종전대로 메인 액션을 소모합니다.');
process.exit(0); // 임포트로 뜬 서버가 프로세스를 붙잡고 있으므로 명시적 종료
