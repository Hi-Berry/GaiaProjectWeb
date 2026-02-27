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
    executeBurnPower
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
    getFederationEntries
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
    | 'burn_power';
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
            // 연방, 건설, 업그레이드, 연구 등 여러 갈래를 MCTS에 맡깁니다.
            const candidates = this.getCandidateMoves(game, playerId);
            if (candidates.length === 1) return candidates[0];
            if (candidates.length > 1) {
                if (isSimulate) {
                    // MCTS 시뮬레이션 내부에서는 가장 점수가 높은 첫 번째 행동을 취하여 재귀를 막습니다.
                    // (candidates 배열 안에는 이미 Evaluator 휴리스틱 등에 기반한 좋은 순서대로 담겨 있어야 하지만,
                    // 현재 getCandidateMoves 는 단순히 목록만 가져오므로 0번을 고르면 탐욕적 선택이 됩니다)
                    return candidates[0];
                }
                log(`Bot ${player.name} starting MCTS with ${candidates.length} candidates...`, 'game', game.id);
                const bestAction = await MCTS.search(game, playerId, candidates);
                if (bestAction) return bestAction;
            }
            return null;
        }

        return null;
    }

    static getCandidateMoves(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        if (!player) return [];

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

        // 9. 일반 연구
        if ((player.knowledge ?? 0) >= 4) {
            const track = this.pickResearchTrack(game, player, playerId);
            if (track) candidates.push({ type: 'advance_research', params: { trackId: track } });
        }

        log(`Bot ${player.name} found ${candidates.length} non-pass candidates in Round ${game.roundNumber}`, 'game', game.id);

        // 9. 패스 (항상 후보에 포함하여 MCTS가 조기 패스의 이점을 계산하게 함)
        if (!player.hasPassed) {
            const availableTiles = game.availableBonusTiles;
            if (availableTiles && availableTiles.length > 0) {
                // 패스는 무작위가 아닌 현재 가장 좋은 타일 1개를 고르게 하거나, 첫 번째 타일
                candidates.push({ type: 'pass_round', params: { bonusTileId: availableTiles[0].id } });
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
                let score = 70;
                // 초반 연구소 확보 가점
                if (round <= 2 && labCount < 2) score += 30;
                if (labCount === 0) score += 40;

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
                // 종족별 PI 파워 체크
                if (player.faction === 'geodens' && this.shouldGeodenBuildPI(game, playerId)) score += 50;
                if (player.faction === 'ivits') score += 50; // 이비츠는 PI가 핵심

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
                let score = 50;
                if (round >= 4) score += 20;

                score += this.calculateRoundScoringBonus(game, playerId, 'build_big_building');
                score += this.calculateFinalMissionBonus(game, playerId, lab, 'academy');

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

                let score = (neededQicForRange === 0 ? 90 : 75) - neededQicForRange * 25;
                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine');
                score += this.calculateRoundScoringBonus(game, playerId, 'build_gaia');
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += this.calculateAdjacencyBonus(game, playerId, tile);

                scored.push({
                    tile,
                    score,
                    action: { type: 'build_mine', params: { tileId: tile.id } }
                });
                continue;
            }

            // 모행성 (테라포밍 불필요)
            if (tile.type === homeType) {
                let score = (neededQicForRange === 0 ? 100 : 80) - neededQicForRange * 25;
                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine');
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += this.calculateFederationScore(game, playerId, tile);

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
                // TF 레벨 3(1삽=1O)이면 점수 높게, TF 레벨 1(1삽=2O)이면 낮게, 0이면 더 낮게
                const tfScore = tfLevel >= 3 ? 60 : (tfLevel >= 2 ? 45 : (tfLevel >= 1 ? 35 : 25));
                let score = tfScore - (remainingSteps * 5) - (neededQicForRange * 25);

                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine');
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += this.calculateFederationScore(game, playerId, tile);

                scored.push({
                    tile,
                    score,
                    action: { type: 'build_mine', params: { tileId: tile.id } }
                });
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

        // 1. 기본 트랙 가치 (동적 계산)
        switch (track) {
            case 'terraforming':
                score += (6 - level) * 12;
                if (round <= 3) score += 25;
                break;
            case 'navigation':
                score += (6 - level) * 10;
                // [동적 분석] 항해를 올렸을 때 새로 닿는 행성이 있는가?
                const currentRange = BotLogic.getEffectiveBaseRange(player);
                const nextRange = getRange(level + 1) + (player.navigationBonus || 0);
                const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);
                const reachableNow = new Set(game.map.filter(t => !t.ownerId && BotLogic.isPlanetHex(t) && myStructures.some(s => getDistance(s, t) <= currentRange)));
                const reachableNext = new Set(game.map.filter(t => !t.ownerId && BotLogic.isPlanetHex(t) && myStructures.some(s => getDistance(s, t) <= nextRange)));

                const newPlanets = Array.from(reachableNext).filter(t => !reachableNow.has(t));
                if (newPlanets.length > 0) {
                    score += newPlanets.length * 15; // 새로운 행성 개수당 가점
                } else if (reachableNext.size === 0 && round <= 4) {
                    // 지금도 앞으로도 닿는 곳이 없으면 항해 우선순위 대폭 상승 (고립 방지)
                    score += 40;
                }
                break;
            case 'artificialIntelligence':
                score += (6 - level) * 15;
                if (round >= 4) score += 20; // 후반 QIC 액션 대비
                break;
            case 'gaiaProject':
                score += (6 - level) * 8;
                if (faction === 'terran' || faction === 'itars') score += 40;
                break;
            case 'economy':
                score += (6 - level) * 20;
                if (round <= 2) score += 50;
                if (round >= 5) score -= 40;
                break;
            case 'science':
                score += (6 - level) * 25;
                if (round <= 4) score += 30;
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

        // 선택 가능한 타일 중 가장 가치 있는 것 선택
        // 1. 일반 기술 타일 우선순위
        const priorities = [
            'tech-7vp', 'tech-1o-1q', 'tech-1k-planet', 'tech-1o-1c-1q',
            'tech-income-1o-1k', 'tech-income-4c', 'tech-income-1k-1c',
            'tech-gaia-3vp', 'tech-step-vp'
        ];

        // 현재 풀에서 가능한 타일 찾기
        const available = game.techTilesPool.filter(t => t && !player.techTiles.includes(t.id));

        // 트랙 위에 놓인 타일들
        for (const trackTiles of Object.values(game.techTilesByTrack)) {
            const arr = Array.isArray(trackTiles) ? trackTiles : [trackTiles];
            for (const t of arr) {
                if (t && !player.techTiles.includes(t.id)) {
                    available.push(t);
                }
            }
        }

        if (available.length === 0) return null;

        // 가치 판단 (간단하게 priorities 순서대로)
        let bestTileId = available[0]!.id;
        let bestIndex = 999;

        for (const t of available) {
            if (!t) continue;
            const idx = priorities.indexOf(t.id);
            if (idx !== -1 && idx < bestIndex) {
                bestIndex = idx;
                bestTileId = t.id;
            }
        }

        // 트랙 선택 (해당 타일이 요구하는 트랙 또는 가장 높은 점수의 트랙)
        const trackId = this.pickResearchTrack(game, player, playerId) || 'economy';

        return { type: 'select_tech_tile', params: { techTileId: bestTileId, trackId } };
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
                case 'gain-3-knowledge': score = 60; break;
                case 'gain-2-steps': score = 70; break;
                case 'gain-2-ore': score = 50; break;
                case 'gain-7-credits': score = 45; break;
                case 'qic-action-tech': score = 90; break;
                case 'qic-action-vp-sector': score = round >= 5 ? 100 : 40; break;
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

        for (const missionTile of missions) {
            switch (missionTile.id) {
                case 'fm_total_structures':
                    totalBonus += 5; // 어떤 건물이든 지으면 도움됨
                    break;
                case 'fm_planet_types':
                    const player = game.players[playerId];
                    const myTiles = game.map.filter(t => t.ownerId === playerId || t.parasiticMine?.ownerId === playerId);
                    const myTypes = new Set(myTiles.map(t => t.type).filter(t => t));
                    if (tile.type && !myTypes.has(tile.type)) {
                        totalBonus += 15; // 새로운 행성 종류면 큰 보너스
                    }
                    break;
                case 'fm_gaia_planets':
                    if (tile.type === 'gaia') totalBonus += 15;
                    break;
                case 'fm_sectors':
                    const mySectors = new Set(game.map.filter(t => t.ownerId === playerId).map(t => t.sector));
                    if (!mySectors.has(tile.sector)) totalBonus += 12;
                    break;
                case 'fm_asteroid_buildings':
                    if (tile.type === 'asteroid') totalBonus += 15;
                    break;
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
                bonus += 10;
            }
        }

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
}

