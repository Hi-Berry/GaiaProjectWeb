/**
 * 경량 Forward Model — B0: SimState 정의 + ServerGameState→SimState 추출기.
 * 설계: server/ai/FORWARD_MODEL_DESIGN.md
 *
 * 목적: MCTS 롤아웃이 무거운 진짜 엔진(deep-clone + performAction) 대신 이 compact 상태 위에서
 * 다턴을 빠르게 굴리도록(50-100배). 위치 정보는 '클러스터 파워합 + 비용별 확장 슬롯'으로 추상화해 보존.
 *
 * B0 범위: 타입 + 추출기 + 검증만. 전이(B2)/income(B1)/종료점수(B3)/롤아웃(B4)은 후속.
 */
import type { ServerGameState } from '../gameState';
import { getPlanetConnectedComponent, getFederationBuildingPower } from '../gameState';
import { getRange, getTerraformStepsForFaction, getDistance, FACTIONS, getNextRoundIncomePreview } from '@shared/gameConfig';

/** 1라운드 income 델타 (B1: 롤아웃 라운드 경계에 적용, 빌드/연구 시 증분 갱신). */
export interface SimIncome { ore: number; credits: number; knowledge: number; qic: number; powerCharge: number; powerTokens: number; }

/** 연구 트랙 고정 순서 (features.ts와 동일). research[] 인덱스. */
export const SIM_TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'] as const;

export interface SimPlayer {
    id: string;
    faction: string;
    // 자원
    ore: number; credits: number; knowledge: number; qic: number;
    p1: number; p2: number; p3: number;      // 파워 그릇
    brainBowl: number;                         // 타클론 등(있으면)
    score: number;
    // 구조물 수
    mines: number; ts: number; labs: number; pi: number; academies: number;
    // 진척
    research: number[];                        // SIM_TRACKS 순서, 6칸
    feds: number; techTiles: number; gaiaformers: number;
    bonusTileId: string | null;
    // 위치 추상 (FORWARD_MODEL_DESIGN 3.3)
    reachableSlots: { s0: number; s1: number; s2: number }; // 닿는 빈 행성: 테라포밍 0/1/2+스텝 개수
    clusterPowers: number[];                   // 미연방 클러스터별 현재 파워합(7도달 추적용), 내림차순
    passed: boolean;
    // 종족 income 등에 필요한 원본 참조용 최소치
    artifacts: string[];
    // B1: 추출 시점의 검증된 1라운드 income(getNextRoundIncomePreview). 롤아웃 중 빌드/연구로 증분 갱신.
    income: SimIncome;
}

export interface SimState {
    round: number;
    meId: string;
    players: SimPlayer[];
    // 공유 풀: 가용 파워액션/보너스타일 (coarse — B2에서 사용)
    powerActionsAvail: number;
}

/** 빈·건설가능 행성 칸인가 (findBuildActions 후보 필터와 동일 취지). */
function isEmptyBuildablePlanet(t: any): boolean {
    if (t.ownerId || t.structure) return false;
    const ty = t.type as string | undefined;
    if (!ty) return false;
    if (ty === 'space' || ty === 'deep_space' || ty === 'transdim') return false;
    if (ty.startsWith('ship_') || ty === 'lost_fleet_ship') return false;
    // 남의 가이아포머만 올라간 칸 제외
    if (t.hasGaiaformer && t.gaiaformerOwnerId == null) return false;
    return true;
}

/** 한 플레이어의 미연방 클러스터별 파워합 목록 (내림차순). evaluator.bestUnfederatedClusterPower 확장. */
function extractClusterPowers(game: ServerGameState, playerId: string): number[] {
    const fedHexes = new Set(game.playerFederationHexes?.[playerId] ?? []);
    const buildings = game.map.filter(t =>
        t.ownerId === playerId && t.structure && t.structure !== 'ship' && !fedHexes.has(t.id)
    );
    const seen = new Set<string>();
    const powers: number[] = [];
    for (const b of buildings) {
        if (seen.has(b.id)) continue;
        const comp = getPlanetConnectedComponent(game, playerId, b.id, fedHexes);
        comp.forEach(id => seen.add(id));
        powers.push(getFederationBuildingPower(game, playerId, comp));
    }
    return powers.sort((a, b) => b - a);
}

/** 한 플레이어의 닿는 빈 행성을 테라포밍 비용(스텝)별로 집계. */
function extractReachableSlots(game: ServerGameState, p: any): { s0: number; s1: number; s2: number } {
    const range = getRange(p.research?.navigation || 0) + (p.navigationBonus || 0);
    const myStructures = game.map.filter(t => t.ownerId === p.id && t.structure);
    const out = { s0: 0, s1: 0, s2: 0 };
    if (myStructures.length === 0) return out;
    for (const t of game.map) {
        if (!isEmptyBuildablePlanet(t)) continue;
        // 닿는가: 가장 가까운 내 건물까지 거리 ≤ range(+QIC 점프 1~2칸 여유는 B2에서, 여기선 무료 사거리만)
        const dist = Math.min(...myStructures.map(s => getDistance(s, t)));
        if (dist > range + 2) continue; // QIC 점프 최대 2칸까지 후보로
        const steps = t.type ? getTerraformStepsForFaction(game, p.faction, t.type) : 3;
        if (steps <= 0) out.s0++;
        else if (steps === 1) out.s1++;
        else out.s2++;
    }
    return out;
}

function fedCountOf(p: any): number {
    if (Array.isArray(p.federations)) return p.federations.length;
    if (Array.isArray(p.federationTokens)) return p.federationTokens.length;
    return 0;
}

function extractSimPlayer(game: ServerGameState, p: any): SimPlayer {
    const structures = game.map.filter(t => t.ownerId === p.id && t.structure && t.structure !== 'ship');
    const mines = structures.filter(t => t.structure === 'mine' || t.structure === 'lost_planet_mine').length
        + game.map.filter(t => (t as any).parasiticMine?.ownerId === p.id).length;
    const ts = structures.filter(t => t.structure === 'trading_station').length;
    const labs = structures.filter(t => t.structure === 'research_lab').length;
    const pi = structures.filter(t => t.structure === 'planetary_institute').length;
    const academies = structures.filter(t => t.structure === 'academy').length;
    return {
        id: p.id, faction: p.faction,
        ore: p.ore || 0, credits: p.credits || 0, knowledge: p.knowledge || 0, qic: p.qic || 0,
        p1: p.power1 || 0, p2: p.power2 || 0, p3: p.power3 || 0, brainBowl: p.brainStoneBowl || 0,
        score: p.score || 0,
        mines, ts, labs, pi, academies,
        research: SIM_TRACKS.map(tr => p.research?.[tr] ?? 0),
        feds: fedCountOf(p), techTiles: p.techTiles?.length ?? 0, gaiaformers: p.gaiaformers ?? 0,
        bonusTileId: p.bonusTile ?? null,
        reachableSlots: extractReachableSlots(game, p),
        clusterPowers: extractClusterPowers(game, p.id),
        passed: !!p.hasPassed,
        artifacts: p.artifacts ?? [],
        income: getNextRoundIncomePreview(p.id, game as any),
    };
}

/** ServerGameState → SimState (전체 플레이어, me 표시). */
export function extractSimState(game: ServerGameState, meId: string): SimState {
    const ids = game.turnOrder?.length ? game.turnOrder : Object.keys(game.players);
    const players = ids.map(id => extractSimPlayer(game, game.players[id])).filter(p => p.faction);
    return {
        round: game.roundNumber ?? 1,
        meId,
        players,
        powerActionsAvail: (game.powerActions ?? []).filter(a => !a.isUsed).length,
    };
}
