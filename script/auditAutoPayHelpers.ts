/**
 * 전수 감사: 이번에 추가한 '자동 지불 보조' 3종이 어떤 상태·종족에서도 손해를 만들지 않는가.
 *
 * 눈으로 케이스를 고르는 대신, 상태 공간을 전부 돌면서 **자동화를 쓴 결과가 안 썼을 때보다
 * 모든 축(크레딧·광물·토큰·브레인 생존·지불 성공)에서 나쁘지 않은지**를 대조한다.
 *
 * 대상:
 *   ① 연방 위성 / 인공물 — 광물→토큰으로 부족분 메우기 + 소멸 확정 3그릇 토큰 크레딧 회수
 *   ② 타클론 파워 액션/우주선 액션 — 2그릇 태우기 계획
 *   ③ (참고) 발타크 포머→QIC는 별도 스크립트(testBalTakQicConvert.ts)에서 검증
 *
 * 사용: PORT=5098 npx tsx script/auditAutoPayHelpers.ts
 */
import {
	countSpendableTokens, doomedBowl3Tokens, planTokenSpend,
	planTaklonsPowerBurns, canSpendTaklonsPower, isBrainCashableBeforeTokenCost,
} from '../shared/gameConfig';
import { executeConvertResource, executeBurnPower, cashDoomedBowl3Tokens } from '../server/gameState';

const ioStub: any = { to: () => ({ emit: () => { } }), emit: () => { } };
const ME = 'p_a';

type Brain = 1 | 2 | 3 | null;
type St = { faction: string; p1: number; p2: number; p3: number; ore: number; brain: Brain; nevlasPI?: boolean; preserveBrain?: boolean };

function mk(s: St) {
	const player: any = {
		name: 'X', faction: s.faction, ore: s.ore, credits: 0, knowledge: 0, qic: 0,
		power1: s.p1, power2: s.p2, power3: s.p3, research: {}, techTiles: [], coveredTechTiles: [],
	};
	if (s.brain != null) player.brainStoneBowl = s.brain;
	if (s.preserveBrain) player.taklonsBrainPriority = false;   // '브레인 보존' 설정
	const map: any[] = s.nevlasPI ? [{ id: 'pi', q: 0, r: 0, type: 'terra', ownerId: ME, structure: 'planetary_institute' }] : [];
	const game: any = {
		id: 'g', currentPhase: 'main', players: { [ME]: player }, turnOrder: [ME],
		currentPlayerIndex: 0, roundNumber: 3, gameLog: [], gameLogSeq: 0, map, hasDoneMainAction: false,
	};
	return { game, player };
}

/** 서버 spendPowerTokens와 동일 동작(비공개 함수라 같은 규칙으로 재현) */
function pay(player: any, n: number): boolean {
	const plan = planTokenSpend(player, n);
	if (!plan) return false;
	player.power1 -= plan.from1; player.power2 -= plan.from2; player.power3 -= plan.from3;
	if (plan.useBrain) { player.brainStoneSpent = true; player.brainStoneBowl = undefined; }
	return true;
}

const snap = (p: any) => ({
	credits: p.credits ?? 0, ore: p.ore ?? 0,
	tokens: (p.power1 ?? 0) + (p.power2 ?? 0) + (p.power3 ?? 0),
	p3: p.power3 ?? 0,
	brainAlive: p.brainStoneSpent ? 0 : (p.brainStoneBowl != null ? 1 : 0),
});

let failed = 0, checked = 0;
const fail = (msg: string) => { if (failed < 12) console.log(`  실패 ${msg}`); failed++; };

const FACTIONS: St[] = [];
for (const faction of ['terran', 'xenos', 'itars', 'nevlas', 'taklons']) {
	for (const brain of (faction === 'taklons' ? [null, 1, 2, 3] as Brain[] : [null] as Brain[])) {
		for (const nevlasPI of (faction === 'nevlas' ? [false, true] : [false])) {
			for (const preserveBrain of (faction === 'taklons' ? [false, true] : [false])) {
				FACTIONS.push({ faction, p1: 0, p2: 0, p3: 0, ore: 0, brain, nevlasPI, preserveBrain });
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────
console.log('① 연방 위성 / 인공물 — 자동화가 어떤 축에서도 손해가 아닌가');
for (const base of FACTIONS) {
	for (let p1 = 0; p1 <= 3; p1++) for (let p2 = 0; p2 <= 3; p2++) for (let p3 = 0; p3 <= 3; p3++)
		for (let ore = 0; ore <= 3; ore++) for (let need = 1; need <= 6; need++) {
			const st: St = { ...base, p1, p2, p3, ore };

			// (A) 기준선: 자동화 없이 그냥 지불 시도
			const b = mk(st);
			const bOk = pay(b.player, need);
			const bs = snap(b.player);

			// (B) 자동화: 클라 로직 그대로 재현
			const a = mk(st);
			const have = countSpendableTokens(a.player);
			let aOk = false;
			// 회수는 서버가 지불 직전에 한다(gameState.cashDoomedBowl3Tokens) → 실제 프로덕션 함수를 그대로 태운다
			const cashAll = () => { cashDoomedBowl3Tokens(a.game, ME, need); };
			if (have >= need) {
				cashAll();
				aOk = pay(a.player, need);
			} else {
				const short = need - have;
				if ((a.player.ore ?? 0) >= short) {
					for (let i = 0; i < short; i++) executeConvertResource(ioStub, a.game, ME, '1ore-to-1token');
					cashAll();
					aOk = pay(a.player, need);
				}
			}
			checked++;
			const as = snap(a.player);
			const tag = `${base.faction}${base.brain ? `/brain${base.brain}` : ''}${base.nevlasPI ? '/PI' : ''}${base.preserveBrain ? '/보존' : ''} p=${p1},${p2},${p3} ore=${ore} need=${need}`;

			// 기준선이 성공했으면 자동화도 반드시 성공해야 한다
			if (bOk && !aOk) { fail(`기준선은 지불 성공인데 자동화 실패 — ${tag}`); continue; }
			if (!aOk) continue;                        // 둘 다 불가(광물로도 못 메움) → 검사 대상 아님
			// 자동화가 성공했으면 지불 후 남은 자원이 기준선보다 나쁘면 안 된다
			if (bOk) {
				if (as.credits < bs.credits) fail(`크레딧 감소 ${bs.credits}→${as.credits} — ${tag}`);
				if (as.ore < bs.ore) fail(`광물 감소 ${bs.ore}→${as.ore} — ${tag}`);
				// 브레인도 위성 비용에서 1개로 세어지므로 '조각 총수'로 비교한다.
				//   (타클론 보존 모드에서 자동화가 브레인 대신 일반 토큰을 내보내는 경우가 있는데,
				//    이는 총수 동일 + 브레인 생존이라 개선이지 손해가 아니다.)
				if (as.tokens + as.brainAlive < bs.tokens + bs.brainAlive)
					fail(`조각 총수 감소 ${bs.tokens + bs.brainAlive}→${as.tokens + as.brainAlive} — ${tag}`);
				if (as.brainAlive < bs.brainAlive) fail(`브레인 소멸(기준선은 생존) — ${tag}`);
			}
		}
}
console.log(`  ${checked}조합 검사 · 실패 ${failed}건`);

// ─────────────────────────────────────────────────────────────
// 위 감사는 '나빠지지 않음'만 본다 → 브레인 회수가 실제로 발동해 3크레딧을 버는지 양성 확인.
console.log('\n①-b 브레인 소멸 확정 시 3크레딧을 실제로 챙기는가');
{
	let fired = 0, gainOk = 0;
	for (const preserveBrain of [false, true])
		for (let p1 = 0; p1 <= 3; p1++) for (let p2 = 0; p2 <= 3; p2++) for (let p3 = 0; p3 <= 3; p3++)
			for (let need = 1; need <= 6; need++) {
				const st: St = { faction: 'taklons', p1, p2, p3, ore: 0, brain: 3, preserveBrain };
				const b = mk(st); const bOk = pay(b.player, need); const bc = snap(b.player).credits;
				const a = mk(st);
				if (countSpendableTokens(a.player) < need) continue;
				if (!isBrainCashableBeforeTokenCost(a.player, need)) continue;
				fired++;
				cashDoomedBowl3Tokens(a.game, ME, need);   // 일반 3그릇 + 브레인 회수(서버 실제 함수)
				const aOk = pay(a.player, need);
				const ac = snap(a.player).credits;
				if (bOk && aOk && ac >= bc + 3) gainOk++;
				else fail(`브레인 회수 이득 미확인 (기준 ${bc} → 자동 ${ac}, 지불 ${bOk}/${aOk}) — p=${p1},${p2},${p3} need=${need}${preserveBrain ? '/보존' : ''}`);
			}
	console.log(`  발동 ${fired}조합 · 3크레딧 확인 ${gainOk}건`);
	if (fired === 0) fail('브레인 회수가 한 번도 발동하지 않음(사실상 죽은 코드)');
}

// ─────────────────────────────────────────────────────────────
// 클라 토스트는 서버가 회수할 크레딧을 **예측**해서 보여준다(부족분 없는 경로 전용).
// 예측이 서버와 어긋나면 토스트가 거짓말을 하므로 그 일치를 못박는다.
console.log('\n①-c 클라 예측 = 서버 실제 회수액');
{
	let n = 0;
	for (const base of FACTIONS)
		for (let p1 = 0; p1 <= 3; p1++) for (let p2 = 0; p2 <= 3; p2++) for (let p3 = 0; p3 <= 3; p3++)
			for (let need = 1; need <= 6; need++) {
				const st: St = { ...base, p1, p2, p3, ore: 0 };
				const { game, player } = mk(st);
				if (countSpendableTokens(player) < need) continue;   // 부족분 있는 경로는 확인창이 안내 → 예측 안 씀
				const perToken = base.nevlasPI ? 2 : 1;              // Game.tsx creditsPerBowl3Token과 동일
				const predicted = doomedBowl3Tokens(player, need) * perToken
					+ (isBrainCashableBeforeTokenCost(player, need) ? 3 : 0);
				const before = player.credits ?? 0;
				const actual = cashDoomedBowl3Tokens(game, ME, need);
				n++;
				if (predicted !== actual) fail(`예측 ${predicted} ≠ 실제 ${actual} — ${base.faction}${base.nevlasPI ? '/PI' : ''}${base.brain ? `/brain${base.brain}` : ''} p=${p1},${p2},${p3} need=${need}`);
				if ((player.credits ?? 0) - before !== actual) fail(`반환값과 실제 크레딧 증가 불일치 — need=${need}`);
			}
	console.log(`  ${n}조합 대조`);
}

// ─────────────────────────────────────────────────────────────
console.log('\n② 타클론 태우기 계획 — 계획대로 태우면 반드시 지불 가능해지는가');
let tChecked = 0; const tFailBefore = failed;
for (const brain of [null, 1, 2, 3] as Brain[]) for (const preserveBrain of [false, true])
	for (let p1 = 0; p1 <= 2; p1++) for (let p2 = 0; p2 <= 6; p2++) for (let p3 = 0; p3 <= 4; p3++)
		for (let cost = 1; cost <= 5; cost++) {
			const st: St = { faction: 'taklons', p1, p2, p3, ore: 0, brain, preserveBrain };
			const { game, player } = mk(st);
			const plan = planTaklonsPowerBurns(player, cost);
			tChecked++;
			const tag = `brain=${brain}${preserveBrain ? '/보존' : ''} p=${p1},${p2},${p3} cost=${cost}`;
			if (!plan) {
				// 불가라고 했으면, 실제로 아무리 태워도 불가여야 한다
				let guard = 0;
				while (executeBurnPower(game, ME) && guard++ < 20) { /* 태울 수 있을 때까지 */ }
				if (canSpendTaklonsPower(player, 3, cost)) fail(`계획은 불가인데 태우니 가능 — ${tag}`);
				continue;
			}
			for (let i = 0; i < plan.burns; i++) {
				if (!executeBurnPower(game, ME)) { fail(`${i + 1}번째 태우기 실패(계획 ${plan.burns}회) — ${tag}`); break; }
			}
			if (!canSpendTaklonsPower(player, 3, cost)) fail(`계획대로 태웠는데 지불 불가 — ${tag}`);
			// 브레인 번은 2그릇 일반토큰을 1개만 써야 한다
			if (plan.brainBurnFirst && brain !== 2) fail(`브레인이 2그릇이 아닌데 brainBurnFirst — ${tag}`);
		}
console.log(`  ${tChecked}조합 검사 · 실패 ${failed - tFailBefore}건`);

console.log('');
if (failed > 0) { console.log(`총 실패 ${failed}건`); process.exit(1); }
console.log('OK: 전 조합에서 자동화가 기준선보다 나쁜 결과를 만들지 않습니다.');
process.exit(0);
