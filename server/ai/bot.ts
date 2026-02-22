import { Server as SocketIOServer } from 'socket.io';
import {
    ServerGameState,
    executeBuildMine,
    executeUpgradeStructure,
    executeAdvanceTech,
    executePassRound,
    executeSelectFaction,
    executePlaceStartingMine,
    executeSelectBonus,
    hasNearbyPlayersForDiscount,
    executeUsePowerAction,
    executePlaceIvitsSpaceStation,
    executeUseShipAction,
    executeEndTurn
} from '../gameState';
import { log } from '../index';
import {
    PlayerState,
    HexTile,
    ResearchTrack,
    STRUCTURE_INCOME,
    ALL_BONUS_TILES,
    FACTIONS,
    getDistance,
    getRange,
    getTerraformStepsForFaction,
    getTerraformCost,
    PlanetType,
    Faction,
    BonusTile,
    getFederationEntries
} from '@shared/gameConfig';

type BotAction = {
    type: 'build_mine' | 'upgrade_structure' | 'advance_research' | 'pass_round'
    | 'charge_power' | 'place_starting_mine' | 'select_faction' | 'select_bonus'
    | 'end_turn'
    | 'use_power_action'
    | 'place_ivits_space_station'
    | 'use_ship_action'
    | 'eclipse_build_asteroid_mine';
    params: any;
};

export class BotLogic {
    static async performAction(io: SocketIOServer, game: ServerGameState, action: BotAction, playerId: string): Promise<boolean> {
        switch (action.type) {
            case 'build_mine':
                return executeBuildMine(io, game, playerId, action.params.tileId);
            case 'upgrade_structure':
                return executeUpgradeStructure(io, game, playerId, action.params.tileId, action.params.target);
            case 'advance_research':
                return executeAdvanceTech(io, game, playerId, action.params.trackId);
            case 'pass_round':
                return executePassRound(io, game, playerId, action.params.bonusTileId);
            case 'select_faction':
                return executeSelectFaction(io, game, playerId, action.params.factionId);
            case 'place_starting_mine':
                return executePlaceStartingMine(io, game, playerId, action.params.tileId) === null; // Returns null on success
            case 'select_bonus':
                return executeSelectBonus(io, game, playerId, action.params.bonusTileId);
            case 'use_power_action':
                return executeUsePowerAction(io, game, playerId, action.params.actionId);
            case 'place_ivits_space_station':
                return executePlaceIvitsSpaceStation(io, game, playerId, action.params.tileId);
            case 'use_ship_action':
                return executeUseShipAction(io, game, playerId, action.params.shipTileId, action.params.actionIndex, action.params.targetTileId);
            case 'eclipse_build_asteroid_mine': {
                // Eclipse 6C 소행성 광산: 서버의 eclipse_build_asteroid_mine 소켓 로직 직접 실행
                const player = game.players[playerId];
                const tile = game.map.find(t => t.id === action.params.tileId);
                if (!tile || tile.type !== 'asteroid' || tile.structure !== null) return false;
                const rangeTiles = game.map.filter(t =>
                    (t.ownerId === playerId && t.structure !== null) ||
                    (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
                );
                if (rangeTiles.length === 0) return false;
                let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
                const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
                if (minDist > baseRange) return false;
                tile.structure = 'mine';
                tile.ownerId = playerId;
                game.pendingEclipseAsteroidMine = null;
                game.hasDoneMainAction = true;
                io.to(game.id).emit('game_updated', game);
                return true;
            }
            case 'charge_power':
                return false;
            case 'end_turn':
                return executeEndTurn(io, game, playerId);
            default:
                console.warn(`Unknown bot action type: ${action.type}`);
                return false;
        }
    }

    static getNextMove(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        if (!player) return null;

        if (game.currentPhase === 'lobby') {
            return null;
        }

        if (game.currentPhase === 'factionSelect') {
            if (!player.faction) {
                const availableFactions = FACTIONS.map(f => f.id);
                const taken = Object.values(game.players).map(p => p.faction).filter(f => f);
                const available = availableFactions.filter(f => !taken.includes(f));
                if (available.length > 0) {
                    const faction = available[Math.floor(Math.random() * available.length)];
                    return { type: 'select_faction', params: { factionId: faction } };
                }
            }
            return null;
        }

        if (game.currentPhase === 'startingMines') {
            return this.findStartingMineAction(game, playerId);
        }

        if (game.currentPhase === 'bonusSelection') {
            return this.findBonusTileAction(game, playerId);
        }

        if (game.currentPhase === 'main') {
            // Eclipse 소행성 광산 배치 대기 중
            if (game.pendingEclipseAsteroidMine?.playerId === playerId) {
                return this.findEclipseAsteroidTarget(game, playerId);
            }

            // 이미 메인 액션을 수행했다면 턴 종료
            if (game.hasDoneMainAction) {
                return { type: 'end_turn', params: {} };
            }

            // pendingTerraformSteps가 있으면 바로 광산 건설 시도
            if ((player.pendingTerraformSteps || 0) > 0) {
                const buildWithPending = this.findBuildWithPendingSteps(game, playerId);
                if (buildWithPending) return buildWithPending;
            }

            // Ivits 우주정거장 전략: 광산 후보 행성 인근 빈 공간에 배치
            if (player.faction === 'ivits' && !player.usedIvitsSpaceStationThisRound) {
                const ivitsAction = this.findIvitsSpaceStationAction(game, playerId);
                if (ivitsAction) return ivitsAction;
            }

            const mineCount = game.map.filter(t => (t.ownerId === playerId || t.parasiticMine?.ownerId === playerId) && (t.structure === 'mine' || t.structure === 'planetary_institute' || t.structure === 'academy' || t.structure === 'research_lab' || t.structure === 'trading_station')).length;

            // 파워 수급을 위한 교역소(TS) 할인 업그레이드 확인
            const discountedTS = this.findDiscountedUpgradeAction(game, playerId);
            const buildAction = this.findBuildAction(game, playerId);

            // 내비게이션 연구 우선순위 체크 (QIC 절약)
            if (buildAction?.type === 'build_mine' && (player.knowledge ?? 0) >= 4) {
                const navId: ResearchTrack = 'navigation';
                const currentNav = player.research[navId] || 0;
                if (currentNav < 5) {
                    const needsQIC = this.checkIfActionNeedsQIC(game, playerId, buildAction);
                    if (needsQIC) {
                        // 연구 시 QIC를 아낄 수 있는지 확인
                        const savesQIC = this.willNavResearchSaveQIC(game, playerId, buildAction);
                        if (savesQIC) {
                            return { type: 'advance_research', params: { trackId: navId } };
                        }
                    }
                }
            }

            // 광산이 적을 때는 건설을 기본으로 하되, 할인된 교역소가 있으면 업그레이드 우선
            if (discountedTS) return discountedTS;

            if (mineCount < 3) {
                if (buildAction) return buildAction;
                const upgradeAction = this.findUpgradeAction(game, playerId);
                if (upgradeAction) return upgradeAction;
            } else {
                const upgradeAction = this.findUpgradeAction(game, playerId);
                if (upgradeAction) return upgradeAction;
                if (buildAction) return buildAction;
            }

            if ((player.knowledge ?? 0) >= 4) {
                const track = this.pickResearchTrack(game, player, playerId);
                if (track) return { type: 'advance_research', params: { trackId: track } };
            }

            // Pass with random valid bonus tile
            if (!player.hasPassed) {
                const availableTiles = game.availableBonusTiles;
                if (availableTiles && availableTiles.length > 0) {
                    const randomTile = availableTiles[0];
                    return { type: 'pass_round', params: { bonusTileId: randomTile.id } };
                }
            }
            return null;
        }

        return null;
    }

    private static findUpgradeAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        const ore = player.ore ?? 0;
        const credits = player.credits ?? 0;
        const round = game.roundNumber;
        const isGeoden = player.faction === 'geodens';

        // 1. 연구소(Research Lab) 우선순위 (초반 라운드 기술 타일 확보 중요)
        if (ore >= 3 && credits >= 5) {
            const labCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'research_lab').length;
            if (labCount < 3) {
                // 초반(1-2R)이거나 연구소가 하나도 없을 때 강하게 추진
                if (round <= 2 || labCount === 0) {
                    const ts = game.map.find(t => t.ownerId === playerId && t.structure === 'trading_station');
                    if (ts) return { type: 'upgrade_structure', params: { tileId: ts.id, target: 'research_lab' } };
                }
            }
        }

        // 2. 종족별 특수 건물 (의회 등)
        const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
        if (ore >= 4 && credits >= 6 && !hasPI) {
            let shouldBuildPI = false;

            if (isGeoden) {
                // 기오덴: 실질적으로 확장 가능한 새로운 행성 유형이 2개 이상일 때만 PI 건설
                shouldBuildPI = this.shouldGeodenBuildPI(game, playerId);
            } else if (round >= 3) {
                // 일반 종족: 초반보다는 라운드 중반부터 고려
                shouldBuildPI = true;
            }

            if (shouldBuildPI) {
                const ts = game.map.find(t => t.ownerId === playerId && t.structure === 'trading_station');
                if (ts) return { type: 'upgrade_structure', params: { tileId: ts.id, target: 'planetary_institute' } };
            }
        }

        // 3. 교역소 (Trading Station) - 파워 수급을 위해 할인 여부와 무관하게 크레딧 여유 시 우선 고려
        if (ore >= 2 && credits >= 3) {
            const mines = game.map.filter(t => t.ownerId === playerId && t.structure === 'mine');
            const discountedMine = mines.find(t => hasNearbyPlayersForDiscount(game, t, playerId));
            if (discountedMine) {
                return { type: 'upgrade_structure', params: { tileId: discountedMine.id, target: 'trading_station' } };
            }

            // 크레딧이 어느 정도 있다면 파워서칭을 위해 일반 교역소도 건설
            if (credits >= 6) {
                const anyMine = mines[0];
                if (anyMine) return { type: 'upgrade_structure', params: { tileId: anyMine.id, target: 'trading_station' } };
            }
        }

        // 4. 연구소 (기본 순수 점검)
        if (ore >= 3 && credits >= 5) {
            const labCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'research_lab').length;
            if (labCount < 3) {
                const ts = game.map.find(t => t.ownerId === playerId && t.structure === 'trading_station');
                if (ts) return { type: 'upgrade_structure', params: { tileId: ts.id, target: 'research_lab' } };
            }
        }

        // 5. 아카데미 (Academy)
        const academyCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'academy').length;
        if (ore >= 6 && credits >= 6 && academyCount < 2) {
            const ts = game.map.find(t => t.ownerId === playerId && t.structure === 'trading_station');
            if (ts) return { type: 'upgrade_structure', params: { tileId: ts.id, target: 'academy_right' } };
        }

        return null;
    }

    private static findDiscountedUpgradeAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        const ore = player.ore ?? 0;
        const credits = player.credits ?? 0;

        if (ore >= 2 && credits >= 3) {
            const mines = game.map.filter(t => t.ownerId === playerId && t.structure === 'mine');
            const discountedMine = mines.find(t => hasNearbyPlayersForDiscount(game, t, playerId));
            if (discountedMine) {
                return { type: 'upgrade_structure', params: { tileId: discountedMine.id, target: 'trading_station' } };
            }
        }
        return null;
    }

    private static checkIfActionNeedsQIC(game: ServerGameState, playerId: string, action: BotAction): boolean {
        if (action.type !== 'build_mine') return false;
        const player = game.players[playerId];
        const tile = game.map.find(t => t.id === action.params.tileId);
        if (!tile) return false;

        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        const range = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
        const dist = Math.min(...myPlanets.map(p => getDistance(p, tile)));
        const neededQicForRange = Math.max(0, Math.ceil((dist - range) / 2));

        if (tile.type === 'gaia' && player.faction !== 'gleens') {
            return (neededQicForRange + 1) > 0;
        }
        return neededQicForRange > 0;
    }

    private static willNavResearchSaveQIC(game: ServerGameState, playerId: string, action: BotAction): boolean {
        const player = JSON.parse(JSON.stringify(game.players[playerId]));
        player.research.navigation = (player.research.navigation || 0) + 1;
        const tile = game.map.find(t => t.id === action.params.tileId);
        if (!tile) return false;

        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        const oldRange = getRange(game.players[playerId].research.navigation || 0) + (game.players[playerId].navigationBonus || 0);
        const newRange = getRange(player.research.navigation) + (player.navigationBonus || 0);
        if (newRange <= oldRange) return false; // 레벨업으로 거리가 안 늘어나는 구간이면 무의미

        const dist = Math.min(...myPlanets.map(p => getDistance(p, tile)));
        const oldQic = Math.max(0, Math.ceil((dist - oldRange) / 2));
        const newQic = Math.max(0, Math.ceil((dist - newRange) / 2));

        return newQic < oldQic;
    }

    /**
     * 기오덴이 의회를 지어야 하는지 실질적 확장 가능성을 토대로 판단
     */
    private static shouldGeodenBuildPI(game: ServerGameState, playerId: string): boolean {
        const player = game.players[playerId];
        const currentPlanetTypes = new Set(
            game.map.filter(t => t.ownerId === playerId && t.type && t.type !== 'space' && t.type !== 'deep_space').map(t => t.type)
        );

        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        const range = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
        const power3 = player.power3 ?? 0;
        const qic = player.qic ?? 0;

        const potentialNewTypes = new Set<string>();

        // 주변 행성 중 새로운 유형 탐색
        const candidates = game.map.filter(t =>
            !t.ownerId && t.structure === null &&
            t.type !== 'space' && t.type !== 'deep_space' && t.type !== 'transdim' &&
            !t.type?.startsWith('ship_')
        );

        for (const tile of candidates) {
            if (currentPlanetTypes.has(tile.type!)) continue;

            const dist = Math.min(...myPlanets.map(p => getDistance(p, tile)));
            const neededQic = Math.max(0, Math.ceil((dist - range) / 2));
            if (neededQic > 1 || neededQic > qic) continue;

            // 실질적 확장 가능 조건 체크
            let canExpand = false;
            if (tile.type === 'asteroid') {
                // 소행성: 가이아포머가 있거나 Eclipse 우주선 액션 가능 여부 (여기서는 단순 소행성 존재 여부만 체크해도 됨)
                canExpand = true;
            } else if (tile.type === 'gaia') {
                canExpand = true;
            } else {
                const steps = getTerraformStepsForFaction(game, player.faction!, tile.type!);
                // 0~1단계만 필요한 행성만 고려 (3단계는 제외)
                if (steps <= 1) {
                    canExpand = true;
                } else if (steps === 2 && power3 >= 5) {
                    // 2단계이지만 5파워 2삽 액션이 가용한 경우
                    const stepAction = game.powerActions.find(a => a.id === 'gain-2-steps' && !a.isUsed);
                    if (stepAction) canExpand = true;
                }
            }

            if (canExpand) {
                potentialNewTypes.add(tile.type!);
            }
        }

        return potentialNewTypes.size >= 2;
    }

    /**
     * 광산 건설 전략 (스코어링 시스템)
     * 우선순위: 모행성 > 가이아 > 파워/TF Mars 콤보 > 테라포밍
     * QIC 소모는 최대 1로 제한
     */
    private static findBuildAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        const ore = player.ore ?? 0;
        const credits = player.credits ?? 0;
        const qic = player.qic ?? 0;
        const power3 = player.power3 ?? 0;

        if (ore < 1 || credits < 2) {
            // Ore/Credit 부족 시에도 Eclipse 6C 소행성이나 파워 콤보 가능한지 확인
            return this.findAlternativeBuildAction(game, playerId);
        }

        if (!player.faction) return null;
        const faction = FACTIONS.find(f => f.id === player.faction);
        if (!faction?.homePlanet) return null;
        const homeType = faction.homePlanet;

        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        if (myPlanets.length === 0) return null;

        const range = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
        const tfLevel = player.research.terraforming ?? 0;
        const pendingSteps = player.pendingTerraformSteps || 0;

        // 모든 잠재적 광산 후보 평가
        const candidates = game.map.filter(t =>
            !t.ownerId &&
            t.structure === null &&
            t.type !== 'space' &&
            t.type !== 'deep_space' &&
            t.type !== 'transdim' &&
            t.type !== 'asteroid' && // 소행성은 별도 처리
            !t.type?.startsWith('ship_')
        );

        interface ScoredCandidate {
            tile: HexTile;
            score: number;
            action: BotAction;
            preAction?: BotAction; // 파워 액션/TF Mars 등 선행 액션
        }

        const scored: ScoredCandidate[] = [];

        for (const tile of candidates) {
            const dist = Math.min(...myPlanets.map(p => getDistance(p, tile)));
            const neededQicForRange = Math.max(0, Math.ceil((dist - range) / 2));

            // QIC 소모 최대 1 제한
            if (neededQicForRange > 1) continue;
            if (neededQicForRange > qic) continue;

            if (tile.type === 'gaia') {
                // 가이아 행성: 1 QIC 추가 (Gleens: 1 Ore 추가)
                const isGleens = player.faction === 'gleens';
                const totalQicNeeded = isGleens ? neededQicForRange : neededQicForRange + 1;
                if (isGleens) {
                    if (ore < 2 || credits < 2) continue; // 1O(mine) + 1O(gaia cost)
                    if (totalQicNeeded > qic) continue;
                } else {
                    if (totalQicNeeded > qic) continue;
                    if (totalQicNeeded > 1) continue; // 가이아 1QIC + 거리 QIC = 2 이상이면 비효율
                }

                scored.push({
                    tile,
                    score: (neededQicForRange === 0 ? 90 : 75) - neededQicForRange * 25,
                    action: { type: 'build_mine', params: { tileId: tile.id } }
                });
                continue;
            }

            // 모행성 (테라포밍 불필요)
            if (tile.type === homeType) {
                scored.push({
                    tile,
                    score: (neededQicForRange === 0 ? 100 : 80) - neededQicForRange * 25,
                    action: { type: 'build_mine', params: { tileId: tile.id } }
                });
                continue;
            }

            // 타종 행성 (테라포밍 필요)
            const steps = getTerraformStepsForFaction(game, player.faction!, tile.type);
            if (steps <= 0) continue;

            // pendingTerraformSteps로 커버 가능한 경우
            const coveredByPending = Math.min(pendingSteps, steps);
            const remainingSteps = steps - coveredByPending;

            if (remainingSteps === 0) {
                // 이미 pendingSteps로 완전 커버 → 무료 테라포밍
                scored.push({
                    tile,
                    score: 85 - neededQicForRange * 25,
                    action: { type: 'build_mine', params: { tileId: tile.id } }
                });
                continue;
            }

            // 파워 액션 콤보: 3P→1삽 (gain-1-step, cost 3P)
            if (remainingSteps === 1 && power3 >= 3) {
                const stepAction = game.powerActions.find(a => a.id === 'gain-1-step' && !a.isUsed);
                if (stepAction) {
                    scored.push({
                        tile,
                        score: 70 - neededQicForRange * 25,
                        preAction: { type: 'use_power_action', params: { actionId: 'gain-1-step' } },
                        action: { type: 'build_mine', params: { tileId: tile.id } }
                    });
                    continue;
                }
            }

            // 파워 액션 콤보: 5P→2삽 (gain-2-steps, cost 5P)
            if (remainingSteps <= 2 && power3 >= 5) {
                const stepAction = game.powerActions.find(a => a.id === 'gain-2-steps' && !a.isUsed);
                if (stepAction) {
                    scored.push({
                        tile,
                        score: 60 - neededQicForRange * 25,
                        preAction: { type: 'use_power_action', params: { actionId: 'gain-2-steps' } },
                        action: { type: 'build_mine', params: { tileId: tile.id } }
                    });
                    continue;
                }
            }

            // TF Mars 우주선 3번 액션: 3C→1삽 (free action)
            if (remainingSteps === 1 && credits >= (2 + 3)) { // 2C(mine) + 3C(TF Mars)
                const tfMarsShip = this.findPlayerShip(game, playerId, 'ship_tf_mars');
                if (tfMarsShip) {
                    const shipState = game.spaceships?.[tfMarsShip.id];
                    const usedActions = shipState?.usedActionIndices ?? [];
                    if (!usedActions.includes(3)) {
                        scored.push({
                            tile,
                            score: 65 - neededQicForRange * 25,
                            preAction: { type: 'use_ship_action', params: { shipTileId: tfMarsShip.id, actionIndex: 3 } },
                            action: { type: 'build_mine', params: { tileId: tile.id } }
                        });
                        continue;
                    }
                }
            }

            // Ore로 직접 테라포밍 (TF 레벨 1+ 필요, 비효율적이므로 낮은 점수)
            if (tfLevel >= 1) {
                const costPerStep = getTerraformCost(tfLevel);
                const terraformCost = remainingSteps * costPerStep;
                const totalOre = 1 + terraformCost;

                if (ore >= totalOre && credits >= 2) {
                    // TF 레벨 3(1삽=1O)이면 점수 높게, TF 레벨 1(1삽=2O)이면 낮게
                    const tfScore = tfLevel >= 3 ? 55 : (tfLevel >= 2 ? 40 : 30);
                    scored.push({
                        tile,
                        score: (tfScore - remainingSteps * 5) - neededQicForRange * 25, // 삽 수가 많을수록 감점
                        action: { type: 'build_mine', params: { tileId: tile.id } }
                    });
                }
            }
        }

        // 최고 점수 후보 선택
        if (scored.length === 0) {
            return this.findAlternativeBuildAction(game, playerId);
        }

        scored.sort((a, b) => b.score - a.score);
        const best = scored[0];

        // 선행 액션이 필요하면 먼저 반환 (봇이 다시 호출하면 build_mine을 수행)
        if (best.preAction) {
            return best.preAction;
        }

        return best.action;
    }

    /**
     * 대체 건설 전략: Eclipse 6C 소행성 등
     */
    private static findAlternativeBuildAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        const credits = player.credits ?? 0;

        // Eclipse 6C 소행성 광산
        if (credits >= 6) {
            const eclipseShip = this.findPlayerShip(game, playerId, 'ship_eclipse');
            if (eclipseShip) {
                const shipState = game.spaceships?.[eclipseShip.id];
                const usedActions = shipState?.usedActionIndices ?? [];
                if (!usedActions.includes(3)) {
                    // 범위 내 빈 소행성이 있는지 확인
                    const myPlanets = game.map.filter(t =>
                        (t.ownerId === playerId && t.structure) ||
                        (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
                    );
                    const range = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
                    const asteroid = game.map.find(t =>
                        t.type === 'asteroid' && !t.ownerId && t.structure === null &&
                        Math.min(...myPlanets.map(p => getDistance(p, t))) <= range
                    );
                    if (asteroid) {
                        return { type: 'use_ship_action', params: { shipTileId: eclipseShip.id, actionIndex: 3 } };
                    }
                }
            }
        }

        return null;
    }

    /**
     * pendingTerraformSteps가 있을 때 광산 건설할 최적 타일 찾기
     */
    private static findBuildWithPendingSteps(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        if ((player.ore ?? 0) < 1 || (player.credits ?? 0) < 2) return null;
        if (!player.faction) return null;

        const faction = FACTIONS.find(f => f.id === player.faction);
        if (!faction?.homePlanet) return null;
        const homeType = faction.homePlanet;

        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        if (myPlanets.length === 0) return null;

        const range = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
        const pendingSteps = player.pendingTerraformSteps || 0;

        // pendingSteps로 커버 가능한 행성 중 최적 선택
        const candidates = game.map.filter(t =>
            !t.ownerId && t.structure === null &&
            t.type !== 'space' && t.type !== 'deep_space' &&
            t.type !== 'transdim' && t.type !== 'asteroid' &&
            !t.type?.startsWith('ship_')
        );

        let bestTile: HexTile | null = null;
        let bestScore = -1;

        for (const tile of candidates) {
            const dist = Math.min(...myPlanets.map(p => getDistance(p, tile)));
            const neededQic = Math.max(0, Math.ceil((dist - range) / 2));
            if (neededQic > 1 || neededQic > (player.qic ?? 0)) continue;

            let steps = 0;
            if (tile.type === homeType) {
                steps = 0;
            } else if (tile.type === 'gaia') {
                // 가이아는 pendingSteps와 무관
                continue;
            } else {
                steps = getTerraformStepsForFaction(game, player.faction!, tile.type);
            }

            if (steps <= pendingSteps) {
                const score = steps === 0 ? 100 : (100 - steps * 10);
                if (score > bestScore) {
                    bestScore = score;
                    bestTile = tile;
                }
            }
        }

        if (bestTile) {
            return { type: 'build_mine', params: { tileId: bestTile.id } };
        }
        return null;
    }

    /**
     * Eclipse 소행성 광산 타겟 선택 (pendingEclipseAsteroidMine 상태에서)
     */
    private static findEclipseAsteroidTarget(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        const range = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);

        const asteroid = game.map.find(t =>
            t.type === 'asteroid' && !t.ownerId && t.structure === null &&
            Math.min(...myPlanets.map(p => getDistance(p, t))) <= range
        );

        if (asteroid) {
            return { type: 'eclipse_build_asteroid_mine', params: { tileId: asteroid.id } };
        }
        return null;
    }

    /**
     * Ivits 우주정거장 전략:
     * 건설 가능한 행성 후보 중 거리 밖이지만, 빈 공간에 우주정거장을 배치하면
     * 거리 1 이내로 오는 행성이 있으면 우주정거장 배치
     */
    private static findIvitsSpaceStationAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        if ((player.ore ?? 0) < 1 || (player.credits ?? 0) < 2) return null;

        const faction = FACTIONS.find(f => f.id === player.faction);
        if (!faction?.homePlanet) return null;
        const homeType = faction.homePlanet;

        // 현재 건물/우주정거장
        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        if (myPlanets.length === 0) return null;

        const range = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);

        // 거리 밖의 행성 후보 (모행성 또는 가이아)
        const targetPlanets = game.map.filter(t =>
            !t.ownerId && t.structure === null &&
            (t.type === homeType || t.type === 'gaia') &&
            Math.min(...myPlanets.map(p => getDistance(p, t))) > range
        );

        // 빈 공간 (우주정거장 배치 가능)
        const emptySpaces = game.map.filter(t =>
            (t.type === 'space' || t.type === 'deep_space') &&
            t.structure === null && !t.spaceStation
        );

        for (const target of targetPlanets) {
            for (const space of emptySpaces) {
                // 이 빈 공간에서 타겟까지 거리 1 이내인지
                const distToTarget = getDistance(space, target);
                if (distToTarget > 1) continue;

                // 현재 건물에서 이 빈 공간까지 Nav 범위 내인지
                const distToSpace = Math.min(...myPlanets.map(p => getDistance(p, space)));
                const neededQic = distToSpace > range ? Math.ceil((distToSpace - range) / 2) : 0;
                if (neededQic > (player.qic ?? 0)) continue;
                if (neededQic > 1) continue; // QIC 1 이상 제한

                return { type: 'place_ivits_space_station', params: { tileId: space.id } };
            }
        }

        return null;
    }

    /**
     * 플레이어가 탑승한 특정 타입의 우주선 찾기
     */
    private static findPlayerShip(game: ServerGameState, playerId: string, shipType: string): HexTile | null {
        if (!game.spaceships) return null;
        for (const [tileId, state] of Object.entries(game.spaceships)) {
            if (state.occupants.includes(playerId)) {
                const tile = game.map.find(t => t.id === tileId);
                if (tile && tile.type === shipType) return tile;
            }
        }
        return null;
    }

    /**
     * 연구 트랙 선택 (라운드/종족에 따른 우선순위)
     * - 라운드 3~4부터 테라포밍 3단계 이상 올리기 전략
     * - 기오덴은 TF 시작 1이므로 더 빨리
     */
    private static pickResearchTrack(game: ServerGameState, player: PlayerState, playerId: string): ResearchTrack | null {
        const feds = getFederationEntries(player);
        const hasGreenFed = feds.some(f => f.isGreen);
        const round = game.roundNumber;
        const tfLevel = player.research.terraforming ?? 0;
        const isGeoden = player.faction === 'geodens';

        // 라운드별 우선순위 동적 결정
        let priorities: ResearchTrack[];

        if (round >= 3 && tfLevel < 3) {
            // 라운드 3+ 에서 TF 3단계 미만이면 TF 우선 (기오덴은 라운드 2부터)
            priorities = ['terraforming', 'economy', 'artificialIntelligence', 'science', 'navigation', 'gaiaProject'];
        } else if (isGeoden && round >= 2 && tfLevel < 3) {
            // 기오덴: 라운드 2부터 TF 우선
            priorities = ['terraforming', 'economy', 'artificialIntelligence', 'science', 'navigation', 'gaiaProject'];
        } else {
            // 기본 우선순위
            priorities = ['economy', 'terraforming', 'artificialIntelligence', 'science', 'navigation', 'gaiaProject'];
        }

        for (const track of priorities) {
            const level = player.research[track] ?? 0;
            if (level >= 5) continue;
            if (level === 4 && !hasGreenFed) continue;

            return track;
        }
        return null;
    }

    private static findStartingMineAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        if (!player || !player.faction) return null;
        const faction = FACTIONS.find(f => f.id === player.faction);
        if (!faction) return null;
        const homePlanet = faction.homePlanet;

        const freeTiles = game.map.filter(t => !t.ownerId && t.structure === null && t.type === homePlanet);
        log(`BotLogic DEBUG: playerId=${playerId}, homePlanet=${homePlanet}, freeTiles.length=${freeTiles.length}`, 'game');
        if (freeTiles.length === 0) {
            log(`BotLogic DEBUG: NO TILES FOUND! Map example tiles: ${game.map.slice(0, 5).map(t => t.type).join(', ')}`, 'game');
            return null;
        }

        let bestTile = freeTiles[0];
        let bestScore = -1000;

        for (const tile of freeTiles) {
            let score = 0;

            const others = game.map.filter(t => t.ownerId && t.ownerId !== playerId && t.structure);
            for (const other of others) {
                const dist = getDistance(tile, other);
                if (dist <= 2) score += 5;
            }

            const nearbyPlanets = game.map.filter(t => t.id !== tile.id && !t.ownerId && t.type !== 'space' && t.type !== 'deep_space');
            for (const p of nearbyPlanets) {
                const dist = getDistance(tile, p);
                if (dist <= 2) score += 2;
                else if (dist <= 3) score += 1;
            }

            if (score > bestScore) {
                bestScore = score;
                bestTile = tile;
            }
        }

        return { type: 'place_starting_mine', params: { tileId: bestTile.id } };
    }

    private static findBonusTileAction(game: ServerGameState, playerId: string): BotAction | null {
        if (!game.availableBonusTiles || game.availableBonusTiles.length === 0) return null;

        const player = game.players[playerId];
        const round = game.roundNumber;

        let bestTile = game.availableBonusTiles[0];
        let bestScore = -Infinity;

        for (const tile of game.availableBonusTiles) {
            const score = this.calculateBonusTileScore(game, player, tile, round, playerId);
            if (score > bestScore) {
                bestScore = score;
                bestTile = tile;
            }
        }

        return { type: 'select_bonus', params: { bonusTileId: bestTile.id } };
    }

    private static calculateBonusTileScore(game: ServerGameState, player: PlayerState, tile: BonusTile, round: number, playerId: string): number {
        let score = 0;

        let resourceValue = 0;
        if (tile.income) {
            resourceValue += (tile.income.ore || 0) * 3;
            resourceValue += (tile.income.knowledge || 0) * 3;
            resourceValue += (tile.income.qic || 0) * 4;
            resourceValue += (tile.income.credits || 0) * 1;
            resourceValue += (tile.income.power || 0) * 1;
            resourceValue += (tile.income.powerTokens || 0) * 1;
        }
        if (tile.specialAction) {
            if (tile.specialAction === 'range_3') resourceValue += 3;
            if (tile.specialAction === 'terraform_step') resourceValue += 3;
            if (tile.specialAction === 'gaia_project') resourceValue += 2;
        }

        let passBonusValue = 0;
        if (tile.passBonus) {
            let count = 0;
            const myTiles = game.map.filter(t => t.ownerId === playerId || t.parasiticMine?.ownerId === playerId);

            switch (tile.passBonus.type) {
                case 'mine':
                    count = myTiles.filter(t => t.structure === 'mine').length;
                    break;
                case 'trading_station':
                    count = myTiles.filter(t => t.structure === 'trading_station').length;
                    break;
                case 'research_lab':
                    count = myTiles.filter(t => t.structure === 'research_lab').length;
                    break;
                case 'big_building':
                    count = myTiles.filter(t => t.structure === 'planetary_institute' || t.structure === 'academy').length;
                    break;
                case 'gaia':
                    count = myTiles.filter(t => t.type === 'gaia').length;
                    break;
                case 'planet_type':
                    const types = new Set(myTiles.filter(t => t.type && t.type !== 'space' && t.type !== 'deep_space').map(t => t.type));
                    count = types.size;
                    break;
                case 'bridge_sector':
                    const sectors = new Set(myTiles.filter(t => t.sector > 10).map(t => t.sector));
                    count = sectors.size;
                    break;
                case 'gaiaformer':
                    count = player.gaiaformers || 0;
                    break;
            }
            passBonusValue = count * tile.passBonus.vp;
        }

        if (round <= 3) {
            score = (resourceValue * 2.0) + (passBonusValue * 0.5);
        } else {
            score = (resourceValue * 0.5) + (passBonusValue * 2.0);
        }

        score += Math.random() * 0.1;

        return score;
    }
}
