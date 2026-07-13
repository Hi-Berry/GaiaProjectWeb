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
import { getPlayerFlag } from './ai/variant';

/** [flag: bescodsLateSpecial] 매안 트랙업(뺏길 수 없는 액션)을 라운드 첫 턴이 아니라 패스 직전으로 미루는 중.
 *  예외: 최하위 트랙이 L4면 L5 자리 선점 경쟁이 있는 유일한 케이스라 기존대로 즉시 사용. */
function bescodsSpecialDeferred(game: ServerGameState, playerId: string): boolean {
    const p = game.players[playerId];
    if (p?.faction !== 'bescods') return false;
    if (p.usedSpecialActions?.includes('bescods-advance-lowest')) return false;
    if (!getPlayerFlag(playerId, 'bescodsLateSpecial', true)) return false;
    const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
    const minLevel = Math.min(...tracks.map(t => p.research?.[t] ?? 0));
    return minLevel < 4; // L5 경쟁이면 미루지 않음
}

const botExecutingGames = new Set<string>();
// [hang수정 2026-07-12 2dezwrnl] 락 획득 시각 — doBotTurn 내부 await가 영영 안 풀리는 부류(async 미해결,
// MCTS는 15s 레이스로 방어됐지만 다른 await 지점은 무방비)에서 락이 영구 점유돼 게임 전체가 동결됨.
// 45초(정상 상한: MCTS 15s + 지연 수초)를 넘긴 락은 죽은 루프로 간주하고 회수(steal)한다.
const botExecutingSince = new Map<string, number>();
// 주의: 이 상태들은 game 객체에 두면 안 됨 — game은 socket emit/MCTS 클론에서 JSON 직렬화되는데
// Timeout은 순환 참조라 직렬화가 터져 게임 전체가 동결된다(스모크 12판 전멸로 실측). 모듈 Map으로 관리.
const botLoopGen = new Map<string, number>();
const botSelfCheckTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 어드민 롤백 등으로 게임 객체가 교체될 때, 진행 중이던 봇 루프 락을 해제해 새 게임에서 봇이 다시 시작될 수 있게 한다. */
export function cancelBotExecution(gameId: string): void {
    // 세대(gen)를 올려, 옛 게임 객체를 붙든 채 아직 살아있는 루프의 finally가
    // 새 게임에서 시작된 루프의 락을 지우지 못하게 한다(락 스틸과 동일한 보호).
    botLoopGen.set(gameId, (botLoopGen.get(gameId) ?? 0) + 1);
    botExecutingGames.delete(gameId);
    botExecutingSince.delete(gameId);
    const timer = botSelfCheckTimers.get(gameId);
    if (timer) { clearTimeout(timer); botSelfCheckTimers.delete(gameId); }
}

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
    // 어드민 롤백 등으로 무효화된(교체 전) 게임 객체를 붙든 옛 봇 루프는 더 진행하지 않음
    if ((game as any).botCanceled) return;
    if (!game.botPlayerIds || game.botPlayerIds.length === 0) return;

    // Module level lock to prevent concurrent executions for the same game
    if (botExecutingGames.has(game.id)) {
        // [hang수정 2026-07-12 2dezwrnl] 죽은 루프가 잡은 락은 회수. 세대(gen)를 올려 좀비 루프의
        // finally가 새 루프의 락을 지우지 못하게 한다. 회수 후 아래 월클록 워치독이 지문 무변화를
        // 감지해 forceSkip → 게임 재개.
        const heldMs = Date.now() - (botExecutingSince.get(game.id) ?? Date.now());
        if (heldMs <= 45000) return;
        botLoopGen.set(game.id, (botLoopGen.get(game.id) ?? 0) + 1);
        botExecutingGames.delete(game.id);
        log(`[LOCK-STEAL] bot loop lock held ${Math.round(heldMs / 1000)}s → 죽은 루프 간주, 회수 (gen=${botLoopGen.get(game.id)})`, 'error', game.id);
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
        (game.pendingEclipseAsteroidMine && game.botPlayerIds.includes(game.pendingEclipseAsteroidMine.playerId)) ||
        (game.pendingEclipseResearch && game.botPlayerIds.includes(game.pendingEclipseResearch.playerId));

    if (!isBotTurn && !hasPendingBotAutoChoice) {
        return;
    }

    // [hang수정 2026-07-04] 2차 월클록 워치독 — 카운터(STALL_THRESHOLD) 방식은 중간 성공(preAction 등)으로
    // 리셋되며 우회될 수 있음(관측: uk3aybql 무한 "must complete pending build" 수 분). gameLog 길이+턴 지문이
    // 20초간 무변화(=실제 진행 없음)면 무조건 강제 스킵. 정상 MCTS(≤6s)나 사람 턴(여기 도달 안 함)엔 무해.
    {
        const g = game as any;
        // [hang수정 2026-07-06 na0vujw3 서버로그] income/보너스선택 대기는 봇 hang이 아니라 정당한 대기다
        //   (특히 사람이 income을 천천히 고르거나 접속이 끊긴 동안). 이 시간을 봇 no-progress로 세면,
        //   라운드 시작의 첫 봇을 income 대기(실측 24초)만으로 20초 초과 판정해 즉시 강제스킵한다
        //   (→ 그 봇이 turnOrder에서 소멸=봇 증발 사고의 방아쇠였음). 해당 서브페이즈에선 타이머를 리셋해
        //   '봇의 실제 메인턴이 시작된 뒤'부터만 20초를 센다. (봇 income은 즉시 자동처리라 여기서 hang 안 됨.)
        // [hang수정 2026-07-07 사용자 가설 적중] income뿐 아니라 '사람이 잡고 있는 모든 pending'(아이타 교환,
        // 기술타일 선택, 테란의회, 연방보상 등) 대기도 정당한 대기다. 라운드 전환 직후엔 currentPlayerIndex가
        // 이전 라운드 잔재(봇)를 가리킬 수 있어, 사람이 아이타 타일을 20초+ 고민하면 그 봇을 forceSkip
        // → 봇이 라운드 통째로 패스(조용한 VP 손실). 사람 pending 활성 중엔 타이머 리셋.
        const humanHeldPending = [
            game.pendingItarsGaiaformerExchange?.playerId, game.pendingTechTileSelection?.playerId,
            game.pendingTerranCouncilBenefit?.playerId, game.pendingTinkeroidSpecialChoice?.playerId,
            game.pendingEclipseResearch?.playerId, game.pendingFederationReward?.playerId,
            game.pendingSpaceshipFedMine?.playerId, game.pendingLostPlanet?.playerId,
            game.pendingAdvancedTechCover?.playerId, game.pendingAdvancedTechTrackAdvance?.playerId,
            game.pendingEclipseAsteroidMine?.playerId, game.pendingShipTechTrackAdvance?.playerId,
            game.pendingShipTechMine?.playerId, (game as any).pendingTFMarsGaiaProject?.playerId,
        ].some(pid => pid && !(game.botPlayerIds ?? []).includes(pid))
            || (game.pendingPowerOffers ?? []).some(o => !o.responded && !(game.botPlayerIds ?? []).includes(o.targetPlayerId));
        if (game.pendingIncomeOrder || (game as any).pendingBonusSelection || game.currentPhase === 'bonusSelection' || humanHeldPending) {
            g._botWallFpr = null;
            g._botWallFprTs = Date.now();
        } else {
            const fpr = `${currentPlayerId}|${game.gameLog?.length ?? 0}|${game.roundNumber}|${game.currentPhase}|${game.hasDoneMainAction ? 1 : 0}`;
            if (g._botWallFpr === fpr) {
                if (Date.now() - (g._botWallFprTs ?? Date.now()) > 20000 && currentPlayerId) {
                    g._botWallFpr = null;
                    log(`wall-clock watchdog: no progress 20s → force skip (${fpr})`, 'error', game.id);
                    forceSkipStuckBotTurn(io, game, currentPlayerId, 'wall-clock watchdog 20s');
                    return;
                }
            } else {
                g._botWallFpr = fpr;
                g._botWallFprTs = Date.now();
            }
        }
    }

    botExecutingGames.add(game.id);
    botExecutingSince.set(game.id, Date.now());
    const myGen = botLoopGen.get(game.id) ?? 0;
    // [hang수정 2026-07-12] 동결 상태에선 소켓 이벤트도 안 와서 락 회수 기회 자체가 없음 → 지연 자가점검을
    // 게임당 1개만 예약(멱등 — 정상 진행 중이면 진입 가드에서 그냥 빠져나감).
    if (!botSelfCheckTimers.has(game.id)) {
        botSelfCheckTimers.set(game.id, setTimeout(() => { botSelfCheckTimers.delete(game.id); executeBotTurnIfNeeded(io, game); }, 50000));
    }
    game.isBotExecuting = true;
    try {
        await doBotTurn(io, game);
    } catch (error) {
        // [hang 근본수정 2026-07-05 최종] 예외 시 ①게임파일에 로깅(기존 콘솔-only는 워커 stdio:ignore로 증발 —
        // 예외 원인이 안 보였음) ②재스케줄(기존엔 루프가 여기서 영영 죽어 게임 동결 — udljuarm에서
        // "must complete pending build" 후 완전 침묵의 정체). 재스케줄되면 월클록 워치독이 20초 내 forceSkip으로 회복.
        const st = (error as Error)?.stack?.split('\n').slice(0, 4).join(' | ') ?? String(error);
        log(`Bot turn EXCEPTION (loop 재스케줄): ${st}`, 'error', game.id);
        setTimeout(() => executeBotTurnIfNeeded(io, game), d(1000));
    } finally {
        // 락이 회수(steal)됐다면 이 finally는 좀비 루프의 것 — 새 루프의 락/플래그를 건드리면 안 됨.
        if ((botLoopGen.get(game.id) ?? 0) === myGen) {
            game.isBotExecuting = false;
            botExecutingGames.delete(game.id);
        }
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
    // [flag: bescodsLateSpecial] ON이면 여기(라운드 첫 턴)서 안 쓰고 패스 직전 인터셉트에서 사용(무손실 순서 교정).
    if (game.currentPhase === 'main' && !game.hasDoneMainAction) {
        const bescodsPlayer = game.players[currentPlayerId ?? ''];
        if (
            bescodsPlayer?.faction === 'bescods' &&
            !bescodsSpecialDeferred(game, currentPlayerId) &&
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
    // [flag: ratioDiag] 계측(기본 OFF): 실제 턴마다 자원상태 + 고른 액션을 게임파일 로그. "크레딧 많은데 광석 없어
    //   빌드 못 하고 패스/변환"(비율 막힘) 빈도를 정량화 — 액션 45% 갭의 원인 규명용. 순수 로깅, 행동 무변.
    if (getPlayerFlag(currentPlayerId, 'ratioDiag', false) && game.currentPhase === 'main') {
        const r = player as any;
        // 업글은 타깃까지(mine→TS 구분: act=upgrade:trading_station). 광산 수 = 광석수입 엔진 크기.
        const mineCount = game.map.filter(t => t.ownerId === currentPlayerId && t.structure === 'mine').length;
        const actStr = action?.type === 'upgrade_structure'
            ? `upgrade:${(action.params as any)?.target ?? '?'}`
            : (action?.type ?? 'PASS');
        log(`[RATIODIAG] R${game.roundNumber} ${player.faction} O${r.ore ?? 0} C${r.credits ?? 0} K${r.knowledge ?? 0} Q${r.qic ?? 0} P3${r.power3 ?? 0} mines${mineCount} main${game.hasDoneMainAction ? 1 : 0} act=${actStr}`, 'ratiodiag', game.id);
    }
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
            // [flag: bescodsLateSpecial] 미뤄둔 매안 트랙업이 남아있으면 패스 전에 반드시 소진(공짜 전진 유실 방지)
            if (!game.hasDoneMainAction && bescodsSpecialDeferred(game, currentPlayerId)) {
                const spOk = executeBotBescodsAdvanceLowestTrack(io, game, currentPlayerId);
                if (spOk) { setTimeout(() => executeBotTurnIfNeeded(io, game), d(500)); return; }
            }
            // [유령라운드 v2 2026-07-13] 결정 null의 잔존 케이스(다카니안 K5·연구 5트랙 가능인데 후보 0) =
            // 라운드 전환 직후 인덱스 race: getCandidateMoves의 드리프트 가드(내 턴 아님 → [])가 전환 완료 전에
            // 평가됨. 즉시 패스 = 라운드 증발 → 1회 재시도(전환 완료 대기) 후에도 null이면 진짜 후보 없음으로 패스.
            {
                const g = game as any;
                if (!g._nullDecisionRetry) g._nullDecisionRetry = {};
                if ((g._nullDecisionRetry[currentPlayerId] ?? 0) < 1) {
                    g._nullDecisionRetry[currentPlayerId] = 1;
                    log(`Bot ${player.name} null decision → 1회 재시도 (전환 race 의심, R${game.roundNumber})`, 'game', game.id);
                    setTimeout(() => executeBotTurnIfNeeded(io, game), d(400));
                    return;
                }
                g._nullDecisionRetry[currentPlayerId] = 0;
            }
            const bonusTileId = game.availableBonusTiles?.length ? game.availableBonusTiles[0].id : undefined;
            // [유령라운드 가시화 2026-07-13] game.id 없이 찍혀 워커 stdio로 증발하던 로그 — 게임 파일에 기록 + 자원 덤프
            // (이 경로 = 결정 null 강제 패스가 '유령 라운드'의 실체였음. 자원 있는데 여기 오면 후보 생성 버그.)
            // [v3 진단] 재시도 후에도 null인 잔존 케이스(K4+·C20 등) 원인 특정용: 이 시점 후보 재산출 + 연구레벨 덤프
            let diagCands = -1;
            let diagList: any[] = [];
            try { diagList = BotLogic.getCandidateMoves(game, currentPlayerId) as any[]; diagCands = diagList.length; } catch { /* 진단 실패 무시 */ }
            const diagCur = game.turnOrder[game.currentPlayerIndex] === currentPlayerId ? 'me' : 'OTHER';
            log(`Bot ${player.name} has no valid action, forcing pass to advance turn (R${game.roundNumber} O${player.ore} C${player.credits} K${player.knowledge} Q${player.qic} P${player.power1}/${player.power2}/${player.power3} | cands=${diagCands} cur=${diagCur} res=${Object.values(player.research ?? {}).join('')})`, 'game', game.id);
            // [유령라운드 v5 2026-07-13] 결정 null인데 후보는 존재(진단 v3 실측: cands 12~23, 원인 = getNextMove
            // 체인 내 미상 null) → 어떤 후보든 패스(라운드 증발)보다 낫다. mctsWithTimeout 폴백과 같은 철학의
            // 핸들러 레벨 최종 그물: 비-패스 후보[0]를 그리디 실행, 실패 시에만 패스로 폴스루.
            const fb = diagList.find((c: any) => c.type !== 'pass_round') ?? null;
            if (fb) {
                let fbOk = true;
                for (const pre of (fb.preActions ?? [])) {
                    if (!await BotLogic.performAction(io, game, pre, currentPlayerId)) { fbOk = false; break; }
                }
                fbOk = fbOk && await BotLogic.performAction(io, game, { type: fb.type, params: fb.params }, currentPlayerId);
                if (fbOk) {
                    log(`Bot ${player.name} null-decision 그리디 폴백 실행: ${fb.type} (후보 ${diagCands}개 보존)`, 'game', game.id);
                    resetBotProgress(game);
                    setTimeout(() => executeBotTurnIfNeeded(io, game), d(500));
                    return;
                }
                log(`Bot ${player.name} 그리디 폴백(${fb.type}) 실패 → 패스 진행`, 'error', game.id);
            }
            const passOk = await BotLogic.performAction(io, game, { type: 'pass_round', params: { bonusTileId } }, currentPlayerId);
            if (passOk) { resetBotProgress(game); setTimeout(() => executeBotTurnIfNeeded(io, game), d(500)); }
            // [hang수정 2026-07-06] 패스마저 실패 = 막는 pending이 있다는 뜻(재시도해도 동일). 60회 재시도(≈30초)나
            //   20초 월클록을 기다리지 말고 즉시 forceSkip(모든 pending 청소 + hasPassed 직접설정 + passingOrder 보존)으로
            //   깨끗이 넘긴다 — 사람이 봇 hang을 기다리지 않게. (사용자 지적: 사람 대전 중 봇은 절대 hang되면 안 됨)
            else forceSkipStuckBotTurn(io, game, currentPlayerId, 'no-action pass failed → 즉시 안전스킵');
        }
        return;
    }

    // [flag: bescodsLateSpecial] 봇이 패스하려는 시점 = 이번 라운드 남은 액션이 없음 → 미뤄둔 매안 트랙업을 지금 사용.
    // (뺏길 수 없는 액션이라 마지막에 해도 가치 동일, 대신 앞 턴들을 경쟁 액션에 씀 — 사용자 순서 모델)
    if (action.type === 'pass_round' && game.currentPhase === 'main' && !game.hasDoneMainAction
        && bescodsSpecialDeferred(game, currentPlayerId)) {
        log(`Bot ${player.name} (Bescods) deferred lowest-track advance before pass`, 'game', game.id);
        const spOk = executeBotBescodsAdvanceLowestTrack(io, game, currentPlayerId);
        if (spOk) { resetBotProgress(game); setTimeout(() => executeBotTurnIfNeeded(io, game), d(500)); return; }
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
        // [유령라운드 v2] 정상 액션 성공 시 null-결정 재시도 카운터 리셋(라운드마다 1회 재시도 보장)
        if ((game as any)._nullDecisionRetry) (game as any)._nullDecisionRetry[currentPlayerId] = 0;
        resetBotProgress(game);
        setTimeout(() => executeBotTurnIfNeeded(io, game), d(500));
    } else {
        log(`Bot ${player.name} failed to execute ${action.type}. Action details: ${JSON.stringify(action)}`, 'error', game.id);
        // [hang 근본수정 2026-07-04] pending(우주선기술 무료광산/테라폼스텝) 상태에서 후보가 서버에 거부되면
        // pass도 서버가 거부(pending 우선) → 무한 재스케줄 루프(uk3aybql 수 분 hang). 첫 실패에 즉시 pending을
        // 정면 해소: skip_ship_tech_mine 시도, 안 되면 스텝 포기 — 낭비지만 무한루프·타임아웃보다 압도적으로 나음.
        if (game.currentPhase === 'main' && game.pendingShipTechMine?.playerId === currentPlayerId) {
            log(`Bot ${player.name} pending-build failed → skip_ship_tech_mine (근본해소). candidates were: ${JSON.stringify(action)}`, 'error', game.id);
            const skipOk = await BotLogic.performAction(io, game, { type: 'skip_ship_tech_mine', params: {} }, currentPlayerId);
            if (skipOk) { resetBotProgress(game); setTimeout(() => executeBotTurnIfNeeded(io, game), d(500)); return; }
        } else if (game.currentPhase === 'main' && (player.pendingTerraformSteps || 0) > 0 && action.type === 'build_mine') {
            log(`Bot ${player.name} pending-steps build failed → 스텝 포기(무한루프 방지)`, 'error', game.id);
            player.pendingTerraformSteps = 0;
        }
        if (game.currentPhase === 'main' && !player.hasPassed) {
            const bonusTileId = game.availableBonusTiles?.length ? game.availableBonusTiles[0].id : undefined;
            const passOk = await BotLogic.performAction(io, game, { type: 'pass_round', params: { bonusTileId } }, currentPlayerId);
            if (passOk) { resetBotProgress(game); setTimeout(() => executeBotTurnIfNeeded(io, game), d(500)); }
            // [hang수정 2026-07-06] 액션+패스 둘 다 실패 = 막는 pending. 재시도 루프(≈30초 hang) 대신 즉시 안전스킵.
            else forceSkipStuckBotTurn(io, game, currentPlayerId, `action ${action.type} + pass failed → 즉시 안전스킵`);
        } else {
            ensureBotProgress(io, game, currentPlayerId, `action ${action.type} failed, not main/passed`);
        }
    }
}
