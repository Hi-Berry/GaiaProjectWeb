/**
 * [2026-09-25 사용자 제보] "토큰 자동 최적화가 타클론에서 잘 안 된다 — 브레인스톤이 3그릇까지 갈 수 있는
 *  파워 수익이었는데 토큰을 먼저 받고 남은 수익으로 2그릇에서 멈췄다."
 *
 * 원인: 브레인스톤은 power1/2/3 개수에 들어가지 않고 brainStoneBowl로 따로 추적되는데,
 *       수입 순서 비교(compareIncomeBowlTotals)가 개수만 봐서 "스톤 3그릇"보다 "일반 토큰 2그릇"을 높게 쳤다.
 * 판정: 최적화가 고른 순서의 '쓸 수 있는 파워'(= p3 + 스톤이 3그릇이면 3)가 모든 순서 중 최대인가.
 *
 * 사용: npx tsx script/testTaklonsIncomeBrain.ts
 */
import { simulateIncomeOrder, findOptimalIncomeOrder, type IncomeOrderItem } from '@shared/gameConfig';

const usable = (s: { p3: number; brainStoneBowl?: 1 | 2 | 3 }) => s.p3 + (s.brainStoneBowl === 3 ? 3 : 0);
let failed = 0, checked = 0;

type Case = { p1: number; p2: number; p3: number; brain: 1 | 2 | 3; tok: number; pw: number };
const cases: Case[] = [];
for (const brain of [1, 2, 3] as const)
  for (const p1 of [0, 1, 2])
    for (const p2 of [0, 1, 2])
      for (const tok of [0, 1, 2])
        for (const pw of [0, 1, 2, 3])
          if (tok + pw > 0) cases.push({ p1, p2, p3: 0, brain, tok, pw });

for (const c of cases) {
  const base = { faction: 'taklons', power1: c.p1, power2: c.p2, power3: c.p3, brainStoneBowl: c.brain, brainStoneInGaia: false, brainStoneSpent: false } as never;
  const items: IncomeOrderItem[] = [];
  if (c.tok > 0) items.push({ type: 'tokens', amount: c.tok, id: 't' });
  if (c.pw > 0) items.push({ type: 'power', amount: c.pw, id: 'p' });
  if (items.length < 2) continue; // 순서가 1가지면 판정 의미 없음
  checked++;
  const chosen = findOptimalIncomeOrder(base, items);
  const got = usable(simulateIncomeOrder(base, chosen));
  const best = Math.max(
    usable(simulateIncomeOrder(base, items)),
    usable(simulateIncomeOrder(base, [items[1], items[0]])),
  );
  if (got < best) {
    failed++;
    if (failed <= 5) console.log(`  ✗ ${c.p1}/${c.p2}/${c.p3} 스톤${c.brain} · 토큰+${c.tok} 파워+${c.pw} → 고른 순서 ${got}파워 (최선 ${best})`);
  }
}

// 비-타클론은 종전 동작(개수 비교)과 같아야 한다 — 스톤 필드가 없으므로 가중치가 걸리지 않음
const plain = { faction: 'terran', power1: 2, power2: 1, power3: 0 } as never;
const plainItems: IncomeOrderItem[] = [{ type: 'tokens', amount: 2, id: 't' }, { type: 'power', amount: 2, id: 'p' }];
const plainBest = findOptimalIncomeOrder(plain, plainItems);
const plainRes = simulateIncomeOrder(plain, plainBest);
const plainAlt = simulateIncomeOrder(plain, [plainItems[1], plainItems[0]]);
if (plainRes.p3 < Math.max(plainRes.p3, plainAlt.p3)) { console.log('  ✗ 비-타클론 최적화가 깨졌다'); failed++; }

console.log(`검사 ${checked}건 · 실패 ${failed}건`);
console.log(failed === 0 ? 'PASS: 타클론 수입 순서가 항상 쓸 수 있는 파워를 최대화한다' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
