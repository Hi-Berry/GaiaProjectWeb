/**
 * [ai2 0단계 2026-10-05] 헤드리스 구동기 — 소켓·타이머 없이 서버 규칙 코드(execute*)만으로 게임을 끝까지 진행한다.
 *
 * 왜: 새 탐색 AI(PUCT + 정책/가치망)는 '이 상태에서 누가 무엇을 결정해야 하나'를 동기적으로 묻고, 고른 수를 적용한 뒤
 *   다음 결정까지 자동 진행하는 시뮬레이터가 필요하다. 기존 봇 루프(botHandler.executeBotTurnIfNeeded)는 같은 일을
 *   setTimeout 체인·락·워치독으로 하므로 시뮬레이터로 쓸 수 없다. 이 모듈은 그 흐름을 동기 상태기계로 옮긴 것이다.
 *
 * 원칙:
 *   - 규칙은 서버 코드 그대로(BotLogic.performAction → execute*). 여기서 규칙을 다시 구현하지 않는다.
 *   - 기존 봇/핸들러는 수정하지 않는다. 라이브와 공유하는 서버 코드에 넣은 것은 game.headless 가드 1곳(수익 체인 동기화)뿐.
 *   - '결정'은 정책에 묻고, 아직 정책이 다루지 않는 부수 선택(수익 순서·팅커로이드·테란 의회 등)은 기존 봇 자동처리 함수로
 *     해소한다(autoResolved로 집계 — 나중에 결정으로 승격할 목록).
 *
 * 사용: const g = prepareHeadless(snapshot); while (true) { const r = await step(g, policy); if (r.done) break; }
 */
import { BotLogic, BotAction } from '../ai/bot';
import { StateCloner } from '../ai/stateCloner';
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
	executeBotAmbasSwapPiMine,
	executeBotBescodsAdvanceLowestTrack,
	getLegalEclipseAsteroidMineTileIds,
	executeEclipseBuildAsteroidMine,
	scoreTerminalStateForRollout,
} from '../gameState';
import { getPlayerFlag } from '../ai/variant';
import type { ResearchTrack } from '@shared/gameConfig';

const io = { to: () => ({ emit: () => { /* noop */ } }), emit: () => { /* noop */ } } as any;
const TRACKS: ResearchTrack[] = ['economy', 'terraforming', 'science', 'navigation', 'artificialIntelligence', 'gaiaProject'];

/** 정책이 내려야 하는 결정. main = 일반 턴(패스 포함), 그 외는 턴 중 생긴 보류 선택. */
export type DecisionKind = 'main' | 'setup';
export interface Decision { kind: DecisionKind; playerId: string }
/** 정책: 결정과 그 시점 상태를 받아 수를 고른다(null = 패스/턴 종료 의사). 상태를 변경하면 안 된다. */
export type Policy = (game: ServerGameState, d: Decision) => Promise<BotAction | null>;

export interface StepResult {
	done: boolean;           // 게임 종료 또는 진행 불가
	stuck?: string;          // 진행 불가 사유(정상 종료면 undefined)
	decided?: boolean;       // 이번 step에서 정책 결정이 있었나
}

export interface DriverStats {
	decisions: number;
	actionsApplied: number;
	actionFailures: number;
	autoResolved: Record<string, number>;
}

export function newStats(): DriverStats { return { decisions: 0, actionsApplied: 0, actionFailures: 0, autoResolved: {} }; }

/** 스냅샷/라이브 상태 → 헤드리스 시뮬 상태. 라이브 객체는 절대 건드리지 않도록 항상 복제한다. */
export function prepareHeadless(src: ServerGameState): ServerGameState {
	const g = StateCloner.cloneGameStateForSimulation(src) as any;
	g.simulation = true;   // 로그·방송·진단 경로가 시뮬 분기를 탄다
	g.headless = true;     // 수익 체인 동기 실행(gameState.continueIncomeChain)
	g.botCanceled = true;  // 서버 코드 안에서 호출되는 executeBotTurnIfNeeded를 즉시 반환시킨다(봇 루프가 시뮬 상태에서 돌지 않게)
	return g as ServerGameState;
}

const bump = (s: DriverStats, k: string) => { s.autoResolved[k] = (s.autoResolved[k] ?? 0) + 1; };

/** 현재 차례(메인 단계) 플레이어 */
function currentPlayer(game: ServerGameState): string | null {
	if (game.currentPhase === 'main' || game.currentPhase === 'factionSelect') return game.turnOrder[game.currentPlayerIndex] ?? null;
	if (game.currentPhase === 'startingMines') {
		const placed = Object.values(game.players).reduce((s, p: any) => s + (p.startingMinesPlaced || 0), 0);
		const seq = (game as any).startingMineSequence ?? [];
		return seq[placed] ?? null;
	}
	if (game.currentPhase === 'bonusSelection') return (game as any).pendingBonusSelection ?? null;
	return null;
}

/** 플레이어 본인이 해소해야 하는 턴 내 보류(이게 있으면 end_turn이 서버에서 거부된다) */
function hasOwnTurnPending(game: ServerGameState, pid: string): boolean {
	const g = game as any;
	return [g.pendingTFMarsGaiaProject, g.pendingTechTileSelection, g.pendingShipTechTrackAdvance, g.pendingAdvancedTechTrackAdvance,
		g.pendingSpaceshipFedMine, g.pendingShipTechMine, g.pendingLostPlanet, g.pendingEclipseResearch, g.pendingEclipseAsteroidMine,
		g.pendingTwilightFederation, g.pendingFederationReward].some(p => p?.playerId === pid)
		|| ((game.players[pid] as any)?.pendingTerraformSteps ?? 0) > 0;
}

function ownPendingKeys(game: ServerGameState, pid: string): string[] {
	const g = game as any;
	const keys = Object.keys(g).filter(k => /^pending/.test(k) && g[k]?.playerId === pid);
	if (((game.players[pid] as any)?.pendingTerraformSteps ?? 0) > 0) keys.push('pendingTerraformSteps');
	return keys;
}

function advanceLowestTrack(game: ServerGameState, pid: string): boolean {
	const p = game.players[pid];
	const ordered = TRACKS.map(t => ({ t, lv: p.research[t] ?? 0 })).filter(x => x.lv < 5).sort((a, b) => a.lv - b.lv);
	for (const { t } of ordered) if (executeAdvanceTech(io, game, pid, t)) return true;
	return false;
}

/**
 * 정책 없이 해소 가능한 보류를 하나 처리한다(botHandler.doBotTurn의 순서 그대로). 처리했으면 true.
 * 정책 결정으로 승격하려면 여기서 빼고 nextDecision에 kind를 추가하면 된다.
 */
async function autoResolveOne(game: ServerGameState, stats: DriverStats): Promise<boolean> {
	const g = game as any;
	if (g.pendingIncomeOrder) { executeBotIncomeSelection(io, game, g.pendingIncomeOrder.playerId); bump(stats, 'incomeOrder'); return true; }
	if (g.pendingTinkeroidSpecialChoice) { executeBotTinkeroidSpecial(io, game, g.pendingTinkeroidSpecialChoice.playerId); bump(stats, 'tinkeroidSpecial'); return true; }
	if (g.pendingTerranCouncilBenefit) { executeBotTerranCouncilBenefit(io, game, g.pendingTerranCouncilBenefit.playerId); bump(stats, 'terranCouncil'); return true; }
	if (g.pendingItarsGaiaformerExchange) { executeBotItarsGaiaformerExchange(io, game, g.pendingItarsGaiaformerExchange.playerId); bump(stats, 'itarsExchange'); return true; }
	if (g.pendingTechTileSelection) {
		// 기존 봇과 같은 경로: 점수 기반 선택(getNextMove가 select_tech_tile/advanced 반환), 실패 시 서버 기본 선택
		const pid = g.pendingTechTileSelection.playerId;
		const pick = await BotLogic.getNextMove(game, pid, true);
		const ok = (pick?.type === 'select_tech_tile' || pick?.type === 'select_advanced_tech_tile') && await BotLogic.performAction(io, game, pick, pid);
		if (!ok) executeBotSelectTechTile(io, game, pid);
		bump(stats, 'techTile'); return true;
	}
	if (g.pendingEclipseAsteroidMine && game.currentPhase === 'main') {
		const pid = g.pendingEclipseAsteroidMine.playerId;
		const legal = getLegalEclipseAsteroidMineTileIds(game, pid);
		if (legal.length) { executeEclipseBuildAsteroidMine(io, game, pid, BotLogic.pickBestEclipseAsteroidTile(game, pid, legal)); bump(stats, 'eclipseAsteroid'); return true; }
	}
	if (g.pendingShipTechTrackAdvance) {
		if (!advanceLowestTrack(game, g.pendingShipTechTrackAdvance.playerId)) g.pendingShipTechTrackAdvance = null;
		bump(stats, 'shipTechTrack'); return true;
	}
	if (g.pendingAdvancedTechCover) {
		const pid = g.pendingAdvancedTechCover.playerId; const p = game.players[pid];
		const covered = new Set((p as any)?.coveredTechTiles ?? []);
		const tid = (p?.techTiles ?? []).find((t: string) => !t.startsWith('adv-') && !covered.has(t)) ?? null;
		if (!(tid && executeCoverAdvancedTechTile(io, game, pid, tid))) g.pendingAdvancedTechCover = null;
		bump(stats, 'advTechCover'); return true;
	}
	if (g.pendingAdvancedTechTrackAdvance) {
		if (!advanceLowestTrack(game, g.pendingAdvancedTechTrackAdvance.playerId)) g.pendingAdvancedTechTrackAdvance = null;
		bump(stats, 'advTechTrack'); return true;
	}
	return false;
}

/** 기존 봇이 '메인 액션 전에' 자동 실행하는 종족 특수(모웨이드 링·엠바스 스왑·매안 트랙업) — 봇 동등성 모드에서만. */
function botParityPreMain(game: ServerGameState, pid: string, stats: DriverStats): boolean {
	if (game.currentPhase !== 'main' || game.hasDoneMainAction) return false;
	const p = game.players[pid] as any;
	if (p?.faction === 'moweyip' && !p.usedSpecialActions?.includes('moweyip-place-ring')
		&& game.map.some(t => t.ownerId === pid && t.structure === 'planetary_institute')
		&& game.map.some(t => t.ownerId === pid && t.structure && t.structure !== 'ship' && !(t as any).moweyipRing)) {
		if (executeBotMoweyipPlaceRing(io, game, pid)) { bump(stats, 'moweyipRing'); return true; }
	}
	if (p?.faction === 'ambas' && !p.usedSpecialActions?.includes('ambas-swap-pi-mine')
		&& (getPlayerFlag(pid, 'ambasFedSwap', false)
			|| (getPlayerFlag(pid, 'ambasFedSwapHuman', true) && (game.botPlayerIds?.length ?? 0) < Object.keys(game.players).length))) {
		const mine = BotLogic.pickAmbasFedSwapMine(game, pid);
		if (mine && executeBotAmbasSwapPiMine(io, game, pid, mine)) { bump(stats, 'ambasSwap'); return true; }
	}
	if (p?.faction === 'bescods' && !p.usedSpecialActions?.includes('bescods-advance-lowest')) {
		// bescodsLateSpecial(기본 ON): L5 경쟁(최하위 L4)이 아니면 패스 직전까지 미룸 — 여기선 즉시 사용 케이스만
		const minLv = Math.min(...TRACKS.map(t => p.research?.[t] ?? 0));
		if (!getPlayerFlag(pid, 'bescodsLateSpecial', true) || minLv >= 4) {
			if (executeBotBescodsAdvanceLowestTrack(io, game, pid)) { bump(stats, 'bescodsSpecial'); return true; }
		}
	}
	return false;
}

async function applyAction(game: ServerGameState, pid: string, a: BotAction): Promise<boolean> {
	try {
		for (const pre of ((a as any).preActions ?? [])) if (!await BotLogic.performAction(io, game, pre, pid)) return false;
		return await BotLogic.performAction(io, game, { type: a.type, params: a.params } as BotAction, pid);
	} catch { return false; }
}

const fingerprint = (g: ServerGameState) => {
	const x = g as any;
	return `${g.currentPhase}|R${g.roundNumber}|i${g.currentPlayerIndex}|m${g.hasDoneMainAction ? 1 : 0}|${g.turnOrder.map(id => (g.players[id].hasPassed ? 1 : 0)).join('')}|${Object.keys(x).filter(k => /^pending/.test(k) && x[k]).join(',')}|s${Object.values(g.players).map((p: any) => p.score).join(',')}|t${g.map.filter(t => t.structure).length}`;
};

export interface StepOptions { botParity?: boolean }

/**
 * 한 단계 진행: 자동 해소 가능한 보류를 먼저 처리하고, 정책 결정이 필요하면 정책을 불러 적용한다.
 * 실패 처리는 기존 봇과 같은 순서: 거부된 수 → (메인 전이면) 패스, 메인 후면 end_turn.
 */
export async function step(game: ServerGameState, policy: Policy, stats: DriverStats, opt: StepOptions = {}): Promise<StepResult> {
	if (game.currentPhase === 'gameEnd') return { done: true };
	if (await autoResolveOne(game, stats)) return { done: false };

	const pid = currentPlayer(game);
	if (!pid) return { done: true, stuck: `no current player (phase=${game.currentPhase})` };
	const player = game.players[pid];
	if (game.currentPhase === 'main') {
		if ((game.pendingPowerOffers ?? []).some(o => !o.responded)) return { done: true, stuck: 'unresponded power offer (사람 대상 — 헤드리스는 전원 봇 가정)' };
		if (player.hasPassed) return { done: true, stuck: `current player ${pid} already passed` };
		// 메인 액션을 했고 본인 보류가 없으면 턴 종료(리치 활성화·다음 차례는 서버 executeEndTurn이 처리)
		if (game.hasDoneMainAction && !hasOwnTurnPending(game, pid)) {
			if (await BotLogic.performAction(io, game, { type: 'end_turn', params: {} } as BotAction, pid)) { stats.actionsApplied++; return { done: false }; }
		}
		// 메인 액션 뒤 본인 후속 보류(이클립스 연구·잊혀진 행성·TF마스 가이아·트왈 연방 보상·우주선 무료광산 등):
		//   getCandidateMoves는 메인 뒤엔 end_turn만 주므로 기존 봇의 해소 경로(getNextMove 시뮬 모드)로 처리. → 승격 후보 목록.
		if (game.hasDoneMainAction && hasOwnTurnPending(game, pid)) {
			const keys = ownPendingKeys(game, pid).join('+');
			const fix = await BotLogic.getNextMove(game, pid, true);
			if (fix && fix.type !== 'end_turn' && await applyAction(game, pid, fix)) { bump(stats, `post:${keys}`); stats.actionsApplied++; return { done: false }; }
			// 남은 게 테라포밍 스텝뿐인데 지을 곳이 없음 → 스텝 포기 후 턴 종료(botHandler '스텝 포기(무한루프 방지)'와 동일)
			if (keys === 'pendingTerraformSteps') {
				(game.players[pid] as any).pendingTerraformSteps = 0;
				bump(stats, 'dropTerraformSteps');
				return { done: false };
			}
			// 해소 수가 없거나 거부되면 서버의 '건너뛰기' 수로 보류를 비운다(기존 봇 폴백과 동일 계열)
			for (const skip of ['skip_tfmars_gaia_project', 'skip_ship_tech_mine'] as const) {
				if (await BotLogic.performAction(io, game, { type: skip, params: {} } as BotAction, pid)) { bump(stats, `skip:${keys}`); return { done: false }; }
			}
			return { done: true, stuck: `post-main pending unresolved (${keys}; bot pick=${fix?.type ?? 'null'})` };
		}
		if (opt.botParity && botParityPreMain(game, pid, stats)) return { done: false };
	}

	stats.decisions++;
	const action = await policy(game, { kind: game.currentPhase === 'main' ? 'main' : 'setup', playerId: pid });
	if (action && await applyAction(game, pid, action)) { stats.actionsApplied++; return { done: false, decided: true }; }
	if (action) stats.actionFailures++;

	if (game.currentPhase !== 'main') return { done: true, stuck: `setup decision failed (phase=${game.currentPhase}, action=${action?.type ?? 'null'})` };
	if (game.hasDoneMainAction) {
		if (await BotLogic.performAction(io, game, { type: 'end_turn', params: {} } as BotAction, pid)) { stats.actionsApplied++; return { done: false, decided: true }; }
		return { done: true, stuck: `end_turn rejected after main (own pending: ${ownPendingKeys(game, pid).join(',') || 'none'}; action=${action?.type ?? 'null'})` };
	}
	// 메인 전 실패/결정 없음 → 패스(보너스 타일 첫 장). 기존 봇의 최종 그물과 동일.
	if (opt.botParity && getPlayerFlag(pid, 'bescodsLateSpecial', true) && (player as any).faction === 'bescods'
		&& !(player as any).usedSpecialActions?.includes('bescods-advance-lowest')
		&& executeBotBescodsAdvanceLowestTrack(io, game, pid)) { bump(stats, 'bescodsSpecial'); return { done: false, decided: true }; }
	const bonusTileId = game.availableBonusTiles?.length ? game.availableBonusTiles[0].id : undefined;
	if (await BotLogic.performAction(io, game, { type: 'pass_round', params: { bonusTileId } } as BotAction, pid)) { stats.actionsApplied++; return { done: false, decided: true }; }
	return { done: true, stuck: `pass rejected (R${game.roundNumber}, pending=${Object.keys(game as any).filter(k => /^pending/.test(k) && (game as any)[k]).join(',')})` };
}

/** 게임 끝까지 구동. 같은 지문이 maxSame번 반복되면 진행 불가로 판정. */
export async function runToEnd(game: ServerGameState, policy: Policy, opt: StepOptions & { maxSteps?: number; maxSame?: number } = {}) {
	const stats = newStats();
	let last = '', same = 0, stuck: string | undefined;
	for (let i = 0; i < (opt.maxSteps ?? 5000); i++) {
		const r = await step(game, policy, stats, opt);
		if (r.done) { stuck = r.stuck; break; }
		const fp = fingerprint(game);
		if (fp === last) { if (++same >= (opt.maxSame ?? 30)) { stuck = `no progress x${same}: ${fp}`; break; } } else { same = 0; last = fp; }
	}
	const ended = game.currentPhase === 'gameEnd';
	if (!ended && !stuck) stuck = 'maxSteps';
	if (ended) { /* 종료 정산은 서버 gameEnd 경로가 이미 수행 */ } else if (!stuck) scoreTerminalStateForRollout(game);
	return { ended, stuck, stats, scores: Object.fromEntries(game.turnOrder.map(id => [id, game.players[id].score])) };
}

/** 정책: 기존 봇(시뮬 모드 getNextMove — MCTS 없이 빠른 경로). 구동기 동등성 검증용. */
export const botFastPolicy: Policy = async (game, d) => BotLogic.getNextMove(game, d.playerId, true);

/** 정책: 기존 봇 전체 경로(MCTS 포함, 예산은 MCTS.setBotOnlyCap으로 제한) — 실제 자가대국과 같은 세기 비교용. */
export const botFullPolicy: Policy = async (game, d) => BotLogic.getNextMove(game, d.playerId, false);

/** 정책: 기존 봇 후보 중 무작위(패스는 10%). 구동기 견고성 검증용. */
export function randomPolicy(seed = 1): Policy {
	let s = seed >>> 0 || 1;
	const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	return async (game, d) => {
		const cands = BotLogic.getCandidateMoves(game, d.playerId).filter(c => c.type !== 'end_turn');
		const nonPass = cands.filter(c => c.type !== 'pass_round');
		// 메인 액션 뒤(턴 내 보류 해소 중)엔 패스가 규칙상 불가 — 비-패스 후보만
		if (nonPass.length && (game.hasDoneMainAction || rnd() > 0.1)) return nonPass[Math.floor(rnd() * nonPass.length)];
		if (game.hasDoneMainAction) return null;
		return cands.find(c => c.type === 'pass_round') ?? null;
	};
}
