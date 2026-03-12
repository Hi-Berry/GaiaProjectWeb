import { ServerGameState } from '../gameState';
import {
    HexTile,
    PlayerState,
    getFederationEntries,
    getNeighbors,
    isEmptyHex,
    isPlanetHex,
    FEDERATION_REWARDS
} from '@shared/gameConfig';
import {
    getFederationRequiredPower,
    getFederationBuildingPower,
    getPlanetConnectedComponent,
    getFederationPlanetIdsFromSelectedEmpties
} from '../gameState';

export class FederationPlanner {
    /** extraTokens: 프리 액션으로 얻을 예정인 파워(위성) 수를 가정해 더 좋은 연방(예: 12VP) 탐색 */
    static getBestFederationAction(game: ServerGameState, playerId: string, extraTokens = 0): {
        selectedHexIds: string[],
        selectedPlanetIds: string[],
        rewardId: string,
        spentTokens: number
    } | null {
        const player = game.players[playerId];
        if (!player) return null;

        const requiredPower = getFederationRequiredPower(game, playerId);
        const isIvits = player.faction === 'ivits';
        let availableTokens = isIvits ? (player.qic || 0) : ((player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0));
        availableTokens += extraTokens;

        const fedHexes = game.playerFederationHexes?.[playerId] || [];
        const myStructures = game.map.filter(t =>
            t.ownerId === playerId &&
            t.structure &&
            t.structure !== 'ship' &&
            !fedHexes.includes(t.id)
        );

        if (myStructures.length === 0) return null;

        // Check if total power is enough
        const allMyPlanetIds = new Set(myStructures.map(t => t.id));
        if (getFederationBuildingPower(game, playerId, allMyPlanetIds) < requiredPower) {
            return null; // Can't form even if we connect ALL buildings
        }

        // Simple greedy search: Try to form a federation around each of my buildings
        for (const startTile of myStructures) {
            const result = this.tryFormFederationFrom(game, playerId, startTile, requiredPower, availableTokens);
            if (result) {
                return result;
            }
        }

        return null;
    }

    private static tryFormFederationFrom(
        game: ServerGameState,
        playerId: string,
        startTile: HexTile,
        requiredPower: number,
        maxTokens: number
    ): { selectedHexIds: string[], selectedPlanetIds: string[], rewardId: string, spentTokens: number } | null {
        const selectedHexIds = new Set<string>();
        const selectedPlanetIds = new Set<string>();
        const fedHexes = game.playerFederationHexes?.[playerId] || [];
        const player = game.players[playerId];

        // Always include the starting planet's connected component
        const initialComponent = getPlanetConnectedComponent(game, playerId, startTile.id);
        initialComponent.forEach(id => selectedPlanetIds.add(id));

        let currentPower = getFederationBuildingPower(game, playerId, selectedPlanetIds);
        if (currentPower >= requiredPower) {
            return this.finalizeFederation(game, playerId, [], Array.from(selectedPlanetIds), 0);
        }

        // We need more power. We must add satellites (empty hexes) to connect to other components.
        // BFS to find paths to other components
        const queue: { currentHexId: string, path: string[], cost: number }[] = [];
        const visited = new Set<string>();

        // Initialize queue with neighbors of our current component
        initialComponent.forEach(pid => {
            const tile = game.map.find(t => t.id === pid)!;
            getNeighbors(game.map, tile).forEach(n => {
                if (isEmptyHex(n) && !visited.has(n.id)) {
                    // Wait, check if the empty hex is valid (not occupied by another player's satellite)
                    const onTile = game.satellites?.[n.id];
                    const playersOnTile = Array.isArray(onTile) ? onTile : (onTile ? [onTile as string] : []);
                    if (!playersOnTile.includes(playerId)) {
                        queue.push({ currentHexId: n.id, path: [n.id], cost: 1 });
                        visited.add(n.id);
                    }
                }
            });
        });

        // To simplify, we'll try to add paths one by one until we reach requiredPower.
        // A more robust algorithm would use MST or Steiner Tree, but this is a heuristic.
        let tokensSpent = 0;
        const currentPlanetIds = new Set(selectedPlanetIds);
        const currentHexIds = new Set<string>();

        // Sort queue by cost (BFS already does this implicitly if costs are 1)
        while (queue.length > 0 && currentPower < requiredPower && tokensSpent <= maxTokens) {
            const { currentHexId, path, cost } = queue.shift()!;
            if (tokensSpent + cost > maxTokens) continue;

            const currentTile = game.map.find(t => t.id === currentHexId)!;

            // Does adding this hex connect us to new planets?
            let connectedToNewComponent = false;
            const newPlanetIdsToMerge = new Set<string>();

            getNeighbors(game.map, currentTile).forEach(n => {
                if (isPlanetHex(n) && n.ownerId === playerId && n.structure && n.structure !== 'ship' && !fedHexes.includes(n.id)) {
                    const comp = getPlanetConnectedComponent(game, playerId, n.id);
                    // Check if this component is already included
                    let hasNew = false;
                    comp.forEach(cid => {
                        if (!currentPlanetIds.has(cid)) {
                            hasNew = true;
                            newPlanetIdsToMerge.add(cid);
                        }
                    });
                    if (hasNew) connectedToNewComponent = true;
                }
            });

            if (connectedToNewComponent) {
                // 이 경로의 일부가 이미 currentHexIds에 들어있을 수 있으므로 순수하게 추가된 위성 개수만 계산
                let actualNewSatellites = 0;
                path.forEach(hid => {
                    if (!currentHexIds.has(hid)) {
                        currentHexIds.add(hid);

                        // Check if the player already owns a satellite here
                        const onTile = game.satellites?.[hid];
                        const playersOnTile = Array.isArray(onTile) ? onTile : (onTile ? [onTile as string] : []);
                        if (!playersOnTile.includes(playerId)) {
                            actualNewSatellites++;
                        }
                    }
                });

                newPlanetIdsToMerge.forEach(pid => currentPlanetIds.add(pid));
                tokensSpent += actualNewSatellites;
                currentPower = getFederationBuildingPower(game, playerId, currentPlanetIds, Array.from(currentHexIds));

                if (currentPower >= requiredPower) {
                    return this.finalizeFederation(game, playerId, Array.from(currentHexIds), Array.from(currentPlanetIds), tokensSpent);
                }

                // Since we added new planets, add their empty neighbors to the queue
                // 새로운 컴포넌트를 병합했으므로, 큐를 초기화하여 최단 경로 탐색을 새 건물 기준(현재 연방)으로 재설정 (위성 낭비 방지)
                queue.length = 0;
                visited.clear();

                // 모든 현재 연방에 속한 행성들 및 위성들에서 다시 1거리 빈 공간 탐색
                const currentFedTiles = [
                    ...Array.from(currentPlanetIds).map(id => game.map.find(t => t.id === id)!),
                    ...Array.from(currentHexIds).map(id => game.map.find(t => t.id === id)!)
                ];

                for (const t of currentFedTiles) {
                    visited.add(t.id);
                }

                for (const t of currentFedTiles) {
                    getNeighbors(game.map, t).forEach(n => {
                        if (isEmptyHex(n) && !visited.has(n.id)) {
                            const onTile = game.satellites?.[n.id];
                            const playersOnTile = Array.isArray(onTile) ? onTile : (onTile ? [onTile as string] : []);
                            if (!playersOnTile.includes(playerId)) {
                                queue.push({ currentHexId: n.id, path: [n.id], cost: 1 });
                                visited.add(n.id);
                            }
                        }
                    });
                }
            } else {
                // Expand from this empty hex to other empty hexes
                getNeighbors(game.map, currentTile).forEach(n => {
                    if (isEmptyHex(n) && !visited.has(n.id)) {
                        const onTile = game.satellites?.[n.id];
                        const playersOnTile = Array.isArray(onTile) ? onTile : (onTile ? [onTile as string] : []);
                        if (!playersOnTile.includes(playerId)) {
                            queue.push({ currentHexId: n.id, path: [...path, n.id], cost: cost + 1 });
                            visited.add(n.id);
                        }
                    }
                });
            }

            // Sort queue to keep it BFS (since we might have pushed longer paths)
            queue.sort((a, b) => a.cost - b.cost);
        }

        return null;
    }

    private static finalizeFederation(
        game: ServerGameState,
        playerId: string,
        selectedHexIds: string[],
        selectedPlanetIds: string[],
        spentTokens: number
    ) {
        // Pick a reward ID randomly from available
        const pool = game.federationPool || {};
        const available = FEDERATION_REWARDS.filter(r => pool[r.id] > 0);
        if (available.length === 0) return null; // No tokens left

        // Best reward logic: VP or resources based on round
        // For now, prioritize tech scaling or VP
        let bestReward = available[0].id;
        let maxScore = -1;

        for (const r of available) {
            let score = r.vp;
            const anyR = r as any;
            if (anyR.qic) score += anyR.qic * 5;
            if (anyR.knowledge) score += anyR.knowledge * 3;
            if (anyR.ore) score += anyR.ore * 2;
            if (anyR.credits) score += anyR.credits * 1;
            if (anyR.powerTokens) score += anyR.powerTokens * 1;

            if (score > maxScore) {
                maxScore = score;
                bestReward = r.id;
            }
        }

        return {
            selectedHexIds,
            selectedPlanetIds,
            rewardId: bestReward,
            spentTokens
        };
    }
}
