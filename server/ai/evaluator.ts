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

    federationValueEach: number;
    gaiaformerValueEach: number;
};

export const DEFAULT_EVALUATOR_WEIGHTS: EvaluatorWeights = {
    vpWeightEarly: 5,
    vpWeightLate: 10,

    resourceMultiplierEarly: 1.0,
    resourceMultiplierLate: 0.8,
    oreValue: 0.4,
    creditsValue: 0.08,
    knowledgeValue: 0.2,

    qicWeightEarly: 1.5,
    qicWeightLate: 3.5,

    power1Value: 0.05,
    power2Value: 0.2,
    power3Value: 0.5,
    brainStoneBowl1: 0.2,
    brainStoneBowl2: 0.8,
    brainStoneBowl3: 1.5,

    structureMine: 12,
    structureTradingStation: 25,
    structureResearchLab: 40,
    structurePlanetaryInstitute: 60,
    structureAcademy: 70,
    structureRemainingRoundsFactor: 0.6,

    researchTerraforming: 12,
    researchNavigation: 12,
    researchArtificialIntelligence: 15,
    researchGaiaProject: 10,
    researchEconomy: 20,
    researchScience: 25,
    researchRemainingRoundsFactor: 0.2,
    researchLevel5Bonus: 80,

    federationValueEach: 25,
    gaiaformerValueEach: 2,
};

let ACTIVE_WEIGHTS: EvaluatorWeights = { ...DEFAULT_EVALUATOR_WEIGHTS };

function normalizeWeights(w: EvaluatorWeights): EvaluatorWeights {
    // Basic sanity clamps to avoid pathological tuning runs
    const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
    return {
        ...w,
        vpWeightEarly: clamp(w.vpWeightEarly, 0, 30),
        vpWeightLate: clamp(w.vpWeightLate, 0, 30),

        resourceMultiplierEarly: clamp(w.resourceMultiplierEarly, 0, 2),
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
        researchLevel5Bonus: clamp(w.researchLevel5Bonus, 0, 400),

        federationValueEach: clamp(w.federationValueEach, 0, 200),
        gaiaformerValueEach: clamp(w.gaiaformerValueEach, 0, 50),
    };
}

export function setActiveEvaluatorWeights(next: Partial<EvaluatorWeights>): EvaluatorWeights {
    ACTIVE_WEIGHTS = normalizeWeights({ ...ACTIVE_WEIGHTS, ...next } as EvaluatorWeights);
    return ACTIVE_WEIGHTS;
}

export function getActiveEvaluatorWeights(): EvaluatorWeights {
    return ACTIVE_WEIGHTS;
}

export function loadEvaluatorWeightsFromFile(filePath: string): EvaluatorWeights | null {
    try {
        const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
        if (!fs.existsSync(abs)) return null;
        const raw = fs.readFileSync(abs, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
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
    static evaluateState(game: ServerGameState, playerId: string): number {
        const player = game.players[playerId];
        if (!player) return -9999;

        const w = ACTIVE_WEIGHTS;

        let score = 0;
        const round = game.roundNumber;
        const totalRounds = 6;
        const remainingRounds = Math.max(0, totalRounds - round + 1);

        // 1) VP
        const vpWeight = round >= 5 ? w.vpWeightLate : w.vpWeightEarly;
        score += (player.score || 0) * vpWeight;

        // 2) Resources
        const resourceMultiplier = round <= 2 ? w.resourceMultiplierEarly : w.resourceMultiplierLate;
        score += (player.ore || 0) * w.oreValue * resourceMultiplier;
        score += (player.credits || 0) * w.creditsValue * resourceMultiplier;
        score += (player.knowledge || 0) * w.knowledgeValue * resourceMultiplier;

        const qicWeight = round >= 4 ? w.qicWeightLate : w.qicWeightEarly;
        score += (player.qic || 0) * qicWeight;

        // 3) Power bowls
        score += (player.power1 || 0) * w.power1Value;
        score += (player.power2 || 0) * w.power2Value;
        score += (player.power3 || 0) * w.power3Value;
        if (player.brainStoneBowl === 1) score += w.brainStoneBowl1;
        if (player.brainStoneBowl === 2) score += w.brainStoneBowl2;
        if (player.brainStoneBowl === 3) score += w.brainStoneBowl3;

        // 4) Structures
        const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);
        for (const tile of myStructures) {
            let baseVal = 0;
            if (tile.structure === 'mine' || tile.structure === 'lost_planet_mine') baseVal = w.structureMine;
            else if (tile.structure === 'trading_station') baseVal = w.structureTradingStation;
            else if (tile.structure === 'research_lab') baseVal = w.structureResearchLab;
            else if (tile.structure === 'planetary_institute') baseVal = w.structurePlanetaryInstitute;
            else if (tile.structure === 'academy') baseVal = w.structureAcademy;

            score += baseVal + (baseVal * w.structureRemainingRoundsFactor * remainingRounds);
        }

        // 5) Research
        const rw: Record<string, number> = {
            terraforming: w.researchTerraforming,
            navigation: w.researchNavigation,
            artificialIntelligence: w.researchArtificialIntelligence,
            gaiaProject: w.researchGaiaProject,
            economy: w.researchEconomy,
            science: w.researchScience,
        };
        for (const [track, level] of Object.entries(player.research || {})) {
            const weight = rw[track] ?? 10;
            score += (level as number) * weight * (1 + remainingRounds * w.researchRemainingRoundsFactor);
            if (level === 5) score += w.researchLevel5Bonus;
        }

        // 6) Federations
        const feds = getFederationEntries(player);
        score += feds.length * w.federationValueEach;

        // 7) Gaiaformers
        if (player.gaiaformers && player.gaiaformers > 0) {
            score += player.gaiaformers * w.gaiaformerValueEach;
        }

        return score;
    }
}
