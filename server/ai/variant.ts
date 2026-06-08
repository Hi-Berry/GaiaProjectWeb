/**
 * 좌석(per-player)별 AI 변형(variant) 레지스트리 — 같은 테이블 head-to-head A/B를 가능하게 한다.
 *
 * Evaluator 가중치는 원래 전역 단일 프로필(evaluator.ts의 ACTIVE_PROFILE)이라,
 * 두 AI 버전을 한 테이블에 앉힐 수 없다. 이 레지스트리는 각 봇 좌석이 자기만의
 * 가중치 프로필과/또는 기능 플래그를 playerId 키로 갖게 한다.
 *   - evaluator.ts  → 좌석별 가중치를 읽어 상태 평가에 사용
 *   - bot.ts / federationPlanner.ts → 좌석별 플래그(getPlayerFlag)로 신규 코드 경로를 게이팅
 *     해서, 챔피언(구 경로)과 도전자(신 경로)를 같은 테이블에서 비교할 수 있다.
 *
 * 순환참조 방지를 위해 이 모듈은 다른 ai 모듈을 import 하지 않는다(가중치 타입은 unknown으로 보관,
 * evaluator가 정규화한다).
 */

export type PlayerVariant = {
    /** 'champion' | 'challenger' 등 라벨 (집계용) */
    label?: string;
    /** EvaluatorWeights 또는 EvaluatorWeightsProfile. evaluator가 정규화한다. 없으면 전역 가중치 사용 */
    weights?: unknown;
    /** 신규 코드 경로 게이팅용 플래그 */
    flags?: Record<string, number | boolean>;
};

const registry: Record<string, PlayerVariant> = {};

export function setPlayerVariant(playerId: string, variant: PlayerVariant | null): void {
    if (!variant) {
        delete registry[playerId];
        return;
    }
    registry[playerId] = variant;
}

/** 새 게임 셋업 시 호출 — 좌석별 변형을 모두 비운다(워커는 게임을 순차 실행하므로 안전). */
export function clearAllPlayerVariants(): void {
    for (const key of Object.keys(registry)) delete registry[key];
}

export function getPlayerVariant(playerId: string): PlayerVariant | undefined {
    return registry[playerId];
}

export function getPlayerVariantLabel(playerId: string): string | undefined {
    return registry[playerId]?.label;
}

export function hasAnyPlayerVariant(): boolean {
    return Object.keys(registry).length > 0;
}

/**
 * 좌석별 기능 플래그 읽기. 신규 AI 코드 경로를 이 플래그로 감싸면, 챔피언 vs 도전자가
 * 같은 테이블에서 구/신 경로를 동시에 돌릴 수 있다. 변형/플래그가 없으면 fallback 반환.
 *
 * 예) if (getPlayerFlag(playerId, 'shipReorder', false)) { ...신규 후보순서... }
 */
export function getPlayerFlag<T extends number | boolean>(
    playerId: string | undefined,
    key: string,
    fallback: T,
): T {
    if (!playerId) return fallback;
    const flags = registry[playerId]?.flags;
    if (!flags || !(key in flags)) return fallback;
    return flags[key] as T;
}
