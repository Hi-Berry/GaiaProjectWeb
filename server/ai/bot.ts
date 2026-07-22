import { Server as SocketIOServer } from 'socket.io';
import * as nodeFs from 'fs';
import {
    ServerGameState,
    isTrackLevel5Taken,
    executeBuildMine,
    executeFiraksDowngrade,
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
    executeEclipseAdvanceTrack,
    executeCancelEclipseResearch,
    executeSelectAdvancedTechTile,
    executeCoverAdvancedTechTile,
    executeBotFederation,
    executeBurnPower,
    executeConvertResource,
    executeUseHadschHallasPIAction,
    executeBotBescodsAdvanceLowestTrack,
    executeBotAmbasSwapPiMine,
    getAcademyLeftCount,
    getAcademyRightCount,
    executeEnterSpaceship,
    executePlaceGaiaformer,
    executeTakeTwilightArtifact,
    executeSkipTfmarsGaiaProject,
    executeEclipseBuildAsteroidMine,
    getLegalEclipseAsteroidMineTileIds,
    peekEclipseAsteroidMineTileIds,
    getPlayerRangeTiles,
    getStructureCount,
    executeBalTakGaiaformerToQic,
    getEffectiveGaiaformers,
    executeConfirmTwilightFederation,
    executePlaceLostPlanet,
    getPlayerPlanetTypesForGeodens
} from '../gameState';
import { FederationPlanner } from './federationPlanner';
import { log } from '../index';
import { MCTS } from './mcts';
import { getPlayerFlag } from './variant';
import { StateCloner } from './stateCloner';
import { Evaluator } from './evaluator';
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
    SHIP_TECH_BY_SHIP,
    isPlanetHex,
    FEDERATION_12VP_ID,
    getGaiaBaseQic,
    BUILDING_LIMITS,
    getNextRoundIncomePreview,
    FEDERATION_REWARDS,
    SPACESHIP_FEDERATION_REWARDS,
    GLEENS_FEDERATION_REWARD,
    canTaklonsSpendUsingBrain,
    canSpendTaklonsPowerWithoutBrain,
    getFinalMissionValue,
    getFinalMissionVpProjected,
} from '@shared/gameConfig';

export type BotAction = {
    type: 'build_mine' | 'upgrade_structure' | 'advance_research' | 'pass_round'
    | 'charge_power' | 'place_starting_mine' | 'select_faction' | 'select_bonus'
    | 'end_turn'
    | 'use_power_action'
    | 'place_ivits_space_station'
    | 'place_lost_planet'
    | 'use_ship_action'
    | 'eclipse_build_asteroid_mine'
    | 'eclipse_advance_track'
    | 'select_tech_tile'
    | 'select_advanced_tech_tile'
    | 'cover_advanced_tech_tile'
    | 'advance_tech'
    | 'skip_ship_tech_mine'
    | 'form_federation'
    | 'burn_power'
    | 'convert_resource'
    | 'use_hadsch_hallas_pi_action'
    | 'bescods_advance_lowest'
    | 'ambas_swap_pi_mine'
    | 'enter_spaceship'
    | 'use_tech_action'
    | 'use_special_action'
    | 'firaks_downgrade'
    | 'use_bonus_action'
    | 'place_gaiaformer'
    | 'take_twilight_artifact'
    | 'confirm_twilight_federation'
    | 'skip_tfmars_gaia_project'
    | 'bal_tak_gaiaformer_to_qic';
    params: any;
    /** 프리 액션을 먼저 실행한 뒤 메인 액션 (예: 2O→2토큰 후 연방) */
    preActions?: BotAction[];
};

// ===== [정책망 prior] 사람 모방 학습 정책망 로드 — 알파고식 후보 prior용 =====
// MLP(policyNetMLP.json, arch:'mlp', 검증 top-1 30.9%/top-3 59.9%) 우선, 없으면 선형(policyNet.json, 25.6%) 폴백.
type PolicyNet = { labels: string[]; featDim?: number; arch?: string;
    W?: number[][]; // 선형: 19×(26+bias)
    W1?: number[][]; b1?: number[]; W2?: number[][]; b2?: number[]; // MLP: W1 H×26, b1 H, W2 19×H, b2 19
};
let _policyNet: PolicyNet | null = null;
let _policyTried = false;
function loadPolicyNet(): PolicyNet | null {
    if (_policyTried) return _policyNet;
    _policyTried = true;
    try {
        _policyNet = JSON.parse(nodeFs.readFileSync('server/ai/policyNetMLP.json', 'utf8'));
    } catch {
        try { _policyNet = JSON.parse(nodeFs.readFileSync('server/ai/policyNet.json', 'utf8')); }
        catch { _policyNet = null; }
    }
    return _policyNet;
}
const POLICY_NONPLANET = new Set(['space', 'deep_space', 'lost_fleet_ship', 'ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse', 'asteroid', 'proto', 'gaia']);
const POLICY_SHIP = new Set(['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse']);

export class BotLogic {
    private static getTrackForTechTile(game: ServerGameState, techTileId: string): ResearchTrack | null {
        for (const [trackId, trackTiles] of Object.entries(game.techTilesByTrack || {})) {
            const tiles = Array.isArray(trackTiles) ? trackTiles : (trackTiles ? [trackTiles] : []);
            if (tiles.some(tile => tile?.id === techTileId)) {
                return trackId as ResearchTrack;
            }
        }
        return null;
    }

    /** server/gameState.ts executeEnterSpaceship와 동일한 규칙(동기 버전) */
    private static canEnterSpaceship(game: ServerGameState, playerId: string, shipTileId: string, qicToUse: number): boolean {
        if (game.hasDoneMainAction) return false;
        if (game.currentPhase !== 'main') return false;
        if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;

        const player = game.players[playerId];
        if (!player) return false;

        const tile = game.map.find(t => t.id === shipTileId);
        const shipTypes = ['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'];
        if (!tile || !shipTypes.includes(tile.type || '')) return false;

        // server는 game.spaceships가 없으면 생성하지만, "부분 초기화" 상태(객체는 있는데 키가 없음)는 실패함
        const shipState = game.spaceships?.[shipTileId];
        if (game.spaceships && !shipState) return false;

        const entered = player.spaceshipsEntered || [];
        if (entered.length >= 3) return false;
        if (entered.includes(shipTileId)) return false;

        const entryCost = player.faction === 'bal_tak' ? 7 : 5;
        if ((player.score || 0) < entryCost) return false;

        // Itars/Nevlas: token 1개 필요
        if (player.faction === 'itars' || player.faction === 'nevlas') {
            const total = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);
            if (total < 1) return false;
        }

        // [SHIPREJ 미러수정 2026-07-05] 타클론: 브레인이 가이아 영역이면 서버가 입장 거부(3건/40판 실패 원인)
        if (player.faction === 'taklons' && (player as any).brainStoneInGaia) return false;

        // 거리/QIC 체크 (AI는 useRangeBonus를 쓰지 않으므로 baseRange만)
        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        if (myPlanets.length === 0) return false;

        // [SHIPREJ 미러수정 2026-07-05] getEffectiveBaseRange는 rangeBonusActive(+3)를 포함하지만 후보가
        // useRangeBonus를 안 보내 서버는 미포함 → '사거리 부족' 4건/40판. 서버와 동일하게 그 몫을 제외.
        const baseRange = this.getEffectiveBaseRange(player) - (player.rangeBonusActive ? 3 : 0);
        const minDist = Math.min(...myPlanets.map(t => getDistance(t, tile)));
        const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
        if (qicToUse < neededQIC) return false;
        // [flag: balTakShipQic] 발타크는 입장 거리 QIC도 포머→QIC 프리액션으로 충당 가능(PI 전 Nav 불가라 점프 의존)
        const entryQicAvail = (player.faction === 'bal_tak' && getPlayerFlag(playerId, 'balTakShipQic', true))
            ? this.getAvailableQic(player) : (player.qic || 0);
        if (entryQicAvail < qicToUse) return false;

        return true;
    }

    /** server/gameState.ts executeUseShipAction와 동일한 규칙(동기 버전) */
    private static canUseShipAction(
        game: ServerGameState,
        playerId: string,
        shipTileId: string,
        actionIndex: number,
        targetTileId?: string
    ): boolean {
        if (!game || game.currentPhase !== 'main') return false;
        if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;

        const player = game.players[playerId];
        if (!player) return false;
        const shipTile = game.map.find(t => t.id === shipTileId);
        const shipTypes = ['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'];
        if (!shipTile || !shipTypes.includes(shipTile.type || '')) return false;

        const shipState = game.spaceships?.[shipTileId];
        if (!shipState || !(shipState.occupants || []).includes(playerId)) return false;

        const usedIndices = (shipState.usedActionIndices ?? (shipState.actionsUsed != null ? [] : [])) as number[];
        if (usedIndices.includes(actionIndex) || usedIndices.length >= 3) return false;

        // [flag: balTakShipQic] 발타크는 미사용 포머→QIC 프리액션(bal_tak_gaiaformer_to_qic)으로 QIC 액션을
        // 지불 가능(사용자 지적: 포머→QIC→리벨리온 3정큐가 봇 후보에 없었음). 유효 QIC = 지갑 + 미사용 포머.
        // 실행 시엔 findSpaceshipActions가 부족분만큼 변환 preActions를 붙여 지갑을 먼저 채움.
        const qicAvail = (player.faction === 'bal_tak' && getPlayerFlag(playerId, 'balTakShipQic', true))
            ? this.getAvailableQic(player) : (player.qic ?? 0);
        // [flag: shipActionBurn] 번(2토큰→1P3) preActions가 실행 전에 붙으므로 유효 P3 = 현재 + floor(bowl2/2)
        const p3Avail = (getPlayerFlag(playerId, 'shipActionBurn', false) && player.faction !== 'taklons')
            ? (player.power3 ?? 0) + Math.floor((player.power2 ?? 0) / 2) : (player.power3 ?? 0);

        // --- Twilight ---
        if (shipTile.type === 'ship_twilight') {
            if (actionIndex === 1) {
                return qicAvail >= 3;
            }
            if (actionIndex === 2) {
                if (!targetTileId) return false;
                const target = game.map.find(t => t.id === targetTileId);
                if (!target || target.ownerId !== playerId || target.structure !== 'trading_station') return false;
                // [버그수정 2026-07-08] 연구소 상한(3) 도달 시 후보 제외 — 서버가 거부하는 액션을 안 내게(매안 연구소 4개 버그).
                if (getStructureCount(game, playerId, 'research_lab') >= BUILDING_LIMITS.research_lab) return false;
                return (player.ore ?? 0) >= 2 && p3Avail >= 3;
            }
            if (actionIndex === 3) {
                return (player.knowledge ?? 0) >= 1;
            }
            return false;
        }

        // --- Rebellion ---
        if (shipTile.type === 'ship_rebellion') {
            if (actionIndex === 1) {
                if (qicAvail >= 3) return true;
                // [flag: rebellionBurnQic] 번(≤2)+4P→1Q 변환으로 3정큐 완성하는 체인(preActions가 먼저 실행됨)
                return getPlayerFlag(playerId, 'rebellionBurnQic', true) && player.faction !== 'taklons'
                    && (player.qic ?? 0) === 2
                    && ((player.power3 ?? 0) + Math.floor((player.power2 ?? 0) / 2)) >= 4
                    && Math.max(0, 4 - (player.power3 ?? 0)) <= 2;
            }
            if (actionIndex === 2) {
                const tid = targetTileId != null ? String(targetTileId) : '';
                if (!tid) return false;
                const target = game.map.find(t => t.id === tid || String(t.id) === tid);
                if (!target || target.ownerId !== playerId || target.structure !== 'mine') return false;
                // [버그수정 2026-07-08] 교역소 상한(4) 도달 시 후보 제외 (리벨 mine→TS, 우주선 경로 상한 누락 교정).
                if (getStructureCount(game, playerId, 'trading_station') >= BUILDING_LIMITS.trading_station) return false;
                return (player.ore ?? 0) >= 1 && p3Avail >= 3;
            }
            if (actionIndex === 3) {
                return (player.knowledge ?? 0) >= 2;
            }
            return false;
        }

        // --- TF Mars ---
        if (shipTile.type === 'ship_tf_mars') {
            if (actionIndex === 1) {
                return qicAvail >= 2;
            }
            if (actionIndex === 2) {
                if (p3Avail < 2) return false;
                if ((player.gaiaformers ?? 0) <= 0) return false;
                // 2P→가이아 프로젝트(즉시 포밍) 후 이어질 가이아포머 배치가 실제로 가능해야 함
                return this.findGaiaformerActions(game, playerId).length > 0;
            }
            if (actionIndex === 3) {
                if ((player.credits ?? 0) < 3) return false;
                // 3C→1스텝 후 광산: 연계 체인이므로 Nav+영구만(임시 네비 미포함, findBuildActionsWithPendingSteps와 동일)
                const oldSteps = player.pendingTerraformSteps || 0;
                player.pendingTerraformSteps = oldSteps + 1;
                // [flag: tfStepBuildSameTurn] 3C 차감까지 시뮬 → 3C 쓰고도 그 턴에 실제로 광산을 지을 수 있을 때만 TF-3C 허용.
                //   (안 그러면 3C 쓰고 자원이 모자라 그 턴엔 못 짓고, 스텝만 들고 다른 메인 액션 → 나중 턴에 건설. 사용자 관찰)
                const simSpend = getPlayerFlag(playerId, 'tfStepBuildSameTurn', true);
                const oldCredits = player.credits ?? 0;
                if (simSpend) player.credits = oldCredits - 3;
                const canFinish = this.findBuildActionsWithPendingSteps(game, playerId).length > 0;
                player.pendingTerraformSteps = oldSteps;
                if (simSpend) player.credits = oldCredits;
                return canFinish;
            }
            return false;
        }

        // --- Eclipse ---
        if (shipTile.type === 'ship_eclipse') {
            if (actionIndex === 1) {
                return qicAvail >= 2;
            }
            if (actionIndex === 2) {
                return (player.knowledge ?? 0) >= 2 && p3Avail >= 3;
            }
            if (actionIndex === 3) {
                if ((player.credits ?? 0) < 6) return false;
                return peekEclipseAsteroidMineTileIds(game, playerId).length > 0;
            }
            return false;
        }

        return false;
    }

    /** [shipActionDiag] 계측: 우주선 액션별 자원 병목 사유. 'ELIG'(자원·타깃 충족) 또는 'BLK:<자원>'. */
    private static shipActionStatus(game: ServerGameState, playerId: string, shipType: string, i: number): string {
        const p = game.players[playerId]; if (!p) return '?';
        const q = p.qic ?? 0, o = p.ore ?? 0, k = p.knowledge ?? 0, c = p.credits ?? 0, p3 = p.power3 ?? 0, gf = p.gaiaformers ?? 0;
        if (shipType === 'ship_twilight') {
            if (i === 1) return q >= 3 ? 'ELIG' : 'qic3';
            if (i === 2) { if (!game.map.some(t => t.ownerId === playerId && t.structure === 'trading_station')) return 'noTS'; if (o < 2) return 'ore2'; if (p3 < 3) return 'pw3'; return 'ELIG'; }
            if (i === 3) return k >= 1 ? 'ELIG' : 'know1';
        } else if (shipType === 'ship_rebellion') {
            if (i === 1) return q >= 3 ? 'ELIG' : 'qic3';
            if (i === 2) { if (!game.map.some(t => t.ownerId === playerId && t.structure === 'mine')) return 'noMine'; if (o < 1) return 'ore1'; if (p3 < 3) return 'pw3'; return 'ELIG'; }
            if (i === 3) return k >= 2 ? 'ELIG' : 'know2';
        } else if (shipType === 'ship_tf_mars') {
            if (i === 1) return q >= 2 ? 'ELIG' : 'qic2';
            if (i === 2) { if (p3 < 2) return 'pw2'; if (gf <= 0) return 'noGaiaformer'; if (this.findGaiaformerActions(game, playerId).length === 0) return 'noGfTarget'; return 'ELIG'; }
            if (i === 3) return c >= 3 ? 'ELIG' : 'cred3';
        } else if (shipType === 'ship_eclipse') {
            if (i === 1) return q >= 2 ? 'ELIG' : 'qic2';
            if (i === 2) { if (k < 2) return 'know2'; if (p3 < 3) return 'pw3'; return 'ELIG'; }
            if (i === 3) { if (c < 6) return 'cred6'; if (peekEclipseAsteroidMineTileIds(game, playerId).length === 0) return 'noAsteroid'; return 'ELIG'; }
        }
        return '?';
    }

    static async performAction(io: SocketIOServer, game: ServerGameState, action: BotAction, playerId: string): Promise<boolean> {
        const nested = (action as any).preActions as BotAction[] | undefined;
        if (nested?.length) {
            for (const pre of nested) {
                const ok = await this.performAction(io, game, pre, playerId);
                if (!ok) return false;
            }
            return this.performAction(io, game, { type: action.type, params: action.params } as BotAction, playerId);
        }

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
                // 공용 함수로 위임 (파워 제안/연방/점수 처리 일치 — 봇 인라인 경로의 파워 미지급 버그 수정)
                const ok = executePlaceLostPlanet(io, game, playerId, action.params.tileId, action.params.qicToSpend);
                if (ok) game.hasDoneMainAction = true;
                return ok;
            }
            case 'use_ship_action':
                return executeUseShipAction(io, game, playerId, action.params.shipTileId, action.params.actionIndex, action.params.targetTileId);
            case 'bescods_advance_lowest':
                return executeBotBescodsAdvanceLowestTrack(io, game, playerId);
            case 'ambas_swap_pi_mine':
                return executeBotAmbasSwapPiMine(io, game, playerId, action.params.mineTileId);
            case 'enter_spaceship':
                {
                    // [계측 SHIPREJ 2026-07-04] enter_spaceship 실패 155건/일 — 서버 거부사유(문자열)를 버리지 말고 로그
                    const shipErr = executeEnterSpaceship(io, game, playerId, action.params.tileId, action.params.useRangeBonus, action.params.qicToUse);
                    if (shipErr !== null && !game.simulation) log(`[SHIPREJ] ${playerId} ${action.params.tileId}: ${shipErr}`, 'error', game.id);
                    return shipErr === null;
                }
            case 'eclipse_advance_track': {
                // [hang 근본수정] pendingEclipseResearch 해소 — 실패 시 취소 폴백(자원 롤백, 교착 방지)
                const okAdv = executeEclipseAdvanceTrack(io, game, playerId, action.params.trackId);
                if (!okAdv) return executeCancelEclipseResearch(io, game, playerId);
                return true;
            }
            case 'eclipse_build_asteroid_mine':
                return executeEclipseBuildAsteroidMine(io, game, playerId, action.params.tileId);
            case 'convert_resource':
                return executeConvertResource(io, game, playerId, action.params.type, action.params.useBrain);
            case 'use_hadsch_hallas_pi_action':
                return executeUseHadschHallasPIAction(io, game, playerId, action.params.actionId);
            case 'charge_power':
                return false;
            case 'end_turn':
                return executeEndTurn(io, game, playerId);
            case 'select_tech_tile':
                // executeSelectTechTile는 조건 불충족 시 조기 return 하고 pendingTechTileSelection을 clear하지 않습니다.
                // 따라서 호출 뒤 pending이 실제로 해제됐는지로 성공 여부를 판단합니다.
                executeSelectTechTile(io, game, playerId, action.params.techTileId, action.params.trackId, action.params.advanceToLevel5);
                return game.pendingTechTileSelection === null;
            case 'select_advanced_tech_tile':
                return executeSelectAdvancedTechTile(io, game, playerId, action.params.advancedTileId, action.params.trackId);
            case 'cover_advanced_tech_tile':
                return executeCoverAdvancedTechTile(io, game, playerId, action.params.coverTileId);
            case 'advance_tech':
                return executeAdvanceTech(io, game, playerId, action.params.trackId);
            case 'skip_ship_tech_mine': {
                const player = game.players[playerId];
                if (!player || game.pendingShipTechMine?.playerId !== playerId) return false;
                game.pendingShipTechMine = null;
                player.pendingTerraformSteps = 0;
                player.nextMineFreeFromShipTech = false;
                game.pendingShipTechTrackAdvance = { playerId };
                log(`Bot ${player.name} skipped Ship Tech 2TF+Mine fallback because no legal mine target was available`, 'game', game.id);
                io.to(game.id).emit('game_updated', game);
                return true;
            }
            case 'form_federation':
                return executeBotFederation(io, game, playerId, action.params.selectedHexIds, action.params.selectedPlanetIds, action.params.rewardId, action.params.spentTokens);
            case 'burn_power':
                executeBurnPower(game, playerId, action.params.moveBrainToBowl3);
                return true;
            case 'place_gaiaformer':
                return executePlaceGaiaformer(io, game, playerId, action.params.tileId, action.params.qicUsed);
            case 'skip_tfmars_gaia_project':
                return executeSkipTfmarsGaiaProject(io, game, playerId);
            case 'take_twilight_artifact':
                return executeTakeTwilightArtifact(io, game, playerId, action.params.artifactId);
            case 'confirm_twilight_federation':
                return executeConfirmTwilightFederation(io, game, playerId, action.params.rewardId);
            case 'use_tech_action':
                return executeUseTechAction(io, game, playerId, action.params.tileId);
            case 'use_special_action':
                return executeUseSpecialAction(io, game, playerId, action.params.actionId);
            case 'firaks_downgrade':
                return executeFiraksDowngrade(game, playerId, action.params.tileId, action.params.trackId);
            case 'use_bonus_action':
                return executeUseBonusAction(io, game, playerId);
            case 'bal_tak_gaiaformer_to_qic':
                return executeBalTakGaiaformerToQic(io, game, playerId);
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

        if (game.currentPhase === 'factionBidding') {
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
            if (game.pendingTwilightFederation?.playerId === playerId) {
                const rewardId = this.getBestTwilightFederationRewardId(game, playerId);
                return rewardId ? { type: 'confirm_twilight_federation', params: { rewardId } } : null;
            }

            // Eclipse 소행성 광산 배치 대기 중
            if (game.pendingEclipseAsteroidMine?.playerId === playerId) {
                return this.findEclipseAsteroidTarget(game, playerId);
            }

            // [hang 근본수정 2026-07-05] Eclipse 연구트랙 선택 대기 — 봇 미처리로 교착이던 것(p2ze7cmd). 최선 트랙 선택, 불가 시 취소.


            if (game.pendingEclipseResearch?.playerId === playerId) {


                const elTracks = this.pickResearchTracks(game, player, playerId);


                const ALL_EL: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];


                const elPick = [...elTracks, ...ALL_EL].find(t => (player.research[t] ?? 0) < 5


                    && !(t === 'navigation' && player.faction === 'bal_tak' && !game.map.some(x => x.ownerId === playerId && x.structure === 'planetary_institute')));


                return { type: 'eclipse_advance_track', params: { trackId: elPick ?? 'economy' } };


            }


            // Nav 5 잊혀진 행성 배치 대기 중
            if (game.pendingLostPlanet?.playerId === playerId) {
                return this.findLostPlanetTarget(game, playerId);
            }

            if (game.pendingSpaceshipFedMine?.playerId === playerId) {
                const mineTarget = this.findSpaceshipFedMineTarget(game, playerId);
                if (mineTarget) return mineTarget;
            }

            // 기술 타일 선택 대기 중
            if (game.pendingTechTileSelection?.playerId === playerId) {
                return this.findTechTileAction(game, playerId, isSimulate);
            }

            // 우주선 기술(2TF+Mine) 또는 테라포밍 액션 등으로 단계가 남아있으면 반드시 건설을 완료해야 함 (다른 메인 액션 방지)
            if (game.pendingShipTechMine?.playerId === playerId || (player.pendingTerraformSteps || 0) > 0) {
                const pendingBuilds = this.findBuildActionsWithPendingSteps(game, playerId);
                if (pendingBuilds.length === 1) return pendingBuilds[0];
                if (pendingBuilds.length > 1) {
                    // [hang 근본수정 2026-07-12 2dezwrnl] 시뮬 클론이 여기서 MCTS를 또 돌림 — MCTS-in-MCTS 재귀.
                    // 시뮬 내 await는 전부 즉시-resolve라 마이크로태스크만 폭주 → setTimeout(15s 레이스 포함)이
                    // 실행 기회를 아예 못 얻어 워커 프로세스 통째 동결(2TF+Mine 획득 직후 5후보에서 재현).
                    // main 경로(candidates.length>1의 isSimulate 분기)와 동일하게 시뮬에선 그리디 선택.
                    if (isSimulate) return pendingBuilds[0];
                    // [로그오염 수정 2026-07-05] MCTS 시뮬 클론도 이 경로를 타는데 simulation 가드가 없어
                    // 게임파일에 초당 수회 스팸(hang처럼 보임 + 진짜 원인 가림) → 가드 추가
                    log(`Bot ${player.name} must complete pending build with ${pendingBuilds.length} candidates...`, 'game', game.id, { simulation: (game as any).simulation });
                    return await this.mctsWithTimeout(game, playerId, pendingBuilds, 'pendingBuilds');
                }
                // 만약 건설할 곳이 없다면 무효 advance_tech 반복 대신 pending을 정리한다.
                if (game.pendingShipTechMine?.playerId === playerId) return { type: 'skip_ship_tech_mine', params: {} };
            }

            // TF Mars/보너스 가이아 프로젝트(가이아포머 배치 또는 스킵) 대기 중
            if (game.pendingTFMarsGaiaProject?.playerId === playerId) {
                const gaiaActions = this.findGaiaformerActions(game, playerId);
                if (gaiaActions.length > 0) return gaiaActions[0];
                return { type: 'skip_tfmars_gaia_project', params: {} };
            }

            // 고급 기술 커버/트랙 전진 대기: end_turn은 서버에서 거부되므로 먼저 처리
            if (game.pendingAdvancedTechCover?.playerId === playerId) {
                const p = game.players[playerId];
                const covered = new Set(p?.coveredTechTiles ?? []);
                const coverTileId = (p?.techTiles ?? []).find((tid: string) => !covered.has(tid)) ?? (p?.techTiles?.[0] ?? null);
                if (coverTileId) return { type: 'cover_advanced_tech_tile', params: { coverTileId } };
            }
            if (game.pendingAdvancedTechTrackAdvance?.playerId === playerId) {
                const p = game.players[playerId];
                if (p) {
                    const tracks = this.pickResearchTracks(game, p, playerId);
                    if (tracks.length > 0) return { type: 'advance_tech', params: { trackId: tracks[0] } };
                }
            }

            // 이미 메인 액션을 수행했다면 턴 종료 (단, 추가 행동이 대기 중이면 예외)
            if (game.hasDoneMainAction) {
                // 파워 액션, 보너스 액션, 우주선 액션 등으로 테라포밍 스텝이나 추가 행동을 얻었을 경우
                // 후속 조치를 취해야 하므로 바로 턴을 종료하면 안 됨.
                if ((player.pendingTerraformSteps || 0) > 0) {
                    const builds = this.findBuildActionsWithPendingSteps(game, playerId);
                    if (builds.length > 0) return builds[0];
                }

                // [flag: hhConvertAfterMain] 실게임 복기(2026-07-12 ofhfvztt HH): R3 PI 건설(메인 소모) 직후
                // 18C 든 채 end_turn — 변환 체크(~880)가 이 조기 반환 뒤라 '메인 후 무료 변환' 기회가 없어
                // 한 라운드 지연(R3에 변환했으면 q4로 당라운드 3정큐 가능). 턴 종료 전 변환 소진.
                if (getPlayerFlag(playerId, 'hhConvertAfterMain', true) && !getPlayerFlag(playerId, 'hhJitConvert', true)) {
                    const hhPost = this.findHadschHallasConvert(game, playerId);
                    if (hhPost) { log(`Bot ${player.name} HH PI convert (post-main): ${(hhPost.params as any)?.actionId}`, 'game', game.id); return hhPost; }
                }

                // 그 외 추가 액션(예: 글린 네비게이션 보너스 사용 등 프리액션)을 할 게 있으면 수행
                const special = this.findSpecialActions(game, playerId);
                if (special.length > 0) return special[0];

                // [flag: taklonsSpendIdleBrain] ★올바른 훅: 메인액션 후 턴종료 직전 = 브레인 idle이 실제 생기는 지점.
                //   타클론 브레인이 bowl3에 놀고 있으면 3P→1O(useBrain)로 써서 재활용(매턴 쓰고 충전복귀=타클론 엔진, 사용자).
                //   이전 시도는 pre-pass에만 넣어(패스때만) idle을 못 잡았음. 여기선 end_turn 전마다 발동 → 실제 idle 감소.
                // [철회 2026-07-14] taklonsBrainHuman 맹목 지출(1O)은 커플링 콤보로 대체 — 원 플래그(OFF)만 보존.
                if (getPlayerFlag(playerId, 'taklonsSpendIdleBrain', false) && player.faction === 'taklons'
                    && player.brainStoneBowl === 3 && !player.brainStoneInGaia) {
                    log(`Bot ${player.name} taklonsSpendIdleBrain(turn-end): 브레인 3P→1O 재활용`, 'game', game.id);
                    return { type: 'convert_resource', params: { type: '3power-to-1ore', useBrain: true } };
                }

                return { type: 'end_turn', params: {} };
            }

            // MCTS 켜기 (후보군 탐색)
            const candidates = this.getCandidateMoves(game, playerId);
            if (candidates.length === 1) {
                const onlyAction = candidates[0];
                if (onlyAction.type === 'pass_round') {
                    const cleanup = this.findCleanupConvertAction(game, playerId, onlyAction.params?.bonusTileId);
                    if (cleanup) {
                        log(`Bot ${player.name} performs cleanup convert before passing: ${cleanup.params.type}`, 'game', game.id);
                        return cleanup;
                    }
                }
                return onlyAction;
            }
            if (candidates.length > 1) {
                if (isSimulate) {
                    // 시뮬레이션 다양성 확보: 상위 후보 중 가중 랜덤 (롤아웃 품질 개선)
                    const r = Math.random();
                    if (candidates.length >= 3 && r < 0.10) return candidates[2];
                    if (candidates.length >= 2 && r < 0.30) return candidates[1];
                    return candidates[0];
                }
                // [flag: buildOrderPlanner] 빌드오더 플래너 — 연방 목표 라운드 스케일링.
                // 데이터: 봇 연방 1~2 vs 사람 3~4. MCTS는 얕은 시야로 연방 형성(위성+보상=다단계)을
                // 자주 놓침. getBestFederationAction이 품질 게이트(가치 없으면 null)이므로, 목표 미달이고
                // 좋은 연방이 가능하면 MCTS를 건너뛰고 즉시 형성한다.
                if (getPlayerFlag(playerId, 'buildOrderPlanner', false)) {
                    const myFeds = ((player as any).federations?.length ?? (player as any).federationTokens?.length ?? 0) as number;
                    const round = (game as any).roundNumber ?? 1;
                    // 라운드별 목표 연방 수 (사람 수준 3~4). 초반엔 무리하지 않음.
                    const fedTarget = round <= 2 ? 1 : round === 3 ? 2 : round === 4 ? 3 : 4;
                    if (myFeds < fedTarget) {
                        const fed = FederationPlanner.getBestFederationAction(game, playerId);
                        if (fed) {
                            log(`Bot ${player.name} buildOrder: form federation (feds=${myFeds}/${fedTarget}, round=${round})`, 'game', game.id);
                            return { type: 'form_federation', params: fed };
                        }
                    }
                }
                // [flag: humanFedCommit] 사용자 목표(2026-07-12): "못해도 2개, 평균 3개". 셀프플레이에선 강제 형성이
                // VP −2~4로 기각됐으나(재료 null 케이스), 사용자 명시 목표가 연방 수를 우선함 + 사람 게임은 리치
                // 경제로 재료 여건이 다름 → 사람 있는 게임에서만: R4+에 연방<2면, R5+에 연방<3이면 플래너가 찾는
                // 즉시 형성을 MCTS보다 우선. 플래너 품질게이트는 유지(무리수는 플래너가 안 냄). 셀프플레이 무오염.
                if (getPlayerFlag(playerId, 'humanFedCommit', false) && !game.hasDoneMainAction) {
                    const hasHumanOppF = (game.botPlayerIds?.length ?? 0) < Object.keys(game.players).length
                        || getPlayerFlag(playerId, 'humanFedCommitForce', false); // Force = 검증 전용
                    const rF = game.roundNumber ?? 1;
                    if (hasHumanOppF && rF >= 4) {
                        const myFedsF = getFederationEntries(player).length;
                        const fedTargetF = rF >= 5 ? 3 : 2;
                        if (myFedsF < fedTargetF) {
                            const fedF = FederationPlanner.getBestFederationAction(game, playerId);
                            if (fedF) {
                                log(`Bot ${player.name} humanFedCommit: 연방 강제 형성 (feds ${myFedsF}<${fedTargetF}, R${rF})`, 'game', game.id);
                                return { type: 'form_federation', params: fedF };
                            }
                        }
                    }
                }
                // [flag: scriptedStrategy] 다턴 실행 우회: MCTS가 얕은 시야로 "지금 연방 형성"을 자주 놓침
                // (로그: 연방1개 봇의 33%가 파워≥7인데 2번째 미형성). 형성 가능 + 연방<2면 MCTS 건너뛰고 즉시 형성.
                if (getPlayerFlag(playerId, 'scriptedStrategy', false)) {
                    const myFeds = ((player as any).federations?.length ?? (player as any).federationTokens?.length ?? 0) as number;
                    if (myFeds < 2) {
                        const fed = FederationPlanner.getBestFederationAction(game, playerId);
                        if (fed) {
                            log(`Bot ${player.name} scripted: force form federation (feds=${myFeds})`, 'game', game.id);
                            return { type: 'form_federation', params: fed };
                        }
                    }
                }
                // [flag: earlyDigResearch] 실측(2026-07-07): 테라포밍 L1 도달 사람 R2.3(25명) vs 봇 R3.8(5명뿐),
                // 가이아 L1 사람 R2.1 vs 봇 R3.5 — 삽·포머가 1.5R 늦어 지을 행성 풀이 작음(사용자 진단 ②) →
                // 광산부족→LOW_POWER→연방부족의 상류. 평가기 nudge는 MCTS가 덮으므로(반복 확인) humanRule 계열
                // 직접-return: R2-3, 지식 4+, 해당 트랙 L0이고 '그 연구가 실제로 여는 대상'이 있으면 연구 강제.
                // [flag: researchYieldBuild] 반사실 복기(2026-07-14, 122결정): 최대 후회 패턴 = 연구 직접-return이
                // 강한 건설(의회 +36VP·포머 배치 +27VP·성숙가이아)보다 먼저 실행돼 선점. 연구 강제는 의회/아카
                // 가능·성숙 포머 광산·포머 배치 가능 상태에선 양보(그 건설들이 반사실 실측 우위).
                const strongBuildNow = getPlayerFlag(playerId, 'researchYieldBuild', true) && (() => {
                    try {
                        if (this.findUpgradeActions(game, playerId).some(a => {
                            const t = (a.params as any)?.target ?? '';
                            return t === 'planetary_institute' || String(t).startsWith('academy');
                        })) return true;
                        if ((player.pendingGaiaformerTiles?.length ?? 0) > 0) return true; // 성숙 포머 = 즉시 광산
                        if (this.findGaiaformerActions(game, playerId).length > 0) return true; // 포머 배치 가능
                    } catch { /* 판정 실패 시 양보 안 함 */ }
                    return false;
                })();
                if (getPlayerFlag(playerId, 'earlyDigResearch', true) && !game.hasDoneMainAction && !strongBuildNow) {
                    const rr = game.roundNumber ?? 1;
                    const know = player.knowledge ?? 0;
                    const hasFedCand = candidates.some(c => c.type === 'form_federation');
                    if (rr >= 2 && rr <= 3 && know >= 4 && !hasFedCand) {
                        const myPl = game.map.filter(t => t.ownerId === playerId && t.structure);
                        const rng = this.getEffectiveBaseRange(player);
                        const nearEmpty = (pred: (t: HexTile) => boolean) => game.map.filter(t =>
                            !t.ownerId && !t.structure && t.type && pred(t)
                            && myPl.some(p => getDistance(p, t) <= rng + 2)).length;
                        // 테라포밍 L0 + 1~2삽 행성 2+개 근처 → 삽 연구
                        if ((player.research?.terraforming ?? 0) === 0 && player.faction !== 'gleens') {
                            const digTargets = nearEmpty(t => {
                                if (t.type === 'gaia' || t.type === 'transdim' || t.type === 'asteroid' || t.type!.startsWith('ship_') || t.type === 'space' || t.type === 'deep_space') return false;
                                const st = getTerraformStepsForFaction(game, player.faction!, t.type!);
                                return st >= 1 && st <= 2;
                            });
                            if (digTargets >= 2) {
                                log(`Bot ${player.name} earlyDigResearch: terraforming L1 강제 (R${rr}, 1-2삽 대상 ${digTargets})`, 'game', game.id);
                                return { type: 'advance_research', params: { trackId: 'terraforming' } };
                            }
                        }
                        // 가이아 L0(포머 0) + 트랜스딤 근처 2+개 → 가이아 연구 (L1=포머 1개)
                        if ((player.research?.gaiaProject ?? 0) === 0 && (player.gaiaformers ?? 0) === 0
                            && player.faction !== 'bal_tak') {
                            const tdTargets = nearEmpty(t => t.type === 'transdim' && !t.hasGaiaformer);
                            if (tdTargets >= 2) {
                                log(`Bot ${player.name} earlyDigResearch: gaiaProject L1 강제 (R${rr}, 트랜스딤 ${tdTargets})`, 'game', game.id);
                                return { type: 'advance_research', params: { trackId: 'gaiaProject' } };
                            }
                        }
                    }
                }
                // [flag: geodensDigCycle] 사용자 모델(2026-07-13): 기오덴 = "삽/거리 올려 빠른 확장 → 광석 →
                // K(+3K 새유형) → 다시 삽/거리" 순환. 실측(기오덴강제 20판): 상위7 삽+거리 합 7.4 vs 하위7 4.9,
                // 경제/과학은 무차이 — 순환 지속이 승부. earlyDigResearch(L0→L1 한정)의 기오덴 연장:
                // PI 보유 + 새 유형 1-2삽 대상이 남아있는 동안 삽 L3까지, 거리는 '새 유형이 새로 열릴 때' L4까지.
                // 새 유형 광산의 +3K = 연구비 4K의 75% 리베이트라 이 연구는 실질 염가(즉시·확정 보상 클래스).
                if (getPlayerFlag(playerId, 'geodensDigCycle', true) && player.faction === 'geodens'
                    && !game.hasDoneMainAction) {
                    const rg = game.roundNumber ?? 1;
                    const hasPIg = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
                    if (hasPIg && rg >= 2 && rg <= 4 && (player.knowledge ?? 0) >= 4
                        && !candidates.some(c => c.type === 'form_federation')) {
                        const myTypesG = getPlayerPlanetTypesForGeodens(game, playerId);
                        const myPlG = game.map.filter(t => t.ownerId === playerId && t.structure);
                        const rngG = getRange(player.research?.navigation ?? 0) + (player.navigationBonus || 0);
                        const newTypeDigTargets = (maxDist: number) => game.map.filter(t =>
                            !t.ownerId && !t.structure && t.type
                            && !['space', 'deep_space', 'transdim', 'asteroid', 'gaia'].includes(t.type) && !t.type.startsWith('ship_')
                            && !myTypesG.has(t.type)
                            && getTerraformStepsForFaction(game, player.faction!, t.type) >= 1
                            && getTerraformStepsForFaction(game, player.faction!, t.type) <= 2
                            && myPlG.some(p => getDistance(p, t) <= maxDist)).length;
                        const terraG = player.research?.terraforming ?? 0;
                        if (terraG < 3 && newTypeDigTargets(rngG + 2) >= 2) {
                            const act = this.advanceResearchAction(playerId, player, 'terraforming');
                            if (act) {
                                log(`Bot ${player.name} geodensDigCycle: 삽 L${terraG + 1} (새유형 1-2삽 ${newTypeDigTargets(rngG + 2)}개, R${rg})`, 'game', game.id);
                                return act;
                            }
                        }
                        const navG = player.research?.navigation ?? 0;
                        if (navG < 4) {
                            const rngNextG = getRange(navG + 1) + (player.navigationBonus || 0);
                            if (newTypeDigTargets(rngNextG + 2) > newTypeDigTargets(rngG + 2)) {
                                const act = this.advanceResearchAction(playerId, player, 'navigation');
                                if (act) {
                                    log(`Bot ${player.name} geodensDigCycle: 거리 L${navG + 1} (새유형 신규 개방, R${rg})`, 'game', game.id);
                                    return act;
                                }
                            }
                        }
                    }
                }
                // [flag: firaksEngineRush] 사람 빌드오더 실측(2026-07-14, 사람 파이락 11석): 성공 공식 = R1-2에
                // 랩+의회 완성 → 다운그레이드 5-6회/판 → 186-220점 (미완성 판은 33-73점). 봇은 랩 R1.5인데
                // PI R3.7(R2 이내 완성 1/31석) → 다운 0.94회 — 능력 엔진이 늦게 가동. R≤2에 자금 되는 즉시
                // 랩→PI 순서로 직접-return (upgradeOreConvert 광석 갭 변환은 후보 preActions가 처리).
                if (getPlayerFlag(playerId, 'firaksEngineRush', false) && player.faction === 'firaks'
                    && !game.hasDoneMainAction && (game.roundNumber ?? 1) <= 2
                    && !candidates.some(c => c.type === 'form_federation')) {
                    const hasPIf = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
                    if (!hasPIf) {
                        const upsF = candidates.filter(c => c.type === 'upgrade_structure');
                        const labF = game.map.some(t => t.ownerId === playerId && t.structure === 'research_lab');
                        if (labF) {
                            const piUp = upsF.find(c => (c.params as any)?.target === 'planetary_institute');
                            if (piUp) {
                                log(`Bot ${player.name} firaksEngineRush: 의회 직행 (랩 보유, R${game.roundNumber}) — 다운그레이드 엔진 가동`, 'game', game.id);
                                return piUp;
                            }
                        } else {
                            const labUp = upsF.find(c => (c.params as any)?.target === 'research_lab');
                            if (labUp) {
                                log(`Bot ${player.name} firaksEngineRush: 연구소 직행 (R${game.roundNumber}) — 의회 전 단계`, 'game', game.id);
                                return labUp;
                            }
                        }
                    }
                }
                // [flag: firaksLoopDrive] 사용자 목표(2026-07-15): "매라운드 3O5C 재건하며 다운그레이드" —
                // 사람 파이락 루프 = 다운(무비용 연구 전진, 라운드 1회) ↔ TS→랩 재건(3O5C, 기술타일 재수확).
                // 봇은 다운 후보만 있고(1.43/판) 재건 연결이 없어 루프 단절. ①다운 가능하면 최우선(연방 다음)
                // ②다운 사용 후 랩 0 + 3O5C면 재건 직접-return. firaksEngineRush(-6.9)와 달리 후보가 실존하는 직접-return.
                // [flag: advClaimDrive] 사용자 관찰(2026-07-15): R6에 12VP 연방 먹고 고급타일 자격이 생겼는데
                // 안 먹음. 실측(120게임): 480석 중 222석(46%)이 '초록+L4+미클레임 adv' 상태로 종료(adv 보유 26석).
                // 원인 = 클레임은 트리거(랩/아카 건설·리벨 3Q)의 기술타일 선택에서만 가능한데 R5-6에 트리거 부재.
                // 자격+좋은 adv(≥60) 시 트리거 직접-return: ①리벨 3Q(탑승·미사용·3Q) ②랩 건설 ③아카 건설.
                // 선택 단계의 adv 우선은 advTileAlways/OverL5가 이미 처리 — 여기선 문만 연다(순서강제 클래스).
                // [사용자 보완 2026-07-15] 초록은 L4→5 승급에도 소모 — 초록 1개 + L5 후보 존재 시 adv가
                // '정말 좋은 것'(≥85, advTileOverL5 기준)일 때만 트리거 강제, 아니면 L5에 양보.
                // 반대로 adv 길이 없으면(점수 미달·트리거 부재) R6에 초록을 썩히지 말고 L5 직행.
                if (process.env.ADVCLAIM_DIAG && !game.hasDoneMainAction && (game.roundNumber ?? 1) >= 5
                    && countGreenFederations(player) >= 1) {
                    try {
                        const rebD = game.map.find(t => t.type === 'ship_rebellion');
                        nodeFs.appendFileSync('data/advclaim-diag.jsonl', JSON.stringify({
                            r: game.roundNumber, fac: player.faction, greens: countGreenFederations(player),
                            adv: Math.round(this.bestClaimableAdvScore(game, playerId)),
                            fed: candidates.some(c => c.type === 'form_federation'),
                            lab: candidates.some(c => c.type === 'upgrade_structure' && (((c.params as any)?.target === 'research_lab') || String((c.params as any)?.target ?? '').startsWith('academy'))),
                            reb: !!(rebD && (player.spaceshipsEntered ?? []).includes(rebD.id) && !(game.spaceships?.[rebD.id]?.usedActionIndices ?? []).includes(1) && (player.qic ?? 0) >= 3),
                            l5: candidates.some(c => c.type === 'advance_research' && (player.research?.[(c.params as any)?.trackId as ResearchTrack] ?? 0) === 4),
                            k: player.knowledge ?? 0, ore: player.ore ?? 0, cr: player.credits ?? 0,
                        }) + '\n');
                    } catch { /* diag only */ }
                }
                if (getPlayerFlag(playerId, 'advClaimDrive', false) && !game.hasDoneMainAction
                    && (game.roundNumber ?? 1) >= 5
                    && countGreenFederations(player) >= 1
                    && !candidates.some(c => c.type === 'form_federation')) {
                    const greensAC = countGreenFederations(player);
                    const advScoreAC = this.bestClaimableAdvScore(game, playerId);
                    const l5Cand = candidates.find(c => c.type === 'advance_research'
                        && (player.research?.[(c.params as any)?.trackId as ResearchTrack] ?? 0) === 4);
                    const advWinsGreen = greensAC >= 2 || !l5Cand || advScoreAC >= 85;
                    if (advScoreAC >= 60 && advWinsGreen) {
                        const rebT2 = game.map.find(t => t.type === 'ship_rebellion');
                        if (rebT2 && (player.spaceshipsEntered ?? []).includes(rebT2.id)
                            && !(game.spaceships?.[rebT2.id]?.usedActionIndices ?? []).includes(1)
                            && (player.qic ?? 0) >= 3) {
                            log(`Bot ${player.name} advClaimDrive: 리벨 3Q 트리거 → 고급타일 클레임 (R${game.roundNumber})`, 'game', game.id);
                            return { type: 'use_ship_action', params: { shipTileId: rebT2.id, actionIndex: 1 } };
                        }
                        const labTrig = candidates.find(c => c.type === 'upgrade_structure'
                            && ((c.params as any)?.target === 'research_lab' || String((c.params as any)?.target ?? '').startsWith('academy')));
                        if (labTrig) {
                            log(`Bot ${player.name} advClaimDrive: ${(labTrig.params as any)?.target} 건설 트리거 → 고급타일 클레임 (R${game.roundNumber})`, 'game', game.id);
                            return labTrig;
                        }
                        // 트리거 후보 부재 — 아래 L5 폴백으로
                    }
                    if (l5Cand && (game.roundNumber ?? 1) >= 6) {
                        log(`Bot ${player.name} advClaimDrive: 초록→L5 승급 (${(l5Cand.params as any)?.trackId}, adv ${Math.round(advScoreAC)}점은 양보/불가, R${game.roundNumber})`, 'game', game.id);
                        return l5Cand;
                    }
                }
                // [flag: upgradeBeforeFed] 사용자 관찰(2026-07-15): 봇이 연방 형성 → 같은 라운드에 그 연방 안
                // 건물을 업글 — 순서만 바꾸면(업글 먼저 → 파워값 상승 → 연방) 같은 연방을 위성 덜 쓰고 만듦.
                // 계획된 연방에 포함될 타일의 업글 후보가 있고, what-if로 위성 절약이 확인되면 업글 선실행
                // (연방은 다음 턴 — 같은 라운드). 순서 교정 클래스(3연승 동형) + 정확 what-if라 추측 없음.
                // [v3 2026-07-15] v1(혼합 −4.28)·v2(광산→TS 한정 −5.28) 기각 — 단 의회/아카(TS→3파워) 셀은
                // 후보 구성상 격리 측정된 적 없음(사용자 지적). v3 = 의회/아카 업글만 + 절약 확인 + 대상 로깅.
                if (getPlayerFlag(playerId, 'upgradeBeforeFed', true) && !game.hasDoneMainAction) {
                    const fedCand = candidates.find(c => c.type === 'form_federation');
                    if (fedCand) {
                        const plannedIds = new Set<string>(((fedCand.params as any)?.selectedPlanetIds ?? []) as string[]);
                        const upsInFed = candidates.filter(c => {
                            if (c.type !== 'upgrade_structure' || !plannedIds.has((c.params as any)?.tileId)) return false;
                            const t = String((c.params as any)?.target ?? '');
                            return t === 'planetary_institute' || t.startsWith('academy');
                        });
                        if (upsInFed.length > 0) {
                            const beforeTok = this.getBestFederationSpentTokens(game, playerId);
                            for (const up of upsInFed) {
                                const tgtRaw = String((up.params as any)?.target ?? '');
                                const tgt = (tgtRaw.startsWith('academy') ? 'academy' : 'planetary_institute') as 'academy' | 'planetary_institute';
                                const afterTok = this.getBestFederationSpentTokensAfterUpgrade(game, playerId, (up.params as any).tileId, tgt);
                                if (beforeTok != null && afterTok != null && afterTok < beforeTok) {
                                    log(`Bot ${player.name} upgradeBeforeFed v3: ${tgt} 선실행(위성 ${beforeTok}→${afterTok}) 후 연방 (R${game.roundNumber})`, 'game', game.id);
                                    return up;
                                }
                            }
                        }
                    }
                }
                // [flag: firaksPiPriority] 사용자 목표(2026-07-15): PI 평균 R2 이하. 실측(ON 20석): 랩은 14/20이
                // R1 완성인데 R2에 4O6C가 모여도 MCTS가 의회 대신 딴 걸 골라 R3-5로 밀림(지연 그룹과 R2 그룹의
                // 차이는 오프닝이 아니라 'R2 의회 최우선' 여부뿐). 후보 실존+순서 강제 클래스(taklonsPowerFirst·
                // firaksLoopDrive 2연승 동형): 의회 후보가 자금상 실존하면 직접-return. (firaksEngineRush −6.9는
                // 후보 부재 상태의 랩 강제가 주범 — 이건 존재하는 의회 후보의 순서만 당김.)
                // [flag: darkTsFirst] 사용자 관찰(2026-07-15): 다카니안이 R1에 광산만 3-4개 짓고 패스.
                // 실측: R1 TS 확보율 다카니안 48% vs 타종족 94-100%, VP 최하위(74.5). 원인 = 7색 1스텝(2O 고정)
                // 광산 후보가 많아 시작 7O를 광산에 전소(색행성 3O/개) → TS(2O6C) 불가 → 기술 엔진 미진입.
                // 후보 실존+순서 강제: R1-2 & TS 0 & TS 업글 후보 실존 시 TS 직접-return(광산은 잔여 광석으로).
                if (getPlayerFlag(playerId, 'darkTsFirst', true) && player.faction === 'darkanians'
                    && !game.hasDoneMainAction && (game.roundNumber ?? 1) <= 2
                    && !candidates.some(c => c.type === 'form_federation')
                    && getStructureCount(game, playerId, 'trading_station') === 0) {
                    const tsFirst = this.findUpgradeActions(game, playerId)
                        .find(c => c.type === 'upgrade_structure' && (c.params as any)?.target === 'trading_station');
                    if (tsFirst) {
                        log(`Bot ${player.name} darkTsFirst: TS 최우선 (기술 엔진 진입, R${game.roundNumber})`, 'game', game.id);
                        return tsFirst;
                    }
                }
                // [flag: lantidsPiRush] 103게임 진단(2026-07-22): 사람 란티다 R1 의회 83%(평균 R1.7, 광산→TS→PI 체인,
                // 평균 165VP) vs 봇 PI 평균 R3.55·R1-2는 25%뿐(72VP, 종족 꼴찌) — r1PiCalib103으로 후보는 열렸으나
                // MCTS가 안 고름. 기생 수는 5.4≈사람 5.3으로 동일한데 PI가 늦어 기생 +2K 엔진의 절반을 버림.
                // darkTsFirst 동형(후보 실존+순서 강제): R≤2 & PI 미보유 시 ①PI 후보 실존(자금 포함)이면 PI 직접-return
                // ②TS가 없으면 TS 직접-return(체인 선행). firaksPiPriority(−6.40)·taklonsPiCommit(−1.70) 기각 이력
                // 주의 — 란티다는 기생 엔진 커플링이라 가치 구조가 다름. 측정으로 판정.
                // [v2 사용자 모델(2026-07-22)]: 맹목 강제가 아니라 사람의 판단 재현 — "의회를 지었을 때 1QIC(+2 사거리)로
                // 기생 타겟(상대 점유 행성) 2개 이상에 갈 수 있나"를 보고 러시 여부 결정. 타겟 <2면 러시 안 함(일반 플레이).
                // [flag: lantidsPiRushHuman] v2 기각(120판 −4.56 p=0.045)의 원인 = 봇끼리 리치 기근 환경. 사람 실측
                // (12석 83% R1 PI, 165VP)은 리치 풍부 환경의 정답이므로 fedSatCapHuman 패턴으로 '사람 있는 게임'에서만
                // 발동 — 셀프플레이 무오염, 실전(사람 게임)만 사람 정합. 발동 여부는 v1/v2 프로브로 행동 검증 완료.
                const lanRushHumanGame = getPlayerFlag(playerId, 'lantidsPiRushHuman', true)
                    && ((game.botPlayerIds?.length ?? 0) < Object.keys(game.players).length);
                if ((getPlayerFlag(playerId, 'lantidsPiRush', false) || lanRushHumanGame) && player.faction === 'lantids'
                    && !game.hasDoneMainAction && (game.roundNumber ?? 1) <= 2
                    && !candidates.some(c => c.type === 'form_federation')
                    && !game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')
                    && (() => {
                        const anchorsLan = game.map.filter(t =>
                            (t.ownerId === playerId && t.structure && t.structure !== 'ship') || t.parasiticMine?.ownerId === playerId);
                        const reachLan = this.getEffectiveBaseRange(player) + ((player.qic ?? 0) >= 1 ? 2 : 0);
                        const paraTargets = game.map.filter(t =>
                            t.ownerId && t.ownerId !== playerId && t.structure && t.structure !== 'ship'
                            && !t.parasiticMine && !String(t.type || '').startsWith('ship_')
                            && anchorsLan.some(a => getDistance(a, t) <= reachLan)).length;
                        return paraTargets >= 2;
                    })()) {
                    const upsLan = this.findUpgradeActions(game, playerId);
                    const piLan = upsLan.find(c => c.type === 'upgrade_structure' && (c.params as any)?.target === 'planetary_institute');
                    if (piLan) {
                        log(`Bot ${player.name} lantidsPiRush: 의회 최우선 (R${game.roundNumber}) — 기생 +2K 엔진 조기 가동`, 'game', game.id);
                        return piLan;
                    }
                    if (getStructureCount(game, playerId, 'trading_station') === 0) {
                        const tsLan = upsLan.find(c => c.type === 'upgrade_structure' && (c.params as any)?.target === 'trading_station');
                        if (tsLan) {
                            log(`Bot ${player.name} lantidsPiRush: TS 선행 (R${game.roundNumber}) — 광산→TS→PI 체인`, 'game', game.id);
                            return tsLan;
                        }
                    }
                }
                // [flag: taklonsPiCommit] 실측(2026-07-16): 봇 타클론 49석 중 21석(43%)이 PI 미건설(사람 6/6 건설,
                // 평균 R4.3). 타이밍이 아니라 커밋 자체가 문제 — 자금이 생겨도 MCTS가 계속 딴 걸 골라 영영 밀림.
                // PI = 토큰수입+브레인 엔진 강화라 타클론 필수 건물. firaksPiPriority 동형: R≤4 & PI 미보유 &
                // PI 후보 실존(자금 포함) 시 직접-return.
                if (getPlayerFlag(playerId, 'taklonsPiCommit', false) && player.faction === 'taklons'
                    && !game.hasDoneMainAction && (game.roundNumber ?? 1) <= 4
                    && !candidates.some(c => c.type === 'form_federation')
                    && !game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) {
                    const piTak = this.findUpgradeActions(game, playerId)
                        .find(c => c.type === 'upgrade_structure' && (c.params as any)?.target === 'planetary_institute');
                    if (piTak) {
                        log(`Bot ${player.name} taklonsPiCommit: 의회 최우선 (R${game.roundNumber}) — 브레인 엔진 커밋`, 'game', game.id);
                        return piTak;
                    }
                }
                // [flag: geodensPiAfterAcademy] 사용자 관찰(2026-07-15): 기오덴이 아카데미를 이미 지었으면
                // 2번째 TS 업그레이드는 의회여야 하는데 연구소를 지음(랩→아카 라인 완료 후 2번째 랩은 가치 하락 —
                // 의회 4O6C = 파워토큰·수입·연방파워3·종족능력). firaksPiPriority와 동형(후보 실존+순서 강제):
                // 아카 보유 + 의회 미보유 + 의회 후보 실존 시 직접-return.
                if (getPlayerFlag(playerId, 'geodensPiAfterAcademy', true) && player.faction === 'geodens'
                    && !game.hasDoneMainAction
                    && !candidates.some(c => c.type === 'form_federation')
                    && !game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')
                    && game.map.some(t => t.ownerId === playerId && t.structure === 'academy')) {
                    const piGeo = this.findUpgradeActions(game, playerId)
                        .find(c => c.type === 'upgrade_structure' && (c.params as any)?.target === 'planetary_institute');
                    if (piGeo) {
                        log(`Bot ${player.name} geodensPiAfterAcademy: 의회 최우선 (아카 보유, R${game.roundNumber})`, 'game', game.id);
                        return piGeo;
                    }
                }
                if (getPlayerFlag(playerId, 'firaksPiPriority', true) && player.faction === 'firaks'
                    && !game.hasDoneMainAction
                    && !candidates.some(c => c.type === 'form_federation')
                    && !game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')
                    && game.map.some(t => t.ownerId === playerId && t.structure === 'research_lab')) {
                    const piNow = this.findUpgradeActions(game, playerId)
                        .find(c => c.type === 'upgrade_structure' && (c.params as any)?.target === 'planetary_institute');
                    if (piNow) {
                        log(`Bot ${player.name} firaksPiPriority: 의회 최우선 (랩 보유, R${game.roundNumber}) — 다운그레이드 엔진 개통`, 'game', game.id);
                        return piNow;
                    }
                }
                if (getPlayerFlag(playerId, 'firaksLoopDrive', true) && player.faction === 'firaks'
                    && !game.hasDoneMainAction
                    && !candidates.some(c => c.type === 'form_federation')
                    && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) {
                    const fdLoop = this.findFiraksDowngradeAction(game, playerId);
                    if (fdLoop) {
                        log(`Bot ${player.name} firaksLoopDrive: 다운그레이드 (무비용 연구, R${game.roundNumber})`, 'game', game.id);
                        return fdLoop;
                    }
                    if ((player.usedSpecialActions ?? []).includes('firaks-downgrade')
                        && !game.map.some(t => t.ownerId === playerId && t.structure === 'research_lab')
                        && (player.ore ?? 0) >= 3 && (player.credits ?? 0) >= 5) {
                        const labRebuild = this.findUpgradeActions(game, playerId)
                            .find(c => c.type === 'upgrade_structure' && (c.params as any)?.target === 'research_lab');
                        if (labRebuild) {
                            log(`Bot ${player.name} firaksLoopDrive: 랩 재건 3O5C (기술타일 재수확, R${game.roundNumber})`, 'game', game.id);
                            return labRebuild;
                        }
                    }
                }
                // [flag: taklonsPowerFirst] 사용자 처방(2026-07-14): 순환 예측(6차 음수)이 안 되면 최소한
                // '브레인 bowl3 + 파워액션 가능이면 그것부터'. 관찰: 브레인+1PW(=4파워) 두고 교역소 짓고
                // 담턴에 파워액션 — 순서 교정은 자기 경제 중립이고 공유 슬롯 선점만 이득(순수 순서 손해 제거).
                // findPowerActions는 점수≥0 가치액션만 반환(브레인 지불 affordability 포함).
                if (getPlayerFlag(playerId, 'taklonsPowerFirst', true) && player.faction === 'taklons'
                    && !game.hasDoneMainAction && player.brainStoneBowl === 3 && !player.brainStoneInGaia
                    && (game.roundNumber ?? 1) <= 5
                    && !candidates.some(c => c.type === 'form_federation')) {
                    const paFirst = this.findPowerActions(game, playerId)[0];
                    if (paFirst) {
                        log(`Bot ${player.name} taklonsPowerFirst: 브레인 bowl3 → 파워액션 선실행 (${(paFirst.params as any)?.actionId})`, 'game', game.id);
                        return paFirst;
                    }
                }
                // [flag: humanRule2O] 데이터 유래 규칙(사람 27게임): 사람은 '크레딧 부자 + 광석 뒤처짐 + 파워 보유' 일 때
                // 2O 파워액션을 누른다(90회 관측: 평균 cred10.9·ore3.7·p3 4.8). 봇은 실전에서 이걸 0회(크레딧 풍선).
                // 평가기 nudge는 무시되므로(어제 확인) MCTS 우회해 강제. 단 연방/연구(지식≥4)/할인업글이 우선.
                if (getPlayerFlag(playerId, 'humanRule2O', true) && !game.hasDoneMainAction) {
                    const round2 = game.roundNumber ?? 1;
                    const ore = player.ore ?? 0, cred = player.credits ?? 0, p3 = player.power3 ?? 0;
                    const twoOre = game.powerActions.find(a => a.id === 'gain-2-ore' && !a.isUsed);
                    const hasFed = candidates.some(c => c.type === 'form_federation');
                    if (twoOre && p3 >= 4 && cred >= 8 && ore < cred * 0.5 && round2 <= 5
                        && (player.knowledge ?? 0) < 4 && !hasFed) {
                        log(`Bot ${player.name} humanRule2O: press 2O (cred${cred} ore${ore} p3${p3})`, 'game', game.id);
                        return { type: 'use_power_action', params: { actionId: 'gain-2-ore', useBrain: player.faction === 'taklons' } };
                    }
                }
                // [flag: humanPowerRace] 프리미엄 파워액션(7C·2O·2K)은 라운드당 선착순 공유자원 — 실측: 사람이
                // 7C 0.73/2K 0.33/석 선점 vs 봇 0.19/0.02(기권). 셀프플레이에선 아무도 안 집어 선점가치가 0으로
                // 측정되는 구조적 사각지대(humanRule2K -2.42 기각의 원인) → **사람이 있는 게임에서만** 발동해
                // 셀프플레이 측정 무오염 + 실전 경쟁. 검증 = 사용자 1:3.
                // [검증 절차(사용자 2026-07-11): 켜기 전에 셀프플레이 하한 측정 — 셀프플레이는 '아무도 안 뺏는 세계'라
                // 선점 이득 0 + 비용(메인액션)만 측정되는 worst-case. 무해면 실전(경쟁)에선 이득만 가능. 음수면 조건 조임.
                // humanPowerRaceForce = 측정용(hasHumanOpp 강제 true).]
                if (getPlayerFlag(playerId, 'humanPowerRace', true) && !game.hasDoneMainAction) {
                    const hasHumanOpp = getPlayerFlag(playerId, 'humanPowerRaceForce', false)
                        || (game.botPlayerIds?.length ?? 0) < Object.keys(game.players).length;
                    const rr2 = game.roundNumber ?? 1;
                    if (hasHumanOpp && rr2 <= 4 && !candidates.some(c => c.type === 'form_federation')) {
                        const p3r = player.power3 ?? 0;
                        const nevHalf = player.faction === 'nevlas' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
                        const canPay = (c: number) => nevHalf ? p3r >= Math.ceil(c / 2) : p3r >= c;
                        const races: Array<[string, number, boolean]> = [
                            ['gain-7-credits', 4, (player.credits ?? 0) <= 6],
                            ['gain-2-ore', 4, (player.ore ?? 0) <= 3],
                            ['gain-2-knowledge', 4, (player.knowledge ?? 0) < 4],
                        ];
                        for (const [id, cost, need] of races) {
                            if (!need || !canPay(cost)) continue;
                            const ra = game.powerActions.find(x => x.id === id && !x.isUsed);
                            if (!ra) continue;
                            log(`Bot ${player.name} humanPowerRace: ${id} 선점 (사람 경쟁 게임)`, 'game', game.id);
                            return { type: 'use_power_action', params: { actionId: id, useBrain: player.faction === 'taklons' } };
                        }
                    }
                }
                // [flag: r1RebelCommit] 사용자(2026-07-11): 사람은 R1부터 계획적으로 3정큐를 만들어 리벨을 함 —
                // 봇도 '게임당 1봇(러너 = 진입비용 최소·결정적 지정)'이 R1-2에 이 빌드를 커밋: ①미탑승이면 리벨리온
                // 입장 직행 ②탑승 후엔 rebellionQicPlan(아래)이 정큐 조립을 이어받음. 3정큐는 라운드당 1회 공유라
                // 남(사람 포함)이 먼저 쓰면 rebUnused=false로 자연히 양보.
                // [v2 2026-07-11] v1(무조건 직행)은 콤보 −5.56 — QIC 태우는 원거리 입장이 R1 인프라를 밀어냄.
                // '입장이 공짜(사거리 내, QIC 0)'일 때만 커밋 = 사람도 가까울 때 하는 빌드.
                if (getPlayerFlag(playerId, 'r1RebelCommit', false) && !game.hasDoneMainAction
                    && (game.roundNumber ?? 1) <= 2 && this.isRebelRunner(game, playerId)) {
                    const rebT = game.map.find(t => t.type === 'ship_rebellion');
                    if (rebT && !(player.spaceshipsEntered ?? []).includes(rebT.id) && (player.spaceshipsEntered ?? []).length < 3) {
                        const entry = this.findSpaceshipEntryActions(game, playerId)
                            .find(a => a.type === 'enter_spaceship' && (a.params as any)?.tileId === rebT.id
                                && ((a.params as any)?.qicToUse ?? 0) === 0);
                        if (entry) {
                            log(`Bot ${player.name} r1RebelCommit: 러너 리벨리온 무료입장 직행 (R${game.roundNumber})`, 'game', game.id);
                            return entry;
                        }
                    }
                }
                // [flag: rebellionQicPlan] 사용자(2026-07-11): "아무도 리벨리온 3정큐 빌드를 안 생각해서 그것만으로 쉽게 이김".
                // 룰 확인: 우주선 액션은 매 라운드 리셋(gameState 7215) = 3Q→기술타일이 라운드당 반복 엔진.
                // 사람 빌드: 리벨리온 탑승 + AI트랙(L1~5: +1/+1/+2/+2/+4Q) 등정 + 매라운드 3Q 소진. 봇에 빠진 조각 =
                // 'Q 수입을 계획적으로 만들기' → 직접-return(점수 너지는 aiTrackQicEngine서 무효 확인): 탑승 중 + 3Q 미달 +
                // 이번 AI 연구의 Q 보상으로 3Q가 완성되면 AI 연구 (연구+1~2Q → 3정큐 → 타일, 타일이 또 트랙 전진).
                if (getPlayerFlag(playerId, 'rebellionQicPlan', true) && !game.hasDoneMainAction) {
                    const rq = game.roundNumber ?? 1;
                    const rebTile = game.map.find(t => t.type === 'ship_rebellion');
                    const onReb = !!rebTile && (player.spaceshipsEntered ?? []).includes(rebTile.id);
                    const rebUnused = !!rebTile && !(game.spaceships?.[rebTile.id]?.usedActionIndices ?? []).includes(1);
                    // [flag: twilightQicPlan v2] 트와 #1(3Q→연방보상) — 사용자 타이밍 룰(R4+ 또는 기술연방 후)에서만 합류
                    const twiTile = (getPlayerFlag(playerId, 'twilightQicPlan', true) && this.twilightTimingOk(game, player))
                        ? game.map.find(t => t.type === 'ship_twilight') : null;
                    const onTwi = !!twiTile && (player.spaceshipsEntered ?? []).includes(twiTile.id);
                    const twiUnused = !!twiTile && !(game.spaceships?.[twiTile.id]?.usedActionIndices ?? []).includes(1);
                    const engineReady = (onReb && rebUnused) || (onTwi && twiUnused);
                    const aiLvl = player.research?.artificialIntelligence ?? 0;
                    const qNow = player.qic ?? 0;
                    if (engineReady && rq <= 5 && qNow < 3 && (player.knowledge ?? 0) >= 4 && aiLvl < 5
                        && !(aiLvl === 4 && !getFederationEntries(player).some(fe => fe.isGreen))
                        && !candidates.some(c => c.type === 'form_federation')) {
                        // [flag: rebelPrepPlus ①] 사용자(2026-07-11): 1Q만 부족하면 리벨 3번(2K→1Q+2C)이 AI연구(4K)보다
                        // 싼 브리지 (같은 배, 다른 인덱스라 같은 라운드 사용 가능) — 이걸 먼저.
                        if (getPlayerFlag(playerId, 'rebelPrepPlus', true) && onReb && qNow === 2 && (player.knowledge ?? 0) >= 2
                            && !(game.spaceships?.[rebTile!.id]?.usedActionIndices ?? []).includes(3)) {
                            log(`Bot ${player.name} rebelPrepPlus: 리벨3번(2K→1Q2C) 브리지 → 3정큐`, 'game', game.id);
                            return { type: 'use_ship_action', params: { shipTileId: rebTile!.id, actionIndex: 3 } };
                        }
                        const qGain = aiLvl < 2 ? 1 : (aiLvl < 4 ? 2 : 4);
                        if (qNow + qGain >= 3) {
                            log(`Bot ${player.name} rebellionQicPlan: AI연구로 3정큐 완성 (q${qNow}+${qGain}, AI L${aiLvl}→${aiLvl + 1})`, 'game', game.id);
                            return this.advanceResearchAction(playerId, player, 'artificialIntelligence');
                        }
                    }
                    // [flag: rebel3qLadder] 사람/봇 데이터(2026-07-14, 사람 125석 vs 봇 192석): 사람은 3Q타일을 R1부터
                    // 매라운드 구매(55/52/49/41/41/40), 봇은 R1 0회·R4-5 몰림(0/6/13/25/26/20) — 승선은 봇도 R1이 최다(46회)라
                    // 병목은 탑승이 아니라 '3Q 조립 사다리'가 좁음: 기존 브리지(#3 2K→1Q2C)가 q==2 && K≥4(AI연구 게이트 안) 한정.
                    // v1(엔진 모드 q<3·K≥5 포함) 40판: 발동 88회 중 74%가 미완성 변환(q0→1 등) → 2K 드레인이 광산 −0.75,
                    // VP −0.82. 구매 조기화는 성공(R≤3 누적 6→20). v2 = '이번 라운드 3Q 완성'이 보이는 브리지만:
                    // ①q2·K≥2 → #3로 즉시 3Q ②q1·K≥2·번4P 가능 → #3 후 번체인 마감. 라운드당 1회(usedActionIndices 가드).
                    if (getPlayerFlag(playerId, 'rebel3qLadder', true) && onReb && rebTile && rebUnused
                        && qNow < 3
                        && !(game.spaceships?.[rebTile.id]?.usedActionIndices ?? []).includes(3)
                        && !candidates.some(c => c.type === 'form_federation')) {
                        const kL = player.knowledge ?? 0;
                        const burnable = player.faction !== 'taklons'
                            && ((player.power3 ?? 0) + Math.floor((player.power2 ?? 0) / 2)) >= 4
                            && Math.max(0, 4 - (player.power3 ?? 0)) <= 2;
                        if ((qNow === 2 && kL >= 2) || (qNow === 1 && kL >= 2 && burnable)) {
                            log(`Bot ${player.name} rebel3qLadder: 리벨3번(2K→1Q2C) q${qNow}→${qNow + 1} (K${kL})`, 'game', game.id);
                            return { type: 'use_ship_action', params: { shipTileId: rebTile.id, actionIndex: 3 } };
                        }
                    }
                    // [flag: rebelPrepPlus ②] 엠바스식 Nav 선행 입장(사용자): 3Q를 이미 들고 있는데 리벨이 사거리 밖이면
                    // QIC 점프 입장은 3정큐 스택 파괴 — Nav 연구 1레벨로 사거리 내가 되면 연구 먼저(무료 입장 + 3Q 보존).
                    // navBeforeJump(채택)의 입장 버전.
                    if (getPlayerFlag(playerId, 'rebelPrepPlus', true) && rebTile && !onReb
                        && rq <= 3 && qNow >= 3 && (player.knowledge ?? 0) >= 4
                        && (player.spaceshipsEntered ?? []).length < 3
                        && !candidates.some(c => c.type === 'form_federation')) {
                        const navLvl = player.research?.navigation ?? 0;
                        const balBlock = player.faction === 'bal_tak' && !game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
                        const myPl2 = game.map.filter(t => (t.ownerId === playerId && t.structure) || (t.spaceStation && (t.spaceStation as any).ownerId === playerId));
                        if (navLvl < 5 && !balBlock && myPl2.length > 0
                            && !(navLvl === 4 && !getFederationEntries(player).some(fe => fe.isGreen))) {
                            const d2 = Math.min(...myPl2.map(p => getDistance(p, rebTile)));
                            const rngNow = getRange(navLvl) + (player.navigationBonus || 0);
                            const rngNext = getRange(navLvl + 1) + (player.navigationBonus || 0);
                            if (d2 > rngNow && d2 <= rngNext) {
                                log(`Bot ${player.name} rebelPrepPlus: Nav연구로 리벨 사거리 확보 (d${d2}, ${rngNow}→${rngNext}) — 3Q 보존 입장 준비`, 'game', game.id);
                                return this.advanceResearchAction(playerId, player, 'navigation');
                            }
                        }
                    }
                }
                // [flag: humanRule2K] 파워배분 실측(2026-07-11): +2지식 파워액션 사람 0.31 vs 봇 0.03(10배) — 점수는
                // 정상(200~300)인데 삽 콤보가 파워를 선소진해 못 누름. 사람 패턴: 지식 기아(<4)+파워 여유일 때 눌러
                // 다음 연구를 연다. humanRule2O와 동일한 직접-return(평가기 우회) 계열, 연방/삽콤보보다 후순위.
                // [기각 2026-07-11: 셀프플레이 -2.42 — 선점가치 사각지대. humanPowerRace(사람게임 한정)로 대체.]
                if (getPlayerFlag(playerId, 'humanRule2K', false) && !game.hasDoneMainAction) {
                    const rk = game.roundNumber ?? 1;
                    const p3k = player.power3 ?? 0, knowK = player.knowledge ?? 0;
                    const twoK = game.powerActions.find(a => a.id === 'gain-2-knowledge' && !a.isUsed);
                    const hasFedK = candidates.some(c => c.type === 'form_federation');
                    // 지식 2~3(연구 4K에 1~2 부족) + 파워 넉넉(5+, 삽콤보 여지 보존) + R≤4(연구 가치 시기)
                    if (twoK && rk <= 4 && knowK >= 2 && knowK < 4 && p3k >= 5 && !hasFedK) {
                        log(`Bot ${player.name} humanRule2K: press 2K (know${knowK} p3${p3k})`, 'game', game.id);
                        return { type: 'use_power_action', params: { actionId: 'gain-2-knowledge', useBrain: player.faction === 'taklons' } };
                    }
                }
                // [flag: humanRule7C] humanRule2O의 크레딧판(사용자 관찰 2026-07-07): 봇이 크레딧기아인데 연방 전에 idle bowl3를
                //   fedSpendBowl3로 1P→1C ×4(=4크레딧)만 뽑고 연방함. gain-7-credits(4파워→7크레딧=1.75C/파워)가 1P→1C(1C/파워)의
                //   상위호환인데 안 씀("4p->7c 액션을 절대 안 함"). 평가기 nudge는 MCTS가 덮으므로 humanRule2O처럼 직접 return.
                //   [2026-07-07 v1측정: 무조건 C≤4 발동 → 크레딧기아 25→17%(성공)이나 VP −2.38·광석기아 16→20%·광산 −0.34.
                //    크레딧 풀어주니 병목이 광석으로 이동(action-gap=확장벽). → v2: "크레딧이 유일한 빌드차단"일 때만 발동하게 정밀화.]
                //   프로브: (a)지금 지을/업글할 게 없고 (b)크레딧 +7이면 build_mine/업글이 가능해지며 (c)광석 보유(≥2, 지은 뒤 계속 확장)
                //   일 때만 7C 강제 = 크레딧이 진짜 유일 병목일 때만. 그 외엔 MCTS/다른 룰에 양보(죽은 크레딧·병목이동 방지).
                if (getPlayerFlag(playerId, 'humanRule7C', true) && !game.hasDoneMainAction) {
                    const round7 = game.roundNumber ?? 1;
                    const cred = player.credits ?? 0, p3 = player.power3 ?? 0, ore7 = player.ore ?? 0;
                    const sevenC = game.powerActions.find(a => a.id === 'gain-7-credits' && !a.isUsed);
                    if (sevenC && p3 >= 4 && cred <= 4 && ore7 >= 2 && round7 <= 5) {
                        // 크레딧이 유일 병목인지 프로브: 현재 못 짓는데 +7C면 지어지는 build/upgrade가 있나
                        const buildableNow = (g: any) => {
                            try {
                                const bs = this.findBuildActions(g, playerId).some(a => a.type === 'build_mine');
                                const us = this.findUpgradeActions(g, playerId).some(a => a.type === 'upgrade_structure');
                                return bs || us;
                            } catch { return false; }
                        };
                        const canNow = buildableNow(game);
                        let unlockedBy7C = false;
                        if (!canNow) {
                            const oldC = player.credits;
                            player.credits = cred + 7;
                            unlockedBy7C = buildableNow(game);
                            player.credits = oldC;
                        }
                        if (!canNow && unlockedBy7C) {
                            log(`Bot ${player.name} humanRule7C: press 7C (cred${cred} ore${ore7} p3${p3} R${round7}, unlocks build)`, 'game', game.id);
                            return { type: 'use_power_action', params: { actionId: 'gain-7-credits', useBrain: player.faction === 'taklons' } };
                        }
                    }
                }
                // [flag: shipActionBalance] 사용자 자원밸런싱 정책(2026-07-07)의 직접-return판. ★기존 shipResourceBalance(기본ON)는
                //   findSpaceshipActions 안에서 점수 nudge(broke+생성 +130 / rich+소비 +90)로 구현돼 있으나 그건 후보점수라 MCTS가
                //   덮어버려(후보점수 nudge 무시 교훈 — humanRule2O·expansionEngineOpen과 동일 함정) 정책이 행동에 안 나타남(사용자:
                //   "여전히 밸런싱 안 함"). 그래서 humanRule2O/7C처럼 직접-return으로 강제한다.
                //   돈 많으면(≥9) 크레딧 소비-확장 우주선액션: TF마스#3(3C→테라스텝+광산)·이클립스#3(6C→소행성광산) = 크레딧풍선→확장 전환.
                //   돈 없으면(≤5) 크레딧-무비용 income 우주선액션: 리벨#2(광산→TS, 1O3P)·트왈#2(TS→연구소, 2O3P) = 패스 대신 엔진충전.
                //   연방/할인업글이 우선이면 양보(그 앞·자체 가드). findSpaceshipActions가 canUseShipAction+타깃선택까지 검증한 액션만 반환.
                if (getPlayerFlag(playerId, 'shipActionBalance', true) && !game.hasDoneMainAction
                    && (player.spaceshipsEntered || []).length > 0
                    && !candidates.some(c => c.type === 'form_federation')
                    && this.findDiscountedUpgradeAction(game, playerId) === null) {
                    const creditsSB = player.credits ?? 0;
                    const shipActs = this.findSpaceshipActions(game, playerId);
                    const typeOf = (a: BotAction) => game.map.find(t => t.id === (a.params as any)?.shipTileId)?.type;
                    const pickShip = (type: string, idx: number) => shipActs.find(a => a.type === 'use_ship_action'
                        && typeOf(a) === type && (a.params as any)?.actionIndex === idx);
                    let chosenSB: BotAction | undefined;
                    if (creditsSB >= 9) chosenSB = pickShip('ship_tf_mars', 3) || pickShip('ship_eclipse', 3);
                    else if (creditsSB <= 5) chosenSB = pickShip('ship_rebellion', 2) || pickShip('ship_twilight', 2);
                    if (chosenSB) {
                        log(`Bot ${player.name} shipActionBalance: ${creditsSB >= 9 ? 'rich→spend' : 'poor→income'} ${typeOf(chosenSB)}#${(chosenSB.params as any).actionIndex} (C${creditsSB})`, 'game', game.id);
                        return chosenSB;
                    }
                }
                // [flag: powerBeforeFedBurn] 사용자 전략(2026-07-07): 연방 전에 프리액션(1P→1C 회수)보다 **파워/우주선 액션으로
                //   bowl3를 먼저 쓰는 게 최적**. 이유: 위성으로 쓴 bowl3는 게임에서 제거되지만, 파워액션에 쓴 bowl3는 bowl1로 복귀(재활용)
                //   → 다음 턴 위성으로 재사용 = 같은 토큰으로 gain-7-credits(7c=1.75c/파워) + 연방 둘 다. cashout(1c/파워)보다 우월.
                //   트레이드오프: 연방을 한 턴 미룸(파워액션=메인). 연방이 bowl3를 ≥4 태울 상황(spent−p1−p2≥4)+7C/2O 가능하면 이번 턴은
                //   그 파워액션 먼저. R≤5(R6 연방 급함), taklons 제외(브레인 회계). 더 부족한 자원 우선(크레딧≤광석→7C). 우주선 케이스는
                //   앞의 shipActionBalance가 이미 처리(여기 도달=우주선 안 걸림). 리스크(연방 지연)로 head2head do-no-harm 확인 필요.
                if (getPlayerFlag(playerId, 'powerBeforeFedBurn', false) && !game.hasDoneMainAction
                    && (game.roundNumber ?? 1) <= 5 && player.faction !== 'taklons') {
                    const p1b = player.power1 ?? 0, p2b = player.power2 ?? 0, p3b = player.power3 ?? 0;
                    if (p3b >= 4) {
                        const fedBurnsBowl3 = candidates.some(c => c.type === 'form_federation'
                            && Math.max(0, ((c.params as any)?.spentTokens ?? 0) - p1b - p2b) >= 4);
                        if (fedBurnsBowl3) {
                            const credB = player.credits ?? 0, oreB = player.ore ?? 0;
                            const sevenCB = game.powerActions.find(a => a.id === 'gain-7-credits' && !a.isUsed);
                            const twoOB = game.powerActions.find(a => a.id === 'gain-2-ore' && !a.isUsed);
                            let actId: string | null = null;
                            if (sevenCB && (credB <= oreB || !twoOB)) actId = 'gain-7-credits';
                            else if (twoOB) actId = 'gain-2-ore';
                            if (actId) {
                                log(`Bot ${player.name} powerBeforeFedBurn: ${actId} 먼저(연방 bowl3≥4 소모 회피, C${credB} O${oreB} p3${p3b} R${game.roundNumber})`, 'game', game.id);
                                return { type: 'use_power_action', params: { actionId: actId, useBrain: false } };
                            }
                        }
                    }
                }
                // [flag: r1TsFirst] R1 오프닝을 사람처럼 — 사람 R1 첫수 교역소업글 59% vs 봇 광산 65%.
                //   사람은 R1에 수입엔진(TS→랩) 착수, 봇은 광산 흩뿌리기. TS 아직 없고 mine→TS 업글 가능하면 R1 첫 메인액션으로 강제.
                //   (R2+ 확장 우선(Q5)과 구분 — R1만 엔진 착수.)
                if (getPlayerFlag(playerId, 'r1TsFirst', false) && (game.roundNumber ?? 1) === 1 && !game.hasDoneMainAction
                    && !game.map.some(t => t.ownerId === playerId && t.structure === 'trading_station')) {
                    const ts = this.findUpgradeActions(game, playerId).find(u => u.type === 'upgrade_structure' && (u.params as any)?.target === 'trading_station');
                    if (ts) { log(`Bot ${player.name} r1TsFirst: R1 교역소 업글 오프닝`, 'game', game.id); return ts; }
                }
                // [flag: expansionEngineOpen] 빌드오더 데이터(2026-07-07): 봇은 R1-3에 테라(0.19)·가이아(0.15)·가이아포머(0.17)를
                //   사람(0.94/1.03/0.94)의 15~20%만 함 = 크레딧/사거리 엔진(TS·경제·내비 과투자)만 짓고 광석/확장 엔진을 통째 건너뜀
                //   → 광산 못 늘려 광석기아 영구화(96점 갭·17% 기아의 단일 뿌리). 방치된 확장연구를 직접 강제(점수 nudge는 MCTS가 덮음).
                //   가이아 우선(L1=가이아포머=확장 직결) → 테라(광석·행성 buildability). 연방/할인업글이 우선이면 양보. bal_tak은 가이아프로젝트 불가라 제외.
                if (getPlayerFlag(playerId, 'expansionEngineOpen', true) && !game.hasDoneMainAction && !strongBuildNow
                    && (game.roundNumber ?? 1) <= 3 && (player.knowledge ?? 0) >= 4 && player.faction !== 'bal_tak'
                    && !candidates.some(c => c.type === 'form_federation')
                    && this.findDiscountedUpgradeAction(game, playerId) === null) {
                    const gaiaLvl = player.research?.gaiaProject ?? 0;
                    const terraLvl = player.research?.terraforming ?? 0;
                    // [flag: gaiaResearchPlaceSync 연동] 이 직접-return이 gaiaResearchUseGate를 우회해 R1 가이아
                    // 연구 → 포머 방치(실측 37%)의 주 공급원이었음. 가이아가 '지금 쓸 수 있는' 상태가 아니면
                    // (R1 배치금지 포함) 테라포밍으로 폴백 — 확장연구 강제라는 취지는 유지.
                    const gaiaOk = gaiaLvl < 1
                        && !(getPlayerFlag(playerId, 'gaiaResearchUseGate', true) && !this.gaiaResearchUsable(game, playerId));
                    // [회귀수정 2026-07-14 사용자 관찰] gaiaResearchPlaceSync(R1 가이아 차단)와 결합 시 R1에 K4+
                    // 봇 전원이 테라 폴백으로 쏠림(사람 첫연구: nav41%/gaia32%/terra11% — 정반대). 테라 폴백은
                    // '가이아를 못 쓰는 상황'용이지 'R1 타이밍 대기'용이 아님 → R1엔 강제하지 않고 일반 후보
                    // (humanResearchPrior: nav+95/gaia+85 shaping)에 맡김. R2+부터만 폴백.
                    const target: ResearchTrack | null = gaiaOk ? 'gaiaProject'
                        : ((game.roundNumber ?? 1) >= 2 && terraLvl < 1 ? 'terraforming' : null);
                    if (target) {
                        const act = this.advanceResearchAction(playerId, player, target);
                        if (act) { log(`Bot ${player.name} expansionEngineOpen: 확장연구 ${target} 강제(R${game.roundNumber})`, 'game', game.id); return act; }
                    }
                }
                // [flag: fedWhenOffered] 반사실 복기 2회전(2026-07-14, 245결정): 연방 후보가 존재하는데 다른 수를
                // 둔 후회 10회·평균 17.7VP(예: HH R4 연방 90 vs 아카 51). buildOrderPlanner(−4.14)와 구분: 그건
                // 라운드 목표로 '없는 연방을 강제'했고, 이건 '이미 제안된(품질게이트 통과) 연방'을 R4+에 즉시 수령.
                if (getPlayerFlag(playerId, 'fedWhenOffered', false) && !game.hasDoneMainAction
                    && (game.roundNumber ?? 1) >= 4) {
                    const fedCand = candidates.find(c => c.type === 'form_federation');
                    if (fedCand) {
                        log(`Bot ${player.name} fedWhenOffered: R${game.roundNumber} 연방 후보 즉시 수령`, 'game', game.id);
                        return fedCand;
                    }
                }
                // [flag: balTakGaiaFirst] 사용자 관찰(2026-07-13): 발타크가 R1에 4K로 테라 L1(+2O 일회성)을 올림 —
                // 포머 = 매라 1QIC 반복 수입(사용자 확정 산수)이라 가이아 L2/L3(+1포머씩)가 일회성 2O를 지배.
                // MCTS 시뮬이 즉시자원(2O→연구소 사슬)을 과대평가해 후보 1순위(가이아 245 vs 테라 143)를 뒤집음
                // → expansionEngineOpen 패턴의 직접-return으로 강제. 연방/할인업글 우선 양보, R≤3·gaia<3 한정.
                // [v2 사용자 정교화 2026-07-13] "발타크는 늘 가이아 트랙 우선(포머=게임 최고 자원 QIC 생성).
                // 예외: 아카데미 지으려는데 2O 부족할 때만 삽(테라 L1, +2O) 한 칸" — 포머는 L1·L3·L4에 나오므로
                // L4까지 강제(3포머 = 매라 3QIC), R≤4(수입 라운드 잔존). 아카데미 자금 예외 시 일반 경로로 양보.
                if (getPlayerFlag(playerId, 'balTakGaiaFirst', true) && player.faction === 'bal_tak'
                    && !game.hasDoneMainAction && (game.roundNumber ?? 1) <= 4 && (player.knowledge ?? 0) >= 4
                    && (player.research?.gaiaProject ?? 0) < 4
                    && !candidates.some(c => c.type === 'form_federation')
                    && this.findDiscountedUpgradeAction(game, playerId) === null) {
                    const academyFunding = (player.research?.terraforming ?? 0) === 0
                        && (player.ore ?? 0) >= 4 && (player.ore ?? 0) < 6 && (player.credits ?? 0) >= 6
                        && game.map.some(t => t.ownerId === playerId && t.structure === 'research_lab')
                        && game.map.filter(t => t.ownerId === playerId && t.structure === 'academy').length < 2;
                    if (!academyFunding) {
                        const act = this.advanceResearchAction(playerId, player, 'gaiaProject');
                        log(`Bot ${player.name} balTakGaiaFirst: 가이아 연구 강제(포머=QIC 수입, R${game.roundNumber})`, 'game', game.id);
                        return act;
                    }
                    log(`Bot ${player.name} balTakGaiaFirst: 아카데미 자금 예외(O${player.ore}<6, 테라 L1 +2O 허용)`, 'game', game.id);
                }
                // [flag: bigMissionBigFirst] 사용자 관찰(2026-07-13 엠바스): 큰건물 미션(5VP) 라운드 + 자원 풍족인데
                // 아카 대신 연구소 2개 — 아카 재료(연구소)가 연방 안이면 fedPenalty(-450)가 아카 후보를 top5 밖으로
                // 밀어냄. 사람 룰: 큰건물 미션 라운드엔 아카/의회 직행(미션 5VP가 연방보존 가치를 압도). 직접-return,
                // 연방 후보가 있으면 양보, 비연방 연구소 우선(없으면 연방 안 것도 허용 — 미션이 우선).
                // [v2 사용자 교정] ①연방 안 건물 폴백 제거(비연방만 — 없으면 안 함) ②의회(TS→PI 4O6C)도 직행
                // 후보(의회 미보유 시 아카보다 우선 — 종족 능력 해금 + 같은 미션 5VP).
                if (getPlayerFlag(playerId, 'bigMissionBigFirst', false) && !game.hasDoneMainAction
                    && game.roundScoringTiles?.[(game.roundNumber ?? 1) - 1]?.triggerType === 'build_big_building'
                    && !candidates.some(c => c.type === 'form_federation')) {
                    const fedHexesB: string[] = (game as any).playerFederationHexes?.[playerId] || [];
                    const oreB = player.ore ?? 0, credB = player.credits ?? 0;
                    const hasPIB = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
                    if (!hasPIB && oreB >= 4 && credB >= 6) {
                        const tsPick = game.map.find(t => t.ownerId === playerId && t.structure === 'trading_station' && !fedHexesB.includes(t.id));
                        if (tsPick) {
                            log(`Bot ${player.name} bigMissionBigFirst: 큰건물 미션 라운드 의회 직행 (${tsPick.id})`, 'game', game.id);
                            return { type: 'upgrade_structure', params: { tileId: tsPick.id, target: 'planetary_institute' } };
                        }
                    }
                    const myAcadCnt = game.map.filter(t => t.ownerId === playerId && t.structure === 'academy').length;
                    if (myAcadCnt < 2 && oreB >= 6 && credB >= 6) {
                        const labPick = game.map.find(t => t.ownerId === playerId && t.structure === 'research_lab' && !fedHexesB.includes(t.id));
                        if (labPick) {
                            const onReb = (player.spaceshipsEntered || []).some(id => game.map.find(t => t.id === id)?.type === 'ship_rebellion');
                            const tgt = ((game.roundNumber ?? 1) >= 5 || onReb) ? 'academy_right' : 'academy_left';
                            log(`Bot ${player.name} bigMissionBigFirst: 큰건물 미션 라운드 아카 직행 (${labPick.id})`, 'game', game.id);
                            return { type: 'upgrade_structure', params: { tileId: labPick.id, target: tgt } };
                        }
                    }
                }
                // [flag: gaiaMineFollow] 사람데이터(2026-07-07 로그): 가이아포머 배치→가이아 광산 건설 = 100%(62% 같은 라운드).
                //   봇은 expansionEngineOpen로 가이아포밍은 2.2배 늘었으나 그 위 광산 건설 다운스트림이 약함(광산 −0.34) =
                //   확장 sink 누락(가이아 행성 만들고 방치 → 템포 손실). 내 가이아포머가 완성된(pendingGaiaformerTiles) 행성에
                //   광산을 지을 수 있으면 직접-return으로 즉시 건설(이미 쓴 포머+가이아페이즈 투자 회수, 순이득). 점수 nudge는
                //   MCTS가 덮으므로(광산 후보 점수 무시) expansionEngineOpen처럼 직접 강제. 자금 부족 시 findBuildActions가
                //   후보를 안 내면(credits<2 bail) 이 룰은 스킵되고 뒤의 mineCreditCombo/humanRule7C가 pre-fund → 다음 루프에 건설
                //   (사람 패턴: power/변환으로 pre-fund 후 건설). 연방이 우선이면 양보.
                if (getPlayerFlag(playerId, 'gaiaMineFollow', true) && !game.hasDoneMainAction
                    && !candidates.some(c => c.type === 'form_federation')) {
                    const isMyReadyGaia = (tid: string | undefined) => {
                        if (!tid) return false;
                        const t = game.map.find(x => x.id === tid);
                        return !!(t && t.hasGaiaformer && t.gaiaformerOwnerId === playerId && player.pendingGaiaformerTiles?.includes(t.id));
                    };
                    let gaiaBuild: BotAction | undefined;
                    try { gaiaBuild = this.findBuildActions(game, playerId).find(a => a.type === 'build_mine' && isMyReadyGaia((a.params as any)?.tileId)); } catch { }
                    if (gaiaBuild) {
                        log(`Bot ${player.name} gaiaMineFollow: 가이아 광산 건설 강제 (tile=${(gaiaBuild.params as any)?.tileId} R${game.roundNumber})`, 'game', game.id);
                        return gaiaBuild;
                    }
                }
                // [flag: expansionMineDrive] 진짜 벽 공략(2026-07-07 사람 로그 전수: 광산 사람 ~14 vs 봇 ~8.3 = 봇이 57%뿐).
                //   사람은 R1=인프라(TS 63%), R2-4=광산 스팸(액션의 25~42%, 라운드당 ~2채). 봇은 평가기가 확장을 저평가해 광산 후보
                //   점수를 MCTS가 덮음(수차례 확인) → R2-4에 '페이스 미달'(광산<2×라운드)이면 봇 자체 최고점 광산을 직접-return 강제.
                //   ★기각된 mineFirstExpansion(−2.92, 홈 뭉침)과 차별: ①R1 제외(인프라 우선) ②페이스 게이트(뒤처질 때만) ③봇 자체
                //   스코어링 최상 광산(사거리·인접·연방연계 반영=홈뭉침 방지, navBeforeJump와 협응) ④연방/할인업글/확장연구 양보(앞 룰들이 선점).
                //   자금 부족 시 findBuildActions가 후보 안 냄→스킵→mineCreditCombo/humanRule7C가 pre-fund→다음 루프 건설(사람 pre-fund 패턴).
                if (getPlayerFlag(playerId, 'expansionMineDrive', false) && !game.hasDoneMainAction
                    && (game.roundNumber ?? 1) >= 2 && (game.roundNumber ?? 1) <= 4
                    && !candidates.some(c => c.type === 'form_federation')
                    && this.findDiscountedUpgradeAction(game, playerId) === null) {
                    const mineCnt = getStructureCount(game, playerId, 'mine');
                    const pace = 2 * (game.roundNumber ?? 1); // 사람 ~2채/라운드
                    if (mineCnt < pace) {
                        let bestMine: BotAction | undefined;
                        try { bestMine = this.findBuildActions(game, playerId).find(a => a.type === 'build_mine'); } catch { }
                        if (bestMine) {
                            log(`Bot ${player.name} expansionMineDrive: 광산 강제 (mines${mineCnt}<pace${pace} R${game.roundNumber} tile=${(bestMine.params as any)?.tileId})`, 'game', game.id);
                            return bestMine;
                        }
                    }
                }
                // [flag: mineCreditCombo] 크레딧기아 교정(2026-07-07 측정: C≤2&O≥2인데 빌드안함 25%, 그중 변환 13%뿐).
                //   findBuildActions가 credits<2면 즉시 bail(광산 후보 0) → 광석 있어도 못 지음. 광석 잉여면 1O→1C로
                //   부족분 메워 광산 건설(예비 광석 남김 → 광석기아 악화 방지). 변환해도 실제 지을 광산이 있을 때만(낭비 방지).
                if (getPlayerFlag(playerId, 'mineCreditCombo', true) && !game.hasDoneMainAction
                    && (player.credits ?? 0) < 2 && (player.ore ?? 0) >= 4
                    && getStructureCount(game, playerId, 'mine') < BUILDING_LIMITS.mine) {
                    const oldC = player.credits;
                    player.credits = 2; // 가정: 크레딧 충족 시 지을 광산이 있나
                    let canBuildMine = false;
                    try { canBuildMine = this.findBuildActions(game, playerId).some(a => a.type === 'build_mine'); } catch { }
                    player.credits = oldC;
                    if (canBuildMine) {
                        log(`Bot ${player.name} mineCreditCombo: 1O→1C (크레딧기아 O${player.ore} C${player.credits}, 광산 건설용)`, 'game', game.id);
                        return { type: 'convert_resource', params: { type: '1ore-to-1credit' } };
                    }
                }
                // [flag: taklonsBrainCredit] 사용자 요청(2026-07-06): 타클론이 브레인(3그릇)을 프리액션 1B→3C로 바꿔
                //   크레딧기아를 풀지 봇이 판단 못함. 브레인이 bowl3에 idle이고 크레딧 부족(<4)인데 +3C가 *지금은 못 하는*
                //   광산 건설을 언락하면 변환(mineCreditCombo의 광석 대신 브레인으로 pre-fund). 1B→3C는 브레인 3파워어치를
                //   낭비 없이(3크레딧) 소비 → 이후 재충전 사이클 복귀(타클론 엔진). humanRule7C/mineCreditCombo의 unlock 프로브와
                //   동형(실효 없는 변환 방지 — after&&!before). 브레인은 어차피 idle(계측 1.6~2.1/게임 놀림). 프리액션이라 메인 유지.
                if (getPlayerFlag(playerId, 'taklonsBrainCredit', false) && !game.hasDoneMainAction
                    && player.faction === 'taklons' && player.brainStoneBowl === 3 && !(player as any).brainStoneInGaia
                    && (player.credits ?? 0) < 4) {
                    const canBuildMine = () => {
                        try { return this.findBuildActions(game, playerId).some(a => a.type === 'build_mine'); } catch { return false; }
                    };
                    const before = canBuildMine();
                    const oldC = player.credits;
                    player.credits = (oldC ?? 0) + 3;
                    const after = canBuildMine();
                    player.credits = oldC;
                    if (after && !before) {
                        log(`Bot ${player.name} taklonsBrainCredit: 1B→3C (크레딧기아 C${oldC}, 브레인 idle→광산 언락)`, 'game', game.id);
                        return { type: 'convert_resource', params: { type: '1brain-to-3credit', useBrain: true } };
                    }
                }
                // [flag: creditIncomeTs] 크레딧기아의 *구조적* 교정(2026-07-07 사람데이터): 사람은 크레딧빈곤+광석부자(C낮음/O높음)일 때
                //   스팟크레딧이 아니라 mine→TS 업글로 **크레딧 수입**을 만든다(actionJournal: 그 사분면 교역소업글 19%). 봇은 스팟(7C/1O→1C)만
                //   만져 매R 재기아 → income으로 끊는다. 사용자 휴리스틱("광산 3개면 교역소가 좋다")과 일치: 3번째+ 광산은 수입 정체라
                //   TS로 바꿔도 광석수입 손실 없이 크레딧수입 획득(순이득). 조기(R≤4)·크레딧빈곤(≤4)·광석부자(≥5)·광산≥3·TS업글 감당가능 시 강제.
                //   점수 nudge는 MCTS가 덮으므로 직접-return. 연방/할인업글/PI 우선이면 그 앞 룰들이 이미 처리(뒤에 둠).
                if (getPlayerFlag(playerId, 'creditIncomeTs', false) && !game.hasDoneMainAction
                    && (game.roundNumber ?? 1) <= 4
                    && (player.credits ?? 0) <= 4 && (player.ore ?? 0) >= 5
                    && getStructureCount(game, playerId, 'mine') >= 3
                    && !candidates.some(c => c.type === 'form_federation')
                    && this.findDiscountedUpgradeAction(game, playerId) === null) {
                    const ts = this.findUpgradeActions(game, playerId).find(u => u.type === 'upgrade_structure' && (u.params as any)?.target === 'trading_station');
                    if (ts) { log(`Bot ${player.name} creditIncomeTs: mine→TS 크레딧수입 강제 (C${player.credits} O${player.ore} R${game.roundNumber})`, 'game', game.id); return ts; }
                }
                // [flag: lantidsEarlyPI] 란티다 정석: 조기(R3~)에 의회(PI)를 지어야 이후 기생광산마다 +2지식(사용자: "3라 정도 의회가 정석").
                //   점수 가점으론 MCTS가 안 고름(실측 PI건설 0.37→0.36) → 직접 강제. TS 있고·PI 없고·감당되면 그 턴 메인액션으로 PI 업글.
                //   (findUpgradeActions가 lantidsEarlyPI 게이트 우회로 PI 후보를 내주므로 여기서 집어 강제 실행.)
                if (getPlayerFlag(playerId, 'lantidsEarlyPI', true) && player.faction === 'lantids' && !game.hasDoneMainAction
                    && (game.roundNumber ?? 1) >= 3
                    && !game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) {
                    const pi = this.findUpgradeActions(game, playerId).find(u => u.type === 'upgrade_structure' && (u.params as any)?.target === 'planetary_institute');
                    if (pi) { log(`Bot ${player.name} lantidsEarlyPI: R${game.roundNumber} 의회 강제 오프닝`, 'game', game.id); return pi; }
                }
                // HH PI 변환(무료): 메인액션 전에 남는 크레딧을 QIC 등으로 미리 보충 → 그 턴 건설/연방에 QIC 활용. 루프가 버퍼까지 반복.
                // [flag: hhJitConvert] 사용자 룰: 미리 바꾸지 말 것 — 필요분은 각 후보의 preActions가 쓰기 직전 변환.
                if (!getPlayerFlag(playerId, 'hhJitConvert', true)) {
                    const hhConvPre = this.findHadschHallasConvert(game, playerId);
                    if (hhConvPre) { log(`Bot ${player.name} HH PI convert (pre-action): ${(hhConvPre.params as any)?.actionId}`, 'game', game.id); return hhConvPre; }
                }
                // [flag: balTakProactiveQic] 발타크 포머→QIC 선제 변환: 발타크는 가이아프로젝트 불가라 포머는 QIC 전용이고,
                //   어차피 패스 시 전부 자동변환됨 → QIC가 낮을 때 미리 1개 바꿔두면 그 턴 빌드/액션에 활용(무해, 순이득).
                if (player.faction === 'bal_tak' && getPlayerFlag(playerId, 'balTakProactiveQic', false)
                    && (player.qic ?? 0) < 2 && getEffectiveGaiaformers(player) >= 1) {
                    log(`Bot ${player.name} balTak proactive 포머→QIC (qic=${player.qic})`, 'game', game.id);
                    return { type: 'bal_tak_gaiaformer_to_qic', params: {} };
                }
                // [flag: twoTurnPlan] 다턴 플래너 — 시뮬 중엔 실행 안 함(중첩 폭발 방지). 실제 결정에서만 2턴 시퀀스 비교.
                if (!isSimulate) {
                    const planned = await this.planTwoTurn(game, playerId, candidates);
                    if (planned) { log(`Bot ${player.name} twoTurnPlan commit: ${planned.type}`, 'game', game.id); return planned; }
                }
                log(`Bot ${player.name} starting MCTS with ${candidates.length} candidates...`, 'game', game.id);
                const bestAction = await this.mctsWithTimeout(game, playerId, candidates, 'main');

                // 패스하기 직전 자원 변환 (Cleanup logic)
                if (bestAction?.type === 'pass_round') {
                    // HH PI 변환(무료): 패스 전 남는 크레딧을 QIC/광석/지식으로. 봇 루프가 버퍼까지 반복 → 크레딧 풍선 해소.
                    // [낭비수정 2026-07-07] R6 최종 패스 직전 변환은 잔여자원 VP 유닛을 3~4→1로 줄이는 확정 손해
                    // (잔여자원 VP는 종류 무관 3유닛=1VP) → R6 제외. 메인액션 전 변환(위쪽)은 그 턴 활용 가능이라 유지.
                    if ((game.roundNumber ?? 1) < 6) {
                        const hhConv = this.findHadschHallasConvert(game, playerId);
                        if (hhConv) { log(`Bot ${player.name} HH PI convert before pass: ${(hhConv.params as any)?.actionId}`, 'game', game.id); return hhConv; }
                    }
                    // [flag: powerActionOverPass] 패스+1:1 파워변환 대신, 쓸만한 파워액션(findPowerActions: 점수≥0만, 베이스150+)이
                    // affordable하면 그걸 실행 = 생산적 턴(1:1 변환보다 훨씬 이득). MCTS가 파워액션 저평가해 0회 쓰던 것 일반교정
                    // (humanRule2O 일반판, 사용자 관찰). 토큰예비 가드로 연방용 토큰 드레인 방지.
                    if (getPlayerFlag(playerId, 'powerActionOverPass', true) && !game.hasDoneMainAction) {
                        // [flag: ivitsStationBeforePass] Ivits 우주정거장(once-per-round, O/C 무료)을 안 놓고 패스하던 누수 교정.
                        //   데이터: 봇 우주정거장 4.5/게임 vs 사람 11.3 — 라운드마다 빼먹어 사거리·연방 앵커 손실(사용자 관찰: "하이브 특출나게 못함").
                        //   패스 직전 미사용 + 배치 가능하면 우선 배치. (findIvitsSpaceStationAction이 affordable QIC만 반환.)
                        if (player.faction === 'ivits' && !player.usedIvitsSpaceStationThisRound
                            && getPlayerFlag(playerId, 'ivitsStationBeforePass', false)) {
                            const station = this.findIvitsSpaceStationAction(game, playerId);
                            if (station) {
                                log(`Bot ${player.name} ivitsStationBeforePass: 우주정거장 배치 후 패스 보류`, 'game', game.id);
                                return station;
                            }
                        }
                        // [flag: twilightRecoupBeforePass] 패스 직전 twilight 액션1(3QIC→연방보상 재수령 4-12VP) 직접실행.
                        // 데이터: spaceships VP 사람 twilight 8.1 vs 봇 0.1 — 봇은 QIC 남기고 패스(3QIC=패스 시 1VP뿐).
                        // ※ 기각된 shipOverPass(입장 강제→타고 안 씀 −5.49)와 다름: *이미 입장*+3QIC+연방보유일 때 확정 VP만
                        //   회수하는 surgical 직접실행(advTileAlways 패턴). 재수령>패스는 산술적으로 항상 이득.
                        if (getPlayerFlag(playerId, 'twilightRecoupBeforePass', false)
                            && (player.qic ?? 0) >= 3 && getFederationEntries(player).length >= 1) {
                            const twi = this.findPlayerShip(game, playerId, 'ship_twilight');
                            const twiState = twi ? game.spaceships?.[twi.id] : null;
                            if (twi && (player.spaceshipsEntered || []).includes(twi.id)
                                && twiState && !((twiState.usedActionIndices ?? []) as number[]).includes(1)) {
                                log(`Bot ${player.name} twilightRecoupBeforePass: 3QIC 연방보상 재수령 후 패스 보류`, 'game', game.id);
                                return { type: 'use_ship_action', params: { shipTileId: twi.id, actionIndex: 1 } };
                            }
                        }
                        // 패스 직전 once-per-round 특수액션(아카데미 QIC·기술액션)도 사용 — 안 쓰면 그 라운드 통째 낭비(사용자 관찰).
                        // gleens-2nav/space_giants-2tf 등 once-per-game 부스터는 제외(아껴야 함). 이들은 비용 없는 자원획득이라 순이득.
                        const sp = this.findSpecialActions(game, playerId).find(a =>
                            a.params?.actionId === 'academy-qic' || a.type === 'use_tech_action');
                        if (sp) {
                            log(`Bot ${player.name} powerActionOverPass(special): ${sp.type}/${(sp.params as any)?.actionId ?? (sp.params as any)?.tileId} 대신 패스 안 함`, 'game', game.id);
                            return sp;
                        }
                        const pa = this.findPowerActions(game, playerId)[0];
                        if (pa) {
                            const act = game.powerActions.find(a => a.id === pa.params?.actionId);
                            const cost = (act && act.costType !== 'qic') ? act.cost : 0;
                            if (cost === 0 || this.canSpendPowerTokensForStrategicAction(game, player, cost)) {
                                log(`Bot ${player.name} powerActionOverPass: ${pa.params?.actionId} 대신 패스 안 함`, 'game', game.id);
                                return pa;
                            }
                        }
                        // [flag: shipOverPass] 패스 직전 우주선(Lost Fleet) 활용 — 사람 초반 우주선 30% vs 봇 11%,
                        //   봇은 대신 초반 패스 17%(할 게 없어 놈). 이미 탄 배의 액션(무료 자원/기술) 우선, 없으면 입장
                        //   (어차피 패스할 턴이니 생산적). 사람처럼 초반에 우주선으로 자원·확장을 뽑게. 파인더가 유효/afford만 반환.
                        if (getPlayerFlag(playerId, 'shipOverPass', false)) {
                            const shipAct = this.findSpaceshipActions(game, playerId)[0];
                            if (shipAct) { log(`Bot ${player.name} shipOverPass: 우주선 액션 대신 패스 안 함`, 'game', game.id); return shipAct; }
                            const shipEnter = this.findSpaceshipEntryActions(game, playerId)[0];
                            if (shipEnter) { log(`Bot ${player.name} shipOverPass: 우주선 입장 대신 패스 안 함`, 'game', game.id); return shipEnter; }
                        }
                    }
                    // [flag: taklonsSpendIdleBrain] 계측결과: 브레인을 bowl3로 옮겨도(번) 안 쓰고 턴종료(브레인놀림 1.6~2.1/게임).
                    //   핵심은 "옮기기"가 아니라 "쓰기" — 패스 직전 브레인이 bowl3에 놀고 있으면 3P→1O(useBrain)로 써버림
                    //   (안 쓸 바엔 1O이라도, 사용자). 브레인 3파워 소진 = idle 방지. cleanup보다 먼저.
                    if (getPlayerFlag(playerId, 'taklonsSpendIdleBrain', false)
                        && player.faction === 'taklons' && player.brainStoneBowl === 3 && !player.brainStoneInGaia) {
                        log(`Bot ${player.name} taklonsSpendIdleBrain: 브레인 3P→1O (idle 방지)`, 'game', game.id);
                        return { type: 'convert_resource', params: { type: '3power-to-1ore', useBrain: true } };
                    }
                    const cleanup = this.findCleanupConvertAction(game, playerId, bestAction.params?.bonusTileId);
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

    /**
     * [flag: twoTurnPlan] 다턴 플래너 v1 — 탑 후보 각각을 '이번 액션 + 다음 턴 최선 후속'까지 실제 시뮬(라운드 내라
     *   수입 없이 정확)해 2턴 종료상태로 비교, 최고 시퀀스의 첫 수를 커밋. deepRollout(fuzzy 그리디 롤아웃)과 달리
     *   탑후보를 deliberate하게 enumerate·비교 = 사용자 원안("두 시퀀스 비교해 좋은 쪽"). 후속은 그리디 1-ply(MCTS 재귀 회피).
     *   1-ply 평가가 못 보는 '셋업→페이오프'(nav→무료건설, 포머→광산)를 2턴 시야로 포착 시도.
     */
    private static async planTwoTurn(game: ServerGameState, playerId: string, candidates: BotAction[]): Promise<BotAction | null> {
        if (!getPlayerFlag(playerId, 'twoTurnPlan', false)) return null;
        if (game.hasDoneMainAction) return null;
        const dummyIo = { to: () => ({ emit: () => { } }) } as any;
        // 메인 액션 후보만(패스/변환 제외). 상위 6개만 평가(성능).
        const mains = candidates.filter(c => c.type !== 'pass_round' && c.type !== 'convert_resource').slice(0, 6);
        if (mains.length < 2) return null;

        // 후속턴 모델: 같은 상태에서 그리디 1-ply 최선 액션을 골라 state에 직접 적용.
        const applyGreedyFollowup = async (state: ServerGameState): Promise<void> => {
            let cands: BotAction[] = [];
            try { cands = this.getCandidateMoves(state, playerId).filter(c => c.type !== 'pass_round').slice(0, 5); } catch { return; }
            let best: BotAction | null = null, bestS = -Infinity;
            for (const fc of cands) {
                try {
                    const s2 = StateCloner.cloneGameStateForSimulation(state); (s2 as any).simulation = true;
                    const ok = await this.performAction(dummyIo, s2, fc, playerId);
                    if (!ok) continue;
                    const sc = Evaluator.evaluateState(s2, playerId);
                    if (sc > bestS) { bestS = sc; best = fc; }
                } catch { /* skip */ }
            }
            if (best) { try { await this.performAction(dummyIo, state, best, playerId); } catch { /* */ } }
        };

        let bestAct: BotAction | null = null, bestScore = -Infinity;
        for (const c of mains) {
            try {
                const s1 = StateCloner.cloneGameStateForSimulation(game); (s1 as any).simulation = true;
                const ok = await this.performAction(dummyIo, s1, c, playerId);
                if (!ok) continue;
                // 다음 턴(같은 라운드, 수입 없음): 메인액션 플래그만 리셋하고 그리디 후속 적용
                (s1 as any).hasDoneMainAction = false;
                await applyGreedyFollowup(s1);
                const score = Evaluator.evaluateState(s1, playerId);
                if (score > bestScore) { bestScore = score; bestAct = c; }
            } catch { /* skip candidate */ }
        }
        return bestAct;
    }

    /** 패스하기 직전에 다음 라운드 수입으로 인해 버려지는 자원이 생기지 않도록 미리 변환 시도 */
    /** [flag: hadschHallasConvert] HH PI 무료 변환(4C→1QIC / 3C→1O / 4C→1K) — 남는 크레딧을 부족한 자원으로.
     *  봇이 HH 시그니처를 0회 쓰던 갭(사람 44.7/게임) + 크레딧 풍선(봇 크레딧 과잉) 동시 교정.
     *  QIC(연방·건설·가이아에 귀함) 최우선, 그다음 부족한 광석/지식. 건설 버퍼(6C)는 남긴다. */
    private static findHadschHallasConvert(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        if (!player || player.faction !== 'hadsch_hallas') return null;
        if (!getPlayerFlag(playerId, 'hadschHallasConvert', true)) return null;
        const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
        if (!hasPI || !player.hadschHallasPIActions?.length) return null;
        const credits = player.credits ?? 0;
        const BUFFER = 3; // 즉시 쓸 최소 크레딧만 남김(HH는 크레딧 부자라 적극 전환)
        const qic = player.qic ?? 0, ore = player.ore ?? 0, know = player.knowledge ?? 0;
        // [flag: hhConvertMinimal] 사용자 관찰: 어제 채택한 HH 변환이 과함 — QIC를 8까지 쟁이고(qic<8) 크레딧 풍선을 무한
        //   배출해서, 이번 턴 3개만 쓸 건데 5개+를 미리 바꿔둠. 안 쓸 QIC는 죽은 크레딧과 다를 바 없고(개당 4C 지불) 오히려 손해.
        //   → 목표를 "필요한 만큼(~3)"으로 낮추고, 순수 풍선배출(QIC로 무한 전환)을 제거. 부족한 광석/지식 보충은 유지.
        const minimal = getPlayerFlag(playerId, 'hhConvertMinimal', true);
        const qicTarget = minimal ? 3 : 8;
        // QIC(연방·건설·가이아에 귀함): 목표 미만이고 크레딧 여유 있으면 전환
        if (qic < qicTarget && credits >= 4 + BUFFER) return { type: 'use_hadsch_hallas_pi_action', params: { actionId: 'hh-4c-1qic' } };
        // 광석 부족(<3)하면 3C→1O (건설 연료)
        if (ore < 3 && credits >= 3 + BUFFER) return { type: 'use_hadsch_hallas_pi_action', params: { actionId: 'hh-3c-1o' } };
        // 지식 부족(<3)하면 4C→1K
        if (know < 3 && credits >= 4 + BUFFER) return { type: 'use_hadsch_hallas_pi_action', params: { actionId: 'hh-4c-1k' } };
        // 크레딧 풍선(>=10)이면 남는 걸 QIC로 계속 빼 (죽은 크레딧 < 자원) — minimal이면 이 무한배출은 안 함(안 쓸 QIC=손해).
        if (!minimal && credits >= 10) return { type: 'use_hadsch_hallas_pi_action', params: { actionId: 'hh-4c-1qic' } };
        return null;
    }

    private static findCleanupConvertAction(game: ServerGameState, playerId: string, nextBonusTileId?: string): BotAction | null {
        const player = game.players[playerId];
        if (!player) return null;

        // [룰 2026-07-11] 종료 정산이 파워를 자동 환산(2그릇 번→3그릇→크레딧, 네뷸라PI 2C/타클론 브레인 3C)하므로
        // R6 최종 패스 전 수동 변환은 무의미하거나 손해(3P→1O = 3C어치→1유닛). 이 함수의 목적(다음 라운드 준비)도
        // R6엔 소멸 → 전체 스킵.
        if ((game.roundNumber ?? 1) >= 6) return null;

        // [flag: gaiaResearchPlaceSync] 미배치 포머 + 가이아 L1+ 상태에서 토큰을 소모하는 정리 변환(1P→1C 등)이
        // 배치 예산(레벨별 6/4/3 토큰)을 파먹으면 포머가 영영 못 나감(실측: 네블라스 토큰 6→1P→1C→5로 라인 사망).
        // 예산 이하로 떨어뜨리는 정리 변환은 스킵 — 배치가 끝나면(포머 소진) 자동 해제.
        if (getPlayerFlag(playerId, 'gaiaResearchPlaceSync', true) && player.faction !== 'bal_tak') {
            const gl = player.research?.gaiaProject ?? 0;
            if (gl >= 1 && (player.gaiaformers ?? 0) > 0) {
                const needTok = gl < 3 ? 6 : gl < 4 ? 4 : 3;
                const totTok = (player.power1 ?? 0) + (player.power2 ?? 0) + (player.power3 ?? 0);
                if (totTok <= needTok) return null;
            }
        }

        const overflowActions = this.getPassResourceOverflowCleanupActions(game, playerId, nextBonusTileId);
        if (overflowActions.length > 0) return overflowActions[0];

        const { powerIncome, tokenIncome } = this.calculateExpectedPowerIncome(game, playerId, nextBonusTileId);

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

        // Gaia의 파워는 "그릇 이동" 구조라 일반적으로 수입으로 낭비되지 않는다.
        // 따라서 cleanup 변환은 정말 예외적으로만 수행한다:
        // - 패스 직전, 다음 라운드에 도움이 되는 최소 자원(O/C) 확보가 필요할 때만
        // - QIC(4P→1Q)는 파워 액션을 대체할 만큼 강하지 않으므로 여기서는 사용하지 않는다
        const currentP3 = player.power3 ?? 0;
        const isTaklons = player.faction === 'taklons';

        // [버그수정 2026-06-23] 충전 낭비 회수 — 위 주석("낭비 안 됨")은 틀렸음.
        // 다음 라운드 충전(powerIncome)이 bowl1/2 흡수용량(2*p1 + p2)을 초과하면, bowl3가 꽉 차 초과분이 증발한다.
        // 패스 전 bowl3 토큰을 자원으로 비우면(→bowl1) 다음 충전이 그걸 다시 끌어올려 '낭비될 충전 = 공짜 자원'으로 회수.
        // 비울 자원: 다음 라운드 ore 부족 예상이면 ore(3p→1o, 토큰3 비움), 아니면 credit(1p→1c, 토큰1 비움). (사용자 규칙)
        // 한 번에 한 변환만 반환 → 패스 전 반복 호출로 wasted가 0이 될 때까지 체인.
        {
            const absorbCapacity = 2 * ((player.power1 ?? 0) + tokenIncome) + (player.power2 ?? 0);
            const wastedCharge = Math.max(0, powerIncome - absorbCapacity);
            if (wastedCharge > 0 && currentP3 >= 1) {
                const nevPI = player.faction === 'nevlas' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
                const exp = this.calculateExpectedRoundIncome(game, playerId, nextBonusTileId);
                const oreShort = ((player.ore ?? 0) + (exp.ore ?? 0)) < 3;
                const can3pOre = isTaklons
                    ? (canSpendTaklonsPowerWithoutBrain(player, 3, 3) || canTaklonsSpendUsingBrain(player, 3, 3))
                    : (nevPI ? currentP3 >= 2 : currentP3 >= 3);
                if (oreShort && can3pOre) {
                    const useBrain = isTaklons && canTaklonsSpendUsingBrain(player, 3, 3) && !canSpendTaklonsPowerWithoutBrain(player, 3, 3);
                    return { type: 'convert_resource', params: { type: nevPI ? '2power-to-1ore-1credit' : '3power-to-1ore', useBrain } };
                }
                return { type: 'convert_resource', params: { type: '1power-to-1credit', useBrain: isTaklons } };
            }
        }

        // 다음 라운드 수입이 아예 없으면 굳이 변환할 이유가 더 줄어듦
        const hasIncoming = (powerIncome + tokenIncome) > 0;

        // 최소 운영자금 확보(다음 라운드에 광산/교역소를 올릴 수 있게): O/C가 너무 바닥일 때만
        if (hasIncoming) {
            // [flag: cleanupIncomeAware] 사용자 관찰(2026-07-12): 4/0/1 + 충전수입 2뿐인데 1P→1C 후 패스 →
            // 3/2/0 시작(2/2/1이 명백히 우위). 원인 = 이 분기가 '현재' O/C만 보고 다음 라운드 수입을 무시 —
            // 수입으로 채워질 자원을 위해 그릇3 토큰(액션 사거리 자산)을 강등. 수입 합산 후에도 바닥일 때만 변환.
            const incomeAware = getPlayerFlag(playerId, 'cleanupIncomeAware', true);
            const expInc = incomeAware ? this.calculateExpectedRoundIncome(game, playerId, nextBonusTileId) : null;
            const effOre = (player.ore ?? 0) + (expInc?.ore ?? 0);
            const effCredits = (player.credits ?? 0) + (expInc?.credits ?? 0);
            // 네뷸라 의회: 오레 변환에 bowl-3 토큰 2개를 쓰는데, '3power-to-1ore'는 1O만 주고 1파워어치가 버려짐.
            // 같은 2토큰으로 1O+1C를 주는 '2power-to-1ore-1credit'을 써서 1C 낭비 방지 (사용자 관찰).
            const hasNevlasPI = player.faction === 'nevlas' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
            const can3pOre = isTaklons
                ? canSpendTaklonsPowerWithoutBrain(player, 3, 3) || canTaklonsSpendUsingBrain(player, 3, 3)
                : (hasNevlasPI ? currentP3 >= 2 : currentP3 >= 3);
            if (can3pOre && (incomeAware ? effOre : (player.ore ?? 0)) < 1) {
                const useBrain = isTaklons && canTaklonsSpendUsingBrain(player, 3, 3) && !canSpendTaklonsPowerWithoutBrain(player, 3, 3);
                const oreType = hasNevlasPI ? '2power-to-1ore-1credit' : '3power-to-1ore';
                return { type: 'convert_resource', params: { type: oreType, useBrain } };
            }
            if (currentP3 >= 1 && (incomeAware ? effCredits : (player.credits ?? 0)) < 2) {
                return { type: 'convert_resource', params: { type: '1power-to-1credit', useBrain: isTaklons } };
            }
        }

        return null;
    }

    /** 패스 후 받을 수입까지 계산했을 때 O/K 15 상한을 넘으면, 넘칠 만큼 C로 바꿔 보존한다. */
    private static getPassResourceOverflowCleanupActions(game: ServerGameState, playerId: string, nextBonusTileId?: string): BotAction[] {
        const player = game.players[playerId];
        if (!player) return [];

        const expected = this.calculateExpectedRoundIncome(game, playerId, nextBonusTileId);
        let ore = player.ore ?? 0;
        let knowledge = player.knowledge ?? 0;
        let credits = player.credits ?? 0;
        const actions: BotAction[] = [];

        while (actions.length < 30) {
            const creditRoomAfterIncome = 30 - (credits + expected.credits);
            if (creditRoomAfterIncome <= 0) break;

            const oreOverflow = Math.max(0, ore + expected.ore - 15);
            const knowledgeOverflow = Math.max(0, knowledge + expected.knowledge - 15);
            if (oreOverflow <= 0 && knowledgeOverflow <= 0) break;

            if (oreOverflow >= knowledgeOverflow && ore > 0) {
                ore -= 1;
                credits += 1;
                actions.push({ type: 'convert_resource', params: { type: '1ore-to-1credit' } });
            } else if (knowledge > 0) {
                knowledge -= 1;
                credits += 1;
                actions.push({ type: 'convert_resource', params: { type: '1knowledge-to-1credit' } });
            } else if (ore > 0) {
                ore -= 1;
                credits += 1;
                actions.push({ type: 'convert_resource', params: { type: '1ore-to-1credit' } });
            } else {
                break;
            }
        }

        return actions;
    }

    private static calculateExpectedRoundIncome(
        game: ServerGameState,
        playerId: string,
        nextBonusTileId?: string
    ): { ore: number; credits: number; knowledge: number; qic: number; powerCharge: number; powerTokens: number } {
        const result = getNextRoundIncomePreview(playerId, game, { excludeBonusTiles: true });
        const player = game.players[playerId];
        const covered = new Set(player?.coveredTechTiles ?? []);

        if (covered.has('tech-inc-1o-1p')) {
            result.ore = Math.max(0, result.ore - 1);
            result.powerCharge = Math.max(0, result.powerCharge - 1);
        }
        if (covered.has('tech-inc-4c')) {
            result.credits = Math.max(0, result.credits - 4);
        }
        if (covered.has('tech-inc-1k-1c')) {
            result.knowledge = Math.max(0, result.knowledge - 1);
            result.credits = Math.max(0, result.credits - 1);
        }

        if (nextBonusTileId) {
            const bonusTile = ALL_BONUS_TILES.find(t => t.id === nextBonusTileId);
            const income = bonusTile?.income;
            if (income?.ore) result.ore += income.ore;
            if (income?.credits) result.credits += income.credits;
            if (income?.knowledge) result.knowledge += income.knowledge;
            if (income?.qic) result.qic += income.qic;
            if (income?.power) result.powerCharge += income.power;
            if (income?.powerTokens) result.powerTokens += income.powerTokens;
        }

        if (player?.artifacts?.includes('art-income-1k1o')) {
            result.knowledge += 1;
            result.ore += 1;
        }
        if (player?.artifacts?.includes('art-income-2p3')) {
            result.powerTokens += 2;
        }

        return result;
    }

    /** 다음 라운드 수입 단계에서 들어올 파워와 토큰 양 예측 */
    private static calculateExpectedPowerIncome(game: ServerGameState, playerId: string, nextBonusTileId?: string): { powerIncome: number; tokenIncome: number } {
        const income = this.calculateExpectedRoundIncome(game, playerId, nextBonusTileId);
        return { powerIncome: income.powerCharge, tokenIncome: income.powerTokens };
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

        // 이미 메인 액션을 수행했더라도 후속 배치 대기면 후속 조치 필요
        if (game.hasDoneMainAction && !game.pendingShipTechMine && !game.pendingSpaceshipFedMine && !game.pendingEclipseAsteroidMine) {
            return [{ type: 'end_turn', params: {} }];
        }

        const candidates: BotAction[] = [];

        // [hang 근본수정 2026-07-05] Eclipse 연구트랙 선택 대기 — 후보로도 강제 처리
        if (game.pendingEclipseResearch?.playerId === playerId) {
            const elTracks = this.pickResearchTracks(game, player, playerId);
            const ALL_EL: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
            const elPick = [...elTracks, ...ALL_EL].find(t => (player.research[t] ?? 0) < 5
                && !(t === 'navigation' && player.faction === 'bal_tak' && !game.map.some(x => x.ownerId === playerId && x.structure === 'planetary_institute')));
            return [{ type: 'eclipse_advance_track', params: { trackId: elPick ?? 'economy' } }];
        }

        // 0a. 고급 기술 타일 커버/트랙 전진 대기 상태는 강제 처리 (이걸 안 하면 턴 진행 불가)
        if (game.pendingAdvancedTechCover?.playerId === playerId) {
            const covered = new Set(player.coveredTechTiles ?? []);
            const coverTileId = (player.techTiles ?? []).find(tid => !covered.has(tid)) ?? (player.techTiles?.[0] ?? null);
            return coverTileId ? [{ type: 'cover_advanced_tech_tile', params: { coverTileId } }] : [];
        }
        if (game.pendingAdvancedTechTrackAdvance?.playerId === playerId) {
            const tracks = this.pickResearchTracks(game, player, playerId);
            return tracks.map(trackId => ({ type: 'advance_tech', params: { trackId } }));
        }

        // 0. 기술 타일 선택 대기 상태라면 다른 액션은 불가능. (MCTS 확장을 위해 모든 가능한 타일을 후보로 제공)
        if (game.pendingTechTileSelection?.playerId === playerId) {
            const availableTiles: TechTile[] = [];
            game.techTilesPool.forEach(t => { if (t && !player.techTiles.includes(t.id)) availableTiles.push(t); });
            for (const trackTiles of Object.values(game.techTilesByTrack)) {
                const arr = Array.isArray(trackTiles) ? trackTiles : [trackTiles];
                for (const t of arr) { if (t && !player.techTiles.includes(t.id)) availableTiles.push(t); }
            }
            if (game.availableShipTechTileIds) {
                for (const shipTechId of game.availableShipTechTileIds) {
                    const shipTech = SHIP_TECH_TILES.find(st => st.id === shipTechId);
                    if (shipTech && !player.techTiles.includes(shipTechId)) availableTiles.push(shipTech);
                }
            }

            // 모든 기술 타일마다 가장 좋은 트랙을 선택해 후보로 추가
            const tracks = this.pickResearchTracks(game, player, playerId);
            const trackId = tracks.length > 0 ? tracks[0] : ('economy' as ResearchTrack);
            
            // 트랙 4 이상이고 초록 토큰이 있으면: 트랙 고급 기술 타일도 후보로 제공
            let advCandCount = 0;
            if (countGreenFederations(player) >= 1 && game.advancedTechTilesByTrack) {
                for (const [t, adv] of Object.entries(game.advancedTechTilesByTrack)) {
                    const tr = t as ResearchTrack;
                    const lvl = player.research?.[tr] ?? 0;
                    if (lvl >= 4 && adv?.id && !player.techTiles.includes(adv.id)) {
                        candidates.push({ type: 'select_advanced_tech_tile', params: { advancedTileId: adv.id, trackId: tr } });
                        advCandCount++;
                    }
                }
            }
            void advCandCount; // (계측용 카운터 — 실제 결정은 findTechTileAction 경로)

            for (const tile of availableTiles) {
                const resolvedTrackId = this.getTrackForTechTile(game, tile.id) ?? trackId;
                candidates.push({
                    type: 'select_tech_tile',
                    params: {
                        techTileId: tile.id,
                        trackId: resolvedTrackId,
                        advanceToLevel5: this.shouldAdvanceToLevel5OnTechSelection(game, playerId, resolvedTrackId),
                    }
                });
            }
            return candidates; // 기술 타일 선택 대기 중이면 다른 액션은 못함
        }

        // Eclipse 6C 후 소행성 광산: 합법 타일만 (MCTS/시뮬과 서버 일치)
        if (game.pendingEclipseAsteroidMine?.playerId === playerId) {
            const eclipseIds = getLegalEclipseAsteroidMineTileIds(game, playerId);
            return eclipseIds.map(tileId => ({ type: 'eclipse_build_asteroid_mine', params: { tileId } }));
        }

        // 1. 연방 구성 (가장 중요) — 라운드별 상한을 다르게 적용
        // R≤2: 토큰 후보 3개까지, R3+: 5개까지, R4+: 8개까지 (후보 다양성 확대로 큰 연방 선택지 확보)
        const _round = (game as any).roundNumber ?? 1;
        const totalPowerTokens = (player.power1 ?? 0) + (player.power2 ?? 0) + (player.power3 ?? 0);
        // [flag: piBeforeFed] 사용자 관찰(2026-07-05): 봇이 연방 먼저 → 내부 PI/업글(파워 낭비). 실측: PI가 연방 前 26 vs
        // 後 41, xenos는 前0/後6(의회 선건설 시 요구파워 6 혜택을 매번 놓침), 연방후 업글의 51%가 닫힌 연방 내부.
        // 의회를 아직 안 지었고 지금 지을 수 있으면(자원+연구소) 이 턴 연방 형성을 보류 — PI(3~4파워, xenos 문턱6)를
        // 먼저 넣어 더 싸고 강한 연방을 만들게. R≤5 한정(R6은 연방이 급함).
        let holdFedForPi = false;
        if (getPlayerFlag(playerId, 'piBeforeFed', true) && _round <= 5) {
            const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
            if (!hasPI) {
                const piUpgradeReady = this.findUpgradeActions(game, playerId)
                    .some(u => u.type === 'upgrade_structure' && (u.params as any)?.target === 'planetary_institute');
                if (piUpgradeReady) holdFedForPi = true;
            }
        }
        const fedTopN = _round >= 4 ? 8 : _round >= 3 ? 5 : 3;
        const fedActions = holdFedForPi ? [] : FederationPlanner.getFederationActions(game, playerId, 0, fedTopN);
        for (const fedAction of fedActions) {
            const spent = fedAction.spentTokens ?? 0;
            const tokenSurplus = totalPowerTokens - spent;
            // R≥3은 비싼 연방도 적극 허용, R≥4는 토큰 부족해도 일단 후보로 넣어 MCTS가 판단
            const allowEarlyExpensiveFed = _round >= 4 || (_round >= 3 && (spent <= 6 || tokenSurplus >= 4)) || spent <= 2 || tokenSurplus >= 8;
            if (allowEarlyExpensiveFed && this.canSpendPowerTokensForStrategicAction(game, player, spent)) {
                // [flag: fedSpendBowl3] 사용자 관찰: 제노스 등이 연방하려 충전한 bowl3 토큰을 안 쓰고 그대로 둔 채 연방함.
                //   위성 지불은 bowl1→2→3 순이라 남는 bowl3는 idle. 연방 전에 그 idle bowl3를 프리액션(1P→1C)으로 미리 써서
                //   가치(크레딧)를 뽑는다. 1P→1C는 bowl3→bowl1로 토큰을 되돌리므로(제거X) 위성 지불 총량엔 영향 없음(안전).
                // [flag: bowl3CashoutOre] 위성이 소모할 bowl3 deficit도 먼저 변환해 회수(순이득, 사용자 룰) — idle 변환에 선행
                // [flag: ivitsFedPowerFix] 이비츠 위성 = QIC 지불이라 토큰 소모 자체가 없음 — 이 회수(및 아래
                // fedSpendBowl3의 idle 배출)는 근거 부재로 액션 연료만 태움(사용자 관찰: 연방 전 3pw 정리). 면제.
                const ivitsNoPowerDrain = player.faction === 'ivits' && getPlayerFlag(playerId, 'ivitsFedPowerFix', true);
                const fedDoomed = (getPlayerFlag(playerId, 'bowl3CashoutOre', true) && !ivitsNoPowerDrain)
                    ? this.doomedBowl3CashoutPreActions(player, spent, playerId) : [];
                const fedBowl3Pre = [...fedDoomed, ...this.fedSpendBowl3PreActions(playerId, player, spent)];
                candidates.push(fedBowl3Pre.length
                    ? { type: 'form_federation', params: fedAction, preActions: fedBowl3Pre }
                    : { type: 'form_federation', params: fedAction });
            }
        }

        // 1b. 프리 액션 kO→k토큰 후 연방: k=2..min(ore,6) 각각 후보로 넣어서 MCTS가 효율(최소 오레로 12VP 등) 판단
        // Ivits는 연방 위성 비용이 QIC이므로, 여기서 "오레->토큰" 프리액션을 섞으면 계산(availableTokens)이 틀어져 QIC 마이너스가 날 수 있음.
        if (player.faction !== 'ivits' && !holdFedForPi) {
            const oreForFed = player.ore ?? 0;
            // [flag: oreFedGuard] 사용자 관찰(2026-07-04): "쓸모없이 Ore 다 위성 변환해서 무리한 연방".
            // 기존 R4+는 광석 8개까지 + 위성수 무제한 → 후반 evaluator가 광석을 싸게 쳐(resMultLate) 8O 올인 연방.
            // 교정: R4-5도 광석 예비 1개 유지 + k≤4 + spent>6 금지. R6만 관대(잔여광석=⅓VP뿐이라 큰 연방이 이득).
            const guard = getPlayerFlag(playerId, 'oreFedGuard', true);
            // [사용자 관찰 2026-07-05] R6 관대(8)도 회수: 제노스가 막라에 광물 8개→토큰, 연방은 위성 4개만 사용
            // → 4토큰 증발 + 막라 미션 업글 액션(광물) 불가. R6도 예비 1개 유지, 상한 6.
            // [flag: fedSatCapHuman] 연방목표(2026-07-12): 상한 완화는 셀프플레이에서 '연방 무효'(봇끼리는 리치
            // 빈약 → 토큰이 안 쌓여 상한이 안 물림)였으나, 사람 게임은 리치 풍부(지불 8.7VP ≈ 토큰 17+ 순환)라
            // 상한이 실제로 묾. humanPowerRace 패턴: 사람 있는 게임만 변환 +2/위성 상한 9 — 셀프플레이 무오염.
            const fedHumanRelax = (getPlayerFlag(playerId, 'fedSatCapHuman', true)
                && ((game.botPlayerIds?.length ?? 0) < Object.keys(game.players).length
                    || getPlayerFlag(playerId, 'fedSatCapHumanForce', false))) ? 2 : 0; // Force = 스모크 검증 전용
            // [flag: fedR6ConvCap] 사용자 1순위(2026-07-20): "연방이 좋다고 보이면 온갖 손실을 하며 연방" —
            // 실측: R6 연방 중 광석→토큰 동반 사람 14%(평균 2.0개) vs 봇 58%(3.4개). R6 광석 = 미션·건설·잔여
            // 가치라 3개+ 태우면 보상(7-12VP)을 숨은 비용이 잠식. 사람 상한(≤3)으로 변환 캡 — 비싼 연방 후보만
            // 소멸, 싼 연방(변환 ≤3)은 유지.
            const r6ConvCap = getPlayerFlag(playerId, 'fedR6ConvCap', true) ? 3 : 6 + fedHumanRelax;
            const maxK = guard
                ? (_round >= 6 ? Math.min(Math.max(0, oreForFed - 1), r6ConvCap) : _round >= 4 ? Math.min(Math.max(0, oreForFed - 1), 4 + fedHumanRelax) : Math.min(oreForFed, 3))
                : (_round >= 4 ? Math.min(oreForFed, 8) : Math.min(oreForFed, 6));
            const fedSubN = _round >= 4 ? 4 : 2;
            for (let k = 2; k <= maxK; k++) {
                const fedWithKs = FederationPlanner.getFederationActions(game, playerId, k, fedSubN);
                for (const fedWithK of fedWithKs) {
                    const spent = fedWithK.spentTokens ?? 0;
                    // 초반엔 "오레 태워서 위성 많이" 연방을 억제 (정말 싸면 허용)
                    if (_round <= 2 && spent > 2) continue;
                    // R3+: 다소 비싼 후보도 허용
                    if (_round === 3 && spent > 6) continue;
                    // [flag: oreFedGuard] R4-5도 위성 상한(기존 무제한) — R6 endgame만 예외
                    // [flag: fedSatCapHuman] 사람 게임에선 9까지 (리치 풍부 환경에서만 물리는 제약)
                    if (guard && _round >= 4 && _round <= 5 && spent > 6 + fedHumanRelax) continue;
                    if (!this.canSpendPowerTokensForStrategicAction(game, player, spent, k)) continue;
                    // [버그수정 2026-07-05] 기존엔 k개를 무조건 변환 — 연방이 위성 spent개만 쓰면 (k-부족분)토큰이
                    // 통째로 증발(사용자 관측: 8변환→4위성=4증발). 변환은 *부족분*(spent-보유토큰)만.
                    const shortfall = Math.max(0, spent - totalPowerTokens);
                    if (shortfall <= 0) continue; // 변환 불필요 = 1a 후보와 중복
                    const oreToTokenPre = Array.from({ length: shortfall }, () => ({ type: 'convert_resource' as const, params: { type: '1ore-to-1token' } }));
                    // [버그수정 2026-07-07 사용자 관찰: "토큰 바꾸고 연방하면 3그릇 토큰 안 쓰고 감 여전"]
                    //   이 경로(ore→token 연방)는 shortfall>0 = 보유 토큰이 부족 → 위성이 bowl3 포함 보유 토큰을 전부 소모함.
                    //   그런데 무변환 연방 경로(위 1a)와 달리 이 경로엔 bowl3 cashout이 안 붙어, 소모될 bowl3를 1P→1C/3P→1O로
                    //   회수하지 않고 그냥 위성으로 태웠음(가치 낭비). ore→token으로 bowl1이 +shortfall 되는 것(bowl1Extra)까지
                    //   반영해 '위성에 소모될' bowl3만 정확히 회수(위성 지불 총량 불변, 순 크레딧/광석 이득). taklons는 함수가 자체 제외.
                    const fedKCashout = this.doomedBowl3CashoutPreActions(player, spent, playerId, shortfall);
                    const preActions = [...oreToTokenPre, ...fedKCashout];
                    candidates.push({ type: 'form_federation', params: fedWithK, preActions });
                }
            }
        }

        // 2. pendingTerraformSteps가 있으면 바로 광산 건설 (다른 메인 액션 차단)
        //    단, 지을 데가 없으면(사거리밖/자원부족/광산한도) 빈 배열을 그대로 반환하면 후보 0개 → 봇 강제 패스 +
        //    연구 블록(아래)에 도달 못 해 4지식이 묶이는 버그(사용자 관찰). 못 지을 땐 강제 반환하지 말고 일반 후보로 폴백.
        if ((player.pendingTerraformSteps || 0) > 0) {
            const builds = this.findBuildActionsWithPendingSteps(game, playerId);
            if (builds.length > 0) return builds; // 지을 수 있으면 그것만(다른 액션 배제)
            // 못 지으면 폴백: 아래에서 연구/업그레이드/파워 등 일반 후보를 계속 생성
        }

        // 3. Ivits 우주정거장 전략
        if (player.faction === 'ivits' && !player.usedIvitsSpaceStationThisRound) {
            const ivitsAction = this.findIvitsSpaceStationAction(game, playerId);
            if (ivitsAction) candidates.push(ivitsAction);
        }

        // 3-1. Firaks 의회 다운그레이드(랩→TS + 연구 1단계) — 종족 핵심 엔진. 메인 액션, 라운드당 1회.
        // 사용자 관찰: 거의 모든 유저가 1~2라운드부터 쓰려는 최고 능력인데 봇이 전혀 활용을 못했음(후보 생성 자체가 없었음).
        if (player.faction === 'firaks' && getPlayerFlag(playerId, 'firaksDowngrade', true)) {
            const fd = this.findFiraksDowngradeAction(game, playerId);
            if (fd) candidates.push(fd);
        }

        // 4. 교역소 할인 업그레이드
        const discountedTS = this.findDiscountedUpgradeAction(game, playerId);
        if (discountedTS) candidates.push(discountedTS);

        // 5. 일반 건설 시도
        const buildActions = this.findBuildActions(game, playerId);

        // [flag: fedBridge] 묘수: 빈 타일에 광산을 지으면 연방이 *새로* 가능해지는 '브리징 빌드'를 강제 우선.
        // 휴리스틱/학습/LLM이 못 푸는 공간 연방계획을, 좁은 부분문제의 정확탐색(getBestFederationAction what-if)으로 직격.
        // (사람 R3 묘수 = 2채 지어 7파워 연결→연방. 연방은 봇 최대약점이라 고가치.) 프로토타입: 1빌드 완성형만.
        // [flag: multiTurnPlan] 다턴 계획엔진: 연방완성 plan을 game에 저장해 여러 턴 commit(fedBridge는 commit 안 해 −3.59였음).
        if (getPlayerFlag(playerId, 'multiTurnPlan', false) && !game.simulation && buildActions.length > 0) {
            const step = this.getMultiTurnFedStep(game, playerId, buildActions);
            if (step) return [step]; // persistent 계획의 다음 스텝 commit
        }
        // [flag: fedBridge] (구) 비-persistent 버전 — 기각(−3.59), OFF 유지
        if (getPlayerFlag(playerId, 'fedBridge', false) && !game.simulation && buildActions.length > 0) {
            const bridge = this.findFederationBridge(game, playerId, buildActions);
            if (bridge) return [bridge];
        }

        if (buildActions.length > 0) candidates.push(...buildActions);

        // [flag: asteroidMainCandidate] per-candidate 데이터: 사람 소행성광산 48건이 봇 후보에 없었음 —
        // Eclipse 6C 소행성이 findAlternativeBuildAction(자원기아·광산캡 *폴백*)에만 있어 정상 상황에선 MCTS가 검토 불가.
        // 사람은 이걸 주력 수로 씀(소행성=미션·타입다양성·확장). affordable하면 정규 후보로 승격 — 채택은 MCTS가 평가.
        if (getPlayerFlag(playerId, 'asteroidMainCandidate', true) && (player.credits ?? 0) >= 6) {
            const alt = this.findAlternativeBuildAction(game, playerId);
            if (alt && !candidates.some(c => c.type === alt.type && (c.params as any)?.shipTileId === (alt.params as any)?.shipTileId && (c.params as any)?.actionIndex === (alt.params as any)?.actionIndex)) {
                candidates.push(alt);
            }
        }

        // 6. 일반 업그레이드 시도
        let upgradeActions = this.findUpgradeActions(game, playerId);
        // [flag: expandOverTS] 사용자 라벨(Q5): 초반엔 확장(미점유 타일 광산)이 교역소 업글보다 급함(타일 선점당함, TS는 천천히).
        //   봇은 교역소 업글에 편중(초반 봇 17% vs 사람 8%). R≤3에 '미점유 새 타일 광산' 후보가 있으면 mine→TS 업글 후보 제거해 확장 우선.
        if (getPlayerFlag(playerId, 'expandOverTS', false) && ((game as any).roundNumber ?? 1) <= 3) {
            const faction = FACTIONS.find(f => f.id === player.faction);
            const homeType = faction?.homePlanet;
            const hasFreshExpansion = buildActions.some(b => {
                if (b.type !== 'build_mine') return false;
                const t = game.map.find(x => x.id === (b.params as any)?.tileId);
                return t && !t.ownerId && t.type !== homeType; // 미점유 + 비모행성유형 = 새 확장
            });
            if (hasFreshExpansion) {
                upgradeActions = upgradeActions.filter(u => !(u.type === 'upgrade_structure' && (u.params as any)?.target === 'trading_station'));
            }
        }
        // [flag: missionBankTS] 다턴뱅킹 2호(TS미션 갭 0.92): 다음 라운드가 build_trading_station 미션이고 이번은
        // 아니면 mine→TS 업글을 한 라운드 보류(TS수입 1R 손실 < 미션 +3-4VP, 미션R에 burst). R5까지·연방개선 업글은 예외
        // (findUpgradeActions의 fed-what-if 큰 가점 후보를 죽이지 않게 TS타깃만 필터).
        if (getPlayerFlag(playerId, 'missionBankTS', true)) {
            const r = game.roundNumber ?? 1;
            const cur = game.roundScoringTiles?.[r - 1]?.triggerType;
            const next = game.roundScoringTiles?.[r]?.triggerType;
            if (r <= 5 && next === 'build_trading_station' && cur !== 'build_trading_station') {
                upgradeActions = upgradeActions.filter(u => !(u.type === 'upgrade_structure' && (u.params as any)?.target === 'trading_station'));
            }
        }
        if (upgradeActions.length > 0) candidates.push(...upgradeActions);

        // 7. 내비게이션 연구 보너스 (QIC 절약)
        const primaryBuild = buildActions.length > 0 ? buildActions[0] : null;
        if (primaryBuild?.type === 'build_mine' && (player.knowledge ?? 0) >= 4) {
            const navId: ResearchTrack = 'navigation';
            const currentNav = player.research[navId] || 0;
            if (currentNav < 5) {
                const needsQIC = this.checkIfActionNeedsQIC(game, playerId, primaryBuild);
                if (needsQIC && this.willNavResearchSaveQIC(game, playerId, primaryBuild)) {
                    candidates.push(this.advanceResearchAction(playerId, player, navId));
                }
            }
        }

        // 8. 특수 액션 (기술 타일, 종족 능력, 보너스 타일) - 최우선 후보로 넣어 MCTS 탐색 강화
        const specialActions = this.findSpecialActions(game, playerId);
        if (specialActions.length > 0) candidates.push(...specialActions);

        // 8-1. 파워/QIC 액션 - MCTS가 충분히 탐색하도록 상위 3개 후보
        const powerActions = this.findPowerActions(game, playerId);
        if (powerActions.length > 0) candidates.push(...powerActions);

        // [flag: itarsBurnCandidate] 아이타 번은 토큰이 가이아공간으로 가(소멸X, 다음R 복귀+PI로 기술타일) 사실상 공짜.
        //   휴리스틱으로 "언제 번할지" 하드코딩하는 대신 burn_power를 MCTS 후보로 넣어 탐색이 "번→파워액션" 최적을
        //   알아서 찾게 함(사용자 아이디어: 2/8/0을 2/0/4처럼 돌려봄). 평가기가 아이타 가이아토큰을 가치화해야 번이 손해로 안 보임(evaluator 수정 동반).
        //   R6(복귀 없음)·bowl2<2(번 불가)면 제외. 아이타 한정(일반 종족은 번=토큰 영구소멸이라 후보로 안 넣음).
        if (getPlayerFlag(playerId, 'itarsBurnCandidate', true) && player.faction === 'itars'
            && (game.roundNumber ?? 1) < 6 && (player.power2 ?? 0) >= 2) {
            candidates.push({ type: 'burn_power', params: {} });
        }

        // [flag: taklonsBrainBurn] 타클론 브레인스톤이 bowl2에 있으면 놀리지 말고 bowl3로 올려 활용(파워액션/1O·3C 변환).
        //   타클론 번(브레인 in 2): 일반토큰 1개 소모 + 브레인→bowl3. 평가기가 이미 브레인 bowl3(2.5)>bowl2(1.2)로 봐서
        //   후보만 열면 MCTS가 옮김(아이타 번과 같은 템플릿). 브레인 in 2 + bowl2 일반토큰 ≥1(번 성립) 조건.
        // [철회 2026-07-14] taklonsBrainHuman 비커플링 번은 taklonsBrainCombo(번+사용 커플링, 사람게임 한정)로 대체.
        if (getPlayerFlag(playerId, 'taklonsBrainBurn', false) && player.faction === 'taklons'
            && player.brainStoneBowl === 2 && (player.power2 ?? 0) >= 1) {
            candidates.push({ type: 'burn_power', params: { moveBrainToBowl3: true } });
        }


        // 8-1b. [flag: bescodsLateSpecial] 매안 트랙업을 botHandler 자동 선사용 대신 MCTS 후보로 —
        // 인에이블러(레벨 보너스 자원·사거리→이번 라운드 연구소/Nav2 등 콤보)면 MCTS가 일찍 잡고, 아니면
        // 자연히 뒤로 밀림(사용자 교정 2026-07-06: 무조건 첫턴도, 무조건 패스직전도 아닌 '판단'이 맞음).
        // botHandler의 패스 인터셉트가 유실 방지 안전망.
        if (player.faction === 'bescods' && getPlayerFlag(playerId, 'bescodsLateSpecial', true)
            && !game.hasDoneMainAction
            && !player.usedSpecialActions?.includes('bescods-advance-lowest')) {
            candidates.push({ type: 'bescods_advance_lowest', params: {} });
        }

        // 8-1c. [flag: ambasSwap] Ambas 시그니처(PI↔광산 위치교체, 메인·1회용). 봇엔 이 능력을 여는 코드가 전무 →
        //   사람 2.12/게임 vs 봇 0(자기 종족 시그니처 미사용). 강제/점수넛지(positional=실패패턴) 대신 각 광산과의 swap을
        //   MCTS 후보로 열어 평가기가 개선되는 위치일 때만 고르게 함(itarsBurn/advTile 패턴). PI 보유 + 미사용일 때만.
        if (player.faction === 'ambas' && getPlayerFlag(playerId, 'ambasSwap', false)
            && !game.hasDoneMainAction
            && !player.usedSpecialActions?.includes('ambas-swap-pi-mine')
            && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) {
            for (const t of game.map) {
                if (t.ownerId === playerId && (t.structure === 'mine' || t.structure === 'lost_planet_mine')) {
                    candidates.push({ type: 'ambas_swap_pi_mine', params: { mineTileId: t.id } });
                }
            }
        }

        // 8-2. 우주선 입장 (Lost Fleet Ship)
        const shipEntries = this.findSpaceshipEntryActions(game, playerId);
        if (shipEntries.length > 0) candidates.push(...shipEntries); // 우주선 탑승을 적극 고려

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
                let shouldAdd = true;

                // 테라포밍/사거리 증가 액션의 경우, 이 액션을 썼을 때 유효한 대상이 있는지 검증합니다.
                if (bonusTileObj.specialAction === 'terraform_step') {
                    // +1 스텝을 얻었을 때 지을 수 있는 후보가 있는지 가상으로 확인 (현재 보너스가 없다면)
                    const oldSteps = player.pendingTerraformSteps || 0;
                    player.pendingTerraformSteps = oldSteps + 1;
                    const possibleBuildActions = this.findBuildActionsWithPendingSteps(game, playerId);
                    const bestPendingBuild = possibleBuildActions.length > 0 ? (possibleBuildActions as any[]).reduce((best, current) => (current.score > best.score ? current : best), possibleBuildActions[0]) : null;
                    player.pendingTerraformSteps = oldSteps;
                    if (!bestPendingBuild) {
                        shouldAdd = false;
                    } else {
                        const targetTile = game.map.find(t => t.id === bestPendingBuild.params?.tileId);
                        if (targetTile && getTerraformStepsForFaction(game, player.faction!, targetTile.type!) === 0) {
                            shouldAdd = false;
                        }
                    }
                } else if (bonusTileObj.specialAction === 'range_3' && !player.rangeBonusActive) {
                    // +3 사거리는 '그 사거리가 있어야 닿는' 대상(광산/가이아포머/우주선입장)이 있을 때만 후보로.
                    // 기존엔 '빌드가 하나라도 가능하면' 켰는데, 가까운 빌드/업그레이드까지 통과시켜 보너스를 낭비했다(사용자 관찰).
                    // 글린+2나 트왈라잇 임시 부스터가 이미 켜져 있으면 중첩하지 않음(각각 별개 액션).
                    if (player.gleensNavBonusActive || player.tempRangeBonus) shouldAdd = false;
                    else if (!this.rangeBoosterUnlocksTarget(game, playerId, 'rangeBonusActive')) shouldAdd = false;
                }

                if (shouldAdd) {
                    candidates.push({ type: 'use_bonus_action', params: { actionId: bonusTileObj.specialAction } });
                }
            }
        }

        // 8-5. 필수 자원 변환 (메인 액션 전 보조 액션으로 추가)
        const conversions = this.findEssentialConversions(game, playerId);
        if (conversions.length > 0) candidates.push(...conversions);

        // 9. 일반 연구 (최우선 순위 부여)
        // [flag: missionBankResearch] 미션 뱅킹(같은게임 대조: 사람 트리거 11.5 vs 봇 4.6, research 갭 1.75 최대 —
        // 사람은 연구미션 라운드에 2-3회 burst = 지식을 미리 모음. 봇은 4K 되는 즉시 소비해 burst 불가).
        // 다음 라운드가 research_track 미션이고 이번은 아니면 연구를 미뤄 지식 축적(다음 라운드에 +미션VP로 회수).
        // 예외: L4(고급타일/L5 레이스 타이밍) 트랙 있으면 안 미룸, 지식 12+면 이미 충분해 미룰 필요 없음(그냥 진행), R5까지만.
        let bankResearch = false;
        if (getPlayerFlag(playerId, 'missionBankResearch', true) && (player.knowledge ?? 0) >= 4) {
            const r = game.roundNumber ?? 1;
            const cur = game.roundScoringTiles?.[r - 1]?.triggerType;
            const next = game.roundScoringTiles?.[r]?.triggerType;
            const hasL4 = (['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'] as ResearchTrack[])
                .some(t => (player.research[t] ?? 0) === 4);
            bankResearch = r <= 5 && next === 'research_track' && cur !== 'research_track'
                && (player.knowledge ?? 0) < 12 && !hasL4;
        }
        const addResearchCandidates = () => {
            const tracks = this.pickResearchTracks(game, player, playerId);
            // [flag: gaiaResearchUseGate] 사용자 관찰(2026-07-11): R1 가이아 L1 올리고 포머 방치 후 패스 — 배치
            // 요구파워(L1-2=6)와 사거리 내 트랜스딤을 아무도 체크 안 해 연구 4K가 증발. L0→L1은 '포머를 실제로
            // 쓸 수 있는' 상황에서만 후보로(그 외엔 나중에 조건 갖추면 자연히 후보 복귀).
            const gaiaGate = getPlayerFlag(playerId, 'gaiaResearchUseGate', true)
                && !this.gaiaResearchUsable(game, playerId);
            // [flag: lateLowStepGate] 사용자 관찰(2026-07-15, 재보고): "R3-4에 경제 한칸 올리고 더는 안 올림" —
            // 실측: 고립 경제1칸(1회·최종≤2) 봇 33% vs 사람 3%(사람은 0 아니면 L4-5 쌍봉), 전원 4K 유료·R5-6 집중.
            // 경제/과학 L≤1→≤2는 수입 전용인데 남은 징수 0-2회면 4K 대비 순손실 + 종료보너스(L3+) 미달 그루터기.
            // researchFinishL3(점수 nudge, 무시당함·기각)와 달리 유료 후보 생성에서 하드 제외(가이아게이트 동형).
            // 미션 예외 없음(사용자 2026-07-15): 연구미션 +2VP는 트랙 불문 — 더 나은 트랙을 올려도 받으므로
            // 저가치 스텝의 정당화가 못 됨.
            // [v2] R4+ 일괄 차단은 120판 VP −1.59(승률 51.8%, 40판 −1.80과 방향 일관) — R4는 징수 2회 남아
            // 수입가치 실재 추정 → R5+(징수 0-1회, 근사 순수 소각 셀)로 축소.
            const lowStepGate = (track: ResearchTrack): boolean => {
                if (!getPlayerFlag(playerId, 'lateLowStepGate', false)) return false;
                if (track !== 'economy' && track !== 'science') return false;
                if ((game.roundNumber ?? 1) < 5) return false;
                return (player.research[track] ?? 0) + 1 <= 2;
            };
            for (const track of tracks) {
                if (gaiaGate && track === 'gaiaProject' && (player.research.gaiaProject ?? 0) === 0) continue;
                if (lowStepGate(track)) continue;
                candidates.push(this.advanceResearchAction(playerId, player, track));
            }
            // [flag: allTracksResearch] per-candidate 데이터(18게임): 사람 연구수의 81%(52/64)가 지식 충분한데
            // 봇 후보에 없었음 = top-3 슬라이스가 4-6순위 트랙을 MCTS에서 숨김(하드필터의 후보생성 갭).
            // 나머지 자격 트랙(L<5, L4→5는 green 필요)도 후보로 — 랭킹은 MCTS가 평가로 함.
            if (getPlayerFlag(playerId, 'allTracksResearch', true)) {
                const ALL: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
                for (const track of ALL) {
                    if (tracks.includes(track)) continue;
                    const lvl = player.research[track] ?? 0;
                    if (lvl >= 5) continue;
                    if (lvl === 4 && !getFederationEntries(player).some(f => f.isGreen)) continue;
                    // L5 선점 체크 — pickResearchTracks와 동일 룰(서버 1210행 정합, 유령 후보 방지)
                    if (lvl === 4 && isTrackLevel5Taken(game, track, playerId)) continue;
                    if (player.faction === 'bal_tak' && track === 'navigation'
                        && !game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) continue;
                    if (gaiaGate && track === 'gaiaProject' && lvl === 0) continue; // [flag: gaiaResearchUseGate]
                    if (lowStepGate(track)) continue; // [flag: lateLowStepGate] 동일 게이트(이 경로도 유료 후보)
                    // [flag: lateResearchMerit] 이 경로는 점수를 안 봐서 R6 저메리트 상승이 그대로 후보화 — 동일 게이트
                    if (getPlayerFlag(playerId, 'lateResearchMerit', false)
                        && this.calculateResearchScore(game, player, playerId, track) <= -500) continue;
                    candidates.push(this.advanceResearchAction(playerId, player, track));
                }
            }
        };
        if ((player.knowledge ?? 0) >= 4 && !bankResearch) addResearchCandidates();
        // [유령라운드 수정 2026-07-13] 뱅킹이 후보를 0으로 만들면 = 이 턴이 아니라 라운드 통째 패스(다른 액션이
        // 전무한 상태) → 템포 1라운드 손실이 미션 +2~4VP를 초과. 실측(w7gmzwnz geodens): R5 O4C11K7로 즉시패스
        // → R6에도 버스트 실패 → fed0 30점. 뱅킹은 '다른 할 일이 있을 때'만 유효 — 후보 0이면 해제.
        if (candidates.length === 0 && bankResearch && (player.knowledge ?? 0) >= 4) {
            if (!game.simulation) log(`Bot ${player.name} missionBankResearch 해제 — 뱅킹 시 후보 0(라운드 통째 패스 방지)`, 'game', game.id);
            addResearchCandidates();
        }

        if (!game.simulation) {
            log(`Bot ${player.name} found ${candidates.length} non-pass candidates in Round ${game.roundNumber}`, 'game', game.id);
        }

        // 10. 패스 (지식이 충분하여 연구를 더 할 수 있다면 패스를 억제하여 무조건 지식을 소모하게 강제)
        if (!player.hasPassed) {
            // [사용자 피드백] 가이아포머나 소행성 우주선 액션 등 매우 좋은 액션이 후보에 있다면, MCTS가 엉뚱하게 패스하는 것을 원천 차단
            const mustDoActions = candidates.filter(c =>
                (c.type === 'place_gaiaformer') ||
                (c.type === 'place_ivits_space_station') ||
                (c.type === 'use_ship_action' && c.params?.actionIndex === 3 && game.map.find(t => t.id === c.params?.shipTileId)?.type === 'ship_eclipse') ||
                (c.type === 'use_ship_action' && c.params?.actionIndex === 1 && game.map.find(t => t.id === c.params?.shipTileId)?.type === 'ship_rebellion') ||
                (c.type === 'use_bonus_action' && c.params?.actionId === 'range_3')
            );

            // [추가] "1빌딩 후 패스" 회귀 방지 — 다음 조건들이 만족되면 패스를 차단
            const ore = player.ore ?? 0;
            const credits = player.credits ?? 0;

            // (a) 할인 업그레이드(인접 플레이어 보너스)가 가능하면 패스 차단 — 자원 효율 최상
            const hasDiscountedUpgrade = this.findDiscountedUpgradeAction(game, playerId) !== null;

            // (b) 연방을 한 개 더 구성할 수 있고 라운드 ≥3이면 패스 차단 (점수원)
            const fedCandidatesNow = candidates.filter(c => c.type === 'form_federation');
            const canFormFedNow = fedCandidatesNow.length > 0 && (game.roundNumber ?? 1) >= 3;

            // (c) 광산/TS 건설이 가능하고 자원이 충분하면 패스 차단 — 엔진 빌딩 중간에 멈추지 말 것
            //     특히 R1~3 초반엔 자원 수급 인프라가 우선이라 자원 남기고 패스하는 행동을 막음
            const hasCheapBuildOrUpgrade =
                ((game.roundNumber ?? 1) <= 3) &&
                (
                    candidates.some(c => c.type === 'build_mine') && ore >= 1 && credits >= 2
                    || candidates.some(c => c.type === 'upgrade_structure') && credits >= 3
                );

            // (d) "메인 액션을 한 번도 안 했는데 패스"는 라운드 ≤4까진 차단 (자원/턴 낭비)
            //     단 자원이 정말 바닥(ore<1 && credits<3 && knowledge<1)이면 허용
            const noMainActionYet = !game.hasDoneMainAction;
            const trulyStarved = ore < 1 && credits < 3 && (player.knowledge ?? 0) < 1 && (player.qic ?? 0) < 1;
            const passTooEarly = noMainActionYet && (game.roundNumber ?? 1) <= 4 && !trulyStarved;

            // [flag: r6SpendDown] R6 소비 강제 — 데이터: 사람 R6 ~25액션(+42VP) vs 봇 ~8액션, 봇은 R6시작 광석 10.7을
            // 쥐고도 잔여 10+ 남기고 패스(승자-패자 대조: 승자 잔여 10.5 vs 패자 12.8 = 소비가 이김).
            // R6에 VP성 액션(빌드/업글/연구/기술액션/우주선액션)이 후보에 있으면 패스를 후보에서 제외 — MCTS가 그중 최선을 고름.
            const r6Spend = getPlayerFlag(playerId, 'r6SpendDown', false) && (game.roundNumber ?? 1) >= 6
                && candidates.some(c => c.type === 'build_mine' || c.type === 'upgrade_structure'
                    || c.type === 'advance_research' || c.type === 'use_tech_action' || c.type === 'use_ship_action');

            if ((player.knowledge ?? 0) >= 4) {
                // 지식이 남았으면 패스하지 않도록 후보에 넣지 않음. (연구를 강제)
            } else if (mustDoActions.length > 0) {
                // 필수 액션(가이아포머/소행성 우주선/사거리 보너스)이 가능하면 패스 차단
            } else if (hasDiscountedUpgrade) {
                // 할인 업그레이드는 자원 효율이 최상이므로 항상 우선
            } else if (canFormFedNow) {
                // 라운드 3+ 에서 연방 구성 가능하면 패스보다 연방 우선
            } else if (hasCheapBuildOrUpgrade) {
                // 초반 자원 수급 인프라(광산/TS)는 패스보다 우선
            } else if (passTooEarly) {
                // 자원 남았는데 메인 액션 안 하고 패스하는 행동은 R1~4까지 차단
            } else if (r6Spend) {
                // R6: VP성 액션이 남아있는 한 패스 금지(소비 강제) — 실패 시 botHandler의 pass 폴백이 안전망
            } else {
                const bestBonus = this.findBonusTileAction(game, playerId);
                const bonusTileId = bestBonus?.params?.bonusTileId;
                candidates.push({ type: 'pass_round', params: { bonusTileId } });

                // 다음 라운드 파워 수입이 그릇1 토큰 부족으로 샐 것으로 예상되면,
                // 패스 직전에 1O→1토큰 프리액션을 1~2회 미리 수행하는 후보도 추가.
                // (연방용 토큰 확보 + 파워 수입 누수 방지)
                const { powerIncome, tokenIncome } = this.calculateExpectedPowerIncome(game, playerId);
                // [버그수정] 충전 흡수용량 = 2×(그릇1+토큰수입) + 그릇2. (그릇1 토큰은 1→2→3로 2충전, 그릇2는 1충전 흡수.)
                // 기존엔 (powerIncome - 그릇1)로 계산해 그릇1을 1배만 치고 그릇2를 무시 → 흡수할 토큰이 충분한데도
                // 낭비로 오판하여 귀한 광석을 토큰으로 불필요하게 태웠음(사용자 관찰). 556행 cleanup의 올바른 시뮬레이션과 일치시킴.
                const absorbCapacity = 2 * ((player.power1 ?? 0) + tokenIncome) + (player.power2 ?? 0);
                const expectedWaste = Math.max(0, powerIncome - absorbCapacity);
                const oreNow = player.ore ?? 0;
                // 1광석→1토큰 = 흡수용량 +2 → 진짜 낭비분의 절반만(ceil) 변환. 광석은 최소 1개 남김(빌드 자원 보호).
                const k = Math.max(0, Math.min(2, Math.ceil(expectedWaste / 2), Math.max(0, oreNow - 1)));
                if (k > 0) {
                    const preActions = Array.from({ length: k }, () => ({ type: 'convert_resource' as const, params: { type: '1ore-to-1token' } }));
                    candidates.push({ type: 'pass_round', params: { bonusTileId }, preActions });
                }
            }

            // 패스 후보가 차단되어 후보가 0개가 되는 사고를 막기 위한 안전망:
            // 차단됐는데 다른 후보가 하나도 없으면 패스를 다시 추가 (게임 진행 보장)
            if (candidates.length === 0) {
                const bestBonus = this.findBonusTileAction(game, playerId);
                const bonusTileId = bestBonus?.params?.bonusTileId;
                candidates.push({ type: 'pass_round', params: { bonusTileId } });
            }
        }

        // 사거리 부스터(트왈라잇 +3 / 보너스 +3 / 글린 +2)가 활성이면, 그 사거리를 쓰는 배치 액션만 허용한다(서버 룰과 동일).
        // 봇은 execute*를 직접 호출해 소켓의 hasActiveRangeBonus 가드를 우회하므로, 후보 단계에서 제한 → 부스터 켜고
        // 업그레이드/연구/파워액션 등 엉뚱한 짓 + 1K 낭비 금지(사용자 관찰). 사거리 액션이 없으면(낭비 상황) 폴백 유지.
        let candidatePool = candidates;
        if (player.tempRangeBonus || player.rangeBonusActive || player.gleensNavBonusActive) {
            const RANGE_USING = new Set(['build_mine', 'place_gaiaformer', 'enter_spaceship', 'place_ivits_space_station', 'place_lost_planet']);
            let rangeOnly = candidates.filter(c => RANGE_USING.has(c.type));
            // [flag: rangeBonusFarOnly] 사용자 처방(2026-07-14): "3거리 쓰고 바로 옆 1nav에 건설" — 부스터 활성 중
            // 부스터 없이도 닿는 타깃에 지으면 서버가 보너스를 무조건 소모(executeBuildMine 6145-6147) = 낭비.
            // 부스터가 '실제로 여는' 타깃(부스터 OFF 후보군에 없는 것)만 남긴다. 전부 근거리뿐이면(먼 타깃 소멸 등)
            // 기존 폴백 유지 — 턴이 막히는 일은 없음. rangeBoosterUnlocksTarget(활성화 게이트)의 사용 단계 미러.
            // [v2 2026-07-20] 기존 판정(부스트 ON/OFF 후보목록 집합 차이)은 후보가 상위 5개 슬라이스라
            // 부스트로 점수가 변하면 '기본 사거리로 닿는 근거리'도 차집합에 들어와 오판(사용자 재현: 트와일라잇
            // 1K 누르고 Nav2로 닿는 2거리 행성에 건설 = 1K 소각). 실제 거리 기반으로 교체 — 내 앵커(건물·기생·
            // 정거장)에서 최단거리가 '부스트 제외 기본 사거리'를 초과하는 타깃만 부스트 사용처로 인정.
            if (getPlayerFlag(playerId, 'rangeBonusFarOnly', true) && rangeOnly.length > 0) {
                const baseNoBoost = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
                const anchors = game.map.filter(t =>
                    (t.ownerId === playerId && t.structure) || t.parasiticMine?.ownerId === playerId
                    || (t.spaceStation as any)?.ownerId === playerId);
                const needsBoost = (targetTileId: string | undefined): boolean => {
                    if (!targetTileId || anchors.length === 0) return true; // 판정 불가 시 보수적 유지
                    const t = game.map.find(m => m.id === targetTileId);
                    if (!t) return true;
                    return Math.min(...anchors.map(a => getDistance(a, t))) > baseNoBoost;
                };
                const far = rangeOnly.filter(c => {
                    const p = (c as any).params || {};
                    if (c.type === 'enter_spaceship') return needsBoost(p.shipTileId ?? p.tileId);
                    if (c.type === 'build_mine' || c.type === 'place_gaiaformer') return needsBoost(p.tileId);
                    return true; // lost planet/ivits 정거장은 보수적으로 유지
                });
                if (far.length > 0) rangeOnly = far;
            }
            if (rangeOnly.length > 0) candidatePool = rangeOnly;
            else {
                // [진단 RANGE-WASTE] 사거리 부스터가 활성인데 쓸 사거리 액션이 0개 = 보너스 낭비 확정 순간.
                // 게이트(rangeBoosterUnlocksTarget)는 "쓸 수 있다"고 켰는데 막상 후보엔 없는 모순을 현장 포착.
                try {
                    const counts = candidates.reduce((m, c) => { m[c.type] = (m[c.type] || 0) + 1; return m; }, {} as Record<string, number>);
                    const entry = {
                        player: player.name,
                        round: (game as any).roundNumber,
                        active: { range: !!player.rangeBonusActive, gleens: !!player.gleensNavBonusActive, temp: !!player.tempRangeBonus },
                        baseRange: getRange(player.research.navigation || 0) + (player.navigationBonus || 0),
                        ore: player.ore, credits: player.credits, qic: player.qic, gaiaformers: player.gaiaformers,
                        findBuild: this.findBuildActions(game, playerId).length,
                        findBuildPending: this.findBuildActionsWithPendingSteps(game, playerId).length,
                        findShipEntry: this.findSpaceshipEntryActions(game, playerId).length,
                        unlocks: {
                            range: this.rangeBoosterUnlocksTarget(game, playerId, 'rangeBonusActive'),
                            gleens: this.rangeBoosterUnlocksTarget(game, playerId, 'gleensNavBonusActive'),
                            temp: this.rangeBoosterUnlocksTarget(game, playerId, 'tempRangeBonus'),
                        },
                        candidates: counts,
                    };
                    // 게임 객체에 저장 → get_game 덤프/종료 자동저장 JSON 어디에든 포함 (콘솔 안 봐도 됨)
                    (game as any).diagRangeWaste = (game as any).diagRangeWaste || [];
                    (game as any).diagRangeWaste.push(entry);
                    log(`[RANGE-WASTE] ${JSON.stringify(entry)}`, 'game', game.id);
                } catch (e) { log(`[RANGE-WASTE] diag error: ${e}`, 'game', game.id); }
            }
        }

        // 중복 제거 (예: 동일한 타일에 대한 건설 명령이 두 번 들어간 경우)
        const uniqueCandidates: BotAction[] = [];
        const seen = new Set<string>();
        for (const c of candidatePool) {
            const key = JSON.stringify(c);
            if (!seen.has(key)) {
                seen.add(key);
                uniqueCandidates.push(c);
            }
        }

        // [flag: fedLastCall] 사용자 정책(2026-07-20): "연방은 다른 액션들을 하다가 — 3P 토큰 파워액션, 랩 건설,
        // 가이아 L2 통과 +3토큰, AI 트랙 QIC 등이 토큰을 공짜로 만들어줌 — 더 할 게 없어지는 '마지막 기회'에 형성.
        // 단 연방이 고급타일을 여는 경우(초록 0 + 좋은 adv 자격)는 앞당겨 보상 자원도 먼저 받기."
        // 연방은 미뤄도 소멸하지 않고 위성 비용은 내려가기만 함 → 생산 액션이 남아 있으면 연방 후보를 이번 턴
        // 보류, 대안이 소진되면(패스/변환/턴종료만 남음) 자동 복귀. fedR6ConvCap(광석 강제변환 캡)의 상류 해법.
        // [v3] R5+ 한정: v2 계측 — R6 연방 0.40(챔피언 0.30) + 액션 +0.87로 후반 메커니즘은 완성됐으나,
        // R1-5 중반 연방까지 미뤄져 총 연방 −0.17(중반 연방 보상의 복리 가치 손실). 사용자 사례도 후반(R6 광석
        // 소각·막판 타이밍) — 중반 연방은 기존대로 즉시, 미루기는 R5+만.
        if (getPlayerFlag(playerId, 'fedLastCall', true)
            && (game.roundNumber ?? 1) >= 5
            && uniqueCandidates.some(c => c.type === 'form_federation')) {
            const productive = uniqueCandidates.some(c =>
                c.type !== 'form_federation' && c.type !== 'pass_round'
                && c.type !== 'convert_resource' && c.type !== 'end_turn');
            const advUrgent = countGreenFederations(player) === 0
                && this.bestClaimableAdvScore(game, playerId) >= 60;
            if (productive && !advUrgent) {
                // [v2] 번(burn) 가드: 40판 계측 — 미루기로 R6 액션 +0.64/석 성공했지만 R6 연방 0.38→0.26 증발.
                // 원인 = 미루는 동안 번 낀 콤보가 토큰을 태워 보류 중인 연방의 위성 지불력이 잠식(사용자 예시 A 재발).
                // 보류 연방의 최소 위성 수요 밑으로 토큰을 태우는 후보는 함께 제외 — 그런 후보뿐이면 지금이 마지막 기회.
                const fedNeed = Math.min(...uniqueCandidates
                    .filter(c => c.type === 'form_federation')
                    .map(c => ((c.params as any)?.spentTokens ?? 99) as number));
                const brainTok = (player.faction === 'taklons' && player.brainStoneBowl != null && !player.brainStoneInGaia) ? 1 : 0;
                const totalTok = (player.power1 ?? 0) + (player.power2 ?? 0) + (player.power3 ?? 0) + brainTok;
                const deferred = uniqueCandidates.filter(c => {
                    if (c.type === 'form_federation') return false;
                    const burns = (c.preActions ?? []).filter(p => p.type === 'burn_power').length;
                    return burns === 0 || totalTok - burns >= fedNeed;
                });
                if (deferred.some(c => c.type !== 'pass_round' && c.type !== 'convert_resource' && c.type !== 'end_turn')) {
                    uniqueCandidates.length = 0;
                    uniqueCandidates.push(...deferred);
                }
                // 번 없는 생산 후보가 없으면 보류 해제(연방 후보 유지) = 마지막 기회 감지
            }
        }

        // [flag: lantidsParasiteWindow] 사용자 지시(2026-07-15): 기생의 발판/가교 가치를 근사 점수로 넣지 말고
        // 롤아웃이 직접 판정하게 하라. MCTS는 상위 TOP_N(8)만 롤아웃하므로 기생 후보가 9위 밖이면 체인 탐색
        // 기회가 0 — 최고 기생 후보 1개를 창 안(4번째)으로 이동(점수 인플레 없음, 판정은 롤아웃+평가기 몫).
        if (player.faction === 'lantids' && getPlayerFlag(playerId, 'lantidsParasiteWindow', true)) {
            const isParasite = (c: BotAction) => {
                if (c.type !== 'build_mine') return false;
                const t = game.map.find(m => m.id === (c.params as any)?.tileId);
                return !!(t && t.ownerId && t.ownerId !== playerId && t.structure);
            };
            const pIdx = uniqueCandidates.findIndex(isParasite);
            if (pIdx >= 8) {
                const [pCand] = uniqueCandidates.splice(pIdx, 1);
                uniqueCandidates.splice(Math.min(4, uniqueCandidates.length), 0, pCand);
            }
        }

        // [flag: candReorder] 우주선/인공물/고급기술 후보를 앞으로 끌어올려 MCTS 롤아웃(candidates.slice(0,TOP_N))
        // starvation 완화. 고가치 연방(form_federation)은 맨 앞 유지, 나머지는 안정 정렬로 우선순위 버킷만 전진.
        if (getPlayerFlag(playerId, 'candReorder', false)) {
            const PRIORITY = new Set(['select_advanced_tech_tile', 'use_ship_action', 'take_twilight_artifact']);
            const feds = uniqueCandidates.filter(c => c.type === 'form_federation');
            const prio = uniqueCandidates.filter(c => c.type !== 'form_federation' && PRIORITY.has(c.type));
            const rest = uniqueCandidates.filter(c => c.type !== 'form_federation' && !PRIORITY.has(c.type));
            return [...feds, ...prio, ...rest];
        }

        // [flag: deferSafeBuild] 라운드 내 긴급도 순서(사용자 모델 2026-07-06): 뺏길 수 없는 액션(무경쟁 가이아
        // 1QIC 건설)은 공유 자원인 파워액션(상대가 먼저 쓰면 이번 라운드 소멸)보다 뒤로. 점수 너지는 MCTS가 무시
        // (aiTrackQicEngine·tsEarlyHardGate 교훈)하므로 하드 필터로 이번 턴 후보에서 제외 — 무경쟁이라 다음 턴에
        // 그대로 남아 총 액션 집합은 불변(순서만 교정). 가드: ①상대 구조물이 3헥스 내면 경쟁 취급(제외 안 함)
        // ②자원이 넉넉해(가이아 건설 2회분) 뒤로 미뤄도 못 짓게 될 위험이 없을 때만 ③패스 후보가 있는 턴(라운드
        // 꼬리)엔 미루지 않고 다 함.
        if (getPlayerFlag(playerId, 'deferSafeBuild', true)
            && !uniqueCandidates.some(c => c.type === 'pass_round')
            && uniqueCandidates.some(c => c.type === 'use_power_action')
            && (player.qic ?? 0) >= 2 && (player.ore ?? 0) >= 2 && (player.credits ?? 0) >= 5) {
            const isSafeGaiaBuild = (c: BotAction): boolean => {
                if (c.type !== 'build_mine') return false;
                const tile = game.map.find(t => t.id === (c.params as any)?.tileId);
                if (!tile || tile.type !== 'gaia') return false;
                // 3헥스 내 상대 구조물 = 경쟁 가능성 → 긴급 취급(미루지 않음)
                return !game.map.some(t => t.ownerId && t.ownerId !== playerId && t.structure
                    && t.structure !== 'ship' && getDistance(tile, t) <= 3);
            };
            const filtered = uniqueCandidates.filter(c => !isSafeGaiaBuild(c));
            if (filtered.length < uniqueCandidates.length && filtered.some(c => c.type !== 'convert_resource')) {
                return filtered;
            }
        }

        // [flag: policyPrior] 알파고식: 사람 모방 학습 정책망(policyNet.json, imitation +10.1%p)으로
        // 후보를 '사람이 그 상태에서 할 법한 행동타입' 확률 순으로 안정정렬 → MCTS 롤아웃(top-N 평가)을
        // 사람 수 쪽으로 좁힘. mcts.ts(사용자 영역) 미수정. 동률은 원래 우선순위 유지(stable).
        if (getPlayerFlag(playerId, 'policyPrior', false)) {
            const probs = this.policyProbs(game, playerId);
            if (probs) {
                const vals = Object.values(probs).slice().sort((a, b) => a - b);
                const med = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
                const scored = uniqueCandidates.map((c, i) => {
                    const lab = this.actionLabel(c);
                    return { c, pr: (lab && probs[lab] != null) ? probs[lab] : med, i };
                });
                scored.sort((a, b) => (b.pr - a.pr) || (a.i - b.i));
                return scored.map(s => s.c);
            }
        }

        return uniqueCandidates;
    }

    /** [정책망/PUCT] 후보 액션들에 대해 정책망 prior(확률)를 계산, 후보 집합 위에서 정규화(합≈1)해 Map 반환.
     *  mcts.ts가 root 자식들의 PUCT prior로 사용. 매핑 없는 액션은 작은 기본값. policyProbs 실패시 빈 Map. */
    static policyPriorMap(game: ServerGameState, playerId: string, actions: BotAction[]): Map<BotAction, number> {
        const m = new Map<BotAction, number>();
        const probs = this.policyProbs(game, playerId);
        if (!probs || !actions.length) return m;
        const raw = actions.map(a => {
            const lab = this.actionLabel(a);
            return (lab && probs[lab] != null) ? probs[lab] : 0.04; // 미매핑은 작은 prior
        });
        const sum = raw.reduce((x, y) => x + y, 0) || 1;
        actions.forEach((a, i) => m.set(a, raw[i] / sum));
        return m;
    }

    /** [정책망] BotAction → 학습 라벨(행동타입). 매핑 없으면 null(중립 prior). */
    private static actionLabel(a: BotAction): string | null {
        switch (a.type) {
            case 'build_mine': return 'Built Mine';
            case 'advance_research': {
                const tr = (a.params as any)?.trackId;
                return tr ? ('R:' + tr) : 'Advanced Research';
            }
            case 'upgrade_structure': {
                const t = (a.params as any)?.target;
                if (t === 'trading_station') return 'Upgraded to Trading Station';
                if (t === 'research_lab') return 'Upgraded to Research Lab';
                if (t === 'academy') return 'Academy';
                return null;
            }
            case 'form_federation': return 'Federation';
            case 'select_advanced_tech_tile': case 'select_tech_tile':
            case 'cover_advanced_tech_tile': case 'advance_tech': return 'Gained Tech Tile';
            case 'enter_spaceship': return 'Entered Ship';
            case 'use_power_action': {
                const id = (a.params as any)?.actionId || '';
                if (/ore/.test(id)) return 'Pw:ore';
                if (/credit/.test(id)) return 'Pw:credits';
                if (/knowledge/.test(id)) return 'Pw:knowledge';
                if (/token/.test(id)) return 'Pw:tokens';
                if (/step/.test(id)) return 'Pw:tf';
                return 'Pw:other'; // qic-action-* 등
            }
            case 'use_ship_action': case 'use_tech_action': return 'Used Tech Action';
            case 'place_gaiaformer': return 'Placed Gaiaformer';
            default: return null;
        }
    }

    /** [정책망] 현재 상태에서 학습된 정책망(softmax)으로 행동타입 확률분포 계산. 피처는 trainPolicyNet.mjs와 일치. */
    private static policyProbs(game: ServerGameState, playerId: string): Record<string, number> | null {
        const net = loadPolicyNet();
        if (!net) return null;
        const p = game.players[playerId];
        if (!p) return null;
        const res: any = p.research || {};
        const owned = game.map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship');
        const mines = owned.filter(t => t.structure === 'mine' || t.structure === 'lost_planet_mine').length;
        const planets = owned.filter(t => !POLICY_NONPLANET.has(t.type || ''));
        const types = new Set(planets.map(t => t.type)).size;
        const sectors = new Set(owned.map(t => t.sector)).size;
        const ships = game.map.filter(t => POLICY_SHIP.has(t.type || ''));
        const protos = game.map.filter(t => t.type === 'proto' || t.type === 'asteroid');
        const nShip = (ships.length && owned.length) ? Math.min(...ships.map(s => Math.min(...owned.map(m => getDistance(m, s))))) : 9;
        const nProto = (protos.length && owned.length) ? Math.min(...protos.map(s => Math.min(...owned.map(m => getDistance(m, s))))) : 9;
        const HEXN = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
        const set = new Set(owned.map(t => t.q + ',' + t.r));
        let adj = 0;
        for (const m of owned) for (const [dq, dr] of HEXN) if (set.has((m.q + dq) + ',' + (m.r + dr))) { adj++; break; }
        const techN = p.techTiles?.length || 0;
        const fedN = (p as any).federations?.length || 0;
        const f = [
            (game.roundNumber || 1) / 6, (p.score || 0) / 100, (p.ore ?? 0) / 15, (p.credits ?? 0) / 20,
            (p.knowledge ?? 0) / 15, (p.qic ?? 0) / 8, ((p.power1 ?? 0) + (p.power2 ?? 0) + (p.power3 ?? 0)) / 12,
            (res.terraforming ?? 0) / 5, (res.navigation ?? 0) / 5, (res.artificialIntelligence ?? 0) / 5,
            (res.gaiaProject ?? 0) / 5, (res.economy ?? 0) / 5, (res.science ?? 0) / 5,
            techN / 8, fedN / 3,
            mines / 12, owned.length / 18, (p.spaceshipsEntered?.length || 0) / 3, fedN / 3, techN / 8,
            owned.length / 12, types / 7, sectors / 8, Math.min(nShip, 9) / 9, Math.min(nProto, 9) / 9,
            owned.length ? adj / owned.length : 0,
            1, // bias
        ];
        let logit: number[];
        if (net.arch === 'mlp' && net.W1 && net.b1 && net.W2 && net.b2) {
            // MLP forward: f26(bias 제외) → ReLU(W1·f26+b1) → W2·h+b2. 피처는 trainPolicyNetMLP.mjs와 동일(26-dim).
            const f26 = f.slice(0, 26);
            const b1 = net.b1, W1 = net.W1, b2 = net.b2, W2 = net.W2;
            const h = W1.map((w, j) => { let s = b1[j]; for (let d = 0; d < 26; d++) s += w[d] * f26[d]; return s > 0 ? s : 0; }); // ReLU
            logit = W2.map((w, k) => { let s = b2[k]; for (let j = 0; j < h.length; j++) s += w[j] * h[j]; return s; });
        } else {
            const W = net.W!;
            logit = W.map(w => { let s = 0; for (let d = 0; d < f.length; d++) s += w[d] * f[d]; return s; });
        }
        const mx = Math.max(...logit);
        const ex = logit.map(v => Math.exp(v - mx));
        const Z = ex.reduce((a, b) => a + b, 0) || 1;
        const probs: Record<string, number> = {};
        net.labels.forEach((lab: string, i: number) => { probs[lab] = ex[i] / Z; });
        return probs;
    }


    private static findUpgradeActions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const ore = player.ore ?? 0;
        const credits = player.credits ?? 0;
        const round = game.roundNumber;
        const fedHexes: string[] = (game as any).playerFederationHexes?.[playerId] || [];

        // [사용자 규칙 2026-06-18] 다음 라운드 오레:크레딧 수입이 1:3.5보다 벗어나면(크레딧 과잉/오레 기아) 나쁜 케이스.
        // 교역소 죽음의 나선: 2오레 모이면 mine→TS 업글 → 크레딧수입↑·오레수입 그대로 → 또 반복 → 돈만 30 쌓이고
        // 오레 없어 패스. TS는 오레를 먹고 크레딧수입을 더 올려 비율을 *악화*시키므로, 이 상태에선 mine→TS를 강하게
        // 억제해 광산건설·오레 파워액션이 선택되게 한다(엔진의 오레 다리를 키움).
        let oreStarved = false;
        // [flag: creditCapGuard] 크레딧 상한(30) 오버플로우 예약 상태 — 현금+다음R 수입이 상한 근접이면 크레딧 수입원 추가는 낭비 확대
        let creditOverflow = false;
        if (getPlayerFlag(playerId, 'oreCreditBalance', true)) {
            const balExp = this.calculateExpectedRoundIncome(game, playerId);
            const oreInc = Math.max(0.5, balExp.ore ?? 0);
            const creditInc = balExp.credits ?? 0;
            // [재튜닝 2026-06-18] 검증서 트리거가 너무 넓어 정상 TS→연구소 발판까지 막아 점수 -3.5 → 좁힘.
            // "수입 비율 악화" + "현재 크레딧 실제로 쟁여둠(≥12)" 둘 다일 때만 = 진짜 죽음의 나선만 잡음.
            oreStarved = (creditInc / oreInc) > 3.5 && credits >= 12;
            // [flag: creditCapGuard] 사용자 관찰(2026-07-12): 연구소1+TS3인데 TS 증설+7C 액션 → 다다음R 수입 30 초과로 증발.
            // 임계 캘리브레이션(사람 15,250결정): 사람 크레딧 p90=16 p95=19, ≥20C는 4%(비정상 구간) —
            // "현금+다음R 수입 ≥21"(다음 라운드를 사람 p95 초과 상태로 시작 예약)이면 크레딧 수입원 증설은 낭비.
            // 셀프플레이 40판 +6.06(p=0.027)→120판 −1.67 완전회귀(curse 9호) — 봇끼리는 평균 6.9C라 대부분 무발동.
            // 실게임 문제(사용자 관측 30C 증발)는 실재 → 사람 게임 한정 가동(fedSatCapHuman 패턴, 120판이 하한 검증).
            const hasHumanOppCap = (game.botPlayerIds?.length ?? 0) < Object.keys(game.players).length;
            creditOverflow = getPlayerFlag(playerId, 'creditCapGuard', true) && hasHumanOppCap && (credits + creditInc >= 21);
        }

        interface ScoredUpgrade {
            id: string;
            score: number;
            action: BotAction;
            isFederated: boolean;
        }
        const candidates: ScoredUpgrade[] = [];

        const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);
        const mineCount = myStructures.filter(t => t.structure === 'mine' || t.structure === 'lost_planet_mine').length
            + game.map.filter(t => t.parasiticMine?.ownerId === playerId).length
            + (player.virtualMineAsteroid ? 1 : 0)
            + (player.virtualMineProto ? 1 : 0);
        const tsCount = myStructures.filter(t => t.structure === 'trading_station').length;
        const labCountNow = myStructures.filter(t => t.structure === 'research_lab').length;

        /** 연방에 이미 속한 타일 업그레이드는 다음 연방에 불리하므로 감점 */
        // [사용자 피드백] 이미 연방에 속한 건물을 업그레이드하면 이미 형성된 연방의 파워만 7 초과로 낭비되고
        // 다음 연방 구성은 늦어짐. 페널티 70→300→450으로 상향해 연방 외부(새 연방용) 업글/확장을 우선.
        // (비연방 타일 업글은 영향 없음 → 정상 income/연구소 업글은 그대로 유지)
        // [flag: lastRoundFedFree] 사용자 관찰(2026-07-13): R6 종료 시 2O3C+3O5C 있으면 업글 체인으로 7VP 타일
        // (잔여 13유닛=4.3VP 대비 순+3)인데 그냥 패스 — 연방 보존 스택(fedPenalty/noFedTierUp/fedDefer)의 근거
        // '미래 연방 재료 보존'이 R6엔 소멸하는데 페널티만 남아 후보를 죽임. 마지막 라운드는 전부 해제.
        const fedFreeNow = getPlayerFlag(playerId, 'lastRoundFedFree', true) && round >= 6;
        const fedPenalty = (tileId: string) => (fedHexes.includes(tileId) && !fedFreeNow) ? 450 : 0;
        const isFederated = (tileId: string) => fedHexes.includes(tileId);
        // [flag: fedFreshTsFirst] 사용자 관찰(2026-07-13): 8O/10C로 새 할인(2O/3C) TS + 4/6 업글 둘 다 가능한데
        // 연방 내 TS를 4/6으로 먼저 올림 — 연방 내 업글은 미래 연방 파워 0 기여라 '새 연방 재료(할인 TS)'가
        // 이번 턴 우선이어야 함(안쪽 업글은 다음 턴에 해도 동일). 할인 TS가 실제로 가능할 때만 추가 감점.
        const freshTsAvailable = getPlayerFlag(playerId, 'fedFreshTsFirst', true) && !fedFreeNow
            && ore >= 2 && credits >= 3
            && myStructures.some(t => t.structure === 'mine' && !fedHexes.includes(t.id)
                && hasNearbyPlayersForDiscount(game, t, playerId));
        const fedDeferPenalty = (tileId: string) => (freshTsAvailable && fedHexes.includes(tileId)) ? 200 : 0;

        // 1. Mines -> Trading Stations
        if (ore >= 2 && (credits >= 3 || getPlayerFlag(playerId, 'tsConvertCombo', true))) {
            const mines = myStructures.filter(t => t.structure === 'mine');
            for (const mine of mines) {
                const isDiscounted = hasNearbyPlayersForDiscount(game, mine, playerId);
                const cost = isDiscounted ? 3 : 6;
                // [flag: tsConvertCombo] 103게임 TS 갭 원인 1위 '자원 부족(2O3C) 50건/신뢰갭 91건' — 사람은 광석 잉여
                // (1O→1C)·bowl3 파워(1P→1C)로 크레딧 갭 1~3을 메꾸고 TS 업글(대부분 할인 3C). 랩/아카에만 있던
                // upgradeConvertCombo의 TS판(순수 후보 개방 — 선택은 MCTS). 타클론은 브레인 회계 특수라 제외.
                let tsFundPre: BotAction[] | null = null;
                if (credits < cost && getPlayerFlag(playerId, 'tsConvertCombo', true) && player.faction !== 'taklons') {
                    const gap = cost - credits;
                    if (gap <= 3) {
                        const pre: BotAction[] = [];
                        let oreSur = ore - 2, p3 = player.power3 ?? 0, ok = true;
                        for (let i = 0; i < gap; i++) {
                            if (oreSur > 0) { pre.push({ type: 'convert_resource', params: { type: '1ore-to-1credit' } }); oreSur--; }
                            else if (p3 > 0) { pre.push({ type: 'convert_resource', params: { type: '1power-to-1credit', useBrain: false } }); p3--; }
                            else { ok = false; break; }
                        }
                        if (ok && pre.length > 0) tsFundPre = pre;
                    }
                }
                if (credits >= cost || tsFundPre) {
                    // [사용자 피드백] TS 점수도 전반적으로 광산보다 높게 유지하여 연구소로 가는 발판을 마련함
                    let score = isDiscounted ? 200 : 50;

                    const academyCount = myStructures.filter(t => t.structure === 'academy').length;
                    const isFirstTS = tsCount === 0 && labCountNow === 0 && academyCount === 0;

                    // [flag: ts26BanEarly] 사용자 실험(2026-07-12): R1-2 비할인(2O/6C) TS는 '첫 TS' 제외 전면 금지
                    //   — 인접 할인(3C) TS는 자유, 6C는 첫 엔진 발판(랩 경로)일 때만. 점수가 아닌 후보 미생성(하드).
                    //   단독 40판 VP−1.27(기각) — 아낀 자원이 다른 낭비(번3+·2토큰액션)로 샜다는 사용자 가설로
                    //   [flag: earlyWasteBan] 3종 묶음(6C TS + 번3+ + 2토큰액션) 재실험.
                    if ((getPlayerFlag(playerId, 'ts26BanEarly', false) || getPlayerFlag(playerId, 'earlyWasteBan', true))
                        && round <= 2 && !isDiscounted && (!isFirstTS || getPlayerFlag(playerId, 'firstTs6cBan', false))) {
                        continue;
                    }

                    // [flag: tsEarlyHardGate] 점수 패널티는 TS를 후보에서 못 잘라냄(top-5 안에 남아 MCTS 평가기가 결국 고름
                    //   → 측정상 초반 TS 타이밍 안 바뀜: TS(R1-2) 2.16→2.00, TS평균R 3.11→3.09). 그래서 점수가 아니라 하드 게이팅으로.
                    //   초반(R≤2)엔 good-case가 아니면 mine→TS 후보를 아예 '생성하지 않아' MCTS가 보지도 못하게 한다.
                    //   good-case: ①첫 TS(랩/의회 발판) ②광산 딱 3개(표준보드 3번째 광산 수입 0 → TS 전환이 순이득). 연방은 R3+라 초반 무관.
                    if (getPlayerFlag(playerId, 'tsEarlyHardGate', false) && round <= 2 && !isFirstTS && mineCount !== 3) {
                        continue;
                    }

                    // [flag: mineKeepGate] 사용자(2026-07-07): 기술로 광석 income을 가져와도 광산을 계속 TS로 바꾸면
                    //   광석수입이 무의미해짐 → 다음R 광석기아(결정의 16.9%가 광석≤1&크레딧≥4&빌드불가). 광산=광석엔진이라
                    //   good-case 아니면 mine→TS 후보를 아예 생성 안 함(하드게이트, 점수 아님 — tsScoreRework 점수판은 기각됨).
                    //   good-case: ①광산 정확히 3개(3번째는 income 0이라 순+3C) ②첫 TS(랩/의회 발판) ③연방을 새로 열거나 위성 줄임.
                    //   tsEarlyHardGate(R≤2)의 전(全)라운드 + 연방 포함판. 광석수입 보존 → 비율 맞춰 빌드↑.
                    if (getPlayerFlag(playerId, 'mineKeepGate', false) && !isFirstTS && mineCount !== 3) {
                        let tsHelpsFed = false;
                        if (round >= 3 && !game.simulation) {
                            const before = BotLogic.getBestFederationSpentTokens(game, playerId);
                            const after = BotLogic.getBestFederationSpentTokensAfterUpgrade(game, playerId, mine.id, 'trading_station');
                            tsHelpsFed = (before == null && after != null) || (before != null && after != null && after < before);
                        }
                        if (!tsHelpsFed) continue; // 광산 유지(광석수입 보존)
                    }

                    if (!isDiscounted && round <= 3) {
                        score -= isFirstTS ? 20 : 100; // 초반 비할인 교역소는 웬만하면 올리지 않도록 강력한 패널티 (첫 교역소는 연구소를 위해 완화)
                    }

                    // 초반 엔진 빌딩의 기본은 "광산 확장"이다.
                    // 1~2라운드에 광산이 부족하면 TS 업그레이드를 강하게 억제 (할인 TS만 예외적으로 허용)
                    if (round <= 2 && mineCount < 4) {
                        score -= isFirstTS ? (isDiscounted ? 0 : 20) : (isDiscounted ? 60 : 240);
                    }

                    // [데이터 실패분석 2026-06-14] 봇 참사게임(y<40)은 광산 3.55 vs 좋은게임(y>90) 5.87인데
                    // TS는 오히려 더 많음(1.29 vs 1.11) = "새 광산 확장 대신 있는 광산 업글 → 작은 엔진"이 점수 박살 #1 패턴.
                    // 엔진이 작을 때(광산<5) 중반(R≤4)까지 비-첫-TS·비할인 업글을 억제해 새 광산 건설을 우선시킨다.
                    // (할인 TS·첫 TS(연구소 발판)는 예외. 광산 후보 없으면 TS는 그대로 후보로 남아 정체 없음)
                    if (getPlayerFlag(playerId, 'mineFirstExpansion', false) && !isFirstTS && !isDiscounted && mineCount < 5 && round <= 4) {
                        score -= 120;
                    }

                    // [전략 개선] 1라운드 교역소 남발 방지: 연구소/아카데미가 없는 상태에서의 단순 교역소는 감점
                    if (round === 1 && !isFirstTS) {
                        if (labCountNow === 0 && academyCount === 0) {
                            score -= 60; // 먼저 연구소로 올릴 계획이 아니면 1라 여러 개의 광산을 TS로 올리는 건 비효율적
                        }
                    }

                    // 아무리 감점되어도 첫 교역소라면 후보에 올라가서 MCTS가 평가할 수 있도록 최소 점수 보장
                    if (isFirstTS && score <= 0) {
                        score = 10;
                    }

                    // [오레기아 가드] 다음 라운드 크레딧:오레 수입>3.5면 추가 TS는 오레를 먹고 크레딧수입만 더 올려
                    // 비율을 악화(=교역소 죽음의 나선). 첫 TS(연구소 발판) 외엔 강하게 억제 → 광산/오레 파워액션 우선.
                    if (oreStarved && !isFirstTS) score -= 220;
                    // [flag: creditCapGuard] 상한 오버플로우 예약이면 크레딧 수입원(TS) 증설은 수입 증발 확대 — 강억제
                    if (creditOverflow && !isFirstTS) score -= 260;

                    // [flag: hhPiRush] HH 부검(2026-07-03 fhhid49g, 33점): R2 TS 4연속(8O)→PI(4O6C) 광물 영영 못 모음
                    // → PI 없는 HH는 신용 사용처가 없어 26~30C 사장. 단 무조건 감점은 정상 TS 플레이도 깎아
                    // HH 좌석 −6.9(24판) → 사재기가 실제 형성 중일 때(credits≥10)만 = 죽음의 나선 상태 한정.
                    if (getPlayerFlag(playerId, 'hhPiRush', true) && player.faction === 'hadsch_hallas' && tsCount >= 2
                        && credits >= 10 && !myStructures.some(t => t.structure === 'planetary_institute')) score -= 140;

                    // [flag: tsScoreRework] 사용자 룰: mine→TS는 광석수입→크레딧수입 "전환"일 뿐 총수입은 안 늘어(돈 남으면 오히려 실질수입↓).
                    //   그러니 TS는 기본적으로 잘 안 짓고, 아래 3가지 좋은 케이스에만 가점:
                    //   ① 광산 딱 3개 — 표준 보드에서 3번째 광산은 광석수입을 안 늘리므로, 하나를 TS로 바꾸면 광석수입 손실 0 + 크레딧수입 +3 (순이득)
                    //   ② 연구소/의회 발판 — 이 TS를 lab/academy로 올릴 계획(isFirstTS 또는 랩 여유+광산기반 있음)
                    //   ③ 연방에 파워 부족 — TS 파워값↑로 7파워 달성 (아래 1521 연방블록이 +480/+280로 이미 처리)
                    if (getPlayerFlag(playerId, 'tsScoreRework', false)) {
                        const mineExactly3 = mineCount === 3;
                        const labStepping = isFirstTS || (labCountNow + academyCount < 3 && mineCount >= 4);
                        if (mineExactly3) {
                            score += 140; // 3번째 광산 수입 0 → TS 전환이 순이득(광석수입 손실 없이 크레딧수입 획득)
                        } else if (!labStepping) {
                            // 발판도 광산3도 아니면 일반 TS = 쓸모있는 광석수입을 (남을) 크레딧으로 바꾸는 낭비 → 강한 감점.
                            // (연방 파워 케이스는 아래 연방블록의 큰 가점이 이 감점을 덮음)
                            score -= 160;
                        }
                    }

                    score -= fedPenalty(mine.id);
                    score += this.calculateRoundScoringBonus(game, playerId, 'build_trading_station');
                    score += this.calculateFinalMissionBonus(game, playerId, mine, 'trading_station');
                    score += this.calculateAdjacencyBonus(game, playerId, mine);
                    // [수정 #2] 위성 낭비 완화: 교역소 업그레이드(파워값↑)로 연방이 새로 열리거나 더 적은 위성으로
                    // 가능해지면 강하게 우대. 기존엔 6라 전용이라 중반에 "위성 줄이는 업글"을 고려 못 했음 → 4라+로 확장.
                    // (실게임 턴에서만 평가해 MCTS 시뮬 비용 폭증 방지)
                    if (round >= 4 && !game.simulation) {
                        const before = BotLogic.getBestFederationSpentTokens(game, playerId);
                        const after = BotLogic.getBestFederationSpentTokensAfterUpgrade(game, playerId, mine.id, 'trading_station');
                        if (before == null && after != null) {
                            score += 480; // 업그레이드로 연방이 새로 열림
                        } else if (before != null && after != null && after < before) {
                            score += Math.min(280, (before - after) * 90); // 위성을 더 적게 쓰는 연방 가능 → 절감폭만큼 가점
                        } else if (round === 6) {
                            // [flag: r6TsGuard] 사용자 관찰(2026-07-04): R6 마지막턴 4O4C에서 미션(연구소 4VP)도 연방개선도
                            // 없는 TS 업글 = 자원만 태우고 잔여자원 VP 마이너스. 기존 무조건 +120이 이걸 부추김 →
                            // 연방개선 없고 라운드미션도 TS가 아니면 후보 자체를 제외(gfFinalRoundGuard와 같은 R6 확정낭비 패턴).
                            const tsMission = game.roundScoringTiles[5]?.triggerType === 'build_trading_station';
                            if (getPlayerFlag(playerId, 'r6TsGuard', true) && !tsMission) continue;
                            score += 120;
                        }
                    }

                    candidates.push({
                        id: `ts-${mine.id}`,
                        score,
                        action: tsFundPre
                            ? { type: 'upgrade_structure', params: { tileId: mine.id, target: 'trading_station' }, preActions: tsFundPre }
                            : { type: 'upgrade_structure', params: { tileId: mine.id, target: 'trading_station' } },
                        isFederated: isFederated(mine.id),
                    });
                }
            }
        }

        // 2. Trading Stations -> Research Labs
        // [flag: upgradeConvertCombo] 사용자 관찰(2026-07-04 R6 블런더): 4O4C인데 연구소(3O5C)가 credits>=5에 탈락 →
        // 1O→1C 한 번이면 정확히 가능(+ 라운드미션 4VP)했는데 후보가 안 생겨 무의미한 TS 업글을 함.
        // 광석 잉여가 크레딧 갭을 덮으면 1O→1C 프리액션 콤보로 후보 생성(변환+메인 번들 갭 교정).
        const labCreditGap = Math.max(0, 5 - credits);
        const labCombo = getPlayerFlag(playerId, 'upgradeConvertCombo', true) && labCreditGap > 0 && ore >= 3 + labCreditGap;
        if ((ore >= 3 && credits >= 5) || labCombo) {
            const labConvertPre: BotAction[] | undefined = labCombo
                ? Array.from({ length: labCreditGap }, () => ({ type: 'convert_resource' as const, params: { type: '1ore-to-1credit' } }))
                : undefined;
            const tsList = myStructures.filter(t => t.structure === 'trading_station');
            const labCount = labCountNow;
            // [flag: labSpread] 사용자 관찰(2026-07-16): "건설할 때 연구소 3개가 딱 붙어있는 경우가 너무 흔함" —
            // 랩 트리플 클러스터는 연방 하나에 통째로 묶여 아카 씨앗·다음 연방 씨앗이 소멸(fedLabKeepOut의 상류).
            // 기존 랩 2+개와 dist≤2로 붙는 TS는, 덜 붙는 대안 TS가 있으면 랩 후보에서 제외(하드 필터).
            const labSpreadOn = getPlayerFlag(playerId, 'labSpread', true);
            const existingLabs = labSpreadOn ? myStructures.filter(t => t.structure === 'research_lab') : [];
            const labsNear = (t: { q?: number, r?: number }) => existingLabs.filter(l => getDistance(l as any, t as any) <= 2).length;
            for (const ts of tsList) {
                if (labSpreadOn && existingLabs.length >= 2 && labsNear(ts) >= 2
                    && tsList.some(o => o.id !== ts.id && labsNear(o) < 2)) continue;
                // 연구소는 최소 1개는 필요(기술 타일 + 트랙 전진으로 확장 가능해짐).
                // 다만 광산 기반 없이 너무 빨리 뛰면 망하므로 "첫 연구소"만 완화된 조건으로 허용.
                const isFirstLab = labCount === 0;
                // [flag: firaksLabLock] 파이락스 다운그레이드 엔진(랩→TS+연구, 라운드당 1회)은 PI가 있어야 발동.
                //   (1) PI 전엔 2번째 랩 금지 — PI 없이 랩 2개는 다운그레이드 못 하는 낭비, PI를 먼저 지으라(사용자 요청).
                //   (2) PI 있는데 랩 0개(다운그레이드로 소모됨)면, 매 라운드 능력 쓰려면 랩 1개 재확보를 강하게 우선.
                const firaksLabLock = player.faction === 'firaks' && getPlayerFlag(playerId, 'firaksLabLock', true);
                const firaksHasPI = firaksLabLock && myStructures.some(t => t.structure === 'planetary_institute');
                if (firaksLabLock && !firaksHasPI && labCount >= 1) continue; // (1) PI 전 2번째 랩 락
                // [flag: geodensPiFirst] 기오덴 PI = 새 행성유형 정착마다 +3K — PI 전에 새 유형에 지은 광산은 전부 손실.
                // 그런데 첫 랩(360)이 PI(~140)를 압살해 순서가 거꾸로였음(사용자 관찰: "왜 자꾸 의회 안 짓고 연구소를 노려").
                // PI를 지금 지불 가능(4O6C)하고 새 유형 2+ 도달 가능하면 이 턴 랩을 미룸(랩은 다음 턴 — 순서만 교정).
                if (player.faction === 'geodens' && getPlayerFlag(playerId, 'geodensPiFirst', false)
                    && round <= 4 && ore >= 4 && credits >= 6
                    && !myStructures.some(t => t.structure === 'planetary_institute')
                    && this.shouldGeodenBuildPI(game, playerId)) continue;
                if (round <= 2) {
                    // 첫 연구소가 아니면 1~2라는 억제
                    if (!isFirstLab) continue;
                    // [사용자 피드백] 발탁(Bal T'aks)처럼 1광산 극단적 시작을 하거나, 자원이 너무 부족해 간신히 1TS만 올린 상태라도
                    // 첫 연구소(기술 타일 선점)는 무조건 열어두어야 AI가 아무것도 안하고 패스하는 걸 막을 수 있음.
                    // 기존 과투자 억제(mineCount <= 1 && tsCount <= 1) 조건을 삭제하거나 대폭 완화
                }

                // [사용자 피드백] 단순 광산 건설보다 TS -> Lab 업그레이드(기술 타일 선점)를 최우선으로 하도록 대폭 상향
                let score = 180;
                // 초반 연구소 확보 가점 (매우 높게 조정)
                if (round <= 3 && labCount < 2) score += 80;
                if (labCount === 0) score += 100;
                // (2) 파이락스 PI 보유 + 랩 0개 = 다운그레이드 능력 쓸 랩이 없음 → 재확보 강하게 우선(매 라운드 엔진 가동).
                if (firaksLabLock && firaksHasPI && labCount === 0) score += 250;

                // 광산/TS 엔진이 아직 약하면 추가 감점 (단, "첫 연구소"는 감점을 완화)
                // 첫 연구소일지라도 기반이 너무 없으면 살짝 감점을 주되 후보에서 아예 날아가지는 않게 유지
                if (round <= 3 && mineCount < 3) score -= isFirstLab ? 20 : 120; // 6에서 3으로 기준 완화
                if (round <= 3 && tsCount < 2) score -= isFirstLab ? 10 : 80;

                score -= fedPenalty(ts.id); score -= fedDeferPenalty(ts.id);
                score += this.calculateRoundScoringBonus(game, playerId, 'build_research_lab');
                score += this.calculateFinalMissionBonus(game, playerId, ts, 'research_lab');
                // [flag: advTileOverL5] green+L4+좋은 고급타일(≥85) 보유 시 연구소 건설을 우대 — 이게 tech-gain을 트리거해
                // findTechTileAction이 그 고급타일을 집게 함(트리거 없으면 고급타일 기회 자체가 안 생겨 봇 0건이던 것).
                if (getPlayerFlag(playerId, 'advTileOverL5', true) && countGreenFederations(player) >= 1
                    && this.bestClaimableAdvScore(game, playerId) >= 70) score += 130;

                candidates.push({
                    id: `lab-${ts.id}`,
                    score,
                    action: labConvertPre
                        ? { type: 'upgrade_structure', params: { tileId: ts.id, target: 'research_lab' }, preActions: labConvertPre }
                        : { type: 'upgrade_structure', params: { tileId: ts.id, target: 'research_lab' } },
                    isFederated: isFederated(ts.id),
                });
            }
        }

        // 3. Trading Stations -> Planetary Institute
        const hasPI = myStructures.some(t => t.structure === 'planetary_institute');
        // [flag: upgradeOreConvert] 사람 실측(저널 델타): 아카 225건 중 43건(19%)이 3P→1O·1Q→1O 변환으로 광석을
        // 채워 완납 — 저널 스냅샷이 턴시작이라 '저지불'로 보였던 것의 실체. 봇은 지갑 광석만 봐서 이 후보가 없음.
        // 광석 갭 ≤2를 파워(3P→1O, 타클론 제외)·여유 QIC(1Q→1O, 예비 1 보존)로 채우는 preActions — PI/아카 공용.
        const oreConvertPre = (gap: number, gapCap = 2): BotAction[] | null => {
            if (!getPlayerFlag(playerId, 'upgradeOreConvert', true) || gap <= 0 || gap > gapCap || player.faction === 'taklons') return null;
            const pre: BotAction[] = [];
            let p3 = player.power3 ?? 0, q = player.qic ?? 0;
            for (let i = 0; i < gap; i++) {
                if (p3 >= 3) { pre.push({ type: 'convert_resource', params: { type: '3power-to-1ore' } }); p3 -= 3; }
                else if (q >= 2) { pre.push({ type: 'convert_resource', params: { type: '1qic-to-1ore' } }); q -= 1; }
                else return null;
            }
            return pre;
        };
        // [flag: firaksPiFunding] 파이락 엔진 자금 v2(직접-return v1은 −6.40 기각 — 병목은 후보 미생성=자금):
        // 사람은 R1-2에 TS→랩→PI(9O14C)를 변환으로 조달해 다운그레이드 엔진 가동(성공 판 186-220점).
        // 파이락 R≤2 + 랩 보유(firaksPiReady) 시 PI 광석 갭 변환 상한 2→4 — 후보만 존재시키고 선택은 MCTS.
        const firaksPiGapCap = (getPlayerFlag(playerId, 'firaksPiFunding', true) && player.faction === 'firaks'
            && round <= 2 && myStructures.some(t => t.structure === 'research_lab')) ? 4 : 2;
        const piOrePre = credits >= 6 ? oreConvertPre(Math.max(0, 4 - ore), firaksPiGapCap) : null;
        if (((ore >= 4 && credits >= 6) || piOrePre) && !hasPI) {
            // [버그수정 2026-07-05: bescods 트리] 매안은 TS→PI를 서버가 거부(6197), 전용 경로=연구소→PI(6224).
            // 봇에 매안 분기가 없어 표준 TS→PI만 시도→항상 실패→매안은 의회를 영영 못 지었음(사용자 관찰).
            const tsList = player.faction === 'bescods'
                ? myStructures.filter(t => t.structure === 'research_lab')
                : myStructures.filter(t => t.structure === 'trading_station');
            // [flag: lantidsEarlyPI] 란티다 PI = 기생광산 지을 때마다 +2지식(gameState 5876). 기생 타겟(상대 점유행성)이 있으면
            //   PI를 먼저 짓고 기생해야 이득이 큼(사용자). 기존엔 제네릭 취급 → R4 전 PI 차단(아래 continue) → 기생광산이
            //   전부 지식보너스를 못 받음(실측: 란티다 봇 게임 PI 0개, 기생 3개 전부 PI前). 타겟 수 비례 우대 + 조기 허용.
            const lantidsEarlyPI = player.faction === 'lantids' && getPlayerFlag(playerId, 'lantidsEarlyPI', true);
            const paraTargetCount = lantidsEarlyPI
                ? game.map.filter(t => t.ownerId && t.ownerId !== playerId && t.structure && !t.parasiticMine && !t.type?.startsWith('ship_')).length
                : 0;
            const lantidsPiReady = lantidsEarlyPI && paraTargetCount >= 1 && mineCount >= 2;
            // [flag: hhPiRush] HH 의회 = 종족 엔진(매라운드 4C→1Q/4C→1K/3C→1O 무료변환, gameState 6245).
            // 실게임 부검(33점 참사): R4 전 hard continue로 PI 후보가 MCTS에 보이지도 않음(후보생성 갭)
            // → 광산 기반(3+)만 있으면 조기 허용. PI만 서면 hadschHallasConvert가 신용을 자원으로 순환.
            const hhPiReady = player.faction === 'hadsch_hallas' && getPlayerFlag(playerId, 'hhPiRush', true) && mineCount >= 3;
            // [flag: geodensPiFirst] R≤2 광산<5 게이트가 earlyPiAllowed(점수)와 무관하게 기오덴 PI 후보를 차단하고
            // 있었음 — 새 유형 2+ 도달 가능 + 광산 3+면 조기 PI 후보 허용(PI 전 새유형 광산 = 3K씩 손실).
            const geodensPiReady = player.faction === 'geodens' && getPlayerFlag(playerId, 'geodensPiFirst', false)
                && mineCount >= 3 && this.shouldGeodenBuildPI(game, playerId);
            // [flag: bescodsPiBeforeFed] 매안 PI = 파워값 4(5394) → PI 먼저 지으면 연방이 훨씬 쌈(PI4+TS2+광산1=7).
            // 사람은 대부분 연방 전 PI(사용자). 실측 매안 봇 PI율 6%(전종족 최저) — R<4 게이트 + 랩(PI 소스) 희생
            // 저평가가 원인. 랩 1+ & 광산 3+면 조기 후보 허용 → piBeforeFed(ON)가 연방을 자동으로 PI 뒤로 시퀀싱.
            const bescodsPiReady = player.faction === 'bescods' && getPlayerFlag(playerId, 'bescodsPiBeforeFed', false)
                && mineCount >= 3 && myStructures.some(t => t.structure === 'research_lab');
            for (const ts of tsList) {
                // 기본 의회 점수 (초반에는 아카데미/연구소보다 낮게 설정하여 무분별한 의회 건설 방지)
                let score = 30;

                // 종족별 PI 타이밍 강력 권장
                const faction = player.faction;
                // 사용자 피드백: 초반 PI는 기오덴/네뷸라/스자(스페이스 자이언츠) 정도만 예외
                const earlyPiAllowed = ['geodens', 'nevlas', 'space_giants'];
                const r2Preferred = ['itars', 'darkanians'];

                if (earlyPiAllowed.includes(faction || '')) {
                    if (round <= 2) score += 80;
                    else score += 50;
                } else if (r2Preferred.includes(faction || '')) {
                    if (round <= 2) score += 70;
                    else score += 40;
                } else if (faction === 'firaks' && getPlayerFlag(playerId, 'firaksDowngrade', true)) {
                    // [flag: firaksDowngrade] 피락스: 연구소+의회면 매 라운드 다운그레이드(랩→TS+연구) 엔진 → 의회 조기 우선.
                    const hasLab = myStructures.some(t => t.structure === 'research_lab');
                    if (hasLab) score += round <= 3 ? 140 : 60;
                    // [flag: firaksPiPriority] 실측 트레이스(2026-07-15): 봇이 랩을 이미 갖고도 R1-2에 배 입장(TF Mars,
                    // 점수 150-450)/광산을 PI(30+140=170)보다 먼저 골라 PI가 R3+로 밀림(R2이내 22.5%). 랩 보유 = PI가
                    // 다운그레이드 엔진의 마지막 조각이므로 R≤2엔 배/광산보다 우선해야 함. 강제 아님(점수 넛지) — 자금 안 되면
                    // 후보 미생성이라 발동 안 함(firaksPiFunding이 자금 채움). mine-hold(+3.90 채택)와 동계열.
                    if (hasLab && round <= 2 && getPlayerFlag(playerId, 'firaksPiPriority', true)) score += 180;
                } else if (lantidsPiReady) {
                    // 란티다: 기생 타겟 있으면 조기 PI 강력 우대(각 후속 기생 = +2지식). 타겟 많을수록 더.
                    score += round <= 2 ? 60 : 90;
                    score += Math.min(80, paraTargetCount * 15);
                } else if (hhPiReady) {
                    // HH: PI가 곧 경제 엔진 — 조기일수록 변환 라운드가 많이 남아 가치가 큼.
                    score += round <= 2 ? 80 : 60;
                } else if (bescodsPiReady) {
                    // 매안: PI(4파워) = 연방 인에이블러. 아직 연방 없으면 더 강하게.
                    score += (round <= 2 ? 70 : 50) + (countGreenFederations(player) === 0 ? 30 : 0);
                } else {
                    // 그 외 종족: 4라운드 이전에는 건설 기피, 4라운드부터 의회 고려
                    if (round < 4) score -= 30;
                    if (round >= 4) score += 50;
                }

                // 초반(1~2라) 의회는 거의 항상 과소비 → "광산 기반" 없으면 차단/강한 감점
                // 단 피락스는 연구소가 있으면 의회를 조기 허용(다운그레이드 엔진 가동 — 광산 기반 게이트도 면제). R1은 모두 너무 이름.
                const firaksPiReady = faction === 'firaks' && getPlayerFlag(playerId, 'firaksDowngrade', true) && myStructures.some(t => t.structure === 'research_lab');
                // [flag: r1PiOpen] 실측(2026-07-11): 사람 R1 의회 32건 — 전부 PI-파워 종족(스자7·란티다7·네뷸라6·
                // 기오덴4·피락스4·할라3). 사람 R1 랩∪의회 도달 86% vs 봇 76%(의회 0%). 기존 R1 절대차단 +
                // R≤2 광산<5 게이트가 earlyPiAllowed 우대점수(+80)를 죽은 코드로 만들고 있었음 → 해당 종족만
                // 광산 2+ 조건으로 개방(순수 후보 추가 — 선택은 MCTS/평가기).
                // [flag: r1PiCalib103] 103게임 리캘리브레이션(2026-07-22): 사람 R1 의회 50건의 당시 광산수는 0~2
                // (대부분 1 — 시작광산→TS 업글 후라 구조적으로 1) → 기존 mineCount>=2 게이트가 사람 패턴을 거의
                // 전부 차단. 광산 게이트 제거 + 실측 종족 확장(darkanians 3·itars 3건; bescods 1건은 노이즈로 제외).
                const r1Calib = getPlayerFlag(playerId, 'r1PiCalib103', true);
                const r1PiFactions = r1Calib
                    ? [...earlyPiAllowed, 'lantids', 'firaks', 'hadsch_hallas', 'darkanians', 'itars']
                    : earlyPiAllowed;
                const r1PiOpen = getPlayerFlag(playerId, 'r1PiOpen', true) && (r1Calib || mineCount >= 2)
                    && (r1PiFactions.includes(faction || '') || firaksPiReady || lantidsPiReady || hhPiReady);
                // [flag: piGateOpen] 리프로브 실측(라이브 PI 갭 40건): R2-3 비허용 종족이 광산 4~10개 기반으로
                // PI를 지음(bescods 3·xenos 3·itars 2·ambas·terran·darkanians) — round<4 게이트가 종족 무관 차단.
                // 광산 4+ & R2+면 개방 (acadGateOpen·r1PiOpen 동형: 순수 후보 개방, 선택은 MCTS).
                const piGateOpen = getPlayerFlag(playerId, 'piGateOpen', true) && round >= 2 && mineCount >= 4;
                // [flag: piGateWide] 94게임 리프로브(2026-07-20): 사람 PI 79건 중 봇 후보 부재 84.8%, 그 72%가
                // 이 R1-3 게이트들 — 사람은 전 종족이 광산 1~7 기반으로 조기 PI(스자 광산1, 기오덴 광산1, 매안
                // 광산2, 암바스 광산2, 제노스·테란…). 기존 개방(r1PiOpen 종족제한·piGateOpen 광산4+)도 39건을
                // 남김 → 자금 실존 시 후보 무조건 개방(순수 후보 개방 — 선택은 MCTS/평가기, acadGateOpen 동형).
                if (!getPlayerFlag(playerId, 'piGateWide', true)) {
                    if (round === 1 && !r1PiOpen) continue;
                    if (!earlyPiAllowed.includes(faction || '') && !firaksPiReady && !lantidsPiReady && !hhPiReady && !geodensPiReady && !bescodsPiReady && !piGateOpen && round < 4) continue;
                    if (round <= 2 && mineCount < 5 && !firaksPiReady && !lantidsPiReady && !hhPiReady && !geodensPiReady && !bescodsPiReady && !r1PiOpen && !piGateOpen) continue;
                } else if (getPlayerFlag(playerId, 'piR1HumanOnly', true) && round === 1 && !r1PiOpen) {
                    // [flag: piR1HumanOnly] 사용자 관찰(2026-07-20): piGateWide가 R1까지 열어 발타크 등 전 종족이
                    // R1 의회(480석 중 발타크 25·스자 26·암바스 17…) — 사람 R1 의회는 PI-파워 종족 6개뿐(32건 실측).
                    // R1은 사람 실측 목록(r1PiOpen)만, 전면 개방은 R2+부터.
                    continue;
                }

                if (faction === 'geodens' && this.shouldGeodenBuildPI(game, playerId)) score += 30;

                score -= fedPenalty(ts.id); score -= fedDeferPenalty(ts.id);
                // [flag: fedZoneStrategy] 의회(파워값 3)로 올려 구역 연방을 '닫거나' 위성을 줄일 수 있으면 강하게 우대
                // — 먼 집까지 위성으로 잇지 말고 구역 내부 티어업으로 7파워 채우라는 전략(사용자 모델).
                if (getPlayerFlag(playerId, 'fedZoneUpgrade', false) && round >= 4 && !game.simulation) {
                    const before = BotLogic.getBestFederationSpentTokens(game, playerId);
                    const after = BotLogic.getBestFederationSpentTokensAfterUpgrade(game, playerId, ts.id, 'planetary_institute');
                    if (before == null && after != null) score += 480;
                    else if (before != null && after != null && after < before) score += Math.min(280, (before - after) * 90);
                }
                score += this.calculateRoundScoringBonus(game, playerId, 'build_big_building');
                score += this.calculateFinalMissionBonus(game, playerId, ts, 'planetary_institute');

                candidates.push({
                    id: `pi-${ts.id}`,
                    score,
                    action: piOrePre
                        ? { type: 'upgrade_structure', params: { tileId: ts.id, target: 'planetary_institute' }, preActions: piOrePre }
                        : { type: 'upgrade_structure', params: { tileId: ts.id, target: 'planetary_institute' } },
                    isFederated: isFederated(ts.id),
                });
            }
        }

        // 4. Research Labs -> Academies
        const academyCount = myStructures.filter(t => t.structure === 'academy').length;
        // [flag: upgradeConvertCombo] 아카(6O6C)도 광석 잉여가 크레딧 갭을 덮으면 1O→1C 콤보 후보(연구소와 동일 갭 교정)
        const acadCreditGap = Math.max(0, 6 - credits);
        const acadCombo = getPlayerFlag(playerId, 'upgradeConvertCombo', true) && acadCreditGap > 0 && ore >= 6 + acadCreditGap;
        const acadConvertPre: BotAction[] | undefined = acadCombo
            ? Array.from({ length: acadCreditGap }, () => ({ type: 'convert_resource' as const, params: { type: '1ore-to-1credit' } }))
            : undefined;
        const acadOrePre = credits >= 6 ? oreConvertPre(Math.max(0, 6 - ore)) : null;
        // [flag: acadFundV2] 103게임 리프로브: 아카 갭 1위 '자원부족(6O6C) 29건' — 기존 조달이 못 덮는 두 케이스:
        // ①광석갭 3(oreConvertPre 캡 2 초과) ②광석갭+크레딧갭 혼합(acadCombo는 광석잉여 전제, acadOrePre는 credits≥6 전제).
        // 광석갭≤3은 3P→1O/1Q→1O(예비 1Q 보존), 크레딧갭은 잔여 bowl3 1P→1C → 잉여광석 1O→1C 순으로 혼합 충당(타클론 제외).
        let acadFundPre: BotAction[] | null = null;
        if (getPlayerFlag(playerId, 'acadFundV2', false) && !acadConvertPre && !acadOrePre
            && !(ore >= 6 && credits >= 6) && player.faction !== 'taklons') {
            const oreGap = Math.max(0, 6 - ore);
            const credGap = Math.max(0, 6 - credits);
            if (oreGap <= 3) {
                const pre: BotAction[] = [];
                let p3 = player.power3 ?? 0, q = player.qic ?? 0;
                let oreSurplus = Math.max(0, ore - 6);
                let ok = true;
                for (let i = 0; i < oreGap && ok; i++) {
                    if (p3 >= 3) { pre.push({ type: 'convert_resource', params: { type: '3power-to-1ore' } }); p3 -= 3; }
                    else if (q >= 2) { pre.push({ type: 'convert_resource', params: { type: '1qic-to-1ore' } }); q -= 1; }
                    else ok = false;
                }
                for (let i = 0; i < credGap && ok; i++) {
                    if (p3 >= 1) { pre.push({ type: 'convert_resource', params: { type: '1power-to-1credit' } }); p3 -= 1; }
                    else if (oreSurplus > 0) { pre.push({ type: 'convert_resource', params: { type: '1ore-to-1credit' } }); oreSurplus--; }
                    else ok = false;
                }
                if (ok && pre.length > 0) acadFundPre = pre;
            }
        }
        if (((ore >= 6 && credits >= 6) || acadCombo || acadOrePre || acadFundPre) && academyCount < 2) {
            // [버그수정 2026-07-05: bescods 트리] 매안 전용 TS→아카(서버 6234)도 아카 소스로 — 봇에 분기가 없어
            // 매안이 교역소에서 아카 직행을 영영 못 썼음(사용자 관찰). 표준 연구소→아카는 매안도 유효라 둘 다.
            const labList = player.faction === 'bescods'
                ? myStructures.filter(t => t.structure === 'research_lab' || t.structure === 'trading_station')
                : myStructures.filter(t => t.structure === 'research_lab');
            for (const lab of labList) {
                // 아카데미는 너무 초반(1R)에는 과소비가 잦지만, 2~3R부터는 상황에 따라 허용
                // 사용자 피드백: 1라 아카도 가능하면 좋음. (단, 시작 광산 2개 수준은 확보되어야 함)
                // 광산 기반이 너무 없으면 억제 (1R은 예외적으로 허용 범위 확대)
                // [flag: acadGateOpen] candidateProbe 갭 2위(172건): 사람은 광산 4개로도 R2-3 아카 직행하는데
                // 이 게이트(R≤3 & 광산<5)가 후보를 차단. r1PiOpen과 동형 — 광산 3+면 개방(선택은 MCTS).
                const acadOpen = getPlayerFlag(playerId, 'acadGateOpen', true) && mineCount >= 3;
                if (round <= 3 && mineCount < 5 && round !== 1 && !acadOpen) continue;

                // [사용자 피드백] 광산 건설보다 아카데미(고급 기술 타일 획득)를 우선하도록 대폭 상향
                let score = 250;
                if (round === 1 && academyCount === 0) score += 120; // 1라 첫 아카데미는 강하게 보상
                if (round >= 2 && round <= 4 && academyCount === 0) score += 100; // 첫 아카데미는 중반까지 매우 강력 권장
                if (round >= 5) score += 50;

                // 연구소→아카데미(파워값 3)로 구역 연방이 열리거나 더 싸지면 매우 강력.
                // 기존엔 6라에서만 평가 → [flag: fedZoneStrategy] R4+로 확장해 중반에도 '구역 내부 티어업으로 연방 닫기' 유도(사용자 모델).
                const evalAcademyFed = round === 6 || (getPlayerFlag(playerId, 'fedZoneUpgrade', false) && round >= 4 && !game.simulation);
                if (evalAcademyFed) {
                    const before = BotLogic.getBestFederationSpentTokens(game, playerId);
                    const after = BotLogic.getBestFederationSpentTokensAfterUpgrade(game, playerId, lab.id, 'academy');
                    if (before == null && after != null) {
                        score += 520;
                    } else if (before != null && after != null && after < before) {
                        score += Math.min(300, (before - after) * 100);
                    } else if (round === 6) {
                        score += 140;
                    }
                }

                score += this.calculateRoundScoringBonus(game, playerId, 'build_big_building');
                score += this.calculateFinalMissionBonus(game, playerId, lab, 'academy');
                // [flag: advTileOverL5] green+L4+좋은 고급타일(≥85)이면 아카 건설 우대 — tech-gain 트리거→고급타일 획득.
                if (getPlayerFlag(playerId, 'advTileOverL5', true) && countGreenFederations(player) >= 1
                    && this.bestClaimableAdvScore(game, playerId) >= 70) score += 130;

                // 지식 수입이 풍족한데 돈이 부족하면 연구소보다 교역소를 선호하도록 유도하는 점수 보정 (TS 점수가 상대적으로 올라감)
                if ((player.knowledge || 0) > 10 && (player.credits || 0) < 10) {
                    score -= 15;
                }

                score -= fedPenalty(lab.id); score -= fedDeferPenalty(lab.id);
                // [flag: academyTypeChoice] 아카 타입 선택(사용자 룰): 기본 left(2지식 패시브 — 연구기아 봇에 유익).
                // right(QIC 특수액션)는 ①리벨리온 우주선 입장(3정큐=3QIC 액션 연료 필요) 또는 ②R5+(후반엔 패시브지식 회수 라운드 적고 QIC 유연성↑)일 때만.
                // 기존엔 항상 right만 지어 QIC 액션도 안 누르고(=아무것도 못 얻음) 지식도 못 받던 이중낭비.
                const onRebellion = (player.spaceshipsEntered || []).some(id => game.map.find(t => t.id === id)?.type === 'ship_rebellion');
                const acadTarget = getPlayerFlag(playerId, 'academyTypeChoice', true)
                    ? (((game.roundNumber ?? 1) >= 5 || onRebellion) ? 'academy_right' : 'academy_left')
                    : 'academy_right';
                const acadPre = acadConvertPre ?? acadOrePre ?? acadFundPre ?? undefined; // [flag: upgradeOreConvert/acadFundV2] 광석·크레딧 갭 변환 조달
                candidates.push({
                    id: `academy-${lab.id}`,
                    score,
                    action: acadPre
                        ? { type: 'upgrade_structure', params: { tileId: lab.id, target: acadTarget }, preActions: acadPre }
                        : { type: 'upgrade_structure', params: { tileId: lab.id, target: acadTarget } },
                    isFederated: isFederated(lab.id),
                });
            }
        }

        if (candidates.length === 0) return [];

        // 핵심 정책: 연방에 묶인 건물 업그레이드는 "다음 연방"에 도움이 안 되므로,
        // 비연방 업그레이드 후보가 하나라도 있으면 연방 업그레이드는 전부 제거한다.
        const hasNonFederated = candidates.some(c => !c.isFederated);
        // [flag: noFedTierUp] 사용자 관찰("이미 연방에 속한 건물 티어 올리는 게 너무 아까워"): 기존 필터는 비연방 대안이
        //   있을 때만 연방 업글을 뺐음 → 업글 후보가 전부 연방건물이면 그냥 둬서 MCTS가 −450 점수 무시하고 골라(과충전 낭비 +
        //   새 연방 씨앗 소모). 이 플래그는 연방 건물 티어업을 '항상' 후보에서 제외(점수 아닌 필터=결정적). 없으면 업글 안 하고
        //   건설/연구/파워로 감(연방 씨앗 보존). fedMinTrim("작게 자주") 모델과 정합.
        // [정제] blunt(연방건물 전부 제외)는 TS→랩(엔진)까지 막아 −3.56(연구소 −0.24). 랩/PI(지식·능력=실이득)는 연방건물이라도
        //   허용하고, mine→TS(수입전환+파워범프)·아카데미(파워범프)만 제외 = 아까운 낭비만 컷.
        const isEngineUpgrade = (c: ScoredUpgrade) => {
            const tgt = (c.action.params as any)?.target;
            return tgt === 'research_lab' || tgt === 'planetary_institute';
        };
        // [flag: fedEngineUpgOutside] 사용자 관찰(2026-07-06 "여전히 연방 내부 티어업이 많다"): noFedTierUp이 엔진업글
        //   (연구소/PI)은 연방건물이어도 '항상' 통과시켜, MCTS가 −450 점수를 무시하고 연방 안 TS를 연구소/PI로 올림.
        //   전면차단은 −3.56 기각(TS→랩 엔진까지 막음)이므로, 엔진업글 자체는 유지하되 '같은 타깃의 비연방 대안이 있으면'
        //   연방 안 업글만 후보에서 뺀다 = 엔진은 연방 밖 건물에 올려 그 파워증가가 다음 연방 씨앗이 되게(fedMinTrim 정합).
        //   비연방 대안이 없으면(전부 연방) 기존대로 허용(엔진 못 올리는 −3.56 실패 회피).
        const upTarget = (c: ScoredUpgrade) => (c.action.params as any)?.target;
        const hasNonFedSameTarget = (c: ScoredUpgrade) =>
            candidates.some(o => !o.isFederated && upTarget(o) === upTarget(c));
        // [flag: lastRoundFedFree] R6엔 연방 필터도 해제 — 미래 연방이 없어 '연방 안 업글 = 낭비' 근거 소멸
        // (7VP 타일 체인의 첫 계단인 연방 안 mine→TS가 이 필터에 죽던 것).
        const fedFilterOffR6 = getPlayerFlag(playerId, 'lastRoundFedFree', true) && round >= 6;
        const filtered = fedFilterOffR6
            ? candidates
            : getPlayerFlag(playerId, 'noFedTierUp', true)
            ? candidates.filter(c => {
                if (!c.isFederated) return true;
                if (!isEngineUpgrade(c)) return false;
                // 연방 엔진업글: 같은 타깃의 비연방 대안이 있으면 제외(그쪽에 올려라)
                if (getPlayerFlag(playerId, 'fedEngineUpgOutside', true) && hasNonFedSameTarget(c)) return false;
                return true;
              })
            : (hasNonFederated ? candidates.filter(c => !c.isFederated) : candidates);

        filtered.sort((a, b) => b.score - a.score);
        // 후보 컷이 너무 강하면 좋은 수가 탐색에서 사라짐 → 상위 5개로 확장
        return filtered.slice(0, 5).map(c => c.action);
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
            // [버그수정] noFedTierUp이 findUpgradeActions에서 연방 mine→TS를 막는데, 이 할인경로는 별도라 우회했음
            //   — `?? discounted[0]` 폴백이 할인광산 전부 연방일 때 연방 광산을 TS로 올림(사용자 관찰: 다카니안이 연방 광산을 TS로).
            //   noFedTierUp ON이면 연방 광산엔 폴백하지 않음(비연방 할인광산 없으면 null → 딴 행동).
            const noFedTierUp = getPlayerFlag(playerId, 'noFedTierUp', true);
            const preferred = discounted.find(t => !fedHexes.includes(t.id)) ?? (noFedTierUp ? undefined : discounted[0]);
            if (preferred) {
                return { type: 'upgrade_structure', params: { tileId: preferred.id, target: 'trading_station' } };
            }
        }
        return null;
    }

    private static getBestFederationSpentTokens(game: ServerGameState, playerId: string): number | null {
        const fed = FederationPlanner.getBestFederationAction(game, playerId);
        if (!fed) return null;
        return fed.spentTokens ?? 0;
    }

    private static getBestFederationSpentTokensAfterUpgrade(
        game: ServerGameState,
        playerId: string,
        tileId: string,
        upgradedStructure: 'trading_station' | 'academy' | 'planetary_institute'
    ): number | null {
        // lightweight clone: only what FederationPlanner reads (map + players + satellites/fed state)
        const clone: ServerGameState = JSON.parse(JSON.stringify(game));
        const tile = clone.map.find(t => t.id === tileId);
        if (tile) tile.structure = upgradedStructure;
        return this.getBestFederationSpentTokens(clone, playerId);
    }

    private static checkIfActionNeedsQIC(game: ServerGameState, playerId: string, action: BotAction): boolean {
        if (action.type !== 'build_mine') return false;
        const player = game.players[playerId];
        const tile = game.map.find(t => t.id === action.params.tileId);
        if (!tile) return false;

        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            t.parasiticMine?.ownerId === playerId ||
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
        const realPlayer = game.players[playerId];
        const curNav = realPlayer.research.navigation || 0;
        if (curNav >= 5) return false;
        const tile = game.map.find(t => t.id === action.params.tileId);
        if (!tile) return false;

        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        const navBonus = realPlayer.navigationBonus || 0;
        const oldRange = getRange(curNav) + navBonus;

        // [사용자 관찰 2026-06-14] getRange는 nav 0·1 모두 range1, 2·3 모두 range2 → nav 0에서 +1(→1)은
        // range가 안 늘어 기존 로직이 "절약 없음"으로 오판, QIC로 먼저 짓게 됨. 실제로는 nav를 2까지 올리면
        // (range2) 무료가 됨. → '실제 range가 증가하는 다음 nav 레벨'(tier상 최대 +2)까지 보고 판단.
        let nextNav = curNav + 1;
        while (nextNav <= 5 && getRange(nextNav) <= getRange(curNav)) nextNav++;
        if (nextNav > 5) return false;
        const newRange = getRange(nextNav) + navBonus;
        if (newRange <= oldRange) return false;

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
     * 발타크: 미사용 가이아포머를 QIC로 쓸 수 있으나, 서버는 **별도 소켓(use_bal_tak_gaiaformer_to_qic)** 으로만 전환.
     * executeBuildMine은 **player.qic 숫자만** 거리 QIC로 차감하므로, 광산 거리 후보 필터에는 가이아포머를 넣으면 안 됨.
     */
    private static getSpendableQicForMineBuild(player: any): number {
        return player.qic ?? 0;
    }

    /** 발타크: 지갑 QIC를 넘어서 필요한 QIC만큼 GF→QIC 프리액션 배열 (앞에서부터 실행) */
    private static balTakGaiaformerPreActionsForQicShortfall(player: PlayerState, walletQic: number, totalQicNeeded: number): BotAction[] {
        if (player.faction !== 'bal_tak') return [];
        const n = Math.max(0, totalQicNeeded - walletQic);
        if (n <= 0) return [];
        return Array.from({ length: n }, () => ({ type: 'bal_tak_gaiaformer_to_qic' as const, params: {} }));
    }

    /** [flag: hhJitConvert] HH: 지갑 QIC를 넘어서는 필요분만큼 4C→1QIC 변환 preActions — 사용자 룰(2026-07-12):
     *  "미리 바꿔두지 말고 쓰기 직전에 바꿔라"(그 사이 턴에 무슨 일이 생길지 모름 = 크레딧 유동성 보존).
     *  발타크 GF→QIC preActions와 동일 패턴. PI 보유 + 변환 후에도 creditsFloor(액션 크레딧비용+버퍼) 이상 남을 때만. */
    private static hhConvertPreActionsForQicShortfall(game: ServerGameState, playerId: string, walletQic: number, totalQicNeeded: number, creditsFloor: number): BotAction[] {
        const player = game.players[playerId];
        if (player?.faction !== 'hadsch_hallas' || !getPlayerFlag(playerId, 'hhJitConvert', true)) return [];
        const n = Math.max(0, totalQicNeeded - walletQic);
        if (n <= 0) return [];
        if (!game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) return [];
        if ((player.credits ?? 0) - n * 4 < creditsFloor) return [];
        return Array.from({ length: n }, () => ({ type: 'use_hadsch_hallas_pi_action' as const, params: { actionId: 'hh-4c-1qic' } }));
    }

    /** [flag: hhJitConvert] HH가 크레딧으로 즉석 변환 가능한 QIC 수 (후보 생성용 가상 지갑) */
    private static hhConvertibleQic(game: ServerGameState, playerId: string, creditsFloor: number): number {
        const player = game.players[playerId];
        if (player?.faction !== 'hadsch_hallas' || !getPlayerFlag(playerId, 'hhJitConvert', true)) return 0;
        if (!game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) return 0;
        return Math.floor(Math.max(0, (player.credits ?? 0) - creditsFloor) / 4);
    }

    /** 잊혀진 행성 등 가이아포머→QIC 전환이 앞에 붙을 수 있는 흐름용(발타크 가상 QIC 포함) */
    private static getAvailableQic(player: any): number {
        let q = player.qic ?? 0;
        if (player.faction === 'bal_tak') {
            const totalGF = player.gaiaformers ?? 0;
            const usedGF = player.balTakGaiaformersUsedForQic ?? 0;
            q += Math.max(0, totalGF - usedGF);
        }
        return q;
    }

    /**
     * executeBuildMine 표준 광산의 거리·QIC 계산과 동일하게: Nav + 임시 네비 보너스(소모 없이 peek).
     * 이클립스 6C에는 쓰지 않음(규칙상 임시 보너스 비적용).
     */
    private static getEffectiveNavRangeForStandardMine(player: PlayerState): number {
        return getRange(player.research?.navigation || 0) + (player.navigationBonus || 0)
            + (player.tempRangeBonus ? 3 : 0)
            + (player.rangeBonusActive ? 3 : 0)
            + (player.gleensNavBonusActive ? 2 : 0);
    }

    /**
     * 파워 1·2스텝, 스페이스 자이언트 +2TF, 보너스 1스텝, TF 3C→스텝 등 **연계로 이어지는 광산** 거리.
     * 이클립스 6C와 동일하게: Nav + 영구 navigationBonus 만. 글린+2, 보너스+3, 우주선 임시+3 등은 섞지 않음.
     */
    private static getStrictTerraformChainNavRange(player: PlayerState): number {
        return getRange(player.research?.navigation || 0) + (player.navigationBonus || 0);
    }

    /** extraPending만큼 스텝을 더 얹었을 때 해당 타일에 광산 건설이 가능한지(연계 액션 검증) */
    private static canCompleteMineOnTileAfterExtraPending(
        game: ServerGameState,
        playerId: string,
        tileId: string,
        extraPending: number
    ): boolean {
        const player = game.players[playerId];
        if (!player) return false;
        const old = player.pendingTerraformSteps || 0;
        player.pendingTerraformSteps = old + extraPending;
        const ok = this.findBuildActionsWithPendingSteps(game, playerId).some(
            a => (a as any).params?.tileId === tileId
        );
        player.pendingTerraformSteps = old;
        return ok;
    }

    /**
     * 광산 건설 전략 (스코어링 시스템)
     * 우선순위: 모행성 > 가이아 > 파워/TF Mars 콤보 > 테라포밍
     * QIC 소모는 최대 1로 제한
     */
    /** [fedBridge 묘수] 이 빈 타일에 광산을 지으면 연방이 *새로* 가능해지나? clone 없이 임시변경+복원(getBestFederationAction은 읽기전용).
     *  지금 이미 연방 가능하면(before non-null) 브리징 불필요 → false. 지금 불가인데 지으면 가능 → true(브리징 빌드). */
    private static buildEnablesFederation(game: ServerGameState, playerId: string, tileId: string): boolean {
        const tile = game.map.find(t => t.id === tileId);
        if (!tile || tile.structure) return false; // 빈 타일만
        let before: any = null;
        try { before = FederationPlanner.getBestFederationAction(game, playerId); } catch { return false; }
        if (before) return false; // 이미 연방 가능 → 기존 로직이 처리
        const savedOwner = tile.ownerId, savedStruct = tile.structure;
        tile.ownerId = playerId; tile.structure = 'mine';
        let after: any = null;
        try { after = FederationPlanner.getBestFederationAction(game, playerId); } catch { /* ignore */ }
        tile.ownerId = savedOwner; tile.structure = savedStruct; // 복원
        return !!after;
    }

    /** [fedBridge 묘수] 연방을 완성/근접시키는 브리징 빌드 찾기. 1빌드 완성 우선, 없으면 2빌드(이 빌드+다음1채로 완성).
     *  사람 R3 묘수(2채 지어 7파워 연결→연방)를 정확탐색으로 재현. 성능: !simulation 실턴만, 후보 상위 8개로 제한(O(N^2)). */
    private static findFederationBridge(game: ServerGameState, playerId: string, buildActions: BotAction[]): BotAction | null {
        const mines = buildActions.filter(a => a.type === 'build_mine' && (a.params as any)?.tileId).slice(0, 8);
        // 1빌드 완성
        for (const a of mines) {
            if (this.buildEnablesFederation(game, playerId, (a.params as any).tileId)) return a;
        }
        // 2빌드: tile1 임시건설 후, 다른 후보 tile2가 완성하면 tile1(첫 브리징) 반환
        for (const a of mines) {
            const t1 = game.map.find(t => t.id === (a.params as any).tileId);
            if (!t1 || t1.structure) continue;
            const so = t1.ownerId, ss = t1.structure;
            t1.ownerId = playerId; t1.structure = 'mine';
            let found = false;
            for (const b of mines) {
                if (b === a) continue;
                if (this.buildEnablesFederation(game, playerId, (b.params as any).tileId)) { found = true; break; }
            }
            t1.ownerId = so; t1.structure = ss; // 복원
            if (found) return a;
        }
        return null;
    }

    // ===== [다턴 계획엔진 brick1] persistent 연방완성 플랜 =====
    // 핵심: 봇이 매턴 재결정해 다턴 계획을 commit 못 하는 문제(fedBridge −3.59) 교정.
    // 7파워 만드는 최소 빌드 set을 *게임상태에 저장*하고 여러 턴 그 다음 스텝을 commit → 끝까지 실행.

    /** 7파워 연결 컴포넌트를 만드는 최소 빌드 타일 set(1~2채) 계산. buildEnablesFederation의 set 버전. */
    private static computeFedBuildSet(game: ServerGameState, playerId: string, buildActions: BotAction[]): string[] | null {
        const mines = buildActions.filter(a => a.type === 'build_mine' && (a.params as any)?.tileId).slice(0, 8);
        for (const a of mines) { // 1채로 완성
            if (this.buildEnablesFederation(game, playerId, (a.params as any).tileId)) return [(a.params as any).tileId];
        }
        for (const a of mines) { // 2채로 완성
            const t1 = game.map.find(t => t.id === (a.params as any).tileId);
            if (!t1 || t1.structure) continue;
            const so = t1.ownerId, ss = t1.structure;
            t1.ownerId = playerId; t1.structure = 'mine';
            let pair: string | null = null;
            for (const b of mines) {
                if (b === a) continue;
                if (this.buildEnablesFederation(game, playerId, (b.params as any).tileId)) { pair = (b.params as any).tileId; break; }
            }
            t1.ownerId = so; t1.structure = ss;
            if (pair) return [(a.params as any).tileId, pair];
        }
        return null;
    }

    /** persistent 연방완성 플랜의 다음 스텝(빌드 액션) 반환. 계획을 game에 저장해 여러 턴 commit. */
    private static getMultiTurnFedStep(game: ServerGameState, playerId: string, buildActions: BotAction[]): BotAction | null {
        const store = (game as any)._botFedPlan || ((game as any)._botFedPlan = {});
        const buildable = new Map<string, BotAction>();
        for (const a of buildActions) if (a.type === 'build_mine' && (a.params as any)?.tileId) buildable.set((a.params as any).tileId, a);

        let plan = store[playerId];
        if (plan) {
            // 이미 지어진 타일 제거(진행)
            plan.tiles = plan.tiles.filter((tid: string) => { const t = game.map.find(x => x.id === tid); return t && !t.structure; });
            if (plan.tiles.length === 0) { delete store[playerId]; }          // 완료 → 기존 로직이 연방 형성
            else {
                const next = plan.tiles.find((tid: string) => buildable.has(tid)); // 다음 빌드가능 스텝
                if (next) return buildable.get(next)!;                          // commit
                delete store[playerId];                                          // 다음 스텝 불가(무효) → 재계획
            }
        }
        // 새 계획: 이미 연방 가능하면 불필요(기존 로직 처리)
        if (FederationPlanner.getBestFederationAction(game, playerId)) return null;
        const tiles = this.computeFedBuildSet(game, playerId, buildActions);
        if (tiles && tiles.length > 0) {
            store[playerId] = { tiles: tiles.slice(), round: game.roundNumber };
            return buildable.get(tiles[0]) || null;
        }
        return null;
    }

    /** [flag: qicShipBudget] R1-2 우주선용 QIC 예약량 — 사람은 시작 QIC를 입장·리벨리온 3Q에 아껴 R1부터 우주선
     *  혜택을 받는데, 봇은 가이아 건설(1Q)·점프에 즉시 소진해 우주선이 늦음(사용자 관찰 2026-07-07).
     *  ①미입장 우주선 중 최소 입장 거리 QIC ②이미 리벨리온 탑승 + 3정큐(기술타일) 미사용이면 3. 큰 쪽. */
    private static computeShipQicReserve(game: ServerGameState, playerId: string): number {
        const player = game.players[playerId];
        const entered = player.spaceshipsEntered || [];
        let reserve = 0;
        // ① 미입장 우주선 최소 입장 QIC (사거리 내면 0 — 예약 불필요) — 입장 예약은 R1-2에만 의미
        if ((game.roundNumber ?? 1) <= 2
            && entered.length < 3 && (player.score || 0) >= (player.faction === 'bal_tak' ? 7 : 5)) {
            const myPlanets = game.map.filter(t =>
                (t.ownerId === playerId && t.structure) || (t.spaceStation && (t.spaceStation as any).ownerId === playerId));
            if (myPlanets.length > 0) {
                const baseRange = this.getEffectiveBaseRange(player);
                let minNeed = Infinity;
                for (const tile of game.map) {
                    if (!['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'].includes(tile.type || '')) continue;
                    if (entered.includes(tile.id)) continue;
                    const dist = Math.min(...myPlanets.map(p => getDistance(p, tile)));
                    const need = dist > baseRange ? Math.ceil((dist - baseRange) / 2) : 0;
                    if (need < minNeed) minNeed = need;
                }
                if (minNeed !== Infinity && minNeed <= 2) reserve = minNeed; // 3Q+짜리 원거리 입장까지 예약하진 않음
            }
        }
        // ② 리벨리온 탑승 중 + 3정큐(기술타일 액션) 미사용 → 3Q 적립 보호
        // [flag: twilightQicPlan] 트와일라잇 #1(3Q→연방보상 8~12VP, 라운드 반복)도 동형 3Q 엔진 — 동일 보호
        for (const shipId of entered) {
            const tile = game.map.find(t => t.id === shipId);
            const isEngine = tile?.type === 'ship_rebellion'
                || (tile?.type === 'ship_twilight' && getPlayerFlag(playerId, 'twilightQicPlan', true)
                    && this.twilightTimingOk(game, player)); // [v2] R4+/기술연방 후에만 예약 — 조기 Q동결이 v1 -9.58 원인
            if (!isEngine) continue;
            const used = game.spaceships?.[shipId]?.usedActionIndices || [];
            if (!used.includes(1)) reserve = Math.max(reserve, 3);
        }
        // ③ [flag: rebelAdjacentQicHold] 미탑승이어도 3Q 엔진 배(리벨리온, twilightQicPlan이면 트와일라잇도)가
        // 사거리 내(입장 0Q)면 R1-2엔 3Q 라인 보호. 사용자 관찰(2026-07-11): 발타크가 리벨 인접 시작 +
        // Q4 라인이 있는데 R1에 가이아 건설로 Q를 던져 라인 사망 — 기존 ①은 입장비용(0)만 예약해 구멍.
        if (getPlayerFlag(playerId, 'rebelAdjacentQicHold', true) && (game.roundNumber ?? 1) <= 2 && entered.length < 3) {
            // [v2] 트와는 인접 선보호(R1-2) 제외 — 사용자 룰상 트와 3정큐는 R4+라 조기 보호가 곧 Q동결
            // [flag: rebelReachQicHold] 사용자 관찰(2026-07-12 스페이스자이언트): 리벨 3거리 + '+3사거리'
            // 부스터 보유 = 이번 턴 입장 가능인데, 도달 판정이 부스터를 켜기 전 사거리만 봐서 홀드가 안 걸림
            // → 2Q를 가이아 광산에 유출, 입장 후 2K→1Q 브리지로 완성되던 3정큐 라인 사망.
            // 보너스타일 range_3 미사용분(+3)까지 도달로 간주해 같은 보호를 적용.
            const boosterExtra = (getPlayerFlag(playerId, 'rebelReachQicHold', true)
                && !player.usedBonusAction && !player.rangeBonusActive
                && ALL_BONUS_TILES.find(t => t.id === player.bonusTile)?.specialAction === 'range_3') ? 3 : 0;
            const engines = game.map.filter(t => t.type === 'ship_rebellion');
            const myPl = game.map.filter(t =>
                (t.ownerId === playerId && t.structure) || (t.spaceStation && (t.spaceStation as any).ownerId === playerId));
            for (const eng of engines) {
                if (entered.includes(eng.id) || !myPl.length) continue;
                const d = Math.min(...myPl.map(p => getDistance(p, eng)));
                if (d <= this.getEffectiveBaseRange(player) + boosterExtra) { reserve = Math.max(reserve, 3); break; }
            }
        }
        return reserve;
    }

    /** [flag: r1ExpandValve] 사거리 내 0스텝(무삽) 확장지 존재 여부 — 조기 가드 교집합의 기아 판정용 */
    private static hasZeroStepExpansion(game: ServerGameState, playerId: string): boolean {
        const player = game.players[playerId];
        const myPl = game.map.filter(t => t.ownerId === playerId && t.structure);
        if (!myPl.length) return true;
        const rng = getRange(player.research?.navigation ?? 0) + (player.navigationBonus || 0);
        return game.map.some(t => !t.ownerId && !t.structure && t.type
            && !['space', 'deep_space', 'transdim', 'asteroid', 'gaia'].includes(t.type) && !t.type.startsWith('ship_')
            && getTerraformStepsForFaction(game, player.faction!, t.type) === 0
            && myPl.some(p => getDistance(p, t) <= rng));
    }

    private static findBuildActions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const ore = player.ore ?? 0;
        const credits = player.credits ?? 0;
        const walletQic = this.getSpendableQicForMineBuild(player);
        // [flag: r1ExpandValve] 사용자 실관찰(2026-07-12 HH): R1 광산 0채·5O20C 패스 — 조기가드 교집합
        // (3O삽 차단 + QIC예약 가이아 차단 + 0스텝 부재)이 광산 후보를 전멸시킴. 0스텝 확장지가 없으면 밸브:
        // ①우주선 QIC 예약 해제(확장>우주선 계획) ②아래 삽 가드 1000→400 캡(후보 생존, 선택은 MCTS).
        const expandValve = getPlayerFlag(playerId, 'r1ExpandValve', true)
            && (game.roundNumber ?? 1) <= 2 && !this.hasZeroStepExpansion(game, playerId);
        // [flag: qicShipBudget] R1-2엔 우주선용 QIC 예약분을 빼고 빌드에 지불 가능 — 중앙 게이트라 가이아 1Q·점프 전부 적용
        // [flag: qicReserveAllRounds] 실게임 복기(ofhfvztt HH R5): 변환으로 q3 완성 후 3정큐 누르기 전에 다른
        // 액션이 Q 소모 → 기회 소멸. 원인 = 호출부 R≤2 게이트가 ②(탑승 중 3Q 보호)까지 꺼버림(의도 불일치).
        // 확장: 예약 계산을 전 라운드 호출하되 ①(입장 예약)만 내부에서 R1-2 한정 — 3Q 엔진 보호가 전 라운드 유지.
        const reserveGate = getPlayerFlag(playerId, 'qicReserveAllRounds', true)
            ? true : (game.roundNumber <= 2);
        const qicReserveForShips = (getPlayerFlag(playerId, 'qicShipBudget', true) && reserveGate && !expandValve)
            ? this.computeShipQicReserve(game, playerId) : 0;
        // [flag: hhJitConvert] HH 가상 지갑: 크레딧 즉석 변환분 포함(크레딧 플로어 5 = 광산 2C + 버퍼 3)
        const hhExtraQicForMine = this.hhConvertibleQic(game, playerId, 5);
        const maxPayQicForMine = Math.max(0,
            (player.faction === 'bal_tak' ? walletQic + getEffectiveGaiaformers(player) : walletQic + hhExtraQicForMine) - qicReserveForShips);

        /** 발타크 GF→QIC / HH 4C→1QIC(쓰기 직전) 프리액션 후 (선택) 파워/우주선 프리액션, 마지막에 광산 */
        const buildMineAction = (tileId: string, qicTotalForBalTak: number, ...extraPres: BotAction[]): BotAction => {
            const bal = this.balTakGaiaformerPreActionsForQicShortfall(player, walletQic, qicTotalForBalTak);
            const hh = this.hhConvertPreActionsForQicShortfall(game, playerId, walletQic, qicTotalForBalTak, 5);
            const pres = [...bal, ...hh, ...extraPres];
            return pres.length
                ? { type: 'build_mine', params: { tileId }, preActions: pres }
                : { type: 'build_mine', params: { tileId } };
        };

        const power3 = player.power3 ?? 0;
        const round = game.roundNumber;

        // 광산 상한(8) 도달 시 광산/파워콤보(3P→스텝 후 광산) 후보를 만들지 않음 — 프리액션만 실행되고 build_mine 실패하는 버그 방지
        if (getStructureCount(game, playerId, 'mine') >= BUILDING_LIMITS.mine) {
            const alt = this.findAlternativeBuildAction(game, playerId);
            return alt ? [alt] : [];
        }

        // [flag: asteroidCandOpen] 서버 룰(리프로브 확정 2026-07-13): 소행성 광산 비용 = 포머 1개 + 거리 QIC뿐 —
        // 1O2C를 청구하지 않음(executeBuildMine 소행성 분기). 기존 조기 반환이 자원기아 시 소행성 후보까지 죽여
        // 사람 소행성 건설 34건이 후보에 없던 룰 불일치. 기아여도 소행성 전용 패스는 계속 진행.
        const resStarved = ore < 1 || credits < 2;
        if (resStarved && !getPlayerFlag(playerId, 'asteroidCandOpen', true)) {
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

        const range = this.getEffectiveNavRangeForStandardMine(player);
        const tfLevel = player.research.terraforming ?? 0;
        const pendingSteps = player.pendingTerraformSteps || 0;
        const canResearch = (player.knowledge ?? 0) >= 4;
        const plannedTopTrack = canResearch ? (this.pickResearchTracks(game, player, playerId)[0] ?? null) : null;
        // [flag: navBeforeJump] 기존엔 nav가 '1순위 트랙'일 때만 QIC점프 광산을 억제했음. 그래서 봇이 곧 nav를
        // 올릴 거면서도 nav가 1순위가 아니면 먼저 QIC로 점프해 광산을 흩뿌림(QIC 낭비 + 클러스터 분산).
        // → "이번 턴 nav를 올릴 수 있으면(지식≥4, nav<5)" 억제 대상으로 넓힘. willNavResearchSaveQIC가
        //   'nav 올리면 이 타일 QIC가 실제로 줄어드나'를 검사하므로, 어차피 점프가 필요한 먼 타일은 그대로 허용.
        // [채택 2026-06-13] head2head 50판: 도전자 승률 64.3%(27:15, p=0.064), VP +2.27(무해) → 기본 ON 승격.
        //   사용자 관찰("nav 올릴 거면서 QIC로 점프부터 광산 뿌림")을 직접 교정. flag로 끄면 구(舊) 동작 복원.
        const likelyNavThisTurn = getPlayerFlag(playerId, 'navBeforeJump', true)
            ? (canResearch && (player.research.navigation ?? 0) < 5)
            : (plannedTopTrack === 'navigation');
        // [flag: navBeforeJumpSoon] 지식<4라 '이번 턴'엔 nav를 못 올려도, 다음 수입이면 올릴 수 있고(초반) nav가 낮으면
        //   지금 QIC 점프로 먼 행성을 먹지 말고 미룬다. 사용자 관찰: "2거리인데 점프해서 먹고 그 다음에 nav를 올림"
        //   = 순서 낭비. 다턴 계획이면 'nav 먼저 올리고 다음 턴에 0 QIC로 먹기'. (지식수입 근사 = 1 + 연구소 + 좌아카데미;
        //   bescods/nevlas는 연구소가 지식이 아니라 제외.) willNavResearchSaveQIC가 '정말 QIC가 줄어드나'를 별도 확인.
        const kLab = (player.faction === 'bescods' || player.faction === 'nevlas') ? 0
            : game.map.filter(t => t.ownerId === playerId && t.structure === 'research_lab').length;
        const kAcadLeft = game.map.filter(t => t.ownerId === playerId && t.structure === 'academy' && (t as any).academyType === 'left').length;
        // getRange 티어는 둘씩 묶임(0·1→range1, 2·3→range2, 4·5→range3). nav가 1 또는 3이면 '한 번만 더' 올리면
        //   사거리가 열림 → 지식과 무관하게 QIC 점프 대신 그 한 칸을 기다림(사용자 관찰: Nav1만 올려 +1Q 얻고 2Q 점프,
        //   나중에 Nav2 만듦 = 순서 낭비. Nav0→2 직행이 맞음). nav0은 2칸이라 '다음 수입이면 지식≥4'일 때만 미룸.
        const navLevel = player.research.navigation ?? 0;
        const navOneStepToRange = navLevel === 1 || navLevel === 3;
        const navRaisableSoon = getPlayerFlag(playerId, 'navBeforeJumpSoon', true)
            && !canResearch && navLevel < 5 && (game.roundNumber ?? 1) <= 5
            && (navOneStepToRange || ((player.knowledge ?? 0) + (1 + kLab + kAcadLeft) >= 4));

        // [사용자 전략] 2거리 이상 확보 시 광산 건설 가중치 부여
        const rangeBonusValue = range >= 2 ? 30 : 0;

        // 확장(건물 수) 우대 전략 (하지만 10개 이상이면 무조건 짓기보단 점수/연방 연계를 중시)
        // [사용자 피드백] 단순 광산 확장의 가치를 과도하게 높게 잡아서 파워 액션 등 선점 요소나 업그레이드를 무시하는 문제 수정
        const expansionDesire = myPlanets.length < 10 ? (10 - myPlanets.length) * 10 : 0; // x30 -> x10으로 하향
        const earlyRushBonus = game.roundNumber <= 3 ? 50 : 0; // 150 -> 50으로 하향
        const overExpansionPenalty = myPlanets.length >= 10 ? -80 : 0; // 충분히 컸을 땐 단순 확장은 감점

        // 모든 잠재적 광산 후보 평가
        const candidates = game.map.filter(t =>
            !t.ownerId &&
            t.structure === null &&
            t.type !== 'space' &&
            t.type !== 'deep_space' &&
            t.type !== 'transdim' &&
            // 소행성: 모행성이 asteroid인 종족(틴커로이드/다카니안)만, 그리고 사용 가능한 가이아포머가 있을 때만 후보.
            // 서버 executeBuildMine은 소행성 건설에 항상 포머 1개를 요구·소모하므로, 포머 없이 후보로 내면
            // 건설이 실패하고 game_error가 방 전체에 브로드캐스트된다(사람 화면에 에러 누수).
            (t.type !== 'asteroid' || (!(getPlayerFlag(playerId, 'balTakAsteroidR6Only', true) && player.faction === 'bal_tak' && (game.roundNumber ?? 1) < 6) && (homeType === 'asteroid' || (getPlayerFlag(playerId, 'asteroidAnyFaction', true) && (getPlayerFlag(playerId, 'asteroidEarly', true) || game.roundNumber >= 5 || !game.map.some(t2 => t2.type === 'transdim' && !t2.structure && !t2.hasGaiaformer)))) && getEffectiveGaiaformers(player) >= 1)) &&
            !t.type?.startsWith('ship_') &&
            // 남의 가이아 포머만 올라간 칸 / 아직 건설 타이밍이 아닌 칸은 표준 광산 후보에서 제외 (서버 executeBuildMine과 동일)
            !(t.hasGaiaformer && (t.gaiaformerOwnerId == null || t.gaiaformerOwnerId !== playerId)) &&
            !(t.hasGaiaformer && t.gaiaformerOwnerId === playerId && !player.pendingGaiaformerTiles?.includes(t.id))
        );

        interface ScoredCandidate {
            tile: HexTile;
            score: number;
            action: BotAction;
        }

        const scored: ScoredCandidate[] = [];

        if (player.faction === 'lantids' && !resStarved) { // 기생광산은 표준 비용(1O2C) — 기아 시 제외
            const parasiticTargets = game.map.filter(t =>
                t.ownerId &&
                t.ownerId !== playerId &&
                t.structure !== null &&
                !t.parasiticMine &&
                !t.type?.startsWith('ship_')
            );

            // [flag: lantidsParasiticPI] 사용자 관찰(2026-07-12): 의회 후 기생 0회. 갭 ①의회 +2K(기생당,
            // 서버 지급)가 점수에 미반영 — 고정 260이라 일반 광산(300-350)에 항상 밀림. ②거리 앵커가
            // 기생광산 제외 — 서버(standard build myTiles)는 기생도 앵커로 인정. (기각된 lantidsParasiticPush는
            // '밀집 강제' 각도로 별개 — 이건 서버 룰 미러링 + 실지급 자원의 가치 반영.)
            const parasiticPI = getPlayerFlag(playerId, 'lantidsParasiticPI', true);
            const lantidsPIBuilt = parasiticPI && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
            const parasiticAnchors = parasiticPI
                ? [...myPlanets, ...game.map.filter(t => t.parasiticMine?.ownerId === playerId)]
                : myPlanets;
            for (const tile of parasiticTargets) {
                const dist = Math.min(...parasiticAnchors.map(p => getDistance(p, tile)));
                const neededQicForRange = Math.max(0, Math.ceil((dist - range) / 2));
                if (neededQicForRange > maxPayQicForMine) continue;
                if (neededQicForRange > 1 && round <= 4) continue;

                let score = 260 - neededQicForRange * (round <= 3 ? 220 : 120);
                if (lantidsPIBuilt) score += 100; // 의회 +2K/기생 = 지식엔진 실지급분
                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine', tile);
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += this.calculateFederationScore(game, playerId, tile);
                score += rangeBonusValue;
                // [flag: lantidsParasiticAdj] 사용자 관찰(2026-07-13): PI 이후에도 기생 1.78회/판 — 일반 광산은
                // 인접 보너스(내 건물 +50/이웃, 상대 +20)를 받는데 기생 후보만 이 항목이 빠져 인접 좋은 일반
                // 광산(400+)에 구조적으로 밀림. 기생은 정의상 상대 행성 위(리치 포지션)라 같은 기준 적용이 정합.
                if (getPlayerFlag(playerId, 'lantidsParasiticAdj', false)) {
                    score += this.calculateAdjacencyBonus(game, playerId, tile);
                }

                // [flag: lantidsFedCluster] 진단(2026-07-15): lantids 연방 1.32 vs 상위권 2.45 — 기생 5.1개가
                // 상대 클러스터 따라 흩어져 연방으로 안 묶임(최하위 68.9의 주범). 기각된 Push(상대 밀집 우대)와
                // 반대로 '내 파워 클러스터 근접'(dist≤2 내 자산 수)을 우대 — 연방 묶임 가능한 기생만 가치.
                if (getPlayerFlag(playerId, 'lantidsFedCluster', true)) {
                    const nearbyOwn = game.map.filter(t =>
                        t.id !== tile.id && getDistance(t, tile) <= 2
                        && ((t.ownerId === playerId && t.structure) || t.parasiticMine?.ownerId === playerId)
                    ).length;
                    score += Math.min(120, nearbyOwn * 40) - (nearbyOwn === 0 ? 80 : 0);
                }
                // [flag: lantidsParasiticPush] 상대 밀집 지역(주변 dist≤2에 상대 건물 多)에 기생 우대 →
                // 점프 한 번으로 이후 기생 타깃 다수 확보(사용자 모델: 밀집지역 의회+점프+기생4가 최상 스타트).
                if (getPlayerFlag(playerId, 'lantidsParasiticPush', false)) {
                    const nearbyEnemies = game.map.filter(t =>
                        t.ownerId && t.ownerId !== playerId && t.structure &&
                        t.id !== tile.id && getDistance(t, tile) <= 2
                    ).length;
                    score += Math.min(120, nearbyEnemies * 30);
                }

                scored.push({
                    tile,
                    score,
                    action: buildMineAction(tile.id, neededQicForRange)
                });
            }
        }

        // [flag: chainReachDefer] 사용자 관찰(2026-07-13 엠바스): 4K로 Nav2 올리고 가이아1(0Q)→가이아1 기점으로
        // 가이아2(0Q) 체인이면 2채를 QIC 없이 짓는데, 3거리 가이아2에 2QIC를 선지불. 기존 navBeforeJump 가드는
        // '기존 건물 기준'으로만 절약을 판정해 체인(새 광산=새 앵커)을 못 봄. QIC점프 대상 T에 대해:
        // (지식≥4면 Nav-up 가정한) 사거리로 0Q 건설 가능한 다른 타일 Z가 있고 Z→T가 그 사거리 내면 점프 유보
        // (Z 먼저 → T는 다음에 0Q). 싼 Z만 인정: 가이아(기본QIC 지불가능)/모행성/0스텝.
        const chainDefer = getPlayerFlag(playerId, 'chainReachDefer', true);
        let chainRange = range;
        let chainZeroTiles: HexTile[] = [];
        if (chainDefer) {
            const navLvl = player.research?.navigation ?? 0;
            if ((player.knowledge ?? 0) >= 4 && navLvl < 5
                && !(player.faction === 'bal_tak' && !game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute'))) {
                let nl = navLvl + 1;
                while (nl <= 5 && getRange(nl) <= getRange(navLvl)) nl++;
                if (nl <= 5) chainRange = Math.max(range, getRange(nl) + (player.navigationBonus || 0));
            }
            chainZeroTiles = candidates.filter(t => {
                const d0 = Math.min(...myPlanets.map(p => getDistance(p, t)));
                if (d0 > chainRange) return false;
                if (t.type === homeType) return getTerraformStepsForFaction(game, player.faction!, t.type!) === 0;
                if (t.type === 'gaia') return getGaiaBaseQic(player.faction || '') <= walletQic || player.faction === 'gleens';
                return t.type != null && getTerraformStepsForFaction(game, player.faction!, t.type!) === 0;
            });
        }

        for (const tile of candidates) {
            // [flag: asteroidCandOpen] 자원기아 패스: 1O2C가 안 드는 소행성만 후보화(그 외는 서버가 거부할 후보)
            if (resStarved && tile.type !== 'asteroid') continue;
            const dist = Math.min(...myPlanets.map(p => getDistance(p, tile)));
            const neededQicForRange = Math.max(0, Math.ceil((dist - range) / 2));
            // [flag: chainReachDefer] Z 경유 체인으로 0Q 도달 가능한 QIC점프는 유보
            if (chainDefer && neededQicForRange > 0
                && chainZeroTiles.some(z => z.id !== tile.id && getDistance(z, tile) <= chainRange)) {
                continue;
            }

            let qicPenalty = neededQicForRange * 60; // 사용자 피드백: 거리(QIC) 페널티 2배 상향
            let bridgeheadBonus = 0;

            // [flag: geodensNewType] 기오덴이 PI 보유 시 '아직 안 먹은 행성유형'에 지으면 즉시 +3K + 후반 이클립스2Q 연료(유형 다양성).
            // 빌드 타깃을 미보유 유형으로 유도 → 종족 엔진을 실제 점수로 변환(연구만 올리고 빌드 안 따라오던 문제의 종족판 해결).
            let geodensNewTypeBonus = 0;
            if (player.faction === 'geodens' && tile.type && getPlayerFlag(playerId, 'geodensNewType', true)) {
                const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
                if (hasPI && !getPlayerPlanetTypesForGeodens(game, playerId).has(tile.type)) {
                    geodensNewTypeBonus = 100;
                }
            }

            // [flag: darkaniansNewSector] 다카니안 PI는 '신규 섹터/외각 진출' 건설 시 +1K+2C를 주는데(서버 자동지급),
            //   봇이 이 가치를 평가 안 해 신섹터 진출을 우선 안 함(사용자 관찰: 시그니처 1.0 vs 사람 22.3).
            //   PI 보유 시 '내 건물이 없는 섹터'에 짓는 후보를 우대(+1K~5점 +2C~20점 ≈ 35). geodens 신유형과 같은 패턴.
            let darkaniansSectorBonus = 0;
            if (player.faction === 'darkanians' && getPlayerFlag(playerId, 'darkaniansNewSector', false)) {
                const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
                if (hasPI) {
                    const mySectors = new Set(game.map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship').map(t => t.sector));
                    if (!mySectors.has(tile.sector)) darkaniansSectorBonus = 35;
                }
            }

            if (neededQicForRange > 0) {
                // [사용자 피드백] 장거리(QIC) 확장의 가치를 주변 꿀행성 군집도로 평가하는 교두보(Bridgehead) 확보 전략
                let easyTargetsDist1 = 0;
                let easyTargetsDist2 = 0;

                for (const t of game.map) {
                    if (t.id !== tile.id && !t.structure && !t.ownerId) {
                        const isEasy = (t.type === 'gaia' || t.type === homeType || (t.type && getTerraformStepsForFaction(game, player.faction!, t.type) <= 1));
                        if (isEasy) {
                            const d = getDistance(tile, t);
                            if (d === 1) easyTargetsDist1++;
                            else if (d === 2) easyTargetsDist2++;
                        }
                    }
                }

                // 거점이 매우 훌륭한 경우 (주변 1거리에 1개 이상, 혹은 2거리에 다수 포진)
                const clusterValue = easyTargetsDist1 * 2 + easyTargetsDist2;

                if (clusterValue >= 3) {
                    // 엄청난 꿀단지면 QIC 페널티를 전부 상쇄하고 오히려 보너스를 줌
                    qicPenalty = 0;
                    bridgeheadBonus = 150 + clusterValue * 15;
                } else if (clusterValue >= 1) {
                    // 적당한 교두보면 페널티 완화
                    qicPenalty = Math.max(0, qicPenalty - 50);
                    bridgeheadBonus = 40;
                } else {
                    // 주변에 확장할 곳이 전혀 없는 낭비성 QIC 점프는 극도로 기피
                    if (range > 1) {
                        qicPenalty += 300;
                    } else if (range === 1) {
                        qicPenalty += 80;
                    }
                }

                // [사용자 피드백] 초반(1~3라운드)에 귀한 QIC를 낭비해서 짓는 행위를 억제.
                // 대신 연구소 업그레이드를 통해 항해술(Nav) 기술을 먼저 올린 뒤(0 QIC로) 짓게끔 페널티를 부과.
                if (game.roundNumber <= 3) {
                    // 꿀단지라도 초반에 무리하게 QIC를 쓰기보다 Nav 업그레이드를 기대하게 만들기 위해 거대한 페널티 부과.
                    // 1 QIC 소모당 -300점 (가이아 행성 등 다른 큰 보너스가 붙더라도 2 QIC 이상 점프는 거의 0% 확률로 만듦)
                    qicPenalty += 300 * neededQicForRange;
                }
            }

            // QIC 소모 제한 해제: QIC만 충분하다면 3거리, 4거리(QIC 3~4 소모) 점프도 교두보 가치가 높으면 시도 가능하도록 허용
            // 발타크: 가용 가이아포머만큼 지갑 QIC 이전에 GF→QIC 프리액션으로 보충 가능
            if (neededQicForRange > maxPayQicForMine) continue;

            // 정책: 이번 턴에 Nav를 올릴 가능성이 높다면(지식>=4이고 navigation이 최우선 트랙),
            // Nav 업그레이드로 QIC 소모를 줄일 수 있는 타일에 대해 QIC 점프 광산을 미리 짓지 않게 한다.
            // (즉, "연구 먼저 → 0 QIC로 확장" 플로우 강제)
            if ((likelyNavThisTurn || navRaisableSoon) && neededQicForRange > 0) {
                const probe: BotAction = { type: 'build_mine', params: { tileId: tile.id } };
                if (this.willNavResearchSaveQIC(game, playerId, probe)) {
                    continue;
                }
            }
            // 정책 변경: QIC로 거리 점프는 게임 전체적으로 1~2회가 적정.
            // 따라서 2QIC 이상 점프는 거의 금지(매우 후반 + 진짜 교두보/가이아 같은 예외만 허용).
            const isLate = round >= 6;
            const allowBigQicJump = isLate && (bridgeheadBonus >= 180); // 후반에만, 그리고 교두보가 정말 큰 경우만
            if (neededQicForRange > 1 && !allowBigQicJump) continue;
            // 1QIC 점프도 기본적으로 매우 큰 페널티를 줘서 "Nav 올리고 가자"로 유도
            if (neededQicForRange === 1) {
                qicPenalty += (round <= 4 ? 220 : 160);
            }

            // 새-유형 가점은 allowBigQicJump 게이트(bridgeheadBonus>=180) 판정 이후에 더해 게이트 오염 방지
            bridgeheadBonus += geodensNewTypeBonus + darkaniansSectorBonus;

            if (tile.type === 'gaia') {
                // [수정 #1] 내 가이아포머가 성숙한 타일(pendingGaiaformerTiles)은 이미 포밍 완료 → 추가 QIC/오레 비용 없음.
                // 기존엔 gaiaBaseQic를 그대로 요구해 QIC가 0이면 영영 스킵 → 가이아포머(파워+토큰) 낭비. 강하게 우선 건설.
                const alreadyFormed = player.pendingGaiaformerTiles?.includes(tile.id) ?? false;
                // [flag: missionBankGaia] 다턴뱅킹 3호(가이아미션 갭 1.0): 다음R이 build_gaia 미션이고 이번은 아니면
                // 성숙 포머 빌드를 1R 보류(내 타일이라 뺏길 위험 없음, 광산수입 1R 손실 < 미션 +3-4VP).
                if (alreadyFormed && getPlayerFlag(playerId, 'missionBankGaia', false)) {
                    const r = game.roundNumber ?? 1;
                    const curM = game.roundScoringTiles?.[r - 1]?.triggerType;
                    const nextM = game.roundScoringTiles?.[r]?.triggerType;
                    if (r <= 5 && nextM === 'build_gaia' && curM !== 'build_gaia' && curM !== 'build_mine') continue;
                }
                // 가이아 행성: 기본 비용 추가 (일반 종족 1 QIC, 글린스 1 Ore, 확장 종족 2 QIC 등)
                const isGleens = player.faction === 'gleens';
                const gaiaBaseQic = alreadyFormed ? 0 : getGaiaBaseQic(player.faction || '');
                const totalQicNeeded = (isGleens && !alreadyFormed) ? neededQicForRange : neededQicForRange + gaiaBaseQic;
                // [flag: earlyGaiaQicCap] 사람 실측(2026-07-15, R1-2 가이아 광산): 사람 2QIC+ 7%(포머 경유 70%)
                // vs 봇 44% — 초반 QIC 2개 전소 점프가 전게임 QIC 기아(리벨 3Q·타일·연방)의 상류(기보복기 1호).
                // R1-2엔 총 QIC(기본+거리) 2+ 가이아 직접 건설 후보 미생성 — 포머 경유(0QIC)·1QIC는 그대로.
                // [120판 curse 13호] 40판 +7.55 p=0.020 → 120판 −2.29 회귀(행동은 유지: 2Q+가이아 −0.50).
                // 셀프플레이 메타에선 낭비 점프도 확장가치 > 차단(midTerraformGuard 교훈 계열) — 사람게임 한정
                // (creditCapGuard 동일 프로필: 사람 실측 7% vs 봇 44%가 실게임 신호, QIC 대체 용처는 사람 경쟁 환경에 실재).
                if (getPlayerFlag(playerId, 'earlyGaiaQicCap', true) && (game.roundNumber ?? 1) <= 2
                    && (game.botPlayerIds?.length ?? 0) < Object.keys(game.players).length
                    && !alreadyFormed && totalQicNeeded >= 2) {
                    continue;
                }
                // [flag: qicMineLabGate] 사용자 관찰(2026-07-15): "R1에 1QIC 광산 안 지으면 연구소 지을 수
                // 있는데 계속 그걸 날리고 감" — 실측: R1-2 QIC 가이아 광산 봇 91% vs 사람 48%, 'QIC광산 짓고
                // R2까지 랩 없음' 봇 13% vs 사람 4%. 연구소 라인 미완(랩 0 + TS 보유 = 랩 업글이 다음 수)인
                // 동안 QIC 소모 가이아 직건 후보 제외 — 랩 완성 후엔 해제(사람도 48%는 지음). 포머 경유(0QIC) 무관.
                if (getPlayerFlag(playerId, 'qicMineLabGate', true) && (game.roundNumber ?? 1) <= 2
                    && !alreadyFormed && totalQicNeeded >= 1
                    && !game.map.some(t => t.ownerId === playerId && t.structure === 'research_lab')
                    && game.map.some(t => t.ownerId === playerId && t.structure === 'trading_station')) {
                    continue;
                }

                if (isGleens && !alreadyFormed) {
                    if (ore < 2 || credits < 2) continue; // 1O(mine) + 1O(gaia cost)
                    if (totalQicNeeded > maxPayQicForMine) continue;
                } else {
                    if (totalQicNeeded > maxPayQicForMine) continue;
                    if (totalQicNeeded > 4) continue; // QIC 캡을 2에서 4로 늘려 장거리 가이아 진출 허용
                }

                let score = (neededQicForRange === 0 ? 300 : 250) - qicPenalty + bridgeheadBonus; // 가이아 건설 베이스 점수 대폭 상향
                // [flag: gaiaBaseQicCost] 사용자 관찰(2026-07-13): 봇이 2QIC 가이아 광산을 과애호 — 가이아 기본
                // QIC(일반1/확장종족2)가 지불 검사만 되고 점수에선 0원(사거리 QIC만 페널티). QIC 기회비용
                // (3정큐 재료·연방·트와 재수령, 연구보상 환산 q×18)을 45/개로 차감(28은 미션·교두보 스택에 묻혀 무행동 — 실측). 성숙 포머(alreadyFormed)는
                // base 0이라 자동 면제, 글린은 광석 지불이라 제외. qicPenalty와 분리 — 교두보 0화에 안 쓸림.
                if (getPlayerFlag(playerId, 'gaiaBaseQicCost', false) && !isGleens) score -= gaiaBaseQic * 45;
                if (alreadyFormed) score += 400; // 성숙한 가이아포머는 반드시 건설(투자 낭비 방지) — 최우선 처리
                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine', tile);
                score += this.calculateRoundScoringBonus(game, playerId, 'build_gaia', tile);
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
                    action: buildMineAction(tile.id, totalQicNeeded)
                });
                continue;
            }

            // 모행성 (테라포밍 불필요)
            if (tile.type === homeType) {
                // 일부 확장 종족(예: proto 홈)은 “홈이어도 스텝 비용”이 발생할 수 있음.
                // 따라서 steps가 0일 때만 모행성(무료 테라포밍) 분기를 적용하고,
                // homeSteps>0이면 아래 “타종 행성(테라포밍 필요)” 로직으로 내려가도록 함.
                const homeSteps = getTerraformStepsForFaction(game, player.faction!, tile.type);
                if (homeSteps <= 0) {
                    let score = (neededQicForRange === 0 ? 350 : 300) - qicPenalty + bridgeheadBonus; // 모행성 확장은 최상위 가치
                    // [flag: asteroidAnyFaction] 사용자 관찰: 봇이 포머 파괴 소행성 건설을 절대 안 함 — 필터가 asteroid-홈
                    // 종족만 허용했었음(서버 룰은 포머 1개 소모면 누구나, 사람 48건). 개방 후 여기(0스텝)로 흐르므로
                    // 포머 소모 기회비용: 남은 transdim 있고 초중반이면 크게(포머=미래 가이아), 없거나 후반이면 작게(idle 포머 전환 이득).
                    if (tile.type === 'asteroid' && homeType !== 'asteroid') {
                        const transdimLeft = game.map.some(t2 => t2.type === 'transdim' && !t2.structure && !t2.hasGaiaformer);
                        score -= (transdimLeft && round <= 4) ? 140 : 25;
                    }
                    score += this.calculateRoundScoringBonus(game, playerId, 'build_mine', tile);
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
                        action: buildMineAction(tile.id, neededQicForRange)
                    });
                    continue;
                }
            }

            // [flag: asteroidCandOpen] 비-홈 소행성은 테라 스텝 0이라 아래 continue에 걸려 후보가 영영 안 생김 —
            // asteroidAnyFaction(7/11)이 필터만 열고 점수 분기가 없던 갭(리프로브 실측: 사람 소행성 118건 중
            // 봇 후보 존재 3건뿐의 근본 원인; 3480행 비-홈 페널티는 도달불가 죽은 코드였음). 홈 분기 미러 + 포머 기회비용.
            if (tile.type === 'asteroid' && getPlayerFlag(playerId, 'asteroidCandOpen', true)) {
                let score = (neededQicForRange === 0 ? 330 : 280) - qicPenalty + bridgeheadBonus;
                const transdimLeft = game.map.some(t2 => t2.type === 'transdim' && !t2.structure && !t2.hasGaiaformer);
                score -= (transdimLeft && round <= 4) ? 140 : 25; // 포머 소모 기회비용(미래 가이아 vs idle 전환)
                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine', tile);
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += earlyRushBonus + expansionDesire + overExpansionPenalty;
                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += this.calculateFederationScore(game, playerId, tile);
                score += this.calculateThreatScore(game, playerId, tile);
                score += rangeBonusValue;
                scored.push({ tile, score, action: buildMineAction(tile.id, neededQicForRange) });
                continue;
            }

            // 타종 행성 (테라포밍 필요)
            const steps = getTerraformStepsForFaction(game, player.faction!, tile.type);
            if (steps <= 0) continue;

            // [사용자 전략] 기오덴(Geodens)은 PI가 없으면 새로운 행성 유형(모행성과 가이아 제외)에 테라포밍 및 확장하는 것을 절대 금지
            if (player.faction === 'geodens') {
                const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
                if (!hasPI) {
                    continue; // PI가 없으면 타종 행성은 짓지 않음
                }
            }

            // pendingTerraformSteps로 커버 가능한 경우
            const coveredByPending = Math.min(pendingSteps, steps);
            const remainingSteps = steps - coveredByPending;

            if (remainingSteps === 0) {
                // 이미 pendingSteps로 완전 커버 → 무료 테라포밍
                let score = 250 - (qicPenalty * 0.8) + bridgeheadBonus; // 상향
                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine', tile);
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += earlyRushBonus;
                score += expansionDesire;
                score += overExpansionPenalty;
                score += rangeBonusValue; // 2거리 확보 가점

                scored.push({
                    tile,
                    score,
                    action: buildMineAction(tile.id, neededQicForRange)
                });
                continue;
            }

            // [flag: rangeBuildOnly] 거리보너스(range_3/트왈3거리/글린) 활성 중엔 그 액션의 뒤가 {광산·포머·소행성·우주선} 빌드로
            //   한정돼야 함(사용자 규칙: 셋업액션끼리 못 겹침). 그런데 봇이 range 켜고 3파워1스텝/5파워2스텝(별개 셋업)을 또 시도 →
            //   스텝-콤보 후보를 억제해 range 뒤엔 직접 빌드만 하게. gleens는 nav보너스라 동일.
            const rangeBoostActive = getPlayerFlag(playerId, 'rangeBuildOnly', true)
                && !!(player.rangeBonusActive || player.tempRangeBonus || player.gleensNavBonusActive);
            // [flag: tfBonusCombo] 사용자 관찰(2026-07-12): 1TF 보너스타일을 놀리면서 1QIC(사거리)로 모행성을
            // 지음. 사용자 룰: 어차피 QIC를 던질 거면 모행성 대신 1스텝 행성에 1TF를 써서 지어라 — 부스터는
            // 그 라운드 안 쓰면 증발하고, 모행성은 나중에 언제든 0스텝으로 지을 수 있어 보존이 이득.
            // 원인: 파워액션(3P→1삽)·TF Mars(3C→1삽)는 삽+건설 콤보 후보가 있는데 보너스타일 1TF만 없어서
            // (부스터 켜기와 건설이 별개 후보 = 1-ply 그리디가 연결 못 봄) 공짜 삽이 후보 경쟁에서 빠짐.
            // 티어 설계: 베이스 340 → 같은 QIC 지불이면 TF콤보(340−0.8·페널티)가 모행성(300−페널티)을 이기고,
            // 0QIC 사거리 내에서는 모행성(350)이 근소 우위 유지(안전).
            if (remainingSteps === 1 && !rangeBoostActive && getPlayerFlag(playerId, 'tfBonusCombo', true)
                && !player.usedBonusAction && !player.rangeBonusActive
                && ALL_BONUS_TILES.find(t => t.id === player.bonusTile)?.specialAction === 'terraform_step'
                && this.canCompleteMineOnTileAfterExtraPending(game, playerId, tile.id, 1)) {
                let score = 340 - (qicPenalty * 0.8) + bridgeheadBonus;
                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine', tile);
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += this.calculateFederationScore(game, playerId, tile);
                score += earlyRushBonus + expansionDesire + overExpansionPenalty + rangeBonusValue;
                scored.push({
                    tile,
                    score,
                    action: buildMineAction(tile.id, neededQicForRange, {
                        type: 'use_bonus_action', params: { actionId: 'terraform_step' }
                    })
                });
                continue;
            }
            // 파워 액션 콤보: 3P→1삽 (gain-1-step, cost 3P) — 이어서 이 타일에 광산 가능할 때만
            if (remainingSteps === 1 && !rangeBoostActive) {
                const stepAction = game.powerActions.find(a => a.id === 'gain-1-step' && !a.isUsed);
                if (stepAction && this.canCompleteMineOnTileAfterExtraPending(game, playerId, tile.id, 1)) {
                    if (power3 >= 3) {
                        scored.push({
                            tile,
                            score: 70 - (qicPenalty * 0.8) + bridgeheadBonus,
                            action: buildMineAction(tile.id, neededQicForRange, {
                                type: 'use_power_action',
                                params: { actionId: 'gain-1-step', useBrain: player.faction === 'taklons' }
                            })
                        });
                        continue;
                    } else if (power3 + Math.floor((player.power2 ?? 0) / 2) >= 3) {
                        // [버그수정 2026-07-04] burn 1회 = bowl3 +1뿐 — 기존엔 번 1개만 붙여 실행 시 "Insufficient Power 3"
                        // 277회/일 실패(→강제 pass 턴 낭비). 부족분(3-power3)만큼 번 반복 부착. 타클론은 브레인 회계 특수라 1회 유지.
                        const burns1 = player.faction === 'taklons' ? 1 : Math.max(1, 3 - power3);
                        // [flag: earlyBurnGuard] 사용자 관찰(2026-07-11): R1에 번 3개(토큰 6개 소모)로 1삽을 사는 건
                        // 파워순환 절반을 태우는 확정 손해 — 평가기가 토큰을 ~0으로 쳐서 MCTS가 거름망 없이 고름.
                        // R1-2엔 번 1개(토큰 2개)까지만 허용. [기각 −4.92: 전면 차단은 광산 소멸]
                        // [flag: burnComboLate] 차단 대신 '지연': R1-2 번2+ 콤보를 라운드 초반(내 메인액션 <2)엔
                        // 미생성 — 리치/충전으로 p3가 차면 같은 라운드 후반에 더 적은 번으로 동일 광산 건설(광산 보존,
                        // deferSafeBuild 계열 순서 재배열). 시뮬에선 게임로그 근사라 실결정 기준.
                        const myMainsThisRound = (game.gameLog || []).filter(e =>
                            (e as any).playerId === playerId && ((e as any).round ?? 0) === round
                            && !/Free Actions|Selected|Charged|Bonus/.test((e as any).action || '')).length;
                        const burnDefer1 = getPlayerFlag(playerId, 'burnComboLate', false)
                            && round <= 2 && burns1 >= 2 && myMainsThisRound < 2;
                        if ((getPlayerFlag(playerId, 'earlyBurnGuard', false) && round <= 2 && burns1 >= 2) || burnDefer1
                            // [flag: earlyWasteBan] R1-2 번 3개+ 금지(사용자: 번2는 리벨리온류 보상이면 허용 — rebellionBurnQic는 별도 체인)
                            || (getPlayerFlag(playerId, 'earlyWasteBan', true) && round <= 2 && burns1 >= 3 && player.faction !== 'itars')) {
                            // 콤보 미생성 (일반 경로/다른 후보로; burnComboLate는 라운드 후반 재생성)
                        } else {
                        const burnPres1: BotAction[] = Array.from({ length: burns1 }, () => ({
                            type: 'burn_power' as const,
                            params: { moveBrainToBowl3: player.faction === 'taklons' && player.brainStoneBowl === 2 ? true : undefined }
                        }));
                        scored.push({
                            tile,
                            score: 69 - (qicPenalty * 0.8) + bridgeheadBonus,
                            action: buildMineAction(tile.id, neededQicForRange, ...burnPres1, {
                                type: 'use_power_action',
                                params: { actionId: 'gain-1-step', useBrain: player.faction === 'taklons' }
                            })
                        });
                        continue;
                        }
                    }
                }
            }

            // 파워 액션 콤보: 5P→2삽 (gain-2-steps, cost 5P)
            if (remainingSteps <= 2 && !rangeBoostActive) {
                // 이 타일에 남은 테라가 1스텝뿐이고 3P→1삽으로 갈 수 있으면, 같은 타일에 5P→2삽은 쓰지 않음.
                // (remainingSteps===2 인 2스텝 행성은 여기서 건너뛰지 않음 → gain-2-steps 후보 유지)
                if (remainingSteps === 1) {
                    const gain1 = game.powerActions.find(a => a.id === 'gain-1-step' && !a.isUsed);
                    if (gain1 && this.canCompleteMineOnTileAfterExtraPending(game, playerId, tile.id, 1)) {
                        continue;
                    }
                }
                const stepAction = game.powerActions.find(a => a.id === 'gain-2-steps' && !a.isUsed);
                if (stepAction && this.canCompleteMineOnTileAfterExtraPending(game, playerId, tile.id, 2)) {
                    if (power3 >= 5) {
                        scored.push({
                            tile,
                            score: 60 - (qicPenalty * 0.8) + bridgeheadBonus,
                            action: buildMineAction(tile.id, neededQicForRange, {
                                type: 'use_power_action',
                                params: { actionId: 'gain-2-steps', useBrain: player.faction === 'taklons' }
                            })
                        });
                        continue;
                    } else if (power3 + Math.floor((player.power2 ?? 0) / 2) >= 5) {
                        // [버그수정 2026-07-04] 위 gain-1-step과 동일 — 부족분(5-power3)만큼 번 반복 부착.
                        const burns2 = player.faction === 'taklons' ? 1 : Math.max(1, 5 - power3);
                        // [flag: earlyBurnGuard] R1-2 번 2+개 콤보 차단 / [flag: burnComboLate] 라운드 초반 지연 (위와 동일)
                        const myMains2 = (game.gameLog || []).filter(e =>
                            (e as any).playerId === playerId && ((e as any).round ?? 0) === round
                            && !/Free Actions|Selected|Charged|Bonus/.test((e as any).action || '')).length;
                        const burnDefer2 = getPlayerFlag(playerId, 'burnComboLate', false)
                            && round <= 2 && burns2 >= 2 && myMains2 < 2;
                        if ((getPlayerFlag(playerId, 'earlyBurnGuard', false) && round <= 2 && burns2 >= 2) || burnDefer2
                            // [flag: earlyWasteBan] R1-2 번 3개+ 금지 (위 gain-1-step과 동일)
                            || (getPlayerFlag(playerId, 'earlyWasteBan', true) && round <= 2 && burns2 >= 3 && player.faction !== 'itars')) {
                            // 콤보 미생성
                        } else {
                        const burnPres2: BotAction[] = Array.from({ length: burns2 }, () => ({
                            type: 'burn_power' as const,
                            params: { moveBrainToBowl3: player.faction === 'taklons' && player.brainStoneBowl === 2 ? true : undefined }
                        }));
                        scored.push({
                            tile,
                            score: 59 - (qicPenalty * 0.8) + bridgeheadBonus,
                            action: buildMineAction(tile.id, neededQicForRange, ...burnPres2, {
                                type: 'use_power_action',
                                params: { actionId: 'gain-2-steps', useBrain: player.faction === 'taklons' }
                            })
                        });
                        continue;
                        }
                    }
                }
            }

            // TF Mars 우주선 3번 액션: 3C→1삽 — 이 타일에 이어서 광산 가능할 때만
            if (remainingSteps === 1 && credits >= (2 + 3)) { // 2C(mine) + 3C(TF Mars)
                const tfMarsShip = this.findPlayerShip(game, playerId, 'ship_tf_mars');
                if (tfMarsShip) {
                    const shipState = game.spaceships?.[tfMarsShip.id];
                    const usedActions = shipState?.usedActionIndices ?? [];
                    if (!usedActions.includes(3) && this.canCompleteMineOnTileAfterExtraPending(game, playerId, tile.id, 1)) {
                        scored.push({
                            tile,
                            score: 65 - (qicPenalty * 0.8) + bridgeheadBonus,
                            action: buildMineAction(tile.id, neededQicForRange, {
                                type: 'use_ship_action',
                                params: { shipTileId: tfMarsShip.id, actionIndex: 3 }
                            })
                        });
                        continue;
                    }
                }
            }

            // Ore로 직접 테라포밍 (비효율적이므로 낮은 점수이나 확장을 위해 감수)
            const costPerStep = getTerraformCost(tfLevel || 0);
            const terraformCost = remainingSteps * costPerStep;
            const totalOre = 1 + terraformCost;

            // 정책: 오레 테라포밍 확장 허용 (Gaia의 기본 확장 수단). 단 비효율 케이스는 아래 페널티로 강하게 억제.
            //  - TF레벨0~1(3광물/스텝): 거의 금지에 가까운 큰 페널티. 단 1스텝이고 오레 여유(>=6) 또는 다카니안이면 허용.
            //  - TF레벨2+(1~2광물/스텝): 약한 페널티로 적극 확장 허용.
            // (예전엔 무조건 continue로 전면 금지했으나, 그 결과 봇이 사거리 내 행성 소진 후 확장이 정체되어
            //  자원을 쥔 채 패스하는 치명적 약점이 있었음 → 재활성화)
            if (ore >= totalOre && credits >= 2) {
                // 확장 가치를 매우 높게 쳐주므로, 광석을 소모해서라도 짓도록 유도
                const tfScore = tfLevel >= 3 ? 150 : (tfLevel >= 2 ? 100 : (tfLevel >= 1 ? 80 : 30));

                // [사용자 피드백] 생 광물을 너무 많이 써서 건설하는 것을 막음
                let stepPenalty = 0;
                if (costPerStep >= 3) {
                    // [버그 수정] 다카니안이거나 광물이 6개 이상 남아돈다면 예외 (1단계 테라포밍만 허용)
                    if (remainingSteps === 1 && (player.faction === 'darkanians' || ore >= 6)) {
                        // [사용자 관찰 2026-06-14, 재확인 2026-06-18] 강한 사람은 R1(~R2)에 3오레 1스텝 테라포밍을 절대 안 함
                        // (사람 R1 광산 31건 중 3오레=0건). 연구(TF/Nav)·0스텝 확장·업글이 우선.
                        // 기존 페널티 260은 너무 약해 proto(+90)/연방(+110)/라운드미션 보너스가 쌓이면 넘겨서 봇이 강행했음
                        // → R1~2엔 차단 수준(1000, ore<6 경로와 동일)으로 올려 오레가 남아돌아도 안 하게.
                        // (후반 R3+는 사거리 소진 후 정체 방지용 저페널티 유지 = ore-terraform 재활성화 본래 목적, 회귀 X)
                        const earlyGuard = getPlayerFlag(playerId, 'earlyTerraformGuard', true) && round <= 2 && player.faction !== 'darkanians';
                        // [flag: midTerraformGuard] 사용자 관찰: 막라도 아닌데(특히 R4) 원삽 원시행성에 3O 써서 짓는 건 손해 —
                        //   그 광산이 컴파운드할 라운드가 적어 3오레 투자 대비 이득이 작음(안 짓는 게 나음). R3~4에도 차단 수준 페널티로
                        //   확장>업글/연구/저비용확장을 우선. (R5+는 종료 임박이라 유지 — 정체방지 목적.)
                        const midGuard = getPlayerFlag(playerId, 'midTerraformGuard', false) && round >= 3 && round <= 4 && player.faction !== 'darkanians';
                        // [flag: r1ExpandValve] 0스텝 확장지 전무(기아)면 차단 1000→400 캡(후보 생존, −50 게이트 통과)
                        stepPenalty = (earlyGuard || midGuard) ? (expandValve ? 400 : 1000) : 50;
                    } else {
                        // 3광물이면 약 -1000점, 6광물이면 약 -2000점 수준의 강력한 페널티 적용
                        stepPenalty = (terraformCost / 3) * 1000;
                        // [flag: tfCandidateOpen] per-candidate 데이터: 사거리내 normal 미싱 90건의 70%가 테라폼 타일,
                        // 그중 36건은 광석 충분한데 페널티 1000-3000이 -50 게이트에 걸려 *후보 자체가 안 생김* = 사실상 하드필터.
                        // 사람은 R3+에 미션/타입/연방 가치로 이걸 지음. R3+는 페널티를 게이트 통과 수준(≤400)으로 캡해
                        // MCTS가 보너스와 트레이드오프 평가하게 함. R1-2는 기존 차단 유지(사람도 0건, 데이터 검증됨).
                        if (getPlayerFlag(playerId, 'tfCandidateOpen', true) && round >= 3) {
                            stepPenalty = Math.min(stepPenalty, 400);
                        }
                    }
                } else {
                    stepPenalty = remainingSteps * 20; // 1~2광석으로 저렴해진 경우엔 약하게 페널티
                }

                // [사용자 관찰 2026-06-18] 크레딧 과잉+오레 부족(예: 30C/4O, QIC 안 씀)인데 희소한 오레로 직접 삽질하면 손해.
                // 크레딧/파워 삽(TF Mars 3C→1삽, 파워 3P→1삽)이나 더 싼 확장이 있으면 그쪽이 오레를 아껴 더 좋음.
                // 이 상태에선 오레직접삽을 강억제해 오레를 보존(파워액션으로 오레 수급 + 크레딧삽 우선).
                if (getPlayerFlag(playerId, 'oreCreditBalance', true) && credits >= 15 && credits >= ore * 4) {
                    stepPenalty += 200;
                }

                let score = tfScore - stepPenalty - (qicPenalty * 0.6) + bridgeheadBonus;

                score += this.calculateRoundScoringBonus(game, playerId, 'build_mine', tile);
                score += this.calculateFinalMissionBonus(game, playerId, tile);
                score += this.calculateAdjacencyBonus(game, playerId, tile);
                score += this.calculateFederationScore(game, playerId, tile);

                // 비용이 너무 비싼 테라포밍(광석 3개 이상 소모)의 경우 무분별한 확장 보너스를 아예 빼버림
                if (terraformCost < 3 || costPerStep < 3) {
                    score += earlyRushBonus;
                    score += expansionDesire;
                } else {
                    // 그래도 혹시나 확장에 엄청난 가치가 있을 수 있으니 약간만 부여 (기존의 20% 수준)
                    score += (earlyRushBonus * 0.2);
                    score += (expansionDesire * 0.2);
                }

                score += overExpansionPenalty;

                if (score >= -50) { // 약간 효율이 떨어져도 무조건 짓게 유도
                    scored.push({
                        tile,
                        score,
                        action: buildMineAction(tile.id, neededQicForRange)
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

        // [flag: noBuildAdjFed] 사용자: 이미 닫힌 연방에 '딱 붙여' 새로 짓는 것도 아까움 — 연방은 형성 시 1회 점수라
        //   거기 건물을 보태도 이득 없고, 그 건물로 새 연방을 못 씀. 다른 곳(연방 비인접) 건설이 가능하면 그쪽으로.
        //   noInflateFed는 군집보너스만 0으로 깎아 MCTS가 무시 → 후보 필터로 '연방 인접' 후보를 제거(비인접 대안 있을 때만=결정적).
        // [flag: firaksMineHold] 사람 파이락 실측(2026-07-14, 7석): R1 광산 0.29/석(6/7이 0개) — 자금을 전부
        // TS(1.3/석)→랩(0.57)→PI(0.86)에 몰빵이 성공 공식(186-220점). 봇은 R1-2 광산 3.29/석 = 3O6C 누수로
        // PI 자금 병목(firaksEngineRush 기각에서 규명). 사용자 처방 "광산 건설을 적당히" — PI 전 R≤2 광산 후보
        // 일괄 감점(금지 아님: 미션/군집 초대박이면 MCTS가 여전히 선택 가능). 경제연구 강제는 사람 신호 약해(1/7) 보류.
        if (getPlayerFlag(playerId, 'firaksMineHold', true) && player.faction === 'firaks'
            && (game.roundNumber ?? 1) <= 2
            && !game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) {
            for (const s of scored) s.score -= 260;
        }

        if (getPlayerFlag(playerId, 'noBuildAdjFed', true)) {
            const fedHexes: string[] = (game as any).playerFederationHexes?.[playerId] || [];
            if (fedHexes.length > 0) {
                // '연방에 이미 포함된 칸'(dist 0) 자체도 인접과 동급으로 처리 (사용자 관찰 2026-07-14: 다카니안이 연방 내부에 막 지음)
                const inFed = (t: HexTile) => fedHexes.includes(t.id);
                const adjToFed = (t: HexTile) => inFed(t) || game.map.some(n => fedHexes.includes(n.id) && getDistance(n, t) === 1);
                const nonAdj = scored.filter(s => (s as any).tile && !adjToFed((s as any).tile));
                if (nonAdj.length > 0) { scored.length = 0; scored.push(...nonAdj); } // 비인접 대안 있으면 연방인접 후보 제거
                // [flag: fedAbsorbBuildPenalty] 비인접 대안이 없으면 위 필터가 무력 → 다카니안이 PI 트리거(+1K+2C,
                // 서버 자동지급이라 MCTS 시뮬이 좋게 봄) 노리고 연방 안/인접에 막 지음(사용자 관찰). 업글엔
                // fedPenalty 450이 있는데 건설엔 상응 감점이 없던 비대칭 교정 — 흡수 건설을 금지하진 않되
                // 연구/파워액션 등과의 경쟁에서 후순위로. R6은 해제(미래 연방 재료 개념 소멸, lastRoundFedFree 동일).
                else if (getPlayerFlag(playerId, 'fedAbsorbBuildPenalty', true)
                    && !(getPlayerFlag(playerId, 'lastRoundFedFree', true) && (game.roundNumber ?? 1) >= 6)) {
                    for (const s of scored) {
                        const t = (s as any).tile;
                        if (t && adjToFed(t)) s.score -= inFed(t) ? 300 : 150;
                    }
                }
            }
        }

        scored.sort((a, b) => b.score - a.score);

        // 상위 후보 반환
        const results: BotAction[] = [];
        const seenActions = new Set<string>();

        for (const s of scored.slice(0, 8)) { // 더 다양한 광산 후보를 고려하도록 상향 (5->8)
            const act = s.action;
            const key = JSON.stringify(act);
            if (!seenActions.has(key)) {
                seenActions.add(key);
                results.push(act);
                if (results.length >= 4) break; // 3->4개로 상향
            }
        }

        // [flag: asteroidCandOpen] 소행성 예약 슬롯: 리프로브 실측(사람 소행성 갭 118건 중 56건 = 탑4 컷에 밀림).
        // 탑4에 소행성이 없으면 최고점 소행성 1개를 추가(순수 후보 개방 — 선택은 MCTS, r1PiOpen 계열).
        if (getPlayerFlag(playerId, 'asteroidCandOpen', true)
            && !results.some(a => game.map.find(t => t.id === (a.params as any)?.tileId)?.type === 'asteroid')) {
            const bestAst = scored.find(s => (s as any).tile?.type === 'asteroid');
            if (bestAst) {
                const key = JSON.stringify(bestAst.action);
                if (!seenActions.has(key)) { seenActions.add(key); results.push(bestAst.action); }
            }
        }

        // [flag: asteroidCandOpen] 자원기아 패스였다면 기존 동작(Eclipse 6C/파워콤보 대안)도 병합
        if (resStarved) {
            const alt = this.findAlternativeBuildAction(game, playerId);
            if (alt) { const key = JSON.stringify(alt); if (!seenActions.has(key)) results.push(alt); }
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
        if (player.faction === 'bal_tak') return []; // 발타크는 가이아 프로젝트 불가

        const availableGaiaformers = Math.max(0, player.gaiaformers || 0);
        if (availableGaiaformers <= 0) return [];

        const gaiaLevel = player.research.gaiaProject || 0;
        let powerRequired = 999;
        if (gaiaLevel >= 1 && gaiaLevel < 3) powerRequired = 6;
        else if (gaiaLevel >= 3 && gaiaLevel < 4) powerRequired = 4;
        else if (gaiaLevel >= 4) powerRequired = 3;

        const totalPower = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);

        // TF Mars 액션/보너스 타일로 인한 즉포 상황인 경우는 파워 소모가 없음
        const isFreeProject = game.pendingTFMarsGaiaProject?.playerId === playerId;

        // [실게임 블런더 수정 2026-06-13] R6(최종 라운드)에 새 가이아포머를 놓으면 다음 라운드 시작에 성숙해야
        // gaia로 바뀌는데(gameState round-transition maturation), 다음 라운드가 없어 절대 성숙 못 함 →
        // 파워(6/4/3) + 메인액션을 통째로 낭비 + fm_gaia_planets +0. (itars 봇 30점 실게임에서 관측)
        // free project(TF Mars 2P/보너스 즉시 가이아)는 같은 턴에 해소되므로 예외. flag로 끄면 구동작.
        const finalRound = (game.roundNumber ?? 1) >= 6;
        if (finalRound && !isFreeProject && getPlayerFlag(playerId, 'gfFinalRoundGuard', true)) return [];

        // [flag: noR1Gaiaformer] 사용자 관찰(2026-07-09): 봇이 R1에 가이아포머를 놓고(성숙은 R2) 조기 커밋 —
        //   사람 R1은 인프라(TS·내비)이고 가이아포밍은 R2+. R1 포밍은 파워6+포머+사거리/QIC를 너무 일찍 묶음.
        //   R1엔 포머 배치 후보를 안 냄(포머는 R2+에 씀). free project(TF Mars 2P·보너스 즉시)는 예외(같은 턴 해소).
        if ((game.roundNumber ?? 1) <= 1 && !isFreeProject && getPlayerFlag(playerId, 'noR1Gaiaformer', true)) return [];

        if (!isFreeProject && totalPower < powerRequired) return [];

        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        if (myPlanets.length === 0) return [];

        // TF Mars 2P·보너스 즉시 포밍 등 "무료 가이아 프로젝트" 연계는 이클립스와 같이 임시 네비 미적용
        const range = isFreeProject
            ? this.getStrictTerraformChainNavRange(player)
            : this.getEffectiveNavRangeForStandardMine(player);
        const qic = player.qic || 0;

        const candidates = game.map.filter(t => t.type === 'transdim' && !t.structure && !t.hasGaiaformer);

        const actions: { score: number, action: BotAction }[] = [];

        for (const tile of candidates) {
            const dist = Math.min(...myPlanets.map(p => getDistance(p, tile)));
            const neededQic = dist > range ? Math.ceil((dist - range) / 2) : 0;

            if (neededQic <= qic && neededQic <= 2) {
                // [사용자 피드백] 가이아포머가 있는데 포밍을 안 하고 패스하는 현상 방지를 위해 포밍 점수를 극한으로 상향
                let score = 350 - neededQic * 40;
                if (isFreeProject) score += 200;

                // [flag: gaiaformPreSpend] 포머 비용을 bowl1+2로 못 채우는 부족분(deficit)만큼 bowl3 토큰을 미리
                // 프리액션(1P→1C)으로 소비 → 비용은 bowl1/2에서 충당, bowl3를 가이아영역에 처박는 대신 크레딧으로 회수.
                // (사용자 관찰: 0/5/3·비용6 → bowl3 1개가 영역으로 낭비됐는데, deficit=1만 변환해 +1크레딧 + bowl3 2개 보존).
                // deficit만큼만(전부 X → bowl2 강등 손해). free project/타클론(브레인스톤 특수)은 제외.
                let preActions: BotAction[] | undefined;
                if (getPlayerFlag(playerId, 'gaiaformPreSpend', false) && !isFreeProject && player.faction !== 'taklons') {
                    const p1 = player.power1 || 0, p2 = player.power2 || 0, p3 = player.power3 || 0;
                    const deficit = powerRequired - (p1 + p2);
                    if (deficit > 0 && p3 >= deficit) {
                        preActions = Array.from({ length: deficit }, () => ({ type: 'convert_resource' as const, params: { type: '1power-to-1credit' } }));
                    }
                }
                // [flag: bowl3CashoutOre] 사용자 룰 v2: 포밍이 소모할 bowl3 deficit을 ore우선(3P→1O)+캡가드로 회수.
                // (구 gaiaformPreSpend −5.24의 원인=크레딧-only·캡무시 — 교정판. 캡으로 변환 불가면 빈 배열=그냥 소모.)
                if (!preActions && getPlayerFlag(playerId, 'bowl3CashoutOre', true) && !isFreeProject) {
                    const cash = this.doomedBowl3CashoutPreActions(player, powerRequired, playerId);
                    if (cash.length) preActions = cash;
                }

                actions.push({
                    score,
                    action: preActions
                        ? { type: 'place_gaiaformer', params: { tileId: tile.id, qicUsed: neededQic }, preActions }
                        : { type: 'place_gaiaformer', params: { tileId: tile.id, qicUsed: neededQic } }
                });
            }
        }

        actions.sort((a, b) => b.score - a.score);
        return actions.slice(0, 4).map(a => a.action); // 상위 4개로 확장
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
                    if (peekEclipseAsteroidMineTileIds(game, playerId).length > 0) {
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
    /**
     * pendingTerraformSteps가 있을 때 광산 건설할 후보 타일들 찾기 (복수 반환)
     */
    private static findBuildActionsWithPendingSteps(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        if (getStructureCount(game, playerId, 'mine') >= BUILDING_LIMITS.mine) return [];

        const walletQic = this.getSpendableQicForMineBuild(player);
        const maxPayQicForMine =
            player.faction === 'bal_tak' ? walletQic + getEffectiveGaiaformers(player) : walletQic;

        const isFree = !!player.nextMineFreeFromShipTech || !!player.spaceshipFed3TfMineFree;

        // 무료 광산이 아니면 1o 2c가 필수. 무료면 자원 불필요.
        if (!isFree && ((player.ore ?? 0) < 1 || (player.credits ?? 0) < 2)) return [];
        if (!player.faction) return [];

        const faction = FACTIONS.find(f => f.id === player.faction);
        if (!faction?.homePlanet) return [];
        const homeType = faction.homePlanet;

        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        if (myPlanets.length === 0) return [];

        const range = this.getStrictTerraformChainNavRange(player);
        const pendingSteps = player.pendingTerraformSteps || 0;

        // pendingSteps로 커버 가능한 행성 중 최적 선택
        const candidates = game.map.filter(t =>
            !t.ownerId && t.structure === null &&
            t.type !== 'space' && t.type !== 'deep_space' &&
            t.type !== 'transdim' &&
            // 소행성은 포머가 있어야만 건설 가능(서버가 항상 포머 1개 요구·소모). 모행성이 asteroid라도 동일.
            (t.type !== 'asteroid' || (!(getPlayerFlag(playerId, 'balTakAsteroidR6Only', true) && player.faction === 'bal_tak' && (game.roundNumber ?? 1) < 6) && (homeType === 'asteroid' || isFree || (getPlayerFlag(playerId, 'asteroidAnyFaction', true) && (getPlayerFlag(playerId, 'asteroidEarly', true) || game.roundNumber >= 5 || !game.map.some(t2 => t2.type === 'transdim' && !t2.structure && !t2.hasGaiaformer)))) && getEffectiveGaiaformers(player) > 0)) &&
            !t.type?.startsWith('ship_') &&
            !(t.hasGaiaformer && (t.gaiaformerOwnerId == null || t.gaiaformerOwnerId !== playerId)) &&
            !(t.hasGaiaformer && t.gaiaformerOwnerId === playerId && !player.pendingGaiaformerTiles?.includes(t.id))
        );

        const scored: { action: BotAction, score: number, nq?: number, cov?: number }[] = [];

        for (const tile of candidates) {
            const dist = Math.min(...myPlanets.map(p => getDistance(p, tile)));
            const neededQic = Math.max(0, Math.ceil((dist - range) / 2));
            if (neededQic > maxPayQicForMine) continue;

            if (tile.type === 'gaia') {
                if (!isFree) continue;
                const gaiaBaseQic = player.faction === 'gleens' ? 0 : getGaiaBaseQic(player.faction || '');
                const gaiaOre = player.faction === 'gleens' ? 1 : 0;
                if (neededQic + gaiaBaseQic > maxPayQicForMine) continue;
                if ((player.ore ?? 0) < gaiaOre) continue;
                scored.push({
                    action: { type: 'build_mine', params: { tileId: tile.id } },
                    score: 120 - (neededQic * 20) + this.calculateRoundScoringBonus(game, playerId, 'build_gaia') + this.calculateFinalMissionBonus(game, playerId, tile),
                    nq: neededQic, cov: -1 // 가이아 무료광산은 삽커버 필터에서 제외(고가치)
                });
                continue;
            }

            if (tile.type === 'asteroid') {
                // [사용자 규칙 2026-07-10] 포머로 짓는 정상 소행성 콜로니는 유지(정당한 확장: 포머 1개 소모 + 1O2C + 거리QIC).
                //   단 2삽/무료광산(isFree=nextMineFreeFromShipTech/spaceshipFed3TfMineFree)은 소행성에 쓰지 않는다 —
                //   무료 테라포밍은 소행성에 무의미(소행성은 테라 대신 포머 소모)라 무료광산·포머 이중낭비("절대 안 할 짓").
                //   → isFree면 스킵, non-free + 포머 보유일 때만 후보(자원은 함수 진입부 3420에서 1O2C 확인됨).
                // [사용자 규칙 확장 2026-07-12] 같은 낭비가 pendingSteps 경로로도 재발: 1TF 보너스타일·TF Mars 3C·
                //   1TF 파워액션으로 삽을 든 상태의 강제 건설에서 소행성을 고르면 삽 전부 증발 + 포머 파괴.
                //   삽 대기 중(pendingSteps>0)에도 소행성 제외 — 소행성 콜로니는 삽 없는 일반 경로에서만.
                if (isFree || pendingSteps > 0 || getEffectiveGaiaformers(player) <= 0) continue;
                scored.push({
                    action: { type: 'build_mine', params: { tileId: tile.id } },
                    score: 105 - (dist * 10) + this.calculateFinalMissionBonus(game, playerId, tile),
                    nq: neededQic, cov: -1 // 포머 소행성도 삽커버 필터 제외
                });
                continue;
            }
            
            const steps = getTerraformStepsForFaction(game, player.faction!, tile.type);

            // [사용자 전략] 기오덴(Geodens)은 PI가 없으면 “테라포밍이 필요한” 새로운 행성 유형은 확장 불가
            if (player.faction === 'geodens' && steps > 0) {
                const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
                if (!hasPI) continue;
            }

            // 서버 executeBuildMine과 동일하게:
            // - pendingTerraformSteps로 steps 일부를 "할인"하고
            // - 남은 actualSteps는 자원(ore)으로 지불해 타일을 건설할 수 있음
            const coveredByPending = Math.min(pendingSteps, steps);
            const actualSteps = Math.max(0, steps - coveredByPending);

            // 무료 광산 여부에 따른 기본 광산 비용(1O/2C)
            const standardMineOre = isFree ? 0 : 1;
            const standardMineCredits = isFree ? 0 : 2;

            // pendingTF로 할인 후 남은 테라포밍 스텝 비용
            // 서버에서는 spaceshipFed3TfMineFree만 테라포밍 비용도 0 처리
            const terraformCost = player.spaceshipFed3TfMineFree
                ? 0
                : actualSteps * getTerraformCost(player.research.terraforming);

            // 초반에는 "2삽 액션 + 남은 1삽을 광석으로 지불" 같은 우회가 엔진을 망가뜨린다.
            // 1~3라운드에는 pending step으로 전부 커버되는 행성만 후속 광산 후보로 둔다.
            if (game.roundNumber <= 3 && actualSteps > 0 && !player.spaceshipFed3TfMineFree) continue;

            const oreNeeded = terraformCost + standardMineOre;
            const creditsNeeded = standardMineCredits;

            if ((player.ore ?? 0) < oreNeeded) continue;
            if ((player.credits ?? 0) < creditsNeeded) continue;

            // 점수: pending으로 커버되는 실제값(steps)을 줄이고(=자원 덜 들고),
            // 커버량이 클수록, 그리고 거리가 가까울수록 선호
            // [개선] 사용자 피드백 반영: 거리 2배 상향(15로 대폭), 2라부터 6Ore로 마구 테라포밍하여 자원 낭비하는 현상 억제 (실제 스텝당 -200 페널티 부여)
            let penaltyPerStep = (game.roundNumber <= 3) ? 350 : (game.roundNumber === 4 ? 200 : 80);
            if (player.faction === 'darkanians') penaltyPerStep = 60; // 다카니안은 예외
            
            let score = (
                (coveredByPending > 0 ? 150 + coveredByPending * 40 : 40)
                - actualSteps * penaltyPerStep
                - (dist * 15) // 거리 페널티 대폭 증가
            );
            // [flag: pendingStepsQicPenalty 기본 ON] 펜딩 테라폼스텝 빌드 경로에도 QIC 점프 페널티 적용.
            // findBuildActions엔 강한 QIC 억제가 있는데 이 경로엔 없어서, 테라폼 보너스/삽 액션 쓸 때
            // 사거리 밖 타일에 1QIC 던져 짓던 낭비(사용자 관찰: "Nav 1만 올리고 2거리에 QIC 던져 지음").
            // 페널티는 후보 순서만 바꿈 → 인레인지(0QIC) 타일 있으면 그걸, 없으면 최소QIC 타일 선택(빌드 자체는 안 막음).
            if (getPlayerFlag(playerId, 'pendingStepsQicPenalty', true) && neededQic > 0) {
                score -= neededQic * (game.roundNumber <= 4 ? 220 : 120);
            }

            score += this.calculateRoundScoringBonus(game, playerId, 'build_mine', tile);
            score += this.calculateFinalMissionBonus(game, playerId, tile);

            const balPres = this.balTakGaiaformerPreActionsForQicShortfall(player, walletQic, neededQic);
            scored.push({
                action:
                    balPres.length > 0
                        ? { type: 'build_mine', params: { tileId: tile.id }, preActions: balPres }
                        : { type: 'build_mine', params: { tileId: tile.id } },
                score,
                nq: neededQic, cov: coveredByPending // 삽커버 필터용(투삽=cov2 > 원삽=cov1)
            });
        }

        // [버그수정] 삽(pendingTerraformSteps)이 로드된 상태에서 '삽을 실제 쓰는' 비-home 행성 빌드가 있으면,
        // home행성(0삽) 빌드를 후보에서 제외한다. 후보점수는 삽쓰기(190)>home(40)로 맞지만 MCTS 최종선택은
        // 평가기가 하고 평가기엔 '삽 낭비' 페널티가 없어, 테라포밍 ore가 안 드는 *싼* home 빌드를 골라 삽을
        // 버리던 문제(사용자 반복관찰: "보너스 1삽 쓰고 모행성에 그냥 지음"). gaia/소행성 무료광산은 유지.
        if (pendingSteps > 0) {
            const tileOf = (a: BotAction) => game.map.find(x => x.id === a.params?.tileId);
            const hasStepUsing = scored.some(s => {
                const t = tileOf(s.action);
                return !!t?.type && t.type !== homeType && getTerraformStepsForFaction(game, player.faction!, t.type) > 0;
            });
            if (hasStepUsing) {
                const kept = scored.filter(s => tileOf(s.action)?.type !== homeType);
                if (kept.length > 0) { scored.length = 0; scored.push(...kept); }
            }
        }

        // [flag: pendingStepsPreferFull] 사용자 규칙: QIC 소모 0(사거리 내) 후보 중에선 펜딩삽을 더 많이 쓰는(투삽) 타일을 우선.
        //   공짜빌드는 남은 삽이 버려져(clearFreeMineFlags reset) 원삽에 지으면 낭비인데, 후보점수만으론 MCTS가 가까운 원삽을
        //   골라(candidate-score≠eval). → 사거리 내 저커버(원삽) 후보를 '제거'해 MCTS가 투삽을 고르게 강제. (관찰: Nav2에 2거리
        //   투삽 냅두고 1거리 원삽에 지음.) 사거리 밖(QIC 필요)·가이아/소행성(cov=-1)은 제외 → QIC 낭비 유발 안 함.
        if (getPlayerFlag(playerId, 'pendingStepsPreferFull', true)) {
            const inRange = scored.filter(s => s.nq === 0 && (s.cov ?? -1) >= 0);
            const maxCov = inRange.length > 0 ? Math.max(...inRange.map(s => s.cov ?? 0)) : 0;
            if (maxCov > 0) {
                for (let i = scored.length - 1; i >= 0; i--) {
                    const s = scored[i];
                    if (s.nq === 0 && (s.cov ?? -1) >= 0 && (s.cov ?? 0) < maxCov) scored.splice(i, 1);
                }
            }
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 5).map(s => s.action);
    }

    /**
     * Eclipse 소행성 광산 타겟 선택 (pendingEclipseAsteroidMine 상태에서)
     */
    /** 합법 소행성 중 네비 거리 최소인 칸 (서버 getLegalEclipseAsteroidMineTileIds와 동일 집합) */
    static pickBestEclipseAsteroidTile(game: ServerGameState, playerId: string, legalIds: string[]): string {
        // 서버 Eclipse와 동일: 사거리 원점에 우주선 타일 포함(Nav 숫자는 getLegal에서 트랙만 사용)
        const rangeTiles = getPlayerRangeTiles(game, playerId);
        let bestId = legalIds[0];
        let bestD = Infinity;
        for (const id of legalIds) {
            const t = game.map.find(x => x.id === id);
            if (!t) continue;
            const d = Math.min(...rangeTiles.map(p => getDistance(p, t)));
            if (d < bestD) {
                bestD = d;
                bestId = id;
            }
        }
        return bestId;
    }

    private static findEclipseAsteroidTarget(game: ServerGameState, playerId: string): BotAction | null {
        const legalIds = getLegalEclipseAsteroidMineTileIds(game, playerId);
        if (legalIds.length === 0) return null;
        const tileId = BotLogic.pickBestEclipseAsteroidTile(game, playerId, legalIds);
        return { type: 'eclipse_build_asteroid_mine', params: { tileId } };
    }

    private static findSpaceshipFedMineTarget(game: ServerGameState, playerId: string): BotAction | null {
        if (game.pendingSpaceshipFedMine?.playerId !== playerId) return null;
        const player = game.players[playerId];
        if (!player) return null;
        const forbidden = new Set(['space', 'deep_space', 'lost_fleet_ship', 'ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse', 'asteroid']);
        const myTiles = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            t.parasiticMine?.ownerId === playerId ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        // [사용자 룰 C, 2026-06-29] 무한거리 무료광산도 가이아QIC·테라포밍 스텝(광석)은 서버가 청구한다.
        //   → 봇이 감당 못 하는 타일을 고르면 build 실패→데드락. 비용을 계산해 '감당 가능' 타일만 후보로 두되,
        //   감당 가능한 게 하나도 없으면 어쩔 수 없이 전체에서 고른다(데드락 방지; 그 경우 서버가 거부→해소 핸들러 처리).
        const haveOre = player.ore ?? 0, haveQic = this.getAvailableQic(player);
        const scoreTile = (t: HexTile) => {
            const dist = myTiles.length > 0 ? Math.min(...myTiles.map(p => getDistance(p, t))) : 0;
            const steps = t.type ? getTerraformStepsForFaction(game, player.faction!, t.type as any) : 0;
            // 서버와 동일한 비용 산정: 가이아=가이아QIC(글린스는 1광석), 그 외=테라포밍 광석(펜딩스텝 할인)
            let needOre = 0, needQic = 0;
            const reclaim = (t.type === 'transdim' || t.type === 'gaia') && player.pendingGaiaformerTiles?.includes(t.id);
            if (!reclaim) {
                if (t.type === 'gaia') {
                    if (player.faction === 'gleens') needOre = 1; else needQic = getGaiaBaseQic(player.faction || '');
                } else {
                    const actual = Math.max(0, steps - Math.min(player.pendingTerraformSteps || 0, steps));
                    needOre = actual * getTerraformCost(player.research.terraforming);
                }
            }
            const affordable = haveOre >= needOre && haveQic >= needQic;
            const score =
                (steps === 0 ? 120 : 80 - steps * 10) +
                this.calculateRoundScoringBonus(game, playerId, 'build_mine') +
                this.calculateFinalMissionBonus(game, playerId, t) -
                dist;
            return { tileId: t.id, score, affordable };
        };
        const all = game.map
            .filter(t => !forbidden.has(t.type || '') && !t.ownerId && t.structure === null)
            .map(scoreTile)
            .sort((a, b) => b.score - a.score);
        const affordableList = all.filter(c => c.affordable);
        const pick = (affordableList.length > 0 ? affordableList : all)[0];
        return pick ? { type: 'build_mine', params: { tileId: pick.tileId } } : null;
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
        const myQic = this.getAvailableQic(player);

        // [수정] 기존엔 "가장 가까운" 빈 우주를 골라 사거리를 낭비하고 기존 건물/연방 바로 옆에 붙였음.
        // → 좋은 땅을 점수화: 확장 교두보(주변 미점유 행성)·새 섹터·최종미션·새 연방 씨앗을 우대,
        //   이미 형성된 연방 바로 옆(중복·낭비)은 페널티. 사거리 안(무료)이면 거리는 비용 아님.
        const fedHexes = new Set<string>(game.playerFederationHexes?.[playerId] || []);
        const finalIds = game.finalMissionIds || [];
        const wantsSectors = finalIds.includes('fm_sectors');
        const wantsOuter = finalIds.includes('fm_outer_sectors');
        const mySectors = new Set<number>(myTiles.map(t => (t as any).sector).filter((s): s is number => typeof s === 'number'));
        const isExpandablePlanet = (o: HexTile) => !!o.type
            && o.type !== 'space' && o.type !== 'deep_space' && o.type !== 'transdim'
            && !o.type.startsWith('ship_') && !o.ownerId && o.structure === null;

        const scored = game.map
            .filter(t => (t.type === 'space' || t.type === 'deep_space') && t.structure === null && !t.spaceStation)
            .filter(t => {
                const raw = (satellites as any)[t.id] as (string | string[] | undefined);
                const onTile = Array.isArray(raw) ? raw : (raw ? [raw] : []);
                return onTile.length === 0;
            })
            .map(t => {
                const minDist = Math.min(...myTiles.map(p => getDistance(p, t)));
                const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
                let score = 0;
                // 1) QIC 소모만 비용(사거리 안 거리는 무료라 패널티 없음)
                score -= neededQIC * 30;
                // 2) 확장 교두보: 주변 미점유 행성(가까울수록↑)
                for (const o of game.map) {
                    if (o.id === t.id || !isExpandablePlanet(o)) continue;
                    const d = getDistance(t, o);
                    if (d === 1) score += 22; else if (d === 2) score += 11;
                }
                // 3) 새 섹터(확장·미션)
                const sec = (t as any).sector as number | undefined;
                if (typeof sec === 'number' && !mySectors.has(sec)) {
                    score += 35;
                    if (wantsSectors) score += 30;
                    if (wantsOuter && sec >= 11) score += 30;
                }
                // 4) 새 연방 씨앗 vs 기존 연방 낭비: 주변(≤2칸) 내 건물의 연방 소속 확인
                let adjFreeOwn = false, adjFedOwn = false;
                for (const o of game.map) {
                    if (o.ownerId !== playerId || !o.structure) continue;
                    if (getDistance(t, o) > 2) continue;
                    if (fedHexes.has(o.id)) adjFedOwn = true; else adjFreeOwn = true;
                }
                if (adjFreeOwn) score += 25;             // 미연방 건물 근처 → 새 연방 형성에 보탬
                if (adjFedOwn && !adjFreeOwn) score -= 45; // 이미 형성된 연방 바로 옆 = 사거리·연방 모두 낭비
                return { tileId: t.id, neededQIC, minDist, score };
            })
            .filter(x => x.neededQIC <= myQic)
            .sort((a, b) => (b.score - a.score) || (a.neededQIC - b.neededQIC));

        if (scored.length === 0) return null;
        const best = scored[0];
        return { type: 'place_lost_planet', params: { tileId: best.tileId, qicToSpend: best.neededQIC } };
    }

    /**
     * Ivits 우주정거장: 라운드당 1회 반드시 고려. (서버는 O/C 비용 없음)
     * 1) 거리 밖 행성에 다리 역할 빈 공간이 있으면 그 타일 우선
     * 2) 없으면 범위 내(또는 QIC로 도달 가능) 빈 우주 아무 타일이라도 배치 후보로 반환 → 패스 방지
     */
    /** Firaks 의회 다운그레이드 후보: 연구소 1개를 교역소로 내리고 연구 1트랙 전진(메인 액션, 라운드당 1회).
     * 트랙 선택: 레벨<4 중 현재 레벨 최고(투자 완성). 레벨4→5는 5슬롯 락을 봇에서 확인 못 해 보류(서버 거부→스톨 방지). */
    private static findFiraksDowngradeAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        if (player.faction !== 'firaks') return null;
        if (player.usedSpecialActions?.includes('firaks-downgrade')) return null;
        if (!game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) return null;
        const labs = game.map.filter(t => t.ownerId === playerId && t.structure === 'research_lab');
        if (labs.length === 0) return null;
        const pref: ResearchTrack[] = ['terraforming', 'gaiaProject', 'economy', 'artificialIntelligence', 'science', 'navigation'];
        let best: ResearchTrack | null = null, bestLvl = -1, bestPref = 99;
        for (const tr of pref) {
            const lvl = player.research?.[tr] ?? 0;
            if (lvl >= 4) continue; // 레벨5 전진 보류(슬롯 락 위험)
            const pi = pref.indexOf(tr);
            if (lvl > bestLvl || (lvl === bestLvl && pi < bestPref)) { best = tr; bestLvl = lvl; bestPref = pi; }
        }
        if (!best) return null;
        return { type: 'firaks_downgrade', params: { tileId: labs[0].id, trackId: best } };
    }

    private static findIvitsSpaceStationAction(game: ServerGameState, playerId: string): BotAction | null {
        const player = game.players[playerId];
        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );
        if (myPlanets.length === 0) return null;

        const range = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
        const qic = player.qic ?? 0;
        const satellites = (game as any).satellites || {};

        const emptySpaces = game.map.filter(t => {
            if ((t.type !== 'space' && t.type !== 'deep_space') || t.structure !== null || t.spaceStation) return false;
            const onTile = Array.isArray(satellites[t.id]) ? satellites[t.id] : (satellites[t.id] ? [satellites[t.id]] : []);
            if (onTile.includes(playerId)) return false;
            return true;
        });

        // 0) [flag: ivitsFedAwareStation] 연방-인지 배치 — 우주정거장을 '내 건물과 인접(거리1)한 수'가 많은 빈 우주에 우선.
        //    내 건물 클러스터를 연방으로 닫는 위치를 선호(자유분방 배치 대신). 인접 건물 ≥1인 자리가 있을 때만 발동, 없으면 기존 전략. (사용자 관찰)
        if (getPlayerFlag(playerId, 'ivitsFedAwareStation', true)) {
            const fedReachable = emptySpaces
                .map(s => {
                    const dist = Math.min(...myPlanets.map(p => getDistance(p, s)));
                    const neededQic = dist > range ? Math.ceil((dist - range) / 2) : 0;
                    const adjOwn = myPlanets.filter(p => getDistance(p, s) === 1).length;
                    return { space: s, dist, neededQic, adjOwn };
                })
                .filter(x => x.neededQic <= qic && x.adjOwn >= 1)
                // [flag: ivitsStationFreeFirst] 사용자 관찰: 모행성 옆 무료(QIC0) 자리가 있는데도 인접건물 더 많은
                //   자리에 QIC 내고 이상한 위치에 놓음. 정렬 1순위를 '무료 우선(neededQic 오름차순)'으로 바꿔,
                //   공짜로 연결되는 자리가 있으면 QIC 안 쓰고 거기(그중 인접건물 많은 순), 무료가 없을 때만 QIC 지불.
                .sort((a, b) => getPlayerFlag(playerId, 'ivitsStationFreeFirst', true)
                    ? ((a.neededQic - b.neededQic) || (b.adjOwn - a.adjOwn) || (a.dist - b.dist))
                    : ((b.adjOwn - a.adjOwn) || (a.neededQic - b.neededQic) || (a.dist - b.dist)));
            if (fedReachable.length > 0) {
                return { type: 'place_ivits_space_station', params: { tileId: fedReachable[0].space.id } };
            }
        }

        // 1) 전략 배치: 거리 밖 행성에 다리 역할
        const faction = FACTIONS.find(f => f.id === player.faction);
        const homeType = faction?.homePlanet;
        if (homeType) {
            const targetPlanets = game.map.filter(t =>
                !t.ownerId && t.structure === null &&
                (t.type === homeType || t.type === 'gaia') &&
                Math.min(...myPlanets.map(p => getDistance(p, t))) > range
            );
            for (const target of targetPlanets) {
                for (const space of emptySpaces) {
                    if (getDistance(space, target) > 1) continue;
                    const distToSpace = Math.min(...myPlanets.map(p => getDistance(p, space)));
                    const neededQic = distToSpace > range ? Math.ceil((distToSpace - range) / 2) : 0;
                    if (neededQic <= qic && neededQic <= 2) {
                        return { type: 'place_ivits_space_station', params: { tileId: space.id } };
                    }
                }
            }
        }

        // 2) 배치 가능한 빈 우주가 있으면 QIC 적은·가까운 순으로 하나 반환 (우주정거장 안 놓고 패스 방지)
        const reachable = emptySpaces
            .map(s => ({
                space: s,
                dist: Math.min(...myPlanets.map(p => getDistance(p, s))),
                neededQic: (() => {
                    const d = Math.min(...myPlanets.map(p => getDistance(p, s)));
                    return d > range ? Math.ceil((d - range) / 2) : 0;
                })(),
            }))
            .filter(x => x.neededQic <= qic)
            .sort((a, b) => (a.neededQic - b.neededQic) || (a.dist - b.dist));
        if (reachable.length > 0) {
            return { type: 'place_ivits_space_station', params: { tileId: reachable[0].space.id } };
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

            // 5단계 상승 시 연방 토큰 필요 + L5 선점(트랙당 1명, 서버 1210행과 동일 룰) — 선점된 트랙을
            // 후보로 내면 서버 거부 → 무진행 → 조기 패스(advClaimDrive v2 총행동 −3.6 사고의 원인).
            if (level === 4) {
                const feds = getFederationEntries(player);
                if (!feds.some(f => f.isGreen)) continue;
                if (isTrackLevel5Taken(game, track, playerId)) continue;
            }

            const score = this.calculateResearchScore(game, player, playerId, track);
            // [flag: lateResearchMerit] -1000(불가/무가치 판정) 트랙이 트랙 수 부족 시 top-3에 새어들어
            // 후보가 되던 누수 — 하드 제외.
            if (getPlayerFlag(playerId, 'lateResearchMerit', false) && score <= -500) continue;
            scored.push({ track, score });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 3).map(s => s.track); // Top 3 tracks
    }

    private static calculateResearchScore(game: ServerGameState, player: PlayerState, playerId: string, track: ResearchTrack): number {
        const level = player.research[track] ?? 0;
        const round = game.roundNumber;
        const faction = player.faction;
        let score = 0;

        const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);

        // 1. 기본 트랙 가치 (동적 계산)
        switch (track) {
            case 'terraforming': {
                score += (6 - level) * 12;
                if (round <= 3) score += 25;
                // [사용자 전략] 아카데미 빌드 시 테라포밍 1단계 우선
                if (level === 0 && round <= 2) score += 30;
                // [flag: terraDynamicScore] 사용자 관찰(2026-07-14): Terra2/Nav2에서 계속 Nav만 올림 — Nav는
                // '새로 닿는 행성 ×15' 동적 가점이 있는데 Terra는 정적뿐이라 비대칭(삽이 싸지면 지을 수 있게
                // 되는 행성의 가치를 못 봄). Nav와 대칭 이식: 사거리+2 내 삽 필요(1-3스텝) 미점유 행성 수 ×
                // 스텝당 절감 광석(비용 레벨차) × 6, 캡 90. L3(1광석/삽) 도달이 자연히 최대 가점.
                if (getPlayerFlag(playerId, 'terraDynamicScore', false) && level < 5) {
                    const costNow = getTerraformCost(level);
                    const costNext = getTerraformCost(level + 1);
                    if (costNext < costNow && player.faction) {
                        const rngT = BotLogic.getEffectiveBaseRange(player) + 2;
                        const digTargets = game.map.filter(t =>
                            !t.ownerId && !t.structure && t.type
                            && !['space', 'deep_space', 'transdim', 'asteroid', 'gaia'].includes(t.type) && !t.type.startsWith('ship_')
                            && getTerraformStepsForFaction(game, player.faction!, t.type) >= 1
                            && getTerraformStepsForFaction(game, player.faction!, t.type) <= 3
                            && myStructures.some(s => getDistance(s, t) <= rngT)).length;
                        score += Math.min(90, digTargets * (costNow - costNext) * 6);
                    }
                }
                break;
            }
            case 'navigation':
                // 발타크는 PI가 없으면 항해 트랙을 올릴 수 없음
                if (faction === 'bal_tak') {
                    const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
                    if (!hasPI) return -1000;
                }
                score += (6 - level) * 10;
                // [동적 분석] 항해를 올렸을 때 새로 닿는 행성이 있는가?
                const currentRange = BotLogic.getEffectiveBaseRange(player);
                // [flag: navLookaheadTier] 사용자 관찰("nav1 올리고 2거리에 QIC 던져 짓고 → 나중에 nav2"):
                //   getRange는 0·1→1, 2·3→2로 tier가 둘씩 묶여, nav0에서 level+1만 보면 range가 안 늘어(getRange(1)=1)
                //   '항해 올려도 새 땅 0개'로 오판 → 항해를 미루고 QIC로 점프 → 뒤늦게 nav2. 자매함수 willNavResearchSaveQIC는
                //   이미 '실제 range가 느는 다음 레벨까지' 보도록 고쳐졌으나(1648~), 이 점수기엔 미적용이었음. 동일 수정 이식.
                let navNextLvl = level + 1;
                if (getPlayerFlag(playerId, 'navLookaheadTier', false)) {
                    while (navNextLvl <= 5 && getRange(navNextLvl) <= getRange(level)) navNextLvl++;
                    if (navNextLvl > 5) navNextLvl = 5;
                }
                const nextRange = getRange(navNextLvl) + (player.navigationBonus || 0);
                const reachableNow = new Set(game.map.filter(t => !t.ownerId && BotLogic.isPlanetHex(t) && myStructures.some(s => getDistance(s, t) <= currentRange)));
                const reachableNext = new Set(game.map.filter(t => !t.ownerId && BotLogic.isPlanetHex(t) && myStructures.some(s => getDistance(s, t) <= nextRange)));

                const newPlanets = Array.from(reachableNext).filter(t => !reachableNow.has(t));
                if (newPlanets.length > 0) {
                    score += newPlanets.length * 15; // 새로운 행성 개수당 가점
                    // [확장 사슬·사용자 전략] 지금 닿는 빈 행성이 거의 없어(확장 병목) 항해가 새 땅을 열면,
                    // 경제/과학보다 우선해 항해를 올리도록 강한 가점 — "땅 없으면 Nav 올려 새 땅 연다".
                    // (데이터: 정체봇 nav0-1/struct≤6 vs 확장봇 nav2-5/struct9-13)
                    // [사용자 관찰 2026-06-14] 단 이 패닉-보너스가 nav4→5(range3→4, 새 땅 거의 안 열림 + L5는 지식 大)까지
                    // 밀어 itars 봇이 경제 방치하고 nav L5 몰빵(39점). flag면 고레벨(level>=4) rush엔 보너스 미적용.
                    const navPanicOk = level < 4 || !getPlayerFlag(playerId, 'noNavRushL5', true);
                    if (reachableNow.size <= 1 && round <= 5 && navPanicOk) {
                        score += 90 + newPlanets.length * 20;
                    }
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
                // [flag: aiTrackQicEngine] 사람 35판 연구분포: AI트랙이 전체 24%로 *1위*(gaia21/terra21/nav17/eco9/sci8).
                // 기존 ×8(꼴찌)은 "확장보다 우선 안 됨"이라 대충 정한 수 — 실제 QIC는 사람의 만능 통화
                // (rebellion 3정큐=기술타일, twilight 재수령 8-12VP, QIC액션, 점프). 봇 종료 QIC 1.0 = QIC기아가
                // techTiles(-44)·spaceships(-17.5) 갭의 상류. 초반은 확장 우선 유지, R3+ 중후반 주력으로.
                if (getPlayerFlag(playerId, 'aiTrackQicEngine', true)) {
                    score += (6 - level) * 13;
                    if (round >= 3) score += 30; // 사람은 중후반 QIC 엔진화
                } else {
                    score += (6 - level) * 8;
                    if (round >= 5 && level < 3) score += 15;
                }
                break;
            case 'gaiaProject':
                score += (6 - level) * 8;
                // [flag: gaiaThroughput] 실측(2026-07-16): 가이아연구 L1 그루터기 46%(110/240석), 가이아광산
                // 봇 1.39 vs 사람 3.08 — 행성 수 = 연방 재료('연방 3개 기본'의 상류). 원인 = 기본 배수 8이
                // 경제(20)/과학(22)의 1/3이라 진입(게이트) 후 심화가 항상 경쟁 탈락. 포머 엔진이 실가동 가능
                // (사거리 내 배치가능 트랜스딤 — 게이트와 동일 판정)할 때만 심화(L1→4)를 수입트랙급으로 상향,
                // 남은 라운드 비례(막판 심화는 무가치).
                if (getPlayerFlag(playerId, 'gaiaThroughput', false) && level >= 1 && level <= 3
                    && round <= 4 && this.gaiaResearchUsable(game, playerId)) {
                    score += 12 * (6 - level) * (Math.max(0, 6 - round) / 5);
                }
                if (faction === 'terran' || faction === 'itars') score += 40;
                // [사용자 피드백] 발타크는 가이아포머가 곧 QIC(거리 및 가이아행성 확장력)이므로 가이아 포머 트랙을 최우선으로 올림
                if (faction === 'bal_tak') score += 120;
                break;
            case 'economy':
                // [flag: researchValueModel] 경제 '반복수입' 성분은 남은 징수 횟수(6-round)에 비례해야 정확.
                //   수입은 라운드 시작 징수, 연구상승은 그 후(액션)라 라운드R 상승분은 R+1..R6에 (6-R)회만 걷힘 → R6=0.
                //   기존은 (6-level)*20 고정이라 막라운드에도 경제 몰빵(사용자 관찰). L5 도달보상(3O/6C/6P)은 아래 (B)에서.
                if (getPlayerFlag(playerId, 'researchValueModel', true)) {
                    const remainingIncomes = Math.max(0, 6 - round); // R1=5 … R5=1 … R6=0
                    if (level < 4) score += (6 - level) * 20 * (remainingIncomes / 5); // 반복수입: 남은 징수 비례
                    if (round <= 2) score += 35; // 초반 경제 우대(남은 징수 많음)
                    // [flag: firaksEcoPlan] 사용자 플랜(2026-07-14): 파이락 R1 = 랩 + 경제 2칸 → R2 수입(Eco L2 =
                    // +1O2C2P/라운드)으로 의회 자금 조달 → R2 PI → 다운그레이드 엔진. 변환 조달(v1/v2 −6.9/−10.8
                    // 기각)과 달리 수입 라인이라 자원을 안 태움. 연구 점수 부스트라 무료 기술타일 트랙 선택
                    // (pickResearchTracks[0])에도 동일 적용 — 랩 타일로 경제 진행하는 사람 수순 재현.
                    if (getPlayerFlag(playerId, 'firaksEcoPlan', true) && player.faction === 'firaks'
                        && round <= 2 && level < 2
                        && !game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) {
                        score += 80;
                    }
                } else {
                    score += (6 - level) * 20; // 상향 (15 -> 20)
                    if (round <= 2) score += 35; // 초반 경제 대폭 우대
                    if (round >= 5) score -= 30;
                }
                // [사용자 전략] 아카데미 건설 시 경제 2단계까지 우선순위 강화
                const academyCount = myStructures.filter(t => t.structure === 'academy').length;
                if (academyCount >= 1 && level < 2) {
                    score += 45;
                }
                break;
            case 'science':
                // [flag: sciIncomeScale] 사용자 관찰(2026-07-15): R6에 12K 들고 Eco1/Sci0 → Eco3+Sci2 만들고
                // 패스 — Eco L4(+8VP)가 정답인데 과학 저레벨에 분산. 원인 = 경제는 '남은 징수 비례' 스케일이
                // 들어갔는데(researchValueModel) 과학은 옛 고정 공식이라 R6 Sci0→1이 132점 = Eco3→4 종료보너스
                // (+4VP=132)와 동점. 과학 지식수입도 남은 징수 0이면 가치 0 — 경제와 동일 스케일 적용.
                if (getPlayerFlag(playerId, 'sciIncomeScale', true) && getPlayerFlag(playerId, 'researchValueModel', true)) {
                    const remainingIncomesSci = Math.max(0, 6 - round);
                    score += (6 - level) * 22 * (remainingIncomesSci / 5);
                    if (round <= 3) score += 30;
                } else {
                    score += (6 - level) * 22; // 복구 및 상향 (12 -> 22)
                    if (round <= 3) score += 30; // 초반 과학은 엔진의 핵심
                }
                if (level >= 3) score += 15;
                break;
        }

        // [flag: researchValueModel] 트랙 상승의 '라운드-불변' 성분 — 기존 감쇠 공식이 놓치던 것(사용자 지적).
        if (getPlayerFlag(playerId, 'researchValueModel', true)) {
            const next = level + 1;
            // (G) 라이벌이 이미 L5 점유 → 그 트랙 L5 도달 불가(단일 슬롯). 후보에서 제외.
            if (next === 5 && Object.entries(game.players).some(([pid, p]) => pid !== playerId && (p.research?.[track] ?? 0) >= 5)) {
                return -1000;
            }
            // [flag: researchFinishL3] 사용자 관찰("R3에 경제 한 칸 같은 걸 좋아함") + 실측(80점+ 좌석):
            // 사람 L3+ 완주 4.0트랙 vs 봇 1.9트랙 — 봇도 4.5트랙을 건드리지만 (6-레벨) 공식의 새트랙 우대로
            // L1-2 그루터기를 양산. 완주 가중: L1-2(다음 스텝이 임계 접근)는 가점, R2+에 미완주 트랙을 두고
            // 새 트랙(L0) 시작은 감점 — 차단이 아닌 서열 교정(lateResearchMerit 차단식 −4.11과 구분).
            if (getPlayerFlag(playerId, 'researchFinishL3', false)) {
                if (level === 1 || level === 2) score += 25;
                else if (level === 0 && round >= 2
                    && (['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'] as const)
                        .some(t => { const l = player.research?.[t] ?? 0; return l >= 1 && l <= 2; })) {
                    score -= 30;
                }
            }
            // (A) 엔드게임 트랙 VP: 종료 시 L3/4/5 = 4/8/12점(절대). 스텝이 L3+ 넘으면 +4 확정VP — 라운드 무관.
            //   막라운드에 저트랙 한 칸 올려 L3 찍는 게 최고수(사용자 예: Nav1/Eco2 → 4K를 Eco에 = Eco3 = +4VP).
            const endVp = (l: number) => (l >= 5 ? 12 : l >= 4 ? 8 : l >= 3 ? 4 : 0);
            // [flag: endgameTrackVp] 사용자 관찰(2026-07-14): R6 3정큐 트랙 선택이 Terra/Eco L2(→L3 = +4VP 확정)
            // 대신 과학 L0→L1(가치 0)을 고름 — 과학 기본점수 (6-0)×22=132가 라운드 무관 고정이라 종료보너스
            // 60(4VP×15)을 이김. R6엔 수입 라운드가 0이라 확정 VP가 항상 우위 → 종료 임계 가중 2배(60→132+).
            const VP_UNIT = (getPlayerFlag(playerId, 'endgameTrackVp', true) && round >= 6) ? 33 : 15; // 1VP ≈ 15점(새 행성=15 스케일). 측정/1:3로 보정.
            score += (endVp(next) - endVp(level)) * VP_UNIT;
            // (B) 즉시 도달보상 자원가치(받는 즉시 = 라운드 무관, R6에도 액션 연료/전환으로 유효).
            //   공통 L3 +3충전, nav L1/3 +1Q, AI L1/2 +1Q·L3/4 +2Q·L5 +4Q, terra L1/4 +2O, eco L5 +3O6C6P, sci L5 +9K.
            let q = 0, o = 0, c = 0, pw = 0, kn = 0;
            if (next === 3) pw += 3;
            if (track === 'navigation' && (next === 1 || next === 3)) q += 1;
            else if (track === 'artificialIntelligence') q += next === 5 ? 4 : next >= 3 ? 2 : 1;
            else if (track === 'terraforming' && (next === 1 || next === 4)) o += 2;
            else if (track === 'economy' && next === 5) { o += 3; c += 6; pw += 6; }
            else if (track === 'science' && next === 5) kn += 9;
            score += q * 18 + o * 8 + c * 4 + pw * 4 + kn * 7;
            // [flag: ecoSciL5Late] 사용자 관찰(2026-07-15): 경제/지식 꼭대기를 R5 이전에 먹어버림 — L5는
            // 일회성 보상 대신 L4의 매라운드 수입(경제 2C2O2P≈28점/R, 과학 4K≈28점/R)이 '정지'되는
            // 트레이드인데 점수가 즉시보상+종료VP만 합산하고 정지분을 차감 안 함. 남은 징수 횟수만큼 차감
            // → R5+(잔여 수입 ≤1회)엔 자연히 원래대로 등정.
            if (getPlayerFlag(playerId, 'ecoSciL5Late', true) && next === 5 && round < 5
                && (track === 'economy' || track === 'science')) {
                score -= Math.max(0, 6 - round) * 28;
            }
            // (H) 이 트랙 위에 '좋은' 미보유 고급타일이 있으면, 그 타일 품질(scoreAdvancedTechTile)에 비례해
            //   L4 자격을 만드는 상승을 우대(사용자 지적: 좋은 고급타일 먹을 수 있어도 보너스가 없었음).
            //   청구엔 트랙 L4 + 초록연방 소모가 필요 → 초록연방 보유 시에만. 정액 +110/+30 근사(advTechChain·시너지)의 값-인지 대체.
            const advOnTrack = (game.advancedTechTilesByTrack || {})[track];
            if (advOnTrack?.id && !Object.values(game.players).some(p => p.techTiles?.includes(advOnTrack.id))
                && countGreenFederations(player) >= 1) {
                const advScore = this.scoreAdvancedTechTile(game, playerId, advOnTrack.id, round, player);
                if (advScore > 0) {
                    // [flag: lateResearchMerit] 선행 가점(×0.3)이 'L4 도달 불가능'한 상승에도 붙던 누수 —
                    // 실측(80판): 저메리트 경제상승 R4 38·R5 53·R6 64건. 남은 라운드(라운드당 1상승 가정)로
                    // L4 도달 가능할 때만 선행 가점.
                    const l4Reachable = !getPlayerFlag(playerId, 'lateResearchMerit', false)
                        || (4 - next) <= (6 - round);
                    if (next === 4) score += advScore;          // 3→4: 자격 생성(결정적) — 타일이 좋을수록 크게
                    else if (next < 4 && l4Reachable) score += advScore * 0.3; // L4로 가는 도중: 약한 선행 가점
                    // next===5는 이미 L4=청구 가능 상태 → 추가 자격가치 없음(0)
                }
            }
            // [flag: lateResearchMerit] 후반 저메리트 상승 차단 — 사용자 관찰 2건: ①R6 저메리트(경계 L3+ 미도달
            // + 즉시보상 없음) = 4K 태우고 얻는 게 0(잔여 4K=1.33VP보다 나쁨) ②R5에 L2까지만 올리고 자원 소모 —
            // 종료 L3(+4VP) '사다리'는 완주 자금이 있어야 가치인데 1-ply라 완주 가능성을 안 봄(다턴 계산 부재).
            // 사다리 완주 판정(결정론): 남은 지식(현재-4 + R5면 다음 라운드 지식수입)으로 L3까지 추가 상승
            // ((3-next)×4K) 자금이 가능해야 허용. R6에 8K+ 보유로 2연속 상승 L3 완주하는 경우는 futureK가 커버.
            if (getPlayerFlag(playerId, 'lateResearchMerit', false) && round >= 5 && next < 3) {
                const hasImmediate = (track === 'navigation' && next === 1)
                    || track === 'artificialIntelligence'
                    || (track === 'terraforming' && next === 1);
                if (!hasImmediate) {
                    const expK = round === 5 ? (this.calculateExpectedRoundIncome(game, playerId).knowledge ?? 0) : 0;
                    const futureK = (player.knowledge ?? 0) - 4 + expK;
                    if (futureK < (3 - next) * 4) return -1000;
                }
            }
        }

        // [flag: humanResearchPrior] 사람 로그 35판(66 시드) 직접 분석 — 첫 연구 분포:
        //   navigation 41% · gaiaProject 32% · terraforming 11% · economy 9% · science 6% · AI 2%
        //   전체 누적도 science 8%(최하위). 봇 공식은 science ×22(162점)로 첫 연구를 지식에 몰아 사람과 정반대였음.
        // → 데이터를 직접 박는다: science 과대평가 제거 + 초반(R1-2) 첫 연구를 사람처럼 항해/가이아로.
        // ※ 이건 self-play A/B가 아니라 사람 데이터가 곧 정답인 케이스(확장가치는 봇끼리 안 잡힘). do-no-harm만 확인, 진짜판정=1:3.
        if (getPlayerFlag(playerId, 'humanResearchPrior', true)) {
            if (track === 'science') {            // ×22→사실상 ×12(상향 전 값)로 환원 + 초반보너스 축소
                score -= (6 - level) * 10;
                if (round <= 3) score -= 20;
            }
            if (round <= 2) {                     // 첫 연구 shaping: nav>gaia>terra>eco
                if (track === 'navigation') score += 95;
                else if (track === 'gaiaProject') score += 85;
                else if (track === 'economy') score -= 40;
            }
        }

        // [사용자 전략] 경제·과학(지식) L5 도달은 R6이 최적 — 일찍 올리면 지식·연방토큰을 비효율 소모하고
        // L5 income을 누릴 라운드도 차이가 작음. L4→L5(level===4)를 R1-4 강하게 억제, R5는 같은 트랙에
        // L4+ 상대가 있어 L5를 뺏길 우려가 있을 때만 허용(선점), R6은 정상 가치로 올림.
        if (level === 4 && (track === 'economy' || track === 'science')) {
            if (round <= 4) {
                score -= 200;
            } else if (round === 5) {
                const rivalNearL5 = Object.entries(game.players).some(([pid, p]) => pid !== playerId && ((p.research?.[track] ?? 0) >= 4));
                if (!rivalNearL5) score -= 100; // 경쟁 없으면 R6까지 대기
            }
        }

        // [flag: advTileOverL5] L4→L5 승급은 초록연방을 소모한다. 좋은 고급타일(≥70)이 아직 청구 가능하고 초록연방을
        //   들고 있으면, 초록을 L5에 태우지 말고 아껴 고급타일에 쓰게 강하게 억제(고급타일 > L5 가치, 사용자 관찰).
        //   봇이 초록을 L5에 소모→고급타일 0건이던 핵심 원인 교정. R6은 고급타일 트리거(아카/연구소) 시간이 없으니 예외.
        if (level === 4 && round < 6 && getPlayerFlag(playerId, 'greenForAdvTile', false)
            && countGreenFederations(player) >= 1 && this.bestClaimableAdvScore(game, playerId) >= 70) {
            score -= 250;
        }

        // [flag: expansionResearch] 봇 전종족이 확장연구(terra/nav/gaia)를 사람의 절반(합 4~7 vs 9~14)만 올려
        // 행성을 못 늘리는 게 최대 약점(데이터). 확장 3트랙을 과학(×22)·경제(×20)와 경쟁되게 상향 — 낮은 레벨일수록
        // 더 우선해 초반부터 확장 인프라(싼 테라포밍·사거리·가이아)를 깔게 한다. 측정으로 자성 확인.
        if (getPlayerFlag(playerId, 'expansionResearch', false)
            && (track === 'terraforming' || track === 'navigation' || track === 'gaiaProject')) {
            score += (5 - level) * 14;
        }

        // 2. 고급 기술 타일 시너지 분석
        //   [flag: researchValueModel] 아래 정액 시너지(+30/+25)는 위 (H)의 값-인지 보너스가 대체 → 플래그 ON시 생략(중복 방지).
        const advTiles = game.advancedTechTilesByTrack || {};
        if (!getPlayerFlag(playerId, 'researchValueModel', true)) {
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
        }

        // 3. 라운드 미션 연계
        score += this.calculateRoundScoringBonus(game, playerId, 'research_track');

        // 3b. [개선] "트랙 완주" 유인 — 기본항 (6-level)*weight 가 낮은 레벨을 선호해
        //   봇이 여러 트랙을 얕게 펼치고(레벨2~3 다수) 레벨5에 못 가는 문제를 교정.
        //   이미 올린 트랙을 끝까지 밀어 레벨4(고급타일 자격·종료보너스8) → 레벨5(종료보너스12·강력 능력)로 가게 한다.
        // [flag: researchValueModel] 이 +25/+55는 엔드게임 VP를 뭉툭하게 근사하던 것 → 위 (A)가 명시적으로 대체하므로 중복 제거.
        if (!getPlayerFlag(playerId, 'researchValueModel', true)) {
            if (level === 2) score += 25;   // 2→3 진척
            else if (level === 3) score += 55; // 3→4: 고급 기술 타일 자격 + 5단계 발판이라 강하게 완주 유도
        }

        // 4. 다음 레벨 보상 가치
        if (level === 4) {
            score += 100;
            const greenFeds = countGreenFederations(player);
            if (greenFeds > 0) {
                // [flag: advTileOverL5] L5 전진과 고급타일은 *둘 다 green 토큰 소모*. 기존 ×2.0이 L5를 ~200점으로 만들어
                // 고급타일(10-30VP)을 압도 → green을 L5에 태우고 고급타일 0건(사람95), green 21개 낭비.
                // ★ value-aware: green이 1개뿐이고, 청구가능 고급타일 중 *정말 좋은 것*(scoreAdvancedTechTile≥85)이 있을 때만
                //   L5 부스트 생략(green을 그 고급타일에 양보). 나쁜 고급타일 땜에 좋은 L5 포기하지 않음. green 2+면 둘 다 가능→유지.
                const divertToAdv = getPlayerFlag(playerId, 'advTileOverL5', true) && greenFeds === 1
                    && this.bestClaimableAdvScore(game, playerId) >= 70;
                if (!divertToAdv) score *= 2.0;
            }
        }

        // [flag: advTechChain] 사용자 관찰(2026-06-28): L3 + 4지식 + 초록연방 + 트랙 위 미보유 고급타일인데도
        // 봇이 일반 수익타일을 먹음. 고급타일 자격 = 트랙 L4. 기존 ×2.0 폭발가중은 level===4(4→5)에만 걸려
        // "3→4로 *자격 자체를 만드는*" 결정적 한 수를 +55로만 약하게 평가했음 → 고급타일(~30VP)을 못 챙김(techTiles 사람40.5 vs 봇3.3).
        // 이 트랙 위에 아무도 안 가진 고급타일 + 초록연방 보유 시, 3→4 전진을 크게 우대(다음 빌드에서 고급타일 획득).
        //   [flag: researchValueModel] 이 정액 +110은 위 (H)의 값-인지 자격보너스(next===4 += advScore)가 대체 → 플래그 ON시 생략.
        if (getPlayerFlag(playerId, 'advTechChain', true) && !getPlayerFlag(playerId, 'researchValueModel', true)
            && level === 3 && countGreenFederations(player) >= 1) {
            const adv = advTiles[track];
            if (adv?.id && !Object.values(game.players).some(p => p.techTiles?.includes(adv.id))) {
                score += 110; // 고급타일 자격을 만드는 결정적 수
            }
        }

        return score;
    }

    private static shouldAdvanceToLevel5OnTechSelection(game: ServerGameState, playerId: string, trackId: ResearchTrack): boolean {
        const player = game.players[playerId];
        if (!player) return false;
        const currentLevel = player.research?.[trackId] ?? 0;
        if (currentLevel !== 4) return false;
        if (countGreenFederations(player) < 1) return false;
        // [flag: advTileOverL5] green 1개뿐인데 청구가능 고급타일 중 *정말 좋은 것*(≥85)이 있으면 L5 말고 그 고급타일에 양보.
        if (getPlayerFlag(playerId, 'advTileOverL5', true) && countGreenFederations(player) === 1
            && this.bestClaimableAdvScore(game, playerId) >= 70) {
            return false;
        }
        if (Object.entries(game.players).some(([pid, p]) => pid !== playerId && (p.research?.[trackId] ?? 0) >= 5)) return false;
        return this.calculateResearchScore(game, player, playerId, trackId) >= 120 || game.roundNumber >= 5;
    }

    /** 내가 지금 청구가능한(트랙 L4+, 미보유) 고급타일 중 최고 scoreAdvancedTechTile. 없으면 -1. value-aware green 배분용. */
    private static bestClaimableAdvScore(game: ServerGameState, playerId: string): number {
        const player = game.players[playerId];
        const advTiles = game.advancedTechTilesByTrack || {};
        let best = -1;
        for (const [t, adv] of Object.entries(advTiles)) {
            if (!adv?.id) continue;
            if ((player.research?.[t as ResearchTrack] ?? 0) < 4) continue;
            if (Object.values(game.players).some(p => p.techTiles?.includes(adv.id))) continue;
            const s = this.scoreAdvancedTechTile(game, playerId, adv.id, game.roundNumber, player);
            if (s > best) best = s;
        }
        return best;
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

        // 동일 id 타일은 트랙/풀에 스택(보통 4장)으로 여러 슬롯에 있음. 점수는 id만으로 결정되므로 종류별 1회만 평가·로그.
        const seenIds = new Set<string>();
        const uniqueTiles: TechTile[] = [];
        for (const t of availableTiles) {
            if (!t?.id || seenIds.has(t.id)) continue;
            seenIds.add(t.id);
            uniqueTiles.push(t);
        }
        if (uniqueTiles.length === 0) return null;

        // [flag: balTakNavTileGate] 사용자 룰(2026-07-12): 발타크는 PI 없으면 Nav 전진 불가 — 서버는 전진만
        // 버리고 타일은 주므로(canBalTakAdvanceNavigation) Nav 트랙 밑 타일 = 전진 증발 = 순손해.
        // 예외: 7VP(tech-imm-7vp)·유형당1K(tech-imm-1k-planet)를 후반(R5+)에 먹는 것만 허용.
        // 서버는 같은 id가 여러 트랙에 있으면 '첫 매칭 트랙' 슬롯을 소모하므로 그 기준으로만 제외.
        if (getPlayerFlag(playerId, 'balTakNavTileGate', true) && player.faction === 'bal_tak'
            && !game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) {
            const firstTrackOf = (id: string): string | null => {
                for (const [trk, val] of Object.entries(game.techTilesByTrack)) {
                    const arr = Array.isArray(val) ? val : (val ? [val] : []);
                    if (arr.some((t: { id?: string } | null) => t?.id === id)) return trk;
                }
                return null;
            };
            const lateOk = (game.roundNumber ?? 1) >= 5;
            const filtered = uniqueTiles.filter(t => firstTrackOf(t.id) !== 'navigation'
                || (lateOk && (t.id === 'tech-imm-7vp' || t.id === 'tech-imm-1k-planet')));
            // 전부 걸러지면 선택 진행을 위해 원본 유지(최소악 선택)
            if (filtered.length > 0 && filtered.length < uniqueTiles.length) {
                uniqueTiles.length = 0;
                uniqueTiles.push(...filtered);
            }
        }

        // 동적 점수 계산을 통해 최적의 타일 선택
        let bestTile: TechTile = uniqueTiles[0];
        let maxScore = -Infinity;
        const tileScores: { id: string; score: number }[] = [];

        for (const tile of uniqueTiles) {
            const score = this.calculateTechTileScore(game, playerId, tile.id);
            tileScores.push({ id: tile.id, score });
            if (score > maxScore) {
                maxScore = score;
                bestTile = tile;
            }
        }

        // [버그수정 — 고급타일 0개의 진짜 원인] 실제 선택은 이 함수가 결정하는데, 기존엔 표준 타일만
        // 평가하고 항상 select_tech_tile을 반환했음 (바로 아래 scoreAdvancedTechTile이 있는데 미연결).
        // 자격(초록연방 + 트랙 L4 + 누구도 미보유)이 되면 고급타일을 같은 척도로 경쟁시켜,
        // 더 좋으면 select_advanced_tech_tile을 반환한다. (botHandler 수락 수정과 한 쌍)
        let bestAdv: { tileId: string; trackId: ResearchTrack; score: number } | null = null;
        if (countGreenFederations(player) >= 1 && game.advancedTechTilesByTrack) {
            const anyOwned = (id: string) => Object.values(game.players).some(p => p.techTiles?.includes(id));
            for (const [t, adv] of Object.entries(game.advancedTechTilesByTrack)) {
                const tr = t as ResearchTrack;
                if (!adv?.id || anyOwned(adv.id)) continue;
                if ((player.research?.[tr] ?? 0) < 4) continue;
                const s = this.scoreAdvancedTechTile(game, playerId, adv.id, game.roundNumber, player);
                if (!bestAdv || s > bestAdv.score) bestAdv = { tileId: adv.id, trackId: tr, score: s };
            }
        }
        // [flag: advTileOverL5] 사람은 좋은 고급타일이면 거의 무조건 먹음(봇 0건/사람95). 표준 수익타일 점수가 고급을
        // 이기는 calibration 때문에 봇이 트리거를 만들어도 고급을 안 집던 마지막 관문 → 좋은 고급타일(≥85)이면 표준보다 우선.
        // value-aware: ≥85(정말 좋은 것)만 강제, 나쁜 고급은 기존대로 표준과 정상 비교.
        // [flag: advTileAlways] 사용자 모델: 고급타일은 거의 항상 기본보다 가치 큼 → 청구 가능하면(초록+L4+미보유) 무조건 우선.
        //   기존 임계(≥70/기본초과)가 봇이 '딸 수 있는데 기본 집는'(사용자가 1:3에서 수없이 관찰) 원인. 실제 결정부 직접 교정.
        // [flag: advTileValueFloor] 사용자 관찰(2026-07-12): 외각 0개인데 '패스당 외각×2VP' 고급타일을 먹음 —
        // advTileAlways가 점수 무관 강제라 조건부 가치 0짜리도 선택됨. 고급타일 비용(초록 연방 토큰 + 표준타일
        // 1개 커버=혜택 영구상실)을 생각하면 한계가치(베이스 45 초과분)가 최소한은 있어야 함. <12면 아예 안 집음.
        const advMarginal = bestAdv ? bestAdv.score - 45 : 0;
        const advWorthless = getPlayerFlag(playerId, 'advTileValueFloor', true) && advMarginal < 12;
        const advPreferred = !!bestAdv && !advWorthless && (getPlayerFlag(playerId, 'advTileAlways', true)
            || bestAdv.score > maxScore
            || (getPlayerFlag(playerId, 'advTileOverL5', true) && bestAdv.score >= 70));
        if (bestAdv && advPreferred) {
            if (!isSimulate) {
                log(`Bot ${player.name} selected ADVANCED Tech Tile: ${bestAdv.tileId} (adv ${bestAdv.score.toFixed(1)} vs std ${maxScore.toFixed(1)})`, 'game', game.id);
            }
            return { type: 'select_advanced_tech_tile', params: { advancedTileId: bestAdv.tileId, trackId: bestAdv.trackId } };
        }

        // 트랙 선택 (해당 타일이 요구하는 트랙 또는 가장 높은 점수의 트랙)
        const tracks = this.pickResearchTracks(game, player, playerId);
        const preferredTrackId = tracks.length > 0 ? tracks[0] : 'economy';
        const trackId = this.getTrackForTechTile(game, bestTile.id) ?? preferredTrackId;

        // MCTS 롤아웃 시에는 매 시뮬 상태마다 로그가 쌓이므로, 실제 수 결정 시에만 로그
        if (!isSimulate) {
            const ranked = [...tileScores].sort((a, b) => b.score - a.score);
            const scoreLine = ranked.map((x) => `${x.id}=${x.score.toFixed(2)}`).join(' | ');
            log(
                `Bot ${player.name} tech tile scores R${game.roundNumber} (${ranked.length} unique types, track→${trackId}): ${scoreLine}`,
                'game',
                game.id
            );
            log(`Bot ${player.name} selected Tech Tile: ${bestTile.id} (Score: ${maxScore.toFixed(2)})`, 'game', game.id);
        }
        return { type: 'select_tech_tile', params: { techTileId: bestTile.id, trackId, advanceToLevel5: this.shouldAdvanceToLevel5OnTechSelection(game, playerId, trackId) } };
    }

    /**
     * 고급 기술 타일 점수: vp-build(남은 건설·업그레이드 파이프라인), vp-research(~30VP 상당),
     * 패스(남은 라운드·누적 상향), imm(즉시 VP), 자원형(자원 가치 환산).
     */
    /** [flag: advPassGrowth] 패스 고급타일의 성장 투영 — 사람은 '지금 개수'가 아니라 '앞으로 늘릴 개수'로 산다
     *  (실게임 4판: 2vp-asteroid 52·3vp-fed 42·3vp-lab 33 — 전부 취득 후 성장분). 현재 개수 평가만으로는
     *  구조적 저평가 → 남은 라운드와 성장 여지(TS→랩 재료, 빈 소행성, 연방 페이스)만큼 보수적으로 가산. */
    private static advPassProj(game: ServerGameState, playerId: string, current: number, kind: 'lab' | 'fed' | 'asteroid' | 'type', passesLeft: number): number {
        if (!getPlayerFlag(playerId, 'advPassGrowth', false) || passesLeft < 2) return current;
        const player = game.players[playerId];
        switch (kind) {
            case 'lab': {
                // TS가 랩 재료 — TS 보유 + 랩 슬롯 여유만큼 1~2개 성장 기대
                const ts = game.map.filter(t => t.ownerId === playerId && t.structure === 'trading_station').length;
                return current + Math.min(2, ts, passesLeft - 1) * 0.8;
            }
            case 'fed': {
                // 사람 페이스 ~라운드당 0.5연방 — 보수적으로 절반만
                return current + Math.min(2, (passesLeft - 1) * 0.5);
            }
            case 'asteroid': {
                // 빈 소행성이 존재하고 포머 확보 경로가 있으면 성장 기대(사람 실측: 취득 후 소행성 적극 건설)
                const empty = game.map.filter(t => t.type === 'asteroid' && !t.ownerId && !t.structure).length;
                const formerPath = getEffectiveGaiaformers(player) > 0 || (player.research?.gaiaProject ?? 0) >= 1;
                return current + (formerPath ? Math.min(2, empty, passesLeft - 1) : 0);
            }
            case 'type':
                return current + Math.min(1.5, passesLeft * 0.4);
        }
    }

    private static scoreAdvancedTechTile(game: ServerGameState, playerId: string, tileId: string, round: number, player: PlayerState): number {
        let s = 45;

        const passesLeft = Math.max(0, 7 - round);
        // 남은 패스 횟수 × 이후 라운드로 갈수록 패스 VP가 최대에 가깝게 오른다고 가정한 가중
        const passRamp = passesLeft <= 0 ? 0 : passesLeft * (0.55 + 0.45 * Math.min(1, passesLeft / 5.5));

        const myStructs = game.map.filter(t => t.ownerId === playerId && t.structure);
        const mineForVp =
            game.map.filter(t => t.ownerId === playerId && t.structure === 'mine').length +
            game.map.filter(t => t.parasiticMine?.ownerId === playerId).length +
            (player.virtualMineAsteroid ? 1 : 0) +
            (player.virtualMineProto ? 1 : 0) +
            game.map.filter(t => t.ownerId === playerId && t.structure === 'lost_planet_mine').length;
        const tsCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'trading_station').length;
        const labCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'research_lab').length;
        const academyCount = myStructs.filter(t => t.structure === 'academy').length;
        const piCount = myStructs.filter(t => t.structure === 'planetary_institute').length;
        // 광산만이 아니라 TS→연구소→아카데미/의회 체인을 거친 뒤에도 결국 신규 광산·TS 건설로 이어질 수 있는 “남은 건물” 전부
        const upgradeChainCount = mineForVp + tsCount + labCount + academyCount + piCount;
        const sectors = new Set(myStructs.map(t => t.sector).filter((x): x is number => x != null));
        const planetTypes = new Set(
            myStructs
                .filter(t => t.type && t.type !== 'space' && t.type !== 'deep_space')
                .map(t => t.type!)
        );
        if (player.virtualMineAsteroid) planetTypes.add('asteroid');
        if (player.virtualMineProto) planetTypes.add('proto');
        if (myStructs.some(t => t.structure === 'lost_planet_mine')) planetTypes.add('lost_planet');

        const fedCount = getFederationEntries(player).length;
        // 외곽(C) 섹터 = 11~18, '서로 다른 섹터 수'로 카운트(실제 VP 계산과 동일). 기존 20~29는 존재하지 않는 죽은 범위였음.
        const outerSectorCount = new Set(
            game.map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship' && (t.sector ?? -1) >= 11 && (t.sector ?? -1) <= 18).map(t => t.sector)
        ).size;
        const outerImm = outerSectorCount;
        const outerPass = outerSectorCount;
        const asteroidCount = game.map.filter(t => t.ownerId === playerId && t.type === 'asteroid').length;
        const gaiaCount = game.map.filter(t => t.ownerId === playerId && t.type === 'gaia').length;
        const bigCount = myStructs.filter(t => t.structure === 'planetary_institute' || t.structure === 'academy').length;

        // adv-vp-build-mine: 체인상 모든 건물이 장기적으로 추가 광산 건설 트리거로 이어짐
        const remainingMineBuildTriggers = Math.min(26, upgradeChainCount + Math.max(0, Math.floor(passesLeft * 1.35)));
        // adv-vp-build-ts: 광산→TS 직접뿐 아니라 연구소·아카데미·의회 보유가 이후 TS 건설·확장과 연동
        const remainingTsBuildTriggers = Math.min(
            24,
            mineForVp + labCount + academyCount + piCount + Math.max(0, Math.floor(passesLeft * 1.05))
        );

        const ORE_W = 3; // adv-imm-1o-sector: 광석 1/섹터

        if (tileId === 'adv-vp-build-mine') {
            s += 3 * remainingMineBuildTriggers;
        } else if (tileId === 'adv-vp-build-ts') {
            s += 3 * remainingTsBuildTriggers;
        } else if (tileId === 'adv-vp-research') {
            // 약 30VP 상당 베이스 + 남은 라운드당 연구(2VP/회) 기대
            const expectedAdvances = Math.max(1, Math.floor(passesLeft * 2.2));
            s += 30 + 2 * expectedAdvances;
        } else if (tileId === 'adv-vp-terraform') {
            const pending = player.pendingTerraformSteps || 0;
            const expectedSteps = pending + Math.max(0, Math.floor(passesLeft * 2.2));
            s += 2 * expectedSteps;
        } else if (tileId === 'adv-vp-qic-action') {
            const expectedQic = Math.max(1, 1 + Math.floor(passesLeft / 2));
            s += 4 * expectedQic;
        } else if (tileId === 'adv-pass-1vp-type') {
            s += this.advPassProj(game, playerId, planetTypes.size, 'type', passesLeft) * 1 * passRamp;
        } else if (tileId === 'adv-pass-3vp-lab') {
            s += this.advPassProj(game, playerId, labCount, 'lab', passesLeft) * 3 * passRamp;
        } else if (tileId === 'adv-pass-3vp-fed') {
            s += this.advPassProj(game, playerId, fedCount, 'fed', passesLeft) * 3 * passRamp;
        } else if (tileId === 'adv-pass-2vp-asteroid') {
            s += this.advPassProj(game, playerId, asteroidCount, 'asteroid', passesLeft) * 2 * passRamp;
        } else if (tileId === 'adv-pass-2vp-outer') {
            s += outerPass * 2 * passRamp;
        } else if (tileId === 'adv-imm-1o-sector') {
            s += sectors.size * ORE_W;
        } else if (tileId === 'adv-imm-4vp-ts') {
            s += tsCount * 4;
        } else if (tileId === 'adv-imm-2vp-mine') {
            s += mineForVp * 2;
        } else if (tileId === 'adv-imm-2vp-sector') {
            s += sectors.size * 2;
        } else if (tileId === 'adv-imm-4vp-outer') {
            s += outerImm * 4;
        } else if (tileId === 'adv-imm-6vp-big') {
            s += bigCount * 6;
        } else if (tileId === 'adv-imm-2vp-gaia') {
            s += gaiaCount * 2;
        } else if (tileId === 'adv-imm-5vp-fed') {
            s += fedCount * 5;
        } else if (tileId === 'adv-act-3k') {
            // 자원형(매 라운드 액션). 라운드-인지: 남은 라운드만큼 사용 → passesLeft 비례. 지식=연구엔진 연료라 가중 높게.
            s += Math.round(6 * passesLeft);
        } else if (tileId === 'adv-act-1q-5c') {
            s += Math.round(5 * passesLeft); // QIC1+크레딧5/라운드
        } else if (tileId === 'adv-act-3o') {
            s += Math.round(4 * passesLeft); // 광석3/라운드
        } else if (tileId.startsWith('adv-')) {
            // 알 수 없는 고급 타일: 보수적 베이스만
            s += 35;
        }

        return s;
    }

    private static calculateTechTileScore(game: ServerGameState, playerId: string, tileId: string): number {
        const player = game.players[playerId];
        const round = game.roundNumber;
        let score = 0;

        // 1. 우주선 전용 타일 보너스 (보통 일반 타일보다 강력함)
        const isShipTech = tileId.startsWith('ship-tech-');
        if (isShipTech) {
            if (getPlayerFlag(playerId, 'shipTechEntryValue', false)) {
                // [flag] 우주선 기술타일을 종류별 실제 가치로 평가. flat +90/+45는 nav+1·1O3K를 저평가해
                // 일반 income타일(+70~120)에 밀림 → 봇이 2TF+Mine만 가끔 집음(데이터: Nav+1 0.09 vs 사람 4.59).
                const early = round <= 3;
                if (tileId === 'ship-tech-nav+1') {
                    const myStruct = game.map.filter(t => t.ownerId === playerId && t.structure).length;
                    score += (early && myStruct < 9) ? 170 : 110; // 영구 +사거리=확장 약점 직격, 일반타일 압도
                } else if (tileId === 'ship-tech-1o3k') {
                    score += early ? 100 : 70; // 지식3(연구 병목 연료)+광석1
                } else {
                    score += early ? 90 : 45;  // 2tf-mine 등 (추가 보너스는 아래 별도 블록)
                }
            } else {
                if (round <= 3) score += 90; // 초반 우주선 타일 매우 선호
                else score += 45;
            }
        }
        if (tileId === 'ship-tech-2tf-mine') {
            const oldSteps = player.pendingTerraformSteps || 0;
            const oldFreeMine = player.nextMineFreeFromShipTech;
            player.pendingTerraformSteps = oldSteps + 2;
            player.nextMineFreeFromShipTech = true;
            const buildCandidates = this.findBuildActionsWithPendingSteps(game, playerId);
            player.pendingTerraformSteps = oldSteps;
            player.nextMineFreeFromShipTech = oldFreeMine;

            if (buildCandidates.length === 0) {
                score -= 10000;
            } else {
                score += 35 + buildCandidates.length * 5;
            }
        }

        // 2. 라운드별 가중치 (초반 수익 → 중반 균형 → 후반 점수)
        // [데이터 2026-06-14] 사람 techTiles VP 32.8 vs 봇 0.0 — 봇이 즉발VP 타일을 너무 광범위(R≤3 -300)하게
        // 회피 + R4 미처리로 techTiles 점수가 0이 됨. 3구간으로 재조정: R1-2 엔진(income), R3-4 균형(7VP도 적극),
        // R5+ VP우선. (초반 7VP 회피는 사용자 우려대로 유지하되 R3부터는 7VP=큰 가치로 인정.)
        const techVpReweight = getPlayerFlag(playerId, 'techVpReweight', true);
        if (!techVpReweight) {
            // [구버전 A/B용] 기존 2구간 로직 (R≤3 즉발VP -300, R≥5 7vp+80)
            if (round <= 3) {
                if (tileId.startsWith('tech-inc-')) score += 120;
                if (tileId === 'tech-act-4p') score += 100;
                if (tileId === 'tech-imm-1o-1q') score += 50;
                if (tileId === 'tech-imm-7vp' || tileId === 'tech-gaia-3vp' || tileId === 'tech-imm-1k-planet' || tileId === 'tech-big-4str') score -= 300;
            } else if (round >= 5) {
                if (tileId === 'tech-imm-7vp') score += 80;
                if (tileId === 'tech-imm-1k-planet') { const t = new Set(game.map.filter(x => x.ownerId === playerId && x.structure).map(x => x.type).filter(Boolean)).size; score += 40 + t * 15; }
                if (tileId.startsWith('tech-inc-')) score -= 40;
            }
        } else if (round <= 2) {
            // 초반: 수익 타일 대폭 우대 (엔진 빌딩). 즉발VP는 회피하되 절대차단(-300)→완화(-180).
            if (tileId.startsWith('tech-inc-')) score += 120;
            if (tileId === 'tech-act-4p') score += 100;
            if (tileId === 'tech-imm-1o-1q') score += 50;
            if (tileId === 'tech-imm-7vp' || tileId === 'tech-gaia-3vp' || tileId === 'tech-imm-1k-planet' || tileId === 'tech-big-4str') {
                score -= 180;
            }
        } else if (round <= 4) {
            // 중반(R3-4): income 우대. 즉발 7VP는 R3·R4 모두 회피 — 아직 엔진 빌딩 시기라 7VP를 먹으면 남은
            // 라운드 income 복리를 버리는 손해(사용자: "3라운드는 물론 4라운드도 7점 타일 먹기엔 이름"). 7VP는 R5+에서만.
            if (tileId.startsWith('tech-inc-')) score += 70;
            if (tileId === 'tech-act-4p') score += 60;
            if (tileId === 'tech-imm-1o-1q') score += 40;
            if (tileId === 'tech-imm-7vp') score -= 180;  // R3-4 모두 즉발 7VP 회피 — 엔진 빌딩 시기라 R5+에서만(사용자: R4도 이름)
            if (tileId === 'tech-gaia-3vp') score += 35;
            if (tileId === 'tech-imm-1k-planet') {
                const types = new Set(game.map.filter(t => t.ownerId === playerId && t.structure).map(t => t.type).filter(t => t)).size;
                score += 30 + (types * 12);
            }
        } else { // round >= 5
            // 후반: 즉시 점수 우선. income은 굴릴 라운드가 없어 가치 급감.
            if (tileId === 'tech-imm-7vp') score += 95;
            if (tileId === 'tech-gaia-3vp') score += 55;
            if (tileId === 'tech-imm-1k-planet') {
                const myPlanets = game.map.filter(t => t.ownerId === playerId && t.structure);
                const types = new Set(myPlanets.map(t => t.type).filter(t => t)).size;
                score += 40 + (types * 15);
            }
            if (tileId.startsWith('tech-inc-')) score -= 40;
            // [flag: lateTilePref] 사용자 관찰(2026-07-14): R6에 big-4str를 1O1Q보다 먼저 집음 — 원인은 선호가
            // 아니라 R5+에서 big-4str·act-4p·1o-1q가 전부 0점 동점 → 목록 순서(엄격 >)가 픽을 결정하던 사고.
            // lastRoundFedFree가 R6 타일 획득을 부활시키며 노출 증가. 서열: 즉시자원(1O1Q, 정산+사용) >
            // 4P액션(마지막 1회 사용 가능) > big-4str(연방 파워 잠재 — 0 유지, 연방 가능 판은 여전히 경쟁 가능).
            if (getPlayerFlag(playerId, 'lateTilePref', true)) {
                if (tileId === 'tech-imm-1o-1q') score += 20;
                if (tileId === 'tech-act-4p') score += 10;
            }
        }

        // [flag: techTileRankFix] 사용자 랭킹(2026-07-07): 4C > 4PW > 1o1P > 1K1C. 기존엔 income 타일 3종이
        //   모두 획일 +120이라 봇이 광석기아인데도 1K1C(광석0)를 집는 등 비율문제를 악화(광석≤1&크레딧≥4 결정 17%).
        //   income 타일을 종류별 차등 + 광석기아면 1o1p(광석) 상황 우대. 기술타일 선택은 점수-최대 직접픽이라 즉시 반영.
        //   R5+은 income 자체가 가치 급감이라 제외(R≤4만).
        if (getPlayerFlag(playerId, 'techTileRankFix', false) && round <= 4) {
            const oreStarved = (player.ore ?? 0) <= 1;
            if (tileId === 'tech-inc-4c') score += 20;                       // 4C = 보통 최상(유연한 크레딧수입)
            else if (tileId === 'tech-act-4p') score += 30;                  // 4PW = 2순위(4p→1o/1q/기타 유연)
            else if (tileId === 'tech-inc-1o-1p') score += oreStarved ? 45 : 0; // 광석수입 — 기아면 최상으로 끌어올림
            else if (tileId === 'tech-inc-1k-1c') score -= 30;               // 1K1C = 필러(트랙전진용), 최하
        }

        // [flag: filler1k1cGuard] 사용자(2026-07-11): 1K1C = income 최하위 필러인데 봇이 자주 집음. 기각된
        // techTileRankFix(-2.75)의 원인이던 '전면 페널티'(트랙전진 필러 용도 훼손)와 달리, 같은 풀에 더 나은
        // 대안(4C/4P/1o1p)이 남아있을 때만 감점 — 대안이 없으면 필러로 정상 사용.
        if (getPlayerFlag(playerId, 'filler1k1cGuard', false) && tileId === 'tech-inc-1k-1c' && round <= 4) {
            const pool = (game.techTilesPool || []);
            const betterAvail = pool.some(t => t && ['tech-inc-4c', 'tech-act-4p', 'tech-inc-1o-1p'].includes(t.id));
            if (betterAvail) score -= 60;
        }

        // [flag: act4pPick] 파워엔진 진단(2026-07-11 사용자): 4P타일 보유 사람 42% vs 봇 10% — 점수가 income보다
        // 한끗 낮아(+100 vs +120) 픽에서 항상 밀림. 4P = 매 라운드 +4충전 = 파워액션·리치 순환의 상류 엔진.
        // 기각된 techTileRankFix(-2.75)의 실패 모드(1K1C 페널티→연구픽 훼손)를 피해 4P 단독 부스트만.
        if (getPlayerFlag(playerId, 'act4pPick', false) && round <= 4 && tileId === 'tech-act-4p') score += 50;

        // 2-1. 고급 기술 타일 (adv-*): 건물·라운드·즉시 VP·자원 기반 세부 점수
        if (tileId.startsWith('adv-')) {
            score += this.scoreAdvancedTechTile(game, playerId, tileId, round, player);
        }

        // 3. 라운드 미션 시너지 (기술 타일 획득 시 2VP 등)
        score += this.calculateRoundScoringBonus(game, playerId, 'gain_tech_tile');

        // 4. 종족별 특정 타일 시너지
        if (player.faction === 'taklons' && tileId === 'tech-act-4p') score += 20; // 아이타는 의회 능력 활용을 위해 4P 매우 선호
        if (player.faction === 'nevlas' && tileId === 'tech-act-4p') score += 20; // 네블라스는 파워 충격 시너지

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

        const myMines = game.map.filter(t => t.ownerId === playerId && t.structure);

        // [flag: startPlacementFuturePlayers] 초기 배치 '큰 그림' 신호 사전계산(후보마다 동일 → 루프 밖):
        // 미래 배치자 홈타입 / 우주선 위치 / 맵 중심.
        const smartPlace = getPlayerFlag(playerId, 'startPlacementFuturePlayers', true);
        const oppHomeTypes = new Set<string>(
            Object.values(game.players)
                .filter(p => p && p.faction && p.faction !== player.faction)
                .map(p => FACTIONS.find(f => f.id === p.faction)?.homePlanet as string | undefined)
                .filter((x): x is string => !!x)
        );
        const shipTiles = game.map.filter(t => ['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'].includes(t.type || ''));
        const mapCenter = (() => {
            if (game.map.length === 0) return { q: 0, r: 0 };
            let sq = 0, sr = 0;
            for (const t of game.map) { sq += (t.q ?? 0); sr += (t.r ?? 0); }
            return { q: sq / game.map.length, r: sr / game.map.length };
        })();

        for (const tile of freeTiles) {
            let score = 0;

            const others = game.map.filter(t => t.ownerId && t.ownerId !== playerId && t.structure);
            for (const other of others) {
                const dist = getDistance(tile, other);
                if (dist <= 2) score += 5; // 상대방과 붙어 있으면 파워 수급이 좋으므로 가점
            }

            const nearbyPlanets = game.map.filter(t => t.id !== tile.id && !t.ownerId && t.type !== 'space' && t.type !== 'deep_space');
            // [기본 ON 전환 2026-06-28] 사용자 관찰("오프닝 광산 위치 엉망") + 사람은 싸고 가까운 확장지(평균 5.6행성)에 둠.
            // self-play는 placement 못 판정(47판 null=do-no-harm)이나 이론옳음+실전관찰 → 켬. 1:3로 최종판정.
            const weightByTf = getPlayerFlag(playerId, 'startPlacementExpansion', true);
            for (const p of nearbyPlanets) {
                const dist = getDistance(tile, p);
                if (dist > 3) continue;
                if (!weightByTf) {
                    // (구) 종류 무관 단순 카운트
                    score += dist <= 2 ? 2 : 1;
                    continue;
                }
                // [데이터 실패분석 2026-06-14] 참사봇은 R1-2 광산 부족(2.0 vs 좋음 3.1)+크레딧 쟁여둠 = 비싼 땅 옆 시작→확장 못함.
                // 초기 배치를 '싸고(테라포밍 적음) 가까운(즉시 건설) 확장 타겟 군집'으로 가중 → R1-2 저비용 확장 유도.
                const steps = p.type ? getTerraformStepsForFaction(game, player.faction!, p.type) : 3;
                let w = steps === 0 ? 4 : steps === 1 ? 2 : steps === 2 ? 0.7 : 0.2; // 홈/가이아 > 1스텝 > 비쌈
                if (dist >= 3) w *= 0.4; else if (dist === 2) w *= 0.7; // 멀면(QIC/Nav 필요) 가치 절감, dist1=즉시
                score += w;
            }

            // [flag: startPlacementFuturePlayers 기본 ON] 초기 배치 '큰 그림' 가점 (스코어러가 즉시 확장만 보던 myopia 보완).
            // self-play로 검증 불가(contention 미재현) → 도메인 논리 + 실게임 1:3 판정용. OFF 기본이라 기존 동작 무영향.
            if (smartPlace) {
                // (a) 미래 배치자: 상대는 자기 홈 행성 타입에 지을 확률↑ → 그 빈 홈타입 타일 인접(dist≤2)이면 미래 파워 리치 기대.
                //     확실한 '이미 놓인 광산 +5'보다 낮게(+2, 캡 +6).
                let futureLeech = 0;
                for (const ft of game.map) {
                    if (ft.ownerId || ft.structure || !ft.type) continue; // 빈 타일만
                    if (!oppHomeTypes.has(ft.type)) continue;
                    if (getDistance(tile, ft) <= 2) futureLeech += 2;
                }
                score += Math.min(futureLeech, 6);
                // (b) 우주선 인접: 우주선 입장(액션)은 강력한데 초기 사거리는 짧다 → 가까울수록 입장 비용(Nav/QIC)↓ (dist≤2:+4, ≤4:+2).
                for (const ship of shipTiles) {
                    const d = getDistance(tile, ship);
                    if (d <= 2) score += 4; else if (d <= 4) score += 2;
                }
                // (c) 맵 중앙: 연결성·사거리·리치·우주선 접근 모두 우위. 중심에 가까울수록 가점(최대 +6, dist≥6은 0).
                score += Math.max(0, 6 - getDistance(tile, mapCenter));
            }

            // 두 번째 광산을 첫 번째 광산 근처(거리 3 이하)에 배치하는 것을 매우 강하게 기피 (선택지가 정말 없을 때만 어쩔 수 없이 짓도록)
            if (myMines.length === 1) {
                const distToFirst = getDistance(tile, myMines[0]);
                if (distToFirst <= 3) {
                    score -= 100; // 엄청난 페널티 부여
                }
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

        // [버그 수정 2026-06-15] 네뷸라 의회: 파워액션 비용 절반(서버 executeUsePowerAction line 6526와 일치).
        // 기존엔 full cost로 p3<cost 체크 → 네뷸라가 살 수 있는 파워액션을 '못산다'고 오판 → 후보 0 → 조기패스(네뷸라 R2패스 원인).
        const hasNevlasPI = player.faction === 'nevlas' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
        const effPowerCost = (c: number) => hasNevlasPI ? Math.ceil(c / 2) : c;

        const scored: { id: string, score: number }[] = [];
        const brainBurnIds = new Set<string>(); // [flag: taklonsBrainCombo] B+T 번 preAction이 필요한 액션

        // 광산/교역소 수: 스텝 vs 자원(2O/7C) 우선순위 판단용 (서버 executeBuildMine과 동일하게 getStructureCount 사용)
        const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure);
        const mineCount = getStructureCount(game, playerId, 'mine');
        const tsCount = myStructures.filter(t => t.structure === 'trading_station').length;
        const minesToUpgrade = mineCount - tsCount; // 교역소로 올릴 광산이 몇 개 있는지
        const needStepsFirst = mineCount <= 2 || minesToUpgrade <= 0; // 광산이 적거나, 올릴 광산이 없으면 스텝 우선

        // [사용자 규칙 2026-06-18] 다음 라운드 크레딧:오레 수입>3.5면(오레 기아) 파워액션으로 오레를 먹게 유도,
        // 크레딧 파워액션은 억제(이미 돈만 쌓임). 교역소 죽음의 나선 탈출.
        let oreStarvedPow = false;
        if (getPlayerFlag(playerId, 'oreCreditBalance', true)) {
            const exp = this.calculateExpectedRoundIncome(game, playerId);
            // [재튜닝 2026-06-18] 수입 비율 악화 + 현재 크레딧 실제 쟁여둠(≥12) 둘 다일 때만 = 진짜 죽음의 나선.
            oreStarvedPow = (exp.credits ?? 0) / Math.max(0.5, exp.ore ?? 0) > 3.5 && (player.credits ?? 0) >= 12;
        }

        for (const action of availableActions) {
            let score = 0;
            const cost = action.cost;
            const isQic = action.costType === 'qic';

            if (isQic) {
                if (qic < cost) continue;
                // [flag: twilightQicSave] 사용자 룰(2026-07-12): R4-5에 트와 탑승 + 재수령(#1) 미사용이면,
                // 저가치 QIC 액션(기술타일 제외)에 QIC를 써서 3Q 스택을 깨느니 재수령(8~12VP)이 이득.
                // 예외: 트와 미탑승 / R6(마지막 라운드 자유 소비) / 지출 후에도 3Q 유지되면 허용.
                if (getPlayerFlag(playerId, 'twilightQicSave', true) && action.id !== 'qic-action-tech') {
                    const rTw = game.roundNumber ?? 1;
                    if (rTw >= 4 && rTw <= 5 && qic - cost < 3) {
                        const twi = game.map.find(t => t.type === 'ship_twilight');
                        const onTwi = !!twi && (player.spaceshipsEntered ?? []).includes(twi.id);
                        const twiReady = !!twi && !(game.spaceships?.[twi.id]?.usedActionIndices ?? []).includes(1);
                        if (onTwi && twiReady) continue;
                    }
                }
            } else {
                const need = effPowerCost(cost); // 네뷸라 의회 반값 반영
                // 타클론: 브레인스톤(추가 파워)도 지출 가능 → 서버와 동일 헬퍼로 판정(p3만 보면 과소평가→조기패스)
                const affordable = player.faction === 'taklons'
                    ? (canSpendTaklonsPowerWithoutBrain(player, 3, need) || canTaklonsSpendUsingBrain(player, 3, need))
                    : p3 >= need;
                // [flag: taklonsBrainCombo] 사용자 방향 교정(2026-07-14): 브레인 활용의 진짜 수정 = '번+사용 커플링'
                // (7/2 기록의 미시도 해법). 브레인이 2그릇이면 B+T 번(일반토큰 1개 소모, 브레인→3그릇=+3파워)으로
                // 이 파워액션이 열릴 때, 번을 preActions로 묶어 한 후보로 — 옮기고 안 쓰는 hoarding(−2.4)과 달리
                // 같은 턴에 즉시 사용이 보장됨. 사람 패턴(B+T 6.2/석)의 셀프플레이 성립형.
                if (!affordable) {
                    // [6차 실측] 커플링조차 셀프플레이 −9.0(충전 기근에서 bowl2 토큰 소모가 더 큰 손해) →
                    // 사람게임 한정(리치 풍부 = 재충전 성립). 셀프플레이 검증 불가 축 확정 — 판정은 1:3.
                    const comboOk = getPlayerFlag(playerId, 'taklonsBrainCombo', true)
                        && (game.botPlayerIds?.length ?? 0) < Object.keys(game.players).length
                        && player.faction === 'taklons' && player.brainStoneBowl === 2
                        && (player.power2 ?? 0) >= 2 // 브레인 외 일반토큰 1개(번 비용) 여유
                        && ((player.power3 ?? 0) + 3) >= need;
                    if (!comboOk) continue;
                    brainBurnIds.add(action.id);
                }
            }

            const ore = player.ore || 0;
            const credits = player.credits || 0;
            const currentMission = game.roundScoringTiles[game.roundNumber - 1];
            const isStepMission = currentMission?.triggerType === 'terraform_step';

            switch (action.id) {
                // [사용자 피드백] 선점 요소인 파워 액션의 기본 점수를 광산 건설보다 압도적으로 상향하여 최우선적으로 먹게 함
                // QIC 액션 - 매우 강력 (상향)
                case 'qic-action-tech':
                    score = 300;
                    break;
                case 'qic-action-vp-sector':
                    score = round >= 4 ? 250 : 120;
                    break;
                case 'qic-action-federation':
                    score = 220;
                    break;

                // 파워 액션 - 자원/테라포밍 선호도 조정 (전체적으로 +100~150점 상향)
                case 'gain-2-ore': {
                    score = 240;
                    if (ore * 1.2 < credits) score += 50;
                    // 액션 해금 가치: 2O 후 연구소(3O+5C)·광산(1O+2C)·트왈라잇 2O+3P→Lab 가능 여부
                    const oreAfter = ore + 2;
                    if (oreAfter >= 3 && credits >= 5) score += 120; // 다음 턴 TS→Lab 가능
                    if (oreAfter >= 2 && p3 >= 3 && game.map.some(t => t.ownerId === playerId && t.structure === 'trading_station')) score += 100; // 트왈라잇 2O+3P→연구소 가능
                    if (oreAfter >= 1 && credits >= 2) score += 40;  // 광산 1채 가능
                    // [flag: powerActionValue] 자원 셋업: 2O로 의회(4O6C)·아카데미(6O6C) 건설이 다음 턴 가능해지면 가점(사용자 모델)
                    if (getPlayerFlag(playerId, 'resourceActionSetup', false)) {
                        const hasTSp = game.map.some(t => t.ownerId === playerId && t.structure === 'trading_station');
                        const hasLabp = game.map.some(t => t.ownerId === playerId && t.structure === 'research_lab');
                        if (oreAfter >= 4 && credits >= 6 && hasTSp) score += 90;   // 다음 턴 TS→의회 가능
                        if (oreAfter >= 6 && credits >= 6 && hasLabp) score += 110;  // 다음 턴 연구소→아카데미 가능
                    }
                    // 교역소 지을 광산이 없으면 자원만 쌓이므로 감점 → 스텝 우선 (powerActionValue 시 억제 완화: 자원액션도 경쟁되게)
                    if (needStepsFirst) score -= getPlayerFlag(playerId, 'resourceActionSetup', false) ? 50 : 100;
                    // [오레기아] 크레딧 수입 과잉 상태면 오레 확보가 탈출구 → 강하게 선호(needStepsFirst 감점 상쇄+).
                    if (oreStarvedPow) score += 180;
                    break;
                }
                case 'gain-7-credits': {
                    score = 230;
                    if (credits < ore * 1.2) score += 50;
                    const credAfter = credits + 7;
                    if (ore >= 3 && credAfter >= 5) score += 120; // 연구소(TS→Lab) 가능
                    if (ore >= 1 && credAfter >= 2) score += 50;   // 광산 가능
                    // [flag: powerActionValue] 자원 셋업: 7C로 의회(4O6C)·아카데미(6O6C)가 다음 턴 가능해지면 가점(사용자 모델)
                    if (getPlayerFlag(playerId, 'resourceActionSetup', false)) {
                        const hasTSc = game.map.some(t => t.ownerId === playerId && t.structure === 'trading_station');
                        const hasLabc = game.map.some(t => t.ownerId === playerId && t.structure === 'research_lab');
                        if (ore >= 4 && credAfter >= 6 && hasTSc) score += 90;    // 다음 턴 TS→의회 가능
                        if (ore >= 6 && credAfter >= 6 && hasLabc) score += 110;   // 다음 턴 연구소→아카데미 가능
                    }
                    if (needStepsFirst) score -= getPlayerFlag(playerId, 'resourceActionSetup', false) ? 50 : 100;
                    // [오레기아] 이미 돈만 쌓이는데 또 크레딧 파워액션은 비율 악화 → 억제.
                    if (oreStarvedPow) score -= 150;
                    // [flag: creditCapGuard] 사용자 관찰(2026-07-12): 크레딧 포화(연구소1+TS3)인데 7C까지 눌러
                    // 상한(30) 오버플로우 예약. 임계 캘리브레이션(사람 15,250결정: ≥20C는 4% 비정상 구간):
                    // ①7C 결과가 20C+면 사람 꼬리 밖 — 강억제 ②상한(30) 오버플로우 예약이면 후보 제외.
                    // 셀프플레이 120판 회귀(curse 9호) → 사람 게임 한정 가동(위 creditOverflow 주석 참조).
                    if (getPlayerFlag(playerId, 'creditCapGuard', true)
                        && (game.botPlayerIds?.length ?? 0) < Object.keys(game.players).length) {
                        if (credits + 7 >= 20) score -= 200;
                        const expCap = this.calculateExpectedRoundIncome(game, playerId);
                        if (credits + 7 + (expCap.credits ?? 0) > 30) score = -1;
                    }
                    break;
                }
                case 'gain-1-step': {
                    // [flag: rangeBuildOnly] 거리보너스 활성 중엔 스텝-파워액션도 셋업체이닝이라 금지(range 뒤엔 직접 빌드만).
                    if (getPlayerFlag(playerId, 'rangeBuildOnly', true) && (player.rangeBonusActive || player.tempRangeBonus || player.gleensNavBonusActive)) { score = -1; break; }
                    const oldSteps = player.pendingTerraformSteps || 0;
                    player.pendingTerraformSteps = oldSteps + 1;
                    const possibleBuildActions = this.findBuildActionsWithPendingSteps(game, playerId);
                    player.pendingTerraformSteps = oldSteps;
                    const usesTerraforming = possibleBuildActions.some(act => {
                        const targetTile = game.map.find(t => t.id === (act as any).params?.tileId);
                        return targetTile && getTerraformStepsForFaction(game, player.faction!, targetTile.type!) > 0;
                    });
                    if (possibleBuildActions.length === 0 || !usesTerraforming) {
                        score = -1000;
                    } else {
                        score = round <= 3 ? 210 : 120;
                        if (isStepMission) score += 50;
                        // 업그레이드할 광산이 부족하면 스텝을 우선 (광산 확보 → 그다음 교역소)
                        if (needStepsFirst) score += 130;
                    }
                    break;
                }
                case 'gain-2-knowledge': {
                    score = 200;
                    const knowAfter = (player.knowledge || 0) + 2;
                    if (knowAfter >= 4) score += 100; // 다음 턴 연구(advance_research) 1회 가능
                    const eclipseShip = this.findPlayerShip(game, playerId, 'ship_eclipse');
                    if (eclipseShip) {
                        const shipState = game.spaceships?.[eclipseShip.id];
                        if (shipState?.usedActionIndices?.includes(2)) score += 30;
                    } else {
                        score += 20;
                    }
                    break;
                }
                case 'gain-2-tokens':
                    score = 160;
                    // 토큰이 부족하여 연방 선언이 어려울 때 가치 상승
                    const totalTokens = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);
                    if (totalTokens < 7) score += 40;
                    // [flag: noR1TokenGain] 사용자: R1엔 구체적 용처 없이 토큰추가(3파워→2토큰) 하는 게 아까움 — 초반엔 건설·확장·연구 우선.
                    //   단 예외: 인공물 획득은 6토큰 소모(gameState 8731)라, 트와일라잇 우주선 탑승 + 슬롯 있음 + 토큰<6이면
                    //   토큰 모으는 게 맞음(사용자 지적). 그 외엔 R1 score<0로 후보 제외(pre-pass 패스대체에도 안 뽑힘).
                    // [flag: earlyWasteBan] noR1TokenGain의 R1-2 확장판(사용자: 인공물 추적도 아닌데 2토큰 늘리기 금지)
                    if (((game.roundNumber ?? 1) === 1 && getPlayerFlag(playerId, 'noR1TokenGain', false))
                        || ((game.roundNumber ?? 1) <= 2 && getPlayerFlag(playerId, 'earlyWasteBan', true))) {
                        const twi = game.map.find(t => t.type === 'ship_twilight');
                        const boardedTwi = !!twi && (player.spaceshipsEntered ?? []).includes(twi.id);
                        const slotsOpen = (game.twilightArtifactSlots ?? []).some(s => s != null);
                        const goingForArtifact = boardedTwi && slotsOpen && totalTokens < 6;
                        if (!goingForArtifact) score = -1;
                    }
                    // [flag: tokenGainNeedGate] 사용자관찰(2026-07-09): 봇이 usable bowl3 파워를 소모(cost 3)해 bowl1 토큰 2개로
                    //   바꾸는 gain-2-tokens를 구체적 용처 없이 남발("파워 income을 못 셈→미리 태움. 실제론 토큰 많은데도 자주 눌러").
                    //   토큰이 이미 넉넉(≥7=연방보너스 조건 밖)하면 이건 usable 파워 강등(bowl3→bowl1)+템포 손해라 순손해 →
                    //   음수로 눌러 findPowerActions(score≥0만) + powerActionOverPass 강제 대상에서 제외. noR1TokenGain(R1 한정)의
                    //   전 라운드 일반판. 인공물 추적(트와일라잇 탑승+슬롯) 시 토큰수집이 맞으므로 예외.
                    if (getPlayerFlag(playerId, 'tokenGainNeedGate', false) && totalTokens >= 7) {
                        const twiT = game.map.find(t => t.type === 'ship_twilight');
                        const boardedTwiT = !!twiT && (player.spaceshipsEntered ?? []).includes(twiT.id);
                        const slotsOpenT = (game.twilightArtifactSlots ?? []).some(s => s != null);
                        if (!(boardedTwiT && slotsOpenT)) score = -1;
                    }
                    break;
                case 'gain-2-steps': {
                    // [flag: rangeBuildOnly] 거리보너스 활성 중엔 스텝-파워액션 금지(range 뒤엔 직접 빌드만).
                    if (getPlayerFlag(playerId, 'rangeBuildOnly', true) && (player.rangeBonusActive || player.tempRangeBonus || player.gleensNavBonusActive)) { score = -1; break; }
                    // 단독 파워 후보에서는 2스텝 행성 등 “1스텝으로는 부족한” 목표가 있을 수 있으므로,
                    // gain-1-step으로 열리는 다른 광산이 있다고 gain-2-steps를 막지 않음(타일별 판단은 findBuildActions).
                    const oldSteps = player.pendingTerraformSteps || 0;
                    const isTfTile = (tid: string) => { const t = game.map.find(m => m.id === tid); return !!(t && getTerraformStepsForFaction(game, player.faction!, t.type!) > 0); };
                    // +1스텝으로 열리는 테라포밍 빌드 타일
                    player.pendingTerraformSteps = oldSteps + 1;
                    const tfTiles1 = new Set(this.findBuildActionsWithPendingSteps(game, playerId).map(a => (a as any).params?.tileId).filter(isTfTile));
                    // +2스텝으로 열리는 테라포밍 빌드 타일
                    player.pendingTerraformSteps = oldSteps + 2;
                    const possibleBuildActions = this.findBuildActionsWithPendingSteps(game, playerId);
                    player.pendingTerraformSteps = oldSteps;
                    const tfTiles2 = possibleBuildActions.map(a => (a as any).params?.tileId).filter(isTfTile);
                    const usesTerraforming = tfTiles2.length > 0;
                    // 2스텝이 1스텝보다 "추가로" 여는 타일(=2스텝 필요 행성)이 있어야 의미. 없으면 1스텝으로 충분 →
                    // gain-1-step(3P)을 쓰도록 후보에서 제외(score<0 → 필터됨)하여 5P 낭비 방지.
                    const opensExtra = tfTiles2.some((tid: string) => !tfTiles1.has(tid));
                    const gain1Available = game.powerActions.some(a => a.id === 'gain-1-step' && !a.isUsed);
                    // [룰수정 2026-07-15] 사용자 관찰(타클론): 부스터 1TF가 미사용인데 3P 삽이 소진됐다고 5P 2삽
                    // 폴백으로 1스텝 땅을 지음 — 공짜 부스터 삽이 같은 일을 하므로 지배당하는 낭비. 부스터 1TF가
                    // 살아 있고 1스텝 목표가 있으면(tfTiles1) 5P 폴백 금지(부스터 콤보 tfBonusCombo가 그 빌드를 담당).
                    const boosterTfFree = !player.usedBonusAction && !player.rangeBonusActive
                        && ALL_BONUS_TILES.find(t => t.id === player.bonusTile)?.specialAction === 'terraform_step'
                        && tfTiles1.size > 0;
                    // 2스텝 필요 타일(opensExtra)이 있으면 1스텝 땅 유무와 무관하게 5P 제공.
                    // 1스텝 땅만 있으면 3P(gain-1-step)·공짜 부스터 1TF를 우선, 둘 다 없을 때만 5P를 폴백으로 허용.
                    if (!usesTerraforming || (!opensExtra && (gain1Available || boosterTfFree))) {
                        score = -1000;
                    } else {
                        score = 180; // 유저 피드백: Geodens/Xenos 외엔 잘 안씀
                        if (player.faction === 'geodens' || player.faction === 'xenos') score += 40;
                        if (isStepMission) score += 60; // 테라포밍 미션 시 2단계는 4vp 이상 가치
                        if (needStepsFirst) score += 140; // 광산 부족 시 스텝 우선
                    }
                    break;
                }
                case 'gain-3-knowledge':
                    score = 170; // 유저 피드백: 거의 안 씀
                    if (player.knowledge === 1) score += 40; // 4지금을 맞추기 위해 3지식 사용 고민 가능
                    break;
                default:
                    score = 150;
            }

            // 라운드 보정: 후반일수록 파워 액션 선점 중요
            if (round >= 5) score += 50;

            // QIC 행동 보정 (QIC 충분 시 상향)
            if (isQic && qic >= cost && round >= 3) score *= 1.2;

            scored.push({ id: action.id, score });
        }

        if (scored.length === 0) return [];
        
        // Filter out actions with negative scores (like -1000 for invalid targets)
        const validActions = scored.filter(s => s.score >= 0);
        if (validActions.length === 0) return [];
        
        validActions.sort((a, b) => b.score - a.score);
        // 상위 3개 후보 반환
        const useBrain = player.faction === 'taklons';
        // 상위 5개 후보 반환하여 파워 액션 탐색 다양화
        return validActions.slice(0, 5).map(s => brainBurnIds.has(s.id)
            ? { type: 'use_power_action' as const, params: { actionId: s.id, useBrain: true }, preActions: [{ type: 'burn_power' as const, params: { moveBrainToBowl3: true } }] }
            : { type: 'use_power_action' as const, params: { actionId: s.id, useBrain } });
    }

    private static getPowerTokenReserve(game: ServerGameState, player: PlayerState): number {
        const round = game.roundNumber ?? 1;
        // [flag: itarsBurnFreely] 아이타는 번한 토큰이 소멸이 아니라 가이아 공간으로 가 다음 라운드 Bowl I 복귀(+PI로 4개당 기술타일).
        //   그래서 막라(R6, 복귀 없음)만 아니면 토큰을 예비로 아낄 이유가 적음 → 예비 0으로 낮춰 파워액션/번을 적극적으로.
        //   (사용자 관찰: 아이타가 번을 잘 안 함. Ivits는 이미 예비 면제(canSpend...)인데 아이타는 예외 없었음.)
        if (player.faction === 'itars' && round < 6) {
            const pid = Object.keys(game.players).find(k => game.players[k] === player);
            if (getPlayerFlag(pid, 'itarsBurnFreely', false)) return 0;
        }
        if (round <= 2) return 4;
        if (round <= 4) return 3;
        if (round === 5) return 1;
        return 0;
    }

    private static getAvailableBonusTokenRefill(game: ServerGameState): number {
        return Math.max(0, ...((game.availableBonusTiles ?? []).map(tile => tile.income?.powerTokens ?? 0)));
    }

    private static canSpendPowerTokensForStrategicAction(
        game: ServerGameState,
        player: PlayerState,
        tokensSpent: number,
        tokensCreatedBeforeSpend = 0,
        tokenRefillAfterSpend = 0
    ): boolean {
        if (player.faction === 'ivits') return true;
        const totalTokens = (player.power1 ?? 0) + (player.power2 ?? 0) + (player.power3 ?? 0) + tokensCreatedBeforeSpend;
        const remainingTokens = totalTokens - tokensSpent;
        if (remainingTokens < 0) return false;
        const refillAllowance = Math.min(2, tokenRefillAfterSpend + this.getAvailableBonusTokenRefill(game));
        const reserve = Math.max(0, this.getPowerTokenReserve(game, player) - refillAllowance);
        return remainingTokens >= reserve;
    }

    private static findEssentialConversions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const p3 = player.power3 ?? 0;
        const res: BotAction[] = [];
        const isTaklons = player.faction === 'taklons';

        // 자원 상황이 정말 좋지 않을 때만 후보에 추가 (MCTS 탐색 공간 낭비 방지). 타클론은 브레인 스톤 우선 사용.
        // 네뷸라 의회: 같은 2토큰으로 1O+1C를 주는 변환을 써서 1C 낭비 방지 (사용자 관찰)
        const hasNevlasPI = player.faction === 'nevlas' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
        const can3pOre = isTaklons
            ? canSpendTaklonsPowerWithoutBrain(player, 3, 3) || canTaklonsSpendUsingBrain(player, 3, 3)
            : (hasNevlasPI ? p3 >= 2 : p3 >= 3);
        if (can3pOre && (player.ore ?? 0) < 2) {
            const useBrain = isTaklons && canTaklonsSpendUsingBrain(player, 3, 3) && !canSpendTaklonsPowerWithoutBrain(player, 3, 3);
            const oreType = hasNevlasPI ? '2power-to-1ore-1credit' : '3power-to-1ore';
            res.push({ type: 'convert_resource', params: { type: oreType, useBrain } });
        }
        if (p3 >= 1 && (player.credits ?? 0) < 2) res.push({ type: 'convert_resource', params: { type: '1power-to-1credit', useBrain: isTaklons } });
        const can4pQic = isTaklons
            ? canSpendTaklonsPowerWithoutBrain(player, 3, 4) || canTaklonsSpendUsingBrain(player, 3, 4)
            : p3 >= 4;
        if (can4pQic && (player.qic ?? 0) < 1) {
            const useBrain = isTaklons && canTaklonsSpendUsingBrain(player, 3, 4) && !canSpendTaklonsPowerWithoutBrain(player, 3, 4);
            res.push({ type: 'convert_resource', params: { type: '4power-to-1qic', useBrain } });
        }

        return res;
    }

    /** [flag: powerActionValue] 아직 입장 안 한 우주선에서 '지금 자원으로 쓸 수 있는 최고 액션' 추정 가치.
     *  입장 가치를 이 값으로 산정해, 효율 좋은 우주선은 적극 입장하되 쓸 액션 없는 우주선은 안 타게(−5VP 낭비 방지). */
    private static estimateBestShipActionValue(player: PlayerState, shipType: string, hasTS: boolean, hasMine: boolean, playerId?: string): number {
        const q = player.qic || 0, o = player.ore || 0, c = player.credits || 0, k = player.knowledge || 0, p3 = player.power3 || 0, gf = player.gaiaformers || 0;
        let best = 0;
        if (shipType === 'ship_twilight') {
            best = 230;
            if (q >= 3) best = Math.max(best, 350);
            if (o >= 2 && p3 >= 3 && hasTS) best = Math.max(best, 420);
            if (k >= 1) best = Math.max(best, 450);
        } else if (shipType === 'ship_rebellion') {
            // [flag: rebelEntryBridge] 사용자 관찰(2026-07-12): 리벨 인접 + 2Q+2K인데 미탑승 — 탑승 후
            // #3 브리지(2K→1Q2C) 또는 번+4P→1Q 체인(rebellionBurnQic)으로 3Q가 완성되는 라인인데 입장
            // 가치가 지갑 q>=3만 380으로 봄. 가장 강한 브리지 1개까지 유효Q에 포함(보수적 — 이중 합산 금지).
            const bridge1 = (playerId && getPlayerFlag(playerId, 'rebelEntryBridge', false)
                && (k >= 2 || (p3 + Math.floor((player.power2 || 0) / 2)) >= 4)) ? 1 : 0;
            best = (q + bridge1) >= 3 ? 380 : 250;
            if (o >= 1 && p3 >= 3 && hasMine) best = Math.max(best, 300);
        } else if (shipType === 'ship_tf_mars') {
            best = q >= 2 ? 320 : 200;
            if (p3 >= 2 && gf > 0) best = Math.max(best, 340);
            if (c >= 3) best = Math.max(best, 380);
        } else if (shipType === 'ship_eclipse') {
            best = q >= 2 ? 300 : 200;
            if (k >= 2 && p3 >= 3) best = Math.max(best, 330);
            if (c >= 6) best = Math.max(best, 450);
        }
        return best;
    }

    private static findSpaceshipEntryActions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const round = game.roundNumber;
        if (game.hasDoneMainAction) return [];

        const entered = player.spaceshipsEntered || [];
        if (entered.length >= 3) return [];

        // [flag: shipEntryGate] 데이터 분석 결과 우주선 입장의 66%가 액션 없이 -5VP만 날림(순손실).
        // "타고서 안 쓰는" 패턴을 후보 생성 단계에서 차단한다.
        if (getPlayerFlag(playerId, 'shipEntryGate', false)) {
            // 1) 마지막 라운드(6)엔 입장 금지: 액션 쓸 턴이 없어 사실상 -5VP 순손실.
            if (round >= 6) return [];
            // 2) 이미 탑승했지만 액션을 하나도 안 쓴 우주선이 있으면 추가 탑승 금지(미사용 우주선 적재 방지).
            const hasUnusedShip = entered.some(id => {
                const st = game.spaceships?.[id];
                return (st?.usedActionIndices?.length ?? 0) < 1;
            });
            if (hasUnusedShip) return [];
        }

        const shipTiles = game.map.filter(t => ['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'].includes(t.type || ''));
        const candidates: { action: BotAction; score: number }[] = [];

        const baseRange = this.getEffectiveBaseRange(player);
        const qic = player.qic || 0;

        const myPlanets = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) ||
            (t.spaceStation && (t.spaceStation as any).ownerId === playerId)
        );

        for (const tile of shipTiles) {
            if (entered.includes(tile.id)) continue;

            const shipState = game.spaceships?.[tile.id];
            const entryCost = player.faction === 'bal_tak' ? 7 : 5;
            if ((player.score || 0) < entryCost) continue;

            // Faction specific cost (Itars/Nevlas)
            if (['itars', 'nevlas'].includes(player.faction || '')) {
                if ((player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0) < 1) continue;
            }

            const minDist = Math.min(...myPlanets.map(p => getDistance(p, tile)));
            const neededQic = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
            // [flag: balTakShipQic] 발타크 입장 거리 QIC를 포머 변환으로 충당(부족분 preActions는 아래 act에서)
            const balTakEntry = player.faction === 'bal_tak' && getPlayerFlag(playerId, 'balTakShipQic', true);
            if (neededQic > (balTakEntry ? this.getAvailableQic(player) : qic)) continue;
            // [flag: rebelEntryFareGuard] 사용자 관찰(2026-07-12): 3Q(3정큐 스택)를 원거리 리벨리온 입장비로
            // 전소 — 도착 즉시 잔여 0Q라 탑승 목적(3Q→기술타일)이 사망. QIC 예약(③)은 건설만 막고 입장비는
            // 안 막던 구멍. 입장비 2Q+ 이고 입장 후 잔여 <3Q면 3Q엔진 배(#1 미사용 리벨/타이밍된 트와) 입장
            // 후보 제외 — 1Q 입장은 탑승 후 2K→1Q 브리지로 복구 가능해 허용.
            // [flag: shipEntryFloor] R4+에 아직 2척 미만이면 3Q 라인 보호보다 입장 자체(사용자 목표 "못해도 2척")가
            // 우선 — 초반(R1-3)은 기존 가드 유지(3Q 전소 방지의 핵심 구간).
            const fareFloorBypass = getPlayerFlag(playerId, 'shipEntryFloor', true)
                && (player.spaceshipsEntered ?? []).length < 2 && (game.roundNumber ?? 1) >= 4
                && (game.botPlayerIds?.length ?? 0) < Object.keys(game.players).length; // 사람게임 한정(curse 12호)
            if (getPlayerFlag(playerId, 'rebelEntryFareGuard', true) && neededQic >= 2 && (qic - neededQic) < 3
                && !fareFloorBypass) {
                const isEngineShip = tile.type === 'ship_rebellion'
                    || (tile.type === 'ship_twilight' && this.twilightTimingOk(game, player));
                if (isEngineShip && !(game.spaceships?.[tile.id]?.usedActionIndices || []).includes(1)) continue;
            }

            // 기존 200(의회급)은 명시적 과보정이라 봇이 우주선에 과탑승 → 확장(광산) 메인액션 잠식
            // → 연방/연구 미달성의 한 원인이었다. head2head에서 낮출수록 +방향(우주선 입장의 66%가 미사용).
            // 과보정을 정상화(200→80). shipLowPriority 플래그로 더 공격적(40) 실험 가능.
            let score: number;
            if (getPlayerFlag(playerId, 'shipEntryByAction', true)) {
                // [사용자] 우주선 액션은 본판 파워액션보다 효율↑ → 입장 가치를 '그 우주선에서 쓸 최고 액션'으로 산정.
                // 좋은 액션 있으면 적극 입장(본판 파워액션 이김), 없으면 낮게(타고 안 쓰는 -5VP 낭비 방지).
                if (round >= 6) continue; // 막판 입장은 액션 쓸 턴이 없어 순손실
                const hasUnusedShip = entered.some(id => ((game.spaceships?.[id]?.usedActionIndices?.length ?? 0) < 1));
                // [flag: shipEntryFloor] 사용자 목표(2026-07-14): "못해도 2척, 왠만하면 3척". 실게임에서 1척 고정
                // 봇 증가(7/12~: 12석 중 4석 등) — 사람이 공유 액션을 선점하면 봇의 첫 배가 '미사용'으로 남아
                // 이 게이트에 계속 걸리는 구조(셀프플레이엔 없는 사람게임 패턴). 2척 미만이면 적재방지 게이트 면제.
                // [120판 curse 12호] 셀프플레이 40판 +6.89 유의 → 120판 −1.36·승률 39.3% 유의 음수 반전. 셀프플레이(입장
                // 2.3, 병목 부재)에선 억지 2척째가 낭비 — 병목(사람 선점→미사용 고착)이 있는 사람 게임에서만 발동.
                const entryFloor = getPlayerFlag(playerId, 'shipEntryFloor', true) && entered.length < 2
                    && (game.botPlayerIds?.length ?? 0) < Object.keys(game.players).length;
                if (hasUnusedShip && !entryFloor) continue; // 이미 안 쓴 우주선 있으면 추가 입장 금지(적재 방지)
                const hasTS = game.map.some(t => t.ownerId === playerId && t.structure === 'trading_station');
                const hasMine = game.map.some(t => t.ownerId === playerId && t.structure === 'mine');
                let best = this.estimateBestShipActionValue(player, tile.type || '', hasTS, hasMine, playerId);
                const occupantsP = shipState?.occupants?.length || 0;
                // [flag: shipEntryOption] 사용자 모델(2026-07-07): 우주선은 "지금 못 써도" 들어간다 — ①다음 라운드
                // 수입으로 열리는 액션의 선점 옵션가치 ②입장 순번 충전(2·3번째 +2pw, 4번째 +3pw). 기존엔 현재 자원
                // 기준 즉시가치만 매겨 '쓸 수 있을 때만' 입장하던 것 교정.
                if (getPlayerFlag(playerId, 'shipEntryOption', true) && round <= 5) {
                    const inc = this.calculateExpectedRoundIncome(game, playerId);
                    const proj = {
                        ...player,
                        ore: (player.ore || 0) + (inc.ore || 0),
                        credits: (player.credits || 0) + (inc.credits || 0),
                        knowledge: (player.knowledge || 0) + (inc.knowledge || 0),
                        qic: (player.qic || 0) + (inc.qic || 0),
                        power3: (player.power3 || 0) + Math.min(4, inc.powerCharge || 0),
                    } as PlayerState;
                    const bestNext = this.estimateBestShipActionValue(proj, tile.type || '', hasTS, hasMine, playerId);
                    best = Math.max(best, bestNext * 0.75); // 다음 라운드 사용은 선점 이득 포함 0.75 할인
                    const chargeAmt = occupantsP >= 3 ? 3 : occupantsP >= 1 ? 2 : 0;
                    score = 50 + best * 0.5 + chargeAmt * 12; // 실제 충전량 비례
                } else {
                    score = 50 + best * 0.5; // 입장은 다음 턴 사용 + -5VP라 액션가치의 절반 반영
                    if (occupantsP >= 1) score += 20; // 동반 입장 파워 충전 가산
                }

                // [flag: shipTechEntryValue] 우주선이 주는 '기술타일' 가치를 입장 결정에 반영.
                // 데이터(사람 vs 봇 좌석당): Nav+1 획득 4.59 vs 0.09(50배!), Rebellion 관여 3.71 vs 0.70(5배).
                // 원인: 입장가치를 estimateBestShipActionValue(액션)으로만 매겨 → Rebellion이 주는 Nav+1(영구 +사거리)
                // 가치가 0 → Twilight/Eclipse에 밀려 안 탐. Nav+1은 봇 최대약점(확장·QIC낭비를 사거리 부족이 유발) 직격.
                if (getPlayerFlag(playerId, 'shipTechEntryValue', false)) {
                    const techId = (game.shipTechByShip ?? SHIP_TECH_BY_SHIP)[tile.type || ''];
                    if (techId && !(player.techTiles ?? []).includes(techId) && (game.shipTechPool?.[techId] ?? 1) > 0) {
                        let tv = 0;
                        if (techId === 'ship-tech-nav+1') {
                            // 영구 +1 사거리: 확장기(구조물<9·초중반)일수록 매우 큼. nav연구 1레벨(navExpandEval ~130)에 준함.
                            tv = (round <= 4 && myPlanets.length < 9) ? 170 : 100;
                        } else if (techId === 'ship-tech-1o3k') {
                            tv = 70;  // 1 ore + 3 knowledge 즉시 (지식=연구 병목 연료)
                        } else if (techId === 'ship-tech-2tf-mine') {
                            tv = 90;  // 2 테라폼 + 무료 광산 (확장)
                        }
                        score += tv * 0.5; // 입장→액션으로 다음 턴 획득 → 액션가치와 동일하게 절반 반영
                    }
                }
            } else {
                score = getPlayerFlag(playerId, 'shipLowPriority', false) ? 40 : 80;
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
                // [flag: twilightArtifactEntry] Twilight = 인공물(6토큰→VP) 접근처인데 입장가치가 0이라 봇이 안 타 인공물을 못 먹음.
                //   좋은 인공물 있고 토큰 4+(6 근처)면 입장 우대. 특히 Ivits는 연방이 QIC 소모라 토큰 쓸 곳이 인공물뿐 → 강하게
                //   (안 그럼 gain-2-tokens로 토큰만 쌓고 안 씀, 사용자관찰). 취득은 입장 후 findTwilightArtifactActions가 처리.
                if (tile.type === 'ship_twilight' && getPlayerFlag(playerId, 'twilightArtifactEntry', true)) {
                    const totalPow = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);
                    const slotsOpen = (game.twilightArtifactSlots ?? []).some(s => s != null);
                    if (slotsOpen && totalPow >= 4 && this.getBestArtifactId(game, playerId) != null) {
                        score += player.faction === 'ivits' ? 120 : 55;
                    }
                }
            }

            // [flag: r1ShipPriority] 사람은 R1에 95% 우주선 탑승(봇 58%는 게임 내내 아예 안 탐 — 35로그+자가대국 확인).
            // 입장 점수(50+best*0.5)가 빌드(~300)보다 낮아 후순위로 밀려 봇이 우주선을 안 탐 → R1-2엔 입장을
            // 빌드와 경쟁하게 부스트. 특히 Rebellion(Nav+1=영구 +사거리=봇 reach 약점 직격, 사용자 "거의 이기는 액션")
            // 과 미보유 기술타일 우주선을 강하게. self-play는 contention 못 재현하니 boarding률 검증 + VP는 1:3로 판정.
            if (getPlayerFlag(playerId, 'r1ShipPriority', true) && round <= 2) {
                score += 180; // 입장을 빌드와 경쟁권으로
                const techId = (game.shipTechByShip ?? SHIP_TECH_BY_SHIP)[tile.type || ''];
                if (techId && !(player.techTiles ?? []).includes(techId) && (game.shipTechPool?.[techId] ?? 1) > 0) {
                    score += (techId === 'ship-tech-nav+1') ? 90 : 50; // Nav+1(reach 직격) 최우선, 기타 기술타일도 가산
                }
            }

            // [사용자 관찰] 입장 순서 충전(2·3번째 +2PW, 4번째 +3PW, executeEnterSpaceship)이 bowl 수용량 부족으로
            // 버려지면 bowl3 먼저 비워 수용량 확보. itars/nevlas는 입장 시 토큰 1개를 선소모해 bowl 상태가 바뀌어
            // chargeDrainPreActions 모델(strictly dominant 보장)이 어긋나므로 제외.
            const myIdx = (shipState?.occupants?.length ?? 0) + 1;
            const entryCharge = (myIdx === 2 || myIdx === 3) ? 2 : (myIdx === 4 ? 3 : 0);
            const entryDrain = ['itars', 'nevlas'].includes(player.faction || '') ? [] : this.chargeDrainPreActions(playerId, player, entryCharge);
            // [flag: balTakShipQic] 지갑 부족분은 포머→QIC 변환을 먼저 실행(서버 executeEnterSpaceship은 지갑만 차감)
            const balTakEntryPres = (player.faction === 'bal_tak' && getPlayerFlag(playerId, 'balTakShipQic', true))
                ? this.balTakGaiaformerPreActionsForQicShortfall(player, qic, neededQic) : [];
            const entryPres = [...balTakEntryPres, ...entryDrain];
            const act: BotAction = entryPres.length
                ? { type: 'enter_spaceship', params: { tileId: tile.id, qicToUse: neededQic }, preActions: entryPres }
                : { type: 'enter_spaceship', params: { tileId: tile.id, qicToUse: neededQic } };
            // 서버 규칙 기준으로 실제 성공하는 후보만 남김 (점수/토큰/사거리 등 누락 방지)
            // note: 후보 생성은 sync이므로, 여기서는 "가능성 높은 것"만 일단 모으고 아래에서 한번에 필터링
            // 서버 executeEnterSpaceship 기준으로 불가능한 후보는 애초에 넣지 않음
            if (!this.canEnterSpaceship(game, playerId, tile.id, neededQic)) continue;
            candidates.push({ action: act, score });
        }

        if (candidates.length === 0) return [];
        candidates.sort((a, b) => b.score - a.score);

        return candidates.slice(0, 5).map(c => c.action);
    }

    /** 우주선 액션 목록 (상위 3개 반환) */
    private static findSpaceshipActions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const entered = player.spaceshipsEntered || [];
        if (entered.length === 0 || game.hasDoneMainAction) return [];
        const round = game.roundNumber;

        const candidates: { action: BotAction; score: number }[] = [];

        // [flag: shipActionDiag] 계측(기본 OFF, 순수 로깅): 입장한 우주선의 안 쓴 각 액션이 자원충족(ELIG)인지
        //   자원부족 탈락(BLK:<자원>)인지 게임파일 로그. 실사용(저널)과 대조해 '자원부족' vs '있는데 미선택' 판별.
        if (getPlayerFlag(playerId, 'shipActionDiag', false) && !game.simulation) {
            const parts: string[] = [];
            for (const shipId of entered) {
                const st = game.spaceships?.[shipId]; const tl = game.map.find(t => t.id === shipId);
                if (!st || !tl) continue;
                const used = st.usedActionIndices || [];
                for (let i = 1; i <= 3; i++) {
                    if (used.includes(i)) continue;
                    const s = this.shipActionStatus(game, playerId, tl.type || '', i);
                    parts.push(`${(tl.type || '').replace('ship_', '')}#${i}=${s}`);
                }
            }
            if (parts.length) log(`[SHIPDIAG] R${round} ${playerId} ${parts.join(' ')}`, 'shipdiag', game.id);
        }

        // [flag: balTakShipQic] 발타크 유효 QIC = 지갑 + 미사용 포머(무료 변환) — QIC 우주선 액션(리벨리온
        // 3정큐=기술타일 등)을 포머 변환으로 지불하는 콤보가 후보에 없던 갭(사용자 지적). 부족분만 변환 preActions.
        const balTakShip = player.faction === 'bal_tak' && getPlayerFlag(playerId, 'balTakShipQic', true);
        // [flag: hhJitConvert] HH도 크레딧 즉석 변환분을 유효 QIC로(3정큐 등) — 부족분은 preActions로 쓰기 직전 변환
        const effShipQic = balTakShip ? this.getAvailableQic(player)
            : (player.qic || 0) + this.hhConvertibleQic(game, playerId, 3);
        const shipQicAction = (shipId: string, i: number, qicCost: number): BotAction => {
            const pres = balTakShip ? this.balTakGaiaformerPreActionsForQicShortfall(player, player.qic || 0, qicCost)
                : this.hhConvertPreActionsForQicShortfall(game, playerId, player.qic || 0, qicCost, 3);
            return pres.length
                ? { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i }, preActions: pres }
                : { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
        };
        // [flag: shipActionBurn] R1 실측(사람 196석 vs 봇 72석): 우주선 액션 사람 1.30 vs 봇 0.25 — 입장은 동수인데
        // p3>=3 게이트를 현재값으로만 체크해 R1 봇(p3=0)은 후보 자체가 안 생김. 사람은 bowl2를 번(2토큰→1P3)해서
        // 할인 액션(Twilight TS→랩 2O3P 등)을 씀. 파워액션 번 콤보(3163)의 우주선판 — 부족분만큼 번 preActions.
        // [v2] 전면 적용은 −4.14(후반 번 = 파워순환 손실 > 할인이득). 사람 패턴대로 R1-2 한정 + 번 후에도
        // bowl2에 토큰 2+ 남을 때만(파워경제 보존). 대상도 엔진 업글형(TS→랩·광산→TS)만 — 아래 각 사이트에서 shipBurnOk로.
        const shipBurn = getPlayerFlag(playerId, 'shipActionBurn', false) && player.faction !== 'taklons'
            && (game.roundNumber ?? 1) <= 2;
        const p3Now = player.power3 || 0;
        const burnableP3 = Math.max(0, Math.floor(((player.power2 || 0) - 2) / 2)); // bowl2 예비 2 남김
        const p3Eff = shipBurn ? p3Now + burnableP3 : p3Now;
        const burnPres = (need: number): BotAction[] => {
            const n = shipBurn ? Math.max(0, need - p3Now) : 0;
            return n > 0 ? Array.from({ length: n }, () => ({ type: 'burn_power' as const, params: {} })) : [];
        };

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
                    if (i === 1 && effShipQic >= 3
                        && !(getPlayerFlag(playerId, 'twilightQicPlan', true) && !this.twilightTimingOk(game, player))) {
                        // [flag: twilightQicPlan v2] 사용자 룰: 재수령은 R4+ 또는 기술연방 후 — 그 전엔 후보 제외(3Q 아낌)
                        score = 350; // 연방 보상 → 매우 강력
                        action = shipQicAction(shipId, i, 3);
                    } else if (i === 1 && (player.qic || 0) >= 0) {
                        score = 230;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && (player.ore || 0) >= 2 && p3Eff >= 3) {
                        const ts = game.map.find(t => t.ownerId === playerId && t.structure === 'trading_station');
                        if (ts) {
                            score = 420; // 2O+3P → TS→Lab: 가이아 프로젝트 파워 액션 중 최상급 (연구소+기술타일 선점)
                            const pres = burnPres(3);
                            action = pres.length
                                ? { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i, targetTileId: ts.id }, preActions: pres }
                                : { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i, targetTileId: ts.id } };
                        }
                    } else if (i === 3) {
                        // 트왈라잇 1지식 → +3 Range(tempRangeBonus). 단, 그 사거리가 '실제로 새 대상을 여는' 경우만 켠다.
                        // 아니면 1K만 버리고 엉뚱한 액션을 하는 낭비(사용자 관찰) → 낮은 점수로 사실상 비활성.
                        const rangeHelps = (player.knowledge || 0) >= 1 && !player.tempRangeBonus
                            && this.rangeBoosterUnlocksTarget(game, playerId, 'tempRangeBonus');
                        score = rangeHelps ? 450 : 0;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    }
                } else if (shipTile.type === 'ship_rebellion') {
                    if (i === 1 && effShipQic >= 3) {
                        score = 380; // 기술 타일 획득: 최강 액션
                        action = shipQicAction(shipId, i, 3);
                    } else if (i === 1 && getPlayerFlag(playerId, 'rebellionBurnQic', true)
                        && player.faction !== 'taklons' && (player.qic || 0) === 2
                        && ((player.power3 || 0) + Math.floor((player.power2 || 0) / 2)) >= 4) {
                        // [flag: rebellionBurnQic] 사용자 룰(2026-07-11): QIC 2 + 번(≤2)로 4P 만들어 4P→1Q 변환
                        // → 3정큐(기술타일) 완성은 번 2개 값을 하는 예외적 보상 — 이 체인만 정밀 허용.
                        const burnsNeeded = Math.max(0, 4 - (player.power3 || 0));
                        if (burnsNeeded <= 2) {
                            score = 375;
                            const chainPres: BotAction[] = [
                                ...Array.from({ length: burnsNeeded }, () => ({ type: 'burn_power' as const, params: {} })),
                                { type: 'convert_resource' as const, params: { type: '4power-to-1qic' } },
                            ];
                            action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i }, preActions: chainPres };
                        }
                    } else if (i === 1) {
                        score = 250;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && (player.ore || 0) >= 1 && p3Eff >= 3) {
                        // [noFedTierUp] 리벨리온 mine→TS도 연방 우회 경로였음(사용자 관찰: 연방 광산을 이 액션으로 올림).
                        //   findUpgradeActions/할인경로처럼 비연방 광산 우선, noFedTierUp ON이면 연방 광산엔 폴백 안 함
                        //   (비연방 광산 없으면 이 액션 스킵 → 다른 우주선 액션/행동으로 연방 씨앗 보존).
                        // [광산 선택 — 사용자 룰] 이 액션은 비용이 고정(1O+3P)이라 할인(2/3) 여부와 무관.
                        //   일반 업글은 싼 2/3 자리를 쓰지만, 리벨리온 액션은 오히려 비싼 2/6(비할인) 자리에 써서
                        //   싼 2/3 자리는 일반 업글용으로 아껴야 이득 → 비연방 중 비할인 광산을 우선한다.
                        // [flag: rebellionMineSelect] 이 리벨리온 mine→TS 선택 개선 전체를 측정 가능하게 게이트(기본 ON).
                        //   OFF면 구 동작(맵 순서 첫 광산, 연방 미고려). strengthTrack BASELINE_OFF에 추가해 Δ 측정.
                        let mine;
                        if (getPlayerFlag(playerId, 'rebellionMineSelect', true)) {
                            const fedHexes: string[] = (game as any).playerFederationHexes?.[playerId] || [];
                            const noFedTierUp = getPlayerFlag(playerId, 'noFedTierUp', true);
                            const mines = game.map
                                .filter(t => t.ownerId === playerId && t.structure === 'mine')
                                .filter(t => !noFedTierUp || !fedHexes.includes(t.id));
                            // 비연방 우선 → 폴백(noFedTierUp OFF면 연방 포함 전체)
                            const nonFed = mines.filter(t => !fedHexes.includes(t.id));
                            const pool = nonFed.length ? nonFed : mines;
                            // 후보 광산 점수화(사용자 룰): ①비할인(2/6) 우선(싼 2/3은 일반업글용으로 아낌) ②인접 내건물=군집/연방연결
                            //   ③업글로 연방이 새로 열리거나 더 적은 위성으로 가능해지는 광산 우선. ③은 풀 클론+플래너라 비싸 !simulation에서만.
                            mine = pool[0];
                            if (pool.length > 1) {
                                const noSim = !game.simulation;
                                const baseFed = noSim ? this.getBestFederationSpentTokens(game, playerId) : null;
                                let best = -Infinity;
                                for (const t of pool) {
                                    let s = 0;
                                    if (!hasNearbyPlayersForDiscount(game, t, playerId)) s += 120; // 비할인(2/6) 우선
                                    s += this.calculateAdjacencyBonus(game, playerId, t);           // 인접 내건물=군집/연방 연결
                                    if (noSim) {
                                        const after = this.getBestFederationSpentTokensAfterUpgrade(game, playerId, t.id, 'trading_station');
                                        if (baseFed == null && after != null) s += 400;             // 이 업글로 연방이 새로 열림
                                        else if (baseFed != null && after != null && after < baseFed) s += Math.min(250, (baseFed - after) * 90); // 위성 절감폭만큼
                                    }
                                    if (s > best) { best = s; mine = t; }
                                }
                            }
                        } else {
                            // 구 동작: 맵 순서상 첫 광산(연방·2/6 미고려)
                            mine = game.map.find(t => t.ownerId === playerId && t.structure === 'mine');
                        }
                        if (mine) {
                            score = 300; // Mine -> TS 업그레이드
                            const presReb = burnPres(3);
                            action = presReb.length
                                ? { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i, targetTileId: mine.id }, preActions: presReb }
                                : { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i, targetTileId: mine.id } };
                        }
                    } else if (i === 3 && (player.knowledge || 0) >= 2) {
                        score = 250; // 2K -> 1Q 2C
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 3) {
                        score = 180;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    }
                } else if (shipTile.type === 'ship_tf_mars') {
                    if (i === 1 && effShipQic >= 2) {
                        // TF Mars 1 = (기술타일수 + 2) VP. [flag: qicVpGate] 실제 VP로 평가: ≥6 또는 R6일 때만 적극,
                        // 아니면 거의 비활성(초반 ~4VP짜리 일찍 하지 말고 QIC를 확장에 쓰게). 사용자 규칙.
                        if (getPlayerFlag(playerId, 'qicVpGate', true)) {
                            const vp = (player.techTiles?.length ?? 0) + 2;
                            // 초반 저VP(<6, R6 아님)면 후보에서 완전 제외(0). 25는 '낮은 점수'일 뿐 후보로 남아
                            // MCTS가 즉시 VP 보고 집어 R2에도 눌리던 문제(사용자 관찰) → 0이면 score>0 가드에서 제외됨.
                            score = (vp >= 6 || round === 6) ? 240 + vp * 10 : 0;
                        } else {
                            score = 320; // QIC 기술 타일: 매우 강력
                        }
                        action = shipQicAction(shipId, i, 2);
                    } else if (i === 1) {
                        score = 200;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && (player.power3 || 0) >= 2 && (player.gaiaformers || 0) > 0) {
                        score = 340; // 가이아 프로젝트 (v2: 번 콤보는 엔진 업글형에만 — 여기는 제외)
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 3 && (player.credits || 0) >= 3) {
                        score = 380; // 3C -> 1TF: 테라포밍 효율적, 확장에 최고
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    }
                } else if (shipTile.type === 'ship_eclipse') {
                    if (i === 1 && effShipQic >= 2) {
                        // Eclipse 1 = (행성유형수 + 2) VP. [flag: qicVpGate] 실제 VP로 평가: ≥6 또는 R6일 때만 적극,
                        // 아니면 거의 비활성(초반 QIC는 확장에). 사용자 규칙.
                        if (getPlayerFlag(playerId, 'qicVpGate', true)) {
                            // 정식 행성유형 집합(lost_planet·가상광산 포함) — naive 계산은 누락해 과소평가했음(서버 Eclipse 수정과 동일).
                            const vp = getPlayerPlanetTypesForGeodens(game, playerId).size + 2;
                            // 초반 저VP면 후보 완전 제외(0) — qicVpGate가 점수만 깎고 안 막던 버그 수정(사용자 관찰: R2에도 누름).
                            score = (vp >= 6 || round === 6) ? 220 + vp * 10 : 0;
                        } else {
                            score = 300; // QIC 기술/연방
                        }
                        action = shipQicAction(shipId, i, 2);
                    } else if (i === 1) {
                        score = 200;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && (player.knowledge || 0) >= 2 && (player.power3 || 0) >= 3) {
                        score = 330; // 연구 전진 (v2: 번 콤보는 엔진 업글형에만 — 여기는 제외)
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 2 && (player.knowledge || 0) >= 2) {
                        score = 230;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 3 && (player.credits || 0) >= 6) {
                        // [사용자 피드백] 이클립스 소행성 파괴(6C) 광산 건설을 안 하고 패스하는 현상을 막기 위해 점수 극한 상향
                        score = 450;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    } else if (i === 3 && (player.credits || 0) >= 3) {
                        score = 200;
                        action = { type: 'use_ship_action', params: { shipTileId: shipId, actionIndex: i } };
                    }
                }

                // [사용자 전략 2026-06-15] 자원 밸런싱: 돈 부족하면 자원생성 액션 우선, 돈 남으면 소비(확장) 액션 우선.
                // 네뷸라 등 자원말림→조기패스 + 크레딧 쟁여두기(참사봇 12-13크레딧 방치)를 동시 교정.
                if (score > 0 && getPlayerFlag(playerId, 'shipResourceBalance', true)) {
                    const credits = player.credits || 0;
                    const broke = credits < 4, rich = credits > 10;
                    const t = shipTile.type;
                    // 자원 생성형: 리벨 2k→1qic+2c(i3)·광산→교역소(i2), 트왈 2o3p→연구소(i2)
                    const isGen = (t === 'ship_rebellion' && (i === 2 || i === 3)) || (t === 'ship_twilight' && i === 2);
                    // 소비-확장형: TF마스 3c→1step(i3), 이클립스 6c→소행성(i3)
                    const isSpend = (t === 'ship_tf_mars' && i === 3) || (t === 'ship_eclipse' && i === 3);
                    if (broke && isGen) score += 130;   // 돈 없을 때 자원 생성 강력 우선(패스 대신 충전)
                    else if (rich && isSpend) score += 90; // 돈 남을 때 소비-확장 우선(쟁여두기 방지)
                    else if (broke && isSpend) score -= 70; // 돈 없는데 소비는 후순위
                }

                // 라운드 후반일수록 우주선 액션 가치 증가 (남은 기회가 적으므로)
                if (score > 0) score += round * 5;

                if (action && score > 0) {
                    // 서버 executeUseShipAction 기준으로 불가능한 후보는 애초에 넣지 않음
                    const p = (action as any).params || {};
                    const ok = this.canUseShipAction(game, playerId, p.shipTileId, p.actionIndex, p.targetTileId);
                    if (ok) candidates.push({ action, score });
                }
            }
        }

        if (candidates.length === 0) return [];
        candidates.sort((a, b) => b.score - a.score);

        return candidates.slice(0, 5).map(c => c.action);
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
            const score = this.calculateArtifactScore(game, playerId, artifactId);
            if (score > bestScore) {
                bestScore = score;
                bestArtifact = artifactId;
            }
        }
        return bestScore > 80 ? bestArtifact : null;
    }

    private static calculateTwilightFederationRewardScore(game: ServerGameState, playerId: string): number {
        const bestRewardId = this.getBestTwilightFederationRewardId(game, playerId);
        return bestRewardId ? this.calculateTwilightFederationRewardScoreForId(game, bestRewardId, playerId) : 0;
    }

    private static getBestTwilightFederationRewardId(game: ServerGameState, playerId: string): string | null {
        const player = game.players[playerId];
        if (!player) return null;

        let bestRewardId: string | null = null;
        let bestScore = 0;
        for (const fed of getFederationEntries(player)) {
            const score = this.calculateTwilightFederationRewardScoreForId(game, fed.rewardId, playerId);
            if (score > bestScore) {
                bestScore = score;
                bestRewardId = fed.rewardId;
            }
        }

        return bestRewardId;
    }

    private static calculateTwilightFederationRewardScoreForId(game: ServerGameState, rewardId: string, playerId?: string): number {
        const normalReward = FEDERATION_REWARDS.find(r => r.id === rewardId)
            || (rewardId === GLEENS_FEDERATION_REWARD.id ? GLEENS_FEDERATION_REWARD : undefined);
        const shipReward = SPACESHIP_FEDERATION_REWARDS.find(r => r.id === rewardId);

        let score = 0;
        if (normalReward) {
            const reward = normalReward as any;
            // [flag: twilightVpLate] 사용자 관찰(2026-07-14): 12VP 보상은 사람은 R6 아니면 잘 안 집는데 봇이
            // 재수령에서 너무 일찍 가져감 — 12×18=216이 R1부터 자원 보상(~100-180, 복리)을 압도하던 것.
            // 순수 VP형(자원 없음)은 R4까지 ×8로 할인(자원 보상이 이기게), R5+엔 원래 가중(막판 VP 우위) 복귀.
            const pureVp = (reward.vp ?? 0) > 0 && !(reward.ore || reward.credits || reward.knowledge || reward.qic || reward.powerTokens);
            const vpLate = playerId ? getPlayerFlag(playerId, 'twilightVpLate', false) : false;
            const vpW = game.roundNumber >= 5 ? 24 : (pureVp && vpLate ? 8 : 18);
            score += (reward.vp ?? 0) * vpW;
            score += (reward.ore ?? 0) * 28;
            score += (reward.credits ?? 0) * 7;
            score += (reward.knowledge ?? 0) * 24;
            score += (reward.qic ?? 0) * 42;
            score += (reward.powerTokens ?? 0) * 28;
        } else if (shipReward) {
            const reward = shipReward as any;
            score += (reward.vp ?? 0) * (game.roundNumber >= 5 ? 24 : 18);
            if (rewardId === 'ship-fed-tech') score += game.roundNumber <= 4 ? 260 : 160;
            if (rewardId === 'ship-fed-4vp4k') score += 4 * 24;
            if (rewardId === 'ship-fed-4vp1q2o') score += 42 + 2 * 28;
            if (rewardId === 'ship-fed-8vp8c') score += 8 * 7;
            if (rewardId === 'ship-fed-7vp3p2t') score += 3 * 18 + 2 * 28;
            // [룰수정 2026-07-15] 사용자 관찰: 3TF 무료광산 보상을 받고 안 지음 — 닿는 건설 타깃이 0인데도
            // 고정 가산(+260)으로 집던 것. 무료광산 계열은 what-if(플래그+삽 임시 세팅 → 후보 실존)로 확인해
            // 타깃 0이면 가산 없이 다른 보상(VP/자원)이 이기게 한다(죽은 보상 회피, 5565행 ship-tech 동형).
            if (rewardId === 'ship-fed-mine-free' || rewardId === 'ship-fed-3tf-mine') {
                let mineUsable = true;
                const pRw = playerId ? game.players[playerId] : null;
                if (pRw) {
                    const oldFedFree = pRw.spaceshipFed3TfMineFree, oldTechFree = pRw.nextMineFreeFromShipTech;
                    const oldSteps = pRw.pendingTerraformSteps || 0;
                    if (rewardId === 'ship-fed-3tf-mine') { pRw.spaceshipFed3TfMineFree = true; pRw.pendingTerraformSteps = oldSteps + 3; }
                    else pRw.nextMineFreeFromShipTech = true;
                    mineUsable = this.findBuildActionsWithPendingSteps(game, playerId!).length > 0;
                    pRw.spaceshipFed3TfMineFree = oldFedFree; pRw.nextMineFreeFromShipTech = oldTechFree; pRw.pendingTerraformSteps = oldSteps;
                }
                if (mineUsable) {
                    if (rewardId === 'ship-fed-mine-free') score += game.roundNumber <= 4 ? 220 : 90;
                    else score += game.roundNumber <= 4 ? 260 : 110;
                }
            }
        }

        return score;
    }

    private static calculateArtifactScore(game: ServerGameState, playerId: string, artifactId: string): number {
        const player = game.players[playerId];
        if (!player) return 0;

        let score = 50;
        let vpNow: number | null = null; // 순수 VP형 인공물의 즉시 VP ([flag: artifactVpFloor] 판정용)
        if (artifactId === 'art-income-2p3') {
            // 매 수익마다 3그릇에 2토큰을 직접 넣어 주므로 초중반 최상위 인공물로 평가한다.
            score += game.roundNumber <= 2 ? 360 : game.roundNumber <= 3 ? 300 : game.roundNumber <= 4 ? 220 : game.roundNumber <= 5 ? 120 : 40;
        } else if (artifactId === 'art-fed-once') {
            const bestReward = this.calculateTwilightFederationRewardScore(game, playerId);
            score += bestReward > 0 ? 120 + bestReward : 0;
        } else if (artifactId === 'art-income-1k1o') {
            const remainingIncomeRounds = Math.max(0, 6 - (game.roundNumber ?? 1));
            score += remainingIncomeRounds * 70;
        } else if (artifactId === 'art-imm-2o5c' || artifactId === 'art-imm-3o3c') {
            score += game.roundNumber <= 3 ? 200 : 40;
        } else if (artifactId === 'art-imm-3k1q') {
            score += game.roundNumber <= 4 ? 180 : 50;
        } else if (artifactId === 'art-7vp-virtual-asteroid' || artifactId === 'art-7vp-virtual-proto') {
            score += 150;
        } else if (artifactId === 'art-vp-planet-types') {
            const structures = game.map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship');
            const types = new Set(structures.map(t => t.type).filter(x => x && x !== 'space' && x !== 'deep_space'));
            if (player.virtualMineAsteroid) types.add('asteroid');
            if (player.virtualMineProto) types.add('proto');
            vpNow = 3 + types.size;
            score += vpNow * (game.roundNumber >= 5 ? 24 : 12);
        } else if (artifactId === 'art-vp-bridge') {
            const bridgeSectors = [11, 12, 13, 14, 15, 16, 17, 18];
            const count = bridgeSectors.filter(s => game.map.some(t => t.sector === s && t.ownerId === playerId && t.structure)).length;
            vpNow = count * 3;
            score += vpNow * (game.roundNumber >= 5 ? 24 : 12);
        } else if (artifactId === 'art-vp-gaia') {
            vpNow = (player.research?.gaiaProject ?? 0) * 3;
            score += vpNow * (game.roundNumber >= 5 ? 24 : 12);
        } else if (artifactId === 'art-vp-science') {
            vpNow = (player.research?.science ?? 0) * 3;
            score += vpNow * (game.roundNumber >= 5 ? 24 : 12);
        } else if (artifactId === 'art-vp-tracks3') {
            const tracks = (['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'] as ResearchTrack[])
                .filter(t => (player.research?.[t] ?? 0) >= 3).length;
            vpNow = tracks * 3;
            score += vpNow * (game.roundNumber >= 5 ? 24 : 12);
        }

        // [flag: artifactVpFloor] 사용자 룰(2026-07-12): 순수 VP형 인공물은 6토큰(=위성 재료)을 태우므로
        // 9VP 이상을 노리거나 토큰이 정말 남아돌 때만 — 3VP짜리 타이밍에 집착해 위성을 전소하는 낭비 차단.
        // '남아돎' = 구매 후에도 토큰 10+ (연방 위성 5~7개 여유). 자원/수익형 인공물은 엔진 가치라 제외.
        if (vpNow != null && getPlayerFlag(playerId, 'artifactVpFloor', true)) {
            const totTok = (player.power1 ?? 0) + (player.power2 ?? 0) + (player.power3 ?? 0);
            if (vpNow < 9 && totTok - 6 < 10) return -1;
        }

        return score;
    }

    /** 인공물 획득 후보. 파워 6 미만이면 need=6-totalPower만큼 1O→1토큰 후보를 need~min(6,ore)까지 넣어 MCTS가 효율 판단. */
    /** [낭비수정] 그릇1→2→3 순으로 cost 파워를 즉시 소모하는 액션(인공물 take 등) 전에,
     *  소모로 그냥 제거될 bowl3 토큰을 1P→1C로 미리 환수하는 프리액션 목록을 만든다.
     *  bowl1+bowl2 < cost면 부족분만큼 bowl3가 소모되는데, 그 토큰을 먼저 환수하면 토큰은 bowl1로
     *  옮겨졌다가 어차피 소모되므로 최종 파워 상태는 동일하고 크레딧만 회수된다(strictly dominant).
     *  타클론은 브레인스톤 파워회계가 특수(토큰 1개=3파워)해 모델이 깨지므로 제외. */
    private static doomedBowl3CashoutPreActions(player: PlayerState, cost: number, playerId?: string, bowl1Extra = 0): BotAction[] {
        if (player.faction === 'taklons') return [];
        const p1 = (player.power1 ?? 0) + bowl1Extra, p2 = player.power2 ?? 0, p3 = player.power3 ?? 0;
        const doomed = Math.min(p3, Math.max(0, cost - p1 - p2));
        if (doomed <= 0) return [];
        // [flag: bowl3CashoutOre] 사용자 룰(2026-07-04): "소모될 bowl3는 반드시 변환으로 가치 회수, 단 캡(30C)으로
        // 변환 불가면 예외". ore 우선(3P→1O) → 나머지 1P→1C(크레딧 캡 가드 — 이전 gaiaformPreSpend −5.24의
        // 원인=캡/크레딧부자에 무가치 크레딧 변환). 캡으로 전부 막히면 빈 배열(그냥 소모 — 사용자 예외 그대로).
        if (playerId && getPlayerFlag(playerId, 'bowl3CashoutOre', true)) {
            const acts: BotAction[] = [];
            let rem = doomed;
            let oreRoom = Math.max(0, 15 - (player.ore ?? 0));
            while (rem >= 3 && oreRoom > 0) {
                acts.push({ type: 'convert_resource' as const, params: { type: '3power-to-1ore', useBrain: false } });
                rem -= 3; oreRoom--;
            }
            const credRoom = Math.max(0, 30 - (player.credits ?? 0));
            for (let i = 0; i < Math.min(rem, credRoom); i++) {
                acts.push({ type: 'convert_resource' as const, params: { type: '1power-to-1credit', useBrain: false } });
            }
            return acts;
        }
        return Array.from({ length: doomed }, () => ({ type: 'convert_resource' as const, params: { type: '1power-to-1credit', useBrain: false } }));
    }

    private static findTwilightArtifactActions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const totalPower = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);
        const ore = player.ore ?? 0;

        const results: BotAction[] = [];

        // [버그가드] 인공물 취득은 트왈라잇 우주선 탑승 + 남은 슬롯 필요(executeTakeTwilightArtifact). 탑승 안 했으면 무효후보라 안 냄.
        const twilight = game.map.find(t => t.type === 'ship_twilight');
        const boarded = !!twilight && (player.spaceshipsEntered ?? []).includes(twilight.id);
        const slotsOpen = (game.twilightArtifactSlots ?? []).some(s => s != null);
        if (!boarded || !slotsOpen) return results;

        if (totalPower >= 6) {
            const bestId = this.getBestArtifactId(game, playerId);
            const refill = bestId === 'art-income-2p3' ? 2 : 0;
            if (!bestId || !this.canSpendPowerTokensForStrategicAction(game, player, 6, 0, refill)) return results;
            // 6파워 소모로 그냥 제거될 bowl3 토큰을 먼저 1P→1C로 환수(최종 파워 동일+크레딧 이득). 사용자 관찰 교정.
            const cashout = this.doomedBowl3CashoutPreActions(player, 6, playerId);
            results.push(cashout.length
                ? { type: 'take_twilight_artifact', params: { artifactId: bestId }, preActions: cashout }
                : { type: 'take_twilight_artifact', params: { artifactId: bestId } });
            return results;
        }

        const need = 6 - totalPower;
        if (need < 1 || ore < need) return results;

        const artifactId = this.getBestArtifactId(game, playerId, 6);
        if (!artifactId) return results;

        const oneConvert = { type: 'convert_resource' as const, params: { type: '1ore-to-1token' } };
        const refill = artifactId === 'art-income-2p3' ? 2 : 0;
        for (let n = need; n <= Math.min(6, ore); n++) {
            if (!this.canSpendPowerTokensForStrategicAction(game, player, 6, n, refill)) continue;
            // [낭비수정 2026-07-22 사용자 관찰: (0,0,3)에서 3그릇 토큰이 인공물 6토큰 소모에 생으로 갈림]
            // 연방 ore→token 경로(2026-07-07 수정)와 동일한 누락 — 이 경로도 소모될 bowl3를 먼저
            // 1P→1C/3P→1O로 환수(토큰은 bowl1로 돌아와 6토큰 지불에 그대로 쓰임 = 순이득).
            const cashout = this.doomedBowl3CashoutPreActions(player, 6, playerId, n);
            results.push({
                type: 'take_twilight_artifact',
                params: { artifactId },
                preActions: [...Array.from({ length: n }, () => oneConvert), ...cashout]
            });
        }
        return results;
    }

    private static getEffectiveBaseRange(player: PlayerState): number {
        let r = getRange(player.research?.navigation ?? 0) + (player.navigationBonus ?? 0);
        if (player.tempRangeBonus) r += 3;
        if (player.rangeBonusActive) r += 3;
        if (player.gleensNavBonusActive) r += 2; // 글린 +2 Nav도 우주선 입장 사거리에 반영(서버 executeEnterSpaceship과 동일)
        return r;
    }

    /**
     * 사거리 부스터(글린 +2 / 보너스 +3)가 '실제로 새 대상을 열어주는지' 검사.
     * 부스터를 켰을 때만 닿는(=끄면 후보에 없는) 광산/가이아포머/우주선입장 대상이 하나라도 있어야 true.
     * 끄든 켜든 후보가 같으면(가까운 곳만 짓거나 업그레이드만 할 상황) 부스터는 낭비이므로 false.
     * → 봇이 +3거리/글린+2를 켜 놓고 정작 사거리 필요 없는 교역소 업그레이드를 해 보너스를 버리던 버그 교정(사용자 관찰).
     */
    private static rangeBoosterUnlocksTarget(
        game: ServerGameState,
        playerId: string,
        flag: 'rangeBonusActive' | 'gleensNavBonusActive' | 'tempRangeBonus'
    ): boolean {
        const player = game.players[playerId];
        if (!player) return false;
        const allowShip = getPlayerFlag(playerId, 'rangeBonusShipEntry', true);

        const targetIds = (): Set<string> => {
            const ids = new Set<string>();
            for (const a of this.findBuildActions(game, playerId)) {
                const t = (a as any).params?.tileId; if (t) ids.add(`b:${t}`);
            }
            for (const a of this.findBuildActionsWithPendingSteps(game, playerId)) {
                const t = (a as any).params?.tileId; if (t) ids.add(`b:${t}`);
            }
            if (allowShip) for (const a of this.findSpaceshipEntryActions(game, playerId)) {
                const t = (a as any).params?.shipTileId ?? (a as any).params?.tileId; if (t) ids.add(`s:${t}`);
            }
            return ids;
        };

        const prev = (player as any)[flag];
        (player as any)[flag] = true;
        const withBoost = targetIds();
        (player as any)[flag] = prev;

        // [v2 2026-07-20] 기존(ON/OFF 집합 차이)은 상위 N 슬라이스 구성 변화로 근거리도 '열린 것'으로 오판
        // (사용자 재현: 1K 누르고 기본 사거리 내 건설). 부스트 켠 후보 중 실제 거리가 '부스트 제외 기본
        // 사거리'를 초과하는 타깃이 있을 때만 true — 사용 단계 필터(rangeBonusFarOnly v2)와 동일 기준.
        const baseNoBoost = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
        const anchors = game.map.filter(t =>
            (t.ownerId === playerId && t.structure) || t.parasiticMine?.ownerId === playerId
            || (t.spaceStation as any)?.ownerId === playerId);
        if (anchors.length === 0) return false;
        return Array.from(withBoost).some((id) => {
            const tileId = id.slice(2); // 'b:'/'s:' 프리픽스 제거
            const t = game.map.find(m => m.id === tileId);
            if (!t) return false;
            return Math.min(...anchors.map(a => getDistance(a, t))) > baseNoBoost;
        });
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

        // [flag: earlyOreBonusTile] 데이터(사람 vs 봇 R1-3 보너스타일 선택): 사람은 1O 확장타일(1o-mine/1o-2tokens/
        // 1o-ts)을 선호, 봇은 4C-gaia(순수 크레딧)를 그 자리에 집음 → 크레딧 풍선만 키우고 광석 굶겨 새 광산을 못 깜
        // (R3종료까지 건물행동 봇 8.71 vs 사람 11.43, R3 보유자원 봇 9.8 vs 사람 5.3 = 봇은 쟁여두고 안 지음).
        // 초반엔 광석이 확장(새 광산)의 병목이므로 광석 가중치를 올려 사람처럼 1O 확장타일을 고르게 한다.
        let oreW = 3, knowW = 3;
        if (getPlayerFlag(playerId, 'earlyOreBonusTile', false) && round <= 3) {
            oreW = 5;   // 광석=새 광산 연료(확장 병목)
            knowW = 4;  // 지식=연구 연료
        }
        // [flag: bonusTileHumanW] 사람 vs 봇 선택분포(246 대 275): 사람 top=4pw충전 12%/2c-1q 13%인데 봇은
        // 1k-lab 12%/1o-1k 8% 과애호(-8/-6 갭). power ×1(4파워=4점)이 bowl3 공급원(사람 bowl3 3-4 유지의 원천)을
        // 저평가, knowledge는 science편향 잔재로 과평가 → 데이터대로 power↑ know↓ qic↑.
        const humanW = getPlayerFlag(playerId, 'bonusTileHumanW', true);
        let resourceValue = 0;
        if (tile.income) {
            resourceValue += (tile.income.ore || 0) * oreW;
            resourceValue += (tile.income.knowledge || 0) * (humanW ? 2.5 : knowW);
            resourceValue += (tile.income.qic || 0) * (humanW ? 5 : 4);
            resourceValue += (tile.income.credits || 0) * 1;
            resourceValue += (tile.income.power || 0) * (humanW ? 2.5 : 1);
        }
        if (tile.specialAction) {
            if (tile.specialAction === 'range_3') resourceValue += 3;
            if (tile.specialAction === 'terraform_step') resourceValue += 3;
            if (tile.specialAction === 'gaia_project') {
                // [flag: gaiaBoosterUsable] 즉포(bon-2pw-gaiaproject)의 특수액션(가이아포머 배치)은 실제로 쓸 수 있을 때만 가치.
                //   실측(사람게임 45판): 봇이 즉포 든 27구간 중 23구간(85%)이 특수액션 안 쓰고 반납 = 2파워만 받고 슬롯 낭비.
                //   findGaiaformerActions>0 = 지금 가이아포밍 가능(포머 보유+사거리 내 transdim+파워). 쓸 수 있으면 상향, 못 쓰면
                //   감점해 2파워 수입가치를 상쇄 → 자원/확장 부스터를 대신 고르게. (사용자 관찰)
                if (getPlayerFlag(playerId, 'gaiaBoosterUsable', true)) {
                    resourceValue += this.findGaiaformerActions(game, playerId).length > 0 ? 4 : -3;
                } else {
                    resourceValue += 2;
                }
            }
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
            // [flag: bonusPassZeroMalus] 사용자 관찰(2026-07-14): 큰건물 0개인데 4pw+큰건물 부스터를 2C+1Q보다
            // 먼저 집음 — bonusTileHumanW(7/5)의 파워 ×2.5가 4pw 부스터를 정적 10점(> 2c-1q 7점)으로 만들어
            // 보드 상태 무관 항상 우선이 된 과교정. 패스VP 대상이 0개면 부스터 정체성 절반이 죽은 것 → −4
            // (큰건물 1개부터는 +4VP로 자연 복귀. 0랩에 1k-lab 부스터 등 동일 케이스 일괄 교정).
            if (getPlayerFlag(playerId, 'bonusPassZeroMalus', true) && count === 0) passBonusValue -= 4;
        }

        // 다음 라운드 파워 수입 예측:
        // 그릇1 토큰이 부족하면(power charge가 새면) 토큰 수급 타일을 강하게 선호
        {
            const { powerIncome, tokenIncome } = this.calculateExpectedPowerIncome(game, playerId);
            const p1Next = (player.power1 ?? 0) + tokenIncome;
            const expectedWaste = Math.max(0, powerIncome - p1Next);
            if (expectedWaste > 0) {
                resourceValue += (tile.income.powerTokens || 0) * 3;
            }
        }

        if (round <= 3) {
            // 엔진 빌딩 시기: 자원 대폭 우대
            score += (resourceValue * 2.5) + (passBonusValue * 0.5);
            // [사용자 피드백] 패스는 기본적으로 기피 대상이므로 페널티를 주되,
            // 아무것도 할 수 없는 (예: 연구소 지을 돈도 없고, 3광물 1테라포밍으로 -1000점을 맞기 싫은) 상황에서는
            // 어쩔 수 없이 패스를 선택해야 하므로 500점이 아닌 150점 정도로 완화
            score -= 150; 
        } else {
            // 후반: 점수 대폭 우대
            score += (resourceValue * 0.5) + (passBonusValue * 2.0);
            score -= 50; // 후반에도 점막 패스를 위해 약간의 페널티
        }

        score += Math.random() * 0.1;
        return score;
    }

    private static calculateRoundScoringBonus(game: ServerGameState, playerId: string, triggerType: string, buildTile?: HexTile): number {
        const round = game.roundNumber;
        const currentRoundIndex = round - 1;
        if (currentRoundIndex < 0 || currentRoundIndex >= game.roundScoringTiles.length) return 0;

        // [flag: roundMissionW15] 정렬 가중치 ×5는 코드베이스 VP환율(proto 6VP=+90→15×, ship-fed 12VP=320→26×)
        // 대비 3-5배 저평가된 대충 숫자 → 4VP미션이 +20뿐이라 봇이 미션을 무시(트리거 사람 11.5회 vs 봇 4.9회, 갭 -20VP).
        // ×15로 환율 통일. 사람은 라운드마다 미션에 행동을 정렬함(같은 광산도 미션 라운드에).
        const W = getPlayerFlag(playerId, 'roundMissionW15', true) ? 15 : 5;

        const tile = game.roundScoringTiles[currentRoundIndex];
        if (tile.triggerType === triggerType) return tile.vp * W;

        // [라운드미션 커버리지 2026-06-15] build류가 'new_planet_type'/'new_sector' 라운드점수를 트리거하는데
        // 기존엔 triggerType('build_mine' 등)만 비교해 누락. buildTile 주어지면 새 행성타입/새 섹터도 정렬.
        if (buildTile && triggerType.startsWith('build_')) {
            if (tile.triggerType === 'new_planet_type') {
                const myTypes = new Set(game.map.filter(t => t.ownerId === playerId && t.structure && t.type).map(t => t.type));
                if (buildTile.type && !myTypes.has(buildTile.type)) return tile.vp * W;
            }
            if (tile.triggerType === 'new_sector') {
                const mySectors = new Set(game.map.filter(t => t.ownerId === playerId && t.structure).map(t => t.sector));
                if (buildTile.sector != null && buildTile.sector !== 90 && !mySectors.has(buildTile.sector)) return tile.vp * W; // 가운데 전략 헥스(90)는 섹터 아님(서버 룰 미러)
            }
        }

        let futureBonus = 0;
        for (let i = currentRoundIndex + 1; i < game.roundScoringTiles.length; i++) {
            const futureTile = game.roundScoringTiles[i];
            // [개선] 미래 라운드 정렬 신호 강화(1→2): 다가올 라운드 점수타일에 맞춰 미리 엔진/구조를 갖추도록.
            if (futureTile.triggerType === triggerType) futureBonus += futureTile.vp * 2;
        }
        return futureBonus;
    }

    /** [flag: finalMissionRankAware] 이 미션에서 내 순위 VP가 아직 오를 수 있는지 — 낙관적 지평(남은 라운드
     *  ×2 진행, 이번 라운드 포함)으로도 VP 불변이면 false(추격 불가 확정 = 진행 보너스 무의미). R1-4는 순위가
     *  유동적이라 항상 true. [v2] R4 포함(v1)은 40판 −2.16 — 사용자 장면(R6 외곽 0→1, 4위 확정)에 맞춰 R5+만.
     *  후보 타일마다 호출되므로 (플레이어·미션·상태)별 메모 — 상태 키는 gameLog 길이
     *  (액션마다 증가; 시뮬 클론도 분기 시 로그가 자라 키가 갈림). 값·키 모두 평범한 데이터라 직렬화 무해. */
    private static finalMissionClimbable(game: ServerGameState, playerId: string, missionId: string): boolean {
        if (!getPlayerFlag(playerId, 'finalMissionRankAware', true)) return true;
        const round = game.roundNumber ?? 1;
        if (round < 5) return true;
        const g = game as any;
        const stateKey = `${round}:${game.gameLog?.length ?? 0}`;
        if (g._fmClimbMemo?.stateKey !== stateKey) g._fmClimbMemo = { stateKey, vals: {} };
        const entryKey = `${playerId}:${missionId}`;
        const cached = g._fmClimbMemo.vals[entryKey];
        if (cached !== undefined) return cached;
        const myVal = getFinalMissionValue(game, playerId, missionId);
        const horizon = (7 - round) * 2; // R4:6 R5:4 R6:2 — 관대한 지평(차단은 확실할 때만)
        const val = getFinalMissionVpProjected(game, playerId, missionId, myVal + horizon)
            > getFinalMissionVpProjected(game, playerId, missionId, myVal);
        g._fmClimbMemo.vals[entryKey] = val;
        return val;
    }

    private static calculateFinalMissionBonus(game: ServerGameState, playerId: string, tile: HexTile, structure?: string): number {
        let totalBonus = 0;
        const player = game.players[playerId];

        const myTiles = game.map.filter(t => t.ownerId === playerId || t.parasiticMine?.ownerId === playerId);
        const myTypes = new Set(myTiles.map(t => t.type).filter(t => t));

        // [flag: finalMissionFix] ★버그수정: 이 함수가 game.finalScoringTiles(셋업 더미 {id:'fs1'/'fs2'})를 읽어
        // fm_* switch가 영영 매칭 안 됨 = 13개 빌드후보 스코어링의 최종미션 정렬이 죽은 코드였음(evaluator는 별도로
        // 올바른 game.finalMissionIds를 씀). 실게임 1:3(fy42d29p·9a5dmht7) 봇 최종미션 0점의 직접 원인.
        // → 실제 미션 id(finalMissionIds)를 읽고, 부활 시 드러나는 누락 case(연방건물·외곽섹터·PI아카거리)도 보강.
        const useFix = getPlayerFlag(playerId, 'finalMissionFix', true);
        const missionIds: string[] = useFix
            ? ((game.finalMissionIds as string[]) || [])
            : ((game.finalScoringTiles || []).map(m => m.id));

        for (const missionId of missionIds) {
            // [flag: finalMissionRankAware] 사용자 관찰(2026-07-13): 외곽 미션 0개·상대 4/5/6인데 R6에 1개
            // 만들러 감 — 순위제(18/12/6)라 순위를 못 바꾸는 진행은 VP 0인데 고정 +25가 무조건 붙던 것.
            // R4+에 "남은 라운드 낙관 진행(라운드당 +2)으로도 내 미션 VP가 못 오르면" 그 미션 보너스 0.
            if (!this.finalMissionClimbable(game, playerId, missionId)) continue;
            switch (missionId) {
                case 'fm_total_structures': totalBonus += 5; break;
                case 'fm_planet_types':
                    if (tile.type && !myTypes.has(tile.type)) totalBonus += 35;
                    break;
                case 'fm_gaia_planets': if (tile.type === 'gaia' || tile.type === 'transdim') totalBonus += 20; break;
                case 'fm_sectors': {
                    const mySectors = new Set(game.map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship').map(t => t.sector));
                    if (!mySectors.has(tile.sector)) totalBonus += 25;
                    break;
                }
                case 'fm_outer_sectors': {
                    // 외곽 섹터(11~18)만 카운트. 새 외곽 섹터 진입이면 우대.
                    if (typeof tile.sector === 'number' && tile.sector >= 11 && tile.sector <= 18) {
                        const myOuter = new Set(game.map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship' && t.sector >= 11 && t.sector <= 18).map(t => t.sector));
                        if (!myOuter.has(tile.sector)) totalBonus += 25;
                    }
                    break;
                }
                case 'fm_asteroid_buildings': if (tile.type === 'asteroid') totalBonus += 20; break;
                case 'fm_federation_buildings': {
                    // 연방 내 건물 최다 — 정확한 예측은 어려우나, 내 클러스터(dist≤1 내건물)에 붙는 빌드는
                    // 연방에 포함될 확률↑. 과한 군집 유도 방지 위해 modest.
                    const adjOwn = game.map.some(t => t.ownerId === playerId && t.structure && t.structure !== 'ship' && getDistance(t, tile) === 1);
                    if (adjOwn) totalBonus += 12;
                    break;
                }
                case 'fm_pi_academy_distance': {
                    // PI-아카데미 최대거리 보상. PI/아카를 지을 때 반대짝 건물에서 멀수록 우대.
                    if (structure === 'planetary_institute') {
                        const acs = game.map.filter(t => t.ownerId === playerId && t.structure === 'academy');
                        if (acs.length) totalBonus += Math.max(...acs.map(a => getDistance(a, tile))) * 5;
                    } else if (structure === 'academy') {
                        const pis = game.map.filter(t => t.ownerId === playerId && t.structure === 'planetary_institute');
                        if (pis.length) totalBonus += Math.max(...pis.map(p => getDistance(p, tile))) * 5;
                    }
                    break;
                }
                // fm_satellites: 위성은 연방 형성의 산물(빌드 액션이 직접 만들지 않음) → per-build 가점 없음.
            }
        }
        const isPlanetTechAvailable = (game.techTilesPool || []).some(t => t?.id === 'tech-imm-1k-planet');
        if (!player.techTiles?.includes('tech-imm-1k-planet') && isPlanetTechAvailable) {
            if (tile.type && !myTypes.has(tile.type)) totalBonus += 25;
        }
        // [데이터 2026-06-18] proto 행성에 광산 = 즉시 +6VP(서버 gameState 5746). 봇이 이 보상을 안 쳐줘
        // 비싼 테라포밍 광산으로만 보고 회피 → 사람 108VP vs 봇 12VP. 가이드: 6VP 즉시값을 점수로 반영(테라포밍비용 일부 상쇄).
        if (tile.type === 'proto' && getPlayerFlag(playerId, 'protoVpBonus', true)) totalBonus += 90;
        return totalBonus;
    }

    private static calculateAdjacencyBonus(game: ServerGameState, playerId: string, tile: HexTile): number {
        let bonus = 0;
        const neighbors = game.map.filter(t => getDistance(t, tile) === 1);
        // [flag: noInflateFed] 이미 형성된(닫힌) 연방에 속한 내 건물 옆 군집화는 연방가치 0(연방은 형성 시 1회 점수).
        // 그런 이웃엔 군집보너스(+50/+20)를 안 줘서, 봇이 닫힌 연방을 계속 부풀리지 않고 새 연방용 NON-연방 건물 옆/새 영토로 가게 유도(사용자 관찰).
        const noInflateFed = getPlayerFlag(playerId, 'noInflateFed', true);
        const fedHexes: string[] = noInflateFed ? ((game as any).playerFederationHexes?.[playerId] || []) : [];
        const clusterCounts = (neighborId: string) => !(noInflateFed && fedHexes.includes(neighborId));

        // [flag: taklonsPowerPos] 타클론은 파워가 생명(브레인스톤 증폭) → 상대 건물(특히 광산: 업글확률↑=리치 더 받음) 옆 포지셔닝을 크게 우대.
        // 사용자 모델: "상대 있는 곳/중앙으로 가서 파워 받을 준비". 봇은 보통 자기영역만 안전 확장해 이 핵심을 놓침.
        const taklonsLeech = game.players[playerId]?.faction === 'taklons' && getPlayerFlag(playerId, 'taklonsPowerPos', false);

        // [flag: oppAdjacencyValue] 사용자 관찰(2026-07-13): 봇이 구석 점프 광산 → 아무도 안 인접 → 6C TS 반복.
        // 상대 인접의 실가치 = ①미래 mine→TS 3C 할인 예약(+3C) ②매라운드 파워 리치 스트림 ③사람 학습 가중치
        // dOpp −0.85(상대 근접 선호 실측). 기존 +20은 군집(+50)·베이스(300) 대비 반올림 오차 — 45/22로 상향.
        // ※ 리치 가치는 셀프플레이서 안 잡힘(buildNearShipOpp −1.76 전례) → do-no-harm 확인 + 실게임 판정.
        // [판정 2026-07-14] 40판 승률 52.5% / VP −1.69±3.70 = 방향 상충 노이즈(do-no-harm 통과) →
        // 사전 등록대로 사람게임 한정 채택(creditCapGuard 패턴). 셀프플레이 지표는 불변.
        const oppAdjBoost = getPlayerFlag(playerId, 'oppAdjacencyValue', true)
            && (game.botPlayerIds?.length ?? 0) < Object.keys(game.players).length;
        for (const neighbor of neighbors) {
            // 다른 플레이어 건물 인접 (파워 수신용 + TS 할인 예약)
            if (neighbor.ownerId && neighbor.ownerId !== playerId) {
                if (neighbor.structure === 'mine' || neighbor.structure === 'trading_station') bonus += taklonsLeech ? 55 : (oppAdjBoost ? 45 : 20);
                else if (neighbor.structure) bonus += taklonsLeech ? 28 : (oppAdjBoost ? 22 : 10);
            }

            // 내 건물 인접 (군집화 및 위성 절약) - 대폭 상향. 단 이미 연방인 이웃은 제외(닫힌 연방 부풀리기 방지).
            if (neighbor.ownerId === playerId && neighbor.structure && neighbor.structure !== 'ship' && clusterCounts(neighbor.id)) {
                bonus += 50;
            }
        }

        // 2거리 내에 내 건물이 있으면 연방 연결에 유리 (이미 연방인 이웃 제외)
        const range2Neighbors = game.map.filter(t => getDistance(t, tile) === 2);
        for (const neighbor of range2Neighbors) {
            if (neighbor.ownerId === playerId && neighbor.structure && neighbor.structure !== 'ship' && clusterCounts(neighbor.id)) {
                bonus += 20;
            }
        }

        // [flag: isolatedTSPenalty] 사용자 전략(2026-06-28): "3원(상대인접) 교역소가 안 되는 자리 = 고립"에 강한 패널티.
        // TS 업글은 상대 건물 인접 시 2ore/3credit(할인), 고립 시 2ore/6credit. 즉 상대옆=싼TS+leech+맵장악.
        // 상대 건물 인접도 아니고 내 클러스터(dist≤2 내건물=연방 연결)도 아닌 *진짜 외곽 흩뿌리기*만 강하게 감점
        // → 봇이 외곽 가이아 점프 대신 중앙/상대옆으로 확장(사용자 라이브 관찰: 스자가 2Nav로 외곽 가이아 점프).
        // ※ self-play 검증 불가(봇끼리 leech가치 안 잡힘, 과거 buildNearShipOpp −1.76) → 사용자 1:3가 진짜 판정. R1-4 한정.
        // [flag: placementPolicy] 사람 22판(656 빌드결정)에서 학습한 배치 정책(placementPolicy.json, top1 17.8% vs random 5%).
        // 8-피처 선형 랭커: dOwn −3.57(압도적 밀집), adjOwn +1.20, dProto −0.98, dOpp −0.85(상대근접=2/3 싼TS), newType −0.81…
        // isolatedTSPenalty(추측 −150)의 데이터-정밀 대체. ON이면 그걸 끄고 학습점수를 씀.
        if (getPlayerFlag(playerId, 'placementPolicy', false)) {
            // 비싼 계산(맵 전수 filter)이라 MCTS 롤아웃(game.simulation)에선 생략 — root 결정에만 적용(GC 폭주 방지).
            if (!game.simulation) bonus += this.calculatePlacementPolicyScore(game, playerId, tile) * 60;
        } else if (getPlayerFlag(playerId, 'isolatedTSPenalty', true) && game.roundNumber <= 4) {
            const adjOpp = neighbors.some(n => n.ownerId && n.ownerId !== playerId && n.structure && n.structure !== 'ship');
            const nearOwn = neighbors.some(n => n.ownerId === playerId && n.structure && n.structure !== 'ship')
                || range2Neighbors.some(n => n.ownerId === playerId && n.structure && n.structure !== 'ship');
            if (!adjOpp && !nearOwn) bonus -= 150; // 강하게: 외곽 고립 빌드 억제
        }

        const opponentGaiaformers = game.map.filter(t => t.hasGaiaformer && t.ownerId !== playerId);
        if (opponentGaiaformers.some(gf => getDistance(gf, tile) === 1)) bonus += 15;

        // [flag: buildNearShip] 사람 첫집 패턴 데이터(39건): 첫 광산을 우주선 dist≤2에 51%(평균2.2)·자기건물 dist≤3에 80%로 둠.
        // 상대 proximity는 무관(26%/분산)이라 제외(이전 buildNearShipOpp가 상대항 넣어 −1.76 backfire). 우주선만, 약하게, R1-2 한정.
        // 자기건물 군집(close-to-own 80%)은 위 adjacencyBonus(+50 dist1/+20 dist2)가 이미 담당.
        if (getPlayerFlag(playerId, 'buildNearShip', true) && game.roundNumber <= 2) {
            const entered = game.players[playerId]?.spaceshipsEntered || [];
            for (const t of game.map) {
                const ty = t.type || '';
                if ((ty === 'ship_twilight' || ty === 'ship_rebellion' || ty === 'ship_tf_mars' || ty === 'ship_eclipse') && !entered.includes(t.id)) {
                    const d = getDistance(tile, t);
                    if (d <= 1) bonus += 30; else if (d === 2) bonus += 20; else if (d === 3) bonus += 8; // 약하게(이전 55/30/12 backfire)
                }
            }
        }
        return bonus;
    }

    /**
     * [학습정책] 사람 22판 656 빌드결정에서 학습한 배치 선형 랭커 점수 (server/ai/placementPolicy.json).
     * imitationProbeTile.mjs와 *동일* 피처/정규화. 게임 누적 시 재학습→W 갱신. 점수 클수록 사람이 고를 자리.
     */
    private static calculatePlacementPolicyScore(game: ServerGameState, playerId: string, tile: HexTile): number {
        const W = [-3.57, -0.85, 0.13, -0.98, -0.54, 1.20, 0.11, -0.81]; // [dOwn,dOpp,dShip,dProto,adjEmpty,adjOwn,newSector,newType]
        const NONPLANET = new Set(['space', 'deep_space', 'transdim', 'lost_fleet_ship']);
        const isPlanetT = (t: HexTile) => !!t.type && !NONPLANET.has(t.type) && !t.type.startsWith('ship_');
        const tiles = game.map;
        const mine = tiles.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship' && isPlanetT(t));
        if (mine.length === 0) return 0;
        const empties = tiles.filter(t => isPlanetT(t) && !t.ownerId && !t.structure);
        const ships = tiles.filter(t => (t.type || '').startsWith('ship_'));
        const protos = tiles.filter(t => t.type === 'proto' || t.type === 'asteroid');
        const opp = tiles.filter(t => t.ownerId && t.ownerId !== playerId && t.structure && t.structure !== 'ship');
        const md = (arr: HexTile[]) => arr.length ? Math.min(...arr.map(s => getDistance(s, tile))) : 9;
        const adjEmpty = empties.filter(t => t.id !== tile.id && getDistance(t, tile) === 1).length;
        const adjOwn = mine.filter(m => getDistance(m, tile) === 1).length;
        const myTypes = new Set(mine.map(t => t.type));
        const mySectors = new Set(mine.map(t => t.sector));
        const f = [
            Math.min(md(mine), 9) / 9, Math.min(md(opp), 9) / 9, Math.min(md(ships), 9) / 9, Math.min(md(protos), 9) / 9,
            adjEmpty / 6, adjOwn / 6, mySectors.has(tile.sector) ? 0 : 1, myTypes.has(tile.type) ? 0 : 1,
        ];
        let s = 0;
        for (let i = 0; i < W.length; i++) s += W[i] * f[i];
        return s;
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
            const ivitsPlanets = game.map.filter(t => t.ownerId === playerId && (t.structure || (t.spaceStation && (t.spaceStation as any).ownerId === playerId)));
            const minDist = ivitsPlanets.length > 0 ? Math.min(...ivitsPlanets.map(p => getDistance(p, tile))) : 999;
            // [flag: ivitsTightCluster] 기존 Ivits는 평면 +20만 받아 '뭉치기' 당김이 없어 산개→연결 불가→연방 불가
            //   (사용자 관찰: "점프 과해 건물 연결 못 해 연방 못 함"). 다른 종족의 tightCluster/fedCompletion 당김을 Ivits에도 부여.
            //   단 Ivits는 QIC 위성이 싸 dist2 연결도 저렴하므로 dist2를 다른 종족보다 후하게(+50).
            if (getPlayerFlag(playerId, 'ivitsTightCluster', false)) {
                let s = 0;
                if (minDist <= 1) s += 100;       // 위성 없이 연결되는 진짜 클러스터 성장
                else if (minDist === 2) s += 50;  // QIC 위성 1개로 싸게 연결
                // 거의 완성된 연결 클러스터(파워합 5~7)를 마저 끝내도록 commit
                let potentialPower = 1;
                for (const p of ivitsPlanets) {
                    if (getDistance(tile, p) <= 4 && p.structure) potentialPower += this.getBuildingValue(p.structure, faction);
                }
                if (potentialPower >= 7) s += 110;
                else if (potentialPower >= 5) s += 60;
                else if (potentialPower >= 4) s += 25;
                return s;
            }
            return minDist <= 2 ? 20 : 0;
        }
        let score = 0;
        const fedHexes = (game as any).playerFederationHexes?.[playerId] || [];
        const myStructures = game.map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship' && !fedHexes.includes(t.id));
        if (myStructures.length > 0) {
            const minDist = Math.min(...myStructures.map(s => getDistance(tile, s)));
            // [실험 tightCluster] 봇이 구조물을 연결클러스터 7.7개로 흩뿌려(최대파워4.3<7) 연방 못 함(맵-피처 발견).
            // 거리합산 대신 인접(dist1=위성없이 연결)을 강하게 우대해 '실제 연결 클러스터'를 키우게 유도.
            // FORCE_TIGHT=1로 측정 시 전체 봇에 적용(클러스터 지표 비교용).
            const tightOn = getPlayerFlag(playerId, 'tightCluster', true);
            if (tightOn) {
                if (minDist <= 1) score += 100;        // 인접 = 위성 없이 연결되는 진짜 클러스터 성장
                else if (minDist === 2) score += 30;   // 위성 1개로 연결 가능
                // dist 3+ 보너스 제거: 흩뿌리기 억제
            } else {
                if (minDist <= 3) score += (4 - minDist) * 15;
            }
            let potentialPower = 1;
            for (const s of myStructures) {
                if (getDistance(tile, s) <= 4) potentialPower += this.getBuildingValue(s.structure!, faction);
            }
            // [연방플래너 최소brick 2026-06-15] greedy가 클러스터를 미완성으로 흩뿌리는 문제 →
            // '거의 다 된(5-6파워) 클러스터를 마저 완성'하는 데 강한 commit 보너스. 봇 연방 1.4→ 끌어올리기.
            if (getPlayerFlag(playerId, 'fedCompletionDrive', true)) {
                if (getPlayerFlag(playerId, 'fedCompletionStrong', false)) {
                    // [실험] 더 가파른 commit — 4-6파워 클러스터를 *확실히* 끝내도록(흩뿌리지 말고 완성).
                    if (potentialPower >= 7) score += 150;
                    else if (potentialPower >= 6) score += 110;
                    else if (potentialPower >= 5) score += 75;
                    else if (potentialPower >= 4) score += 40;
                } else {
                    if (potentialPower >= 7) score += 110;        // 이 건물로 연방 완성 가능 → 강하게 우선(완성=초록토큰·연구5 연쇄)
                    else if (potentialPower >= 5) score += 60;    // 5-6: 거의 완성, 한두 채 더 지어 끝내도록
                    else if (potentialPower >= 4) score += 25;
                }
            } else {
                if (potentialPower >= 7) score += 60;
                else if (potentialPower >= 4) score += 25;
            }
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

    /** [flag: chargeDrainBowl3 기본 ON] chargeAmount 파워를 충전하는 액션(tech-act-4p·우주선 입장 등) 전에,
     *  충전 수용량(2*p1+p2)이 부족해 버려질 충전이 2 이상이면 bowl3 토큰을 1P→1C로 미리 비워 수용량을 확보한다
     *  (가치 추출 + 낭비 방지). waste>=2에서만 발동하므로 비운 토큰은 그 충전으로 bowl3에 되돌아와 strictly dominant
     *  (최종 파워 동일 + 크레딧 이득). 드레인 수는 p3로 캡(프리액션 실패→리스케줄 루프 방지). 타클론은 브레인스톤
     *  파워회계(토큰1개=3파워) 특수로 제외. */
    private static chargeDrainPreActions(playerId: string, player: PlayerState, chargeAmount: number): BotAction[] {
        if (!getPlayerFlag(playerId, 'chargeDrainBowl3', true)) return [];
        if (chargeAmount <= 0) return [];
        const p1 = player.power1 ?? 0, p2 = player.power2 ?? 0, p3 = player.power3 ?? 0;
        const waste = Math.max(0, chargeAmount - (2 * p1 + p2));
        if (waste < 2) return [];
        // [flag: taklonsChargeDrain] 타클론은 브레인 회계(1토큰=3파워) 특수로 기존엔 charge-drain 제외 → 충전 넘칠 때 bowl3를
        //   안 비워 브레인 낀 채 충전 낭비(사용자: "파워 넘칠 때 브레인 미리 안 바꿈"). 브레인 bowl3면 3P→1O(useBrain)로 미리 써서
        //   슬롯 크게 확보 + 브레인 활용. 브레인 회계 리스크로 별 플래그 격리 — 브레인 있으면 그것만(over-drain 방지), 없으면 일반 드레인.
        if (player.faction === 'taklons') {
            if (!getPlayerFlag(playerId, 'taklonsChargeDrain', false)) return [];
            if (player.brainStoneBowl === 3 && !player.brainStoneInGaia) {
                return [{ type: 'convert_resource' as const, params: { type: '3power-to-1ore', useBrain: true } }];
            }
            const drains = Math.min(p3, Math.ceil(waste / 2));
            return Array.from({ length: drains }, () => ({ type: 'convert_resource' as const, params: { type: '1power-to-1credit', useBrain: false } }));
        }
        if (p3 < 1) return [];
        const drains = Math.min(p3, Math.ceil(waste / 2));
        return Array.from({ length: drains }, () => ({ type: 'convert_resource' as const, params: { type: '1power-to-1credit', useBrain: false } }));
    }

    /** [flag: fedSpendBowl3] 연방 형성 전에 '남을' idle bowl3 토큰을 프리액션(1P→1C)으로 미리 써서 가치(크레딧)를 뽑는다.
     *  위성 지불은 bowl1→2→3 순이라 bowl3 소모분 = max(0, spent−p1−p2); 그 위 나머지 bowl3 = idle(사용자 관찰: 그대로 둔 채 연방).
     *  1P→1C는 토큰을 bowl3→bowl1로 되돌려(제거X) 위성 지불 총량이 불변이라 안전. taklons는 브레인 회계 리스크로 제외. */
    private static fedSpendBowl3PreActions(playerId: string, player: PlayerState, spentTokens: number): BotAction[] {
        if (!getPlayerFlag(playerId, 'fedSpendBowl3', true)) return [];
        if (player.faction === 'taklons') return [];
        // [flag: ivitsFedPowerFix] 사용자 관찰(2026-07-14): 이비츠가 연방 전에 bowl3를 1P→1C로 정리 — 이비츠
        // 위성은 QIC 지불이라 토큰이 전혀 안 소모되는데, 이 계산식(spent−p1−p2)이 전 bowl3를 idle로 오판해
        // 액션 연료를 헐값(1C)에 배출하던 것. 근거(위성 소모분 회수) 자체가 이비츠엔 부재 → 면제.
        if (player.faction === 'ivits' && getPlayerFlag(playerId, 'ivitsFedPowerFix', true)) return [];
        const p1 = player.power1 ?? 0, p2 = player.power2 ?? 0, p3 = player.power3 ?? 0;
        const bowl3UsedBySat = Math.max(0, (spentTokens ?? 0) - p1 - p2);
        const idle = Math.max(0, p3 - bowl3UsedBySat);
        if (idle < 1) return [];
        const drain = Math.min(idle, 6);
        return Array.from({ length: drain }, () => ({ type: 'convert_resource' as const, params: { type: '1power-to-1credit', useBrain: false } }));
    }

    /** [hang수정 2026-07-12] MCTS.search가 드물게 영영 미해결(오늘 전 배치에서 게임의 2~10%가 [HANG],
     *  시그니처: "must complete pending build ..." 후 완전 침묵·예외 없음 = async 미해결. 이벤트루프는 살아있음).
     *  근본원인(mcts.ts 내부)과 무관하게 하네스 방어: 15초 레이스 → 초과 시 후보[0] 그리디 폴백.
     *  진짜 hang이 아니어도 15초 MCTS는 이미 비정상(정상 ≤6s)이라 폴백이 안전. */
    private static async mctsWithTimeout(game: ServerGameState, playerId: string, candidates: BotAction[], tag: string): Promise<BotAction | null> {
        const fallback = candidates[0] ?? null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<BotAction | null>(resolve => {
            timer = setTimeout(() => {
                log(`[MCTS-TIMEOUT] ${tag}: 15s 초과 → 후보[0] 폴백 (${fallback?.type ?? 'null'})`, 'error', game.id);
                resolve(fallback);
            }, 15000);
        });
        try {
            const res = await Promise.race([MCTS.search(game, playerId, candidates), timeout]);
            // [유령라운드 v4 2026-07-13] search가 예외/타임아웃 없이 null을 '반환'하면 race가 null로 풀려
            // candidates[0] 폴백을 우회 → 후보 17-34개 있는데 결정 null → 강제 패스(잔존 유령의 실체,
            // 진단 v3로 확정: cands=17~34 cur=me res=정상인데 null). null 반환도 폴백 적용.
            if (res == null && fallback) log(`[MCTS-NULL] ${tag}: search null 반환 → 후보[0] 폴백 (${fallback.type})`, 'error', game.id);
            return res ?? fallback;
        } catch (e) {
            log(`[MCTS-TIMEOUT] ${tag}: MCTS 예외 → 폴백: ${(e as Error)?.message}`, 'error', game.id);
            return fallback;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** [flag: twilightQicPlan v2] 사용자 룰(2026-07-11): 트와 3정큐(연방보상 재수령)는 R4+ 또는
     *  기술연방(ship-fed-tech) 획득 후에만 노린다 — v1(-9.58)은 조기 예약/사용 압박이 원인. */
    private static twilightTimingOk(game: ServerGameState, player: PlayerState): boolean {
        if ((game.roundNumber ?? 1) >= 4) return true;
        return getFederationEntries(player).some(e => e.rewardId === 'ship-fed-tech');
    }

    /** [flag: r1RebelCommit] 게임당 1봇을 '리벨리온 러너'로 지정 — 3정큐는 라운드당 1회 공유(선착순)라
     *  봇 셋이 경합하면 낭비. 이미 탑승한 봇이 있으면 그 봇(첫 번째), 없으면 진입 거리 QIC가 최소인 봇
     *  (동률 = turnOrder 앞) — 결정적이라 매 호출 재계산해도 동일 봇. */
    private static isRebelRunner(game: ServerGameState, playerId: string): boolean {
        const reb = game.map.find(t => t.type === 'ship_rebellion');
        if (!reb) return false;
        const bots = (game.botPlayerIds ?? []).filter(b => game.players[b]?.faction);
        if (!bots.includes(playerId)) return false;
        const boarded = bots.filter(b => (game.players[b].spaceshipsEntered ?? []).includes(reb.id));
        if (boarded.length) return boarded[0] === playerId;
        let best: string | null = null, bestNeed = Infinity;
        for (const b of (game.turnOrder ?? []).filter(id => bots.includes(id))) {
            const p = game.players[b];
            const myPl = game.map.filter(t => (t.ownerId === b && t.structure) || (t.spaceStation && (t.spaceStation as any).ownerId === b));
            if (!myPl.length) continue;
            const rng = this.getEffectiveBaseRange(p);
            const dist = Math.min(...myPl.map(t => getDistance(t, reb)));
            const need = dist > rng ? Math.ceil((dist - rng) / 2) : 0;
            if (need < bestNeed) { bestNeed = need; best = b; }
        }
        return best === playerId;
    }

    /** [flag: gaiaResearchUseGate] 가이아 L0→L1 연구가 '포머를 실제로 쓸 수 있는' 상황인지.
     *  요건: ①사거리+2(QIC 점프 여지) 내 미점유 트랜스딤 존재 ②총 파워 5+ (배치요구 6, 수입 감안). */
    private static gaiaResearchUsable(game: ServerGameState, playerId: string): boolean {
        const player = game.players[playerId];
        if (!player || player.faction === 'bal_tak') return false;
        // [flag: gaiaResearchPlaceSync] 실측(60판): R1 가이아 L1 연구 41건 중 15건(37%)이 R2까지 포머 미활용.
        // 원인 = 연구는 R1 허용인데 배치 후보는 noR1Gaiaformer가 R2+로 차단 → 한 라운드 어긋난 사이에
        // 토큰이 6 밑으로 새거나(정리변환) 트랜스딤 피격. 연구도 R2+로 동기화(연구→같은 라운드 배치).
        if (getPlayerFlag(playerId, 'gaiaResearchPlaceSync', true)
            && (game.roundNumber ?? 1) <= 1 && getPlayerFlag(playerId, 'noR1Gaiaformer', true)) return false;
        const myPl = game.map.filter(t => t.ownerId === playerId && t.structure);
        if (!myPl.length) return true;
        const rng = this.getEffectiveBaseRange(player) + 2;
        const td = game.map.some(t => t.type === 'transdim' && !t.structure && !t.hasGaiaformer
            && myPl.some(p => getDistance(p, t) <= rng));
        if (!td) return false;
        return ((player.power1 ?? 0) + (player.power2 ?? 0) + (player.power3 ?? 0)) >= 5;
    }

    /** advance_research 후보 생성 헬퍼: 그 전진이 충전을 유발하면(아무 트랙 L3 도달 +3PW, 경제 L5 +6PW,
     *  applyTrackLevelBonus) bowl 수용량 부족분을 chargeDrainPreActions로 미리 비워 충전 낭비를 막는다.
     *  충전을 안 일으키는 전진은 preActions 없이 그대로. */
    private static advanceResearchAction(playerId: string, player: PlayerState, trackId: ResearchTrack): BotAction {
        const newLevel = (player.research?.[trackId] ?? 0) + 1;
        const charge = newLevel === 3 ? 3 : (trackId === 'economy' && newLevel === 5 ? 6 : 0);
        const preActions = this.chargeDrainPreActions(playerId, player, charge);
        return preActions.length
            ? { type: 'advance_research', params: { trackId }, preActions }
            : { type: 'advance_research', params: { trackId } };
    }

    private static findSpecialActions(game: ServerGameState, playerId: string): BotAction[] {
        const player = game.players[playerId];
        const res: BotAction[] = [];

        // 메인 액션 완료 후에는 executeUseSpecialAction / use_tech_action 등이 서버에서 전부 거부됨.
        // (과거에 gleens-2nav·academy-qic를 '무료'로 넣었으나 둘 다 hasDoneMainAction 체크로 막혀 봇이 실패 루프에 빠짐)
        if (game.hasDoneMainAction) {
            return [];
        }

        // 1. 기술 타일 액션
        for (const tid of player.techTiles || []) {
            if (player.usedTechActions?.includes(tid)) continue;
            if (tid === 'tech-act-4p') {
                // [사용자 관찰] 4파워 충전 전에 bowl이 차 있으면(수용량 2*p1+p2 < 4) 충전이 버려진다 → bowl3 먼저 비워 수용량 확보.
                const preActions = this.chargeDrainPreActions(playerId, player, 4);
                res.push(preActions.length
                    ? { type: 'use_tech_action', params: { tileId: tid }, preActions }
                    : { type: 'use_tech_action', params: { tileId: tid } });
            }
            if (tid === 'adv-act-3k') res.push({ type: 'use_tech_action', params: { tileId: tid } });
            if (tid === 'adv-act-3o') res.push({ type: 'use_tech_action', params: { tileId: tid } });
            if (tid === 'adv-act-1q-5c') res.push({ type: 'use_tech_action', params: { tileId: tid } });
        }

        // 2. 종족 특수 액션 (use_special_action)
        // 글린 +2 Nav(게임당 1회)는 '그 사거리가 있어야 닿는 대상'이 있을 때만 후보로 — 안 그러면 켜 놓고
        // 가까운 곳/업그레이드를 해 보너스를 버린다(사용자 관찰).
        // 또한 이번 턴에 이미 다른 사거리 부스터(+3 보너스/트왈라잇 임시)가 켜져 있으면 추가로 켜지 않는다
        //   — 부스터끼리 한 턴에 중첩하지 않음(각각 별개 액션, 사용자 관찰).
        const anyRangeBoostActive = player.rangeBonusActive || player.tempRangeBonus;
        if (player.faction === 'gleens' && !player.usedSpecialActions?.includes('gleens-2nav')
            && !anyRangeBoostActive
            && this.rangeBoosterUnlocksTarget(game, playerId, 'gleensNavBonusActive')) {
            res.push({ type: 'use_special_action', params: { actionId: 'gleens-2nav' } });
        }
        if (player.faction === 'space_giants' && !player.usedSpecialActions?.includes('space_giants-2tf')) {
            // 2-step 스페셜은 '그 2스텝으로 실제 광산을 지을 수 있을 때만' 후보로 — 안 그러면 스텝 받고
            // 지을 데가 없어 폴백으로 연구를 올려 스텝을 통째로 버린다(사용자 관찰). gleens +2Nav 가드와 동일 취지.
            const prevSteps = player.pendingTerraformSteps || 0;
            let canBuildWith2 = false;
            try {
                player.pendingTerraformSteps = prevSteps + 2;
                canBuildWith2 = this.findBuildActionsWithPendingSteps(game, playerId).length > 0;
            } finally {
                player.pendingTerraformSteps = prevSteps;
            }
            if (canBuildWith2) {
                res.push({ type: 'use_special_action', params: { actionId: 'space_giants-2tf' } });
            }
        }
        if (player.faction === 'tinkeroids' && player.tinkeroidRoundSpecialId && !player.usedSpecialActions?.includes('tinkeroid-special')) {
            res.push({ type: 'use_special_action', params: { actionId: player.tinkeroidRoundSpecialId } });
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
                let shouldAdd = true;
                if (tile.specialAction === 'terraform_step') {
                    const oldSteps = player.pendingTerraformSteps || 0;
                    player.pendingTerraformSteps = oldSteps + 1;
                    const possibleBuildActions = this.findBuildActionsWithPendingSteps(game, playerId);
                    const bestPendingBuild = possibleBuildActions.length > 0 ? (possibleBuildActions as any[]).reduce((best, current) => (current.score > best.score ? current : best), possibleBuildActions[0]) : null;
                    player.pendingTerraformSteps = oldSteps;

                    if (!bestPendingBuild) {
                        shouldAdd = false;
                    } else {
                        // 만약 보너스를 썼는데도 모행성(steps=0)밖에 지을 데가 없다면 굳이 보너스를 쓸 이유가 없음
                        const targetTile = game.map.find(t => t.id === bestPendingBuild.params?.tileId);
                        if (targetTile && getTerraformStepsForFaction(game, player.faction!, targetTile.type!) === 0) {
                            shouldAdd = false;
                        }
                    }
                } else if (tile.specialAction === 'range_3' && !player.rangeBonusActive) {
                    // +3 사거리는 '그 사거리가 있어야 닿는' 광산/가이아포머/우주선입장이 있을 때만 — 사거리 필요 없는
                    // 가까운 빌드/업그레이드만 할 거면 켜지 않는다(보너스 낭비 방지, 사용자 관찰).
                    // 글린+2나 트왈라잇 임시 부스터가 이미 켜져 있으면 중첩하지 않음(각각 별개 액션).
                    if (player.gleensNavBonusActive || player.tempRangeBonus) shouldAdd = false;
                    else if (!this.rangeBoosterUnlocksTarget(game, playerId, 'rangeBonusActive')) shouldAdd = false;
                } else if (tile.specialAction === 'gaia_project' && getEffectiveGaiaformers(player) < 1) {
                    // [BONUSREJ 미러수정 2026-07-05] 포머 0개면 서버가 noFormer 거부 — 후보 자체를 안 냄
                    shouldAdd = false;
                }
                if (shouldAdd) {
                    res.push({ type: 'use_bonus_action', params: { actionId: tile.specialAction } });
                }
            }
        }

        return res;
    }
}
