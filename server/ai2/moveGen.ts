/**
 * [ai2 0단계 2026-10-05] 합법 수 생성기 — 기존 봇 후보 생성(getCandidateMoves: 휴리스틱 게이트·점수, 수당 ~6.5ms)을
 * 대체하는 '규칙상 둘 수 있는 수'의 넓은 열거.
 *
 * 설계:
 *   - 의사-합법(pseudo-legal): 싼 필터(소유·자원 하한·거리 상한·사용 여부)만 걸고 넓게 뽑는다. 진짜 합법 여부는
 *     탐색이 그 수를 펼칠 때 서버 performAction 결과로 판정한다(isLegal). 규칙을 여기서 다시 구현하지 않는다.
 *   - 프리액션(변환·번)은 preActions로 묶지 않고 '턴 안의 개별 수'로 낸다 — 변환 조합 폭발 없이 완전성 확보.
 *     턴은 메인 액션 후 end_turn으로 끝난다(패스도 메인 액션).
 *   - 휴리스틱 게이트 없음: 전략 판단(QIC 예약·연방 미루기 등)은 정책/가치망 몫.
 *   - 턴 중 보류 선택(기술 타일·이클립스 연구 등)은 지금은 구동기가 기존 봇으로 자동 해소 — 여기선 메인 결정만 다룬다.
 *
 * 예외(아직 기존 코드 재사용): 연방은 FederationPlanner(기하 탐색)를 쓴다 — 위성 조합 열거는 별도 과제.
 */
import { BotAction } from '../ai/bot';
import { BotLogic } from '../ai/bot';
import { FederationPlanner } from '../ai/federationPlanner';
import { StateCloner } from '../ai/stateCloner';
import { stripHeavy } from './headlessDriver';
import { ServerGameState, upgradeRejectReason, researchRejectReason, techActionRejectReason } from '../gameState';
import { getRange, getDistance, ALL_BONUS_TILES, getTerraformCost, getTerraformStepsForFaction, getGaiaBaseQic } from '@shared/gameConfig';
import type { ResearchTrack, HexTile } from '@shared/gameConfig';

const TRACKS: ResearchTrack[] = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
const SHIP_TYPES = new Set(['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse']);
const NON_PLANET = new Set(['space', 'deep_space', 'transdim', 'lost_fleet_ship']);
const CONVERT_TYPES = ['1qic-to-1ore', '1ore-to-1credit', '1knowledge-to-1credit', '1power-to-1credit', '3power-to-1ore',
	'4power-to-1qic', '4power-to-1knowledge', '1ore-to-1token', '2power-to-1ore-1credit', '3power-to-2ore', '1brain-to-3credit', '1power-to-1k-gaiaformer'];
const io = { to: () => ({ emit: () => { /* noop */ } }), emit: () => { /* noop */ } } as any;

/** 수의 동일성 키(중복 제거·커버리지 비교용) — preActions는 무시 */
export function moveKey(a: BotAction): string {
	const p: any = a.params ?? {};
	return [a.type, p.tileId, p.target, p.trackId, p.actionId, p.shipTileId, p.actionIndex, p.targetTileId, p.bonusTileId,
		p.rewardId, p.artifactId, p.mineTileId, p.type, p.useBrain ? 'B' : ''].filter(x => x != null && x !== '').join('|');
}

function myAnchors(game: ServerGameState, pid: string): HexTile[] {
	return game.map.filter(t => (t.ownerId === pid && t.structure && t.structure !== 'ship')
		|| ((t as any).spaceStation?.ownerId === pid) || ((t as any).parasiticMine?.ownerId === pid));
}

/** 내 건물에서 최소 거리 → 필요한 QIC(사거리 r, 2칸당 1Q). 상한 필터용 근사 — 정확한 비용은 서버가 판정. */
function minDist(anchors: HexTile[], t: HexTile): number {
	let m = Infinity; for (const a of anchors) { const d = getDistance(a, t); if (d < m) m = d; } return m;
}

/** 메인 액션 전: 일반 턴의 모든 의사-합법 수 */
function mainActionMoves(game: ServerGameState, pid: string): BotAction[] {
	const p: any = game.players[pid];
	const out: BotAction[] = [];
	const ore = p.ore ?? 0, cr = p.credits ?? 0, qic = p.qic ?? 0, k = p.knowledge ?? 0;
	const p1 = p.power1 ?? 0, p2 = p.power2 ?? 0, p3 = p.power3 ?? 0;
	const anchors = myAnchors(game, pid);
	const range = getRange(p.research?.navigation ?? 0) + (p.tempRangeBonus || p.rangeBonusActive ? 3 : 0) + (p.gleensNavBonusActive ? 2 : 0);
	const reach = range + 2 * (qic + (p.faction === 'bal_tak' ? (p.gaiaformers ?? 0) : 0));

	// 광산(일반·가이아·소행성): 빈 행성. 지금 자원으로 낼 수 있는 비용만(광석=1+테라포밍, QIC=사거리+가이아 기본) — 변환이 필요하면
	//   변환(프리액션 수) 뒤 상태에서 합법이 된다. 비용 공식은 상한 근사, 최종 판정은 서버.
	const tfCost = getTerraformCost(p.research?.terraforming ?? 0);
	const freeSteps = p.pendingTerraformSteps ?? 0;
	const qicAvail = qic + (p.faction === 'bal_tak' ? (p.gaiaformers ?? 0) : 0) + (p.faction === 'hadsch_hallas' ? Math.floor(cr / 4) : 0);
	const baseRange = range;
	for (const t of game.map) {
		if (t.ownerId || t.structure || !t.type || SHIP_TYPES.has(t.type)) continue;
		const formedMine = t.hasGaiaformer && (t as any).gaiaformerOwnerId === pid && (p.pendingGaiaformerTiles ?? []).includes(t.id);
		if (t.hasGaiaformer && !formedMine) continue;
		if (NON_PLANET.has(t.type) && !formedMine) continue;
		const d = minDist(anchors, t);
		const rangeQ = Math.max(0, Math.ceil((d - baseRange) / 2));
		if (rangeQ > qicAvail) continue;
		const freeMine = !!(p.nextMineFreeFromShipTech || p.spaceshipFed3TfMineFree); // 우주선 기술·연방 무료 광산(비용은 서버 판정)
		if (freeMine) { /* 비용 필터 생략 */ }
		else if (t.type === 'asteroid') { if ((p.gaiaformers ?? 0) < 1) continue; }
		else if (formedMine) { if (ore < 1 || cr < 2) continue; }
		else if (t.type === 'gaia') {
			const gq = p.faction === 'gleens' ? 0 : getGaiaBaseQic(p.faction);
			if (ore < 1 + (p.faction === 'gleens' ? 1 : 0) || cr < 2 || rangeQ + gq > qicAvail) continue;
		} else {
			const steps = Math.max(0, getTerraformStepsForFaction(game as any, p.faction, t.type as any) - freeSteps);
			if (ore < 1 + steps * tfCost || cr < 2) continue;
		}
		out.push({ type: 'build_mine', params: { tileId: t.id } });
	}
	// 란티다 기생광산: 남의 건물 위
	if (p.faction === 'lantids' && ore >= 1 && cr >= 2) {
		for (const t of game.map) {
			if (!t.ownerId || t.ownerId === pid || !t.structure || (t as any).parasiticMine || SHIP_TYPES.has(t.type as string)) continue;
			if (minDist(anchors, t) > reach) continue;
			out.push({ type: 'build_mine', params: { tileId: t.id } });
		}
	}
	// 가이아포머 배치: 빈 트랜스딤
	if ((p.gaiaformers ?? 0) > 0) {
		for (const t of game.map) {
			if (t.type !== 'transdim' || t.ownerId || t.hasGaiaformer) continue;
			const d = minDist(anchors, t); if (d > reach) continue;
			out.push({ type: 'place_gaiaformer', params: { tileId: t.id, qicUsed: Math.max(0, Math.ceil((d - range) / 2)) } });
		}
	}
	// 업그레이드
	for (const t of game.map) {
		if (t.ownerId !== pid || !t.structure) continue;
		const targets = t.structure === 'mine' ? ['trading_station']
			: t.structure === 'trading_station' ? ['research_lab', 'planetary_institute']
			: t.structure === 'research_lab' ? ['academy_left', 'academy_right', 'planetary_institute'] : [];
		for (const target of targets) if (!upgradeRejectReason(game, pid, t.id, target)) out.push({ type: 'upgrade_structure', params: { tileId: t.id, target } });
	}
	// 연구
	for (const tr of TRACKS) if (!researchRejectReason(game, pid, tr)) out.push({ type: 'advance_research', params: { trackId: tr } });
	// 파워 액션(번으로 채울 수 있는 만큼까지 허용 — 번은 프리액션 수로 따로 있지만 서버가 자동 번하지 않으므로 p3 기준)
	for (const a of (game.powerActions ?? []) as any[]) {
		if (a.isUsed) continue;
		const brain3 = p.faction === 'taklons' && p.brainStoneBowl === 3 && !p.brainStoneInGaia ? 3 : 0; // 브레인스톤 = 3파워
		// 네블라스 의회: 그릇3 토큰 1개 = 파워 2 → 토큰 소모 절반(올림)
		const nevPI = p.faction === 'nevlas' && game.map.some(t => t.ownerId === pid && t.structure === 'planetary_institute');
		const tokCost = nevPI ? Math.ceil(a.cost / 2) : a.cost;
		if (a.costType === 'qic' ? qic >= a.cost : p3 + brain3 >= tokCost) out.push({ type: 'use_power_action', params: { actionId: a.id } });
		if (p.faction === 'taklons' && a.costType !== 'qic' && p3 + brain3 >= a.cost) out.push({ type: 'use_power_action', params: { actionId: a.id, useBrain: true } });
	}
	// 기술 액션 타일
	for (const tid of (p.techTiles ?? []) as string[]) if (!techActionRejectReason(game, pid, tid)) out.push({ type: 'use_tech_action', params: { tileId: tid } });
	// 종족·아카데미 특수 액션(서버가 사용 여부·조건 판정)
	const hasPI = game.map.some(t => t.ownerId === pid && t.structure === 'planetary_institute');
	const specials: string[] = [];
	if (game.map.some(t => t.ownerId === pid && t.structure === 'academy' && (t as any).academyType === 'right')) specials.push('academy-qic');
	if (p.faction === 'gleens') specials.push('gleens-2nav');
	if (p.faction === 'space_giants') specials.push('space_giants-2tf');
	if (p.tinkeroidRoundSpecialId) specials.push(p.tinkeroidRoundSpecialId);
	for (const id of specials) if (!(p.usedSpecialActions ?? []).includes(id)) out.push({ type: 'use_special_action', params: { actionId: id } });
	if (p.faction === 'bescods' && !(p.usedSpecialActions ?? []).includes('bescods-advance-lowest')) out.push({ type: 'bescods_advance_lowest', params: {} });
	if (p.faction === 'ambas' && hasPI && !(p.usedSpecialActions ?? []).includes('ambas-swap-pi-mine')) {
		for (const t of game.map) if (t.ownerId === pid && t.structure === 'mine') out.push({ type: 'ambas_swap_pi_mine', params: { mineTileId: t.id } });
	}
	if (p.faction === 'firaks' && hasPI && !(p.usedSpecialActions ?? []).some((x: string) => /firaks/.test(x))) {
		for (const t of game.map) if (t.ownerId === pid && t.structure === 'research_lab') for (const tr of TRACKS) out.push({ type: 'firaks_downgrade', params: { tileId: t.id, trackId: tr } });
	}
	if (p.faction === 'ivits') {
		for (const t of game.map) {
			if (t.type !== 'space' || t.ownerId || (t as any).spaceStation) continue;
			if (minDist(anchors, t) > reach) continue;
			out.push({ type: 'place_ivits_space_station', params: { tileId: t.id } });
		}
	}
	// 보너스 타일 액션
	const bonus = ALL_BONUS_TILES.find(b => b.id === p.bonusTile);
	if (bonus?.specialAction && !p.usedBonusAction) out.push({ type: 'use_bonus_action', params: { actionId: bonus.specialAction } });
	// 우주선 입장: 미입장 배, 필요 QIC(근사)·사거리 보너스 변형
	const entered: string[] = p.spaceshipsEntered ?? [];
	for (const t of game.map) {
		if (!SHIP_TYPES.has(t.type as string) || entered.includes(t.id)) continue;
		const d = minDist(anchors, t);
		const need = Math.max(0, Math.ceil((d - range) / 2)); // range = 연구 사거리 + 이번 턴 활성 보너스
		if (need <= qic) out.push({ type: 'enter_spaceship', params: { tileId: t.id, useRangeBonus: false, qicToUse: need } } as any);
		if (bonus?.specialAction === 'range_3' && !p.usedBonusAction && !p.rangeBonusActive) {
			const needB = Math.max(0, Math.ceil((d - range - 3) / 2));
			if (needB <= qic) out.push({ type: 'enter_spaceship', params: { tileId: t.id, useRangeBonus: true, qicToUse: needB } } as any);
		}
	}
	// 우주선 액션: 탑승한 배의 1~3번, 업글형(트왈 #2 TS→랩, 리벨 #2 광산→TS)은 대상 타일별
	for (const sid of entered) {
		const t = game.map.find(x => x.id === sid); if (!t) continue;
		const used: number[] = (game as any).spaceships?.[sid]?.usedActionIndices ?? [];
		for (const idx of [1, 2, 3]) {
			if (used.includes(idx)) continue;
			if (idx === 2 && (t.type === 'ship_twilight' || t.type === 'ship_rebellion')) {
				const from = t.type === 'ship_twilight' ? 'trading_station' : 'mine';
				for (const x of game.map) if (x.ownerId === pid && x.structure === from) out.push({ type: 'use_ship_action', params: { shipTileId: sid, actionIndex: idx, targetTileId: x.id } });
			} else out.push({ type: 'use_ship_action', params: { shipTileId: sid, actionIndex: idx } });
		}
	}
	// 트왈라잇 인공물
	const slots = (game as any).twilightArtifactSlots ?? [];
	const onTwilight = entered.some(id => game.map.find(x => x.id === id)?.type === 'ship_twilight');
	if (onTwilight && slots.some((s: any) => s != null) && p1 + p2 + p3 >= 6) {
		for (const s of slots) if (s != null) out.push({ type: 'take_twilight_artifact', params: { artifactId: typeof s === 'string' ? s : s.id } });
	}
	// 하드시 할라 의회 / 발타크 포머→QIC
	if (p.faction === 'hadsch_hallas' && hasPI) for (const id of (cr >= 4 ? ['hh-4c-1qic', 'hh-3c-1o', 'hh-4c-1k'] : cr >= 3 ? ['hh-3c-1o'] : [])) out.push({ type: 'use_hadsch_hallas_pi_action', params: { actionId: id } });
	// 연방(기하 탐색은 플래너 재사용 — 상위 8개)
	try { for (const fed of FederationPlanner.getFederationActions(game, pid, 0, 8)) out.push({ type: 'form_federation', params: fed } as any); } catch { /* 플래너 실패는 연방 수 없음으로 */ }
	// 패스(보너스 타일별; R6은 보너스 없음)
	const bonuses = (game.availableBonusTiles ?? []) as any[];
	for (const b of bonuses) out.push({ type: 'pass_round', params: { bonusTileId: b.id } });
	if (!bonuses.length || (game.roundNumber ?? 1) >= 6) out.push({ type: 'pass_round', params: {} });
	return out;
}

/** 프리액션(턴 중 언제든): 변환·번·발타크 포머→QIC. 자원 하한만 필터. */
function freeActionMoves(game: ServerGameState, pid: string): BotAction[] {
	const p: any = game.players[pid];
	const out: BotAction[] = [];
	const ore = p.ore ?? 0, cr = p.credits ?? 0, qic = p.qic ?? 0, k = p.knowledge ?? 0, p2 = p.power2 ?? 0, p3 = p.power3 ?? 0;
	const need: Record<string, boolean> = {
		'1qic-to-1ore': qic >= 1, '1ore-to-1credit': ore >= 1, '1knowledge-to-1credit': k >= 1, '1power-to-1credit': p3 >= 1,
		'3power-to-1ore': p3 >= 3, '4power-to-1qic': p3 >= 4, '4power-to-1knowledge': p3 >= 4, '1ore-to-1token': ore >= 1,
		'2power-to-1ore-1credit': p3 >= 2 && p.faction === 'nevlas', '3power-to-2ore': p3 >= 3 && p.faction === 'nevlas',
		'1brain-to-3credit': p.faction === 'taklons' && p.brainStoneBowl === 3, '1power-to-1k-gaiaformer': p.faction === 'itars',
	};
	for (const t of CONVERT_TYPES) if (need[t]) out.push({ type: 'convert_resource', params: { type: t } });
	// 타클론: 파워 변환에 브레인스톤(3파워) 사용 변형
	if (p.faction === 'taklons' && p.brainStoneBowl === 3) for (const t of ['1power-to-1credit', '3power-to-1ore', '4power-to-1qic', '4power-to-1knowledge']) out.push({ type: 'convert_resource', params: { type: t, useBrain: true } });
	if (p2 >= 2) out.push({ type: 'burn_power', params: {} });
	if (p.faction === 'bal_tak' && (p.gaiaformers ?? 0) > 0) out.push({ type: 'bal_tak_gaiaformer_to_qic', params: {} });
	void cr;
	return out;
}

/** 현재 차례 플레이어의 의사-합법 수 전체(메인 전: 메인 액션+프리액션 / 메인 후: end_turn+프리액션). */
export function generateMoves(game: ServerGameState, pid: string, opts: { freeActions?: boolean } = {}): BotAction[] {
	if (game.currentPhase !== 'main') return [];
	if (game.turnOrder[game.currentPlayerIndex] !== pid || game.players[pid]?.hasPassed) return [];
	const moves = game.hasDoneMainAction ? [{ type: 'end_turn', params: {} } as BotAction] : mainActionMoves(game, pid);
	if (opts.freeActions !== false) moves.push(...freeActionMoves(game, pid));
	const seen = new Set<string>(); const outM: BotAction[] = [];
	for (const m of moves) { const key = moveKey(m); if (!seen.has(key)) { seen.add(key); outM.push(m); } }
	return outM;
}

/** 진짜 합법 판정: 복제본에 서버 규칙으로 적용해 본다(탐색이 노드를 펼칠 때만 호출 — 지연 검증). 적용된 복제본도 돌려준다. */
export async function tryApply(game: ServerGameState, pid: string, m: BotAction): Promise<ServerGameState | null> {
	stripHeavy(game);
	const s = StateCloner.cloneGameStateForSimulation(game) as any;
	s.simulation = true; s.headless = (game as any).headless; s.botCanceled = (game as any).botCanceled;
	try { return (await BotLogic.performAction(io, s, m, pid)) ? s : null; } catch { return null; }
}
