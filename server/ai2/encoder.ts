/**
 * [ai2 0단계 2026-10-05] 신경망 입력 인코더 — ServerGameState → 고정 길이 숫자 배열.
 *
 * 구성(관점 플레이어 기준, 좌석은 '나 → 다음 차례 → …' 상대 순서):
 *   grid : 육각 맵을 축좌표(q,r) 격자에 펼친 C×H×W 채널(행성 종류·소유·건물·위성·연방·포머 등). 합성곱/그래프망용.
 *   flat : 라운드·미션·공용 풀(파워 액션·보너스·기술/고급 타일·연방 보상·우주선·인공물) + 플레이어 4명(자원·그릇·연구·
 *          건물 수·보유 타일·연방·보너스·다음 수익 미리보기 등).
 *   move : 후보 수 1개의 특징(종류·트랙·대상·보상·우주선 칸 등) + 맵 칸 인덱스(cell, 없으면 −1).
 *          정책망 = 후보 집합 소프트맥스(상태 임베딩 ⊕ 수 특징 → 로짓; cell로 격자 임베딩을 집어 쓸 수 있음).
 *
 * 어휘는 shared/gameConfig 정의에서 만든다(없는 id는 'other' 칸). 차원은 상수 — encoderDims()로 확인.
 * 정규화: 개수·자원은 대략 0~1 근처가 되게 나눈다(정확한 범위 아님, 학습 쪽에서 표준화 권장).
 */
import { BotAction } from '../ai/bot';
import { ServerGameState } from '../gameState';
import {
	ALL_BONUS_TILES, ROUND_MISSION_POOL, FINAL_MISSION_IDS, FEDERATION_REWARDS, SPACESHIP_FEDERATION_REWARDS, GLEENS_FEDERATION_REWARD,
	ARTIFACTS, INITIAL_POWER_ACTIONS, ALL_TECH_TILES, SHIP_TECH_TILES, ALL_ADVANCED_TECH_TILES, FACTIONS,
	getFederationEntries, getNextRoundIncomePreview, getDistance, getTerraformStepsForFaction,
} from '@shared/gameConfig';

// ── 어휘 ──
const vocab = (ids: string[]) => { const m = new Map<string, number>(); ids.forEach((id, i) => m.set(id, i)); return { m, n: ids.length + 1 }; }; // 마지막 = other
const idx = (v: { m: Map<string, number>; n: number }, id: any) => (id == null ? -1 : (v.m.get(String(id)) ?? v.n - 1));
const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
const V = {
	faction: vocab(FACTIONS.map(f => f.id)),
	bonus: vocab(ALL_BONUS_TILES.map(b => b.id)),
	mission: vocab(Array.from(new Set(ROUND_MISSION_POOL.map(m => m.id)))),
	final: vocab([...FINAL_MISSION_IDS]),
	fedReward: vocab([...FEDERATION_REWARDS.map(r => r.id), ...SPACESHIP_FEDERATION_REWARDS.map(r => r.id), GLEENS_FEDERATION_REWARD.id]),
	artifact: vocab(ARTIFACTS.map(a => a.id)),
	power: vocab(INITIAL_POWER_ACTIONS.map(a => a.id)),
	tech: vocab([...ALL_TECH_TILES.map(t => t.id), ...SHIP_TECH_TILES.map(t => t.id)]),
	adv: vocab(ALL_ADVANCED_TECH_TILES.map(t => t.id)),
	track: vocab(TRACKS),
	planet: vocab(['terra', 'oxide', 'volcanic', 'desert', 'swamp', 'titanium', 'ice', 'gaia', 'transdim', 'asteroid', 'proto', 'space', 'deep_space',
		'lost_planet', 'ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse']),
	structure: vocab(['mine', 'trading_station', 'research_lab', 'planetary_institute', 'academy', 'lost_planet_mine']),
	shipType: vocab(['ship_twilight', 'ship_rebellion', 'ship_tf_mars', 'ship_eclipse']),
	moveType: vocab(['build_mine', 'upgrade_structure', 'advance_research', 'use_power_action', 'use_tech_action', 'use_special_action', 'bescods_advance_lowest',
		'ambas_swap_pi_mine', 'firaks_downgrade', 'place_ivits_space_station', 'use_bonus_action', 'enter_spaceship', 'use_ship_action', 'take_twilight_artifact',
		'use_hadsch_hallas_pi_action', 'form_federation', 'place_gaiaformer', 'pass_round', 'end_turn', 'convert_resource', 'burn_power', 'bal_tak_gaiaformer_to_qic',
		'select_tech_tile', 'select_advanced_tech_tile', 'cover_advanced_tech_tile', 'advance_tech', 'eclipse_advance_track', 'eclipse_build_asteroid_mine',
		'confirm_twilight_federation', 'place_lost_planet', 'skip_tfmars_gaia_project', 'skip_ship_tech_mine', 'respond_power_offer']),
	upTarget: vocab(['trading_station', 'research_lab', 'planetary_institute', 'academy_left', 'academy_right']),
	special: vocab(['academy-qic', 'gleens-2nav', 'space_giants-2tf', 'tinkeroid-1qic', 'tinkeroid-1tf-mine', 'tinkeroid-2qic', 'tinkeroid-3k', 'tinkeroid-3tf-mine',
		'tinkeroid-4power', 'hh-4c-1qic', 'hh-3c-1o', 'hh-4c-1k', 'gaia_project', 'range_3', 'terraform_step']),
	convert: vocab(['1qic-to-1ore', '1ore-to-1credit', '1knowledge-to-1credit', '1power-to-1credit', '3power-to-1ore', '4power-to-1qic', '4power-to-1knowledge',
		'1ore-to-1token', '2power-to-1ore-1credit', '3power-to-2ore', '1brain-to-3credit', '1power-to-1k-gaiaformer']),
};

// ── 격자 ── (관측 범위 q −4..15, r 0..15에 여유)
const Q0 = -6, R0 = -2, W = 24, H = 20;
export const GRID_W = W, GRID_H = H;
const cellOf = (q: number, r: number) => { const x = q - Q0, y = r - R0; return (x < 0 || y < 0 || x >= W || y >= H) ? -1 : y * W + x; };
// 채널 배치
const CH = { exists: 0, planet: 1, owner: 1 + V.planet.n, structure: 0, gfOwn: 0, gfOther: 0, gaiaformed: 0, parasitic: 0, station: 0, satellite: 0, fed: 0, ring: 0, total: 0 };
CH.structure = CH.owner + 4; CH.gfOwn = CH.structure + V.structure.n; CH.gfOther = CH.gfOwn + 1; CH.gaiaformed = CH.gfOther + 1;
CH.parasitic = CH.gaiaformed + 1; CH.station = CH.parasitic + 4; CH.satellite = CH.station + 4; CH.fed = CH.satellite + 4; CH.ring = CH.fed + 4; CH.total = CH.ring + 1;

/** 관점 기준 좌석 순서(나 → 턴 순서상 다음 …). 4인 미만이면 빈 자리는 −1. */
export function seatOrder(game: ServerGameState, pov: string): string[] {
	const order = game.turnOrder?.length ? game.turnOrder : Object.keys(game.players);
	const i = Math.max(0, order.indexOf(pov));
	return [0, 1, 2, 3].map(k => order[(i + k) % order.length]).slice(0, Math.min(4, order.length));
}

class Buf {
	a: number[] = [];
	push(...x: number[]) { for (const v of x) this.a.push(Number.isFinite(v) ? v : 0); }
	onehot(n: number, i: number) { for (let k = 0; k < n; k++) this.a.push(k === i ? 1 : 0); }
	multihot(n: number, is: number[]) { const s = new Set(is); for (let k = 0; k < n; k++) this.a.push(s.has(k) ? 1 : 0); }
	counts(n: number, is: number[], scale = 1) { const c = new Array(n).fill(0); for (const i of is) if (i >= 0) c[i] += 1 / scale; this.a.push(...c); }
}

function encodePlayer(b: Buf, game: ServerGameState, pid: string | undefined) {
	const real: any = pid ? game.players[pid] : null;
	const p: any = real ?? {}; // 빈 좌석(3인 이하): 같은 길이로 인코딩한 뒤 0으로 덮는다
	const start = b.a.length;
	b.push(1);
	b.onehot(V.faction.n, idx(V.faction, p.faction));
	b.push((p.score ?? 0) / 100, (p.ore ?? 0) / 10, (p.credits ?? 0) / 20, (p.knowledge ?? 0) / 10, (p.qic ?? 0) / 5,
		(p.power1 ?? 0) / 10, (p.power2 ?? 0) / 10, (p.power3 ?? 0) / 10, p.brainStoneBowl ? p.brainStoneBowl / 3 : 0, p.brainStoneInGaia ? 1 : 0,
		(p.gaiaformers ?? 0) / 3, (p.gaiaformerPower ?? 0) / 6, (p.pendingTerraformSteps ?? 0) / 3, p.hasPassed ? 1 : 0, p.usedBonusAction ? 1 : 0,
		p.tempRangeBonus || p.rangeBonusActive ? 1 : 0);
	for (const t of TRACKS) b.push((p.research?.[t] ?? 0) / 5);
	const mine = game.map.filter(t => t.ownerId === pid && t.structure);
	b.counts(V.structure.n, mine.map(t => idx(V.structure, t.structure)), 4);
	b.multihot(V.tech.n, (p.techTiles ?? []).filter((t: string) => !t.startsWith('adv-')).map((t: string) => idx(V.tech, t)));
	b.multihot(V.adv.n, (p.techTiles ?? []).filter((t: string) => t.startsWith('adv-')).map((t: string) => idx(V.adv, t)));
	b.multihot(V.tech.n, (p.coveredTechTiles ?? []).map((t: string) => idx(V.tech, t)));
	b.multihot(V.tech.n, (p.usedTechActions ?? []).map((t: string) => idx(V.tech, t)));
	const feds = getFederationEntries(p);
	b.counts(V.fedReward.n, feds.map((f: any) => idx(V.fedReward, f.rewardId)), 2);
	b.push(feds.filter((f: any) => f.isGreen !== false).length / 3);
	b.onehot(V.bonus.n, idx(V.bonus, p.bonusTile));
	const entered: string[] = p.spaceshipsEntered ?? [];
	b.multihot(V.shipType.n, entered.map(id => idx(V.shipType, game.map.find(t => t.id === id)?.type)));
	b.multihot(V.artifact.n, (p.artifacts ?? []).map((a: string) => idx(V.artifact, a)));
	b.push((p.usedSpecialActions ?? []).length / 3, (p.factionBidVp ?? 0) / 20);
	let inc = { ore: 0, credits: 0, knowledge: 0, qic: 0, powerCharge: 0, powerTokens: 0 };
	if (real) { try { inc = getNextRoundIncomePreview(pid!, game as any); } catch { /* 미리보기 실패 = 0 */ } }
	b.push(inc.ore / 10, inc.credits / 20, inc.knowledge / 10, inc.qic / 3, inc.powerCharge / 10, inc.powerTokens / 5);
	if (!real) for (let k = start; k < b.a.length; k++) b.a[k] = 0;
}

/** 상태 인코딩 */
export function encodeState(game: ServerGameState, pov: string): { flat: number[]; grid: Float32Array } {
	const seats = seatOrder(game, pov);
	const rel = (pid: string | null | undefined) => (pid == null ? -1 : seats.indexOf(pid));
	const g: any = game;
	// grid
	const grid = new Float32Array(CH.total * H * W);
	const put = (ch: number, cell: number, v = 1) => { if (cell >= 0 && ch >= 0) grid[ch * H * W + cell] = v; };
	const fedOwner = new Map<string, number>();
	for (const [pid, hexes] of Object.entries<any>(g.playerFederationHexes ?? {})) for (const h of hexes ?? []) fedOwner.set(h, rel(pid));
	for (const t of game.map as any[]) {
		const c = cellOf(t.q, t.r); if (c < 0) continue;
		put(CH.exists, c);
		put(CH.planet + idx(V.planet, t.type), c);
		const o = rel(t.ownerId); if (o >= 0) put(CH.owner + o, c);
		if (t.structure) put(CH.structure + idx(V.structure, t.structure), c);
		if (t.hasGaiaformer) put(t.gaiaformerOwnerId === pov ? CH.gfOwn : CH.gfOther, c);
		if (t.isGaiaformed) put(CH.gaiaformed, c);
		const po = rel(t.parasiticMine?.ownerId); if (po >= 0) put(CH.parasitic + po, c);
		const so = rel(t.spaceStation?.ownerId); if (so >= 0) put(CH.station + so, c);
		for (const sp of (g.satellites?.[t.id] ?? []) as string[]) { const r = rel(sp); if (r >= 0) put(CH.satellite + r, c); }
		const fo = fedOwner.get(t.id); if (fo != null && fo >= 0) put(CH.fed + fo, c);
		if (t.moweyipRing) put(CH.ring, c);
	}
	// flat
	const b = new Buf();
	const round = game.roundNumber ?? 1;
	b.onehot(7, Math.min(6, round));
	b.push(game.hasDoneMainAction ? 1 : 0, (game.turnOrder[game.currentPlayerIndex] === pov) ? 1 : 0);
	b.onehot(4, rel(game.turnOrder[game.currentPlayerIndex]));
	for (let r = 0; r < 6; r++) b.onehot(V.mission.n, idx(V.mission, g.roundScoringTiles?.[r]?.id)); // 라운드별 미션(지난 라운드 포함 — 위치로 구분)
	b.multihot(V.final.n, (g.finalMissionIds ?? []).map((id: string) => idx(V.final, id)));
	b.push((g.economyVariant === 'vp') ? 1 : 0);
	b.multihot(V.power.n, ((g.powerActions ?? []) as any[]).filter(a => a.isUsed).map(a => idx(V.power, a.id)));
	b.multihot(V.bonus.n, ((g.availableBonusTiles ?? []) as any[]).map(x => idx(V.bonus, x.id)));
	// 트랙별 기술 타일(트랙 순서 고정) · 하단 풀 · 트랙별 고급 타일
	for (const tr of TRACKS) { const val = g.techTilesByTrack?.[tr]; const first = (Array.isArray(val) ? val : [val]).find((x: any) => x?.id); b.onehot(V.tech.n, idx(V.tech, first?.id)); }
	b.multihot(V.tech.n, ((g.techTilesPool ?? []) as any[]).filter(Boolean).map(t => idx(V.tech, t.id)));
	for (const tr of TRACKS) b.onehot(V.adv.n, idx(V.adv, g.advancedTechTilesByTrack?.[tr]?.id));
	for (const id of Array.from(V.fedReward.m.keys())) b.push((g.federationPool?.[id] ?? 0) / 3);
	// 우주선: 종류별 해금·탑승자(상대 좌석)·사용 칸
	for (const st of Array.from(V.shipType.m.keys())) {
		const tile = game.map.find(t => t.type === st); const s = tile ? g.spaceships?.[tile.id] : null;
		b.push(s?.unlocked ? 1 : 0);
		b.multihot(4, ((s?.occupants ?? []) as string[]).map(rel));
		b.multihot(3, ((s?.usedActionIndices ?? []) as number[]).map(i => i - 1));
	}
	b.multihot(V.artifact.n, ((g.twilightArtifactSlots ?? []) as any[]).filter(Boolean).map(s => idx(V.artifact, typeof s === 'string' ? s : s.id)));
	// 플레이어 4명
	for (let k = 0; k < 4; k++) encodePlayer(b, game, seats[k]);
	return { flat: b.a, grid };
}

/** 후보 수 인코딩: 특징 벡터 + 맵 칸(격자 인덱스, 없으면 −1) */
export function encodeMove(game: ServerGameState, pov: string, m: BotAction): { flat: number[]; cell: number } {
	const p: any = m.params ?? {};
	const b = new Buf();
	b.onehot(V.moveType.n, idx(V.moveType, m.type));
	// use_tech_action의 tileId는 맵 칸이 아니라 기술 타일 id
	const techActId = m.type === 'use_tech_action' ? p.tileId : null;
	const tileId = techActId ? null : (p.tileId ?? p.targetTileId ?? p.mineTileId ?? p.shipTileId);
	const tile: any = tileId ? game.map.find(t => t.id === tileId) : null;
	const cell = tile ? cellOf(tile.q, tile.r) : -1;
	b.onehot(V.planet.n, tile ? idx(V.planet, tile.type) : -1);
	// 칸 관련 비용 단서: 내 건물까지 거리·테라포밍 단계
	let dist = 0, steps = 0;
	if (tile) {
		const mine = game.map.filter(t => t.ownerId === pov && t.structure);
		dist = mine.length ? Math.min(...mine.map(t => getDistance(t, tile))) : 0;
		const fac = (game.players[pov] as any)?.faction;
		try { steps = fac && tile.type && !String(tile.type).startsWith('ship_') ? getTerraformStepsForFaction(game as any, fac, tile.type) : 0; } catch { steps = 0; }
	}
	b.push(tile ? 1 : 0, dist / 6, steps / 3);
	b.onehot(V.upTarget.n, p.target ? idx(V.upTarget, p.target) : -1);
	b.onehot(V.track.n, p.trackId ? idx(V.track, p.trackId) : -1);
	b.onehot(V.power.n, m.type === 'use_power_action' ? idx(V.power, p.actionId) : -1);
	b.onehot(V.special.n, (m.type === 'use_special_action' || m.type === 'use_hadsch_hallas_pi_action' || m.type === 'use_bonus_action') ? idx(V.special, p.actionId) : -1);
	b.onehot(V.bonus.n, p.bonusTileId ? idx(V.bonus, p.bonusTileId) : -1);
	b.onehot(V.fedReward.n, p.rewardId ? idx(V.fedReward, p.rewardId) : -1);
	b.push((p.spentTokens ?? 0) / 6, ((p.selectedPlanetIds ?? []) as any[]).length / 6);
	const shipTile = p.shipTileId ? game.map.find(t => t.id === p.shipTileId) : (m.type === 'enter_spaceship' ? tile : null);
	b.onehot(V.shipType.n, shipTile ? idx(V.shipType, shipTile.type) : -1);
	b.onehot(3, p.actionIndex ? p.actionIndex - 1 : -1);
	b.onehot(V.convert.n, m.type === 'convert_resource' ? idx(V.convert, p.type) : -1);
	const techId = p.techTileId ?? p.coverTileId ?? (techActId && !String(techActId).startsWith('adv-') ? techActId : null);
	b.onehot(V.tech.n, techId ? idx(V.tech, techId) : -1);
	const advId = p.advancedTileId ?? (techActId && String(techActId).startsWith('adv-') ? techActId : null);
	b.onehot(V.adv.n, advId ? idx(V.adv, advId) : -1);
	b.onehot(V.artifact.n, p.artifactId ? idx(V.artifact, p.artifactId) : -1);
	b.push(p.advanceToLevel5 ? 1 : 0, p.useBrain ? 1 : 0, p.useRangeBonus ? 1 : 0, (p.qicToUse ?? p.qicUsed ?? p.qicToSpend ?? 0) / 3);
	// 리치: 수락 여부 + 제안 크기·VP 비용
	if ((m.type as string) === 'respond_power_offer') {
		const o: any = (game.pendingPowerOffers ?? []).find(x => x.id === p.offerId);
		b.push(p.accept ? 1 : 0, (o?.amount ?? 0) / 5, (o?.vpCost ?? 0) / 4);
	} else b.push(0, 0, 0);
	return { flat: b.a, cell };
}

/** 차원 확인 */
export function encoderDims(game: ServerGameState, pov: string) {
	const pb = new Buf(); encodePlayer(pb, game, pov);
	const s = encodeState(game, pov);
	return { flat: s.flat.length, grid: [CH.total, H, W] as const, player: pb.a.length, move: encodeMove(game, pov, { type: 'pass_round', params: {} }).flat.length };
}
