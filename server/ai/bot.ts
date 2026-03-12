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
    executeUseTechAction,
    executeUseSpecialAction,
    executeUseBonusAction,
    executePlaceIvitsSpaceStation,
    executeUseShipAction,
    executeEndTurn,
    executeSelectTechTile,
    executeBotFederation,
    executeBurnPower,
    executeConvertResource,
    getAcademyLeftCount,
    getAcademyRightCount,
    executeEnterSpaceship,
    executePlaceGaiaformer,
    executeTakeTwilightArtifact
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
    countGreenFederations,
    TechTile,
    SHIP_TECH_TILES,
    isPlanetHex,
    FEDERATION_12VP_ID
} from '@shared/gameConfig';

type BotAction = {
    type: 'build_mine' | 'upgrade_structure' | 'advance_research' | 'pass_round'
    | 'charge_power' | 'place_starting_mine' | 'select_faction' | 'select_bonus'
    | 'end_turn'
    | 'use_power_action'
    | 'place_ivits_space_station'
    | 'place_lost_planet'
    | 'use_ship_action'
    | 'eclipse_build_asteroid_mine'
    | 'select_tech_tile'
    | 'advance_tech'
    | 'form_federation'
    | 'burn_power'
    | 'convert_resource'
    | 'enter_spaceship'
    | 'use_tech_action'
    | 'use_special_action'
    | 'use_bonus_action'
    | 'place_gaiaformer'
    | 'take_twilight_artifact';
    params: any;
    /** 프리 액션을 먼저 실행한 뒤 메인 액션 (예: 2O→2토큰 후 연방) */
    preActions?: BotAction[];
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
                return executeUsePowerAction(io, game, playerId, action.params.actionId, action.params.useBrain);
            case 'place_ivits_space_station':
                return executePlaceIvitsSpaceStation(io, game, playerId, action.params.tileId);
            case 'place_lost_planet': {
                if (game.currentPhase !== 'main') return false;
                if (game.pendingLostPlanet?.playerId !== playerId) return false;
                const player = game.players[playerId];
                const tile = game.map.find(t => t.id === action.params.tileId);
                if (!player || !tile) return false;
                if (tile.type !== 'space' && tile.type !== 'deep_space') return false;
                if (tile.structure != null || tile.spaceStation) return false;
                const satellites = game.satellites || {};
                const raw = (satellites as any)[tile.id] as (string | string[] | undefined);
                const onTile = Array.isArray(raw) ? raw : (raw ? [raw] : []);
                if (onTile.length > 0) return false;

                const rangeTiles = game.map.filter(t =>
                    (t.ownerId === playerId && t.structure !== null) ||
                    (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
                );
                if (rangeTiles.length === 0) return false;

                const baseRange = getRange(5) + (player.navigationBonus || 0);
                const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
                const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
                const qicSpent = typeof action.params.qicToSpend === 'number' ? action.params.qicToSpend : 0;
                if (qicSpent !== neededQIC || (player.qic || 0) < neededQIC) return false;

                player.qic -= neededQIC;
                tile.structure = 'lost_planet_mine';
                tile.ownerId = playerId;
                game.pendingLostPlanet = null;
                game.hasDoneMainAction = true;
                io.to(game.id).emit('game_updated', game);
                return true;
            }
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
            case 'place_gaiaformer':
                return executePlaceGaiaformer(io, game, playerId, action.params.tileId, action.params.qicUsed);
            case 'take_twilight_artifact':
                return executeTakeTwilightArtifact(io, game, playerId, action.params.artifactId);
            case 'use_tech_action':
                return executeUseTechAction(io, game, playerId, action.params.tileId);
            case 'use_special_action':
                return executeUseSpecialAction(io, game, playerId, action.params.actionId);
            case 'use_bonus_action':
                return executeUseBonusAction(io, game, playerId);
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

            // Nav 5 잊혀진 행성 배치 대기 중
            if (game.pendingLostPlanet?.playerId === playerId) {
                return this.findLostPlanetTarget(game, playerId);
            }

            // 기술 타일 선택 대기 중
            if (game.pendingTechTileSelection?.playerId === playerId) {
                return this.findTechTileAction(game, playerId, isSimulate);
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
                    // 80% 확률로 최선의 수, 20% 확률로 두 번째 수 선택 (시뮬레이션 다양성 확보)
                    if (candidates.length > 1 && Math.random() < 0.2) {
                        return candidates[1];
                    }
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
            // 변환 우선순위: QIC(4) > Ore(3) > Credit(1). 타클론은 브레인 스톤 우선 사용.
            const useBrain = player.faction === 'taklons';
            if (currentP3 >= 4 && (player.qic || 0) < 15) {
                if (player.faction !== 'gleens' || getAcademyRightCount(game, playerId) > 0) {
                    return { type: 'convert_resource', params: { type: '4power-to-1qic', useBrain } };
                }
            }
            if (currentP3 >= 3 && (player.ore ?? 0) < 15) {
                return { type: 'convert_resource', params: { type: '3power-to-1ore', useBrain } };
            }
            if (currentP3 >= 1 && (player.credits ?? 0) < 30) {
                return { type: 'convert_resource', params: { type: '1power-to-1credit', useBrain } };
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
        if (fedAction) {
            const round = (game as any).roundNumber ?? 1;
            const spent = fedAction.spentTokens ?? 0;
            const totalTokens = (player.power1 ?? 0) + (player.power2 ?? 0) + (player.power3 ?? 0);
            const tokenSurplus = totalTokens - spent;
            const allowEarlyExpensiveFed = round >= 3 || spent <= 2 || tokenSurplus >= 8;
            if (allowEarlyExpensiveFed) candidates.push({ type: 'form_federation', params: fedAction });
        }

        // 1b. 프리 액션 kO→k토큰 후 연방: k=2..min(ore,6) 각각 후보로 넣어서 MCTS가 효율(최소 오레로 12VP 등) 판단
        const oreForFed = player.ore ?? 0;
        for (let k = 2; k <= Math.min(oreForFed, 6); k++) {
            const fedWithK = FederationPlanner.getBestFederationAction(game, playerId, k);
            if (!fedWithK) continue;
            const round = (game as any).roundNumber ?? 1;
            const spent = fedWithK.spentTokens ?? 0;
            // 초반엔 "오레 태워서 위성 많이" 연방을 억제 (정말 싸면 허용)
            if (round <= 2 && spent > 2) continue;
            const preActions = Array.from({ length: k }, () => ({ type: 'convert_resource' as const, params: { type: '1ore-to-1token' } }));
            candidates.push({ type: 'form_federation', params: fedWithK, preActions });
        }

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
        const buildActions = this.findBuildActions(game, playerId);
        if (buildActions.length > 0) candidates.push(...buildActions);

        // 6. 일반 업그레이드 시도
        const upgradeActions = this.findUpgradeActions(game, playerId);
        if (upgradeActions.length > 0) candidates.push(...upgradeActions);

        // 7. 내비게이션 연구 보너스 (QIC 절약)
        // 7. 내비게이션 연구 보너스 (QIC 절약)
        const primaryBuild = buildActions.length > 0 ? buildActions[0] : null;
        if (primaryBuild?.type === 'build_mine' && (player.knowledge ?? 0) >= 4) {
            const navId: ResearchTrack = 'navigation';
            const currentNav = player.research[navId] || 0;
            if (currentNav < 5) {
                const needsQIC = this.checkIfActionNeedsQIC(game, playerId, primaryBuild);
                if (needsQIC && this.willNavResearchSaveQIC(game, playerId, primaryBuild)) {
                    candidates.push({ type: 'advance_research', params: { trackId: navId } });
                }
            }
        }

        // 8. 특수 액션 (기술 타일, 종족 능력, 보너스 타일) - 최우선 후보로 넣어 MCTS 탐색 강화
        const specialActions = this.findSpecialActions(game, playerId);
        if (specialActions.length > 0) candidates.push(...specialActions);

        // 8-1. 파워/QIC 액션 - MCTS가 충분히 탐색하도록 상위 3개 후보
        const powerActions = this.findPowerActions(game, playerId);
        if (powerActions.length > 0) candidates.push(...powerActions);

        // 8-2. 우주선 입장 (Lost Fleet Ship)
        const shipEntry = this.findSpaceshipEntryAction(game, playerId);
        if (shipEntry) candidates.push(shipEntry); // 우주선 탑승을 적극 고려

        // 8-3. 우주선 액션 (Lost Fleet Actions) - 상위 3개로 확장
        const shipActions = this.findSpaceshipActions(game, playerId);
        if (shipActions.length > 0) candidates.push(...shipActions);

        // 8-3b. 트왈라잇 인공물 획득 (프리 n회 1O→1토큰 후 획득도 n=1..6 후보로 넣어 MCTS가 효율 판단)
        const artifactActions = this.findTwilightArtifactActions(game, playerId);
        if (artifactActions.length > 0) candidates.push(...artifactActions);

        // 가이아 포머 배치 액션 (가이아 프로젝트)
        const gaiaformerActions = this.findGaiaformerActions(game, playerId);
        if (gaiaformerActions.length > 0) candidates.push(...gaiaformerActions);

        // 8-4. 보너스 타일 스페셜 액션 (use_bonus_action)
        if (player.bonusTile && !player.usedBonusAction) {
            const bonusTileObj = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
            if (bonusTileObj?.specialAction) {
                candidates.push({ type: 'use_bonus_action', params: { actionId: bonusTileObj.specialAction } });
            }
        }

        // 8-5. 필수 자원 변환 (메인 액션 전 보조 액션으로 추가)
        const conversions = this.findEssentialConversions(game, playerId);
        if (conversions.length > 0) candidates.push(...conversions);

        // 9. 일반 연구 (최우선 순위 부여)
        if ((player.knowledge ?? 0) >= 4) {
            const tracks = this.pickResearchTracks(game, player, playerId);
            for (const track of tracks) {
                candidates.push({ type: 'advance_research', params: { trackId: track } });
            }
        }

        if (!game.simulation) {
            log(`Bot ${player.name} found ${candidates.length} non-pass candidates in Round ${game.roundNumber}`, 'game', game.id);
        }

        // 10. 패스 (지식이 충분하여 연구를 더 할 수 있다면 패스를 억제하여 무조건 지식을 소모하게 강제)
        if (!player.hasPassed) {
            if ((player.knowledge ?? 0) >= 4) {
                // 지식이 남았으면 패스하지 않도록 후보에 넣지 않음. (연구를 강제)
            } else {
                const bestBonus = this.findBonusTileAction(game, playerId);
                const bonusTileId = bestBonus?.params?.bonusTileId;
                candidates.push({ type: 'pass_round', params: { bonusTileId } });
            }
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


    private static findUpgradeActions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const ore = player.ore ?? 0;
        const credits = player.credits ?? 0;
        const round = game.roundNumber;
        const fedHexes: string[] = (game as any).playerFederationHexes?.[playerId] || [];

        interface ScoredUpgrade {
            id: string;
            score: number;
            action: BotAction;
        }
        const candidates: ScoredUpgrade[] = [];

        const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);

        /** 연방에 이미 속한 타일 업그레이드는 다음 연방에 불리하므로 감점 */
        const fedPenalty = (tileId: string) => fedHexes.includes(tileId) ? 70 : 0;

        // 1. Mines -> Trading Stations
        if (ore >= 2 && credits >= 3) {
            const mines = myStructures.filter(t => t.structure === 'mine');
            for (const mine of mines) {
                const isDiscounted = hasNearbyPlayersForDiscount(game, mine, playerId);
                const cost = isDiscounted ? 3 : 6;
                if (credits >= cost) {
                    let score = isDiscounted ? 80 : 40;

                    // [전략 개선] 1라운드 교역소 남발 방지: 연구소/아카데미가 없는 상태에서의 단순 교역소는 감점
                    if (round === 1) {
                        const labCount = myStructures.filter(t => t.structure === 'research_lab').length;
                        const academyCount = myStructures.filter(t => t.structure === 'academy').length;
                        if (labCount === 0 && academyCount === 0) {
                            score -= 60; // 먼저 연구소로 올릴 계획이 아니면 1라 TS는 비효율적
                        }
                    }

                    score -= fedPenalty(mine.id);
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

                score -= fedPenalty(ts.id);
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
                // 기본 의회 점수 (초반에는 아카데미/연구소보다 낮게 설정하여 무분별한 의회 건설 방지)
                let score = 30;

                // 종족별 PI 타이밍 강력 권장
                const faction = player.faction;
                const r1Preferred = ['geodens', 'space_giants', 'nevlas', 'lantids'];
                const r2Preferred = ['itars', 'darkanians'];

                if (r1Preferred.includes(faction || '')) {
                    if (round <= 2) score += 80;
                    else score += 50;
                } else if (r2Preferred.includes(faction || '')) {
                    if (round <= 2) score += 70;
                    else score += 40;
                } else if (faction === 'firaks') {
                    // 피락스: 연구소가 있어야 의회 능력이 의미 있음
                    const hasLab = myStructures.some(t => t.structure === 'research_lab');
                    if (hasLab) score += 60;
                } else {
                    // 그 외 종족: 4라운드 이전에는 건설 기피, 4라운드부터 의회 고려
                    if (round < 4) score -= 30;
                    if (round >= 4) score += 50;
                }

                if (faction === 'geodens' && this.shouldGeodenBuildPI(game, playerId)) score += 30;

                score -= fedPenalty(ts.id);
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
                let score = 120; // 아카데미를 의회보다 기본적으로 훨씬 높게 평가
                if (round >= 2 && round <= 4 && academyCount === 0) score += 70; // 첫 아카데미는 중반까지 매우 강력 권장
                if (round >= 5) score += 20;

                score += this.calculateRoundScoringBonus(game, playerId, 'build_big_building');
                score += this.calculateFinalMissionBonus(game, playerId, lab, 'academy');

                // 지식 수입이 풍족한데 돈이 부족하면 연구소보다 교역소를 선호하도록 유도하는 점수 보정 (TS 점수가 상대적으로 올라감)
                if ((player.knowledge || 0) > 10 && (player.credits || 0) < 10) {
                    score -= 15;
                }

                score -= fedPenalty(lab.id);
                candidates.push({
                    id: `academy-${lab.id}`,
                    score,
                    action: { type: 'upgrade_structure', params: { tileId: lab.id, target: 'academy_right' } }
                });
            }
        }

        if (candidates.length === 0) return [];

        candidates.sort((a, b) => b.score - a.score);
        // 상위 3개 후보 반환
        return candidates.slice(0, 3).map(c => c.action);
    }

    private static findDiscountedUpgradeAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        const ore = player.ore ?? 0;
        const credits = player.credits ?? 0;

        if (ore >= 2 && credits >= 3) {
            const fedHexes: string[] = (game as any).playerFederationHexes?.[playerId] || [];
            const mines = game.map.filter(t => t.ownerId === playerId && t.structure === 'mine');
            const discounted = mines.filter(t => hasNearbyPlayersForDiscount(game, t, playerId));
            // 연방에 아직 안 속한 타일 우선 (다음 연방에 유리)
            const preferred = discounted.find(t => !fedHexes.includes(t.id)) ?? discounted[0];
            if (preferred) {
                return { type: 'upgrade_structure', params: { tileId: preferred.id, target: 'trading_station' } };
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
    private static findBuildActions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const ore = player.ore ?? 0;
        const credits = player.credits ?? 0;
        const qic = player.qic ?? 0;
        const power3 = player.power3 ?? 0;

        if (ore < 1 || credits < 2) {
            // Ore/Credit 부족 시에도 Eclipse 6C 소행성이나 파워 콤보 가능한지 확인
            const alt = this.findAlternativeBuildAction(game, playerId);
            return alt ? [alt] : [];
        }

        if (!player.faction) return [];
        const faction = FACTIONS.find(f => f.id === player.faction);
        if (!faction?.homePlanet) return [];
        const homeType = faction.homePlanet;

        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        if (myPlanets.length === 0) return [];

        const range = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
        const tfLevel = player.research.terraforming ?? 0;
        const pendingSteps = player.pendingTerraformSteps || 0;

        // [사용자 전략] 2거리 이상 확보 시 광산 건설 가중치 부여
        const rangeBonusValue = range >= 2 ? 30 : 0;

        // 확장(건물 수) 우대 전략 (하지만 10개 이상이면 무조건 짓기보단 점수/연방 연계를 중시)
        const expansionDesire = myPlanets.length < 10 ? (10 - myPlanets.length) * 30 : 0;
        const earlyRushBonus = game.roundNumber <= 3 ? 150 : 0;
        const overExpansionPenalty = myPlanets.length >= 10 ? -80 : 0; // 충분히 컸을 땐 단순 확장은 감점

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

            let qicPenalty = neededQicForRange * 30;
            if (neededQicForRange > 0) {
                // Determine if this is a "good" QIC jump based on condition B:
                // Are there additional easy expansion targets (Gaia or home type) within 1 hex of the target tile?
                let easyTargetsNearby = 0;
                for (const t of game.map) {
                    if (t.id !== tile.id && !t.structure && (t.type === 'gaia' || t.type === homeType)) {
                        if (getDistance(tile, t) <= 1) easyTargetsNearby++;
                    }
                }

                // If base range is 1 (player hasn't upgraded range) or there are nearby targets,
                // it's an acceptable jump, so keep the normal penalty.
                // Otherwise, it's a "bad" jump, so we apply a massive penalty to discourage it.
                if (range > 1 && easyTargetsNearby === 0) {
                    qicPenalty += 200; // Heavily discourage pointless QIC jumps when range is already upgraded and no clusters nearby
                } else if (range === 1 && easyTargetsNearby === 0) {
                    qicPenalty += 50; // Mildly discourage even if range is 1, but still allow if desperate
                }
            }

            // QIC 소모 최대 1 제한 (초반 확장 패널티 약간 완화)
            if (neededQicForRange > 2) continue; // 확장을 위해서라면 QIC 2개 소모까지 허용
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
                    if (totalQicNeeded > 2) continue; // 확장을 위해서 2까지 완화
                }

                let score = (neededQicForRange === 0 ? 300 : 250) - qicPenalty; // 가이아 건설 베이스 점수 대폭 상향
                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine');
                score += this.calculateRoundScoringBonus(game, playerId, 'build_gaia');
                score += this.calculateFinalMissionBonus(game, playerId, tile);

                score += earlyRushBonus;
                score += expansionDesire;
                score += overExpansionPenalty;

                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += this.calculateThreatScore(game, playerId, tile);
                score += rangeBonusValue;

                scored.push({
                    tile,
                    score,
                    action: { type: 'build_mine', params: { tileId: tile.id } }
                });
                continue;
            }

            // 모행성 (테라포밍 불필요)
            if (tile.type === homeType) {
                let score = (neededQicForRange === 0 ? 350 : 300) - qicPenalty; // 모행성 확장은 최상위 가치
                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine');
                score += this.calculateFinalMissionBonus(game, playerId, tile);

                score += earlyRushBonus;
                score += expansionDesire;
                score += overExpansionPenalty;

                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += this.calculateFederationScore(game, playerId, tile);
                score += this.calculateThreatScore(game, playerId, tile);
                score += rangeBonusValue;

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
                let score = 250 - (qicPenalty * 0.8); // 상향
                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine');
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += earlyRushBonus;
                score += expansionDesire;
                score += overExpansionPenalty;
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
                            score: 70 - (qicPenalty * 0.8),
                            preAction: { type: 'use_power_action', params: { actionId: 'gain-1-step', useBrain: player.faction === 'taklons' } },
                            action: { type: 'build_mine', params: { tileId: tile.id } }
                        });
                        continue;
                    } else if (power3 + Math.floor((player.power2 ?? 0) / 2) >= 3) {
                        scored.push({
                            tile,
                            score: 69 - (qicPenalty * 0.8),
                            preAction: {
                                type: 'burn_power',
                                params: { moveBrainToBowl3: player.faction === 'taklons' && player.brainStoneBowl === 2 ? true : undefined }
                            },
                            action: { type: 'use_power_action', params: { actionId: 'gain-1-step', useBrain: player.faction === 'taklons' } }
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
                            score: 60 - (qicPenalty * 0.8),
                            preAction: { type: 'use_power_action', params: { actionId: 'gain-2-steps', useBrain: player.faction === 'taklons' } },
                            action: { type: 'build_mine', params: { tileId: tile.id } }
                        });
                        continue;
                    } else if (power3 + Math.floor((player.power2 ?? 0) / 2) >= 5) {
                        scored.push({
                            tile,
                            score: 59 - (qicPenalty * 0.8),
                            preAction: {
                                type: 'burn_power',
                                params: { moveBrainToBowl3: player.faction === 'taklons' && player.brainStoneBowl === 2 ? true : undefined }
                            },
                            action: { type: 'use_power_action', params: { actionId: 'gain-2-steps', useBrain: player.faction === 'taklons' } }
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
                            score: 65 - (qicPenalty * 0.8),
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
                // 확장 가치를 매우 높게 쳐주므로, 광석을 소모해서라도 짓도록 유도
                const tfScore = tfLevel >= 3 ? 150 : (tfLevel >= 2 ? 100 : (tfLevel >= 1 ? 80 : 30));

                const stepPenalty = costPerStep >= 3 ? (remainingSteps * 20) : (remainingSteps * 10);
                let score = tfScore - stepPenalty - (qicPenalty * 0.6);

                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine');
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += this.calculateFederationScore(game, playerId, tile);

                score += earlyRushBonus;
                score += expansionDesire;
                score += overExpansionPenalty;

                if (score >= -50) { // 약간 효율이 떨어져도 무조건 짓게 유도
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
            const alt = this.findAlternativeBuildAction(game, playerId);
            return alt ? [alt] : [];
        }

        scored.sort((a, b) => b.score - a.score);

        // 상위 후보 반환
        const results: BotAction[] = [];
        const seenActions = new Set<string>();

        for (const s of scored.slice(0, 8)) { // 더 다양한 광산 후보를 고려하도록 상향 (5->8)
            const act = s.preAction || s.action;
            const key = JSON.stringify(act);
            if (!seenActions.has(key)) {
                seenActions.add(key);
                results.push(act);
                if (results.length >= 4) break; // 3->4개로 상향
            }
        }

        return results;
    }

    /**
     * 대체 건설 전략: Eclipse 6C 소행성 등
     */
    /**
     * 가이아포머를 사용하여 보라색 행성(Transdim)을 가이아 행성으로 변환하는 액션 탐색
     */
    private static findGaiaformerActions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const availableGaiaformers = Math.max(0, (player.gaiaformers || 0) - (player.faction === 'bal_tak' ? (player.balTakGaiaformersUsedForQic || 0) : 0));

        if (availableGaiaformers <= 0) return [];

        const gaiaLevel = player.research.gaiaProject || 0;
        let powerRequired = 999;
        if (gaiaLevel >= 1 && gaiaLevel < 3) powerRequired = 6;
        else if (gaiaLevel >= 3 && gaiaLevel < 4) powerRequired = 4;
        else if (gaiaLevel >= 4) powerRequired = 3;

        const totalPower = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);

        // TF Mars 액션/보너스 타일로 인한 즉포 상황인 경우는 파워 소모가 없음
        const isFreeProject = game.pendingTFMarsGaiaProject?.playerId === playerId;
        if (!isFreeProject && totalPower < powerRequired) return [];

        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        if (myPlanets.length === 0) return [];

        const range = getRange(player.research.navigation || 0) + (player.navigationBonus || 0) + (player.tempRangeBonus ? 3 : 0) + (player.rangeBonusActive ? 3 : 0) + (player.gleensNavBonusActive ? 2 : 0);
        const qic = player.qic || 0;

        const candidates = game.map.filter(t => t.type === 'transdim' && !t.structure && !t.hasGaiaformer);

        const actions: { score: number, action: BotAction }[] = [];

        for (const tile of candidates) {
            const dist = Math.min(...myPlanets.map(p => getDistance(p, tile)));
            const neededQic = dist > range ? Math.ceil((dist - range) / 2) : 0;

            if (neededQic <= qic && neededQic <= 2) {
                let score = 200 - neededQic * 40; // 가이아 프로젝트 시도 가치를 매우 높게 부여
                if (isFreeProject) score += 100;

                actions.push({
                    score,
                    action: { type: 'place_gaiaformer', params: { tileId: tile.id, qicUsed: neededQic } }
                });
            }
        }

        actions.sort((a, b) => b.score - a.score);
        return actions.slice(0, 2).map(a => a.action); // 상위 2개
    }
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
     * Nav 5 보상 잊혀진 행성 타겟 선택 (pendingLostPlanet 상태에서)
     * - 위성 없는 빈 우주(space/deep_space)에만 배치
     * - QIC 소모는 (거리 - Nav5범위)를 2로 나눈 올림
     * - 봇은 QIC 소모 최소(동률이면 거리 최소)로 선택
     */
    private static findLostPlanetTarget(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        if (!player) return null;
        if (game.pendingLostPlanet?.playerId !== playerId) return null;

        const myTiles = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        if (myTiles.length === 0) return null;

        const satellites = game.satellites || {};
        const baseRange = getRange(5) + (player.navigationBonus || 0);
        const myQic = player.qic || 0;

        const candidates = game.map
            .filter(t => (t.type === 'space' || t.type === 'deep_space') && t.structure === null && !t.spaceStation)
            .filter(t => {
                const raw = (satellites as any)[t.id] as (string | string[] | undefined);
                const onTile = Array.isArray(raw) ? raw : (raw ? [raw] : []);
                return onTile.length === 0;
            })
            .map(t => {
                const minDist = Math.min(...myTiles.map(p => getDistance(p, t)));
                const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
                return { tileId: t.id, neededQIC, minDist };
            })
            .filter(x => x.neededQIC <= myQic)
            .sort((a, b) => (a.neededQIC - b.neededQIC) || (a.minDist - b.minDist));

        if (candidates.length === 0) return null;
        const best = candidates[0];
        return { type: 'place_lost_planet', params: { tileId: best.tileId, qicToSpend: best.neededQIC } };
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
    private static pickResearchTracks(game: ServerGameState, player: PlayerState, playerId: string): ResearchTrack[] {
        const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];

        const scored: { track: ResearchTrack, score: number }[] = [];

        for (const track of tracks) {
            const level = player.research[track] ?? 0;
            if (level >= 5) continue;

            // 5단계 상승 시 연방 토큰 필요
            if (level === 4) {
                const feds = getFederationEntries(player);
                if (!feds.some(f => f.isGreen)) continue;
            }

            const score = this.calculateResearchScore(game, player, playerId, track);
            scored.push({ track, score });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 2).map(s => s.track); // Top 2 tracks
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
                score += (6 - level) * 20; // 상향 (15 -> 20)
                if (round <= 2) score += 35; // 초반 경제 대폭 우대
                if (round >= 5) score -= 30;
                // [사용자 전략] 아카데미 건설 시 경제 2단계까지 우선순위 강화
                const academyCount = myStructures.filter(t => t.structure === 'academy').length;
                if (academyCount >= 1 && level < 2) {
                    score += 45;
                }
                break;
            case 'science':
                score += (6 - level) * 22; // 복구 및 상향 (12 -> 22)
                if (round <= 3) score += 30; // 초반 과학은 엔진의 핵심
                if (level >= 3) score += 15;
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
        if (level === 4) {
            score += 100;
            // [전략 개선] 초록 연방 토큰이 있으면 5단계(고급 기술 타일 가능)에 폭발적인 가중치
            const greenFeds = countGreenFederations(player);
            if (greenFeds > 0) {
                score *= 2.0; // 5단계를 찍어서 고급 타일을 가져오도록 강력 독촉
            }
        }

        return score;
    }

    private static findTechTileAction(game: ServerGameState, playerId: string, isSimulate = false): BotAction | null {
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
        const tracks = this.pickResearchTracks(game, player, playerId);
        const trackId = tracks.length > 0 ? tracks[0] : 'economy';

        // MCTS 롤아웃 시에는 매 시뮬 상태마다 로그가 쌓이므로, 실제 수 결정 시에만 로그
        if (!isSimulate) {
            log(`Bot ${player.name} selected Tech Tile: ${bestTile.id} (Score: ${maxScore.toFixed(1)})`, 'game', game.id);
        }
        return { type: 'select_tech_tile', params: { techTileId: bestTile.id, trackId } };
    }

    private static calculateTechTileScore(game: ServerGameState, playerId: string, tileId: string): number {
        const player = game.players[playerId];
        const round = game.roundNumber;
        let score = 0;

        // 1. 우주선 전용 타일 보너스 (보통 일반 타일보다 강력함)
        const isShipTech = tileId.startsWith('ship-tech-');
        if (isShipTech) {
            if (round <= 3) score += 90; // 초반 우주선 타일 매우 선호
            else score += 45;
        }

        // 2. 라운드별 가중치 (초반 수익, 후반 점수)
        if (round <= 3) {
            // 초반: 수익 타일 대폭 우대 (엔진 빌딩)
            if (tileId.startsWith('tech-inc-')) score += 80;
            if (tileId === 'tech-act-4p') score += 70;
            if (tileId === 'tech-imm-1o-1q') score += 50;

            // 극단적 기피 (즉발 점수 타일)
            if (tileId === 'tech-imm-7vp' || tileId === 'tech-gaia-3vp' || tileId === 'tech-imm-1k-planet') {
                score -= 200;
            }
        } else if (round >= 5) {
            // 후반: 즉시 점수 및 행성 유형당 지식 타일 우대
            if (tileId === 'tech-imm-7vp') score += 80;
            if (tileId === 'tech-imm-1k-planet') {
                const myPlanets = game.map.filter(t => t.ownerId === playerId && t.structure);
                const types = new Set(myPlanets.map(t => t.type).filter(t => t)).size;
                score += 40 + (types * 15);
            }
            if (tileId.startsWith('tech-inc-')) score -= 40; // 수입 타일은 후반에 가치 극감
        }

        // 2-1. 고급 기술 타일 (adv-tech-*) 평가
        if (tileId.startsWith('adv-')) {
            score += 100; // 기본적으로 고벨류
            if (tileId.includes('vp-build')) score += 40;
            if (tileId.includes('vp-research')) score += 30;
            if (tileId.includes('pass-')) {
                if (round >= 5) score += 60;
                else score -= 30; // 너무 일찍 가져가면 비효율
            }
            if (tileId.includes('imm-')) score += 50;
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

    private static findPowerActions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const round = game.roundNumber;
        const p3 = player.power3 || 0;
        const qic = player.qic || 0;

        const availableActions = game.powerActions.filter(a => !a.isUsed);
        if (availableActions.length === 0) return [];

        const scored: { id: string, score: number }[] = [];

        // 광산 건설 가능 여부 확인 (deltas for step action scoring)
        const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);
        const mineCount = myStructures.filter(t => t.structure === 'mine').length;

        for (const action of availableActions) {
            let score = 0;
            const cost = action.cost;
            const isQic = action.costType === 'qic';

            if (isQic) {
                if (qic < cost) continue;
            } else {
                if (p3 < cost) continue;
            }

            switch (action.id) {
                // QIC 액션 - 매우 강력
                case 'qic-action-tech':
                    score = 200; // 기술 타일 획득: 최고 우선순위
                    break;
                case 'qic-action-vp-sector':
                    score = round >= 4 ? 180 : 80; // 후반 섹터 VP: 강력
                    break;
                case 'qic-action-federation':
                    score = 160; // QIC 연방 보상도 강력
                    break;

                // 파워 액션 - 자원/테라포밍
                case 'gain-3-knowledge':
                    score = 160; // 지식 3개 = 연구 1회 충분
                    if (round <= 3) score += 30;
                    break;
                case 'gain-2-steps':
                    score = 150; // 테라포밍 2단계 = 강력
                    if (round <= 4) score += 20;
                    break;
                case 'gain-1-step':
                    score = 120; // 테라포밍 1단계
                    break;
                case 'gain-2-ore':
                    score = 100;
                    if (round <= 3) score += 20;
                    break;
                case 'gain-7-credits':
                    score = 90;
                    if ((player.credits || 0) < 5) score += 40; // 크레딧 부족 시 더 중요
                    break;
                default:
                    score = 60;
            }

            // 라운드 보정: 후반일수록 파워 액션 가치 증가 (남은 라운드가 적으므로)
            if (round >= 5) score += 40;
            else if (round >= 4) score += 20;

            // QIC 행동은 QIC가 충분할 때만 실행 가치 있음
            if (isQic && qic >= cost && round >= 3) score *= 1.3;

            scored.push({ id: action.id, score });
        }

        if (scored.length === 0) return [];
        scored.sort((a, b) => b.score - a.score);
        // 상위 3개 후보 반환 - MCTS가 다양한 파워 액션을 탐색할 수 있도록. 타클론은 브레인 스톤 우선 사용.
        const useBrain = player.faction === 'taklons';
        return scored.slice(0, 3).map(s => ({ type: 'use_power_action', params: { actionId: s.id, useBrain } }));
    }

    private static findEssentialConversions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const p3 = player.power3 ?? 0;
        const res: BotAction[] = [];
        const useBrain = player.faction === 'taklons';

        // 자원 상황이 정말 좋지 않을 때만 후보에 추가 (MCTS 탐색 공간 낭비 방지). 타클론은 브레인 스톤 우선 사용.
        if (p3 >= 3 && (player.ore ?? 0) < 2) res.push({ type: 'convert_resource', params: { type: '3power-to-1ore', useBrain } });
        if (p3 >= 1 && (player.credits ?? 0) < 2) res.push({ type: 'convert_resource', params: { type: '1power-to-1credit', useBrain } });
        if (p3 >= 4 && (player.qic ?? 0) < 1) res.push({ type: 'convert_resource', params: { type: '4power-to-1qic', useBrain } });

        return res;
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

            let score = 200; // 우주선 탑승 우선순위를 폭발적으로 상향

            // 입장 순서 가산 (2/3번째 +2PW, 4번째 +3PW)
            const occupants = shipState?.occupants?.length || 0;
            if (occupants === 1 || occupants === 2) score += 20;
            else if (occupants === 3) score += 30;

            // 라운드별 가점 (초반에는 강력한 기술 타일이나 자원 확보를 위해)
            if (round <= 3) score += 50;

            // Rebellion은 기술 타일을 주기 때문에 더 높게 평가
            if (tile.type === 'ship_rebellion') score += 40;
            if (tile.type === 'ship_eclipse') score += 60; // 후반 소행성 건설/연구용
            if (tile.type === 'ship_tf_mars') score += 50;

            candidates.push({
                action: { type: 'enter_spaceship', params: { tileId: tile.id, qicToUse: neededQic } },
                score
            });
        }

        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0].action;
    }

    /** 우주선 액션 목록 (상위 3개 반환) */
    private static findSpaceshipActions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const entered = player.spaceshipsEntered || [];
        if (entered.length === 0 || game.hasDoneMainAction) return [];
        const round = game.roundNumber;

        const candidates: { action: BotAction; score: number }[] = [];

        for (const shipId of entered) {
            const shipTile = game.map.find(t => t.id === shipId);
            const shipState = game.spaceships?.[shipId];
            if (!shipTile || !shipState) continue;

            const usedIndices = shipState.usedActionIndices || [];
            if (usedIndices.length >= 3) continue;

            for (let i = 1; i <= 3; i++) {
                if (usedIndices.includes(i)) continue;

                let score = 0;
                let action: BotAction | null = null;

                if (shipTile.type === 'ship_twilight') {
                    if (i === 1 && (player.qic || 0) >= 3) {
                        score = 250; // 연방 보상 → 매우 강력
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 1 && (player.qic || 0) >= 0) {
                        score = 130;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && (player.ore || 0) >= 2 && (player.power3 || 0) >= 3) {
                        const ts = game.map.find(t => t.ownerId === playerId && t.structure === 'trading_station');
                        if (ts) {
                            score = 220; // TS -> Lab 업그레이드
                            action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i, targetTileId: ts.id } };
                        }
                    } else if (i === 3) {
                        score = 150; // +3 거리: 범위 확장은 언제나 유용
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    }
                } else if (shipTile.type === 'ship_rebellion') {
                    if (i === 1 && (player.qic || 0) >= 3) {
                        score = 280; // 기술 타일 획득: 최강 액션
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 1) {
                        score = 150;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && (player.ore || 0) >= 1 && (player.power3 || 0) >= 3) {
                        const mine = game.map.find(t => t.ownerId === playerId && t.structure === 'mine');
                        if (mine) {
                            score = 200; // Mine -> TS 업그레이드
                            action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i, targetTileId: mine.id } };
                        }
                    } else if (i === 3 && (player.knowledge || 0) >= 2) {
                        score = 150; // 2K -> 1Q 2C
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 3) {
                        score = 80;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    }
                } else if (shipTile.type === 'ship_tf_mars') {
                    if (i === 1 && (player.qic || 0) >= 2) {
                        score = 220; // QIC 기술 타일: 매우 강력
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 1) {
                        score = 100;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && (player.power3 || 0) >= 2 && (player.gaiaformers || 0) > 0) {
                        score = 240; // 가이아 프로젝트
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 3 && (player.credits || 0) >= 3) {
                        score = 280; // 3C -> 1TF: 테라포밍 효율적, 확장에 최고
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    }
                } else if (shipTile.type === 'ship_eclipse') {
                    if (i === 1 && (player.qic || 0) >= 2) {
                        score = 200; // QIC 기술/연방
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 1) {
                        score = 100;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && (player.knowledge || 0) >= 2 && (player.power3 || 0) >= 3) {
                        score = 230; // 연구 전진: 매우 강력
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && (player.knowledge || 0) >= 2) {
                        score = 130;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 3 && (player.credits || 0) >= 6) {
                        score = 300; // 소행성 광산: 추가 건물 = 파워/점수 (절대적 우선순위)
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 3 && (player.credits || 0) >= 3) {
                        score = 100;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    }
                }

                // 라운드 후반일수록 우주선 액션 가치 증가 (남은 기회가 적으므로)
                if (score > 0) score += round * 5;

                if (action && score > 0) {
                    candidates.push({ action, score });
                }
            }
        }

        if (candidates.length === 0) return [];
        candidates.sort((a, b) => b.score - a.score);
        // 상위 3개 반환하여 MCTS가 다양한 우주선 액션을 탐색하도록
        return candidates.slice(0, 3).map(c => c.action);
    }

    /** @deprecated Use findSpaceshipActions instead */
    private static findSpaceshipAction(game: ServerGameState, playerId: string): BotAction | null {
        const actions = this.findSpaceshipActions(game, playerId);
        return actions.length > 0 ? actions[0] : null;
    }

    /** 인공물 비용 6 파워 기준으로 쓸 만한 인공물 ID 반환. assumedMinPower를 주면 그만큼 있다고 가정. */
    private static getBestArtifactId(game: ServerGameState, playerId: string, assumedMinPower?: number): string | null {
        const player = game.players[playerId];
        const entered = player.spaceshipsEntered || [];
        const twilightTile = game.map.find(t => t.type === 'ship_twilight');
        if (!twilightTile || !entered.includes(twilightTile.id)) return null;

        const totalPower = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);
        const effectivePower = assumedMinPower ?? totalPower;
        if (effectivePower < 6) return null;

        const slots = game.twilightArtifactSlots ?? [];
        const availableArtifacts = slots.filter(s => s !== null) as string[];
        if (availableArtifacts.length === 0) return null;

        let bestArtifact = availableArtifacts[0];
        let bestScore = -Infinity;

        for (const artifactId of availableArtifacts) {
            let score = 50;
            if (artifactId === 'art-imm-2o5c' || artifactId === 'art-imm-3o3c') {
                if (game.roundNumber <= 3) score += 200;
                else score += 40;
            } else if (artifactId === 'art-imm-3k1q') {
                if (game.roundNumber <= 4) score += 180;
                else score += 50;
            } else if (artifactId === 'art-7vp-virtual-asteroid' || artifactId === 'art-7vp-virtual-proto') {
                score += 150;
            } else if (artifactId === 'art-vp-planet-types' || artifactId === 'art-vp-bridge') {
                if (game.roundNumber >= 5) score += 150;
            } else if (artifactId === 'art-fed-once') {
                score += 100;
            }
            if (score > bestScore) {
                bestScore = score;
                bestArtifact = artifactId;
            }
        }
        return bestScore > 80 ? bestArtifact : null;
    }

    /** 인공물 획득 후보. 파워 6 미만이면 need=6-totalPower만큼 1O→1토큰 후보를 need~min(6,ore)까지 넣어 MCTS가 효율 판단. */
    private static findTwilightArtifactActions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const totalPower = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);
        const ore = player.ore ?? 0;

        const results: BotAction[] = [];

        if (totalPower >= 6) {
            const bestId = this.getBestArtifactId(game, playerId);
            if (bestId) results.push({ type: 'take_twilight_artifact', params: { artifactId: bestId } });
            return results;
        }

        const need = 6 - totalPower;
        if (need < 1 || ore < need) return results;

        const artifactId = this.getBestArtifactId(game, playerId, 6);
        if (!artifactId) return results;

        const oneConvert = { type: 'convert_resource' as const, params: { type: '1ore-to-1token' } };
        for (let n = need; n <= Math.min(6, ore); n++) {
            results.push({
                type: 'take_twilight_artifact',
                params: { artifactId },
                preActions: Array.from({ length: n }, () => oneConvert)
            });
        }
        return results;
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
                    count = new Set(myTiles.filter(t => t.type && t.type !== 'space' && t.type !== 'deep_space').map(t => t.type)).size;
                    break;
                case 'bridge_sector':
                    count = new Set(myTiles.filter(t => t.sector > 10).map(t => t.sector)).size;
                    break;
                case 'gaiaformer':
                    count = player.gaiaformers || 0;
                    break;
            }
            passBonusValue = count * (tile.passBonus?.vp || 0);
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
        if (tile.triggerType === triggerType) return tile.vp * 5;

        let futureBonus = 0;
        for (let i = currentRoundIndex + 1; i < game.roundScoringTiles.length; i++) {
            const futureTile = game.roundScoringTiles[i];
            if (futureTile.triggerType === triggerType) futureBonus += futureTile.vp * 1;
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
                case 'fm_total_structures': totalBonus += 5; break;
                case 'fm_planet_types':
                    if (tile.type && !myTypes.has(tile.type)) totalBonus += 35;
                    break;
                case 'fm_gaia_planets': if (tile.type === 'gaia') totalBonus += 20; break;
                case 'fm_sectors':
                    const mySectors = new Set(game.map.filter(t => t.ownerId === playerId).map(t => t.sector));
                    if (!mySectors.has(tile.sector)) totalBonus += 25;
                    break;
                case 'fm_asteroid_buildings': if (tile.type === 'asteroid') totalBonus += 20; break;
            }
        }
        const isPlanetTechAvailable = (game.techTilesPool || []).some(t => t?.id === 'tech-imm-1k-planet');
        if (!player.techTiles?.includes('tech-imm-1k-planet') && isPlanetTechAvailable) {
            if (tile.type && !myTypes.has(tile.type)) totalBonus += 25;
        }
        return totalBonus;
    }

    private static calculateAdjacencyBonus(game: ServerGameState, playerId: string, tile: HexTile): number {
        let bonus = 0;
        const neighbors = game.map.filter(t => getDistance(t, tile) === 1);

        for (const neighbor of neighbors) {
            // 다른 플레이어 건물 인접 (파워 수신용)
            if (neighbor.ownerId && neighbor.ownerId !== playerId) {
                if (neighbor.structure === 'mine' || neighbor.structure === 'trading_station') bonus += 20;
                else if (neighbor.structure) bonus += 10;
            }

            // 내 건물 인접 (군집화 및 위성 절약) - 대폭 상향
            if (neighbor.ownerId === playerId && neighbor.structure && neighbor.structure !== 'ship') {
                bonus += 50;
            }
        }

        // 2거리 내에 내 건물이 있으면 연방 연결에 유리
        const range2Neighbors = game.map.filter(t => getDistance(t, tile) === 2);
        for (const neighbor of range2Neighbors) {
            if (neighbor.ownerId === playerId && neighbor.structure && neighbor.structure !== 'ship') {
                bonus += 20;
            }
        }

        const opponentGaiaformers = game.map.filter(t => t.hasGaiaformer && t.ownerId !== playerId);
        if (opponentGaiaformers.some(gf => getDistance(gf, tile) === 1)) bonus += 15;
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
        if (faction === 'ivits') {
            const ivitsPlanets = game.map.filter(t => t.ownerId === playerId && t.structure);
            const minDist = ivitsPlanets.length > 0 ? Math.min(...ivitsPlanets.map(p => getDistance(p, tile))) : 999;
            return minDist <= 2 ? 20 : 0;
        }
        let score = 0;
        const fedHexes = (game as any).playerFederationHexes?.[playerId] || [];
        const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship' && !fedHexes.includes(t.id));
        if (myStructures.length > 0) {
            const minDist = Math.min(...myStructures.map(s => getDistance(tile, s)));
            if (minDist <= 3) score += (4 - minDist) * 15;
            let potentialPower = 1;
            for (const s of myStructures) {
                if (getDistance(tile, s) <= 4) potentialPower += this.getBuildingValue(s.structure!, faction);
            }
            if (potentialPower >= 7) score += 60;
            else if (potentialPower >= 4) score += 25;
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

    private static findSpecialActions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const res: BotAction[] = [];

        if (game.hasDoneMainAction) {
            if (player.faction === 'gleens' && !player.usedSpecialActions?.includes('gleens-2nav')) {
                res.push({ type: 'use_special_action', params: { actionId: 'gleens-2nav' } });
            }
            return res;
        }

        // 1. 기술 타일 액션
        for (const tid of player.techTiles || []) {
            if (player.usedTechActions?.includes(tid)) continue;
            if (tid === 'tech-act-4p') res.push({ type: 'use_tech_action', params: { tileId: tid } });
            if (tid === 'adv-act-3k') res.push({ type: 'use_tech_action', params: { tileId: tid } });
            if (tid === 'adv-act-3o') res.push({ type: 'use_tech_action', params: { tileId: tid } });
            if (tid === 'adv-act-1q-5c') res.push({ type: 'use_tech_action', params: { tileId: tid } });
        }

        // 2. 종족 특수 액션 (use_special_action)
        if (player.faction === 'gleens' && !player.usedSpecialActions?.includes('gleens-2nav')) {
            res.push({ type: 'use_special_action', params: { actionId: 'gleens-2nav' } });
        }

        // Academy right action (getAcademyRightCount is in gameState.ts)
        const hasRightAcademy = game.map.some(t => t.ownerId === playerId && t.structure === 'academy' && t.academyType === 'right');
        if (hasRightAcademy && !player.usedSpecialActions?.includes('academy-qic')) {
            res.push({ type: 'use_special_action', params: { actionId: 'academy-qic' } });
        }

        // 3. 보너스 타일 액션
        if (player.bonusTile && !player.usedBonusAction) {
            const tile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
            if (tile?.specialAction) {
                res.push({ type: 'use_bonus_action', params: { actionId: tile.specialAction } });
            }
        }

        return res;
    }
}
