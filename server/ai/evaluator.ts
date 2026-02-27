import { ServerGameState } from '../gameState';
import { PlayerState, getFederationEntries, FACTIONS } from '@shared/gameConfig';

export class Evaluator {
    /**
     * Evaluates a given game state from the perspective of a specific player.
     * Returns a numerical score. Higher is better.
     * MCTS uses this at the end of a rollout or at depth limit.
     */
    static evaluateState(game: ServerGameState, playerId: string): number {
        const player = game.players[playerId];
        if (!player) return -9999;

        let score = 0;
        const round = game.roundNumber;
        const totalRounds = 6;
        const remainingRounds = Math.max(0, totalRounds - round + 1);

        // 1. Base VP is important, but infrastructure is key for early rounds
        // In early game, 1 VP is less valuable than 1 Ore. In late game, vice-versa.
        const vpWeight = round >= 5 ? 10 : 5;
        score += (player.score || 0) * vpWeight;

        // 2. 자원 가치 평점 (Liquid resources - 대폭 하향하여 소모를 장려)
        const resourceMultiplier = round <= 2 ? 1.5 : 1.0;
        score += (player.ore || 0) * 0.5 * resourceMultiplier;
        score += (player.credits || 0) * 0.1 * resourceMultiplier;
        score += (player.knowledge || 0) * 0.2 * resourceMultiplier;

        // QIC valuation: Increases in later rounds to reserve for powerful QIC actions
        const qicWeight = round >= 4 ? 3.5 : 1.5;
        score += (player.qic || 0) * qicWeight;

        // Power valuation - 3번 그릇의 파워 가치도 행동 소모를 위해 약간 조정
        score += (player.power1 || 0) * 0.05;
        score += (player.power2 || 0) * 0.2;
        score += (player.power3 || 0) * 0.5;
        if (player.brainStoneBowl === 1) score += 0.2;
        if (player.brainStoneBowl === 2) score += 0.8;
        if (player.brainStoneBowl === 3) score += 1.5;

        // 3. 건물 점수 (Board presence - 가치 상향)
        const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);
        for (const tile of myStructures) {
            let baseVal = 0;
            if (tile.structure === 'mine' || tile.structure === 'lost_planet_mine') baseVal = 15;
            else if (tile.structure === 'trading_station') baseVal = 25;
            else if (tile.structure === 'research_lab') baseVal = 30;
            else if (tile.structure === 'planetary_institute') baseVal = 50;
            else if (tile.structure === 'academy') baseVal = 50;

            // Early structures are much more valuable due to income
            score += baseVal + (baseVal * 0.5 * remainingRounds);
        }

        // 4. 연구 진행도 (Research - 가중치를 높여 자원 소모 유도)
        const researchWeights: Record<string, number> = {
            terraforming: 12, navigation: 12, artificialIntelligence: 15,
            gaiaProject: 10, economy: 20, science: 25
        };
        for (const [track, level] of Object.entries(player.research || {})) {
            const weight = researchWeights[track] || 10;
            score += (level as number) * weight * (1 + remainingRounds * 0.2);
            if (level === 5) score += 80; // Significant bonus for reaching level 5
        }

        // 5. Federations
        const feds = getFederationEntries(player);
        score += feds.length * 25;

        // 6. Gaiaformers
        if (player.gaiaformers && player.gaiaformers > 0) {
            score += player.gaiaformers * 2;
        }

        // 7. Penalty for unspent resources near the end of the game
        if (round >= 6) {
            // End of game: resources are only worth their fractional VP value
            // (Standard: 3 resources = 1 VP)
            // We should have converted them or spent them.
        }

        return score;
    }
}
