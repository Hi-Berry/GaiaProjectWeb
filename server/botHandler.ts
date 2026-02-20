// Bot turn execution helper
import { Server as SocketIOServer } from 'socket.io';
import { BotLogic } from './ai/bot';
import {
    ServerGameState,
    executeBotIncomeSelection,
    executeBotSelectTechTile,
    executeAdvanceTech
} from './gameState';
import { log } from './index';
import { ResearchTrack } from '@shared/gameConfig';

/**
 * Execute bot turn if current player is a bot
 * Called after any game state update during main phase
 */
export async function executeBotTurnIfNeeded(io: SocketIOServer, game: ServerGameState): Promise<void> {
    if (!game.botPlayerIds || game.botPlayerIds.length === 0) return;
    if (game.isBotExecuting) return;

    game.isBotExecuting = true;
    try {
        await doBotTurn(io, game);
    } catch (error) {
        log(`Bot turn execution error: ${error}`, 'error');
    } finally {
        game.isBotExecuting = false;
    }
}

async function doBotTurn(io: SocketIOServer, game: ServerGameState): Promise<void> {
    const botPlayerIds = game.botPlayerIds;
    if (!botPlayerIds || botPlayerIds.length === 0) return;

    if (game.pendingIncomeOrder) {
        const incomePlayerId = game.pendingIncomeOrder.playerId;
        if (botPlayerIds.includes(incomePlayerId)) {
            await new Promise(resolve => setTimeout(resolve, 300));
            const botPlayer = game.players[incomePlayerId];
            log(`Bot ${botPlayer?.name} auto-handling income selection`, 'game');
            executeBotIncomeSelection(io, game, incomePlayerId);
            return;
        }
        return;
    }

    // === 기술 타일 선택 대기: 봇이면 자동 처리 ===
    if (game.pendingTechTileSelection) {
        const techPlayerId = game.pendingTechTileSelection.playerId;
        if (botPlayerIds.includes(techPlayerId)) {
            await new Promise(resolve => setTimeout(resolve, 300));
            const botPlayer = game.players[techPlayerId];
            log(`Bot ${botPlayer?.name} auto-handling tech tile selection`, 'game');
            executeBotSelectTechTile(io, game, techPlayerId);
            // 기술 타일 선택 후 다시 확인 (pendingShipTechTrackAdvance 등 후속 대기 가능)
            setTimeout(() => executeBotTurnIfNeeded(io, game), 300);
            return;
        }
        return;
    }

    // === 우주선 기술 트랙 진행 대기: 봇이면 자동 처리 ===
    if (game.pendingShipTechTrackAdvance) {
        const shipTechPlayerId = game.pendingShipTechTrackAdvance.playerId;
        if (botPlayerIds.includes(shipTechPlayerId)) {
            await new Promise(resolve => setTimeout(resolve, 300));
            const botPlayer = game.players[shipTechPlayerId];
            // 가장 낮은 트랙을 선택해 진행
            const tracks: ResearchTrack[] = ['economy', 'terraforming', 'science', 'navigation', 'artificialIntelligence', 'gaiaProject'];
            let bestTrack: ResearchTrack | null = null;
            let bestLevel = 99;
            for (const t of tracks) {
                const lv = botPlayer.research[t] ?? 0;
                if (lv < 5 && lv < bestLevel) {
                    bestLevel = lv;
                    bestTrack = t;
                }
            }
            if (bestTrack) {
                log(`Bot ${botPlayer?.name} auto-advancing ship tech track: ${bestTrack}`, 'game');
                executeAdvanceTech(io, game, shipTechPlayerId, bestTrack);
            }
            setTimeout(() => executeBotTurnIfNeeded(io, game), 300);
            return;
        }
        return;
    }

    // === 고급 기술 트랙 진행 대기: 봇이면 자동 처리 ===
    if (game.pendingAdvancedTechTrackAdvance) {
        const advPlayerId = game.pendingAdvancedTechTrackAdvance.playerId;
        if (botPlayerIds.includes(advPlayerId)) {
            await new Promise(resolve => setTimeout(resolve, 300));
            const botPlayer = game.players[advPlayerId];
            const tracks: ResearchTrack[] = ['economy', 'terraforming', 'science', 'navigation', 'artificialIntelligence', 'gaiaProject'];
            let bestTrack: ResearchTrack | null = null;
            let bestLevel = 99;
            for (const t of tracks) {
                const lv = botPlayer.research[t] ?? 0;
                if (lv < 5 && lv < bestLevel) {
                    bestLevel = lv;
                    bestTrack = t;
                }
            }
            if (bestTrack) {
                log(`Bot ${botPlayer?.name} auto-advancing advanced tech track: ${bestTrack}`, 'game');
                executeAdvanceTech(io, game, advPlayerId, bestTrack);
            }
            setTimeout(() => executeBotTurnIfNeeded(io, game), 300);
            return;
        }
        return;
    }

    let currentPlayerId: string | null = null;

    if (game.currentPhase === 'main') {
        currentPlayerId = game.turnOrder[game.currentPlayerIndex];
    }
    else if (game.currentPhase === 'factionSelect') {
        currentPlayerId = game.turnOrder[game.currentPlayerIndex];
    }
    else if (game.currentPhase === 'startingMines') {
        const totalMines = game.map.filter(t => t.structure === 'mine' || t.structure === 'planetary_institute').length;
        const snakingSequence = (game as any).startingMineSequence ?? [];
        if (snakingSequence.length > 0 && totalMines < snakingSequence.length) {
            currentPlayerId = snakingSequence[totalMines];
        } else {
            return;
        }
    }
    else if (game.currentPhase === 'bonusSelection') {
        currentPlayerId = game.pendingBonusSelection;
    }

    if (!currentPlayerId || !botPlayerIds.includes(currentPlayerId)) return;

    // Check if any human player has a pending power offer (blocking game flow)
    const pendingHumanOffers = game.pendingPowerOffers?.filter(o => !o.responded && !botPlayerIds.includes(o.targetPlayerId));
    if (pendingHumanOffers && pendingHumanOffers.length > 0) {
        return;
    }

    const player = game.players[currentPlayerId];
    if (!player || player.hasPassed) return;

    // Delay to make it more visible for debugging/demo
    await new Promise(resolve => setTimeout(resolve, 500));

    const action = BotLogic.getNextMove(game, currentPlayerId);
    if (!action) {
        log(`Bot ${player.name} has no valid action, skipping turn`, 'game');
        return;
    }

    log(`Bot ${player.name} executing: ${action.type}`, 'game');
    const success = await BotLogic.performAction(io, game, action, currentPlayerId);

    if (success) {
        log(`Bot ${player.name} successfully executed ${action.type}`, 'game');
        setTimeout(() => executeBotTurnIfNeeded(io, game), 500);
    } else {
        log(`Bot ${player.name} failed to execute ${action.type}`, 'error');
    }
}
