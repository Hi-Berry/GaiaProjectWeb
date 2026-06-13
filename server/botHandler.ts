// Bot turn execution helper
import { Server as SocketIOServer } from 'socket.io';
import { BotLogic } from './ai/bot';
import {
    ServerGameState,
    executeBotIncomeSelection,
    executeBotSelectTechTile,
    executeAdvanceTech,
    executeCoverAdvancedTechTile,
    executeBotTinkeroidSpecial,
    executeBotTerranCouncilBenefit,
    executeBotItarsGaiaformerExchange,
    executeBotMoweyipPlaceRing,
    executeBotBescodsAdvanceLowestTrack,
    executeConvertResource,
    getLegalEclipseAsteroidMineTileIds,
    executeEclipseBuildAsteroidMine,
    forceSkipStuckBotTurn
} from './gameState';
import { log } from './index';
import { ResearchTrack } from '@shared/gameConfig';
import { recordDecisionFeatures } from './ai/valueData';

const botExecutingGames = new Set<string>();

// 봇 턴 사이 지연(ms). 기본은 데모/디버깅 가시성용. 자기대국/head-to-head 하니스에서는
// admin_set_bot_delay_ms 로 0에 가깝게 낮춰 게임을 빠르게 돌린다(로직 변화 없음).
let BOT_DELAY_MS: number | null = (typeof process !== 'undefined' && process.env?.BOT_DELAY_MS != null && process.env.BOT_DELAY_MS !== '')
    ? Math.max(0, parseInt(process.env.BOT_DELAY_MS, 10) || 0)
    : null;
export function setBotDelayMs(ms: number | null): void {
    BOT_DELAY_MS = ms == null ? null : Math.max(0, ms);
}
/** 기본 지연값 def를 받아, 오버라이드가 설정돼 있으면 그 값을, 아니면 def를 반환 */
function d(def: number): number {
    return BOT_DELAY_MS == null ? def : BOT_DELAY_MS;
}

// === Stall 워치독 ===
// 봇 액션/패스가 실패하면(라운드 전환 레이스, 보너스타일 부재 등) 그냥 멈추지 않고 재호출해 자가복구하되,
// 연속 무진행이 임계치를 넘으면 게임을 강제 종료해 영구 정지를 막는다. 진행이 있으면 카운터를 리셋.
const STALL_THRESHOLD = 60;
function resetBotProgress(game: ServerGameState): void {
    (game as any)._botNoProgress = 0;
}
function ensureBotProgress(io: SocketIOServer, game: ServerGameState, currentPlayerId: string, reason: string): void {
    if (game.currentPhase === 'gameEnd') return; // 이미 종료 → 헛돌지 않게
    const g = game as any;
    g._botNoProgress = (g._botNoProgress || 0) + 1;
    if (g._botNoProgress >= STALL_THRESHOLD) {
        g._botNoProgress = 0;
        // 게임을 끝내지 않고 막힌 봇만 스킵 → 유저 게임이 계속됨
        forceSkipStuckBotTurn(io, game, currentPlayerId, `bot stall watchdog: ${reason}`);
        return;
    }
    setTimeout(() => executeBotTurnIfNeeded(io, game), d(500));
}

function recordBotActionForFeedback(game: ServerGameState, playerId: string, action: { type: string; params?: any; preActions?: any[] }, source: string) {
    const player = game.players[playerId];
    if (!player) return null;
    const entry = {
        id: `${Date.now()}-${playerId}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        playerId,
        playerName: player.name,
        actionType: action.type,
        params: action.params,
        preActions: action.preActions,
        source,
        roundNumber: game.roundNumber,
        phase: game.currentPhase,
    };
    if (!game.botActionsForFeedback) game.botActionsForFeedback = [];
    game.botActionsForFeedback.push(entry);
    if (game.botActionsForFeedback.length > 50) game.botActionsForFeedback.shift();
    game.lastBotActionForFeedback = entry;
    return entry;
}

function addBotFeedbackLog(game: ServerGameState, playerId: string, entry: NonNullable<ReturnType<typeof recordBotActionForFeedback>>) {
    const logs = game.gameLog ?? [];
    for (let i = logs.length - 1; i >= 0; i--) {
        const logEntry = logs[i];
        if (logEntry.playerId === playerId && !logEntry.aiFeedbackActionId) {
            logEntry.aiFeedbackActionId = entry.id;
            return;
        }
    }
}

/**
 * Execute bot turn if current player is a bot
 * Called after any game state update during main phase
 */
export async function executeBotTurnIfNeeded(io: SocketIOServer, game: ServerGameState): Promise<void> {
    if (game.currentPhase === 'lobby') return;
    if (!game.botPlayerIds || game.botPlayerIds.length === 0) return;

    // Module level lock to prevent concurrent executions for the same game
    if (botExecutingGames.has(game.id)) {
        return;
    }

    // Determine current player ID based on phase
    let currentPlayerId: string | null = null;
    if (game.currentPhase === 'factionBidding') {
        return;
    }
    if (game.currentPhase === 'main' || game.currentPhase === 'factionSelect') {
        currentPlayerId = game.turnOrder[game.currentPlayerIndex];
    } else if (game.currentPhase === 'startingMines') {
        const totalMines = game.map.filter(t => t.structure === 'mine' || t.structure === 'planetary_institute').length;
        const snakingSequence = (game as any).startingMineSequence ?? [];
        if (snakingSequence.length > 0 && totalMines < snakingSequence.length) {
            currentPlayerId = snakingSequence[totalMines];
        }
    } else if (game.currentPhase === 'bonusSelection') {
        currentPlayerId = game.pendingBonusSelection;
    }

    // Special blocking conditions (e.g. pending income or other specific bot-auto-choices)
    // If there's a pending choice for a bot, we process it. 
    // Otherwise, we only proceed if it's a bot's regular turn.
    const isBotTurn = currentPlayerId && game.botPlayerIds.includes(currentPlayerId);
    const hasPendingBotAutoChoice =
        (game.pendingIncomeOrder && game.botPlayerIds.includes(game.pendingIncomeOrder.playerId)) ||
        (game.pendingTinkeroidSpecialChoice && game.botPlayerIds.includes(game.pendingTinkeroidSpecialChoice.playerId)) ||
        (game.pendingTerranCouncilBenefit && game.botPlayerIds.includes(game.pendingTerranCouncilBenefit.playerId)) ||
        (game.pendingItarsGaiaformerExchange && game.botPlayerIds.includes(game.pendingItarsGaiaformerExchange.playerId)) ||
        (game.pendingTechTileSelection && game.botPlayerIds.includes(game.pendingTechTileSelection.playerId)) ||
        (game.pendingShipTechTrackAdvance && game.botPlayerIds.includes(game.pendingShipTechTrackAdvance.playerId)) ||
        (game.pendingAdvancedTechCover && game.botPlayerIds.includes(game.pendingAdvancedTechCover.playerId)) ||
        (game.pendingAdvancedTechTrackAdvance && game.botPlayerIds.includes(game.pendingAdvancedTechTrackAdvance.playerId)) ||
        (game.pendingEclipseAsteroidMine && game.botPlayerIds.includes(game.pendingEclipseAsteroidMine.playerId));

    if (!isBotTurn && !hasPendingBotAutoChoice) {
        return;
    }

    botExecutingGames.add(game.id);
    game.isBotExecuting = true;
    try {
        await doBotTurn(io, game);
    } catch (error) {
        log(`Bot turn execution error for game ${game.id}: ${error}`, 'error');
    } finally {
        game.isBotExecuting = false;
        botExecutingGames.delete(game.id);
    }
}

async function doBotTurn(io: SocketIOServer, game: ServerGameState): Promise<void> {
    const botPlayerIds = game.botPlayerIds;
    if (!botPlayerIds || botPlayerIds.length === 0) return;

    if (game.pendingIncomeOrder) {
        const incomePlayerId = game.pendingIncomeOrder.playerId;
        if (botPlayerIds.includes(incomePlayerId)) {
            await new Promise(resolve => setTimeout(resolve, d(300)));
            const botPlayer = game.players[incomePlayerId];
            log(`Bot ${botPlayer?.name} auto-handling income selection`, 'game');
            executeBotIncomeSelection(io, game, incomePlayerId);
            // 수익 선택 후 다음 수익 선택자나 턴 시작 확인을 위해 재호출
            setTimeout(() => executeBotTurnIfNeeded(io, game), d(300));
            return;
        }
        return;
    }

    // === 팅커로이드 라운드 특수 능력 선택 대기: 봇이면 자동 처리 ===
    if (game.pendingTinkeroidSpecialChoice) {
        const tinkerPlayerId = game.pendingTinkeroidSpecialChoice.playerId;
        if (botPlayerIds.includes(tinkerPlayerId)) {
            await new Promise(resolve => setTimeout(resolve, d(300)));
            log(`Bot auto-handling Tinkeroid special choice`, 'game');
            executeBotTinkeroidSpecial(io, game, tinkerPlayerId);
            setTimeout(() => executeBotTurnIfNeeded(io, game), d(300));
            return;
        }
        return;
    }

    // === 테란 의회 혜택 선택 대기: 봇이면 자동 처리 ===
    if (game.pendingTerranCouncilBenefit) {
        const terranPlayerId = game.pendingTerranCouncilBenefit.playerId;
        if (botPlayerIds.includes(terranPlayerId)) {
            await new Promise(resolve => setTimeout(resolve, d(300)));
            log(`Bot auto-handling Terran council benefits`, 'game');
            executeBotTerranCouncilBenefit(io, game, terranPlayerId);
            setTimeout(() => executeBotTurnIfNeeded(io, game), d(300));
            return;
        }
        return;
    }

    // === 아이타 의회 가이아포머 환전 선택 대기: 봇이면 자동 처리 ===
    if (game.pendingItarsGaiaformerExchange) {
        const itarsPlayerId = game.pendingItarsGaiaformerExchange.playerId;
        if (botPlayerIds.includes(itarsPlayerId)) {
            await new Promise(resolve => setTimeout(resolve, d(300)));
            log(`Bot auto-handling Itars Gaiaformer exchange`, 'game');
            executeBotItarsGaiaformerExchange(io, game, itarsPlayerId);
            setTimeout(() => executeBotTurnIfNeeded(io, game), d(300));
            return;
        }
        return;
    }

    // === 기술 타일 선택 대기: 봇이면 자동 처리 ===
    // BotLogic.findTechTileAction(점수 로그·calculateTechTileScore)을 쓰도록 함.
    // 예전 executeBotSelectTechTile은 트랙 순서대로 첫 타일만 집어서 로그/전략이 따로 놀았음.
    if (game.pendingTechTileSelection) {
        const techPlayerId = game.pendingTechTileSelection.playerId;
        if (botPlayerIds.includes(techPlayerId)) {
            await new Promise(resolve => setTimeout(resolve, d(300)));
            const botPlayer = game.players[techPlayerId];
            log(`Bot ${botPlayer?.name} auto-handling tech tile selection (scored pick)`, 'game', game.id);
            const techPick = await BotLogic.getNextMove(game, techPlayerId, false);
            // [버그수정] 기존엔 'select_tech_tile'만 수락해서, MCTS가 고급 기술타일(select_advanced_tech_tile)을
            // 골라도 fallback(일반 타일)으로 덮어씀 → 봇 고급타일 0개의 직접 원인 (자격 있는 선택 23회 중 채택 0회).
            if (techPick?.type === 'select_tech_tile' || techPick?.type === 'select_advanced_tech_tile') {
                const feedbackEntry = recordBotActionForFeedback(game, techPlayerId, techPick, 'pending_tech');
                const ok = await BotLogic.performAction(io, game, techPick, techPlayerId);
                if (!ok) {
                    log(`Bot ${botPlayer?.name} performAction select_tech_tile failed, fallback executeBotSelectTechTile`, 'game', game.id);
                    const fallbackEntry = recordBotActionForFeedback(game, techPlayerId, { type: 'select_tech_tile_fallback', params: {} }, 'pending_tech_fallback');
                    executeBotSelectTechTile(io, game, techPlayerId);
                    if (fallbackEntry) addBotFeedbackLog(game, techPlayerId, fallbackEntry);
                } else if (feedbackEntry) {
                    addBotFeedbackLog(game, techPlayerId, feedbackEntry);
                }
            } else {
                log(`Bot ${botPlayer?.name} getNextMove did not return select_tech_tile (${techPick?.type ?? 'null'}), fallback executeBotSelectTechTile`, 'game', game.id);
                const fallbackEntry = recordBotActionForFeedback(game, techPlayerId, { type: 'select_tech_tile_fallback', params: { reason: techPick?.type ?? 'null' } }, 'pending_tech_fallback');
                executeBotSelectTechTile(io, game, techPlayerId);
                if (fallbackEntry) addBotFeedbackLog(game, techPlayerId, fallbackEntry);
            }
            // 기술 타일 선택 후 다시 확인 (pendingShipTechTrackAdvance 등 후속 대기 가능)
            setTimeout(() => executeBotTurnIfNeeded(io, game), d(300));
            return;
        }
        return;
    }

    // === Eclipse 6C 후 소행성 광산: getNextMove null 시 pass_round로 넘어가던 버그 방지, 서버 합법 타일로 즉시 건설 ===
    if (game.pendingEclipseAsteroidMine && game.currentPhase === 'main') {
        const eclipsePid = game.pendingEclipseAsteroidMine.playerId;
        if (botPlayerIds.includes(eclipsePid) && game.turnOrder[game.currentPlayerIndex] === eclipsePid) {
            await new Promise(resolve => setTimeout(resolve, d(300)));
            const legal = getLegalEclipseAsteroidMineTileIds(game, eclipsePid);
            if (legal.length > 0) {
                const tileId = BotLogic.pickBestEclipseAsteroidTile(game, eclipsePid, legal);
                const botPlayer = game.players[eclipsePid];
                log(`Bot ${botPlayer?.name} auto eclipse asteroid mine on ${tileId}`, 'game', game.id);
                executeEclipseBuildAsteroidMine(io, game, eclipsePid, tileId);
                setTimeout(() => executeBotTurnIfNeeded(io, game), d(300));
                return;
            }
            log(`Bot ${game.players[eclipsePid]?.name ?? eclipsePid} pending Eclipse mine but no legal asteroid in range`, 'error', game.id);
            return;
        }
    }

    // === 우주선 기술 트랙 진행 대기: 봇이면 자동 처리 ===
    if (game.pendingShipTechTrackAdvance) {
        const shipTechPlayerId = game.pendingShipTechTrackAdvance.playerId;
        if (botPlayerIds.includes(shipTechPlayerId)) {
            await new Promise(resolve => setTimeout(resolve, d(300)));
            const botPlayer = game.players[shipTechPlayerId];
            // 낮은 레벨 우선으로, 실제로 진행 가능한(executeAdvanceTech가 true를 반환하는) 첫 트랙을 올린다.
            // 4→5는 초록연방/트랙선점 게이트로 막힐 수 있어, 막힌 트랙을 계속 고르면 pending이 안 풀려
            // 무한 재시도(데드락)가 난다. 반환값으로 판별하고, 전부 막히면 보너스를 포기하고 pending을 해제한다.
            const tracks: ResearchTrack[] = ['economy', 'terraforming', 'science', 'navigation', 'artificialIntelligence', 'gaiaProject'];
            const ordered = tracks
                .map(t => ({ t, lv: botPlayer.research[t] ?? 0 }))
                .filter(x => x.lv < 5)
                .sort((a, b) => a.lv - b.lv);
            let advanced = false;
            for (const { t } of ordered) {
                if (executeAdvanceTech(io, game, shipTechPlayerId, t)) {
                    log(`Bot ${botPlayer?.name} auto-advancing ship tech track: ${t}`, 'game');
                    const feedbackEntry = recordBotActionForFeedback(game, shipTechPlayerId, { type: 'advance_tech', params: { trackId: t } }, 'pending_ship_tech_track');
                    if (feedbackEntry) addBotFeedbackLog(game, shipTechPlayerId, feedbackEntry);
                    advanced = true;
                    break;
                }
            }
            if (!advanced) {
                game.pendingShipTechTrackAdvance = null; // 진행 가능한 트랙 없음 → 데드락 방지 위해 해제
                log(`Bot ${botPlayer?.name} ship tech: no advanceable track, clearing pending to avoid stall`, 'game', game.id);
            }
            setTimeout(() => executeBotTurnIfNeeded(io, game), d(300));
            return;
        }
        return;
    }

    // === 고급 기술타일 '커버' 대기: 봇이면 자동 처리 (없으면 게임이 멈춤 → 타임아웃 버그) ===
    // select_advanced_tech_tile 직후 pendingAdvancedTechCover가 걸리는데 전용 핸들러가 없어
    // 봇이 일반 메인턴 경로(hasDoneMainAction=true라 무동작)로 빠져 게임이 hang됐었음.
    if (game.pendingAdvancedTechCover) {
        const coverPlayerId = game.pendingAdvancedTechCover.playerId;
        if (botPlayerIds.includes(coverPlayerId)) {
            await new Promise(resolve => setTimeout(resolve, d(300)));
            const botPlayer = game.players[coverPlayerId];
            // 덮을 일반(비고급) 기술타일 중 아직 안 덮인 것 — 가치 낮은 income 타일 우선(여기선 첫 미커버).
            const covered = new Set(botPlayer?.coveredTechTiles ?? []);
            const coverTileId = (botPlayer?.techTiles ?? []).find(
                (tid: string) => !tid.startsWith('adv-') && !covered.has(tid)
            ) ?? null;
            if (coverTileId && executeCoverAdvancedTechTile(io, game, coverPlayerId, coverTileId)) {
                log(`Bot ${botPlayer?.name} auto-cover for advanced tile: ${coverTileId}`, 'game', game.id);
            } else {
                game.pendingAdvancedTechCover = null; // 덮을 타일 없음 → 데드락 방지 해제
                log(`Bot ${botPlayer?.name} adv-tile cover: no coverable tile, clearing pending to avoid stall`, 'game', game.id);
            }
            setTimeout(() => executeBotTurnIfNeeded(io, game), d(300));
            return;
        }
        return;
    }

    // === 고급 기술 트랙 진행 대기: 봇이면 자동 처리 ===
    if (game.pendingAdvancedTechTrackAdvance) {
        const advPlayerId = game.pendingAdvancedTechTrackAdvance.playerId;
        if (botPlayerIds.includes(advPlayerId)) {
            await new Promise(resolve => setTimeout(resolve, d(300)));
            const botPlayer = game.players[advPlayerId];
            // ship tech와 동일: 진행 가능한 트랙을 반환값으로 찾고, 전부 막히면 pending 해제(데드락 방지).
            const tracks: ResearchTrack[] = ['economy', 'terraforming', 'science', 'navigation', 'artificialIntelligence', 'gaiaProject'];
            const ordered = tracks
                .map(t => ({ t, lv: botPlayer.research[t] ?? 0 }))
                .filter(x => x.lv < 5)
                .sort((a, b) => a.lv - b.lv);
            let advanced = false;
            for (const { t } of ordered) {
                if (executeAdvanceTech(io, game, advPlayerId, t)) {
                    log(`Bot ${botPlayer?.name} auto-advancing advanced tech track: ${t}`, 'game');
                    const feedbackEntry = recordBotActionForFeedback(game, advPlayerId, { type: 'advance_tech', params: { trackId: t } }, 'pending_advanced_tech_track');
                    if (feedbackEntry) addBotFeedbackLog(game, advPlayerId, feedbackEntry);
                    advanced = true;
                    break;
                }
            }
            if (!advanced) {
                game.pendingAdvancedTechTrackAdvance = null; // 진행 가능한 트랙 없음 → 데드락 방지 위해 해제
                log(`Bot ${botPlayer?.name} advanced tech: no advanceable track, clearing pending to avoid stall`, 'game', game.id);
            }
            setTimeout(() => executeBotTurnIfNeeded(io, game), d(300));
            return;
        }
        return;
    }

    let currentPlayerId: string | null = null;

    if (game.currentPhase === 'main') {
        currentPlayerId = game.turnOrder[game.currentPlayerIndex];
    } else if (game.currentPhase === 'factionSelect') {
        currentPlayerId = game.turnOrder[game.currentPlayerIndex];
    } else if (game.currentPhase === 'startingMines') {
        const totalMinesPlaced = Object.values(game.players).reduce((sum, p) => sum + (p.startingMinesPlaced || 0), 0);
        const snakingSequence = (game as any).startingMineSequence ?? [];
        if (snakingSequence.length > 0 && totalMinesPlaced < snakingSequence.length) {
            currentPlayerId = snakingSequence[totalMinesPlaced];
        } else {
            return;
        }
    } else if (game.currentPhase === 'bonusSelection') {
        currentPlayerId = game.pendingBonusSelection;
    }

    log(`BotHandler DEBUG: phase=${game.currentPhase}, currentPlayer=${currentPlayerId}, isBot=${botPlayerIds.includes(currentPlayerId || '')}`, 'game');

    if (!currentPlayerId || !botPlayerIds.includes(currentPlayerId)) return;

    // === 모웨이드: 의회 보유 + 링 미사용 상태면 자동으로 링 놓기 처리 (메인 액션 전에만) ===
    if (game.currentPhase === 'main' && !game.hasDoneMainAction) {
        const moweyipPlayer = game.players[currentPlayerId];
        if (
            moweyipPlayer?.faction === 'moweyip' &&
            !moweyipPlayer.usedSpecialActions?.includes('moweyip-place-ring') &&
            game.map.some(t => t.ownerId === currentPlayerId && t.structure === 'planetary_institute') &&
            game.map.some(t => t.ownerId === currentPlayerId && t.structure && t.structure !== 'ship' && !(t as any).moweyipRing)
        ) {
            await new Promise(resolve => setTimeout(resolve, d(400)));
            log(`Bot ${moweyipPlayer.name} (Moweyip) auto-placing ring`, 'game');
            const ok = executeBotMoweyipPlaceRing(io, game, currentPlayerId);
            if (ok) {
                setTimeout(() => executeBotTurnIfNeeded(io, game), d(500));
                return;
            }
        }
    }

    // === 매안(Bescods): 미사용 상태면 자동으로 가장 낮은 트랙 +1 처리 ===
    if (game.currentPhase === 'main' && !game.hasDoneMainAction) {
        const bescodsPlayer = game.players[currentPlayerId ?? ''];
        if (
            bescodsPlayer?.faction === 'bescods' &&
            !bescodsPlayer.usedSpecialActions?.includes('bescods-advance-lowest')
        ) {
            await new Promise(resolve => setTimeout(resolve, d(400)));
            log(`Bot ${bescodsPlayer.name} (Bescods) auto-advancing lowest track`, 'game');
            const ok = executeBotBescodsAdvanceLowestTrack(io, game, currentPlayerId!);
            if (ok) {
                setTimeout(() => executeBotTurnIfNeeded(io, game), d(500));
                return;
            }
        }
    }

    // Check if any human player has a pending power offer (blocking game flow)
    const pendingHumanOffers = game.pendingPowerOffers?.filter(o => !o.responded && !botPlayerIds.includes(o.targetPlayerId));
    if (pendingHumanOffers && pendingHumanOffers.length > 0) {
        return;
    }

    const player = game.players[currentPlayerId];
    if (!player || player.hasPassed) return;

    // Delay to make it more visible for debugging/demo
    await new Promise(resolve => setTimeout(resolve, d(500)));

    // 가치망 학습 데이터: 봇이 결정하는 시점의 상태 특징 기록(VALUE_NET_COLLECT=1일 때만)
    recordDecisionFeatures(game, currentPlayerId);

    const action = await BotLogic.getNextMove(game, currentPlayerId);
    if (!action) {
        if (game.currentPhase === 'main' && !player.hasPassed) {
            // Eclipse 소행성 대기 중인데 후보가 비면 패스하면 안 됨 (6C만 소모된 상태)
            if (game.pendingEclipseAsteroidMine?.playerId === currentPlayerId) {
                log(`Bot ${player.name} eclipse mine pending but getNextMove returned null; not forcing pass`, 'error', game.id);
                return;
            }
            // 메인 액션은 했는데 후보만 비어 있으면 end_turn 먼저 시도 (pending 블로커 시 pass 실패 대비)
            if (game.hasDoneMainAction) {
                const endOk = await BotLogic.performAction(io, game, { type: 'end_turn', params: {} }, currentPlayerId);
                if (endOk) {
                    setTimeout(() => executeBotTurnIfNeeded(io, game), d(500));
                    return;
                }
            }
            const bonusTileId = game.availableBonusTiles?.length ? game.availableBonusTiles[0].id : undefined;
            log(`Bot ${player.name} has no valid action, forcing pass to advance turn`, 'game');
            const passOk = await BotLogic.performAction(io, game, { type: 'pass_round', params: { bonusTileId } }, currentPlayerId);
            if (passOk) { resetBotProgress(game); setTimeout(() => executeBotTurnIfNeeded(io, game), d(500)); }
            else ensureBotProgress(io, game, currentPlayerId, 'no-action pass failed'); // 멈추지 말고 재시도/스킵
        }
        return;
    }

    log(`Bot ${player.name} executing: ${action.type}`, 'game');
    const preActions = (action as any).preActions as any[] | undefined;
    let preOk = true;
    if (preActions?.length) {
        for (const pre of preActions) {
            const ok = await BotLogic.performAction(io, game, pre, currentPlayerId);
            if (!ok) {
                log(`Bot ${player.name} failed preAction ${pre.type}`, 'error', game.id);
                preOk = false;
                break;
            }
        }
    }
    const mainAction = preActions?.length ? { type: action.type, params: action.params } : action;
    const feedbackEntry = recordBotActionForFeedback(game, currentPlayerId, action as any, 'main_turn');
    const success = preOk && await BotLogic.performAction(io, game, mainAction, currentPlayerId);

    if (success) {
        if (feedbackEntry) addBotFeedbackLog(game, currentPlayerId, feedbackEntry);
        log(`Bot ${player.name} successfully executed ${action.type}`, 'game', game.id);
        resetBotProgress(game);
        setTimeout(() => executeBotTurnIfNeeded(io, game), d(500));
    } else {
        log(`Bot ${player.name} failed to execute ${action.type}. Action details: ${JSON.stringify(action)}`, 'error', game.id);
        if (game.currentPhase === 'main' && !player.hasPassed) {
            const bonusTileId = game.availableBonusTiles?.length ? game.availableBonusTiles[0].id : undefined;
            const passOk = await BotLogic.performAction(io, game, { type: 'pass_round', params: { bonusTileId } }, currentPlayerId);
            if (passOk) { resetBotProgress(game); setTimeout(() => executeBotTurnIfNeeded(io, game), d(500)); }
            else ensureBotProgress(io, game, currentPlayerId, `action ${action.type} + pass failed`);
        } else {
            ensureBotProgress(io, game, currentPlayerId, `action ${action.type} failed, not main/passed`);
        }
    }
}
