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
    executeEndTurn,
    executeSelectTechTile,
    executeBotFederation,
    executeBurnPower,
    executeConvertResource,
    getAcademyLeftCount,
    getAcademyRightCount,
    executeEnterSpaceship
} from '../gameState';
import { FederationPlanner } from './federationPlanner';
import { log } from '../index';
import { MCTS } from './mcts';
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
    getFederationEntries,
    TechTile,
    SHIP_TECH_TILES,
    isPlanetHex
} from '@shared/gameConfig';

type BotAction = {
    type: 'build_mine' | 'upgrade_structure' | 'advance_research' | 'pass_round'
    | 'charge_power' | 'place_starting_mine' | 'select_faction' | 'select_bonus'
    | 'end_turn'
    | 'use_power_action'
    | 'place_ivits_space_station'
    | 'use_ship_action'
    | 'eclipse_build_asteroid_mine'
    | 'select_tech_tile'
    | 'advance_tech'
    | 'form_federation'
    | 'burn_power'
    | 'convert_resource'
    | 'enter_spaceship';
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
            case 'enter_spaceship':
                return executeEnterSpaceship(io, game, playerId, action.params.tileId, action.params.useRangeBonus, action.params.qicToUse) === null;
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
            case 'convert_resource':
                return executeConvertResource(io, game, playerId, action.params.type, action.params.useBrain);
            case 'charge_power':
                return false;
            case 'end_turn':
                return executeEndTurn(io, game, playerId);
            case 'select_tech_tile':
                executeSelectTechTile(io, game, playerId, action.params.techTileId, action.params.trackId);
                return true;
            case 'advance_tech':
                return executeAdvanceTech(io, game, playerId, action.params.trackId);
            case 'form_federation':
                return executeBotFederation(io, game, playerId, action.params.selectedHexIds, action.params.selectedPlanetIds, action.params.rewardId, action.params.spentTokens);
            case 'burn_power':
                executeBurnPower(game, playerId, action.params.moveBrainToBowl3);
                return true;
            default:
                console.warn(`Unknown bot action type: ${action.type}`);
                return false;
        }
    }

    static async getNextMove(game: ServerGameState, playerId: string, isSimulate = false): Promise<BotAction | null> {
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

            // 기술 타일 선택 대기 중
            if (game.pendingTechTileSelection?.playerId === playerId) {
                return this.findTechTileAction(game, playerId);
            }

            // 우주선 기술(2TF+Mine) 광산 건설 대기 중
            if (game.pendingShipTechMine?.playerId === playerId) {
                return this.findBuildWithPendingSteps(game, playerId);
            }

            // 이미 메인 액션을 수행했다면 턴 종료
            if (game.hasDoneMainAction) {
                return { type: 'end_turn', params: {} };
            }

            // MCTS 켜기 (후보군 탐색)
            const candidates = this.getCandidateMoves(game, playerId);
            if (candidates.length === 1) return candidates[0];
            if (candidates.length > 1) {
                if (isSimulate) {
                    return candidates[0];
                }
                log(`Bot ${player.name} starting MCTS with ${candidates.length} candidates...`, 'game', game.id);
                const bestAction = await MCTS.search(game, playerId, candidates);

                // 패스하기 직전 자원 변환 (Cleanup logic)
                if (bestAction?.type === 'pass_round') {
                    const cleanup = this.findCleanupConvertAction(game, playerId);
                    if (cleanup) {
                        log(`Bot ${player.name} performs cleanup convert before passing: ${cleanup.params.type}`, 'game', game.id);
                        return cleanup;
                    }
                }

                if (bestAction) return bestAction;
            }
            return null;
        }

        return null;
    }

    /** 패스하기 직전에 다음 라운드 수입으로 인해 버려지는 파워가 생기지 않도록 미리 변환 시도 */
    private static findCleanupConvertAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        if (!player) return null;

        const maxTotalPower = (player.power1 ?? 0) + (player.power2 ?? 0) + (player.power3 ?? 0);
        const { powerIncome, tokenIncome } = this.calculateExpectedPowerIncome(game, playerId);

        // 현재 파워 상태와 다음 라운드 수입을 합산하여 예측
        let p1 = (player.power1 ?? 0) + tokenIncome;
        let p2 = player.power2 ?? 0;
        let p3 = player.power3 ?? 0;

        // 수입 단계의 파워 순환 시뮬레이션
        let remainingCharge = powerIncome;
        // 1 -> 2
        const charge1to2 = Math.min(p1, remainingCharge);
        p1 -= charge1to2;
        p2 += charge1to2;
        remainingCharge -= charge1to2;
        // 2 -> 3
        const charge2to3 = Math.min(p2, remainingCharge);
        p2 -= charge2to3;
        p3 += charge2to3;

        // 만약 수입 단계에서 낭비되는 파워가 생길 것으로 예측된다면,
        // *현재* 보유한 p3를 자원으로 미리 변환 (에러 방지: 시뮬레이션된 p3가 아닌 현재 p3 기준)
        const currentP3 = player.power3 ?? 0;
        if (p3 > (player.power1 ?? 0) + (player.power2 ?? 0) + (player.power3 ?? 0) || p3 >= 1) {
            // 변환 우선순위: QIC(4) > Ore(3) > Credit(1)
            if (currentP3 >= 4 && (player.qic || 0) < 15) {
                if (player.faction !== 'gleens' || getAcademyRightCount(game, playerId) > 0) {
                    return { type: 'convert_resource', params: { type: '4power-to-1qic' } };
                }
            }
            if (currentP3 >= 3 && (player.ore ?? 0) < 15) {
                return { type: 'convert_resource', params: { type: '3power-to-1ore' } };
            }
            if (currentP3 >= 1 && (player.credits ?? 0) < 30) {
                return { type: 'convert_resource', params: { type: '1power-to-1credit' } };
            }
        }

        return null;
    }

    /** 다음 라운드 수입 단계에서 들어올 파워와 토큰 양 예측 */
    private static calculateExpectedPowerIncome(game: ServerGameState, playerId: string): { powerIncome: number; tokenIncome: number } {
        const player = game.players[playerId];
        if (!player) return { powerIncome: 0, tokenIncome: 0 };

        let powerIncome = 0;
        let tokenIncome = 0;

        // 1. Faction Base Income
        const faction = FACTIONS.find(f => f.id === player.faction);
        tokenIncome += faction?.baseIncome?.powerTokens ?? 0;

        // 2. Bonus Tile Income
        if (player.bonusTile) {
            const tile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
            if (tile?.income?.power) powerIncome += tile.income.power;
            if (tile?.income?.powerTokens) tokenIncome += tile.income.powerTokens;
        }

        // 3. Tech Tiles Income
        for (const tid of player.techTiles || []) {
            if (tid === 'tech-inc-1o-1p') powerIncome += 1;
            if (tid === 'tech-act-4p' && !player.usedSpecialActions?.includes(tid)) {
                // 이 액션은 메인 액션 대신 쓰는 거지만 수입 단계 직전 수동 고려 가능성 (여기선 제외)
            }
        }

        // 4. Research Track Income
        for (const trackId of Object.keys(player.research || {}) as ResearchTrack[]) {
            const level = player.research[trackId] ?? 0;
            if (trackId === 'economy') {
                if (level >= 1) powerIncome += 1;
                if (level >= 2) powerIncome += 1;
                if (level >= 3) powerIncome += 1;
                if (level >= 4) powerIncome += 1;
            } else if (trackId === 'science') {
                // 과학 트랙은 충전 없음
            }
        }

        // 5. Structure Income
        const structures = game.map.filter(t => t.ownerId === playerId);
        // Labs (네뷸라는 연구소당 2P)
        const labs = structures.filter(t => t.structure === 'research_lab').length;
        if (labs > 0 && player.faction === 'nevlas') powerIncome += 2 * labs;

        // PI / Academy Income (Power)
        const hasPI = structures.some(t => t.structure === 'planetary_institute');
        if (hasPI) {
            if (player.faction === 'taklons') powerIncome += 4;
            else if (['terrans', 'xenos', 'ambas', 'ivits', 'firaks'].includes(player.faction || '')) powerIncome += 4;
        }

        return { powerIncome, tokenIncome };
    }

    // ... rest of the file stays same

    static getCandidateMoves(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        if (!player || player.hasPassed) return [];

        // Check if it's actually this player's turn (important for MCTS simulation drift)
        const currentPlayerId = game.turnOrder[game.currentPlayerIndex];
        if (currentPlayerId !== playerId && game.currentPhase === 'main') {
            // If it's not our turn, we can't do anything
            return [];
        }

        // 이미 메인 액션을 수행했더라도 pendingShipTechMine 상태면 광산 건설이 강제됨
        if (game.hasDoneMainAction && !game.pendingShipTechMine) {
            return [{ type: 'end_turn', params: {} }];
        }

        const candidates: BotAction[] = [];

        // 1. 연방 구성 (가장 중요)
        const fedAction = FederationPlanner.getBestFederationAction(game, playerId);
        if (fedAction) candidates.push({ type: 'form_federation', params: fedAction });

        // 2. pendingTerraformSteps가 있으면 바로 광산 건설
        if ((player.pendingTerraformSteps || 0) > 0) {
            const buildWithPending = this.findBuildWithPendingSteps(game, playerId);
            if (buildWithPending) candidates.push(buildWithPending);
        }

        // 3. Ivits 우주정거장 전략
        if (player.faction === 'ivits' && !player.usedIvitsSpaceStationThisRound) {
            const ivitsAction = this.findIvitsSpaceStationAction(game, playerId);
            if (ivitsAction) candidates.push(ivitsAction);
        }

        // 4. 교역소 할인 업그레이드
        const discountedTS = this.findDiscountedUpgradeAction(game, playerId);
        if (discountedTS) candidates.push(discountedTS);

        // 5. 일반 건설 시도
        const buildAction = this.findBuildAction(game, playerId);
        if (buildAction) candidates.push(buildAction);

        // 6. 일반 업그레이드 시도
        const upgradeAction = this.findUpgradeAction(game, playerId);
        if (upgradeAction) candidates.push(upgradeAction);

        // 7. 내비게이션 연구 보너스 (QIC 절약)
        if (buildAction?.type === 'build_mine' && (player.knowledge ?? 0) >= 4) {
            const navId: ResearchTrack = 'navigation';
            const currentNav = player.research[navId] || 0;
            if (currentNav < 5) {
                const needsQIC = this.checkIfActionNeedsQIC(game, playerId, buildAction);
                if (needsQIC && this.willNavResearchSaveQIC(game, playerId, buildAction)) {
                    candidates.push({ type: 'advance_research', params: { trackId: navId } });
                }
            }
        }

        // 8. 파워/QIC 액션
        const powerAction = this.findPowerAction(game, playerId);
        if (powerAction) candidates.push(powerAction);

        // 8-1. 우주선 입장 (Lost Fleet Ship)
        const shipEntry = this.findSpaceshipEntryAction(game, playerId);
        if (shipEntry) candidates.push(shipEntry);

        // 8-2. 우주선 액션 (Lost Fleet Actions)
        const shipAction = this.findSpaceshipAction(game, playerId);
        if (shipAction) candidates.push(shipAction);

        // 9. 일반 연구
        if ((player.knowledge ?? 0) >= 4) {
            const track = this.pickResearchTrack(game, player, playerId);
            if (track) candidates.push({ type: 'advance_research', params: { trackId: track } });
        }

        if (!game.simulation) {
            log(`Bot ${player.name} found ${candidates.length} non-pass candidates in Round ${game.roundNumber}`, 'game', game.id);
        }

        // 9. 패스 (항상 후보에 포함하여 MCTS가 조기 패스의 이점을 계산하게 함). 6라운드/보너스 없어도 패스 가능.
        if (!player.hasPassed) {
            const availableTiles = game.availableBonusTiles;
            const bonusTileId = availableTiles && availableTiles.length > 0 ? availableTiles[0].id : undefined;
            candidates.push({ type: 'pass_round', params: { bonusTileId } });
        }

        // 중복 제거 (예: 동일한 타일에 대한 건설 명령이 두 번 들어간 경우)
        const uniqueCandidates: BotAction[] = [];
        const seen = new Set<string>();
        for (const c of candidates) {
            const key = JSON.stringify(c);
            if (!seen.has(key)) {
                seen.add(key);
                uniqueCandidates.push(c);
            }
        }

        return uniqueCandidates;
    }


    private static findUpgradeAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        const ore = player.ore ?? 0;
        const credits = player.credits ?? 0;
        const round = game.roundNumber;

        interface ScoredUpgrade {
            id: string;
            score: number;
            action: BotAction;
        }
        const candidates: ScoredUpgrade[] = [];

        const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);

        // 1. Mines -> Trading Stations
        if (ore >= 2 && credits >= 3) {
            const mines = myStructures.filter(t => t.structure === 'mine');
            for (const mine of mines) {
                const isDiscounted = hasNearbyPlayersForDiscount(game, mine, playerId);
                const cost = isDiscounted ? 3 : 6;
                if (credits >= cost) {
                    let score = isDiscounted ? 80 : 40;
                    score += this.calculateRoundScoringBonus(game, playerId, 'build_trading_station');
                    score += this.calculateFinalMissionBonus(game, playerId, mine, 'trading_station');
                    score += this.calculateAdjacencyBonus(game, playerId, mine);

                    candidates.push({
                        id: `ts-${mine.id}`,
                        score,
                        action: { type: 'upgrade_structure', params: { tileId: mine.id, target: 'trading_station' } }
                    });
                }
            }
        }

        // 2. Trading Stations -> Research Labs
        if (ore >= 3 && credits >= 5) {
            const tsList = myStructures.filter(t => t.structure === 'trading_station');
            const labCount = myStructures.filter(t => t.structure === 'research_lab').length;

            for (const ts of tsList) {
                let score = 75;
                // 초반 연구소 확보 가점 (매우 높게 조정)
                if (round <= 2 && labCount < 2) score += 60;
                if (labCount === 0) score += 80;

                score += this.calculateRoundScoringBonus(game, playerId, 'build_research_lab');
                score += this.calculateFinalMissionBonus(game, playerId, ts, 'research_lab');

                candidates.push({
                    id: `lab-${ts.id}`,
                    score,
                    action: { type: 'upgrade_structure', params: { tileId: ts.id, target: 'research_lab' } }
                });
            }
        }

        // 3. Trading Stations -> Planetary Institute
        const hasPI = myStructures.some(t => t.structure === 'planetary_institute');
        if (ore >= 4 && credits >= 6 && !hasPI) {
            const tsList = myStructures.filter(t => t.structure === 'trading_station');
            for (const ts of tsList) {
                let score = 60;
                // 종족별 PI 파워 체크 및 우선순위
                if (player.faction === 'geodens' && this.shouldGeodenBuildPI(game, playerId)) score += 50;
                
                // 피락스: 연구소가 있어야 의회 능력이 의미 있음 (유저 피드백)
                if (player.faction === 'firaks') {
                    const hasLab = myStructures.some(t => t.structure === 'research_lab');
                    if (hasLab) score += 45;
                }
                
                if (player.faction === 'nevlas') score += 40; // 네블라스 의회 강력 추천
                
                // 이비츠는 기본적으로 PI를 갖고 시작하므로 !hasPI 조건에서 이미 걸러지지만, 명시적 점수 상향은 제거

                if (round >= 3) score += 20;

                score += this.calculateRoundScoringBonus(game, playerId, 'build_big_building');
                score += this.calculateFinalMissionBonus(game, playerId, ts, 'planetary_institute');

                candidates.push({
                    id: `pi-${ts.id}`,
                    score,
                    action: { type: 'upgrade_structure', params: { tileId: ts.id, target: 'planetary_institute' } }
                });
            }
        }

        // 4. Research Labs -> Academies
        const academyCount = myStructures.filter(t => t.structure === 'academy').length;
        if (ore >= 6 && credits >= 6 && academyCount < 2) {
            const labList = myStructures.filter(t => t.structure === 'research_lab');
            for (const lab of labList) {
                let score = 110; // 베이스 상향
                if (round >= 2 && round <= 4 && academyCount === 0) score += 60; // 첫 아카데미는 중반까지 매우 강력 권장
                if (round >= 5) score += 20;

                score += this.calculateRoundScoringBonus(game, playerId, 'build_big_building');
                score += this.calculateFinalMissionBonus(game, playerId, lab, 'academy');

                // 지식 수입이 풍족한데 돈이 부족하면 연구소보다 교역소를 선호하도록 유도하는 점수 보정 (TS 점수가 상대적으로 올라감)
                if ((player.knowledge || 0) > 10 && (player.credits || 0) < 10) {
                    score -= 15;
                }

                candidates.push({
                    id: `academy-${lab.id}`,
                    score,
                    action: { type: 'upgrade_structure', params: { tileId: lab.id, target: 'academy_right' } }
                });
            }
        }

        if (candidates.length === 0) return null;

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0].action;
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

        // [사용자 전략] 2거리 이상 확보 시 광산 건설 가중치 부여
        const rangeBonusValue = range >= 2 ? 30 : 0;

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

                let score = (neededQicForRange === 0 ? 130 : 100) - neededQicForRange * 25; // 가이아 건설 베이스 점수 상향
                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine');
                score += this.calculateRoundScoringBonus(game, playerId, 'build_gaia');
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += this.calculateThreatScore(game, playerId, tile); // 가이아 탈취 위협 방어 점수 추가
                score += rangeBonusValue; // 2거리 확보 가점

                scored.push({
                    tile,
                    score,
                    action: { type: 'build_mine', params: { tileId: tile.id } }
                });
                continue;
            }

            // 모행성 (테라포밍 불필요)
            if (tile.type === homeType) {
                let score = (neededQicForRange === 0 ? 130 : 100) - neededQicForRange * 25; // 모행성 베이스 약간 하향 (업그레이드와 경합 유도)
                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine');
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += this.calculateFederationScore(game, playerId, tile);
                score += this.calculateThreatScore(game, playerId, tile); // 다른 플레이어가 뺏을 위험 방어 점수 추가
                score += rangeBonusValue; // 2거리 확보 가점

                scored.push({
                    tile,
                    score,
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
                let score = 85 - neededQicForRange * 25;
                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine');
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += rangeBonusValue; // 2거리 확보 가점

                scored.push({
                    tile,
                    score,
                    action: { type: 'build_mine', params: { tileId: tile.id } }
                });
                continue;
            }

            // 파워 액션 콤보: 3P→1삽 (gain-1-step, cost 3P)
            if (remainingSteps === 1) {
                const stepAction = game.powerActions.find(a => a.id === 'gain-1-step' && !a.isUsed);
                if (stepAction) {
                    if (power3 >= 3) {
                        scored.push({
                            tile,
                            score: 70 - neededQicForRange * 25,
                            preAction: { type: 'use_power_action', params: { actionId: 'gain-1-step' } },
                            action: { type: 'build_mine', params: { tileId: tile.id } }
                        });
                        continue;
                    } else if (power3 + Math.floor((player.power2 ?? 0) / 2) >= 3) {
                        scored.push({
                            tile,
                            score: 69 - neededQicForRange * 25,
                            preAction: {
                                type: 'burn_power',
                                params: { moveBrainToBowl3: player.faction === 'taklons' && player.brainStoneBowl === 2 ? true : undefined }
                            },
                            action: { type: 'use_power_action', params: { actionId: 'gain-1-step' } }
                        });
                        continue;
                    }
                }
            }

            // 파워 액션 콤보: 5P→2삽 (gain-2-steps, cost 5P)
            if (remainingSteps <= 2) {
                const stepAction = game.powerActions.find(a => a.id === 'gain-2-steps' && !a.isUsed);
                if (stepAction) {
                    if (power3 >= 5) {
                        scored.push({
                            tile,
                            score: 60 - neededQicForRange * 25,
                            preAction: { type: 'use_power_action', params: { actionId: 'gain-2-steps' } },
                            action: { type: 'build_mine', params: { tileId: tile.id } }
                        });
                        continue;
                    } else if (power3 + Math.floor((player.power2 ?? 0) / 2) >= 5) {
                        scored.push({
                            tile,
                            score: 59 - neededQicForRange * 25,
                            preAction: {
                                type: 'burn_power',
                                params: { moveBrainToBowl3: player.faction === 'taklons' && player.brainStoneBowl === 2 ? true : undefined }
                            },
                            action: { type: 'use_power_action', params: { actionId: 'gain-2-steps' } }
                        });
                        continue;
                    }
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

            // Ore로 직접 테라포밍 (비효율적이므로 낮은 점수이나 확장을 위해 감수)
            const costPerStep = getTerraformCost(tfLevel || 0);
            const terraformCost = remainingSteps * costPerStep;
            const totalOre = 1 + terraformCost;

            if (ore >= totalOre && credits >= 2) {
                // [AI 개선] 3O(광석 3개)를 소모하는 테라포밍은 매우 비효율적이므로 점수를 대폭 하향
                const tfScore = tfLevel >= 3 ? 50 : (tfLevel >= 2 ? 30 : (tfLevel >= 1 ? 5 : -20));

                // 3O 소모 구간(costPerStep >= 3)에서는 패널티 대폭 증가
                const stepPenalty = costPerStep >= 3 ? (remainingSteps * 30) : (remainingSteps * 10);
                let score = tfScore - stepPenalty - (neededQicForRange * 25);

                // 광석이 충분하지 않은 초/중반 3O 테라포밍 극단적 패널티
                if (costPerStep >= 3 && (game.roundNumber <= 3 || ore < 8)) {
                    score -= 60;
                }

                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine');
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += this.calculateFederationScore(game, playerId, tile);

                // 효율이 극도로 낮다면 아예 후보에서 배제 (차라리 기술을 올리거나 패스하도록 유도)
                if (score >= -10) {
                    scored.push({
                        tile,
                        score,
                        action: { type: 'build_mine', params: { tileId: tile.id } }
                    });
                }
            }
        }

        // 연방 형성을 위해 파워 태우기 (Bowl 2 -> 3) 고려
        // 만약 1~2 파워가 부족해서 파워 액션을 못하는 경우, 태우기 가능 여부 체크
        // (이 로직은 findAlternativeBuildAction 이나 main loop 상단에서 처리하는 것이 좋음)


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
        const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];

        let bestTrack: ResearchTrack | null = null;
        let bestScore = -1;

        for (const track of tracks) {
            const level = player.research[track] ?? 0;
            if (level >= 5) continue;

            // 5단계 상승 시 연방 토큰 필요
            if (level === 4) {
                const feds = getFederationEntries(player);
                if (!feds.some(f => f.isGreen)) continue;
            }

            const score = this.calculateResearchScore(game, player, playerId, track);
            if (score > bestScore) {
                bestScore = score;
                bestTrack = track;
            }
        }

        return bestTrack;
    }

    private static calculateResearchScore(game: ServerGameState, player: PlayerState, playerId: string, track: ResearchTrack): number {
        const level = player.research[track] ?? 0;
        const round = game.roundNumber;
        const faction = player.faction;
        let score = 0;

        const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);

        // 1. 기본 트랙 가치 (동적 계산)
        switch (track) {
            case 'terraforming':
                score += (6 - level) * 12;
                if (round <= 3) score += 25;
                // [사용자 전략] 아카데미 빌드 시 테라포밍 1단계 우선
                if (level === 0 && round <= 2) score += 30;
                break;
            case 'navigation':
                score += (6 - level) * 10;
                // [동적 분석] 항해를 올렸을 때 새로 닿는 행성이 있는가?
                const currentRange = BotLogic.getEffectiveBaseRange(player);
                const nextRange = getRange(level + 1) + (player.navigationBonus || 0);
                const reachableNow = new Set(game.map.filter(t => !t.ownerId && BotLogic.isPlanetHex(t) && myStructures.some(s => getDistance(s, t) <= currentRange)));
                const reachableNext = new Set(game.map.filter(t => !t.ownerId && BotLogic.isPlanetHex(t) && myStructures.some(s => getDistance(s, t) <= nextRange)));

                const newPlanets = Array.from(reachableNext).filter(t => !reachableNow.has(t));
                if (newPlanets.length > 0) {
                    score += newPlanets.length * 15; // 새로운 행성 개수당 가점
                } else if (reachableNext.size === 0 && round <= 4) {
                    score += 40;
                }

                // [사용자 전략] 연구소 건설(또는 계획) + 지식 확보 시 항해 점수 대폭 강화
                const labCount = myStructures.filter(t => t.structure === 'research_lab').length;
                if (labCount >= 1 && (player.knowledge || 0) >= 3) {
                    score += 50;
                }
                // [사용자 전략] 2거리에 도달하면 이후에 광산을 최대한 많이 짓도록 유도 (항해 자체보다는 다른 행동 가점)
                if (nextRange >= 2) {
                    score += 20;
                }
                break;
            case 'artificialIntelligence':
                score += (6 - level) * 15;
                if (round >= 4) score += 20;
                break;
            case 'gaiaProject':
                score += (6 - level) * 8;
                if (faction === 'terran' || faction === 'itars') score += 40;
                break;
            case 'economy':
                score += (6 - level) * 15;
                if (round <= 2) score += 20;
                if (round >= 5) score -= 40;
                // [사용자 전략] 아카데미 건설 시 경제 2단계까지 우선순위 강화
                const academyCount = myStructures.filter(t => t.structure === 'academy').length;
                if (academyCount >= 1 && level < 2) {
                    score += 45;
                }
                break;
            case 'science':
                score += (6 - level) * 12; // 대폭 축소 (기존 20/15)
                if (round <= 2) score += 5;
                if (level >= 3) score += 10; // 지식 생산량 확보를 위한 중반 가중치
                break;
        }

        // 2. 고급 기술 타일 시너지 분석
        const advTiles = game.advancedTechTilesByTrack || {};
        const myAdvTracks = Object.keys(advTiles).filter(t => player.research[t as ResearchTrack] >= 4);

        for (const [t, tile] of Object.entries(advTiles)) {
            if (t === track) {
                // 이 트랙 위에 있는 고급 타일이 나에게 유리한가?
                if (tile.id.includes('vp-build') || tile.id.includes('vp-terraform')) {
                    score += 30; // 건설/테라포밍 점수 타일은 매우 강력
                }
                if (tile.id.includes('pass-') && round >= 4) {
                    score += 25; // 후반 패스 보너스 타일 시너지
                }
            }
        }

        // 3. 라운드 미션 연계
        score += this.calculateRoundScoringBonus(game, playerId, 'research_track');

        // 4. 다음 레벨 보상 가치
        if (level === 4) score += 80;

        return score;
    }

    private static findTechTileAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        const pending = game.pendingTechTileSelection;
        if (!pending) return null;

        // 현재 풀에서 가능한 타일 찾기 (일반 풀 + 트랙 위 타일 + 우주선 전용 타일)
        const availableTiles: TechTile[] = [];

        // 1. 일반 풀
        game.techTilesPool.forEach(t => { if (t && !player.techTiles.includes(t.id)) availableTiles.push(t); });

        // 2. 트랙 위 타일들
        for (const trackTiles of Object.values(game.techTilesByTrack)) {
            const arr = Array.isArray(trackTiles) ? trackTiles : [trackTiles];
            for (const t of arr) {
                if (t && !player.techTiles.includes(t.id)) availableTiles.push(t);
            }
        }

        // 3. 우주선 전용 기술 타일 (우주선에 입장한 상태인 경우)
        if (game.availableShipTechTileIds) {
            for (const shipTechId of game.availableShipTechTileIds) {
                const shipTech = SHIP_TECH_TILES.find((st: TechTile) => st.id === shipTechId);
                if (shipTech && !player.techTiles.includes(shipTechId)) {
                    availableTiles.push(shipTech);
                }
            }
        }

        if (availableTiles.length === 0) return null;

        // 동적 점수 계산을 통해 최적의 타일 선택
        let bestTile: TechTile = availableTiles[0];
        let maxScore = -Infinity;

        for (const tile of availableTiles) {
            const score = this.calculateTechTileScore(game, playerId, tile.id);
            if (score > maxScore) {
                maxScore = score;
                bestTile = tile;
            }
        }

        // 트랙 선택 (해당 타일이 요구하는 트랙 또는 가장 높은 점수의 트랙)
        const trackId = this.pickResearchTrack(game, player, playerId) || 'economy';

        log(`Bot ${player.name} selected Tech Tile: ${bestTile.id} (Score: ${maxScore.toFixed(1)})`, 'game', game.id);
        return { type: 'select_tech_tile', params: { techTileId: bestTile.id, trackId } };
    }

    private static calculateTechTileScore(game: ServerGameState, playerId: string, tileId: string): number {
        const player = game.players[playerId];
        const round = game.roundNumber;
        let score = 0;

        // 1. 우주선 전용 타일 보너스 (보통 일반 타일보다 강력함)
        const isShipTech = tileId.startsWith('ship-tech-');
        if (isShipTech) score += 45;

        // 2. 라운드별 가중치 (초반 수익, 후반 점수)
        if (round <= 3) {
            // 초반: 수익 타일 대폭 우대
            if (tileId.startsWith('tech-inc-')) score += 50;
            if (tileId === 'tech-act-4p') score += 40;
            if (tileId === 'tech-imm-1o-1q') score += 30;
        } else if (round >= 5) {
            // 후반: 즉시 점수 및 행성 유형당 지식 타일 우대
            if (tileId === 'tech-imm-7vp') score += 70;
            if (tileId === 'tech-imm-1k-planet') {
                const myPlanets = game.map.filter(t => t.ownerId === playerId && t.structure);
                const types = new Set(myPlanets.map(t => t.type).filter(t => t)).size;
                score += 30 + (types * 10); // 개척한 행성 종류가 많을수록 큰 가치
            }
            if (tileId.startsWith('tech-inc-')) score -= 20; // 수입 타일은 후반에 가치 급감
        }

        // 3. 라운드 미션 시너지 (기술 타일 획득 시 2VP 등)
        score += this.calculateRoundScoringBonus(game, playerId, 'gain_tech_tile');

        // 4. 종족별 특정 타일 시너지
        if (player.faction === 'itars' && tileId === 'tech-act-4p') score += 20; // 아이타는 의회 능력 활용을 위해 4P 매우 선호
        if (player.faction === 'nevlas' && tileId === 'tech-inc-1o-1p') score += 15; // 네블라스는 파워 충격 시너지

        // 5. 무작위 변동성 (동일 점수 시 다양성 부여)
        score += Math.random() * 2;

        return score;
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

    private static findPowerAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        const round = game.roundNumber;

        const availableActions = game.powerActions.filter(a => !a.isUsed);
        if (availableActions.length === 0) return null;

        let bestScore = -1;
        let bestActionId = '';

        for (const action of availableActions) {
            let score = 0;
            const cost = action.cost;
            const isQic = action.costType === 'qic';

            if (isQic) {
                if ((player.qic || 0) < cost) continue;
            } else {
                if ((player.power3 || 0) < cost) continue;
            }

            switch (action.id) {
                case 'gain-3-knowledge': score = 90; break; // 지식 3은 고벨류
                case 'gain-2-steps': score = 85; break; // 2삽 고벨류
                case 'gain-2-ore': score = 60; break;
                case 'gain-7-credits': score = 55; break;
                case 'gain-1-step': score = 75; break; // 하이브 등 건설을 위해 1단계 전진 중요도 상향
                case 'qic-action-tech': score = 110; break; // 기술 타일 획득은 무조건 고점
                case 'qic-action-vp-sector': score = round >= 5 ? 120 : 40; break;
                default: score = 10;
            }

            if (isQic && round >= 4) score *= 1.5;

            if (score > bestScore) {
                bestScore = score;
                bestActionId = action.id;
            }
        }

        if (bestActionId) {
            return { type: 'use_power_action', params: { actionId: bestActionId } };
        }
        return null;
    }

    private static findSpaceshipEntryAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        const round = game.roundNumber;
        if (game.hasDoneMainAction) return null;

        const entered = player.spaceshipsEntered || [];
        if (entered.length >= 3) return null;

        const shipTiles = game.map.filter(t => ['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'].includes(t.type || ''));
        const candidates: { action: BotAction; score: number }[] = [];

        const baseRange = this.getEffectiveBaseRange(player);
        const qic = player.qic || 0;

        // In ServerGameState context, we might not have getPlayerRangeTiles easily available as a static method of Bot
        // But we can simulate it by finding buildings/stations.
        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );

        for (const tile of shipTiles) {
            if (entered.includes(tile.id)) continue;

            const shipState = game.spaceships?.[tile.id];
            const unlockCost = player.faction === 'bal_tak' ? 7 : 5;
            if (!shipState?.unlocked && (player.score || 0) < unlockCost) continue;

            // Faction specific cost (Itars/Nevlas)
            if (['itars', 'nevlas'].includes(player.faction || '')) {
                if ((player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0) < 1) continue;
            }

            const minDist = Math.min(...myPlanets.map(p => getDistance(p, tile)));
            const neededQic = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
            if (neededQic > qic) continue;

            let score = 50; // 기본 입장 점수 (5VP 가치)
            
            // 입장 순서 가산 (2/3번째 +2PW, 4번째 +3PW)
            const occupants = shipState?.occupants?.length || 0;
            if (occupants === 1 || occupants === 2) score += 20;
            else if (occupants === 3) score += 30;

            // 라운드별 가점 (초반에는 강력한 기술 타일이나 자원 확보를 위해)
            if (round <= 3) score += 20;

            // Rebellion은 기술 타일을 주기 때문에 더 높게 평가
            if (tile.type === 'ship_rebellion') score += 30;
            if (tile.type === 'ship_eclipse') score += 10; // 후반 소행성 건설/연구용

            candidates.push({
                action: { type: 'enter_spaceship', params: { tileId: tile.id, qicToUse: neededQic } },
                score
            });
        }

        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0].action;
    }

    private static findSpaceshipAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        const entered = player.spaceshipsEntered || [];
        if (entered.length === 0 || game.hasDoneMainAction) return null;

        const candidates: { action: BotAction; score: number }[] = [];

        for (const shipId of entered) {
            const shipTile = game.map.find(t => t.id === shipId);
            const shipState = game.spaceships?.[shipId];
            if (!shipTile || !shipState) continue;

            const usedIndices = shipState.usedActionIndices || [];
            if (usedIndices.length >= 3) continue;

            // Action Indices: 1, 2, 3
            for (let i = 1; i <= 3; i++) {
                if (usedIndices.includes(i)) continue;

                let score = 0;
                let action: BotAction | null = null;

                if (shipTile.type === 'ship_twilight') {
                    if (i === 1 && player.qic >= 3) {
                        score = 110; // 연방 보상
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && player.ore >= 2 && player.power3 >= 3) {
                        const ts = game.map.find(t => t.ownerId === playerId && t.structure === 'trading_station');
                        if (ts) {
                            score = 80; // TS -> Lab (강력)
                            action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i, targetTileId: ts.id } };
                        }
                    } else if (i === 3 && player.knowledge >= 1) {
                        score = 40; // +3 거리
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    }
                } else if (shipTile.type === 'ship_rebellion') {
                    if (i === 1 && player.qic >= 3) {
                        score = 120; // 기술 타일!!
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && player.ore >= 1 && player.power3 >= 3) {
                        const mine = game.map.find(t => t.ownerId === playerId && t.structure === 'mine');
                        if (mine) {
                            score = 70; // Mine -> TS
                            action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i, targetTileId: mine.id } };
                        }
                    } else if (i === 3 && player.knowledge >= 2) {
                        score = 50; // 2K -> 1Q 2C
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    }
                } else if (shipTile.type === 'ship_tf_mars') {
                    if (i === 1 && player.qic >= 2) {
                        const count = player.techTiles?.length ?? 0;
                        score = 40 + (count + 2) * 2; // 기술 타일 비례 점수
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && player.power3 >= 2 && (player.gaiaformers || 0) > 0) {
                        score = 75; // 가이아 프로젝트
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 3 && player.credits >= 3) {
                        score = 60; // 3C -> 1TF
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    }
                } else if (shipTile.type === 'ship_eclipse') {
                    if (i === 1 && player.qic >= 2) {
                        const structures = game.map.filter(t => t.ownerId === playerId && t.structure);
                        const types = new Set(structures.map(t => t.type).filter(x => x && x !== 'space' && x !== 'deep_space')).size;
                        score = 40 + (types + 2) * 2;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && player.knowledge >= 2 && player.power3 >= 3) {
                        score = 90; // 연구 전진
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 3 && player.credits >= 6) {
                        score = 85; // 소행성 광산
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    }
                }

                if (action && score > 0) {
                    candidates.push({ action, score });
                }
            }
        }

        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0].action;
    }

    private static getEffectiveBaseRange(player: PlayerState): number {
        let r = getRange(player.research?.navigation ?? 0) + (player.navigationBonus ?? 0);
        if (player.tempRangeBonus) r += 3;
        if (player.rangeBonusActive) r += 3;
        return r;
    }

    private static isPlanetHex(tile: HexTile): boolean {
        if (!tile.type) return false;
        const nonPlanet: PlanetType[] = ['space', 'deep_space', 'lost_fleet_ship', 'asteroid'];
        if (tile.type.startsWith('ship_')) return false;
        return !nonPlanet.includes(tile.type);
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

    private static calculateRoundScoringBonus(game: ServerGameState, playerId: string, triggerType: string): number {
        const round = game.roundNumber;
        const currentRoundIndex = round - 1;
        if (currentRoundIndex < 0 || currentRoundIndex >= game.roundScoringTiles.length) return 0;

        const tile = game.roundScoringTiles[currentRoundIndex];
        if (tile.triggerType === triggerType) {
            // 라운드 미션 점수에 비례하여 가중치 부여 (예: 2점당 10점의 내부 스코어)
            return tile.vp * 5;
        }

        // 미래 라운드 미션도 약간 고려 (0.2 가중치)
        let futureBonus = 0;
        for (let i = currentRoundIndex + 1; i < game.roundScoringTiles.length; i++) {
            const futureTile = game.roundScoringTiles[i];
            if (futureTile.triggerType === triggerType) {
                futureBonus += futureTile.vp * 1;
            }
        }

        return futureBonus;
    }

    private static calculateFinalMissionBonus(game: ServerGameState, playerId: string, tile: HexTile, structure?: string): number {
        let totalBonus = 0;
        const missions = game.finalScoringTiles || [];
        const player = game.players[playerId];

        const myTiles = game.map.filter(t => t.ownerId === playerId || t.parasiticMine?.ownerId === playerId);
        const myTypes = new Set(myTiles.map(t => t.type).filter(t => t));

        for (const missionTile of missions) {
            switch (missionTile.id) {
                case 'fm_total_structures':
                    totalBonus += 5; // 어떤 건물이든 지으면 도움됨
                    break;
                case 'fm_planet_types':
                    if (tile.type && !myTypes.has(tile.type)) {
                        totalBonus += 35; // 기본 보너스 상향
                    }
                    break;
                case 'fm_gaia_planets':
                    if (tile.type === 'gaia') totalBonus += 20;
                    break;
                case 'fm_sectors':
                    const mySectors = new Set(game.map.filter(t => t.ownerId === playerId).map(t => t.sector));
                    if (!mySectors.has(tile.sector)) totalBonus += 25; // 상향
                    break;
                case 'fm_asteroid_buildings':
                    if (tile.type === 'asteroid') totalBonus += 20;
                    break;
            }
        }

        // 기술 타일 시너지: 유형당 1지식 (유저 피드백: 획득 전일 때 가치 높음, 이미 먹었으면 추가 가치 낮음)
        const isPlanetTechAvailable = (game.techTilesPool || []).some(t => t?.id === 'tech-imm-1k-planet');
        if (!player.techTiles?.includes('tech-imm-1k-planet') && isPlanetTechAvailable) {
            if (tile.type && !myTypes.has(tile.type)) {
                totalBonus += 25; // 아직 안 먹었을 때 더 적극적으로 확장 (기대를 위함)
            }
        }

        return totalBonus;
    }

    private static calculateAdjacencyBonus(game: ServerGameState, playerId: string, tile: HexTile): number {
        let bonus = 0;
        const neighbors = game.map.filter(t => getDistance(t, tile) === 1);

        for (const neighbor of neighbors) {
            if (neighbor.ownerId && neighbor.ownerId !== playerId) {
                // 상대방 건물 근처면 교역소 할인 및 파워 수급 기회
                if (neighbor.structure === 'mine' || neighbor.structure === 'trading_station') {
                    // 업그레이드 여지가 있는 건물 옆일 때 장기적 파워 수급 기회가 더 큼
                    bonus += 20;
                } else if (neighbor.structure) {
                    // PI/Academy 등 업그레이드가 끝난 건물 옆은 즉각적인 교역소 할인용
                    bonus += 10;
                }
            }
        }

        // 상대방의 가이아포머가 놓인 곳 옆도 잠재적 건설 예약지이므로 가점
        const opponentGaiaformers = game.map.filter(t => t.hasGaiaformer && t.ownerId !== playerId);
        const nearGaiaformer = opponentGaiaformers.some(gf => getDistance(gf, tile) === 1);
        if (nearGaiaformer) bonus += 15;

        return bonus;
    }

    private static getBuildingValue(structure: string, faction: string): number {
        switch (structure) {
            case 'mine': return 1;
            case 'trading_station': return 2;
            case 'research_lab': return 2;
            case 'planetary_institute': return (faction === 'bescods' || faction === 'ivits') ? 4 : 3;
            case 'academy': return (faction === 'bescods' || faction === 'ivits') ? 4 : 3;
            default: return 0;
        }
    }

    private static calculateFederationScore(game: ServerGameState, playerId: string, tile: HexTile): number {
        const player = game.players[playerId];
        const faction = player.faction || '';

        // Ivits는 연방 규칙이 다르므로 단순 거리 보너스만
        if (faction === 'ivits') {
            const ivitsPlanets = game.map.filter(t => t.ownerId === playerId && t.structure);
            const minDist = ivitsPlanets.length > 0 ? Math.min(...ivitsPlanets.map(p => getDistance(p, tile))) : 999;
            if (minDist <= 2) return 15;
            return 0;
        }

        let score = 0;
        const fedHexes = (game as any).playerFederationHexes?.[playerId] || [];
        // myStructures: 내 건물 중 아직 연방에 포함되지 않은 것들
        const myStructures = game.map.filter(t =>
            t.ownerId === playerId &&
            t.structure &&
            t.structure !== 'ship' &&
            !fedHexes.includes(t.id)
        );

        // 주변 2칸 이내에 내 건물이 있는지 (연결 용이성)
        const nearbyMe = myStructures.filter(t => getDistance(t, tile) <= 2);
        if (nearbyMe.length > 0) {
            score += 10;

            // 건물 가치 합산
            let totalValue = 1; // 내 지을 mine 가치
            for (const s of nearbyMe) {
                totalValue += this.getBuildingValue(s.structure!, faction);
            }

            // 7점에 가까워질수록 큰 가점
            if (totalValue >= 7) score += 30;
            else if (totalValue >= 4) score += 15;
        }

        return score;
    }

    /**
     * 동적 위협 평가 (Threat Assessment)
     * 이 타일 주변에 적 플레이어가 침투할 가능성이나 의지가 높은가?
     */
    private static calculateThreatScore(game: ServerGameState, playerId: string, tile: HexTile): number {
        let threatScore = 0;
        const player = game.players[playerId];
        const myFactionDef = FACTIONS.find(f => f.id === player.faction);

        // 모행성이나 가이아 행성 선점 위협 평가
        if (tile.type !== myFactionDef?.homePlanet && tile.type !== 'gaia') {
            // 다른 종류의 행성일 경우, 테라포밍 비용 대비 가치 평가 (사용자 피드백 반영)
            const steps = getTerraformStepsForFaction(game, player.faction!, tile.type!);
            if (steps >= 2) return 0; // 2단계 이상 삽질이 필요하면 견제보다는 내 내실에 집중
            
            // 0~1단계 삽질로 먹을 수 있는 땅이라면 약간의 견제 점수 부여
            threatScore += (2 - steps) * 10;
        }

        for (const [otherId, otherPlayer] of Object.entries(game.players)) {
            if (otherId === playerId || !otherPlayer.faction) continue;

            const otherFactionDef = FACTIONS.find(f => f.id === otherPlayer.faction);
            const otherHomeTp = otherFactionDef?.homePlanet;
            let targetAttractiveness = 0;

            if (tile.type === otherHomeTp) {
                targetAttractiveness += 40; // 적의 모행성 선점은 강력한 위협이자 견제 수단
            } else if (tile.type === 'gaia') {
                targetAttractiveness += 20;
            }

            const otherBuildings = game.map.filter(t => t.ownerId === otherId && t.structure);
            if (otherBuildings.length === 0) continue;

            const minDist = Math.min(...otherBuildings.map(b => getDistance(b, tile)));
            const otherRange = getRange(otherPlayer.research.navigation || 0) + (otherPlayer.navigationBonus || 0);

            if (minDist <= otherRange) {
                threatScore += targetAttractiveness * 1.5;
            } else if (minDist <= otherRange + 2) {
                threatScore += targetAttractiveness * 0.8;
            }
        }

        return Math.min(threatScore, 65);
    }
}
