import { ServerGameState, getPlanetConnectedComponent, getFederationBuildingPower, getFederationRequiredPower } from '../gameState';
import { getFederationEntries, getFinalMissionVp, getFinalMissionValue, countGreenFederations } from '@shared/gameConfig';
import { getPlayerVariant, getPlayerFlag } from './variant';
import { ValueNet } from './valueNet';
import { extractFeatures } from './features';
import fs from 'fs';
import path from 'path';

/**
 * 위성 없이(인접 건물만) 연결된 '미연방' 클러스터 중 최대 건물 파워.
 * 가까이 모인 집들의 티어를 올려(광산→교역소/연구소→의회/아카데미) 7파워를 채우면
 * 위성 0~1개로 연방이 되므로, 이 값을 보상해 멀리 잇기보다 밀집/티어업을 유도한다.
 */
function bestUnfederatedClusterPower(game: ServerGameState, playerId: string): number {
    const fedHexes = new Set(game.playerFederationHexes?.[playerId] ?? []);
    const buildings = game.map.filter(t =>
        t.ownerId === playerId && t.structure && t.structure !== 'ship' && !fedHexes.has(t.id)
    );
    let best = 0;
    const seen = new Set<string>();
    for (const b of buildings) {
        if (seen.has(b.id)) continue;
        const comp = getPlanetConnectedComponent(game, playerId, b.id, fedHexes);
        comp.forEach(id => seen.add(id));
        const power = getFederationBuildingPower(game, playerId, comp);
        if (power > best) best = power;
    }
    return best;
}

// [flag: humanValueBlendK] 사람게임 학습 가치망 v2 (2026-07-04, 39맵게임 624스냅샷, R3우승예측 62% vs 베이스49%).
// 릿지 선형: 예측VP = Σ w·feat×100. 휴리스틱을 *대체하지 않고* score += K×예측VP로 가산 —
// 망은 엔진 한계가치(기술타일+6.1/연방+13/우주선입장+17/큰건물+14VP)만 알고 자원/템포는 모름(휴리스틱 담당).
// 후보 간 랭킹엔 상수항(round/intercept) 무관. 피처 정규화는 scripts/valueProbe.mjs와 반드시 동일.
let _hvn: { weights: number[] } | null = null;
let _hvnTried = false;
function getHumanValueNet(): { weights: number[] } | null {
    if (_hvnTried) return _hvn;
    _hvnTried = true;
    try {
        const p = path.join(process.cwd(), 'server', 'ai', 'humanValueNet.json');
        if (fs.existsSync(p)) _hvn = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { _hvn = null; }
    return _hvn;
}
const HVN_HEX = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
const HVN_TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
function computeHumanValueVP(game: ServerGameState, playerId: string): number {
    const net = getHumanValueNet();
    if (!net) return 0;
    const player = game.players[playerId];
    if (!player) return 0;
    const owned = game.map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship'
        && t.type && !['space', 'deep_space', 'transdim', 'lost_fleet_ship'].includes(t.type) && !t.type.startsWith('ship_'));
    const cnt: Record<string, number> = { mine: 0, trading_station: 0, research_lab: 0, academy: 0, planetary_institute: 0 };
    for (const t of owned) if (cnt[t.structure!] != null) cnt[t.structure!]++;
    // 클러스터 (probe와 동일: 인접 연결성분, 파워 mine1/ts·lab2/big3)
    const sp = (s: string) => (s === 'planetary_institute' || s === 'academy') ? 3 : (s === 'trading_station' || s === 'research_lab') ? 2 : 1;
    const key = (t: any) => t.q + ',' + t.r;
    const coordSet = new Set(owned.map(key));
    const byCoord = new Map(owned.map(t => [key(t), t]));
    const seen = new Set<string>(); let nCl = 0, maxP = 0;
    for (const m of owned) {
        if (seen.has(key(m))) continue;
        nCl++; let p = 0; const stack = [m];
        while (stack.length) {
            const c = stack.pop()!; const ck = key(c); if (seen.has(ck)) continue; seen.add(ck);
            p += sp(c.structure!);
            for (const [dq, dr] of HVN_HEX) { const nk = (c.q! + dq) + ',' + (c.r! + dr); if (coordSet.has(nk) && !seen.has(nk)) stack.push(byCoord.get(nk)!); }
        }
        if (p > maxP) maxP = p;
    }
    const types = new Set(owned.map(t => t.type)), sectors = new Set(owned.map(t => t.sector));
    const resArr = HVN_TRACKS.map(t => (player.research?.[t as keyof typeof player.research] ?? 0));
    const resSum = resArr.reduce((a, b) => a + b, 0);
    const deep = resArr.filter(v => v >= 3).length;
    const gfPlaced = game.map.filter(t => t.hasGaiaformer && t.gaiaformerOwnerId === playerId).length
        + owned.filter(t => t.isGaiaformed).length;
    const f = [(game.roundNumber ?? 1) / 6, cnt.mine / 10, cnt.trading_station / 5, cnt.research_lab / 4,
        (cnt.academy + cnt.planetary_institute) / 3, (player.techTiles?.length ?? 0) / 10,
        getFederationEntries(player).length / 4, (player.spaceshipsEntered?.length ?? 0) / 3, gfPlaced / 3,
        ...resArr.map(v => v / 5), resSum / 20, deep / 4,
        types.size / 7, sectors.size / 9, nCl / 6, maxP / 12, owned.length / 13];
    let s = 0;
    const W = net.weights;
    for (let i = 0; i < W.length && i < f.length; i++) s += W[i] * f[i];
    return s * 100; // 예측VP 스케일(상수항 생략 — 후보 랭킹엔 무관)
}

// 학습된 가치망(있으면) 지연 로드. useValueNet 플래그가 켜진 좌석은 휴리스틱 대신 이 망의 예측 최종VP를 리프값으로 사용.
let _valueNet: ValueNet | null = null;
let _valueNetTried = false;
function getValueNet(): ValueNet | null {
    if (_valueNetTried) return _valueNet;
    _valueNetTried = true;
    try {
        const p = process.env.VALUE_NET_OUT || path.join(process.cwd(), 'server', 'ai', 'valueNet.json');
        if (fs.existsSync(p)) _valueNet = ValueNet.fromJSON(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch { _valueNet = null; }
    return _valueNet;
}
export function reloadValueNet(): void { _valueNetTried = false; _valueNet = null; }

// [engineBlend] 봇 자가대국 24만 샘플로 학습한 'score-마스킹 엔진 가치망' 지연 로드.
// 엔진 피처(gaia/tech/fed)만으로 예상VP를 학습(score계열 2,29,30 마스킹) → greedy 봇을 엔진 빌드업으로 유도.
// gradient 프로브: gaiaPlanets +13, techTiles +5.2, fed +5.2 (올바른 방향). 1-ply 평가라 OOD 악용 위험 낮음.
let _engineNet: ValueNet | null = null;
let _engineNetTried = false;
function getEngineNet(): ValueNet | null {
    if (_engineNetTried) return _engineNet;
    _engineNetTried = true;
    try {
        const p = path.join(process.cwd(), 'server', 'ai', 'engineValueNet.json');
        if (fs.existsSync(p)) _engineNet = ValueNet.fromJSON(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch { _engineNet = null; }
    return _engineNet;
}

export type EvaluatorWeights = {
    vpWeightEarly: number;
    vpWeightLate: number;

    resourceMultiplierEarly: number;
    resourceMultiplierLate: number;
    oreValue: number;
    creditsValue: number;
    knowledgeValue: number;

    qicWeightEarly: number;
    qicWeightLate: number;

    power1Value: number;
    power2Value: number;
    power3Value: number;
    brainStoneBowl1: number;
    brainStoneBowl2: number;
    brainStoneBowl3: number;

    structureMine: number;
    structureTradingStation: number;
    structureResearchLab: number;
    structurePlanetaryInstitute: number;
    structureAcademy: number;
    structureRemainingRoundsFactor: number;

    researchTerraforming: number;
    researchNavigation: number;
    researchArtificialIntelligence: number;
    researchGaiaProject: number;
    researchEconomy: number;
    researchScience: number;
    researchRemainingRoundsFactor: number;
    researchLevel5Bonus: number;
    researchLevel4Bonus: number;

    federationValueEach: number;
    gaiaformerValueEach: number;
};

export type EvaluatorWeightsProfile = {
    global: EvaluatorWeights;
    byFaction?: Record<string, Partial<EvaluatorWeights>>;
};

/** 사람 150점대에 가깝게: VP·연방·연구5 비중을 크게 둔 기본값 */
export const DEFAULT_EVALUATOR_WEIGHTS: EvaluatorWeights = {
    vpWeightEarly: 5,
    vpWeightLate: 22,

    resourceMultiplierEarly: 2.5, // 1.2 -> 2.5 (초반 자원 가치 뻥튀기로 엔진 빌딩 유도)
    resourceMultiplierLate: 0.5,
    oreValue: 0.8, // 0.5 -> 0.8
    creditsValue: 0.25, // 0.12 -> 0.25
    knowledgeValue: 0.5, // 사용자 피드백 반영: 지식가중치 하향 (0.8 -> 0.5)

    qicWeightEarly: 3.5, // 2.5 -> 3.5
    qicWeightLate: 6.0,

    power1Value: 0.05,
    power2Value: 0.3,
    power3Value: 0.7,
    brainStoneBowl1: 0.2,
    brainStoneBowl2: 1.2,
    brainStoneBowl3: 2.5,

    structureMine: 60, // 50 -> 60
    structureTradingStation: 150, // 60 -> 150 (경제/확장: 교역소의 가치를 크게 높여 업그레이드 선호)
    structureResearchLab: 180, // 80 -> 180 (연구소 가치 대폭 상향)
    structurePlanetaryInstitute: 220, // 120 -> 220
    structureAcademy: 240, // 140 -> 240
    structureRemainingRoundsFactor: 1.0, // 초반 건물 가치 극대화 (0.5 -> 1.0)

    researchTerraforming: 14,
    researchNavigation: 14,
    researchArtificialIntelligence: 10, // 정보(AI) 트랙: QIC용 보조 수준으로 평가 (과도한 우선순위 방지)
    researchGaiaProject: 12,
    researchEconomy: 22,
    researchScience: 10, // 초반 지식 트랙 효율 낮음 — 다른 트랙(경제/테라포밍 등) 우선
    researchRemainingRoundsFactor: 0.2,
    researchLevel5Bonus: 350, // 대폭 상향: 5단계 진입 강력 유도
    researchLevel4Bonus: 100, // 4단계 진입 가산점

    federationValueEach: 120, // 85 -> 120 (연방 형성을 위해 광산을 더 지을 동기 부여)
    gaiaformerValueEach: 5,
};

let ACTIVE_PROFILE: EvaluatorWeightsProfile = { global: { ...DEFAULT_EVALUATOR_WEIGHTS }, byFaction: {} };

function normalizeWeights(w: EvaluatorWeights): EvaluatorWeights {
    // Basic sanity clamps to avoid pathological tuning runs
    const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
    return {
        ...w,
        vpWeightEarly: clamp(w.vpWeightEarly, 0, 30),
        vpWeightLate: clamp(w.vpWeightLate, 0, 30),

        // DEFAULT가 2.5까지 쓰는 설계이므로 상한을 그에 맞춰 올림 (튜닝 무력화 방지)
        resourceMultiplierEarly: clamp(w.resourceMultiplierEarly, 0, 4),
        resourceMultiplierLate: clamp(w.resourceMultiplierLate, 0, 2),
        oreValue: clamp(w.oreValue, 0, 5),
        creditsValue: clamp(w.creditsValue, 0, 5),
        knowledgeValue: clamp(w.knowledgeValue, 0, 5),

        qicWeightEarly: clamp(w.qicWeightEarly, 0, 10),
        qicWeightLate: clamp(w.qicWeightLate, 0, 10),

        power1Value: clamp(w.power1Value, 0, 5),
        power2Value: clamp(w.power2Value, 0, 5),
        power3Value: clamp(w.power3Value, 0, 5),
        brainStoneBowl1: clamp(w.brainStoneBowl1, 0, 10),
        brainStoneBowl2: clamp(w.brainStoneBowl2, 0, 10),
        brainStoneBowl3: clamp(w.brainStoneBowl3, 0, 10),

        structureMine: clamp(w.structureMine, 0, 200),
        structureTradingStation: clamp(w.structureTradingStation, 0, 200),
        structureResearchLab: clamp(w.structureResearchLab, 0, 250),
        structurePlanetaryInstitute: clamp(w.structurePlanetaryInstitute, 0, 300),
        structureAcademy: clamp(w.structureAcademy, 0, 400),
        structureRemainingRoundsFactor: clamp(w.structureRemainingRoundsFactor, 0, 3),

        researchTerraforming: clamp(w.researchTerraforming, 0, 100),
        researchNavigation: clamp(w.researchNavigation, 0, 100),
        researchArtificialIntelligence: clamp(w.researchArtificialIntelligence, 0, 120),
        researchGaiaProject: clamp(w.researchGaiaProject, 0, 120),
        researchEconomy: clamp(w.researchEconomy, 0, 140),
        researchScience: clamp(w.researchScience, 0, 160),
        researchRemainingRoundsFactor: clamp(w.researchRemainingRoundsFactor, 0, 2),
        researchLevel5Bonus: clamp(w.researchLevel5Bonus, 0, 600),
        researchLevel4Bonus: clamp(w.researchLevel4Bonus ?? 100, 0, 300),

        federationValueEach: clamp(w.federationValueEach, 0, 200),
        gaiaformerValueEach: clamp(w.gaiaformerValueEach, 0, 50),
    };
}

function normalizeProfile(profile: EvaluatorWeightsProfile): EvaluatorWeightsProfile {
    const global = normalizeWeights(profile.global);
    const byFaction: Record<string, Partial<EvaluatorWeights>> = {};
    for (const [faction, patch] of Object.entries(profile.byFaction || {})) {
        byFaction[faction] = normalizeWeights({ ...global, ...patch } as EvaluatorWeights);
    }
    return { global, byFaction };
}

function isProfileShape(v: any): v is Partial<EvaluatorWeightsProfile> {
    return !!v && typeof v === 'object' && ('global' in v || 'byFaction' in v);
}

export function setActiveEvaluatorWeights(next: Partial<EvaluatorWeights> | Partial<EvaluatorWeightsProfile>): EvaluatorWeightsProfile {
    if (isProfileShape(next)) {
        const merged: EvaluatorWeightsProfile = {
            global: {
                ...ACTIVE_PROFILE.global,
                ...(next.global || {}),
            } as EvaluatorWeights,
            byFaction: {
                ...(ACTIVE_PROFILE.byFaction || {}),
                ...(next.byFaction || {}),
            },
        };
        ACTIVE_PROFILE = normalizeProfile(merged);
        return ACTIVE_PROFILE;
    }

    ACTIVE_PROFILE = normalizeProfile({
        ...ACTIVE_PROFILE,
        global: {
            ...ACTIVE_PROFILE.global,
            ...next,
        } as EvaluatorWeights,
    });
    return ACTIVE_PROFILE;
}

export function getActiveEvaluatorWeights(): EvaluatorWeightsProfile {
    return ACTIVE_PROFILE;
}

/** raw 가중치(평면 EvaluatorWeights 또는 Profile)를 정규화된 Profile로 변환 */
function resolveProfile(raw: unknown): EvaluatorWeightsProfile {
    if (isProfileShape(raw)) {
        const p = raw as Partial<EvaluatorWeightsProfile>;
        return normalizeProfile({
            global: { ...DEFAULT_EVALUATOR_WEIGHTS, ...(p.global || {}) } as EvaluatorWeights,
            byFaction: p.byFaction || {},
        });
    }
    return normalizeProfile({
        global: { ...DEFAULT_EVALUATOR_WEIGHTS, ...(raw as Partial<EvaluatorWeights>) } as EvaluatorWeights,
        byFaction: {},
    });
}

// evaluateState는 MCTS에서 수천 번 호출되므로, 좌석별 프로필 정규화 결과를 캐싱한다.
// variant.weights 객체 참조가 게임 내내 동일하므로 참조 비교로 캐시 무효화한다.
const resolvedPlayerProfileCache = new Map<string, { src: unknown; profile: EvaluatorWeightsProfile }>();

/** 좌석별 변형 가중치가 있으면 정규화 프로필을 반환, 없으면 null(전역 프로필 사용) */
function getPlayerProfile(playerId: string): EvaluatorWeightsProfile | null {
    const variant = getPlayerVariant(playerId);
    if (!variant?.weights) return null;
    const cached = resolvedPlayerProfileCache.get(playerId);
    if (cached && cached.src === variant.weights) return cached.profile;
    const profile = resolveProfile(variant.weights);
    resolvedPlayerProfileCache.set(playerId, { src: variant.weights, profile });
    return profile;
}

export function loadEvaluatorWeightsFromFile(filePath: string): EvaluatorWeightsProfile | null {
    try {
        const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
        if (!fs.existsSync(abs)) return null;
        // PowerShell로 저장하면 UTF-8 BOM이 붙어 JSON.parse가 실패한다. 과거엔 catch에서 조용히 null을
        // 반환해 튜닝한 가중치가 무시되고 DEFAULT로 폴백되는 버그가 있었음 → BOM을 제거하고 파싱한다.
        const raw = fs.readFileSync(abs, 'utf-8').replace(/^﻿/, '');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (isProfileShape(parsed)) {
            return setActiveEvaluatorWeights(parsed as Partial<EvaluatorWeightsProfile>);
        }
        return setActiveEvaluatorWeights(parsed as Partial<EvaluatorWeights>);
    } catch (e) {
        // 조용한 폴백은 가중치 무시 버그를 숨긴다 → 최소한 콘솔에 경고
        console.warn(`[evaluator] failed to load weights from ${filePath}: ${(e as Error).message} (falling back to DEFAULT)`);
        return null;
    }
}

// Auto-load on module import (best-effort). Default path can be overridden.
const DEFAULT_WEIGHTS_PATH = process.env.AI_WEIGHTS_PATH || 'server/ai/aiWeights.json';
loadEvaluatorWeightsFromFile(DEFAULT_WEIGHTS_PATH);

export class Evaluator {
    /**
     * Evaluates a given game state from the perspective of a specific player.
     * Returns a numerical score. Higher is better.
     * MCTS uses this at the end of a rollout or at depth limit.
     */
    static evaluateState(game: ServerGameState, playerId: string, debug: boolean = false): number {
        const player = game.players[playerId];
        if (!player) return -9999;

        // [flag: useValueNet] 학습된 가치망이 있으면 휴리스틱 대신 예측 최종 VP를 리프값으로 사용.
        // 비선형 학습 평가라 가중치 튜닝(선형, null)의 천장을 넘을 수 있는지 head2head로 검증.
        if (getPlayerFlag(playerId, 'useValueNet', false)) {
            const net = getValueNet();
            if (net) return net.predict(extractFeatures(game, playerId));
        }

        // [flag: humanValueBlendK] 사람게임 가치망 v2 가산 블렌드 (0=OFF). K×예측VP를 휴리스틱에 더함.
        // K=5면 연방 +65점(휴리스틱 fed 120의 절반 보정), 기술타일 +30점 등 — 전략 항 보정, 전술(자원)은 휴리스틱 유지.
        const hvnK = getPlayerFlag(playerId, 'humanValueBlendK', 0);
        const hvnBonus = hvnK > 0 ? hvnK * computeHumanValueVP(game, playerId) : 0;

        // 좌석별 변형(head-to-head A/B)이 있으면 그 프로필을, 없으면 전역 프로필을 사용
        const profile = getPlayerProfile(playerId) ?? ACTIVE_PROFILE;
        const factionPatch = player.faction ? profile.byFaction?.[player.faction] : undefined;
        const w = factionPatch
            ? normalizeWeights({ ...profile.global, ...factionPatch } as EvaluatorWeights)
            : profile.global;

        let score = 0;
        let logs: string[] = [];
        const logDebug = (msg: string) => { if (debug) logs.push(msg); };

        const round = game.roundNumber;
        const totalRounds = 6;
        const remainingRounds = Math.max(0, totalRounds - round + 1);
        // 미래 수입(기술 타일 엔진) 등: 초반엔 자원 가치를 높게, 후반엔 낮게 (가중치 resourceMultiplier*)
        const phaseRes = totalRounds <= 1 ? 0 : (round - 1) / (totalRounds - 1);
        const resMult = w.resourceMultiplierEarly * (1 - phaseRes) + w.resourceMultiplierLate * phaseRes;

        if (debug) logDebug(`\n=== Eval Breakdown: ${player.faction || playerId} (Round ${round}) ===`);

        // 1) VP
        const vpWeight = round >= 5 ? w.vpWeightLate : w.vpWeightEarly;
        let vpBasis = (player.score || 0);
        // [flag: valueNetBlend] 휴리스틱 구조(빌드/연구 그래디언트)는 유지하고 VP 항목만 전진적으로:
        // 현재 점수와 가치망 "예측 최종 점수"를 반반 섞음. 망은 보조 신호(경계 有)라 탐색 악용 완화.
        if (getPlayerFlag(playerId, 'valueNetBlend', false)) {
            const net = getValueNet();
            if (net) {
                // [flag: valueNetBlendW] 블렌드 가중치(0~1). 망이 노이즈면 작게(0.1~0.15) 섞어 방향성만 취하고 노이즈 지배 방지.
                //   사용자: 절대MAE 나빠도 엔진축 방향성(+)은 맞으니 작은 넛지로 쓸 수 있나 검증.
                const bw = Math.max(0, Math.min(1, getPlayerFlag(playerId, 'valueNetBlendW', 0.5)));
                vpBasis = (1 - bw) * (player.score || 0) + bw * net.predict(extractFeatures(game, playerId));
            }
        }
        const vpScore = vpBasis * vpWeight;
        score += vpScore;
        logDebug(`1) VP: ${player.score || 0} * ${vpWeight.toFixed(1)} = +${vpScore.toFixed(1)}`);

        // 2) Resources
        // [수정] 자원을 킵하는 것을 '효율적'이라고 오해하지 않도록, 쓰지 않은 잉여 자원은 0.1수준의 아주 낮은 점수만 부여
        const oreScore = (player.ore || 0) * w.oreValue * 0.1;
        const credScore = (player.credits || 0) * w.creditsValue * 0.1;
        const knowScore = (player.knowledge || 0) * w.knowledgeValue * 0.1;

        score += oreScore + credScore + knowScore;
        logDebug(`2) Resources: Ore +${oreScore.toFixed(1)}, Cred +${credScore.toFixed(1)}, Know +${knowScore.toFixed(1)}`);

        // [flag: potentialEval] 다턴 잠재력: ore·knowledge는 '쟁여둔 잉여(0.1×)'가 아니라 '선불된 다음 행동'이다.
        // 데이터(사람 vs 봇 행동믹스): 봇은 라운드당 행동수가 절반(research −9·upgrade −8·mine −7) — 라운드 중반에
        // ore/지식이 말라 일찍 패스(패스 횟수는 동일). ore·지식을 '다음 행동가치의 작은 일부'로 평가해, 크레딧 대신
        // ore/지식 획득을 우대(크레딧은 0.1× 유지 = 풍선 억제). ★분수를 작게 유지하는 게 핵심: 광산 건설(~60×멀티)이
        // 보유 ore 가치(~수/개)를 항상 압도하므로 봇은 모으되 결국 쓴다(hoarding 유발 X). 남은 라운드↑ = 쓸 기회↑ → 소폭 가산.
        if (getPlayerFlag(playerId, 'potentialEval', false)) {
            const potMult = 1 + 0.3 * remainingRounds;
            // 지식: 4당 연구 1칸 가능. 남은 라운드만큼만 실제 쓸 수 있으니 캡(hoarding 방지).
            const usableKnow = Math.min(Math.floor((player.knowledge || 0) / 4), remainingRounds);
            const knowPot = usableKnow * (w.researchTerraforming * 0.4) * potMult;
            // 광석: 건설/업글의 핵심 연료. 남은 라운드 동안 쓸 양으로 캡.
            const usableOre = Math.min((player.ore || 0), remainingRounds + 1);
            const orePot = usableOre * (w.structureMine * 0.1) * potMult;
            const potential = knowPot + orePot;
            score += potential;
            logDebug(`2p) Potential(다턴 연료): know ${usableKnow}→+${knowPot.toFixed(0)}, ore ${usableOre}→+${orePot.toFixed(0)} = +${potential.toFixed(1)}`);
        }

        const qicWeight = round >= 4 ? w.qicWeightLate : w.qicWeightEarly;
        const qicScore = (player.qic || 0) * qicWeight;
        score += qicScore;
        logDebug(`3) QIC: ${player.qic || 0} * ${qicWeight.toFixed(1)} = +${qicScore.toFixed(1)}`);

        // pendingTerraformSteps = "다음 턴에 광산으로 전환"되는 가치이므로, 광산 1개와 동일한 가중치로 평가.
        const pendingSteps = (player.pendingTerraformSteps || 0);
        if (pendingSteps > 0) {
            const structMultiplierForSteps = 1 + w.structureRemainingRoundsFactor * remainingRounds;
            const pendingValue = pendingSteps * w.structureMine * structMultiplierForSteps;
            score += pendingValue;
            logDebug(`3b) Pending Terraform Steps (≈mine): ${pendingSteps} * ${w.structureMine.toFixed(0)} * ${structMultiplierForSteps.toFixed(2)} = +${pendingValue.toFixed(1)}`);
        }

        // 3) Power bowls
        const p1Score = (player.power1 || 0) * w.power1Value;
        const p2Score = (player.power2 || 0) * w.power2Value;
        // [flag: powerHoardDamp] 사람은 충전파워(bowl3)를 ~1.5만 유지하고 계속 파워액션/번으로 순환 + 패스 전 비움.
        //   봇은 bowl3를 flat 0.7/개로 값매겨 쟁여둘수록 점수↑ → hoarding + 막라 소멸(0점)인데도 과대평가(사용자 최대약점).
        //   개선: ①앞 3개만 제값, 초과분은 ×0.25(빨리 못 씀=낭비위험) ②R6 보유 bowl3는 거의 0(패스 후 소멸).
        //   → '쟁여둔 상태' 값이 낮아져 MCTS가 '파워액션으로 쓴 상태'를 상대적으로 선호(hold→spend 결정 직격).
        const _p3 = player.power3 || 0;
        let p3Score;
        if (getPlayerFlag(playerId, 'powerHoardDamp', false)) { // [기각 2026-07-03] 검증: 행동 무변(파워액션 3.18↔3.11, 종료bowl3 둘다~0.4=봇 이미 비움) + VP −2.8. 전제(막라 hoarding) 틀림. 기본 OFF.
            const useful = Math.min(_p3, 3), excess = Math.max(0, _p3 - 3);
            const roundKeep = round >= 6 ? 0.25 : 1; // 막라 보유 bowl3 = 패스하면 소멸 → 거의 무가치
            p3Score = (useful * w.power3Value + excess * w.power3Value * 0.25) * roundKeep;
        } else {
            p3Score = _p3 * w.power3Value;
        }
        let bsScore = 0;
        // [flag: taklonsBrainSpend] 사용자 통찰: 타클론 브레인(bowl3)은 들고 있는 자산이 아니라 매턴 쓰고 충전으로 복귀시켜
        //   라운드 내내 재활용하는 엔진. brainStoneBowl3=2.5가 '보유'를 과대평가 → MCTS가 쓰기 싫어해(쓰면 −2.5) hoarding+안 돌림.
        //   재활용되니 쓰는 건 사실상 손해가 아님 → 이 플래그면 bowl3 가중치를 확 낮춰(≈bowl1) MCTS가 매턴 브레인-파워액션을 쓰게(재활용).
        const brainSpendMode = player.faction === 'taklons' && getPlayerFlag(playerId, 'taklonsBrainSpend', false);
        const bb3 = brainSpendMode ? Math.min(w.brainStoneBowl3, w.brainStoneBowl1 + 0.3) : w.brainStoneBowl3;
        if (player.brainStoneBowl === 1) bsScore += w.brainStoneBowl1;
        if (player.brainStoneBowl === 2) bsScore += w.brainStoneBowl2;
        if (player.brainStoneBowl === 3) bsScore += bb3;
        // [아이타] 가이아공간 토큰(gaiaformerPower): 번/가이아프로젝트로 이동한 토큰. 다음 라운드 Bowl I로 복귀하고,
        //   PI 보유 시 4개당 기술타일로 환전 가능 → 소멸이 아니다. 이걸 0으로 두면 MCTS가 아이타 번을 '토큰 손실'로 오판해
        //   burn_power 후보를 탐색해도 안 고름. PI면 bowl3급(기술타일 연료), 아니면 bowl1급(복귀)으로 가치화.
        if (player.faction === 'itars' && (player.gaiaformerPower || 0) > 0) {
            const hasItarsPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
            bsScore += (player.gaiaformerPower || 0) * (hasItarsPI ? w.power3Value : w.power1Value);
        }
        score += p1Score + p2Score + p3Score + bsScore;
        logDebug(`4) Power: P1(+${p1Score.toFixed(1)}), P2(+${p2Score.toFixed(1)}), P3(+${p3Score.toFixed(1)}), BrainStone(+${bsScore.toFixed(1)})`);

        // 4) Structures
        const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);

        // [수정] 초반 저확장 교정 (보드 프레즌스): 봇이 시작 광산만 업그레이드하고 새 광산을 안 짓는 문제.
        // 보드 규모 ~6개 전엔 "새 구조물"이 "업그레이드"보다 가치 높게(structMultiplier 동일 스케일,
        // presencePer>60이면 새 광산(60+presencePer) > 업글이득(120)) → 봇이 광산 깔고 그다음 업그레이드.
        {
            const presenceMult = 1 + w.structureRemainingRoundsFactor * remainingRounds;
            const presencePer = round <= 4 ? 80 : 40;
            const boardPresence = Math.min(myStructures.length, 6) * presencePer * presenceMult;
            score += boardPresence;
            logDebug(`4a) Board presence(<=6): min(${myStructures.length},6)*${presencePer}*${presenceMult.toFixed(1)} = +${boardPresence.toFixed(0)}`);

            // [확장 사슬] 작은 보드·초반엔 항해(거리)를 Nav2까지 평가함수에서 보상 → 우선순위가
            // 빌드(~140) > Nav(130) > 업그레이드(120)가 되어: 지을 땅 있으면 짓고, 막히면 업글 대신
            // Nav를 올려 새 땅을 연다. (사용자 전략 "Nav2 만들고 광산 뿌린다". 후보생성 boost와 함께 작동)
            if (getPlayerFlag(playerId, 'navExpandEval', true) && round <= 4 && myStructures.length < 6) {
                const navLvl = Math.min(player.research.navigation ?? 0, 2);
                const navExpand = navLvl * 130 * presenceMult;
                score += navExpand;
                logDebug(`4b) Nav-for-expansion: nav${navLvl}*130*${presenceMult.toFixed(1)} = +${navExpand.toFixed(0)}`);
            }
        }

        // 확장(광산 10개 이상)에 대한 추가 보너스
        let structExpansionScore = 0;
        if (getPlayerFlag(playerId, 'expandDrive', false)) {
            // [실험] 확장 부족(봇 대부분 8-11개)이 연방2/연구5 미달성의 뿌리 → 5번째 구조물부터 강하게 보상해
            // 확장을 적극 유도. 기존은 10개 이상부터라 대부분 봇이 보너스를 못 받았음.
            const threshold = 4;
            if (myStructures.length > threshold) {
                const perStructure = round <= 4 ? 28 : 18;
                structExpansionScore = (myStructures.length - threshold) * perStructure;
                score += structExpansionScore;
            }
        } else if (myStructures.length >= 10) {
            // 과도한 확장 편향을 줄이기 위해 보너스를 라운드 기반으로 완화
            const perStructure = round <= 3 ? 8 : 14;
            structExpansionScore = (myStructures.length - 9) * perStructure;
            score += structExpansionScore;
        }

        const mineCount = myStructures.filter(t => t.structure === 'mine' || t.structure === 'lost_planet_mine').length;
        const tsCount = myStructures.filter(t => t.structure === 'trading_station').length;
        const labCount = myStructures.filter(t => t.structure === 'research_lab').length;
        const piCount = myStructures.filter(t => t.structure === 'planetary_institute').length;
        const academyCount = myStructures.filter(t => t.structure === 'academy').length;

        let structScore = 0;
        const structMultiplier = 1 + w.structureRemainingRoundsFactor * remainingRounds;

        // 1. 선형 건물 점수 (광산, 연구소, 의회, 아카데미)
        structScore += mineCount * w.structureMine * structMultiplier;
        structScore += labCount * w.structureResearchLab * structMultiplier;
        structScore += piCount * w.structurePlanetaryInstitute * structMultiplier;
        structScore += academyCount * w.structureAcademy * structMultiplier;

        // [flag: geodensPiValue] 기오덴 PI = 새 행성유형 정착마다 +3K 스트림인데 평가기가 몰라 첫랩(180+기술타일)이
        // PI(220)를 항상 이겼음(geodensPiFirst 후보조작 기각의 근본원인 — PI건설 0.65→0.51 역효과). PI 보유 상태를
        // '아직 안 가진 도달권 새 유형 수 × W'로 가산 — MCTS가 새 유형이 많이 남았을 때 PI를 자연 선호. 숫자 플래그(0=OFF).
        const geoW = player.faction === 'geodens' ? getPlayerFlag(playerId, 'geodensPiValue', 0) : 0;
        if (geoW > 0 && piCount >= 1 && remainingRounds >= 2) {
            const myTypes = new Set(myStructures.filter(t => t.type && t.type !== 'space' && t.type !== 'deep_space').map(t => t.type));
            const newTypes = new Set(game.map
                .filter(t => !t.ownerId && !t.structure && t.type
                    && t.type !== 'space' && t.type !== 'deep_space' && t.type !== 'transdim'
                    && !t.type.startsWith('ship_') && !myTypes.has(t.type))
                .map(t => t.type)).size;
            structScore += Math.min(newTypes, 5) * geoW;
        }

        // [flag: bescodsPiValue] 매안 PI = 파워값 4(일반 3) → 연방 인에이블러(PI4+TS2+광산1=7, 위성 최소).
        // 랩→PI 업글이 평가기상 +40(220−180)뿐이라 랩 희생을 못 넘어 매안 PI율 6%(전종족 최저, 사람은 연방 전 PI가 표준).
        // PI 보유 상태에 +W — 남은 라운드 2+일 때(연방 만들 시간이 있을 때)만. 숫자 플래그(0=OFF).
        const besW = player.faction === 'bescods' ? getPlayerFlag(playerId, 'bescodsPiValue', 0) : 0;
        if (besW > 0 && piCount >= 1 && remainingRounds >= 2) {
            structScore += besW;
        }

        // 2. 퍼널 구조 건물 점수 (교역소 병목 현상 해결)
        // 첫 번째 교역소는 연구소/아카데미로 가는 발판이므로 가치를 크게 줍니다.
        // 하지만 이미 연구소나 의회 등 상위 건물이 있다면, 현재 교역소가 0개라도 새로 짓는 교역소는 '두 번째 교역소'로 취급해야 합니다. (첫 교역소의 병목은 이미 뚫었기 때문)
        const advancedStructuresCount = labCount + piCount + academyCount;
        let tsScore = 0;
        for (let i = 0; i < tsCount; i++) {
            // 상위 건물이 아예 없을 때 짓는 교역소 1개만 '첫 교역소'의 엄청난 보너스를 받음
            if (i === 0 && advancedStructuresCount === 0) {
                tsScore += w.structureTradingStation * structMultiplier;
            } else if (getPlayerFlag(playerId, 'tpDiminish', true) && i >= 2) {
                // [flag: tpDiminish] 3번째+ 교역소는 메리트 거의 없음 — 크레딧 수입은 1~2개면 충분하고, 잉여 크레딧은
                // 광석 없이 못 써 '돈 풍선'만 됨(사용자 관찰: 교역소 4개+돈 터짐). 광산 가치만 부여 → 광산→TP 업글
                // 인센티브 ~0이라 괜한 4번째 교역소 대신 광산/연구소/확장을 하게 됨.
                tsScore += w.structureMine * structMultiplier;
            } else {
                // 교역소는 광산을 업그레이드해서 짓는 것이므로 광산보다 가치가 낮아지면 안 됨 (페널티 제거)
                const secondTsBase = round <= 2 ? w.structureMine + 15 : (w.structureTradingStation + w.structureMine) / 2;
                tsScore += secondTsBase * structMultiplier;
            }
        }
        structScore += tsScore;

        // 3. 초반(1~3R) 엔진 빌딩 보너스 — 자원 수급 인프라 강력 유도
        // 라운드별 강도: R1 1.0x, R2 0.7x, R3 0.4x (점진 감쇠)
        let engineBonus = 0;
        if (round <= 3) {
            const roundFactor = round === 1 ? 1.0 : round === 2 ? 0.7 : 0.4;
            // 첫 교역소(이미 funnel에서 가산되지만 추가 boost)
            if (tsCount >= 1 && labCount === 0 && piCount === 0 && academyCount === 0) {
                engineBonus += 80 * roundFactor;
            }
            // 연구소: 지식 수급 핵심 인프라
            if (labCount >= 1) {
                engineBonus += 160 * roundFactor;
                engineBonus += (mineCount + tsCount) * 18 * roundFactor;
            }
            // 의회/아카데미: 고급 엔진
            if (piCount >= 1 || academyCount >= 1) {
                engineBonus += 240 * roundFactor;
                engineBonus += (mineCount + tsCount) * 14 * roundFactor;
            }
        }

        // 남은 라운드만큼 미래 수입이 누적되므로 multiplier 적용 (중복 증폭을 막기 위해 0.4 계수)
        const engineMultiplier = 1 + w.structureRemainingRoundsFactor * remainingRounds * 0.4;
        const scaledEngineBonus = engineBonus * engineMultiplier;
        structScore += scaledEngineBonus;

        score += structScore;
        logDebug(`5) Structures: funnel-base+rem: +${(structScore - scaledEngineBonus).toFixed(1)}, EngineBns: +${scaledEngineBonus.toFixed(1)}, Expand-bonus: +${structExpansionScore.toFixed(1)}`);

        // 5) Research
        const rw: Record<string, number> = {
            terraforming: w.researchTerraforming,
            navigation: w.researchNavigation,
            artificialIntelligence: w.researchArtificialIntelligence,
            gaiaProject: w.researchGaiaProject,
            economy: w.researchEconomy,
            science: w.researchScience,
        };
        // [flag: researchLikeHuman] 데이터유래(사람 27게임): 봇은 nav+economy에 87% 몰빵(econ 44%·nav 43%),
        // 사람은 terr 21·gaia 23·ai 24%로 고루. economy 가중치(22, 최고)가 economy 쏠림→크레딧 풍선만 키움.
        // 사람 분포 쪽으로 재조정: economy 억제, terraforming/gaiaProject/AI(QIC) 부스트.
        if (getPlayerFlag(playerId, 'researchLikeHuman', false)) {
            rw.economy = 17;                  // 22→17 (과투자 완화, 부드럽게)
            rw.terraforming = 16;             // 14→16
            rw.gaiaProject = 16;              // 12→16 (행성다양성)
            rw.artificialIntelligence = 13;   // 10→13 (QIC)
        }
        // [flag: qicEngineValue] shipActionDiag 확정(2026-07-06): 우주선 최강액션(#1 연방보상/기술타일/행성VP)이
        //   QIC부족으로 74~94% 탈락 = QIC 기아가 근본원인. AI트랙은 QIC 즉시부여(L1+1·L2+1·L3+2·L4+2=L4까지 6QIC)인데
        //   평가기 weight 10(최저권)이라 봇이 투자 안 함. ★aiTrackQicEngine(후보점수)은 무시됐으나 이건 평가기 term(유효 route).
        //   ★사람 타이밍(55게임 177전진): AI투자 91%가 R4+, L1첫진입 중앙 R5·기술6·연방3. 초반(R≤3, 사람 9%)엔
        //   확장연구 우선이라 부스트 안 함(flat R1부스트는 확장을 뺏음 — 사용자 교정). R4+·연방 갖춘 뒤 사람처럼 QIC엔진 투자.
        if (getPlayerFlag(playerId, 'qicEngineValue', false)) {
            const fedCount = getFederationEntries(player).length;
            if (round >= 5) rw.artificialIntelligence = 22;              // R5-6: 사람 AI투자 집중 구간(52+85회)
            else if (round === 4 && fedCount >= 1) rw.artificialIntelligence = 18; // R4: 연방 갖춘 뒤만(사람 L1중앙 연방3)
            // R≤3: 기본 10 유지(초반 확장연구 보호)
        }
        let researchScore = 0;
        for (const [track, level] of Object.entries(player.research || {})) {
            const weight = rw[track] ?? 10;
            let factor = 1 + remainingRounds * w.researchRemainingRoundsFactor;
            // 초반 지식(science) 트랙 효율이 낮음 — 남은 라운드가 많을수록 페널티
            if (track === 'science' && remainingRounds > 2) {
                factor *= Math.max(0.35, 1 - (remainingRounds - 2) * 0.2);
            }
            const lvl = level as number;

            // 연구 단계 점수 부스팅 — 4단계 이상은 결정적
            let levelMultiplier = 1;
            if (lvl >= 3) levelMultiplier = 1.3;
            if (lvl >= 4) levelMultiplier = 1.7;
            if (lvl >= 5) levelMultiplier = 2.0;

            researchScore += lvl * weight * factor * levelMultiplier;

            if (lvl >= 4) researchScore += (w.researchLevel4Bonus || 100);
            // 5단계 진입 보너스: 종족별 강력한 이득 + 종료 점수 12점 → 후반일수록 추가 가산
            if (lvl === 5) {
                const lateFactor = round >= 4 ? 1.2 : 1.0;
                researchScore += w.researchLevel5Bonus * lateFactor;
            }
        }
        // [flag: researchBreadth (숫자 가중치, 0=off)] 연구 분산 보상 — 봇은 1~2트랙 몰빵(20-24점), 사람은 4~5트랙 L4+(32-44점).
        // researchLevel5Bonus가 '깊이'만 과보상하던 것 보완: 여러 트랙을 L2+/L3+로 올린 '폭'을 상태 보상(핸드오프 권장 방식).
        const rbW = getPlayerFlag(playerId, 'researchBreadth', 15);
        if (rbW) {
            const lvls = Object.values(player.research ?? {}) as number[];
            const tracksAt2 = lvls.filter(l => l >= 2).length;
            const tracksAt3 = lvls.filter(l => l >= 3).length;
            const breadth = Math.max(0, tracksAt2 - 1) + Math.max(0, tracksAt3 - 1) * 0.5; // 1트랙 몰빵=0, 분산할수록 ↑
            researchScore += rbW * breadth;
            logDebug(`6b) ResearchBreadth(x${rbW}): +${(rbW * breadth).toFixed(1)} (L2+=${tracksAt2}, L3+=${tracksAt3})`);
        }
        score += researchScore;
        logDebug(`6) Research: +${researchScore.toFixed(1)}`);

        // 5.5) Early Game Expansion & Economy Strategy (Round 1-2)
        let earlyBonus = 0;
        if (round <= 2) {
            const hasAcademy = myStructures.some(t => t.structure === 'academy');
            const hasResearchLab = myStructures.some(t => t.structure === 'research_lab');
            const navLevel = player.research?.navigation || 0;
            const ecoLevel = player.research?.economy || 0;
            const hasNavTech = player.techTiles?.includes('ship-tech-nav+1');

            // Strategy 1: Academy -> Economy focus
            if (hasAcademy) {
                if (ecoLevel >= 1) earlyBonus += 35;
                if (ecoLevel >= 2) earlyBonus += 45; // cumulative
            }

            // Strategy 2: Research Lab -> Navigation focus (for range)
            if (hasResearchLab && !hasAcademy) {
                if (navLevel === 1) earlyBonus += 25;
                if (navLevel >= 2) earlyBonus += 35;
            }

            // Strategy 3: Nav+1 Tech Tile early is great for expansion
            if (hasNavTech) {
                earlyBonus += 45;
            }

            // Prevent over-investment: if they have both Nav+1 Tech AND Nav track >= 2,
            // penalize slightly to encourage using the resources elsewhere, since 2 range is usually enough early.
            if (hasNavTech && navLevel >= 2) {
                earlyBonus -= 35;
            }
            if (earlyBonus !== 0) {
                score += earlyBonus;
                logDebug(`7) Early Game Strat: ${earlyBonus > 0 ? '+' : ''}${earlyBonus.toFixed(1)}`);
            }
        }

        // 6) Federations — 라운드 기반 스케일링
        // 초반(R1~2)엔 연방 구성이 자원 손해 ↔ 중후반(R3~5)엔 결정적 가치
        // 라운드 1: 0.6x, 2: 0.85x, 3: 1.1x, 4: 1.35x, 5: 1.5x, 6: 1.5x
        const feds = getFederationEntries(player);
        let fedRoundScale = 0.6;
        if (round === 2) fedRoundScale = 0.85;
        else if (round === 3) fedRoundScale = 1.1;
        else if (round === 4) fedRoundScale = 1.35;
        else if (round >= 5) fedRoundScale = 1.5;
        // [flag: fedValueMult] 연방 코어 가치 직접 증폭(미검증 마지막 손잡이 — 항 추가/보조항 증폭과 달리 코어 가중치).
        // 숫자 플래그(0=OFF, 1.5=×1.5). MCTS가 연방으로 이어지는 상태 전반을 더 선호하게.
        const fedMult = getPlayerFlag(playerId, 'fedValueMult', 0);
        const fedScore = feds.length * w.federationValueEach * (fedMult > 0 ? fedMult : 1) * fedRoundScale;
        score += fedScore;
        logDebug(`8) Federations: ${feds.length} * ${w.federationValueEach.toFixed(0)} * ${fedRoundScale.toFixed(2)} = +${fedScore.toFixed(1)}`);

        // [flag: clusterFedBonus] 위성 없이 연방 가능한 밀집 클러스터 근접도 보상.
        // 멀리 떨어진 집을 위성으로 잇는 대신, 가까운 집들의 티어를 올려(파워↑) 7파워를 채우게 유도.
        // gap(필요파워-클러스터파워)이 작을수록 보상 → 인접 건물 업그레이드가 점수를 올림.
        // [flag: clusterFedGradient] 연방 병목 해부(2026-07-07, 2.2만 시드): 결정실패 0%, fed1 정체의 45%가
        // SCATTERED(파워는 있는데 흩어짐), 배치 실측 사람 직접인접 31% vs 봇 21%. 기존 clusterFedBonus는
        // gap≤3에서만 발동해 초반 배치(클러스터 3~4파워, gap 4+)엔 신호 0 — 흩뿌린 다음에야 보상이 켜짐.
        // 전 구간 그라디언트: 최대 미연방 클러스터 파워에 비례 보상(req 캡) → 2번째 건물부터 군집이 점수가 됨.
        if (getPlayerFlag(playerId, 'clusterFedGradient', false)) {
            const required = getFederationRequiredPower(game, playerId);
            // [v2 2026-07-07] v1(클러스터만 보상)은 연방 선언 순간 클러스터가 fedHexes로 빠져 보상 소멸
            // → 선언 회피 인센티브(40판 실측: 연방 1.45→1.38 역행). 통합 지표 '연방화 파워 + 미연방 최대
            // 클러스터'로 — 선언 시 클러스터→연방 전환이 점수 중립 이상이라 회피 유인 제거, 군집 신호는 유지.
            const clusterPower = Math.min(bestUnfederatedClusterPower(game, playerId), required);
            const unified = feds.length * required + clusterPower;
            if (unified > 0) {
                const gradScore = unified * 12 * fedRoundScale;
                score += gradScore;
                logDebug(`8b) ClusterGradient v2: fed ${feds.length}×${required} + cluster ${clusterPower} → +${gradScore.toFixed(1)}`);
            }
        } else if (getPlayerFlag(playerId, 'clusterFedBonus', true)) {
            const required = getFederationRequiredPower(game, playerId);
            const clusterPower = bestUnfederatedClusterPower(game, playerId);
            const gap = required - clusterPower;
            if (clusterPower > 0 && gap <= 3) {
                const near = Math.max(0, 4 - Math.max(0, gap)); // gap0→4, 1→3, 2→2, 3→1
                // [실험·플래그 fedPacePush] 연방 수가 인간 페이스(R3:1, R4:2, R5+:3)보다 뒤지면 "질 신호"인
                // 클러스터 근접 보상만 증폭(개수 직접 보상은 buildOrderPlanner에서 −3.55로 실패 → 금지).
                // 봇 연방 1.4 vs 사람 4.5 — 모든 상류(초록→L5·고급타일)의 병목.
                let paceMul = 1.0;
                if (getPlayerFlag(playerId, 'fedPacePush', false)) {
                    const paceTarget = round >= 5 ? 3 : round >= 4 ? 2 : round >= 3 ? 1 : 0;
                    if (feds.length < paceTarget) paceMul = 1.9;
                }
                const clusterScore = near * 22 * fedRoundScale * paceMul;
                score += clusterScore;
                logDebug(`8b) ClusterFed: power ${clusterPower}/${required} (gap ${gap})${paceMul > 1 ? ` ×${paceMul}(pace)` : ''} → +${clusterScore.toFixed(1)}`);
            }
        }

        // [flag: advTileReadyBonus] 고급 기술타일 '준비 상태' 보상.
        // 봇 기술타일 VP가 0인 핵심 원인: 고급타일은 (초록연방 보유 + 트랙 L4 + 덮을 일반타일)이
        // 동시에 맞아야 후보가 생성되는데 봇이 그 정렬을 못 맞춤. 초록연방을 들고 있고 사용가능한
        // 고급타일이 걸린 트랙이 L4에 가까울수록 보상해, 트랙을 L4로 밀고 초록연방을 아껴 정렬을 유도.
        if (getPlayerFlag(playerId, 'advTileReadyBonus', true)) {
            const greenAvail = countGreenFederations(player);
            const advByTrack = (game as any).advancedTechTilesByTrack as Record<string, { id?: string } | null> | undefined;
            if (greenAvail >= 1 && advByTrack) {
                let bestLvl = 0;
                for (const [tr, adv] of Object.entries(advByTrack)) {
                    if (!adv?.id || player.techTiles?.includes(adv.id)) continue; // 이미 보유/슬롯 비었으면 제외
                    const lvl = (player.research as Record<string, number> | undefined)?.[tr] ?? 0;
                    if (lvl > bestLvl) bestLvl = lvl;
                }
                if (bestLvl >= 3) {
                    const ready = Math.min(bestLvl, 4) - 2; // L3→1, L4→2
                    // [flag: advTileValueBoost] 사용자 가설검증 — 고급타일이 저평가라 MCTS가 경로를 안 따라가나?
                    //   준비보상을 30→90으로 키워 "초록+L4+고급타일 가능" 상태를 강하게 만들어, MCTS가 트리거(아카/연구소) 건설로 끌리는지 직접 측정.
                    const readyW = getPlayerFlag(playerId, 'advTileValueMax', false) ? 400 : (getPlayerFlag(playerId, 'advTileValueBoost', false) ? 90 : 30);
                    const advScore = ready * readyW * fedRoundScale;
                    score += advScore;
                    logDebug(`8c) AdvTileReady: green ${greenAvail}, bestTrackLvl ${bestLvl} → +${advScore.toFixed(1)}`);
                }
            }
        }

        // 연방 형성 직후(보상 선택 대기) 상태는 연방 엔트리(feds.length)가 아직 안 늘고 보상 VP도
        // 미반영이라(보상 선택이 별도 단계) 평가가 '연방 형성'을 과소평가 → 봇이 회피(avgFed 1.6, 사람 4.75).
        // 임박한 가치(연방 엔트리 1 + 보상 ~10VP)를 반영해 MCTS가 form_federation을 제대로 선택하게 한다.
        // head2head 60g do-no-harm(51.7%). 연방 전략은 셀프플레이로 검증 불가라 실효는 사용자 1:3 실전으로 확인. 상시 적용.
        if ((game as any).pendingFederationReward?.playerId === playerId) {
            const formBonus = w.federationValueEach * fedRoundScale + 10 * vpWeight;
            score += formBonus;
            logDebug(`8b) Federation-forming (pending reward): +${formBonus.toFixed(1)}`);
        }

        // 고급 기술타일 획득 중(pendingAdvancedTechCover) 크레딧 — 연방 형성 중 보너스와 같은 패턴.
        // select_advanced_tech_tile 직후엔 타일이 아직 techTiles에 없어(커버 후 확정) 평가가 0 →
        // MCTS가 "즉시 보상 있는 일반 타일"만 선택, 고급타일 채택 0의 두 번째 원인. 입수 직전 가치를 크레딧.
        if ((game as any).pendingAdvancedTechCover?.playerId === playerId) {
            const advCredit = getPlayerFlag(playerId, 'advTileValueMax', false) ? 2000 : 240;
            score += advCredit;
            logDebug(`8d) AdvTile-acquiring (pending cover): +${advCredit.toFixed(1)}`);
        }

        // [flag: pendingTechTileValue] 옵션가치: 아카/연구소 등을 지으면 '곧' 기술타일을 고른다(pendingTechTileSelection).
        //   그 임박가치를 평가에 안 넣으면(지금까진 0) 봇이 그 빌드를 저평가 → 즉시VP(광물→위성 12점 연방 등)에 밀림
        //   (사용자 지적의 근본원인: 다턴이면 '아카+기술타일 7점' 라인이 더 좋은데 그리디가 셋업 중간상태를 저평가).
        //   보유 타일은 아래 projectedTechIncome로 평가되나 pending은 아직 techTiles에 없음 → 임박 타일 1장 기대VP를 당겨줌.
        //   pendingFederationReward(10*vpWeight)와 같은 패턴. 하드코딩 목표 대신 평가기가 A vs B를 스스로 판단하게 하는 레버.
        if (getPlayerFlag(playerId, 'pendingTechTileValue', true) && (game as any).pendingTechTileSelection?.playerId === playerId) {
            const incR = Math.max(0, 6 - round);
            const pend = Math.min(7 + incR * 1.5, 13) * vpWeight; // 기본 ~7VP + 남은 라운드 수입 소폭(과대 방지 상한 13)
            score += pend;
            logDebug(`8e) Pending TechTile imminent: +${pend.toFixed(1)}`);
        }

        // 7) Gaiaformers
        if (player.gaiaformers && player.gaiaformers > 0) {
            const gaiaScore = player.gaiaformers * w.gaiaformerValueEach;
            score += gaiaScore;
            logDebug(`9) Gaiaformers: ${player.gaiaformers} * ${w.gaiaformerValueEach} = +${gaiaScore.toFixed(1)}`);
        }
        // [flag: gaiaformerPlacedValue] 다턴 세팅 핵심: '놓은 가이아포머'(transdim에 내 포머, 다음 라운드 성숙→가이아 광산)를
        //   평가기가 0으로 봐서, 포머 놓으면 gaiaformers -1(−5점)만 남고 미래 광산 가치는 미반영 → MCTS가 '포머 놓기=순손해'로
        //   판단해 절대 안 놓음(봇 0.03 vs 사람 0.43). 예약된 가이아 타일을 '거의 확정된 새 광산'으로 크레딧해 다턴 세팅을 유도.
        //   배치가 MCTS 결정이라 평가기 수정이 직접 먹힌다(advanced-tile과 달리).
        if (getPlayerFlag(playerId, 'gaiaformerPlacedValue', false)) {
            const placed = (player.pendingGaiaformerTiles?.length ?? 0);
            if (placed > 0) {
                const placedScore = placed * 16; // 새 가이아 광산 1개 ≈ 수입+확장+연방씨앗 (소비된 포머 5점보다 큼 = 순이득)
                score += placedScore;
                logDebug(`9b) Placed gaiaformers (pending gaia mines): ${placed} * 16 = +${placedScore.toFixed(1)}`);
            }
        }

        // 8) 현재 라운드 미션 정렬 보너스 (해당 라운드 VP를 더 벌 수 있으면 가치 상승)
        let roundBonus = 0;
        const roundMissions = game.roundScoringTiles;
        if (roundMissions?.length && round >= 1 && round <= 6) {
            const mission = roundMissions[round - 1];
            if (mission?.vp) {
                const trigger = (mission as any).triggerType as string | undefined;
                const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);
                const mineCount = myStructures.filter(t => t.structure === 'mine' || t.structure === 'lost_planet_mine').length;
                const tsCount = myStructures.filter(t => t.structure === 'trading_station').length;
                const labCount = myStructures.filter(t => t.structure === 'research_lab').length;
                const bigCount = myStructures.filter(t => t.structure === 'planetary_institute' || t.structure === 'academy').length;
                const gaiaCount = game.map.filter(t => t.ownerId === playerId && t.structure && (t.type === 'gaia' || (t as any).gaiaformed)).length;
                const researchLevels = Object.values(player.research || {}).reduce((s, l) => s + (l as number), 0);
                if (trigger === 'build_mine') roundBonus += mineCount * mission.vp * 1.4;
                else if (trigger === 'build_trading_station') roundBonus += tsCount * mission.vp * 1.4;
                else if (trigger === 'build_research_lab') roundBonus += labCount * mission.vp * 1.4;
                else if (trigger === 'build_big_building') roundBonus += bigCount * mission.vp * 1.4;
                else if (trigger === 'build_gaia') roundBonus += gaiaCount * mission.vp * 1.4;
                else if (trigger === 'research_track') roundBonus += researchLevels * mission.vp * 1.3;
                else if (trigger === 'federation') roundBonus += feds.length * mission.vp * 1.5;
                // [라운드미션 커버리지 2026-06-15] 평가기에 누락됐던 new_planet_type/new_sector 추가
                // (이 라운드 점수일 때 봇이 새 타입/섹터 확장을 정렬하도록).
                else if (trigger === 'new_planet_type') roundBonus += new Set(myStructures.map(t => t.type).filter(Boolean)).size * mission.vp * 1.4;
                else if (trigger === 'new_sector') roundBonus += new Set(myStructures.map(t => t.sector)).size * mission.vp * 1.4;
            }
        }
        if (roundBonus > 0) {
            score += roundBonus;
            logDebug(`10) Round Mission Bonus: +${roundBonus.toFixed(1)}`);
        }

        // 9) 최종 미션 정렬 보너스 (게임 끝 1/2/3등 18/12/6점 쪽으로 유도)
        // 후반일수록 가중치 상향 — R1~2엔 0.7x, R3엔 1.0x, R4~5엔 1.4x, R6엔 1.8x
        let finalBonus = 0;
        const finalIds = game.finalMissionIds;
        const finalScaling = round <= 2 ? 0.7 : round === 3 ? 1.0 : round <= 5 ? 1.4 : 1.8;
        if (finalIds?.length) {
            // [개선] 수작업 절대값 공식 대신, 실제 채점과 동일한 순위기반 함수(getFinalMissionVp)로
            // "이 보드에서 게임이 끝났다면 받을 최종미션 VP(18/12/6)"를 그대로 투영한다.
            // → 봇이 모든 9종 미션을 정확히 인식하고, 상대 대비 내 순위를 따라잡거나(또는 이미 1등이면 과투자 안 함) 판단.
            // 추가로 raw value 그래디언트(ownVal)를 약하게 더해, 같은 순위 안에서도 수치를 계속 끌어올려
            // 다음 등수로 추월하도록 유도한다.
            for (const fid of finalIds) {
                let projVp = 0;
                try { projVp = getFinalMissionVp(game as any, playerId, fid); } catch { projVp = 0; }
                let ownVal = 0;
                try { ownVal = getFinalMissionValue(game as any, playerId, fid); } catch { ownVal = 0; }
                // projVp(0~18)를 주신호로, ownVal은 연속적 진척 신호로 약하게 가산
                finalBonus += (projVp * 3.0 + ownVal * 2.5) * finalScaling;
            }
        }
        if (finalBonus > 0) {
            score += finalBonus;
            logDebug(`11) Final Mission Bonus: +${finalBonus.toFixed(1)}`);
        }

        // 10) 기술 타일 등 미래 수입(엔진)에 대한 프로젝션 가치 (사용자 피드백 반영)
        // 당장 수입이 안 들어왔더라도 앞으로 N라운드 동안 들어올 자원을 미리 당겨서 가치로 환산
        const incomeRounds = Math.max(0, 6 - round);
        let projectedTechIncomeScore = 0;
        if (incomeRounds > 0 && player.techTiles) {
            for (const techId of player.techTiles) {
                if (player.coveredTechTiles?.includes(techId)) continue; // 고급타일에 덮인 기본타일은 수입 없음
                if (techId === 'tech-inc-1o-1p') {
                    // 앞으로 incomeRounds 번 1광물, 1파워
                    const totalOre = incomeRounds * 1;
                    const totalPower = incomeRounds * 1;
                    projectedTechIncomeScore += totalOre * w.oreValue * resMult * 1.8;
                    projectedTechIncomeScore += totalPower * w.power2Value * 1.3;
                } else if (techId === 'tech-inc-4c') {
                    const totalCred = incomeRounds * 4;
                    projectedTechIncomeScore += totalCred * w.creditsValue * resMult * 1.6;
                } else if (techId === 'tech-inc-1k-1c') {
                    const totalKnow = incomeRounds * 1;
                    const totalCred = incomeRounds * 1;
                    projectedTechIncomeScore += totalKnow * w.knowledgeValue * resMult * 1.9;
                    projectedTechIncomeScore += totalCred * w.creditsValue * resMult * 1.6;
                } else if (techId === 'tech-act-4p') {
                    // 매 라운드 4파워 액션
                    const totalPower = (incomeRounds + 1) * 4;
                    projectedTechIncomeScore += totalPower * w.power2Value * 1.1;
                }
            }
        }
        // 미래 수입 보너스가 현재 보드/점수 신호를 압도하지 않도록 상한 (조금 더 풀어줌)
        projectedTechIncomeScore = Math.min(projectedTechIncomeScore, 320);

        // 10b) 고급 기술 타일 직접 평가 (선택 가치 인식)
        // - imm-* : 즉시 VP — 현재 보드 상태에서 곧장 환산
        // - pass-* : 패스시 VP — 남은 라운드(incomeRounds+1: 이번 라운드 포함) × 보드 카운트
        // - vp-act-* : 액션마다 VP — 라운드당 평균 활동량 × 남은 라운드
        // - act-* : 라운드당 1회 자원 액션 — 남은 라운드 × 자원 가치
        const remainingPasses = incomeRounds + 1; // 이번 라운드 포함
        let advTechScore = 0;
        if (player.techTiles) {
            // 보드 카운트 미리 계산 (재사용)
            const _myStructs = game.map.filter(t => t.ownerId === playerId && t.structure);
            const _mineCount = _myStructs.filter(t => t.structure === 'mine' || t.structure === 'lost_planet_mine').length;
            const _tsCount = _myStructs.filter(t => t.structure === 'trading_station').length;
            const _labCount = _myStructs.filter(t => t.structure === 'research_lab').length;
            const _bigCount = _myStructs.filter(t => t.structure === 'planetary_institute' || t.structure === 'academy').length;
            const _gaiaCount = game.map.filter(t => t.ownerId === playerId && t.structure && t.type === 'gaia').length;
            const _planetTypes = new Set(_myStructs.map(t => t.type).filter(Boolean)).size;
            const _outerSectors = new Set(
                _myStructs
                    .filter(t => typeof (t as any).sector === 'number' && (t as any).sector >= 11)
                    .map(t => (t as any).sector as number)
            ).size;
            const _asteroidCount = _myStructs.filter(t => (t as any).type === 'asteroid').length;
            const _sectorSet = new Set(_myStructs.map(t => (t as any).sector).filter((s): s is number => typeof s === 'number')).size;
            const _fedsCount = (getFederationEntries(player) ?? []).length;
            // 라운드당 평균 활동량 (대략 광산+TS 건설 1~2 / 연구 1 / 테라포밍 1 / QIC액션 0.5)
            const buildsPerRound = Math.max(1, Math.min(2, 1 + (mineCount + tsCount) / 8));
            const researchPerRound = Math.min(1.5, 0.6 + Object.keys(player.research || {}).length * 0.1);
            const terraformPerRound = 1.0;
            const qicActPerRound = 0.5;

            for (const techId of player.techTiles) {
                // 즉시형
                if (techId === 'adv-imm-4vp-ts') advTechScore += _tsCount * 4 * w.vpWeightLate * 0.6;
                else if (techId === 'adv-imm-2vp-mine') advTechScore += _mineCount * 2 * w.vpWeightLate * 0.6;
                else if (techId === 'adv-imm-2vp-sector') advTechScore += _sectorSet * 2 * w.vpWeightLate * 0.6;
                else if (techId === 'adv-imm-4vp-outer') advTechScore += _outerSectors * 4 * w.vpWeightLate * 0.6;
                else if (techId === 'adv-imm-6vp-big') advTechScore += _bigCount * 6 * w.vpWeightLate * 0.6;
                else if (techId === 'adv-imm-2vp-gaia') advTechScore += _gaiaCount * 2 * w.vpWeightLate * 0.6;
                else if (techId === 'adv-imm-5vp-fed') advTechScore += _fedsCount * 5 * w.vpWeightLate * 0.6;
                else if (techId === 'adv-imm-1o-sector') advTechScore += _sectorSet * 1 * w.oreValue * resMult * 2.0;
                // 패스형 (남은 라운드 × 카운트 × VP)
                else if (techId === 'adv-pass-1vp-type') advTechScore += remainingPasses * _planetTypes * 1 * w.vpWeightLate * 0.5;
                else if (techId === 'adv-pass-3vp-lab') advTechScore += remainingPasses * Math.max(_labCount, 1) * 3 * w.vpWeightLate * 0.5;
                else if (techId === 'adv-pass-3vp-fed') advTechScore += remainingPasses * Math.max(_fedsCount, 1) * 3 * w.vpWeightLate * 0.5;
                else if (techId === 'adv-pass-2vp-asteroid') advTechScore += remainingPasses * _asteroidCount * 2 * w.vpWeightLate * 0.5;
                else if (techId === 'adv-pass-2vp-outer') advTechScore += remainingPasses * _outerSectors * 2 * w.vpWeightLate * 0.5;
                // 액션마다 VP (남은 라운드 × 라운드당 빈도 × VP)
                else if (techId === 'adv-vp-build-mine') advTechScore += incomeRounds * buildsPerRound * 0.6 * 3 * w.vpWeightLate * 0.5;
                else if (techId === 'adv-vp-build-ts') advTechScore += incomeRounds * buildsPerRound * 0.4 * 3 * w.vpWeightLate * 0.5;
                else if (techId === 'adv-vp-research') advTechScore += incomeRounds * researchPerRound * 2 * w.vpWeightLate * 0.5;
                else if (techId === 'adv-vp-terraform') advTechScore += incomeRounds * terraformPerRound * 2 * w.vpWeightLate * 0.5;
                else if (techId === 'adv-vp-qic-action') advTechScore += incomeRounds * qicActPerRound * 4 * w.vpWeightLate * 0.5;
                // 라운드당 1회 자원 액션
                else if (techId === 'adv-act-3k') advTechScore += remainingPasses * 3 * w.knowledgeValue * resMult * 1.6;
                else if (techId === 'adv-act-3o') advTechScore += remainingPasses * 3 * w.oreValue * resMult * 1.6;
                else if (techId === 'adv-act-1q-5c') advTechScore += remainingPasses * (1 * qicWeight + 5 * w.creditsValue * resMult) * 1.3;
            }
        }
        // [개선] 고급 기술타일은 다(多)연방/다구조물형 반복VP라 잠재가치가 큼 — 상한 600→1000으로 상향.
        // [flag: advTileValueBoost] 보유 고급타일 가치의 ×0.5 디스카운트를 상쇄(×2)해 '거의 정가'로 — 저평가 가설 테스트.
        if (getPlayerFlag(playerId, 'advTileValueMax', false)) advTechScore *= 6;
        else if (getPlayerFlag(playerId, 'advTileValueBoost', false)) advTechScore *= 2;
        advTechScore = Math.min(advTechScore, getPlayerFlag(playerId, 'advTileValueMax', false) ? 6000 : 1400);
        if (advTechScore > 0) {
            score += advTechScore;
            logDebug(`12b) Advanced Tech Tiles: +${advTechScore.toFixed(1)}`);
        }

        // [개선] 소득형 인공물(Twilight) 미래가치 — 남은 라운드 동안 매 수입마다 들어오는 자원을 미리 환산.
        // 기존엔 evaluator가 인공물 보유를 전혀 평가하지 않아 봇이 인공물 상태가치를 과소평가했음.
        if (player.artifacts && incomeRounds > 0) {
            let artIncomeScore = 0;
            if (player.artifacts.includes('art-income-2p3')) {
                artIncomeScore += incomeRounds * 2 * w.power3Value * 2.5; // 매 수입 +2 파워(그릇3)
            }
            if (player.artifacts.includes('art-income-1k1o')) {
                artIncomeScore += incomeRounds * (w.knowledgeValue + w.oreValue) * resMult * 2.0; // 매 수입 +1K +1O
            }
            if (artIncomeScore > 0) {
                score += artIncomeScore;
                logDebug(`12c) Artifact Income (Rounds=${incomeRounds}): +${artIncomeScore.toFixed(1)}`);
            }
        }

        if (projectedTechIncomeScore > 0) {
            score += projectedTechIncomeScore;
            logDebug(`12) Projected Tech Income (Rounds=${incomeRounds}): +${projectedTechIncomeScore.toFixed(1)}`);
        }

        // 13) [실험·플래그 useGoalPlanner] 다턴 목표 플래너 바이어스.
        // 강한 사람(Space Giants 273) 빌드오더의 "형태"로 유도. 국소 튜닝(expandDrive 등)이 null이었던 점을 감안,
        // "라운드별 페이스 목표"에 못 미칠 때 해당 영역을 보상해 다턴 시퀀스(연구심화·우주선엔진·고급패스타일·연방조기)를 유도.
        if (getPlayerFlag(playerId, 'useGoalPlanner', false)) {
            let gp = 0;
            const gpTech = player.techTiles || [];
            // (1) 연구 깊이 페이스: 273게임 누적 총레벨 곡선 근사. 뒤처지면 연구를 강하게 우선.
            const gpTotalResearch = Object.values(player.research || {}).reduce((s, l) => s + (l as number), 0);
            const gpResearchTarget = [0, 3, 6, 9, 12, 15, 17][Math.min(round, 6)] ?? 0;
            if (gpTotalResearch < gpResearchTarget) gp += (gpResearchTarget - gpTotalResearch) * 20;
            const gpTracksL4 = Object.values(player.research || {}).filter(l => (l as number) >= 4).length;
            gp += gpTracksL4 * 45; // 다트랙 심화(273게임은 5트랙 L4~5)
            // (2) 우주선 액션 엔진: 탑승만이 아니라 "사용한 액션"을 보상(활용 유도). 소행성광산=확장+adv-pass+최종미션 트리플.
            let gpUsedShipActions = 0;
            for (const sid of (player.spaceshipsEntered || [])) gpUsedShipActions += (game.spaceships?.[sid]?.usedActionIndices?.length || 0);
            gp += gpUsedShipActions * 35;
            const gpAsteroid = myStructures.filter(t => (t as any).type === 'asteroid').length;
            gp += gpAsteroid * 16;
            // (3) 고급 패스 기술타일(반복 VP) 보유 강화
            gp += gpTech.filter(t => t.startsWith('adv-pass-')).length * 55;
            // (4) 연방 조기 페이스
            const gpFedTarget = round >= 4 ? 3 : round >= 3 ? 2 : round >= 2 ? 1 : 0;
            if (feds.length < gpFedTarget) gp += (gpFedTarget - feds.length) * 45;
            if (gp !== 0) { score += gp; logDebug(`13) GoalPlanner: +${gp.toFixed(1)}`); }
        }

        // 14) [실험·플래그 shipEngineBonus] 우주선 "사용 액션" 보상 (핸드오프 #1 표적: 봇 우주선 VP 0, 사람 17~24).
        // v1(사용액션 + 탑승 잠재가치)은 h2h null(−3.03, 과탑승 의심) → v2: 탑승 잠재가치 제거, "실제 사용한 액션"만 보상.
        // 실행된 액션에만 보상이라 과탑승 부작용이 없고, MCTS 탐색에서 우주선 액션 후보 점수를 직접 끌어올림.
        if (getPlayerFlag(playerId, 'shipEngineBonus', false)) {
            let usedShipActions = 0;
            for (const sid of (player.spaceshipsEntered || [])) usedShipActions += (game.spaceships?.[sid]?.usedActionIndices?.length || 0);
            const se = usedShipActions * 35;
            if (se > 0) { score += se; logDebug(`14) ShipEngine(use-only): +${se.toFixed(1)}`); }
        }

        // 15) [flag: engineBlend (숫자 가중치, 0=off)] 학습된 엔진 가치망 블렌드.
        // 봇 자가대국 데이터로 학습한 score-마스킹 net이 엔진(gaia/tech/fed) 빌드업의 미래VP를 추정 →
        // greedy 봇이 즉시 점수뿐 아니라 '엔진 성장'을 보게 함. 추론도 학습과 동일하게 score계열 마스킹.
        const engBlendW = getPlayerFlag(playerId, 'engineBlend', 0);
        if (engBlendW) {
            const net = getEngineNet();
            if (net) {
                const f = extractFeatures(game, playerId);
                f[2] = 0; f[29] = 0; f[30] = 0; // score, scoreVsMaxOpp, scoreVsMeanOpp 마스킹 (학습과 일치)
                const eng = engBlendW * net.predict(f);
                score += eng;
                logDebug(`15) EngineBlend(x${engBlendW}): +${eng.toFixed(1)}`);
            }
        }

        // [flag: humanValueBlendK] 사람게임 가치망 가산 (위에서 계산, 0=OFF)
        score += hvnBonus;

        if (debug) {
            if (hvnBonus !== 0) logDebug(`hvn) humanValueNet blend: +${hvnBonus.toFixed(1)}`);
            logDebug(`==> Total Score: ${score.toFixed(1)}`);
            console.log(logs.join('\n'));
        }

        return score;
    }
}
