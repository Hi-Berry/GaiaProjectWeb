/**
 * 회귀 테스트: '토큰 N개' 비용에서 타클론 브레인 스톤을 쓸지 정하는 planTokenSpend.
 * 연방 위성·트왈라잇 인공물(spendPowerTokens)과 가이아포밍(executePlaceGaiaformer)이 같이 쓴다.
 *
 * 사용자 규칙(2026-08-11):
 *  - 브레인 우선 = 브레인을 큰 파워 액션용으로 아끼는 설정 → 토큰 비용엔 안 쓴다. 모자랄 때만 마지막 1개 충당.
 *  - 브레인 보존 = 파워로 안 쓸 브레인이니 토큰 비용으로 먼저 내보낸다. 단 '마지막으로 손대는 그릇'보다
 *    아래 그릇에 있을 때만 — 그래야 더 충전된 토큰이 남아 손해가 없다. 같은 그릇이면 브레인이 더 값지다.
 *
 * 사용: npx tsx script/testBrainTokenSpendPlan.ts   (shared만 임포트 — 서버 안 뜸)
 */
import { planTokenSpend } from '../shared/gameConfig';

type P = { power1: number; power2: number; power3: number; brainStoneBowl?: 1 | 2 | 3; brainStoneInGaia?: boolean; brainStoneSpent?: boolean; taklonsBrainPriority?: boolean };
const tak = (p: P) => ({ faction: 'taklons', ...p } as any);
const other = (p: P) => ({ faction: 'terran', ...p } as any);

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	console.log(`  ${ok ? 'OK  ' : '실패'} ${name} → ${JSON.stringify(actual)}${ok ? '' : ` (기대 ${JSON.stringify(expected)})`}`);
	if (!ok) failed++;
};
const plan = (from1: number, from2: number, from3: number, useBrain: boolean) => ({ from1, from2, from3, useBrain });

// --- 브레인 우선(기본): 토큰 비용엔 안 쓴다 ---
check('우선: 일반 토큰만으로 충분 → 브레인 미사용',
	planTokenSpend(tak({ power1: 5, power2: 2, power3: 0, brainStoneBowl: 1, taklonsBrainPriority: true }), 6), plan(5, 1, 0, false));
check('우선: 모자라면 마지막 1개만 브레인 (액션 자체는 가능해야)',
	planTokenSpend(tak({ power1: 2, power2: 0, power3: 0, brainStoneBowl: 3, taklonsBrainPriority: true }), 3), plan(2, 0, 0, true));
check('설정 미지정(undefined)은 우선과 동일',
	planTokenSpend(tak({ power1: 5, power2: 2, power3: 0, brainStoneBowl: 1 }), 6), plan(5, 1, 0, false));

// --- 브레인 보존: 아래 그릇이면 먼저 내보낸다 ---
check('보존: 브레인 1그릇 · 마지막이 2그릇 → 맞바꿈 (사용자 예시)',
	planTokenSpend(tak({ power1: 5, power2: 2, power3: 0, brainStoneBowl: 1, taklonsBrainPriority: false }), 6), plan(5, 0, 0, true));
check('보존: 브레인 1그릇 · 마지막이 3그릇 → 맞바꿈',
	planTokenSpend(tak({ power1: 2, power2: 0, power3: 2, brainStoneBowl: 1, taklonsBrainPriority: false }), 3), plan(2, 0, 0, true));
check('보존: 브레인 2그릇 · 마지막이 3그릇 → 맞바꿈',
	planTokenSpend(tak({ power1: 1, power2: 1, power3: 3, brainStoneBowl: 2, taklonsBrainPriority: false }), 4), plan(1, 1, 1, true));
check('보존: 브레인이 마지막 그릇과 같음 → 그대로 둔다(브레인이 더 값짐)',
	planTokenSpend(tak({ power1: 0, power2: 4, power3: 3, brainStoneBowl: 3, taklonsBrainPriority: false }), 6), plan(0, 4, 2, false));
check('보존: 브레인이 마지막 그릇보다 위 → 그대로 둔다',
	planTokenSpend(tak({ power1: 6, power2: 0, power3: 0, brainStoneBowl: 3, taklonsBrainPriority: false }), 6), plan(6, 0, 0, false));
check('보존: 1그릇만 쓰고 브레인도 1그릇 → 동률이라 그대로',
	planTokenSpend(tak({ power1: 6, power2: 0, power3: 0, brainStoneBowl: 1, taklonsBrainPriority: false }), 6), plan(6, 0, 0, false));

// --- 공통 경계 ---
check('브레인까지 합쳐도 모자라면 null',
	planTokenSpend(tak({ power1: 1, power2: 0, power3: 0, brainStoneBowl: 3, taklonsBrainPriority: false }), 3), null);
check('가이아 영역의 브레인은 없는 것으로',
	planTokenSpend(tak({ power1: 2, power2: 0, power3: 0, brainStoneBowl: 1, brainStoneInGaia: true, taklonsBrainPriority: false }), 3), null);
check('이미 소멸한 브레인도 없는 것으로',
	planTokenSpend(tak({ power1: 2, power2: 0, power3: 0, brainStoneSpent: true, taklonsBrainPriority: false }), 3), null);
check('타클론이 아니면 브레인 개념 없음',
	planTokenSpend(other({ power1: 5, power2: 2, power3: 0 }), 6), plan(5, 1, 0, false));
check('0개 요청은 아무것도 안 냄',
	planTokenSpend(tak({ power1: 5, power2: 0, power3: 0, brainStoneBowl: 1, taklonsBrainPriority: false }), 0), plan(0, 0, 0, false));

// 낸 개수는 항상 요청 개수와 같아야 한다(브레인=1개)
for (const [n, p] of [
	[6, tak({ power1: 5, power2: 2, power3: 0, brainStoneBowl: 1, taklonsBrainPriority: false })],
	[4, tak({ power1: 1, power2: 1, power3: 3, brainStoneBowl: 2, taklonsBrainPriority: false })],
	[3, tak({ power1: 2, power2: 0, power3: 0, brainStoneBowl: 3, taklonsBrainPriority: true })],
] as Array<[number, any]>) {
	const r = planTokenSpend(p, n)!;
	check(`합계 검증 (${n}개)`, r.from1 + r.from2 + r.from3 + (r.useBrain ? 1 : 0), n);
}

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 브레인 우선은 아끼고, 브레인 보존은 더 아래 그릇일 때만 먼저 내보냅니다.');
