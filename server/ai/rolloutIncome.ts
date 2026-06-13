/**
 * Path A 벽돌 1: 롤아웃용 정확 income 적용.
 *
 * 목적 — MCTS 다라운드 롤아웃(deepRollout)이 "지금 엔진을 깔면 다음 라운드 자원이 늘어
 * 연방/연구5/고급타일로 간다"는 다턴 페이오프를 보게 한다. mcts.applyApproxIncome(방향만 맞는
 * 가짜 모델)을 대체. deepRollout이 과거 head2head에서 null이었던 주요 의심 원인이 가짜 income.
 *
 * 구현은 직접 복제하지 않고 **이미 production(bot.ts:635)에서 검증된 순수 함수
 * getNextRoundIncomePreview**(@shared/gameConfig)를 감싸 한 플레이어 자원에 적용한다.
 * 이 프리뷰는 base/구조물/연구(경제·과학)/기술타일/보너스/PI/인공물/종족분기(bescods·nevlas)까지 포함.
 * power 아이템은 자동 해소: powerTokens→그릇1 직접, powerCharge→applyPowerIncome(그릇 이동).
 */
import type { ServerGameState } from '../gameState';
import { getNextRoundIncomePreview, applyPowerIncome } from '@shared/gameConfig';

/** 한 플레이어에게 1라운드치 income을 순수 적용(자원 그릇만 변경). io/프롬프트/재귀 없음. */
export function applyRolloutIncome(game: ServerGameState, playerId: string): void {
    const p: any = game.players[playerId];
    if (!p?.faction) return;
    const inc = getNextRoundIncomePreview(playerId, game as any);
    p.ore = (p.ore || 0) + inc.ore;
    p.credits = (p.credits || 0) + inc.credits;
    p.knowledge = (p.knowledge || 0) + inc.knowledge;
    p.qic = (p.qic || 0) + inc.qic;
    if (inc.powerTokens) p.power1 = (p.power1 || 0) + inc.powerTokens;
    if (inc.powerCharge) applyPowerIncome(p, inc.powerCharge);
}
