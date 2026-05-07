import { ServerGameState } from '../gameState';
import { getFederationEntries } from '@shared/gameConfig';
import fs from 'fs';
import path from 'path';

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

export function loadEvaluatorWeightsFromFile(filePath: string): EvaluatorWeightsProfile | null {
    try {
        const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
        if (!fs.existsSync(abs)) return null;
        const raw = fs.readFileSync(abs, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (isProfileShape(parsed)) {
            return setActiveEvaluatorWeights(parsed as Partial<EvaluatorWeightsProfile>);
        }
        return setActiveEvaluatorWeights(parsed as Partial<EvaluatorWeights>);
    } catch {
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

        const factionPatch = player.faction ? ACTIVE_PROFILE.byFaction?.[player.faction] : undefined;
        const w = factionPatch
            ? normalizeWeights({ ...ACTIVE_PROFILE.global, ...factionPatch } as EvaluatorWeights)
            : ACTIVE_PROFILE.global;

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
        const vpScore = (player.score || 0) * vpWeight;
        score += vpScore;
        logDebug(`1) VP: ${player.score || 0} * ${vpWeight.toFixed(1)} = +${vpScore.toFixed(1)}`);

        // 2) Resources
        // [수정] 자원을 킵하는 것을 '효율적'이라고 오해하지 않도록, 쓰지 않은 잉여 자원은 0.1수준의 아주 낮은 점수만 부여
        const oreScore = (player.ore || 0) * w.oreValue * 0.1;
        const credScore = (player.credits || 0) * w.creditsValue * 0.1;
        const knowScore = (player.knowledge || 0) * w.knowledgeValue * 0.1;

        score += oreScore + credScore + knowScore;
        logDebug(`2) Resources: Ore +${oreScore.toFixed(1)}, Cred +${credScore.toFixed(1)}, Know +${knowScore.toFixed(1)}`);

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
        const p3Score = (player.power3 || 0) * w.power3Value;
        let bsScore = 0;
        if (player.brainStoneBowl === 1) bsScore += w.brainStoneBowl1;
        if (player.brainStoneBowl === 2) bsScore += w.brainStoneBowl2;
        if (player.brainStoneBowl === 3) bsScore += w.brainStoneBowl3;
        score += p1Score + p2Score + p3Score + bsScore;
        logDebug(`4) Power: P1(+${p1Score.toFixed(1)}), P2(+${p2Score.toFixed(1)}), P3(+${p3Score.toFixed(1)}), BrainStone(+${bsScore.toFixed(1)})`);

        // 4) Structures
        const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);

        // 확장(광산 10개 이상)에 대한 추가 보너스
        let structExpansionScore = 0;
        if (myStructures.length >= 10) {
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

        // 2. 퍼널 구조 건물 점수 (교역소 병목 현상 해결)
        // 첫 번째 교역소는 연구소/아카데미로 가는 발판이므로 가치를 크게 줍니다.
        // 하지만 이미 연구소나 의회 등 상위 건물이 있다면, 현재 교역소가 0개라도 새로 짓는 교역소는 '두 번째 교역소'로 취급해야 합니다. (첫 교역소의 병목은 이미 뚫었기 때문)
        const advancedStructuresCount = labCount + piCount + academyCount;
        let tsScore = 0;
        for (let i = 0; i < tsCount; i++) {
            // 상위 건물이 아예 없을 때 짓는 교역소 1개만 '첫 교역소'의 엄청난 보너스를 받음
            if (i === 0 && advancedStructuresCount === 0) {
                tsScore += w.structureTradingStation * structMultiplier;
            } else {
                // 교역소는 광산을 업그레이드해서 짓는 것이므로 광산보다 가치가 낮아지면 안 됨 (페널티 제거)
                const secondTsBase = round <= 2 ? w.structureMine + 15 : (w.structureTradingStation + w.structureMine) / 2;
                tsScore += secondTsBase * structMultiplier;
            }
        }
        structScore += tsScore;

        // 3. 1~2라운드 이상적인 테크 트리 보너스 (엔진 빌딩)
        let engineBonus = 0;
        if (round <= 2) {
            if (labCount >= 1) {
                engineBonus += 45;
                engineBonus += (mineCount + tsCount) * 6;
            }
            if (piCount >= 1 || academyCount >= 1) {
                engineBonus += 70;
                engineBonus += (mineCount + tsCount) * 5;
            }
        }

        // 엔진 보너스는 이미 구조 점수와 중첩되므로 별도 multiplier를 적용하지 않음(중복 증폭 방지)
        const scaledEngineBonus = engineBonus;
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
        let researchScore = 0;
        for (const [track, level] of Object.entries(player.research || {})) {
            const weight = rw[track] ?? 10;
            let factor = 1 + remainingRounds * w.researchRemainingRoundsFactor;
            // 초반 지식(science) 트랙 효율이 낮음 — 남은 라운드가 많을수록 페널티
            if (track === 'science' && remainingRounds > 2) {
                factor *= Math.max(0.35, 1 - (remainingRounds - 2) * 0.2);
            }
            const lvl = level as number;

            // 연구 단계 점수 부스팅
            // 후반 라운드일수록 높은 단계의 연구가 더 가치가 높도록 (종료 점수 등)
            let levelMultiplier = 1;
            if (lvl >= 3) levelMultiplier = 1.2;
            if (lvl >= 4) levelMultiplier = 1.5;

            researchScore += lvl * weight * factor * levelMultiplier;

            if (lvl >= 4) researchScore += (w.researchLevel4Bonus || 100);
            if (lvl === 5) researchScore += w.researchLevel5Bonus;
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

        // 6) Federations
        const feds = getFederationEntries(player);
        const fedScore = feds.length * w.federationValueEach;
        score += fedScore;
        logDebug(`8) Federations: ${feds.length} * ${w.federationValueEach} = +${fedScore.toFixed(1)}`);

        // 7) Gaiaformers
        if (player.gaiaformers && player.gaiaformers > 0) {
            const gaiaScore = player.gaiaformers * w.gaiaformerValueEach;
            score += gaiaScore;
            logDebug(`9) Gaiaformers: ${player.gaiaformers} * ${w.gaiaformerValueEach} = +${gaiaScore.toFixed(1)}`);
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
                if (trigger === 'build_mine') roundBonus += mineCount * mission.vp * 1.1;
                else if (trigger === 'build_trading_station') roundBonus += tsCount * mission.vp * 1.1;
                else if (trigger === 'build_research_lab') roundBonus += labCount * mission.vp * 1.1;
                else if (trigger === 'build_big_building') roundBonus += bigCount * mission.vp * 1.1;
                else if (trigger === 'build_gaia') roundBonus += gaiaCount * mission.vp * 1.1;
                else if (trigger === 'research_track') roundBonus += researchLevels * mission.vp;
                else if (trigger === 'federation') roundBonus += feds.length * mission.vp * 1.5;
            }
        }
        if (roundBonus > 0) {
            score += roundBonus;
            logDebug(`10) Round Mission Bonus: +${roundBonus.toFixed(1)}`);
        }

        // 9) 최종 미션 정렬 보너스 (게임 끝 1/2/3등 18/12/6점 쪽으로 유도)
        let finalBonus = 0;
        const finalIds = game.finalMissionIds;
        if (finalIds?.length) {
            const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);
            const structCount = myStructures.length;
            const gaiaCount = game.map.filter(t => t.ownerId === playerId && t.structure && (t.type === 'gaia' || (t as any).gaiaformed)).length;
            const sectorSet = new Set(myStructures.map(t => (t as any).sector).filter((s): s is number => typeof s === 'number'));
            for (const fid of finalIds) {
                if (fid === 'fm_total_structures') finalBonus += structCount * 4;
                else if (fid === 'fm_federation_buildings' || fid === 'fm_gaia_planets') finalBonus += (feds.length * 5 + gaiaCount * 4);
                else if (fid === 'fm_sectors') finalBonus += sectorSet.size * 5;
                else if (fid === 'fm_satellites') {
                    let sat = 0;
                    for (const v of Object.values(game.satellites || {})) {
                        if (Array.isArray(v)) sat += v.filter((id: string) => id === playerId).length;
                        else if (v === playerId) sat += 1;
                    }
                    finalBonus += sat * 6;
                }
                else if (fid === 'fm_planet_types') {
                    const types = new Set(myStructures.map(t => t.type).filter(Boolean));
                    finalBonus += types.size * 5;
                } else finalBonus += structCount * 2;
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
        // 미래 수입 보너스가 현재 보드/점수 신호를 압도하지 않도록 상한
        projectedTechIncomeScore = Math.min(projectedTechIncomeScore, 220);
        if (projectedTechIncomeScore > 0) {
            score += projectedTechIncomeScore;
            logDebug(`12) Projected Tech Income (Rounds=${incomeRounds}): +${projectedTechIncomeScore.toFixed(1)}`);
        }

        if (debug) {
            logDebug(`==> Total Score: ${score.toFixed(1)}`);
            console.log(logs.join('\n'));
        }

        return score;
    }
}
