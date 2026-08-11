import zlib from 'zlib';
import { Server as SocketIOServer } from 'socket.io';
import { setActiveEvaluatorWeights, getActiveEvaluatorWeights, type EvaluatorWeights } from './ai/evaluator';
import { MCTS } from './ai/mcts';
import type { Server as HTTPServer } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './index';
import { getClientBuildId } from './static';
import { setSeatPassword, findSeatByPassword } from './accounts';
import { StateCloner } from './ai/stateCloner';
import type {
	GaiaGameState,
	PlayerState,
	HexTile,
	StructureType,
	ResearchTrack,
	PowerAction
} from '@shared/gameConfig';
import {
	FACTIONS,
	generateMap,
	INITIAL_POWER_ACTIONS,
	ECONOMY_INCOME,
	ECONOMY_INCOME_POWER,
	ECONOMY_INCOME_VP,
	STRUCTURE_INCOME,
	chargePower,
	chargePowerTaklons,
	applyPowerIncome,
	findOptimalIncomeOrder,
	snapshotPlayerPower,
	restorePlayerPowerSnapshot,
	getMaxPowerGain,
	isPowerLeechPointlessAfterIncome,
	canSpendTaklonsPower,
	spendTaklonsPower,
	planTokenSpend,
	createInitialPlayerState,
	ALL_TECH_TILES,
	ALL_ADVANCED_TECH_TILES,
	ALL_BONUS_TILES,
	getRange,
	getTerraformCost,
	getTerraformSteps,
	getTerraformStepsForFaction,
	getGaiaBaseQic,
	computeExpansionThreeStepPlanets,
	HOME_PLANETS,
	getDistance,
	BonusTile,
	ROUND_MISSION_POOL,
	ScoringTile,
	SHIP_TECH_TILES,
	SHIP_TECH_BY_SHIP,
	FEDERATION_REWARDS,
	FEDERATION_12VP_ID,
	GLEENS_FEDERATION_REWARD,
	SPACESHIP_FEDERATION_REWARDS,
	getFederationEntries,
	countGreenFederations,
	spendGreenFederation,
	isTechTileCovered,
	ARTIFACTS,
	getNeighbors,
	isEmptyHex,
	isPlanetHex,
	BUILDING_LIMITS,
	FINAL_MISSION_IDS,
	getFinalMissionValue,
	// 패스 점수: 클라 미리보기와 공용 (shared가 단일 출처)
	computeBonusTilePassVp,
	computeAdvancedTechPassVp,
	getOwnedPlanetTypes,
	getMineCountForPassAndBonuses as sharedGetMineCountForPassAndBonuses,
	countRemainingGaiaformers as sharedCountRemainingGaiaformers,
	countOccupiedSectors,
	tileOccupiesSector as sharedTileOccupiesSector,
	RESEARCH_TRACK_END_BONUS,
	RESEARCH_TRACKS,
	isHiddenSpectatorName,
	type ScoreBreakdown,
} from '@shared/gameConfig';
import { executeBotTurnIfNeeded, setBotDelayMs, cancelBotExecution } from './botHandler';
import { setPlayerVariant, clearAllPlayerVariants, getPlayerFlag, type PlayerVariant } from './ai/variant';
import { flushGameData } from './ai/valueData';
import * as FactionBidding from './factionBidding';
import { exportHumanGameDataset, recordHumanActionFromLog, recordFullGameLog, buildLiveSnapshot, submitToScoreSite, type HumanActionJournalEntry } from './humanGameLogger';




// Extend GaiaGameState for server-specific metadata
export interface ServerGameState extends GaiaGameState {
	id: string;
	hostId: string;
	/** 방장 브라우저의 socket.id (한 컴퓨터 4인플 시 조작 전환 후에도 방장이 다시 전환 가능하도록) */
	hostSocketId?: string;
	currentPlayerIndex: number;
	maxPlayers: number;
	createdAt: number;
	/** AI 봇 플레이어 ID 목록 */
	botPlayerIds?: string[];
	/** 관전자 ID 목록 (플레이어 슬롯 없음, 턴 없음) */
	spectatorIds?: string[];
	turnStartState?: Record<string, any>; // [playerId]: PlayerTurnState (현재(또는 가장 최근) 턴 시작 스냅샷)
	prevTurnStartState?: Record<string, any>; // [playerId]: 직전 턴 시작 스냅샷 (현재 턴이 비었을 때 어드민 롤백이 한 턴 더 되감기용)
	isBotExecuting?: boolean; // 봇 로직이 실행 중인지 확인하는 락
	simulation?: boolean; // MCTS 시뮬레이션 중인지 여부 (로그 억제용)
	freeActionUndoStack?: string[]; // Free Action 단계별 Undo 스냅샷 스택(최신이 끝)
	freeActionUndoContext?: { playerId: string; roundNumber: number; currentPlayerIndex: number };
	queuedPowerOffers?: NonNullable<GaiaGameState['pendingPowerOffers']>; // 턴 종료 전까지 보류되는 파워 제안
	pendingTurnEndPlayerId?: string; // 파워 수락 대기 때문에 턴 종료가 보류된 플레이어 ID
	humanActionJournal?: HumanActionJournalEntry[];
	humanActionJournalExported?: boolean;
}



const games = new Map<string, ServerGameState>();
// [사용자] AI 봇 추가 허용 여부(서버별). 기본 허용. env AI_ENABLED(또는 AI_AVAILABLE/AI_BOTS_ENABLED)=0 이면
// 봇 추가·Auto Setup 비활성(로비 버튼 숨김 + 서버 거부) — 상태 페이지 표기(isAiEnabled)와 동일 판정.
const AI_BOTS_ENABLED = isAiEnabled();

/** [대역폭 2단계 2026-07-26, 사용자] gameLog는 후반 100KB+로 최대 잔여 항목 — 액션 브로드캐스트엔 꼬리만
 *  보내고(전체 길이/시작 인덱스 동봉) 클라가 병합·보관. 전체 로그는 입장/재접속 콜백(callback({game}))이 담당
 *  → 늦게 들어와도/재접해도 처음부터 다 보임. {...game} 스프레드는 non-enumerable 무거운 필드도 자동 제외. */
const GAME_LOG_TAIL = 40;
const _emitStats: Record<string, { n: number; raw: number; gz: number }> = {};
/** [대역폭 2026-08-07, 사용자] 실측: 게임당 emit 4,000~5,500회(압축 후 47~67MB/수신자) — 액션 1회에 20~29회.
 *  원인은 "상태를 바꿀 때마다 보낸다"는 관행(165개 호출 지점)이고, 같은 이벤트 루프 tick 안에서 연달아 나가는
 *  emit은 화면상 구분되지 않는다(브라우저는 마지막 상태만 그림). → tick 단위로 합쳐 마지막 1회만 실제 전송.
 *  ★사용자 경험 불변 보장: (1) tick 경계를 넘는 emit(봇 순차 진행·타이머·소켓 응답)은 그대로 각각 나감
 *  (2) 합쳐지는 건 '같은 tick 안의 중간 상태'뿐이라 클라가 보던 최종 상태와 동일 (3) EMIT_COALESCE=0으로 즉시 해제. */
const _pendingEmit = new Map<string, { io: any; game: any }>();
function flushPendingEmit(gameId: string) {
	const p = _pendingEmit.get(gameId);
	if (!p) return;
	_pendingEmit.delete(gameId);
	// ★정합성: 이 tick에 롤백/리셋으로 game 객체가 통째로 교체됐거나(games.set) 방이 삭제됐을 수 있다.
	//   항상 현재 등록된 게임을 우선 사용하고, 삭제됐으면 아무것도 보내지 않는다(유령 상태 방송 방지).
	const cur = games.get(gameId);
	if (!cur) return;
	emitGameUpdatedNow(p.io, cur);
}
export function emitGameUpdated(io: any, game: any) {
	if (process.env.EMIT_COALESCE === '0' || !game?.id) { emitGameUpdatedNow(io, game); return; }
	const had = _pendingEmit.has(game.id);
	_pendingEmit.set(game.id, { io, game });   // 항상 최신 game 참조로 갱신
	if (!had) queueMicrotask(() => flushPendingEmit(game.id));
}
function emitGameUpdatedNow(io: any, game: any) {
	const logArr = game.gameLog || [];
	const payload = logArr.length > GAME_LOG_TAIL
		? { ...game, gameLog: logArr.slice(-GAME_LOG_TAIL), gameLogStart: logArr.length - GAME_LOG_TAIL, gameLogLen: logArr.length }
		: { ...game, gameLogStart: 0, gameLogLen: logArr.length };
	// [계측, EMIT_BYTES=1일 때만] 게임당 emit 바이트 실측(원본+deflate 근사 — 실제 스트림 압축은 이보다 유리)
	if (process.env.EMIT_BYTES) {
		try {
			const s = JSON.stringify(payload);
			const st = (_emitStats[game.id] ??= { n: 0, raw: 0, gz: 0 });
			st.n++; st.raw += s.length; st.gz += zlib.deflateRawSync(Buffer.from(s)).length;
			if (game.currentPhase === 'gameEnd') {
				fs.appendFileSync('data/emit-bytes.log', JSON.stringify({ id: game.id, ...st }) + '\n');
				delete _emitStats[game.id];
			}
		} catch { /* 계측 실패 무시 */ }
	}
	io.to(game.id).emit('game_updated', payload);
}

/** [대역폭 2026-07-26, 사용자: 하루 10GB] game_updated가 액션마다 게임 전체(893KB)를 방 전원에 emit —
 *  그중 730KB가 클라 미사용 서버 전용(turnStartState 등, 플레이어별 맵 스냅샷). non-enumerable로 만들어
 *  코드 접근은 그대로 두고 JSON 직렬화(socket emit·파일 저장)에서만 자동 제외. 재할당해도 유지됨. */
function hideHeavyServerFields(game: any) {
	for (const k of ['turnStartState', 'prevTurnStartState', 'humanActionJournal', 'fullGameLog']) {
		Object.defineProperty(game, k, { value: game[k], writable: true, configurable: true, enumerable: false });
	}
}

/** [의회 pending 가드 2026-07-26, 사용자] 아이타/테란 의회 능력(가이아 단계 타일/혜택 선택)이 진행 중이면
 *  라운드 첫 액션이 열려도 모든 메인 액션을 보류 — 파워 수락 대기와 동일한 순서 보장. */
function councilPendingActive(game: GaiaGameState): boolean {
	// [확장 2026-07-27, 사용자] 이클립스 6C(소행성 건설)·2K+3P(트랙 선택) 진행 중에도 다른 메인 액션이
	// 열려 있던 구멍 — 전용 해소 핸들러(eclipse_build_asteroid_mine/cancel_eclipse_asteroid_mine/
	// eclipse_advance_track/cancel_eclipse_research)는 이 가드 목록에 없어 그대로 동작.
	// [확장 2026-07-27, 사용자] 수입 단계 시퀀스(팅커 선택 → 아이타/테란 의회 → 첫 턴)의 '사이 틈' 봉쇄:
	// 팅커로이드 라운드 선택(pendingTinkeroidSpecialChoice)과 의회 대기열(queue — 현재 pending이 잠깐 비는
	// 전환 순간 포함)도 가드. 해소 핸들러(tinkeroid_choose_special 등)는 가드 목록 밖이라 정상 동작.
	return !!(game.pendingItarsGaiaformerExchange || game.pendingTerranCouncilBenefit
		|| (game as any).pendingTinkeroidSpecialChoice
		|| (game.terranCouncilQueue?.length ?? 0) > 0
		|| ((game as any).terranCouncilQueueAfterItars?.length ?? 0) > 0
		// [버그수정 2026-07-31, 사용자] 아이타 4토큰 교환의 '기술타일 선택' 단계도 가드 —
		//   교환 도중(pendingItarsGaiaformerExchange가 null이 되고 pendingTechTileSelection[itars_pi_exchange]로
		//   넘어간 순간) 다른 플레이어가 액션 가능했던 문제(8토큰=2회 교환 시 특히). 해소 핸들러(select_tech_tile)는
		//   councilPendingActive를 체크하지 않으므로 소유자는 안 막힘.
		//   (교환 후 우주선 tech 후속단계[트랙전진/광산]는 소유자 build_mine/advance_tech가 이 가드를 체크하므로
		//    여기 포함하지 않음 — 소유자 해소를 막지 않기 위함.)
		|| ((game as any).pendingTechTileSelection?.structureType === 'itars_pi_exchange')
		|| (game as any).pendingEclipseAsteroidMine || (game as any).pendingEclipseResearch);
}

/** [상태 페이지 실시간 안내 2026-08-04, 사용자] 상태 페이지의 '여기서 플레이하세요' 안내를
 *  재배포(Netlify)·재시작(Render) 없이 즉시 바꾸기 위한 서버별 런타임 안내.
 *  /api/status에 실려 나가고 상태 페이지가 그대로 표시한다. 설정은 /api/status/notice (admin 토큰).
 *  recommend=true인 서버가 여러 개면 상태 페이지가 updatedAt이 가장 최신인 것을 고른다
 *  → 새 서버를 지정할 때 나머지를 일일이 해제할 필요가 없다(URL 1개로 전환). */
type StatusNotice = { text: string; recommend: boolean; updatedAt: number };
let statusNotice: StatusNotice = { text: '', recommend: false, updatedAt: 0 };

function statusNoticeFilePath(): string {
	return path.join(process.cwd(), 'data', 'status-notice.json');
}
/** 재시작에도 안내를 유지(같은 인스턴스 수명 내). Render 파일시스템은 재배포 시 초기화되는데,
 *  그때는 안내가 비어 자동 추천으로 되돌아가므로 안전한 방향으로 실패한다. */
function loadStatusNotice(): void {
	try {
		const raw = fs.readFileSync(statusNoticeFilePath(), 'utf8');
		const j = JSON.parse(raw);
		statusNotice = {
			text: typeof j?.text === 'string' ? j.text.slice(0, 200) : '',
			recommend: !!j?.recommend,
			updatedAt: Number(j?.updatedAt) || 0,
		};
	} catch { /* 없거나 깨졌으면 기본값(빈 안내) */ }
}
loadStatusNotice();

export function getStatusNotice(): StatusNotice {
	return statusNotice;
}
/** 안내 설정/해제. text 200자 제한, 즉시 /api/status에 반영됨(폴링 주기만큼만 지연). */
export function setStatusNotice(next: { text?: string; recommend?: boolean }): StatusNotice {
	statusNotice = {
		text: (next.text ?? statusNotice.text).slice(0, 200),
		recommend: next.recommend ?? statusNotice.recommend,
		updatedAt: Date.now(),
	};
	try {
		fs.mkdirSync(path.dirname(statusNoticeFilePath()), { recursive: true });
		fs.writeFileSync(statusNoticeFilePath(), JSON.stringify(statusNotice), 'utf8');
	} catch { /* 읽기전용 FS여도 메모리 값은 살아있으므로 무시 */ }
	return statusNotice;
}

/** [상태 대시보드] 외부 status 페이지(Netlify)가 CORS로 조회하는 공개 요약 — 개인정보/게임내용 없음 */
export function getPublicStatus() {
	let humanPlayers = 0, activeGames = 0;
	for (const g of Array.from(games.values())) {
		if ((g as any).simulation || g.currentPhase === 'gameEnd') continue;
		activeGames++;
		humanPlayers += Math.max(0, Object.keys(g.players || {}).length - ((g as any).botPlayerIds?.length || 0));
	}
	return {
		ok: true, activeGames, humanPlayers, aiEnabled: isAiEnabled(),
		notice: statusNotice.text || null,
		recommend: statusNotice.recommend,
		noticeAt: statusNotice.updatedAt || null,
		ts: Date.now(),
	};
}
/** AI 봇 사용 가능 여부 — Render 환경변수로 서버별 지정 (AI_ENABLED / AI_AVAILABLE / AI_BOTS_ENABLED 중 아무거나).
 *  미설정이면 true. '0'/'false'/'off'/'no'면 false. 상태 페이지 표기용. */
export function isAiEnabled(): boolean {
	const raw = process.env.AI_ENABLED ?? process.env.AI_AVAILABLE ?? process.env.AI_BOTS_ENABLED;
	if (raw == null || raw === '') return true;
	return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}
/** [사람 우선 스로틀 2026-07-20] 사람이 참여한 진행 중 게임이 (지정 게임 외에) 존재하는가 —
 *  봇 전용 방의 MCTS가 이벤트 루프를 점유해 사람 방이 렉 걸리는 문제(사용자)의 판별용. */
export function hasActiveHumanGame(exceptGameId?: string): boolean {
	for (const [id, g] of Array.from(games.entries())) {
		if (id === exceptGameId) continue;
		if ((g as any).simulation) continue;
		if (g.currentPhase === 'lobby' || g.currentPhase === 'gameEnd') continue;
		const bots = new Set(g.botPlayerIds || []);
		if (Object.keys(g.players).some(pid => !bots.has(pid))) return true;
	}
	return false;
}
const playerGameMap = new Map<string, string>();
const socketToPlayerMap = new Map<string, string>();
const socketToSpectatorMap = new Map<string, string>();
const spectatorToGameMap = new Map<string, string>();
/** [숨은 관전 아이디] HIDDEN_SPECTATOR_NAME('---')으로 들어온 관전자 id. 서버 메모리에만 두어
 *  game 객체(=브로드캐스트 payload·롤백 스냅샷)에 이름/흔적을 남기지 않는다. 재접속 시 숨김 유지 판정용.
 *  게임은 메모리에만 존재해 서버 재시작 시 게임과 함께 무의미해지므로 별도 정리 없이 둔다(항목당 수십 바이트). */
const hiddenSpectatorIds = new Set<string>();
// [사용자] 폰에서 잠깐 앱 전환(카톡 등) 후 복귀 시 '떠났/다시접속' 채팅 스팸 방지용 디바운스 타이머.
//   키 = `${gameId}:${playerId}`. 해제 시 45초 타이머 설정 → 그 안에 재접속하면 취소(무알림), 넘으면 '떠났' 표시.
const LEFT_ANNOUNCE_DELAY_MS = 45000;
const leftAnnounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function deepClone<T>(value: T): T {
	// Prefer structuredClone to preserve undefined/Date/Map/Set/etc.
	// Fallback to JSON clone for older runtimes or unsupported values.
	try {
		const sc = (globalThis as any).structuredClone;
		if (typeof sc === 'function') return sc(value) as T;
	} catch (_e) {
		// ignore and fall back
	}
	return JSON.parse(JSON.stringify(value)) as T;
}

function buildFreeActionUndoSnapshot(game: ServerGameState): string {
	// [메모리] 클론 전에 무거운 서버 전용 필드를 잠시 떼어낸다.
	// turnStartState/prevTurnStartState엔 플레이어별 fullGameState 클론이 들어 있어,
	// 그대로 cloneGameState하면 자유액션 1회마다 게임 전체+스냅샷 6벌을 복제해 메모리가 폭증한다.
	// 이 필드들은 스냅샷에 불필요(undo 복원 시 라이브 게임에서 다시 붙임).
	const detached = {
		turnStartState: game.turnStartState,
		prevTurnStartState: game.prevTurnStartState,
		freeActionUndoStack: game.freeActionUndoStack,
		freeActionUndoState: (game as any).freeActionUndoState,
		freeActionUndoContext: game.freeActionUndoContext,
		// [메모리] gameLog/humanActionJournal도 떼고 클론한다. turn-start 스냅샷(cloneGameForTurnStartSnapshot)은
		// 이미 이 둘을 제외하는데, free-action 스냅샷만 StateCloner 통째복제라 제외 안 해 왔다(비일관 버그).
		// humanActionJournal은 사람게임(=프로덕션 OOM 상황)에서 게임 용량의 ~90%까지 자라므로, 프리액션 1회마다
		// 이걸 복제·문자열화해 스택에 쌓으면 메모리가 폭증한다. undo 복원 시 라이브 로그를 다시 붙인다(아래 핸들러).
		gameLog: game.gameLog,
		humanActionJournal: game.humanActionJournal,
	};
	game.turnStartState = undefined;
	game.prevTurnStartState = undefined;
	game.freeActionUndoStack = undefined;
	(game as any).freeActionUndoState = undefined;
	game.freeActionUndoContext = undefined;
	game.gameLog = undefined as any;
	game.humanActionJournal = undefined as any;
	try {
		const cloned = StateCloner.cloneGameState(game) as ServerGameState;
		cloned.queuedPowerOffers = undefined;
		cloned.pendingTurnEndPlayerId = undefined;
		return JSON.stringify(cloned);
	} finally {
		game.turnStartState = detached.turnStartState;
		game.prevTurnStartState = detached.prevTurnStartState;
		game.freeActionUndoStack = detached.freeActionUndoStack;
		(game as any).freeActionUndoState = detached.freeActionUndoState;
		game.freeActionUndoContext = detached.freeActionUndoContext;
		game.gameLog = detached.gameLog;
		game.humanActionJournal = detached.humanActionJournal;
	}
}

function clearFreeActionUndo(game: ServerGameState): void {
	(game as any).freeActionUndoState = undefined;
	game.freeActionUndoStack = [];
	game.freeActionUndoContext = undefined;
}

function pushFreeActionUndoSnapshot(game: ServerGameState): void {
	const playerId = game.turnOrder?.[game.currentPlayerIndex];
	const context = {
		playerId: playerId ?? '',
		roundNumber: game.roundNumber ?? 0,
		currentPlayerIndex: game.currentPlayerIndex ?? 0,
	};
	const oldContext = game.freeActionUndoContext;
	if (!oldContext || oldContext.playerId !== context.playerId || oldContext.roundNumber !== context.roundNumber || oldContext.currentPlayerIndex !== context.currentPlayerIndex) {
		game.freeActionUndoStack = [];
	}
	if (!game.freeActionUndoStack) game.freeActionUndoStack = [];
	// 하위 호환: 기존 단일 스냅샷이 남아 있으면 스택의 첫 항목으로 승격
	if ((game as any).freeActionUndoState && game.freeActionUndoStack.length === 0) {
		game.freeActionUndoStack.push((game as any).freeActionUndoState);
	}
	game.freeActionUndoContext = context;
	game.freeActionUndoStack.push(buildFreeActionUndoSnapshot(game));
	// [메모리] 백스톱: 한 턴에 프리액션이 비정상적으로 많아도 스택이 무한정 자라지 않게 상한(오래된 것부터 버림).
	// 40단계면 정상 플레이의 되돌리기엔 충분하고, 그 이전까지 되돌릴 일은 사실상 없음.
	const FREE_UNDO_CAP = 40;
	if (game.freeActionUndoStack.length > FREE_UNDO_CAP) {
		game.freeActionUndoStack.splice(0, game.freeActionUndoStack.length - FREE_UNDO_CAP);
	}
	(game as any).freeActionUndoState = undefined;
}

/**
 * 턴 시작/리셋용 전체 게임 스냅샷. turnStartState를 제외해 복사하면
 * 중첩으로 인한 기하급수적 용량 증가와 RangeError: Invalid string length 방지.
 */
function cloneGameForTurnStartSnapshot(game: ServerGameState): ServerGameState {
	const { turnStartState: _ts, prevTurnStartState: _pts, freeActionUndoState: _fa, gameLog: _gl, humanActionJournal: _haj, ...rest } = game as any;
	// Reset 복원에는 gameLog 본문/Undo 원본 문자열이 필수 아님(길이만 사용) → 스냅샷 용량 대폭 절감
	const cloned = deepClone(rest) as ServerGameState;
	cloned.turnStartState = undefined;
	cloned.prevTurnStartState = undefined;
	(cloned as any).freeActionUndoState = undefined;
	cloned.freeActionUndoStack = undefined;
	cloned.freeActionUndoContext = undefined;
	cloned.queuedPowerOffers = undefined;
	cloned.pendingTurnEndPlayerId = undefined;
	cloned.gameLog = [];
	return cloned;
}

/** Reset/턴 시작 스냅샷 1건 — 라이브 game.turnStartState를 통째로 붙이면 타 플레이어·옛 fullGameState 참조가 섞여 멀티플레이에서 잘못 복구될 수 있음 */
// [per-candidate 학습] 사람 결정시점의 '가능했던 후보 수' 캡처용 훅(DI로 BotLogic.getCandidateMoves 주입 — 순환참조 회피).
// index.ts에서 setHumanCandidateHook로 주입. 사람 게임 학습데이터에 (선택한 수 + 대안 후보)를 남겨 per-candidate 정책 가능.
// var(호이스팅): 단독 tsx 진입(counterfactual 등)에서 순환 import 시 index.ts가 이 모듈 초기화 전에
// setHumanCandidateHook을 호출해도 TDZ 에러가 안 나게 — let이면 ReferenceError(실측).
// eslint-disable-next-line no-var
var _humanCandidateHook: ((game: ServerGameState, playerId: string) => any[]) | null = null;
export function setHumanCandidateHook(fn: (game: ServerGameState, playerId: string) => any[]): void {
	_humanCandidateHook = fn;
}
function captureHumanCandidates(game: ServerGameState, playerId: string): any[] | undefined {
	if (!_humanCandidateHook) return undefined;
	if ((game as any).botPlayerIds?.includes(playerId)) return undefined; // 사람만
	if (game.currentPhase !== 'main') return undefined;                   // 메인 결정만(핵심)
	try {
		const cands = _humanCandidateHook(game, playerId) || [];
		// 경량 저장: 타입 + 식별 파라미터만(피처는 저장된 최종맵으로 사후계산). 폭주 방지 40개 캡.
		return cands.slice(0, 40).map((c: any) => ({
			type: c.type, tileId: c.params?.tileId, trackId: c.params?.trackId,
			target: c.params?.target, actionId: c.params?.actionId,
			// [2026-07-25 학습빌드] 우주선 액션 파라미터 — 미캡처라 per-candidate 학습에서 배 액션 구분 불가였음
			// (통합랭커 ship 95% 허수의 원인). undefined는 JSON에서 자동 탈락이라 비-우주선 후보 페이로드 증가 없음.
			shipTileId: c.params?.shipTileId, actionIndex: c.params?.actionIndex,
		}));
	} catch { return undefined; } // 캡처 실패는 게임에 절대 영향 없음
}

function buildTurnStartStateEntryForPlayer(game: ServerGameState, playerId: string) {
	clearFreeActionUndo(game);
	// 턴 시작(또는 리셋) 시점 = 이 플레이어 액션 변동량의 기준선. 인컴/지난 턴/누수가 '이 턴 액션'에 안 섞이게 한다.
	resetLogSnapBase(game, playerId);
	return {
		playerId,
		roundNumber: game.roundNumber,
		currentPlayerIndex: game.currentPlayerIndex,
		playerState: deepClone(game.players[playerId]),
		humanCandidates: captureHumanCandidates(game, playerId), // [per-candidate 학습] 결정시점 가능 후보들
		mapState: deepClone(game.map),
		spaceshipsState: game.spaceships ? deepClone(game.spaceships) : undefined,
		twilightArtifactSlots: game.twilightArtifactSlots ? deepClone(game.twilightArtifactSlots) : undefined,
		gameLogLength: game.gameLog?.length || 0,
		// gameLog는 100개 초과 시 앞에서 shift되어 '길이'가 절대 인덱스로 못 쓰임 → 단조 카운터로 턴 시작 시점 기록.
		gameLogSeqAt: (game as any).gameLogSeq ?? 0,
		// [메모리] gameLog/journal 전체 복제(gameLogState·humanActionJournalState)는 제거.
		// 후반 게임에서 턴마다·플레이어마다 큰 로그를 6벌씩 복제해 게임 객체가 비대해지고 OOM의 주원인이었음.
		// 리셋은 길이(gameLogLength·humanActionJournalLength)로 라이브 로그를 잘라 복원한다(restoreGameLogForReset).
		gameLogSnapshotAt: Date.now(),
		humanActionJournalLength: game.humanActionJournal?.length ?? 0,
		fullGameState: cloneGameForTurnStartSnapshot(game),
	};
}

/**
 * [턴 롤백] playerId의 '턴 시작 스냅샷'을 새로 캡처하되, 기존(직전 턴) 스냅샷은 prevTurnStartState로 밀어 보존한다.
 * 예전엔 finalizeTurnEnd(정상 턴 전환)만 이 prev-보존을 했고, 라운드/페이즈 시작 경로(helperStartNewRoundTurn·Itars/Terran·
 * 가이아포머·executeSelectBonus·executePassRound·admin_set_current_turn)는 turnStartState만 덮어써 prev를 잃었다 → 그
 * 경계를 넘어온 턴에서 어드민 롤백이 '직전 턴'을 못 찾고 현재 턴 시작으로 폴백하던 버그(사용자: "4K 쓰기 전으로 안 가고
 * 현재 턴으로만 감"). 캡처 지점을 이 헬퍼로 통일한다. 참조 이관만 하므로(clone 아님) 추가 메모리 없음.
 * ※ 라운드 경계를 넘어선 prev는 admin_rollback_turn이 roundNumber 가드로 걸러 과도한 되감기(인컴 재적용 등)를 막는다.
 */
/** [롤백] gameId별 압축 턴 시작 스냅샷 히스토리 (서버 메모리, 게임 객체와 분리 — 클론/emit/저장 무관).
 *  실측: gzip(level1) 스냅샷당 ~5KB, dedup 후 게임당 수십~백 개 → 1MB 미만. */
type TurnHistoryEntry = { seq: number; round: number; playerId: string; playerName: string; currentPlayerIndex: number; gz: Buffer; gameLogSeqAt: number; humanActionJournalLength: number; ts: number };
const turnHistories = new Map<string, TurnHistoryEntry[]>();

/** [롤백 집계 2026-08-06 사용자 요청] 게임별 롤백 횟수 (요청자별 + GM).
 *  게임 객체가 아니라 여기(모듈 레벨)에 두는 이유: 롤백은 게임 상태를 스냅샷으로 통째 복원하므로
 *  game 안에 세면 카운터까지 같이 되감긴다. 밖에 두면 되감기와 무관하게 누적된다. */
const rollbackCounts = new Map<string, { total: number; byPlayer: Record<string, number>; admin: number }>();
export function countRollback(gameId: string, actorId: string | null): void {
	const c = rollbackCounts.get(gameId) ?? { total: 0, byPlayer: {}, admin: 0 };
	c.total++;
	if (actorId) c.byPlayer[actorId] = (c.byPlayer[actorId] ?? 0) + 1;
	else c.admin++;
	rollbackCounts.set(gameId, c);
}
/** 게임 종료 시 로그에 남길 롤백 요약. 롤백이 없었으면 null. */
export function buildRollbackSummary(game: GaiaGameState): string | null {
	const c = rollbackCounts.get(game.id);
	if (!c || c.total === 0) return null;
	const parts = Object.entries(c.byPlayer)
		.sort((a, b) => b[1] - a[1])
		.map(([pid, n]) => `${game.players[pid]?.name ?? pid} ${n}회`);
	if (c.admin > 0) parts.push(`GM ${c.admin}회`);
	return `총 ${c.total}회${parts.length ? ` (${parts.join(', ')})` : ''}`;
}
const TURN_HISTORY_CAP = 300; // 안전 상한(게임당). dedup 후엔 보통 이보다 훨씬 적음.

function pushTurnHistory(game: ServerGameState, playerId: string): void {
	if ((game as any).simulation) return; // 자가대전/시뮬은 롤백 불필요 → 오버헤드 스킵
	const entry: any = game.turnStartState?.[playerId];
	if (!entry?.fullGameState) return;
	let hist = turnHistories.get(game.id);
	if (!hist) { hist = []; turnHistories.set(game.id, hist); }
	// dedup: 직전 엔트리와 같은 seq(그 사이 새 로그 없음)면 스킵 — 재진입/중복 캡처 제거(핵심). 실측: ~1102콜 → 32개 유지.
	if (hist.length && hist[hist.length - 1].seq === entry.gameLogSeqAt) return;
	const gz = zlib.gzipSync(Buffer.from(JSON.stringify(entry.fullGameState)), { level: 1 });
	hist.push({ seq: entry.gameLogSeqAt, round: entry.roundNumber, playerId, playerName: game.players[playerId]?.name ?? playerId, currentPlayerIndex: entry.currentPlayerIndex, gz, gameLogSeqAt: entry.gameLogSeqAt, humanActionJournalLength: entry.humanActionJournalLength ?? 0, ts: Date.now() });
	if (hist.length > TURN_HISTORY_CAP) hist.splice(0, hist.length - TURN_HISTORY_CAP);
}

function captureTurnStartWithPrev(game: ServerGameState, playerId: string): void {
	if (!game.turnStartState) game.turnStartState = {};
	if (game.turnStartState[playerId]?.fullGameState) {
		if (!game.prevTurnStartState) game.prevTurnStartState = {};
		game.prevTurnStartState[playerId] = game.turnStartState[playerId];
	}
	game.turnStartState[playerId] = buildTurnStartStateEntryForPlayer(game, playerId);
	pushTurnHistory(game, playerId);
}

/** [롤백 실행] 압축 히스토리 엔트리로 게임 상태 전체 복원 (admin_rollback_turn과 동일 복원부).
 *  해당 seq 이후 히스토리는 잘라내고, 봇 루프 취소 후 복원 지점에서 재가동. */
function executeRollbackToHistory(io: SocketIOServer, game: ServerGameState, hist: TurnHistoryEntry[], entry: TurnHistoryEntry): void {
	const fullGameState = JSON.parse(zlib.gunzipSync(entry.gz).toString('utf8'));
	const restored = deepClone(fullGameState) as ServerGameState;
	const synthStart: any = { gameLogSeqAt: entry.gameLogSeqAt, humanActionJournalLength: entry.humanActionJournalLength };
	restored.gameLog = restoreGameLogForReset(game, synthStart, entry.playerId);
	restored.humanActionJournal = (game.humanActionJournal || []).slice(0, entry.humanActionJournalLength || 0);
	clearFreeActionUndo(restored);
	restored.turnStartState = { [entry.playerId]: buildTurnStartStateEntryForPlayer(restored, entry.playerId) };
	restored.prevTurnStartState = undefined;
	(restored as any).pendingRollback = null;
	// 진행 중 봇 루프 무효화 후 복원 지점에서 재시작
	(game as any).botCanceled = true;
	cancelBotExecution(game.id);
	hideHeavyServerFields(restored);
	games.set(game.id, restored);
	clampPlayerResources(restored);
	// 이 seq 이후 히스토리 제거(새 타임라인)
	const cut = hist.findIndex(h => h.seq === entry.seq);
	if (cut >= 0) hist.splice(cut + 1);
	log(`[ROLLBACK] ${game.id} → seq ${entry.seq} (R${entry.round} ${entry.playerName} 턴 시작)`, 'game', game.id);
	emitGameUpdated(io, restored); // [대역폭 2026-08-07] 전체 로그 직접 emit → 헬퍼 경유(꼬리40 델타)
	executeBotTurnIfNeeded(io, restored).catch(err => log(`Bot turn execution error (rollback): ${err}`, 'error'));
}

function restoreGameLogForReset(game: ServerGameState, startState: any, playerId: string): NonNullable<GaiaGameState['gameLog']> {
	// gameLogState(전체 복제)는 더 이상 저장하지 않는다(메모리). 항상 길이 기준으로 라이브 로그를 잘라 복원하고,
	// 해당 플레이어가 이번 턴에 남긴 되돌릴 수 있는 액션 로그가 꼬리에 남아 있으면 제거한다.
	const live = (game.gameLog || []) as NonNullable<GaiaGameState['gameLog']>;
	// [100캡 버그수정] gameLog는 100개 초과 시 앞에서 shift되어 '길이'가 턴 시작 인덱스로 못 쓰인다
	// (후반전에 reset해도 포머/이클립스 등 비-화이트리스트 로그가 안 지워지던 근본 원인 — slice(0,길이)가 통째 보존).
	// 단조 증가 카운터(gameLogSeq)로 '턴 시작 이후 추가된 엔트리 수'를 구해 꼬리에서 그만큼 잘라낸다(shift 무관·정확).
	const liveSeq = (game as any).gameLogSeq;
	if (typeof liveSeq === 'number' && typeof startState.gameLogSeqAt === 'number') {
		const added = Math.max(0, Math.min(live.length, liveSeq - startState.gameLogSeqAt));
		return live.slice(0, live.length - added);
	}
	// 레거시(seq 없는 구 스냅샷) 폴백: 기존 길이 슬라이스 + 꼬리 트림
	const logs = live.slice(0, startState.gameLogLength || 0) as NonNullable<GaiaGameState['gameLog']>;
	const resettable = new Set([
		'Power Action',
		'Used Tech Action',
		'Used Bonus Action',
		'Built Mine',
		'Built Parasitic Mine',
		'Upgraded to Trading Station',
		'Upgraded to Research Lab',
		'Upgraded to Planetary Institute',
		'Advanced Research',
		'Federation',
		// 기술 타일/고급 타일 선택 로그도 되돌릴 수 있는 액션 — 안 넣으면 트레일링 트림이 'Gained Tech Tile'에서
		// 멈춰 그 앞 'Upgraded to Research Lab'까지 통째로 남는다(취소 후 둘 다 로그에 남던 버그).
		'Gained Tech Tile',
		'Rebellion: Gained Tech Tile',
		'Advanced Tech Tile',
		'Advanced Tech: Advanced track',
		'Ship Tech: Advanced track',
		'Twilight: TS → Research Lab',
	]);
	while (logs.length > 0) {
		const last = logs[logs.length - 1];
		if (last.playerId !== playerId) break;
		if (!resettable.has(last.action)) break;
		logs.pop();
	}
	return logs;
}

/** 자원 상한: O/K 최대 15, C 최대 30 */
const MAX_ORE = 15;
const MAX_KNOWLEDGE = 15;
const MAX_CREDITS = 30;

function clampPlayerResources(game: GaiaGameState): void {
	for (const p of Object.values(game.players)) {
		if (p.ore != null && p.ore > MAX_ORE) p.ore = MAX_ORE;
		if (p.knowledge != null && p.knowledge > MAX_KNOWLEDGE) p.knowledge = MAX_KNOWLEDGE;
		if (p.credits != null && p.credits > MAX_CREDITS) p.credits = MAX_CREDITS;
	}
}

function ensureScoreBreakdown(player: PlayerState): ScoreBreakdown {
	if (!player.scoreBreakdown) {
		player.scoreBreakdown = {
			roundMissions: [],
			bonusTilePass: [],
			techTiles: [],
			finalMissions: 0,
			finalMissionDetails: [],
			powerReceived: 0,
			spaceships: [],
			researchTracks: 0,
			remainingResources: 0,
			other: [],
		};
	}
	return player.scoreBreakdown;
}

/** Debug Log: console + file (if game.id exists) */
export function debugLog(game: { id: string; simulation?: boolean }, message: string, source = "game") {
	if (game.simulation) return;
	log(message, source, game.id);
}

export function saveFinalGameState(game: ServerGameState) {
	try {
		const logDir = path.join(process.cwd(), "logs");
		if (!fs.existsSync(logDir)) {
			fs.mkdirSync(logDir, { recursive: true });
		}
		const filename = `game_${game.id}_final_state.json`;
		const filePath = path.join(logDir, filename);
		fs.writeFileSync(filePath, JSON.stringify(game, null, 2));
		debugLog(game, `Final game state saved to ${filename}`, 'system');
		if (!game.humanActionJournalExported) {
			game.humanActionJournalExported = true;
			exportHumanGameDataset(game).catch((error) => {
				log(`Failed to export human game dataset: ${error}`, 'error', game.id);
				game.humanActionJournalExported = false;
			});
		}
		// 4인 전원 사람게임이면 점수사이트(PythonAnywhere)에 자동 제출(fire-and-forget). 멱등 가드로 1회만.
		// [사용자] 친선전이면 기록 사이트 자동 저장 스킵.
		if ((game as any).friendlyMatch) {
			log(`친선전(friendlyMatch) — 기록 사이트 자동 저장 스킵`, 'game', game.id);
		} else if (!(game as any).scoreSiteSubmitted) {
			(game as any).scoreSiteSubmitted = true;
			submitToScoreSite(game).catch((error) => {
				log(`Failed to submit to score site: ${error}`, 'error', game.id);
			});
		}
	} catch (error) {
		log(`Failed to save final game state: ${error}`, 'error', game.id);
	}
}

function addScore(game: GaiaGameState, playerId: string, vp: number, category: keyof ScoreBreakdown, detail?: { round?: number; tileId?: string; shipTileId?: string; shipType?: string; actionIndex?: number; source?: string; missionId?: string; noLog?: boolean }) {
	const player = game.players[playerId];
	if (!player) return;
	ensureScoreBreakdown(player);
	const previousScore = player.score ?? 0;
	const nextScore = Math.max(0, previousScore + vp);
	const appliedVp = nextScore - previousScore;
	player.score = nextScore;
	if (appliedVp === 0) return;
	const b = player.scoreBreakdown!;
	let recordedInBreakdown = false;
	if (category === 'roundMissions' && detail?.round != null) {
		b.roundMissions.push({ round: detail.round, vp: appliedVp });
		recordedInBreakdown = true;
	} else if (category === 'bonusTilePass' && detail?.round != null) {
		b.bonusTilePass.push({ round: detail.round, vp: appliedVp, tileId: detail.tileId });
		recordedInBreakdown = true;
	} else if (category === 'techTiles' && detail?.tileId) {
		b.techTiles.push({ tileId: detail.tileId, vp: appliedVp });
		recordedInBreakdown = true;
	} else if (category === 'finalMissions') {
		b.finalMissions += appliedVp;
		if (detail?.missionId) {
			b.finalMissionDetails.push({ missionId: detail.missionId, vp: appliedVp });
		}
		recordedInBreakdown = true;
	} else if (category === 'powerReceived' && appliedVp < 0) {
		b.powerReceived += -appliedVp;
		recordedInBreakdown = true;
	} else if (category === 'spaceships') {
		b.spaceships.push({ shipTileId: detail?.shipTileId || detail?.tileId || detail?.source || 'spaceship-reward', vp: appliedVp, shipType: detail?.shipType, actionIndex: detail?.actionIndex });
		recordedInBreakdown = true;
	} else if (category === 'researchTracks') {
		b.researchTracks += appliedVp;
		recordedInBreakdown = true;
	} else if (category === 'remainingResources') {
		b.remainingResources += appliedVp;
		recordedInBreakdown = true;
	} else if (category === 'other' && detail?.source) {
		b.other.push({ source: detail.source, vp: appliedVp });
		recordedInBreakdown = true;
	}
	if (!recordedInBreakdown) {
		b.other.push({ source: `Uncategorized: ${category}`, vp: appliedVp });
	}

	// Merge into last log if it's the same player's action
	if (appliedVp > 0 && (category === 'other' || category === 'spaceships') && !detail?.noLog) {
		if (!game.gameLog) game.gameLog = [];
		const lastLog = game.gameLog.length > 0 ? game.gameLog[game.gameLog.length - 1] : null;
		let desc = '';
		if (category === 'other' && detail?.source) desc = detail.source;
		else if (category === 'spaceships') desc = 'Spaceship Fed';

		if (lastLog && lastLog.playerId === playerId) {
			if (lastLog.details) {
				lastLog.details += ` (+${appliedVp}VP ${desc})`;
			} else {
				lastLog.details = `+${appliedVp}VP (${desc})`;
			}
		} else if (desc) {
			addGameLog(game, playerId, '', `+${appliedVp}VP (${desc})`);
		}
	}
}

/** 플레이어가 입장한 우주선들의 전용 기술 타일 ID 목록 (이미 보유한 타일 제외). 게임마다 shipTechByShip 랜덤 배정 사용 */
function getShipTechTileIdsForPlayer(game: ServerGameState, playerId: string): string[] {
	const ids: string[] = [];
	const entered = game.players[playerId]?.spaceshipsEntered ?? [];
	const owned = game.players[playerId]?.techTiles ?? [];
	const byShip = game.shipTechByShip ?? SHIP_TECH_BY_SHIP;
	for (const tileId of entered) {
		const tile = game.map.find(t => t.id === tileId);
		if (tile?.type && byShip[tile.type]) {
			const techId = byShip[tile.type];
			const hasStock = (game.shipTechPool?.[techId] ?? 0) > 0;
			if (!ids.includes(techId) && !owned.includes(techId) && hasStock) ids.push(techId);
		}
	}
	return ids;
}

// 파워 교환 헬퍼 함수들
function getStructurePowerValue(structure: StructureType, hasBigBuildingTechTile: boolean): number {
	if (!structure) return 0;
	switch (structure) {
		case 'planetary_institute':
		case 'academy':
			return hasBigBuildingTechTile ? 4 : 3;
		case 'trading_station':
		case 'research_lab':
			return 2;
		case 'mine':
		case 'lost_planet_mine':
			return 1; // Nav5 보상 잊혀진 행성 광산도 일반 광산과 동일하게 연방 파워 1
		default:
			return 0;
	}
}

/** 외곽(C) 섹터 = 11~18. 내 건물이 있는 '서로 다른 섹터' 수 (구조물 수가 아니라 섹터 수). */
const OUTER_SECTORS = [11, 12, 13, 14, 15, 16, 17, 18];
/** 이 타일에서 플레이어가 섹터를 '점유'하는가 — 내 건물(우주선/빈칸 제외) 또는 기생광산. (shared 공용 규칙) */
const tileOccupiesSector = sharedTileOccupiesSector;
/** 플레이어가 점유한 [lo,hi] 범위의 '서로 다른 섹터' 집합 (기생광산 포함). 개수만 필요하면 shared countOccupiedSectors */
function occupiedSectorSet(game: GaiaGameState, playerId: string, lo: number, hi: number): Set<number> {
	const out = new Set<number>();
	for (const t of game.map) {
		if (t.sector >= lo && t.sector <= hi && tileOccupiesSector(t, playerId)) out.add(t.sector);
	}
	return out;
}
function countOuterSectorsOccupied(game: GaiaGameState, playerId: string): number {
	return countOccupiedSectors(game, playerId, 11, 18);
}

function findNearbyPlayersForPower(game: ServerGameState, tile: HexTile, sourcePlayerId: string): Array<{ playerId: string; maxPower: number; tileId: string }> {
	const result: Array<{ playerId: string; maxPower: number; tileId: string }> = [];
	const processedPlayers = new Set<string>();
	const addOrUpdate = (targetPlayerId: string, powerValue: number, tileId: string) => {
		if (powerValue <= 0) return;
		if (processedPlayers.has(targetPlayerId)) {
			const existing = result.find(r => r.playerId === targetPlayerId);
			if (existing && powerValue > existing.maxPower) { existing.maxPower = powerValue; existing.tileId = tileId; }
		} else {
			processedPlayers.add(targetPlayerId);
			result.push({ playerId: targetPlayerId, maxPower: powerValue, tileId });
		}
	};

	// 2칸 이내의 다른 플레이어 건물 + 란티다 기생광산 찾기
	for (const otherTile of game.map) {
		const distance = getDistance(tile, otherTile);
		if (distance > 2) continue;

		// 1) 일반 건물 (구조물 소유자)
		if (otherTile.structure && otherTile.structure !== 'ship' && otherTile.ownerId && otherTile.ownerId !== sourcePlayerId) {
			const targetPlayerId = otherTile.ownerId;
			const hasBigBuildingTechTile = (game.players[targetPlayerId]?.techTiles?.includes('tech-big-4str') && !isTechTileCovered(game.players[targetPlayerId], 'tech-big-4str')) || false;
			let powerValue = getStructurePowerValue(otherTile.structure, hasBigBuildingTechTile);
			const targetPlayer = game.players[targetPlayerId];
			// 매안(Bescods) 의회 보유 시 모행성(titanium) 건물은 파워 +1
			const bescodsHasPI = targetPlayer?.faction === 'bescods' && game.map.some(t => t.ownerId === targetPlayerId && t.structure === 'planetary_institute');
			if (bescodsHasPI && otherTile.type === 'titanium') powerValue += 1;
			// 모웨이드 의회: 링이 놓인 건물은 파워 수신 시 +2
			if (targetPlayer?.faction === 'moweyip' && otherTile.moweyipRing) powerValue += 2;
			addOrUpdate(targetPlayerId, powerValue, otherTile.id);
		}

		// 2) 란티다 기생광산 (소유자=기생광산 주인, 파워값 1) — [버그수정] 기존엔 structure만 봐 기생광산 주인이 누수를 못 받았음
		const pmOwner = otherTile.parasiticMine?.ownerId;
		if (pmOwner && pmOwner !== sourcePlayerId) addOrUpdate(pmOwner, 1, otherTile.id);
	}

	return result;
}

export function hasNearbyPlayersForDiscount(game: ServerGameState, tile: HexTile, sourcePlayerId: string): boolean {
	return findNearbyPlayersForPower(game, tile, sourcePlayerId).length > 0;
}

/** 파워 토큰 소비: 1그릇 → 2그릇 → 3그릇 순. 성공 시 true */
function spendPowerTokens(player: PlayerState, amount: number): boolean {
	// [사용자 요청 2026-06-29] 타클론 브레인 스톤도 토큰 비용(연방 위성·인공물 등)에 1토큰으로 사용 가능.
	// [사용자 2026-08-11] 어느 토큰을 낼지는 planTokenSpend가 결정한다(가이아포밍과 동일 규칙):
	//   브레인 우선 = 파워용으로 아껴 모자랄 때만 / 브레인 보존 = 아래 그릇에 있으면 먼저 내보냄.
	const plan = planTokenSpend(player, amount);
	if (!plan) return false;
	player.power1 = (player.power1 || 0) - plan.from1;
	player.power2 = (player.power2 || 0) - plan.from2;
	player.power3 = (player.power3 || 0) - plan.from3;
	// 연방 위성·인공물은 토큰이 게임에서 아예 제거되므로 브레인도 영구 소멸(복귀 없음, 사용자 확정 룰).
	// 가이아포밍은 가이아 영역으로 갔다가 돌아오는 것과 다른 점.
	if (plan.useBrain) {
		player.brainStoneSpent = true;
		player.brainStoneBowl = undefined;
	}
	return true;
}

/** 플레이어 광산 수 (오레 수익용: 일반 광산 + 기생 + 가상만, 잊혀진 행성 제외) */
function getEffectiveMineCount(game: GaiaGameState, playerId: string): number {
	const player = game.players[playerId];
	let n = game.map.filter(t => t.ownerId === playerId && t.structure === 'mine').length;
	n += game.map.filter(t => t.parasiticMine?.ownerId === playerId).length;
	if (player?.virtualMineAsteroid) n += 1;
	if (player?.virtualMineProto) n += 1;
	return n;
}

/** 패스/보너스/기술타일용 광산 수 (잊혀진 행성 포함) — shared 공용 규칙 */
const getMineCountForPassAndBonuses = sharedGetMineCountForPassAndBonuses;

/** 기오덴 의회 보너스(새 행성 유형당 3K)용: 플레이어가 보유한 행성 유형 집합.
 *  란티다 기생 광산은 행성 유형 점수 산정에서 제외(다른 점수 경로와 일관). 가상 광산(인공물)은 포함. */
export function getPlayerPlanetTypesForGeodens(game: GaiaGameState, playerId: string): Set<string> {
	// 규칙은 shared getOwnedPlanetTypes 하나로 통일 (패스 보너스·고급타일·최종미션과 동일)
	return getOwnedPlanetTypes(game, playerId);
}

/** 기오덴: 의회 보유 시 새 행성 유형을 얻은 경우 +3K (build_mine / place_lost_planet / 인공물 소행성·원시행성 직후 호출) */
function applyGeodensNewPlanetTypeBonus(game: GaiaGameState, playerId: string, typesBefore: Set<string>) {
	const player = game.players[playerId];
	if (player?.faction !== 'geodens') return;
	const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
	if (!hasPI) return;
	const typesAfter = getPlayerPlanetTypesForGeodens(game, playerId);
	if (typesAfter.size <= typesBefore.size) return;
	player.knowledge = (player.knowledge || 0) + 3;
	addGameLog(game, playerId, 'Geodens Council', '+3 Knowledge (new planet type)', '');
	log(`Player ${player.name} (Geodens) gained 3 Knowledge from new planet type (Council)`, 'game', undefined, { simulation: (game as any).simulation });
}

/** 발타크: 의회(PI)가 있을 때만 Nav 트랙 진행 가능 (없으면 Nav+1 타일·3거리 보너스·QIC 임시 거리 등은 가능) */
function canBalTakAdvanceNavigation(game: GaiaGameState, playerId: string): boolean {
	const player = game.players[playerId];
	if (player?.faction !== 'bal_tak') return true;
	return game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
}

/** 사용 가능한 가이아 포머 수 (발타크: QIC 전환으로 잠긴 포머 제외, 다음 라운드에 복귀) */
export function getEffectiveGaiaformers(player: PlayerState): number {
	const total = player.gaiaformers ?? 0;
	if (player.faction !== 'bal_tak') return total;
	const locked = player.balTakGaiaformersUsedForQic ?? 0;
	return Math.max(0, total - locked);
}

/** 거리 보너스(+3거리/글린 +2항해)가 활성화되어 아직 거리 액션에 쓰이지 않은 상태인지 */
export function hasActiveRangeBonus(player: PlayerState | undefined | null): boolean {
	return !!(player && (player.tempRangeBonus || player.rangeBonusActive || player.gleensNavBonusActive));
}

/** 보너스 타일 'Pass: N VP per Gaiaformer'용: 파괴되지 않고 남아있는 포머 수.
 *  = 개인판 보유(발타크 QIC 잠금분 포함) + 맵에서 가이아포밍 중인 것. (소행성에 쓰여 파괴된 건 제외) */
const countRemainingGaiaformers = sharedCountRemainingGaiaformers;
const RANGE_BONUS_BLOCK_MSG = '거리 보너스 액션 사용 중입니다. 광산 건설 · 가이아포머 배치 · 소행성 광산 · 우주선 입장만 가능합니다.';

/** 광산 공급(8개) 한도 계산용 물리 광산 수: 일반 + 잊혀진행성 + 기생(란티다). 가상 광산(인공물)은 실제 토큰이 아니므로 제외. */
export function getStructureCount(game: GaiaGameState, playerId: string, structure: 'planetary_institute' | 'trading_station' | 'research_lab' | 'mine'): number {
	if (structure === 'mine') {
		// 광산 보유 한도(8개)용 카운트: 실제 '광산 토큰'을 쓰는 것만.
		// 잊혀진 행성(Nav5 별도 토큰)·가상 광산(인공물)은 토큰을 쓰지 않으므로 한도에서 제외. 란티다 기생광산은 토큰 사용이라 포함.
		return game.map.filter(t => t.ownerId === playerId && t.structure === 'mine').length
			+ game.map.filter(t => t.parasiticMine?.ownerId === playerId).length;
	}
	return game.map.filter(t => t.ownerId === playerId && t.structure === structure).length;
}

export function getAcademyLeftCount(game: GaiaGameState, playerId: string): number {
	return game.map.filter(t => t.ownerId === playerId && t.structure === 'academy' && (t.academyType === 'left' || t.academyType == null)).length;
}

export function getAcademyRightCount(game: GaiaGameState, playerId: string): number {
	return game.map.filter(t => t.ownerId === playerId && t.structure === 'academy' && t.academyType === 'right').length;
}

/** 글린: 오른쪽 아카데미 없으면 QIC 획득 시 전부 광물로 변환. 그 외 종족은 QIC 그대로 */
function grantQic(game: GaiaGameState, playerId: string, amount: number): void {
	if (amount <= 0) return;
	const player = game.players[playerId];
	if (!player) return;
	const gleensNoRightAcademy = player.faction === 'gleens' && getAcademyRightCount(game, playerId) < 1;
	if (gleensNoRightAcademy) {
		player.ore = (player.ore ?? 0) + amount;
	} else {
		player.qic = (player.qic ?? 0) + amount;
	}
}

function grantGleensFederationReward(game: GaiaGameState, playerId: string, tileId?: string): void {
	const player = game.players[playerId];
	if (!player || player.faction !== 'gleens') return;

	player.ore = (player.ore ?? 0) + GLEENS_FEDERATION_REWARD.ore;
	player.knowledge = (player.knowledge ?? 0) + GLEENS_FEDERATION_REWARD.knowledge;
	player.credits = (player.credits ?? 0) + GLEENS_FEDERATION_REWARD.credits;
	if (!Array.isArray(player.federations) || (player.federations.length > 0 && typeof (player.federations as any)[0] === 'string')) {
		player.federations = getFederationEntries(player);
	}
	player.federations.push({ rewardId: GLEENS_FEDERATION_REWARD.id, isGreen: true });
	addGameLog(game, playerId, 'Gleens: PI Federation', `+${GLEENS_FEDERATION_REWARD.label} (${GLEENS_FEDERATION_REWARD.id})`, tileId);
	applyRoundMissionScore(game, playerId, 'federation');
}

/** 거리 계산용: 내 건물 + 내 우주정거장이 있는 타일 (하이브 우주정거장도 기준점) */
export function getPlayerRangeTiles(game: ServerGameState, playerId: string, excludeShip?: boolean): HexTile[] {
	return game.map.filter(t => {
		if (t.ownerId === playerId && t.structure !== null && (excludeShip !== true || t.structure !== 'ship'))
			return true;
		if (t.spaceStation?.ownerId === playerId) return true;
		// 기생광산(Lantids)도 내 건물이므로 사거리 기점에 포함
		if (t.parasiticMine?.ownerId === playerId) return true;
		return false;
	});
}

/** 연방: 행성 타일 ID 집합에 있는 해당 플레이어 건물의 파워 합 (광산=1, TS/연구소=2, 아카데미/의회=3, 큰건물기술타일 있으면 4). 란티다 기생 광산=1. 위성=0, 우주정거장=1(selectedEmptyHexIds에 있는 타일만) */
export function getFederationBuildingPower(
	game: ServerGameState,
	playerId: string,
	planetTileIds: Set<string>,
	selectedEmptyHexIds?: string[]
): number {
	const hasBig = (game.players[playerId]?.techTiles?.includes('tech-big-4str') && !isTechTileCovered(game.players[playerId], 'tech-big-4str')) ?? false;
	let sum = 0;
	const player = game.players[playerId];
	const bescodsHasPI = player?.faction === 'bescods' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
	planetTileIds.forEach((tileId) => {
		const tile = game.map.find(t => t.id === tileId);
		if (!tile) return;
		if (tile.ownerId === playerId && tile.structure && tile.structure !== 'ship') {
			sum += getStructurePowerValue(tile.structure, hasBig);
			if (bescodsHasPI && tile.type === 'titanium') sum += 1; // 매안(Bescods) 의회: 모행성(titanium) 건물 +1
			if (player?.faction === 'moweyip' && tile.moweyipRing) sum += 2; // 모웨이드 의회: 링 건물 연방 시 +2
		}
		if (tile.parasiticMine?.ownerId === playerId)
			sum += 1; // 기생 광산 = 1
		if (tile.spaceStation?.ownerId === playerId)
			sum += 1; // 우주정거장 = 1
	});
	// 하이브: 선택된 빈공간/타일 중 내 우주정거장이 있으면 1파워씩 (위성은 0)
	if (selectedEmptyHexIds?.length) {
		for (const hexId of selectedEmptyHexIds) {
			const tile = game.map.find(t => t.id === hexId);
			if (tile?.spaceStation?.ownerId === playerId && !planetTileIds.has(hexId)) sum += 1;
		}
	}
	return sum;
}

/** 행성만으로 연결된 컴포넌트 (해당 행성 타일 ID 포함, 인접 행성 중 내 건물만 BFS) */
export function getPlanetConnectedComponent(game: ServerGameState, playerId: string, startTileId: string, blocked?: Set<string>): Set<string> {
	const start = game.map.find(t => t.id === startTileId);
	if (!start) return new Set();
	// [수정] blocked(예: 이미 다른 연방에 속한 건물)는 새 연방 컴포넌트에서 제외 — 시작점/연결 모두 차단.
	if (blocked?.has(startTileId)) return new Set();

	const isOwn = (tile: HexTile) => {
		if (tile.ownerId === playerId && tile.structure && tile.structure !== 'ship') return true;
		if (tile.parasiticMine?.ownerId === playerId) return true;
		if (tile.spaceStation?.ownerId === playerId) return true;
		return false;
	};

	if (!isOwn(start)) return new Set();

	const component = new Set<string>();
	const queue: string[] = [startTileId];
	component.add(startTileId);

	while (queue.length > 0) {
		const tid = queue.shift()!;
		const tile = game.map.find(t => t.id === tid)!;
		const neighbors = getNeighbors(game.map, tile);
		for (const n of neighbors) {
			if (blocked?.has(n.id)) continue;
			if (!isOwn(n)) continue;
			if (component.has(n.id)) continue;
			component.add(n.id);
			queue.push(n.id);
		}
	}
	return component;
}

/** 선택된 빈공간들 + 인접 행성들(및 행성/건물끼리 연결된 본인 건물 전체) → 연방에 포함된 행성 타일 ID 집합. 건물/우주정거장끼리 붙어 있으면 한 연방에 같이 포함 */
export function getFederationPlanetIdsFromSelectedEmpties(game: ServerGameState, playerId: string, selectedHexIds: string[]): Set<string> {
	const planetIds = new Set<string>();
	for (const hexId of selectedHexIds) {
		const tile = game.map.find(t => t.id === hexId);
		if (!tile || !isEmptyHex(tile)) continue;
		const neighbors = getNeighbors(game.map, tile);
		for (const n of neighbors) {
			if (isPlanetHex(n) || n.spaceStation?.ownerId === playerId || n.parasiticMine?.ownerId === playerId || (n.ownerId === playerId && n.structure && n.structure !== 'ship')) {
				// 인접 행성/건물뿐 아니라, 연결된 전체 컴포넌트 포함
				const component = getPlanetConnectedComponent(game, playerId, n.id);
				component.forEach(id => planetIds.add(id));
			}
		}
	}
	return planetIds;
}

/** 연방 1회당 필요 파워. 제노스는 의회 보유 시 6, 그 외 7 */
export function getFederationRequiredPower(game: ServerGameState, playerId: string): number {
	const player = game.players[playerId];
	const hasPI = player && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
	const powerPerFed = (player?.faction === 'xenos' && hasPI) ? 6 : 7;

	// 하이브(Ivits)만 연방 횟수에 따라 7 → 14 → 21 ... 처럼 누적 증가 규칙이 적용됨.
	// 그 외 종족은 매 연방 시도마다 선택된 건물/우주정거장 파워가 7(또는 Xenos면 6) 이상인지로 판정.
	if (player?.faction !== 'ivits') return powerPerFed;

	// [수정 2026-06-28] 하이브 누적 요구치는 *모든* 연방(위성+우주선)을 1개씩 센다(사용자 룰 확정).
	// 이전엔 ship-fed-*를 제외해 우주선 연방 보유 시 다음 요구파워가 7씩 모자라게 떴음(예: 위성2+우주선1=3개인데 21로).
	// [수정 2026-07-06] 단 테라포밍 5단계 '보상' 연방은 선언이 아니므로 제외(사용자 버그: 3선언+TF5 상태에서
	// 다음 요구치가 28이어야 하는데 28/35로 떠 연방 불가). 새 게임은 fromTrack5 마커, 마커 없는 진행 중
	// 게임은 TF≥5 도달+트랙 연방타일 존재로 폴백 차감.
	const entries = getFederationEntries(player);
	const marked = entries.filter(e => (e as any).fromTrack5).length;
	const legacyTf5 = marked === 0 && ((player.research?.terraforming ?? 0) >= 5) && (game as any).federationOnTerraforming5 ? 1 : 0;
	const formedFedCount = Math.max(0, entries.length - marked - legacyTf5);
	const n = formedFedCount + 1;
	return powerPerFed * n;
}

const STRUCTURE_LABELS: Record<string, string> = {
	planetary_institute: '의회',
	academy: '아카데미',
	trading_station: '교역소',
	research_lab: '연구소',
	mine: '광산',
};

/**
 * 비-Ivits 연방 연결성 검증: 선택한 위성/우주정거장/건물이 '하나의 연결 컴포넌트'를 이루는지 확인하고
 * 그 컴포넌트 안의 건물 파워를 계산한다. (이미 다른 연방에 속한 건물 fedHexes는 새 네트워크에서 제외 — 기존 설계 유지)
 * connected=false면 끊긴/엉뚱한 위성이 섞인 것 → 연방 거부. (위성=0, 우주정거장=1, 광산/잊혀진행성=1, …)
 */
function computeConnectedFederation(
	game: ServerGameState,
	playerId: string,
	selectedHexIds: string[],
	selectedSpaceStationHexIds: string[],
	selectedPlanetIds: string[]
): { planetIds: Set<string>; power: number; connected: boolean } {
	const fedHexes = new Set(game.playerFederationHexes?.[playerId] ?? []);
	const satelliteSet = new Set(selectedHexIds);
	const ownedBuilding = (t: HexTile) =>
		(t.ownerId === playerId && t.structure != null && t.structure !== 'ship') ||
		t.parasiticMine?.ownerId === playerId ||
		t.spaceStation?.ownerId === playerId;
	// 네트워크 통과 가능 타일: 선택한 위성 칸 + 내 건물/기생광산/우주정거장. 이미 다른 연방에 속한 칸은 제외.
	const passable = (t: HexTile) => {
		if (fedHexes.has(t.id)) return false;
		if (satelliteSet.has(t.id)) return true;
		return ownedBuilding(t);
	};
	const selected = [...selectedHexIds, ...selectedSpaceStationHexIds, ...selectedPlanetIds];
	if (selected.length === 0) return { planetIds: new Set(), power: 0, connected: false };
	const startId = selected.find(id => { const t = game.map.find(x => x.id === id); return !!t && passable(t); });
	if (!startId) return { planetIds: new Set(), power: 0, connected: false };
	const comp = new Set<string>([startId]);
	const queue = [startId];
	while (queue.length) {
		const tid = queue.shift()!;
		const tile = game.map.find(t => t.id === tid);
		if (!tile) continue;
		for (const n of getNeighbors(game.map, tile)) {
			if (comp.has(n.id) || !passable(n)) continue;
			comp.add(n.id);
			queue.push(n.id);
		}
	}
	// 명시적으로 선택한 모든 칸이 같은 컴포넌트에 있어야 '연결된 연방' (끊긴 위성/건물 거부)
	const connected = selected.every(id => comp.has(id));
	const planetIds = new Set<string>();
	comp.forEach(id => { const t = game.map.find(x => x.id === id); if (t && ownedBuilding(t)) planetIds.add(id); });
	const power = getFederationBuildingPower(game, playerId, planetIds, [...selectedHexIds, ...selectedSpaceStationHexIds]);
	return { planetIds, power, connected };
}

/** [불필요 위성 재검사 2026-08-10 사용자 지적] 위성 일부를 뺀 상태에서도, 원래 연방에 들어간 건물들만으로
 *  요구 파워를 채우는 연결 덩어리가 남는지. 남으면 그 위성은 없어도 됐던 것.
 *
 *  기존엔 computeConnectedFederation에 '클릭 목록'을 그대로 넘겨 재검사했는데, 그 함수는 시드가 비면
 *  connected=false를 돌려준다(선택 없음 = 판정 불가). 위성만 클릭한 사람은 그 위성을 빼는 순간 시드가 0개가 돼
 *  '연방 불가'로 잘못 읽혀 경고가 안 떴고, 건물까지 클릭한 사람만 경고를 받았다 — 같은 보드인데 클릭 순서로 갈렸다.
 *  그래서 시드를 클릭 목록이 아니라 '원래 컴포넌트의 건물'에서 잡는다. 위성을 빼면 컴포넌트가 쪼개질 뿐이므로
 *  조각들만 확인하면 되고, 연방과 무관한 다른 곳의 건물 덩어리는 시드가 아니라 오탐이 되지 않는다. */
export function federationFormsWithoutSatellite(
	game: ServerGameState,
	playerId: string,
	satelliteHexIds: string[],
	seedBuildingIds: Set<string> | string[],
	requiredPower: number
): boolean {
	const fedHexes = new Set(game.playerFederationHexes?.[playerId] ?? []);
	const satSet = new Set(satelliteHexIds);
	const ownedBuilding = (t: HexTile) =>
		(t.ownerId === playerId && t.structure != null && t.structure !== 'ship') ||
		t.parasiticMine?.ownerId === playerId ||
		t.spaceStation?.ownerId === playerId;
	const passable = (t: HexTile) => !fedHexes.has(t.id) && (satSet.has(t.id) || ownedBuilding(t));
	const visited = new Set<string>();
	const seeds = Array.isArray(seedBuildingIds) ? seedBuildingIds : Array.from(seedBuildingIds);
	for (const seedId of seeds) {
		if (visited.has(seedId)) continue;
		const seed = game.map.find(t => t.id === seedId);
		if (!seed || !passable(seed)) continue;
		const comp = new Set<string>([seedId]);
		const queue = [seedId];
		visited.add(seedId);
		while (queue.length) {
			const cid = queue.shift()!; // shift는 find 술어 밖에서 (1122줄과 같은 함정)
			const cur = game.map.find(t => t.id === cid);
			if (!cur) continue;
			for (const n of getNeighbors(game.map, cur)) {
				if (comp.has(n.id) || !passable(n)) continue;
				comp.add(n.id); visited.add(n.id); queue.push(n.id);
			}
		}
		const buildings = new Set<string>();
		comp.forEach(id => { const t = game.map.find(x => x.id === id); if (t && ownedBuilding(t)) buildings.add(id); });
		if (getFederationBuildingPower(game, playerId, buildings, satelliteHexIds) >= requiredPower) return true;
	}
	return false;
}

/** Ivits(하이브) 연방 연결성: 선택한 위성·건물·우주정거장이 (내 건물망 + 기존 연방 칸을 통과해) 하나로 연결되는지.
 *  통과 가능: 선택 위성 + 내 건물/우주정거장/기생광산 + 기존 연방 칸. 새로 선택한 모든 칸이 한 컴포넌트면 connected.
 *  (Ivits는 완성 시 파워만 검사했어서 A옆·B옆 따로 위성을 놓아도 연방이 서던 버그 수정용.) */
function computeIvitsFederationConnected(
	game: ServerGameState,
	playerId: string,
	selectedHexIds: string[],
	selectedSpaceStationHexIds: string[],
	selectedPlanetIds: string[]
): boolean {
	const fedHexes = new Set(game.playerFederationHexes?.[playerId] ?? []);
	const satSet = new Set(selectedHexIds);
	const ownedBuilding = (t: HexTile) =>
		(t.ownerId === playerId && t.structure != null && t.structure !== 'ship') ||
		t.parasiticMine?.ownerId === playerId ||
		t.spaceStation?.ownerId === playerId;
	const passable = (t: HexTile) => satSet.has(t.id) || fedHexes.has(t.id) || ownedBuilding(t);
	const selected = [...selectedHexIds, ...selectedSpaceStationHexIds, ...selectedPlanetIds];
	if (selected.length === 0) return true; // 선택 없음 → 경고 안 함 (미리보기용)
	const startId = selected.find(id => { const t = game.map.find(x => x.id === id); return !!t && passable(t); });
	if (!startId) return false;
	const comp = new Set<string>([startId]);
	const queue = [startId];
	while (queue.length) {
		const cid = queue.shift()!; // [버그수정] 예전엔 game.map.find(t => t.id === queue.shift())로 써서 shift가 find 술어 안에서 맵 원소마다 호출돼 큐가 잘못 비워졌음(BFS가 첫 노드에서 끝나 연방이 거의 항상 '연결 안 됨'으로 거부됨). shift를 먼저 꺼낸다.
		const cur = game.map.find(t => t.id === cid);
		if (!cur) continue;
		for (const n of getNeighbors(game.map, cur)) {
			if (!comp.has(n.id) && passable(n)) { comp.add(n.id); queue.push(n.id); }
		}
	}
	return selected.every(id => comp.has(id));
}

/** 연방 모드 선택 기준으로 포함될 건물·파워 미리보기 계산 */
function computeFederationPreview(game: ServerGameState, playerId: string): { power: number; requiredPower: number; items: Array<{ tileId: string; label: string; power: number }>; connected: boolean } | null {
	const mode = game.federationMode;
	if (!mode || mode.playerId !== playerId) return null;
	const isIvits = game.players[playerId]?.faction === 'ivits';
	const fedHexes = game.playerFederationHexes?.[playerId] ?? [];
	const selectedHexIds = mode.selectedHexIds ?? [];
	const selectedPlanetIds = mode.selectedPlanetIds ?? [];
	const selectedSpaceStationHexIds = mode.selectedSpaceStationHexIds ?? [];
	// Ivits(하이브)만 요구파워 누적(7→14→21)이라 기존 연방 건물까지 시드에 포함. 그 외 종족은
	// 선택한 위성+건물이 '하나의 연결 컴포넌트'를 이뤄야 하므로 computeConnectedFederation으로 통일
	// (federation_complete의 수락 기준과 미리보기가 일치하도록).
	let planetIds: Set<string>;
	let power: number;
	let connected = true;
	const seedHexIds = [...fedHexes, ...selectedHexIds, ...selectedSpaceStationHexIds, ...selectedPlanetIds];
	if (isIvits) {
		planetIds = new Set<string>();
		seedHexIds.forEach(hexId => {
			const tile = game.map.find(t => t.id === hexId);
			if (!tile) return;
			if (isPlanetHex(tile) || tile.spaceStation?.ownerId === playerId || tile.parasiticMine?.ownerId === playerId) {
				getPlanetConnectedComponent(game, playerId, hexId).forEach(pid => planetIds.add(pid));
			}
			getNeighbors(game.map, tile).forEach(n => {
				if (isPlanetHex(n) || n.spaceStation?.ownerId === playerId || n.parasiticMine?.ownerId === playerId) {
					getPlanetConnectedComponent(game, playerId, n.id).forEach(pid => planetIds.add(pid));
				}
			});
		});
		power = getFederationBuildingPower(game, playerId, planetIds, seedHexIds);
		connected = computeIvitsFederationConnected(game, playerId, selectedHexIds, selectedSpaceStationHexIds, selectedPlanetIds);
	} else {
		const net = computeConnectedFederation(game, playerId, selectedHexIds, selectedSpaceStationHexIds, selectedPlanetIds);
		planetIds = net.planetIds;
		power = net.power;
		// 선택 칸이 하나로 연결됐는지 (끊긴 위성이 있으면 false). 선택이 없으면 연결 경고 표시 안 함.
		connected = net.connected || (selectedHexIds.length + selectedSpaceStationHexIds.length + selectedPlanetIds.length === 0);
	}
	const requiredPower = getFederationRequiredPower(game, playerId);
	const hasBig = (game.players[playerId]?.techTiles?.includes('tech-big-4str') && !isTechTileCovered(game.players[playerId], 'tech-big-4str')) ?? false;
	const items: Array<{ tileId: string; label: string; power: number }> = [];
	planetIds.forEach(tileId => {
		const t = game.map.find(x => x.id === tileId);
		if (!t) return;
		if (t.ownerId === playerId && t.structure && t.structure !== 'ship') {
			const p = getStructurePowerValue(t.structure, hasBig);
			items.push({ tileId, label: STRUCTURE_LABELS[t.structure] ?? t.structure, power: p });
		}
		if (t.parasiticMine?.ownerId === playerId) items.push({ tileId, label: '기생광산', power: 1 });
		if (t.spaceStation?.ownerId === playerId) items.push({ tileId, label: '우주정거장', power: 1 });
	});
	for (const hexId of selectedSpaceStationHexIds) {
		const t = game.map.find(x => x.id === hexId);
		if (t?.spaceStation?.ownerId === playerId && !planetIds.has(hexId)) items.push({ tileId: hexId, label: '우주정거장', power: 1 });
	}
	return { power, requiredPower, items, connected };
}

/** 연방에 속한 본인 건물/우주정거장 바로 옆에 건설한 타일이면 해당 타일도 연방에 포함시킴 */
function addBuildingToFederationIfAdjacent(game: ServerGameState, playerId: string, tileId: string): void {
	if (!tileId) return;
	const fed = game.playerFederationHexes?.[playerId];
	if (!fed || fed.includes(tileId)) return;
	const tile = game.map.find(t => t.id === tileId);
	if (!tile) return;
	const isOwn = (tile.ownerId === playerId && tile.structure && tile.structure !== 'ship') || tile.parasiticMine?.ownerId === playerId || (tile.spaceStation as { ownerId?: string } | null)?.ownerId === playerId;
	if (!isOwn) return;
	const neighbors = getNeighbors(game.map, tile);
	const hasFederatedNeighbor = neighbors.some(n => fed.includes(n.id));
	if (hasFederatedNeighbor) fed.push(tileId);
}

/** 특정 연방 보상 ID가 이미 누군가에게 획득되었는지 */
function isSpaceshipFederationRewardTaken(game: GaiaGameState, rewardId: string): boolean {
	for (const p of Object.values(game.players)) {
		const entries = getFederationEntries(p);
		if (entries.some(e => e.rewardId === rewardId)) return true;
	}
	return false;
}

function createPowerOffers(game: ServerGameState, tile: HexTile, sourcePlayerId: string): void {
	const nearbyPlayers = findNearbyPlayersForPower(game, tile, sourcePlayerId);
	if (!game.queuedPowerOffers) game.queuedPowerOffers = [];
	for (const { playerId, maxPower, tileId } of nearbyPlayers) {
		const targetPlayer = game.players[playerId];
		// [2026-08-07 사용자] 타클론 의회는 토큰을 먼저 만들고 파워를 받으므로 그만큼 여력이 더 있다.
		const potentialGain = getMaxPowerGainForOrder(game, playerId, true);

		// 이타르(Itars) 의회 보유 시: 파워 수신 대신 가이아 구역에 파워 토큰 1개 추가 가능 (상시 선택)
		// 여기서는 일단 일반적인 파워 수신 가능 여부만 체크하고, 실제 처리 시 이타르 룰 적용
		// 단, 수신 가능한 파워가 0이면 오퍼 자체를 만들지 않음
		// 타클론 의회(PI) 보유 시: 풀파워(충전 여력 0)여도 수락하면 토큰 +1(그릇1)이라 오퍼를 띄워야 함(사용자 관찰).
		const taklonsPI = targetPlayer.faction === 'taklons'
			&& game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
		if (potentialGain === 0 && targetPlayer.faction !== 'itars' && !taklonsPI) continue;

		const actualGain = Math.min(maxPower, potentialGain);

		// 이타르의 경우 실제 수신량이 0이라도 가이아 토큰을 위해 오퍼를 띄워야 할 수도 있으나,
		// 원칙적으로 '파워 수신' 행위가 가능해야 점수 깎는 오퍼가 성립함.
		// 일단 수신 가능 파워가 0이면 오퍼 생략 (사용자 요청 사항)
		if (actualGain === 0 && !taklonsPI) continue;

		const maxAffordable = Math.min(actualGain, targetPlayer.score + 1);
		const vpCost = Math.max(0, maxAffordable - 1);

		game.queuedPowerOffers.push({
			id: `${Date.now()}_${playerId}_${Math.random()}`,
			targetPlayerId: playerId,
			sourcePlayerId,
			amount: maxAffordable,
			vpCost,
			tileId,
			responded: false
		});
	}
}

/** 봇의 파워 누출(leech) 수락 판단: 무료면 무조건, 유료(VP 차감)면 라운드·충전여력·패스여부로 전략적 평가. */
function shouldBotAcceptPowerOffer(game: ServerGameState, targetPlayerId: string, amount: number, vpCost: number): boolean {
	if (vpCost <= 0) return true; // 무료 충전은 항상 수락
	const player = game.players[targetPlayerId];
	if (!player) return false;
	const effective = Math.min(amount, getMaxPowerGain(player)); // 실제 충전 가능한 양
	if (effective <= 0) return false; // 못 받으면 VP 낭비 → 거절
	const round = game.roundNumber ?? 1;
	// 파워를 활용할 수 있는 라운드 수 (패스했으면 이번 라운드엔 못 쓰고 다음 라운드 충전분만)
	const usefulRounds = Math.max(0, 6 - round) + (player.hasPassed ? 0 : 1);
	// 파워 1개의 대략 가치(VP 환산): 게임이 많이 남을수록 높게. 받는 파워×가치 ≥ 깎이는 VP 면 수락.
	// [flag: leechHumanPay] 103게임 실측(2026-07-22): 리치 지불 사람 평균 10.0VP(p50 10, p90 17) vs 봇 7.9VP —
	// 사람이 ~2VP 더 지불하며, 지불량-점수 관계는 사람 중립·봇 소폭 양(+4). 사용자 지시("봇끼리도 더 받아봐"):
	// 중·후반 파워 가치 상향(0.5→0.65, 0.25→0.35) + 예산 임계 8→12(사람 p50 위로) 캘리브레이션.
	const leechCalib = getPlayerFlag(targetPlayerId, 'leechHumanPay', true);
	let perPowerValue = usefulRounds >= 4 ? 0.8 : usefulRounds >= 2 ? (leechCalib ? 0.65 : 0.5) : (leechCalib ? 0.35 : 0.25);
	// [사용자 관찰 2026-06-14] 후반에 무작정 거절 말 것 — 받은 파워를 '쓸 곳'(미사용 파워액션)이 있고
	// 아직 패스 안 했으면 실질 전환 가치가 있으므로 파워 가치를 상향해 수락 쪽으로 (전환처 없으면 기존대로 보수적).
	if (getPlayerFlag(targetPlayerId, 'smartPowerAccept', true) && !player.hasPassed) {
		const hasUnusedPowerAction = (game.powerActions ?? []).some(a => !a.isUsed);
		if (hasUnusedPowerAction) perPowerValue += usefulRounds < 2 ? 0.35 : 0.2; // 후반일수록 '전환처 있음' 가중을 더 크게
	}
	// [flag: powerAcceptBudget] 저점 게임 실측(피락스 31점 파워차감 −13, 사람 215점도 −8): 수락 모델이
	// 파워당 0.8VP를 가정하지만 전환 못 하는 봇의 실현 가치는 그 이하 — 누적 지불이 사람 상한(8VP)을
	// 넘으면 추가 수락 기준을 강화(가치 40% 할인)해 저점 봇의 VP 출혈을 제한.
	// [flag: powerBudgetRoundGuard, v2 2026-07-15] 사용자 관찰: R4에 2PW/1VP도 회피 — 8VP 초과 시 일괄
	// 할인이 이른 라운드까지 물들임. 할인 취지 = '전환 못 하는 후반 출혈 차단' → 가드 ON이면 활용 라운드
	// 3+ 남은 시점(≈R4 이전, 미패스)엔 할인 미적용.
	if (getPlayerFlag(targetPlayerId, 'powerAcceptBudget', true)
		&& (!getPlayerFlag(targetPlayerId, 'powerBudgetRoundGuard', true) || usefulRounds <= 2)) {
		const paidSoFar = player.scoreBreakdown?.powerReceived ?? 0;
		if (paidSoFar >= (leechCalib ? 12 : 8)) perPowerValue *= 0.6; // [flag: leechHumanPay] 사람 p50(10) 위로 완화
	}
	return effective * perPowerValue >= vpCost;
}

function activateQueuedPowerOffersForPlayer(game: ServerGameState, sourcePlayerId: string): number {
	const queued = game.queuedPowerOffers ?? [];
	if (!queued.length) return 0;
	if (!game.pendingPowerOffers) game.pendingPowerOffers = [];

	const sourcePlayer = game.players[sourcePlayerId];
	const remaining: NonNullable<GaiaGameState['pendingPowerOffers']> = [];
	for (const offer of queued) {
		if (offer.sourcePlayerId !== sourcePlayerId) {
			remaining.push(offer);
			continue;
		}
		const targetPlayer = game.players[offer.targetPlayerId];
		if (!targetPlayer) continue;

		// 마지막 라운드(6)에 이미 패스한 플레이어: 파워 제안 창을 띄우지 않고 자동 처리.
		// [버그수정 2026-08-03, 사용자 제보 "2파워 받을 타이밍에 1파워만 올라감"] 예전 코드는 오퍼 크기와 무관하게
		// 무조건 1파워를 충전했다. 두 가지가 잘못됨: ①부분 충전은 룰에 없다(전액 수락 또는 거절) ②패스 후 파워는
		// 종료 점수에 1점도 기여하지 않으므로(파워 토큰은 잔여자원 VP 대상 아님) VP를 깎고 받는 건 순손실.
		// → 오퍼가 1파워(전액=무료)면 그대로 수령, 2파워 이상(VP 소모)이면 전액 자동 거절.
		if (targetPlayer.hasPassed && (game.roundNumber ?? 0) >= 6) {
			if (offer.amount === 1 && offer.vpCost === 0 && getMaxPowerGain(targetPlayer) > 0) {
				applyPlayerPowerCharge(game, offer.targetPlayerId, 1);
				const added = addSubLogToLastAction(game, sourcePlayerId, {
					playerId: offer.targetPlayerId,
					playerName: targetPlayer.name,
					text: `↳ Received Power +1P ${targetPlayer.name}`
				});
				if (!added) addGameLog(game, offer.targetPlayerId, '↳ Received Power', `+1P from ${sourcePlayer?.name} (auto)`, offer.tileId);
			} else if (offer.amount >= 2) {
				const added = addSubLogToLastAction(game, sourcePlayerId, {
					playerId: offer.targetPlayerId,
					playerName: targetPlayer.name,
					text: `↳ Declined Power (auto: passed) ${targetPlayer.name}`
				});
				if (!added) addGameLog(game, offer.targetPlayerId, 'Declined Power', `from ${sourcePlayer?.name} (auto: passed)`, offer.tileId);
			}
			continue;
		}

		// [사용자 요청 2026-08-06] 이미 패스한 플레이어가 '다음 라운드 수익(토큰 추가 + 파워 수익)만으로도
		//   토큰이 전부 그릇3에 차는' 상태면 지금 누출을 받아도 다음 라운드 시작 상태가 똑같다 → VP만 손해.
		//   이런 사람에게는 "파워 받을래?"를 묻지 않고 자동 거절한다(사용자: "다 거절할 테니 묻지 말아 달라").
		//   패스했지만 수익만으로 다 차지 않는 경우(= 받아 두면 다음 라운드에 실제로 더 쓸 수 있는 경우)는 종전대로 묻는다.
		//   라운드 6은 위 분기에서 이미 별도 처리(패스 후 파워는 종료 점수에 기여하지 않음).
		if (targetPlayer.hasPassed && isPowerLeechPointlessAfterIncome(game, offer.targetPlayerId)) {
			const added = addSubLogToLastAction(game, sourcePlayerId, {
				playerId: offer.targetPlayerId,
				playerName: targetPlayer.name,
				text: `↳ Declined Power (auto: bowls full) ${targetPlayer.name}`
			});
			if (!added) addGameLog(game, offer.targetPlayerId, 'Declined Power', `from ${sourcePlayer?.name} (auto: bowls full)`, offer.tileId);
			continue;
		}

		const isBot = !!game.botPlayerIds?.includes(offer.targetPlayerId);
		// 봇: 전략적 판단. 사람: 무료(VP 0)만 자동 수락, 유료는 직접 결정(아래 pending).
		const autoAcceptOne = offer.vpCost === 0 && targetPlayer.faction !== 'itars' && targetPlayer.faction !== 'taklons';
		if (isBot) {
			// [버그수정 2026-07-28] stale 오퍼 값 대신 현재 충전여력·점수로 재계산(순차 leech로 여력 줄면 그만큼만·무료).
			const capNow = getMaxPowerGainForOrder(game, offer.targetPlayerId, false); // 봇은 '파워 먼저'
			const chargeNow = Math.min(offer.amount, capNow, (targetPlayer.score ?? 0) + 1);
			const vpNow = Math.max(0, chargeNow - 1);
			if (shouldBotAcceptPowerOffer(game, offer.targetPlayerId, chargeNow, vpNow)) {
				addScore(game, offer.targetPlayerId, -vpNow, 'powerReceived');
				applyPlayerPowerCharge(game, offer.targetPlayerId, chargeNow);
				const text = `+${chargeNow}P${vpNow > 0 ? ` (-${vpNow}VP)` : ''}`;
				const added = addSubLogToLastAction(game, sourcePlayerId, {
					playerId: offer.targetPlayerId,
					playerName: targetPlayer.name,
					text: `↳ Received Power ${text} ${targetPlayer.name}`
				});
				if (!added) addGameLog(game, offer.targetPlayerId, '↳ Received Power', `${text} from ${sourcePlayer?.name}`, offer.tileId);
			} else {
				addSubLogToLastAction(game, sourcePlayerId, {
					playerId: offer.targetPlayerId,
					playerName: targetPlayer.name,
					text: `↳ Declined Power ${targetPlayer.name}`
				});
			}
			continue;
		}
		if (autoAcceptOne) {
			addScore(game, offer.targetPlayerId, -offer.vpCost, 'powerReceived');
			applyPlayerPowerCharge(game, offer.targetPlayerId, offer.amount);
			const text = `+${offer.amount}P${offer.vpCost > 0 ? ` (-${offer.vpCost}VP)` : ''}`;
			const added = addSubLogToLastAction(game, sourcePlayerId, {
				playerId: offer.targetPlayerId,
				playerName: targetPlayer.name,
				text: `↳ Received Power ${text} ${targetPlayer.name}`
			});
			if (!added) addGameLog(game, offer.targetPlayerId, '↳ Received Power', `${text} from ${sourcePlayer?.name}`, offer.tileId);
			continue;
		}
		game.pendingPowerOffers.push({ ...offer, responded: false });
	}

	game.queuedPowerOffers = remaining;
	return game.pendingPowerOffers.length;
}

/** 다른 플레이어의 '사전 처리'가 진행 중이면 true → 그동안 어떤 새 메인 액션도 막는다('당신의 턴이 아닙니다'와 동급).
 *  포함: ①수입 단계 파워 수입 순서 선택(pendingIncomeOrder, 예: 의회 4pw→경제2pw 순서 고르는 중)
 *        ②leech 파워 오퍼 미해소(pendingPowerOffers / 턴 종료 보류 pendingTurnEndPlayerId). */
function mainActionBlockedByPending(game: ServerGameState): boolean {
	return ((game.pendingPowerOffers?.length ?? 0) > 0)
		|| Boolean(game.pendingTurnEndPlayerId)
		|| Boolean(game.pendingIncomeOrder)
		|| Boolean((game as any).pendingRollback); // 롤백 투표 중엔 게임 얼림
}

function finalizeTurnEnd(io: SocketIOServer, game: ServerGameState, endedPlayerId: string, options?: { triggerBot?: boolean; reason?: string }) {
	// 끝난 플레이어의 마지막 로그에 로그 이후 적용된 효과까지 끌어올림(변동량 정확도 보강)
	finalizeLogSnap(game, endedPlayerId);
	game.hasDoneMainAction = false;
	// [버그수정] 이번 라운드에 실제 턴(액션)이 1회 이상 진행됐음을 표시 → 라운드시작 헬퍼가 늦게(중복) 호출돼도
	// currentPlayerIndex=0 재리셋을 막는 강한 가드(시작 플레이어 연속 2턴 방지). actionPhaseStartedRound 가드는
	// 헬퍼가 직접 set하므로 "메인이 헬퍼를 안 거치고 시작된" 우회 경로를 못 막았음. 이 플래그는 턴 종료가 직접 set.
	(game as any).firstMainActionDoneThisRound = true;
	clearFreeActionUndo(game);
	// [턴 롤백] 끝난 플레이어의 '턴 시작 스냅샷'을 삭제하지 않고 유지 → GM이 각 플레이어의
	// 마지막 턴 시작으로 되돌릴 수 있게 함(플레이어당 1개, 다음 턴 시작 때 갱신). reset_turn은
	// 현재 플레이어 + 라운드/인덱스 일치 가드가 있어 stale 스냅샷에 영향받지 않음.
	// '이번 턴' 한정 거리 보너스(+3 Range 보너스 액션 등)는 미사용 시 턴 종료에 소멸시킨다.
	// 안 그러면 다음 턴으로 새서 먼 곳에 포머/건물을 QIC 없이 무료 배치하는 버그가 생김.
	if (game.players[endedPlayerId]) {
		const ep = game.players[endedPlayerId];
		ep.tempRangeBonus = false;
		ep.rangeBonusActive = false;
		ep.gleensNavBonusActive = false;
		// 주의: nextMineFreeFromShipTech / spaceshipFed3TfMineFree / pendingTerraformSteps는 여기서 지우지 않는다.
		// ship-fed-3tf-mine 무료광산은 연방 형성이 그 턴 액션이라 보통 '다음 턴'에 짓는다 → 턴 종료에 지우면
		// 정당한 무료광산을 잃는 회귀버그. 소비는 건설 시 clearFreeMineFlags가 담당(원래 동작 유지).
	}
	game.pendingTurnEndPlayerId = undefined;

	const _prevIdx = game.currentPlayerIndex;
	game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
	let passCount = 0;
	while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed) {
		game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
		passCount++;
		if (passCount >= game.turnOrder.length) break;
	}
	// [진단] "턴 끝냈는데 나에게 다시 돌아온다"는 사용자 보고. 다음 플레이어가 방금 끝낸 사람이면 = 되돌아옴.
	// passStates를 같이 기록해 '정상(다른 플레이어 전원 패스로 나만 남음)'인지 '버그(남들 미패스인데 회귀)'인지 구분.
	if (!(game as any).simulation && game.turnOrder[game.currentPlayerIndex] === endedPlayerId) {
		const passStates = game.turnOrder.map(id => `${game.players[id]?.name ?? id}:${game.players[id]?.hasPassed ? 'P' : '-'}`).join(' ');
		const othersAllPassed = game.turnOrder.every(id => id === endedPlayerId || game.players[id]?.hasPassed);
		const verdict = othersAllPassed ? 'OK(others-all-passed)' : '★BUG(others-NOT-passed)';
		log(`[TURN-REVERT] ended=${game.players[endedPlayerId]?.name} → back to self ${verdict} | round=${game.roundNumber} pass=[${passStates}]`, 'game', game.id);
		(game as any).turnRevertDiag = (game as any).turnRevertDiag || [];
		(game as any).turnRevertDiag.push({ round: game.roundNumber, ended: endedPlayerId, verdict, passStates });
	}

	const newCurrentPlayerId = game.turnOrder[game.currentPlayerIndex];
	if (newCurrentPlayerId) {
		captureTurnStartWithPrev(game as ServerGameState, newCurrentPlayerId);
	}

	clampPlayerResources(game);
	emitGameUpdated(io, game);

	if (options?.reason) {
		log(`Turn ended for ${endedPlayerId}. Next player: ${newCurrentPlayerId} (${options.reason})`, 'game', undefined, { simulation: (game as any).simulation });
	}
	if (options?.triggerBot) {
		executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
			log(`Bot turn execution error (${options.reason || 'finalizeTurnEnd'}): ${err}`, 'error');
		});
	}
}

/**
 * 봇 루프 stall 우선 안전망(graceful): 막힌 봇만 이번 라운드 패스 처리하고 다음 플레이어로 진행시켜
 * **게임은 계속**되게 한다. 실유저가 봇과 플레이 중 봇이 막혀도 게임이 멈추거나 강제 종료되지 않게 하는 것이 목적.
 * 전원이 패스 상태가 되면(=더 진행 불가) 비로소 정상 종료한다.
 */

/** [hang 근본수정 2026-07-05] Eclipse 액션2(연구트랙 선택) 해소 — 봇도 호출 가능하게 추출.
 *  기존엔 socket 클로저 전용 → 봇이 pendingEclipseResearch를 영영 해소 못해 교착(p2ze7cmd 재현으로 확정). */
export function executeEclipseAdvanceTrack(io: SocketIOServer, game: ServerGameState, playerId: string, trackId: string): boolean {
	if (!game || game.currentPhase !== 'main') return false;
	const pending = game.pendingEclipseResearch;
	if (!pending || pending.playerId !== playerId) return false;
	const player = game.players[playerId];
	const track = trackId as ResearchTrack;
	const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
	if (!tracks.includes(track) || player.research[track] >= 5) return false;
	if (track === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return false;
	const newLevel = (player.research[track] ?? 0) + 1;
	if (newLevel === 5 && (countGreenFederations(player) < 1 || isTrackLevel5Taken(game, track, playerId))) return false;

	saveActionStartState(game, playerId);
	if (newLevel === 5) spendGreenFederation(player);
	player.research[track]++;
	const levelNow = player.research[track];
	applyTrackLevelBonus(game, playerId, player, track, levelNow);
	addGameLog(game, playerId, 'Eclipse: Research', `${track} → Lv.${levelNow} (2K+3P)`, pending.shipTileId);
	applyRoundMissionScore(game, playerId, 'research_track');
	applyAdvancedTechTileEffect(game, playerId, 'research');
	game.pendingEclipseResearch = null;
	game.hasDoneMainAction = true;
	clampPlayerResources(game); emitGameUpdated(io, game);
	return true;
}

/** Eclipse 연구 선택 취소(자원 롤백) — 봇의 최후 폴백용 추출판 */
export function executeCancelEclipseResearch(io: SocketIOServer, game: ServerGameState, playerId: string): boolean {
	if (!game || game.currentPhase !== 'main') return false;
	const pending = game.pendingEclipseResearch;
	if (!pending || pending.playerId !== playerId) return false;
	const player = game.players[playerId];
	// [취소 정확도 2026-08-07 사용자] 지불 직전 스냅샷이 있으면 그대로 복원(종족 무관 정확).
	// 예전엔 power3+3/power1-3 하드코딩이라 타클론(브레인스톤)·네블라(토큰 환산)에서 토큰이 어긋났다.
	const pre = (pending as any).pre;
	if (pre) {
		player.knowledge = pre.knowledge;
		player.power1 = pre.power1; player.power2 = pre.power2; player.power3 = pre.power3;
		if (pre.brainStoneBowl !== undefined) (player as any).brainStoneBowl = pre.brainStoneBowl;
	} else {
		player.knowledge = (player.knowledge || 0) + 2;
		player.power3 = (player.power3 || 0) + 3;
		player.power1 = Math.max(0, (player.power1 || 0) - 3);
	}
	const shipState = game.spaceships?.[pending.shipTileId];
	if (shipState && shipState.usedActionIndices) {
		shipState.usedActionIndices = shipState.usedActionIndices.filter(idx => idx !== 2);
		shipState.actionsUsed = shipState.usedActionIndices.length;
	}
	game.hasDoneMainAction = false;
	game.pendingEclipseResearch = null;
	removeLastGameLogEntry(game, playerId, 'Eclipse: 2K+3P → Research'); // 취소한 액션의 placeholder 로그 제거(로그 잔류 버그)
	clampPlayerResources(game); emitGameUpdated(io, game);
	return true;
}

export function forceSkipStuckBotTurn(io: SocketIOServer, game: ServerGameState, playerId: string, reason: string): void {
	if (game.currentPhase === 'gameEnd') return;
	const player = game.players[playerId];
	log(`forceSkipStuckBotTurn: skipping ${player?.name ?? playerId} (${reason})`, 'error', game.id);
	if (player) {
		player.hasPassed = true; // 이 라운드 동안만 스킵 (다음 라운드에 hasPassed 리셋되어 복귀)
		// ★[버그수정 2026-07-06 na0vujw3] passingOrder에도 넣어야 라운드 전환(turnOrder=passingOrder, 7097행)에서
		//   강제스킵된 봇이 turnOrder에서 탈락하지 않는다. 안 넣으면 봇이 "패스하다 사라짐"(hang→스킵→다음 라운드
		//   turnOrder에서 소멸, 게임이 남은 사람만으로 조기종료). 위 주석의 '복귀' 가정이 실제로 성립하려면 필수.
		if (!game.passingOrder) game.passingOrder = [];
		if (!game.passingOrder.includes(playerId)) game.passingOrder.push(playerId);
	}
	// [hang수정 2026-07-04] 스킵당한 플레이어의 미해결 pending을 청소 — 안 지우면 스킵 후에도 후속 턴이
	// pendingShipTechMine/hasDoneMainAction에 막혀 hang 지속(관측: uk3aybql 무한 "must complete pending build" 루프).
	if (game.pendingShipTechMine?.playerId === playerId) game.pendingShipTechMine = null;
	if (game.pendingSpaceshipFedMine?.playerId === playerId) game.pendingSpaceshipFedMine = null;
	if (game.pendingEclipseAsteroidMine?.playerId === playerId) game.pendingEclipseAsteroidMine = null;
	if (game.pendingTechTileSelection?.playerId === playerId) game.pendingTechTileSelection = null;
	if (game.pendingEclipseResearch?.playerId === playerId) game.pendingEclipseResearch = null; // [2026-07-05] 미처리 pending 감사에서 발견
	if (game.pendingTwilightFederation?.playerId === playerId) game.pendingTwilightFederation = null; // [2026-08-01] end_turn 가드 추가에 맞춘 안전망
	if (game.pendingFederationReward?.playerId === playerId) game.pendingFederationReward = null;
	if (player) player.pendingTerraformSteps = 0;
	game.hasDoneMainAction = false;
	// [hang수정 2026-07-05] 잔류 pendingPowerOffers가 게임 전체를 막음(iiftcanv: offers+shipTechMine 콤보 타임아웃).
	// 무응답 오퍼 강제 해소(무료=수락, 유료=거절) + 보류된 턴종료 마무리.
	if (game.pendingPowerOffers && game.pendingPowerOffers.length > 0) {
		for (const offer of game.pendingPowerOffers) {
			if (offer.responded) continue;
			if (offer.vpCost === 0 && offer.amount > 0 && game.players[offer.targetPlayerId]) {
				applyPlayerPowerCharge(game, offer.targetPlayerId, offer.amount);
			}
			offer.responded = true;
		}
		game.pendingPowerOffers = [];
		log(`forceSkipStuckBotTurn: stale pendingPowerOffers 강제 해소`, 'error', game.id);
	}
	game.pendingTurnEndPlayerId = undefined;

	if (Object.values(game.players).every(p => p.hasPassed)) {
		forceFinishStalledGame(io, game, `all passed after skip (${reason})`);
		return;
	}

	if (game.turnStartState) delete game.turnStartState[playerId];
	game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
	let guard = 0;
	while (game.players[game.turnOrder[game.currentPlayerIndex]]?.hasPassed && guard++ < game.turnOrder.length) {
		game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
	}
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
		log(`Bot turn execution error (forceSkipStuckBotTurn): ${err}`, 'error');
	});
}

/**
 * 봇 루프 stall 최종 안전망: 어떤 이유로든 게임이 진행 불가일 때 모든 플레이어를 패스 처리하고
 * 정상 종료(최종 미션/연구/잔여자원 점수 포함)시켜 측정/플레이가 영구 정지하지 않게 한다.
 * 라운드6 전원패스 종료(executePassRound)와 동일한 점수 계산을 사용한다. 드물게만 호출되는 안전망.
 */
export function forceFinishStalledGame(io: SocketIOServer, game: ServerGameState, reason: string): void {
	if (game.currentPhase === 'gameEnd') return;
	log(`forceFinishStalledGame: ending game ${game.id} (${reason})`, 'error', game.id);
	for (const p of Object.values(game.players)) p.hasPassed = true;

	if (!game.gameLog) game.gameLog = [];
	game.gameLog.push({ timestamp: Date.now(), playerId: '', playerName: 'Game', action: 'Game Finished', details: '최종 점수 정산', round: game.roundNumber });
	// [2026-08-06 사용자] 롤백 횟수는 집계는 하되 게임 로그(플레이어 화면)에는 띄우지 않는다 — 서버 로그에만 남김.
	{
		const rb = buildRollbackSummary(game);
		if (rb) log(`[ROLLBACK-SUMMARY] ${game.id} ${rb}`, 'game', game.id);
	}
	applyFinalMissionScoring(game);
	for (const pid of game.turnOrder) {
		const p = game.players[pid];
		if (!p?.research) continue;
		let researchBonus = 0;
		for (const track of RESEARCH_TRACKS) {
			const level = p.research[track.id] ?? 0;
			if (level >= 5) researchBonus += RESEARCH_TRACK_END_BONUS[5] ?? 12;
			else if (level >= 4) researchBonus += RESEARCH_TRACK_END_BONUS[4] ?? 8;
			else if (level >= 3) researchBonus += RESEARCH_TRACK_END_BONUS[3] ?? 4;
		}
		if (researchBonus > 0) addScore(game, pid, researchBonus, 'researchTracks');
	}
	for (const pid of Object.keys(game.players)) {
		const p = game.players[pid];
		if (!p) continue;
		const sum = endgameLeftoverUnits(game, pid, p); // [룰 2026-07-11] 파워 자동 환산 포함
		const vp = Math.floor(sum / 3);
		if (vp > 0) addScore(game, pid, vp, 'remainingResources');
	}
	for (const pid of Object.keys(game.players)) {
		const bid = game.players[pid]?.factionBidVp ?? 0;
		if (bid > 0) addScore(game, pid, -bid, 'other', { source: '종족 비딩' });
	}
	for (const pid of Object.keys(game.players)) ensureScoreBreakdown(game.players[pid]);
	game.currentPhase = 'gameEnd';
	turnHistories.delete(game.id); // [롤백] 게임 종료 → 히스토리 메모리 즉시 해제(끝난 게임엔 롤백 불필요)
	rollbackCounts.delete(game.id); // 위 종료 로그에 요약을 남긴 뒤이므로 함께 해제
	saveFinalGameState(game);
	flushGameData(game);
	clampPlayerResources(game);
	emitGameUpdated(io, game);
}

/** 특정 플레이어에 대해 파워 충전 처리 (타클론 브레인스톤 및 의회 보너스 포함) */
/** 충전 여력. 타클론 의회 보유자가 '토큰 먼저(piAddFirst)'를 고르면 그릇1 토큰 1개가 먼저 생기므로
 *  여력이 +2 늘어난다(그릇1 토큰 하나는 1→2, 2→3 두 칸을 흡수).
 *  [2026-08-07 사용자] 두 순서는 모두 유효한 선택이다 —
 *    · 파워 먼저: 받을 수 있는 만큼 받고 그다음 토큰 1개 추가 (여력은 평소와 동일)
 *    · 토큰 먼저: 토큰 1개 추가하고 그다음 받을 수 있는 만큼 받음 (여력 +2)
 *  오퍼 '표시 금액'은 최대치(토큰 먼저 기준)로 만들고, 실제 충전량은 수락 시 고른 순서로 재계산한다. */
function getMaxPowerGainForOrder(game: GaiaGameState, playerId: string, piAddFirst: boolean): number {
	const player = game.players[playerId];
	if (!player) return 0;
	const base = getMaxPowerGain(player);
	if (!piAddFirst) return base;
	const hasPI = player.faction === 'taklons' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
	return hasPI ? base + 2 : base;
}

function applyPlayerPowerCharge(game: GaiaGameState, playerId: string, amount: number, options?: { brainFirst?: boolean; piAddFirst?: boolean }) {
	const player = game.players[playerId];
	if (!player) return;

	const isTaklons = player.faction === 'taklons';
	const hasPI = isTaklons && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
	const brainFirst = options?.brainFirst !== false; // Default true
	const piAddFirst = options?.piAddFirst === true; // Default false (charge power from structures first, then add token)

	if (isTaklons) {
		if (hasPI) {
			// [2026-08-07 사용자] 두 순서 모두 유효한 선택이다.
			//   · 토큰 먼저: 그릇1에 토큰 1개를 만든 뒤 충전 → 그 토큰도 이번 충전으로 올라간다
			//     (풀파워에서 2파워 제안 → 토큰 생성 → 2충전으로 1→2→3그릇, VP 2−1=1점)
			//   · 파워 먼저: 받을 수 있는 만큼 먼저 받고 그다음 토큰 1개 추가(그 토큰은 이번엔 안 올라감)
			//   예전엔 "순서는 표시용일 뿐 추가 충전은 없다"는 주석과 함께 충전량이 토큰 추가 전 여력으로
			//   고정돼 있어, 풀파워에선 어느 쪽을 골라도 '1그릇에 토큰 1개'로 끝나 선택이 무의미했다.
			if (piAddFirst) {
				player.power1 = (player.power1 || 0) + 1;
				chargePowerTaklons(player, amount, brainFirst);
			} else {
				// [2026-08-07 사용자] '파워 먼저'인데 충전이 0이면(=풀파워) 애초에 '파워를 받는 행동'이 아니므로
				//   의회 토큰도 생기지 않는다. 클라가 이 순서를 못 고르게 막아두었지만 서버에서도 동일하게 판정한다.
				const charged = amount > 0 && getMaxPowerGain(player) > 0;
				chargePowerTaklons(player, amount, brainFirst);
				if (charged) player.power1 = (player.power1 || 0) + 1;
			}
		} else {
			chargePowerTaklons(player, amount, brainFirst);
		}
	} else {
		chargePower(player, amount);
	}
}

/** 맵 위 모든 건물에 대해 인접 플레이어에게 파워 제안 생성 (설정 종료 후 첫 수익 단계 등). 란티다 기생 광산도 포함 */
function createPowerOffersForAllStructures(game: ServerGameState): void {
	for (const tile of game.map) {
		if (tile.structure != null && tile.ownerId) {
			createPowerOffers(game, tile, tile.ownerId);
		}
		if (tile.parasiticMine?.ownerId) {
			createPowerOffers(game, tile, tile.parasiticMine.ownerId);
		}
	}
}

function generateGameId(): string {
	return Math.random().toString(36).substring(2, 10);
}

/** 소켓을 게임 방에 넣기 전, 이전에 참여한 '다른 게임' 방에서 제거.
 *  방을 넘나든 소켓이 이전 방에 남아 그 방의 채팅/업데이트를 계속 받던 문제(사용자 관찰: 채팅이 모든 방에 보임). */
/** [관전자 목록] 현재 접속 중인 관전자 id 목록(game.connectedSpectators) 갱신 — 채팅창 "(관전자: AA, BB)" 표기용.
 *  spectatorIds(재접속 허용 명단)와 별개: 이건 '지금 보고 있는 사람'만. */
function setSpectatorConnected(game: any, spectatorId: string, on: boolean) {
	const list: string[] = game.connectedSpectators ?? (game.connectedSpectators = []);
	const i = list.indexOf(spectatorId);
	if (on && i < 0) list.push(spectatorId);
	if (!on && i >= 0) list.splice(i, 1);
}

function joinGameRoom(socket: { id: string; rooms: Set<string>; join: (r: string) => void; leave: (r: string) => void }, gameId: string) {
	for (const r of Array.from(socket.rooms)) {
		if (r !== socket.id && r !== gameId && games.has(r)) socket.leave(r);
	}
	socket.join(gameId);
}

function generatePlayerId(): string {
	return 'p_' + Math.random().toString(36).substring(2, 12);
}

/** 룰: 턴 순서(하이브·확장4 제외) 1개씩 → 역순 1개씩 → 제노스 1개 → 확장 4종족 각 1개 → 하이브 의회 */
function buildStartingMineSequence(game: GaiaGameState): string[] {
	const turnOrder = game.turnOrder ?? Object.keys(game.players);
	const basePlayers: string[] = [];
	const xenosPlayer: string | null = turnOrder.find(pid => game.players[pid]?.faction === 'xenos') ?? null;
	const expansionPlayers: string[] = [];
	const ivitsPlayer: string | null = turnOrder.find(pid => game.players[pid]?.faction === 'ivits') ?? null;

	for (const pid of turnOrder) {
		const pFaction = FACTIONS.find(f => f.id === game.players[pid]?.faction);
		const pMaxMines = pFaction?.startingMines ?? 2;
		if (pFaction?.id === 'ivits') continue;
		if (pFaction?.id === 'xenos') {
			basePlayers.push(pid);
		} else if (pMaxMines === 1) {
			expansionPlayers.push(pid);
		} else {
			basePlayers.push(pid);
		}
	}
	const out: string[] = [];
	for (const pid of basePlayers) out.push(pid);
	for (let i = basePlayers.length - 1; i >= 0; i--) out.push(basePlayers[i]);
	if (xenosPlayer) out.push(xenosPlayer);
	for (const pid of expansionPlayers) out.push(pid);
	if (ivitsPlayer) out.push(ivitsPlayer);
	return out;
}

// Helper functions moved to top level
/** 로그 변동량 표시용: 플레이어의 점수/자원 스냅샷 한 컷 */
function snapOfPlayer(p: PlayerState) {
	return {
		vp: p.score ?? 0, c: p.credits ?? 0, o: p.ore ?? 0, k: p.knowledge ?? 0,
		q: p.qic ?? 0, p1: p.power1 ?? 0, p2: p.power2 ?? 0, p3: p.power3 ?? 0,
		// [버그추적 2026-08-06 사용자] 타클론 브레인 스톤 위치도 스냅샷에 — 프리액션/언두/충전에서 브레인이
		// 어디로 갔는지 로그 클릭만으로 추적 가능하게. 0 = 가이아 영역(이번 라운드 사용 불가), undefined = 타클론 아님.
		...(p.faction === 'taklons' ? { bs: p.brainStoneInGaia ? 0 : (p.brainStoneBowl ?? 1) } : {}),
	};
}

/** 액션 직전 기준선(_snapBase) 갱신: 인컴 적용 직후 전원, 턴 종료 시 등 — 변동량이 '이 액션만' 보이도록 */
export function resetLogSnapBase(game: GaiaGameState, playerId: string) {
	const p = game.players[playerId];
	if (!p) return;
	if (!(game as any)._snapBase) (game as any)._snapBase = {};
	(game as any)._snapBase[playerId] = snapOfPlayer(p);
}

/** 로그 '후'에 적용된 효과(예: 트랙 보너스 QIC는 addGameLog가 아니라 console log로만 처리)를
 *  그 플레이어의 마지막 로그 엔트리 snap에 끌어올리고 기준선도 동기화 → 다음 로그에 안 묻어나게 한다. */
export function finalizeLogSnap(game: GaiaGameState, playerId: string) {
	const p = game.players[playerId];
	if (!p || !game.gameLog) return;
	const s = snapOfPlayer(p);
	for (let i = game.gameLog.length - 1; i >= 0; i--) {
		if (game.gameLog[i].playerId === playerId) { game.gameLog[i].snap = s; break; }
	}
	if (!(game as any)._snapBase) (game as any)._snapBase = {};
	(game as any)._snapBase[playerId] = s;
}

export function addGameLog(game: GaiaGameState, playerId: string, action: string, details?: string, tileId?: string, meta?: { actionIndex?: number; shipTileId?: string }) {
	if ((game as any).simulation) return;
	if (!game.gameLog) {
		game.gameLog = [];
	}
	const player = game.players[playerId];
	if (!player) return;

	// [2026-07-08 사용자] 발타크 포머→QIC도 프리액션 — 3번 하면 로그 3줄 나옴 → 다른 프리액션처럼 한 줄(×N) 중첩.
	// [2026-07-12 사용자] 하드쉬할라 PI 변환(4C→1QIC 등)도 프리액션 반복 — 연사 시 줄마다 칸 소모 → ×N 중첩 대상에 추가
	const CONSOLIDATABLE_ACTIONS = ['Resource Convert', 'Burn 2 Power', 'Power Burn', 'Burn 2 Power (Itars)', 'Free Actions', "Bal T'aks: 1 Gaiaformer → 1 QIC", 'Hadsch Hallas PI'];
	const isConsolidatable = CONSOLIDATABLE_ACTIONS.includes(action);

	const lastLog = game.gameLog.length > 0 ? game.gameLog[game.gameLog.length - 1] : null;

	if (isConsolidatable && lastLog && lastLog.playerId === playerId && CONSOLIDATABLE_ACTIONS.includes(lastLog.action)) {
		// Consolidate into the last log
		lastLog.action = 'Free Actions';
		const newDetail = details || action;
		if (lastLog.details) {
			// [로그 표시 수정] 같은 변환을 여러 번(예: 연방 파워 채우려 1O→1Token ×5) 하면 기존엔 동일 문자열을 dedup해
			//   로그에 1개만 떠서 "5번 한 걸 1번처럼" 보였음(사용자 관찰). → 마지막 세그먼트와 같으면 ×N 카운트로 집계.
			const segs = lastLog.details.split(', ');
			const last = segs[segs.length - 1];
			const mm = last.match(/^(.*) ×(\d+)$/);
			const lastBase = mm ? mm[1] : last;
			const lastN = mm ? parseInt(mm[2], 10) : 1;
			if (lastBase === newDetail) {
				segs[segs.length - 1] = `${newDetail} ×${lastN + 1}`;
				lastLog.details = segs.join(', ');
			} else if (!lastLog.details.includes(newDetail)) {
				lastLog.details += `, ${newDetail}`;
			}
		} else {
			lastLog.details = newDetail;
		}
		lastLog.timestamp = Date.now(); // Update timestamp to keep it at the top if sorted
	} else {
		(game as any).gameLogSeq = ((game as any).gameLogSeq ?? 0) + 1;
			game.gameLog.push({
			timestamp: Date.now(),
			playerId,
			playerName: player.name,
			action: isConsolidatable ? 'Free Actions' : action,
			details: details || (isConsolidatable ? action : undefined),
			tileId,
			round: game.roundNumber, // [계측] 라운드별 행동 분해용(초반 TS 타이밍 등). h2h가 e.round로 버킷팅.
			seq: (game as any).gameLogSeq, // [롤백] 이 엔트리 시점의 단조 seq — 로그에서 '여기로 롤백' 매핑용
		});
	}

	// 로그 클릭 시 '이 액션의 변동량' 표시용 — base(액션 직전) → snap(액션 후).
	// base는 _snapBase(직전 로그 시점 갱신 + 인컴 직후 리셋)에서 가져와, 인컴/지난 턴까지 섞이는 '전턴 대비' 혼동을 없앤다.
	// 트랙 보너스 QIC처럼 로그 '후'에 적용되는 효과는 다음 갱신/턴 종료(finalizeLogSnap)에서 snap이 끌어올려져 반영된다.
	if (!(game as any)._snapBase) (game as any)._snapBase = {};
	const _snapLast = game.gameLog[game.gameLog.length - 1];
	const _curSnap = snapOfPlayer(player);
	if (_snapLast) {
		_snapLast.round = game.roundNumber;
		// 신규 엔트리에만 base 설정(합치기 엔트리는 처음 base 유지). 합치기 여부 = 직전과 동일 객체.
		if (!_snapLast.base) _snapLast.base = (game as any)._snapBase[playerId] ?? _curSnap;
		_snapLast.snap = _curSnap;
	}
	(game as any)._snapBase[playerId] = _curSnap; // 다음 로그의 base 기준선 = 이 액션 결과

	recordHumanActionFromLog(game as ServerGameState, playerId, action, details, tileId, meta);
	// 사람 게임 한정 전체 로그(봇 포함, 전 라운드) — 라이브 gameLog는 아래에서 100캡되므로 별도 보관.
	recordFullGameLog(game as ServerGameState, playerId, action, details, tileId);

	// 라이브 로그 상한: 전체 로그 보기(처음부터 라운드 점프) 지원 위해 100→2000으로 상향.
	// 정상 게임(4인 6라운드 ~460엔트리)은 절대 안 닿으므로 shift가 안 일어나 reset도 더 안전.
	// 메모리 영향 미미(엔트리 ~250B, 460개 ≈ 115KB/게임). 2000은 폭주 방지용 안전상한.
	if (game.gameLog.length > 2000) {
		game.gameLog.shift();
	}
}

/**
 * [로그 정합성] 액션 취소 핸들러(전체 리셋이 아니라 자원만 수동 환불하는 경로)가 방금 남긴 placeholder 로그 1줄을 제거한다.
 * 안 지우면 취소한 액션이 로그에 그대로 남고(사용자: "이클립스 2K+3P 취소했는데 로그에 남아있음"), gameLogSeq를 함께
 * 되돌리지 않으면 같은 턴의 이후 reset_turn이 seq기반 트림을 과다 계산해 정상 로그까지 지운다. base 스냅도 환불 후 값으로
 * 재동기화해 다음 로그의 '변동량' 표시가 취소된 액션 기준으로 어긋나지 않게 한다.
 * ※ pending 모달이 UI를 막아 placeholder가 항상 그 플레이어의 '마지막' 엔트리라는 전제 → action 이름이 안 맞으면 no-op(안전).
 */
function removeLastGameLogEntry(game: GaiaGameState, playerId: string, action: string): void {
	if ((game as any).simulation) return; // addGameLog와 동일 가드 — sim에선 로그도 seq도 안 건드림
	const gl = game.gameLog;
	if (!gl || gl.length === 0) return;
	const last = gl[gl.length - 1];
	if (last.playerId !== playerId || last.action !== action) return;
	gl.pop();
	if (typeof (game as any).gameLogSeq === 'number') {
		(game as any).gameLogSeq = Math.max(0, (game as any).gameLogSeq - 1);
	}
	resetLogSnapBase(game, playerId);
}

function getAiFeedbackFilePath(): string {
	return path.resolve(process.cwd(), 'server', 'ai', 'expertFeedback.jsonl');
}

function summarizeGameForAiFeedback(game: GaiaGameState) {
	return {
		roundNumber: game.roundNumber,
		currentPhase: game.currentPhase,
		currentPlayerId: game.turnOrder?.[game.currentPlayerIndex],
		players: Object.fromEntries(Object.entries(game.players).map(([id, p]) => [id, {
			name: p.name,
			faction: p.faction,
			score: p.score,
			ore: p.ore,
			credits: p.credits,
			knowledge: p.knowledge,
			qic: p.qic,
			research: p.research,
			bonusTile: p.bonusTile,
			federations: getFederationEntries(p),
			techTiles: p.techTiles,
			coveredTechTiles: p.coveredTechTiles,
		}])),
		structures: game.map
			.filter((t) => t.ownerId && t.structure)
			.map((t) => ({ id: t.id, ownerId: t.ownerId, type: t.type, sector: t.sector, structure: t.structure })),
		recentLogs: (game.gameLog ?? []).slice(-12),
	};
}

function saveAiExpertFeedback(game: GaiaGameState, submitterId: string, role: 'player' | 'spectator', payload: any, targetAction: NonNullable<GaiaGameState['lastBotActionForFeedback']>) {
	const feedbackPath = getAiFeedbackFilePath();
	fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });

	const record = {
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		gameId: game.id,
		submitterId,
		submitterRole: role,
		lastBotAction: targetAction,
		rating: typeof payload?.rating === 'string' ? payload.rating.slice(0, 32) : 'unspecified',
		expertMove: typeof payload?.expertMove === 'string' ? payload.expertMove.slice(0, 500) : '',
		reason: typeof payload?.reason === 'string' ? payload.reason.slice(0, 2000) : '',
		tags: Array.isArray(payload?.tags) ? payload.tags.filter((x: unknown) => typeof x === 'string').slice(0, 12) : [],
		gameSummary: summarizeGameForAiFeedback(game),
	};

	fs.appendFileSync(feedbackPath, JSON.stringify(record) + '\n', 'utf8');
	return record;
}

export function addSubLogToLastAction(game: GaiaGameState, sourcePlayerId: string, subLog: { playerId: string; playerName: string; text: string }): boolean {
	if (!game.gameLog || game.gameLog.length === 0) return false;
	if (!subLog.text) return false;

	// 뒤에서부터 탐색하여 sourcePlayerId가 일으킨 최근 메인 액션을 찾음
	for (let i = game.gameLog.length - 1; i >= 0; i--) {
		const log = game.gameLog[i];
		// 파워 수령/수익 로그가 아닌 메인 액션 로그를 찾음
		if (log.playerId === sourcePlayerId && !/power|income|energy|bowl/i.test(log.action) && !/Accepted|Declined/i.test(log.action)) {
			if (!log.subLogs) log.subLogs = [];
			log.subLogs.push(subLog);
			return true;
		}
	}
	return false;
}

/** 마지막 로그가 같은 플레이어 것이면 details에 `(+NVP reason)` 세그먼트를 붙인다.
 *  같은 reason 세그먼트가 이미 있으면 VP를 합산(예: 테라포밍 3단계 → +2VP 3번 대신 +6VP 1번).
 *  직전 로그가 내 것이 아니면 새 로그로 남기되, 이후 병합이 가능하도록 동일한 `(+NVP reason)` 포맷을 쓴다. */
function appendVpSegmentToLastLog(game: GaiaGameState, playerId: string, vp: number, reason: string) {
	if (!game.gameLog) game.gameLog = [];
	const lastLog = game.gameLog.length > 0 ? game.gameLog[game.gameLog.length - 1] : null;
	const segment = `(+${vp}VP ${reason})`;
	if (lastLog && lastLog.playerId === playerId) {
		if (lastLog.details) {
			const re = new RegExp(`\\(\\+(\\d+)VP ${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`);
			const m = lastLog.details.match(re);
			if (m) {
				lastLog.details = lastLog.details.replace(re, `(+${parseInt(m[1], 10) + vp}VP ${reason})`);
			} else {
				lastLog.details += ` ${segment}`;
			}
		} else {
			lastLog.details = segment;
		}
	} else {
		// [로그 정리 2026-08-03 사용자] 병합할 내 로그가 없을 때 예전엔 액션명이 빈 줄로 떠서 깨진 칸처럼 보였다.
		//   최소한 사유를 액션명으로 세워 읽히게 한다(정상 경로는 위 병합으로 처리됨 — 여기는 예외 폴백).
		addGameLog(game, playerId, reason, `+${vp}VP`);
	}
}

export function applyRoundMissionScore(game: GaiaGameState, playerId: string, triggerType: string) {
	const currentRoundIndex = game.roundNumber - 1;
	if (currentRoundIndex < 0 || currentRoundIndex >= game.roundScoringTiles.length) return;

	const currentRoundMission = game.roundScoringTiles[currentRoundIndex];
	if (!currentRoundMission || currentRoundMission.triggerType !== triggerType) return;

	const player = game.players[playerId];
	if (!player) return;

	const vpGain = currentRoundMission.vp;
	addScore(game, playerId, vpGain, 'roundMissions', { round: game.roundNumber });
	log(`Player ${player.name} gained ${vpGain} VP from Round ${game.roundNumber} mission: ${currentRoundMission.condition}`, 'game', undefined, { simulation: (game as any).simulation });

	// 메인 액션 로그에 병합. 'Round' 접두로 고급기술 보너스와 구분(둘 다 동시에 떠도 식별 가능).
	appendVpSegmentToLastLog(game, playerId, vpGain, `Round ${currentRoundMission.condition}`);
}

export function applyFinalMissionScoring(game: GaiaGameState) {
	if (game.finalMissionScoresApplied || !game.finalMissionIds?.length) return;
	const missionIds = game.finalMissionIds;
	const POINTS = [18, 12, 6];

	for (const missionId of missionIds) {
		const values = game.turnOrder.map(pid => ({ playerId: pid, value: getFinalMissionValue(game, pid, missionId) }));
		const withValue = values.filter(v => v.value > 0).sort((a, b) => b.value - a.value);
		if (withValue.length === 0) continue;

		let placeIndex = 0;
		while (placeIndex < withValue.length) {
			const group: typeof withValue = [];
			const firstVal = withValue[placeIndex].value;
			const startPlace = placeIndex;
			while (placeIndex < withValue.length && withValue[placeIndex].value === firstVal) {
				group.push(withValue[placeIndex]);
				placeIndex++;
			}
			const pool = group.reduce((sum, _, i) => sum + (POINTS[startPlace + i] ?? 0), 0);
			const pointsEach = group.length > 0 ? Math.floor((pool * 10) / group.length) / 10 : 0;
			for (const { playerId } of group) {
				const p = game.players[playerId];
				if (p) {
					addScore(game, playerId, pointsEach, 'finalMissions', { missionId });
					addGameLog(game, playerId, 'Final Mission', `+${pointsEach} VP`, missionId);
				}
			}
		}
	}
	game.finalMissionScoresApplied = true;
}

/**
 * [Path A 벽돌1a] 롤아웃 terminal 평가용 순수 종료 점수 적용.
 * forceFinishStalledGame의 점수 시퀀스(최종미션+연구트랙+잔여자원+비딩)와 동일하되 io/저장/emit/flush 없음.
 * 클론된 시뮬 상태에 적용해 각 플레이어 최종 VP(player.score)를 확정한다. (eval 천장 우회 = 진짜 최종점수로 리프 평가)
 * 주의: addScore가 호출되므로 시뮬 클론에만 사용(실게임 상태에 쓰지 말 것).
 */
export function scoreTerminalStateForRollout(game: ServerGameState): void {
	applyFinalMissionScoring(game);
	for (const pid of game.turnOrder) {
		const p = game.players[pid];
		if (!p?.research) continue;
		let researchBonus = 0;
		for (const track of RESEARCH_TRACKS) {
			const level = p.research[track.id] ?? 0;
			if (level >= 5) researchBonus += RESEARCH_TRACK_END_BONUS[5] ?? 12;
			else if (level >= 4) researchBonus += RESEARCH_TRACK_END_BONUS[4] ?? 8;
			else if (level >= 3) researchBonus += RESEARCH_TRACK_END_BONUS[3] ?? 4;
		}
		if (researchBonus > 0) addScore(game, pid, researchBonus, 'researchTracks');
	}
	for (const pid of Object.keys(game.players)) {
		const p = game.players[pid];
		if (!p) continue;
		const sum = endgameLeftoverUnits(game, pid, p);
		const vp = Math.floor(sum / 3);
		if (vp > 0) addScore(game, pid, vp, 'remainingResources');
	}
	for (const pid of Object.keys(game.players)) {
		const bid = game.players[pid]?.factionBidVp ?? 0;
		if (bid > 0) addScore(game, pid, -bid, 'other', { source: '종족 비딩' });
	}
}

/** [룰 2026-07-11 사용자 확정] 종료 잔여자원 정산 시 파워 자동 환산:
 *  2그릇을 전부 번(2토큰→1개 3그릇행) → 3그릇 전체를 크레딧으로(기본 1C, 네뷸라 의회 보유 시 2C,
 *  타클론 브레인스톤은 3C — 2그릇에 있으면 일반토큰 1개를 번 비용으로 쓰고 이동) 후 합산. /3은 호출부에서.
 *  (기존엔 파워 미포함 → 플레이어가 패스 전 수동 변환 노가다를 해야 했음) */
function endgameLeftoverUnits(game: GaiaGameState, pid: string, p: PlayerState): number {
	let sum = (p.ore ?? 0) + (p.credits ?? 0) + (p.qic ?? 0) + (p.knowledge ?? 0);
	const hasPI = game.map.some(t => t.ownerId === pid && t.structure === 'planetary_institute');
	const rate = (p.faction === 'nevlas' && hasPI) ? 2 : 1;
	let n2 = p.power2 ?? 0;
	const n3 = p.power3 ?? 0;
	let brainC = 0;
	// !brainStoneInGaia: 우주선 입장으로 브레인이 가이아 영역에 있으면(:9699 — brainStoneBowl은 안 지워짐)
	// 이번 라운드엔 쓸 수 없으므로 환산 대상이 아니다. 다른 브레인 사용처(1B→3C, 번, 파워지불)와 동일한 가드.
	// (잠재 버그였음: R6 우주선 입장 후 종료 시 부당 +3유닛 → 최대 +1VP. 실측 571판 중 발생 0건)
	if (p.faction === 'taklons' && !p.brainStoneInGaia) {
		if (p.brainStoneBowl === 3) brainC = 3;
		else if (p.brainStoneBowl === 2 && n2 >= 1) { brainC = 3; n2 -= 1; } // 이동 번 비용: 일반토큰 1개
	}
	sum += (n3 + Math.floor(n2 / 2)) * rate + brainC;
	return sum;
}

export function qualifiesForNewSectorRoundMission(game: GaiaGameState, playerId: string, tileId: string, sector?: number): boolean {
	const tile = game.map.find(t => t.id === tileId || String(t.id) === tileId);
	if (!tile) return false;
	const sec = sector ?? tile.sector;
	if (sec == null || sec === undefined) return false;
	if (sec === 90) return false; // 가운데 전략 헥스(우주선·소행성·원시·빈칸, sector 90)는 섹터가 아님 — 새 섹터/브릿지 점수 대상 제외(사용자 관찰)
	const hadStructureInThisSector = game.map.some(t => t.sector === sec && tileOccupiesSector(t, playerId));
	const isNewSector = !hadStructureInThisSector;
	const isBridgeSector = sec >= 11 && sec <= 18;
	return isNewSector || isBridgeSector;
}

export function applyAdvancedTechTileEffect(game: GaiaGameState, playerId: string, actionType: 'build_mine' | 'build_ts' | 'research' | 'terraform' | 'qic_action') {
	const player = game.players[playerId];
	if (!player || !player.techTiles) return;

	if (!game.gameLog) game.gameLog = [];

	// 'Advanced' 접두로 라운드 미션 보너스와 구분(둘 다 동시에 떠도 식별 가능). 같은 사유는 자동 합산됨.
	const appendToLastLog = (vp: number, reason: string) => appendVpSegmentToLastLog(game, playerId, vp, `Advanced ${reason}`);

	for (const tileId of player.techTiles) {
		// 덮인 기술 타일이면 적용하지 않음
		if (isTechTileCovered(player, tileId)) continue;

		if (actionType === 'build_mine' && tileId === 'adv-vp-build-mine') {
			addScore(game, playerId, 3, 'techTiles', { tileId });
			appendToLastLog(3, 'Mine built');
		}
		else if (actionType === 'build_ts' && tileId === 'adv-vp-build-ts') {
			addScore(game, playerId, 3, 'techTiles', { tileId });
			appendToLastLog(3, 'TS built');
		}
		else if (actionType === 'research' && tileId === 'adv-vp-research') {
			addScore(game, playerId, 2, 'techTiles', { tileId });
			appendToLastLog(2, 'Research advanced');
		}
		else if (actionType === 'terraform' && tileId === 'adv-vp-terraform') {
			addScore(game, playerId, 2, 'techTiles', { tileId });
			appendToLastLog(2, 'Terraform step');
		}
		else if (actionType === 'qic_action' && tileId === 'adv-vp-qic-action') {
			addScore(game, playerId, 4, 'techTiles', { tileId });
			appendToLastLog(4, 'QIC action');
		}
	}
}

export function applyAdvancedTechTilePassEffect(game: GaiaGameState, playerId: string, options?: { suppressLog?: boolean }): Array<{ tileId: string; vp: number }> {
	const player = game.players[playerId];
	const results: Array<{ tileId: string; vp: number }> = [];
	if (!player || !player.techTiles) return results;
	const suppressLog = options?.suppressLog ?? false;

	// 계산은 shared computeAdvancedTechPassVp 단일 출처 (클라 미리보기와 동일 함수). 여기서는 점수/로그 반영만.
	for (const item of computeAdvancedTechPassVp(game, playerId)) {
		addScore(game, playerId, item.vp, 'techTiles', { tileId: item.tileId });
		if (!suppressLog) addGameLog(game, playerId, 'Tech Tile Pass Bonus', `+${item.vp} VP (${item.reason})`);
		results.push({ tileId: item.tileId, vp: item.vp });
	}
	return results;
}

// 트랙 레벨 상승 시 즉시 보너스를 주는 공통 함수 (playerId는 grantQic용)
export function applyTrackLevelBonus(game: GaiaGameState, playerId: string, player: PlayerState, track: ResearchTrack, newLevel: number) {
	// 레벨 3에서 공통 보너스: 파워 3 충전
	if (newLevel === 3) {
		if (player.faction === 'taklons') chargePowerTaklons(player, 3, true);
		else chargePower(player, 3);
		log(`Player ${player.name} gained 3 power from reaching level 3 in ${track}`, 'game', undefined, { simulation: (game as any).simulation });
	}

	// Navigation 트랙 보너스
	if (track === 'navigation') {
		if (newLevel === 1 || newLevel === 3) {
			grantQic(game, playerId, 1);
			const isGleensOre = player.faction === 'gleens' && getAcademyRightCount(game, playerId) < 1;
			log(`Player ${player.name} gained 1 ${isGleensOre ? 'Ore (Gleens)' : 'QIC'} from Navigation level ${newLevel}`, 'game', undefined, { simulation: (game as any).simulation });
		}
		if (newLevel === 5) {
			game.pendingLostPlanet = { playerId };
			log(`Player ${player.name} reached Navigation 5: Lost Planet placement pending`, 'game', undefined, { simulation: (game as any).simulation });
		}
	}

	// Artificial Intelligence 트랙 보너스
	if (track === 'artificialIntelligence') {
		if (newLevel === 1) {
			grantQic(game, playerId, 1);
			log(`Player ${player.name} gained 1 QIC from AI level 1`, 'game', undefined, { simulation: (game as any).simulation });
		} else if (newLevel === 2) {
			grantQic(game, playerId, 1);
			log(`Player ${player.name} gained 1 QIC from AI level 2`, 'game', undefined, { simulation: (game as any).simulation });
		} else if (newLevel === 3) {
			grantQic(game, playerId, 2);
			log(`Player ${player.name} gained 2 QIC from AI level 3`, 'game', undefined, { simulation: (game as any).simulation });
		} else if (newLevel === 4) {
			grantQic(game, playerId, 2);
			log(`Player ${player.name} gained 2 QIC from AI level 4`, 'game', undefined, { simulation: (game as any).simulation });
		} else if (newLevel === 5) {
			grantQic(game, playerId, 4);
			log(`Player ${player.name} gained 4 QIC from AI level 5`, 'game', undefined, { simulation: (game as any).simulation });
		}
	}

	// Terraforming 트랙 보너스
	if (track === 'terraforming') {
		if (newLevel === 1 || newLevel === 4) {
			player.ore += 2;
			log(`Player ${player.name} gained 2 Ore from Terraforming level ${newLevel}`, 'game', undefined, { simulation: (game as any).simulation });
		}
		if (newLevel === 5) {
			const rewardId = game.federationOnTerraforming5;
			if (!game.federationPool) {
				game.federationPool = {};
				FEDERATION_REWARDS.forEach(r => { game.federationPool![r.id] = 3; });
			}
			// 연구 트랙에 올려둔 연방 1장은 create_game 시 해당 종류 풀에서 이미 -1 반영됨 — TF5 획득 시 풀을 또 줄이지 않음
			const reward = rewardId ? FEDERATION_REWARDS.find(r => r.id === rewardId) : undefined;
			if (reward) {
				// [사용자 2026-08-03] 다른 로그처럼 영문 액션명 + 연방 타일 이미지로 표시.
				//   tileId에 보상 id를 실으면 클라 GameLog가 Federation_N.gif를 렌더(액션명 무관 — 같은 날 규칙 확장).
				addGameLog(game, playerId, 'Terra Reward', reward.label, reward.id);
				addScore(game, playerId, reward.vp, 'other', { source: 'Terraforming 5 Reward' });
				if ('ore' in reward && reward.ore) player.ore += reward.ore;
				if ('credits' in reward && reward.credits) player.credits += reward.credits;
				if ('knowledge' in reward && reward.knowledge) player.knowledge += reward.knowledge;
				if ('qic' in reward && reward.qic) grantQic(game, playerId, reward.qic);
				if ('powerTokens' in reward && reward.powerTokens) player.power1 = (player.power1 || 0) + reward.powerTokens;
				if (!Array.isArray(player.federations) || (player.federations.length > 0 && typeof (player.federations as any)[0] === 'string')) {
					player.federations = getFederationEntries(player);
				}
				player.federations.push({ rewardId: reward.id, isGreen: reward.id !== FEDERATION_12VP_ID });
				log(`Player ${player.name} gained federation reward from Terraforming 5: ${reward.label}`, 'game', undefined, { simulation: (game as any).simulation });
				applyRoundMissionScore(game, playerId, 'federation');
			}
		}
	}

	// Gaia Project 트랙 보너스
	if (track === 'gaiaProject') {
		if (newLevel === 1) {
			// 1단계: 가이아포머 1개
			player.gaiaformers = (player.gaiaformers || 0) + 1;
			log(`Player ${player.name} gained 1 Gaiaformer from Gaia Project level 1 (Total: ${player.gaiaformers})`, 'game', undefined, { simulation: (game as any).simulation });
		} else if (newLevel === 2) {
			// 2단계: 1단계 토큰 3개 (power1에 3개 추가)
			player.power1 = (player.power1 || 0) + 3;
			log(`Player ${player.name} gained 3 power tokens from Gaia Project level 2`, 'game', undefined, { simulation: (game as any).simulation });
		} else if (newLevel === 3) {
			// 3단계: 포머 2개
			player.gaiaformers = (player.gaiaformers || 0) + 1;
			log(`Player ${player.name} gained 1 Gaiaformers from Gaia Project level 3 (Total: ${player.gaiaformers})`, 'game', undefined, { simulation: (game as any).simulation });
		} else if (newLevel === 4) {
			// 4단계: 포머 3개
			player.gaiaformers = (player.gaiaformers || 0) + 1;
			log(`Player ${player.name} gained 1 Gaiaformers from Gaia Project level 4 (Total: ${player.gaiaformers})`, 'game', undefined, { simulation: (game as any).simulation });
		} else if (newLevel === 5) {
			// 5단계: 4점 + 가이아 행성만큼 점수
			const playerId = Object.keys(game.players).find(id => game.players[id] === player);
			if (playerId) {
				const playerStructures = game.map.filter(t => t.ownerId === playerId);
				const gaiaPlanets = playerStructures.filter(t => t.type === 'gaia').length;
				const vpGain = 4 + gaiaPlanets;
				addScore(game, playerId, vpGain, 'other', { source: 'Gaia Project track reward', noLog: true });
				// 직전 메인 액션(예: Advanced Research) 로그의 하위줄로 붙임. 없으면 단독 로그.
				const sub = addSubLogToLastAction(game, playerId, { playerId, playerName: player.name, text: `Gaia Project Track Reward +${vpGain} VP` });
				if (!sub) addGameLog(game, playerId, 'Gaia Project Track Reward', `+${vpGain} VP`);
				log(`Player ${player.name} gained ${vpGain} VP from Gaia Project level 5 (4 base + ${gaiaPlanets} Gaia planets)`, 'game', undefined, { simulation: (game as any).simulation });
			}
		}
	}

	// Economy 트랙 보너스 (레벨 5)
	if (track === 'economy' && newLevel === 5) {
		player.ore += 3;
		player.credits += 6;
		if (player.faction === 'taklons') chargePowerTaklons(player, 6, true);
		else chargePower(player, 6);
		log(`Player ${player.name} gained 3 Ore, 6 Credits, and 6 Power from Economy level 5`, 'game', undefined, { simulation: (game as any).simulation });
	}

	// Science 트랙 보너스 (레벨 5)
	if (track === 'science' && newLevel === 5) {
		player.knowledge += 9;
		log(`Player ${player.name} gained 9 Knowledge from Science level 5`, 'game', undefined, { simulation: (game as any).simulation });
	}

	// 트랙 보너스(QIC/오레/지식 등)는 직전 액션 로그 '이후' console log로만 적용된다 → 그 액션 로그의 변동량에
	// 반영되도록 snap을 끌어올리고 기준선 동기화(다음 로그에 안 묻어나게). 사용자 관찰: AI트랙 +1Q가 다음 로그에 뜨던 문제.
	const _btId = Object.keys(game.players).find(id => game.players[id] === player);
	if (_btId) finalizeLogSnap(game, _btId);
}


export function helperTriggerIncomePhase(io: SocketIOServer, game: GaiaGameState) {
	// 이미 수익 선택이 진행 중이면 중복 호출 방지
	if (game.pendingIncomeOrder) {
		log(`Income phase already in progress for player ${game.pendingIncomeOrder.playerId}`, 'game', undefined, { simulation: (game as any).simulation });
		return;
	}
	// 파워 수신은 턴 종료 시점에만 처리. 라운드 시작(수익 단계)에서는 잔여 제안을 정리.
	if (game.pendingPowerOffers && game.pendingPowerOffers.length > 0) {
		game.pendingPowerOffers = [];
		log(`Income phase: cleared pending power offers`, 'game', undefined, { simulation: (game as any).simulation });
	}
	if ((game as ServerGameState).queuedPowerOffers && (game as ServerGameState).queuedPowerOffers!.length > 0) {
		(game as ServerGameState).queuedPowerOffers = [];
		log(`Income phase: cleared queued power offers`, 'game', undefined, { simulation: (game as any).simulation });
	}
	if ((game as ServerGameState).pendingTurnEndPlayerId) {
		(game as ServerGameState).pendingTurnEndPlayerId = undefined;
	}
	log(`Triggering income phase for round ${game.roundNumber}`, 'game', game.id, { simulation: (game as any).simulation });
	// [진단] 분기 결정 상태를 게임별 로그파일에 기록 (수익 스킵 버그 추적)
	log(`[Income][diag] round=${game.roundNumber} incomePhaseAppliedThisRound=${(game as any).incomePhaseAppliedThisRound} pendingIncomeOrder=${(game.pendingIncomeOrder as any)?.playerId ?? 'none'}`, 'game', game.id, { simulation: (game as any).simulation });
	const turnOrder = game.turnOrder ?? Object.keys(game.players);

	// 재진입(한 명이 수익 선택 완료 후): 수익 재적용 없이, 파워/토큰 선택이 남은 다음 플레이어만 턴 순서로 찾기
	if ((game as any).incomePhaseAppliedThisRound) {
		for (const pId of turnOrder) {
			const player = game.players[pId];
			const items = (player as any).pendingIncomeItems;
			if (!items?.length) continue;
			game.pendingIncomeOrder = {
				playerId: pId,
				incomeItems: [...items],
				appliedItems: [],
				powerBeforeSnapshots: [],
			};
			log(`[Income] Next: ${player.name} needs to select income items: ${items.length} items`, 'game', undefined, { simulation: (game as any).simulation });
			clampPlayerResources(game); emitGameUpdated(io, game);
			executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
				log(`Bot turn execution error (IncomeReentry): ${err}`, 'error');
			});
			return;
		}
		// 선택 대기 플레이어 없음 → 아래 가이아 포머 복귀 등으로 진행
	} else {
		// 라운드당 1회: 모든 플레이어에게 턴 순서대로 수익 적용 (먼저 모두 수익 → 그 다음 액션 단계)
		const playersNeedingOrder: string[] = [];
		for (const pId of turnOrder) {
			const player = game.players[pId];
			if (!player?.faction) continue;

			player.hasPassed = false;
			const factionId = player.faction;

			const beforeResources = { ore: player.ore, credits: player.credits, knowledge: player.knowledge, qic: player.qic, power3: player.power3 };
			log(`[Income] ${player.name} BEFORE: O:${beforeResources.ore} C:${beforeResources.credits} K:${beforeResources.knowledge} Q:${beforeResources.qic} P3:${beforeResources.power3} | BonusTile: ${player.bonusTile}`, 'game', game.id, { simulation: (game as any).simulation });

			// --- Round income totals accumulator (stable metric for tuning) ---
			const incomeRound = game.roundNumber || 1;
			let gainedOre = 0;
			let gainedCredits = 0;
			let gainedKnowledge = 0;
			let gainedQic = 0;
			let gainedPowerCharge = 0;  // amount that will be charged (bowl movement)
			let gainedPowerTokens = 0;  // tokens added directly to bowls (ex: base/bonus/pi tokens, artifacts to bowl3)
			const grantQicAndTrack = (amount: number) => {
				if (!amount) return;
				const beforeQ = player.qic ?? 0;
				const beforeO = player.ore ?? 0;
				grantQic(game, pId, amount);
				const afterQ = player.qic ?? 0;
				const afterO = player.ore ?? 0;
				if (afterQ > beforeQ) gainedQic += (afterQ - beforeQ);
				if (afterO > beforeO) gainedOre += (afterO - beforeO); // Gleens conversion etc.
			};

			// 수익 단계에서 파워와 토큰 수익을 개별 아이템으로 수집
			const incomeItems: Array<{ type: 'power' | 'tokens'; amount: number; id: string }> = [];

			// 1. Base Income (faction-specific)
			const faction = FACTIONS.find(f => f.id === factionId);
			const baseOre = faction?.baseIncome?.ore ?? 1;
			const baseKnowledge = faction?.baseIncome?.knowledge ?? 1;
			const baseCredits = faction?.baseIncome?.credits ?? 0;
			const baseQic = faction?.baseIncome?.qic ?? 0;
			const basePowerTokens = faction?.baseIncome?.powerTokens ?? 0;

			player.ore += baseOre;
			gainedOre += baseOre;
			player.knowledge += baseKnowledge;
			gainedKnowledge += baseKnowledge;
			player.credits = (player.credits || 0) + baseCredits;
			gainedCredits += baseCredits;
			grantQicAndTrack(baseQic);
			if (basePowerTokens > 0) {
				incomeItems.push({ type: 'tokens', amount: basePowerTokens, id: `base-tokens-${pId}` });
				gainedPowerTokens += basePowerTokens;
			}
			// 인공물 수익: 1=매라운드 2토큰(3그릇), 2=매라운드 1K 1O
			const arts = player.artifacts ?? [];
			if (arts.includes('art-income-2p3')) { player.power3 = (player.power3 || 0) + 2; gainedPowerTokens += 2; }
			if (arts.includes('art-income-1k1o')) {
				player.knowledge += 1;
				player.ore += 1;
				gainedKnowledge += 1;
				gainedOre += 1;
			}

			// 2. Structure Income
			const playerStructures = game.map.filter(t => t.ownerId === pId);

			// Mines (일반 광산 + 란티다 기생 광산)
			const mineCount = getEffectiveMineCount(game, pId);
			for (let i = 0; i < mineCount && i < STRUCTURE_INCOME.mine.length; i++) {
				player.ore += STRUCTURE_INCOME.mine[i];
				gainedOre += STRUCTURE_INCOME.mine[i];
			}

			// Trading Stations
			const tsCount = playerStructures.filter(t => t.structure === 'trading_station').length;
			for (let i = 0; i < tsCount && i < STRUCTURE_INCOME.trading_station.length; i++) {
				if (factionId === 'bescods') {
					player.knowledge += 1;
					gainedKnowledge += 1;
				} else {
					player.credits += STRUCTURE_INCOME.trading_station[i];
					gainedCredits += STRUCTURE_INCOME.trading_station[i];
				}
			}

			// Research Labs — shared/gameConfig.ts getNextRoundIncomePreview와 동일 (labBase는 연구소 0개여도 적용)
			const labCount = playerStructures.filter(t => t.structure === 'research_lab').length;
			if (factionId === 'bescods') {
				if (labCount > 0) {
					const labCredits = [3, 4, 5];
					for (let i = 0; i < labCount && i < labCredits.length; i++) {
						player.credits += labCredits[i];
						gainedCredits += labCredits[i];
					}
				}
			} else {
				if (labCount > 0) {
					if (factionId === 'nevlas') {
						incomeItems.push({ type: 'power', amount: 2 * labCount, id: `nevlas-lab-${pId}` });
						gainedPowerCharge += 2 * labCount;
					} else {
						player.knowledge += labCount;
						gainedKnowledge += labCount;
					}
				}
			}

			// Academies (왼쪽: 수익 2K, 아이타는 3K / 오른쪽: Special 액션 1QIC, 발타크는 4C)
			const leftAcademyCount = playerStructures.filter(t => t.structure === 'academy' && (t.academyType === 'left' || (t as any).academyType == null)).length;
			if (leftAcademyCount > 0) {
				const kPerLeft = player.faction === 'itars' ? 3 : STRUCTURE_INCOME.academy.left;
				player.knowledge += leftAcademyCount * kPerLeft;
				gainedKnowledge += leftAcademyCount * kPerLeft;
			}

			// Planetary Institute 체크 (PI 자체 수익과 의회 수익 모두에 사용)
			const hasPI = playerStructures.some(t => t.structure === 'planetary_institute');

			// PI 자체의 파워 수익은 즉시 처리 (의회 수익과 별개, 선택 불필요)
			// 3. Tech Track Income: Economy
			const econLevel = player.research.economy || 0;
			if (econLevel < 5) {
				// 경제 트랙 변형에 따라 다른 수익 적용 (레벨 5는 즉시 보상이므로 수익 없음)
				const economyIncome = game.economyVariant === 'vp' ? ECONOMY_INCOME_VP : ECONOMY_INCOME_POWER;
				const ei = economyIncome[econLevel] || economyIncome[0];
				player.credits += ei.credits;
				player.ore += ei.ore;
				gainedCredits += ei.credits;
				gainedOre += ei.ore;
				if (ei.power) {
					incomeItems.push({ type: 'power', amount: ei.power, id: `economy-${econLevel}-${pId}` });
					gainedPowerCharge += ei.power;
				}
				if (ei.vp) {
					addScore(game, pId, ei.vp, 'other', { source: 'Economy track reward', noLog: true });
					addGameLog(game, pId, 'Economy Track Reward', `+${ei.vp} VP`);
					log(`Player ${player.name} gained ${ei.vp} VP from Economy level ${econLevel}`, 'game', undefined, { simulation: (game as any).simulation });
				}
			}
			// 레벨 5는 advanceTech에서 즉시 보상으로 처리됨

			// 4. Tech Track Income: Science
			const sciLevel = player.research.science || 0;
			if (sciLevel < 5) {
				player.knowledge += sciLevel;
				gainedKnowledge += sciLevel;
			}
			// 레벨 5는 advanceTech에서 즉시 보상으로 처리됨

			// 5. Technology Tile Income (덮인 타일은 수입 없음)
			if (player.techTiles.includes('tech-inc-1o-1p') && !isTechTileCovered(player, 'tech-inc-1o-1p')) {
				player.ore += 1;
				incomeItems.push({ type: 'power', amount: 1, id: `tech-1o-1p-${pId}` });
				gainedOre += 1;
				gainedPowerCharge += 1;
			}
			if (player.techTiles.includes('tech-inc-4c') && !isTechTileCovered(player, 'tech-inc-4c')) {
				player.credits += 4;
				gainedCredits += 4;
			}
			if (player.techTiles.includes('tech-inc-1k-1c') && !isTechTileCovered(player, 'tech-inc-1k-1c')) {
				player.knowledge += 1;
				player.credits += 1;
				gainedKnowledge += 1;
				gainedCredits += 1;
			}

			// 6. Bonus Tile Income
			if (player.bonusTile) {
				const bonusTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
				if (bonusTile?.income) {
					if (bonusTile.income.ore) { player.ore += bonusTile.income.ore; gainedOre += bonusTile.income.ore; }
					if (bonusTile.income.credits) { player.credits += bonusTile.income.credits; gainedCredits += bonusTile.income.credits; }
					if (bonusTile.income.knowledge) { player.knowledge += bonusTile.income.knowledge; gainedKnowledge += bonusTile.income.knowledge; }
					if (bonusTile.income.qic) grantQicAndTrack(bonusTile.income.qic);
					if (bonusTile.income.power) { incomeItems.push({ type: 'power', amount: bonusTile.income.power, id: `bonus-power-${player.bonusTile}-${pId}` }); gainedPowerCharge += bonusTile.income.power; }
					if (bonusTile.income.powerTokens) { incomeItems.push({ type: 'tokens', amount: bonusTile.income.powerTokens, id: `bonus-tokens-${player.bonusTile}-${pId}` }); gainedPowerTokens += bonusTile.income.powerTokens; }
					log(`[Income] ${player.name} bonus tile (${player.bonusTile}): ${JSON.stringify(bonusTile.income)}`, 'game', undefined, { simulation: (game as any).simulation });
				}
			} else {
				log(`[Income] ${player.name} has NO bonus tile`, 'game', undefined, { simulation: (game as any).simulation });
			}

			// 7. Planetary Institute(의회) 수익 - 종족별 power/tokens/ore/qic
			if (hasPI && faction?.piIncome) {
				const pi = faction.piIncome;
				const piPower = pi.power ?? 0;
				const piTokens = pi.tokens ?? 0;
				if (piPower > 0) {
					incomeItems.push({ type: 'power', amount: piPower, id: `pi-income-power-${pId}` });
					gainedPowerCharge += piPower;
				}
				if (piTokens > 0) {
					incomeItems.push({ type: 'tokens', amount: piTokens, id: `pi-income-tokens-${pId}` });
					gainedPowerTokens += piTokens;
				}
				if (pi.ore) { player.ore += pi.ore; gainedOre += pi.ore; }
				if (pi.qic) grantQicAndTrack(pi.qic);
			}

			// 수익 아이템이 있으면 개별 선택 요청
			// 단, 1개만 있고 파워와 토큰이 섞여있지 않으면 자동 처리
			if (incomeItems.length > 0) {
				// 1개만 있고 파워/토큰이 섞여있지 않으면 자동 처리
				if (incomeItems.length === 1) {
					const item = incomeItems[0];
					if (item.type === 'power') {
						applyPowerIncome(player, item.amount);
					} else {
						player.power1 = (player.power1 || 0) + item.amount;
					}
					log(`[Income] ${player.name} auto-received income: ${item.amount} ${item.type}`, 'game', undefined, { simulation: (game as any).simulation });
				} else {
					// 여러 개이거나 파워/토큰이 섞여있으면 선택 요청
					playersNeedingOrder.push(pId);
					(player as any).pendingIncomeItems = incomeItems;
				}
			} else {
				// 수익 아이템이 없으면 로그만 남기고 계속 진행
				log(`[Income] ${player.name} has no power/token income items`, 'game', undefined, { simulation: (game as any).simulation });
			}

			// Reset used actions
			player.usedTechActions = [];
			player.usedSpecialActions = [];
			player.usedBonusAction = false;
			player.gleensNavBonusActive = false;
			// [버그수정 2026-06-25] Ivits 우주정거장 플래그도 여기(canonical per-round 리셋)서 리셋 — 기존엔 6844(전원패스 분기)에만 있어, 그 경로를 못 타면 플래그가 true로 막혀 봇이 정거장을 못 놓고 여러 라운드 idle 패스(사용자 관찰: R2-4 통째 패스, 도달가능 빈칸 多).
			player.usedIvitsSpaceStationThisRound = false;
			// [버그수정 2026-08-09 사용자] 팅커로이드 라운드 특수타일은 '새로 고를 때 덮어쓰기'만 하고 라운드 전환에
			//   비워지지 않아, 새 라운드가 시작됐는데 아직 안 고른 구간에 지난 라운드 타일이 칩으로 떠 있었다
			//   (usedSpecialActions가 리셋되며 '아직 안 씀' 상태로 보임). → 여기서 비우고, 선택 완료 시 다시 채운다.
			if (player.faction === 'tinkeroids') player.tinkeroidRoundSpecialId = undefined;
			// [버그수정 2026-06-19] 타클론 브레인 스톤(가이아 영역) 복귀는 여기(income loop, 충전 적용 전)서 하면
			// 그릇1으로 돌아온 직후 이 라운드 income 충전이 브레인스톤을 끌어올려버린다(사용자 관찰).
			// 표준 순서(income 충전 → 가이아 단계 토큰 복귀)대로, 가이아포머 토큰 복귀와 같은 위치(income 이후)로 옮김.
			// 아이타: 2그릇 태울 때 보관해 둔 토큰을 1그릇으로 복귀 (이제 gaiaformerPower로 통합 관리되므로 이 부분은 삭제 가능하거나 gaiaformerPower 로직으로 대체됨)
			// 기존 itarsPendingBowl1Tokens 로직 삭제 (아래 가이아 포머 복귀 로직에서 통합 처리됨)

			const afterResources = { ore: player.ore, credits: player.credits, knowledge: player.knowledge, qic: player.qic, power3: player.power3 };
			log(`[Income] ${player.name} AFTER: O:${afterResources.ore} C:${afterResources.credits} K:${afterResources.knowledge} Q:${afterResources.qic} P3:${afterResources.power3}`, 'game', game.id, { simulation: (game as any).simulation });

			// Save round income totals (power/tokens counts are already totals for the round)
			if (!player.roundIncomeTotals) player.roundIncomeTotals = {};
			player.roundIncomeTotals[incomeRound] = {
				ore: gainedOre,
				credits: gainedCredits,
				knowledge: gainedKnowledge,
				qic: gainedQic,
				powerCharge: gainedPowerCharge,
				powerTokens: gainedPowerTokens,
			};
		}
		(game as any).incomePhaseAppliedThisRound = true;
		// 수익 선택이 필요한 플레이어는 턴 순서대로 한 명씩만 대기 (모든 수익 적용 후 선택만 순서대로)
		if (playersNeedingOrder.length > 0) {
			const firstPlayerId = playersNeedingOrder[0];
			const firstPlayer = game.players[firstPlayerId];
			const incomeItems = (firstPlayer as any).pendingIncomeItems || [];
			if (incomeItems.length > 0) {
				game.pendingIncomeOrder = {
					playerId: firstPlayerId,
					incomeItems: [...incomeItems],
					appliedItems: [],
					powerBeforeSnapshots: [],
				};
				log(`[Income] ${firstPlayer.name} needs to select income items: ${incomeItems.length} items`, 'game', undefined, { simulation: (game as any).simulation });
				clampPlayerResources(game); emitGameUpdated(io, game);
				executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
					log(`Bot turn execution error (IncomeInitial): ${err}`, 'error');
				});
				return;
			}
			delete (firstPlayer as any).pendingIncomeItems;
			playersNeedingOrder.shift();
			helperTriggerIncomePhase(io, game); // 다음 대기 플레이어 처리
			return;
		}
	}

	// 수익 단계 모두 완료 (재진입에서 대기자 없음, 또는 첫 진입에서 선택 필요자 없음)

	// [순서 2026-07-27 사용자] 팅커로이드 특수타일 선택을 income 직후 먼저 → 그다음 가이아포머복귀/아이타/테란/액션.
	if (handleTinkeroidRoundSpecial(io, game as ServerGameState)) { clampPlayerResources(game); emitGameUpdated(io, game); return; }

	// 타클론: 가이아 영역의 브레인 스톤을 그릇1로 복귀 (income 충전 이후 = 표준 가이아 단계 타이밍).
	// brainStoneInGaia로 멱등 처리(재진입 시 이미 false면 스킵).
	Object.values(game.players).forEach((p) => {
		if (p.faction === 'taklons' && p.brainStoneInGaia) {
			p.brainStoneInGaia = false;
			p.brainStoneBowl = 1;
			log(`[Gaia] ${p.name} (Taklons): Brain Stone returned to Bowl 1 (after income)`, 'game', undefined, { simulation: (game as any).simulation });
		}
	});

	// 수익 단계가 모두 끝난 후 가이아 포머 파워 토큰 복귀
	// 테란: 기본 능력으로 2그릇으로 복귀. 의회 있으면 추가로 토큰 수만큼 해택 선택.
	// 그 외 종족: 1그릇으로 복귀
	// [버그수정 2026-07-23 사용자 관찰: 아이타 라운드 중 번한 토큰이 가이아영역에서 사라짐] 이 복귀는 라운드당 1회여야
	// 하는데 가드가 없었음 — helperTriggerIncomePhase가 라운드 중(수익 완료·대기자 없음 상태)에 재호출되면 여기까지
	// 흘러와 그 라운드에 새로 번한 gaiaformerPower를 또 쓸어버림(다음 라운드 복귀분이 조기 소진). 라운드당 1회 가드.
	// 이미 이 라운드에 복귀 처리했으면 재진입은 아무것도 안 함(라운드는 이미 진행 중/대기 선택 중이므로 진행은 다른 경로가 담당).
	if ((game as any).gaiaformerReturnDoneThisRound) return;
	(game as any).gaiaformerReturnDoneThisRound = true;
	const terranCouncilQueue: { playerId: string; tokenCount: number }[] = [];
	Object.entries(game.players).forEach(([pId, player]) => {
		if (!player.gaiaformerPower || player.gaiaformerPower <= 0) return;
		const powerToReturn = player.gaiaformerPower;
		const isTerran = player.faction === 'terran';
		const hasPI = game.map.some(t => t.ownerId === pId && t.structure === 'planetary_institute');
		if (isTerran) {
			player.power2 = (player.power2 || 0) + powerToReturn;
			log(`Player ${player.name} (Terran): ${powerToReturn} tokens from Gaiaformer → Bowl 2`, 'game', undefined, { simulation: (game as any).simulation });
			if (hasPI) {
				terranCouncilQueue.push({ playerId: pId, tokenCount: powerToReturn });
			}
		} else if (player.faction === 'itars' && hasPI && powerToReturn >= 4) {
			game.pendingItarsGaiaformerExchange = { playerId: pId, tokensRemaining: powerToReturn };
			player.gaiaformerPower = 0;
			log(`Player ${player.name} (Itars PI): ${powerToReturn} tokens in Gaiaformer → exchange or Bowl 1 choice`, 'game', undefined, { simulation: (game as any).simulation });
			executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
				log(`Bot turn execution error (ItarsInitial): ${err}`, 'error');
			});
			return;
		} else {
			player.power1 = (player.power1 || 0) + powerToReturn;
			log(`Player ${player.name} returned ${powerToReturn} power tokens from Gaiaformer area to Bowl 1`, 'game', undefined, { simulation: (game as any).simulation });
		}
		player.gaiaformerPower = 0;
	});

	if (game.pendingItarsGaiaformerExchange) {
		game.terranCouncilQueueAfterItars = terranCouncilQueue.length > 0 ? terranCouncilQueue : undefined;
		clampPlayerResources(game); emitGameUpdated(io, game);
		return;
	}

	if (terranCouncilQueue.length > 0) {
		game.pendingTerranCouncilBenefit = terranCouncilQueue[0];
		game.terranCouncilQueue = terranCouncilQueue.slice(1);
		clampPlayerResources(game); emitGameUpdated(io, game);
		executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
			log(`Bot turn execution error (TerranInitial): ${err}`, 'error');
		});
		return;
	}

	clampPlayerResources(game); emitGameUpdated(io, game);
	helperStartNewRoundTurn(io, game);
}

// [버그수정 2026-07-27 사용자] 아이타 교환 잔여 토큰 증발 방지 안전망: 여러 완료경로(우주선-mine defer·force-skip·엣지)
//   중 하나라도 itarsGaiaformerRemainingAfterTech를 소비 못 하면 그릇1로 복구가 누락돼 증발. 액션단계 시작 직전 무조건 복구.
//   교환이 아직 진행 중(pending/resume)이면 건드리지 않음.
function flushLeftoverItarsTokens(io: SocketIOServer, game: GaiaGameState) {
	const rem = (game as any).itarsGaiaformerRemainingAfterTech ?? 0;
	if (rem <= 0) return;
	if ((game as any).pendingItarsGaiaformerExchange) return;
	if ((game as any).pendingTechTileSelection?.structureType === 'itars_pi_exchange') return;
	if ((game as any).itarsExchangeResumeAfterShipMine) return;
	const itarsId = Object.keys(game.players).find(pid => game.players[pid].faction === 'itars');
	(game as any).itarsGaiaformerRemainingAfterTech = undefined;
	if (!itarsId) return;
	const p = game.players[itarsId];
	p.power1 = (p.power1 || 0) + rem;
	addGameLog(game, itarsId, 'Itars PI', `${rem} tokens → Bowl 1 (안전복구)`);
	log(`[ITARS-CHAIN][SAFETY] leftover ${rem} tokens flushed to Bowl 1 (round ${game.roundNumber})`, 'game', game.id);
}

export function helperStartNewRoundTurn(io: SocketIOServer, game: GaiaGameState) {
	// [순서 2026-08-05 사용자] 아이타 교환으로 받은 2TF+무료광산이 아직 미해소면 액션 단계(1턴)를 시작하지 않는다.
	//   "건설까지 다 하고 1턴이 시작"이 되도록 보류 — 광산+트랙이 끝나면 resumeItarsExchangeChain이 여기를 다시 부른다.
	//   탈출구: 지을 곳이 없으면 skip_ship_tech_mine('배치 포기')로 pending을 비우고 체인을 재개할 수 있다.
	if ((game as any).itarsExchangeResumeAfterShipMine) {
		log(`[ITARS-ORDER] action phase deferred: 2TF+Mine unresolved (round ${game.roundNumber})`, 'game', game.id, { simulation: (game as any).simulation });
		clampPlayerResources(game as ServerGameState); emitGameUpdated(io, game);
		executeBotTurnIfNeeded(io, game as ServerGameState).catch(() => { /* 봇이면 스스로 해소 */ });
		return;
	}
	flushLeftoverItarsTokens(io, game);
	// [버그수정] 수입 단계가 아직 안 끝났는데 액션 단계를 시작하면, 뒤 순번 플레이어(예: 네뷸라)의 수입 팝업이
	// 영영 안 뜨고 파워를 못 받는다(사용자 관찰: 마지막 라운드 네뷸라 파워 미수령). ①팝업 활성 중이면 시작 보류
	// (완료 후 체인이 다시 부름) ②팝업은 없는데 미처리 수입 플레이어가 남았으면(체인 끊김) 수입 체인을 이어 복구.
	if (game.pendingIncomeOrder) {
		log(`[INCOME-GUARD] action phase deferred: income popup active for ${game.pendingIncomeOrder.playerId} (round ${game.roundNumber})`, 'game', game.id);
		return;
	}
	const stragglerIncome = (game.turnOrder ?? []).find(id => (((game.players[id] as any)?.pendingIncomeItems?.length) ?? 0) > 0);
	if (stragglerIncome) {
		log(`[INCOME-GUARD] action phase deferred: ${stragglerIncome} still has unshown income items — resuming income chain (round ${game.roundNumber})`, 'game', game.id);
		helperTriggerIncomePhase(io, game);
		return;
	}
	// [버그수정 2026-06-19] 라운드당 액션단계는 한 번만 시작. 여러 경로(수익선택완료·Itars교환·Terran의회·tinkeroid)가
	// 라운드시작을 중복 호출하면 index가 0으로 재리셋돼 시작 플레이어가 연속 2턴 하던 문제(사용자 관찰, Itars게임 4회).
	if ((game as any).actionPhaseStartedRound === game.roundNumber) return;
	// [버그수정] 이미 이번 라운드에 턴이 진행됐으면(시작 플레이어가 한 번 둠) index=0 재리셋 금지 — 늦은/중복
	// 라운드시작 호출이 시작 플레이어를 연속 2턴 시키던 버그. actionPhaseStartedRound가 우회된 경로도 이걸로 차단.
	if ((game as any).firstMainActionDoneThisRound) {
		log(`[ROUND-START-GUARD] helperStartNewRoundTurn blocked: round ${game.roundNumber} already had a turn (index stays ${game.currentPlayerIndex})`, 'game', game.id);
		(game as any).actionPhaseStartedRound = game.roundNumber;
		return;
	}
	(game as any).actionPhaseStartedRound = game.roundNumber;
	// 수익 단계 종료 → 액션 단계는 항상 턴 순서 1번(선 플레이어)부터
	game.currentPlayerIndex = 0;
	// 첫 플레이어가 패스한 상태면 다음 플레이어로 (실제로는 라운드 초기에는 없을 수 있지만 방어적 코드)
	while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed && Object.values(game.players).some(p => !p.hasPassed)) {
		game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
	}

	const currentId = game.turnOrder[game.currentPlayerIndex];
	if (currentId) {
		captureTurnStartWithPrev(game as ServerGameState, currentId);
	}
	clampPlayerResources(game as ServerGameState); emitGameUpdated(io, game);

	log(`[RoundStart] New round ${game.roundNumber} action phase starts. First player: ${currentId}`, 'game', undefined, { simulation: (game as any).simulation });

	// [분석] 라운드별 빌드 페이스 스냅샷 (봇 약점 진단용). AI_PACE_LOG=1 일 때만.
	if (process.env.AI_PACE_LOG === '1') {
		for (const pid of game.turnOrder) {
			const p = game.players[pid]; if (!p) continue;
			const st = (game.map as HexTile[]).filter(t => t.ownerId === pid && t.structure && t.structure !== 'ship');
			const c: Record<string, number> = {};
			for (const t of st) c[t.structure!] = (c[t.structure!] || 0) + 1;
			const r = p.research || {};
			const rs = (['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'] as const).map(k => (r[k] ?? 0)).join('');
			const feds = ((p as any).federations?.length ?? 0);
			// [우주선 진단] 탑승 척수 / 실제 사용한 액션 수 (66% 미사용 문제 추적)
			const shEntered = (p.spaceshipsEntered ?? []);
			let shUsed = 0; for (const sid of shEntered) shUsed += ((game as any).spaceships?.[sid]?.usedActionIndices?.length ?? 0);
			const shTag = ` sh${shEntered.length}/u${shUsed}`;
			// [연방 진단] 연방이 (a)총파워부족 (b)파워충분하나 분산(위성필요) (c)이미형성가능 중 어느 상태인지 구분
			let fedProbe = '';
			try {
				const g = game as any;
				const req = getFederationRequiredPower(g, pid);
				const fedHexes = game.playerFederationHexes?.[pid] || [];
				const freeStructs = st.filter(t => !fedHexes.includes(t.id));
				const allIds = new Set(freeStructs.map(t => t.id));
				const totalPow = getFederationBuildingPower(g, pid, allIds);
				let maxComp = 0; const seenComp = new Set<string>();
				for (const t of freeStructs) {
					if (seenComp.has(t.id)) continue;
					const comp = getPlanetConnectedComponent(g, pid, t.id);
					comp.forEach((id: string) => seenComp.add(id));
					const cp = getFederationBuildingPower(g, pid, new Set(comp));
					if (cp > maxComp) maxComp = cp;
				}
				const tok = p.faction === 'ivits' ? (p.qic ?? 0) : ((p.power1 ?? 0) + (p.power2 ?? 0) + (p.power3 ?? 0));
				const stateTag = totalPow < req ? 'LOW_POWER' : (maxComp >= req ? 'FORMABLE' : 'SCATTERED');
				fedProbe = ` | FED[${stateTag} req${req} tot${totalPow} maxC${maxComp} tok${tok}]`;
			} catch { /* 진단 실패 무시 */ }
			log(`[PACE r${game.roundNumber}] ${p.faction}: VP${p.score} | struct${st.length}(m${c.mine ?? 0}/ts${c.trading_station ?? 0}/lab${c.research_lab ?? 0}/pi${c.planetary_institute ?? 0}/ac${c.academy ?? 0}) | res${rs} | fed${feds} | O${p.ore}C${p.credits}K${p.knowledge}Q${p.qic} P${(p.power1 ?? 0)}/${(p.power2 ?? 0)}/${(p.power3 ?? 0)}${shTag}${fedProbe}`, 'game', game.id, { simulation: (game as any).simulation });
		}
	}

	// 첫 플레이어가 봇이면 바로 봇 턴 시작
	executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
		log(`Bot turn execution error (StartNewRoundTurn): ${err}`, 'error');
	});
}

/** Itars PI 교환 체인 재개: 남은 가이아 토큰이 4+면 다음 교환 창, 아니면 그릇1 복귀 후 액션단계 진행.
 *  (기술타일 선택 후·또는 2TF+광산 타일의 광산·트랙 완료 후 호출) */
export function resumeItarsExchangeChain(io: SocketIOServer, game: GaiaGameState, playerId: string, remaining: number) {
	const player = game.players[playerId];
	game.itarsGaiaformerRemainingAfterTech = undefined;
	if (remaining >= 4) {
		game.pendingItarsGaiaformerExchange = { playerId, tokensRemaining: remaining };
	} else {
		if (player) player.power1 = (player.power1 || 0) + remaining;
		if (remaining > 0) addGameLog(game, playerId, 'Itars PI', `${remaining} tokens → Bowl 1`);
		try {
			helperProceedAfterItarsGaiaformerOrTerran(io, game);
		} catch (e) {
			log(`[ITARS-CHAIN] resume helperProceed EXCEPTION: ${(e as Error)?.stack || e}`, 'error', game.id);
			executeBotTurnIfNeeded(io, game as ServerGameState).catch(() => { /* 위에서 로깅됨 */ });
		}
	}
	clampPlayerResources(game); emitGameUpdated(io, game);
}

// [버그수정+순서 2026-07-27 사용자] 팅커로이드 라운드 특수선택을 income 완료 직후 "먼저" 처리(아이타/테란보다 앞).
//   라운드당 1회 가드. 반환: human/bot 선택 대기 설정됐으면 true(호출측은 return하고 선택 완료 후 helperTriggerIncomePhase 재호출로 이어짐).
function handleTinkeroidRoundSpecial(io: SocketIOServer, game: ServerGameState): boolean {
	if ((game as any).tinkeroidSpecialHandledRound === game.roundNumber) return !!game.pendingTinkeroidSpecialChoice;
	const tinkeroidPlayerId = Object.keys(game.players).find(pid => game.players[pid].faction === 'tinkeroids');
	if (!tinkeroidPlayerId) { (game as any).tinkeroidSpecialHandledRound = game.roundNumber; return false; }
	const tinkeroidPlayer = game.players[tinkeroidPlayerId];
	const chosen = tinkeroidPlayer.tinkeroidsChosenSpecialIds ?? [];
	const round13 = ['tinkeroid-1tf-mine', 'tinkeroid-1qic', 'tinkeroid-4power'];
	const round46 = ['tinkeroid-3k', 'tinkeroid-2qic', 'tinkeroid-3tf-mine'];
	const pool = game.roundNumber >= 1 && game.roundNumber <= 3 ? round13 : round46;
	const options = pool.filter((id: string) => !chosen.includes(id));
	(game as any).tinkeroidSpecialHandledRound = game.roundNumber;
	if (options.length === 1) {
		tinkeroidPlayer.tinkeroidRoundSpecialId = options[0];
		tinkeroidPlayer.tinkeroidsChosenSpecialIds = [...chosen, options[0]];
		log(`Tinkeroid: round ${game.roundNumber} special auto-selected: ${options[0]}`, 'game', undefined, { simulation: (game as any).simulation });
		return false;
	} else if (options.length > 1) {
		game.pendingTinkeroidSpecialChoice = { playerId: tinkeroidPlayerId, round: game.roundNumber, options };
		executeBotTurnIfNeeded(io, game).catch(err => log(`Bot turn execution error (TinkeroidChoice): ${err}`, 'error'));
		return true;
	}
	return false;
}

export function helperProceedAfterItarsGaiaformerOrTerran(io: SocketIOServer, game: GaiaGameState) {
	// [순서 2026-08-05] helperStartNewRoundTurn과 동일 보험 — 2TF+무료광산 미해소 상태로 액션 단계가 시작되지 않게.
	//   (정상 흐름은 트랙 전진에서 플래그를 소비한 뒤 여기 오므로 이 가드에 걸리지 않는다.)
	if ((game as any).itarsExchangeResumeAfterShipMine) {
		log(`[ITARS-ORDER] action phase deferred(Itars path): 2TF+Mine unresolved (round ${game.roundNumber})`, 'game', game.id, { simulation: (game as any).simulation });
		clampPlayerResources(game as ServerGameState); emitGameUpdated(io, game);
		return;
	}
	flushLeftoverItarsTokens(io, game);
	const terranQueue = game.terranCouncilQueueAfterItars;
	game.terranCouncilQueueAfterItars = undefined;
	if (terranQueue && terranQueue.length > 0) {
		game.pendingTerranCouncilBenefit = terranQueue[0];
		game.terranCouncilQueue = terranQueue.slice(1);
		clampPlayerResources(game as ServerGameState); emitGameUpdated(io, game);
		// 봇 보상 선택 처리
		executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
			log(`Bot turn execution error (ProceedAfterItarsTerranBenefit): ${err}`, 'error');
		});
		return;
	}
	// [버그수정] 수입 미완료 상태에서 액션 단계 시작 금지 — 뒤 순번 수입 스킵(네뷸라 파워 미수령) 방지. (helperStartNewRoundTurn과 동일)
	if (game.pendingIncomeOrder) {
		log(`[INCOME-GUARD] action phase deferred(Itars path): income popup active for ${game.pendingIncomeOrder.playerId} (round ${game.roundNumber})`, 'game', game.id);
		return;
	}
	const stragglerIncome2 = (game.turnOrder ?? []).find(id => (((game.players[id] as any)?.pendingIncomeItems?.length) ?? 0) > 0);
	if (stragglerIncome2) {
		log(`[INCOME-GUARD] action phase deferred(Itars path): ${stragglerIncome2} unshown income — resuming income chain (round ${game.roundNumber})`, 'game', game.id);
		helperTriggerIncomePhase(io, game);
		return;
	}
	// [버그수정 2026-06-19] 라운드당 액션단계 1회만 시작(helperStartNewRoundTurn과 동일 가드) — 중복 시작 시 시작플레이어 더블턴 방지.
	// [hang수정 2026-07-07] 단 bare return은 아무도 턴을 재개하지 않아 게임 정지(사용자: 아이타 교환 후 멈춤 관측).
	// 액션 단계가 이미 시작된 상태라도 현재 턴 재개(emit + 봇 트리거)는 하고 나간다 — 둘 다 멱등이라 안전.
	if ((game as any).actionPhaseStartedRound === game.roundNumber) {
		log(`[ITARS-RESUME] round ${game.roundNumber} action phase already started — resuming current turn (index ${game.currentPlayerIndex})`, 'game', game.id);
		clampPlayerResources(game as ServerGameState); emitGameUpdated(io, game);
		executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
			log(`Bot turn execution error (ItarsResumeStarted): ${err}`, 'error');
		});
		return;
	}
	// [버그수정] 위와 동일 — 이미 턴이 진행된 라운드면 index=0 재리셋 금지(시작플레이어 더블턴 방지).
	if ((game as any).firstMainActionDoneThisRound) {
		log(`[ROUND-START-GUARD] helperProceedAfterItars blocked: round ${game.roundNumber} already had a turn (index stays ${game.currentPlayerIndex})`, 'game', game.id);
		(game as any).actionPhaseStartedRound = game.roundNumber;
		clampPlayerResources(game as ServerGameState); emitGameUpdated(io, game);
		executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
			log(`Bot turn execution error (ItarsResumeMidRound): ${err}`, 'error');
		});
		return;
	}
	(game as any).actionPhaseStartedRound = game.roundNumber;
	game.currentPlayerIndex = 0;
	// 첫 플레이어가 패스한 상태면 다음 플레이어로
	while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed && Object.values(game.players).some(p => !p.hasPassed)) {
		game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
	}

	const currentId = game.turnOrder[game.currentPlayerIndex];
	if (currentId) {
		captureTurnStartWithPrev(game as ServerGameState, currentId);
	}
	// [가시화 2026-07-07] 아이타 경로 라운드 시작은 로그가 전무해 hang 원인 특정 불가였음 — RoundStart와 동급 로그
	log(`[RoundStart] (Itars/Terran path) round ${game.roundNumber} action phase starts. First player: ${currentId}`, 'game', game.id, { simulation: (game as any).simulation });
	clampPlayerResources(game as ServerGameState); emitGameUpdated(io, game);

	// 봇 턴 확인
	executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
		log(`Bot turn execution error (ProceedAfterItarsTerranEnd): ${err}`, 'error');
	});
}

export function helperFinishAfterGaiaformerPhase(io: SocketIOServer, game: GaiaGameState) {
	const currentId = game.turnOrder[game.currentPlayerIndex];
	if (currentId) {
		captureTurnStartWithPrev(game as ServerGameState, currentId);
	}
	clampPlayerResources(game);
	emitGameUpdated(io, game);

	// 가이아 단계 종료 후 봇 턴 확인
	executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
		log(`Bot turn execution error (FinishAfterGaiaformerPhase): ${err}`, 'error');
	});
}

export function setupGameServer(httpServer: HTTPServer) {
	const io = new SocketIOServer(httpServer, {
		cors: { origin: '*', methods: ['GET', 'POST'] },
		path: '/socket.io',
		// [대역폭 2026-07-27, 사용자: Render 월 5GB 쿼터] WebSocket 압축 — 게임 상태 JSON은 반복 키가 많아
		// ~25KB → ~6-8KB (3-4배 절감). 1KB 미만 소형 메시지는 압축 오버헤드가 손해라 임계값으로 제외.
		perMessageDeflate: { threshold: 1024 },
	});

	io.on('connection', (socket) => {
		log(`Player connected: ${socket.id}`, 'socket.io');

		// [배포 반영 2026-08-09, 사용자] 배포하면 서버가 재시작 → 모든 클라가 재접속한다. 그 순간이
		//   "네 번들 최신이니?"를 물어볼 가장 확실한 타이밍. 클라는 자기 __BUILD_ID__와 비교해 배너를 띄운다.
		socket.emit('server_build', { buildId: getClientBuildId() });

		/**
		 * (Dev/Tuning) AI Evaluator 가중치 런타임 변경.
		 * - 기본은 개발용: 토큰 없으면 NODE_ENV=production 에서 거부
		 * - 토큰을 쓰고 싶으면 서버 env에 AI_TUNING_TOKEN 을 설정하고, 요청에 token을 포함
		 */
		socket.on('admin_set_ai_weights', ({ weights, token }, callback) => {
			try {
				const requiredToken = process.env.AI_TUNING_TOKEN;
				const isProd = process.env.NODE_ENV === 'production';
				if (isProd && !requiredToken) {
					callback?.({ error: 'Not allowed in production without AI_TUNING_TOKEN' });
					return;
				}
				if (requiredToken && token !== requiredToken) {
					callback?.({ error: 'Invalid token' });
					return;
				}

				const next = setActiveEvaluatorWeights(weights as Partial<EvaluatorWeights>);
				callback?.({ ok: true, weights: next });
			} catch (e) {
				callback?.({ error: (e as Error).message });
			}
		});

		socket.on('admin_get_ai_weights', (_payload, callback) => {
			callback?.({ ok: true, weights: getActiveEvaluatorWeights() });
		});

		/** tune-ai에서 MCTS 생각 시간(ms) 런타임 변경. timeMs가 null이면 환경변수/기본값으로 복원 */
		socket.on('admin_set_mcts_time_ms', ({ timeMs, token }, callback) => {
			try {
				const requiredToken = process.env.AI_TUNING_TOKEN;
				const isProd = process.env.NODE_ENV === 'production';
				if (isProd && !requiredToken) {
					callback?.({ error: 'Not allowed in production without AI_TUNING_TOKEN' });
					return;
				}
				if (requiredToken && token !== requiredToken) {
					callback?.({ error: 'Invalid token' });
					return;
				}
				MCTS.setTimeMsOverride(typeof timeMs === 'number' && timeMs > 0 ? timeMs : null);
				callback?.({ ok: true });
			} catch (e) {
				callback?.({ error: (e as Error).message });
			}
		});

		/** 하니스(self-play/head-to-head)에서 봇 턴 사이 지연(ms) 런타임 변경. null이면 기본값 복원 */
		socket.on('admin_set_bot_delay_ms', ({ delayMs, token }, callback) => {
			try {
				const requiredToken = process.env.AI_TUNING_TOKEN;
				const isProd = process.env.NODE_ENV === 'production';
				if (isProd && !requiredToken) {
					callback?.({ error: 'Not allowed in production without AI_TUNING_TOKEN' });
					return;
				}
				if (requiredToken && token !== requiredToken) {
					callback?.({ error: 'Invalid token' });
					return;
				}
				setBotDelayMs(typeof delayMs === 'number' && delayMs >= 0 ? delayMs : null);
				callback?.({ ok: true });
			} catch (e) {
				callback?.({ error: (e as Error).message });
			}
		});

		socket.on('list_games', (callback) => {
			const gameList = Array.from(games.values()).map(g => {
				const playerEntries = Object.entries(g.players).map(([id, p]) => ({
					id,
					name: p.name || id,
					isHost: id === g.hostId,
				}));
				return {
					id: g.id,
					playerCount: playerEntries.length,
					maxPlayers: g.maxPlayers,
					phase: g.currentPhase,
					roundNumber: g.roundNumber ?? 0,
					botCount: g.botPlayerIds?.length ?? 0,
					createdAt: g.createdAt ?? 0,
					players: playerEntries,
					hostName: g.players[g.hostId]?.name ?? null,
				};
			});
			gameList.sort((a, b) => {
				const aLobby = a.phase === 'lobby' ? 0 : 1;
				const bLobby = b.phase === 'lobby' ? 0 : 1;
				if (aLobby !== bLobby) return aLobby - bLobby;
				return (b.createdAt ?? 0) - (a.createdAt ?? 0);
			});
			callback({ games: gameList });
		});

		socket.on('create_game', ({ playerName, password }, callback) => {
			const gameId = generateGameId();
			const playerId = generatePlayerId();
			// [방 한정 좌석 비번(선택)] 방장 좌석도 다른 기기 이어하기 지원
			if (password) setSeatPassword(gameId, playerId, playerName, password);

			// Shuffle bonus tiles
			const shuffledBonusTiles = [...ALL_BONUS_TILES].sort(() => Math.random() - 0.5);

			const game: ServerGameState = {
				id: gameId,
				hostId: playerId,
				players: { [playerId]: createInitialPlayerState(playerName) },
				map: generateMap(),
				currentPhase: 'lobby',
				roundNumber: 0,
				currentPlayerIndex: 0,
				turnOrder: [playerId],
				hostAddedPlayerIds: [],
				maxPlayers: 4,
				createdAt: Date.now(),
				isTestMode: false,
				aiBotsAllowed: AI_BOTS_ENABLED, // [사용자] 이 서버가 AI 봇 추가/Auto Setup을 허용하는지 (env AI_BOTS_ENABLED)
				hasDoneMainAction: false,
				powerActions: JSON.parse(JSON.stringify(INITIAL_POWER_ACTIONS)),
				availableBonusTiles: shuffledBonusTiles.slice(0, 7), // Players + 3 extra (will adjust when game starts)
				roundScoringTiles: Array(6).fill(null).map(() => ({ id: '', label: '', condition: '', vp: 0 })), // 임시 초기화
				usedRoundMissions: [], // 사용된 라운드 미션 추적
				finalScoringTiles: [
					{ id: 'fs1', label: 'Final 1', condition: 'Satellites', vp: 0 },
					{ id: 'fs2', label: 'Final 2', condition: 'Structures', vp: 0 },
				],
				techTilesByTrack: {},
				advancedTechTilesByTrack: {},
				techTilesPool: [],
				passingOrder: [],
				pendingBonusSelection: null,
				nextRoundBonusTiles: {},
				pendingTechTileSelection: null,
				gameLog: [],
				economyVariant: Math.random() < 0.5 ? 'power' : 'vp', // 랜덤으로 경제 트랙 변형 선택
				useFactionBidding: true, // [사용자] 기본 체크
				friendlyMatch: false, // [사용자] 친선전(기록 사이트 미저장) — 방 전체 표시, 호스트 토글
			};

			// Randomize Standard Tech Tiles (9종류를 6트랙 + 3풀에 무작위 배정, 각 4개씩 스택)
			const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
			const allStandardTiles = [...ALL_TECH_TILES].sort(() => Math.random() - 0.5);

			// 6개는 트랙에 배정
			tracks.forEach((track, i) => {
				const tileType = allStandardTiles[i];
				game.techTilesByTrack[track] = Array(4).fill(null).map(() => ({ ...tileType }));
			});

			// 남은 3개는 풀에 배정
			game.techTilesPool = [];
			[6, 7, 8].forEach(idx => {
				const tileType = allStandardTiles[idx];
				// 4개씩 담기 위해 다차원 배열이나 평탄화된 배열 고민 필요하지만, 기존 getFirstTrackTile이 배열에서 첫 t를 찾는 로직임
				// techTilesPool은 (TechTile | null)[] 타입이므로 4개씩 밀어넣으면 UI에서 어떻게 보일지 확인 필요
				// 기존 UI는 Pool 3개를 개별 슬롯으로 그림. 여기서는 3종류를 각각 4개씩 스택으로 관리해야 함.
				// 하지만 기존 techTilesPool 정의가 (TechTile | null)[] 임. 
				// 규칙상 풀 타일 3종류도 각각 4개씩이므로, 3 * 4 = 12개의 요소를 넣거나 로직 수정 필요.
				// 현재 ResearchBoard.tsx:146 에서는 game.techTilesPool?.map(tile, idx)로 그림.
				// 12개를 넣으면 칸이 너무 많아짐. 3개 타입만 보여주고 수량을 표시하거나 내부적으로만 4개인 것이 좋음.
				// 일단 UI 호환성을 위해 4개씩 채우되 렌더링은 getFirstTechTilePool 처럼 첫 번째 것만 보여주도록 클라이언트 수정 혹은 서버에서 3개만 유지하고 count 관리.
				// 하지만 기존 techTilesByTrack은 (TechTile | null)[]로 4개를 다 들고 있음. 
				// Pool도 동일하게 3종류 * 4개 = 12개로 구성하고 클라이언트에서 중복 제거해서 그리거나, 3개만 넣고 소유권 체크로 퉁칠 수도 있으나
				// '4개씩 있고 유저별로 1번씩' 이라면 4개 데이터가 살아있는게 안전함.
				for (let k = 0; k < 4; k++) {
					game.techTilesPool.push({ ...tileType });
				}
			});



			// Randomize Advanced Tech Tiles (7개: 6개는 트랙 4–5 사이, 1개는 하단 풀 오른쪽 슬롯)
			const shuffledAdvanced = [...ALL_ADVANCED_TECH_TILES].sort(() => Math.random() - 0.5);
			tracks.forEach((track, i) => {
				game.advancedTechTilesByTrack[track] = shuffledAdvanced[i];
			});
			game.extraAdvancedTechTile = shuffledAdvanced[6];
			game.extraAdvancedTechCondition = Math.random() < 0.5 ? '25vp' : '3ships';

			// 게임 시작 시 모든 라운드 미션을 미리 랜덤 선택
			initializeRoundMissions(game);

			// 최종미션: 9개 중 2개 랜덤 선택
			const shuffledFinal = [...FINAL_MISSION_IDS].sort(() => Math.random() - 0.5);
			game.finalMissionIds = shuffledFinal.slice(0, 2);

			// 우주선 타일별 상태 초기화
			game.spaceships = {};
			for (const tile of game.map) {
				if (tile.type === 'ship_twilight' || tile.type === 'ship_rebellion' || tile.type === 'ship_tf_mars' || tile.type === 'ship_eclipse') {
					game.spaceships[tile.id] = { unlocked: false, occupants: [], usedActionIndices: [] };
				}
			}
			// 우주선 전용 기술 타일 3개를 3종 우주선에 매 게임 랜덤 배정
			const shipTechIds = SHIP_TECH_TILES.map(t => t.id);
			const shuffledShipTech = [...shipTechIds].sort(() => Math.random() - 0.5);
			game.shipTechByShip = {
				ship_rebellion: shuffledShipTech[0],
				ship_tf_mars: shuffledShipTech[1],
				ship_eclipse: shuffledShipTech[2],
			};
			// 우주선 전용 기술 타일 풀 수량 초기화 (각 4개)
			game.shipTechPool = {
				[shuffledShipTech[0]]: 4,
				[shuffledShipTech[1]]: 4,
				[shuffledShipTech[2]]: 4,
			};

			// 트왈라잇 인공물: 13종 중 4개 랜덤 배치
			const allArtifactIds = ARTIFACTS.map(a => a.id);
			const shuffledArtifacts = [...allArtifactIds].sort(() => Math.random() - 0.5);
			game.twilightArtifactSlots = shuffledArtifacts.slice(0, 4);

			// 연방 풀: 6종류 각 3개. 테라포밍 5단계에 랜덤 1종 배치 → 그 종은 풀에서 1개 차감(2개 남음)
			game.federationPool = {};
			FEDERATION_REWARDS.forEach(r => { game.federationPool![r.id] = 3; });
			const shuffledFed = [...FEDERATION_REWARDS].sort(() => Math.random() - 0.5);
			game.federationOnTerraforming5 = shuffledFed[0].id;
			game.federationPool![shuffledFed[0].id] -= 1;
			const shuffledShipFed = [...SPACESHIP_FEDERATION_REWARDS].sort(() => Math.random() - 0.5);
			const shipTypes = ['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'];
			game.spaceshipFederationByShip = {};
			shipTypes.forEach((shipType, i) => { game.spaceshipFederationByShip![shipType] = shuffledShipFed[i].id; });
			game.satellites = {};

			hideHeavyServerFields(game);
			games.set(gameId, game);
			game.hostSocketId = socket.id;
			playerGameMap.set(playerId, gameId);
			socketToPlayerMap.set(socket.id, playerId);
			joinGameRoom(socket, gameId);

			log(`Game created: ${gameId} by ${playerName}`, 'game', undefined, { simulation: (game as any).simulation });
			callback({ gameId, playerId, game });
		});

		socket.on('join_game', ({ gameId, playerName, password }, callback) => {
			const game = games.get(gameId);
			if (!game || Object.keys(game.players).length >= game.maxPlayers || game.currentPhase !== 'lobby') {
				callback({ error: 'Cannot join game' }); return;
			}
			const playerId = generatePlayerId();
			game.players[playerId] = createInitialPlayerState(playerName);
			game.turnOrder.push(playerId);
			playerGameMap.set(playerId, gameId);
			socketToPlayerMap.set(socket.id, playerId);
			// [방 한정 좌석 비번(선택)] 걸어두면 다른 기기에서 같은 방 + 같은 이름/비번으로 이 좌석에 복귀 가능
			if (password) setSeatPassword(gameId, playerId, playerName, password);
			joinGameRoom(socket, gameId);
			clampPlayerResources(game); emitGameUpdated(io, game);
			callback({ gameId, playerId, game });
		});

		/** [사용자 2026-07-31] 로비 단계에서 Leave하면 좌석을 실제로 제거 — 그동안 서버 핸들러가 없어
		 *  좌석이 남았고, 다시 Join하면 같은 사람이 2명이 되던 문제. 진행 중 게임은 좌석 유지(재접속 모델). */
		socket.on('leave_game', ({ gameId }: { gameId: string }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId || !game.players[playerId]) return;
			if (game.currentPhase !== 'lobby') return;
			delete game.players[playerId];
			game.turnOrder = game.turnOrder.filter(id => id !== playerId);
			if (game.hostAddedPlayerIds) game.hostAddedPlayerIds = game.hostAddedPlayerIds.filter(id => id !== playerId);
			playerGameMap.delete(playerId);
			socketToPlayerMap.delete(socket.id);
			socket.leave(gameId);
			const bots = new Set(game.botPlayerIds || []);
			const humans = Object.keys(game.players).filter(id => !bots.has(id));
			if (humans.length === 0) {
				// 사람이 아무도 안 남으면(봇만 남거나 빈 방) 방 자체를 정리
				io.to(gameId).emit('game_deleted', { gameId });
				games.delete(gameId);
				turnHistories.delete(gameId);
				rollbackCounts.delete(gameId);
				log(`Game ${gameId} deleted (last human left lobby)`, 'game', gameId);
				return;
			}
			if (game.hostId === playerId) {
				// 방장이 나가면 남은 사람(직접 접속 좌석 우선)에게 방장 이관
				const hostAdded = new Set(game.hostAddedPlayerIds || []);
				game.hostId = humans.find(id => !hostAdded.has(id)) ?? humans[0];
			}
			log(`Player ${playerId} left lobby of game ${gameId}`, 'game', gameId);
			emitGameUpdated(io, game);
		});

		/** 다른 기기에서 이름/비번으로 좌석 복귀 (방 한정 일회용 비번) — playerId를 돌려주면
		 *  클라이언트가 localStorage에 심고 rejoin_game으로 정상 재접속. */
		socket.on('account_rejoin', ({ gameId, playerName, password }, callback) => {
			const game = games.get(gameId);
			if (!game) { callback({ error: '게임을 찾을 수 없습니다.' }); return; }
			if (!password) { callback({ error: '비밀번호를 입력하세요.' }); return; }
			const seatId = findSeatByPassword(gameId, playerName, password);
			if (!seatId || !game.players[seatId]) { callback({ error: '이름/비밀번호가 맞는 자리가 없습니다 (참가할 때 비밀번호를 걸었어야 합니다).' }); return; }
			callback({ gameId, playerId: seatId, playerName: game.players[seatId].name });
		});

		/** 방장 전용: 플레이어 슬롯 추가 (한 컴퓨터에서 교대로 조작하는 4인플용) */
		socket.on('host_add_player', ({ gameId, playerName }, callback) => {
			const game = games.get(gameId);
			if (!game) { callback({ error: 'Game not found' }); return; }
			const callerId = socketToPlayerMap.get(socket.id);
			if (callerId !== game.hostId) { callback({ error: 'Only host can add players' }); return; }
			if (game.currentPhase !== 'lobby') { callback({ error: 'Can only add players in lobby' }); return; }
			if (Object.keys(game.players).length >= game.maxPlayers) { callback({ error: 'Max players reached' }); return; }
			const newPlayerId = generatePlayerId();
			const name = playerName || `Player ${Object.keys(game.players).length + 1}`;
			game.players[newPlayerId] = createInitialPlayerState(name);
			game.turnOrder.push(newPlayerId);
			if (!game.hostAddedPlayerIds) game.hostAddedPlayerIds = [];
			game.hostAddedPlayerIds.push(newPlayerId);
			clampPlayerResources(game);
			emitGameUpdated(io, game);
			callback({ playerId: newPlayerId, name, game });
		});

		/** 방장 전용: AI 봇 플레이어 추가 */
		socket.on('host_add_bot', ({ gameId, botName }, callback) => {
			const game = games.get(gameId);
			if (!game) { callback({ error: 'Game not found' }); return; }
			const callerId = socketToPlayerMap.get(socket.id);
			if (!AI_BOTS_ENABLED) { callback({ error: '이 서버에서는 AI 봇을 추가할 수 없습니다.' }); return; }
				if (callerId !== game.hostId) { callback({ error: 'Only host can add bots' }); return; }
			if (game.currentPhase !== 'lobby') { callback({ error: 'Can only add bots in lobby' }); return; }
			if (Object.keys(game.players).length >= game.maxPlayers) { callback({ error: 'Max players reached' }); return; }

			const botId = `bot-${generatePlayerId()}`;
			const name = botName || `AI Bot ${Object.keys(game.players).length + 1}`;

			game.players[botId] = createInitialPlayerState(name);
			game.turnOrder.push(botId);

			if (!game.botPlayerIds) game.botPlayerIds = [];
			game.botPlayerIds.push(botId);

			if (!game.hostAddedPlayerIds) game.hostAddedPlayerIds = [];
			game.hostAddedPlayerIds.push(botId);

			log(`AI Bot added: ${name} (${botId}) to game ${gameId}`, 'game', undefined, { simulation: (game as any).simulation });
			clampPlayerResources(game);
			emitGameUpdated(io, game);
			callback({ botId, name, game });
		});

		/** 방장 전용: 로비에서 추가한 플레이어/봇 제거 (잘못 추가 시). 방장 본인은 제거 불가. */
		socket.on('host_remove_player', ({ gameId, targetPlayerId }, callback) => {
			const game = games.get(gameId);
			if (!game) { callback?.({ error: 'Game not found' }); return; }
			const callerId = socketToPlayerMap.get(socket.id);
			if (callerId !== game.hostId) { callback?.({ error: 'Only host can remove players' }); return; }
			if (game.currentPhase !== 'lobby') { callback?.({ error: 'Can only remove in lobby' }); return; }
			if (!targetPlayerId || targetPlayerId === game.hostId) { callback?.({ error: '방장은 제거할 수 없습니다.' }); return; }
			if (!game.players[targetPlayerId]) { callback?.({ ok: true, game }); return; }
			delete game.players[targetPlayerId];
			game.turnOrder = (game.turnOrder || []).filter(id => id !== targetPlayerId);
			game.botPlayerIds = (game.botPlayerIds || []).filter(id => id !== targetPlayerId);
			game.hostAddedPlayerIds = (game.hostAddedPlayerIds || []).filter(id => id !== targetPlayerId);
			log(`Player removed: ${targetPlayerId} from game ${gameId} by host`, 'game', undefined, { simulation: (game as any).simulation });
			emitGameUpdated(io, game);
			callback?.({ ok: true, game });
		});

		socket.on('rejoin_game', ({ gameId, playerId }, callback) => {
			const game = games.get(gameId);
			if (!game) { callback({ error: 'Game not found' }); return; }

			// 관전자 재접속: 플레이어 슬롯 없이 방만 구독
			if (game.spectatorIds?.includes(playerId)) {
				socketToSpectatorMap.set(socket.id, playerId);
				spectatorToGameMap.set(playerId, gameId);
				joinGameRoom(socket, gameId);
				// [숨은 관전 아이디] 새로고침으로 재접속할 때 다시 목록에 뜨면 숨김이 무의미해진다 → 숨은 id면 등록 생략.
				//   (게임은 서버 메모리에만 있어 재시작하면 게임 자체가 사라지므로 이 Set이 게임보다 먼저 없어질 일은 없다.)
				if (!hiddenSpectatorIds.has(playerId)) setSpectatorConnected(game, playerId, true);
				callback({ game });
				emitGameUpdated(io, game); // 관전자 목록 갱신
				return;
			}

			if (!game.players[playerId]) { callback({ error: 'Player not found' }); return; }

			// '떠났습니다'와 대칭으로 '다시 접속했습니다' 알림(사용자 요청). 단 이 소켓 등록 '전에' 같은 플레이어의
			// 다른 소켓이 없었을 때만 = 진짜 떠나있다 돌아온 경우만. (여러 탭/빠른 새로고침 중복 알림 방지.) 봇 제외.
			const wasAway = !Array.from(socketToPlayerMap.values()).includes(playerId)
				&& !game.botPlayerIds?.includes(playerId);
			// [사용자] 45초 내 복귀면 '떠났'을 아직 안 띄웠으므로 그 타이머를 취소하고 '다시 접속'도 생략(스팸 방지).
			//   타이머가 이미 발화(45초 초과 → '떠났' 표시됨)했으면 map에 없으니 아래 wasAway 알림이 정상 표시된다.
			const leftKey = `${gameId}:${playerId}`;
			const hadPendingLeftTimer = leftAnnounceTimers.has(leftKey);
			if (hadPendingLeftTimer) {
				clearTimeout(leftAnnounceTimers.get(leftKey)!);
				leftAnnounceTimers.delete(leftKey);
			}

			// If the reconnecting player is the host, update the host socket context
			if (game.hostId === playerId) {
				game.hostSocketId = socket.id;
			}

			socketToPlayerMap.set(socket.id, playerId);
			playerGameMap.set(playerId, gameId);
			joinGameRoom(socket, gameId);
			clampPlayerResources(game);

			if (wasAway && !hadPendingLeftTimer) {
				const name = game.players[playerId].name;
				const msg = {
					id: generatePlayerId(),
					gameId,
					senderId: 'system',
					name: '시스템',
					faction: null,
					isSpectator: false,
					text: `🔄 ${name}님이 다시 접속했습니다.`,
					ts: Date.now(),
				};
				if (!game.chatMessages) game.chatMessages = [];
				game.chatMessages.push(msg);
				if (game.chatMessages.length > 100) game.chatMessages = game.chatMessages.slice(-100);
				io.to(gameId).emit('chat_message', msg);
			}

			emitGameUpdated(io, game);
			callback({ game });
			executeBotTurnIfNeeded(io, game as ServerGameState).catch(() => { });
		});

		socket.on('watch_game', ({ gameId, name }: { gameId: string; name?: string }, callback) => {
			const game = games.get(gameId);
			if (!game) { callback({ error: 'Game not found' }); return; }

			const specName = typeof name === 'string' ? name.trim().slice(0, 20) : '';
			// [사용자 2026-08-01] Join처럼 관전도 이름 필수 — 채팅/관전자 목록 표기에 쓰임
			if (!specName) { callback({ error: '관전하려면 이름을 입력하세요.' }); return; }
			const spectatorId = 'spec-' + generatePlayerId();
			if (!game.spectatorIds) game.spectatorIds = [];
			game.spectatorIds.push(spectatorId);
			// [숨은 관전 아이디] HIDDEN_SPECTATOR_NAME('---')이면 이름을 game 객체에 아예 기록하지 않고
			//   connectedSpectators에도 넣지 않는다 → 채팅창 관전자 목록에 안 뜨는 건 물론, game_updated 브로드캐스트·
			//   롤백 gz 스냅샷 어디에도 흔적이 없어 devtools로 payload를 열어봐도 보이지 않는다.
			//   spectatorIds에는 남지만 이름 없는 'spec-xxxx'라 접속을 끊은 일반 관전자와 구별되지 않는다(재접속 인증에 필요).
			const hiddenSpectator = isHiddenSpectatorName(specName);
			if (hiddenSpectator) {
				hiddenSpectatorIds.add(spectatorId);
			} else {
				if (!(game as any).spectatorNames) (game as any).spectatorNames = {};
				(game as any).spectatorNames[spectatorId] = specName;
				setSpectatorConnected(game, spectatorId, true);
			}
			socketToSpectatorMap.set(socket.id, spectatorId);
			spectatorToGameMap.set(spectatorId, gameId);
			joinGameRoom(socket, gameId);
			log(`Spectator joined game ${gameId} (${spectatorId})${hiddenSpectator ? ' [hidden]' : ''}`, 'game', undefined, { simulation: (game as any).simulation });
			callback({ gameId, spectatorId, game });
			// 관전자 목록 갱신 브로드캐스트. 숨은 관전자는 목록이 안 바뀌므로 보내지 않는다 —
			// 내용이 그대로인 game_updated가 방 전원에 튀는 것 자체가 '누가 들어왔다'는 신호가 되기 때문.
			if (!hiddenSpectator) emitGameUpdated(io, game);
		});

		socket.on('get_game', ({ gameId }, callback) => {
			const game = games.get(gameId);
			if (!game) { callback({ error: 'Game not found' }); return; }
			callback({ game });
			executeBotTurnIfNeeded(io, game as ServerGameState).catch(() => { });
		});

		// [진행 중 로그 다운로드] 관전자/플레이어가 게임 끝나기 전에 분석용 스냅샷을 받음 (최종 저장과 동일 포맷, 비파괴).
		socket.on('export_game_snapshot', ({ gameId }: { gameId: string }, callback?: (r: { payload?: unknown; error?: string }) => void) => {
			const game = games.get(gameId);
			if (!game) { callback?.({ error: 'Game not found' }); return; }
			try {
				const payload = buildLiveSnapshot(game as ServerGameState);
				callback?.({ payload });
			} catch (e) {
				log(`export_game_snapshot failed: ${(e as Error)?.message}`, 'error', gameId);
				callback?.({ error: '스냅샷 생성 실패' });
			}
		});

		socket.on('submit_ai_feedback', ({ gameId, actionId, rating, expertMove, reason, tags }, callback) => {
			const game = games.get(gameId);
			if (!game) { callback?.({ error: 'Game not found' }); return; }
			const playerId = socketToPlayerMap.get(socket.id);
			const spectatorId = socketToSpectatorMap.get(socket.id);
			const isPlayerInGame = !!playerId && playerGameMap.get(playerId) === gameId;
			const isSpectatorInGame = !!spectatorId && spectatorToGameMap.get(spectatorId) === gameId;
			if (!isPlayerInGame && !isSpectatorInGame) {
				callback?.({ error: 'Not connected to this game' });
				return;
			}
			const targetAction = actionId
				? (game.botActionsForFeedback ?? []).find((a) => a.id === actionId) ?? null
				: game.lastBotActionForFeedback ?? null;
			if (!targetAction) {
				callback?.({ error: 'No bot action to review' });
				return;
			}

			try {
				const record = saveAiExpertFeedback(game, playerId || spectatorId || socket.id, isPlayerInGame ? 'player' : 'spectator', {
					rating,
					expertMove,
					reason,
					tags,
				}, targetAction);
				addGameLog(game, targetAction.playerId, 'AI Feedback', `${rating || 'unspecified'} by ${isPlayerInGame ? game.players[playerId!]?.name ?? playerId : 'spectator'}`);
				log(`AI feedback saved for game ${gameId}: ${record.lastBotAction?.actionType ?? 'unknown'} (${rating ?? 'unspecified'})`, 'game', gameId);
				emitGameUpdated(io, game);
				callback?.({ ok: true });
			} catch (err) {
				log(`Failed to save AI feedback: ${err}`, 'error', gameId);
				callback?.({ error: 'Failed to save feedback' });
			}
		});

		socket.on('set_use_faction_bidding', ({ gameId, useFactionBidding }: { gameId: string; useFactionBidding: boolean }, callback?: (r: { ok?: boolean; error?: string }) => void) => {
			const game = games.get(gameId);
			if (!game) { callback?.({ error: 'Game not found' }); return; }
			const playerId = socketToPlayerMap.get(socket.id);
			if (playerId !== game.hostId) { callback?.({ error: 'Host only' }); return; }
			if (game.currentPhase !== 'lobby') { callback?.({ error: 'Lobby only' }); return; }
			game.useFactionBidding = !!useFactionBidding;
			clampPlayerResources(game); emitGameUpdated(io, game);
			callback?.({ ok: true });
		});

		// 친선전 토글: 로비에서 호스트만. 켜면 종료 시 기록(점수) 사이트 자동 저장 스킵. 방 전체에 표시됨.
		socket.on('set_friendly_match', ({ gameId, friendlyMatch }: { gameId: string; friendlyMatch: boolean }, callback?: (r: { ok?: boolean; error?: string }) => void) => {
			const game = games.get(gameId);
			if (!game) { callback?.({ error: 'Game not found' }); return; }
			const playerId = socketToPlayerMap.get(socket.id);
			if (playerId !== game.hostId) { callback?.({ error: 'Host only' }); return; }
			if (game.currentPhase !== 'lobby') { callback?.({ error: 'Lobby only' }); return; }
			game.friendlyMatch = !!friendlyMatch;
			clampPlayerResources(game); emitGameUpdated(io, game);
			callback?.({ ok: true });
		});

		// [롤백 투표] 호스트가 로그의 특정 지점으로 롤백 요청 → 다른 사람(사람) 전원 동의 시 실행. 봇 자동 승인.
		socket.on('request_rollback', ({ gameId, seq }: { gameId: string; seq: number }, callback?: (r: { ok?: boolean; error?: string }) => void) => {
			const game = games.get(gameId);
			if (!game) { callback?.({ error: 'Game not found' }); return; }
			const playerId = socketToPlayerMap.get(socket.id);
			// [사용자] 방장 전용 → 참가자 누구나 요청 가능(어차피 나머지 전원 동의 필요). 봇·관전자만 차단.
			if (!playerId || !game.players[playerId] || (game.botPlayerIds || []).includes(playerId)) { callback?.({ error: '게임 참가자만 롤백을 요청할 수 있습니다.' }); return; }
			// [사용자 2026-08-03] 최초 집 배치(startingMines)도 허용 — 첫 집을 잘못 놓으면 게임 전체가 꼬이므로 되돌릴 필요가 큼.
			if (!['main','startingMines','bonusSelection'].includes(String(game.currentPhase))) { callback?.({ error: '진행 중·시작 배치·보너스 선택 단계에서만 롤백 가능합니다.' }); return; }
			if ((game as any).pendingRollback) { callback?.({ error: '이미 롤백 투표가 진행 중입니다.' }); return; }
			const hist = turnHistories.get(gameId) || [];
			// [버그수정] 클릭한 로그 seq '미만'의 가장 최근 턴 시작 스냅샷 = 그 로그가 속한 턴의 시작.
			//   (기존 '<='는 클릭한 턴의 '다음' 턴 시작을 잡아 한 턴 늦게 시작하던 문제)
			let targetIdx = -1;
			for (let i = 0; i < hist.length; i++) { if (hist[i].seq < seq) targetIdx = i; else break; }
			if (targetIdx < 0) { callback?.({ error: '그 지점의 롤백 스냅샷이 없습니다.' }); return; }
			const target = hist[targetIdx];
			const bots = new Set(game.botPlayerIds || []);
			const required = Object.keys(game.players).filter(id => id !== playerId && !bots.has(id));
			// [표시] 몇 턴 전인지 + 되돌릴 로그 내용(target.seq 이후 로그 요약, 최근 8개)
			const turnsBack = hist.length - 1 - targetIdx; // target 이후 턴 시작 수
			const undone = (game.gameLog || []).filter(e => typeof (e as any).seq === 'number' && (e as any).seq > target.seq);
			const undoneCount = undone.length;
			const undoneActions = undone.slice(-8).map(e => `${e.playerName}: ${e.action}`);
			(game as any).pendingRollback = {
				requesterId: playerId, requesterName: game.players[playerId!]?.name ?? '요청자',
				seq: target.seq, label: `R${target.round} · ${target.playerName} 턴 시작`,
				turnsBack, undoneCount, undoneActions,
				required, approvals: [],
			};
			if (required.length === 0) { // 다른 사람(사람) 없음 → 즉시 실행
				countRollback(gameId, playerId);
				executeRollbackToHistory(io, game, hist, target);
				callback?.({ ok: true }); return;
			}
			emitGameUpdated(io, game);
			callback?.({ ok: true });
		});

		// 롤백 투표 응답: 한 명이라도 거절하면 취소, 필요한 사람 전원 승인 시 실행.
		socket.on('respond_rollback', ({ gameId, accept }: { gameId: string; accept: boolean }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;
			const pr = (game as any).pendingRollback;
			if (!pr || !pr.required.includes(playerId)) return;
			if (!accept) { (game as any).pendingRollback = null; emitGameUpdated(io, game); return; }
			if (!pr.approvals.includes(playerId)) pr.approvals.push(playerId);
			if (pr.required.every((id: string) => pr.approvals.includes(id))) {
				const hist = turnHistories.get(gameId) || [];
				const target = hist.find(h => h.seq === pr.seq);
				if (target) { countRollback(gameId, pr.requesterId); executeRollbackToHistory(io, game, hist, target); }
				else { (game as any).pendingRollback = null; emitGameUpdated(io, game); }
			} else {
				emitGameUpdated(io, game);
			}
		});

		// 방 삭제: 시작 전(로비) 상태에서 방장만. 방 안의 모두를 로비로 내보내고 게임을 메모리에서 제거.
		socket.on('delete_game', ({ gameId, playerId: claimedId }: { gameId: string; playerId?: string }, callback?: (r: { ok?: boolean; error?: string }) => void) => {
			const game = games.get(gameId);
			if (!game) { callback?.({ ok: true }); return; } // 이미 없음
			// 로비 화면발 요청은 소켓에 좌석 매핑이 없어 payload playerId 인정 (rejoin_game과 동일 신뢰모델 — id 자체가 비밀값)
			const playerId = socketToPlayerMap.get(socket.id) ?? (claimedId && game.players[claimedId] ? claimedId : undefined);
			if (!playerId || game.hostId !== playerId) { callback?.({ error: '방장만 방을 삭제할 수 있습니다.' }); return; }
			// [사용자 요청 2026-07-31] 사람만 있는 방도 방장이면 종료 가능 (기존: 진행 중 + 사람 2명 이상이면 거부).
			// 버려진 사람 방 정리가 목적 — 클라이언트에서 다른 사람이 있으면 경고 confirm을 띄운다.
			io.to(gameId).emit('game_deleted', { gameId });
			games.delete(gameId);
			turnHistories.delete(gameId); // [롤백] 히스토리 메모리 정리
			rollbackCounts.delete(gameId);
			log(`Game ${gameId} deleted by host ${playerId}`, 'game', gameId);
			callback?.({ ok: true });
		});

		socket.on('start_game', ({ gameId }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (playerId !== game.hostId) return;
			// 턴 순서 초기화: 일단 조인 순서 등으로 임시 설정 (이후 executeSelectFaction 완료 시 확정)
			if (!game.turnOrder || game.turnOrder.length === 0) {
				game.turnOrder = Object.keys(game.players);
			}

			const allHaveFaction = Object.values(game.players).every(p => p.faction != null);
			const biddingDeps = {
				executeSelectFaction,
				finalizeFactionSelectionToStartingMines,
			};

			if (game.useFactionBidding && !allHaveFaction) {
				game.currentPhase = 'factionBidding';
				log(`Start game: Entering factionBidding phase.`, 'game', undefined, { simulation: (game as any).simulation });
				FactionBidding.initFactionBiddingPhase(game, io, biddingDeps);
				computeTwoExpansionDraw(game);
				freezeSingleExpansionThreeStep(game); // 단일 확장종족도 비딩 시작 시 3삽 확정(랜덤 보충 문구 방지)
			} else if (allHaveFaction) {
				game.currentPhase = 'startingMines';
				log(`Start game: All factions selected. Resuming startingMines phase.`, 'game', undefined, { simulation: (game as any).simulation });
			} else {
				game.currentPhase = 'factionSelect';
				log(`Start game: Entering factionSelect phase.`, 'game', undefined, { simulation: (game as any).simulation });
			}

			// 확장: 모웨이드/팅커로이드 (종족 비딩이면 finalizeFactionSelectionToStartingMines에서 적용됨)
			if (game.currentPhase !== 'factionBidding') {
				const playerList = Object.values(game.players);
				const moweyipPlayer = playerList.find(p => p.faction === 'moweyip');
				const tinkeroidsPlayer = playerList.find(p => p.faction === 'tinkeroids');
				if (moweyipPlayer) {
					const otherHomes = playerList.filter(p => p.faction && p.faction !== 'moweyip').map(p => FACTIONS.find(f => f.id === p.faction)?.homePlanet).filter((h): h is import('@shared/gameConfig').PlanetType => h != null && HOME_PLANETS.includes(h));
					game.moweyipThreeStepPlanets = computeExpansionThreeStepPlanets(otherHomes);
					log(`Moweyip expansion: 3-step planets = ${game.moweyipThreeStepPlanets.join(', ')}`, 'game', undefined, { simulation: (game as any).simulation });
				}
				if (tinkeroidsPlayer) {
					const otherHomes = playerList.filter(p => p.faction && p.faction !== 'tinkeroids').map(p => FACTIONS.find(f => f.id === p.faction)?.homePlanet).filter((h): h is import('@shared/gameConfig').PlanetType => h != null && HOME_PLANETS.includes(h));
					game.tinkeroidsThreeStepPlanets = computeExpansionThreeStepPlanets(otherHomes);
					log(`Tinkeroids expansion: 3-step planets = ${game.tinkeroidsThreeStepPlanets.join(', ')}`, 'game', undefined, { simulation: (game as any).simulation });
				}
			}

			// 턴 시퀀스 계산 (이미 startingMines라면)
			if (game.currentPhase === 'startingMines') {
				const sequence = buildStartingMineSequence(game);
				(game as any).startingMineSequence = sequence;
				const firstId = sequence[0];
				if (firstId && game.turnOrder?.length) {
					game.currentPlayerIndex = game.turnOrder.indexOf(firstId);
					if (game.currentPlayerIndex < 0) game.currentPlayerIndex = 0;
					log(`Start game: first to place is ${firstId} (index ${game.currentPlayerIndex})`, 'game', undefined, { simulation: (game as any).simulation });
				} else {
					game.currentPlayerIndex = 0;
				}
			} else {
				game.currentPlayerIndex = 0;
			}
			clampPlayerResources(game); emitGameUpdated(io, game);

			// Trigger bot turn if first player is a bot
			executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
				log(`Bot turn execution error (start_game): ${err}`, 'error');
			});
		});

		socket.on('toggle_test_mode', ({ gameId }) => {
			const game = games.get(gameId);
			if (!game) return;
			game.isTestMode = !game.isTestMode;
			log(`Test mode ${game.isTestMode ? 'ENABLED' : 'DISABLED'} for game ${gameId}`, 'game', undefined, { simulation: (game as any).simulation });
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		/**
		 * 테스트용 원클릭 자동 세팅 (봇 3개 + 랜덤 팩션 + 게임 시작). selfPlay: true 시 호스트도 봇으로 간주해 4인 전부 봇으로 진행.
		 * headToHead: 같은 테이블 A/B 비교. bPositions(0-base 턴순서 위치)에 해당하는 좌석은 그룹 B(도전자),
		 *   나머지는 그룹 A(챔피언) 변형을 갖는다. 좌석별로 evaluator 가중치/기능 플래그가 달라진다.
		 */
		socket.on('auto_setup_test', ({ gameId, selfPlay, headToHead, fixedSetup }: {
			gameId: string;
			selfPlay?: boolean;
			headToHead?: { bPositions: number[]; A: PlayerVariant; B: PlayerVariant; forceFaction?: string; forceFactionPos?: number };
			fixedSetup?: { map?: HexTile[]; seatFactions?: string[] };
		}) => {
			const game = games.get(gameId);
			if (!game) return;
			const callerId = socketToPlayerMap.get(socket.id);
			if (callerId !== game.hostId) return;
			if (game.currentPhase !== 'lobby') return;

			// head-to-head: 이전 게임의 좌석별 변형을 비운다(워커는 게임을 순차 실행)
			if (!AI_BOTS_ENABLED) return; // [사용자] 봇 비활성 서버: Auto Setup(봇 자동 채우기) 금지
				if (headToHead) clearAllPlayerVariants();

			// 1. 봇 3개 추가 (최대 4인)
			if (!game.botPlayerIds) game.botPlayerIds = [];
			if (selfPlay && !game.botPlayerIds.includes(game.hostId)) {
				game.botPlayerIds.push(game.hostId); // 자기대국: 호스트 슬롯도 봇이 수행
			}
			while (Object.keys(game.players).length < 4) {
				const botId = `bot-${generatePlayerId()}`;
				const name = `AI Bot ${Object.keys(game.players).length + 1}`;
				game.players[botId] = createInitialPlayerState(name);
				game.turnOrder.push(botId);
				game.botPlayerIds.push(botId);
			}

			// [paired h2h] 고정 맵 주입: 하니스가 generateMap()으로 그룹당 맵 하나 만들어 그룹 내 모든 게임에 동일 주입.
			//   맵 레이아웃(회전·행성배치)을 고정해 판간 맵 노이즈를 제거 → paired 비교(1좌석만 변경).
			if (fixedSetup?.map && fixedSetup.map.length > 0) {
				game.map = deepClone(fixedSetup.map).map(t => ({ ...t, structure: null, ownerId: null, isGaiaformed: false }));
			}

			// 2. 게임 시작 (팩션 선택 단계로 진입)
			game.currentPhase = 'factionSelect';

			// 3. 모든 플레이어에게 랜덤 팩션 및 턴 순서 배정 (무작위성 확보)
			const playerIds = Object.keys(game.players);
			const shuffledPlayerIds = [...playerIds].sort(() => Math.random() - 0.5);
			const shuffledFactions = [...FACTIONS].sort(() => Math.random() - 0.5);

			const usedColors = new Set<string>();
			const usedFactionIds = new Set<string>();

			// 배치 도중 봇 턴이 중복 실행되지 않도록 락을 건 상태로 일괄 작업
			game.isBotExecuting = true;
			try {
				// 1단계: 이미 팩션을 가진 플레이어(주로 사람)의 팩션 선점
				playerIds.forEach(pid => {
					const p = game.players[pid];
					if (p.faction) {
						usedFactionIds.add(p.faction);
						const f = FACTIONS.find(fac => fac.id === p.faction);
						if (f) usedColors.add(f.color);
					}
				});

				// [faction-forcing] head2head 종족별 측정: 목표 종족을 고정 위치(기본 0)에 강제 배정.
				// 그 종족의 색/ID를 미리 선점해 랜덤 배정이 같은 색을 가져가지 않게 하고(중복 방지),
				// 목표 위치 좌석엔 명시적으로 그 종족을 앉힌다. B_PATTERNS 회전이 그 좌석을 절반은 B(플래그ON)/절반은 A(OFF)로
				// 만들어 → 같은 종족·같은 좌석을 ON/OFF로 paired 비교(좌석/위치 편향 통제).
				const forceFaction = headToHead?.forceFaction;
				const forcePos = headToHead?.forceFactionPos ?? 0;
				if (forceFaction) {
					const ff = FACTIONS.find(fac => fac.id === forceFaction);
					if (ff) { usedColors.add(ff.color); usedFactionIds.add(ff.id); }
				}

				let factionIdx = 0;
				const orderIds = fixedSetup?.seatFactions ? playerIds : shuffledPlayerIds;
				orderIds.forEach((pid, idx) => {
					const player = game.players[pid];

					// [paired h2h] 고정 세팅: 위치 idx에 seatFactions[idx] 결정적 배정(그룹 내 동일 종족/좌석) — 랜덤 우회.
					if (fixedSetup?.seatFactions) {
						const fid = fixedSetup.seatFactions[idx];
						if (fid) executeSelectFaction(io, game, pid, fid, idx + 1, { skipBotTrigger: true });
						return;
					}

					// 이미 팩션이 있는 경우 (유저가 선택함), 턴 순서만 새로 배정하여 executeSelectFaction 호출
					if (player.faction) {
						executeSelectFaction(io, game, pid, player.faction, idx + 1, { skipBotTrigger: true });
						return;
					}

					// [faction-forcing] 목표 위치 좌석엔 강제 종족 배정 (위에서 색/ID 선점했으므로 랜덤과 충돌 없음)
					if (forceFaction && idx === forcePos) {
						const ff = FACTIONS.find(fac => fac.id === forceFaction);
						if (ff) {
							executeSelectFaction(io, game, pid, ff.id, idx + 1, { skipBotTrigger: true });
							return;
						}
					}

					// 중복되지 않는 컬러/팩션을 가진 팩션 찾기
					while (factionIdx < shuffledFactions.length) {
						const f = shuffledFactions[factionIdx++];
						if (!usedColors.has(f.color) && !usedFactionIds.has(f.id)) {
							usedColors.add(f.color);
							usedFactionIds.add(f.id);
							executeSelectFaction(io, game, pid, f.id, idx + 1, { skipBotTrigger: true });
							break;
						}
					}
				});

				// 배정 결과 요약 로그
				const summary = Object.entries(game.players).map(([id, p]: [string, any]) => `${p.name}(${p.faction}) order:${p.selectedTurnOrder}`).join(', ');
				log(`Auto setup assignments: ${summary}`, 'game', undefined, { simulation: (game as any).simulation });

				// 4. 상태 점검 및 봇 턴 실행 (executeSelectFaction 내에서 이미 startingMines 단계로 진입했을 것임)
				log(`Current Phase after setup: ${game.currentPhase}`, 'game', undefined, { simulation: (game as any).simulation });

				// 만약 executeSelectFaction 내에서 단계 전환이 안 일어났을 경우를 대비한 보장 로직
				if (game.currentPhase === 'factionSelect') {
					game.currentPhase = 'startingMines';
					(game as any).startingMineSequence = buildStartingMineSequence(game);
				}

				// 광산 배치 순서 확인/초기화 (이미 executeSelectFaction에서 했을 수 있지만 보강)
				if (game.currentPhase === 'startingMines' && !(game as any).startingMineSequence) {
					(game as any).startingMineSequence = buildStartingMineSequence(game);
				}

				// 모웨이드/팅커로이드 3테라포밍 땅 설정 (start_game 로직 복사)
				const playerList = Object.values(game.players);
				const moweyipPlayer = playerList.find(p => p.faction === 'moweyip');
				const tinkeroidsPlayer = playerList.find(p => p.faction === 'tinkeroids');

				if (moweyipPlayer) {
					const otherHomes = playerList.filter(p => p.faction && p.faction !== 'moweyip').map(p => FACTIONS.find(f => f.id === p.faction)?.homePlanet).filter((h): h is import('@shared/gameConfig').PlanetType => h != null && HOME_PLANETS.includes(h));
					game.moweyipThreeStepPlanets = computeExpansionThreeStepPlanets(otherHomes);
				}
				if (tinkeroidsPlayer) {
					const otherHomes = playerList.filter(p => p.faction && p.faction !== 'tinkeroids').map(p => FACTIONS.find(f => f.id === p.faction)?.homePlanet).filter((h): h is import('@shared/gameConfig').PlanetType => h != null && HOME_PLANETS.includes(h));
					game.tinkeroidsThreeStepPlanets = computeExpansionThreeStepPlanets(otherHomes);
				}

				// === head-to-head A/B: 좌석(턴순서)별로 챔피언(A)/도전자(B) 변형 주입 ===
				if (headToHead) {
					const bSet = new Set(headToHead.bPositions || []);
					const assigned: string[] = [];
					Object.keys(game.players).forEach(pid => {
						const order = (game.players[pid] as any).selectedTurnOrder as number | undefined;
						if (typeof order !== 'number') return;
						const pos = order - 1; // 0-base 턴순서 위치
						const isB = bSet.has(pos);
						const variant = isB
							? { ...headToHead.B, label: headToHead.B.label ?? 'challenger' }
							: { ...headToHead.A, label: headToHead.A.label ?? 'champion' };
						setPlayerVariant(pid, variant);
						// 집계용으로 게임 상태에도 그룹/라벨을 박아 game_updated로 러너에 전달
						(game.players[pid] as any).h2hGroup = isB ? 'B' : 'A';
						(game.players[pid] as any).h2hLabel = variant.label;
						(game.players[pid] as any).h2hPos = pos;
						assigned.push(`${(game.players[pid] as any).faction || pid}=pos${pos}/${isB ? 'B' : 'A'}`);
					});
					log(`Head-to-head variants assigned: ${assigned.join(', ')}`, 'game', undefined, { simulation: (game as any).simulation });
				}

				log(`Auto setup test completed for game ${gameId}. Current Phase: ${game.currentPhase}`, 'game', undefined, { simulation: (game as any).simulation });
				clampPlayerResources(game);
				emitGameUpdated(io, game);
			} finally {
				game.isBotExecuting = false;
			}

			// 모든 세팅이 안정된 후 단 한 번 봇 턴 실행 트리거
			executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
				log(`Bot turn execution error (auto_setup_test): ${err}`, 'error');
			});
		});

		socket.on('debug_set_resources', ({ gameId, resources }) => {
			const game = games.get(gameId);
			if (!game || !game.isTestMode) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;
			const player = game.players[playerId];
			if (resources.credits !== undefined) player.credits = resources.credits;
			if (resources.ore !== undefined) player.ore = resources.ore;
			if (resources.knowledge !== undefined) player.knowledge = resources.knowledge;
			if (resources.qic !== undefined) player.qic = resources.qic;
			// Power bowl settings
			if (resources.power1 !== undefined) player.power1 = resources.power1;
			if (resources.power2 !== undefined) player.power2 = resources.power2;
			if (resources.power3 !== undefined) player.power3 = resources.power3;
			log(`Debug: Set resources for ${player.name}: ${JSON.stringify(resources)}`, 'game', undefined, { simulation: (game as any).simulation });
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		socket.on('admin_set_player_state', ({ gameId, targetPlayerId, resources, adminCode }, callback) => {
			const game = games.get(gameId);
			if (!game) {
				callback?.({ error: 'Game not found' });
				return;
			}
			if (adminCode !== '0011') {
				callback?.({ error: 'Invalid admin password' });
				return;
			}
			const target = game.players[targetPlayerId];
			if (!target) {
				callback?.({ error: 'Player not found' });
				return;
			}

			const setNumber = (key: 'score' | 'credits' | 'ore' | 'knowledge' | 'qic' | 'power1' | 'power2' | 'power3') => {
				const value = resources?.[key];
				if (typeof value === 'number' && Number.isFinite(value)) {
					(target as any)[key] = Math.max(0, Math.floor(value));
				}
			};

			setNumber('score');
			setNumber('credits');
			setNumber('ore');
			setNumber('knowledge');
			setNumber('qic');
			setNumber('power1');
			setNumber('power2');
			setNumber('power3');

			// Taklons: Brainstone position controls (GM/Admin)
			if (typeof (resources as any)?.brainStoneInGaia === 'boolean') {
				(target as any).brainStoneInGaia = (resources as any).brainStoneInGaia;
				// Gaia에 두면 보통 다음 라운드 시작에 1그릇 복귀하므로 기본값 안전하게 맞춤
				if ((target as any).brainStoneInGaia === true && (target as any).brainStoneBowl == null) {
					(target as any).brainStoneBowl = 1;
				}
			}
			const bowl = (resources as any)?.brainStoneBowl;
			if (bowl === 1 || bowl === 2 || bowl === 3) {
				(target as any).brainStoneBowl = bowl;
			}

			log(`Admin: Set player state for ${target.name}: ${JSON.stringify(resources)}`, 'game', gameId);
			clampPlayerResources(game);
			emitGameUpdated(io, game);
			callback?.({ ok: true });
		});

		// GM/Admin: 게임 즉시 종료 → 최종 점수 계산 후 점수 화면 표시 (테스트용)
		socket.on('admin_force_end_game', ({ gameId, adminCode }: { gameId: string; adminCode: string }, callback?: (r: { ok?: boolean; error?: string }) => void) => {
			const game = games.get(gameId);
			if (!game) { callback?.({ error: 'Game not found' }); return; }
			if (adminCode !== '0011') { callback?.({ error: 'Invalid admin password' }); return; }
			if (game.currentPhase === 'gameEnd') { callback?.({ ok: true }); return; }
			log(`Admin: force end game ${gameId}`, 'game', gameId);
			forceFinishStalledGame(io, game as ServerGameState, 'admin force end');
			callback?.({ ok: true });
		});

		// GM/Admin: 현재 턴을 특정 플레이어로 강제 지정 (디버그용).
		// 가드: main 단계만 · 패스한 플레이어 제외 · 진행중인 선택/액션(pending*)이 있으면 거부(고아 상태 방지).
		// 전환 시 hasDoneMainAction 리셋·undo컨텍스트 정리·turnStartState 재생성·봇이면 트리거.
		socket.on('admin_set_current_turn', ({ gameId, targetPlayerId, adminCode }: { gameId: string; targetPlayerId: string; adminCode: string }, callback?: (r: { ok?: boolean; error?: string }) => void) => {
			const game = games.get(gameId);
			if (!game) { callback?.({ error: 'Game not found' }); return; }
			if (adminCode !== '0011') { callback?.({ error: 'Invalid admin password' }); return; }
			if (game.currentPhase !== 'main') { callback?.({ error: `현재 턴 지정은 액션(main) 단계에서만 가능합니다 (현재: ${game.currentPhase})` }); return; }
			const idx = game.turnOrder.indexOf(targetPlayerId);
			if (idx < 0) { callback?.({ error: 'Player not in turn order' }); return; }
			const target = game.players[targetPlayerId];
			if (!target) { callback?.({ error: 'Player not found' }); return; }
			if (target.hasPassed) { callback?.({ error: `${target.name}은(는) 이미 이 라운드에 패스했습니다` }); return; }
			// 진행 중인 선택/액션이 있으면 거부 — 턴을 바꾸면 그 대기 상태가 고아가 됨
			const pendingKeys = [
				'pendingTurnEndPlayerId', 'pendingLostPlanet', 'pendingIncomeOrder', 'pendingItarsGaiaformerExchange',
				'pendingTerranCouncilBenefit', 'pendingTinkeroidSpecialChoice', 'pendingBonusSelection', 'pendingTwilightFederation',
				'pendingTechTileSelection', 'pendingTFMarsGaiaProject', 'pendingEclipseResearch', 'pendingEclipseAsteroidMine',
				'pendingShipTechTrackAdvance', 'pendingAdvancedTechTrackAdvance', 'pendingAdvancedTechCover', 'pendingFederationReward',
				'pendingSpaceshipFedMine',
			];
			const active = pendingKeys.filter(k => (game as any)[k] != null);
			if (active.length > 0) { callback?.({ error: `대기 중인 액션이 있어 턴을 변경할 수 없습니다: ${active.join(', ')}. 먼저 처리(완료/취소)하세요.` }); return; }

			game.currentPlayerIndex = idx;
			game.hasDoneMainAction = false;
			(game as any).freeActionUndoContext = undefined;
			captureTurnStartWithPrev(game as ServerGameState, targetPlayerId);
			log(`Admin: set current turn to ${target.name} (index ${idx})`, 'game', gameId);
			clampPlayerResources(game);
			emitGameUpdated(io, game);
			// 새 현재 플레이어가 봇이면 자동 진행
			executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => log(`Bot turn execution error (admin_set_current_turn): ${err}`, 'error'));
			callback?.({ ok: true });
		});

		// GM/Admin: 연방 토큰의 초록/빨강 상태 토글 (이미 사용해 뒤집힌 연방을 다시 초록으로 되돌리는 등 실수 복구용).
		socket.on('admin_toggle_federation_green', ({ gameId, targetPlayerId, federationIndex, adminCode }: { gameId: string; targetPlayerId: string; federationIndex: number; adminCode: string }, callback?: (r: { ok?: boolean; error?: string; isGreen?: boolean }) => void) => {
			const game = games.get(gameId);
			if (!game) { callback?.({ error: 'Game not found' }); return; }
			if (adminCode !== '0011') { callback?.({ error: 'Invalid admin password' }); return; }
			const target = game.players[targetPlayerId];
			if (!target) { callback?.({ error: 'Player not found' }); return; }
			// 레거시 string[] → FederationEntry[] 정규화 후 인덱스 토글
			const entries = getFederationEntries(target);
			if (federationIndex < 0 || federationIndex >= entries.length) { callback?.({ error: `연방 인덱스 범위 초과 (0~${entries.length - 1})` }); return; }
			entries[federationIndex] = { ...entries[federationIndex], isGreen: !entries[federationIndex].isGreen };
			target.federations = entries;
			const nowGreen = entries[federationIndex].isGreen;
			log(`Admin: toggled federation #${federationIndex} (${entries[federationIndex].rewardId}) of ${target.name} → ${nowGreen ? 'GREEN(사용가능)' : 'RED(사용됨)'}`, 'game', gameId);
			emitGameUpdated(io, game);
			callback?.({ ok: true, isGreen: nowGreen });
		});

		// GM/Admin: 현재 턴 플레이어의 턴을 시작 시점으로 롤백 (실수 복구용).
		// reset_turn과 동일한 전체 상태 복원이지만 GM이 대신 실행. 끝난 턴은 스냅샷이 삭제돼 불가.
		socket.on('admin_rollback_turn', ({ gameId, adminCode, targetPlayerId }: { gameId: string; adminCode: string; targetPlayerId?: string }, callback?: (r: { ok?: boolean; error?: string; playerName?: string }) => void) => {
			const game = games.get(gameId);
			if (!game) { callback?.({ error: 'Game not found' }); return; }
			if (adminCode !== '0011') { callback?.({ error: 'Invalid admin password' }); return; }
			// 대상 미지정 시 현재 턴 플레이어. 지정 시 그 플레이어의 마지막 턴 시작으로 전체 되감기.
			const playerId = targetPlayerId || game.turnOrder[game.currentPlayerIndex];
			if (!playerId) { callback?.({ error: '대상 플레이어를 찾을 수 없습니다.' }); return; }
			// 현재 차례 플레이어이고 이번 턴에 아직 메인 액션을 안 했으면(빈 턴), 직전 턴 시작으로 한 단계 더 되감기
			// (아니면 '직전 턴 종료=새 턴 시작' 상태로 되감겨 방금 한 행동이 안 지워지는 문제)
			const isCurrentPlayer = game.turnOrder[game.currentPlayerIndex] === playerId;
			const currentTurnEmpty = isCurrentPlayer && !game.hasDoneMainAction;
			const prevState: any = game.prevTurnStartState?.[playerId];
			const tsState: any = game.turnStartState?.[playerId];
			// [과도 되감기 방지 가드] prev(직전 턴)는 '같은 라운드'일 때만 되감기 후보로 쓴다. 라운드/페이즈 경계를 넘어온
			//   prev를 그대로 쓰면 인컴 재적용·가이아포머 성숙·파워리셋까지 통째로 한 라운드 되감겨 어드민 의도보다 과도하게
			//   되감긴다(과거 19f48ad가 이 가드 없이 되돌려진 원인). 경계 prev는 무시하고 현재 턴 시작(ts)으로 안전 폴백.
			const prevUsable = prevState?.fullGameState && prevState.roundNumber === game.roundNumber;
			// 견고한 선택: 빈 현재턴 & prev가 같은 라운드면 prev(직전 턴 시작) 우선, 아니면 ts(이번/마지막 턴 시작).
			const ordered = (currentTurnEmpty && prevUsable) ? [prevState, tsState] : [tsState, prevState];
			const startState: any = ordered.find(s => s?.fullGameState);
			if (!startState?.fullGameState) {
				// [진단] 배포 환경에서 원인 파악용 — 어떤 스냅샷이 비었는지 에러에 담아 보여줌.
				const diag = `ts=${tsState ? (tsState.fullGameState ? 'O' : 'noFull') : 'none'} prev=${prevState ? (prevState.fullGameState ? 'O' : 'noFull') : 'none'} prevUsable=${prevUsable ? 'Y' : 'N'}(r${prevState?.roundNumber ?? '-'}/now${game.roundNumber}) cur=${isCurrentPlayer} emptyTurn=${currentTurnEmpty} tsKeys=[${Object.keys(game.turnStartState || {}).length}]`;
				log(`Admin rollback: no snapshot for ${game.players[playerId]?.name ?? playerId} — ${diag}`, 'error', gameId);
				callback?.({ error: `롤백 스냅샷이 없습니다 (${diag})` });
				return;
			}
			const restored = deepClone(startState.fullGameState) as ServerGameState;
			restored.gameLog = restoreGameLogForReset(game as ServerGameState, startState, playerId);
			restored.humanActionJournal = startState.humanActionJournalState
				? deepClone(startState.humanActionJournalState)
				: (game.humanActionJournal || []).slice(0, startState.humanActionJournalLength || 0);
			clearFreeActionUndo(restored);
			restored.turnStartState = { [playerId]: buildTurnStartStateEntryForPlayer(restored, playerId) };
			restored.prevTurnStartState = undefined;
			countRollback(gameId, null); // GM 되감기 (좌석이 아니므로 admin으로 집계)
			// 진행 중이던 봇 루프 무효화: 옛 game 객체에 취소 플래그 + 락 해제 → 옛 루프 정지, 새 게임에서 재시작
			(game as any).botCanceled = true;
			cancelBotExecution(gameId);
			hideHeavyServerFields(restored);
			games.set(gameId, restored);
			clampPlayerResources(restored);
			log(`Admin: rolled back turn for ${restored.players[playerId]?.name ?? playerId}`, 'game', gameId);
			emitGameUpdated(io, restored); // [대역폭 2026-08-07] 전체 로그 직접 emit → 헬퍼 경유(꼬리40 델타)
			callback?.({ ok: true, playerName: restored.players[playerId]?.name });
			executeBotTurnIfNeeded(io, restored).catch(err => {
				log(`Bot turn execution error (admin_rollback_turn): ${err}`, 'error');
			});
		});

		socket.on('select_faction', ({ gameId, factionId, turnOrder }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;
			if (game.currentPhase === 'factionBidding') return;

			executeSelectFaction(io, game, playerId, factionId, turnOrder);
		});

		const factionBiddingDeps = () => ({
			executeSelectFaction,
			finalizeFactionSelectionToStartingMines,
		});

		socket.on('faction_bid_raise', ({ gameId, newBid }: { gameId: string; newBid: number }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;
			const err = FactionBidding.processFactionBidRaise(game, playerId, newBid);
			if (err) {
				io.to(gameId).emit('game_error', { message: err });
				return;
			}
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		socket.on('faction_bid_pass', ({ gameId }: { gameId: string }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;
			const err = FactionBidding.processFactionBidPass(game, playerId);
			if (err) {
				io.to(gameId).emit('game_error', { message: err });
				return;
			}
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		socket.on('faction_bid_pick', ({ gameId, factionId, turnOrder }: { gameId: string; factionId: string; turnOrder: number }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;
			const err = FactionBidding.processFactionBidPick(game, io, playerId, factionId, turnOrder, factionBiddingDeps());
			if (err) {
				io.to(gameId).emit('game_error', { message: err });
				return;
			}
			clampPlayerResources(game); emitGameUpdated(io, game);
			executeBotTurnIfNeeded(io, game as ServerGameState).catch(() => { });
		});

		socket.on('confirm_factions', ({ gameId }) => {
			const game = games.get(gameId);
			if (!game || !Object.values(game.players).every(p => p.faction !== null)) return;

			// 턴 순서를 selectedTurnOrder에 따라 정렬
			const playersWithTurnOrder = Object.entries(game.players)
				.map(([id, p]) => ({ id, turnOrder: (p as any).selectedTurnOrder as number | undefined }))
				.filter(p => p.turnOrder !== undefined)
				.sort((a, b) => (a.turnOrder || 0) - (b.turnOrder || 0));

			// 모든 플레이어가 턴 순서를 선택했는지 확인
			if (playersWithTurnOrder.length === Object.keys(game.players).length) {
				game.turnOrder = playersWithTurnOrder.map(p => p.id);
			}

			// 모든 플레이어가 종족을 선택했으면 보너스 타일 선택으로 이동
			const numPlayers = Object.keys(game.players).length;
			const shuffledBonusTiles = [...ALL_BONUS_TILES].sort(() => Math.random() - 0.5);
			game.availableBonusTiles = shuffledBonusTiles.slice(0, numPlayers + 3);
			game.currentPlayerIndex = game.turnOrder.length - 1;
			game.pendingBonusSelection = game.turnOrder[game.currentPlayerIndex];

			game.currentPhase = 'bonusSelection';
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		socket.on('place_starting_mine', ({ gameId, tileId, factionId }) => {
			const game = games.get(gameId);
			if (!game) { io.to(gameId).emit('game_error', { message: '게임을 찾을 수 없습니다.' }); return; }
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) { io.to(gameId).emit('game_error', { message: '플레이어 연결이 없습니다.' }); return; }

			const error = executePlaceStartingMine(io, game, playerId, tileId, factionId);
			if (error) {
				io.to(gameId).emit('game_error', { message: error });
			}
		});

		// Bonus Tile Selection
		socket.on('select_bonus_tile', ({ gameId, bonusTileId }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;

			executeSelectBonus(io, game, playerId, bonusTileId);
		});

		// Use Bonus Tile Special Action
		socket.on('use_bonus_action', ({ gameId }) => {
			const game = games.get(gameId); if (!game || game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (councilPendingActive(game)) { socket.emit('game_error', { message: '다른 플레이어의 선택(의회/이클립스)이 진행 중입니다. 완료되면 이어집니다.' }); return; }
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
			if (councilPendingActive(game)) return; // 아이타/테란 의회 선택 대기 중 — 라운드 첫 액션 보류

			const player = game.players[playerId];
			if (!player?.bonusTile || player.usedBonusAction) return;
			const bonusTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
			if (bonusTile?.specialAction === 'gaia_project' && getEffectiveGaiaformers(player) < 1) {
				socket.emit('game_error', { message: '사용 가능한 가이아포머가 없습니다.' });
				return;
			}
			executeUseBonusAction(io, game, playerId);
		});


		socket.on('build_mine', ({ gameId, tileId, useGaiaformer }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (councilPendingActive(game)) { socket.emit('game_error', { message: '다른 플레이어의 선택(의회/이클립스)이 진행 중입니다. 완료되면 이어집니다.' }); return; }

			executeBuildMine(io, game, playerId, tileId, useGaiaformer);
		});

		// 우주선 입장 (5VP로 잠금 해제 후 입장, 또는 이미 열린 우주선에 거리 체크 후 입장)
		socket.on('enter_spaceship', ({ gameId, tileId, useRangeBonus, qicToUse }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;
			if (councilPendingActive(game)) { socket.emit('game_error', { message: '다른 플레이어의 선택(의회/이클립스)이 진행 중입니다. 완료되면 이어집니다.' }); return; }

			const error = executeEnterSpaceship(io, game, playerId, tileId, useRangeBonus, qicToUse);
			if (error) {
				socket.emit('game_error', { message: error });
			}
		});

		// 우주선 내부 액션 사용 (트왈라잇, Rebellion, TF Mars, Eclipse)
		socket.on('use_ship_action', (payload) => {
			const { gameId, shipTileId, actionIndex, targetTileId } = payload;
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
			if (councilPendingActive(game)) return; // 아이타/테란 의회 선택 대기 중 — 라운드 첫 액션 보류
			if (hasActiveRangeBonus(game.players[playerId])) { socket.emit('game_error', { message: RANGE_BONUS_BLOCK_MSG }); return; }
			saveActionStartState(game, playerId);
			const player = game.players[playerId];
			// Nevlas 의회: 3그릇(area III) 토큰 1개 = 파워 2 → 우주선 액션 파워 코스트의 실제 토큰 소모를 절반(올림)으로.
			const hasNevlasPI = player.faction === 'nevlas' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
			const shipPowerTokens = (cost: number) => hasNevlasPI ? Math.ceil(cost / 2) : cost;
			const shipTile = game.map.find(t => t.id === shipTileId);
			const shipTypes = ['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'];
			if (!shipTile || !shipTypes.includes(shipTile.type)) return;
			const shipState = game.spaceships?.[shipTileId];
			if (!shipState || !shipState.occupants.includes(playerId)) return;
			const usedIndices = shipState.usedActionIndices ?? (shipState.actionsUsed != null ? [] : []);
			if (usedIndices.includes(actionIndex)) return;
			if (usedIndices.length >= 3) return;

			// --- 트왈라잇 ---
			if (shipTile.type === 'ship_twilight') {
				if (actionIndex === 1) {
					if (player.qic < 3) return;
					player.qic -= 3;
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					game.pendingTwilightFederation = { playerId, shipTileId };
					// [로그 정리 2026-08-03 사용자] adv-vp-qic-action(+4VP)을 여기서 적용하면 이 시점엔 이 액션의 로그가
					//   아직 없어(보상 선택 후에야 로그가 남음) '+4VP'만 빈 줄로 따로 떴다. 다른 우주선 첫 칸들처럼
					//   '액션 로그 뒤 병합'이 되도록, 보상 확정 시점(confirm_twilight_federation)으로 미룬다.
					game.hasDoneMainAction = true; // 우주선 액션 = 파워액션과 동일, 한 턴에 하나
					clampPlayerResources(game); emitGameUpdated(io, game);
					return;
				}
				if (actionIndex === 2) {
					if (!targetTileId) return;
					const target = game.map.find(t => t.id === targetTileId);
					if (!target || target.ownerId !== playerId || target.structure !== 'trading_station') return;
					// [버그수정 2026-07-08 사용자: 매안 연구소 4개] 우주선(트왈라잇) TS→연구소도 건물 상한(3) 적용 — 일반 업글만 체크하던 누락 교정.
					if (getStructureCount(game, playerId, 'research_lab') >= BUILDING_LIMITS.research_lab) return;
					{ const tok = shipPowerTokens(3);
					if (player.ore < 2) return;
					if (player.faction === 'taklons') { if (!canSpendTaklonsPower(player, 3, 3)) return; } else if (player.power3 < tok) return;
					player.ore -= 2;
					if (player.faction === 'taklons') { spendTaklonsPower(player, 3, 3, player.taklonsBrainPriority ?? true); }
					else { player.power3 -= tok; player.power1 += tok; } }
					target.structure = 'research_lab';
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					/* build_research_lab 라운드 미션은 건물 로그 직후에 처리(로그 같은 줄에 +VP 병합) */
					addGameLog(game, playerId, 'Twilight: TS → Research Lab', '2O, 3P (no 3O 5C)', targetTileId, { actionIndex, shipTileId }); applyRoundMissionScore(game, playerId, 'build_research_lab');
					// 일반 TS→Lab 업그레이드와 동일하게: 인접 상대에게 파워 제공 + 인접 연방 편입 (우주선 액션 경로 누락 버그 수정)
					createPowerOffers(game, target, playerId);
					addBuildingToFederationIfAdjacent(game, playerId, target.id);
					game.pendingTechTileSelection = { playerId, tileId: targetTileId, structureType: 'research_lab' };
					// 연구소 건설 시 6트랙+풀+우주선 기술 타일 모두 선택 가능 (동일 플로우)
					game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
					game.hasDoneMainAction = true;
					clampPlayerResources(game); emitGameUpdated(io, game);
					return;
				}
				if (actionIndex === 3) {
					// 1K로 +3 거리: 이번 턴에 광산/포밍 등 추가 행동 후 End Turn (메인 액션으로 처리하지 않음)
					if (player.knowledge < 1) return;
					player.knowledge -= 1;
					player.tempRangeBonus = true;
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					addGameLog(game, playerId, 'Twilight: +3 Range', '1K (this turn)', shipTileId, { actionIndex, shipTileId });
					// hasDoneMainAction 설정하지 않음 → 같은 턴에 광산 건설/가이아포밍 등 후 End Turn
					clampPlayerResources(game); emitGameUpdated(io, game);
					return;
				}
			}

			// --- Rebellion ---
			if (shipTile.type === 'ship_rebellion') {
				if (actionIndex === 1) {
					if (player.qic < 3) return;
					player.qic -= 3;
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					// 연구소/아카데미와 동일: 6트랙+풀+우주선 기술 타일 모두 선택 가능
					game.pendingTechTileSelection = { playerId, tileId: '', structureType: 'rebellion_gain' };
					game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
					addGameLog(game, playerId, 'Rebellion: Gain tech tile', '3 QIC (choose tile + track advance)', shipTileId, { actionIndex, shipTileId });
					applyAdvancedTechTileEffect(game, playerId, 'qic_action'); // 첫 칸=QIC액션 → adv-vp-qic-action +4VP (누락 버그 수정)
					game.hasDoneMainAction = true;
					clampPlayerResources(game); emitGameUpdated(io, game);
					return;
				}
				if (actionIndex === 2) {
					const tid = targetTileId != null ? String(targetTileId) : '';
					if (!tid) return;
					const target = game.map.find(t => t.id === tid || String(t.id) === tid);
					if (!target || target.ownerId !== playerId || target.structure !== 'mine') return;
					// [버그수정 2026-07-08] 리벨리온 mine→TS도 교역소 상한(4) 적용 — 우주선 경로 상한 누락(트왈 연구소 버그와 동일 클래스).
					if (getStructureCount(game, playerId, 'trading_station') >= BUILDING_LIMITS.trading_station) return;
					{ const tok = shipPowerTokens(3);
					if (player.ore < 1) return;
					if (player.faction === 'taklons') { if (!canSpendTaklonsPower(player, 3, 3)) return; } else if (player.power3 < tok) return;
					player.ore -= 1;
					if (player.faction === 'taklons') { spendTaklonsPower(player, 3, 3, player.taklonsBrainPriority ?? true); }
					else { player.power3 -= tok; player.power1 += tok; } }
					target.structure = 'trading_station';
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					applyRoundMissionScore(game, playerId, 'build_trading_station');
					applyAdvancedTechTileEffect(game, playerId, 'build_ts'); // adv-vp-build-ts(+3VP) — 리벨리온 Mine→TS도 '교역소 건설'로 취급(누락 수정, 사용자 관찰)
					addGameLog(game, playerId, 'Rebellion: Mine → TS', '1O, 3P (no 2O 3C/6C)', targetTileId, { actionIndex, shipTileId });
					createPowerOffers(game, target, playerId);
					addBuildingToFederationIfAdjacent(game, playerId, target.id);
					game.hasDoneMainAction = true;
					clampPlayerResources(game); emitGameUpdated(io, game);
					return;
				}
				if (actionIndex === 3) {
					if (player.knowledge < 2) return;
					player.knowledge -= 2;
					grantQic(game, playerId, 1);
					player.credits += 2;
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					addGameLog(game, playerId, 'Rebellion: 2K → 1Q 2C', '', shipTileId, { actionIndex, shipTileId });
					game.hasDoneMainAction = true;
					clampPlayerResources(game); emitGameUpdated(io, game);
					return;
				}
			}

			// --- TF Mars ---
			if (shipTile.type === 'ship_tf_mars') {
				if (actionIndex === 1) {
					if (player.qic < 2) return;
					player.qic -= 2;
					const count = (player.techTiles ?? []).filter(id => !isTechTileCovered(player, id)).length; // 고급 타일에 덮인 일반 타일은 제외
					addScore(game, playerId, count + 2, 'spaceships', { shipTileId: shipTile.id, shipType: 'ship_tf_mars', actionIndex, noLog: true });
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					addGameLog(game, playerId, 'TF Mars: Tech tiles + 2 VP', `${count + 2} VP`, shipTileId, { actionIndex, shipTileId });
					applyAdvancedTechTileEffect(game, playerId, 'qic_action'); // 첫 칸=QIC액션 → adv-vp-qic-action +4VP (누락 버그 수정)
					game.hasDoneMainAction = true;
					clampPlayerResources(game); emitGameUpdated(io, game);
					return;
				}
				if (actionIndex === 2) {
					if (player.faction === 'taklons') { if (!canSpendTaklonsPower(player, 3, 2)) return; } else if (player.power3 < shipPowerTokens(2)) return; // Nevlas 의회: 2pw=1토큰
					if (getEffectiveGaiaformers(player) < 1) {
						socket.emit('game_error', { message: '사용 가능한 가이아포머가 없습니다.' });
						return;
					}
					if (player.faction === 'taklons') { spendTaklonsPower(player, 3, 2, player.taklonsBrainPriority ?? true); }
					else { player.power3 -= shipPowerTokens(2); player.power1 += shipPowerTokens(2); }
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					game.pendingTFMarsGaiaProject = { playerId, shipTileId };
					addGameLog(game, playerId, 'TF Mars: Gaia Project', '2P → place Gaiaformer (same as bonus tile)', shipTileId, { actionIndex, shipTileId });
					game.hasDoneMainAction = true; // 가이아포머 배치는 후속 선택이지만 턴은 이미 소모
					clampPlayerResources(game); emitGameUpdated(io, game);
					return;
				}
				if (actionIndex === 3) {
					// 3C로 1테라포밍 단계 (연구 보드 3PW 1테라포밍 / 보너스 타일 1테라포밍과 동일) → 광산 건설 시 할인 적용
					if (player.credits < 3) return;
					player.credits -= 3;
					player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 1;
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					addGameLog(game, playerId, 'TF Mars: 3C → 1 Terraform', '(same as 3PW or bonus 1 Step, use when building)', shipTileId, { actionIndex, shipTileId });
					// 같은 턴에 광산 건설 시 테라포밍 할인 받을 수 있도록 hasDoneMainAction 설정하지 않음
					clampPlayerResources(game); emitGameUpdated(io, game);
					return;
				}
			}

			// --- Eclipse ---
			if (shipTile.type === 'ship_eclipse') {
				if (actionIndex === 1) {
					if (player.qic < 2) return;
					player.qic -= 2;
					const structures = game.map.filter(t => t.ownerId === playerId && t.structure);
					void structures; const types = getPlayerPlanetTypesForGeodens(game, playerId); /* 잊혀진 행성(lost_planet)·가상광산 포함 정식 행성유형 집합 — 기존 naive 계산은 space타일의 lost_planet_mine을 놓쳐 미카운트(사용자 관찰) */
					addScore(game, playerId, types.size + 2, 'spaceships', { shipTileId: shipTile.id, shipType: 'ship_eclipse', actionIndex, noLog: true });
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					addGameLog(game, playerId, 'Eclipse: Planet types + 2 VP', `${types.size + 2} VP`, shipTileId, { actionIndex, shipTileId });
					applyAdvancedTechTileEffect(game, playerId, 'qic_action'); // 첫 칸=QIC액션 → adv-vp-qic-action +4VP (누락 버그 수정)
					game.hasDoneMainAction = true;
					clampPlayerResources(game); emitGameUpdated(io, game);
					return;
				}
				if (actionIndex === 2) {
					// 2K+3P 지불 후 원하는 연구 트랙을 선택해 1칸 진행
					if (player.knowledge < 2) return;
					if (player.faction === 'taklons') {
						if (!canSpendTaklonsPower(player, 3, 3)) return;
					} else if ((player.power3 ?? 0) < shipPowerTokens(3)) {
						return;
					}
					// [취소 정확도 2026-08-07 사용자] 지불 직전 스냅샷 — 취소 시 종족별 경로(타클론 브레인/네블라 환산)를 정확히 되돌린다
					const preEclipse = { knowledge: player.knowledge ?? 0, power1: player.power1 ?? 0, power2: player.power2 ?? 0, power3: player.power3 ?? 0, brainStoneBowl: (player as any).brainStoneBowl };
					player.knowledge -= 2;
					if (player.faction === 'taklons') {
						// [버그수정 2026-08-10] useBrain을 true로 못박아 '브레인 보존' 설정을 무시했다 —
						//   같은 핸들러의 다른 배 액션 3곳(:4265 :4329 :4384)은 모두 taklonsBrainPriority를 따른다.
						//   보존을 골라도 3그릇 브레인이 항상 소모돼 큰 액션용으로 아껴둘 수 없었다.
						//   (보존인데 일반토큰이 모자라면 spendTaklonsPower가 알아서 브레인으로 폴백하므로 액션은 막히지 않는다)
						spendTaklonsPower(player, 3, 3, player.taklonsBrainPriority ?? true);
					} else {
						player.power3 -= shipPowerTokens(3);
						player.power1 = (player.power1 || 0) + shipPowerTokens(3);
					}
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					game.pendingEclipseResearch = { playerId, shipTileId, pre: preEclipse };
					addGameLog(game, playerId, 'Eclipse: 2K+3P → Research', '(choose track)', shipTileId, { actionIndex, shipTileId });
					game.hasDoneMainAction = true;
					clampPlayerResources(game); emitGameUpdated(io, game);
					return;
				}
				if (actionIndex === 3) {
					// 6C 지불 후 소행성 선택 시 광산 건설 (선택 완료 시점에 hasDoneMainAction 설정)
					if (player.credits < 6) return;
					// 건설 가능한 빈 소행성(사거리 내)이 없으면 6C 지불 후 스터을 방지하기 위해 액션 자체를 막음
					if (peekEclipseAsteroidMineTileIds(game, playerId).length === 0) {
						socket.emit('game_error', { message: '건설 가능한 소행성(빈 소행성, 사거리 내)이 없어 이 액션을 쓸 수 없습니다.' });
						return;
					}
					player.credits -= 6;
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					game.pendingEclipseAsteroidMine = { playerId, shipTileId };
					addGameLog(game, playerId, 'Eclipse: 6C → Build mine on asteroid', '(select tile)', shipTileId, { actionIndex, shipTileId });
					// hasDoneMainAction은 소행성 선택 후 eclipse_build_asteroid_mine에서 설정
					clampPlayerResources(game); emitGameUpdated(io, game);
					return;
				}
			}

			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		// 트왈라잇 인공물 가져가기 (우주선에 있는 플레이어만, 6파워 1→2→3 순 소모)
		socket.on('take_twilight_artifact', ({ gameId, artifactId }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (councilPendingActive(game)) return; // 아이타/테란 의회 선택 대기 중 — 라운드 첫 액션 보류
			if (game.hasDoneMainAction) return;
			const player = game.players[playerId];
			const entered = player.spaceshipsEntered ?? [];
			const twilightTile = game.map.find(t => t.type === 'ship_twilight');
			if (!twilightTile || !entered.includes(twilightTile.id)) return;
			const slots = game.twilightArtifactSlots ?? [];
			const slotIdx = slots.findIndex(s => s === artifactId);
			if (slotIdx === -1 || !ARTIFACTS.some(a => a.id === artifactId)) return;
			if (!spendPowerTokens(player, 6)) return;

			saveActionStartState(game, playerId);
			(game.twilightArtifactSlots as (string | null)[])[slotIdx] = null;
			if (!player.artifacts) player.artifacts = [];
			player.artifacts.push(artifactId);

			const art = ARTIFACTS.find(a => a.id === artifactId)!;
			if (art.id === 'art-fed-once') {
				game.pendingTwilightFederation = { playerId, shipTileId: twilightTile.id, fromArtifact: true };
				addGameLog(game, playerId, 'Artifact: Federation benefit', 'Choose one federation reward', art.id);
			} else if (art.id === 'art-vp-gaia') {
				const lvl = player.research.gaiaProject ?? 0;
				const vp = lvl * 3;
				addScore(game, playerId, vp, 'other', { source: 'Artifact: Gaia x 3' });
				addGameLog(game, playerId, 'Artifact: Gaia×3 VP', `${lvl}×3 = ${vp} VP`, art.id);
			} else if (art.id === 'art-vp-science') {
				const lvl = player.research.science ?? 0;
				const vp = lvl * 3;
				addScore(game, playerId, vp, 'other', { source: 'Artifact: Science x 3' });
				addGameLog(game, playerId, 'Artifact: Science×3 VP', `${lvl}×3 = ${vp} VP`, art.id);
			} else if (art.id === 'art-vp-tracks3') {
				const tracks = (['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'] as ResearchTrack[]).filter(t => (player.research[t] ?? 0) >= 3).length;
				const vp = tracks * 3;
				addScore(game, playerId, vp, 'other', { source: 'Artifact: Tracks >= 3' });
				addGameLog(game, playerId, 'Artifact: Tracks≥3×3 VP', `${tracks}×3 = ${vp} VP`, art.id);
			} else if (art.id === 'art-vp-planet-types') {
				// [버그수정 2026-07-26, 사용자 관찰] naive tile.type 카운트는 잊혀진 행성(space 타일 위 lost_planet_mine)을
				// 놓쳐 상태창(정본 fm_planet_types와 동일 규칙)보다 1 적게 정산 — 3889행에서 이미 고친 것과 동일 부류.
				// 정본 헬퍼로 통일(lost_planet·가상광산 포함, 란티다 기생 제외).
				const types = getPlayerPlanetTypesForGeodens(game, playerId);
				const vp = 3 + types.size;
				addScore(game, playerId, vp, 'other', { source: 'Artifact: Planet types' });
				addGameLog(game, playerId, 'Artifact: 3+Planet types VP', `3+${types.size} = ${vp} VP`, art.id);
			} else if (art.id === 'art-7vp-virtual-asteroid') {
				const geodensTypesBeforeArt = getPlayerPlanetTypesForGeodens(game, playerId);
				addScore(game, playerId, 7, 'other', { source: 'Artifact: 7 VP + Asteroid', noLog: true }); // 전용 로그가 바로 아래 — 자동로그 중복 제거(사용자)
				player.virtualMineAsteroid = true;
				addGameLog(game, playerId, 'Artifact: 7 VP + virtual mine (asteroid)', '', art.id);
				applyRoundMissionScore(game, playerId, 'build_mine'); // 가상 광산도 '광산 건설' 라운드 미션(+2) 대상 — 실제/기생/잊혀진 광산과 동일(사용자 관찰)
					applyAdvancedTechTileEffect(game, playerId, 'build_mine'); // adv-vp-build-mine(+3VP) — 가상광산(소행성)도 '광산 건설'로 취급(누락 수정, 사용자 관찰)
				// 가상 광산도 새 행성 유형으로 취급 → 라운드 미션(유형당) + Geodens 의회 보너스 (실제 광산 건설과 동일)
				if (getPlayerPlanetTypesForGeodens(game, playerId).size > geodensTypesBeforeArt.size) {
					applyRoundMissionScore(game, playerId, 'new_planet_type');
				}
				applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeArt);
			} else if (art.id === 'art-7vp-virtual-proto') {
				const geodensTypesBeforeArtProto = getPlayerPlanetTypesForGeodens(game, playerId);
				addScore(game, playerId, 7, 'other', { source: 'Artifact: 7 VP + Proto', noLog: true }); // 전용 로그가 바로 아래 — 자동로그 중복 제거(사용자)
				player.virtualMineProto = true;
				addGameLog(game, playerId, 'Artifact: 7 VP + virtual mine (proto)', '', art.id);
				applyRoundMissionScore(game, playerId, 'build_mine'); // 가상 광산도 '광산 건설' 라운드 미션(+2) 대상(사용자 관찰)
					applyAdvancedTechTileEffect(game, playerId, 'build_mine'); // adv-vp-build-mine(+3VP) — 가상광산(프로토)도 '광산 건설'로 취급(누락 수정, 사용자 관찰)
				if (getPlayerPlanetTypesForGeodens(game, playerId).size > geodensTypesBeforeArtProto.size) {
					applyRoundMissionScore(game, playerId, 'new_planet_type');
				}
				applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeArtProto);
			} else if (art.id === 'art-imm-3o3c') {
				player.ore = (player.ore || 0) + 3;
				player.credits = (player.credits || 0) + 3;
				addGameLog(game, playerId, 'Artifact: 3O 3C', '', art.id);
			} else if (art.id === 'art-imm-2o5c') {
				player.ore = (player.ore || 0) + 2;
				player.credits = (player.credits || 0) + 5;
				addGameLog(game, playerId, 'Artifact: 2O 5C', '', art.id);
			} else if (art.id === 'art-imm-3k1q') {
				player.knowledge = (player.knowledge || 0) + 3;
				grantQic(game, playerId, 1);
				addGameLog(game, playerId, 'Artifact: 3K 1Q', '', art.id);
			} else if (art.id === 'art-vp-bridge') {
				const bridgeSectors = [11, 12, 13, 14, 15, 16, 17, 18];
				const withBuilding = bridgeSectors.filter(s => game.map.some(t => t.sector === s && tileOccupiesSector(t, playerId)));
				const vp = withBuilding.length * 3;
				addScore(game, playerId, vp, 'other', { source: 'Artifact: Bridge VP' });
				addGameLog(game, playerId, 'Artifact: Bridge sections×3 VP', `${withBuilding.length}×3 = ${vp} VP`, art.id);
			} else {
				addGameLog(game, playerId, 'Artifact', art.label, art.id);
			}

			game.hasDoneMainAction = true;
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		// TF Mars 액션2 / 보너스 타일 가이아 프로젝트: 건너뛰기 (가이아포머 없거나 배치 불가 시)
		socket.on('skip_tfmars_gaia_project', ({ gameId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const pending = game.pendingTFMarsGaiaProject;
			if (!pending || pending.playerId !== playerId) return;
			const isBonusGaia = pending.shipTileId === 'bonus-gaia';
			game.pendingTFMarsGaiaProject = null;

			if (isBonusGaia) {
				// 보너스 타일 가이아 프로젝트 건너뛰기 -> 타일 반납 및 패스하지 않음. 턴만 종료하도록 유도.
				addGameLog(game, playerId, 'Bonus: Gaia Project', 'skipped (no placement)', 'bonus-gaia');
				game.hasDoneMainAction = true; // 메인 액션 소모함
			} else {
				// TF Mars 액션2 스킵
				addGameLog(game, playerId, 'TF Mars: Gaia Project', 'skipped', pending.shipTileId);
				game.hasDoneMainAction = true;
			}

			clampPlayerResources(game);
			emitGameUpdated(io, game);
		});

		// Eclipse 액션2 취소: 자원과 사용 횟수 롤백
		socket.on('cancel_eclipse_research', ({ gameId }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			// [버그수정 2026-08-10 사용자 제보 "타클론 2K+3P 취소하면 토큰이 생김"]
			//   여기서 knowledge+2 / power3+3 / power1-3을 하드코딩 환불하던 것 → executeCancelEclipseResearch로 위임.
			//   지불부(:4439)가 남기는 pre 스냅샷을 그 함수가 그대로 되돌린다. 하드코딩은 종족별 지불 경로와 어긋났다:
			//   타클론이 브레인(=3파워)으로 내면 power3는 줄지 않고 브레인만 3그릇→1그릇인데, 환불은 power3에 3개를
			//   새로 만들고 넣은 적 없는 power1에서 3개를 빼려 해 토큰이 통째로 늘었다(네블라 의회 반값 환산도 동일).
			//   795d59a가 봇 폴백용 executeCancelEclipseResearch만 고치고 이 사람용 핸들러를 놓쳤던 것.
			executeCancelEclipseResearch(io, game, playerId);
		});

		// Eclipse 액션3(6C 소행성) 취소: 6C 환불 + 액션 사용 롤백 (건설 가능 소행성이 없을 때 진행 불가 해소)
		socket.on('cancel_eclipse_asteroid_mine', ({ gameId }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const pending = game.pendingEclipseAsteroidMine;
			if (!pending || pending.playerId !== playerId) return;
			const player = game.players[playerId];
			player.credits = (player.credits || 0) + 6; // 6C 환불
			const shipState = game.spaceships?.[pending.shipTileId];
			if (shipState && shipState.usedActionIndices) {
				shipState.usedActionIndices = shipState.usedActionIndices.filter(idx => idx !== 3);
				shipState.actionsUsed = shipState.usedActionIndices.length;
				if (shipState.usedActionBy) delete shipState.usedActionBy[3];
			}
			game.pendingEclipseAsteroidMine = null;
			// [로그 잔류 버그수정] 취소한 액션의 placeholder "Eclipse: 6C → Build mine on asteroid (select tile)" 제거
			//   (기존엔 placeholder를 남긴 채 별도 '취소' 줄을 더해 '지었다 취소'처럼 보였음 — research 취소와 동일 처리).
			removeLastGameLogEntry(game, playerId, 'Eclipse: 6C → Build mine on asteroid');
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		// Eclipse 액션2: 선택한 연구 트랙 1칸 진행 (비용은 이미 use_ship_action에서 차감됨)
		socket.on('eclipse_advance_track', ({ gameId, trackId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			executeEclipseAdvanceTrack(io, game, playerId, trackId);
		});

		// Eclipse 액션3: 6C 지불 후 소행성 광산 건설 (가이아포머 소모 없음)
		socket.on('eclipse_build_asteroid_mine', ({ gameId, tileId, qicToSpend }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			executeEclipseBuildAsteroidMine(io, game, playerId, tileId, qicToSpend);
		});

		// 트왈라잇 액션1: 보유 연방 중 하나 선택 후 해당 해택 재수령 (federation reward id)
		socket.on('confirm_twilight_federation', ({ gameId, rewardId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const pending = game.pendingTwilightFederation;
			if (!pending || pending.playerId !== playerId) return;
			const player = game.players[playerId];
			const myFed = getFederationEntries(player);
			if (!rewardId || !myFed.some((f) => f.rewardId === rewardId)) return;

			const normalReward = FEDERATION_REWARDS.find(r => r.id === rewardId)
				|| (rewardId === GLEENS_FEDERATION_REWARD.id ? GLEENS_FEDERATION_REWARD : undefined);
			const shipReward = SPACESHIP_FEDERATION_REWARDS.find(r => r.id === rewardId);

			if (normalReward) {
				addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Federation benefit' : 'Twilight: Federation benefit', normalReward.label, rewardId);
				addScore(game, playerId, normalReward.vp, 'spaceships', { shipTileId: pending.shipTileId, shipType: 'ship_twilight', actionIndex: 1, noLog: true });
				if ('ore' in normalReward && normalReward.ore) player.ore += normalReward.ore;
				if ('credits' in normalReward && normalReward.credits) player.credits += normalReward.credits;
				if ('knowledge' in normalReward && normalReward.knowledge) player.knowledge += normalReward.knowledge;
				if ('qic' in normalReward && normalReward.qic) grantQic(game, playerId, normalReward.qic);
				if ('powerTokens' in normalReward && normalReward.powerTokens) player.power1 = (player.power1 || 0) + normalReward.powerTokens;
			} else if (shipReward) {
				switch (rewardId) {
					case 'ship-fed-tech':
						game.pendingTechTileSelection = { playerId, tileId: '', structureType: 'rebellion_gain' };
						game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
						addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', shipReward.label, rewardId);
						break;
					case 'ship-fed-4vp4k':
						addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', shipReward.label, rewardId);
						addScore(game, playerId, 4, 'spaceships', { shipTileId: pending.shipTileId, shipType: 'ship_twilight', actionIndex: 1, noLog: true });
						player.knowledge = (player.knowledge || 0) + 4;
						break;
					case 'ship-fed-4vp1q2o':
						addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', shipReward.label, rewardId);
						addScore(game, playerId, 4, 'spaceships', { shipTileId: pending.shipTileId, shipType: 'ship_twilight', actionIndex: 1, noLog: true });
						grantQic(game, playerId, 1); player.ore = (player.ore || 0) + 2;
						break;
					case 'ship-fed-8vp8c':
						addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', shipReward.label, rewardId);
						addScore(game, playerId, 8, 'spaceships', { shipTileId: pending.shipTileId, shipType: 'ship_twilight', actionIndex: 1, noLog: true });
						player.credits = (player.credits || 0) + 8;
						break;
					case 'ship-fed-12vp':
						addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', shipReward.label, rewardId);
						addScore(game, playerId, 12, 'spaceships', { shipTileId: pending.shipTileId, shipType: 'ship_twilight', actionIndex: 1, noLog: true });
						break;
					case 'ship-fed-7vp3p2t':
						addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', shipReward.label, rewardId);
						addScore(game, playerId, 7, 'spaceships', { shipTileId: pending.shipTileId, shipType: 'ship_twilight', actionIndex: 1, noLog: true });
						player.power3 = (player.power3 || 0) + 2; // [수정] ship-fed-7vp3p2t: 그릇3에 토큰 2개(충전됨)
						break;
					case 'ship-fed-mine-free':
					case 'ship-fed-3tf-mine':
						addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', `${shipReward.label} (재수령은 즉시 효과만)`, rewardId);
						if (shipReward.id === 'ship-fed-3tf-mine') {
							player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 3;
							player.spaceshipFed3TfMineFree = true;
							log(`Player ${player.name} received 3 terraform steps from ship-fed-3tf-mine`, 'game', undefined, { simulation: (game as any).simulation });
						}
						break;
					default:
						return;
				}
			} else {
				return;
			}
			// [로그 정리 2026-08-03 사용자] 트왈 첫 칸(3QIC)의 adv-vp-qic-action(+4VP)을 여기서 적용 —
			//   바로 위에서 이 액션의 로그가 남았으므로 '(+4VP Advanced QIC action)'이 그 줄 뒤에 병합된다.
			//   인공물 경로(fromArtifact)는 QIC 액션이 아니므로 제외.
			if (!pending.fromArtifact) applyAdvancedTechTileEffect(game, playerId, 'qic_action');
			game.pendingTwilightFederation = null;
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		// Transdim에 가이아 포머 설치
		socket.on('place_gaiaformer', ({ gameId, tileId, qicUsed }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (councilPendingActive(game)) { socket.emit('game_error', { message: '다른 플레이어의 선택(의회/이클립스)이 진행 중입니다. 완료되면 이어집니다.' }); return; }
			// 실패 사유는 요청자에게만 (방 전체 브로드캐스트 X)
			executePlaceGaiaformer(io, game, playerId, tileId, qicUsed, (message) => socket.emit('game_error', { message }));
		});

		// 하이브(이비츠) 우주정거장 배치: 빈 공간(space/deep_space), 내 건물·우주정거장에서 거리 계산, Nav 범위 밖이면 2거리당 1 QIC. 다른 플레이어 위성 허용, 내 위성 있으면 불가. 라운드당 1회.
		socket.on('place_ivits_space_station', ({ gameId, tileId }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
			if (councilPendingActive(game)) return; // 아이타/테란 의회 선택 대기 중 — 라운드 첫 액션 보류
			if (game.hasDoneMainAction) return;

			const player = game.players[playerId];
			if (player.faction !== 'ivits') return;
			if (player.usedIvitsSpaceStationThisRound) return;

			const tile = game.map.find(t => t.id === tileId);
			if (!tile) return;
			if (tile.type !== 'space' && tile.type !== 'deep_space') return;
			if (tile.structure !== null || tile.spaceStation) return;
			const satellites = game.satellites || {};
			const onTile = Array.isArray(satellites[tileId]) ? satellites[tileId]! : (satellites[tileId] ? [satellites[tileId] as string] : []);
			if (onTile.includes(playerId)) return; // 내 위성 있는 칸에는 설치 불가

			const rangeTiles = getPlayerRangeTiles(game, playerId);
			if (rangeTiles.length === 0) return;
			let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
			// [증발 방지 2026-08-01] 글린즈 플래그 소모를 QIC 검증 뒤로 (Ivits 전용이라 현재 도달 불가지만 동일 패턴 정리)
			if (player.gleensNavBonusActive) baseRange += 2;
			const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
			const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
			if (player.qic < neededQIC) return;

			saveActionStartState(game, playerId);
			if (player.gleensNavBonusActive) player.gleensNavBonusActive = false;
			player.qic -= neededQIC;
			tile.spaceStation = { ownerId: playerId };
			player.usedIvitsSpaceStationThisRound = true;
			game.hasDoneMainAction = true;
			addBuildingToFederationIfAdjacent(game, playerId, tileId);
			addGameLog(game, playerId, 'Ivits: Space Station', neededQIC ? `${neededQIC} QIC (range)` : 'Placed (in Nav range)', tileId);
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		// 거리 5 보상 잊혀진 행성: 빈 우주(space/deep_space, 위성 없음)에 특수 광산 1개 배치. O 없음, 광산 보너스/패스/행성유형 포함, 업그레이드 불가.
		socket.on('place_lost_planet', ({ gameId, tileId, qicToSpend }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const ok = executePlaceLostPlanet(io, game as ServerGameState, playerId, tileId, qicToSpend);
			// 실패 시 침묵하지 않고 사유 안내 (기존엔 확인을 눌러도 아무 반응이 없던 문제)
			if (!ok) socket.emit('game_error', { message: '잊혀진 행성을 배치할 수 없습니다 — 사거리/QIC 부족, 광산 한도(8개) 초과, 또는 위성·건물이 있는 칸인지 확인하세요.' });
		});

		socket.on('upgrade_structure', ({ gameId, tileId, target }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (councilPendingActive(game)) { socket.emit('game_error', { message: '다른 플레이어의 선택(의회/이클립스)이 진행 중입니다. 완료되면 이어집니다.' }); return; }
			if (hasActiveRangeBonus(game.players[playerId])) { socket.emit('game_error', { message: RANGE_BONUS_BLOCK_MSG }); return; }

			executeUpgradeStructure(io, game, playerId, tileId, target);
		});
		socket.on('select_tech_tile', ({ gameId, techTileId, trackId, advanceToLevel5 }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;

			executeSelectTechTile(io, game, playerId, techTileId, trackId, advanceToLevel5);
		});

		socket.on('reset_turn', ({ gameId }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;
			if (game.pendingTurnEndPlayerId === playerId) { socket.emit('game_error', { message: '파워 수락 대기 중에는 리셋할 수 없습니다.' }); return; }
			// 현재 턴 플레이어만 자기 턴 시작 스냅샷으로 복구 (다른 소켓/착오 방지)
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
			// [사용자 2026-08-01 제보 "6C 액션+프리액션 후 Reset"] 이클립스 6C/2K+3P 대기는 '내 턴의 내 보류'라
			// 전체 복원이 비용(6C/2K+3P)까지 정확히 되돌린다 → 리셋 허용. 기존엔 councilPendingActive에 묶여
			// 조용히 무시됐고(무반응), 사용자는 리셋된 줄 알고 이어가다 상태가 꼬였다. 아이타/테란/팅커 의회 등
			// 다른 플레이어와 얽힌 대기는 기존대로 차단하되 이유를 토스트로 안내.
			const councilBlockedNonEclipse = !!(game.pendingItarsGaiaformerExchange || game.pendingTerranCouncilBenefit
				|| (game as any).pendingTinkeroidSpecialChoice
				|| (game.terranCouncilQueue?.length ?? 0) > 0
				|| ((game as any).terranCouncilQueueAfterItars?.length ?? 0) > 0
				|| ((game as any).pendingTechTileSelection?.structureType === 'itars_pi_exchange')
				|| (game.pendingEclipseAsteroidMine && game.pendingEclipseAsteroidMine.playerId !== playerId)
				|| (game.pendingEclipseResearch && game.pendingEclipseResearch.playerId !== playerId));
			if (councilBlockedNonEclipse) { socket.emit('game_error', { message: '다른 플레이어의 선택(의회 등)이 처리 중이라 지금은 리셋할 수 없습니다.' }); return; }
			const startState = game.turnStartState?.[playerId];
			if (!startState) { socket.emit('game_error', { message: '이 턴의 시작 스냅샷이 없어 리셋할 수 없습니다.' }); return; }
			if (startState.playerId && startState.playerId !== playerId) return;
			if (typeof startState.roundNumber === 'number' && startState.roundNumber !== game.roundNumber) return;
			if (typeof startState.currentPlayerIndex === 'number' && startState.currentPlayerIndex !== game.currentPlayerIndex) return;

			log(`Player ${game.players[playerId].name} reset turn`, 'game', undefined, { simulation: (game as any).simulation });

			if (startState.fullGameState) {
				// 전체 상태 복구 (기술 타일 트랙, 풀, 맵, 플레이어 데이터 등 모두 포함)
				const restored = deepClone(startState.fullGameState) as ServerGameState;
				restored.gameLog = restoreGameLogForReset(game, startState, playerId);
				restored.humanActionJournal = startState.humanActionJournalState
					? deepClone(startState.humanActionJournalState)
					: (game.humanActionJournal || []).slice(0, startState.humanActionJournalLength || 0);
				clearFreeActionUndo(restored);

				// 복원된 상태만 기준으로 turnStartState 재구성 (라이브 game.turnStartState 통째 할당 금지 — 타인/과거 스냅샷 혼입 방지)
				restored.turnStartState = {
					[playerId]: buildTurnStartStateEntryForPlayer(restored, playerId),
				};

				hideHeavyServerFields(restored);
				games.set(gameId, restored);

				clampPlayerResources(restored);
				emitGameUpdated(io, restored); // [대역폭 2026-08-07] 전체 로그 직접 emit → 헬퍼 경유(꼬리40 델타)
			} else {
				// 하위 호환성용 (기존 필드 복구)
				game.players[playerId] = deepClone(startState.playerState);
				game.map = deepClone(startState.mapState);
				if (startState.spaceshipsState) game.spaceships = deepClone(startState.spaceshipsState);
				if (startState.twilightArtifactSlots) game.twilightArtifactSlots = deepClone(startState.twilightArtifactSlots);
				game.gameLog = restoreGameLogForReset(game as ServerGameState, startState, playerId);
				game.humanActionJournal = startState.humanActionJournalState
					? deepClone(startState.humanActionJournalState)
					: (game.humanActionJournal || []).slice(0, startState.humanActionJournalLength || 0);
				game.hasDoneMainAction = false;
				clearFreeActionUndo(game as ServerGameState);
				game.turnStartState = {
					[playerId]: buildTurnStartStateEntryForPlayer(game as ServerGameState, playerId),
				};
				clampPlayerResources(game);
				emitGameUpdated(io, game);
			}
		});

		/** 아이타 의회: 가이아포머 토큰 4개 제거하고 기술 타일 1개 vs 그만하고 나머지 1그릇 복귀 */
		socket.on('itars_gaiaformer_exchange_choice', ({ gameId, takeTile }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const pending = game.pendingItarsGaiaformerExchange;
			if (!pending || (pending.playerId !== playerId && game.hostId !== playerId)) return;
			const targetPlayerId = pending.playerId;
			const player = game.players[targetPlayerId];
			const tokensRemaining = pending.tokensRemaining;
			game.pendingItarsGaiaformerExchange = null;

			if (takeTile && tokensRemaining >= 4) {
				const after = tokensRemaining - 4;
				game.itarsGaiaformerRemainingAfterTech = after;
				game.pendingTechTileSelection = { playerId, tileId: '', structureType: 'itars_pi_exchange' };
				// [룰 2026-07-13 사용자 확정] 아이타 의회 교환에서도 (탑승한 배의) 우주선 기술타일 선택 가능 —
				// 연구소/아카데미/리벨리온 획득과 동일 풀. 이 필드가 없으면 UI 미표시 + 선택 검증 거부.
				game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
				addGameLog(game, playerId, 'Itars PI', '4 tokens → 1 Tech Tile (choose tile + track)');
				clampPlayerResources(game); emitGameUpdated(io, game);
				return;
			}
			player.power1 = (player.power1 || 0) + tokensRemaining;
			if (tokensRemaining > 0) addGameLog(game, playerId, 'Itars PI', `${tokensRemaining} tokens → Bowl 1`);
			// [hang수정 2026-07-07] 소켓 핸들러 내 예외는 조용히 죽어 액션 단계가 영영 시작 안 됨 — 가시화 + 최후 복구
			try {
				proceedAfterItarsGaiaformerOrTerran(game);
			} catch (e) {
				log(`[ITARS-CHAIN] proceedAfterItars(choice) EXCEPTION: ${(e as Error)?.stack || e}`, 'error', game.id);
				executeBotTurnIfNeeded(io, game as ServerGameState).catch(() => { /* 위에서 로깅됨 */ });
			}
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		socket.on('advance_tech', ({ gameId, trackId }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;
			// [버그수정 2026-07-31] 남의 파워 수령/수입 처리 중엔 연구 전진 불가(자기 pending 트랙전진은 mid-turn이라 pendingPowerOffers 없음 → 미차단).
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (councilPendingActive(game)) { socket.emit('game_error', { message: '다른 플레이어의 선택(의회/이클립스)이 진행 중입니다. 완료되면 이어집니다.' }); return; }
			// 거리 보너스가 진행 중인데 Eclipse/우주선 트랙 보상 진행이 아니면 막음
			if (hasActiveRangeBonus(game.players[playerId])
				&& game.pendingEclipseResearch?.playerId !== playerId
				&& game.pendingShipTechTrackAdvance?.playerId !== playerId
				&& game.pendingAdvancedTechTrackAdvance?.playerId !== playerId) {
				socket.emit('game_error', { message: RANGE_BONUS_BLOCK_MSG }); return;
			}

			// 보상 트랙 전진(고급기술/우주선기술)이 거부되면 무반응 대신 사유를 안내 (사용자 관찰: 가이아5 클릭 무반응)
			const player = game.players[playerId];
			const wasPendingAdvance = game.pendingAdvancedTechTrackAdvance?.playerId === playerId
				|| game.pendingShipTechTrackAdvance?.playerId === playerId;
			const lvlBefore = (player?.research as any)?.[trackId] ?? -1;
			const ok = executeAdvanceTech(io, game, playerId, trackId);
			if (!ok && wasPendingAdvance) {
				if (lvlBefore >= 5) {
					socket.emit('game_error', { message: '이미 5단계라 더 올릴 수 없습니다.' });
				} else if (lvlBefore === 4) {
					if (countGreenFederations(player) < 1) {
						socket.emit('game_error', { message: '5단계 진입에는 녹색 연방 토큰이 필요합니다. (고급 타일 획득에 이미 1개 사용했거나, 12점 연방은 녹색이 아닙니다)' });
					} else if (isTrackLevel5Taken(game, trackId as ResearchTrack, playerId)) {
						socket.emit('game_error', { message: '다른 플레이어가 이미 이 트랙 5단계에 있어 진입할 수 없습니다.' });
					} else {
						socket.emit('game_error', { message: '이 트랙을 5단계로 올릴 수 없습니다.' });
					}
				} else if (trackId === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) {
					socket.emit('game_error', { message: '발타크는 의회(PI)가 있어야 항해 트랙을 올릴 수 있습니다.' });
				} else {
					socket.emit('game_error', { message: '이 트랙을 전진할 수 없습니다.' });
				}
			}
		});


		socket.on('set_taklons_brain_priority', ({ gameId, value }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const player = game.players[playerId];
			if (!player || player.faction !== 'taklons') return;
			// 전역 토글: 파워 소비 시 브레인 스톤 우선 여부
			player.taklonsBrainPriority = !!value;
			emitGameUpdated(io, game);
		});

		socket.on('use_power_action', ({ gameId, actionId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (councilPendingActive(game)) { socket.emit('game_error', { message: '다른 플레이어의 선택(의회/이클립스)이 진행 중입니다. 완료되면 이어집니다.' }); return; }
			if (hasActiveRangeBonus(game.players[playerId])) { socket.emit('game_error', { message: RANGE_BONUS_BLOCK_MSG }); return; }
			executeUsePowerAction(io, game, playerId, actionId);
		});

		// 하드쉬 할라 의회 프리 액션: 4C→1QIC, 4C→1K, 3C→1O (Free Action — 크레딧 있으면 반복 사용 가능)
		// [사용자 2026-08-01] 수입/파워 수락 대기 중(배너 표시)에도 프리액션이 뚫려 토큰 이동(번/변환)이
		// 수입 파워 충전·leech 처리와 엉키던 문제 — 메인 액션과 동일하게 mainActionBlockedByPending으로 차단.
		socket.on('use_hadsch_hallas_pi_action', ({ gameId, actionId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (councilPendingActive(game)) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			executeUseHadschHallasPIAction(io, game as ServerGameState, playerId, actionId);
		});

		// 발타크 프리 액션: 1 포머 → 1 QIC (사용한 포머는 다음 라운드 시작까지 잠김, 가이아 토큰 표기)
		socket.on('use_bal_tak_gaiaformer_to_qic', ({ gameId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			// 프리액션은 자기 턴(메인 단계)에만 가능 — 서버 권위 검증
			if (game.currentPhase !== 'main') return;
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
			if (councilPendingActive(game)) return; // 아이타/테란 의회 선택 대기 중 — 라운드 첫 액션 보류
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			executeBalTakGaiaformerToQic(io, game, playerId);
		});

		socket.on('convert_resource', ({ gameId, type, useBrain }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			// 프리액션은 자기 턴(메인 단계)에만 가능 — 서버 권위 검증 (클라 버튼 비활성과 별개로 막음)
			if (game.currentPhase !== 'main') return;
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
			if (councilPendingActive(game)) return; // 아이타/테란 의회 선택 대기 중 — 라운드 첫 액션 보류
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }

			// Free Action을 수행하기 직전, 게임 상태 스냅샷 저장 (매 단계 저장)
			pushFreeActionUndoSnapshot(game);

			if (executeConvertResource(io, game, playerId, type, useBrain)) {
				// 이미 executeConvertResource에서 clamp 및 emit을 수행함
			}
		});

		socket.on('burn_power', ({ gameId, moveBrainToBowl3 }: { gameId: string; moveBrainToBowl3?: boolean }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			// 프리액션은 자기 턴(메인 단계)에만 가능 — 서버 권위 검증
			if (game.currentPhase !== 'main') return;
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
			if (councilPendingActive(game)) return; // 아이타/테란 의회 선택 대기 중 — 라운드 첫 액션 보류
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }

			pushFreeActionUndoSnapshot(game);

			if (executeBurnPower(game, playerId, moveBrainToBowl3)) {
				clampPlayerResources(game); emitGameUpdated(io, game);
			}
		});

		// 인게임 채팅: 플레이어/관전자 모두 전송 가능. 가벼운 'chat_message' 이벤트로 즉시 전파하고,
		// 재접속/관전자 히스토리 복원을 위해 게임 상태에 최근 100개만 보관(전체 game_updated는 보내지 않음).
		socket.on('send_chat', ({ gameId, text }: { gameId: string; text: string }) => {
			const game = games.get(gameId); if (!game) return;
			// [방 격리, 사용자 관찰] 소켓의 좌석/관전 ID가 '이 게임'의 것일 때만 인정 — 방을 옮긴 소켓의
			// 이전 방 신원으로 다른 방에 채팅되는 것 방지.
			const rawPlayerId = socketToPlayerMap.get(socket.id);
			const rawSpectatorId = socketToSpectatorMap.get(socket.id);
			const playerId = rawPlayerId && game.players[rawPlayerId] ? rawPlayerId : undefined;
			const spectatorId = rawSpectatorId && game.spectatorIds?.includes(rawSpectatorId) ? rawSpectatorId : undefined;
			const senderId = playerId || spectatorId;
			if (!senderId) return; // 이 게임에 속하지 않은 소켓은 무시
			if (typeof text !== 'string') return;
			const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
			if (!clean) return;
			const player = playerId ? game.players[playerId] : undefined;
			const msg = {
				id: generatePlayerId(),
				gameId, // 클라이언트가 현재 방 메시지만 표시하도록 (방 격리)
				senderId,
				name: player?.name ?? (game as any).spectatorNames?.[senderId] ?? '관전자',
				faction: player?.faction ?? null,
				isSpectator: !player,
				text: clean,
				ts: Date.now(),
			};
			if (!game.chatMessages) game.chatMessages = [];
			game.chatMessages.push(msg);
			if (game.chatMessages.length > 100) game.chatMessages = game.chatMessages.slice(-100);
			io.to(gameId).emit('chat_message', msg);
		});

		socket.on('undo_free_action', ({ gameId, steps }: { gameId: string; steps?: number }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;

			if (!game.freeActionUndoStack) game.freeActionUndoStack = [];
			// 하위 호환: 기존 단일 스냅샷을 스택으로 승격
			if ((game as any).freeActionUndoState && game.freeActionUndoStack.length === 0) {
				game.freeActionUndoStack.push((game as any).freeActionUndoState);
			}
			const stack = game.freeActionUndoStack;
			if (!stack.length) return;

			// [진단 2026-07-31] 타클론 브레인/파워 되돌리기 버그 추적용 — 복원 전 라이브 상태 캡처(브레인이면).
			const _diagLive = (() => {
				const lp = game.players[playerId];
				if (!lp || lp.faction !== 'taklons') return null;
				return { bowl: (lp as any).brainStoneBowl, gaia: (lp as any).brainStoneInGaia, p1: lp.power1, p2: lp.power2, p3: lp.power3 };
			})();

			try {
				const currentTurnStartState = game.turnStartState ? deepClone(game.turnStartState) : undefined;
				const currentPrevTurnStartState = game.prevTurnStartState ? deepClone(game.prevTurnStartState) : undefined;
				const currentUndoContext = game.freeActionUndoContext ? { ...game.freeActionUndoContext } : undefined;
				const requestedSteps = typeof steps === 'number' && Number.isFinite(steps) ? Math.floor(steps) : 1;
				const popCount = Math.max(1, requestedSteps);
				let snapshot = stack[stack.length - 1];
				for (let i = 0; i < popCount && stack.length > 0; i++) {
					snapshot = stack.pop() as string;
				}
				const restoredGame = JSON.parse(snapshot) as ServerGameState;
				restoredGame.freeActionUndoStack = stack;
				restoredGame.freeActionUndoContext = currentUndoContext;
				restoredGame.turnStartState = currentTurnStartState;
				restoredGame.prevTurnStartState = currentPrevTurnStartState; // 스냅샷엔 안 담으므로 라이브에서 복원
				// [메모리] 스냅샷에서 gameLog/humanActionJournal을 제외했으므로(buildFreeActionUndoSnapshot) 라이브에서 재부착.
				// [버그수정 2026-07-14 사용자] 기존엔 라이브 로그를 그대로 붙여 되돌린 액션 로그가 잔류('Used Tech
				// Action' 등이 리셋 반복 시 3중 누적). 스냅샷의 gameLogSeq(단조 카운터, 100캡 shift 무관)로
				// '스냅샷 이후 추가된 줄 수'를 구해 꼬리에서 잘라 상태와 로그를 일치시킨다(reset_turn과 동일 방식).
				{
					const liveSeq = (game as any).gameLogSeq;
					const snapSeq = (restoredGame as any).gameLogSeq;
					let liveLog = (game.gameLog || []) as NonNullable<GaiaGameState['gameLog']>;
					if (typeof liveSeq === 'number' && typeof snapSeq === 'number') {
						const added = Math.max(0, Math.min(liveLog.length, liveSeq - snapSeq));
						liveLog = liveLog.slice(0, liveLog.length - added);
					}
					restoredGame.gameLog = liveLog;
				}
				restoredGame.humanActionJournal = game.humanActionJournal;
				// [버그수정 2026-07-27 사용자 관찰: 리벨리온 교역소 후 타클론 leech 누락] 파워 leech 오퍼는 메인 액션
				// '건설'로 생성되는, 상대에게 진 의무다. 스냅샷(buildFreeActionUndoSnapshot)은 queuedPowerOffers·
				// pendingTurnEndPlayerId를 벗겨내는데, 복원 시 이 라이브 상태들을 도로 붙이지 않아 프리액션 되돌리기가
				// 방금 건설로 큐잉된 leech 오퍼를 통째로 날렸다(자기·타인 무관) → 상대가 파워 수령 창을 영영 못 받음.
				// 프리액션 undo는 '건설'을 되돌리지 않으므로 라이브 파워오퍼 상태를 그대로 보존한다.
				restoredGame.pendingPowerOffers = game.pendingPowerOffers;
				(restoredGame as ServerGameState).queuedPowerOffers = (game as ServerGameState).queuedPowerOffers;
				(restoredGame as any).pendingTurnEndPlayerId = (game as any).pendingTurnEndPlayerId;
				(restoredGame as any).freeActionUndoState = undefined;
				// 복구할 스냅샷에서 클라이언트가 보지 말아야 할/유지해야 할 세션 정보 등
				// 통째로 덮어쓰고, Map에 반영.
				hideHeavyServerFields(restoredGame);
				games.set(gameId, restoredGame);
				const player = restoredGame.players[playerId];
				log(`Player ${player?.name} undone free actions (${popCount} step)`, 'game', undefined, { simulation: (game as any).simulation });
				// [진단 2026-07-31] 타클론이면 되돌리기 전(라이브)→후(복원) 브레인/파워 비교 로그.
				if (_diagLive && player) {
					log(`[BRAIN-UNDO-DIAG] live→restored | live{bowl=${_diagLive.bowl} gaia=${_diagLive.gaia} p1=${_diagLive.p1} p2=${_diagLive.p2} p3=${_diagLive.p3}} restored{bowl=${(player as any).brainStoneBowl} gaia=${(player as any).brainStoneInGaia} p1=${player.power1} p2=${player.power2} p3=${player.power3}}`, 'game', undefined, { simulation: (game as any).simulation });
				}
				addGameLog(restoredGame, playerId, 'Undo Free Action', `Reverted ${popCount} free action step(s)`);
				emitGameUpdated(io, restoredGame); // [대역폭 2026-08-07] 전체 로그 직접 emit → 헬퍼 경유(꼬리40 델타)
			} catch (err) {
				log(`Failed to restore freeActionUndoStack: ${err}`, 'error');
			}
		});

		// 고급 기술 타일 획득 시: 기술 타일 선택 대기 중에만 가능. 트랙 타일은 해당 트랙 4/5, 7번째(추가) 타일은 25 VP+ 또는 우주선 3개 입장
		socket.on('select_advanced_tech_tile', ({ gameId, advancedTileId, trackId }: { gameId: string; advancedTileId: string; trackId?: ResearchTrack }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (!game.pendingTechTileSelection || game.pendingTechTileSelection.playerId !== playerId) return;

			const player = game.players[playerId];
			if (countGreenFederations(player) < 1) return;
			// 고급 타일은 각 1개씩만 존재 — 이미 누군가 보유 중이면 중복 획득 거부 (UI는 슬롯을 '획득됨/TAKEN'으로 유지)
			if (Object.values(game.players).some(p => p.techTiles?.includes(advancedTileId))) return;
			const uncoveredNormal = (player.techTiles || []).filter(
				(id) => !(player.coveredTechTiles || []).includes(id) && !id.startsWith('adv-')
			);
			if (uncoveredNormal.length < 1) return;

			// [버그수정 2026-08-06 사용자] 아이타 의회 교환으로 받은 고급 타일인지 기억해 둔다 —
			//   교환은 가이아 단계(액션 전)에 일어나므로 후속 트랙 전진이 메인 액션을 소모하면 안 된다.
			const fromItarsExchange = game.pendingTechTileSelection?.structureType === 'itars_pi_exchange';
			if (trackId != null) {
				// 트랙 4–5 사이 고급 타일
				const advTile = game.advancedTechTilesByTrack?.[trackId];
				if (!advTile || advTile.id !== advancedTileId) return;
				const level = player.research?.[trackId] ?? 0;
				if (level < 4) return;
				game.pendingAdvancedTechCover = { playerId, advancedTileId, trackId, fromItarsExchange };
			} else {
				// 7번째(추가) 고급 타일: 조건 25 VP+ 또는 우주선 3개 입장
				const extra = game.extraAdvancedTechTile;
				if (!extra || extra.id !== advancedTileId) return;
				const cond = game.extraAdvancedTechCondition;
				if (cond === '25vp') {
					if ((player.score ?? 0) < 25) return;
				} else {
					const entered = (player.spaceshipsEntered ?? []).length;
					if (entered < 3) return;
				}
				game.pendingAdvancedTechCover = { playerId, advancedTileId, fromItarsExchange };
			}
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		// 고급 타일로 덮을 일반 타일 선택 확정 → 연방 1개 소모, 덮기, 고급 타일 추가, 즉시 효과, 트랙 1칸 선택 대기
		socket.on('confirm_advanced_tech_cover', ({ gameId, coverTileId }: { gameId: string; coverTileId: string }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const pending = game.pendingAdvancedTechCover;
			if (!pending || pending.playerId !== playerId) return;

			const player = game.players[playerId];
			if (!player.techTiles?.includes(coverTileId) || coverTileId.startsWith('adv-')) return;
			if (player.coveredTechTiles?.includes(coverTileId)) return;
			if (countGreenFederations(player) < 1) return;

			spendGreenFederation(player);
			if (!player.coveredTechTiles) player.coveredTechTiles = [];
			player.coveredTechTiles.push(coverTileId);
			if (!player.techTiles.includes(pending.advancedTileId)) player.techTiles.push(pending.advancedTileId);

			const immDesc = applyAdvancedTileImmediateEffect(game, playerId, pending.advancedTileId);

			// tileId에 획득한 고급 타일 id를 담아 로그가 '덮은 일반 타일'이 아니라 '획득한 고급 타일' 이미지를 표시하도록. 즉발 효과는 같은 줄에 병합.
			addGameLog(game, playerId, 'Advanced Tech Tile', `Covered ${coverTileId} → ${pending.advancedTileId}${immDesc ? ` · ${immDesc}` : ''}`, pending.advancedTileId);
			game.pendingTechTileSelection = null;
			game.pendingAdvancedTechCover = null;
			game.availableShipTechTileIds = undefined;
			game.pendingAdvancedTechTrackAdvance = { playerId, fromItarsExchange: pending.fromItarsExchange };
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		// 즉발 효과를 적용하고 '한 줄에 합칠' 설명 문자열을 반환(별도 'Tech Tile Effect' 로그 제거 — 사용자 요청)
		function applyAdvancedTileImmediateEffect(game: GaiaGameState, playerId: string, tileId: string): string {
			const player = game.players[playerId];
			if (!player) return '';
			if (tileId === 'adv-imm-1o-sector') {
				const sectors = occupiedSectorSet(game, playerId, 0, 9);
				player.ore += sectors.size;
				return `+${sectors.size}O (1/sector)`;
			} else if (tileId === 'adv-imm-4vp-ts') {
				const tsCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'trading_station').length;
				addScore(game, playerId, tsCount * 4, 'techTiles', { tileId });
				return `+${tsCount * 4}VP (4/TS)`;
			} else if (tileId === 'adv-imm-2vp-mine') {
				const mineCount = getMineCountForPassAndBonuses(game, playerId);
				addScore(game, playerId, mineCount * 2, 'techTiles', { tileId });
				return `+${mineCount * 2}VP (2/mine)`;
			} else if (tileId === 'adv-imm-2vp-sector') {
				const sectors = occupiedSectorSet(game, playerId, 0, 9);
				addScore(game, playerId, sectors.size * 2, 'techTiles', { tileId });
				return `+${sectors.size * 2}VP (2/sector)`;
			} else if (tileId === 'adv-imm-4vp-outer') {
				const outerCount = countOuterSectorsOccupied(game, playerId);
				addScore(game, playerId, outerCount * 4, 'techTiles', { tileId });
				return `+${outerCount * 4}VP (4/outer sector)`;
			} else if (tileId === 'adv-imm-6vp-big') {
				const bigCount = game.map.filter(t => t.ownerId === playerId && (t.structure === 'planetary_institute' || t.structure === 'academy')).length;
				addScore(game, playerId, bigCount * 6, 'techTiles', { tileId });
				return `+${bigCount * 6}VP (6/big building)`;
			} else if (tileId === 'adv-imm-2vp-gaia') {
				const gaiaCount = game.map.filter(t => t.ownerId === playerId && t.type === 'gaia').length;
				addScore(game, playerId, gaiaCount * 2, 'techTiles', { tileId });
				return `+${gaiaCount * 2}VP (2/Gaia)`;
			} else if (tileId === 'adv-imm-5vp-fed') {
				const fedCount = getFederationEntries(player).length;
				addScore(game, playerId, fedCount * 5, 'techTiles', { tileId });
				return `+${fedCount * 5}VP (5/federation)`;
			}
			return '';
		}

		socket.on('gain_tech_tile', ({ gameId, tileId }) => {
			const game = games.get(gameId); if (!game) return;
			// 보너스 선택 단계에서는 기술 타일 획득 불가
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const player = game.players[playerId];

			// [중대 버그수정] 보류 중인 기술타일 선택이 없으면 거저 획득 차단(연구소 1개로 타일 2개 먹던 버그).
				// 정상 획득은 select_tech_tile 경로가 담당. 이 핸들러는 보류가 있을 때만 동작하고 보류를 소모한다.
				if (!game.pendingTechTileSelection || game.pendingTechTileSelection.playerId !== playerId) return;

				if (player.techTiles.includes(tileId)) return;
			// 고급 기술 타일 획득 시 초록 연방 1개 소모 (없으면 획득 불가)
			if (tileId.startsWith('adv-')) {
				if (countGreenFederations(player) < 1) return;
				spendGreenFederation(player);
			}
			player.techTiles.push(tileId);

			// Immediate effects
			if (tileId === 'tech-imm-7vp') {
				addScore(game, playerId, 7, 'techTiles', { tileId });
			} else if (tileId === 'tech-imm-1k-planet') {
				// 보유 행성 유형 수(가상 광산 포함). 단, 기술타일 획득 시점의 1회성 효과
				player.knowledge += getPlayerPlanetTypesForGeodens(game, playerId).size;
			} else if (tileId === 'tech-imm-1o-1q') {
				player.ore += 1;
				grantQic(game, playerId, 1);
			}
			// 고급 타일: 일시불 자원
			else if (tileId === 'adv-imm-1o-sector') {
				const sectors = occupiedSectorSet(game, playerId, 0, 9);
				player.ore += sectors.size;
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${sectors.size} Ore (1 per sector)`);
			}
			// 고급 타일: 일시불 점수
			else if (tileId === 'adv-imm-4vp-ts') {
				const tsCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'trading_station').length;
				addScore(game, playerId, tsCount * 4, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${tsCount * 4} VP (4 per TS)`);
			}
			else if (tileId === 'adv-imm-2vp-mine') {
				const mineCount = getMineCountForPassAndBonuses(game, playerId);
				addScore(game, playerId, mineCount * 2, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${mineCount * 2} VP (2 per mine)`);
			}
			else if (tileId === 'adv-imm-2vp-sector') {
				const sectors = occupiedSectorSet(game, playerId, 0, 9);
				addScore(game, playerId, sectors.size * 2, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${sectors.size * 2} VP (2 per sector)`);
			}
			else if (tileId === 'adv-imm-4vp-outer') {
				const outerCount = countOuterSectorsOccupied(game, playerId);
				addScore(game, playerId, outerCount * 4, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${outerCount * 4} VP (4 per outer sector)`);
			}
			else if (tileId === 'adv-imm-6vp-big') {
				const bigCount = game.map.filter(t => t.ownerId === playerId && (t.structure === 'planetary_institute' || t.structure === 'academy')).length;
				addScore(game, playerId, bigCount * 6, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${bigCount * 6} VP (6 per big building)`);
			}
			else if (tileId === 'adv-imm-2vp-gaia') {
				const gaiaCount = game.map.filter(t => t.ownerId === playerId && t.type === 'gaia').length;
				addScore(game, playerId, gaiaCount * 2, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${gaiaCount * 2} VP (2 per Gaia)`);
			}
			else if (tileId === 'adv-imm-5vp-fed') {
				const fedCount = getFederationEntries(player).length;
				addScore(game, playerId, fedCount * 5, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${fedCount * 5} VP (5 per federation)`);
			}

			game.pendingTechTileSelection = null; game.availableShipTechTileIds = undefined;
				clampPlayerResources(game); emitGameUpdated(io, game);
		});

		socket.on('use_tech_action', ({ gameId, tileId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (councilPendingActive(game)) { socket.emit('game_error', { message: '다른 플레이어의 선택(의회/이클립스)이 진행 중입니다. 완료되면 이어집니다.' }); return; }
			if (hasActiveRangeBonus(game.players[playerId])) { socket.emit('game_error', { message: RANGE_BONUS_BLOCK_MSG }); return; }
			const ok = executeUseTechAction(io, game, playerId, tileId);
			if (!ok) {
				socket.emit('game_error', { message: '기술 타일 액션을 사용할 수 없습니다. (내 턴/메인 액션 상태/소유 여부를 확인하세요)' });
			}
		});

		socket.on('tinkeroid_choose_special', ({ gameId, specialId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const pending = game.pendingTinkeroidSpecialChoice;
			if (!pending || (pending.playerId !== playerId && game.hostId !== playerId) || pending.round !== game.roundNumber) return;
			if (!pending.options.includes(specialId)) return;

			const targetPlayerId = pending.playerId;
			const player = game.players[targetPlayerId];
			player.tinkeroidRoundSpecialId = specialId;
			player.tinkeroidsChosenSpecialIds = [...(player.tinkeroidsChosenSpecialIds ?? []), specialId];

			game.pendingTinkeroidSpecialChoice = null;
			addGameLog(game, playerId, 'Tinkeroid Special', `Selected ${specialId} for Round ${game.roundNumber}`);
			log(`Player ${player.name} (Tinkeroids) selected special ${specialId} for round ${game.roundNumber}`, 'game', undefined, { simulation: (game as any).simulation });

			clampPlayerResources(game); emitGameUpdated(io, game);

			// [순서 2026-07-27] 팅커를 맨 앞으로 옮김 → 선택 후 income 계속(아이타/테란/액션).
			helperTriggerIncomePhase(io, game);
		});

		socket.on('use_special_action', ({ gameId, actionId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			// 이미 거리 보너스가 켜져 있으면 글린 +2항해 포함 모든 스페셜 액션 차단 (중복 활성 방지)
			if (hasActiveRangeBonus(game.players[playerId])) { socket.emit('game_error', { message: RANGE_BONUS_BLOCK_MSG }); return; }
			const ok = executeUseSpecialAction(io, game, playerId, actionId);
			// [버그수정 2026-07-06] 실패가 조용히 삼켜져 유저는 액션이 된 줄 알고 턴종료 → "메인 액션 미수행" 에러로만
			// 나타남(사용자 관찰 "종종"). 실패 사유를 즉시 피드백 + 게임파일에 계측.
			if (!ok) {
				const why = game.currentPhase !== 'main' ? '메인 단계가 아닙니다'
					: game.hasDoneMainAction ? '이번 턴 메인 액션을 이미 사용했습니다'
					: game.turnOrder[game.currentPlayerIndex] !== playerId ? '자신의 턴이 아닙니다'
					: game.players[playerId]?.usedSpecialActions?.includes(actionId) ? '이번 라운드에 이미 사용한 스페셜 액션입니다'
					: '조건이 맞지 않습니다';
				debugLog(game, `[SPECIALREJ] ${playerId} ${actionId} → ${why} (main=${game.hasDoneMainAction}, phase=${game.currentPhase})`, 'error');
				socket.emit('game_error', { message: `스페셜 액션 사용 불가: ${why}` });
			}
		});

		// 팅커로이드: 라운드 시작 시 고른 Special 액션 확정 (한 옵션만 남으면 자동 지정됨)
		socket.on('tinkeroid_choose_special', ({ gameId, actionId }: { gameId: string; actionId: string }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const pending = game.pendingTinkeroidSpecialChoice;
			if (!pending || pending.playerId !== playerId) return;
			const player = game.players[playerId];
			if (player.faction !== 'tinkeroids') return;
			if (!pending.options.includes(actionId)) return;

			const chosen = player.tinkeroidsChosenSpecialIds ?? [];
			player.tinkeroidRoundSpecialId = actionId;
			player.tinkeroidsChosenSpecialIds = [...chosen, actionId];
			game.pendingTinkeroidSpecialChoice = null;
			addGameLog(game, playerId, 'Tinkeroid: Round Special', `Round ${game.roundNumber}: ${actionId}`, undefined);
			log(`Tinkeroid: ${player.name} chose special for round ${game.roundNumber}: ${actionId}`, 'game', undefined, { simulation: (game as any).simulation });
			clampPlayerResources(game); emitGameUpdated(io, game);
			// [순서 2026-07-27] 팅커를 맨 앞으로 → 선택 후 income 계속(아이타/테란/액션).
			helperTriggerIncomePhase(io, game);
		});

		// 엠바스(Ambas): 의회 건설 후 Special — 의회와 광산 위치 교체 (라운드당 1회). 배치지 변경이므로 RM7·다카니안 의회 보너스 미적용.
		socket.on('ambas_swap_pi_mine', ({ gameId, mineTileId }: { gameId: string; mineTileId: string }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const player = game.players[playerId];
			if (game.turnOrder[game.currentPlayerIndex] !== playerId || game.hasDoneMainAction) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (councilPendingActive(game)) return; // 의회 선택 대기
			if (player.faction !== 'ambas') return;
			if (player.usedSpecialActions?.includes('ambas-swap-pi-mine')) return;

			const piTile = game.map.find(t => t.ownerId === playerId && t.structure === 'planetary_institute');
			const mineTile = game.map.find(t => t.id === mineTileId && t.ownerId === playerId && (t.structure === 'mine' || t.structure === 'lost_planet_mine'));
			if (!piTile || !mineTile) return;

			const prevPI = piTile.structure;
			const prevMine = mineTile.structure;
			piTile.structure = prevMine;
			mineTile.structure = prevPI;
			if (!player.usedSpecialActions) player.usedSpecialActions = [];
			player.usedSpecialActions.push('ambas-swap-pi-mine');
			game.hasDoneMainAction = true;
			addGameLog(game, playerId, 'Ambas: Special', 'PI ↔ Mine 위치 교체', mineTileId);
			log(`Player ${player.name} (Ambas) swapped PI with Mine`, 'game', undefined, { simulation: (game as any).simulation });
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		// 매안(Bescods) Special: 가장 낮은 트랙 중 하나 +1 (라운드당 1회, 비용 없음)
		socket.on('bescods_advance_lowest_track', ({ gameId, trackId }: { gameId: string; trackId: ResearchTrack }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const player = game.players[playerId];
			if (game.turnOrder[game.currentPlayerIndex] !== playerId || game.hasDoneMainAction) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (councilPendingActive(game)) return; // 의회 선택 대기
			if (player.faction !== 'bescods') return;
			if (player.usedSpecialActions?.includes('bescods-advance-lowest')) return;

			const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
			if (!tracks.includes(trackId)) return;
			const levels = tracks.map(t => player.research?.[t] ?? 0);
			const minLevel = Math.min(...levels);
			const currentLevel = player.research?.[trackId] ?? 0;
			if (currentLevel !== minLevel || currentLevel >= 5) return;
			if (currentLevel === 4 && isTrackLevel5Taken(game, trackId, playerId)) return;
			if (trackId === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return;

			saveActionStartState(game, playerId);
			if (!player.usedSpecialActions) player.usedSpecialActions = [];
			player.usedSpecialActions.push('bescods-advance-lowest');
			player.research[trackId] = currentLevel + 1;
			const newLevel = player.research[trackId];
			addGameLog(game, playerId, 'Bescods/매안: Special', `가장 낮은 트랙 +1 → ${trackId} Lv.${newLevel}`, undefined);
			applyTrackLevelBonus(game, playerId, player, trackId, newLevel);
			applyRoundMissionScore(game, playerId, 'research_track');
			applyAdvancedTechTileEffect(game, playerId, 'research');
			log(`Player ${player.name} (Bescods) advanced lowest track ${trackId} to Lv.${newLevel}`, 'game', undefined, { simulation: (game as any).simulation });
			game.hasDoneMainAction = true;
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		// 모웨이드(Moweyip) Special: 의회 보유 시 링 놓기 — 본인 건물 중 링 없는 것 하나에 링 배치 (+2 파워 수신/연방)
		socket.on('moweyip_place_ring', ({ gameId, tileId }: { gameId: string; tileId: string }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const player = game.players[playerId];
			if (game.turnOrder[game.currentPlayerIndex] !== playerId || game.hasDoneMainAction) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (councilPendingActive(game)) return; // 의회 선택 대기
			if (player.faction !== 'moweyip') return;
			if (player.usedSpecialActions?.includes('moweyip-place-ring')) return;
			if (!game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) return;

			const tile = game.map.find(t => t.id === tileId && t.ownerId === playerId && t.structure && t.structure !== 'ship');
			if (!tile || tile.moweyipRing) return;

			tile.moweyipRing = true;
			if (!player.usedSpecialActions) player.usedSpecialActions = [];
			player.usedSpecialActions.push('moweyip-place-ring');
			game.hasDoneMainAction = true;
			addGameLog(game, playerId, 'Moweyip: Special', `링 놓기 → ${tile.structure} (+2 파워)`, tileId);
			log(`Player ${player.name} (Moweyip) placed ring on ${tile.structure}`, 'game', undefined, { simulation: (game as any).simulation });
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		/** 우주선 연방 보상 무료광산 배치 포기 — 지을 곳이 없을 때(광산 8개 한도·빈 행성 없음) 배치도 턴종료도
		 *  불가한 데드락 탈출구(사용자 관찰). 보상은 소멸하고 턴 종료가 가능해진다. */
		// [탈출구 2026-08-05 사용자] 2TF+무료광산: 지을 곳이 없을 때 포기. 아이타 교환에서 온 것이면
		//   액션 단계가 이 pending을 기다리며 보류돼 있으므로(helperStartNewRoundTurn), 체인을 재개해 1턴을 시작시킨다.
		socket.on('skip_ship_tech_mine', ({ gameId }: { gameId: string }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (game.pendingShipTechMine?.playerId !== playerId) return;
			const player = game.players[playerId];
			const fromItars = !!(game as any).itarsExchangeResumeAfterShipMine;
			game.pendingShipTechMine = null;
			if (player) { player.nextMineFreeFromShipTech = false; player.pendingTerraformSteps = 0; }
			addGameLog(game, playerId, 'Ship Tech: 2TF+Mine', '광산 배치 포기');
			// 광산을 건너뛰어도 타일의 트랙 전진은 남는다(정상 경로와 동일: 광산 완료 → 트랙 전진).
			// 단 아이타 교환 중이면 '트랙 전진'이 액션 단계 보류 플래그를 소비하는 유일한 지점이므로,
			// 올릴 수 있는 트랙이 없으면(전부 L4↑ = L5 제약에 걸릴 수 있음) 트랙을 걸지 않고 여기서 체인을 재개해
			// 1턴이 반드시 시작되게 한다(교착 방지).
			const canAdvanceSomeTrack = !!player && RESEARCH_TRACKS.some(t => (player.research?.[t.id] ?? 0) < 4);
			if (canAdvanceSomeTrack) {
				game.pendingShipTechTrackAdvance = { playerId };
				if (fromItars) log(`[ITARS-ORDER] 2TF+Mine skipped by ${player?.name ?? playerId} — 트랙 전진 후 체인 재개 (round ${game.roundNumber})`, 'game', game.id);
				clampPlayerResources(game); emitGameUpdated(io, game);
				return;
			}
			if (fromItars) {
				(game as any).itarsExchangeResumeAfterShipMine = false;
				const rem = game.itarsGaiaformerRemainingAfterTech ?? 0;
				log(`[ITARS-ORDER] 2TF+Mine skipped, 올릴 트랙 없음 — 체인 즉시 재개 (잔여 ${rem}, round ${game.roundNumber})`, 'game', game.id);
				resumeItarsExchangeChain(io, game, playerId, rem);
				return;
			}
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		socket.on('skip_spaceship_fed_mine', ({ gameId }: { gameId: string }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (game.pendingSpaceshipFedMine?.playerId !== playerId) return;
			game.pendingSpaceshipFedMine = null;
			addGameLog(game, playerId, 'Spaceship Fed', 'Skipped free mine placement');
			emitGameUpdated(io, game);
		});

		// 파이락(Firaks) Special: 의회 보유 시 연구소 1개→교역소 다운그레이드 + 아무 트랙 1칸 (라운드당 1회)
		socket.on('firaks_downgrade', ({ gameId, tileId, trackId }: { gameId: string; tileId: string; trackId: ResearchTrack }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (executeFiraksDowngrade(game, playerId, tileId, trackId)) { clampPlayerResources(game); emitGameUpdated(io, game); }
		});

		// ---------- 연방 구현 ----------
		socket.on('federation_toggle_mode', ({ gameId }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (councilPendingActive(game)) { socket.emit('game_error', { message: '다른 플레이어의 선택(의회/이클립스)이 진행 중입니다. 완료되면 이어집니다.' }); return; }
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
			if (councilPendingActive(game)) return; // 아이타/테란 의회 선택 대기 중 — 라운드 첫 액션 보류
			if (game.hasDoneMainAction) return;
			if (game.pendingFederationReward) return;

			if (game.federationMode?.playerId === playerId) {
				game.federationMode = null;
				game.federationPreview = null;
			} else {
				if (!game.federationPool) {
					game.federationPool = {};
					FEDERATION_REWARDS.forEach(r => { game.federationPool![r.id] = 3; });
				}
				if (!game.satellites) game.satellites = {};
				game.federationMode = { playerId, selectedHexIds: [], selectedPlanetIds: [], selectedSpaceStationHexIds: [], toggleSeq: 0 };
				game.federationPreview = computeFederationPreview(game, playerId);
			}
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		socket.on('federation_toggle_hex', ({ gameId, tileId }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (!game.federationMode || game.federationMode.playerId !== playerId) return;
			if (game.pendingFederationReward) return;

			const tile = game.map.find(t => t.id === tileId);
			if (!tile) return;

			const satellites = game.satellites || {};
			const isSpaceHex = tile.type === 'space' || tile.type === 'deep_space';
			if (isSpaceHex && tile.spaceStation?.ownerId === playerId) {
				// 내 우주정거장 칸: 연결 건물로 토글 (파워 +1)
				const arr = game.federationMode.selectedSpaceStationHexIds ?? [];
				const idx = arr.indexOf(tileId);
				if (idx >= 0) arr.splice(idx, 1);
				else arr.push(tileId);
				game.federationMode.selectedSpaceStationHexIds = arr;
			} else if (isSpaceHex && tile.structure == null) {
				// 위성 배치 가능 칸: 빈 우주칸 또는 "상대 우주정거장만 있는" 우주칸 (위성과 상대 우주정거장은 공존 가능).
				// isEmptyHex는 spaceStation이 있으면 false라, 상대 하이브 우주정거장 칸에 위성을 못 놓던 버그 수정.
				const onTile = Array.isArray(satellites[tileId]) ? satellites[tileId]! : (satellites[tileId] ? [satellites[tileId] as string] : []);
				if (onTile.includes(playerId)) return; // 내 위성 있는 공간은 선택 불가
				const idx = game.federationMode.selectedHexIds.indexOf(tileId);
				if (idx >= 0) {
					game.federationMode.selectedHexIds.splice(idx, 1);
				} else {
					// 하이브 2회째 이후: 새 빈칸은 '내 네트워크(건물/우주정거장/기생광산) · 기존 연방 · 현재 선택' 중
					// 하나와 인접해야 함. [버그수정] 기존엔 앵커에 '내 건물'이 빠져, 아직 연방에 안 든 새 건물 옆
					// 빈칸을 먼저 클릭하면 거부 → 2칸 이상 떨어진 연결에서 클릭 순서를 강제하거나 아예 막던 문제.
					// (최종 연결성은 federation_complete에서 검증하므로 클릭 단계 앵커는 넉넉히 허용)
					const player = game.players[playerId];
					const fedHexes = game.playerFederationHexes?.[playerId] ?? [];
					if (player.faction === 'ivits' && fedHexes.length > 0) {
						const neighbors = getNeighbors(game.map, tile).map(n => n.id);
						const ownNodes = game.map.filter(t =>
							(t.ownerId === playerId && t.structure && t.structure !== 'ship') ||
							t.spaceStation?.ownerId === playerId ||
							t.parasiticMine?.ownerId === playerId
						).map(t => t.id);
						const allowed = new Set([...game.federationMode.selectedHexIds, ...(game.federationMode.selectedPlanetIds ?? []), ...(game.federationMode.selectedSpaceStationHexIds ?? []), ...fedHexes, ...ownNodes]);
						if (!neighbors.some(id => allowed.has(id))) return;
					}
					game.federationMode.selectedHexIds.push(tileId);
				}
			} else if (isPlanetHex(tile)) {
				if (tile.ownerId === playerId && tile.structure && tile.structure !== 'ship') {
					const arr = game.federationMode.selectedPlanetIds ?? [];
					const idx = arr.indexOf(tileId);
					if (idx >= 0) arr.splice(idx, 1);
					else arr.push(tileId);
					game.federationMode.selectedPlanetIds = arr;
				} else {
					// 이미 다른 연방에 속한 건물은 재사용 불가 → blocked로 제외하고 컴포넌트 계산
					const blocked = new Set(game.playerFederationHexes?.[playerId] ?? []);
					const component = getPlanetConnectedComponent(game, playerId, tileId, blocked);
					const power = getFederationBuildingPower(game, playerId, component);
					const requiredPower = getFederationRequiredPower(game, playerId);
					if (power >= requiredPower) {
						game.federationMode = null;
						game.federationPreview = null;
						// 형성된 건물 컴포넌트를 selectedPlanetIds로 기록 → 다음 연방에서 재사용 차단
						game.pendingFederationReward = { playerId, selectedHexIds: [], selectedPlanetIds: Array.from(component), spentTokens: 0 };
					}
				}
			}
			game.federationPreview = computeFederationPreview(game, playerId);
			// [낙관적 동기화] 토글 시퀀스 증가 → 클라가 자기 낙관 토글 수와 비교해 옛(stale) 패킷을 무시(rubber-banding 방지).
			if (game.federationMode) game.federationMode.toggleSeq = (game.federationMode.toggleSeq ?? 0) + 1;
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		socket.on('federation_complete', ({ gameId, force }: { gameId: string; force?: boolean }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (councilPendingActive(game)) { socket.emit('game_error', { message: '다른 플레이어의 선택(의회/이클립스)이 진행 중입니다. 완료되면 이어집니다.' }); return; }
			if (!game.federationMode || game.federationMode.playerId !== playerId) return;
			if (game.pendingFederationReward) return;

			const selectedHexIds = [...game.federationMode.selectedHexIds];
			const selectedPlanetIds = [...(game.federationMode.selectedPlanetIds ?? [])];
			const selectedSpaceStationHexIds = [...(game.federationMode.selectedSpaceStationHexIds ?? [])];
			const numEmpty = selectedHexIds.length;
			const player = game.players[playerId];
			const fedHexes = game.playerFederationHexes?.[playerId] ?? [];
			const isIvits = player.faction === 'ivits';
			const requiredPower = getFederationRequiredPower(game, playerId);
			let planetIdsForPower: Set<string>;
			let power: number;
			if (isIvits) {
				// [버그수정] Ivits도 선택한 위성·건물이 하나로 연결돼야 함 (기존엔 파워만 검사 → A옆·B옆 따로 위성을 놓아도 연방이 서던 문제).
				if (!computeIvitsFederationConnected(game, playerId, selectedHexIds, selectedSpaceStationHexIds, selectedPlanetIds)) {
					log(`Federation complete rejected (Ivits): selected hexes not one connected component`, 'game', undefined, { simulation: (game as any).simulation });
					io.to(gameId).emit('game_error', { message: '선택한 위성·건물이 하나로 연결되어야 합니다. (연결 안 된 위성은 제거하세요)' });
					return;
				}
				// Ivits(하이브): 요구파워 누적(7→14→21) + 기존 연방 건물까지 시드에 포함하는 기존 로직 유지.
				const seedHexIds = [...fedHexes, ...selectedHexIds, ...selectedSpaceStationHexIds, ...selectedPlanetIds];
				planetIdsForPower = new Set<string>();
				seedHexIds.forEach(hexId => {
					const tile = game.map.find(t => t.id === hexId);
					if (!tile) return;
					if (isPlanetHex(tile) || tile.spaceStation?.ownerId === playerId || tile.parasiticMine?.ownerId === playerId) {
						getPlanetConnectedComponent(game, playerId, hexId).forEach(pid => planetIdsForPower.add(pid));
					}
					getNeighbors(game.map, tile).forEach(n => {
						if (isPlanetHex(n) || n.spaceStation?.ownerId === playerId || n.parasiticMine?.ownerId === playerId) {
							getPlanetConnectedComponent(game, playerId, n.id).forEach(pid => planetIdsForPower.add(pid));
						}
					});
				});
				power = getFederationBuildingPower(game, playerId, planetIdsForPower, seedHexIds);
				if (power < requiredPower) {
					log(`Federation complete rejected: building power ${power} < ${requiredPower}`, 'game', undefined, { simulation: (game as any).simulation });
					io.to(gameId).emit('game_error', { message: `연방에 포함된 내 건물·우주정거장 파워가 ${requiredPower} 이상이어야 합니다. (위성=0, 우주정거장=1)` });
					return;
				}
			} else {
				// 비-Ivits: 선택한 위성+건물이 '하나의 연결 컴포넌트'를 이뤄야 하고, 그 컴포넌트 파워가 7 이상이어야 함.
				// (끊긴/엉뚱한 위성을 찍어도 다른 건물군 파워로 연방이 서던 버그 수정)
				const net = computeConnectedFederation(game, playerId, selectedHexIds, selectedSpaceStationHexIds, selectedPlanetIds);
				if (!net.connected) {
					log(`Federation complete rejected: selected hexes not one connected component`, 'game', undefined, { simulation: (game as any).simulation });
					io.to(gameId).emit('game_error', { message: '선택한 위성·건물이 하나로 연결되어야 합니다. (연결 안 된 위성은 제거하세요)' });
					return;
				}
				if (net.power < requiredPower) {
					log(`Federation complete rejected: building power ${net.power} < ${requiredPower}`, 'game', undefined, { simulation: (game as any).simulation });
					io.to(gameId).emit('game_error', { message: `연방에 포함된 내 건물·우주정거장 파워가 ${requiredPower} 이상이어야 합니다. (위성=0, 우주정거장=1)` });
					return;
				}
				// 불필요한 위성 경고: 위성 하나를 빼도 연결+파워 충족이면 토큰 낭비 → 확인 후 진행 (force=true면 통과)
				// [2026-08-10 사용자 지적] 판정 시드를 '클릭 목록'이 아니라 '이번 연방에 든 건물(net.planetIds)'에서 잡는다.
				// 예전 방식은 위성만 클릭한 경우 위성을 빼면 시드가 비어 판정 불가 → 경고가 안 떴다(클릭 순서로 갈림).
				if (!force && selectedHexIds.length > 0) {
					const redundantCount = selectedHexIds.filter(sid =>
						federationFormsWithoutSatellite(game, playerId, selectedHexIds.filter(id => id !== sid), net.planetIds, requiredPower)
					).length;
					if (redundantCount > 0) {
						log(`Federation complete warning: ${redundantCount} redundant satellite(s)`, 'game', undefined, { simulation: (game as any).simulation });
						socket.emit('federation_redundant_warning', { count: redundantCount });
						return;
					}
				}
				planetIdsForPower = net.planetIds;
				power = net.power;
			}
			if (isIvits) {
				if (player.qic < numEmpty) {
					log(`Federation complete rejected (Ivits): need ${numEmpty} QIC, have ${player.qic}`, 'game', undefined, { simulation: (game as any).simulation });
					io.to(gameId).emit('game_error', { message: `QIC가 부족합니다. (필요: ${numEmpty}, 보유: ${player.qic})` });
					return;
				}
				player.qic -= numEmpty;
			} else {
				// 브레인 스톤도 1토큰으로 셈 (실제 소비는 spendPowerTokens가 일반토큰 우선→브레인 순으로 처리)
				const brainTok = (player.faction === 'taklons' && player.brainStoneBowl != null && !player.brainStoneInGaia) ? 1 : 0;
				const totalPower = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0) + brainTok;
				if (totalPower < numEmpty) {
					log(`Federation complete rejected: need ${numEmpty} power tokens, have ${totalPower}`, 'game', undefined, { simulation: (game as any).simulation });
					io.to(gameId).emit('game_error', { message: `파워 토큰이 부족합니다. (필요: ${numEmpty}, 보유: ${totalPower})` });
					return;
				}
				if (!spendPowerTokens(player, numEmpty)) {
					io.to(gameId).emit('game_error', { message: '파워 토큰 소비에 실패했습니다.' });
					return;
				}
			}
			game.federationMode = null;
			game.federationPreview = null;
			const federatedPlanetIds = Array.from(new Set([...selectedPlanetIds, ...Array.from(planetIdsForPower)]));
			game.pendingFederationReward = {
				playerId,
				selectedHexIds,
				selectedPlanetIds: federatedPlanetIds,
				selectedSpaceStationHexIds,
				spentTokens: numEmpty
			};
			// 하이브(Ivits): numEmpty는 QIC로 잇는 빈칸 수(위성/우주정거장 개수가 아님) → QIC로 표기
			const fedDetail = isIvits
				? `Formed federation (${power} power${numEmpty > 0 ? `, ${numEmpty} QIC` : ''})`
				: `Formed federation (${numEmpty} satellites, ${power} power)`;
			addGameLog(game, playerId, 'Federation', fedDetail);
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		socket.on('federation_select_reward', ({ gameId, rewardId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (!game.pendingFederationReward || game.pendingFederationReward.playerId !== playerId) return;

			const player = game.players[playerId];
			const byShip = game.spaceshipFederationByShip || {};
			const shipRewardIds = Object.values(byShip);
			const isSpaceshipReward = shipRewardIds.includes(rewardId) && !isSpaceshipFederationRewardTaken(game, rewardId);
			if (isSpaceshipReward) {
				const shipTypeForReward = Object.entries(byShip).find(([, id]) => id === rewardId)?.[0];
				const enteredTileIds = player.spaceshipsEntered ?? [];
				const hasEnteredThisShip = shipTypeForReward && game.map.some(t => t.type === shipTypeForReward && enteredTileIds.includes(t.id));
				if (!hasEnteredThisShip) {
					io.to(gameId).emit('game_error', { message: '해당 우주선에 입장한 플레이어만 그 우주선 연방을 선택할 수 있습니다.' });
					return;
				}
			}

			if (!isSpaceshipReward) {
				if (!game.federationPool) {
					game.federationPool = {};
					FEDERATION_REWARDS.forEach(r => { game.federationPool![r.id] = 3; });
				}
				const pool = game.federationPool;
				if (pool[rewardId] == null || pool[rewardId] < 1) {
					io.to(gameId).emit('game_error', { message: '해당 연방 보상을 선택할 수 없습니다.' });
					return;
				}
			}

			let rewardLabel: string;
			if (isSpaceshipReward) {
				const shipReward = SPACESHIP_FEDERATION_REWARDS.find(r => r.id === rewardId);
				if (!shipReward) return;
				rewardLabel = shipReward.label;
				addGameLog(game, playerId, 'Federation Reward', rewardLabel, rewardId);
			} else {
				const reward = FEDERATION_REWARDS.find(r => r.id === rewardId);
				if (!reward) return;
				rewardLabel = reward.label;
				// [사용자] 로그엔 "+7VP +6C"처럼 깔끔히 표기. addScore는 noLog(중복 "(+7VP 연방 7 VP 6C)" 방지 —
				// 라벨 자체가 보상 표기라 auto-append와 겹쳤음). 라운드 미션(+5VP)은 뒤에서 이 줄에 별도 병합됨.
				const rf: any = reward;
				const fedParts = [`+${reward.vp}VP`];
				if (rf.credits) fedParts.push(`+${rf.credits}C`);
				if (rf.ore) fedParts.push(`+${rf.ore}O`);
				if (rf.knowledge) fedParts.push(`+${rf.knowledge}K`);
				if (rf.qic) fedParts.push(`+${rf.qic}Q`);
				if (rf.powerTokens) fedParts.push(`+${rf.powerTokens}PW`);
				addGameLog(game, playerId, 'Federation Reward', fedParts.join(' '), rewardId);
				addScore(game, playerId, reward.vp, 'other', { source: '연방 ' + rewardLabel, noLog: true });
				if ('ore' in reward && reward.ore) player.ore += reward.ore;
				if ('credits' in reward && reward.credits) player.credits += reward.credits;
				if ('knowledge' in reward && reward.knowledge) player.knowledge += reward.knowledge;
				if ('qic' in reward && reward.qic) grantQic(game, playerId, reward.qic);
				if ('powerTokens' in reward && reward.powerTokens) {
					player.power1 = (player.power1 || 0) + reward.powerTokens;
				}
				game.federationPool![rewardId] -= 1;
			}

			if (!Array.isArray(player.federations) || (player.federations.length > 0 && typeof (player.federations as any)[0] === 'string')) {
				player.federations = getFederationEntries(player);
			}
			player.federations.push({ rewardId, isGreen: rewardId !== FEDERATION_12VP_ID }); // [버그수정 2026-07-05] 12VP 연방은 유일한 비-초록(사용자 룰)

			const { selectedHexIds, selectedPlanetIds = [], selectedSpaceStationHexIds = [] } = game.pendingFederationReward;
			if (!game.satellites) game.satellites = {};
			for (const hexId of selectedHexIds) {
				const existing = game.satellites[hexId];
				if (Array.isArray(existing)) {
					if (!existing.includes(playerId)) existing.push(playerId);
				} else if (existing) {
					game.satellites[hexId] = [existing, playerId];
				} else {
					game.satellites[hexId] = [playerId];
				}
			}
			if (!game.playerFederationHexes) game.playerFederationHexes = {};
			if (!game.playerFederationHexes[playerId]) game.playerFederationHexes[playerId] = [];
			game.playerFederationHexes[playerId] = Array.from(new Set([
				...game.playerFederationHexes[playerId],
				...selectedHexIds,
				...selectedPlanetIds,
				...selectedSpaceStationHexIds,
			]));
			game.pendingFederationReward = null;

			applyRoundMissionScore(game, playerId, 'federation');

			if (isSpaceshipReward) {
				const spaceshipBreakdownId = rewardId;
				switch (rewardId) {
					case 'ship-fed-tech':
						game.pendingTechTileSelection = { playerId, tileId: '', structureType: 'rebellion_gain' };
						game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
						break;
					case 'ship-fed-4vp4k':
						addScore(game, playerId, 4, 'other', { source: '연방 우주선 보상', noLog: true });
						player.knowledge = (player.knowledge || 0) + 4;
						break;
					case 'ship-fed-4vp1q2o':
						addScore(game, playerId, 4, 'other', { source: '연방 우주선 보상', noLog: true });
						grantQic(game, playerId, 1);
						player.ore = (player.ore || 0) + 2;
						break;
					case 'ship-fed-8vp8c':
						addScore(game, playerId, 8, 'other', { source: '연방 우주선 보상', noLog: true });
						player.credits = (player.credits || 0) + 8;
						break;
					case 'ship-fed-mine-free':
						game.pendingSpaceshipFedMine = { playerId };
						break;
					case 'ship-fed-3tf-mine':
						player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 3;
						player.spaceshipFed3TfMineFree = true;
						break;
					case 'ship-fed-12vp':
						addScore(game, playerId, 12, 'other', { source: '연방 우주선 보상', noLog: true });
						break;
					case 'ship-fed-7vp3p2t':
						addScore(game, playerId, 7, 'other', { source: '연방 우주선 보상', noLog: true });
						player.power3 = (player.power3 || 0) + 2; // [수정] ship-fed-7vp3p2t: 그릇3에 토큰 2개(충전됨)
						break;
					default:
						break;
				}
			}

			game.hasDoneMainAction = true;
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		// 게임 시작 시 모든 라운드 미션을 미리 랜덤 선택
		function initializeRoundMissions(game: GaiaGameState) {
			const availableMissions = [...ROUND_MISSION_POOL].sort(() => Math.random() - 0.5);
			const selectedMissions: ScoringTile[] = [];
			const usedIds: string[] = [];

			// 6개 라운드에 대해 미션 선택
			for (let i = 0; i < 6; i++) {
				// 사용 가능한 미션 중 선택 (같은 ID는 한 번만 사용)
				let selected: ScoringTile | null = null;
				for (const mission of availableMissions) {
					if (!usedIds.includes(mission.id)) {
						selected = mission;
						usedIds.push(mission.id);
						break;
					}
				}

				// 만약 모든 미션이 사용되었다면 (큰건물 미션이 2개라서 가능), 풀에서 다시 선택
				if (!selected) {
					const remainingMissions = ROUND_MISSION_POOL.filter(m => !usedIds.includes(m.id));
					if (remainingMissions.length > 0) {
						selected = remainingMissions[Math.floor(Math.random() * remainingMissions.length)];
						usedIds.push(selected.id);
					} else {
						// 정말 모든 미션이 사용되었다면 랜덤 선택 (큰건물 미션 중복 허용)
						selected = ROUND_MISSION_POOL[Math.floor(Math.random() * ROUND_MISSION_POOL.length)];
					}
				}

				selectedMissions.push(selected);
				log(`Round ${i + 1} mission: ${selected.condition} (${selected.vp} VP)`, 'game', undefined, { simulation: (game as any).simulation });
			}

			game.roundScoringTiles = selectedMissions;
			game.usedRoundMissions = usedIds;
		}


		function triggerIncomePhase(game: GaiaGameState) {
			helperTriggerIncomePhase(io, game);
		}

		/** 아이타 의회 처리 또는 가이아포머 복귀 후 다음 단계 (테란 의회 큐 또는 액션 단계 시작) */
		function proceedAfterItarsGaiaformerOrTerran(game: GaiaGameState) {
			helperProceedAfterItarsGaiaformerOrTerran(io, game);
		}

		function finishAfterGaiaformerPhase(game: GaiaGameState) {
			helperFinishAfterGaiaformerPhase(io, game);
		}

		socket.on('end_turn', ({ gameId }) => {
			const game = games.get(gameId); if (!game) return;
			// 보너스 선택 단계에서는 턴 종료 불가 (보너스 선택만 가능)
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (game.pendingTurnEndPlayerId) return;

			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
			if (councilPendingActive(game)) return; // 아이타/테란 의회 선택 대기 중 — 라운드 첫 액션 보류
			// 가이아 프로젝트(보너스/TF Mars) 대기 중에는 턴 종료 불가 → 배치 또는 건너뛰기 먼저
			if (game.pendingTFMarsGaiaProject?.playerId === playerId) {
				socket.emit('game_error', { message: '가이아 프로젝트 진행 중에는 턴을 종료할 수 없습니다.' });
				return;
			}
			// 기술 타일 선택(트랙 올리기) 또는 우주선 기술 타일 보상 트랙 진행을 같은 턴에 끝내야 함
			if (game.pendingTechTileSelection?.playerId === playerId) {
				socket.emit('game_error', { message: '기술 타일을 선택하고 트랙을 전진해야 턴을 종료할 수 있습니다.' });
				return;
			}
			if (game.pendingShipTechTrackAdvance?.playerId === playerId) {
				socket.emit('game_error', { message: '우주선 기술 보상으로 트랙을 전진해야 턴을 종료할 수 있습니다.' });
				return;
			}
			if (game.pendingAdvancedTechTrackAdvance?.playerId === playerId) {
				socket.emit('game_error', { message: '고급 기술 보상으로 트랙을 전진해야 턴을 종료할 수 있습니다.' });
				return;
			}
			if (game.pendingSpaceshipFedMine?.playerId === playerId) {
				socket.emit('game_error', { message: '우주선 연방 보상 광산을 배치해야 턴을 종료할 수 있습니다.' });
				return;
			}
			if (game.pendingLostPlanet?.playerId === playerId) {
				socket.emit('game_error', { message: '검은 행성을 배치해야 턴을 종료할 수 있습니다.' });
				return;
			}
			// [사용자 2026-08-01 제보 "액션 후 턴이 넘어감"] 이클립스 2K+3P(트랙 선택)·트왈라잇 3QIC(연방 보상)는
			// hasDoneMainAction=true 상태로 보류가 남는데 end_turn 가드에 빠져 있어 — 선택을 안 하고 턴 종료하면
			// 지불한 비용째 증발 + pending이 남아 councilPendingActive가 게임 전체를 잠갔다. 해소 전 턴 종료 차단.
			if (game.pendingEclipseResearch?.playerId === playerId) {
				socket.emit('game_error', { message: '이클립스 연구 트랙을 선택(또는 취소)해야 턴을 종료할 수 있습니다.' });
				return;
			}
			if (game.pendingEclipseAsteroidMine?.playerId === playerId) {
				socket.emit('game_error', { message: '소행성을 선택(또는 취소)해야 턴을 종료할 수 있습니다.' });
				return;
			}
			if (game.pendingTwilightFederation?.playerId === playerId) {
				socket.emit('game_error', { message: '연방 보상을 선택해야 턴을 종료할 수 있습니다.' });
				return;
			}
			if (!game.hasDoneMainAction) {
				// [계측 2026-07-06] 사용자 "스페셜 QIC 받기 후 종종 이 에러" — 직전 액션 흐름을 게임파일에 남겨 재발 시 원인 특정
				const recent = (game.gameLog || []).slice(-3).map((e: any) => `${e.playerName ?? e.playerId}:${e.action}`).join(' | ');
				debugLog(game, `[ENDREJ] ${playerId} end_turn 거부(main=false). 직전 로그: ${recent}`, 'error');
				socket.emit('game_error', { message: '메인 액션을 수행하지 않아 턴을 종료할 수 없습니다.' });
				return;
			}

			const endingPlayerId = game.turnOrder[game.currentPlayerIndex];
			const manualOfferCount = activateQueuedPowerOffersForPlayer(game as ServerGameState, endingPlayerId);
			if (manualOfferCount > 0) {
				game.pendingTurnEndPlayerId = endingPlayerId;
				clampPlayerResources(game); emitGameUpdated(io, game);
				return;
			}

			finalizeTurnEnd(io, game as ServerGameState, endingPlayerId, { triggerBot: true, reason: 'end_turn' });
		});


		socket.on('select_income_item', ({ gameId, itemId }) => {
			console.log(`[DEBUG_INCOME] Received select_income_item: gameId=${gameId}, itemId=${itemId}`);
			const game = games.get(gameId); if (!game) { console.log(`[DEBUG_INCOME] Game not found: ${gameId}`); return; }
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) { console.log(`[DEBUG_INCOME] PlayerId not found for socket: ${socket.id}`); return; }

			console.log(`[DEBUG_INCOME] Processing for player: ${playerId}, current pending: ${game.pendingIncomeOrder?.playerId}`);
			// 호스트가 봇의 턴을 대신할 때만 허용. 다른 인간 플레이어의 턴을 뺏지 못하게 함.
			const isBot = game.botPlayerIds?.includes(game.pendingIncomeOrder?.playerId || '');
			if (!game.pendingIncomeOrder || (game.pendingIncomeOrder.playerId !== playerId && !(isBot && game.hostId === playerId))) {
				console.log(`[DEBUG_INCOME] Authorization failed or no pending order. pendingOrder:`, game.pendingIncomeOrder);
				return;
			}
			const targetPlayerId = game.pendingIncomeOrder.playerId;
			const player = game.players[targetPlayerId];
			const itemsList = game.pendingIncomeOrder.incomeItems;
			const item = itemsList.find(i => i.id === itemId);
			if (!item) {
				console.log(`[DEBUG_INCOME] Item not found: ${itemId}. Available items:`, itemsList.map(i => i.id));
				return;
			}

			// Undo용: 적용 직전 파워·브레인 스톤 스냅샷 저장
			if (!game.pendingIncomeOrder.powerBeforeSnapshots) game.pendingIncomeOrder.powerBeforeSnapshots = [];
			game.pendingIncomeOrder.powerBeforeSnapshots.push(snapshotPlayerPower(player));

			// 수익 적용: 파워는 미리보기와 동일(applyPowerIncome), 토큰은 1그릇에만 추가
			if (item.type === 'power') {
				applyPowerIncome(player, item.amount);
			} else {
				player.power1 = (player.power1 || 0) + item.amount;
			}

			game.pendingIncomeOrder.appliedItems.push(item);
			game.pendingIncomeOrder.incomeItems = game.pendingIncomeOrder.incomeItems.filter(i => i.id !== itemId);

			log(`Player ${player.name} selected income: ${item.amount} ${item.type}`, 'game', undefined, { simulation: (game as any).simulation });
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		/** 수익 항목 전부 한 번에 받기: 파워는 1그릇 추가 후 charge(amount), 토큰은 1그릇에만 추가. 적용 직전마다 스냅샷 저장 → Undo 시 복원 */
		/** 수익 항목 전부 한 번에 받기: 파워 토큰/충전 순서 최적화 시뮬레이션 적용 */
		socket.on('select_all_income_items', ({ gameId }) => {
			console.log(`[DEBUG_INCOME] Received select_all_income_items: gameId=${gameId}`);
			const game = games.get(gameId); if (!game) { console.log(`[DEBUG_INCOME] Game not found: ${gameId}`); return; }
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) { console.log(`[DEBUG_INCOME] PlayerId not found for socket: ${socket.id}`); return; }

			const isBot = game.botPlayerIds?.includes(game.pendingIncomeOrder?.playerId || '');
			const isHostViewingBot = isBot && game.hostId === playerId;

			if (!game.pendingIncomeOrder || (game.pendingIncomeOrder.playerId !== playerId && !isHostViewingBot)) {
				console.log(`[DEBUG_INCOME] Auto-select Auth failed. pendingOrder:`, game.pendingIncomeOrder);
				return;
			}
			const targetPlayerId = game.pendingIncomeOrder.playerId;
			const player = game.players[targetPlayerId];
			const items = [...game.pendingIncomeOrder.incomeItems];
			if (items.length === 0) return;

			if (!game.pendingIncomeOrder.powerBeforeSnapshots) game.pendingIncomeOrder.powerBeforeSnapshots = [];
			const applied: typeof items = [];

			const bestOrder = findOptimalIncomeOrder(player, items);

			// Apply best order
			for (const item of bestOrder) {
				game.pendingIncomeOrder.powerBeforeSnapshots.push(snapshotPlayerPower(player));
				if (item.type === 'tokens') {
					player.power1 = (player.power1 || 0) + item.amount;
				} else if (item.type === 'power') {
					applyPowerIncome(player, item.amount);
				}
				applied.push(item);
			}

			game.pendingIncomeOrder.appliedItems.push(...applied);
			game.pendingIncomeOrder.incomeItems = [];
			log(`Player ${player.name} auto-received all income (Optimal Order): ${items.length} items`, 'game', undefined, { simulation: (game as any).simulation });
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		socket.on('undo_income_item', ({ gameId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;

			const isBot = game.botPlayerIds?.includes(game.pendingIncomeOrder?.playerId || '');
			if (!game.pendingIncomeOrder || (game.pendingIncomeOrder.playerId !== playerId && !(isBot && game.hostId === playerId))) return;
			if (game.pendingIncomeOrder.appliedItems.length === 0) return;

			const targetPlayerId = game.pendingIncomeOrder.playerId;
			const player = game.players[targetPlayerId];
			const lastItem = game.pendingIncomeOrder.appliedItems.pop()!;
			const snapshots = game.pendingIncomeOrder.powerBeforeSnapshots;
			if (snapshots && snapshots.length > 0) {
				restorePlayerPowerSnapshot(player, snapshots.pop()!);
			}

			game.pendingIncomeOrder.incomeItems.push(lastItem);

			log(`Player ${player.name} undone income: ${lastItem.amount} ${lastItem.type}`, 'game', undefined, { simulation: (game as any).simulation });
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		/** 테란 의회: 가이아포머 토큰 수만큼 해택 선택 (4→QIC/K, 3→O, 1→C). 소비한 토큰만큼 2그릇에서 차감 */
		socket.on('terran_council_confirm_benefits', ({ gameId, qic = 0, knowledge = 0, ore = 0, credits = 0 }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const pending = game.pendingTerranCouncilBenefit;
			if (!pending || (pending.playerId !== playerId && game.hostId !== playerId)) return;
			const targetPlayerId = pending.playerId;
			const player = game.players[targetPlayerId];
			const totalCost = qic * 4 + knowledge * 4 + ore * 3 + credits * 1;
			if (totalCost > pending.tokenCount || totalCost < 0) {
				io.to(gameId).emit('game_error', { message: 'Terran council: invalid benefit total (4=QIC/K, 3=O, 1=C).' });
				return;
			}
			// [버그수정] 테란 의회 보너스는 '추가 자원'만 준다 — 가이아포머 토큰은 종족 능력대로 이미 2그릇으로
			// 복귀했고(위), 여기서 차감하면 토큰이 사라짐(사용자 관찰). totalCost는 '받을 자원량 한도(토큰 수)'일 뿐.
			grantQic(game, playerId, qic);
			player.knowledge = (player.knowledge ?? 0) + knowledge;
			player.ore = (player.ore ?? 0) + ore;
			player.credits = (player.credits ?? 0) + credits;
			addGameLog(game, playerId, 'Terran Council', `${pending.tokenCount} tokens (2그릇 유지) → ${[qic&&`+${qic}Q`,knowledge&&`+${knowledge}K`,ore&&`+${ore}O`,credits&&`+${credits}C`].filter(Boolean).join(' ')||'없음'}`);
			game.pendingTerranCouncilBenefit = null;
			const queue = game.terranCouncilQueue ?? [];
			if (queue.length > 0) {
				game.pendingTerranCouncilBenefit = queue[0];
				game.terranCouncilQueue = queue.slice(1);
			} else {
				game.terranCouncilQueue = [];
				finishAfterGaiaformerPhase(game);
			}
			clampPlayerResources(game); emitGameUpdated(io, game);
		});

		socket.on('finish_income_selection', ({ gameId }) => {
			console.log(`[DEBUG_INCOME] Received finish_income_selection: gameId=${gameId}`);
			const game = games.get(gameId); if (!game) { console.log(`[DEBUG_INCOME] Game not found: ${gameId}`); return; }
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) { console.log(`[DEBUG_INCOME] PlayerId not found for socket: ${socket.id}`); return; }

			const isBot = game.botPlayerIds?.includes(game.pendingIncomeOrder?.playerId || '');
			if (!game.pendingIncomeOrder || (game.pendingIncomeOrder.playerId !== playerId && !(isBot && game.hostId === playerId))) {
				console.log(`[DEBUG_INCOME] Finish Auth failed. pendingOrder:`, game.pendingIncomeOrder);
				return;
			}
			if (game.pendingIncomeOrder.incomeItems.length > 0) {
				console.log(`[DEBUG_INCOME] Finish failed: remaining items:`, game.pendingIncomeOrder.incomeItems.length);
				log(`Player ${playerId} tried to finish but has remaining income items`, 'game', undefined, { simulation: (game as any).simulation });
				return; // 아직 남은 아이템이 있으면 완료 불가
			}

			const targetPlayerId = game.pendingIncomeOrder.playerId;
			const player = game.players[targetPlayerId];

			// 저장된 수익 정보 제거
			delete (player as any).pendingIncomeItems;

			log(`Player ${player.name} finished income selection`, 'game', undefined, { simulation: (game as any).simulation });
			const finishedPlayerId = game.pendingIncomeOrder.playerId;
			game.pendingIncomeOrder = null;

			// 게임 상태 먼저 업데이트
			clampPlayerResources(game); emitGameUpdated(io, game);

			// 수익 선택이 필요한 다음 플레이어(턴 순서)만 찾아서 대기시킴 (수익 재적용 없음)
			setTimeout(() => triggerIncomePhase(game), 100);
		});

		// 파워 교환 제안 수락/거부 (타클론: brainFirst, piAddFirst 옵션)
		socket.on('respond_power_offer', ({ gameId, offerId, accept, brainFirst, piAddFirst }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			executeRespondPowerOffer(io, game, playerId, offerId, accept, brainFirst, piAddFirst);
		});

		// 파워 제안 일괄 수락 (자동 받기): 토큰 이동 후 파워 추가로 최대한 수용, 큰 제안 먼저 처리
		socket.on('accept_all_power_offers', ({ gameId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (!game.pendingPowerOffers) return;

			// 봇 소켓이거나 인간 플레이어 본인인 경우에만 수락
			// 방장이 인간 플레이어의 제안을 수락할 수는 없지만 봇의 것은 수락 가능
			const myOffers = game.pendingPowerOffers.filter(o => {
				if (o.responded) return false;
				if (o.targetPlayerId === playerId) return true;
				if (game.hostId === playerId && game.botPlayerIds?.includes(o.targetPlayerId)) return true;
				return false;
			});
			// 큰 파워 먼저 받기
			myOffers.sort((a, b) => b.amount - a.amount);

			for (const offer of myOffers) {
				const targetPlayer = game.players[offer.targetPlayerId];
				if (!targetPlayer) continue;

				// [버그수정 2026-07-28 사용자] 오퍼 값(amount/vpCost)은 생성 시점(stale) — 일괄 수락은 큰 것부터
				//   순차 처리라 앞 수락으로 충전여력·점수가 줄면 뒤 오퍼는 그만큼만 충전/무료여야 함 → 현재값으로 재계산.
				const capNow = getMaxPowerGainForOrder(game, offer.targetPlayerId, false); // 봇은 '파워 먼저'
				const chargeNow = Math.min(offer.amount, capNow, (targetPlayer.score ?? 0) + 1);
				const vpNow = Math.max(0, chargeNow - 1);
				offer.responded = true;
				addScore(game, offer.targetPlayerId, -vpNow, 'powerReceived');
				// 파워 수령 로직 통일: 타클론 브레인/PI 보너스 포함
				applyPlayerPowerCharge(game, offer.targetPlayerId, chargeNow, { brainFirst: true });
				const sourcePlayer = game.players[offer.sourcePlayerId];
				const subTxt = `↳ Received Power +${chargeNow}P${vpNow > 0 ? ` (-${vpNow}VP)` : ''} ${targetPlayer.name}`;
				const subAdded = addSubLogToLastAction(game, offer.sourcePlayerId, { playerId: offer.targetPlayerId, playerName: targetPlayer.name, text: subTxt });
				if (!subAdded) addGameLog(game, offer.targetPlayerId, 'Received Power', `+${chargeNow}P from ${sourcePlayer?.name} (-${vpNow}VP)`, offer.tileId);
			}
			game.pendingPowerOffers = game.pendingPowerOffers.filter(o => !o.responded);
			if (game.pendingPowerOffers.length === 0) game.pendingPowerOffers = [];
			if (game.pendingTurnEndPlayerId) {
				// [버그수정 2026-07-28 사용자: 파워 처리 단계 모두 안 끝났는데 다음 사람이 액션] 일괄 수락은 '자기' 오퍼만
				// 해소한다. 다른 플레이어 오퍼가 아직 남았는데도 pendingTurnEndPlayerId만 보고 finalize하면 턴이 조기
				// 종료돼 다음 사람이 먼저 둔다. 단일 응답(executeRespondPowerOffer)과 동일하게 '모든 오퍼 해소' 시에만 종료.
				if ((game.pendingPowerOffers?.length || 0) === 0) {
					const endingPlayerId = game.pendingTurnEndPlayerId;
					finalizeTurnEnd(io, game as ServerGameState, endingPlayerId, { triggerBot: true, reason: 'power_offers_done' });
				} else {
					clampPlayerResources(game); emitGameUpdated(io, game); // 다른 플레이어 오퍼 대기 — 종료 보류
				}
				return;
			}
			clampPlayerResources(game); emitGameUpdated(io, game);

			executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
				log(`Bot turn execution error (accept_all_power_offers): ${err}`, 'error');
			});
		});

		socket.on('pass_round', ({ gameId, newBonusTileId }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;
			if (mainActionBlockedByPending(game)) { socket.emit('game_error', { message: '수입/파워 처리가 진행 중입니다. 완료 후 진행됩니다.' }); return; }
			if (councilPendingActive(game)) { socket.emit('game_error', { message: '다른 플레이어의 선택(의회/이클립스)이 진행 중입니다. 완료되면 이어집니다.' }); return; }
			if (hasActiveRangeBonus(game.players[playerId])) { socket.emit('game_error', { message: RANGE_BONUS_BLOCK_MSG }); return; }

			executePassRound(io, game, playerId, newBonusTileId);
		});

		socket.on('cancel_twilight_federation', ({ gameId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (!game.pendingTwilightFederation || game.pendingTwilightFederation.playerId !== playerId) return;

			const startState = game.turnStartState?.[playerId];
			if (startState) {
				log(`Player ${game.players[playerId].name} canceled Twilight Federation selection (reverting to action start)`, 'game', undefined, { simulation: (game as any).simulation });
				if (startState.fullGameState) {
					const restored = deepClone(startState.fullGameState) as ServerGameState;
					restored.gameLog = restoreGameLogForReset(game, startState, playerId);
					restored.humanActionJournal = startState.humanActionJournalState
						? deepClone(startState.humanActionJournalState)
						: (game.humanActionJournal || []).slice(0, startState.humanActionJournalLength || 0);
					restored.turnStartState = {
						[playerId]: buildTurnStartStateEntryForPlayer(restored, playerId),
					};
					hideHeavyServerFields(restored);
					games.set(gameId, restored);
					clampPlayerResources(restored);
					emitGameUpdated(io, restored); // [대역폭 2026-08-07] 전체 로그 직접 emit → 헬퍼 경유(꼬리40 델타)
				} else {
					game.players[playerId] = deepClone(startState.playerState);
					game.map = deepClone(startState.mapState);
					if (startState.spaceshipsState) game.spaceships = deepClone(startState.spaceshipsState);
					if (startState.twilightArtifactSlots) game.twilightArtifactSlots = deepClone(startState.twilightArtifactSlots);
					game.gameLog = restoreGameLogForReset(game as ServerGameState, startState, playerId);
					game.humanActionJournal = startState.humanActionJournalState
						? deepClone(startState.humanActionJournalState)
						: (game.humanActionJournal || []).slice(0, startState.humanActionJournalLength || 0);
					game.hasDoneMainAction = false;
					game.pendingTwilightFederation = null;
					clampPlayerResources(game);
					emitGameUpdated(io, game);
				}
			} else {
				game.pendingTwilightFederation = null;
				clampPlayerResources(game);
				emitGameUpdated(io, game);
			}
		});




		socket.on('disconnect', () => {
			const playerId = socketToPlayerMap.get(socket.id);
			if (playerId) {
				socketToPlayerMap.delete(socket.id); // 이 소켓 먼저 제거 후 '다른 탭 남았나' 판정
				const gameId = playerGameMap.get(playerId);
				if (gameId) {
					const game = games.get(gameId);
					if (game && game.players[playerId]) {
						log(`Player ${game.players[playerId].name} disconnected`, 'game', undefined, { simulation: (game as any).simulation });
						// 같은 플레이어의 다른 소켓(여러 탭)이 안 남았으면 = 완전히 떠남 → 채팅에 시스템 알림(사용자 요청).
						// 게임 끝(gameEnd 포함) 어느 단계든 창 닫으면 표시. 봇은 소켓이 없으니 해당 없음.
						const stillConnected = Array.from(socketToPlayerMap.values()).includes(playerId);
						if (!stillConnected && !game.botPlayerIds?.includes(playerId)) {
							// [사용자] 즉시 '떠났' 대신 45초 디바운스 — 폰에서 잠깐 앱 전환(카톡 등) 시 스팸 방지.
							//   45초 내 재접속하면 rejoin에서 이 타이머를 지워 아무 알림도 안 뜬다(떠났/다시접속 둘 다 생략).
							const key = `${gameId}:${playerId}`;
							const existing = leftAnnounceTimers.get(key);
							if (existing) clearTimeout(existing);
							const timer = setTimeout(() => {
								leftAnnounceTimers.delete(key);
								const g = games.get(gameId);
								if (!g || !g.players[playerId]) return;
								if (Array.from(socketToPlayerMap.values()).includes(playerId)) return; // 그 사이 재접속함
								const name = g.players[playerId].name;
								const msg = {
									id: generatePlayerId(),
									gameId,
									senderId: 'system',
									name: '시스템',
									faction: null,
									isSpectator: false,
									text: `🚪 ${name}님이 게임을 떠났습니다.`,
									ts: Date.now(),
								};
								if (!g.chatMessages) g.chatMessages = [];
								g.chatMessages.push(msg);
								if (g.chatMessages.length > 100) g.chatMessages = g.chatMessages.slice(-100);
								io.to(gameId).emit('chat_message', msg);
							}, LEFT_ANNOUNCE_DELAY_MS);
							leftAnnounceTimers.set(key, timer);
						}
					}
				}
			}
			const spectatorId = socketToSpectatorMap.get(socket.id);
			if (spectatorId) {
				// [관전자 목록] 접속 끊기면 '현재 관전 중' 목록에서 제거 (spectatorIds는 재접속용으로 유지)
				const specGameId = spectatorToGameMap.get(spectatorId);
				const specGame = specGameId ? games.get(specGameId) : undefined;
				spectatorToGameMap.delete(spectatorId);
				socketToSpectatorMap.delete(socket.id);
				if (specGame) {
					setSpectatorConnected(specGame, spectatorId, false);
					emitGameUpdated(io, specGame);
				}
			}
		});
	});

}

export function saveActionStartState(game: ServerGameState, playerId: string) {
	// 메인 액션이 시작되면 Free Action Undo 내역을 삭제해 더 이상 예전 프리액션 스냅샷으로 되돌리지 못하게 한다.
	if (!game.hasDoneMainAction) {
		clearFreeActionUndo(game);
	}
	// 이미 해당 플레이어의 턴 시작 상태가 저장되어 있다면(이 턴의 첫 번째 액션이 아니라면) 덮어쓰지 않는다.
	if (game.turnStartState?.[playerId]) return;
	if (game.hasDoneMainAction) return;

	if (!game.turnStartState) game.turnStartState = {};
	game.turnStartState[playerId] = buildTurnStartStateEntryForPlayer(game as ServerGameState, playerId);
}

export function executeSelectTechTile(io: SocketIOServer, game: ServerGameState, playerId: string, techTileId: string, trackId?: string, advanceToLevel5?: boolean) {
	if (!game || !game.pendingTechTileSelection) return;
	if (game.pendingTechTileSelection.playerId !== playerId) return;

	const player = game.players[playerId];
	const isShipTech = game.availableShipTechTileIds?.includes(techTileId);
	const techTile = ALL_TECH_TILES.find(t => t.id === techTileId) || SHIP_TECH_TILES.find(t => t.id === techTileId);
	if (!techTile) return;

	// [방어] 탑승하지 않은 우주선의 ship 기술 타일 선택은 무시 (pendingTechTileSelection을 유지해 턴이 넘어가지 않게).
	// 기존엔 이 경우 rebellion_gain 분기로 빠져 효과 없이 타일만 추가되고 pending이 해제되어 턴을 잃는 버그가 있었음.
	if (SHIP_TECH_TILES.some(t => t.id === techTileId) && !isShipTech) {
		log(`Player ${player.name} tried to select ship tech tile ${techTileId} that is not available (ship not entered). Ignored — turn kept.`, 'game', undefined, { simulation: (game as any).simulation });
		return;
	}

	// 획득 로그는 마지막에 한 번만 (트랙 전진 + 즉시 효과 통합, 타일은 tileId로 이미지 표시)
	let advanceDetail = '';

	// 이미 해당 종류의 기술 타일을 가지고 있다면 획득 불가
	if (player.techTiles.includes(techTileId)) {
		log(`Player ${player.name} already owns tech tile ${techTileId}. Cannot gain again.`, 'game', undefined, { simulation: (game as any).simulation });
		return;
	}

	// 우주선 전용 기술 타일 선택 (3개 중 1개) — 획득 후 하단 풀 3개처럼 6개 트랙 중 원하는 트랙 1칸 진행
	if (isShipTech && SHIP_TECH_TILES.some(t => t.id === techTileId)) {
		// 수량 확인 및 차감
		if (!game.shipTechPool || (game.shipTechPool[techTileId] ?? 0) <= 0) {
			log(`Ship Tech Tile ${techTileId} is out of stock.`, 'game', undefined, { simulation: (game as any).simulation });
			return;
		}
		// [룰 2026-07-13] 아이타 의회 교환에서 우주선 타일을 골랐는지 — 이 분기는 조기 반환하므로 아래(5700대)의
		// 잔여 토큰 체인을 여기서도 수행해야 함(누락 시 잔여 토큰 증발 + helperProceed 미호출 = 액션 페이즈 동결).
		const wasItarsExchange = game.pendingTechTileSelection?.structureType === 'itars_pi_exchange';
		game.shipTechPool[techTileId]--;

		if (!player.techTiles.includes(techTileId)) player.techTiles.push(techTileId);
		if (techTileId === 'ship-tech-nav+1') {
			player.navigationBonus = (player.navigationBonus || 0) + 1;
			addGameLog(game, playerId, 'Ship Tech: Nav+1', 'Permanent +1 range', techTileId);
		} else if (techTileId === 'ship-tech-1o3k') {
			player.ore += 1;
			player.knowledge += 3;
			addGameLog(game, playerId, 'Ship Tech: 1O 3K', '+1 Ore, +3 Knowledge', techTileId);
		} else if (techTileId === 'ship-tech-2tf-mine') {
			player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 2;
			player.nextMineFreeFromShipTech = true;
			addGameLog(game, playerId, 'Ship Tech: 2TF+Mine', '2 terraform steps, next mine free', techTileId);
		}
		game.pendingTechTileSelection = null;
		game.availableShipTechTileIds = undefined;
		if (techTileId === 'ship-tech-2tf-mine') {
			// 광산 건설부터 우선 수행
			game.pendingShipTechMine = { playerId };
		} else {
			// [버그수정 2026-08-03 사용자] 아이타 의회 교환에서 온 우주선 타일이면 표시 — 후속 트랙 전진이
			//   '내 턴'에 해소돼도 메인 액션을 소모하면 안 된다(타일 즉시효과). 예전엔 2TF+Mine만 예외라
			//   Nav+1/1O3K를 고르면 hasDoneMainAction=true가 돼 액션을 못 하고 다음 사람으로 넘어갔음.
			game.pendingShipTechTrackAdvance = { playerId, fromItars: wasItarsExchange };
		}
		// [룰 2026-07-13 사용자 확정] 아이타 교환에서 온 선택이면 잔여 토큰 체인 이어가기 —
		// 우주선 후속 pending(트랙전진/광산)은 '내 턴 아닐 때' 해소를 이미 지원(6860대 주석)하므로 공존 가능.
		if (wasItarsExchange) {
			const remainingItars = game.itarsGaiaformerRemainingAfterTech ?? 0;
			// [BUGFIX 2026-07-23 log-confirmed 5i3rsaz3 R4] ship-tech-2tf-mine: place mine + advance track first.
			// Running the exchange chain now makes pendingShipTechMine and the next exchange collide (user rolled back).
			// Mine case: defer (keep remaining) and resume via resumeItarsExchangeChain after mine+track complete.
			if (game.pendingShipTechMine?.playerId === playerId) {
				(game as any).itarsExchangeResumeAfterShipMine = true;
				clampPlayerResources(game); emitGameUpdated(io, game);
				return;
			}
			game.itarsGaiaformerRemainingAfterTech = undefined;
			log(`[ITARS-CHAIN] ${player.name} ship-tech done, remaining=${remainingItars} (round ${game.roundNumber})`, 'game', game.id, { simulation: (game as any).simulation });
			if (remainingItars >= 4) {
				game.pendingItarsGaiaformerExchange = { playerId, tokensRemaining: remainingItars };
			} else {
				player.power1 = (player.power1 || 0) + remainingItars;
				if (remainingItars > 0) addGameLog(game, playerId, 'Itars PI', `${remainingItars} tokens → Bowl 1`);
				try {
					helperProceedAfterItarsGaiaformerOrTerran(io, game);
				} catch (e) {
					log(`[ITARS-CHAIN] helperProceed(ship-tech) EXCEPTION: ${(e as Error)?.stack || e}`, 'error', game.id);
					executeBotTurnIfNeeded(io, game).catch(() => { /* 위에서 로깅됨 */ });
				}
			}
		}
		clampPlayerResources(game); emitGameUpdated(io, game);
		return;
	}

	// 트랙 타일: 배열 중 첫 번째로 일치하는 칸만 비움 (다른 플레이어는 남은 복사본 가져갈 수 있음)
	const trackEntry = Object.entries(game.techTilesByTrack).find(([_, val]) => {
		const arr = Array.isArray(val) ? val : (val ? [val] : []);
		return arr.some((t: { id?: string } | null) => t?.id === techTileId);
	});
	const isRebellionGainTrack = game.pendingTechTileSelection.structureType === 'rebellion_gain';
	if (trackEntry) {
		const [selectedTrack, arr] = trackEntry;
		const tiles = Array.isArray(arr) ? arr : (arr ? [arr] : []);
		const idx = tiles.findIndex((t: { id?: string } | null) => t?.id === techTileId);
		if (idx !== -1 && selectedTrack) {
			const track = selectedTrack as ResearchTrack;
			const currentLevel = player.research[track] ?? 0;
			const baseCanAdvance = currentLevel < 5 && (track !== 'navigation' || canBalTakAdvanceNavigation(game, playerId));
			const targetLevel = baseCanAdvance ? currentLevel + 1 : 0;
			const isLevel5Advance = targetLevel === 5;
			const level5Blocked = isLevel5Advance && isTrackLevel5Taken(game, track, playerId);
			const wantsLevel5 = advanceToLevel5 !== false;
			const canSpendLevel5Fed = !isLevel5Advance || countGreenFederations(player) >= 1;
			const canAdvance = baseCanAdvance && (!isLevel5Advance || (wantsLevel5 && !level5Blocked && canSpendLevel5Fed));
			const newLevel = canAdvance ? targetLevel : 0;
			const isAdvancedTile = techTileId.startsWith('adv-') || Object.values(game.advancedTechTilesByTrack || {}).some((t: { id?: string } | null) => t?.id === techTileId);
			const greenNeeded = (isAdvancedTile ? 1 : 0) + (newLevel === 5 ? 1 : 0);
			if (greenNeeded > 0 && countGreenFederations(player) < greenNeeded) { io.to(game.id).emit('game_error', { message: '녹색 연방 토큰이 없어 이 타일(고급/5단계 진행)을 받을 수 없습니다. 다른 트랙·타일을 고르세요.' }); return; }
			for (let i = 0; i < greenNeeded; i++) spendGreenFederation(player);
			if (canAdvance) {
				player.research[track]++;
				const levelNow = player.research[track];
				const tileLabel = techTile.label || techTileId;
				advanceDetail = `${track} → Lv.${levelNow}`; applyAdvancedTechTileEffect(game, playerId, 'research'); /* adv-vp-research(+2/연구전진) 누락 수정 — 트랙 타일 선택(3QIC/기술연방 포함) */
				log(`Player ${player.name}${isRebellionGainTrack ? ' (Rebellion)' : ''} gained tech tile ${tileLabel} and advanced ${track} to level ${levelNow}`, 'game', undefined, { simulation: (game as any).simulation });
				applyTrackLevelBonus(game, playerId, player, track, levelNow);
				applyRoundMissionScore(game, playerId, 'research_track');
			} else if (isLevel5Advance) {
				const reason = level5Blocked ? 'L5 already occupied' : !canSpendLevel5Fed ? 'no green federation' : 'stayed at L4';
				advanceDetail = `${track} stays L4 (${reason})`;
			}
			if (!player.techTiles.includes(techTileId)) player.techTiles.push(techTileId);
			(game.techTilesByTrack[track] as (typeof tiles[0] | null)[])[idx] = null;
		}
	} else {
		const isRebellionGain = game.pendingTechTileSelection.structureType === 'rebellion_gain';
		const hasTrackId = trackId != null && String(trackId).trim() !== '';
		if (!hasTrackId && !isRebellionGain) { io.to(game.id).emit('game_error', { message: '기술 타일을 받을 연구 트랙을 먼저 선택하세요.' });
			log(`Player ${player.name} selected pool tile but no trackId provided (trackId=${JSON.stringify(trackId)})`, 'game', undefined, { simulation: (game as any).simulation });
			return;
		}
		const selectedTrack = (hasTrackId ? trackId : null) as ResearchTrack | null;
		const validTracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
		const trackOk = selectedTrack && validTracks.includes(selectedTrack);
		const currentLevelPool = trackOk ? (player.research[selectedTrack] ?? 0) : 0;
		const baseCanAdvancePool = Boolean(trackOk && player.research[selectedTrack] < 5 && (selectedTrack !== 'navigation' || canBalTakAdvanceNavigation(game, playerId)));
		const targetLevelPool = baseCanAdvancePool ? currentLevelPool + 1 : 0;
		const isLevel5AdvancePool = targetLevelPool === 5;
		const level5BlockedPool = Boolean(isLevel5AdvancePool && selectedTrack && isTrackLevel5Taken(game, selectedTrack, playerId));
		const wantsLevel5Pool = advanceToLevel5 !== false;
		const canSpendLevel5FedPool = !isLevel5AdvancePool || countGreenFederations(player) >= 1;
		const canAdvancePool = baseCanAdvancePool && (!isLevel5AdvancePool || (wantsLevel5Pool && !level5BlockedPool && canSpendLevel5FedPool));
		const newLevelPool = canAdvancePool ? targetLevelPool : 0;
		const isAdvancedPool = techTileId.startsWith('adv-');
		// [증발 버그수정 2026-08-01] 풀 존재 검증을 초록 연방 소모/트랙 전진 '앞'으로 — 기존엔 연방을 뒤집고
		// 트랙까지 올린 뒤 풀에 타일이 없으면 return해 초록 연방이 증발했다(재시도 시 이중 소모).
		const poolIndexEarly = game.techTilesPool.findIndex(t => t && t.id === techTileId);
		if (poolIndexEarly === -1 && !isRebellionGain) {
			log(`Player ${player.name} selected pool tile ${techTileId} but it's not available in pool.`, 'game', undefined, { simulation: (game as any).simulation });
			return;
		}
		const greenNeededPool = (isAdvancedPool ? 1 : 0) + (newLevelPool === 5 ? 1 : 0);
		if (greenNeededPool > 0 && countGreenFederations(player) < greenNeededPool) { io.to(game.id).emit('game_error', { message: '녹색 연방 토큰이 없어 이 타일(고급/5단계 진행)을 받을 수 없습니다. 다른 트랙·타일을 고르세요.' }); return; }
		for (let i = 0; i < greenNeededPool; i++) spendGreenFederation(player);
		if (canAdvancePool && selectedTrack) {
			player.research[selectedTrack]++;
			const newLevel = player.research[selectedTrack];
			advanceDetail = `${selectedTrack} → Lv.${newLevel}`;
			log(`Player ${player.name}${isRebellionGain ? ' (Rebellion)' : ''} gained tech tile ${techTile.label || techTileId} from pool and advanced ${selectedTrack} to level ${newLevel}`, 'game', undefined, { simulation: (game as any).simulation });
			applyTrackLevelBonus(game, playerId, player, selectedTrack, newLevel);
			applyRoundMissionScore(game, playerId, 'research_track');
			applyAdvancedTechTileEffect(game, playerId, 'research'); // 기술 타일 획득 시 전진에 따른 고급 기술 보너스 누락 해결
		} else if (isLevel5AdvancePool && selectedTrack) {
			const reason = level5BlockedPool ? 'L5 already occupied' : !canSpendLevel5FedPool ? 'no green federation' : 'stayed at L4';
			advanceDetail = `${selectedTrack} stays L4 (${reason})`;
		}

		// 풀 존재 확인은 위(연방 소모 전)에서 완료 — poolIndexEarly 재사용
		const poolIndex = poolIndexEarly;

		if (!player.techTiles.includes(techTileId)) player.techTiles.push(techTileId);
		// 풀에서 해당 칸만 빈 칸으로 표시 (splice로 당기지 않음)
		if (poolIndex !== -1) (game.techTilesPool as (typeof game.techTilesPool[0] | null)[])[poolIndex] = null;
	}

	// 즉시 효과 처리 (로그는 아래에서 트랙 전진과 함께 한 줄로 통합)
	let immediateDetail = '';
	if (techTileId === 'tech-imm-7vp') {
		addScore(game, playerId, 7, 'techTiles', { tileId: techTileId });
		immediateDetail = '+7 VP';
		log(`Player ${player.name} gained 7 VP from tech tile`, 'game', undefined, { simulation: (game as any).simulation });
	} else if (techTileId === 'tech-imm-1o-1q') {
		player.ore = (player.ore || 0) + 1;
		grantQic(game, playerId, 1);
		immediateDetail = '+1 Ore, +1 QIC';
		log(`Player ${player.name} gained 1 Ore and 1 QIC from tech tile (Ore: ${player.ore}, QIC: ${player.qic})`, 'game', undefined, { simulation: (game as any).simulation });
	} else if (techTileId === 'tech-imm-1k-planet') {
		// 보유 행성 유형 수(가상 광산 포함, 다른 점수 경로와 일관)
		const planetTypeCount = getPlayerPlanetTypesForGeodens(game, playerId).size;
		player.knowledge += planetTypeCount;
		immediateDetail = `+${planetTypeCount} Knowledge`;
		log(`Player ${player.name} gained ${planetTypeCount} Knowledge from tech tile (${planetTypeCount} planet types)`, 'game', undefined, { simulation: (game as any).simulation });
	}

	// 통합 로그: 타일 이미지는 tileId로 표시되므로 라벨/풀 출처 문구 없이 한 줄에 전부
	{
		const unified = [advanceDetail, immediateDetail].filter(Boolean).join(' · ');
		addGameLog(game, playerId, isRebellionGainTrack ? 'Rebellion: Gained Tech Tile' : 'Gained Tech Tile', unified || undefined, techTileId);
	}

	// 아이타 의회: 기술 타일 선택 후 남은 가이아포머 토큰 처리 (4개 이상이면 다시 묻기, 아니면 1그릇 복귀 후 진행)
	if (game.pendingTechTileSelection.structureType === 'itars_pi_exchange') {
		const remaining = game.itarsGaiaformerRemainingAfterTech ?? 0;
		game.itarsGaiaformerRemainingAfterTech = undefined;
		// [hang수정 2026-07-07] 사용자 관측: 아이타 3번째 교환 타일 후 게임 정지(봇 재개 로그 전무).
		// 이 체인의 예외가 소켓 핸들러에서 조용히 죽으면 액션 단계가 영영 시작 안 됨 → 진행 로그 + 예외 가시화 +
		// pendingTechTileSelection을 helperProceed *이전에* 정리(재개된 봇/클라가 잔존 pending을 보지 않게).
		log(`[ITARS-CHAIN] ${player.name} tech done, remaining=${remaining} (round ${game.roundNumber})`, 'game', game.id, { simulation: (game as any).simulation });
		if (remaining >= 4) {
			game.pendingItarsGaiaformerExchange = { playerId, tokensRemaining: remaining };
		} else {
			player.power1 = (player.power1 || 0) + remaining;
			if (remaining > 0) addGameLog(game, playerId, 'Itars PI', `${remaining} tokens → Bowl 1`);
			game.pendingTechTileSelection = null;
			game.availableShipTechTileIds = undefined;
			try {
				helperProceedAfterItarsGaiaformerOrTerran(io, game);
			} catch (e) {
				log(`[ITARS-CHAIN] helperProceed EXCEPTION: ${(e as Error)?.stack || e}`, 'error', game.id);
				executeBotTurnIfNeeded(io, game).catch(() => { /* 위에서 로깅됨 */ });
			}
		}
	}

	game.pendingTechTileSelection = null;
	game.availableShipTechTileIds = undefined;
	clampPlayerResources(game); emitGameUpdated(io, game);
}

/** Bot/서버 공용: 고급 기술 타일 선택 (track 4–5 사이 또는 extra tile). */
export function executeSelectAdvancedTechTile(
	io: SocketIOServer, game: ServerGameState,
	playerId: string, advancedTileId: string, trackId?: ResearchTrack
): boolean {
	if (!game || !playerId) return false;
	if (game.currentPhase !== 'main') return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;
	const player = game.players[playerId];
	if (!player) return false;
	// 고급 타일 선택은 기술 타일 선택 대기 중에만 허용
	if (!game.pendingTechTileSelection || game.pendingTechTileSelection.playerId !== playerId) return false;
	// 초록 연방 1개 필요 (소켓 select_advanced_tech_tile와 동일). 없으면 선택 자체 차단 → 커버 단계 stuck 방지.
	if (countGreenFederations(player) < 1) return false;
	// 고급 타일은 각 1개씩만 존재 — 이미 누군가 보유 중이면 중복 획득 거부.
	if (Object.values(game.players).some(p => p.techTiles?.includes(advancedTileId))) return false;

	// [버그수정 2026-08-06 사용자] 소켓 경로와 동일 — 아이타 의회 교환 유래 여부를 커버 단계로 전달
	const fromItarsExchange = game.pendingTechTileSelection?.structureType === 'itars_pi_exchange';
	if (trackId != null) {
		const advTile = game.advancedTechTilesByTrack?.[trackId];
		if (!advTile || advTile.id !== advancedTileId) return false;
		const level = player.research?.[trackId] ?? 0;
		if (level < 4) return false;
		game.pendingAdvancedTechCover = { playerId, advancedTileId, trackId, fromItarsExchange };
	} else {
		const extra = game.extraAdvancedTechTile;
		if (!extra || extra.id !== advancedTileId) return false;
		const cond = game.extraAdvancedTechCondition;
		if (cond === '25vp') {
			if ((player.score ?? 0) < 25) return false;
		} else if (cond === '3ships') {
			const entered = (player.spaceshipsEntered ?? []).length;
			if (entered < 3) return false;
		}
		game.pendingAdvancedTechCover = { playerId, advancedTileId, fromItarsExchange };
	}
		// [hang 수정] 고급타일 선택 확정 시 표준 기술타일 선택 대기를 비워 커버 단계로 전환.
		// 안 비우면 botHandler가 pendingTechTileSelection을 계속 감지해 무한 재선택(게임 hang).
		game.pendingTechTileSelection = null;
		game.availableShipTechTileIds = undefined;
	clampPlayerResources(game); emitGameUpdated(io, game);
	return true;
}

/** Bot/서버 공용: 고급 기술 타일 커버 처리 */
export function executeCoverAdvancedTechTile(
	io: SocketIOServer, game: ServerGameState,
	playerId: string, coverTileId: string
): boolean {
	if (!game || !playerId) return false;
	if (game.currentPhase !== 'main') return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;
	const player = game.players[playerId];
	if (!player) return false;
	const pending = game.pendingAdvancedTechCover;
	if (!pending || pending.playerId !== playerId) return false;
	if (!player.techTiles?.includes(coverTileId) || coverTileId.startsWith('adv-')) return false;

	if (!player.coveredTechTiles) player.coveredTechTiles = [];
	// 이미 커버된 타일이면 실패
	if (player.coveredTechTiles.includes(coverTileId)) return false;
	// 고급 기술 타일 획득은 초록 연방 1개 소모 (소켓 confirm_advanced_tech_cover와 동일). 봇 경로에서 누락돼 있던 버그 수정.
	if (countGreenFederations(player) < 1) return false;
	spendGreenFederation(player);
	player.coveredTechTiles.push(coverTileId);
	if (!player.techTiles.includes(pending.advancedTileId)) player.techTiles.push(pending.advancedTileId);

	// 즉발 효과 → 설명 문자열 반환(별도 'Tech Tile Effect' 로그 없이 아래 'Advanced Tech Tile' 한 줄에 병합)
	const immDesc = (() => {
		const tileId = pending.advancedTileId;
		if (tileId === 'adv-imm-1o-sector') {
			const sectors = occupiedSectorSet(game, playerId, 0, 9);
			player.ore = (player.ore ?? 0) + sectors.size;
			return `+${sectors.size}O (1/sector)`;
		} else if (tileId === 'adv-imm-4vp-ts') {
			const tsCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'trading_station').length;
			addScore(game, playerId, tsCount * 4, 'techTiles', { tileId });
			return `+${tsCount * 4}VP (4/TS)`;
		} else if (tileId === 'adv-imm-2vp-mine') {
			const mineCount = getMineCountForPassAndBonuses(game, playerId);
			addScore(game, playerId, mineCount * 2, 'techTiles', { tileId });
			return `+${mineCount * 2}VP (2/mine)`;
		} else if (tileId === 'adv-imm-2vp-sector') {
			const sectors = occupiedSectorSet(game, playerId, 0, 9);
			addScore(game, playerId, sectors.size * 2, 'techTiles', { tileId });
			return `+${sectors.size * 2}VP (2/sector)`;
		} else if (tileId === 'adv-imm-4vp-outer') {
			const outerCount = countOuterSectorsOccupied(game, playerId);
			addScore(game, playerId, outerCount * 4, 'techTiles', { tileId });
			return `+${outerCount * 4}VP (4/outer sector)`;
		} else if (tileId === 'adv-imm-6vp-big') {
			const bigCount = game.map.filter(t => t.ownerId === playerId && (t.structure === 'planetary_institute' || t.structure === 'academy')).length;
			addScore(game, playerId, bigCount * 6, 'techTiles', { tileId });
			return `+${bigCount * 6}VP (6/big building)`;
		} else if (tileId === 'adv-imm-2vp-gaia') {
			const gaiaCount = game.map.filter(t => t.ownerId === playerId && t.type === 'gaia').length;
			addScore(game, playerId, gaiaCount * 2, 'techTiles', { tileId });
			return `+${gaiaCount * 2}VP (2/Gaia)`;
		} else if (tileId === 'adv-imm-5vp-fed') {
			const fedCount = getFederationEntries(player).length;
			addScore(game, playerId, fedCount * 5, 'techTiles', { tileId });
			return `+${fedCount * 5}VP (5/federation)`;
		}
		return '';
	})();
	// [버그수정 2026-07-08 사용자: 고급기술 로그에 덮인 일반/우주선 기술 이미지 표시] tileId 누락 → GameLog가 details 첫 id(커버타일)를 씀. 4405처럼 고급 tileId 전달.
	addGameLog(game, playerId, 'Advanced Tech Tile', `Covered ${coverTileId} → ${pending.advancedTileId}${immDesc ? ` · ${immDesc}` : ''}`, pending.advancedTileId);
	game.pendingTechTileSelection = null;
	game.pendingAdvancedTechCover = null;
	game.availableShipTechTileIds = undefined;
	game.pendingAdvancedTechTrackAdvance = { playerId, fromItarsExchange: pending.fromItarsExchange };
	clampPlayerResources(game); emitGameUpdated(io, game);
	return true;
}



/** Nav5 잊혀진 행성 광산 배치 (소켓·봇 공용). 일반 광산처럼 파워 제안/연방/점수 모두 처리. */
export function executePlaceLostPlanet(io: SocketIOServer, game: ServerGameState, playerId: string, tileId: string, qicToSpend?: number): boolean {
	if (game.currentPhase !== 'main') return false;
	if (game.pendingLostPlanet?.playerId !== playerId) return false;

	const player = game.players[playerId];
	const tile = game.map.find(t => t.id === tileId);
	if (!player || !tile) return false;
	if (tile.type !== 'space' && tile.type !== 'deep_space') return false;
	if (tile.structure != null || tile.spaceStation) return false;
	const satellites = game.satellites || {};
	const onTile = Array.isArray(satellites[tileId]) ? satellites[tileId]! : (satellites[tileId] ? [satellites[tileId] as string] : []);
	if (onTile.length > 0) return false;

	const rangeTiles = getPlayerRangeTiles(game, playerId);
	if (rangeTiles.length === 0) return false;
	const baseRange = getRange(5) + (player.navigationBonus ?? 0);
	const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
	const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
	// 클라가 보낸 qicToSpend는 참고만 — 서버 산정 neededQIC를 권위로 사용(클라/서버 사거리 계산 차로 인한 무반응 방지).
	void qicToSpend;
	if (player.qic < neededQIC) return false;
	// 잊혀진 행성은 일반 광산 토큰(8개)과 무관한 별도 토큰 → 광산 한도로 막지 않는다(배치는 pendingLostPlanet로 1회만 허용).

	// 다카니안 의회: 잊혀진 행성도 신규 섹터/외각이면 1K 2C.
	const hadStructureInThisSectorLP = game.map.some(t => t.id !== tileId && t.sector === tile.sector && tileOccupiesSector(t, playerId));
	const hadStructureInOuterLP = game.map.some(t => t.id !== tileId && OUTER_SECTORS.includes(t.sector) && tileOccupiesSector(t, playerId));
	const isNewSectorLP = tile.sector !== 90 && !hadStructureInThisSectorLP; // 가운데 전략 헥스(90)는 섹터 아님
	const isNewOuterSectorLP = OUTER_SECTORS.includes(tile.sector) && !hadStructureInOuterLP;
	const darkaniansPiBonusLP = player.faction === 'darkanians' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute') && (isNewSectorLP || isNewOuterSectorLP);

	const geodensTypesBeforeLostPlanet = getPlayerPlanetTypesForGeodens(game, playerId);
	const rm7QualifyLP = qualifiesForNewSectorRoundMission(game, playerId, tileId);
	player.qic -= neededQIC;
	tile.structure = 'lost_planet_mine';
	tile.ownerId = playerId;
	game.pendingLostPlanet = null;
	if (darkaniansPiBonusLP) {
		player.knowledge = (player.knowledge ?? 0) + 1;
		player.credits = (player.credits ?? 0) + 2;
		addGameLog(game, playerId, 'Darkanians PI', 'Lost planet in new sector/outer: +1K, +2C', tileId);
	}
	addGameLog(game, playerId, 'Lost Planet (Nav 5)', neededQIC ? `${neededQIC} QIC` : 'Placed', tileId);
	applyRoundMissionScore(game, playerId, 'build_mine');
	if (rm7QualifyLP) applyRoundMissionScore(game, playerId, 'new_sector');

	const geodensTypesAfterLostPlanet = getPlayerPlanetTypesForGeodens(game, playerId);
	if (geodensTypesAfterLostPlanet.size > geodensTypesBeforeLostPlanet.size) {
		applyRoundMissionScore(game, playerId, 'new_planet_type');
	}

	applyAdvancedTechTileEffect(game, playerId, 'build_mine');
	createPowerOffers(game, tile, playerId);
	addBuildingToFederationIfAdjacent(game, playerId, tileId);
	applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeLostPlanet);
	clampPlayerResources(game); emitGameUpdated(io, game);
	return true;
}

export function executeBuildMine(io: SocketIOServer, game: ServerGameState, playerId: string, tileId: string, useGaiaformer?: boolean): boolean {
	if (!game) {
		log(`executeBuildMine failed: Game state is null`, 'error');
		return false;
	}
	const player = game.players[playerId];
	const isTerraformingPowerActionBuild = (player.pendingTerraformSteps || 0) > 0;
	const isPendingGaiaBuild = (player.pendingGaiaformerTiles || []).includes(tileId);
	const isPendingSpaceshipFedMine = game.pendingSpaceshipFedMine?.playerId === playerId;
	// [버그수정 2026-08-05 사용자] 아이타 PI 교환(가이아 단계)으로 받은 'ship-tech-2tf-mine'의 무료 광산은
	//   액션 단계로 이연된다(교환 시점엔 currentPhase!=='main'이라 즉시 건설 불가). 그런데 그 이연분이 자기 턴
	//   '시작 시점'에 해소되면 아래 hasDoneMainAction=true가 걸려 그 라운드 메인 액션을 통째로 잡아먹었다.
	//   (일반 경로는 연구소 건설=메인액션 직후라 이미 true여서 무해했고, 교환 경로만 손해였다.)
	//   → 교환에서 온 이연 광산은 메인 액션을 소모하지 않는다. 타일의 즉시효과이지 액션이 아니므로.
	const isItarsExchangeShipMine = !!(game as any).itarsExchangeResumeAfterShipMine
		&& game.pendingShipTechMine?.playerId === playerId;
	if (game.hasDoneMainAction && !isTerraformingPowerActionBuild && !isPendingGaiaBuild && !isPendingSpaceshipFedMine) {
		debugLog(game, `executeBuildMine failed: Player ${playerId} has already done a main action`, 'error');
		return false;
	}

	// [순서 2026-08-05 사용자] 아이타 교환의 2TF+무료광산은 '가이아 단계에서 건설까지 끝내고' 액션 단계가
	//   시작돼야 한다 → 그 pending에 한해 phase/턴 게이트를 면제. (액션 단계 시작은 helperStartNewRoundTurn이
	//   이 pending 동안 보류하므로, 이 창에서는 아직 아무의 턴도 아니다.)
	if (game.currentPhase !== 'main' && !isItarsExchangeShipMine) {
		debugLog(game, `executeBuildMine failed: Current phase is ${game.currentPhase}, expected 'main'`, 'error');
		return false;
	}

	// Note: playerId is passed as argument, so we check if it matches current player
	if (game.turnOrder[game.currentPlayerIndex] !== playerId && !isItarsExchangeShipMine) {
		debugLog(game, `executeBuildMine failed: Not Player ${playerId}'s turn (Current: ${game.turnOrder[game.currentPlayerIndex]})`, 'error');
		return false;
	}

	saveActionStartState(game, playerId);

	const tile = game.map.find(t => t.id === tileId);
	if (!tile) {
		debugLog(game, `executeBuildMine failed: Tile ${tileId} not found`, 'error');
		return false;
	}
	const faction = FACTIONS.find(f => f.id === player.faction);
	if (!faction) {
		debugLog(game, `executeBuildMine failed: Faction not found for player ${playerId}`, 'error');
		return false;
	}

	// [사용자 2026-08-01] 테라포밍 스텝 구매 상태(3PW/보너스/TF마스 3C)에서는 1스텝 이상 소모되는 행성만 건설 허용.
	// 가이아·포밍된 행성(스텝 0)은 스텝을 안 쓰고 지어져 스텝이 남고, 메인 액션 후에도 6472 우회로
	// '포밍한 곳 공짜 광산'이 가능했던 exploit 차단. 봇은 제외(교착 방지 — 봇은 이 경로를 악용하지 않음).
	// [예외 확대 2026-08-09 사용자] '2TF+무료광산'류(우주선 기술타일 ship-tech-2tf-mine, 우주선 연방 3TF+무료광산,
	//   아이타 교환 2TF+Mine)는 타일이 광산 자체를 주는 보상이라 테라 스텝을 안 쓰고 모행성(0스텝)에 지어도 정당하다.
	//   위 exploit(스텝만 사놓고 0스텝 행성에 공짜 광산)과 구분되므로 가드에서 제외한다.
	const isGrantedFreeMine = !!player.nextMineFreeFromShipTech || !!player.spaceshipFed3TfMineFree
		|| game.pendingShipTechMine?.playerId === playerId;
	if ((player.pendingTerraformSteps || 0) > 0 && !isPendingSpaceshipFedMine && !isGrantedFreeMine
		&& !game.botPlayerIds?.includes(playerId) && !(game as any).simulation) {
		const stepsNeeded = (tile.type === 'gaia' || tile.type === 'transdim' || isPendingGaiaBuild)
			? 0 : getTerraformStepsForFaction(game, player.faction!, tile.type);
		if (stepsNeeded < 1) {
			debugLog(game, `executeBuildMine rejected: terraform step pending but target ${tileId} (${tile.type}) needs 0 steps`, 'error');
			io.to(game.id).emit('game_error', '테라포밍 스텝을 구매한 상태에서는 1스텝 이상 소모되는 행성에만 광산을 지을 수 있습니다.');
			return false;
		}
	}

	// 0. 전역 광산 개수 제한 체크 (자원 소모 전)
	if (getStructureCount(game, playerId, 'mine') >= BUILDING_LIMITS.mine) {
		const errorMsg = `광산 건설 제한(${BUILDING_LIMITS.mine}개)에 도달했습니다.`;
		debugLog(game, `executeBuildMine failed: ${errorMsg}`, 'error');
		io.to(game.id).emit('game_error', errorMsg);
		return false;
	}

	// Spaceship Fed Mine
	if (game.pendingSpaceshipFedMine?.playerId === playerId) {
		const unbuildable = ['space', 'deep_space', 'lost_fleet_ship', 'ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'];
		// [사용자 관찰 2026-07-22: "클릭해도 아무 반응 없음"] 조용한 거부(debugLog만)를 사람에겐 에러 토스트로 안내
		const notifyReject = (msg: string) => {
			if (!game.botPlayerIds?.includes(playerId) && !(game as any).simulation) io.to(game.id).emit('game_error', msg);
		};
		if (unbuildable.includes(tile.type) || tile.structure !== null) {
			debugLog(game, `executeBuildMine failed (Spaceship Fed): Tile ${tileId} is unbuildable (${tile.type}) or has structure (${tile.structure})`, 'error');
			notifyReject(tile.structure !== null ? '연방 보상 광산은 건물이 없는 행성에만 지을 수 있습니다.' : '연방 보상 광산은 행성에만 지을 수 있습니다 (빈 우주/우주선 불가).');
			return false;
		}
		if (tile.type === 'asteroid') {
			debugLog(game, `executeBuildMine failed (Spaceship Fed): Cannot build on asteroid directly`, 'error');
			notifyReject('연방 보상 광산은 소행성에는 지을 수 없습니다.');
			return false;
		}
		// [사용자 룰 C, 2026-06-29] 무한거리 무료광산: 기본 광산비용(1O2C)·거리QIC는 면제하되,
		//   가이아 행성 기본 QIC와 테라포밍 스텝(광석)은 정상 청구한다. 자원 부족 시 그 행성엔 못 짓는다.
		//   (기존엔 전부 면제라 비-원주민/가이아 행성도 완전 공짜였음 — 사용자 관찰로 교정.)
		const isFedGaiaReclaim = (tile.type === 'transdim' || tile.type === 'gaia') && player.pendingGaiaformerTiles?.includes(tileId);
		let fedGaiaQic = 0, fedTerraOre = 0, fedDiscountSteps = 0;
		if (!isFedGaiaReclaim) {
			if (tile.type === 'gaia') {
				if (player.faction === 'gleens') fedTerraOre = 1; // 글린스는 가이아 비용을 1광석으로
				else fedGaiaQic = getGaiaBaseQic(player.faction || '');
			} else {
				const fedSteps = getTerraformStepsForFaction(game, player.faction!, tile.type as any);
				const pend = player.pendingTerraformSteps || 0;
				fedDiscountSteps = Math.min(pend, fedSteps);
				const actual = fedSteps - fedDiscountSteps;
				fedTerraOre = actual * getTerraformCost(player.research.terraforming);
			}
		}
		// [데드락 수정 2026-06-30] 비용 부족 시 '거부'하면 pendingSpaceshipFedMine이 영영 안 풀려(턴종료도 막힘) 게임이 hang됨
		//   (실측: 80판 중 데드락으로 멈춤). → 거부 대신 '낼 수 있는 만큼만 청구하고 모자라면 면제'해 항상 건설 가능하게.
		//   (사용자 룰: 테라포밍/가이아 비용 청구 — 단 못 낼 땐 면제. 무한거리 무료광산은 어디든 반드시 놓을 수 있어야 함.)
		if ((player.ore ?? 0) < fedTerraOre) { fedTerraOre = 0; fedDiscountSteps = 0; }
		if ((player.qic ?? 0) < fedGaiaQic) fedGaiaQic = 0;
		player.ore = (player.ore ?? 0) - fedTerraOre;
		player.qic = (player.qic ?? 0) - fedGaiaQic;
		if (fedDiscountSteps > 0) player.pendingTerraformSteps = Math.max(0, (player.pendingTerraformSteps || 0) - fedDiscountSteps);
		// (이미 위에서 체크함)
		game.pendingSpaceshipFedMine = null;
		const geodensTypesBefore = getPlayerPlanetTypesForGeodens(game, playerId);
		const rm7Qualify = qualifiesForNewSectorRoundMission(game, playerId, tileId);
		tile.structure = 'mine';
		tile.ownerId = playerId;

		if (tile.hasGaiaformer && player.pendingGaiaformerTiles?.includes(tileId)) {
			tile.hasGaiaformer = false;
			tile.gaiaformerOwnerId = undefined;
			player.gaiaformers = (player.gaiaformers ?? 0) + 1;
			player.pendingGaiaformerTiles = player.pendingGaiaformerTiles.filter(id => id !== tileId);
			/* 'Gaiaformer Returned' 로그 제거 — 불필요(사용자 요청). 포머 복귀 로직은 위에서 이미 처리됨 */
		}

		addGameLog(game, playerId, 'Spaceship Fed', `Mine unlimited range (Free${fedTerraOre ? `, ${fedTerraOre}O terraform` : ''}${fedGaiaQic ? `, ${fedGaiaQic}QIC gaia` : ''})`, tileId);
		applyRoundMissionScore(game, playerId, 'build_mine');
		if (rm7Qualify) applyRoundMissionScore(game, playerId, 'new_sector');
		if (tile.type === 'gaia') applyRoundMissionScore(game, playerId, 'build_gaia');

		// RM8: New Planet Type (RM8)
		const geodensTypesAfter = getPlayerPlanetTypesForGeodens(game, playerId);
		if (geodensTypesAfter.size > geodensTypesBefore.size) {
			applyRoundMissionScore(game, playerId, 'new_planet_type');
		}

		applyAdvancedTechTileEffect(game, playerId, 'build_mine');
		createPowerOffers(game, tile, playerId);
		addBuildingToFederationIfAdjacent(game, playerId, tileId);
		applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBefore);
		game.hasDoneMainAction = true;
		clampPlayerResources(game); emitGameUpdated(io, game);
		return true;
	}

	const freeMine = !!player.nextMineFreeFromShipTech || !!player.spaceshipFed3TfMineFree;

	const clearFreeMineFlags = () => {
		const fromShipTech = player.nextMineFreeFromShipTech;
		if (freeMine) {
			player.nextMineFreeFromShipTech = false;
			if (player.spaceshipFed3TfMineFree) player.spaceshipFed3TfMineFree = false;
		}
		if (game.pendingShipTechMine?.playerId === playerId) {
			game.pendingShipTechMine = null;
			if (fromShipTech) {
				// 광산 건설 완료 후 트랙 전진 단계로
				game.pendingShipTechTrackAdvance = { playerId };
			}
		}
		// 테라포밍 액션(2TF 등)은 광산 1개를 지으면 잔여 단계가 있어도 종료됨
		player.pendingTerraformSteps = 0;
	};

	// Lantids Parasitic
	if (player.faction === 'lantids' && tile.structure != null && tile.ownerId !== playerId && tile.ownerId != null && !tile.parasiticMine) {
		// (이미 위에서 체크함)
		const mineOre = freeMine ? 0 : 1, mineCredits = freeMine ? 0 : 2;
		if ((player.ore ?? 0) < mineOre || (player.credits ?? 0) < mineCredits) {
			debugLog(game, `executeBuildMine failed (Lantida): Insufficient resources (Ore: ${player.ore}/${mineOre}, Credits: ${player.credits}/${mineCredits})`, 'error');
			return false;
		}
		const playerTiles = game.map.filter(t => (t.ownerId === playerId || t.parasiticMine?.ownerId === playerId) && (t.structure != null || t.parasiticMine));
		if (playerTiles.length === 0) {
			debugLog(game, `executeBuildMine failed (Lantida): No existing structures for range calculation`, 'error');
			return false;
		}
		// [증발 버그수정 2026-08-01] +3사거리/글린즈 보너스 플래그를 QIC 검증 '전에' 소모 → 실패 시 보너스만 증발.
		// 가이아포머 배치/우주선 입장과 동일 부류 — 검증 통과 후에만 소모하도록 재배치.
		let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
		if (player.tempRangeBonus) baseRange += 3;
		if (player.rangeBonusActive) baseRange += 3;
		if (player.gleensNavBonusActive) baseRange += 2;
		const minDist = Math.min(...playerTiles.map(t => getDistance(t, tile)));
		const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
		if ((player.qic ?? 0) < neededQIC) {
			debugLog(game, `executeBuildMine failed (Lantida): Insufficient QIC (QIC: ${player.qic}/${neededQIC}, Dist: ${minDist}, Range: ${baseRange})`, 'error');
			return false;
		}
		if (player.tempRangeBonus) player.tempRangeBonus = false;
		if (player.rangeBonusActive) player.rangeBonusActive = false;
		if (player.gleensNavBonusActive) player.gleensNavBonusActive = false;
		player.ore = (player.ore ?? 0) - mineOre;
		player.credits = (player.credits ?? 0) - mineCredits;
		player.qic = (player.qic ?? 0) - neededQIC;
		const rm7QualifyParasitic = qualifiesForNewSectorRoundMission(game, playerId, tileId);
		tile.parasiticMine = { ownerId: playerId };
		addGameLog(game, playerId, 'Built Parasitic Mine', `1O, 2C (Lantida)`, tileId);
		applyRoundMissionScore(game, playerId, 'build_mine');
		if (rm7QualifyParasitic) applyRoundMissionScore(game, playerId, 'new_sector');
		// 란티다 기생 광산은 새로운 행성 유형 및 가이아 점수를 받지 않음
		applyAdvancedTechTileEffect(game, playerId, 'build_mine');
		createPowerOffers(game, tile, playerId);
		addBuildingToFederationIfAdjacent(game, playerId, tileId);
		const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
		if (hasPI) {
			player.knowledge = (player.knowledge || 0) + 2;
			addGameLog(game, playerId, 'Lantida Council', '+2 Knowledge (parasitic build with PI)', tileId);
		}
		clearFreeMineFlags();
		game.hasDoneMainAction = true;
		log(`Player ${player.name} built parasitic mine on ${tileId}`, 'game', undefined, { simulation: (game as any).simulation });
		clampPlayerResources(game); emitGameUpdated(io, game);
		return true;
	}

	// 가이아 포머가 있는 칸: 다른 플레이어 포머이면 건설 불가 / 본인도 성숙·즉시 건설 가능(pendingGaiaformerTiles)일 때만 표준 광산
	if (tile.hasGaiaformer) {
		if (tile.gaiaformerOwnerId != null && tile.gaiaformerOwnerId !== playerId) {
			debugLog(game, `executeBuildMine failed: Gaiaformer on tile belongs to another player`, 'error');
			return false;
		}
		if (!player.pendingGaiaformerTiles?.includes(tileId)) {
			debugLog(game, `executeBuildMine failed: Gaiaformer on tile is not ready for mine (not in pendingGaiaformerTiles)`, 'error');
			return false;
		}
	}

	if (tile.structure !== null) {
		debugLog(game, `executeBuildMine failed: Tile ${tileId} already has structure ${tile.structure}`, 'error');
		return false;
	}

	const unbuildableTypes = ['space', 'deep_space', 'lost_fleet_ship', 'ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'];
	if (unbuildableTypes.includes(tile.type)) {
		debugLog(game, `executeBuildMine failed: Tile ${tileId} type ${tile.type} is unbuildable`, 'error');
		return false;
	}

	// Asteroid
	if (tile.type === 'asteroid') {
		const effectiveGaiaformers = getEffectiveGaiaformers(player);
		if (effectiveGaiaformers <= 0) {
			const errorMsg = '소행성에 광산을 건설하려면 사용 가능한 가이아 포머가 1개 이상 필요합니다.';
			debugLog(game, `executeBuildMine failed (Asteroid): No available gaiaformers (total=${player.gaiaformers ?? 0}, locked=${player.balTakGaiaformersUsedForQic ?? 0})`, 'error');
			// 봇/시뮬의 잘못된 시도는 방 전체에 브로드캐스트하지 않는다(사람 화면에 봇 에러가 새던 문제). 봇은 실패 시 재스케줄됨.
			if (!game.botPlayerIds?.includes(playerId) && !(game as any).simulation) {
				io.to(game.id).emit('game_error', errorMsg);
			}
			return false;
		}
		// [버그수정 2026-06-23] 소행성도 표준 건설과 동일하게 거리(range)·QIC 적용. 이 분기가 range 체크를 건너뛰어
		// QIC가 안 빠지던 버그(클라 mineBuildCost는 neededQIC를 요구/표시하는데 서버 미차감). Eclipse 6C 소행성 경로와 일관.
		let astNeededQIC = 0;
		{
			// [증발 버그수정 2026-08-01] 사거리 보너스 플래그 소모를 QIC 검증 뒤로 (실패 시 보너스 증발 — 란티다 분기와 동일)
			let astBaseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
			if (player.tempRangeBonus) astBaseRange += 3;
			if (player.rangeBonusActive) astBaseRange += 3;
			if (player.gleensNavBonusActive) astBaseRange += 2;
			const astRangeTiles = getPlayerRangeTiles(game, playerId);
			const astMinDist = astRangeTiles.length > 0 ? Math.min(...astRangeTiles.map(t => getDistance(t, tile))) : Infinity;
			astNeededQIC = astMinDist > astBaseRange ? Math.ceil((astMinDist - astBaseRange) / 2) : 0;
			if ((player.qic ?? 0) < astNeededQIC) {
				debugLog(game, `executeBuildMine failed (Asteroid): out of range (need ${astNeededQIC} QIC, have ${player.qic ?? 0})`, 'error');
				if (!game.botPlayerIds?.includes(playerId) && !(game as any).simulation) io.to(game.id).emit('game_error', `소행성이 사거리 밖입니다 (필요 QIC ${astNeededQIC}, 보유 ${player.qic ?? 0}).`);
				return false;
			}
			if (player.tempRangeBonus) player.tempRangeBonus = false;
			if (player.rangeBonusActive) player.rangeBonusActive = false;
			if (player.gleensNavBonusActive) player.gleensNavBonusActive = false;
			player.qic = (player.qic ?? 0) - astNeededQIC;
		}


		const geodensTypesBeforeAsteroid = getPlayerPlanetTypesForGeodens(game, playerId);
		const rm7QualifyAsteroid = qualifiesForNewSectorRoundMission(game, playerId, tileId);
		// 다카니안 의회: 소행성 무료 건설(포머 파괴)도 신규 섹터/외각이면 1K 2C — 이 분기는 표준 경로(아래)를 안 타서 누락됐었음(사용자 관찰).
		const hadStructureInThisSectorAst = game.map.some(t => t.id !== tileId && t.sector === tile.sector && tileOccupiesSector(t, playerId));
		const hadStructureInOuterAst = game.map.some(t => t.id !== tileId && OUTER_SECTORS.includes(t.sector) && tileOccupiesSector(t, playerId));
		const darkaniansPiBonusAst = player.faction === 'darkanians' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute') && ((tile.sector !== 90 && !hadStructureInThisSectorAst) || (OUTER_SECTORS.includes(tile.sector) && !hadStructureInOuterAst));
		tile.structure = 'mine';
		tile.ownerId = playerId;
		tile.destroyedGaiaformer = true; // 가이아포머 파괴 상태 저장
		// 소행성 광산 건설 시 가이아포머 1개 파괴
		player.gaiaformers = Math.max(0, (player.gaiaformers ?? 0) - 1);
		player.destroyedGaiaformers = (player.destroyedGaiaformers ?? 0) + 1;
		addGameLog(game, playerId, 'Built Mine on Asteroid', `${astNeededQIC > 0 ? `${astNeededQIC} QIC · ` : ''}Used 1 Gaiaformer, ${player.gaiaformers} remaining`, tileId);
		if (darkaniansPiBonusAst) {
			player.knowledge = (player.knowledge ?? 0) + 1;
			player.credits = (player.credits ?? 0) + 2;
			addGameLog(game, playerId, 'Darkanians PI', 'New sector / new outer sector: +1K, +2C', tileId);
		}
		applyRoundMissionScore(game, playerId, 'build_mine');
		if (rm7QualifyAsteroid) applyRoundMissionScore(game, playerId, 'new_sector');

		// RM8: New Planet Type (RM8)
		const geodensTypesAfterAsteroid = getPlayerPlanetTypesForGeodens(game, playerId);
		if (geodensTypesAfterAsteroid.size > geodensTypesBeforeAsteroid.size) {
			applyRoundMissionScore(game, playerId, 'new_planet_type');
		}

		applyAdvancedTechTileEffect(game, playerId, 'build_mine');
		createPowerOffers(game, tile, playerId);
		addBuildingToFederationIfAdjacent(game, playerId, tileId);
		applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeAsteroid);
		clearFreeMineFlags();
		game.hasDoneMainAction = true;
		clampPlayerResources(game); emitGameUpdated(io, game);
		return true;
	}

	// Standard Build
	let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
	// [계측 2026-07-20] 사용자 관찰("+3거리 누르고 기본 사거리 안에 건설 = 1K 낭비") 현장 포착용 —
	// 부스트 소모량을 기억해 두고, 건설 거리가 부스트 없이도 닿았으면 diagRangeWaste에 기록(행동 무변경).
	const rangeBoostSpent = (player.tempRangeBonus ? 3 : 0) + (player.rangeBonusActive ? 3 : 0) + (player.gleensNavBonusActive ? 2 : 0);
	// [증발 버그수정 2026-08-01] 사거리 보너스 플래그를 자원 검증 '전에' 소모 → 자원 부족으로 건설 실패해도
	// 보너스만 증발(사용자 제보 "Reset/액션 후 토큰 사라짐" 부류). 소모는 아래 비용 차감 성공 후로 재배치.
	if (player.tempRangeBonus) baseRange += 3;
	if (player.rangeBonusActive) baseRange += 3;
	if (player.gleensNavBonusActive) baseRange += 2;
	const rangeTiles = getPlayerRangeTiles(game, playerId);
	if (rangeTiles.length === 0) {
		debugLog(game, `executeBuildMine failed (Standard): No starting tiles for range calculation`, 'error');
		return false;
	}

	const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
	if (rangeBoostSpent > 0 && minDist <= baseRange - rangeBoostSpent) {
		const entry = { kind: 'boosted-build-within-base-range', player: player.name, isBot: !!game.botPlayerIds?.includes(playerId), round: game.roundNumber, tileId, minDist, baseRangeWithoutBoost: baseRange - rangeBoostSpent, boost: rangeBoostSpent };
		(game as any).diagRangeWaste = (game as any).diagRangeWaste || [];
		(game as any).diagRangeWaste.push(entry);
		log(`[RANGE-WASTE-BUILD] ${JSON.stringify(entry)}`, 'game', game.id);
	}
	let neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;

	// 가이아포머로 미리 포밍해 둔(즉시포밍) 행성에 광산을 짓는지 여부.
	// 아래에서 가이아포머 회수 시 pendingGaiaformerTiles가 비워지므로 로그 계산 전에 미리 잡아둔다.
	const isGaiaformerReclaim = (tile.type === 'transdim' || tile.type === 'gaia') && !!player.pendingGaiaformerTiles?.includes(tileId);

	// 가이아포머가 이미 설치된 행성에 광산을 지을 때는 거리 비용(QIC) 차감 안함 (배치 시 지불 완료)
	if (isGaiaformerReclaim) {
		neededQIC = 0;
	}

	let terraformCost = 0;
	let terraformSteps = 0;
	const pendingTerraformSteps = player.pendingTerraformSteps || 0;
	const standardMineOre = freeMine ? 0 : 1, standardMineCredits = freeMine ? 0 : 2;

	if ((tile.type === 'transdim' || tile.type === 'gaia') && player.pendingGaiaformerTiles?.includes(tileId)) {
		// 가이아 포머 회수 시: QIC 비용 면제, 광산 비용 1광석, 2돈만
		if ((player.ore ?? 0) < standardMineOre || (player.credits ?? 0) < standardMineCredits || (player.qic ?? 0) < neededQIC) {
			debugLog(game, `executeBuildMine failed (Gaiaformer reclaim): Insufficient resources (Ore: ${player.ore}/${standardMineOre}, Credits: ${player.credits}/${standardMineCredits}, QIC: ${player.qic}/${neededQIC})`, 'error');
			return false;
		}
		player.ore = (player.ore ?? 0) - standardMineOre;
		player.credits = (player.credits ?? 0) - standardMineCredits;
		player.qic = (player.qic ?? 0) - neededQIC;
		terraformSteps = 0;
	} else if (tile.type === 'gaia') {
		const isGleens = player.faction === 'gleens';
		if (isGleens) {
			// Gleens pay 1 Ore instead of QIC for Gaia planets. Free mine makes standardMineOre = 0, but they still pay the 1 Ore Gaia cost unless the free mine fully covers it?
			// Actually, "Free mine" means the *mine* is free, not the Gaia cost. Wait, standardMineOre is 0 if free. 0 + 1 = 1 Ore for Gleens.
			const gleensGaiaCost = 1;
			if ((player.ore ?? 0) < (standardMineOre + gleensGaiaCost) || (player.credits ?? 0) < standardMineCredits || (player.qic ?? 0) < neededQIC) {
				debugLog(game, `executeBuildMine failed (Gleens Gaia Planet): Insufficient resources (Ore: ${player.ore}/${standardMineOre + gleensGaiaCost}, Credits: ${player.credits}/${standardMineCredits}, QIC: ${player.qic}/${neededQIC})`, 'error');
				return false;
			}
			player.ore = (player.ore ?? 0) - (standardMineOre + gleensGaiaCost);
			player.credits = (player.credits ?? 0) - standardMineCredits;
			player.qic = (player.qic ?? 0) - neededQIC;
		} else {
			const gaiaBaseQic = getGaiaBaseQic(player.faction || '');
			if ((player.ore ?? 0) < standardMineOre || (player.credits ?? 0) < standardMineCredits || (player.qic ?? 0) < (neededQIC + gaiaBaseQic)) {
				debugLog(game, `executeBuildMine failed (Gaia Planet): Insufficient resources (Ore: ${player.ore}/${standardMineOre}, Credits: ${player.credits}/${standardMineCredits}, QIC: ${player.qic}/${neededQIC + gaiaBaseQic})`, 'error');
				return false;
			}
			player.ore = (player.ore ?? 0) - standardMineOre;
			player.credits = (player.credits ?? 0) - standardMineCredits;
			player.qic = (player.qic ?? 0) - (neededQIC + gaiaBaseQic);
		}
		terraformSteps = 0;
	} else {
		terraformSteps = getTerraformStepsForFaction(game, player.faction!, tile.type);
		const discountSteps = Math.min(pendingTerraformSteps, terraformSteps);
		const actualSteps = terraformSteps - discountSteps;
		// spaceshipFed3TfMineFree의 경우 "3단계를 넘지 않는 한 무료"와 같은 룰인데, 일단 원래 코드 유지
		terraformCost = player.spaceshipFed3TfMineFree ? 0 : actualSteps * getTerraformCost(player.research.terraforming);

		if ((player.ore ?? 0) < (terraformCost + standardMineOre) || (player.credits ?? 0) < standardMineCredits || (player.qic ?? 0) < neededQIC) {
			debugLog(game, `executeBuildMine failed (Standard): Insufficient resources (Ore: ${player.ore}/${terraformCost + standardMineOre}, Credits: ${player.credits}/${standardMineCredits}, QIC: ${player.qic}/${neededQIC})`, 'error');
			return false;
		}
		player.ore = (player.ore ?? 0) - (terraformCost + standardMineOre); player.credits = (player.credits ?? 0) - standardMineCredits; player.qic = (player.qic ?? 0) - neededQIC;
		player.pendingTerraformSteps = Math.max(0, pendingTerraformSteps - discountSteps);
	}

	// ---- 여기부터 성공 확정: 사거리 보너스 플래그 소모 (위 검증 실패 시엔 보존) ----
	if (player.tempRangeBonus) player.tempRangeBonus = false;
	if (player.rangeBonusActive) player.rangeBonusActive = false;
	if (player.gleensNavBonusActive) player.gleensNavBonusActive = false;

	// (이미 위에서 체크함)
	const geodensTypesBefore = getPlayerPlanetTypesForGeodens(game, playerId);
	const hadStructureInThisSector = game.map.some(t => t.id !== tileId && t.sector === tile.sector && tileOccupiesSector(t, playerId));
	const hadStructureInOuter = game.map.some(t => t.id !== tileId && OUTER_SECTORS.includes(t.sector) && tileOccupiesSector(t, playerId));
	const isNewSector = tile.sector !== 90 && !hadStructureInThisSector; // 가운데 전략 헥스(90)는 섹터 아님
	const isNewOuterSector = OUTER_SECTORS.includes(tile.sector) && !hadStructureInOuter;
	const darkaniansPiNewSectorBonus = player.faction === 'darkanians' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute') && (isNewSector || isNewOuterSector);
	const rm7QualifyMine = qualifiesForNewSectorRoundMission(game, playerId, tileId);

	tile.structure = 'mine'; tile.ownerId = playerId;

	if (tile.hasGaiaformer && player.pendingGaiaformerTiles?.includes(tileId)) {
		tile.hasGaiaformer = false;
		tile.gaiaformerOwnerId = undefined;
		player.gaiaformers = (player.gaiaformers ?? 0) + 1;
		player.pendingGaiaformerTiles = player.pendingGaiaformerTiles.filter(id => id !== tileId);
		/* 'Gaiaformer Returned' 로그 제거 — 불필요(사용자 요청). 포머 복귀 로직은 위에서 이미 처리됨 */
	}

	if (darkaniansPiNewSectorBonus) {
		player.knowledge = (player.knowledge ?? 0) + 1;
		player.credits = (player.credits ?? 0) + 2;
		addGameLog(game, playerId, 'Darkanians PI', 'New sector / new outer sector: +1K, +2C', tileId);
	}

	if (tile.type === 'proto') {
		// noLog: 바로 아래 전용 로그가 +6VP를 이미 표기 — addScore 자동로그("+6VP (Proto Planet)")는 중복(사용자)
		addScore(game, playerId, 6, 'other', { source: 'Proto Planet', noLog: true });
		addGameLog(game, playerId, 'Built Mine on Proto', `+6 VP (3 terraforming required)`, tileId);
	}

	// 가이아 광산 보너스(기술타일 +3VP / 글린 +2VP)는 전용 로그줄을 쓰지 않고 아래 'Built Mine' 로그에
	// `(+NVP ...)` 세그먼트로 병합한다(라운드 미션과 동일한 방식, 사용자 요청).
	const gaiaMineVpSegments: Array<{ vp: number; reason: string }> = [];
	if (tile.type === 'gaia' && player.techTiles.includes('tech-gaia-3vp') && !isTechTileCovered(player, 'tech-gaia-3vp')) {
		addScore(game, playerId, 3, 'techTiles', { tileId: 'tech-gaia-3vp' });
		gaiaMineVpSegments.push({ vp: 3, reason: 'Tech Gaia Planet' });
	}
	if (tile.type === 'gaia' && player.faction === 'gleens') {
		addScore(game, playerId, 2, 'other', { source: 'Gleens Gaia Bonus', noLog: true });
		gaiaMineVpSegments.push({ vp: 2, reason: 'Gleens Gaia' });
	}

	let totalQicLog = neededQIC;
	if (tile.type === 'gaia' && player.faction !== 'gleens' && !isGaiaformerReclaim) {
		// 가이아 행성 기본 비용 반영 (글린스는 광석 소모). 단, 가이아포머로 포밍(즉시포밍)한 경우는 비용 면제됨.
		totalQicLog += getGaiaBaseQic(player.faction || '');
	}
	// 비용 표기는 실제 청구액(freeMine이면 0) 기준 — 기존엔 '1O, 2C'를 하드코딩해 무료 광산(우주선 연방 보상 등)에도 비용이 찍히던 버그(사용자 관찰)
	const costDetails = freeMine
		? `Free${totalQicLog > 0 ? `, ${totalQicLog}QIC` : ''}`
		: `${standardMineOre}O, ${standardMineCredits}C${totalQicLog > 0 ? `, ${totalQicLog}QIC` : ''}${terraformCost > 0 ? `, ${terraformCost}O terraform` : ''}`;
	addGameLog(game, playerId, 'Built Mine', `on ${tile.type} (${costDetails})`, tileId);
	for (const seg of gaiaMineVpSegments) appendVpSegmentToLastLog(game, playerId, seg.vp, seg.reason);

	applyRoundMissionScore(game, playerId, 'build_mine');
	if (rm7QualifyMine) applyRoundMissionScore(game, playerId, 'new_sector');
	if (tile.type === 'gaia') {
		applyRoundMissionScore(game, playerId, 'build_gaia');
	}

	// RM8: New Planet Type (RM8)
	const geodensTypesAfterMine = getPlayerPlanetTypesForGeodens(game, playerId);
	if (geodensTypesAfterMine.size > geodensTypesBefore.size) {
		applyRoundMissionScore(game, playerId, 'new_planet_type');
	}
	if (terraformSteps > 0) {
		for (let i = 0; i < terraformSteps; i++) {
			applyRoundMissionScore(game, playerId, 'terraform_step');
			applyAdvancedTechTileEffect(game, playerId, 'terraform');
		}
	}
	applyAdvancedTechTileEffect(game, playerId, 'build_mine');
	// 사거리 연장에 QIC를 쓴 것은 'QIC 액션'(PAC 보라색 액션)이 아니라 단순 비용 지불이므로
	// adv-vp-qic-action(+4VP)을 주지 않는다. (과다점수 버그 수정 — 사용자 관찰)

	createPowerOffers(game, tile, playerId);
	addBuildingToFederationIfAdjacent(game, playerId, tileId);
	applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBefore);

	clearFreeMineFlags();
	// 아이타 교환에서 이연된 무료 광산은 메인 액션 소모 없음(위 isItarsExchangeShipMine 주석 참조).
	if (!isItarsExchangeShipMine) game.hasDoneMainAction = true;
	clampPlayerResources(game); emitGameUpdated(io, game);
	return true;
}

export function executeUpgradeStructure(
	io: SocketIOServer,
	game: ServerGameState,
	playerId: string,
	tileId: string,
	target: StructureType | 'academy_left' | 'academy_right'
): boolean {
	if (!game || game.hasDoneMainAction) return false;
	if (game.currentPhase !== 'main') return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;

	const player = game.players[playerId];
	const tile = game.map.find(t => t.id === tileId);
	if (!tile || tile.ownerId !== playerId) return false;
	if (tile.structure === 'lost_planet_mine') return false;

	saveActionStartState(game, playerId);

	if (tile.structure === 'mine' && target === 'trading_station') {
		if (getStructureCount(game, playerId, 'trading_station') >= BUILDING_LIMITS.trading_station) return false;
		const hasNearby = hasNearbyPlayersForDiscount(game, tile, playerId);
		const creditCost = hasNearby ? 3 : 6;
		if ((player.ore ?? 0) < 2 || (player.credits ?? 0) < creditCost) return false;
		player.ore = (player.ore ?? 0) - 2; player.credits = (player.credits ?? 0) - creditCost; tile.structure = 'trading_station'; game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Upgraded to Trading Station', `2O, ${creditCost}C`, tileId);
		applyRoundMissionScore(game, playerId, 'build_trading_station');
		applyAdvancedTechTileEffect(game, playerId, 'build_ts');
		createPowerOffers(game, tile, playerId);
		addBuildingToFederationIfAdjacent(game, playerId, tileId);
		clampPlayerResources(game); emitGameUpdated(io, game);
		return true;
	} else if (tile.structure === 'trading_station' && target === 'research_lab') {
		if (getStructureCount(game, playerId, 'research_lab') >= BUILDING_LIMITS.research_lab) return false;
		if ((player.ore ?? 0) < 3 || (player.credits ?? 0) < 5) return false;
		player.ore = (player.ore ?? 0) - 3; player.credits = (player.credits ?? 0) - 5; tile.structure = 'research_lab'; game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Upgraded to Research Lab', '3O, 5C', tileId); applyRoundMissionScore(game, playerId, 'build_research_lab');
		/* build_research_lab 라운드 미션은 건물 로그 직후에 처리(로그 같은 줄에 +VP 병합) */
		createPowerOffers(game, tile, playerId);
		addBuildingToFederationIfAdjacent(game, playerId, tileId);
		game.pendingTechTileSelection = { playerId, tileId, structureType: 'research_lab' };
		game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
		clampPlayerResources(game); emitGameUpdated(io, game);
		return true;
	} else if (tile.structure === 'trading_station' && target === 'planetary_institute') {
		if (player.faction === 'bescods') return false;
		if (getStructureCount(game, playerId, 'planetary_institute') >= BUILDING_LIMITS.planetary_institute) return false;
		if ((player.ore ?? 0) < 4 || (player.credits ?? 0) < 6) return false;
		player.ore = (player.ore ?? 0) - 4; player.credits = (player.credits ?? 0) - 6; tile.structure = 'planetary_institute'; game.hasDoneMainAction = true;
		if (player.faction === 'hadsch_hallas' && !player.hadschHallasPIActions?.length) {
			player.hadschHallasPIActions = [
				{ id: 'hh-4c-1qic', costCredits: 4, label: '4C→1QIC', isUsed: false },
				{ id: 'hh-4c-1k', costCredits: 4, label: '4C→1K', isUsed: false },
				{ id: 'hh-3c-1o', costCredits: 3, label: '3C→1O', isUsed: false },
			];
			log(`Player ${player.name} (Hadsch Hallas) gained PI free actions: 4C→1QIC, 4C→1K, 3C→1O`, 'game', undefined, { simulation: (game as any).simulation });
		}
		if (player.faction === 'space_giants') {
			game.pendingTechTileSelection = { playerId: playerId, tileId, structureType: 'space_giants_pi' };
			game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
			addGameLog(game, playerId, 'Space Giants: PI built', 'Choose 1 tech tile + track', tileId);
		}
		if (player.faction === 'gleens') {
			grantGleensFederationReward(game, playerId, tileId);
		}

		addGameLog(game, playerId, 'Upgraded to Planetary Institute', '4O, 6C', tileId);
		applyRoundMissionScore(game, playerId, 'build_big_building');
		createPowerOffers(game, tile, playerId);
		addBuildingToFederationIfAdjacent(game, playerId, tileId);
		clampPlayerResources(game); emitGameUpdated(io, game);
		return true;
	} else if (tile.structure === 'research_lab' && target === 'planetary_institute' && player.faction === 'bescods') {
		if (getStructureCount(game, playerId, 'planetary_institute') >= BUILDING_LIMITS.planetary_institute) return false;
		if ((player.ore ?? 0) < 4 || (player.credits ?? 0) < 6) return false;
		player.ore = (player.ore ?? 0) - 4; player.credits = (player.credits ?? 0) - 6; tile.structure = 'planetary_institute'; game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Upgraded to Planetary Institute (Bescods/매안)', '4O, 6C', tileId);
		applyRoundMissionScore(game, playerId, 'build_big_building');
		createPowerOffers(game, tile, playerId);
		addBuildingToFederationIfAdjacent(game, playerId, tileId);
		clampPlayerResources(game); emitGameUpdated(io, game);
		return true;
	} else if (tile.structure === 'trading_station' && (target === 'academy_left' || target === 'academy_right') && player.faction === 'bescods') {
		const academyTotal = game.map.filter(t => t.ownerId === playerId && t.structure === 'academy').length;
		if (academyTotal >= BUILDING_LIMITS.academy) return false;
		const leftCount = getAcademyLeftCount(game, playerId);
		const rightCount = getAcademyRightCount(game, playerId);
		if (target === 'academy_left' && leftCount >= 1) return false;
		if (target === 'academy_right' && rightCount >= 1) return false;
		if ((player.ore ?? 0) < 6 || (player.credits ?? 0) < 6) return false;
		player.ore = (player.ore ?? 0) - 6; player.credits = (player.credits ?? 0) - 6;
		tile.structure = 'academy';
		tile.academyType = target === 'academy_left' ? 'left' : 'right';
		game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Upgraded to Academy (Bescods/매안)', target === 'academy_left' ? '6O, 6C (2K 수익)' : '6O, 6C (1QIC 액션)', tileId);
		applyRoundMissionScore(game, playerId, 'build_big_building');
		createPowerOffers(game, tile, playerId);
		addBuildingToFederationIfAdjacent(game, playerId, tileId);
		game.pendingTechTileSelection = { playerId, tileId, structureType: 'academy' };
		game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
		clampPlayerResources(game); emitGameUpdated(io, game);
		return true;
	} else if (tile.structure === 'research_lab' && (target === 'academy_left' || target === 'academy_right')) {
		if (player.faction === 'bescods') return false;
		const academyTotal = game.map.filter(t => t.ownerId === playerId && t.structure === 'academy').length;
		if (academyTotal >= BUILDING_LIMITS.academy) return false;
		const leftCount = getAcademyLeftCount(game, playerId);
		const rightCount = getAcademyRightCount(game, playerId);
		if (target === 'academy_left' && leftCount >= 1) return false;
		if (target === 'academy_right' && rightCount >= 1) return false;
		if ((player.ore ?? 0) < 6 || (player.credits ?? 0) < 6) return false;
		player.ore = (player.ore ?? 0) - 6; player.credits = (player.credits ?? 0) - 6;
		tile.structure = 'academy';
		tile.academyType = target === 'academy_left' ? 'left' : 'right';
		game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Upgraded to Academy', target === 'academy_left' ? `6O, 6C (${player.faction === 'itars' ? 3 : 2}K 수익)` : '6O, 6C (1QIC 액션)', tileId);
		applyRoundMissionScore(game, playerId, 'build_big_building');
		createPowerOffers(game, tile, playerId);
		addBuildingToFederationIfAdjacent(game, playerId, tileId);
		game.pendingTechTileSelection = { playerId, tileId, structureType: 'academy' };
		game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
		clampPlayerResources(game); emitGameUpdated(io, game);
		return true;
	}

	return false;
}

/** 모웨이드/팅커로이드 확장 행성 — 종족 확정 후 호출 */
// [룰 2026-07-27 사용자] 모웨+팅커 공존 시 3삽 = 고정 2개(일반 종족들 홈, 두 종족 공유) + 추첨 2개(A/B).
//   추첨은 남은 HOME_PLANETS에서 랜덤 2개, 한 번만 뽑아 저장(비딩 표기·finalize 배정 동일값). 턴 앞(selectedTurnOrder 작은)=A, 뒷턴=B.
//   일반 종족 전원 배정돼야 고정이 확정되므로 그 시점에 추첨(멱등).
/** 확장 3삽: 단일 확장종족(모웨 또는 팅커 하나만)일 때, 비딩 시작 시점에 '랜덤 보충분'까지 확정해 저장한다.
 *  비딩 UI에서 '(+랜덤 보충)' 문구 없이 실제 3개를 바로 보여주고, 이후 배정 확정 시 재랜덤되지 않도록 하기 위함(사용자). */
function freezeSingleExpansionThreeStep(game: ServerGameState): void {
	const players = Object.values(game.players);
	const total = players.length;
	const assignedFacs = players.map(pl => pl.faction).filter((f): f is string => !!f);
	const poolFacs = game.factionBidding?.remainingFactionIds ?? [];
	const allFacs = Array.from(new Set([...assignedFacs, ...poolFacs]));
	if (allFacs.length < total) return; // 종족 풀 미확정이면 대기
	const hasMowe = allFacs.includes('moweyip');
	const hasTink = allFacs.includes('tinkeroids');
	if (hasMowe && hasTink) return; // 두 확장종족 공존은 computeTwoExpansionDraw가 담당
	const otherHomes = (excludeFac: string) => allFacs
		.filter(f => f !== excludeFac)
		.map(f => FACTIONS.find(x => x.id === f)?.homePlanet)
		.filter((h): h is import('@shared/gameConfig').PlanetType => !!h && HOME_PLANETS.includes(h));
	if (hasMowe && !game.moweyipThreeStepPlanets) {
		game.moweyipThreeStepPlanets = computeExpansionThreeStepPlanets(otherHomes('moweyip'));
		log(`Moweyip expansion(bidding freeze): 3-step planets = ${game.moweyipThreeStepPlanets.join(', ')}`, 'game', undefined, { simulation: (game as any).simulation });
	}
	if (hasTink && !game.tinkeroidsThreeStepPlanets) {
		game.tinkeroidsThreeStepPlanets = computeExpansionThreeStepPlanets(otherHomes('tinkeroids'));
		log(`Tinkeroids expansion(bidding freeze): 3-step planets = ${game.tinkeroidsThreeStepPlanets.join(', ')}`, 'game', undefined, { simulation: (game as any).simulation });
	}
}

function computeTwoExpansionDraw(game: ServerGameState): void {
	if ((game as any).expansionTwoFactionDraw) return;
	const players = Object.values(game.players);
	const total = players.length;
	// [2026-07-27 사용자] 비딩 풀은 시작 시 확정 → 배정 완료를 기다리지 않고 풀(배정+잔여) 기준으로 즉시 확정.
	// (기존: 배정된 플레이어만 봐서 비딩 하나 끝날 때마다 3삽 목록이 자라 보이던 문제)
	const assignedFacs = players.map(pl => pl.faction).filter((f): f is string => !!f);
	const poolFacs = game.factionBidding?.remainingFactionIds ?? [];
	const allFacs = Array.from(new Set([...assignedFacs, ...poolFacs]));
	if (!allFacs.includes('moweyip') || !allFacs.includes('tinkeroids')) return;
	if (allFacs.length < total) return; // 종족 풀 자체가 미확정일 때만 대기
	const normalFacs = allFacs.filter(f => f !== 'moweyip' && f !== 'tinkeroids');
	if (normalFacs.length !== total - 2) return;
	const fixed = Array.from(new Set(
		normalFacs.map(f => FACTIONS.find(x => x.id === f)?.homePlanet)
		.filter((h): h is import('@shared/gameConfig').PlanetType => !!h && HOME_PLANETS.includes(h))
	));
	const need = Math.max(1, 3 - fixed.length);
	const remaining = HOME_PLANETS.filter(h => !fixed.includes(h));
	const shuffled = remaining.slice().sort(() => Math.random() - 0.5);
	(game as any).expansionTwoFactionDraw = { fixed, drawA: shuffled.slice(0, need), drawB: shuffled.slice(need, 2 * need) };
}

function applyMoweyipTinkeroidsExpansionPlanets(game: ServerGameState): void {
	const playerList = Object.values(game.players);
	const moweyipPlayer = playerList.find(p => p.faction === 'moweyip');
	const tinkeroidsPlayer = playerList.find(p => p.faction === 'tinkeroids');
	if (moweyipPlayer && tinkeroidsPlayer) {
		// 두 확장종족 공존: 고정 공용 + A/B 추첨, 턴 빠른 쪽=A 느린 쪽=B (사용자 룰).
		computeTwoExpansionDraw(game);
		const d = (game as any).expansionTwoFactionDraw as { fixed: string[]; drawA: string[]; drawB: string[] } | undefined;
		if (d) {
			const mOrder = (moweyipPlayer as any).selectedTurnOrder ?? 99;
			const tOrder = (tinkeroidsPlayer as any).selectedTurnOrder ?? 99;
			const moweyipEarlier = mOrder <= tOrder;
			game.moweyipThreeStepPlanets = [...d.fixed, ...(moweyipEarlier ? d.drawA : d.drawB)] as import('@shared/gameConfig').PlanetType[];
			game.tinkeroidsThreeStepPlanets = [...d.fixed, ...(moweyipEarlier ? d.drawB : d.drawA)] as import('@shared/gameConfig').PlanetType[];
			log(`Expansion(2-faction): fixed=${d.fixed.join(',')} A=${d.drawA.join(',')} B=${d.drawB.join(',')} | moweyip(o${mOrder})=${game.moweyipThreeStepPlanets.join(',')} tinkeroids(o${tOrder})=${game.tinkeroidsThreeStepPlanets.join(',')}`, 'game', undefined, { simulation: (game as any).simulation });
			return;
		}
	}
	if (moweyipPlayer) {
		const otherHomes = playerList
			.filter(p => p.faction && p.faction !== 'moweyip')
			.map(p => FACTIONS.find(f => f.id === p.faction)?.homePlanet)
			.filter((h): h is import('@shared/gameConfig').PlanetType => h != null && HOME_PLANETS.includes(h));
		// 비딩 시작 시 이미 확정(freeze)했으면 그대로 사용 — 재랜덤 방지(사용자)
		game.moweyipThreeStepPlanets = game.moweyipThreeStepPlanets ?? computeExpansionThreeStepPlanets(otherHomes);
		log(`Moweyip expansion: 3-step planets = ${game.moweyipThreeStepPlanets.join(', ')}`, 'game', undefined, { simulation: (game as any).simulation });
	}
	if (tinkeroidsPlayer) {
		const otherHomes = playerList
			.filter(p => p.faction && p.faction !== 'tinkeroids')
			.map(p => FACTIONS.find(f => f.id === p.faction)?.homePlanet)
			.filter((h): h is import('@shared/gameConfig').PlanetType => h != null && HOME_PLANETS.includes(h));
		// 비딩 시작 시 이미 확정(freeze)했으면 그대로 사용 — 재랜덤 방지(사용자)
		game.tinkeroidsThreeStepPlanets = game.tinkeroidsThreeStepPlanets ?? computeExpansionThreeStepPlanets(otherHomes);
		log(`Tinkeroids expansion: 3-step planets = ${game.tinkeroidsThreeStepPlanets.join(', ')}`, 'game', undefined, { simulation: (game as any).simulation });
	}
}

export function finalizeFactionSelectionToStartingMines(io: SocketIOServer, game: ServerGameState): void {
	log(`All players selected faction. Finalizing turn order and moving to startingMines.`, 'game', undefined, { simulation: (game as any).simulation });
	game.factionBidding = null;

	const playersWithOrder = Object.values(game.players)
		.filter(p => (p as any).selectedTurnOrder !== undefined)
		.map(p => ({ id: Object.keys(game.players).find(key => game.players[key] === p)!, order: (p as any).selectedTurnOrder }));

	const takenOrders = new Set(playersWithOrder.map(x => x.order));
	const playersWithoutOrder = Object.keys(game.players).filter(id => !playersWithOrder.find(p => p.id === id));

	const numPlayers = Object.keys(game.players).length;
	const availableOrders = Array.from({ length: numPlayers }, (_, i) => i + 1).filter(o => !takenOrders.has(o));

	const finalOrders = [...playersWithOrder];
	playersWithoutOrder.forEach((id, index) => {
		if (availableOrders[index] !== undefined) {
			finalOrders.push({ id, order: availableOrders[index] });
		}
	});

	finalOrders.sort((a, b) => a.order - b.order);
	game.turnOrder = finalOrders.map(x => x.id);

	game.currentPhase = 'startingMines';
	(game as any).startingMineSequence = buildStartingMineSequence(game);
	log(`Turn order finalized: ${game.turnOrder.join(', ')}`, 'game', undefined, { simulation: (game as any).simulation });

	applyMoweyipTinkeroidsExpansionPlanets(game);

	if (game.turnOrder?.length) {
		const seq = buildStartingMineSequence(game);
		const total = Object.values(game.players).reduce((s, p) => s + (p.startingMinesPlaced || 0), 0);
		if (total < seq.length) {
			const idx = game.turnOrder.indexOf(seq[total]);
			if (idx >= 0) game.currentPlayerIndex = idx;
		}
	}
	clampPlayerResources(game);
}

export function executeSelectFaction(
	io: SocketIOServer,
	game: ServerGameState,
	playerId: string,
	factionId: string,
	turnOrder?: number,
	options?: { skipBotTrigger?: boolean }
): boolean {
	const player = game.players[playerId];
	if (!player) return false;

	const requestedFaction = FACTIONS.find(f => f.id === factionId);
	if (!requestedFaction) return false;

	// Check if faction or color is already taken by another player
	const alreadyTaken = Object.entries(game.players).some(([id, p]) => {
		if (id === playerId || !p.faction) return false;
		if (p.faction === factionId) return true;

		const otherFaction = FACTIONS.find(f => f.id === p.faction);
		return otherFaction?.color === requestedFaction.color;
	});

	if (alreadyTaken) {
		log(`Collision: Faction ${factionId} or its color is already taken.`, 'game', undefined, { simulation: (game as any).simulation });
		return false;
	}

	// Check if turn order is already taken
	if (turnOrder !== undefined) {
		const turnOrderTaken = Object.entries(game.players).some(([id, p]) => {
			if (id === playerId) return false;
			return (p as any).selectedTurnOrder === turnOrder;
		});

		if (turnOrderTaken) {
			log(`Collision: Turn order ${turnOrder} is already taken.`, 'game', undefined, { simulation: (game as any).simulation });
			return false;
		}

		(player as any).selectedTurnOrder = turnOrder;
	}

	player.faction = factionId;
	const faction = FACTIONS.find(f => f.id === factionId);
	if (faction) {
		addGameLog(game, playerId, 'Selected Faction', faction.name);
		log(`Applying starting specs for ${faction.name}`, 'game', undefined, { simulation: (game as any).simulation });

		// Resources (글린: 시작 QIC는 광물로)
		player.ore = faction.startingResources.ore;
		player.knowledge = faction.startingResources.knowledge;
		player.credits = faction.startingResources.credits;
		if (factionId === 'gleens' && (faction.startingResources.qic ?? 0) > 0) {
			player.ore = (player.ore ?? 0) + (faction.startingResources.qic ?? 0);
			player.qic = 0;
		} else {
			player.qic = faction.startingResources.qic;
		}
		// 개발 중: 테스트 모드일 때 자원 10O 15C 8K 20QIC 추가 (글린은 QIC→광물)
		if (game.isTestMode) {
			player.ore += 10;
			player.credits += 15;
			player.knowledge += 8;
			grantQic(game, playerId, 20);
		}

		// Power Bowls (타클론: 브레인 스톤은 그릇1에)
		player.power1 = faction.startingPower.bowl1;
		player.power2 = faction.startingPower.bowl2;
		player.power3 = faction.startingPower.bowl3;
		if (factionId === 'taklons') {
			player.brainStoneBowl = 1;
			player.brainStoneInGaia = false;
		}

		// Techs
		if (faction.startingTech) {
			Object.entries(faction.startingTech).forEach(([track, level]) => {
				const lvl = level as number;
				if (player.research) {
					player.research[track as ResearchTrack] = Math.max(player.research[track as ResearchTrack] || 0, lvl);

					// Apply immediate setup bonuses for starting tech (글린: QIC→광물)
					if (lvl >= 1) {
						if (track === 'terraforming') player.ore += 2;
						if (track === 'navigation') grantQic(game, playerId, 1);
						if (track === 'artificialIntelligence') grantQic(game, playerId, 1);
						// 가이아 프로젝트 1단계: 가이아 포머 1개 (테란 등)
						if (track === 'gaiaProject' && lvl === 1) {
							player.gaiaformers = (player.gaiaformers || 0) + 1;
							log(`Player ${player.name} gained 1 Gaiaformer from starting tech (Gaia Project level 1)`, 'game', undefined, { simulation: (game as any).simulation });
						}
					}
				}
			});
		}

		// Moweyip start with TF Mars ship occupied & unlocked
		if (factionId === 'moweyip') {
			const tfMarsTile = game.map.find(t => t.type === 'ship_tf_mars');
			if (tfMarsTile && game.spaceships?.[tfMarsTile.id]) {
				const ship = game.spaceships[tfMarsTile.id];
				if (!ship.occupants.includes(playerId)) {
					ship.occupants.push(playerId);
					ship.unlocked = true; // Moweyip starts with ship activated
					if (!player.spaceshipsEntered) player.spaceshipsEntered = [];
					if (!player.spaceshipsEntered.includes(tfMarsTile.id)) {
						player.spaceshipsEntered.push(tfMarsTile.id);
					}
					log(`Moweyip player ${player.name} startingly occupied & unlocked ${tfMarsTile.id} (TF Mars)`, 'game', undefined, { simulation: (game as any).simulation });
				}
			}
		}
	}


	// 모든 플레이어가 종족 선택을 마쳤다면 턴 순서 확정 및 단계 전환
	const allHaveFaction = Object.values(game.players).every(p => p.faction != null);
	if (allHaveFaction && (game.currentPhase === 'factionSelect' || game.currentPhase === 'factionBidding')) {
		finalizeFactionSelectionToStartingMines(io, game);
	}

	// 시작 광산 단계에서 종족을 고르면 "지금 배치할 사람"으로 턴 동기화 (1번=하이브, 2번=테란 → 2번 턴으로)
	if (game.currentPhase === 'startingMines' && game.turnOrder?.length) {
		const seq = buildStartingMineSequence(game);
		const total = Object.values(game.players).reduce((s, p) => s + (p.startingMinesPlaced || 0), 0);
		if (total < seq.length) {
			const idx = game.turnOrder.indexOf(seq[total]);
			if (idx >= 0) game.currentPlayerIndex = idx;
		}
	}

	log(`Player ${player.name} selected faction ${factionId}. State: ${JSON.stringify(player)}`, 'game', undefined, { simulation: (game as any).simulation });
	clampPlayerResources(game); emitGameUpdated(io, game);

	if (!options?.skipBotTrigger) {
		executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
			log(`Bot turn execution error (SelectFaction): ${err}`, 'error');
		});
	}

	return true;
}

export function executePlaceStartingMine(
	io: SocketIOServer,
	game: ServerGameState,
	playerId: string,
	tileId: string,
	factionId?: string
): string | null {
	if (game.currentPhase !== 'startingMines') return '지금은 시작 광산 배치 단계가 아닙니다.';

	const player = game.players[playerId];
	if (!player) return '플레이어를 찾을 수 없습니다.';

	// 종족이 아직 선택되지 않았으면 선택
	if (!player.faction && factionId) {
		const success = executeSelectFaction(io, game, playerId, factionId);
		if (!success) return '종족을 선택할 수 없습니다.';
	}

	const faction = FACTIONS.find(f => f.id === player.faction);
	if (!faction) return '종족을 먼저 선택하세요.';

	// Get faction-specific starting mines count (default 2)
	const maxStartingMines = faction.startingMines ?? 2;
	// Get faction-specific starting structure (default 'mine')
	const startingStructure = faction.startingStructure ?? 'mine';

	// 룰: 턴 순서(하이브·확장4 제외) 1개씩 → 역순 1개씩 → 제노스 1개 → 확장 4종족 각 1개 → 하이브 의회
	const snakingSequence: string[] = (game as any).startingMineSequence ?? buildStartingMineSequence(game);

	const totalMinesPlaced = Object.values(game.players).reduce((sum, p) => sum + p.startingMinesPlaced, 0);

	if (totalMinesPlaced >= snakingSequence.length) return '모든 시작 건물을 이미 배치했습니다.';

	const expectedPlayerId = snakingSequence[totalMinesPlaced];
	// 항상 "지금 배치할 사람"으로 턴 표시 동기화
	const expectedIndex = game.turnOrder.indexOf(expectedPlayerId);
	if (expectedIndex >= 0) game.currentPlayerIndex = expectedIndex;

	if (playerId !== expectedPlayerId) {
		log(`Wait for turn! Expected ${expectedPlayerId}, but got ${playerId}`, 'game', undefined, { simulation: (game as any).simulation });
		clampPlayerResources(game); emitGameUpdated(io, game);
		return `지금은 다른 플레이어의 차례입니다.`;
	}

	if (player.startingMinesPlaced >= maxStartingMines) return '이미 시작 건물을 모두 배치했습니다.';

	const tile = game.map.find(t => t.id === tileId);
	if (!tile || tile.structure !== null) return '해당 타일에 배치할 수 없습니다.';

	if (tile.type !== faction.homePlanet) return `${faction.name}은(는) ${faction.homePlanet} 행성에만 배치할 수 있습니다.`;

	// [사용자 2026-08-03] 최초 집 배치 단계도 롤백 가능하게 — 배치 '직전' 상태를 롤백 히스토리에 남긴다.
	// (main 단계는 턴 시작마다 captureTurnStartWithPrev가 남기지만 startingMines엔 스냅샷이 없어 되돌릴 지점이 0이었음)
	captureTurnStartWithPrev(game, playerId);

	tile.structure = startingStructure;
	tile.ownerId = playerId;
	player.startingMinesPlaced++;

	const structureName = startingStructure === 'planetary_institute' ? 'Planetary Institute' : 'Mine';
	addGameLog(game, playerId, `Placed Starting ${structureName}`, `Position: ${tileId}`, tileId);
	log(`Player ${player.name} (${faction.name}) placed ${structureName} #${player.startingMinesPlaced}. Total: ${totalMinesPlaced + 1}`, 'game', undefined, { simulation: (game as any).simulation });

	const newTotal = totalMinesPlaced + 1;
	if (newTotal >= snakingSequence.length) {
		log(`All starting structures placed. Checking if all factions are selected.`, 'game', undefined, { simulation: (game as any).simulation });
		delete (game as any).startingMineSequence;
		const allHaveFaction = Object.values(game.players).every(p => p.faction !== null);
		if (allHaveFaction) {
			game.currentPlayerIndex = game.turnOrder.length - 1;
			game.pendingBonusSelection = game.turnOrder[game.currentPlayerIndex];
			game.currentPhase = 'bonusSelection';
			log(`All factions selected. Moving to bonus selection phase.`, 'game', undefined, { simulation: (game as any).simulation });
		} else {
			game.currentPhase = 'factionSelect';
			log(`Moving to faction selection phase.`, 'game', undefined, { simulation: (game as any).simulation });
		}
	} else {
		const nextPlayerId = snakingSequence[newTotal];
		game.currentPlayerIndex = game.turnOrder.indexOf(nextPlayerId);
	}

	clampPlayerResources(game); emitGameUpdated(io, game);

	executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
		log(`Bot turn execution error (PlaceStartingMine): ${err}`, 'error');
	});

	return null;
}

export function executeSelectBonus(
	io: SocketIOServer,
	game: ServerGameState,
	playerId: string,
	bonusTileId: string
): boolean {
	if (game.currentPhase !== 'bonusSelection') return false;
	if (game.pendingBonusSelection !== playerId) return false;

	const tileIndex = game.availableBonusTiles.findIndex(t => t.id === bonusTileId);
	if (tileIndex === -1) return false;

	const player = game.players[playerId];
	// [사용자 2026-08-03] 게임 시작 시 보너스 타일 선택도 롤백 가능하게 — 선택 '직전' 상태를 히스토리에 남긴다.
	// (라운드 중 패스하며 고르는 보너스는 main 단계라 턴 시작 스냅샷으로 이미 롤백 가능했음)
	captureTurnStartWithPrev(game, playerId);
	player.bonusTile = bonusTileId;
	game.availableBonusTiles.splice(tileIndex, 1);

	const tile = ALL_BONUS_TILES.find(t => t.id === bonusTileId);
	addGameLog(game, playerId, 'Selected Bonus Tile', tile?.label || bonusTileId);
	log(`Player ${player.name} selected bonus tile: ${bonusTileId}`, 'game', undefined, { simulation: (game as any).simulation });

	// Move to next player (reverse order)
	game.currentPlayerIndex--;
	if (game.currentPlayerIndex < 0) {
		log(`All bonus tiles selected. Moving to main phase.`, 'game', undefined, { simulation: (game as any).simulation });
		game.currentPhase = 'main';
		game.roundNumber = 1;
		(game as any).incomePhaseAppliedThisRound = false;
		(game as any).gaiaformerReturnDoneThisRound = false; // 라운드당 1회 가이아 복귀 가드 리셋
		game.currentPlayerIndex = 0;
		game.pendingBonusSelection = null;
		for (const pid of Object.keys(game.players)) ensureScoreBreakdown(game.players[pid]);

		const firstPlayerId = game.turnOrder[0];
		if (firstPlayerId) {
			captureTurnStartWithPrev(game as ServerGameState, firstPlayerId);
		}

		helperTriggerIncomePhase(io, game);
	} else {
		game.pendingBonusSelection = game.turnOrder[game.currentPlayerIndex];
	}

	clampPlayerResources(game); emitGameUpdated(io, game);

	// 보너스 선택이 완료되고 수익 단계로 진입하는 경우: helperStartNewRoundTurn에서 executeBotTurnIfNeeded를 호출하므로 여기서는 호출하지 않음
	// 다음 보너스 선택 플레이어로 넘어가는 경우에만 호출
	if (game.pendingBonusSelection) {
		executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
			log(`Bot turn execution error (SelectBonus): ${err}`, 'error');
		});
	}

	return true;
}

/** 트랙 5단계는 게임당 1명만 가능. 이미 다른 플레이어가 해당 트랙 5단계면 true */
/**
 * 파이락 의회 능력: 연구소 1개를 교역소로 다운그레이드하고 연구 1트랙 1단계 전진(메인 액션, 라운드당 1회).
 * 소켓 핸들러와 봇(performAction)이 공유 — 룰 중복 방지. 조건/효과는 firaks_downgrade 핸들러와 동일.
 */
export function executeFiraksDowngrade(game: ServerGameState, playerId: string, tileId: string, trackId: ResearchTrack): boolean {
	const player = game.players[playerId];
	if (!player) return false;
	if (game.currentPhase !== 'main') return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId || game.hasDoneMainAction) return false;
	if (player.faction !== 'firaks') return false;
	if (player.usedSpecialActions?.includes('firaks-downgrade')) return false;
	if (!game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) return false;
	const tile = game.map.find(t => t.id === tileId && t.ownerId === playerId && t.structure === 'research_lab');
	if (!tile) return false;
	const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
	if (!tracks.includes(trackId)) return false;
	const currentLevel = player.research?.[trackId] ?? 0;
	if (currentLevel >= 5) return false;
	if (currentLevel === 4 && isTrackLevel5Taken(game, trackId, playerId)) return false;
	// [버그수정] L5 도달(4→5)은 초록 연방 1개가 필요하고 소모(플립)된다 — Firaks 다운그레이드 advance도 동일.
	// 기존엔 요구·소모를 안 해 AI L5 등을 초록연방 안 뒤집고 공짜로 올리던 문제(사용자 관찰).
	if (currentLevel === 4 && countGreenFederations(player) < 1) return false;
	if (trackId === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return false;
	saveActionStartState(game, playerId);
	tile.structure = 'trading_station';
	if (!player.usedSpecialActions) player.usedSpecialActions = [];
	player.usedSpecialActions.push('firaks-downgrade');
	player.research[trackId] = currentLevel + 1;
	const newLevel = player.research[trackId];
	if (newLevel === 5) spendGreenFederation(player); // L5 도달 시 초록 연방 소모/플립 (누락 수정 — 사용자 관찰)
	addGameLog(game, playerId, 'Firaks: Downgrade', `Lab→TS, ${trackId} Lv.${newLevel}`, tileId);
	createPowerOffers(game, tile, playerId);
	addBuildingToFederationIfAdjacent(game, playerId, tile.id);
	applyRoundMissionScore(game, playerId, 'build_trading_station');
	applyAdvancedTechTileEffect(game, playerId, 'build_ts'); // adv-vp-build-ts(+3VP) — 파이락 다운그레이드(Lab→TS)도 교역소 건설 혜택 다 받음(누락 수정)
	applyTrackLevelBonus(game, playerId, player, trackId, newLevel);
	applyRoundMissionScore(game, playerId, 'research_track');
	applyAdvancedTechTileEffect(game, playerId, 'research');
	game.hasDoneMainAction = true;
	return true;
}

export function isTrackLevel5Taken(game: ServerGameState, track: ResearchTrack, excludePlayerId: string): boolean {
	return Object.entries(game.players).some(([pid, p]) => pid !== excludePlayerId && (p.research?.[track] ?? 0) >= 5);
}

export function executeAdvanceTech(
	io: SocketIOServer,
	game: ServerGameState,
	playerId: string,
	trackId: ResearchTrack
): boolean {
	if (!game) return false;
	// [순서 2026-08-05 사용자] 보상 트랙 전진(우주선/고급기술 pending)은 아이타 교환처럼 액션 단계 시작 전
	//   (가이아 단계)에도 해소돼야 한다 → pending 소유자면 phase 게이트 면제. 일반 4K 연구는 종전대로 main 전용.
	const ownsPendingAdvanceEarly = game.pendingShipTechTrackAdvance?.playerId === playerId
		|| game.pendingAdvancedTechTrackAdvance?.playerId === playerId;
	if (game.currentPhase !== 'main' && !ownsPendingAdvanceEarly) return false;

	// [버그수정 2026-06-19] 보상 트랙 전진(우주선/고급기술 pending)은 Itars PI 가이아포머 교환처럼
	// '내 액션 턴이 아닐 때' 생길 수 있다 → 그 pending 소유자는 현재 턴이 아니어도 해소 가능.
	// (그동안 본인 턴이 와야만 트랙이 올라가던 버그: 고급타일 Gaia당2점 먹고 가이아5가 한 바퀴 뒤에야 올라감 — 사용자 관찰)
	// 일반 4K 연구는 종전대로 내 턴에만 가능.
	const isMyTurn = game.turnOrder[game.currentPlayerIndex] === playerId;
	const ownsPendingAdvance = game.pendingShipTechTrackAdvance?.playerId === playerId
		|| game.pendingAdvancedTechTrackAdvance?.playerId === playerId;
	if (!isMyTurn && !ownsPendingAdvance) return false;
	// [버그수정 2026-07-28 사용자: 다른 사람 파워 수령 중인데 제노스가 연구 전진해버림] 파워 leech 오퍼가 아직
	//   미해소(턴 종료 보류)면 일반 4K 연구 전진 불가 — 파워 처리 완료 후 진행. 보상 트랙 전진(Itars 등 크로스턴)은 예외.
	if (!ownsPendingAdvance && mainActionBlockedByPending(game as ServerGameState)) return false;

	const player = game.players[playerId];
	const track = trackId as ResearchTrack;
	const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];

	const pendingShipTech = game.pendingShipTechTrackAdvance;
	if (pendingShipTech?.playerId === playerId) {
		if (!tracks.includes(track) || player.research[track] >= 5) return false;
		if (track === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return false;
		const newLevel = (player.research[track] ?? 0) + 1;
		if (newLevel === 5 && (countGreenFederations(player) < 1 || isTrackLevel5Taken(game, track, playerId))) return false;
		saveActionStartState(game, playerId);
		game.pendingShipTechTrackAdvance = null;
		if (newLevel === 5) spendGreenFederation(player);
		player.research[track]++;
		addGameLog(game, playerId, 'Ship Tech: Advanced track', `${track} → Lv.${newLevel}`); applyAdvancedTechTileEffect(game, playerId, 'research'); /* adv-vp-research(+2/연구전진) 누락 수정 */
		applyTrackLevelBonus(game, playerId, player, track, newLevel);
		applyRoundMissionScore(game, playerId, 'research_track');
		// 보상 해소가 내 턴이 아니면(예: Itars 교환) 현재 플레이어 턴 상태를 건드리지 않음.
		// [버그수정 2026-08-05 사용자] 아이타 교환에서 온 2TF+Mine의 후속 트랙 전진은 '내 턴'에 해소되더라도
		//   메인 액션을 소모하면 안 된다(광산 쪽과 동일 이유 — 타일 즉시효과. 아래 몇 줄 뒤에서 이 플래그를 소비).
		// [버그수정 2026-08-03 사용자] fromItars 추가 — 아이타 의회 교환 유래(2TF+Mine 외 Nav+1/1O3K 포함)는
		//   내 턴에 해소해도 메인 액션 미소모. 예전엔 2TF+Mine만 예외라 아이타가 1턴일 때 액션 없이 턴이 넘어갔다.
		if (isMyTurn && !(game as any).itarsExchangeResumeAfterShipMine && !pendingShipTech.fromItars) game.hasDoneMainAction = true;

		// 2TF+Mine 관련 순서 조정을 위해 기존 로직 제거 (이제 광산 건설 완료 시 트랙 전진이 트리거됨)

		// [BUGFIX 2026-07-23] Itars PI 교환으로 받은 2TF+광산 타일: 광산 배치 → 트랙 전진이 끝난 지금,
		// 이연해 둔 잔여 토큰 교환 체인을 재개(다음 4토큰 교환 or 그릇1 복귀 후 액션단계 진행).
		if ((game as any).itarsExchangeResumeAfterShipMine) {
			(game as any).itarsExchangeResumeAfterShipMine = false;
			const remainingItars = game.itarsGaiaformerRemainingAfterTech ?? 0;
			log(`[ITARS-CHAIN] ${player.name} 2TF+Mine 광산·트랙 완료 — 잔여 ${remainingItars} 체인 재개 (round ${game.roundNumber})`, 'game', game.id, { simulation: (game as any).simulation });
			resumeItarsExchangeChain(io, game, playerId, remainingItars);
			return true;
		}

		clampPlayerResources(game); emitGameUpdated(io, game);
		return true;
	}

	const pendingAdvTech = game.pendingAdvancedTechTrackAdvance;
	if (pendingAdvTech?.playerId === playerId) {
		if (!tracks.includes(track) || player.research[track] >= 5) return false;
		if (track === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return false;
		const newLevel = (player.research[track] ?? 0) + 1;
		if (newLevel === 5 && (countGreenFederations(player) < 1 || isTrackLevel5Taken(game, track, playerId))) return false;
		saveActionStartState(game, playerId);
		game.pendingAdvancedTechTrackAdvance = null;
		if (newLevel === 5) spendGreenFederation(player);
		player.research[track]++;
		addGameLog(game, playerId, 'Advanced Tech: Advanced track', `${track} → Lv.${newLevel}`); applyAdvancedTechTileEffect(game, playerId, 'research'); /* adv-vp-research(+2/연구전진) 누락 수정 */
		applyTrackLevelBonus(game, playerId, player, track, newLevel);
		applyRoundMissionScore(game, playerId, 'research_track');
		// 보상 해소가 내 턴이 아니면(예: Itars 교환) 현재 플레이어 턴 상태를 건드리지 않음.
		// [버그수정 2026-08-06 사용자: "아이타가 의회로 고급기술(즉시점수) 먹었는데 1턴에 자기 액션 없이 2턴으로 넘어감"]
		//   아이타 교환은 가이아 단계(액션 시작 전)에 일어나는데, 교환자가 시작 플레이어면 그 시점에도
		//   turnOrder[currentPlayerIndex] === 본인이라 isMyTurn이 true다. 그대로 hasDoneMainAction을 세우면
		//   액션 단계가 시작될 때 이미 '액션 완료' 상태 → 첫 턴이 통째로 날아갔다(라운드 시작은 이 플래그를 리셋하지 않음).
		//   고급 타일의 트랙 전진은 타일의 보상이지 메인 액션이 아니므로, 교환 유래면 소모하지 않는다.
		//   (바로 위 우주선 기술 분기가 itarsExchangeResumeAfterShipMine으로 같은 처리를 하고 있었는데 이 분기만 누락)
		if (isMyTurn && !pendingAdvTech.fromItarsExchange) game.hasDoneMainAction = true;
		// [버그수정 2026-07-27 사보르 R5 실측] 아이타 교환에서 고급타일 선택 시 잔여 가이아포머 토큰이 증발하던 문제 —
		//   고급 트랙전진(교환의 마지막 단계) 완료 후 잔여를 1그릇 복구하고 교환 체인 재개(일반타일·우주선 경로와 동형).
		const remItarsAdv = game.itarsGaiaformerRemainingAfterTech ?? 0;
		if (remItarsAdv > 0 && !game.pendingItarsGaiaformerExchange && !(game as any).itarsExchangeResumeAfterShipMine) {
			game.itarsGaiaformerRemainingAfterTech = undefined;
			resumeItarsExchangeChain(io, game, playerId, remItarsAdv);
			return true;
		}
		clampPlayerResources(game); emitGameUpdated(io, game);
		return true;
	}

	if (game.hasDoneMainAction) return false;

	saveActionStartState(game, playerId);

	if (track === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return false;
	if ((player.knowledge ?? 0) < 4 || player.research[track] >= 5) return false;
	const newLevel = (player.research[track] ?? 0) + 1;
	if (newLevel === 5 && (countGreenFederations(player) < 1 || isTrackLevel5Taken(game, track, playerId))) return false;

	const knowledgeBefore = player.knowledge;
	player.knowledge = (player.knowledge ?? 0) - 4;
	if (newLevel === 5) spendGreenFederation(player);
	player.research[track]++;
	// 트랙 레벨 보너스(가이아/경제 5단계 보상 등)가 이 로그의 하위줄로 붙도록 Advanced Research 로그를 먼저 찍는다
	addGameLog(game, playerId, 'Advanced Research', `${track} to level ${newLevel} (${knowledgeBefore}K→${player.knowledge}K)`);
	applyTrackLevelBonus(game, playerId, player, track, newLevel);
	log(`Player ${player.name} advanced ${track} to Lv.${newLevel}: knowledge ${knowledgeBefore} → ${player.knowledge} (-4)`, 'game', undefined, { simulation: (game as any).simulation });
	applyRoundMissionScore(game, playerId, 'research_track');
	applyAdvancedTechTileEffect(game, playerId, 'research');
	game.hasDoneMainAction = true;
	clampPlayerResources(game); emitGameUpdated(io, game);
	return true;
}

// Helper functions for executePassRound (Rewritten to avoid collision if they exist hiddenly)
// Rewrites removed as originals are available at top level.

export function executePassRound(
	io: SocketIOServer,
	game: ServerGameState,
	playerId: string,
	newBonusTileId?: string
): boolean {
	if (!game) return false;

	// [GHOST-PASS 계측 2026-07-12] 유령 라운드 추적 — 실제 게임 객체에 대한 모든 패스(시도 포함)를 호출origin과
	// 함께 무조건 기록. 재현: 봇이 결정로그 없이 패스 처리돼 라운드 통째 증발(40판 중 15건, fed0의 주범).
	if (games.get(game.id) === game) {
		const st = (new Error().stack ?? '').split('\n').slice(2, 4).map(s => s.trim().replace(/^at /, '')).join(' < ');
		log(`[PASS-TRACE] ${game.players[playerId]?.name ?? playerId} R${game.roundNumber} idx=${game.currentPlayerIndex} cur=${game.turnOrder[game.currentPlayerIndex]} passed=${game.turnOrder.map(id => game.players[id]?.hasPassed ? 1 : 0).join('')} via ${st}`, 'game', game.id);
	}

	if (game.currentPhase !== 'main') return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;
	if (game.hasDoneMainAction) {
		return false;
	}

	const player = game.players[playerId];
	if (!player) return false;

	// [증발 버그수정 2026-08-01] 라운드 1-5 보너스 타일 검증을 발타크 자동변환 '앞'으로 —
	// 기존엔 변환(포머 잠금+QIC)부터 하고 아래에서 타일 무효로 return false 시 실패한 패스인데도
	// 포머가 잠긴 채 라운드를 계속하게 됐다. (아래 기존 검증은 newTileIndex 사용을 위해 유지)
	if (game.roundNumber !== 6) {
		if (!newBonusTileId) return false;
		if (game.availableBonusTiles.findIndex(t => t.id === newBonusTileId) === -1) return false;
	}

	// 발타크: 패스 시 남은(잠기지 않은) 가이아포머를 자동으로 QIC로 변환.
	// 패스 후엔 이번 라운드에 포머를 쓸 기회가 없고, 잠긴 포머는 어차피 라운드 전환 시 복귀하므로 항상 이득.
	if (player.faction === 'bal_tak') {
		let converted = 0;
		while (getEffectiveGaiaformers(player) >= 1) {
			player.balTakGaiaformersUsedForQic = (player.balTakGaiaformersUsedForQic ?? 0) + 1;
			grantQic(game, playerId, 1);
			converted++;
		}
		if (converted > 0) {
			addGameLog(game, playerId, "Bal T'aks: Pass auto-convert", `${converted} Gaiaformer → ${converted} QIC (패스 시 자동 변환)`);
			log(`Player ${player.name} (Bal T'aks) auto-converted ${converted} gaiaformer(s) to QIC on pass`, 'game', undefined, { simulation: (game as any).simulation });
		}
	}

	// 6라운드 처리
	if (game.roundNumber === 6) {
		let passBonusVp6 = 0;
		{
			// 패스 보너스 계산은 shared computeBonusTilePassVp 단일 출처 (클라 미리보기와 동일 함수)
			const passBonus = computeBonusTilePassVp(game, playerId);
			if (passBonus) {
				passBonusVp6 = passBonus.vp;
				addScore(game, playerId, passBonus.vp, 'bonusTilePass', { round: 6 });
				log(`Player ${player.name} gained ${passBonus.vp} VP from pass bonus (${passBonus.count} x ${passBonus.vpPer} for ${passBonus.type})`, 'game', undefined, { simulation: (game as any).simulation });
			}
		}

		const advTiles6 = applyAdvancedTechTilePassEffect(game, playerId, { suppressLog: true });
		// 통합 패스 로그: 보너스 타일(+패스점수) + 고급 패스 타일 이미지 (라운드6은 새 타일 없음)
		addGameLog(game, playerId, 'Selected Bonus', undefined, undefined);
		{
			const lastLog = game.gameLog && game.gameLog.length > 0 ? game.gameLog[game.gameLog.length - 1] : null;
			if (lastLog && lastLog.action === 'Selected Bonus') {
				lastLog.passInfo = {
					returnedTileId: player.bonusTile ?? undefined,
					bonusVp: passBonusVp6 > 0 ? passBonusVp6 : undefined,
					advTiles: advTiles6.length > 0 ? advTiles6 : undefined,
				};
			}
		}

		player.hasPassed = true;
		if (!game.passingOrder.includes(playerId)) {
			game.passingOrder.push(playerId);
		}
		game.hasDoneMainAction = false;

		// Check if all passed
		if (Object.values(game.players).every(p => p.hasPassed)) {
			// 게임 종료 마커 — 최종 점수 정산 로그들보다 먼저 (시스템 로그, 특정 플레이어 없음)
			if (!game.gameLog) game.gameLog = [];
			game.gameLog.push({ timestamp: Date.now(), playerId: '', playerName: 'Game', action: 'Game Finished', details: '최종 점수 정산', round: game.roundNumber });
			// [2026-08-06 사용자] 롤백 횟수는 집계는 하되 게임 로그(플레이어 화면)에는 띄우지 않는다 — 서버 로그에만 남김.
			{
				const rb = buildRollbackSummary(game);
				if (rb) log(`[ROLLBACK-SUMMARY] ${game.id} ${rb}`, 'game', game.id);
			}
			applyFinalMissionScoring(game);
			// Research Track End Bonus
			for (const pid of game.turnOrder) {
				const p = game.players[pid];
				if (!p?.research) continue;
				let researchBonus = 0;
				for (const track of RESEARCH_TRACKS) {
					const level = p.research[track.id] ?? 0;
					if (level >= 5) researchBonus += RESEARCH_TRACK_END_BONUS[5] ?? 12;
					else if (level >= 4) researchBonus += RESEARCH_TRACK_END_BONUS[4] ?? 8;
					else if (level >= 3) researchBonus += RESEARCH_TRACK_END_BONUS[3] ?? 4;
				}
				if (researchBonus > 0) addScore(game, pid, researchBonus, 'researchTracks');
			}
			// 남은 자원 (O, C, QIC, K + 파워 자동 환산) 합 3당 1 VP
			// [버그수정 2026-07-13] 1607ea9 룰(파워 자동 환산)이 롤아웃/강제종료에만 적용되고 실게임 종료
			// 경로만 구식 합산이었음 — 봇 R6 정리변환 스킵(bot.ts)이 이 자동 환산을 전제하므로 여기 누락 시
			// 봇이 실게임에서만 판당 1~3VP 손실 + 롤아웃 평가와 실정산 불일치.
			for (const pid of Object.keys(game.players)) {
				const p = game.players[pid];
				if (!p) continue;
				const sum = endgameLeftoverUnits(game, pid, p);
				const vp = Math.floor(sum / 3);
				if (vp > 0) addScore(game, pid, vp, 'remainingResources');
			}
			for (const pid of Object.keys(game.players)) {
				const bid = game.players[pid]?.factionBidVp ?? 0;
				if (bid > 0) {
					addScore(game, pid, -bid, 'other', { source: '종족 비딩' });
				}
			}
			for (const pid of Object.keys(game.players)) ensureScoreBreakdown(game.players[pid]);
			game.currentPhase = 'gameEnd';
			turnHistories.delete(game.id); // [롤백] 게임 종료 → 히스토리 메모리 즉시 해제
			rollbackCounts.delete(game.id); // 위 종료 로그에 요약을 남긴 뒤이므로 함께 해제
			saveFinalGameState(game);
			flushGameData(game);
			clampPlayerResources(game); emitGameUpdated(io, game);
			return true;
		}

		// Next player
		// [턴 롤백] 패스한 플레이어의 '턴 시작 스냅샷'을 삭제하지 않고 그대로 둔다 → 실수로 누른 패스도 어드민 롤백 가능
		//   (finalizeTurnEnd가 끝난 플레이어 스냅샷을 남기는 것과 동일 원칙, 1112줄). 예전엔 delete 해서 tsKeys에 현재
		//   플레이어만 남아 패스한 플레이어 롤백이 'cur=false 스냅샷없음'으로 실패했음. gameLog는 스냅샷서 제외(OOM수정)돼
		//   플레이어당 1개 유지는 메모리 안전.
		game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
		while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed) {
			game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
			if (Object.values(game.players).every(p => p.hasPassed)) break;
		}

		// 다음 플레이어 지정을 위한 스냅샷 저장 (턴 전환 → 직전 턴은 prev로 보존)
		const nextId = game.turnOrder[game.currentPlayerIndex];
		if (nextId && !game.players[nextId].hasPassed) {
			captureTurnStartWithPrev(game as ServerGameState, nextId);
		}

		clampPlayerResources(game); emitGameUpdated(io, game);

		// 6라운드에서도 사람이 패스한 후 다음 플레이어가 봇이면 자동 실행될 수 있도록 트리거 추가
		executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
			log(`Bot turn execution error (Round 6 pass): ${err}`, 'error');
		});

		return true;

	} else {
		// Rounds 1-5
		if (!newBonusTileId) return false;
		const newTileIndex = game.availableBonusTiles.findIndex(t => t.id === newBonusTileId);
		if (newTileIndex === -1) return false;

		// Calculate pass bonus (통합 Selected Bonus 로그용으로 모음)
		let passBonusVpForLog = 0;
		let passAdvTiles: Array<{ tileId: string; vp: number }> = [];
		if (player.bonusTile) {
			const currentBonusTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
			let vpGained = 0;
			// 패스 보너스 계산은 shared computeBonusTilePassVp 단일 출처 (클라 미리보기와 동일 함수)
			const passBonus = computeBonusTilePassVp(game, playerId);
			if (passBonus) {
				vpGained = passBonus.vp;
				passBonusVpForLog = vpGained;
				log(`Player ${player.name} gained ${vpGained} VP from pass bonus (${passBonus.count} x ${passBonus.vpPer} for ${passBonus.type})`, 'game', undefined, { simulation: (game as any).simulation });
			}

			if (currentBonusTile) {
				if (vpGained > 0) {
						addScore(game, playerId, vpGained, 'bonusTilePass', { round: game.roundNumber, tileId: currentBonusTile.id });
					} else {
						ensureScoreBreakdown(player).bonusTilePass.push({ round: game.roundNumber, vp: 0, tileId: currentBonusTile.id });
					}
			}

			passAdvTiles = applyAdvancedTechTilePassEffect(game, playerId, { suppressLog: true });

			const oldTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
			if (oldTile) {
				game.availableBonusTiles.push(oldTile);
			}
		}

		const oldBonusId = player.bonusTile;
		player.bonusTile = newBonusTileId;
		game.availableBonusTiles.splice(newTileIndex, 1);
		player.usedBonusAction = false;

		addGameLog(game, playerId, 'Selected Bonus', `Returned ${oldBonusId}, took ${newBonusTileId}`);
		{
			const lastLog = game.gameLog && game.gameLog.length > 0 ? game.gameLog[game.gameLog.length - 1] : null;
			if (lastLog && lastLog.action === 'Selected Bonus') {
				lastLog.passInfo = {
					returnedTileId: oldBonusId ?? undefined,
					tookTileId: newBonusTileId,
					bonusVp: passBonusVpForLog > 0 ? passBonusVpForLog : undefined,
					advTiles: passAdvTiles.length > 0 ? passAdvTiles : undefined,
				};
			}
		}
		log(`Player ${player.name} returned ${oldBonusId} and took ${newBonusTileId}`, 'game', undefined, { simulation: (game as any).simulation });

		player.hasPassed = true;
		if (!game.passingOrder.includes(playerId)) {
			game.passingOrder.push(playerId);
		}
		game.hasDoneMainAction = false;

		if (Object.values(game.players).every(p => p.hasPassed)) {
			game.roundNumber++;
			// [반사실 복기 2026-07-13] AI_ROUND_SNAPSHOTS=1이면 라운드 시작 전체상태를 덤프 — 오프라인
			// counterfactual 리플레이(수 롤백→대안 강제→터미널 비교)의 기점. R2-5만(R1 셋업/R6 직전은 제외).
			if (process.env.AI_ROUND_SNAPSHOTS === '1' && game.roundNumber >= 2 && game.roundNumber <= 5 && !(game as any).simulation) {
				try {
					const dir = path.join(process.cwd(), 'logs', 'cf-snapshots');
					fs.mkdirSync(dir, { recursive: true });
					const { gameLog: _gl, ...rest } = game as any;
					fs.writeFileSync(path.join(dir, `${game.id}_r${game.roundNumber}.json`), JSON.stringify(rest));
				} catch { /* 스냅샷 실패는 게임에 무영향 */ }
			}
			(game as any).incomePhaseAppliedThisRound = false;
			(game as any).gaiaformerReturnDoneThisRound = false; // 라운드당 1회 가이아 복귀 가드 리셋
			(game as any).firstMainActionDoneThisRound = false; // 새 라운드: 액션 진행 플래그 리셋(시작플레이어 더블턴 가드)
			game.powerActions.forEach(a => { a.isUsed = false; (a as any).usedByPlayerId = undefined; (a as any).usedByPlayerName = undefined; });
			Object.values(game.players).forEach(p => {
				if (p.hadschHallasPIActions) p.hadschHallasPIActions.forEach(a => { a.isUsed = false; });
				p.usedIvitsSpaceStationThisRound = false;
				if (p.faction === 'bal_tak') p.balTakGaiaformersUsedForQic = 0;
			});
			if (game.spaceships) {
				Object.keys(game.spaceships).forEach(id => {
					game.spaceships![id].actionsUsed = 0;
					game.spaceships![id].usedActionIndices = [];
					game.spaceships![id].usedActionBy = {};
				});
			}

			// ★[방어 2026-07-06] turnOrder = passingOrder는 passingOrder에 없는 플레이어를 게임에서 탈락시킨다.
			//   어떤 경로로든(강제스킵·예외 등) hasPassed는 됐는데 passingOrder에 안 든 플레이어가 있으면 뒤에 보존 —
			//   절대 플레이어를 turnOrder에서 소멸시키지 않는다(na0vujw3 봇 소멸 사고 방어망).
			const missingFromPassing = game.turnOrder.filter(id => !game.passingOrder.includes(id));
			if (missingFromPassing.length > 0) {
				log(`[turnOrder guard] preserving ${missingFromPassing.length} player(s) missing from passingOrder: ${missingFromPassing.join(',')}`, 'error', game.id);
			}
			game.turnOrder = [...game.passingOrder, ...missingFromPassing];
			game.passingOrder = [];
			game.currentPlayerIndex = 0;

			// Gaiaformer maturation logic
			Object.entries(game.players).forEach(([pId, player]) => {
				const placed = player.gaiaformerPlacedThisRound ?? [];
				if (placed.length === 0) {
					player.gaiaformerPlacedThisRound = [];
					return;
				}
				if (!player.pendingGaiaformerTiles) player.pendingGaiaformerTiles = [];
				placed.forEach(tileId => {
					const t = game.map.find(m => m.id === tileId);
					if (t && t.type === 'transdim' && t.hasGaiaformer && !t.structure) {
						t.type = 'gaia';
						t.isGaiaformed = true;
						if (!player.pendingGaiaformerTiles!.includes(tileId)) {
							player.pendingGaiaformerTiles!.push(tileId);
							log(`Player ${player.name}: gaiaformer matured on ${tileId} (now buildable)`, 'game', undefined, { simulation: (game as any).simulation });
						}
					}
				});
				player.gaiaformerPlacedThisRound = [];
			});

			// [사용자] 라운드 전환 순간(수입/파워/의회 처리 전)에 '라운드 시작' 시스템 로그 1개 — 클라가 이걸 라운드
			// 구분선으로 렌더한다. 새 라운드의 첫(가장 오래된) 로그라 라벨이 '첫 액션'이 아니라 라운드 경계에 정확히 고정됨.
			{
				(game as any).gameLogSeq = ((game as any).gameLogSeq ?? 0) + 1;
				game.gameLog?.push({
					timestamp: Date.now(),
					playerId: '',
					playerName: '',
					action: 'Round Start',
					round: game.roundNumber,
					seq: (game as any).gameLogSeq,
				});
			}

			helperTriggerIncomePhase(io, game);
		} else {
			game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
			while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed) {
				game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
			}
		}

		const newCurrentId = game.turnOrder[game.currentPlayerIndex];
		if (newCurrentId) {
			captureTurnStartWithPrev(game as ServerGameState, newCurrentId);
		}

		clampPlayerResources(game); emitGameUpdated(io, game);

		// Trigger bot turn if next player is a bot
		executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
			log(`Bot turn execution error: ${err}`, 'error');
		});

		return true;
	}
}

// ========== Bot-accessible exported functions ==========

/** Bot용: 파워 액션 실행 (테라포밍 스텝 등). 타클론 시 useBrain=true면 브레인 스톤 우선 사용. */
export function executeUsePowerAction(
	io: SocketIOServer, game: ServerGameState,
	playerId: string, actionId: string, useBrain?: boolean
): boolean {
	if (!game) {
		log(`executeUsePowerAction failed: Game state is null`, 'error');
		return false;
	}
	if (game.hasDoneMainAction) {
		debugLog(game, `executeUsePowerAction failed: Player ${playerId} has already done a main action`, 'error');
		return false;
	}
	const action = game.powerActions.find(a => a.id === actionId);
	if (!action) {
		debugLog(game, `executeUsePowerAction failed: Action ${actionId} not found`, 'error');
		return false;
	}
	if (action.isUsed) {
		debugLog(game, `executeUsePowerAction failed: Action ${actionId} is already used`, 'error');
		return false;
	}
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) {
		debugLog(game, `executeUsePowerAction failed: Not Player ${playerId}'s turn (Current: ${game.turnOrder[game.currentPlayerIndex]})`, 'error');
		return false;
	}

	// Undo를 위해 액션 시작 상태 저장
	saveActionStartState(game, playerId);

	const player = game.players[playerId];
	const hasNevlasPI = player.faction === 'nevlas' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
	const powerCost = action.costType === 'power' ? (hasNevlasPI ? Math.ceil(action.cost as number / 2) : action.cost as number) : 0;
	if (action.costType === 'power') {
		const isTaklons = player.faction === 'taklons';
		if (isTaklons) {
			if (!canSpendTaklonsPower(player, 3, powerCost)) {
				debugLog(game, `executeUsePowerAction failed: Taklons insufficient power (Required: ${powerCost})`, 'error');
				return false;
			}
		} else if ((player.power3 ?? 0) < powerCost) {
			debugLog(game, `executeUsePowerAction failed: Insufficient Power 3 (Required: ${powerCost}, Current: ${player.power3})`, 'error');
			return false;
		}
	}
	if (action.costType === 'qic' && (player.qic ?? 0) < action.cost) {
		debugLog(game, `executeUsePowerAction failed: Insufficient QIC (Required: ${action.cost}, Current: ${player.qic})`, 'error');
		return false;
	}

	if (action.costType === 'power') {
		if (player.faction === 'taklons') {
			spendTaklonsPower(player, 3, powerCost, player.taklonsBrainPriority ?? (useBrain ?? true));
		} else {
			player.power3 = (player.power3 ?? 0) - powerCost;
			player.power1 = (player.power1 ?? 0) + powerCost;
		}
	} else {
		player.qic = (player.qic ?? 0) - action.cost;
		// NOTE: 이 변형의 INITIAL_POWER_ACTIONS엔 QIC비용 보드 액션이 없어 이 분기는 현재 도달 불가(unreachable).
		// adv-vp-qic-action(+4VP/QIC액션)의 실제 QIC 액션은 우주선 첫 칸에서 처리한다
		// (executeUseShipAction / 소켓 우주선 핸들러). 보드에 QIC 액션을 추가하면 여기서 트리거를 다시 붙일 것.
	}

	if (actionId === 'gain-3-knowledge') player.knowledge += 3;
	if (actionId === 'gain-2-knowledge') player.knowledge += 2;
	if (actionId === 'gain-2-ore') player.ore += 2;
	if (actionId === 'gain-7-credits') player.credits += 7;
	if (actionId === 'gain-2-tokens') player.power1 += 2;
	if (actionId === 'gain-1-step') {
		player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 1;
	}
	if (actionId === 'gain-2-steps') {
		player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 2;
	}

	// 게임 로그 (파워 액션은 화면 로그에 표시되어야 함)
	{
		const costText =
			action.costType === 'power'
				? `${powerCost}P`
				: `${action.cost} QIC`;
		let effectText = action.label || actionId;
		if (actionId === 'gain-1-step') effectText = `+1 Terraform step`;
		else if (actionId === 'gain-2-steps') effectText = `+2 Terraform steps`;
		else if (actionId === 'gain-3-knowledge') effectText = `+3 Knowledge`;
		else if (actionId === 'gain-2-knowledge') effectText = `+2 Knowledge`;
		else if (actionId === 'gain-2-ore') effectText = `+2 Ore`;
		else if (actionId === 'gain-7-credits') effectText = `+7 Credits`;
		else if (actionId === 'gain-2-tokens') effectText = `+2 Power tokens`;

		const detail = `${effectText} (${costText})`;
		addGameLog(game, playerId, 'Power Action', detail);
		log(`Player ${player.name} used power action: ${detail}`, 'game', undefined, { simulation: (game as any).simulation });
	}

	action.isUsed = true;
	action.usedByPlayerId = playerId;
	action.usedByPlayerName = player.name ?? playerId;
	game.hasDoneMainAction = true; // Bot version also marks main action done
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

/** Bot/소켓 공용: 기술 타일 액션 사용 (4P, 3K, 3O, 1Q+5C 등). 메인 액션 소모. */
export function executeUseTechAction(
	io: SocketIOServer, game: ServerGameState,
	playerId: string, tileId: string
): boolean {
	if (!game || game.currentPhase !== 'main' || game.hasDoneMainAction) return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;

	const player = game.players[playerId];
	if (!player) return false;
	if (!player.usedTechActions) player.usedTechActions = [];
	if (!player.techTiles.includes(tileId) || player.usedTechActions.includes(tileId)) return false;
	if (isTechTileCovered(player, tileId)) return false;

	saveActionStartState(game, playerId);

	if (tileId === 'tech-act-4p') {
		if (player.faction === 'taklons') chargePowerTaklons(player, 4, true);
		else chargePower(player, 4);
		player.usedTechActions.push(tileId);
		game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Used Tech Action', 'Gained 4 Power', tileId);
	} else if (tileId === 'adv-act-3k') {
		player.knowledge += 3;
		player.usedTechActions.push(tileId);
		game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Used Tech Action', 'Gained 3 Knowledge', tileId);
	} else if (tileId === 'adv-act-3o') {
		player.ore += 3;
		player.usedTechActions.push(tileId);
		game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Used Tech Action', 'Gained 3 Ore', tileId);
	} else if (tileId === 'adv-act-1q-5c') {
		grantQic(game, playerId, 1);
		player.credits += 5;
		player.usedTechActions.push(tileId);
		game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Used Tech Action', 'Gained 1 QIC and 5 Credits', tileId);
	} else {
		return false;
	}

	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

/** Bot/소켓 공용: 종족/기술 타일 특수 액션 사용 (academy-qic, gleens-2nav, space_giants-2tf, tinkeroid, tech-act-4p 등). */
export function executeUseSpecialAction(
	io: SocketIOServer, game: ServerGameState,
	playerId: string, actionId: string
): boolean {
	if (!game || game.currentPhase !== 'main' || game.hasDoneMainAction) return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;

	const player = game.players[playerId];
	if (!player || (player.usedSpecialActions && player.usedSpecialActions.includes(actionId))) return false;

	let applied = false;

	if (actionId === 'academy-qic') {
		const rightAcademyCount = getAcademyRightCount(game, playerId);
		if (rightAcademyCount >= 1) {
			if (player.faction === 'bal_tak') {
				player.credits = (player.credits ?? 0) + 4;
				addGameLog(game, playerId, 'Academy (Right)', '4 C (Special Action)', undefined);
			} else {
				grantQic(game, playerId, 1);
				addGameLog(game, playerId, 'Academy (Right)', '1 QIC (Special Action)', undefined);
			}
			if (!player.usedSpecialActions) player.usedSpecialActions = [];
			player.usedSpecialActions.push(actionId);
			game.hasDoneMainAction = true;
			applied = true;
		}
	}
	if (actionId === 'gleens-2nav' && player.faction === 'gleens') {
		saveActionStartState(game, playerId);
		player.gleensNavBonusActive = true;
		if (!player.usedSpecialActions) player.usedSpecialActions = [];
		player.usedSpecialActions.push(actionId);
		addGameLog(game, playerId, 'Gleens: Special', '+2 Nav (next action)', undefined);
		applied = true;
	}
	if (actionId === 'space_giants-2tf' && player.faction === 'space_giants') {
		saveActionStartState(game, playerId);
		if (!player.usedSpecialActions) player.usedSpecialActions = [];
		player.usedSpecialActions.push(actionId);
		player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 2;
		addGameLog(game, playerId, 'Space Giants: Special', '+2 Terraform steps', undefined);
		applied = true;
	}

	const tinkeroidIds = ['tinkeroid-1tf-mine', 'tinkeroid-1qic', 'tinkeroid-4power', 'tinkeroid-3k', 'tinkeroid-2qic', 'tinkeroid-3tf-mine'];
	if (player.faction === 'tinkeroids' && tinkeroidIds.includes(actionId) && player.tinkeroidRoundSpecialId === actionId && !player.usedSpecialActions?.includes('tinkeroid-special')) {
		saveActionStartState(game, playerId);
		if (!player.usedSpecialActions) player.usedSpecialActions = [];
		player.usedSpecialActions.push('tinkeroid-special');
		if (actionId === 'tinkeroid-1tf-mine') {
			player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 1;
			addGameLog(game, playerId, 'Tinkeroid: Special', '1 Terraform Step', actionId);
		} else if (actionId === 'tinkeroid-1qic') {
			grantQic(game, playerId, 1);
			game.hasDoneMainAction = true;
			addGameLog(game, playerId, 'Tinkeroid: Special', '1 QIC', actionId);
		} else if (actionId === 'tinkeroid-4power') {
			chargePower(player, 4);
			game.hasDoneMainAction = true;
			addGameLog(game, playerId, 'Tinkeroid: Special', '4 Power', actionId);
		} else if (actionId === 'tinkeroid-3k') {
			player.knowledge = (player.knowledge ?? 0) + 3;
			game.hasDoneMainAction = true;
			addGameLog(game, playerId, 'Tinkeroid: Special', '3 Knowledge', actionId);
		} else if (actionId === 'tinkeroid-2qic') {
			grantQic(game, playerId, 2);
			game.hasDoneMainAction = true;
			addGameLog(game, playerId, 'Tinkeroid: Special', '2 QIC', actionId);
		} else if (actionId === 'tinkeroid-3tf-mine') {
			player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 3;
			addGameLog(game, playerId, 'Tinkeroid: Special', '3 Terraform Steps', actionId);
		}
		applied = true;
	}

	if (actionId === 'tech-act-4p') {
		if (player.techTiles.includes(actionId) && !player.usedTechActions.includes(actionId) && !isTechTileCovered(player, actionId)) {
			saveActionStartState(game, playerId);
			if (player.faction === 'taklons') chargePowerTaklons(player, 4, true);
			else chargePower(player, 4);
			player.usedTechActions.push(actionId);
			game.hasDoneMainAction = true;
			addGameLog(game, playerId, 'Used Tech Action', 'Gained 4 Power (via Special Action)', actionId);
			applied = true;
		}
	}

	if (!applied) return false;
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

/** Bot/소켓 공용: 보너스 타일 스페셜 액션 (terraform_step, gaia_project, range_3). */
export function executeUseBonusAction(
	io: SocketIOServer, game: ServerGameState, playerId: string
): boolean {
	// [계측 BONUSREJ 2026-07-04] 봇 use_bonus_action 실패 388건/일 — 거부 이유 분포 수집(시뮬 제외)
	const rej = (why: string) => { debugLog(game, `[BONUSREJ] ${playerId} ${why}`, 'error'); return false; };
	if (!game || game.currentPhase !== 'main') return rej('phase');
	if (game.hasDoneMainAction) return rej('hasDoneMainAction');
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return rej('notTurn');

	const player = game.players[playerId];
	if (!player?.bonusTile) return rej('noBonusTile');
	if (player.usedBonusAction) return rej('alreadyUsed');

	const bonusTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
	if (!bonusTile?.specialAction) return rej('noSpecialAction');

	saveActionStartState(game, playerId);

	switch (bonusTile.specialAction) {
		case 'terraform_step':
			player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 1;
			player.usedBonusAction = true;
			addGameLog(game, playerId, 'Bonus Action', '1 Terraform Step');
			log(`Player ${player.name} activated bonus action: 1 terraform step (Total: ${player.pendingTerraformSteps})`, 'game', undefined, { simulation: (game as any).simulation });
			break;
		case 'gaia_project':
			if (getEffectiveGaiaformers(player) < 1) return rej('noFormer');
			player.usedBonusAction = true;
			game.pendingTFMarsGaiaProject = { playerId, shipTileId: 'bonus-gaia' };
			game.hasDoneMainAction = true;
			addGameLog(game, playerId, 'Bonus Action', 'Gaia Project');
			log(`Player ${player.name} activated bonus action: Gaia Project (place Gaiaformer or skip)`, 'game', undefined, { simulation: (game as any).simulation });
			break;
		case 'range_3':
			player.usedBonusAction = true;
			player.rangeBonusActive = true;
			addGameLog(game, playerId, 'Bonus Action', '+3 Range');
			log(`Player ${player.name} activated bonus action: +3 range (this turn)`, 'game', undefined, { simulation: (game as any).simulation });
			break;
		default:
			log(`Player ${player.name} used bonus action (unhandled specialAction: ${bonusTile.specialAction})`, 'game', undefined, { simulation: (game as any).simulation });
			break;
	}
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

/** Bot용: 하이브(Ivits) 우주정거장 배치. 메인 액션 소모. */
export function executePlaceIvitsSpaceStation(
	io: SocketIOServer, game: ServerGameState,
	playerId: string, tileId: string
): boolean {
	if (!game || game.currentPhase !== 'main') return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;
	if (game.hasDoneMainAction) return false;

	const player = game.players[playerId];
	if (player.faction !== 'ivits') return false;
	if (player.usedIvitsSpaceStationThisRound) return false;

	const tile = game.map.find(t => t.id === tileId);
	if (!tile) return false;
	if (tile.type !== 'space' && tile.type !== 'deep_space') return false;
	if (tile.structure !== null || tile.spaceStation) return false;
	const satellites = (game as any).satellites || {};
	const onTile = Array.isArray(satellites[tileId]) ? satellites[tileId]! : (satellites[tileId] ? [satellites[tileId] as string] : []);
	if (onTile.includes(playerId)) return false;

	const rangeTiles = getPlayerRangeTiles(game, playerId);
	if (rangeTiles.length === 0) return false;
	let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
	const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
	const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
	if (player.qic < neededQIC) return false;

	saveActionStartState(game, playerId);
	player.qic -= neededQIC;
	tile.spaceStation = { ownerId: playerId };
	player.usedIvitsSpaceStationThisRound = true;
	game.hasDoneMainAction = true;
	addBuildingToFederationIfAdjacent(game, playerId, tileId);
	addGameLog(game, playerId, 'Ivits: Space Station (Bot)', neededQIC ? `${neededQIC} QIC (range)` : 'Placed', tileId);
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

/**
 * pending 없이 “지금 상태에서 이클립스 6C 직후 질 수 있는” 소행성 (봇이 액션 시도 전 검증용).
 * 조건은 executeEclipseBuildAsteroidMine과 동일: Nav(+navigationBonus)만, 임시 네비 보너스 없음.
 */
export function peekEclipseAsteroidMineTileIds(game: ServerGameState, playerId: string): string[] {
	const player = game.players[playerId];
	if (!player) return [];
	// [버그수정 2026-07-01] 광산 8개 한도 초과 방지 — 이클립스 소행성광산도 광산 토큰을 쓰므로 한도 적용(사용자 관찰: 광산 9개).
	if (getStructureCount(game, playerId, 'mine') >= BUILDING_LIMITS.mine) return [];
	const rangeTiles = getPlayerRangeTiles(game, playerId);
	if (rangeTiles.length === 0) return [];
	const baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
	const maxRange = baseRange + (player.qic || 0) * 2; // QIC 1개당 +2 거리 (일반 광산/잊혀진 행성과 동일)
	const out: string[] = [];
	for (const tile of game.map) {
		if (tile.type !== 'asteroid' || tile.structure !== null) continue;
		const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
		if (minDist <= maxRange) out.push(tile.id);
	}
	return out;
}

/**
 * Eclipse 6C 후 소행성 광산 배치 가능 타일 (executeEclipseBuildAsteroidMine과 동일 조건).
 */
export function getLegalEclipseAsteroidMineTileIds(game: ServerGameState, playerId: string): string[] {
	const pending = game.pendingEclipseAsteroidMine;
	if (!pending || pending.playerId !== playerId) return [];
	return peekEclipseAsteroidMineTileIds(game, playerId);
}

/** Bot용: 우주선 액션 실행. 소켓 use_ship_action과 동일 로직 (Twilight/Rebellion/TF Mars/Eclipse 전액션). */

export function executeEclipseBuildAsteroidMine(io: SocketIOServer, game: ServerGameState, playerId: string, tileId: string, qicToSpend?: number): boolean {
	const pending = game.pendingEclipseAsteroidMine;
	if (!pending || pending.playerId !== playerId) return false;
	const player = game.players[playerId];
	if (!player) return false;
	const tile = game.map.find(t => t.id === tileId);
	if (!tile || tile.type !== 'asteroid' || tile.structure !== null) return false;
	// [버그수정 2026-07-01] 광산 8개 한도 가드(이클립스 소행성광산도 토큰 사용). 초과 시 건설 거부.
	if (getStructureCount(game, playerId, 'mine') >= BUILDING_LIMITS.mine) return false;
	const rangeTiles = getPlayerRangeTiles(game, playerId);
	if (rangeTiles.length === 0) return false;
	const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
	const baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
	// QIC 1개당 +2 거리로 더 멀리 건설 가능 (일반 광산/잊혀진 행성과 동일). qicToSpend가 오면 일치 검증.
	const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
	if ((player.qic ?? 0) < neededQIC) return false;
	if (typeof qicToSpend === 'number' && qicToSpend !== neededQIC) return false;
	player.qic = (player.qic ?? 0) - neededQIC;
	const rm7QualifyEclipse = qualifiesForNewSectorRoundMission(game, playerId, tileId);
	const geodensTypesBeforeEclipse = getPlayerPlanetTypesForGeodens(game, playerId);
	const ecHadInThisSector = game.map.some(t => t.id !== tileId && t.sector === tile.sector && tileOccupiesSector(t, playerId));
	const ecHadInOuter = game.map.some(t => t.id !== tileId && OUTER_SECTORS.includes(t.sector) && tileOccupiesSector(t, playerId));
	const darkaniansPiBonusEclipse = player.faction === 'darkanians' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute') && ((tile.sector !== 90 && !ecHadInThisSector) || (OUTER_SECTORS.includes(tile.sector) && !ecHadInOuter));
	tile.structure = 'mine';
	tile.ownerId = playerId;
	game.pendingEclipseAsteroidMine = null;
	addGameLog(game, playerId, 'Eclipse: Built mine on asteroid', neededQIC > 0 ? `6C, ${neededQIC} QIC (range)` : '6C (no Gaiaformer)', tileId);
	applyRoundMissionScore(game, playerId, 'build_mine');
	if (rm7QualifyEclipse) applyRoundMissionScore(game, playerId, 'new_sector');
	// RM8(새 행성유형) + 기오덴 의회 +3K — 소행성 포머파괴 경로(executeBuildMine)와 동일하게 누락됐던 것 보강(사용자 관찰)
	if (getPlayerPlanetTypesForGeodens(game, playerId).size > geodensTypesBeforeEclipse.size) {
		applyRoundMissionScore(game, playerId, 'new_planet_type');
	}
	applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeEclipse);
	if (darkaniansPiBonusEclipse) { player.knowledge = (player.knowledge ?? 0) + 1; player.credits = (player.credits ?? 0) + 2; addGameLog(game, playerId, 'Darkanians PI', 'New sector / new outer sector: +1K, +2C', tileId); } // 이클립스 소행성광산 누락 보강(사용자 관찰)
	applyAdvancedTechTileEffect(game, playerId, 'build_mine');
	createPowerOffers(game, tile, playerId);
	addBuildingToFederationIfAdjacent(game, playerId, tileId);
	game.hasDoneMainAction = true;
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

export function executeUseShipAction(
	io: SocketIOServer, game: ServerGameState,
	playerId: string, shipTileId: string, actionIndex: number,
	targetTileId?: string
): boolean {
	if (!game || game.currentPhase !== 'main') return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;
	saveActionStartState(game, playerId);
	const player = game.players[playerId];
	const shipTile = game.map.find(t => t.id === shipTileId);
	const shipTypes = ['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'];
	if (!shipTile || !shipTypes.includes(shipTile.type)) return false;
	const shipState = game.spaceships?.[shipTileId];
	if (!shipState || !shipState.occupants.includes(playerId)) return false;
	const usedIndices = shipState.usedActionIndices ?? (shipState.actionsUsed != null ? [] : []);
	if (usedIndices.includes(actionIndex) || usedIndices.length >= 3) return false;

	// --- Twilight ---
	if (shipTile.type === 'ship_twilight') {
		if (actionIndex === 1) {
			if (player.qic < 3) return false;
			player.qic -= 3;
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			game.pendingTwilightFederation = { playerId, shipTileId };
			// 우주선 첫 칸은 QIC 소모 액션 → adv-vp-qic-action(+4VP/QIC액션) 트리거 (누락 버그 수정, 사용자 관찰)
			applyAdvancedTechTileEffect(game, playerId, 'qic_action');
			game.hasDoneMainAction = true;
			clampPlayerResources(game); emitGameUpdated(io, game);
			return true;
		}
		if (actionIndex === 2) {
			if (targetTileId == null) return false;
			const target = game.map.find(t => t.id === targetTileId);
			if (!target || target.ownerId !== playerId || target.structure !== 'trading_station') return false;
			// [버그수정 2026-07-08 봇 경로] 트왈 TS→연구소 상한(3) — executeUseShipAction(봇)에도 적용(소켓과 중복구현이라 별도).
			if (getStructureCount(game, playerId, 'research_lab') >= BUILDING_LIMITS.research_lab) return false;
			if (player.ore < 2) return false;
			// 타클론: 브레인스톤 포함 소비(3그릇 3파워는 브레인 우선). 직접 power3 차감하면 브레인 무시 버그(사용자 관찰).
			if (player.faction === 'taklons') {
				if (!canSpendTaklonsPower(player, 3, 3)) return false;
			} else if ((player.power3 ?? 0) < 3) {
				return false;
			}
			player.ore -= 2;
			if (player.faction === 'taklons') {
				spendTaklonsPower(player, 3, 3, true);
			} else {
				player.power3 -= 3;
				player.power1 = (player.power1 || 0) + 3;
			}
			target.structure = 'research_lab';
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			/* build_research_lab 라운드 미션은 건물 로그 직후에 처리(로그 같은 줄에 +VP 병합) */
			addGameLog(game, playerId, 'Twilight: TS → Research Lab', '2O, 3P (no 3O 5C)', targetTileId); applyRoundMissionScore(game, playerId, 'build_research_lab');
			// 일반 TS→Lab 업그레이드와 동일하게: 인접 상대에게 파워 제공 + 인접 연방 편입 (우주선 액션 경로 누락 버그 수정)
			createPowerOffers(game, target, playerId);
			addBuildingToFederationIfAdjacent(game, playerId, target.id);
			game.pendingTechTileSelection = { playerId, tileId: targetTileId, structureType: 'research_lab' };
			game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
			game.hasDoneMainAction = true;
			clampPlayerResources(game); emitGameUpdated(io, game);
			return true;
		}
		if (actionIndex === 3) {
			if (player.knowledge < 1) return false;
			player.knowledge -= 1;
			player.tempRangeBonus = true;
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			addGameLog(game, playerId, 'Twilight: +3 Range', '1K (this turn)', shipTileId);
			clampPlayerResources(game); emitGameUpdated(io, game);
			return true;
		}
		return false;
	}

	// --- Rebellion ---
	if (shipTile.type === 'ship_rebellion') {
		if (actionIndex === 1) {
			if (player.qic < 3) return false;
			player.qic -= 3;
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			game.pendingTechTileSelection = { playerId, tileId: '', structureType: 'rebellion_gain' };
			game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
			addGameLog(game, playerId, 'Rebellion: Gain tech tile', '3 QIC (choose tile + track advance)', shipTileId);
			applyAdvancedTechTileEffect(game, playerId, 'qic_action'); // 첫 칸=QIC액션 → adv-vp-qic-action +4VP (누락 버그 수정)
			game.hasDoneMainAction = true;
			clampPlayerResources(game); emitGameUpdated(io, game);
			return true;
		}
		if (actionIndex === 2) {
			const tid = targetTileId != null ? String(targetTileId) : '';
			if (!tid) return false;
			const target = game.map.find(t => t.id === tid || String(t.id) === tid);
			if (!target || target.ownerId !== playerId || target.structure !== 'mine') return false;
			// [버그수정 2026-07-08 봇 경로] 리벨 mine→TS 교역소 상한(4) — executeUseShipAction에도 적용.
			if (getStructureCount(game, playerId, 'trading_station') >= BUILDING_LIMITS.trading_station) return false;
			if (player.ore < 1) return false;
			// 타클론: 브레인스톤 포함 소비(3그릇 3파워는 브레인 우선). 직접 power3 차감하면 브레인 무시 버그(사용자 관찰).
			if (player.faction === 'taklons') {
				if (!canSpendTaklonsPower(player, 3, 3)) return false;
			} else if ((player.power3 ?? 0) < 3) {
				return false;
			}
			player.ore -= 1;
			if (player.faction === 'taklons') {
				spendTaklonsPower(player, 3, 3, true);
			} else {
				player.power3 -= 3;
				player.power1 = (player.power1 || 0) + 3;
			}
			target.structure = 'trading_station';
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			applyRoundMissionScore(game, playerId, 'build_trading_station');
			applyAdvancedTechTileEffect(game, playerId, 'build_ts'); // adv-vp-build-ts(+3VP) — 리벨리온 Mine→TS도 교역소 건설로 취급(누락 수정)
			addGameLog(game, playerId, 'Rebellion: Mine → TS', '1O, 3P (no 2O 3C/6C)', targetTileId);
			createPowerOffers(game, target, playerId);
			addBuildingToFederationIfAdjacent(game, playerId, target.id);
			game.hasDoneMainAction = true;
			clampPlayerResources(game); emitGameUpdated(io, game);
			return true;
		}
		if (actionIndex === 3) {
			if (player.knowledge < 2) return false;
			player.knowledge -= 2;
			grantQic(game, playerId, 1);
			player.credits = (player.credits || 0) + 2;
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			addGameLog(game, playerId, 'Rebellion: 2K → 1Q 2C', '', shipTileId);
			game.hasDoneMainAction = true;
			clampPlayerResources(game); emitGameUpdated(io, game);
			return true;
		}
		return false;
	}

	// --- TF Mars ---
	if (shipTile.type === 'ship_tf_mars') {
		if (actionIndex === 1) {
			if (player.qic < 2) return false;
			player.qic -= 2;
			const count = (player.techTiles ?? []).filter(id => !isTechTileCovered(player, id)).length; // 고급 타일에 덮인 일반 타일은 제외
			addScore(game, playerId, count + 2, 'spaceships', { shipTileId: shipTile.id, shipType: 'ship_tf_mars', actionIndex, noLog: true });
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			addGameLog(game, playerId, 'TF Mars: Tech tiles + 2 VP', `${count + 2} VP`, shipTileId);
			applyAdvancedTechTileEffect(game, playerId, 'qic_action'); // 첫 칸=QIC액션 → adv-vp-qic-action +4VP (누락 버그 수정)
			game.hasDoneMainAction = true;
			clampPlayerResources(game); emitGameUpdated(io, game);
			return true;
		}
		if (actionIndex === 2) {
			if (player.power3 < 2) return false;
			if (getEffectiveGaiaformers(player) < 1) return false;
			player.power3 -= 2;
			player.power1 = (player.power1 || 0) + 2;
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			game.pendingTFMarsGaiaProject = { playerId, shipTileId };
			addGameLog(game, playerId, 'TF Mars: Gaia Project', '2P → place Gaiaformer (same as bonus tile)', shipTileId);
			game.hasDoneMainAction = true;
			clampPlayerResources(game); emitGameUpdated(io, game);
			return true;
		}
		if (actionIndex === 3) {
			if (player.credits < 3) return false;
			player.credits -= 3;
			player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 1;
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			addGameLog(game, playerId, 'TF Mars: 3C → 1 Terraform', '(same as 3PW or bonus 1 Step)', shipTileId);
			clampPlayerResources(game); emitGameUpdated(io, game);
			return true;
		}
		return false;
	}

	// --- Eclipse ---
	if (shipTile.type === 'ship_eclipse') {
		if (actionIndex === 1) {
			if (player.qic < 2) return false;
			player.qic -= 2;
			const structures = game.map.filter(t => t.ownerId === playerId && t.structure);
			void structures; const types = getPlayerPlanetTypesForGeodens(game, playerId); /* 잊혀진 행성(lost_planet)·가상광산 포함 정식 행성유형 집합 — 기존 naive 계산은 space타일의 lost_planet_mine을 놓쳐 미카운트(사용자 관찰) */
			addScore(game, playerId, types.size + 2, 'spaceships', { shipTileId: shipTile.id, shipType: 'ship_eclipse', actionIndex, noLog: true });
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			addGameLog(game, playerId, 'Eclipse: Planet types + 2 VP', `${types.size + 2} VP`, shipTileId);
			applyAdvancedTechTileEffect(game, playerId, 'qic_action'); // 첫 칸=QIC액션 → adv-vp-qic-action +4VP (누락 버그 수정)
			game.hasDoneMainAction = true;
			clampPlayerResources(game); emitGameUpdated(io, game);
			return true;
		}
		if (actionIndex === 2) {
			if (player.knowledge < 2) return false;
			if (player.faction === 'taklons') {
				if (!canSpendTaklonsPower(player, 3, 3)) return false;
			} else if ((player.power3 ?? 0) < 3) {
				return false;
			}
			// [취소 정확도 2026-08-07 사용자] 지불 직전 스냅샷 — 취소 시 종족별 경로(타클론 브레인/네블라 환산)를 정확히 되돌린다
			const preEclipseBot = { knowledge: player.knowledge ?? 0, power1: player.power1 ?? 0, power2: player.power2 ?? 0, power3: player.power3 ?? 0, brainStoneBowl: (player as any).brainStoneBowl };
			player.knowledge -= 2;
			if (player.faction === 'taklons') {
				spendTaklonsPower(player, 3, 3, true);
			} else {
				player.power3 -= 3;
				player.power1 = (player.power1 || 0) + 3;
			}
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			game.pendingEclipseResearch = { playerId, shipTileId, pre: preEclipseBot };
			addGameLog(game, playerId, 'Eclipse: 2K+3P → Research', '(choose track)', shipTileId);
			game.hasDoneMainAction = true;
			clampPlayerResources(game); emitGameUpdated(io, game);
			return true;
		}
		if (actionIndex === 3) {
			if (player.credits < 6) return false;
			// 건설 가능 소행성 없으면(사거리 밖 or 광산 8개 한도) 6C 낭비·stuck 방지 위해 차단(소켓 경로와 일치).
			if (peekEclipseAsteroidMineTileIds(game, playerId).length === 0) return false;
			player.credits -= 6;
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			game.pendingEclipseAsteroidMine = { playerId, shipTileId };
			addGameLog(game, playerId, 'Eclipse: 6C → Build mine on asteroid', '(select tile)', shipTileId);
			clampPlayerResources(game); emitGameUpdated(io, game);
			return true;
		}
		return false;
	}

	return false;
}

/** Bot용: 수익 단계 파워/토큰 자동 선택. select_all_income_items + finish_income_selection 재현. */
export function executeBotIncomeSelection(
	io: SocketIOServer, game: ServerGameState,
	playerId: string
): boolean {
	if (!game.pendingIncomeOrder || game.pendingIncomeOrder.playerId !== playerId) return false;

	const player = game.players[playerId];
	const items = [...game.pendingIncomeOrder.incomeItems];

	if (items.length === 0) {
		delete (player as any).pendingIncomeItems;
		game.pendingIncomeOrder = null;
		clampPlayerResources(game);
		emitGameUpdated(io, game);
		setTimeout(() => helperTriggerIncomePhase(io, game), 100);
		return true;
	}

	if (!game.pendingIncomeOrder.powerBeforeSnapshots) game.pendingIncomeOrder.powerBeforeSnapshots = [];

	const bestOrder = findOptimalIncomeOrder(player, items);

	for (const item of bestOrder) {
		game.pendingIncomeOrder.powerBeforeSnapshots.push(snapshotPlayerPower(player));
		if (item.type === 'tokens') { player.power1 = (player.power1 || 0) + item.amount; }
		else { applyPowerIncome(player, item.amount); }
	}

	game.pendingIncomeOrder.appliedItems.push(...bestOrder);
	game.pendingIncomeOrder.incomeItems = [];
	delete (player as any).pendingIncomeItems;
	log(`Bot ${player.name} auto-received all income: ${items.length} items`, 'game', undefined, { simulation: (game as any).simulation });
	game.pendingIncomeOrder = null;
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	setTimeout(() => helperTriggerIncomePhase(io, game), 100);
	return true;
}

/** Bot용: 턴 종료 (서버의 end_turn 소켓 핸들러와 동일 로직). executeBotTurnIfNeeded는 호출하지 않음 (botHandler에서 처리). */
export function executeEndTurn(
	io: SocketIOServer, game: ServerGameState,
	playerId: string
): boolean {
	if (!game || game.currentPhase !== 'main') return false;
	if (game.pendingTurnEndPlayerId) return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) {
		debugLog(game, `executeEndTurn failed: Not Player ${playerId}'s turn (Current: ${game.turnOrder[game.currentPlayerIndex]})`, 'error');
		return false;
	}
	if (!game.hasDoneMainAction) {
		debugLog(game, `executeEndTurn failed: Player ${playerId} has not done a main action yet`, 'error');
		return false;
	}

	// 대기 중인 후속 선택이 있으면 턴 종료 불가
	if (game.pendingTFMarsGaiaProject?.playerId === playerId) return false;
	if (game.pendingTechTileSelection?.playerId === playerId) return false;
	if (game.pendingShipTechTrackAdvance?.playerId === playerId) return false;
	if (game.pendingAdvancedTechTrackAdvance?.playerId === playerId) return false;
	if (game.pendingSpaceshipFedMine?.playerId === playerId) return false;
	if (game.pendingShipTechMine?.playerId === playerId) return false;
	if (game.pendingLostPlanet?.playerId === playerId) return false;
	// [사용자 2026-08-01] 이클립스/트왈라잇 보류도 해소 전 턴 종료 차단 (소켓 end_turn과 동일 — 비용 지불 후 미선택 증발 방지)
	if (game.pendingEclipseResearch?.playerId === playerId) return false;
	if (game.pendingEclipseAsteroidMine?.playerId === playerId) return false;
	if (game.pendingTwilightFederation?.playerId === playerId) return false;

	const endingPlayerId = game.turnOrder[game.currentPlayerIndex];
	const manualOfferCount = activateQueuedPowerOffersForPlayer(game as ServerGameState, endingPlayerId);
	if (manualOfferCount > 0) {
		game.pendingTurnEndPlayerId = endingPlayerId;
		clampPlayerResources(game);
		emitGameUpdated(io, game);
		return true;
	}

	finalizeTurnEnd(io, game as ServerGameState, endingPlayerId, {
		triggerBot: !(game as any).simulation,
		reason: 'executeEndTurn'
	});

	return true;
}

/** Bot용: pendingTechTileSelection 자동 처리. 트랙 타일 중 진행 가능한 첫 번째를 선택. */
export function executeBotSelectTechTile(
	io: SocketIOServer, game: ServerGameState,
	playerId: string
): boolean {
	if (!game.pendingTechTileSelection || game.pendingTechTileSelection.playerId !== playerId) return false;

	const player = game.players[playerId];
	const _wasItarsExch = game.pendingTechTileSelection.structureType === 'itars_pi_exchange';
	// [버그수정 2026-07-03] 폴백이 itars_pi_exchange 후속(남은토큰→2번째 교환 or 진행)을 안 해 gaia phase hang(사용자: 아이타 기술2개 후 멈춤). 소켓 경로와 동일 체이닝 후 클리어.
	const _clearPendingTech = () => {
		if (_wasItarsExch) {
			const remaining = game.itarsGaiaformerRemainingAfterTech ?? 0;
			game.itarsGaiaformerRemainingAfterTech = undefined;
			if (remaining >= 4) { game.pendingItarsGaiaformerExchange = { playerId, tokensRemaining: remaining }; }
			else { player.power1 = (player.power1 || 0) + remaining; if (remaining > 0) addGameLog(game, playerId, 'Itars PI', `${remaining} tokens → Bowl 1`); helperProceedAfterItarsGaiaformerOrTerran(io, game); }
		}
		game.pendingTechTileSelection = null;
		game.availableShipTechTileIds = undefined;
	};
	const tracks: ResearchTrack[] = ['economy', 'terraforming', 'science', 'navigation', 'artificialIntelligence', 'gaiaProject'];

	// 1. 트랙 타일 시도: 진행 가능한 트랙에 남은 타일이 있으면 선택
	for (const track of tracks) {
		if (player.research[track] >= 5) continue;
		const arr = game.techTilesByTrack?.[track];
		const tiles = Array.isArray(arr) ? arr : (arr ? [arr] : []);
		for (const tile of tiles) {
			if (!tile || !(tile as any).id) continue;
			const techTileId = (tile as any).id as string;
			if (player.techTiles.includes(techTileId)) continue;
			// 이 타일+트랙 조합 유효 → select_tech_tile 소켓과 동일 로직
			const isAdvanced = techTileId.startsWith('adv-');
			const newLevel = (player.research[track] ?? 0) + 1;
			if (newLevel === 5 && isTrackLevel5Taken(game, track, playerId)) continue;
			const greenNeeded = (isAdvanced ? 1 : 0) + (newLevel === 5 ? 1 : 0);
			if (greenNeeded > 0 && countGreenFederations(player) < greenNeeded) continue;

			// 유효! 적용
			for (let i = 0; i < greenNeeded; i++) spendGreenFederation(player);
			player.research[track]++;
			applyTrackLevelBonus(game, playerId, player, track, newLevel);
			addGameLog(game, playerId, 'Bot: Gained Tech Tile', `${techTileId}, ${track} → Lv.${newLevel}`);
			applyRoundMissionScore(game, playerId, 'research_track');
			applyAdvancedTechTileEffect(game, playerId, 'research');
			if (!player.techTiles.includes(techTileId)) player.techTiles.push(techTileId);
			const tilesCast = tiles as (typeof tile | null)[];
			const idx = tilesCast.indexOf(tile);
			if (idx !== -1) tilesCast[idx] = null;
			log(`Bot ${player.name} gained tech tile ${techTileId} and advanced ${track} to level ${newLevel}`, 'game', undefined, { simulation: (game as any).simulation });
			_clearPendingTech();
			clampPlayerResources(game);
			emitGameUpdated(io, game);
			return true;
		}
	}

	// 2. 풀 타일 시도: 진행 가능한 트랙 아무거나 + 풀의 첫 번째 타일
	if (game.techTilesPool) {
		for (let pi = 0; pi < game.techTilesPool.length; pi++) {
			const poolTile = game.techTilesPool[pi];
			if (!poolTile || !(poolTile as any).id) continue;
			const techTileId = (poolTile as any).id as string;
			if (player.techTiles.includes(techTileId)) continue;
			// 진행 가능한 트랙 아무거나 찾기
			for (const track of tracks) {
				if (player.research[track] >= 5) continue;
				const newLevel = (player.research[track] ?? 0) + 1;
				if (newLevel === 5 && isTrackLevel5Taken(game, track, playerId)) continue;
				const greenNeeded = newLevel === 5 ? 1 : 0;
				if (greenNeeded > 0 && countGreenFederations(player) < greenNeeded) continue;
				for (let i = 0; i < greenNeeded; i++) spendGreenFederation(player);
				player.research[track]++;
				applyTrackLevelBonus(game, playerId, player, track, newLevel);
				addGameLog(game, playerId, 'Bot: Gained Tech Tile', `${techTileId} from pool, ${track} → Lv.${newLevel}`);
				applyRoundMissionScore(game, playerId, 'research_track');
				applyAdvancedTechTileEffect(game, playerId, 'research');
				if (!player.techTiles.includes(techTileId)) player.techTiles.push(techTileId);
				(game.techTilesPool as (typeof poolTile | null)[])[pi] = null;
				log(`Bot ${player.name} gained pool tech tile ${techTileId} and advanced ${track} to level ${newLevel}`, 'game', undefined, { simulation: (game as any).simulation });
				_clearPendingTech();
				clampPlayerResources(game);
				emitGameUpdated(io, game);
				return true;
			}
		}
	}

	// 진행 가능한 조합이 없으면 강제 해제 (무한 대기 방지)
	log(`Bot ${player.name} could not find valid tech tile selection, clearing pending state`, 'game', undefined, { simulation: (game as any).simulation });
	_clearPendingTech();
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

/** Bot용: 팅커로이드 라운드 특수 능력 자동 선택. 첫 번째 가능한 옵션 선택. */
export function executeBotTinkeroidSpecial(
	io: SocketIOServer, game: ServerGameState,
	playerId: string
): boolean {
	const pending = game.pendingTinkeroidSpecialChoice;
	if (!pending || pending.playerId !== playerId) return false;
	if (!pending.options || pending.options.length === 0) return false;

	const player = game.players[playerId];
	// [2026-06-30] 기존엔 무조건 options[0] (전략 0). 라운드별 우선순위로 스마트 선택:
	//   초반(1-3R): 엔진/확장 연료 — 4파워 > 1QIC > 1TF+광산. 후반(4-6R): 점수직결 — 3지식 > 2QIC > 3TF+광산.
	//   (지식은 연구·고급타일, QIC는 연방·건설에 귀함. options에 있는 것 중 우선순위 첫 매칭.)
	const round = (game as any).roundNumber ?? 1;
	const pref = round <= 3
		? ['tinkeroid-1tf-mine', 'tinkeroid-4power', 'tinkeroid-1qic']  /* [사용자 2026-07-03] R1-3 확장(1TF광산) 최우선 — under-build 교정, 4파워는 초반 굴릴데 적음 */
		: ['tinkeroid-3k', 'tinkeroid-2qic', 'tinkeroid-3tf-mine'];
	const specialId = pref.find(s => pending.options.includes(s)) ?? pending.options[0];
	player.tinkeroidRoundSpecialId = specialId;
	player.tinkeroidsChosenSpecialIds = [...(player.tinkeroidsChosenSpecialIds ?? []), specialId];

	game.pendingTinkeroidSpecialChoice = null;
	addGameLog(game, playerId, 'Bot: Tinkeroid Special', `Auto-selected ${specialId}`);
	log(`Bot ${player.name} (Tinkeroids) auto-selected special ${specialId}`, 'game', undefined, { simulation: (game as any).simulation });

	game.hasDoneMainAction = false; // 보너스 선택만 일어난 경우 메인 액션 소모 방지
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	// 봇 전용: 보너스 픽업 완료 후 턴오더 강제 리셋을 방지하기 위해 여기선 return만 처리
	// [순서 2026-07-27] 팅커를 맨 앞으로 옮김 → 선택 후 income 계속(가이아포머복귀/아이타/테란/액션).
	helperTriggerIncomePhase(io, game as ServerGameState);
	return true;
}

/** Bot용: 테란 의회 혜택 자동 선택. QIC/지식 위주로 가능한 만큼 선택. */
export function executeBotTerranCouncilBenefit(
	io: SocketIOServer, game: ServerGameState,
	playerId: string
): boolean {
	const pending = game.pendingTerranCouncilBenefit;
	if (!pending || pending.playerId !== playerId) return false;

	const player = game.players[playerId];
	let tokens = pending.tokenCount;
	let qic = 0, knowledge = 0, ore = 0, credits = 0;

	// QIC(4) > Knowledge(4) > Ore(3) > Credits(1) 순서로 자동 배분 시뮬레이션
	// [버그수정] 보너스 한도 = 복귀한 토큰 수(tokenCount). 토큰은 이미 2그릇으로 복귀했으므로 차감하지 않음(사용자 관찰).
	let remaining = tokens;
	while (remaining >= 4) { knowledge++; remaining -= 4; }
	while (remaining >= 1) { credits++; remaining -= 1; }

	grantQic(game, playerId, qic);
	player.knowledge = (player.knowledge ?? 0) + knowledge;
	player.ore = (player.ore ?? 0) + ore;
	player.credits = (player.credits || 0) + credits;

	addGameLog(game, playerId, 'Bot: Terran Council', `Auto: ${tokens} tokens (2그릇 유지) → ${[qic&&`+${qic}Q`,knowledge&&`+${knowledge}K`,ore&&`+${ore}O`,credits&&`+${credits}C`].filter(Boolean).join(' ')||'없음'}`);
	log(`Bot ${player.name} (Terran) auto-selected council benefits: ${tokens} tokens (kept in bowl 2)`, 'game', undefined, { simulation: (game as any).simulation });

	game.pendingTerranCouncilBenefit = null;
	const queue = game.terranCouncilQueue ?? [];
	if (queue.length > 0) {
		game.pendingTerranCouncilBenefit = queue[0];
		game.terranCouncilQueue = queue.slice(1);
	} else {
		game.terranCouncilQueue = [];
		helperFinishAfterGaiaformerPhase(io, game);
	}

	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

/** Bot용: 매안(Bescods) 의회 보유 시 가장 낮은 트랙 +1 스페셜 자동 수행. 가장 낮은 레벨의 트랙 중 하나를 선택. */
export function executeBotBescodsAdvanceLowestTrack(
	io: SocketIOServer, game: ServerGameState,
	playerId: string
): boolean {
	const player = game.players[playerId];
	if (!player || player.faction !== 'bescods') return false;
	if (player.usedSpecialActions?.includes('bescods-advance-lowest')) return false;

	const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
	const levels = tracks.map(t => player.research?.[t] ?? 0);
	const minLevel = Math.min(...levels);
	// Navigation blocked for Bal'Tak without PI (not relevant here since we're already Bescods, but keep check)
	const candidates = tracks.filter(t => {
		const lvl = player.research?.[t] ?? 0;
		if (lvl !== minLevel || lvl >= 5) return false;
		if (lvl === 4 && isTrackLevel5Taken(game, t, playerId)) return false;
		return true;
	});
	if (candidates.length === 0) return false;

	// 동점 최하위 트랙 타이브레이크: science 우선. ★반직관적이나 측정으로 확정(2026-07-06, bescods 강제 40판):
	//   '가치순(확장 우선)'으로 바꾸니 매안 좌석 −10.10 VP. 매 라운드 공짜 전진을 방치된 science에 넣어 트랙 폭/균형
	//   (L3 파워·breadth·미션다양성)을 확보하고 유료연구는 확장에 집중하는 게 매안엔 더 강함. 건드리지 말 것.
	const preferred: ResearchTrack[] = ['science', 'economy', 'gaiaProject', 'artificialIntelligence', 'navigation', 'terraforming'];
	const chosen = preferred.find(t => candidates.includes(t as ResearchTrack)) ?? candidates[0];

	saveActionStartState(game, playerId);
	if (!player.usedSpecialActions) player.usedSpecialActions = [];
	player.usedSpecialActions.push('bescods-advance-lowest');
	player.research[chosen as ResearchTrack] = (player.research[chosen as ResearchTrack] ?? 0) + 1;
	const newLevel = player.research[chosen as ResearchTrack];
	addGameLog(game, playerId, 'Bot: Bescods Special', `가장 낮은 트랙 +1 → ${chosen} Lv.${newLevel}`); applyAdvancedTechTileEffect(game, playerId, 'research'); /* adv-vp-research(+2/연구전진) 누락 수정 */
	applyTrackLevelBonus(game, playerId, player, chosen as ResearchTrack, newLevel);
	applyRoundMissionScore(game, playerId, 'research_track');
	log(`Bot ${player.name} (Bescods) advanced lowest track ${chosen} to Lv.${newLevel}`, 'game', undefined, { simulation: (game as any).simulation });
	game.hasDoneMainAction = true;

	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

/** Bot용: Ambas 시그니처 — PI ↔ 광산 위치 교체(메인액션·1회용). 소켓 핸들러(ambas_swap_pi_mine)와 동일 로직.
 *  봇엔 이 능력을 여는 코드가 아예 없어(사람 2.12/게임 vs 봇 0) getCandidateMoves가 후보로 열고 MCTS가 결정. */
export function executeBotAmbasSwapPiMine(
	io: SocketIOServer, game: ServerGameState,
	playerId: string, mineTileId: string
): boolean {
	const player = game.players[playerId];
	if (!player || player.faction !== 'ambas') return false;
	if (game.hasDoneMainAction) return false;
	if (player.usedSpecialActions?.includes('ambas-swap-pi-mine')) return false;

	const piTile = game.map.find(t => t.ownerId === playerId && t.structure === 'planetary_institute');
	const mineTile = game.map.find(t => t.id === mineTileId && t.ownerId === playerId && (t.structure === 'mine' || t.structure === 'lost_planet_mine'));
	if (!piTile || !mineTile) return false;

	saveActionStartState(game, playerId);
	const prevPI = piTile.structure;
	const prevMine = mineTile.structure;
	piTile.structure = prevMine;
	mineTile.structure = prevPI;
	if (!player.usedSpecialActions) player.usedSpecialActions = [];
	player.usedSpecialActions.push('ambas-swap-pi-mine');
	game.hasDoneMainAction = true;
	addGameLog(game, playerId, 'Ambas: Special', 'PI ↔ Mine 위치 교체', mineTileId);
	log(`Bot ${player.name} (Ambas) swapped PI with Mine (${mineTileId})`, 'game', undefined, { simulation: (game as any).simulation });
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

/** Bot용: 모웨이드 의회 보유 시 링 놓기 스페셜 자동 수행. 링이 없는 첫 번째 건물에 링 배치. */
export function executeBotMoweyipPlaceRing(
	io: SocketIOServer, game: ServerGameState,
	playerId: string
): boolean {
	const player = game.players[playerId];
	if (!player || player.faction !== 'moweyip') return false;
	if (player.usedSpecialActions?.includes('moweyip-place-ring')) return false;
	if (!game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) return false;

	// 링 대상 스코어링(기존 '첫 번째 건물'은 이미 연방된 건물에 낭비 — 사용자 관찰):
	// ①미연방 건물 우선(+2 파워가 향후 연방 7파워에 기여 — 연방 완료 건물이면 그 가치가 죽음)
	// ②상대 건물 인접(2칸) 많을수록 우대(상대가 근처에 지을 때 파워 수신 +2 실현 가능성)
	const fedHexes = new Set(game.playerFederationHexes?.[playerId] || []);
	const ringCandidates = game.map.filter(
		t => t.ownerId === playerId && t.structure && t.structure !== 'ship' && !t.moweyipRing
	);
	if (ringCandidates.length === 0) return false;
	let targetTile = ringCandidates[0];
	let bestScore = -Infinity;
	for (const t of ringCandidates) {
		let s = fedHexes.has(t.id) ? 0 : 100;
		for (const o of game.map) {
			const oppBuilding = o.ownerId && o.ownerId !== playerId && o.structure && o.structure !== 'ship';
			const oppParasite = o.parasiticMine?.ownerId && o.parasiticMine.ownerId !== playerId;
			if ((oppBuilding || oppParasite) && getDistance(t, o) <= 2) s += 10;
		}
		if (s > bestScore) { bestScore = s; targetTile = t; }
	}

	targetTile.moweyipRing = true;
	if (!player.usedSpecialActions) player.usedSpecialActions = [];
	player.usedSpecialActions.push('moweyip-place-ring');
	game.hasDoneMainAction = true;
	addGameLog(game, playerId, 'Bot: Moweyip Special', `링 놓기 → ${targetTile.structure} @ ${targetTile.id} (+2 파워)`, targetTile.id);
	log(`Bot ${player.name} (Moweyip) placed ring on ${targetTile.structure} @ ${targetTile.id}`, 'game', undefined, { simulation: (game as any).simulation });

	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

/** Bot용: 아이타 의회 가이아포머 환전 자동 결정. 4개 이상이면 무조건 기술 타일 선택. */
export function executeBotItarsGaiaformerExchange(
	io: SocketIOServer, game: ServerGameState,
	playerId: string
): boolean {
	const pending = game.pendingItarsGaiaformerExchange;
	if (!pending || pending.playerId !== playerId) return false;

	const player = game.players[playerId];
	const tokensRemaining = pending.tokensRemaining;
	game.pendingItarsGaiaformerExchange = null;

	// 4개 이상이면 기술 타일 선택 (itars_pi_exchange)
	if (tokensRemaining >= 4) {
		const after = tokensRemaining - 4;
		game.itarsGaiaformerRemainingAfterTech = after;
		game.pendingTechTileSelection = { playerId, tileId: '', structureType: 'itars_pi_exchange' };
		// [룰 2026-07-13 사용자 확정] 봇 경로도 우주선 기술타일을 교환 풀에 포함(소켓 경로 4212와 대칭)
		game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
		addGameLog(game, playerId, 'Bot: Itars PI', '4 tokens → Tech Tile exchange');
		clampPlayerResources(game);
		emitGameUpdated(io, game);
		return true;
	}

	// 4개 미만이면 1그릇 복귀
	player.power1 = (player.power1 || 0) + tokensRemaining;
	if (tokensRemaining > 0) addGameLog(game, playerId, 'Bot: Itars PI', `${tokensRemaining} tokens → Bowl 1`);
	helperProceedAfterItarsGaiaformerOrTerran(io, game);

	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

export function executeRespondPowerOffer(io: SocketIOServer, game: ServerGameState, playerId: string, offerId: string, accept: boolean, brainFirst?: boolean, piAddFirst?: boolean) {
	if (!game || !game.pendingPowerOffers) return;

	const offerIndex = game.pendingPowerOffers.findIndex(o =>
		o.id === offerId && (
			o.targetPlayerId === playerId ||
			(game.hostId === playerId && game.botPlayerIds?.includes(o.targetPlayerId))
		)
	);
	if (offerIndex === -1) {
		log(`Power offer response failed: offer ${offerId} not found or target mismatch (socketPlayer: ${playerId})`, 'error');
		return;
	}

	const offer = game.pendingPowerOffers[offerIndex];
	if (offer.responded) return; // 이미 응답함

	offer.responded = true;
	const actualTargetId = offer.targetPlayerId;
	const targetPlayer = game.players[actualTargetId];
	if (!targetPlayer) {
		log(`Power offer response: targetPlayer ${actualTargetId} not found`, 'error');
		game.pendingPowerOffers.splice(offerIndex, 1);
		return;
	}

	if (accept) {
		// [버그수정 2026-07-28 사용자] 오퍼의 amount/vpCost는 생성 시점(같은 턴 다른 leech 처리 전, 충전여력·점수
		//   가득) 기준이라 stale. 한 턴 2회 leech(연구소+광산/검은행성 등)에서 첫 수락으로 충전여력·점수가 줄면
		//   두 번째는 '실제 충전 가능분'만·그만큼의 VP만 내야 하는데(예: 1충전=무료) 옛 값으로 과다 차감하던 문제.
		//   → 응답 시점의 현재 충전여력·점수로 재계산(줄면 그만큼만; 여력 여유면 원래 값과 동일).
		const capNow = getMaxPowerGainForOrder(game, actualTargetId, piAddFirst === true);
		const chargeNow = Math.min(offer.amount, capNow, (targetPlayer.score ?? 0) + 1);
		const vpNow = Math.max(0, chargeNow - 1);
		addScore(game, actualTargetId, -vpNow, 'powerReceived');
		applyPlayerPowerCharge(game, actualTargetId, chargeNow, { brainFirst, piAddFirst });

		const sourcePlayer = game.players[offer.sourcePlayerId];
		const text = `+${chargeNow}P${vpNow > 0 ? ` (-${vpNow}VP)` : ''}`;
		// 중첩 로그 시도하되, 실패하거나 더 명확한 표시를 위해 개별 로그도 병행 고려 (보통 중첩이 가독성 좋음)
		const added = addSubLogToLastAction(game, offer.sourcePlayerId, {
			playerId: actualTargetId,
			playerName: targetPlayer.name,
			text: `↳ Received Power ${text} ${targetPlayer.name}`
		});
		if (!added) {
			addGameLog(game, actualTargetId, 'Received Power', `${text} from ${sourcePlayer?.name}`, offer.tileId);
		} else {
			// 중첩되었더라도 최소한 개별 플레이어 입장에서 무엇인가 일어났음을 알 수 있도록 개별 로그도 남김 (상수 필터링 고려)
			/* 서브로그(건물 아래 ↳)와 중복이라 개별 'Power Gained' 로그는 생략 */
		}
		log(`Player ${targetPlayer.name} accepted power: +${chargeNow}P, -${vpNow}VP`, 'game', undefined, { simulation: (game as any).simulation });
	} else {
		// [2026-07-27 사용자] 수락은 로그창에 뜨는데 거절은 무반응이던 것 — 거절도 같은 서브로그(↳)로 표기
		const declined = addSubLogToLastAction(game, offer.sourcePlayerId, {
			playerId: actualTargetId,
			playerName: targetPlayer.name,
			text: `↳ Declined Power ${targetPlayer.name}`
		});
		if (!declined) addGameLog(game, actualTargetId, 'Declined Power', `from ${game.players[offer.sourcePlayerId]?.name}`, offer.tileId);
		log(`Player ${targetPlayer.name} declined power offer`, 'game', undefined, { simulation: (game as any).simulation });
	}

	game.pendingPowerOffers.splice(offerIndex, 1);
	if (game.pendingPowerOffers.every(o => o.responded)) {
		game.pendingPowerOffers = [];
	}

	if ((game.pendingPowerOffers?.length || 0) === 0 && game.pendingTurnEndPlayerId) {
		const endingPlayerId = game.pendingTurnEndPlayerId;
		finalizeTurnEnd(io, game as ServerGameState, endingPlayerId, { triggerBot: true, reason: 'power_offers_done' });
		return;
	}

	clampPlayerResources(game);
	emitGameUpdated(io, game);

	executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
		log(`Bot turn execution error (respond_power_offer): ${err}`, 'error');
	});
}


// --- 봇 연방 구성 실행 ---
export function executeBotFederation(
	io: SocketIOServer,
	game: ServerGameState,
	playerId: string,
	selectedHexIds: string[],
	selectedPlanetIds: string[],
	rewardId: string,
	spentTokens: number
): boolean {
	const player = game.players[playerId];
	if (!player) return false;

	const isIvits = player.faction === 'ivits';
	const numEmpty = selectedHexIds.length;
	// UI의 federation_complete과 동일한 검증/차감을 bot에서도 강제:
	// - Ivits: QIC로 위성(빈칸) 수만큼 차감
	// - 그 외: 파워 토큰으로 위성(빈칸) 수만큼 차감
	if (isIvits) {
		const qicHave = player.qic ?? 0;
		if (qicHave < numEmpty) return false;
		player.qic = qicHave - numEmpty;
	} else {
		// 브레인 스톤도 1토큰으로 셈 (spendPowerTokens가 일반토큰 우선→브레인 순으로 소비)
		const brainTok = (player.faction === 'taklons' && player.brainStoneBowl != null && !player.brainStoneInGaia) ? 1 : 0;
		const totalPower = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0) + brainTok;
		if (totalPower < numEmpty) return false;
		if (!spendPowerTokens(player, numEmpty)) return false;
	}

	if (!game.federationPool) {
		game.federationPool = {};
		FEDERATION_REWARDS.forEach(r => { game.federationPool![r.id] = 3; });
	}

	if (rewardId.startsWith('ship-fed-')) {
		// [버그수정 2026-06-18] 봇이 우주선 연방 보상을 적용 못하던 것 — federation_select_reward(4591~)와 동일 효과.
		// (사용자 관찰: 우주선 연방이 일반보다 월등한데 봇 후보/적용에 없었음.) ship-fed는 federationPool 차감 없음.
		switch (rewardId) {
			case 'ship-fed-tech':
				game.pendingTechTileSelection = { playerId, tileId: '', structureType: 'rebellion_gain' } as any;
				(game as any).availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
				break;
			case 'ship-fed-4vp4k':
				addScore(game, playerId, 4, 'other', { source: '연방 우주선 보상', noLog: true }); player.knowledge = (player.knowledge || 0) + 4; break;
			case 'ship-fed-4vp1q2o':
				addScore(game, playerId, 4, 'other', { source: '연방 우주선 보상', noLog: true }); grantQic(game, playerId, 1); player.ore = (player.ore || 0) + 2; break;
			case 'ship-fed-8vp8c':
				addScore(game, playerId, 8, 'other', { source: '연방 우주선 보상', noLog: true }); player.credits = (player.credits || 0) + 8; break;
			case 'ship-fed-mine-free':
				game.pendingSpaceshipFedMine = { playerId }; break;
			case 'ship-fed-3tf-mine':
				player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 3; player.spaceshipFed3TfMineFree = true; break;
			case 'ship-fed-12vp':
				addScore(game, playerId, 12, 'other', { source: '연방 우주선 보상', noLog: true }); break;
			case 'ship-fed-7vp3p2t':
				addScore(game, playerId, 7, 'other', { source: '연방 우주선 보상', noLog: true }); player.power3 = (player.power3 || 0) + 2; break;
		}
	} else {
		const reward = FEDERATION_REWARDS.find(r => r.id === rewardId);
		if (reward) {
			addScore(game, playerId, reward.vp, 'other', { source: '연방 ' + reward.label, noLog: true });
			const anyReward = reward as any;
			if (anyReward.ore) player.ore += anyReward.ore;
			if (anyReward.credits) player.credits += anyReward.credits;
			if (anyReward.knowledge) player.knowledge += anyReward.knowledge;
			if (anyReward.qic) grantQic(game, playerId, anyReward.qic);
			if (anyReward.powerTokens) player.power1 = (player.power1 || 0) + anyReward.powerTokens;
			game.federationPool![rewardId] -= 1;
		}
	}

	if (!Array.isArray(player.federations) || (player.federations.length > 0 && typeof (player.federations as any)[0] === 'string')) {
		player.federations = getFederationEntries(player);
	}
	player.federations.push({ rewardId, isGreen: rewardId !== FEDERATION_12VP_ID }); // [버그수정 2026-07-05] 12VP 연방은 유일한 비-초록(사용자 룰)

	if (!game.satellites) game.satellites = {};
	for (const hexId of selectedHexIds) {
		// Ivits: 우주정거장 타일은 satellites(위성)로 기록하지 않음.
		// (우주정거장 타일은 이미 맵에 spaceStation으로 존재하며, 위성 데이터와 섞이면 다른 로직에서 혼동될 수 있음)
		const tile = game.map.find(t => t.id === hexId);
		if (isIvits && tile?.spaceStation?.ownerId === playerId) continue;

		const existing = game.satellites[hexId];
		if (Array.isArray(existing)) {
			if (!existing.includes(playerId)) existing.push(playerId);
		} else if (existing) {
			game.satellites[hexId] = [existing, playerId];
		} else {
			game.satellites[hexId] = [playerId];
		}
	}

	if (!game.playerFederationHexes) game.playerFederationHexes = {};
	if (!game.playerFederationHexes[playerId]) game.playerFederationHexes[playerId] = [];
	game.playerFederationHexes[playerId] = Array.from(new Set([
		...game.playerFederationHexes[playerId],
		...selectedHexIds,
		...selectedPlanetIds,
	]));

	// [문구 통일 2026-08-09 사용자] 사람 경로(소켓)는 'Formed federation (...)' 영문인데 봇 경로만 한글이라
	//   같은 게임 로그에 두 표기가 섞였다 → 영문으로 통일. (봇 경로엔 건물 파워 합계가 없어 위성/QIC 수만 표기)
	const unitLabel = isIvits ? 'QIC' : (numEmpty === 1 ? 'satellite' : 'satellites');
	// 한 줄 통합: 위성 수 텍스트 + 연방 보상 이미지(tileId=rewardId). 'reward: 라벨'·'+VP' 텍스트는 생략
	addGameLog(game, playerId, 'Federation', `Formed federation (${numEmpty} ${unitLabel})`, rewardId);
	// [버그수정 2026-07-12 사용자 발견] 봇 연방 경로에 라운드미션(rs8 연방=5VP) 적용이 통째로 누락 —
	// 사람은 소켓 경로(federation_select_reward)에서 받는데 봇만 못 받아 실게임에서 연방당 5VP 손해.
	// addGameLog 뒤에 호출해 "(+5VP Round Federation)" 주석이 Federation 행에 병합되게 한다.
	applyRoundMissionScore(game, playerId, 'federation');
	game.hasDoneMainAction = true;
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

/** 발타크: 가이아포머 1개 → QIC 1 (프리 액션). 봇/소켓 공용. */
export function executeBalTakGaiaformerToQic(
	io: SocketIOServer,
	game: ServerGameState,
	playerId: string
): boolean {
	if (game.pendingTurnEndPlayerId) return false;
	const player = game.players[playerId];
	if (!player || player.faction !== 'bal_tak') return false;
	if (getEffectiveGaiaformers(player) < 1) return false;

	pushFreeActionUndoSnapshot(game);

	player.balTakGaiaformersUsedForQic = (player.balTakGaiaformersUsedForQic ?? 0) + 1;
	grantQic(game, playerId, 1);
	addGameLog(game, playerId, "Bal T'aks: 1 Gaiaformer → 1 QIC", undefined, undefined);
	log(`Player ${player.name} (Bal T'aks) used 1 Gaiaformer for 1 QIC (locked until next round)`, 'game', undefined, { simulation: (game as any).simulation });
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

/** 자원 변환 (Free Action) */
/** Hadsch Hallas PI 무료 변환 액션(4C→1QIC / 4C→1K / 3C→1O) — 봇/소켓 공용. 크레딧만 있으면 반복 가능(once-per-round 아님). */
export function executeUseHadschHallasPIAction(io: SocketIOServer, game: ServerGameState, playerId: string, actionId: string): boolean {
	const player = game.players[playerId];
	if (!player || player.faction !== 'hadsch_hallas') return false;
	if (game.currentPhase !== 'main') return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;
	const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
	if (!hasPI || !player.hadschHallasPIActions?.length) return false;
	const action = player.hadschHallasPIActions.find(a => a.id === actionId);
	if (!action) return false;
	if ((player.credits ?? 0) < action.costCredits) return false;
	pushFreeActionUndoSnapshot(game);
	player.credits = (player.credits ?? 0) - action.costCredits;
	if (actionId === 'hh-4c-1qic') grantQic(game, playerId, 1);
	else if (actionId === 'hh-4c-1k') player.knowledge = (player.knowledge ?? 0) + 1;
	else if (actionId === 'hh-3c-1o') player.ore = (player.ore ?? 0) + 1;
	else return false;
	addGameLog(game, playerId, 'Hadsch Hallas PI', action.label, undefined);
	clampPlayerResources(game); emitGameUpdated(io, game);
	return true;
}

export function executeConvertResource(
	io: SocketIOServer,
	game: ServerGameState,
	playerId: string,
	type: string,
	useBrain?: boolean
): boolean {
	const player = game.players[playerId];
	if (!player) return false;
	const isTaklons = player.faction === 'taklons';
	const hasNevlasPI = player.faction === 'nevlas' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');

	let success = false;
	let logDesc = '';

	// 타클론 전용: 브레인 스톤(3그릇) 1개 → 크레딧 3 (브레인은 1그릇으로 이동)
	// 규칙(사용자 설명): 브레인은 3그릇에서 사용되면 우선 사용되고(3파워 이상), 사용 시 1그릇으로 이동한다.
	// 여기서는 명시적으로 "1B"를 소비하는 전용 프리 액션으로 제공한다.
	if (type === '1brain-to-3credit') {
		if (!isTaklons) return false;
		if (player.brainStoneInGaia) return false;
		if (player.brainStoneBowl !== 3) return false;
		player.brainStoneBowl = 1;
		player.credits = (player.credits ?? 0) + 3;
		logDesc = '1B → 3C';
		success = true;
	}
	// 네뷸라 전용: 3그릇 토큰 → 가이아포머 공간 + 1K (의회 시 2P→1K)
	else if (type === '1power-to-1k-gaiaformer') {
		if (player.faction !== 'nevlas') return false;
		if ((player.power3 ?? 0) < 1) return false;
		player.power3! -= 1;
		player.gaiaformerPower = (player.gaiaformerPower ?? 0) + 1;
		player.knowledge = (player.knowledge ?? 0) + 1;
		logDesc = '1P → Gaiaformer + 1K';
		success = true;
	}
	else if (type === '3power-to-1ore') {
		if (hasNevlasPI && (player.power3 ?? 0) >= 2) {
			player.power3! -= 2; player.power1 = (player.power1 ?? 0) + 2; player.ore = (player.ore ?? 0) + 1;
			logDesc = '2P → 1O'; success = true;
		} else if (isTaklons) {
			if (canSpendTaklonsPower(player, 3, 3) && spendTaklonsPower(player, 3, 3, useBrain ?? true)) {
				player.ore = (player.ore ?? 0) + 1; logDesc = '3P → 1O'; success = true;
			}
		} else if ((player.power3 ?? 0) >= 3) {
			player.power3! -= 3; player.power1 = (player.power1 ?? 0) + 3; player.ore = (player.ore ?? 0) + 1;
			logDesc = '3P → 1O'; success = true;
		}
	}
	else if (type === '3power-to-2ore') {
		if (hasNevlasPI && (player.power3 ?? 0) >= 3) {
			player.power3! -= 3; player.power1 = (player.power1 ?? 0) + 3; player.ore = (player.ore ?? 0) + 2;
			logDesc = '3P → 2O'; success = true;
		}
	}
	else if (type === '2power-to-1ore-1credit') {
		if (hasNevlasPI && (player.power3 ?? 0) >= 2) {
			player.power3! -= 2; player.power1 = (player.power1 ?? 0) + 2; player.ore = (player.ore ?? 0) + 1; player.credits = (player.credits ?? 0) + 1;
			logDesc = '2P → 1O, 1C'; success = true;
		}
	}
	else if (type === '4power-to-1qic') {
		if (player.faction === 'gleens' && getAcademyRightCount(game, playerId) < 1) return false;
		if (hasNevlasPI && (player.power3 ?? 0) >= 2) {
			player.power3! -= 2; player.power1 = (player.power1 ?? 0) + 2; grantQic(game, playerId, 1);
			logDesc = '2P → 1Q'; success = true;
		} else if (isTaklons) {
			if (canSpendTaklonsPower(player, 3, 4) && spendTaklonsPower(player, 3, 4, useBrain ?? true)) {
				grantQic(game, playerId, 1); logDesc = '4P → 1Q'; success = true;
			}
		} else if ((player.power3 ?? 0) >= 4) {
			player.power3! -= 4; player.power1 = (player.power1 ?? 0) + 4; grantQic(game, playerId, 1);
			logDesc = '4P → 1Q'; success = true;
		}
	}
	else if (type === '1power-to-1credit') {
		if (hasNevlasPI && (player.power3 ?? 0) >= 1) {
			player.power3! -= 1; player.power1 = (player.power1 ?? 0) + 1; player.credits = (player.credits ?? 0) + 2;
			logDesc = '1P → 2C'; success = true;
		} else if (isTaklons) {
			// [버그수정 2026-07-03 사용자관찰] 브레인(3파워)을 1P→1C에 쓰면 3파워 소모+1크레딧만=2파워 낭비.
			// 일반 bowl3 토큰 있으면 그걸로(브레인 보존), 없고 브레인만이면 3파워어치를 3크레딧으로(낭비0).
			const brainInBowl3 = !player.brainStoneInGaia && player.brainStoneBowl === 3;
			if ((player.power3 ?? 0) >= 1 && spendTaklonsPower(player, 3, 1, false)) {
				player.credits += 1; logDesc = '1P → 1C'; success = true;
			} else if (brainInBowl3 && spendTaklonsPower(player, 3, 3, true)) {
				player.credits += 3; logDesc = 'Brain 3P → 3C'; success = true;
			}
		} else if ((player.power3 ?? 0) >= 1) {
			player.power3! -= 1; player.power1 = (player.power1 ?? 0) + 1; player.credits = (player.credits ?? 0) + 1;
			logDesc = '1P → 1C'; success = true;
		}
	}
	else if (type === '1knowledge-to-1credit' && (player.knowledge ?? 0) >= 1) {
		player.knowledge! -= 1; player.credits = (player.credits ?? 0) + 1;
		logDesc = '1K → 1C'; success = true;
	}
	else if (type === '1qic-to-1ore' && (player.qic ?? 0) >= 1) {
		player.qic! -= 1; player.ore = (player.ore ?? 0) + 1;
		logDesc = '1Q → 1O'; success = true;
	}
	else if (type === '1ore-to-1credit' && (player.ore ?? 0) >= 1) {
		player.ore! -= 1; player.credits = (player.credits ?? 0) + 1;
		logDesc = '1O → 1C'; success = true;
	}
	else if (type === '1ore-to-1token' && (player.ore ?? 0) >= 1) {
		player.ore! -= 1;
		if (player.faction === 'xenos') {
			player.power3 = (player.power3 ?? 0) + 1;
			logDesc = '1O → 1 Token to Bowl III';
		} else {
			player.power1 = (player.power1 ?? 0) + 1;
			logDesc = '1O → 1 Token';
		}
		success = true;
	}
	else if (type === '4power-to-1knowledge') {
		if (hasNevlasPI && (player.power3 ?? 0) >= 2) {
			player.power3! -= 2; player.power1 = (player.power1 ?? 0) + 2; player.knowledge = (player.knowledge ?? 0) + 1;
			logDesc = '2P → 1K'; success = true;
		} else if (isTaklons) {
			if (canSpendTaklonsPower(player, 3, 4) && spendTaklonsPower(player, 3, 4, useBrain ?? true)) {
				player.knowledge = (player.knowledge ?? 0) + 1; logDesc = '4P → 1K'; success = true;
			}
		} else if ((player.power3 ?? 0) >= 4) {
			player.power3! -= 4; player.power1 = (player.power1 ?? 0) + 4; player.knowledge = (player.knowledge ?? 0) + 1;
			logDesc = '4P → 1K'; success = true;
		}
	}

	if (success) {
		addGameLog(game, playerId, 'Free Actions', logDesc, undefined);
		clampPlayerResources(game);
		emitGameUpdated(io, game);
		return true;
	}

	return false;
}

export function executeBurnPower(game: ServerGameState, playerId: string, moveBrainToBowl3?: boolean): boolean {
	const player = game.players[playerId];
	if (!player) return false;

	const isTaklonsBrainIn2 = player.faction === 'taklons' && player.brainStoneBowl === 2 && !player.brainStoneInGaia;

	// 타클론 규칙(사용자 설명 기준):
	// - Burn(2→1)은 "2파워"를 소모하는데, 이때 브레인도 1파워로 취급됨.
	// - 따라서 브레인이 2그릇에 있으면, 브레인(1) + 2그릇 일반 토큰 1개(1)만으로 2파워 소모가 성립.
	// - 결과로 브레인이 3그릇으로 이동하고, 2그릇 일반 토큰은 1개만 제거된다.
	if (isTaklonsBrainIn2) {
		if ((player.power2 ?? 0) < 1) return false;
		player.power2 -= 1;
		player.brainStoneBowl = 3;
		addGameLog(game, playerId, 'Taklons: Burn (B+T)', 'Brain(2) + 1 token -> Brain(3)');
		log(`Player ${player.name} burned Brain+1 token (Bowl II -> Brain Bowl III)`, 'game', undefined, { simulation: (game as any).simulation });
		return true;
	}

	// 일반 2→1 번: 2그릇 일반 토큰 2개 제거, 3그릇에 1개 추가
	if ((player.power2 ?? 0) < 2) return false;

	player.power2 -= 2;
	player.power3 += 1;
	if (player.faction === 'itars') {
		player.gaiaformerPower = (player.gaiaformerPower ?? 0) + 1;
		addGameLog(game, playerId, 'Power Burn', `1 token to Bowl III, 1 to Gaia area`);
		log(`Player ${player.name} (Itars) burned 2 power: 1 token to Bowl III, 1 to Gaia area (→Bowl I next round)`, 'game', undefined, { simulation: (game as any).simulation });
	} else {
		addGameLog(game, playerId, 'Power Burn', `Bowl II -> III`);
		log(`Player ${player.name} burned 2 power (Bowl II -> III)`, 'game', undefined, { simulation: (game as any).simulation });
	}
	return true;
}

export function executeEnterSpaceship(io: SocketIOServer, game: ServerGameState, playerId: string, tileId: string, useRangeBonus?: boolean, qicToUse?: number): string | null {
	if (game.hasDoneMainAction) return '이미 메인 액션을 수행했습니다.';
	if (game.currentPhase !== 'main') return '메인 페이즈가 아닙니다.';

	const player = game.players[playerId];
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return '현재 턴이 아닙니다.';

	saveActionStartState(game, playerId);
	const tile = game.map.find(t => t.id === tileId);
	const shipTypes = ['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'];
	if (!tile || !shipTypes.includes(tile.type || '')) return '유효하지 않은 우주선입니다.';

	if (!game.spaceships) {
		game.spaceships = {};
		for (const t of game.map) {
			if (['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse'].includes(t.type || '')) {
				game.spaceships[t.id] = { unlocked: false, occupants: [], usedActionIndices: [] };
			}
		}
	}
	const shipState = game.spaceships[tileId];
	if (!shipState) return '우주선 상태를 찾을 수 없습니다.';

	const entered = player.spaceshipsEntered || [];
	if (entered.length >= 3) return '이미 3개의 우주선에 입장했습니다.';
	if (entered.includes(tileId)) return '이미 이 우주선에 입장했습니다.';

	// 거리 체크: 플레이어 건물에서 우주선 타일까지 (첫 입장도 동일)
	// [증발 버그수정 2026-08-01] +3 사거리/글린즈 +2 보너스를 검증 '전에' 소모하던 것 → 아래 모든 검증
	// 통과 후에만 소모 (예전엔 QIC/VP/토큰 부족으로 입장 거부돼도 보너스만 날아감 — 가이아포머 배치와 동일 부류)
	let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
	if (player.tempRangeBonus) baseRange += 3;
	const usingRangeBonus = !!(useRangeBonus && player.rangeBonusActive);
	if (usingRangeBonus) baseRange += 3;
	const usingGleensBonus = !!player.gleensNavBonusActive;
	if (usingGleensBonus) baseRange += 2;
	const rangeTiles = getPlayerRangeTiles(game, playerId, true);
	if (rangeTiles.length === 0) return '거리 계산을 위한 시작 지점이 없습니다.';
	const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
	const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
	const useQic = qicToUse ?? 0;
	if (neededQIC > 0 && useQic < neededQIC) return '사거리가 부족합니다.';
	if ((player.qic || 0) < useQic) return 'QIC가 부족합니다.';

	// 우주선 입장 비용: 입장자마다 5 VP (발타크는 7 VP)
	const entryCost = player.faction === 'bal_tak' ? 7 : 5;
	if ((player.score || 0) < entryCost) return `우주선 입장에 ${entryCost} VP가 필요합니다.`;

	// 아이타·네뷸라: 우주선 입장 시 토큰 1개 비용 (1그릇 → 2그릇 → 3그릇 순으로 차감, 없으면 입장 불가)
	if (player.faction === 'itars' || player.faction === 'nevlas') {
		const p1 = player.power1 ?? 0, p2 = player.power2 ?? 0, p3 = player.power3 ?? 0;
		if (p1 + p2 + p3 < 1) return '우주선 입장에 파워 토큰 1개가 필요합니다.';
	}
	// 타클론: 브레인 스톤이 가이아 영역에 있으면 (이번 라운드에 브레인 토큰이 없으므로) 우주선 입장 불가
	if (player.faction === 'taklons' && player.brainStoneInGaia) {
		return '타클론: 브레인 스톤이 가이아 영역에 있어 이번 라운드에는 우주선에 입장할 수 없습니다.';
	}

	// ---- 여기부터 성공 확정: 보너스 플래그 소모 + 자원 차감 ----
	if (usingRangeBonus) player.rangeBonusActive = false;
	if (usingGleensBonus) player.gleensNavBonusActive = false;
	player.qic = (player.qic || 0) - useQic; const scoreBefore = player.score ?? 0;
	addScore(game, playerId, -entryCost, 'other', { source: '우주선 입장' });

	if (player.faction === 'itars' || player.faction === 'nevlas') {
		const p1 = player.power1 ?? 0, p2 = player.power2 ?? 0, p3 = player.power3 ?? 0;
		if (p1 >= 1) player.power1 = p1 - 1;
		else if (p2 >= 1) player.power2 = p2 - 1;
		else player.power3 = p3 - 1;
	}

	if (!shipState.unlocked) {
		shipState.unlocked = true;
	}

	shipState.occupants = shipState.occupants || [];
	shipState.occupants.push(playerId);
	if (!player.spaceshipsEntered) player.spaceshipsEntered = [];
	player.spaceshipsEntered.push(tileId);

	// 타클론: 우주선 입장 시 브레인 스톤을 가이아 영역으로 (다음 라운드까지 사용 불가)
	if (player.faction === 'taklons' && player.brainStoneBowl != null && !player.brainStoneInGaia) {
		player.brainStoneInGaia = true;
		addGameLog(game, playerId, 'Taklons: Brain Stone', 'Moved to Gaia (until next round)', tileId);
	}

	// 입장 순서 보상: idx = occupants.length인데 위 8561에서 나를 이미 push했으므로 idx는 '나 포함 1-based 탑승 순번'.
	//   1번째(빈 우주선)=idx1 → 0파워, 2·3번째=idx2·3 → +2PW, 4번째=idx4 → +3PW. (탑승자 1명 있으면 나는 2번째=idx2=+2.)
	// [원복 2026-07-01] 07-01의 idx===1||2 수정은 오진(idx가 나 포함인 걸 착각) — 빈 우주선에 +2 주는 버그였음(사용자 관찰). 원래대로 복구.
	const idx = shipState.occupants.length;
	if (idx === 2 || idx === 3) chargePower(player, 2);
	else if (idx === 4) chargePower(player, 3);

	const shipNm = (({ ship_twilight: 'Twilight', ship_rebellion: 'Rebellion', ship_tf_mars: 'TF Mars', ship_eclipse: 'Eclipse' } as Record<string, string>)[tile.type ?? ''] ?? '우주선');
	addGameLog(game, playerId, 'Entered Ship', `${shipNm} · ${scoreBefore}VP → ${player.score ?? 0}VP (-${entryCost})${useQic ? `, ${useQic}QIC` : ''}`, tileId);

	game.hasDoneMainAction = true;
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return null;
}

/** onFail: 실패 사유를 요청자에게만 안내하는 콜백(소켓 핸들러가 주입). 봇 경로는 안 넘겨 조용히 false. */
export function executePlaceGaiaformer(io: SocketIOServer, game: ServerGameState, playerId: string, tileId: string, qicUsed?: number, onFail?: (message: string) => void): boolean {
	if (!game || game.currentPhase !== 'main') return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;
	const fromTFMars = game.pendingTFMarsGaiaProject?.playerId === playerId;
	if (!fromTFMars && game.hasDoneMainAction) return false;

	saveActionStartState(game, playerId);

	const player = game.players[playerId];
	const tile = game.map.find(t => t.id === tileId);
	if (!tile || tile.type !== 'transdim' || tile.hasGaiaformer || tile.structure !== null) return false;

	if (getEffectiveGaiaformers(player) <= 0) return false;

	// [토큰 증발 버그수정 2026-08-01, 사용자 제보 "Reset하면 토큰이 사라져"] 예전 순서: QIC 차감 → 그릇1→2→3
	// 토큰 차감 → '부족하면 return false' — 실패해도 이미 뺀 QIC/토큰이 복구되지 않고 증발했고, +3사거리
	// 보너스도 검증 전에 소모됐다. 모든 검증을 차감 '앞'으로, 보너스 플래그 소모는 성공 확정 후로 재배치.
	let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
	if (player.tempRangeBonus) baseRange += 3;
	if (player.rangeBonusActive) baseRange += 3;
	if (player.gleensNavBonusActive) baseRange += 2;
	const rangeTiles = getPlayerRangeTiles(game, playerId, true);
	if (rangeTiles.length === 0) return false;

	const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
	const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;

	const qicToUse = qicUsed || 0;
	if (qicToUse < neededQIC) return false;
	if (player.qic < qicToUse) return false;

	const gaiaLevel = player.research.gaiaProject || 0;
	let powerToMove = 0;

	// [버그수정 2026-08-10 사용자 "왜 타클론 브레인스톤으로 포밍 못해?"] 브레인 스톤도 토큰 1개로 센다.
	//   연방 위성·인공물 비용(spendPowerTokens :811)은 2026-06-29에 이미 반영됐는데, 가이아포밍은 그 헬퍼를 안 쓰고
	//   손으로 그릇을 비우는 탓에 power1+2+3만 봐서 브레인이 계산에 아예 안 잡혔다(버튼은 활성인데 조용히 실패).
	//   일반 토큰을 먼저 다 쓰고 '부족분 1개'만 브레인으로 충당한다 — 브레인은 파워로 낼 땐 3인데 여기선 1이라 아깝다.
	//   쓴 브레인은 가이아 영역으로(brainStoneInGaia) → 가이아 단계에 그릇1로 복귀(:2678). gaiaformerPower는 일반
	//   토큰만 세야 한다(브레인은 저 경로로 따로 돌아오므로, 같이 세면 복귀 때 없던 일반 토큰이 1개 생긴다).
	const brainAvailForGaia = (player.faction === 'taklons' && player.brainStoneBowl != null
		&& !player.brainStoneInGaia && !player.brainStoneSpent) ? 1 : 0;
	let tokenPlan: ReturnType<typeof planTokenSpend> = null;

	const pendingGaia = game.pendingTFMarsGaiaProject;
	// [버그수정 2026-07-20] 소유자 미확인: 다른 플레이어의 pending('bonus-gaia')이 남아 있으면 내 일반 배치가
	// 무료 즉포로 오판(반대로 pending이 어긋나면 즉포가 유료 오판될 수도) — playerId 일치까지 요구.
	const isBonusGaia = pendingGaia?.shipTileId === 'bonus-gaia' && pendingGaia?.playerId === playerId;
	const immediateBuildable = fromTFMars || isBonusGaia;

	if (!immediateBuildable) {
		if (gaiaLevel >= 1 && gaiaLevel < 3) powerToMove = 6;
		else if (gaiaLevel >= 3 && gaiaLevel < 4) powerToMove = 4;
		else if (gaiaLevel >= 4) powerToMove = 3;
		else return false;
		// 총 보유 토큰 검증을 차감 전에 완료 (타클론 브레인 스톤 1개 포함)
		// [사용자 2026-08-10] 예전엔 조용히 return false — 클라가 토큰 수를 검사하지 않아 버튼은 활성인데
		//   눌러도 무반응이었다. 종족 공통으로 사유를 안내한다(브레인 보유 시 개수에 포함해 표기).
		tokenPlan = planTokenSpend(player, powerToMove);
		if (!tokenPlan) {
			const haveTokens = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0) + brainAvailForGaia;
			onFail?.(`가이아 포밍을 위한 토큰이 부족합니다. (필요: ${powerToMove}, 보유: ${haveTokens}${brainAvailForGaia ? ' — 브레인 스톤 1개 포함' : ''})`);
			return false;
		}
	}

	// ---- 여기부터 성공 확정: 자원 차감/플래그 소모 ----
	if (player.tempRangeBonus) player.tempRangeBonus = false;
	if (player.rangeBonusActive) player.rangeBonusActive = false;
	if (player.gleensNavBonusActive) player.gleensNavBonusActive = false;
	player.qic -= qicToUse;

	if (!immediateBuildable && tokenPlan) {
		player.power1 = (player.power1 || 0) - tokenPlan.from1;
		player.power2 = (player.power2 || 0) - tokenPlan.from2;
		player.power3 = (player.power3 || 0) - tokenPlan.from3;

		// 브레인은 가이아 영역으로 → 가이아 단계에 그릇1로 복귀(:2678). 연방/인공물의 영구 소멸과 다르다.
		let brainMoved = 0;
		if (tokenPlan.useBrain) {
			player.brainStoneInGaia = true;
			brainMoved = 1;
			addGameLog(game, playerId, 'Taklons: Brain Stone', 'Moved to Gaia (counts as 1 token)', tileId);
		}

		// gaiaformerPower는 일반 토큰만 — 브레인은 위 경로로 따로 돌아오므로 같이 세면 토큰이 1개 생긴다
		player.gaiaformerPower = (player.gaiaformerPower || 0) + (powerToMove - brainMoved);
	}

	player.gaiaformers = (player.gaiaformers || 0) - 1;
	tile.hasGaiaformer = true;
	tile.gaiaformerOwnerId = playerId;

	if (immediateBuildable) {
		if (!player.pendingGaiaformerTiles) player.pendingGaiaformerTiles = [];
		player.pendingGaiaformerTiles.push(tileId);
		tile.type = 'gaia';
		tile.isGaiaformed = true;
	} else {
		if (!player.gaiaformerPlacedThisRound) player.gaiaformerPlacedThisRound = [];
		player.gaiaformerPlacedThisRound.push(tileId);
	}

	game.pendingTFMarsGaiaProject = null;

	const qicText = qicToUse > 0 ? ` (${qicToUse} QIC for range)` : '';
	addGameLog(game, playerId, 'Placed Gaiaformer', `on Transdim (${powerToMove} power tokens moved to Gaiaformer area${qicText})`, tileId);
	log(`Player ${player.name} placed Gaiaformer on Transdim, moved ${powerToMove} power tokens to Gaiaformer area${qicText}`, 'game', undefined, { simulation: (game as any).simulation });

	if (fromTFMars && isBonusGaia) {
		// [로그 UI 2026-07-14 사용자] 'Action completed' 중복 로그 제거 — 바로 위 'Placed Gaiaformer' 전용
		// 로그가 이미 배치를 표기(스킵 케이스의 'skipped'는 유일한 기록이라 유지).
		game.hasDoneMainAction = true;
	} else if (!fromTFMars) {
		game.hasDoneMainAction = true;
	}

	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

/** Bot용: TF Mars/보너스 가이아 프로젝트(가이아포머 배치) 건너뛰기. 서버 skip_tfmars_gaia_project와 동일 로직 */
export function executeSkipTfmarsGaiaProject(io: SocketIOServer, game: ServerGameState, playerId: string): boolean {
	if (!game || game.currentPhase !== 'main') return false;
	const pending = game.pendingTFMarsGaiaProject;
	if (!pending || pending.playerId !== playerId) return false;
	const isBonusGaia = pending.shipTileId === 'bonus-gaia';
	game.pendingTFMarsGaiaProject = null;
	if (isBonusGaia) {
		addGameLog(game, playerId, 'Bonus: Gaia Project', 'skipped (no placement)', 'bonus-gaia');
		game.hasDoneMainAction = true;
	} else {
		addGameLog(game, playerId, 'TF Mars: Gaia Project', 'skipped', pending.shipTileId);
		game.hasDoneMainAction = true;
	}
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}

export function executeTakeTwilightArtifact(io: SocketIOServer, game: ServerGameState, playerId: string, artifactId: string): boolean {
	if (!game || game.currentPhase !== 'main') return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;
	if (game.hasDoneMainAction) return false;

	const player = game.players[playerId];
	const entered = player.spaceshipsEntered ?? [];
	const twilightTile = game.map.find(t => t.type === 'ship_twilight');
	if (!twilightTile || !entered.includes(twilightTile.id)) return false;

	const slots = game.twilightArtifactSlots ?? [];
	const slotIdx = slots.findIndex(s => s === artifactId);
	if (slotIdx === -1 || !ARTIFACTS.some(a => a.id === artifactId)) return false;

	// simulate spendPowerTokens logic
	let amount = 6;
	const total = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);
	if (total < amount) return false;

	saveActionStartState(game, playerId);

	let remaining = amount;
	const from1 = Math.min(remaining, player.power1 || 0);
	player.power1 = (player.power1 || 0) - from1;
	remaining -= from1;
	const from2 = Math.min(remaining, player.power2 || 0);
	player.power2 = (player.power2 || 0) - from2;
	remaining -= from2;
	const from3 = Math.min(remaining, player.power3 || 0);
	player.power3 = (player.power3 || 0) - from3;

	(game.twilightArtifactSlots as (string | null)[])[slotIdx] = null;
	if (!player.artifacts) player.artifacts = [];
	player.artifacts.push(artifactId);

	const art = ARTIFACTS.find(a => a.id === artifactId)!;
	if (art.id === 'art-fed-once') {
		game.pendingTwilightFederation = { playerId, shipTileId: twilightTile.id, fromArtifact: true };
		addGameLog(game, playerId, 'Artifact: Federation benefit', 'Choose one federation reward', art.id);
	} else if (art.id === 'art-vp-gaia') {
		const lvl = player.research.gaiaProject ?? 0;
		const vp = lvl * 3;
		addScore(game, playerId, vp, 'other', { source: 'Artifact: Gaia x 3' });
		addGameLog(game, playerId, 'Artifact: Gaia×3 VP', `${lvl}×3 = ${vp} VP`, art.id);
	} else if (art.id === 'art-vp-science') {
		const lvl = player.research.science ?? 0;
		const vp = lvl * 3;
		addScore(game, playerId, vp, 'other', { source: 'Artifact: Science x 3' });
		addGameLog(game, playerId, 'Artifact: Science×3 VP', `${lvl}×3 = ${vp} VP`, art.id);
	} else if (art.id === 'art-vp-tracks3') {
		const tracks = (['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'] as ResearchTrack[]).filter(t => (player.research[t] ?? 0) >= 3).length;
		const vp = tracks * 3;
		addScore(game, playerId, vp, 'other', { source: 'Artifact: Tracks >= 3' });
		addGameLog(game, playerId, 'Artifact: Tracks≥3×3 VP', `${tracks}×3 = ${vp} VP`, art.id);
	} else if (art.id === 'art-vp-planet-types') {
		const structures = game.map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship');
		const types = new Set(structures.map(t => t.type).filter(x => x && x !== 'space' && x !== 'deep_space'));
		if (player.virtualMineAsteroid) types.add('asteroid');
		if (player.virtualMineProto) types.add('proto');
		const vp = 3 + types.size;
		addScore(game, playerId, vp, 'other', { source: 'Artifact: Planet types' });
		addGameLog(game, playerId, 'Artifact: 3+Planet types VP', `3+${types.size} = ${vp} VP`, art.id);
	} else if (art.id === 'art-7vp-virtual-asteroid') {
		const geodensTypesBeforeArt = getPlayerPlanetTypesForGeodens(game, playerId);
		addScore(game, playerId, 7, 'other', { source: 'Artifact: 7 VP + Asteroid', noLog: true }); // 전용 로그가 바로 아래 — 자동로그 중복 제거(사용자)
		player.virtualMineAsteroid = true;
		addGameLog(game, playerId, 'Artifact: 7 VP + virtual mine (asteroid)', '', art.id);
				applyRoundMissionScore(game, playerId, 'build_mine'); // 가상 광산도 '광산 건설' 라운드 미션(+2) 대상 — 실제/기생/잊혀진 광산과 동일(사용자 관찰)
					applyAdvancedTechTileEffect(game, playerId, 'build_mine'); // adv-vp-build-mine(+3VP) — 가상광산(소행성)도 '광산 건설'로 취급(누락 수정, 사용자 관찰)
		// 가상 광산도 새 행성 유형으로 취급 → 라운드 미션(유형당) + Geodens 의회 보너스 (사람 경로와 동일)
		if (getPlayerPlanetTypesForGeodens(game, playerId).size > geodensTypesBeforeArt.size) {
			applyRoundMissionScore(game, playerId, 'new_planet_type');
		}
		applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeArt);
	} else if (art.id === 'art-7vp-virtual-proto') {
		const geodensTypesBeforeProto = getPlayerPlanetTypesForGeodens(game, playerId);
		addScore(game, playerId, 7, 'other', { source: 'Artifact: 7 VP + Proto', noLog: true }); // 전용 로그가 바로 아래 — 자동로그 중복 제거(사용자)
		player.virtualMineProto = true;
		addGameLog(game, playerId, 'Artifact: 7 VP + virtual mine (proto)', '', art.id);
				applyRoundMissionScore(game, playerId, 'build_mine'); // 가상 광산도 '광산 건설' 라운드 미션(+2) 대상(사용자 관찰)
					applyAdvancedTechTileEffect(game, playerId, 'build_mine'); // adv-vp-build-mine(+3VP) — 가상광산(프로토)도 '광산 건설'로 취급(누락 수정, 사용자 관찰)
		if (getPlayerPlanetTypesForGeodens(game, playerId).size > geodensTypesBeforeProto.size) {
			applyRoundMissionScore(game, playerId, 'new_planet_type');
		}
		applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeProto);
	} else if (art.id === 'art-imm-3o3c') {
		player.ore = (player.ore || 0) + 3;
		player.credits = (player.credits || 0) + 3;
		addGameLog(game, playerId, 'Artifact: 3O 3C', '', art.id);
	} else if (art.id === 'art-imm-2o5c') {
		player.ore = (player.ore || 0) + 2;
		player.credits = (player.credits || 0) + 5;
		addGameLog(game, playerId, 'Artifact: 2O 5C', '', art.id);
	} else if (art.id === 'art-imm-3k1q') {
		player.knowledge = (player.knowledge || 0) + 3;
		player.qic = (player.qic || 0) + 1; // grantQic shortcut
		addGameLog(game, playerId, 'Artifact: 3K 1Q', '', art.id);
	} else if (art.id === 'art-vp-bridge') {
		const bridgeSectors = [11, 12, 13, 14, 15, 16, 17, 18];
		const withBuilding = bridgeSectors.filter(s => game.map.some(t => t.sector === s && tileOccupiesSector(t, playerId)));
		const vp = withBuilding.length * 3;
		addScore(game, playerId, vp, 'other', { source: 'Artifact: Bridge VP' });
		addGameLog(game, playerId, 'Artifact: Bridge sections×3 VP', `${withBuilding.length}×3 = ${vp} VP`, art.id);
	} else {
		addGameLog(game, playerId, 'Artifact', art.label, art.id);
	}

	game.hasDoneMainAction = true;
	for (const p of Object.values(game.players)) {
		if (p.ore != null && p.ore > 15) p.ore = 15;
		if (p.knowledge != null && p.knowledge > 15) p.knowledge = 15;
		if (p.credits != null && p.credits > 30) p.credits = 30;
	}
	emitGameUpdated(io, game);
	return true;
}

export function executeConfirmTwilightFederation(
	io: SocketIOServer,
	game: ServerGameState,
	playerId: string,
	rewardId: string
): boolean {
	const pending = game.pendingTwilightFederation;
	if (!pending || pending.playerId !== playerId) return false;
	const player = game.players[playerId];
	if (!player) return false;
	const myFed = getFederationEntries(player);
	if (!rewardId || !myFed.some((f) => f.rewardId === rewardId)) return false;

	const normalReward = FEDERATION_REWARDS.find(r => r.id === rewardId)
		|| (rewardId === GLEENS_FEDERATION_REWARD.id ? GLEENS_FEDERATION_REWARD : undefined);
	const shipReward = SPACESHIP_FEDERATION_REWARDS.find(r => r.id === rewardId);

	if (normalReward) {
		addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Federation benefit' : 'Twilight: Federation benefit', normalReward.label, rewardId);
		addScore(game, playerId, normalReward.vp, 'spaceships', { shipTileId: pending.shipTileId, shipType: 'ship_twilight', actionIndex: 1, noLog: true });
		if ('ore' in normalReward && normalReward.ore) player.ore += normalReward.ore;
		if ('credits' in normalReward && normalReward.credits) player.credits += normalReward.credits;
		if ('knowledge' in normalReward && normalReward.knowledge) player.knowledge += normalReward.knowledge;
		if ('qic' in normalReward && normalReward.qic) grantQic(game, playerId, normalReward.qic);
		if ('powerTokens' in normalReward && normalReward.powerTokens) player.power1 = (player.power1 || 0) + normalReward.powerTokens;
	} else if (shipReward) {
		switch (rewardId) {
			case 'ship-fed-tech':
				game.pendingTechTileSelection = { playerId, tileId: '', structureType: 'rebellion_gain' };
				game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
				addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', shipReward.label, rewardId);
				break;
			case 'ship-fed-4vp4k':
				addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', shipReward.label, rewardId);
				addScore(game, playerId, 4, 'spaceships', { shipTileId: pending.shipTileId, shipType: 'ship_twilight', actionIndex: 1, noLog: true });
				player.knowledge = (player.knowledge || 0) + 4;
				break;
			case 'ship-fed-4vp1q2o':
				addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', shipReward.label, rewardId);
				addScore(game, playerId, 4, 'spaceships', { shipTileId: pending.shipTileId, shipType: 'ship_twilight', actionIndex: 1, noLog: true });
				grantQic(game, playerId, 1);
				player.ore = (player.ore || 0) + 2;
				break;
			case 'ship-fed-8vp8c':
				addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', shipReward.label, rewardId);
				addScore(game, playerId, 8, 'spaceships', { shipTileId: pending.shipTileId, shipType: 'ship_twilight', actionIndex: 1, noLog: true });
				player.credits = (player.credits || 0) + 8;
				break;
			case 'ship-fed-12vp':
				addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', shipReward.label, rewardId);
				addScore(game, playerId, 12, 'spaceships', { shipTileId: pending.shipTileId, shipType: 'ship_twilight', actionIndex: 1, noLog: true });
				break;
			case 'ship-fed-7vp3p2t':
				addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', shipReward.label, rewardId);
				addScore(game, playerId, 7, 'spaceships', { shipTileId: pending.shipTileId, shipType: 'ship_twilight', actionIndex: 1, noLog: true });
				player.power3 = (player.power3 || 0) + 2; // [수정] ship-fed-7vp3p2t: 그릇3에 토큰 2개(충전됨)
				break;
			case 'ship-fed-mine-free':
			case 'ship-fed-3tf-mine':
				addGameLog(game, playerId, pending.fromArtifact ? 'Artifact: Spaceship Fed' : 'Twilight: Spaceship Fed', `${shipReward.label} (재수령은 즉시 효과만)`, rewardId);
				if (shipReward.id === 'ship-fed-3tf-mine') {
					player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 3;
					player.spaceshipFed3TfMineFree = true;
					log(`Player ${player.name} received 3 terraform steps from ship-fed-3tf-mine`, 'game', undefined, { simulation: (game as any).simulation });
				}
				break;
			default:
				return false;
		}
	} else {
		return false;
	}

	game.pendingTwilightFederation = null;
	clampPlayerResources(game);
	emitGameUpdated(io, game);
	return true;
}
