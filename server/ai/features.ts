/**
 * 가치망(value network)용 특징 추출 — 게임 상태를 고정 길이 숫자 벡터로 변환한다.
 * 가중치 튜닝(선형, null)을 넘어서려면 (a) 비선형 모델 + (b) 더 풍부한 특징(상대 대비/보드/템포)이 필요.
 * 여기서는 그 풍부한 특징을 정규화해 제공하고, valueNet의 MLP가 비선형 조합을 학습한다.
 *
 * 의존성 없음. game + playerId만으로 계산. 특징 순서/길이는 FEATURE_DIM과 고정(학습/추론 일치).
 */
import type { ServerGameState } from '../gameState';
import type { PlayerState } from '@shared/gameConfig';

const RESEARCH_TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'] as const;

export const FEATURE_NAMES: string[] = [
    'round', 'remainingRounds',
    'score', 'ore', 'credits', 'knowledge', 'qic', 'power1', 'power2', 'power3', 'brainBowl',
    'mines', 'tradingStations', 'labs', 'pInstitutes', 'academies',
    'res_terraforming', 'res_navigation', 'res_ai', 'res_gaia', 'res_economy', 'res_science',
    'federations', 'techTiles', 'gaiaformers', 'shipsEntered', 'planetsOwned',
    'distinctPlanetTypes', 'gaiaPlanets',
    'scoreVsMaxOpp', 'scoreVsMeanOpp', 'structsVsMeanOpp', 'researchSumVsMeanOpp',
];
export const FEATURE_DIM = FEATURE_NAMES.length;

function structCounts(game: ServerGameState, playerId: string) {
    let mine = 0, ts = 0, lab = 0, pi = 0, academy = 0, total = 0;
    const planetTypes = new Set<string>();
    let gaiaPlanets = 0;
    for (const t of game.map) {
        if (t.ownerId !== playerId || !t.structure || t.structure === 'ship') continue;
        total++;
        switch (t.structure) {
            case 'mine': case 'lost_planet_mine': mine++; break;
            case 'trading_station': ts++; break;
            case 'research_lab': lab++; break;
            case 'planetary_institute': pi++; break;
            case 'academy': academy++; break;
        }
        if (t.type && t.type !== 'space' && t.type !== 'deep_space') planetTypes.add(t.type);
        if (t.type === 'gaia') gaiaPlanets++;
    }
    return { mine, ts, lab, pi, academy, total, distinctTypes: planetTypes.size, gaiaPlanets };
}

function fedCount(p: PlayerState): number {
    const anyP = p as any;
    if (Array.isArray(anyP.federations)) return anyP.federations.length;
    if (Array.isArray(anyP.federationTokens)) return anyP.federationTokens.length;
    return 0;
}

function researchSum(p: PlayerState): number {
    let s = 0;
    for (const t of RESEARCH_TRACKS) s += (p.research?.[t] ?? 0);
    return s;
}

/** 고정 길이 정규화 특징 벡터. 값 대부분 0~2 범위로 스케일. */
export function extractFeatures(game: ServerGameState, playerId: string): number[] {
    const p = game.players[playerId];
    if (!p) return new Array(FEATURE_DIM).fill(0);

    const round = game.roundNumber ?? 1;
    const remainingRounds = Math.max(0, 6 - round + 1);
    const sc = structCounts(game, playerId);

    // 상대 대비 (opponent-relative): 경쟁 게임에서 절대값보다 상대 위치가 중요
    const oppIds = Object.keys(game.players).filter(id => id !== playerId);
    const oppScores = oppIds.map(id => game.players[id]?.score ?? 0);
    const oppStructs = oppIds.map(id => structCounts(game, id).total);
    const oppResearch = oppIds.map(id => researchSum(game.players[id]));
    const maxOpp = oppScores.length ? Math.max(...oppScores) : 0;
    const meanOpp = oppScores.length ? oppScores.reduce((a, b) => a + b, 0) / oppScores.length : 0;
    const meanOppStructs = oppStructs.length ? oppStructs.reduce((a, b) => a + b, 0) / oppStructs.length : 0;
    const meanOppResearch = oppResearch.length ? oppResearch.reduce((a, b) => a + b, 0) / oppResearch.length : 0;

    const bowl = p.brainStoneBowl ?? 0;

    return [
        round / 6, remainingRounds / 6,
        (p.score ?? 0) / 100, (p.ore ?? 0) / 15, (p.credits ?? 0) / 20, (p.knowledge ?? 0) / 15,
        (p.qic ?? 0) / 8, (p.power1 ?? 0) / 12, (p.power2 ?? 0) / 12, (p.power3 ?? 0) / 12, bowl / 3,
        sc.mine / 8, sc.ts / 4, sc.lab / 3, sc.pi / 1, sc.academy / 2,
        (p.research?.terraforming ?? 0) / 5, (p.research?.navigation ?? 0) / 5, (p.research?.artificialIntelligence ?? 0) / 5,
        (p.research?.gaiaProject ?? 0) / 5, (p.research?.economy ?? 0) / 5, (p.research?.science ?? 0) / 5,
        fedCount(p) / 3, (p.techTiles?.length ?? 0) / 6, ((p as any).gaiaformers ?? 0) / 3,
        (p.spaceshipsEntered?.length ?? 0) / 3, sc.total / 14,
        sc.distinctTypes / 8, sc.gaiaPlanets / 6,
        ((p.score ?? 0) - maxOpp) / 40, ((p.score ?? 0) - meanOpp) / 40,
        (sc.total - meanOppStructs) / 8, (researchSum(p) - meanOppResearch) / 12,
    ];
}
