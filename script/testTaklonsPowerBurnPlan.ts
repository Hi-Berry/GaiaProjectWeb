/**
 * 회귀 테스트: 타클론 파워 액션/우주선 액션의 '자동 태우기' 계획(planTaklonsPowerBurns).
 *
 * 사용자 요청(2026-08-13): "3그릇에 브레인스톤 있어서 2그릇 태워서 일반 토큰이 3그릇 오는 경우나
 *   브레인 스톤이 2그릇에 있어서 태우고 3그릇 가서 액션 하는 경우 두 가지 모두 되면 좋겠어"
 *
 * 계획이 서버의 실제 번 동작(executeBurnPower)과 어긋나면 확인창을 눌러도 액션이 실패하므로,
 * 계획 결과를 **서버 함수로 실제 시뮬레이션**해서 지불 가능해지는지까지 검증한다.
 *
 * 사용: PORT=5095 npx tsx script/testTaklonsPowerBurnPlan.ts
 */
import { planTaklonsPowerBurns, canSpendTaklonsPower } from '../shared/gameConfig';
import { executeBurnPower } from '../server/gameState';

type P = { power1: number; power2: number; power3: number; brainStoneBowl: 1 | 2 | 3 | null; brainStoneInGaia?: boolean };

function mk(p: P) {
	const player: any = {
		name: 'Tak', faction: 'taklons', ore: 9, credits: 9, knowledge: 9, qic: 9,
		power1: p.power1, power2: p.power2, power3: p.power3,
		research: {}, techTiles: [], coveredTechTiles: [],
	};
	if (p.brainStoneBowl) player.brainStoneBowl = p.brainStoneBowl;
	if (p.brainStoneInGaia) player.brainStoneInGaia = true;
	const game: any = {
		id: 'g', currentPhase: 'main', players: { me: player }, turnOrder: ['me'],
		currentPlayerIndex: 0, roundNumber: 3, gameLog: [], gameLogSeq: 0, map: [],
	};
	return { game, player };
}

let failed = 0;
const check = (name: string, ok: boolean, extra = '') => {
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name}${extra ? ` — ${extra}` : ''}`);
	if (!ok) failed++;
};

/** 계획대로 실제로 태운 뒤 정말 지불 가능해지는지 */
function simulate(state: P, need: number, expect: { burns: number; brainBurnFirst: boolean } | null, name: string) {
	const { game, player } = mk(state);
	const plan = planTaklonsPowerBurns(player, need);
	if (expect === null) {
		check(name, plan === null, `계획=${JSON.stringify(plan)}`);
		return;
	}
	if (!plan) { check(name, false, '계획이 null인데 가능해야 함'); return; }
	const planOk = plan.burns === expect.burns && plan.brainBurnFirst === expect.brainBurnFirst;
	// 계획대로 서버 번을 실행 → 지불 가능해져야 한다
	let burnOk = true;
	for (let i = 0; i < plan.burns; i++) if (!executeBurnPower(game, 'me')) burnOk = false;
	const payable = canSpendTaklonsPower(player, 3, need);
	check(name, planOk && burnOk && payable,
		`계획 ${JSON.stringify(plan)} (기대 ${JSON.stringify(expect)}) · 번실행 ${burnOk} · 태운뒤 지불가능 ${payable} · 남은 p2=${player.power2} p3=${player.power3} brain=${player.brainStoneBowl}`);
}

console.log('① 이미 지불 가능하면 태우지 않는다');
simulate({ power1: 0, power2: 4, power3: 3, brainStoneBowl: 1 }, 3, { burns: 0, brainBurnFirst: false }, '일반토큰 3개로 3파워');
simulate({ power1: 0, power2: 4, power3: 0, brainStoneBowl: 3 }, 3, { burns: 0, brainBurnFirst: false }, '3그릇 브레인만으로 3파워');
simulate({ power1: 0, power2: 4, power3: 1, brainStoneBowl: 3 }, 4, { burns: 0, brainBurnFirst: false }, '브레인(3)+토큰1 = 4파워');

console.log('\n② 브레인이 3그릇인데 모자람 → 일반 번(2그릇 2개 → 3그릇 1개)');
// 브레인(3) + 토큰0 = 3파워, 4파워 필요 → 1번 태워 토큰 1개 확보
simulate({ power1: 0, power2: 2, power3: 0, brainStoneBowl: 3 }, 4, { burns: 1, brainBurnFirst: false }, '4파워에 1회');
// 브레인(3) = 3파워, 6파워 필요 → 3회
simulate({ power1: 0, power2: 6, power3: 0, brainStoneBowl: 3 }, 6, { burns: 3, brainBurnFirst: false }, '6파워에 3회');
// 2그릇이 모자라 불가능
simulate({ power1: 0, power2: 1, power3: 0, brainStoneBowl: 3 }, 4, null, '2그릇 1개뿐이면 불가능');

console.log('\n③ 브레인이 2그릇 → 첫 번에 브레인이 3그릇으로(일반토큰 1개만 소모, +3파워)');
// 브레인 2그릇, 3그릇 비었고 3파워 필요 → 브레인 번 1회면 브레인이 3그릇(=3파워)
simulate({ power1: 0, power2: 1, power3: 0, brainStoneBowl: 2 }, 3, { burns: 1, brainBurnFirst: true }, '3파워에 브레인 번 1회');
// 4파워 필요 → 브레인 번(+3) 후 일반 번(+1) 1회 = 총 2회, 2그릇 1+2=3개
simulate({ power1: 0, power2: 3, power3: 0, brainStoneBowl: 2 }, 4, { burns: 2, brainBurnFirst: true }, '4파워에 브레인 번 + 일반 번');
// 브레인 번 뒤 2그릇이 1개만 남아 일반 번 불가 → 불가능
simulate({ power1: 0, power2: 2, power3: 0, brainStoneBowl: 2 }, 4, null, '브레인 번 후 2그릇 부족이면 불가능');

console.log('\n④ 브레인이 가이아 지역이면 없는 것으로 취급(일반 번만)');
simulate({ power1: 0, power2: 4, power3: 0, brainStoneBowl: 2, brainStoneInGaia: true }, 2, { burns: 2, brainBurnFirst: false }, '가이아 브레인은 못 씀');

console.log('\n⑤ 브레인이 1그릇이면 번으로 못 끌어올린다(2그릇 일반 번만)');
simulate({ power1: 0, power2: 4, power3: 0, brainStoneBowl: 1 }, 2, { burns: 2, brainBurnFirst: false }, '1그릇 브레인은 무관');

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 두 경우 모두 계획대로 태우면 액션이 지불 가능해집니다.');
process.exit(0);
