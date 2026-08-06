/**
 * 검증: 이미 패스한 플레이어에게 파워 누출(leech)을 물어볼지 판정하는 규칙.
 *   isPowerLeechPointlessAfterIncome — 다음 라운드 수익(그릇1 토큰 추가 + 파워 수익)만으로도
 *   토큰이 전부 그릇3에 차면, 지금 받아봐야 결과가 같으므로 묻지 않고 자동 거절한다.
 *
 * 사용자 요청(2026-08-06): "이미 패스한 사람은 수익 파워 받으면 풀파워일 수도 있는데
 *   (토큰 추가, 파워 수익 다 고려) 그런 유저한테는 파워 받을래? 안 물어봤으면 좋겠어. 다 거절할 테니까"
 *
 * 사용: npx tsx script/testPassedLeechAutoDecline.ts
 */
import { isPowerLeechPointlessAfterIncome, getMaxPowerGain, type GaiaGameState } from '../shared/gameConfig';

/** 구조물 없는 최소 게임 — 수익은 종족 기본 + 보너스 타일로만 결정되게 한다 */
function makeGame(opts: {
	faction?: string;
	bonusTile?: string;
	p1: number; p2: number; p3: number;
	gaiaformerPower?: number;
}): GaiaGameState {
	const player: any = {
		name: 'P', faction: opts.faction ?? 'terran',
		power1: opts.p1, power2: opts.p2, power3: opts.p3,
		gaiaformerPower: opts.gaiaformerPower ?? 0,
		bonusTile: opts.bonusTile ?? null,
		techTiles: [], coveredTechTiles: [], federations: [],
		research: { terraforming: 0, navigation: 0, artificialIntelligence: 0, gaiaProject: 0, economy: 0, science: 0 },
		hasPassed: true,
	};
	return { players: { p: player }, map: [], turnOrder: ['p'], roundNumber: 3 } as any;
}

let failed = 0;
function check(name: string, actual: boolean, expected: boolean, extra = '') {
	const ok = actual === expected;
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name} → ${actual}${ok ? '' : ` (기대 ${expected})`}${extra ? ` ${extra}` : ''}`);
	if (!ok) failed++;
}

console.log('수익만으로 풀파워가 되는가? (true = 묻지 않고 자동 거절)');

// 그릇2에 1개(충전 여력 1) + 4파워 수익 → 수익만으로 다 올라감 → 누출 무의미
{
	const g = makeGame({ bonusTile: 'bon-4pw-bigbuilding', p1: 0, p2: 1, p3: 5 });
	check('여력1, 파워수익4 → 무의미', isPowerLeechPointlessAfterIncome(g, 'p'), true,
		`(현재 여력 ${getMaxPowerGain(g.players['p'])})`);
}

// 그릇1에 2개(여력 4) + 2파워 수익 → 여력이 남음 → 받아두면 다음 라운드에 실제 이득 → 계속 물어봐야 함
{
	const g = makeGame({ bonusTile: 'bon-2pw-range3', p1: 2, p2: 0, p3: 4 });
	check('여력4, 파워수익2 → 유의미(물어봄)', isPowerLeechPointlessAfterIncome(g, 'p'), false,
		`(현재 여력 ${getMaxPowerGain(g.players['p'])})`);
}

// 토큰 추가를 반드시 고려해야 하는 케이스: 여력1인데 파워수익 2 → 언뜻 다 찰 것 같지만
// 토큰 +2가 그릇1에 들어와 여력이 5로 늘어난다 → 아직 누출이 의미 있음
{
	const g = makeGame({ bonusTile: 'bon-1o-2tokens', p1: 0, p2: 1, p3: 5 });
	const p: any = g.players['p'];
	p.research.economy = 1; // 경제 트랙 1: 파워 수익 확보(토큰 추가와 함께 계산되는지 확인)
	check('여력1 + 토큰추가2 → 유의미(토큰 고려됨)', isPowerLeechPointlessAfterIncome(g, 'p'), false,
		`(현재 여력 ${getMaxPowerGain(p)})`);
}

// 파워 수익이 아예 없으면 저절로 찰 수 없다 → 물어봄
{
	const g = makeGame({ bonusTile: 'bon-2c-1q', p1: 0, p2: 1, p3: 5 });
	check('파워 수익 없음 → 유의미(물어봄)', isPowerLeechPointlessAfterIncome(g, 'p'), false);
}

// 이타르(가이아 구역 토큰)·타클론(브레인 스톤)은 판정 제외 — 항상 종전대로 물어봄
{
	const g = makeGame({ faction: 'itars', bonusTile: 'bon-4pw-bigbuilding', p1: 0, p2: 1, p3: 5 });
	check('이타르는 판정 제외', isPowerLeechPointlessAfterIncome(g, 'p'), false);
}
{
	const g = makeGame({ faction: 'taklons', bonusTile: 'bon-4pw-bigbuilding', p1: 0, p2: 1, p3: 5 });
	check('타클론은 판정 제외', isPowerLeechPointlessAfterIncome(g, 'p'), false);
}

// 가이아 포머 구역 토큰은 판정에 영향을 주지 않는다 (사용자 지적):
//   그릇 밖이라 충전 여력에 안 잡히고, 복귀는 '수익 단계가 모두 끝난 뒤'라 수익 파워를 흡수하지 못한다.
//   → 누출을 받든 말든 복귀는 똑같이 일어나므로, 토큰이 있어도 결론은 '무의미(자동 거절)' 그대로.
{
	const g = makeGame({ bonusTile: 'bon-4pw-bigbuilding', p1: 0, p2: 1, p3: 5, gaiaformerPower: 2 });
	check('가이아 구역 복귀 토큰은 결론을 바꾸지 않음', isPowerLeechPointlessAfterIncome(g, 'p'), true);
}
// 같은 상태에서 가이아 토큰만 뺀 대조군 — 두 결과가 같아야 한다(토큰이 판정에 개입하지 않음)
{
	const withGaia = makeGame({ bonusTile: 'bon-4pw-bigbuilding', p1: 1, p2: 2, p3: 3, gaiaformerPower: 3 });
	const without = makeGame({ bonusTile: 'bon-4pw-bigbuilding', p1: 1, p2: 2, p3: 3 });
	const a = isPowerLeechPointlessAfterIncome(withGaia, 'p');
	const b = isPowerLeechPointlessAfterIncome(without, 'p');
	check('가이아 토큰 유무가 판정을 바꾸지 않음', a === b, true, `(있음=${a}, 없음=${b})`);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 토큰 추가·파워 수익을 모두 반영해 판정합니다.');
