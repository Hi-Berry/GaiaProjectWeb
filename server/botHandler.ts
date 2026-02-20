// Bot turn execution helper
import { Server as SocketIOServer } from 'socket.io';
import { BotLogic } from './ai/bot';
import {
    ServerGameState,
    executeBotIncomeSelection,
    executeBotSelectTechTile,
    executeAdvanceTech,
    executeBotTinkeroidSpecial,
    executeBotTerranCouncilBenefit,
    executeBotItarsGaiaformerExchange,
    executeBotMoweyipPlaceRing,
    executeBotBescodsAdvanceLowestTrack
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
            // 수익 선택 후 다음 수익 선택자나 턴 시작 확인을 위해 재호출
            setTimeout(() => executeBotTurnIfNeeded(io, game), 300);
            return;
        }
        return;
    }

    // === 팅커로이드 라운드 특수 능력 선택 대기: 봇이면 자동 처리 ===
    if (game.pendingTinkeroidSpecialChoice) {
        const tinkerPlayerId = game.pendingTinkeroidSpecialChoice.playerId;
        if (botPlayerIds.includes(tinkerPlayerId)) {
            await new Promise(resolve => setTimeout(resolve, 300));
            log(`Bot auto-handling Tinkeroid special choice`, 'game');
            executeBotTinkeroidSpecial(io, game, tinkerPlayerId);
            setTimeout(() => executeBotTurnIfNeeded(io, game), 300);
            return;
        }
        return;
    }

    // === 테란 의회 혜택 선택 대기: 봇이면 자동 처리 ===
    if (game.pendingTerranCouncilBenefit) {
        const terranPlayerId = game.pendingTerranCouncilBenefit.playerId;
        if (botPlayerIds.includes(terranPlayerId)) {
            await new Promise(resolve => setTimeout(resolve, 300));
            log(`Bot auto-handling Terran council benefits`, 'game');
            executeBotTerranCouncilBenefit(io, game, terranPlayerId);
            setTimeout(() => executeBotTurnIfNeeded(io, game), 300);
            return;
        }
        return;
    }

    // === 아이타 의회 가이아포머 환전 선택 대기: 봇이면 자동 처리 ===
    if (game.pendingItarsGaiaformerExchange) {
        const itarsPlayerId = game.pendingItarsGaiaformerExchange.playerId;
        if (botPlayerIds.includes(itarsPlayerId)) {
            await new Promise(resolve => setTimeout(resolve, 300));
            log(`Bot auto-handling Itars Gaiaformer exchange`, 'game');
            executeBotItarsGaiaformerExchange(io, game, itarsPlayerId);
            setTimeout(() => executeBotTurnIfNeeded(io, game), 300);
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
    } else if (game.currentPhase === 'factionSelect') {
        currentPlayerId = game.turnOrder[game.currentPlayerIndex];
    } else if (game.currentPhase === 'startingMines') {
        const totalMines = game.map.filter(t => t.structure === 'mine' || t.structure === 'planetary_institute').length;
        const snakingSequence = (game as any).startingMineSequence ?? [];
        if (snakingSequence.length > 0 && totalMines < snakingSequence.length) {
            currentPlayerId = snakingSequence[totalMines];
        } else {
            return;
        }
    } else if (game.currentPhase === 'bonusSelection') {
        currentPlayerId = game.pendingBonusSelection;
    }

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
            await new Promise(resolve => setTimeout(resolve, 400));
            log(`Bot ${moweyipPlayer.name} (Moweyip) auto-placing ring`, 'game');
            const ok = executeBotMoweyipPlaceRing(io, game, currentPlayerId);
            if (ok) {
                setTimeout(() => executeBotTurnIfNeeded(io, game), 500);
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
            await new Promise(resolve => setTimeout(resolve, 400));
            log(`Bot ${bescodsPlayer.name} (Bescods) auto-advancing lowest track`, 'game');
            const ok = executeBotBescodsAdvanceLowestTrack(io, game, currentPlayerId!);
            if (ok) {
                setTimeout(() => executeBotTurnIfNeeded(io, game), 500);
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
