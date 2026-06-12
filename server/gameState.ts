import { Server as SocketIOServer } from 'socket.io';
import { setActiveEvaluatorWeights, getActiveEvaluatorWeights, type EvaluatorWeights } from './ai/evaluator';
import { MCTS } from './ai/mcts';
import type { Server as HTTPServer } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './index';
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
	canSpendTaklonsPower,
	spendTaklonsPower,
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
	RESEARCH_TRACK_END_BONUS,
	RESEARCH_TRACKS,
	type ScoreBreakdown,
} from '@shared/gameConfig';
import { executeBotTurnIfNeeded, setBotDelayMs } from './botHandler';
import { setPlayerVariant, clearAllPlayerVariants, type PlayerVariant } from './ai/variant';
import { flushGameData } from './ai/valueData';
import * as FactionBidding from './factionBidding';
import { exportHumanGameDataset, recordHumanActionFromLog, type HumanActionJournalEntry } from './humanGameLogger';




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
	turnStartState?: Record<string, any>; // [playerId]: PlayerTurnState
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
const playerGameMap = new Map<string, string>();
const socketToPlayerMap = new Map<string, string>();
const socketToSpectatorMap = new Map<string, string>();
const spectatorToGameMap = new Map<string, string>();

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
	const cloned = StateCloner.cloneGameState(game) as ServerGameState;
	// Undo 스냅샷 내부에 다시 Undo 스택이 들어가면 중첩/용량이 급격히 커질 수 있어 제거
	(cloned as any).freeActionUndoState = undefined;
	cloned.freeActionUndoStack = undefined;
	cloned.freeActionUndoContext = undefined;
	cloned.turnStartState = undefined;
	cloned.queuedPowerOffers = undefined;
	cloned.pendingTurnEndPlayerId = undefined;
	return JSON.stringify(cloned);
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
	(game as any).freeActionUndoState = undefined;
}

/**
 * 턴 시작/리셋용 전체 게임 스냅샷. turnStartState를 제외해 복사하면
 * 중첩으로 인한 기하급수적 용량 증가와 RangeError: Invalid string length 방지.
 */
function cloneGameForTurnStartSnapshot(game: ServerGameState): ServerGameState {
	const { turnStartState: _ts, freeActionUndoState: _fa, gameLog: _gl, humanActionJournal: _haj, ...rest } = game as any;
	// Reset 복원에는 gameLog 본문/Undo 원본 문자열이 필수 아님(길이만 사용) → 스냅샷 용량 대폭 절감
	const cloned = deepClone(rest) as ServerGameState;
	cloned.turnStartState = undefined;
	(cloned as any).freeActionUndoState = undefined;
	cloned.freeActionUndoStack = undefined;
	cloned.freeActionUndoContext = undefined;
	cloned.queuedPowerOffers = undefined;
	cloned.pendingTurnEndPlayerId = undefined;
	cloned.gameLog = [];
	return cloned;
}

/** Reset/턴 시작 스냅샷 1건 — 라이브 game.turnStartState를 통째로 붙이면 타 플레이어·옛 fullGameState 참조가 섞여 멀티플레이에서 잘못 복구될 수 있음 */
function buildTurnStartStateEntryForPlayer(game: ServerGameState, playerId: string) {
	clearFreeActionUndo(game);
	return {
		playerId,
		roundNumber: game.roundNumber,
		currentPlayerIndex: game.currentPlayerIndex,
		playerState: deepClone(game.players[playerId]),
		mapState: deepClone(game.map),
		spaceshipsState: game.spaceships ? deepClone(game.spaceships) : undefined,
		twilightArtifactSlots: game.twilightArtifactSlots ? deepClone(game.twilightArtifactSlots) : undefined,
		gameLogLength: game.gameLog?.length || 0,
		gameLogState: deepClone(game.gameLog ?? []),
		gameLogSnapshotAt: Date.now(),
		humanActionJournalLength: game.humanActionJournal?.length ?? 0,
		humanActionJournalState: deepClone(game.humanActionJournal ?? []),
		fullGameState: cloneGameForTurnStartSnapshot(game),
	};
}

function restoreGameLogForReset(game: ServerGameState, startState: any, playerId: string): NonNullable<GaiaGameState['gameLog']> {
	if (startState.gameLogState) return deepClone(startState.gameLogState);

	// 하위 호환: 이미 진행 중인 게임은 과거 스냅샷에 gameLogState가 없다.
	// 길이 기준 복원 후, 해당 플레이어가 이번 턴에 남긴 액션 로그가 꼬리에 남아 있으면 제거한다.
	const logs = ((game.gameLog || []).slice(0, startState.gameLogLength || 0)) as NonNullable<GaiaGameState['gameLog']>;
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
	} catch (error) {
		log(`Failed to save final game state: ${error}`, 'error', game.id);
	}
}

function addScore(game: GaiaGameState, playerId: string, vp: number, category: keyof ScoreBreakdown, detail?: { round?: number; tileId?: string; shipTileId?: string; source?: string; missionId?: string; noLog?: boolean }) {
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
		b.spaceships.push({ shipTileId: detail?.shipTileId || detail?.tileId || detail?.source || 'spaceship-reward', vp: appliedVp });
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
function countOuterSectorsOccupied(game: GaiaGameState, playerId: string): number {
	return OUTER_SECTORS.filter(s =>
		game.map.some(t => t.sector === s && t.ownerId === playerId && t.structure && t.structure !== 'ship')
	).length;
}

function findNearbyPlayersForPower(game: ServerGameState, tile: HexTile, sourcePlayerId: string): Array<{ playerId: string; maxPower: number; tileId: string }> {
	const result: Array<{ playerId: string; maxPower: number; tileId: string }> = [];
	const processedPlayers = new Set<string>();

	// 2칸 이내의 다른 플레이어 건물 찾기
	for (const otherTile of game.map) {
		if (!otherTile.structure || otherTile.structure === 'ship') continue;
		if (otherTile.ownerId === sourcePlayerId || !otherTile.ownerId) continue;

		const distance = getDistance(tile, otherTile);
		if (distance > 2) continue;

		const targetPlayerId = otherTile.ownerId;

		// 이미 처리한 플레이어는 최대값만 업데이트
		const hasBigBuildingTechTile = game.players[targetPlayerId]?.techTiles?.includes('tech-big-4str') || false;
		let powerValue = getStructurePowerValue(otherTile.structure, hasBigBuildingTechTile);
		// 매안(Bescods) 의회 보유 시 모행성(titanium) 건물은 파워 +1
		const targetPlayer = game.players[targetPlayerId];
		const bescodsHasPI = targetPlayer?.faction === 'bescods' && game.map.some(t => t.ownerId === targetPlayerId && t.structure === 'planetary_institute');
		if (bescodsHasPI && otherTile.type === 'titanium') powerValue += 1;
		// 모웨이드 의회: 링이 놓인 건물은 파워 수신 시 +2
		if (targetPlayer?.faction === 'moweyip' && otherTile.moweyipRing) powerValue += 2;

		if (processedPlayers.has(targetPlayerId)) {
			const existing = result.find(r => r.playerId === targetPlayerId);
			if (existing && powerValue > existing.maxPower) {
				existing.maxPower = powerValue;
				existing.tileId = otherTile.id;
			}
		} else {
			processedPlayers.add(targetPlayerId);
			result.push({ playerId: targetPlayerId, maxPower: powerValue, tileId: otherTile.id });
		}
	}

	return result;
}

export function hasNearbyPlayersForDiscount(game: ServerGameState, tile: HexTile, sourcePlayerId: string): boolean {
	return findNearbyPlayersForPower(game, tile, sourcePlayerId).length > 0;
}

/** 파워 토큰 소비: 1그릇 → 2그릇 → 3그릇 순. 성공 시 true */
function spendPowerTokens(player: PlayerState, amount: number): boolean {
	const total = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);
	if (total < amount) return false;
	let remaining = amount;
	const from1 = Math.min(remaining, player.power1 || 0);
	player.power1 = (player.power1 || 0) - from1;
	remaining -= from1;
	const from2 = Math.min(remaining, player.power2 || 0);
	player.power2 = (player.power2 || 0) - from2;
	remaining -= from2;
	const from3 = Math.min(remaining, player.power3 || 0);
	player.power3 = (player.power3 || 0) - from3;
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

/** 패스/보너스/기술타일용 광산 수 (잊혀진 행성 포함) */
function getMineCountForPassAndBonuses(game: GaiaGameState, playerId: string): number {
	let n = getEffectiveMineCount(game, playerId);
	n += game.map.filter(t => t.ownerId === playerId && t.structure === 'lost_planet_mine').length;
	return n;
}

/** 기오덴 의회 보너스(새 행성 유형당 3K)용: 플레이어가 보유한 행성 유형 집합 (맵 건물·기생·잊혀진 행성·가상 광산 포함) */
function getPlayerPlanetTypesForGeodens(game: GaiaGameState, playerId: string): Set<string> {
	const types = new Set<string>();
	for (const t of game.map) {
		if (t.ownerId === playerId && t.structure && t.structure !== 'ship') {
			if (t.structure === 'lost_planet_mine') types.add('lost_planet');
			else if (t.type !== 'space' && t.type !== 'deep_space') types.add(t.type);
		}
		if (t.parasiticMine?.ownerId === playerId && t.type !== 'space' && t.type !== 'deep_space') types.add(t.type);
	}
	const player = game.players[playerId];
	if (player?.virtualMineAsteroid) types.add('asteroid');
	if (player?.virtualMineProto) types.add('proto');
	return types;
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

/** 플레이어 건물 개수 (맵만, 기생/가상 제외). 아카데미는 academyType 별도. */
export function getStructureCount(game: GaiaGameState, playerId: string, structure: 'planetary_institute' | 'trading_station' | 'research_lab' | 'mine'): number {
	if (structure === 'mine') {
		return game.map.filter(t => t.ownerId === playerId && (t.structure === 'mine' || t.structure === 'lost_planet_mine')).length
			+ game.map.filter(t => t.parasiticMine?.ownerId === playerId).length
			+ (game.players[playerId]?.virtualMineAsteroid ? 1 : 0)
			+ (game.players[playerId]?.virtualMineProto ? 1 : 0);
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
	const hasBig = game.players[playerId]?.techTiles?.includes('tech-big-4str') ?? false;
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

	const n = getFederationEntries(player).length + 1;
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
	} else {
		const net = computeConnectedFederation(game, playerId, selectedHexIds, selectedSpaceStationHexIds, selectedPlanetIds);
		planetIds = net.planetIds;
		power = net.power;
		// 선택 칸이 하나로 연결됐는지 (끊긴 위성이 있으면 false). 선택이 없으면 연결 경고 표시 안 함.
		connected = net.connected || (selectedHexIds.length + selectedSpaceStationHexIds.length + selectedPlanetIds.length === 0);
	}
	const requiredPower = getFederationRequiredPower(game, playerId);
	const hasBig = game.players[playerId]?.techTiles?.includes('tech-big-4str') ?? false;
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
		const potentialGain = getMaxPowerGain(targetPlayer);

		// 이타르(Itars) 의회 보유 시: 파워 수신 대신 가이아 구역에 파워 토큰 1개 추가 가능 (상시 선택)
		// 여기서는 일단 일반적인 파워 수신 가능 여부만 체크하고, 실제 처리 시 이타르 룰 적용
		// 단, 수신 가능한 파워가 0이면 오퍼 자체를 만들지 않음
		if (potentialGain === 0 && targetPlayer.faction !== 'itars') continue;

		const actualGain = Math.min(maxPower, potentialGain);

		// 이타르의 경우 실제 수신량이 0이라도 가이아 토큰을 위해 오퍼를 띄워야 할 수도 있으나, 
		// 원칙적으로 '파워 수신' 행위가 가능해야 점수 깎는 오퍼가 성립함. 
		// 일단 수신 가능 파워가 0이면 오퍼 생략 (사용자 요청 사항)
		if (actualGain === 0) continue;

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

		const autoAcceptOne = offer.vpCost === 0 && targetPlayer.faction !== 'itars' && targetPlayer.faction !== 'taklons';
		const autoAcceptBot = !!game.botPlayerIds?.includes(offer.targetPlayerId);
		if (autoAcceptOne || autoAcceptBot) {
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

function finalizeTurnEnd(io: SocketIOServer, game: ServerGameState, endedPlayerId: string, options?: { triggerBot?: boolean; reason?: string }) {
	game.hasDoneMainAction = false;
	clearFreeActionUndo(game);
	if (game.turnStartState) delete game.turnStartState[endedPlayerId];
	if (game.players[endedPlayerId]) game.players[endedPlayerId].tempRangeBonus = false;
	game.pendingTurnEndPlayerId = undefined;

	game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
	let passCount = 0;
	while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed) {
		game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
		passCount++;
		if (passCount >= game.turnOrder.length) break;
	}

	const newCurrentPlayerId = game.turnOrder[game.currentPlayerIndex];
	if (newCurrentPlayerId) {
		if (!game.turnStartState) game.turnStartState = {};
		game.turnStartState[newCurrentPlayerId] = buildTurnStartStateEntryForPlayer(game as ServerGameState, newCurrentPlayerId);
	}

	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);

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
export function forceSkipStuckBotTurn(io: SocketIOServer, game: ServerGameState, playerId: string, reason: string): void {
	if (game.currentPhase === 'gameEnd') return;
	const player = game.players[playerId];
	log(`forceSkipStuckBotTurn: skipping ${player?.name ?? playerId} (${reason})`, 'error', game.id);
	if (player) player.hasPassed = true; // 이 라운드 동안만 스킵 (다음 라운드에 hasPassed 리셋되어 복귀)

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
	io.to(game.id).emit('game_updated', game);
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
		const sum = (p.ore ?? 0) + (p.credits ?? 0) + (p.qic ?? 0) + (p.knowledge ?? 0);
		const vp = Math.floor(sum / 3);
		if (vp > 0) addScore(game, pid, vp, 'remainingResources');
	}
	for (const pid of Object.keys(game.players)) {
		const bid = game.players[pid]?.factionBidVp ?? 0;
		if (bid > 0) addScore(game, pid, -bid, 'other', { source: '종족 비딩' });
	}
	for (const pid of Object.keys(game.players)) ensureScoreBreakdown(game.players[pid]);
	game.currentPhase = 'gameEnd';
	saveFinalGameState(game);
	flushGameData(game);
	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);
}

/** 특정 플레이어에 대해 파워 충전 처리 (타클론 브레인스톤 및 의회 보너스 포함) */
function applyPlayerPowerCharge(game: GaiaGameState, playerId: string, amount: number, options?: { brainFirst?: boolean; piAddFirst?: boolean }) {
	const player = game.players[playerId];
	if (!player) return;

	const isTaklons = player.faction === 'taklons';
	const hasPI = isTaklons && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
	const brainFirst = options?.brainFirst !== false; // Default true
	const piAddFirst = options?.piAddFirst === true; // Default false (charge power from structures first, then add token)

	if (isTaklons) {
		if (hasPI) {
			// 타클론 의회(PI) 보너스는 "파워 토큰 +1(그릇1)"이며, 그 토큰은 즉시 충전(그릇 이동)되지 않는다.
			// 따라서 순서(piAddFirst)는 시각적/일관성만 결정하고, 추가 charge는 하지 않는다.
			if (piAddFirst) {
				player.power1 = (player.power1 || 0) + 1;
				chargePowerTaklons(player, amount, brainFirst);
			} else {
				chargePowerTaklons(player, amount, brainFirst);
				player.power1 = (player.power1 || 0) + 1;
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
export function addGameLog(game: GaiaGameState, playerId: string, action: string, details?: string, tileId?: string) {
	if ((game as any).simulation) return;
	if (!game.gameLog) {
		game.gameLog = [];
	}
	const player = game.players[playerId];
	if (!player) return;

	const CONSOLIDATABLE_ACTIONS = ['Resource Convert', 'Burn 2 Power', 'Power Burn', 'Burn 2 Power (Itars)', 'Free Actions'];
	const isConsolidatable = CONSOLIDATABLE_ACTIONS.includes(action);

	const lastLog = game.gameLog.length > 0 ? game.gameLog[game.gameLog.length - 1] : null;

	if (isConsolidatable && lastLog && lastLog.playerId === playerId && CONSOLIDATABLE_ACTIONS.includes(lastLog.action)) {
		// Consolidate into the last log
		lastLog.action = 'Free Actions';
		const newDetail = details || action;
		if (lastLog.details) {
			if (!lastLog.details.includes(newDetail)) {
				lastLog.details += `, ${newDetail}`;
			}
		} else {
			lastLog.details = newDetail;
		}
		lastLog.timestamp = Date.now(); // Update timestamp to keep it at the top if sorted
	} else {
		game.gameLog.push({
			timestamp: Date.now(),
			playerId,
			playerName: player.name,
			action: isConsolidatable ? 'Free Actions' : action,
			details: details || (isConsolidatable ? action : undefined),
			tileId,
		});
	}

	recordHumanActionFromLog(game as ServerGameState, playerId, action, details, tileId);

	if (game.gameLog.length > 100) {
		game.gameLog.shift();
	}
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

	// 메인 액션 로그 병합: 가장 마지막 로그가 내 로그라면 details에 추가, 아니면 subLogs에 추가
	if (!game.gameLog) game.gameLog = [];
	const lastLog = game.gameLog.length > 0 ? game.gameLog[game.gameLog.length - 1] : null;

	if (lastLog && lastLog.playerId === playerId) {
		if (lastLog.details) {
			lastLog.details += ` (+${vpGain}VP ${currentRoundMission.condition})`;
		} else {
			lastLog.details = `+${vpGain}VP (${currentRoundMission.condition})`;
		}
	} else {
		// 만약 직전 로그가 내 것이 아니라면(드문 경우) 기존처럼 개별 로그로 남기되 서브 로그 형태로 처리
		addGameLog(game, playerId, '', `+${vpGain}VP (${currentRoundMission.condition})`);
	}
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
					addGameLog(game, playerId, 'Final Mission', `+${pointsEach} VP (${missionId})`);
				}
			}
		}
	}
	game.finalMissionScoresApplied = true;
}

export function qualifiesForNewSectorRoundMission(game: GaiaGameState, playerId: string, tileId: string, sector?: number): boolean {
	const tile = game.map.find(t => t.id === tileId || String(t.id) === tileId);
	if (!tile) return false;
	const sec = sector ?? tile.sector;
	if (sec == null || sec === undefined) return false;
	const hadStructureInThisSector = game.map.some(t => t.ownerId === playerId && t.structure && t.structure !== 'ship' && t.sector === sec);
	const isNewSector = !hadStructureInThisSector;
	const isBridgeSector = sec >= 11 && sec <= 18;
	return isNewSector || isBridgeSector;
}

export function applyAdvancedTechTileEffect(game: GaiaGameState, playerId: string, actionType: 'build_mine' | 'build_ts' | 'research' | 'terraform' | 'qic_action') {
	const player = game.players[playerId];
	if (!player || !player.techTiles) return;

	if (!game.gameLog) game.gameLog = [];

	const appendToLastLog = (vp: number, reason: string) => {
		const lastLog = game.gameLog && game.gameLog.length > 0 ? game.gameLog[game.gameLog.length - 1] : null;
		if (lastLog && lastLog.playerId === playerId && !reason.includes('Tech Tile Bonus')) {
			if (lastLog.details) {
				lastLog.details += ` (+${vp}VP ${reason})`;
			} else {
				lastLog.details = `+${vp}VP (${reason})`;
			}
		} else {
			addGameLog(game, playerId, '', `+${vp}VP (${reason})`);
		}
	};

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

export function applyAdvancedTechTilePassEffect(game: GaiaGameState, playerId: string) {
	const player = game.players[playerId];
	if (!player || !player.techTiles) return;

	for (const tileId of player.techTiles) {
		if (tileId === 'adv-pass-1vp-type') {
			const planetTypes = new Set(game.map.filter(t => t.ownerId === playerId && t.structure && t.type !== 'space').map(t => t.type));
			const vp = planetTypes.size;
			addScore(game, playerId, vp, 'techTiles', { tileId });
			addGameLog(game, playerId, 'Tech Tile Pass Bonus', `+${vp} VP (1 per planet type)`);
		}
		else if (tileId === 'adv-pass-3vp-lab') {
			const labCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'research_lab').length;
			const vp = labCount * 3;
			addScore(game, playerId, vp, 'techTiles', { tileId });
			addGameLog(game, playerId, 'Tech Tile Pass Bonus', `+${vp} VP (3 per lab)`);
		}
		else if (tileId === 'adv-pass-3vp-fed') {
			const fedCount = getFederationEntries(player).length;
			const vp = fedCount * 3;
			addScore(game, playerId, vp, 'techTiles', { tileId });
			addGameLog(game, playerId, 'Tech Tile Pass Bonus', `+${vp} VP (3 per federation)`);
		}
		else if (tileId === 'adv-pass-2vp-asteroid') {
			const asteroidCount = game.map.filter(t => t.ownerId === playerId && t.type === 'asteroid').length;
			const vp = asteroidCount * 2;
			addScore(game, playerId, vp, 'techTiles', { tileId });
			addGameLog(game, playerId, 'Tech Tile Pass Bonus', `+${vp} VP (2 per asteroid)`);
		}
		else if (tileId === 'adv-pass-2vp-outer') {
			const outerCount = countOuterSectorsOccupied(game, playerId);
			const vp = outerCount * 2;
			addScore(game, playerId, vp, 'techTiles', { tileId });
			addGameLog(game, playerId, 'Tech Tile Pass Bonus', `+${vp} VP (2 per outer sector)`);
		}
	}
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
				addGameLog(game, playerId, 'Terraforming 5', `연방 보상 획득: ${reward.label}`);
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
				addScore(game, playerId, vpGain, 'other', { source: 'Gaia Project track reward' });
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
	log(`Triggering income phase for round ${game.roundNumber}`, 'game', undefined, { simulation: (game as any).simulation });
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
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
			log(`[Income] ${player.name} BEFORE: O:${beforeResources.ore} C:${beforeResources.credits} K:${beforeResources.knowledge} Q:${beforeResources.qic} P3:${beforeResources.power3} | BonusTile: ${player.bonusTile}`, 'game', undefined, { simulation: (game as any).simulation });

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
					addScore(game, pId, ei.vp, 'other', { source: 'Economy track reward' });
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
			// 타클론: 가이아에 있던 브레인 스톤을 그릇1으로 복귀
			if (player.faction === 'taklons' && player.brainStoneInGaia) {
				player.brainStoneInGaia = false;
				player.brainStoneBowl = 1;
				log(`[Income] ${player.name} (Taklons): Brain Stone returned to Bowl 1`, 'game', undefined, { simulation: (game as any).simulation });
			}
			// 아이타: 2그릇 태울 때 보관해 둔 토큰을 1그릇으로 복귀 (이제 gaiaformerPower로 통합 관리되므로 이 부분은 삭제 가능하거나 gaiaformerPower 로직으로 대체됨)
			// 기존 itarsPendingBowl1Tokens 로직 삭제 (아래 가이아 포머 복귀 로직에서 통합 처리됨)

			const afterResources = { ore: player.ore, credits: player.credits, knowledge: player.knowledge, qic: player.qic, power3: player.power3 };
			log(`[Income] ${player.name} AFTER: O:${afterResources.ore} C:${afterResources.credits} K:${afterResources.knowledge} Q:${afterResources.qic} P3:${afterResources.power3}`, 'game', undefined, { simulation: (game as any).simulation });

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
				clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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

	// 수익 단계가 모두 끝난 후 가이아 포머 파워 토큰 복귀
	// 테란: 기본 능력으로 2그릇으로 복귀. 의회 있으면 추가로 토큰 수만큼 해택 선택.
	// 그 외 종족: 1그릇으로 복귀
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
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		return;
	}

	if (terranCouncilQueue.length > 0) {
		game.pendingTerranCouncilBenefit = terranCouncilQueue[0];
		game.terranCouncilQueue = terranCouncilQueue.slice(1);
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
			log(`Bot turn execution error (TerranInitial): ${err}`, 'error');
		});
		return;
	}

	// 팅커로이드: 라운드 시작 시 Special 1개 선택 (게임 중 각 1회만, 3/6라운드는 남은 1개 자동 지정)
	const tinkeroidPlayerId = Object.keys(game.players).find(pid => game.players[pid].faction === 'tinkeroids');
	let tinkeroidsPending = false;
	if (tinkeroidPlayerId) {
		const tinkeroidPlayer = game.players[tinkeroidPlayerId];
		const chosen = tinkeroidPlayer.tinkeroidsChosenSpecialIds ?? [];
		const round13 = ['tinkeroid-1tf-mine', 'tinkeroid-1qic', 'tinkeroid-4power'];
		const round46 = ['tinkeroid-3k', 'tinkeroid-2qic', 'tinkeroid-3tf-mine'];
		const pool = game.roundNumber >= 1 && game.roundNumber <= 3 ? round13 : round46;
		const options = pool.filter((id: string) => !chosen.includes(id));
		if (options.length === 1) {
			tinkeroidPlayer.tinkeroidRoundSpecialId = options[0];
			tinkeroidPlayer.tinkeroidsChosenSpecialIds = [...chosen, options[0]];
			log(`Tinkeroid: round ${game.roundNumber} special auto-selected: ${options[0]}`, 'game', undefined, { simulation: (game as any).simulation });
		} else if (options.length > 1) {
			game.pendingTinkeroidSpecialChoice = { playerId: tinkeroidPlayerId, round: game.roundNumber, options };
			tinkeroidsPending = true;
			executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
				log(`Bot turn execution error (TinkeroidInitial): ${err}`, 'error');
			});
		}
	}

	clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

	if (!tinkeroidsPending) {
		helperStartNewRoundTurn(io, game);
	}
}

export function helperStartNewRoundTurn(io: SocketIOServer, game: GaiaGameState) {
	// 수익 단계 종료 → 액션 단계는 항상 턴 순서 1번(선 플레이어)부터
	game.currentPlayerIndex = 0;
	// 첫 플레이어가 패스한 상태면 다음 플레이어로 (실제로는 라운드 초기에는 없을 수 있지만 방어적 코드)
	while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed && Object.values(game.players).some(p => !p.hasPassed)) {
		game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
	}

	const currentId = game.turnOrder[game.currentPlayerIndex];
	if (currentId) {
		if (!game.turnStartState) game.turnStartState = {};
		game.turnStartState[currentId] = buildTurnStartStateEntryForPlayer(game as ServerGameState, currentId);
	}
	clampPlayerResources(game as ServerGameState); io.to(game.id).emit('game_updated', game);

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
			log(`[PACE r${game.roundNumber}] ${p.faction}: VP${p.score} | struct${st.length}(m${c.mine ?? 0}/ts${c.trading_station ?? 0}/lab${c.research_lab ?? 0}/pi${c.planetary_institute ?? 0}/ac${c.academy ?? 0}) | res${rs} | fed${feds} | O${p.ore}C${p.credits}K${p.knowledge}Q${p.qic} P${(p.power1 ?? 0)}/${(p.power2 ?? 0)}/${(p.power3 ?? 0)}${shTag}${fedProbe}`, 'game', undefined, { simulation: (game as any).simulation });
		}
	}

	// 첫 플레이어가 봇이면 바로 봇 턴 시작
	executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
		log(`Bot turn execution error (StartNewRoundTurn): ${err}`, 'error');
	});
}

export function helperProceedAfterItarsGaiaformerOrTerran(io: SocketIOServer, game: GaiaGameState) {
	const terranQueue = game.terranCouncilQueueAfterItars;
	game.terranCouncilQueueAfterItars = undefined;
	if (terranQueue && terranQueue.length > 0) {
		game.pendingTerranCouncilBenefit = terranQueue[0];
		game.terranCouncilQueue = terranQueue.slice(1);
		clampPlayerResources(game as ServerGameState); io.to(game.id).emit('game_updated', game);
		// 봇 보상 선택 처리
		executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
			log(`Bot turn execution error (ProceedAfterItarsTerranBenefit): ${err}`, 'error');
		});
		return;
	}
	game.currentPlayerIndex = 0;
	// 첫 플레이어가 패스한 상태면 다음 플레이어로
	while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed && Object.values(game.players).some(p => !p.hasPassed)) {
		game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
	}

	const currentId = game.turnOrder[game.currentPlayerIndex];
	if (currentId) {
		if (!game.turnStartState) game.turnStartState = {};
		game.turnStartState[currentId] = buildTurnStartStateEntryForPlayer(game as ServerGameState, currentId);
	}
	clampPlayerResources(game as ServerGameState); io.to(game.id).emit('game_updated', game);

	// 봇 턴 확인
	executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
		log(`Bot turn execution error (ProceedAfterItarsTerranEnd): ${err}`, 'error');
	});
}

export function helperFinishAfterGaiaformerPhase(io: SocketIOServer, game: GaiaGameState) {
	const currentId = game.turnOrder[game.currentPlayerIndex];
	if (currentId) {
		if (!game.turnStartState) game.turnStartState = {};
		game.turnStartState[currentId] = buildTurnStartStateEntryForPlayer(game as ServerGameState, currentId);
	}
	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);

	// 가이아 단계 종료 후 봇 턴 확인
	executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
		log(`Bot turn execution error (FinishAfterGaiaformerPhase): ${err}`, 'error');
	});
}

export function setupGameServer(httpServer: HTTPServer) {
	const io = new SocketIOServer(httpServer, {
		cors: { origin: '*', methods: ['GET', 'POST'] },
		path: '/socket.io',
	});

	io.on('connection', (socket) => {
		log(`Player connected: ${socket.id}`, 'socket.io');

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

		socket.on('create_game', ({ playerName }, callback) => {
			const gameId = generateGameId();
			const playerId = generatePlayerId();

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
				useFactionBidding: false,
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

			games.set(gameId, game);
			game.hostSocketId = socket.id;
			playerGameMap.set(playerId, gameId);
			socketToPlayerMap.set(socket.id, playerId);
			socket.join(gameId);

			log(`Game created: ${gameId} by ${playerName}`, 'game', undefined, { simulation: (game as any).simulation });
			callback({ gameId, playerId, game });
		});

		socket.on('join_game', ({ gameId, playerName }, callback) => {
			const game = games.get(gameId);
			if (!game || Object.keys(game.players).length >= game.maxPlayers || game.currentPhase !== 'lobby') {
				callback({ error: 'Cannot join game' }); return;
			}
			const playerId = generatePlayerId();
			game.players[playerId] = createInitialPlayerState(playerName);
			game.turnOrder.push(playerId);
			playerGameMap.set(playerId, gameId);
			socketToPlayerMap.set(socket.id, playerId);
			socket.join(gameId);
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
			callback({ gameId, playerId, game });
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
			io.to(gameId).emit('game_updated', game);
			callback({ playerId: newPlayerId, name, game });
		});

		/** 방장 전용: AI 봇 플레이어 추가 */
		socket.on('host_add_bot', ({ gameId, botName }, callback) => {
			const game = games.get(gameId);
			if (!game) { callback({ error: 'Game not found' }); return; }
			const callerId = socketToPlayerMap.get(socket.id);
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
			io.to(gameId).emit('game_updated', game);
			callback({ botId, name, game });
		});

		socket.on('rejoin_game', ({ gameId, playerId }, callback) => {
			const game = games.get(gameId);
			if (!game) { callback({ error: 'Game not found' }); return; }

			// 관전자 재접속: 플레이어 슬롯 없이 방만 구독
			if (game.spectatorIds?.includes(playerId)) {
				socketToSpectatorMap.set(socket.id, playerId);
				spectatorToGameMap.set(playerId, gameId);
				socket.join(gameId);
				callback({ game });
				return;
			}

			if (!game.players[playerId]) { callback({ error: 'Player not found' }); return; }

			// If the reconnecting player is the host, update the host socket context
			if (game.hostId === playerId) {
				game.hostSocketId = socket.id;
			}

			socketToPlayerMap.set(socket.id, playerId);
			playerGameMap.set(playerId, gameId);
			socket.join(gameId);
			clampPlayerResources(game);
			io.to(gameId).emit('game_updated', game);
			callback({ game });
			executeBotTurnIfNeeded(io, game as ServerGameState).catch(() => { });
		});

		socket.on('watch_game', ({ gameId }, callback) => {
			const game = games.get(gameId);
			if (!game) { callback({ error: 'Game not found' }); return; }

			const spectatorId = 'spec-' + generatePlayerId();
			if (!game.spectatorIds) game.spectatorIds = [];
			game.spectatorIds.push(spectatorId);
			socketToSpectatorMap.set(socket.id, spectatorId);
			spectatorToGameMap.set(spectatorId, gameId);
			socket.join(gameId);
			log(`Spectator joined game ${gameId} (${spectatorId})`, 'game', undefined, { simulation: (game as any).simulation });
			callback({ gameId, spectatorId, game });
		});

		socket.on('get_game', ({ gameId }, callback) => {
			const game = games.get(gameId);
			if (!game) { callback({ error: 'Game not found' }); return; }
			callback({ game });
			executeBotTurnIfNeeded(io, game as ServerGameState).catch(() => { });
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
				io.to(gameId).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);

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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
		});

		/**
		 * 테스트용 원클릭 자동 세팅 (봇 3개 + 랜덤 팩션 + 게임 시작). selfPlay: true 시 호스트도 봇으로 간주해 4인 전부 봇으로 진행.
		 * headToHead: 같은 테이블 A/B 비교. bPositions(0-base 턴순서 위치)에 해당하는 좌석은 그룹 B(도전자),
		 *   나머지는 그룹 A(챔피언) 변형을 갖는다. 좌석별로 evaluator 가중치/기능 플래그가 달라진다.
		 */
		socket.on('auto_setup_test', ({ gameId, selfPlay, headToHead }: {
			gameId: string;
			selfPlay?: boolean;
			headToHead?: { bPositions: number[]; A: PlayerVariant; B: PlayerVariant };
		}) => {
			const game = games.get(gameId);
			if (!game) return;
			const callerId = socketToPlayerMap.get(socket.id);
			if (callerId !== game.hostId) return;
			if (game.currentPhase !== 'lobby') return;

			// head-to-head: 이전 게임의 좌석별 변형을 비운다(워커는 게임을 순차 실행)
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

				let factionIdx = 0;
				shuffledPlayerIds.forEach((pid, idx) => {
					const player = game.players[pid];

					// 이미 팩션이 있는 경우 (유저가 선택함), 턴 순서만 새로 배정하여 executeSelectFaction 호출
					if (player.faction) {
						executeSelectFaction(io, game, pid, player.faction, idx + 1, { skipBotTrigger: true });
						return;
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
				io.to(gameId).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
			io.to(gameId).emit('game_updated', game);
			callback?.({ ok: true });
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;

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

			executeBuildMine(io, game, playerId, tileId, useGaiaformer);
		});

		// 우주선 입장 (5VP로 잠금 해제 후 입장, 또는 이미 열린 우주선에 거리 체크 후 입장)
		socket.on('enter_spaceship', ({ gameId, tileId, useRangeBonus, qicToUse }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;

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
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
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
					addGameLog(game, playerId, 'Twilight: Federation benefit', '3 QIC (choose reward)', shipTileId);
					game.hasDoneMainAction = true; // 우주선 액션 = 파워액션과 동일, 한 턴에 하나
					clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
					return;
				}
				if (actionIndex === 2) {
					if (!targetTileId) return;
					const target = game.map.find(t => t.id === targetTileId);
					if (!target || target.ownerId !== playerId || target.structure !== 'trading_station') return;
					{ const tok = shipPowerTokens(3);
					if (player.ore < 2 || player.power3 < tok) return;
					player.ore -= 2;
					player.power3 -= tok;
					player.power1 += tok; }
					target.structure = 'research_lab';
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					applyRoundMissionScore(game, playerId, 'build_research_lab');
					addGameLog(game, playerId, 'Twilight: TS → Research Lab', '2O, 3P (no 3O 5C)', targetTileId);
					// 일반 TS→Lab 업그레이드와 동일하게: 인접 상대에게 파워 제공 + 인접 연방 편입 (우주선 액션 경로 누락 버그 수정)
					createPowerOffers(game, target, playerId);
					addBuildingToFederationIfAdjacent(game, playerId, target.id);
					game.pendingTechTileSelection = { playerId, tileId: targetTileId, structureType: 'research_lab' };
					// 연구소 건설 시 6트랙+풀+우주선 기술 타일 모두 선택 가능 (동일 플로우)
					game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
					game.hasDoneMainAction = true;
					clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
					addGameLog(game, playerId, 'Twilight: +3 Range', '1K (this turn)', shipTileId);
					// hasDoneMainAction 설정하지 않음 → 같은 턴에 광산 건설/가이아포밍 등 후 End Turn
					clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
					addGameLog(game, playerId, 'Rebellion: Gain tech tile', '3 QIC (choose tile + track advance)', shipTileId);
					game.hasDoneMainAction = true;
					clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
					return;
				}
				if (actionIndex === 2) {
					const tid = targetTileId != null ? String(targetTileId) : '';
					if (!tid) return;
					const target = game.map.find(t => t.id === tid || String(t.id) === tid);
					if (!target || target.ownerId !== playerId || target.structure !== 'mine') return;
					{ const tok = shipPowerTokens(3);
					if (player.ore < 1 || player.power3 < tok) return;
					player.ore -= 1;
					player.power3 -= tok;
					player.power1 += tok; }
					target.structure = 'trading_station';
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					applyRoundMissionScore(game, playerId, 'build_trading_station');
					addGameLog(game, playerId, 'Rebellion: Mine → TS', '1O, 3P (no 2O 3C/6C)', targetTileId);
					createPowerOffers(game, target, playerId);
					addBuildingToFederationIfAdjacent(game, playerId, target.id);
					game.hasDoneMainAction = true;
					clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
					addGameLog(game, playerId, 'Rebellion: 2K → 1Q 2C', '', shipTileId);
					game.hasDoneMainAction = true;
					clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
					return;
				}
			}

			// --- TF Mars ---
			if (shipTile.type === 'ship_tf_mars') {
				if (actionIndex === 1) {
					if (player.qic < 2) return;
					player.qic -= 2;
					const count = player.techTiles?.length ?? 0;
					addScore(game, playerId, count + 2, 'other', { source: 'TF Mars Action' });
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					addGameLog(game, playerId, 'TF Mars: Tech tiles + 2 VP', `(${count}+2) VP`, shipTileId);
					game.hasDoneMainAction = true;
					clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
					return;
				}
				if (actionIndex === 2) {
					if (player.power3 < shipPowerTokens(2)) return; // Nevlas 의회: 2pw=1토큰
					if (getEffectiveGaiaformers(player) < 1) {
						socket.emit('game_error', { message: '사용 가능한 가이아포머가 없습니다.' });
						return;
					}
					player.power3 -= shipPowerTokens(2);
					player.power1 += shipPowerTokens(2);
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					game.pendingTFMarsGaiaProject = { playerId, shipTileId };
					addGameLog(game, playerId, 'TF Mars: Gaia Project', '2P → place Gaiaformer (same as bonus tile)', shipTileId);
					game.hasDoneMainAction = true; // 가이아포머 배치는 후속 선택이지만 턴은 이미 소모
					clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
					addGameLog(game, playerId, 'TF Mars: 3C → 1 Terraform', '(same as 3PW or bonus 1 Step, use when building)', shipTileId);
					// 같은 턴에 광산 건설 시 테라포밍 할인 받을 수 있도록 hasDoneMainAction 설정하지 않음
					clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
					return;
				}
			}

			// --- Eclipse ---
			if (shipTile.type === 'ship_eclipse') {
				if (actionIndex === 1) {
					if (player.qic < 2) return;
					player.qic -= 2;
					const structures = game.map.filter(t => t.ownerId === playerId && t.structure);
					const types = new Set(structures.map(t => t.type).filter(t => t && t !== 'space' && t !== 'deep_space'));
					addScore(game, playerId, types.size + 2, 'other', { source: 'Eclipse Action' });
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					addGameLog(game, playerId, 'Eclipse: Planet types + 2 VP', `(${types.size}+2) VP`, shipTileId);
					game.hasDoneMainAction = true;
					clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
					player.knowledge -= 2;
					if (player.faction === 'taklons') {
						spendTaklonsPower(player, 3, 3, true);
					} else {
						player.power3 -= shipPowerTokens(3);
						player.power1 = (player.power1 || 0) + shipPowerTokens(3);
					}
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					game.pendingEclipseResearch = { playerId, shipTileId };
					addGameLog(game, playerId, 'Eclipse: 2K+3P → Research', '(choose track)', shipTileId);
					game.hasDoneMainAction = true;
					clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
					return;
				}
				if (actionIndex === 3) {
					// 6C 지불 후 소행성 선택 시 광산 건설 (선택 완료 시점에 hasDoneMainAction 설정)
					if (player.credits < 6) return;
					player.credits -= 6;
					shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
					shipState.actionsUsed = shipState.usedActionIndices.length;
					if (!shipState.usedActionBy) shipState.usedActionBy = {};
					shipState.usedActionBy[actionIndex] = playerId;
					game.pendingEclipseAsteroidMine = { playerId, shipTileId };
					addGameLog(game, playerId, 'Eclipse: 6C → Build mine on asteroid', '(select tile)', shipTileId);
					// hasDoneMainAction은 소행성 선택 후 eclipse_build_asteroid_mine에서 설정
					clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
					return;
				}
			}

			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		});

		// 트왈라잇 인공물 가져가기 (우주선에 있는 플레이어만, 6파워 1→2→3 순 소모)
		socket.on('take_twilight_artifact', ({ gameId, artifactId }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
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
				game.pendingTwilightFederation = { playerId, shipTileId: twilightTile.id };
				addGameLog(game, playerId, 'Artifact: Federation benefit', 'Choose one federation reward', twilightTile.id);
			} else if (art.id === 'art-vp-gaia') {
				const lvl = player.research.gaiaProject ?? 0;
				const vp = lvl * 3;
				addScore(game, playerId, vp, 'other', { source: 'Artifact: Gaia x 3' });
				addGameLog(game, playerId, 'Artifact: Gaia×3 VP', `${lvl}×3 = ${vp} VP`, twilightTile.id);
			} else if (art.id === 'art-vp-science') {
				const lvl = player.research.science ?? 0;
				const vp = lvl * 3;
				addScore(game, playerId, vp, 'other', { source: 'Artifact: Science x 3' });
				addGameLog(game, playerId, 'Artifact: Science×3 VP', `${lvl}×3 = ${vp} VP`, twilightTile.id);
			} else if (art.id === 'art-vp-tracks3') {
				const tracks = (['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'] as ResearchTrack[]).filter(t => (player.research[t] ?? 0) >= 3).length;
				const vp = tracks * 3;
				addScore(game, playerId, vp, 'other', { source: 'Artifact: Tracks >= 3' });
				addGameLog(game, playerId, 'Artifact: Tracks≥3×3 VP', `${tracks}×3 = ${vp} VP`, twilightTile.id);
			} else if (art.id === 'art-vp-planet-types') {
				const structures = game.map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship');
				const types = new Set(structures.map(t => t.type).filter(x => x && x !== 'space' && x !== 'deep_space'));
				if (player.virtualMineAsteroid) types.add('asteroid');
				if (player.virtualMineProto) types.add('proto');
				const vp = 3 + types.size;
				addScore(game, playerId, vp, 'other', { source: 'Artifact: Planet types' });
				addGameLog(game, playerId, 'Artifact: 3+Planet types VP', `3+${types.size} = ${vp} VP`, twilightTile.id);
			} else if (art.id === 'art-7vp-virtual-asteroid') {
				const geodensTypesBeforeArt = getPlayerPlanetTypesForGeodens(game, playerId);
				addScore(game, playerId, 7, 'other', { source: 'Artifact: 7 VP + Asteroid' });
				player.virtualMineAsteroid = true;
				addGameLog(game, playerId, 'Artifact: 7 VP + virtual mine (asteroid)', '', twilightTile.id);
				applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeArt);
			} else if (art.id === 'art-7vp-virtual-proto') {
				const geodensTypesBeforeArtProto = getPlayerPlanetTypesForGeodens(game, playerId);
				addScore(game, playerId, 7, 'other', { source: 'Artifact: 7 VP + Proto' });
				player.virtualMineProto = true;
				addGameLog(game, playerId, 'Artifact: 7 VP + virtual mine (proto)', '', twilightTile.id);
				applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeArtProto);
			} else if (art.id === 'art-imm-3o3c') {
				player.ore = (player.ore || 0) + 3;
				player.credits = (player.credits || 0) + 3;
				addGameLog(game, playerId, 'Artifact: 3O 3C', '', twilightTile.id);
			} else if (art.id === 'art-imm-2o5c') {
				player.ore = (player.ore || 0) + 2;
				player.credits = (player.credits || 0) + 5;
				addGameLog(game, playerId, 'Artifact: 2O 5C', '', twilightTile.id);
			} else if (art.id === 'art-imm-3k1q') {
				player.knowledge = (player.knowledge || 0) + 3;
				grantQic(game, playerId, 1);
				addGameLog(game, playerId, 'Artifact: 3K 1Q', '', twilightTile.id);
			} else if (art.id === 'art-vp-bridge') {
				const bridgeSectors = [11, 12, 13, 14, 15, 16, 17, 18];
				const withBuilding = bridgeSectors.filter(s => game.map.some(t => t.sector === s && t.ownerId === playerId && t.structure));
				const vp = withBuilding.length * 3;
				addScore(game, playerId, vp, 'other', { source: 'Artifact: Bridge VP' });
				addGameLog(game, playerId, 'Artifact: Bridge sections×3 VP', `${withBuilding.length}×3 = ${vp} VP`, twilightTile.id);
			} else {
				addGameLog(game, playerId, 'Artifact', art.label, twilightTile.id);
			}

			game.hasDoneMainAction = true;
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
			io.to(game.id).emit('game_updated', game);
		});

		// Eclipse 액션2 취소: 자원과 사용 횟수 롤백
		socket.on('cancel_eclipse_research', ({ gameId }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const pending = game.pendingEclipseResearch;
			if (!pending || pending.playerId !== playerId) return;

			// 자원 롤백
			const player = game.players[playerId];
			player.knowledge = (player.knowledge || 0) + 2;
			player.power3 = (player.power3 || 0) + 3;
			player.power1 = Math.max(0, (player.power1 || 0) - 3);

			// 사용된 액션 인덱스 롤백 (액션 인덱스 2번)
			const shipState = game.spaceships?.[pending.shipTileId];
			if (shipState && shipState.usedActionIndices) {
				shipState.usedActionIndices = shipState.usedActionIndices.filter(idx => idx !== 2);
				shipState.actionsUsed = shipState.usedActionIndices.length;
			}

			// 메인 액션 사용 취소
			game.hasDoneMainAction = false;
			game.pendingEclipseResearch = null;
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		});

		// Eclipse 액션2: 선택한 연구 트랙 1칸 진행 (비용은 이미 use_ship_action에서 차감됨)
		socket.on('eclipse_advance_track', ({ gameId, trackId }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const pending = game.pendingEclipseResearch;
			if (!pending || pending.playerId !== playerId) return;
			const player = game.players[playerId];
			const track = trackId as ResearchTrack;
			const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
			if (!tracks.includes(track) || player.research[track] >= 5) return;
			if (track === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return;
			const newLevel = (player.research[track] ?? 0) + 1;
			if (newLevel === 5 && (countGreenFederations(player) < 1 || isTrackLevel5Taken(game, track, playerId))) return;

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
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
				addGameLog(game, playerId, 'Twilight: Federation benefit', normalReward.label, pending.shipTileId);
				addScore(game, playerId, normalReward.vp, 'other', { source: 'Twilight Federation Benefit' });
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
						addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
						break;
					case 'ship-fed-4vp4k':
						addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
						addScore(game, playerId, 4, 'spaceships', { shipTileId: pending.shipTileId });
						player.knowledge = (player.knowledge || 0) + 4;
						break;
					case 'ship-fed-4vp1q2o':
						addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
						addScore(game, playerId, 4, 'spaceships', { shipTileId: pending.shipTileId });
						grantQic(game, playerId, 1); player.ore = (player.ore || 0) + 2;
						break;
					case 'ship-fed-8vp8c':
						addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
						addScore(game, playerId, 8, 'spaceships', { shipTileId: pending.shipTileId });
						player.credits = (player.credits || 0) + 8;
						break;
					case 'ship-fed-12vp':
						addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
						addScore(game, playerId, 12, 'spaceships', { shipTileId: pending.shipTileId });
						break;
					case 'ship-fed-7vp3p2t':
						addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
						addScore(game, playerId, 7, 'spaceships', { shipTileId: pending.shipTileId });
						player.power3 = (player.power3 || 0) + 2; // [수정] ship-fed-7vp3p2t: 그릇3에 토큰 2개(충전됨)
						break;
					case 'ship-fed-mine-free':
					case 'ship-fed-3tf-mine':
						addGameLog(game, playerId, 'Twilight: Spaceship Fed', `${shipReward.label} (재수령은 즉시 효과만)`, pending.shipTileId);
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
			game.pendingTwilightFederation = null;
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		});

		// Transdim에 가이아 포머 설치
		socket.on('place_gaiaformer', ({ gameId, tileId, qicUsed }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			executePlaceGaiaformer(io, game, playerId, tileId, qicUsed);
		});

		// 하이브(이비츠) 우주정거장 배치: 빈 공간(space/deep_space), 내 건물·우주정거장에서 거리 계산, Nav 범위 밖이면 2거리당 1 QIC. 다른 플레이어 위성 허용, 내 위성 있으면 불가. 라운드당 1회.
		socket.on('place_ivits_space_station', ({ gameId, tileId }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
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
			if (player.gleensNavBonusActive) { baseRange += 2; player.gleensNavBonusActive = false; }
			const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
			const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
			if (player.qic < neededQIC) return;

			saveActionStartState(game, playerId);
			player.qic -= neededQIC;
			tile.spaceStation = { ownerId: playerId };
			player.usedIvitsSpaceStationThisRound = true;
			game.hasDoneMainAction = true;
			addBuildingToFederationIfAdjacent(game, playerId, tileId);
			addGameLog(game, playerId, 'Ivits: Space Station', neededQIC ? `${neededQIC} QIC (range)` : 'Placed (in Nav range)', tileId);
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		});

		// 거리 5 보상 잊혀진 행성: 빈 우주(space/deep_space, 위성 없음)에 특수 광산 1개 배치. O 없음, 광산 보너스/패스/행성유형 포함, 업그레이드 불가.
		socket.on('place_lost_planet', ({ gameId, tileId, qicToSpend }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (game.pendingLostPlanet?.playerId !== playerId) return;

			const player = game.players[playerId];
			const tile = game.map.find(t => t.id === tileId);
			if (!tile) return;
			if (tile.type !== 'space' && tile.type !== 'deep_space') return;
			if (tile.structure != null || tile.spaceStation) return;
			const satellites = game.satellites || {};
			const onTile = Array.isArray(satellites[tileId]) ? satellites[tileId]! : (satellites[tileId] ? [satellites[tileId] as string] : []);
			if (onTile.length > 0) return; // 위성 없는 빈공간만

			const rangeTiles = getPlayerRangeTiles(game, playerId);
			if (rangeTiles.length === 0) return;
			const baseRange = getRange(5) + (player.navigationBonus ?? 0); // Nav 5 = 거리 4, Nav+1 타일이면 navigationBonus 1
			const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
			const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
			const qicSpent = typeof qicToSpend === 'number' ? qicToSpend : 0;
			if (qicSpent !== neededQIC || player.qic < neededQIC) return;
			if (getStructureCount(game, playerId, 'mine') >= BUILDING_LIMITS.mine) return;

			// 다카니안 의회: 잊혀진 행성도 신규 섹터/외각이면 1K 2C. 건물 배치지 변경에는 미적용.
			const hadStructureInThisSectorLP = game.map.some(t => t.id !== tileId && t.ownerId === playerId && t.structure && t.structure !== 'ship' && t.sector === tile.sector);
			const hadStructureInOuterLP = game.map.some(t => t.id !== tileId && t.ownerId === playerId && t.structure && t.structure !== 'ship' && OUTER_SECTORS.includes(t.sector));
			const isNewSectorLP = !hadStructureInThisSectorLP;
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

			// RM8: New Planet Type (RM8)
			const geodensTypesAfterLostPlanet = getPlayerPlanetTypesForGeodens(game, playerId);
			if (geodensTypesAfterLostPlanet.size > geodensTypesBeforeLostPlanet.size) {
				applyRoundMissionScore(game, playerId, 'new_planet_type');
			}

			applyAdvancedTechTileEffect(game, playerId, 'build_mine');
			createPowerOffers(game, tile, playerId);
			addBuildingToFederationIfAdjacent(game, playerId, tileId);
			applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBeforeLostPlanet);
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		});

		socket.on('upgrade_structure', ({ gameId, tileId, target }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;

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
			if (game.pendingTurnEndPlayerId === playerId) return;
			// 현재 턴 플레이어만 자기 턴 시작 스냅샷으로 복구 (다른 소켓/착오 방지)
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
			const startState = game.turnStartState?.[playerId];
			if (!startState) return;
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

				games.set(gameId, restored);

				clampPlayerResources(restored);
				io.to(gameId).emit('game_updated', restored);
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
				io.to(gameId).emit('game_updated', game);
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
				addGameLog(game, playerId, 'Itars PI', '4 tokens → 1 Tech Tile (choose tile + track)');
				clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
				return;
			}
			player.power1 = (player.power1 || 0) + tokensRemaining;
			if (tokensRemaining > 0) addGameLog(game, playerId, 'Itars PI', `${tokensRemaining} tokens → Bowl 1`);
			proceedAfterItarsGaiaformerOrTerran(game);
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		});

		socket.on('advance_tech', ({ gameId, trackId }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;

			executeAdvanceTech(io, game, playerId, trackId);
		});


		socket.on('use_power_action', ({ gameId, actionId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			executeUsePowerAction(io, game, playerId, actionId);
		});

		// 하드쉬 할라 의회 프리 액션: 4C→1QIC, 4C→1K, 3C→1O (Free Action — 크레딧 있으면 반복 사용 가능)
		socket.on('use_hadsch_hallas_pi_action', ({ gameId, actionId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (game.pendingTurnEndPlayerId) return;
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
			const player = game.players[playerId];
			if (player.faction !== 'hadsch_hallas') return;
			const hasPI = game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
			if (!hasPI || !player.hadschHallasPIActions?.length) return;
			const action = player.hadschHallasPIActions.find(a => a.id === actionId);
			if (!action) return;
			if ((player.credits ?? 0) < action.costCredits) return;

			pushFreeActionUndoSnapshot(game);

			player.credits = (player.credits ?? 0) - action.costCredits;
			if (actionId === 'hh-4c-1qic') grantQic(game, playerId, 1);
			else if (actionId === 'hh-4c-1k') player.knowledge = (player.knowledge ?? 0) + 1;
			else if (actionId === 'hh-3c-1o') player.ore = (player.ore ?? 0) + 1;
			else return;
			addGameLog(game, playerId, 'Hadsch Hallas PI', action.label, undefined);
			log(`Player ${player.name} used Hadsch Hallas PI action: ${action.label}`, 'game', undefined, { simulation: (game as any).simulation });
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		});

		// 발타크 프리 액션: 1 포머 → 1 QIC (사용한 포머는 다음 라운드 시작까지 잠김, 가이아 토큰 표기)
		socket.on('use_bal_tak_gaiaformer_to_qic', ({ gameId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			executeBalTakGaiaformerToQic(io, game, playerId);
		});

		socket.on('convert_resource', ({ gameId, type, useBrain }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (game.pendingTurnEndPlayerId) return;

			// Free Action을 수행하기 직전, 게임 상태 스냅샷 저장 (매 단계 저장)
			pushFreeActionUndoSnapshot(game);

			if (executeConvertResource(io, game, playerId, type, useBrain)) {
				// 이미 executeConvertResource에서 clamp 및 emit을 수행함
			}
		});

		socket.on('burn_power', ({ gameId, moveBrainToBowl3 }: { gameId: string; moveBrainToBowl3?: boolean }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (game.pendingTurnEndPlayerId) return;

			pushFreeActionUndoSnapshot(game);

			if (executeBurnPower(game, playerId, moveBrainToBowl3)) {
				clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
			}
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

			try {
				const currentTurnStartState = game.turnStartState ? deepClone(game.turnStartState) : undefined;
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
				(restoredGame as any).freeActionUndoState = undefined;
				// 복구할 스냅샷에서 클라이언트가 보지 말아야 할/유지해야 할 세션 정보 등
				// 통째로 덮어쓰고, Map에 반영.
				games.set(gameId, restoredGame);
				const player = restoredGame.players[playerId];
				log(`Player ${player?.name} undone free actions (${popCount} step)`, 'game', undefined, { simulation: (game as any).simulation });
				addGameLog(restoredGame, playerId, 'Undo Free Action', `Reverted ${popCount} free action step(s)`);
				io.to(gameId).emit('game_updated', restoredGame);
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
			const uncoveredNormal = (player.techTiles || []).filter(
				(id) => !(player.coveredTechTiles || []).includes(id) && !id.startsWith('adv-')
			);
			if (uncoveredNormal.length < 1) return;

			if (trackId != null) {
				// 트랙 4–5 사이 고급 타일
				const advTile = game.advancedTechTilesByTrack?.[trackId];
				if (!advTile || advTile.id !== advancedTileId) return;
				const level = player.research?.[trackId] ?? 0;
				if (level < 4) return;
				game.pendingAdvancedTechCover = { playerId, advancedTileId, trackId };
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
				game.pendingAdvancedTechCover = { playerId, advancedTileId };
			}
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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

			applyAdvancedTileImmediateEffect(game, playerId, pending.advancedTileId);

			addGameLog(game, playerId, 'Advanced Tech Tile', `Covered ${coverTileId} → ${pending.advancedTileId}`);
			game.pendingTechTileSelection = null;
			game.pendingAdvancedTechCover = null;
			game.availableShipTechTileIds = undefined;
			game.pendingAdvancedTechTrackAdvance = { playerId };
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		});

		function applyAdvancedTileImmediateEffect(game: GaiaGameState, playerId: string, tileId: string) {
			const player = game.players[playerId];
			if (!player) return;
			if (tileId === 'adv-imm-1o-sector') {
				const sectors = new Set(game.map.filter(t => t.ownerId === playerId && t.structure).map(t => t.sector));
				player.ore += sectors.size;
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${sectors.size} Ore (1 per sector)`);
			} else if (tileId === 'adv-imm-4vp-ts') {
				const tsCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'trading_station').length;
				addScore(game, playerId, tsCount * 4, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${tsCount * 4} VP (4 per TS)`);
			} else if (tileId === 'adv-imm-2vp-mine') {
				const mineCount = getMineCountForPassAndBonuses(game, playerId);
				addScore(game, playerId, mineCount * 2, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${mineCount * 2} VP (2 per mine)`);
			} else if (tileId === 'adv-imm-2vp-sector') {
				const sectors = new Set(game.map.filter(t => t.ownerId === playerId && t.structure).map(t => t.sector));
				addScore(game, playerId, sectors.size * 2, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${sectors.size * 2} VP (2 per sector)`);
			} else if (tileId === 'adv-imm-4vp-outer') {
				const outerCount = countOuterSectorsOccupied(game, playerId);
				addScore(game, playerId, outerCount * 4, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${outerCount * 4} VP (4 per outer sector)`);
			} else if (tileId === 'adv-imm-6vp-big') {
				const bigCount = game.map.filter(t => t.ownerId === playerId && (t.structure === 'planetary_institute' || t.structure === 'academy')).length;
				addScore(game, playerId, bigCount * 6, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${bigCount * 6} VP (6 per big building)`);
			} else if (tileId === 'adv-imm-2vp-gaia') {
				const gaiaCount = game.map.filter(t => t.ownerId === playerId && t.type === 'gaia').length;
				addScore(game, playerId, gaiaCount * 2, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${gaiaCount * 2} VP (2 per Gaia)`);
			} else if (tileId === 'adv-imm-5vp-fed') {
				const fedCount = getFederationEntries(player).length;
				addScore(game, playerId, fedCount * 5, 'techTiles', { tileId });
				addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${fedCount * 5} VP (5 per federation)`);
			}
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
				const planetTypes = new Set(game.map.filter(t => t.ownerId === playerId && t.type !== 'space').map(t => t.type));
				player.knowledge += planetTypes.size;
			} else if (tileId === 'tech-imm-1o-1q') {
				player.ore += 1;
				grantQic(game, playerId, 1);
			}
			// 고급 타일: 일시불 자원
			else if (tileId === 'adv-imm-1o-sector') {
				const sectors = new Set(game.map.filter(t => t.ownerId === playerId && t.structure).map(t => t.sector));
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
				const sectors = new Set(game.map.filter(t => t.ownerId === playerId && t.structure).map(t => t.sector));
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
				clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		});

		socket.on('use_tech_action', ({ gameId, tileId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
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

			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

			// 팅커로이드 선택이 수익 단계 마지막 단계이므로, 액션 단계로 전환 (내부에서 executeBotTurnIfNeeded 호출)
			helperStartNewRoundTurn(io, game);
		});

		socket.on('use_special_action', ({ gameId, actionId }) => {
			const game = games.get(gameId); if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			executeUseSpecialAction(io, game, playerId, actionId);
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
			// 팅커로이드 선택이 수익 단계 마지막 단계이므로, 여기서 액션 단계로 전환
			helperStartNewRoundTurn(io, game);
		});

		// 엠바스(Ambas): 의회 건설 후 Special — 의회와 광산 위치 교체 (라운드당 1회). 배치지 변경이므로 RM7·다카니안 의회 보너스 미적용.
		socket.on('ambas_swap_pi_mine', ({ gameId, mineTileId }: { gameId: string; mineTileId: string }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const player = game.players[playerId];
			if (game.turnOrder[game.currentPlayerIndex] !== playerId || game.hasDoneMainAction) return;
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
		});

		// 매안(Bescods) Special: 가장 낮은 트랙 중 하나 +1 (라운드당 1회, 비용 없음)
		socket.on('bescods_advance_lowest_track', ({ gameId, trackId }: { gameId: string; trackId: ResearchTrack }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const player = game.players[playerId];
			if (game.turnOrder[game.currentPlayerIndex] !== playerId || game.hasDoneMainAction) return;
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
		});

		// 모웨이드(Moweyip) Special: 의회 보유 시 링 놓기 — 본인 건물 중 링 없는 것 하나에 링 배치 (+2 파워 수신/연방)
		socket.on('moweyip_place_ring', ({ gameId, tileId }: { gameId: string; tileId: string }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const player = game.players[playerId];
			if (game.turnOrder[game.currentPlayerIndex] !== playerId || game.hasDoneMainAction) return;
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
		});

		// 파이락(Firaks) Special: 의회 보유 시 연구소 1개→교역소 다운그레이드 + 아무 트랙 1칸 (라운드당 1회)
		socket.on('firaks_downgrade', ({ gameId, tileId, trackId }: { gameId: string; tileId: string; trackId: ResearchTrack }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			const player = game.players[playerId];
			if (game.turnOrder[game.currentPlayerIndex] !== playerId || game.hasDoneMainAction) return;
			if (player.faction !== 'firaks') return;
			if (player.usedSpecialActions?.includes('firaks-downgrade')) return;
			if (!game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) return;

			const tile = game.map.find(t => t.id === tileId && t.ownerId === playerId && t.structure === 'research_lab');
			if (!tile) return;

			const tracks: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
			if (!tracks.includes(trackId)) return;
			const currentLevel = player.research?.[trackId] ?? 0;
			if (currentLevel >= 5) return;
			if (currentLevel === 4 && isTrackLevel5Taken(game, trackId, playerId)) return;
			if (trackId === 'navigation' && !canBalTakAdvanceNavigation(game, playerId)) return;

			saveActionStartState(game, playerId);
			tile.structure = 'trading_station';
			if (!player.usedSpecialActions) player.usedSpecialActions = [];
			player.usedSpecialActions.push('firaks-downgrade');
			player.research[trackId] = currentLevel + 1;
			const newLevel = player.research[trackId];
			addGameLog(game, playerId, 'Firaks: Downgrade', `Lab→TS, ${trackId} Lv.${newLevel}`, tileId);
			// 다운그레이드로 생긴 교역소도 일반 교역소 건설과 동일 취급: 인접 상대 파워 제공 + 연방 편입 + 교역소 라운드 점수
			createPowerOffers(game, tile, playerId);
			addBuildingToFederationIfAdjacent(game, playerId, tile.id);
			applyRoundMissionScore(game, playerId, 'build_trading_station');
			applyTrackLevelBonus(game, playerId, player, trackId, newLevel);
			applyRoundMissionScore(game, playerId, 'research_track');
			applyAdvancedTechTileEffect(game, playerId, 'research');
			log(`Player ${player.name} (Firaks) downgraded Lab to TS and advanced ${trackId} to Lv.${newLevel}`, 'game', undefined, { simulation: (game as any).simulation });
			game.hasDoneMainAction = true;
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
		});

		// ---------- 연방 구현 ----------
		socket.on('federation_toggle_mode', ({ gameId }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
			if (game.turnOrder[game.currentPlayerIndex] !== playerId) return;
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
				game.federationMode = { playerId, selectedHexIds: [], selectedPlanetIds: [], selectedSpaceStationHexIds: [] };
				game.federationPreview = computeFederationPreview(game, playerId);
			}
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
					// 하이브 2회째 이후: 새 빈칸은 기존 연방 또는 현재 선택과 인접해야 함
					const player = game.players[playerId];
					const fedHexes = game.playerFederationHexes?.[playerId] ?? [];
					if (player.faction === 'ivits' && fedHexes.length > 0) {
						const neighbors = getNeighbors(game.map, tile).map(n => n.id);
						const allowed = [...game.federationMode.selectedHexIds, ...(game.federationMode.selectedPlanetIds ?? []), ...(game.federationMode.selectedSpaceStationHexIds ?? []), ...fedHexes];
						if (!neighbors.some(id => allowed.includes(id))) return;
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
					const component = getPlanetConnectedComponent(game, playerId, tileId);
					const power = getFederationBuildingPower(game, playerId, component);
					const requiredPower = getFederationRequiredPower(game, playerId);
					if (power >= requiredPower) {
						game.federationMode = null;
						game.federationPreview = null;
						game.pendingFederationReward = { playerId, selectedHexIds: [], spentTokens: 0 };
					}
				}
			}
			game.federationPreview = computeFederationPreview(game, playerId);
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
		});

		socket.on('federation_complete', ({ gameId }) => {
			const game = games.get(gameId); if (!game) return;
			if (game.currentPhase !== 'main') return;
			const playerId = socketToPlayerMap.get(socket.id); if (!playerId) return;
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
				const totalPower = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);
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
			const unitLabel = isIvits ? '우주정거장' : '위성';
			addGameLog(game, playerId, 'Federation', `Formed federation (${numEmpty} ${unitLabel}, ${power} power${isIvits ? ', QIC cost' : ''})`);
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
				addGameLog(game, playerId, 'Federation', `Took reward: ${rewardLabel}`);
			} else {
				const reward = FEDERATION_REWARDS.find(r => r.id === rewardId);
				if (!reward) return;
				rewardLabel = reward.label;
				addGameLog(game, playerId, 'Federation', `Took reward: ${rewardLabel}`);
				addScore(game, playerId, reward.vp, 'other', { source: '연방 ' + rewardLabel });
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
			player.federations.push({ rewardId, isGreen: true });

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
						addScore(game, playerId, 4, 'spaceships', { shipTileId: spaceshipBreakdownId });
						player.knowledge = (player.knowledge || 0) + 4;
						break;
					case 'ship-fed-4vp1q2o':
						addScore(game, playerId, 4, 'spaceships', { shipTileId: spaceshipBreakdownId });
						grantQic(game, playerId, 1);
						player.ore = (player.ore || 0) + 2;
						break;
					case 'ship-fed-8vp8c':
						addScore(game, playerId, 8, 'spaceships', { shipTileId: spaceshipBreakdownId });
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
						addScore(game, playerId, 12, 'spaceships', { shipTileId: spaceshipBreakdownId });
						break;
					case 'ship-fed-7vp3p2t':
						addScore(game, playerId, 7, 'spaceships', { shipTileId: spaceshipBreakdownId });
						player.power3 = (player.power3 || 0) + 2; // [수정] ship-fed-7vp3p2t: 그릇3에 토큰 2개(충전됨)
						break;
					default:
						break;
				}
			}

			game.hasDoneMainAction = true;
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
			if (!game.hasDoneMainAction) {
				socket.emit('game_error', { message: '메인 액션을 수행하지 않아 턴을 종료할 수 없습니다.' });
				return;
			}

			const endingPlayerId = game.turnOrder[game.currentPlayerIndex];
			const manualOfferCount = activateQueuedPowerOffersForPlayer(game as ServerGameState, endingPlayerId);
			if (manualOfferCount > 0) {
				game.pendingTurnEndPlayerId = endingPlayerId;
				clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
			const p2 = player.power2 ?? 0;
			if (p2 < totalCost) {
				io.to(gameId).emit('game_error', { message: 'Not enough tokens in bowl 2.' });
				return;
			}
			player.power2 = p2 - totalCost;
			grantQic(game, playerId, qic);
			player.knowledge = (player.knowledge ?? 0) + knowledge;
			player.ore = (player.ore ?? 0) + ore;
			player.credits = (player.credits ?? 0) + credits;
			addGameLog(game, playerId, 'Terran Council', `${pending.tokenCount} tokens → +${qic}Q +${knowledge}K +${ore}O +${credits}C`);
			game.pendingTerranCouncilBenefit = null;
			const queue = game.terranCouncilQueue ?? [];
			if (queue.length > 0) {
				game.pendingTerranCouncilBenefit = queue[0];
				game.terranCouncilQueue = queue.slice(1);
			} else {
				game.terranCouncilQueue = [];
				finishAfterGaiaformerPhase(game);
			}
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);

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

				if (offer.vpCost > (targetPlayer.score || 0)) continue; // VP 부족 시 스킵
				offer.responded = true;
				addScore(game, offer.targetPlayerId, -offer.vpCost, 'powerReceived');
				// 파워 수령 로직 통일: 타클론 브레인/PI 보너스 포함
				applyPlayerPowerCharge(game, offer.targetPlayerId, offer.amount, { brainFirst: true });
				const sourcePlayer = game.players[offer.sourcePlayerId];
				addGameLog(game, offer.targetPlayerId, 'Received Power', `+${offer.amount}P from ${sourcePlayer?.name} (-${offer.vpCost}VP)`, offer.tileId);
			}
			game.pendingPowerOffers = game.pendingPowerOffers.filter(o => !o.responded);
			if (game.pendingPowerOffers.length === 0) game.pendingPowerOffers = [];
			if (game.pendingTurnEndPlayerId) {
				const endingPlayerId = game.pendingTurnEndPlayerId;
				finalizeTurnEnd(io, game as ServerGameState, endingPlayerId, { triggerBot: true, reason: 'power_offers_done' });
				return;
			}
			clampPlayerResources(game); io.to(gameId).emit('game_updated', game);

			executeBotTurnIfNeeded(io, game as ServerGameState).catch(err => {
				log(`Bot turn execution error (accept_all_power_offers): ${err}`, 'error');
			});
		});

		socket.on('pass_round', ({ gameId, newBonusTileId }) => {
			const game = games.get(gameId);
			if (!game) return;
			const playerId = socketToPlayerMap.get(socket.id);
			if (!playerId) return;

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
					games.set(gameId, restored);
					clampPlayerResources(restored);
					io.to(gameId).emit('game_updated', restored);
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
					io.to(gameId).emit('game_updated', game);
				}
			} else {
				game.pendingTwilightFederation = null;
				clampPlayerResources(game);
				io.to(gameId).emit('game_updated', game);
			}
		});




		socket.on('disconnect', () => {
			const playerId = socketToPlayerMap.get(socket.id);
			if (playerId) {
				const gameId = playerGameMap.get(playerId);
				if (gameId) {
					const game = games.get(gameId);
					if (game && game.players[playerId]) {
						log(`Player ${game.players[playerId].name} disconnected`, 'game', undefined, { simulation: (game as any).simulation });
					}
				}
				socketToPlayerMap.delete(socket.id);
			}
			const spectatorId = socketToSpectatorMap.get(socket.id);
			if (spectatorId) {
				spectatorToGameMap.delete(spectatorId);
				socketToSpectatorMap.delete(socket.id);
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

	let alreadyLogged = false;

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
		game.shipTechPool[techTileId]--;

		if (!player.techTiles.includes(techTileId)) player.techTiles.push(techTileId);
		if (techTileId === 'ship-tech-nav+1') {
			player.navigationBonus = (player.navigationBonus || 0) + 1;
			addGameLog(game, playerId, 'Ship Tech: Nav+1', 'Permanent +1 range');
		} else if (techTileId === 'ship-tech-1o3k') {
			player.ore += 1;
			player.knowledge += 3;
			addGameLog(game, playerId, 'Ship Tech: 1O 3K', '+1 Ore, +3 Knowledge');
		} else if (techTileId === 'ship-tech-2tf-mine') {
			player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 2;
			player.nextMineFreeFromShipTech = true;
			addGameLog(game, playerId, 'Ship Tech: 2TF+Mine', '2 terraform steps, next mine free');
		}
		game.pendingTechTileSelection = null;
		game.availableShipTechTileIds = undefined;
		if (techTileId === 'ship-tech-2tf-mine') {
			// 광산 건설부터 우선 수행
			game.pendingShipTechMine = { playerId };
		} else {
			game.pendingShipTechTrackAdvance = { playerId };
		}
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
			if (greenNeeded > 0 && countGreenFederations(player) < greenNeeded) return;
			for (let i = 0; i < greenNeeded; i++) spendGreenFederation(player);
			if (canAdvance) {
				player.research[track]++;
				const levelNow = player.research[track];
				const tileLabel = techTile.label || techTileId;
				if (isRebellionGainTrack) {
					addGameLog(game, playerId, 'Rebellion: Gained Tech Tile', `${tileLabel}, ${track} → Lv.${levelNow}`);
					log(`Player ${player.name} (Rebellion) gained tech tile ${tileLabel} and advanced ${track} to level ${levelNow}`, 'game', undefined, { simulation: (game as any).simulation });
				} else {
					addGameLog(game, playerId, 'Gained Tech Tile', `${tileLabel} and advanced ${track} to L${levelNow}`);
					log(`Player ${player.name} gained tech tile ${tileLabel} and advanced ${track} track to level ${newLevel}`, 'game', undefined, { simulation: (game as any).simulation });
				}
				alreadyLogged = true;
				applyTrackLevelBonus(game, playerId, player, track, levelNow);
				applyRoundMissionScore(game, playerId, 'research_track');
			} else if (isLevel5Advance) {
				const reason = level5Blocked ? 'L5 already occupied' : !canSpendLevel5Fed ? 'no green federation' : 'stayed at L4';
				addGameLog(game, playerId, 'Gained Tech Tile', `${techTile.label || techTileId} (${track} stays L4: ${reason})`);
				alreadyLogged = true;
			} else if (isRebellionGainTrack) {
				addGameLog(game, playerId, 'Rebellion: Gained Tech Tile', techTileId);
			}
			if (!player.techTiles.includes(techTileId)) player.techTiles.push(techTileId);
			(game.techTilesByTrack[track] as (typeof tiles[0] | null)[])[idx] = null;
		}
	} else {
		const isRebellionGain = game.pendingTechTileSelection.structureType === 'rebellion_gain';
		const hasTrackId = trackId != null && String(trackId).trim() !== '';
		if (!hasTrackId && !isRebellionGain) {
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
		const greenNeededPool = (isAdvancedPool ? 1 : 0) + (newLevelPool === 5 ? 1 : 0);
		if (greenNeededPool > 0 && countGreenFederations(player) < greenNeededPool) return;
		for (let i = 0; i < greenNeededPool; i++) spendGreenFederation(player);
		if (canAdvancePool && selectedTrack) {
			player.research[selectedTrack]++;
			const newLevel = player.research[selectedTrack];
			if (isRebellionGain) {
				addGameLog(game, playerId, 'Rebellion: Gained Tech Tile', `${techTile.label || techTileId} from pool, ${selectedTrack} → Lv.${newLevel}`);
				log(`Player ${player.name} (Rebellion) gained tech tile ${techTile.label || techTileId} from pool and advanced ${selectedTrack} to level ${newLevel}`, 'game', undefined, { simulation: (game as any).simulation });
			} else {
				addGameLog(game, playerId, 'Gained Tech Tile', `${techTile.label || techTileId} from pool and advanced ${selectedTrack} to L${newLevel}`);
				log(`Player ${player.name} gained tech tile ${techTile.label || techTileId} from pool and advanced ${selectedTrack} track to level ${newLevel}`, 'game', undefined, { simulation: (game as any).simulation });
			}
			alreadyLogged = true;
			applyTrackLevelBonus(game, playerId, player, selectedTrack, newLevel);
			applyRoundMissionScore(game, playerId, 'research_track');
			applyAdvancedTechTileEffect(game, playerId, 'research'); // 기술 타일 획득 시 전진에 따른 고급 기술 보너스 누락 해결
		} else if (isLevel5AdvancePool && selectedTrack) {
			const reason = level5BlockedPool ? 'L5 already occupied' : !canSpendLevel5FedPool ? 'no green federation' : 'stayed at L4';
			addGameLog(game, playerId, 'Gained Tech Tile', `${techTile.label || techTileId} from pool (${selectedTrack} stays L4: ${reason})`);
			alreadyLogged = true;
		} else if (isRebellionGain && !selectedTrack) {
			addGameLog(game, playerId, 'Rebellion: Gained Tech Tile', techTileId);
		}

		// 풀에서 해당 칸이 존재하는지 확인
		const poolIndex = game.techTilesPool.findIndex(t => t && t.id === techTileId);
		if (poolIndex === -1 && !isRebellionGain) {
			log(`Player ${player.name} selected pool tile ${techTileId} but it's not available in pool.`, 'game', undefined, { simulation: (game as any).simulation });
			return;
		}

		if (!player.techTiles.includes(techTileId)) player.techTiles.push(techTileId);
		// 풀에서 해당 칸만 빈 칸으로 표시 (splice로 당기지 않음)
		if (poolIndex !== -1) (game.techTilesPool as (typeof game.techTilesPool[0] | null)[])[poolIndex] = null;
	}

	// 즉시 효과 처리
	if (techTileId === 'tech-imm-7vp') {
		addScore(game, playerId, 7, 'techTiles', { tileId: techTileId });
		addGameLog(game, playerId, 'Gained Tech Tile', 'tech-imm-7vp: +7 VP');
		log(`Player ${player.name} gained 7 VP from tech tile`, 'game', undefined, { simulation: (game as any).simulation });
	} else if (techTileId === 'tech-imm-1o-1q') {
		player.ore = (player.ore || 0) + 1;
		grantQic(game, playerId, 1);
		addGameLog(game, playerId, 'Gained Tech Tile', 'tech-imm-1o-1q: +1 Ore, +1 QIC');
		log(`Player ${player.name} gained 1 Ore and 1 QIC from tech tile (Ore: ${player.ore}, QIC: ${player.qic})`, 'game', undefined, { simulation: (game as any).simulation });
	} else if (techTileId === 'tech-imm-1k-planet') {
		const playerStructures = game.map.filter(t => t.ownerId === playerId);
		const planetTypes = new Set(
			playerStructures
				.filter(t => t.type !== 'space' && t.type !== 'deep_space')
				.map(t => t.type)
		);
		player.knowledge += planetTypes.size;
		addGameLog(game, playerId, 'Gained Tech Tile', `tech-imm-1k-planet: +${planetTypes.size} Knowledge`);
		log(`Player ${player.name} gained ${planetTypes.size} Knowledge from tech tile (${planetTypes.size} planet types)`, 'game', undefined, { simulation: (game as any).simulation });
	} else if (!alreadyLogged) {
		addGameLog(game, playerId, 'Gained Tech Tile', techTile.label || techTileId);
	}

	// 아이타 의회: 기술 타일 선택 후 남은 가이아포머 토큰 처리 (4개 이상이면 다시 묻기, 아니면 1그릇 복귀 후 진행)
	if (game.pendingTechTileSelection.structureType === 'itars_pi_exchange') {
		const remaining = game.itarsGaiaformerRemainingAfterTech ?? 0;
		game.itarsGaiaformerRemainingAfterTech = undefined;
		if (remaining >= 4) {
			game.pendingItarsGaiaformerExchange = { playerId, tokensRemaining: remaining };
		} else {
			player.power1 = (player.power1 || 0) + remaining;
			if (remaining > 0) addGameLog(game, playerId, 'Itars PI', `${remaining} tokens → Bowl 1`);
			helperProceedAfterItarsGaiaformerOrTerran(io, game);
		}
	}

	game.pendingTechTileSelection = null;
	game.availableShipTechTileIds = undefined;
	clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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

	if (trackId != null) {
		const advTile = game.advancedTechTilesByTrack?.[trackId];
		if (!advTile || advTile.id !== advancedTileId) return false;
		const level = player.research?.[trackId] ?? 0;
		if (level < 4) return false;
		game.pendingAdvancedTechCover = { playerId, advancedTileId, trackId };
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
		game.pendingAdvancedTechCover = { playerId, advancedTileId };
	}
	clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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

	// socket handler 내부의 applyAdvancedTileImmediateEffect를 여기서도 동일하게 적용
	(() => {
		const tileId = pending.advancedTileId;
		if (tileId === 'adv-imm-1o-sector') {
			const sectors = new Set(game.map.filter(t => t.ownerId === playerId && t.structure).map(t => t.sector));
			player.ore = (player.ore ?? 0) + sectors.size;
			addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${sectors.size} Ore (1 per sector)`);
		} else if (tileId === 'adv-imm-4vp-ts') {
			const tsCount = game.map.filter(t => t.ownerId === playerId && t.structure === 'trading_station').length;
			addScore(game, playerId, tsCount * 4, 'techTiles', { tileId });
			addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${tsCount * 4} VP (4 per TS)`);
		} else if (tileId === 'adv-imm-2vp-mine') {
			const mineCount = getMineCountForPassAndBonuses(game, playerId);
			addScore(game, playerId, mineCount * 2, 'techTiles', { tileId });
			addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${mineCount * 2} VP (2 per mine)`);
		} else if (tileId === 'adv-imm-2vp-sector') {
			const sectors = new Set(game.map.filter(t => t.ownerId === playerId && t.structure).map(t => t.sector));
			addScore(game, playerId, sectors.size * 2, 'techTiles', { tileId });
			addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${sectors.size * 2} VP (2 per sector)`);
		} else if (tileId === 'adv-imm-4vp-outer') {
			const outerCount = countOuterSectorsOccupied(game, playerId);
			addScore(game, playerId, outerCount * 4, 'techTiles', { tileId });
			addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${outerCount * 4} VP (4 per outer sector)`);
		} else if (tileId === 'adv-imm-6vp-big') {
			const bigCount = game.map.filter(t => t.ownerId === playerId && (t.structure === 'planetary_institute' || t.structure === 'academy')).length;
			addScore(game, playerId, bigCount * 6, 'techTiles', { tileId });
			addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${bigCount * 6} VP (6 per big building)`);
		} else if (tileId === 'adv-imm-2vp-gaia') {
			const gaiaCount = game.map.filter(t => t.ownerId === playerId && t.type === 'gaia').length;
			addScore(game, playerId, gaiaCount * 2, 'techTiles', { tileId });
			addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${gaiaCount * 2} VP (2 per Gaia)`);
		} else if (tileId === 'adv-imm-5vp-fed') {
			const fedCount = getFederationEntries(player).length;
			addScore(game, playerId, fedCount * 5, 'techTiles', { tileId });
			addGameLog(game, playerId, 'Tech Tile Effect', `Gained ${fedCount * 5} VP (5 per federation)`);
		}
	})();
	addGameLog(game, playerId, 'Advanced Tech Tile', `Covered ${coverTileId} → ${pending.advancedTileId}`);
	game.pendingTechTileSelection = null;
	game.pendingAdvancedTechCover = null;
	game.availableShipTechTileIds = undefined;
	game.pendingAdvancedTechTrackAdvance = { playerId };
	clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
	if (game.hasDoneMainAction && !isTerraformingPowerActionBuild && !isPendingGaiaBuild && !isPendingSpaceshipFedMine) {
		debugLog(game, `executeBuildMine failed: Player ${playerId} has already done a main action`, 'error');
		return false;
	}

	if (game.currentPhase !== 'main') {
		debugLog(game, `executeBuildMine failed: Current phase is ${game.currentPhase}, expected 'main'`, 'error');
		return false;
	}

	// Note: playerId is passed as argument, so we check if it matches current player
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) {
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
		if (unbuildable.includes(tile.type) || tile.structure !== null) {
			debugLog(game, `executeBuildMine failed (Spaceship Fed): Tile ${tileId} is unbuildable (${tile.type}) or has structure (${tile.structure})`, 'error');
			return false;
		}
		if (tile.type === 'asteroid') {
			debugLog(game, `executeBuildMine failed (Spaceship Fed): Cannot build on asteroid directly`, 'error');
			return false;
		}
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
			addGameLog(game, playerId, 'Gaiaformer Returned', 'Moved back to faction board', tileId);
		}

		addGameLog(game, playerId, 'Spaceship Fed', 'Mine 1 free (no Nav)', tileId);
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
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
		let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
		if (player.tempRangeBonus) { baseRange += 3; player.tempRangeBonus = false; }
		if (player.rangeBonusActive) { baseRange += 3; player.rangeBonusActive = false; }
		if (player.gleensNavBonusActive) { baseRange += 2; player.gleensNavBonusActive = false; }
		const minDist = Math.min(...playerTiles.map(t => getDistance(t, tile)));
		const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
		if ((player.qic ?? 0) < neededQIC) {
			debugLog(game, `executeBuildMine failed (Lantida): Insufficient QIC (QIC: ${player.qic}/${neededQIC}, Dist: ${minDist}, Range: ${baseRange})`, 'error');
			return false;
		}
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
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
			io.to(game.id).emit('game_error', errorMsg);
			return false;
		}
		const geodensTypesBeforeAsteroid = getPlayerPlanetTypesForGeodens(game, playerId);
		const rm7QualifyAsteroid = qualifiesForNewSectorRoundMission(game, playerId, tileId);
		tile.structure = 'mine';
		tile.ownerId = playerId;
		tile.destroyedGaiaformer = true; // 가이아포머 파괴 상태 저장
		// 소행성 광산 건설 시 가이아포머 1개 파괴
		player.gaiaformers = Math.max(0, (player.gaiaformers ?? 0) - 1);
		player.destroyedGaiaformers = (player.destroyedGaiaformers ?? 0) + 1;
		addGameLog(game, playerId, 'Built Mine on Asteroid', `Free (Used 1 Gaiaformer, ${player.gaiaformers} remaining)`, tileId);
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
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		return true;
	}

	// Standard Build
	let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
	if (player.tempRangeBonus) { baseRange += 3; player.tempRangeBonus = false; }
	if (player.rangeBonusActive) { baseRange += 3; player.rangeBonusActive = false; }
	if (player.gleensNavBonusActive) { baseRange += 2; player.gleensNavBonusActive = false; }
	const rangeTiles = getPlayerRangeTiles(game, playerId);
	if (rangeTiles.length === 0) {
		debugLog(game, `executeBuildMine failed (Standard): No starting tiles for range calculation`, 'error');
		return false;
	}

	const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
	let neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;

	// 가이아포머가 이미 설치된 행성에 광산을 지을 때는 거리 비용(QIC) 차감 안함 (배치 시 지불 완료)
	if ((tile.type === 'transdim' || tile.type === 'gaia') && player.pendingGaiaformerTiles?.includes(tileId)) {
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

	// (이미 위에서 체크함)
	const geodensTypesBefore = getPlayerPlanetTypesForGeodens(game, playerId);
	const hadStructureInThisSector = game.map.some(t => t.id !== tileId && t.ownerId === playerId && t.structure && t.structure !== 'ship' && t.sector === tile.sector);
	const hadStructureInOuter = game.map.some(t => t.id !== tileId && t.ownerId === playerId && t.structure && t.structure !== 'ship' && OUTER_SECTORS.includes(t.sector));
	const isNewSector = !hadStructureInThisSector;
	const isNewOuterSector = OUTER_SECTORS.includes(tile.sector) && !hadStructureInOuter;
	const darkaniansPiNewSectorBonus = player.faction === 'darkanians' && game.map.some(t => t.ownerId === playerId && t.structure === 'planetary_institute') && (isNewSector || isNewOuterSector);
	const rm7QualifyMine = qualifiesForNewSectorRoundMission(game, playerId, tileId);

	tile.structure = 'mine'; tile.ownerId = playerId;

	if (tile.hasGaiaformer && player.pendingGaiaformerTiles?.includes(tileId)) {
		tile.hasGaiaformer = false;
		tile.gaiaformerOwnerId = undefined;
		player.gaiaformers = (player.gaiaformers ?? 0) + 1;
		player.pendingGaiaformerTiles = player.pendingGaiaformerTiles.filter(id => id !== tileId);
		addGameLog(game, playerId, 'Gaiaformer Returned', 'Moved back to faction board', tileId);
	}

	if (darkaniansPiNewSectorBonus) {
		player.knowledge = (player.knowledge ?? 0) + 1;
		player.credits = (player.credits ?? 0) + 2;
		addGameLog(game, playerId, 'Darkanians PI', 'New sector / new outer sector: +1K, +2C', tileId);
	}

	if (tile.type === 'proto') {
		addScore(game, playerId, 6, 'other', { source: 'Proto Planet' });
		addGameLog(game, playerId, 'Built Mine on Proto', `+6 VP (3 terraforming required)`, tileId);
	}

	if (tile.type === 'gaia' && player.techTiles.includes('tech-gaia-3vp')) {
		addScore(game, playerId, 3, 'techTiles', { tileId: 'tech-gaia-3vp' });
		addGameLog(game, playerId, 'Tech Tile Bonus', `Gaia Planet: +3 VP`, tileId);
	}
	if (tile.type === 'gaia' && player.faction === 'gleens') {
		addScore(game, playerId, 2, 'other', { source: 'Gleens Gaia Bonus', noLog: true });
		addGameLog(game, playerId, 'Gleens: Gaia building', '+2 VP', tileId);
	}

	let totalQicLog = neededQIC;
	if (tile.type === 'gaia' && player.faction !== 'gleens' && !player.pendingGaiaformerTiles?.includes(tileId)) {
		// 가이아 행성 기본 비용 반영 (글린스는 광석 소모). 단, 가이아포머로 포밍한 경우는 비용 면제됨.
		totalQicLog += getGaiaBaseQic(player.faction || '');
	}
	const costDetails = `1O, 2C${totalQicLog > 0 ? `, ${totalQicLog}QIC` : ''}${terraformCost > 0 ? `, ${terraformCost}O terraform` : ''}`;
	addGameLog(game, playerId, 'Built Mine', `on ${tile.type} (${costDetails})`, tileId);

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
	if (neededQIC > 0) {
		applyAdvancedTechTileEffect(game, playerId, 'qic_action');
	}

	createPowerOffers(game, tile, playerId);
	addBuildingToFederationIfAdjacent(game, playerId, tileId);
	applyGeodensNewPlanetTypeBonus(game, playerId, geodensTypesBefore);

	clearFreeMineFlags();
	game.hasDoneMainAction = true;
	clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		return true;
	} else if (tile.structure === 'trading_station' && target === 'research_lab') {
		if (getStructureCount(game, playerId, 'research_lab') >= BUILDING_LIMITS.research_lab) return false;
		if ((player.ore ?? 0) < 3 || (player.credits ?? 0) < 5) return false;
		player.ore = (player.ore ?? 0) - 3; player.credits = (player.credits ?? 0) - 5; tile.structure = 'research_lab'; game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Upgraded to Research Lab', '3O, 5C', tileId);
		applyRoundMissionScore(game, playerId, 'build_research_lab');
		createPowerOffers(game, tile, playerId);
		addBuildingToFederationIfAdjacent(game, playerId, tileId);
		game.pendingTechTileSelection = { playerId, tileId, structureType: 'research_lab' };
		game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		return true;
	} else if (tile.structure === 'research_lab' && target === 'planetary_institute' && player.faction === 'bescods') {
		if (getStructureCount(game, playerId, 'planetary_institute') >= BUILDING_LIMITS.planetary_institute) return false;
		if ((player.ore ?? 0) < 4 || (player.credits ?? 0) < 6) return false;
		player.ore = (player.ore ?? 0) - 4; player.credits = (player.credits ?? 0) - 6; tile.structure = 'planetary_institute'; game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Upgraded to Planetary Institute (Bescods/매안)', '4O, 6C', tileId);
		applyRoundMissionScore(game, playerId, 'build_big_building');
		createPowerOffers(game, tile, playerId);
		addBuildingToFederationIfAdjacent(game, playerId, tileId);
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
		addGameLog(game, playerId, 'Upgraded to Academy', target === 'academy_left' ? '6O, 6C (2K 수익)' : '6O, 6C (1QIC 액션)', tileId);
		applyRoundMissionScore(game, playerId, 'build_big_building');
		createPowerOffers(game, tile, playerId);
		addBuildingToFederationIfAdjacent(game, playerId, tileId);
		game.pendingTechTileSelection = { playerId, tileId, structureType: 'academy' };
		game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		return true;
	}

	return false;
}

/** 모웨이드/팅커로이드 확장 행성 — 종족 확정 후 호출 */
function applyMoweyipTinkeroidsExpansionPlanets(game: ServerGameState): void {
	const playerList = Object.values(game.players);
	const moweyipPlayer = playerList.find(p => p.faction === 'moweyip');
	const tinkeroidsPlayer = playerList.find(p => p.faction === 'tinkeroids');
	if (moweyipPlayer) {
		const otherHomes = playerList
			.filter(p => p.faction && p.faction !== 'moweyip')
			.map(p => FACTIONS.find(f => f.id === p.faction)?.homePlanet)
			.filter((h): h is import('@shared/gameConfig').PlanetType => h != null && HOME_PLANETS.includes(h));
		game.moweyipThreeStepPlanets = computeExpansionThreeStepPlanets(otherHomes);
		log(`Moweyip expansion: 3-step planets = ${game.moweyipThreeStepPlanets.join(', ')}`, 'game', undefined, { simulation: (game as any).simulation });
	}
	if (tinkeroidsPlayer) {
		const otherHomes = playerList
			.filter(p => p.faction && p.faction !== 'tinkeroids')
			.map(p => FACTIONS.find(f => f.id === p.faction)?.homePlanet)
			.filter((h): h is import('@shared/gameConfig').PlanetType => h != null && HOME_PLANETS.includes(h));
		game.tinkeroidsThreeStepPlanets = computeExpansionThreeStepPlanets(otherHomes);
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
	clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

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
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
		return `지금은 다른 플레이어의 차례입니다.`;
	}

	if (player.startingMinesPlaced >= maxStartingMines) return '이미 시작 건물을 모두 배치했습니다.';

	const tile = game.map.find(t => t.id === tileId);
	if (!tile || tile.structure !== null) return '해당 타일에 배치할 수 없습니다.';

	if (tile.type !== faction.homePlanet) return `${faction.name}은(는) ${faction.homePlanet} 행성에만 배치할 수 있습니다.`;

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

	clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

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
		game.currentPlayerIndex = 0;
		game.pendingBonusSelection = null;
		for (const pid of Object.keys(game.players)) ensureScoreBreakdown(game.players[pid]);

		const firstPlayerId = game.turnOrder[0];
		if (firstPlayerId) {
			if (!game.turnStartState) game.turnStartState = {};
			game.turnStartState[firstPlayerId] = buildTurnStartStateEntryForPlayer(game as ServerGameState, firstPlayerId);
		}

		helperTriggerIncomePhase(io, game);
	} else {
		game.pendingBonusSelection = game.turnOrder[game.currentPlayerIndex];
	}

	clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

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
function isTrackLevel5Taken(game: ServerGameState, track: ResearchTrack, excludePlayerId: string): boolean {
	return Object.entries(game.players).some(([pid, p]) => pid !== excludePlayerId && (p.research?.[track] ?? 0) >= 5);
}

export function executeAdvanceTech(
	io: SocketIOServer,
	game: ServerGameState,
	playerId: string,
	trackId: ResearchTrack
): boolean {
	if (!game || game.currentPhase !== 'main') return false;

	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;

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
		addGameLog(game, playerId, 'Ship Tech: Advanced track', `${track} → Lv.${newLevel}`);
		applyTrackLevelBonus(game, playerId, player, track, newLevel);
		applyRoundMissionScore(game, playerId, 'research_track');
		game.hasDoneMainAction = true;

		// 2TF+Mine 관련 순서 조정을 위해 기존 로직 제거 (이제 광산 건설 완료 시 트랙 전진이 트리거됨)

		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
		addGameLog(game, playerId, 'Advanced Tech: Advanced track', `${track} → Lv.${newLevel}`);
		applyTrackLevelBonus(game, playerId, player, track, newLevel);
		applyRoundMissionScore(game, playerId, 'research_track');
		game.hasDoneMainAction = true;
		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
	applyTrackLevelBonus(game, playerId, player, track, newLevel);
	log(`Player ${player.name} advanced ${track} to Lv.${newLevel}: knowledge ${knowledgeBefore} → ${player.knowledge} (-4)`, 'game', undefined, { simulation: (game as any).simulation });
	addGameLog(game, playerId, 'Advanced Research', `${track} to level ${newLevel} (4K)`);
	applyRoundMissionScore(game, playerId, 'research_track');
	applyAdvancedTechTileEffect(game, playerId, 'research');
	game.hasDoneMainAction = true;
	clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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

	if (game.currentPhase !== 'main') return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;
	if (game.hasDoneMainAction) {
		return false;
	}

	const player = game.players[playerId];
	if (!player) return false;

	// 6라운드 처리
	if (game.roundNumber === 6) {
		if (player.bonusTile) {
			const currentBonusTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
			if (currentBonusTile?.passBonus) {
				const playerStructures = game.map.filter(t => t.ownerId === playerId);
				let count = 0;

				switch (currentBonusTile.passBonus.type) {
					case 'big_building':
						count = playerStructures.filter(t =>
							t.structure === 'academy' || t.structure === 'planetary_institute'
						).length;
						break;
					case 'mine':
						count = getMineCountForPassAndBonuses(game, playerId);
						break;
					case 'trading_station':
						count = playerStructures.filter(t => t.structure === 'trading_station').length;
						break;
					case 'research_lab':
						count = playerStructures.filter(t => t.structure === 'research_lab').length;
						break;
					case 'gaiaformer':
						count = 0;
						break;
					case 'planet_type': {
						const planetTypes = new Set(
							playerStructures
								.filter(t => t.type !== 'space' && t.type !== 'deep_space')
								.map(t => t.type)
						);
						if (player.virtualMineAsteroid) planetTypes.add('asteroid');
						if (player.virtualMineProto) planetTypes.add('proto');
						if (playerStructures.some(t => t.structure === 'lost_planet_mine')) planetTypes.add('lost_planet');
						count = planetTypes.size;
						break;
					}
					case 'gaia':
						count = playerStructures.filter(t => t.type === 'gaia').length;
						break;
					case 'bridge_sector':
						const bridgeSectors = new Set(
							playerStructures
								.filter(t => t.sector >= 11 && t.sector <= 18)
								.map(t => t.sector)
						);
						count = bridgeSectors.size;
						break;
				}

				const vpGained = count * currentBonusTile.passBonus.vp;
				addScore(game, playerId, vpGained, 'bonusTilePass', { round: 6 });
				const logMsg = `Gained ${vpGained} VP from pass bonus (${count} x ${currentBonusTile.passBonus.vp} for ${currentBonusTile.passBonus.type})`;
				addGameLog(game, playerId, 'Pass (Round 6)', logMsg);
				log(`Player ${player.name} ${logMsg}`, 'game', undefined, { simulation: (game as any).simulation });
			}
		}

		applyAdvancedTechTilePassEffect(game, playerId);

		player.hasPassed = true;
		if (!game.passingOrder.includes(playerId)) {
			game.passingOrder.push(playerId);
		}
		game.hasDoneMainAction = false;

		// Check if all passed
		if (Object.values(game.players).every(p => p.hasPassed)) {
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
			// 남은 자원 (O, C, QIC, K) 합 3당 1 VP
			for (const pid of Object.keys(game.players)) {
				const p = game.players[pid];
				if (!p) continue;
				const sum = (p.ore ?? 0) + (p.credits ?? 0) + (p.qic ?? 0) + (p.knowledge ?? 0);
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
			saveFinalGameState(game);
			flushGameData(game);
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
			return true;
		}

		// Next player
		if (game.turnStartState) delete game.turnStartState[playerId];
		game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
		while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed) {
			game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
			if (Object.values(game.players).every(p => p.hasPassed)) break;
		}

		// 다음 플레이어 지정을 위한 스냅샷 저장
		const nextId = game.turnOrder[game.currentPlayerIndex];
		if (nextId && !game.players[nextId].hasPassed) {
			if (!game.turnStartState) game.turnStartState = {};
			game.turnStartState[nextId] = buildTurnStartStateEntryForPlayer(game as ServerGameState, nextId);
		}

		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

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

		// Calculate pass bonus
		if (player.bonusTile) {
			const currentBonusTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
			let vpGained = 0;
			if (currentBonusTile?.passBonus) {
				const playerStructures = game.map.filter(t => t.ownerId === playerId);
				let count = 0;

				switch (currentBonusTile.passBonus.type) {
					case 'big_building':
						count = playerStructures.filter(t =>
							t.structure === 'academy' || t.structure === 'planetary_institute'
						).length;
						break;
					case 'mine':
						count = getMineCountForPassAndBonuses(game, playerId);
						break;
					case 'trading_station':
						count = playerStructures.filter(t => t.structure === 'trading_station').length;
						break;
					case 'research_lab':
						count = playerStructures.filter(t => t.structure === 'research_lab').length;
						break;
					case 'gaiaformer':
						count = 0;
						break;
					case 'planet_type': {
						const planetTypes = new Set(
							playerStructures
								.filter(t => t.type !== 'space' && t.type !== 'deep_space')
								.map(t => t.type)
						);
						if (player.virtualMineAsteroid) planetTypes.add('asteroid');
						if (player.virtualMineProto) planetTypes.add('proto');
						if (playerStructures.some(t => t.structure === 'lost_planet_mine')) planetTypes.add('lost_planet');
						count = planetTypes.size;
						break;
					}
					case 'gaia':
						count = playerStructures.filter(t => t.type === 'gaia').length;
						break;
					case 'bridge_sector':
						const bridgeSectors = new Set(
							playerStructures
								.filter(t => t.sector >= 11 && t.sector <= 18)
								.map(t => t.sector)
						);
						count = bridgeSectors.size;
						break;
				}
				vpGained = count * currentBonusTile.passBonus.vp;
				const logMsg = `Gained ${vpGained} VP from pass bonus (${count} x ${currentBonusTile.passBonus.vp} for ${currentBonusTile.passBonus.type})`;
				addGameLog(game, playerId, 'Pass Round', logMsg);
				log(`Player ${player.name} ${logMsg}`, 'game', undefined, { simulation: (game as any).simulation });
			}

			if (currentBonusTile) {
				addScore(game, playerId, vpGained, 'bonusTilePass', { round: game.roundNumber, tileId: currentBonusTile.id });
			}

			applyAdvancedTechTilePassEffect(game, playerId);

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
		log(`Player ${player.name} returned ${oldBonusId} and took ${newBonusTileId}`, 'game', undefined, { simulation: (game as any).simulation });

		player.hasPassed = true;
		if (!game.passingOrder.includes(playerId)) {
			game.passingOrder.push(playerId);
		}
		game.hasDoneMainAction = false;

		if (Object.values(game.players).every(p => p.hasPassed)) {
			game.roundNumber++;
			(game as any).incomePhaseAppliedThisRound = false;
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

			game.turnOrder = [...game.passingOrder];
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

			helperTriggerIncomePhase(io, game);
		} else {
			game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
			while (game.players[game.turnOrder[game.currentPlayerIndex]].hasPassed) {
				game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.turnOrder.length;
			}
		}

		const newCurrentId = game.turnOrder[game.currentPlayerIndex];
		if (newCurrentId) {
			if (!game.turnStartState) game.turnStartState = {};
			game.turnStartState[newCurrentId] = buildTurnStartStateEntryForPlayer(game as ServerGameState, newCurrentId);
		}

		clampPlayerResources(game); io.to(game.id).emit('game_updated', game);

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
			spendTaklonsPower(player, 3, powerCost, useBrain ?? true);
		} else {
			player.power3 = (player.power3 ?? 0) - powerCost;
			player.power1 = (player.power1 ?? 0) + powerCost;
		}
	} else {
		player.qic = (player.qic ?? 0) - action.cost;
		// QIC 파워 액션 사용 시 고급 기술 타일(qic_action) 보상 적용
		applyAdvancedTechTileEffect(game, playerId, 'qic_action');
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
	io.to(game.id).emit('game_updated', game);
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
		addGameLog(game, playerId, 'Used Tech Action', 'Gained 4 Power');
	} else if (tileId === 'adv-act-3k') {
		player.knowledge += 3;
		player.usedTechActions.push(tileId);
		game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Used Tech Action', 'Gained 3 Knowledge');
	} else if (tileId === 'adv-act-3o') {
		player.ore += 3;
		player.usedTechActions.push(tileId);
		game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Used Tech Action', 'Gained 3 Ore');
	} else if (tileId === 'adv-act-1q-5c') {
		grantQic(game, playerId, 1);
		player.credits += 5;
		player.usedTechActions.push(tileId);
		game.hasDoneMainAction = true;
		addGameLog(game, playerId, 'Used Tech Action', 'Gained 1 QIC and 5 Credits');
	} else {
		return false;
	}

	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);
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
			addGameLog(game, playerId, 'Tinkeroid: Special', '1 TF + Build Mine (bonus tile)', undefined);
		} else if (actionId === 'tinkeroid-1qic') {
			grantQic(game, playerId, 1);
			game.hasDoneMainAction = true;
			addGameLog(game, playerId, 'Tinkeroid: Special', '1 QIC', undefined);
		} else if (actionId === 'tinkeroid-4power') {
			chargePower(player, 4);
			game.hasDoneMainAction = true;
			addGameLog(game, playerId, 'Tinkeroid: Special', '4 Power', undefined);
		} else if (actionId === 'tinkeroid-3k') {
			player.knowledge = (player.knowledge ?? 0) + 3;
			game.hasDoneMainAction = true;
			addGameLog(game, playerId, 'Tinkeroid: Special', '3 Knowledge', undefined);
		} else if (actionId === 'tinkeroid-2qic') {
			grantQic(game, playerId, 2);
			game.hasDoneMainAction = true;
			addGameLog(game, playerId, 'Tinkeroid: Special', '2 QIC', undefined);
		} else if (actionId === 'tinkeroid-3tf-mine') {
			player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 3;
			addGameLog(game, playerId, 'Tinkeroid: Special', '3 TF + Build Mine', undefined);
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
			addGameLog(game, playerId, 'Used Tech Action', 'Gained 4 Power (via Special Action)');
			applied = true;
		}
	}

	if (!applied) return false;
	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);
	return true;
}

/** Bot/소켓 공용: 보너스 타일 스페셜 액션 (terraform_step, gaia_project, range_3). */
export function executeUseBonusAction(
	io: SocketIOServer, game: ServerGameState, playerId: string
): boolean {
	if (!game || game.currentPhase !== 'main' || game.hasDoneMainAction) return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;

	const player = game.players[playerId];
	if (!player?.bonusTile || player.usedBonusAction) return false;

	const bonusTile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
	if (!bonusTile?.specialAction) return false;

	saveActionStartState(game, playerId);

	switch (bonusTile.specialAction) {
		case 'terraform_step':
			player.pendingTerraformSteps = (player.pendingTerraformSteps || 0) + 1;
			player.usedBonusAction = true;
			addGameLog(game, playerId, 'Bonus Action', '1 Terraform Step');
			log(`Player ${player.name} activated bonus action: 1 terraform step (Total: ${player.pendingTerraformSteps})`, 'game', undefined, { simulation: (game as any).simulation });
			break;
		case 'gaia_project':
			if (getEffectiveGaiaformers(player) < 1) return false;
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
	io.to(game.id).emit('game_updated', game);
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
	io.to(game.id).emit('game_updated', game);
	return true;
}

/**
 * pending 없이 “지금 상태에서 이클립스 6C 직후 질 수 있는” 소행성 (봇이 액션 시도 전 검증용).
 * 조건은 executeEclipseBuildAsteroidMine과 동일: Nav(+navigationBonus)만, 임시 네비 보너스 없음.
 */
export function peekEclipseAsteroidMineTileIds(game: ServerGameState, playerId: string): string[] {
	const player = game.players[playerId];
	if (!player) return [];
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
	tile.structure = 'mine';
	tile.ownerId = playerId;
	game.pendingEclipseAsteroidMine = null;
	addGameLog(game, playerId, 'Eclipse: Built mine on asteroid', neededQIC > 0 ? `6C, ${neededQIC} QIC (range)` : '6C (no Gaiaformer)', tileId);
	applyRoundMissionScore(game, playerId, 'build_mine');
	if (rm7QualifyEclipse) applyRoundMissionScore(game, playerId, 'new_sector');
	applyAdvancedTechTileEffect(game, playerId, 'build_mine');
	createPowerOffers(game, tile, playerId);
	addBuildingToFederationIfAdjacent(game, playerId, tileId);
	game.hasDoneMainAction = true;
	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);
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
			addGameLog(game, playerId, 'Twilight: Federation benefit', '3 QIC (choose reward)', shipTileId);
			game.hasDoneMainAction = true;
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
			return true;
		}
		if (actionIndex === 2) {
			if (targetTileId == null) return false;
			const target = game.map.find(t => t.id === targetTileId);
			if (!target || target.ownerId !== playerId || target.structure !== 'trading_station') return false;
			if (player.ore < 2 || player.power3 < 3) return false;
			player.ore -= 2;
			player.power3 -= 3;
			player.power1 = (player.power1 || 0) + 3;
			target.structure = 'research_lab';
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			applyRoundMissionScore(game, playerId, 'build_research_lab');
			addGameLog(game, playerId, 'Twilight: TS → Research Lab', '2O, 3P (no 3O 5C)', targetTileId);
			// 일반 TS→Lab 업그레이드와 동일하게: 인접 상대에게 파워 제공 + 인접 연방 편입 (우주선 액션 경로 누락 버그 수정)
			createPowerOffers(game, target, playerId);
			addBuildingToFederationIfAdjacent(game, playerId, target.id);
			game.pendingTechTileSelection = { playerId, tileId: targetTileId, structureType: 'research_lab' };
			game.availableShipTechTileIds = getShipTechTileIdsForPlayer(game, playerId);
			game.hasDoneMainAction = true;
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
			game.hasDoneMainAction = true;
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
			return true;
		}
		if (actionIndex === 2) {
			const tid = targetTileId != null ? String(targetTileId) : '';
			if (!tid) return false;
			const target = game.map.find(t => t.id === tid || String(t.id) === tid);
			if (!target || target.ownerId !== playerId || target.structure !== 'mine') return false;
			if (player.ore < 1 || player.power3 < 3) return false;
			player.ore -= 1;
			player.power3 -= 3;
			player.power1 = (player.power1 || 0) + 3;
			target.structure = 'trading_station';
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			applyRoundMissionScore(game, playerId, 'build_trading_station');
			addGameLog(game, playerId, 'Rebellion: Mine → TS', '1O, 3P (no 2O 3C/6C)', targetTileId);
			createPowerOffers(game, target, playerId);
			addBuildingToFederationIfAdjacent(game, playerId, target.id);
			game.hasDoneMainAction = true;
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
			return true;
		}
		return false;
	}

	// --- TF Mars ---
	if (shipTile.type === 'ship_tf_mars') {
		if (actionIndex === 1) {
			if (player.qic < 2) return false;
			player.qic -= 2;
			const count = player.techTiles?.length ?? 0;
			addScore(game, playerId, count + 2, 'other', { source: 'TF Mars Action' });
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			addGameLog(game, playerId, 'TF Mars: Tech tiles + 2 VP', `(${count}+2) VP`, shipTileId);
			game.hasDoneMainAction = true;
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
			const types = new Set(structures.map(t => t.type).filter(t => t && t !== 'space' && t !== 'deep_space'));
			addScore(game, playerId, types.size + 2, 'other', { source: 'Eclipse Action' });
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			addGameLog(game, playerId, 'Eclipse: Planet types + 2 VP', `(${types.size}+2) VP`, shipTileId);
			game.hasDoneMainAction = true;
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
			return true;
		}
		if (actionIndex === 2) {
			if (player.knowledge < 2) return false;
			if (player.faction === 'taklons') {
				if (!canSpendTaklonsPower(player, 3, 3)) return false;
			} else if ((player.power3 ?? 0) < 3) {
				return false;
			}
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
			game.pendingEclipseResearch = { playerId, shipTileId };
			addGameLog(game, playerId, 'Eclipse: 2K+3P → Research', '(choose track)', shipTileId);
			game.hasDoneMainAction = true;
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
			return true;
		}
		if (actionIndex === 3) {
			if (player.credits < 6) return false;
			player.credits -= 6;
			shipState.usedActionIndices = [...(shipState.usedActionIndices ?? []), actionIndex];
			shipState.actionsUsed = shipState.usedActionIndices.length;
			if (!shipState.usedActionBy) shipState.usedActionBy = {};
			shipState.usedActionBy[actionIndex] = playerId;
			game.pendingEclipseAsteroidMine = { playerId, shipTileId };
			addGameLog(game, playerId, 'Eclipse: 6C → Build mine on asteroid', '(select tile)', shipTileId);
			clampPlayerResources(game); io.to(game.id).emit('game_updated', game);
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
		io.to(game.id).emit('game_updated', game);
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
	io.to(game.id).emit('game_updated', game);
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

	const endingPlayerId = game.turnOrder[game.currentPlayerIndex];
	const manualOfferCount = activateQueuedPowerOffersForPlayer(game as ServerGameState, endingPlayerId);
	if (manualOfferCount > 0) {
		game.pendingTurnEndPlayerId = endingPlayerId;
		clampPlayerResources(game);
		io.to(game.id).emit('game_updated', game);
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
			game.pendingTechTileSelection = null;
			game.availableShipTechTileIds = undefined;
			clampPlayerResources(game);
			io.to(game.id).emit('game_updated', game);
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
				game.pendingTechTileSelection = null;
				game.availableShipTechTileIds = undefined;
				clampPlayerResources(game);
				io.to(game.id).emit('game_updated', game);
				return true;
			}
		}
	}

	// 진행 가능한 조합이 없으면 강제 해제 (무한 대기 방지)
	log(`Bot ${player.name} could not find valid tech tile selection, clearing pending state`, 'game', undefined, { simulation: (game as any).simulation });
	game.pendingTechTileSelection = null;
	game.availableShipTechTileIds = undefined;
	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);
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

	const specialId = pending.options[0];
	const player = game.players[playerId];
	player.tinkeroidRoundSpecialId = specialId;
	player.tinkeroidsChosenSpecialIds = [...(player.tinkeroidsChosenSpecialIds ?? []), specialId];

	game.pendingTinkeroidSpecialChoice = null;
	addGameLog(game, playerId, 'Bot: Tinkeroid Special', `Auto-selected ${specialId}`);
	log(`Bot ${player.name} (Tinkeroids) auto-selected special ${specialId}`, 'game', undefined, { simulation: (game as any).simulation });

	game.hasDoneMainAction = false; // 보너스 선택만 일어난 경우 메인 액션 소모 방지
	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);
	// 봇 전용: 보너스 픽업 완료 후 턴오더 강제 리셋을 방지하기 위해 여기선 return만 처리
	// (botHandler가 알아서 이어서 메인턴 실행함)
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
	const p2 = player.power2 ?? 0;
	const maxSpend = Math.min(tokens, p2);

	let remaining = maxSpend;
	// 지식 우선 (4점)
	while (remaining >= 4) { knowledge++; remaining -= 4; }
	// 남은걸로 크레딧 (1점)
	while (remaining >= 1) { credits++; remaining -= 1; }

	player.power2 = p2 - maxSpend;
	grantQic(game, playerId, qic);
	player.knowledge = (player.knowledge ?? 0) + knowledge;
	player.ore = (player.ore ?? 0) + ore;
	player.credits = (player.credits || 0) + credits;

	addGameLog(game, playerId, 'Bot: Terran Council', `Auto: ${maxSpend} tokens → +${qic}Q +${knowledge}K +${ore}O +${credits}C`);
	log(`Bot ${player.name} (Terran) auto-selected council benefits: ${maxSpend} tokens used`, 'game', undefined, { simulation: (game as any).simulation });

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
	io.to(game.id).emit('game_updated', game);
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

	// Pick the first candidate (deterministic, e.g. prefer science > economy > gaia > AI > nav > terra)
	const preferred: ResearchTrack[] = ['science', 'economy', 'gaiaProject', 'artificialIntelligence', 'navigation', 'terraforming'];
	const chosen = preferred.find(t => candidates.includes(t as ResearchTrack)) ?? candidates[0];

	saveActionStartState(game, playerId);
	if (!player.usedSpecialActions) player.usedSpecialActions = [];
	player.usedSpecialActions.push('bescods-advance-lowest');
	player.research[chosen as ResearchTrack] = (player.research[chosen as ResearchTrack] ?? 0) + 1;
	const newLevel = player.research[chosen as ResearchTrack];
	addGameLog(game, playerId, 'Bot: Bescods Special', `가장 낮은 트랙 +1 → ${chosen} Lv.${newLevel}`);
	applyTrackLevelBonus(game, playerId, player, chosen as ResearchTrack, newLevel);
	applyRoundMissionScore(game, playerId, 'research_track');
	log(`Bot ${player.name} (Bescods) advanced lowest track ${chosen} to Lv.${newLevel}`, 'game', undefined, { simulation: (game as any).simulation });
	game.hasDoneMainAction = true;

	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);
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

	// 링이 없는 본인 건물 중 첫 번째 선택 (ship 제외)
	const targetTile = game.map.find(
		t => t.ownerId === playerId && t.structure && t.structure !== 'ship' && !t.moweyipRing
	);
	if (!targetTile) return false;

	targetTile.moweyipRing = true;
	if (!player.usedSpecialActions) player.usedSpecialActions = [];
	player.usedSpecialActions.push('moweyip-place-ring');
	game.hasDoneMainAction = true;
	addGameLog(game, playerId, 'Bot: Moweyip Special', `링 놓기 → ${targetTile.structure} @ ${targetTile.id} (+2 파워)`, targetTile.id);
	log(`Bot ${player.name} (Moweyip) placed ring on ${targetTile.structure} @ ${targetTile.id}`, 'game', undefined, { simulation: (game as any).simulation });

	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);
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
		addGameLog(game, playerId, 'Bot: Itars PI', '4 tokens → Tech Tile exchange');
		clampPlayerResources(game);
		io.to(game.id).emit('game_updated', game);
		return true;
	}

	// 4개 미만이면 1그릇 복귀
	player.power1 = (player.power1 || 0) + tokensRemaining;
	if (tokensRemaining > 0) addGameLog(game, playerId, 'Bot: Itars PI', `${tokensRemaining} tokens → Bowl 1`);
	helperProceedAfterItarsGaiaformerOrTerran(io, game);

	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);
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
		addScore(game, actualTargetId, -offer.vpCost, 'powerReceived');
		applyPlayerPowerCharge(game, actualTargetId, offer.amount, { brainFirst, piAddFirst });

		const sourcePlayer = game.players[offer.sourcePlayerId];
		const text = `+${offer.amount}P${offer.vpCost > 0 ? ` (-${offer.vpCost}VP)` : ''}`;
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
			addGameLog(game, actualTargetId, 'Power Gained', `${text} (via ${sourcePlayer?.name})`, offer.tileId);
		}
		log(`Player ${targetPlayer.name} accepted power: +${offer.amount}P, -${offer.vpCost}VP`, 'game', undefined, { simulation: (game as any).simulation });
	} else {
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
	io.to(game.id).emit('game_updated', game);

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
		const totalPower = (player.power1 || 0) + (player.power2 || 0) + (player.power3 || 0);
		if (totalPower < numEmpty) return false;
		if (!spendPowerTokens(player, numEmpty)) return false;
	}

	if (!game.federationPool) {
		game.federationPool = {};
		FEDERATION_REWARDS.forEach(r => { game.federationPool![r.id] = 3; });
	}

	const reward = FEDERATION_REWARDS.find(r => r.id === rewardId);
	if (reward) {
		addScore(game, playerId, reward.vp, 'other', { source: '연방 ' + reward.label });
		const anyReward = reward as any;
		if (anyReward.ore) player.ore += anyReward.ore;
		if (anyReward.credits) player.credits += anyReward.credits;
		if (anyReward.knowledge) player.knowledge += anyReward.knowledge;
		if (anyReward.qic) grantQic(game, playerId, anyReward.qic);
		if (anyReward.powerTokens) player.power1 = (player.power1 || 0) + anyReward.powerTokens;
		game.federationPool![rewardId] -= 1;
	}

	if (!Array.isArray(player.federations) || (player.federations.length > 0 && typeof (player.federations as any)[0] === 'string')) {
		player.federations = getFederationEntries(player);
	}
	player.federations.push({ rewardId, isGreen: true });

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

	const unitLabel = isIvits ? '우주정거장' : '위성';
	addGameLog(game, playerId, 'Federation', `Formed federation (${numEmpty} ${unitLabel}, reward: ${reward?.label})`);
	game.hasDoneMainAction = true;
	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);
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
	addGameLog(game, playerId, "Bal T'aks: 1 Gaiaformer → 1 QIC", '1 포머 사용 (다음 라운드까지 복귀)', undefined);
	log(`Player ${player.name} (Bal T'aks) used 1 Gaiaformer for 1 QIC (locked until next round)`, 'game', undefined, { simulation: (game as any).simulation });
	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);
	return true;
}

/** 자원 변환 (Free Action) */
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
			if (canSpendTaklonsPower(player, 3, 1) && spendTaklonsPower(player, 3, 1, useBrain ?? false)) {
				player.credits += 1; logDesc = '1P → 1C'; success = true;
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
		io.to(game.id).emit('game_updated', game);
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
	let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
	if (player.tempRangeBonus) baseRange += 3;
	if (useRangeBonus && player.rangeBonusActive) {
		baseRange += 3;
		player.rangeBonusActive = false;
	}
	if (player.gleensNavBonusActive) { baseRange += 2; player.gleensNavBonusActive = false; }
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

	player.qic = (player.qic || 0) - useQic;
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

	// 입장 순서 보상: 2·3번째 2PW, 4번째 3PW
	const idx = shipState.occupants.length;
	if (idx === 2 || idx === 3) chargePower(player, 2);
	else if (idx === 4) chargePower(player, 3);

	addGameLog(game, playerId, 'Entered Ship', `${tile.type} (#${idx}), -${entryCost}VP${useQic ? `, ${useQic}QIC` : ''}`, tileId);

	game.hasDoneMainAction = true;
	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);
	return null;
}

export function executePlaceGaiaformer(io: SocketIOServer, game: ServerGameState, playerId: string, tileId: string, qicUsed?: number): boolean {
	if (!game || game.currentPhase !== 'main') return false;
	if (game.turnOrder[game.currentPlayerIndex] !== playerId) return false;
	const fromTFMars = game.pendingTFMarsGaiaProject?.playerId === playerId;
	if (!fromTFMars && game.hasDoneMainAction) return false;

	saveActionStartState(game, playerId);

	const player = game.players[playerId];
	const tile = game.map.find(t => t.id === tileId);
	if (!tile || tile.type !== 'transdim' || tile.hasGaiaformer || tile.structure !== null) return false;

	if (getEffectiveGaiaformers(player) <= 0) return false;

	let baseRange = getRange(player.research.navigation || 0) + (player.navigationBonus || 0);
	if (player.tempRangeBonus) { baseRange += 3; player.tempRangeBonus = false; }
	if (player.rangeBonusActive) { baseRange += 3; player.rangeBonusActive = false; }
	if (player.gleensNavBonusActive) { baseRange += 2; player.gleensNavBonusActive = false; }
	const rangeTiles = getPlayerRangeTiles(game, playerId, true);
	if (rangeTiles.length === 0) return false;

	const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));
	const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;

	const qicToUse = qicUsed || 0;
	if (qicToUse < neededQIC) return false;
	if (player.qic < qicToUse) return false;

	player.qic -= qicToUse;

	const gaiaLevel = player.research.gaiaProject || 0;
	let powerToMove = 0;

	const pendingGaia = game.pendingTFMarsGaiaProject;
	const isBonusGaia = pendingGaia?.shipTileId === 'bonus-gaia';
	const immediateBuildable = fromTFMars || isBonusGaia;

	if (!immediateBuildable) {
		if (gaiaLevel >= 1 && gaiaLevel < 3) powerToMove = 6;
		else if (gaiaLevel >= 3 && gaiaLevel < 4) powerToMove = 4;
		else if (gaiaLevel >= 4) powerToMove = 3;
		else return false;

		let remaining = powerToMove;
		let movedFrom1 = Math.min(remaining, player.power1 || 0);
		player.power1 = (player.power1 || 0) - movedFrom1;
		remaining -= movedFrom1;

		let movedFrom2 = Math.min(remaining, player.power2 || 0);
		player.power2 = (player.power2 || 0) - movedFrom2;
		remaining -= movedFrom2;

		let movedFrom3 = Math.min(remaining, player.power3 || 0);
		player.power3 = (player.power3 || 0) - movedFrom3;
		remaining -= movedFrom3;

		if (remaining > 0) return false;

		player.gaiaformerPower = (player.gaiaformerPower || 0) + powerToMove;
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
		addGameLog(game, playerId, 'Bonus: Gaia Project', 'Action completed', 'bonus-gaia');
		game.hasDoneMainAction = true;
	} else if (!fromTFMars) {
		game.hasDoneMainAction = true;
	}

	clampPlayerResources(game);
	io.to(game.id).emit('game_updated', game);
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
	io.to(game.id).emit('game_updated', game);
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
		game.pendingTwilightFederation = { playerId, shipTileId: twilightTile.id };
		addGameLog(game, playerId, 'Artifact: Federation benefit', 'Choose one federation reward', twilightTile.id);
	} else if (art.id === 'art-vp-gaia') {
		const lvl = player.research.gaiaProject ?? 0;
		const vp = lvl * 3;
		addScore(game, playerId, vp, 'other', { source: 'Artifact: Gaia x 3' });
		addGameLog(game, playerId, 'Artifact: Gaia×3 VP', `${lvl}×3 = ${vp} VP`, twilightTile.id);
	} else if (art.id === 'art-vp-science') {
		const lvl = player.research.science ?? 0;
		const vp = lvl * 3;
		addScore(game, playerId, vp, 'other', { source: 'Artifact: Science x 3' });
		addGameLog(game, playerId, 'Artifact: Science×3 VP', `${lvl}×3 = ${vp} VP`, twilightTile.id);
	} else if (art.id === 'art-vp-tracks3') {
		const tracks = (['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'] as ResearchTrack[]).filter(t => (player.research[t] ?? 0) >= 3).length;
		const vp = tracks * 3;
		addScore(game, playerId, vp, 'other', { source: 'Artifact: Tracks >= 3' });
		addGameLog(game, playerId, 'Artifact: Tracks≥3×3 VP', `${tracks}×3 = ${vp} VP`, twilightTile.id);
	} else if (art.id === 'art-vp-planet-types') {
		const structures = game.map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship');
		const types = new Set(structures.map(t => t.type).filter(x => x && x !== 'space' && x !== 'deep_space'));
		if (player.virtualMineAsteroid) types.add('asteroid');
		if (player.virtualMineProto) types.add('proto');
		const vp = 3 + types.size;
		addScore(game, playerId, vp, 'other', { source: 'Artifact: Planet types' });
		addGameLog(game, playerId, 'Artifact: 3+Planet types VP', `3+${types.size} = ${vp} VP`, twilightTile.id);
	} else if (art.id === 'art-7vp-virtual-asteroid') {
		addScore(game, playerId, 7, 'other', { source: 'Artifact: 7 VP + Asteroid' });
		player.virtualMineAsteroid = true;
		addGameLog(game, playerId, 'Artifact: 7 VP + virtual mine (asteroid)', '', twilightTile.id);
	} else if (art.id === 'art-7vp-virtual-proto') {
		addScore(game, playerId, 7, 'other', { source: 'Artifact: 7 VP + Proto' });
		player.virtualMineProto = true;
		addGameLog(game, playerId, 'Artifact: 7 VP + virtual mine (proto)', '', twilightTile.id);
	} else if (art.id === 'art-imm-3o3c') {
		player.ore = (player.ore || 0) + 3;
		player.credits = (player.credits || 0) + 3;
		addGameLog(game, playerId, 'Artifact: 3O 3C', '', twilightTile.id);
	} else if (art.id === 'art-imm-2o5c') {
		player.ore = (player.ore || 0) + 2;
		player.credits = (player.credits || 0) + 5;
		addGameLog(game, playerId, 'Artifact: 2O 5C', '', twilightTile.id);
	} else if (art.id === 'art-imm-3k1q') {
		player.knowledge = (player.knowledge || 0) + 3;
		player.qic = (player.qic || 0) + 1; // grantQic shortcut
		addGameLog(game, playerId, 'Artifact: 3K 1Q', '', twilightTile.id);
	} else if (art.id === 'art-vp-bridge') {
		const bridgeSectors = [11, 12, 13, 14, 15, 16, 17, 18];
		const withBuilding = bridgeSectors.filter(s => game.map.some(t => t.sector === s && t.ownerId === playerId && t.structure));
		const vp = withBuilding.length * 3;
		addScore(game, playerId, vp, 'other', { source: 'Artifact: Bridge VP' });
		addGameLog(game, playerId, 'Artifact: Bridge sections×3 VP', `${withBuilding.length}×3 = ${vp} VP`, twilightTile.id);
	} else {
		addGameLog(game, playerId, 'Artifact', art.label, twilightTile.id);
	}

	game.hasDoneMainAction = true;
	for (const p of Object.values(game.players)) {
		if (p.ore != null && p.ore > 15) p.ore = 15;
		if (p.knowledge != null && p.knowledge > 15) p.knowledge = 15;
		if (p.credits != null && p.credits > 30) p.credits = 30;
	}
	io.to(game.id).emit('game_updated', game);
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
		addGameLog(game, playerId, 'Twilight: Federation benefit', normalReward.label, pending.shipTileId);
		addScore(game, playerId, normalReward.vp, 'other', { source: 'Twilight Federation Benefit' });
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
				addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
				break;
			case 'ship-fed-4vp4k':
				addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
				addScore(game, playerId, 4, 'spaceships', { shipTileId: pending.shipTileId });
				player.knowledge = (player.knowledge || 0) + 4;
				break;
			case 'ship-fed-4vp1q2o':
				addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
				addScore(game, playerId, 4, 'spaceships', { shipTileId: pending.shipTileId });
				grantQic(game, playerId, 1);
				player.ore = (player.ore || 0) + 2;
				break;
			case 'ship-fed-8vp8c':
				addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
				addScore(game, playerId, 8, 'spaceships', { shipTileId: pending.shipTileId });
				player.credits = (player.credits || 0) + 8;
				break;
			case 'ship-fed-12vp':
				addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
				addScore(game, playerId, 12, 'spaceships', { shipTileId: pending.shipTileId });
				break;
			case 'ship-fed-7vp3p2t':
				addGameLog(game, playerId, 'Twilight: Spaceship Fed', shipReward.label, pending.shipTileId);
				addScore(game, playerId, 7, 'spaceships', { shipTileId: pending.shipTileId });
				player.power3 = (player.power3 || 0) + 2; // [수정] ship-fed-7vp3p2t: 그릇3에 토큰 2개(충전됨)
				break;
			case 'ship-fed-mine-free':
			case 'ship-fed-3tf-mine':
				addGameLog(game, playerId, 'Twilight: Spaceship Fed', `${shipReward.label} (재수령은 즉시 효과만)`, pending.shipTileId);
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
	io.to(game.id).emit('game_updated', game);
	return true;
}
