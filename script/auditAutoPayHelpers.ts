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
	planTaklonsPowerBurns, canSpendTaklonsPower,
} from '../shared/gameConfig';
import { executeConvertResource, executeBurnPower } from '../server/gameState';

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
			if (have >= need) {
				const d = doomedBowl3Tokens(a.player, need);
				for (let i = 0; i < d; i++) executeConvertResource(ioStub, a.game, ME, '1power-to-1credit');
				aOk = pay(a.player, need);
			} else {
				const short = need - have;
				if ((a.player.ore ?? 0) >= short) {
					for (let i = 0; i < short; i++) executeConvertResource(ioStub, a.game, ME, '1ore-to-1token');
					// 변환 후 총 토큰 = 필요 수 → 3그릇 일반 토큰은 전부 소멸 확정
					const cash = a.player.power3 ?? 0;
					for (let i = 0; i < cash; i++) executeConvertResource(ioStub, a.game, ME, '1power-to-1credit');
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
