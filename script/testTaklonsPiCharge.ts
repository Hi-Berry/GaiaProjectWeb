/**
 * 회귀 테스트: 타클론 의회(PI) 파워 수령.
 *
 * 사용자 정의(2026-08-07): "토큰 1개를 생성하고 '그다음' 주는 파워를 받는 개념.
 *   풀파워라도 2파워 이상 받으면 1점 까고 (그 토큰이) 3그릇으로 가야 한다."
 *
 * 기존 버그: 의회 토큰을 충전 '후'에 더하기도 했고(순서 선택), 오퍼 금액·수락 시 여력을 토큰 추가 전
 *   기준으로 계산해 풀파워면 amount=0이 됐다 → 어느 순서를 골라도 '1그릇에 토큰 1개'로 끝나 능력이 죽었다.
 *
 * 사용: PORT=5089 npx tsx script/testTaklonsPiCharge.ts
 *   (server/gameState를 임포트하면 server/index가 딸려와 HTTP 서버가 뜬다 → 빈 포트를 주고 끝에서 종료)
 */
import { executeRespondPowerOffer } from '../server/gameState';
import { createInitialPlayerState, generateMap } from '../shared/gameConfig';

const ioStub: any = { to: () => ({ emit: () => { } }), emit: () => { } };
const ME = 'p_tak', SRC = 'p_src';

/** 풀파워(모두 3그릇) 타클론 + 의회. amount 파워 제안을 수락시킨다. */
function run(opts: { hasPI: boolean; amount: number; p1?: number; p2?: number; p3?: number; score?: number }) {
  const me = createInitialPlayerState('Tak') as any;
  me.faction = 'taklons';
  me.power1 = opts.p1 ?? 0; me.power2 = opts.p2 ?? 0; me.power3 = opts.p3 ?? 5;
  me.brainStoneBowl = 3;            // 브레인은 3그릇(더 못 올라감) — 순수하게 의회 토큰만 보기 위해
  me.score = opts.score ?? 20;
  const src = createInitialPlayerState('Src') as any;
  src.faction = 'terran';

  const map = generateMap() as any[];
  if (opts.hasPI) {
    const t = map.find(x => x.type !== 'space' && x.type !== 'deep_space');
    t.ownerId = ME; t.structure = 'planetary_institute';
  }

  const game: any = {
    id: 'g', players: { [ME]: me, [SRC]: src }, map,
    turnOrder: [ME, SRC], currentPlayerIndex: 1, roundNumber: 3, currentPhase: 'main',
    gameLog: [], roundScoringTiles: [], finalScoringTiles: [], passingOrder: [], powerActions: [],
    pendingPowerOffers: [{ id: 'o1', targetPlayerId: ME, sourcePlayerId: SRC, amount: opts.amount, vpCost: Math.max(0, opts.amount - 1), tileId: 't', responded: false }],
  };
  const before = me.score;
  executeRespondPowerOffer(ioStub, game, ME, 'o1', true, true, undefined);
  return { p1: me.power1, p2: me.power2, p3: me.power3, vpPaid: before - me.score };
}

let failed = 0;
const check = (name: string, got: any, want: any) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'OK  ' : '실패'} ${name} → ${JSON.stringify(got)}${ok ? '' : ` (기대 ${JSON.stringify(want)})`}`);
  if (!ok) failed++;
};

console.log('타클론 의회 + 풀파워(0/0/5)');
// 2파워 제안: 토큰 생성 → 2충전으로 1→2→3 → 3그릇 6개, 1VP 지불
check('2파워 → 1VP, 토큰이 3그릇까지', run({ hasPI: true, amount: 2 }), { p1: 0, p2: 0, p3: 6, vpPaid: 1 });
// 1파워 제안: 토큰 생성 → 1충전으로 1→2 → 2그릇에 1개, 무료
check('1파워 → 0VP, 토큰이 2그릇', run({ hasPI: true, amount: 1 }), { p1: 0, p2: 1, p3: 5, vpPaid: 0 });
// 3파워 제안: 토큰 1개는 2칸까지만 흡수 → 2만 충전되고 1VP (여력 초과분은 못 받음)
check('3파워 → 여력 2까지만, 1VP', run({ hasPI: true, amount: 3 }), { p1: 0, p2: 0, p3: 6, vpPaid: 1 });

console.log('타클론 의회 없음 + 풀파워(0/0/5)');
check('의회 없으면 아무 일 없음', run({ hasPI: false, amount: 2 }), { p1: 0, p2: 0, p3: 5, vpPaid: 0 });

console.log('타클론 의회 + 여유 있음(2/0/3)');
// 기존 여력 4 + 의회 토큰 2 = 6. 2파워면 기존 토큰 2개가 1→2로: (0,2,3) + 새 토큰 1그릇
check('2파워 → 토큰 먼저 생성 후 2충전', run({ hasPI: true, amount: 2, p1: 2, p2: 0, p3: 3 }), { p1: 1, p2: 2, p3: 3, vpPaid: 1 });

console.log('');
if (failed > 0) { console.log(`실패 ${failed}건`); process.exit(1); }
console.log('OK: 의회 토큰을 먼저 만들고 제안된 파워를 받습니다.');
process.exit(0);
