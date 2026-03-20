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
        const all = this.getFederationActions(game, playerId, extraTokens, 1);
        return all.length ? all[0] : null;
    }

    /**
     * 연방 후보 여러 개 반환 (상위 limit개).
     * - 봇이 "1개만 연방"에 고착되는 문제를 줄이기 위해, 좋은 대안 연방도 후보로 제공.
     */
    static getFederationActions(
        game: ServerGameState,
        playerId: string,
        extraTokens = 0,
        limit = 3
    ): { selectedHexIds: string[], selectedPlanetIds: string[], rewardId: string, spentTokens: number }[] {
        const player = game.players[playerId];
        if (!player) return [];

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

        if (myStructures.length === 0) return [];

        // Check if total power is enough
        const allMyPlanetIds = new Set(myStructures.map(t => t.id));
        if (getFederationBuildingPower(game, playerId, allMyPlanetIds) < requiredPower) {
            return []; // Can't form even if we connect ALL buildings
        }

        // Greedy search from each building, then pick the best considering satellite cost.
        const round = (game as any).roundNumber ?? 1;

        const results: { selectedHexIds: string[], selectedPlanetIds: string[], rewardId: string, spentTokens: number, score: number }[] = [];

        for (const startTile of myStructures) {
            const result = this.tryFormFederationFrom(game, playerId, startTile, requiredPower, availableTokens);
            if (!result) continue;

            const rewardScore = this.getRewardScore(game, playerId, result.rewardId);

            // 위성(소모 파워 토큰) 절약을 유도하되,
            // hard-cut(일정 개수 초과 시 후보 자체 제거) 때문에 2번째/그 이후 연방 후보가 사라지는 문제가 있어
            // score 페널티로만 제어하도록 변경합니다.
            const isShipReward = result.rewardId.startsWith('ship-fed-') && result.rewardId !== 'ship-fed-mine-free'; // 무한 거리 광산은 쓰레기
            const greenNeeded = this.needsGreenFederation(game, playerId);

            // 기본 페널티: 위성을 쓸수록 불리하도록
            let satellitePenalty = 15;
            // 예외 상황(우주선 연방/초록 연방 급함/후반)은 위성 사용 비용을 낮춰 후보가 살아남게 함
            if (isShipReward || greenNeeded || round >= 5) satellitePenalty = 8;

            const score = rewardScore - result.spentTokens * satellitePenalty;
            results.push({ ...result, score });
        }

        if (results.length === 0) return [];
        // 중복(같은 선택 셋) 제거 후 상위 limit개
        const seen = new Set<string>();
        const unique = results.filter(r => {
            const key = `${r.rewardId}|${[...r.selectedPlanetIds].sort().join(',')}|${[...r.selectedHexIds].sort().join(',')}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        unique.sort((a, b) => b.score - a.score);
        return unique.slice(0, Math.max(1, limit)).map(({ score: _s, ...rest }) => rest);
    }

    private static needsGreenFederation(game: ServerGameState, playerId: string): boolean {
        const player = game.players[playerId];
        if (!player) return false;

        // 1. 현재 기술 트랙 중 4단계인 것이 있는지 확인
        const tracks = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
        const hasLevel4 = tracks.some(t => (player.research?.[t as keyof typeof player.research] ?? 0) === 4);

        if (hasLevel4) {
            // 현재 초록 연방 토큰이 없는지 확인
            const fedEntries = player.federations || [];
            const greenCount = fedEntries.filter(f => typeof f !== 'string' && f.isGreen).length;
            if (greenCount === 0) return true;
        }

        return false;
    }

    private static getRewardScore(game: ServerGameState, playerId: string, rewardId: string): number {
        let score = 0;

        // 우선순위 1: 우주선 연방 (무한 거리 광산 제외)
        if (rewardId.startsWith('ship-fed-') && rewardId !== 'ship-fed-mine-free') {
            return 300;
        }

        const greenNeeded = this.needsGreenFederation(game, playerId);

        // 우선순위 2: 자원 연방 (7VP 2Ore, 7VP 6C 등)
        if (rewardId === 'fed-7vp-2o' || rewardId === 'fed-7vp-6c') {
            score = 250;
        }
        // 우선순위 3: 8VP 1QIC
        else if (rewardId === 'fed-8vp-1q') {
            score = 200;
        }
        // 우선순위 4: 6VP 2K 또는 8VP 2Tokens (5단계/고급기술 필요할 때)
        else if (rewardId === 'fed-6vp-2k' || rewardId === 'fed-8vp-2t') {
            if (greenNeeded) {
                score = 180;
            } else {
                score = 100; // 급하지 않으면 후순위
            }
        }
        // 그 외 (예: 12VP)
        else if (rewardId === 'fed-12vp') {
            // 12VP는 초록 토큰이 아니므로, 5단계 진입이 급할 때는 피해야 함
            if (greenNeeded) {
                score = 50;
            } else {
                score = 150; // 다른 자원 연방이 다 떨어졌을 때 선택
            }
        }

        return score;
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
        const isIvits = player?.faction === 'ivits';

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
                // Ivits: 우주정거장 타일은 토큰 비용 없이 파워 계산에 포함될 수 있어야 함.
                if (isIvits && n.spaceStation?.ownerId === playerId && !visited.has(n.id)) {
                    queue.push({ currentHexId: n.id, path: [n.id], cost: 0 });
                    visited.add(n.id);
                    return;
                }

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
                        const hidTile = game.map.find(t => t.id === hid);
                        // 우주정거장(공간) 타일은 Ivits 파워로 쓰되, QIC(위성/토큰) 비용에는 포함하지 않음.
                        if (isIvits && hidTile?.spaceStation?.ownerId === playerId) return;

                        // Check if the player already owns a satellite here
                        const onTile = game.satellites?.[hid];
                        const playersOnTile = Array.isArray(onTile) ? onTile : (onTile ? [onTile as string] : []);
                        if (!playersOnTile.includes(playerId)) actualNewSatellites++;
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
                        if (isIvits && n.spaceStation?.ownerId === playerId && !visited.has(n.id)) {
                            queue.push({ currentHexId: n.id, path: [n.id], cost: 0 });
                            visited.add(n.id);
                        } else if (isEmptyHex(n) && !visited.has(n.id)) {
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
                    if (isIvits && n.spaceStation?.ownerId === playerId && !visited.has(n.id)) {
                        // 우주정거장 타일은 비용 없이 확장
                        queue.push({ currentHexId: n.id, path: [...path, n.id], cost: cost });
                        visited.add(n.id);
                    } else if (isEmptyHex(n) && !visited.has(n.id)) {
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
