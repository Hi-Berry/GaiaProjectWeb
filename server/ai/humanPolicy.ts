/**
 * 사람 모방 정책(후보 랭커) — .claude/skills/gaia-ai-lab/scripts/humanPolicy/{build_dataset,train_policy}.py 와 1:1.
 *
 * 502판 사람 결정 74,716건(봇 후보 목록 중 사람이 고른 것)으로 학습한 후보 집합 softmax MLP.
 * 검증 top-1 40.9%(무작위 12.9%) — 전 결정을 맡길 정확도는 아니지만 "넓힌 후보 중 top-K 고르기"엔 충분
 * (마진 상위 12.6%에서 74.8%). 용도: getNextMove에서 후보를 프루닝해 MCTS 400ms가 희석되지 않게 한다.
 *
 * ★피처 순서·정규화는 build_dataset.py의 state_features/cand_features와 반드시 동일해야 한다
 *   (script/testHumanPolicyFeatures.ts가 파이썬 픽스처와 대조). 학습 데이터의 후보는 캡처 시 params가 평탄화되고
 *   preActions가 없었으므로 preActions 피처는 항상 0으로 둔다(분포 일치).
 */
import * as fs from 'fs';
import * as path from 'path';
import { getDistance } from '@shared/gameConfig';
import type { ServerGameState } from '../gameState';

export const TYPES = ['build_mine', 'upgrade_structure', 'advance_research', 'use_power_action', 'use_ship_action', 'enter_spaceship',
    'place_gaiaformer', 'use_tech_action', 'use_bonus_action', 'use_special_action', 'form_federation',
    'take_twilight_artifact', 'convert_resource', 'pass_round', 'place_ivits_space_station'];
const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
const SHIPS = ['ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'];
const TARGETS = ['trading_station', 'research_lab', 'academy', 'planetary_institute'];
const PLANETS = ['terra', 'desert', 'swamp', 'oxide', 'volcanic', 'titanium', 'ice', 'gaia', 'transdim', 'proto', 'asteroid', 'other'];
const PW_ACTIONS = ['gain-3-knowledge', 'gain-2-steps', 'gain-2-ore', 'gain-7-credits', 'gain-2-knowledge', 'gain-1-step', 'gain-2-tokens'];
const BONUS = ['bon-2c-terraform', 'bon-2c-1q', 'bon-1o-2tokens', 'bon-4c-gaia', 'bon-1o-mine', 'bon-1o-ts', 'bon-1k-lab',
    'bon-4pw-bigbuilding', 'bon-1o-planettype', 'bon-2pw-range3', 'bon-2pw-gaiaproject', 'bon-3c-bridge'];
const FACTIONS = ['terran', 'lantids', 'xenos', 'gleens', 'taklons', 'ambas', 'hadsch_hallas', 'ivits', 'geodens', 'bal_tak',
    'firaks', 'bescods', 'nevlas', 'itars', 'darkanians', 'moweyip', 'tinkeroids', 'space_giants', 'other'];
const NONPLANET = new Set(['space', 'deep_space', 'lost_fleet_ship']);
const STRUCT = ['mine', 'trading_station', 'research_lab', 'planetary_institute', 'academy'];
const TECH_KINDS = ['tech-inc-1o-1p', 'tech-inc-4c', 'tech-inc-1k-1c', 'tech-imm-7vp', 'tech-imm-1k-planet', 'tech-imm-1o-1q', 'tech-gaia-3vp', 'tech-big-4str', 'tech-act-4p'];
/** build_dataset.py replay에서 '메인 액션 수'에 안 세는 로그 라벨 */
const NON_MAIN = new Set(['Received Power', 'Free Actions', 'Power Burn', 'Selected Bonus', 'Income Order', 'Undo Free Action', 'Gained Tech Tile', 'Federation Reward']);

export const STATE_DIM = 66;
export const CAND_DIM = 69;
/** v2 확장(2026-09-18): 리플레이 복원 가능 정보 44개(상태)+2개(후보) 추가 — build_dataset.py FEATURE_VERSION=2 */
export const STATE_DIM_V2 = 110;
export const CAND_DIM_V2 = 71;
const PW_COST: Record<string, number> = { 'gain-3-knowledge': 7, 'gain-2-steps': 5, 'gain-2-ore': 4, 'gain-7-credits': 4, 'gain-2-knowledge': 4, 'gain-1-step': 3, 'gain-2-tokens': 3 };

type Model = { hidden: number; state_dim: number; cand_dim: number; weights: Record<string, number[][] | number[]>; val_top1?: number; meta?: { feature_version?: number } };
const _models: Record<string, Model | null> = {};
/** 모델 파일 로드(캐시). version 1 = humanPolicy.json(66/69), 2 = humanPolicy.v2.json(110/71). */
export function loadHumanPolicy(version: 1 | 2 = 1): Model | null {
    const key = String(version);
    if (key in _models) return _models[key];
    try {
        const p = path.resolve(process.cwd(), version === 2 ? 'server/ai/humanPolicy.v2.json' : 'server/ai/humanPolicy.json');
        const m: Model = JSON.parse(fs.readFileSync(p, 'utf8'));
        const [sd, cd] = version === 2 ? [STATE_DIM_V2, CAND_DIM_V2] : [STATE_DIM, CAND_DIM];
        _models[key] = (m && m.state_dim === sd && m.cand_dim === cd) ? m : null;
    } catch { _models[key] = null; }
    return _models[key];
}

function onehot(list: string[], v: string | undefined | null): number[] {
    const f = new Array(list.length).fill(0);
    if (v != null && list.includes(v)) f[list.indexOf(v)] = 1;
    else if (list[list.length - 1] === 'other') f[list.length - 1] = 1;
    return f;
}
const clip = (x: number, hi: number) => Math.min(hi, x);

export type HPCandidate = { type: string; params?: Record<string, any>; preActions?: unknown[] };

/** 결정 시점 컨텍스트(파이썬 ctx와 동일 의미) */
export type HPContext = {
    round: number;
    my: { id: string; q: number; r: number; type?: string; sector?: number; structure?: string }[];
    others: { q: number; r: number; structure?: string }[];
    mySectors: Set<number | undefined>;
    enteredCount: number;
    slotsUsedThisRound: number;
    myActionsThisRound: number;
    // v2
    myScore: number;
    powerUsed: Set<string>;
    techTaken: Record<string, number>;
    advTaken: number;
    othersFeds: number;
    othersBoosters: Set<string>;
    othersVp: number[];
    othersRes: { o: number; c: number; k: number; q: number; p3: number }[];
    othersPassed: number;
    myTypes: Set<string | undefined>;
};

export function buildContext(game: ServerGameState, playerId: string): HPContext {
    const player = game.players[playerId];
    const my = game.map.filter(t => t.ownerId === playerId && t.structure).map(t => ({ id: t.id, q: t.q, r: t.r, type: t.type, sector: t.sector, structure: t.structure as string }));
    const others = game.map.filter(t => t.ownerId && t.ownerId !== playerId && t.structure).map(t => ({ q: t.q, r: t.r, structure: t.structure as string }));
    const round = game.roundNumber ?? 1;
    let slots = 0;
    for (const st of Object.values(game.spaceships ?? {})) slots += (st as any)?.usedActionIndices?.length ?? 0;
    let myActs = 0;
    for (const e of game.gameLog ?? []) {
        if ((e as any).playerId === playerId && ((e as any).round ?? 0) === round && !NON_MAIN.has((e as any).action)) myActs++;
    }
    // v2: 리플레이 복원 정보의 라이브 대응값
    const powerUsed = new Set<string>((game.powerActions ?? []).filter((a: any) => a.isUsed).map((a: any) => a.id));
    const remaining: Record<string, number> = {};
    for (const arr of [...Object.values(game.techTilesByTrack ?? {}), game.techTilesPool ?? []]) {
        for (const t of (Array.isArray(arr) ? arr : [arr]) as any[]) if (t?.id) remaining[t.id] = (remaining[t.id] ?? 0) + 1;
    }
    const techTaken: Record<string, number> = {};
    for (const k of TECH_KINDS) techTaken[k] = Math.max(0, 4 - (remaining[k] ?? 0));
    const opps: any[] = Object.entries(game.players).filter(([id]) => id !== playerId).map(([, p]) => p);
    const advTaken = Object.values(game.players).reduce((n, p: any) => n + (p.techTiles ?? []).filter((t: string) => String(t).startsWith('adv-')).length, 0);
    return {
        round, my, others, mySectors: new Set(my.map(t => t.sector)),
        enteredCount: (player?.spaceshipsEntered ?? []).length, slotsUsedThisRound: slots, myActionsThisRound: myActs,
        myScore: player?.score ?? 0, powerUsed, techTaken, advTaken,
        othersFeds: opps.reduce((n, p) => n + (p.federations ?? []).length, 0),
        othersBoosters: new Set(opps.map(p => p.bonusTile).filter(Boolean)),
        othersVp: opps.map(p => p.score ?? 0),
        othersRes: opps.map(p => ({ o: p.ore ?? 0, c: p.credits ?? 0, k: p.knowledge ?? 0, q: p.qic ?? 0, p3: p.power3 ?? 0 })),
        othersPassed: opps.filter(p => p.hasPassed).length,
        myTypes: new Set(my.map(t => t.type)),
    };
}

/** v2 상태 피처 = v1 66 + 44 (build_dataset.py state_features v2 블록과 동일 순서) */
export function stateFeaturesV2(game: ServerGameState, playerId: string, ctx: HPContext): number[] {
    const f = stateFeatures(game, playerId, ctx);
    f.push(Math.min(3, ctx.myScore / 100));
    for (const a of PW_ACTIONS) f.push(ctx.powerUsed.has(a) ? 1 : 0);
    for (const k of TECH_KINDS) f.push(Math.min(4, ctx.techTaken[k] ?? 0) / 4);
    f.push(Math.min(7, ctx.advTaken) / 7);
    const oc: Record<string, number> = { mine: 0, trading_station: 0, research_lab: 0, planetary_institute: 0, academy: 0 };
    for (const t of ctx.others) if (t.structure && t.structure in oc) oc[t.structure]++;
    f.push(oc.mine / 24, oc.trading_station / 12, oc.research_lab / 9, oc.planetary_institute / 3, oc.academy / 6);
    f.push(Math.min(15, ctx.othersFeds) / 15);
    for (const b of BONUS) f.push(ctx.othersBoosters.has(b) ? 1 : 0);
    const mx = ctx.othersVp.length ? Math.max(...ctx.othersVp) : 0;
    f.push(Math.min(3, mx / 100)); f.push(Math.max(-2, Math.min(2, (ctx.myScore - mx) / 50)));
    const n = Math.max(1, ctx.othersRes.length);
    for (const [key, norm] of [['o', 10], ['c', 20], ['k', 10], ['q', 5], ['p3', 8]] as [keyof HPContext['othersRes'][0], number][])
        f.push(Math.min(2, ctx.othersRes.reduce((s, x) => s + (x[key] ?? 0), 0) / n / norm));
    f.push(Math.min(3, ctx.othersPassed) / 3);
    return f;
}

/** v2 후보 피처 = v1 69 + 2 */
export function candFeaturesV2(game: ServerGameState, playerId: string, c: HPCandidate, ctx: HPContext): number[] {
    const f = candFeatures(game, playerId, c, ctx);
    const prm = c.params ?? {};
    const tile = prm.tileId ? game.map.find(t => t.id === prm.tileId) : undefined;
    const ttype = tile?.type;
    f.push(c.type === 'build_mine' && ttype && !ctx.myTypes.has(ttype) ? 1 : 0);
    f.push(c.type === 'use_power_action' ? (PW_COST[String(prm.actionId)] ?? 0) / 7 : 0);
    return f;
}

export function stateFeatures(game: ServerGameState, playerId: string, ctx: HPContext): number[] {
    const p: any = game.players[playerId];
    const f: number[] = [ctx.round / 6];
    const res: [string, number][] = [['credits', 20], ['ore', 10], ['knowledge', 10], ['qic', 5], ['power1', 8], ['power2', 8], ['power3', 8]];
    for (const [k, n] of res) f.push(clip((p[k] ?? 0) / n, 2.0));
    for (const t of TRACKS) f.push((p.research?.[t] ?? 0) / 5);
    const tiles: string[] = p.techTiles ?? [];
    f.push(tiles.length / 9, tiles.filter(t => String(t).startsWith('adv-')).length / 3);
    for (const t of TECH_KINDS) f.push(tiles.includes(t) ? 1 : 0);
    const feds: any[] = p.federations ?? [];
    f.push(feds.length / 5);
    const greens = feds.filter(x => (x && typeof x === 'object' && x.isGreen) || (typeof x === 'string' && x.includes('fed'))).length;
    f.push(Math.min(2, greens) / 2);
    f.push(...onehot(BONUS, p.bonusTile));
    f.push(...onehot(FACTIONS, p.faction));
    const cnt: Record<string, number> = { mine: 0, trading_station: 0, research_lab: 0, planetary_institute: 0, academy: 0 };
    for (const t of ctx.my) if (t.structure && t.structure in cnt) cnt[t.structure]++;
    f.push(cnt.mine / 8, cnt.trading_station / 4, cnt.research_lab / 3, cnt.planetary_institute, cnt.academy / 2);
    f.push(ctx.enteredCount / 3, Math.min(4, ctx.slotsUsedThisRound) / 4, Math.min(6, ctx.myActionsThisRound) / 6);
    return f;
}

export function candFeatures(game: ServerGameState, playerId: string, c: HPCandidate, ctx: HPContext): number[] {
    const p: any = game.players[playerId];
    const prm = c.params ?? {};
    const f: number[] = onehot(TYPES, c.type);
    const tile = prm.tileId ? game.map.find(t => t.id === prm.tileId) : undefined;
    if (tile && ctx.my.length) {
        const ds = ctx.my.map(m => getDistance(m as any, tile));
        const dOwn = Math.min(...ds);
        f.push(1, Math.min(dOwn, 9) / 9, ds.filter(x => x === 1).length / 6, ds.filter(x => x <= 2).length / 8);
    } else f.push(0, 0, 0, 0);
    const ttype = tile?.type;
    f.push(...onehot(PLANETS, (ttype && !NONPLANET.has(ttype) && !String(ttype).startsWith('ship_')) ? ttype : 'other'));
    if (tile) {
        f.push(Math.min(4, ctx.others.filter(o => getDistance(o as any, tile) <= 2).length) / 4);
        f.push(ctx.mySectors.has(tile.sector) ? 0 : 1);
    } else f.push(0, 0);
    const trk: string | undefined = prm.trackId;
    f.push(...onehot(TRACKS, trk));
    f.push(trk ? (p.research?.[trk] ?? 0) / 5 : 0);
    f.push(...(c.type === 'use_power_action' ? onehot(PW_ACTIONS, prm.actionId) : new Array(PW_ACTIONS.length).fill(0)));
    const stype = prm.shipTileId ? game.map.find(t => t.id === prm.shipTileId)?.type : undefined;
    f.push(...onehot(SHIPS, stype));
    for (const k of [1, 2, 3]) f.push(c.type === 'use_ship_action' && prm.actionIndex === k ? 1 : 0);
    f.push(...(c.type === 'enter_spaceship' && tile ? onehot(SHIPS, tile.type) : [0, 0, 0, 0]));
    for (const t of TARGETS) f.push(c.type === 'upgrade_structure' && String(prm.target ?? '').startsWith(t) ? 1 : 0);
    const cur = prm.tileId ? ctx.my.find(m => m.id === prm.tileId)?.structure : undefined;
    f.push(...onehot([...STRUCT, 'other'], cur ?? 'other'));
    f.push(0); // preActions 피처 — 학습 데이터(캡처)에 없었으므로 항상 0
    return f;
}

function matvec(W: number[][], b: number[], x: number[], relu: boolean): number[] {
    const out = new Array(W.length);
    for (let i = 0; i < W.length; i++) {
        let s = b[i]; const row = W[i];
        for (let j = 0; j < row.length; j++) s += row[j] * x[j];
        out[i] = relu && s < 0 ? 0 : s;
    }
    return out;
}

/** 후보별 softmax 확률(모델 없으면 null). */
export function humanPolicyProbs(game: ServerGameState, playerId: string, cands: HPCandidate[], version: 1 | 2 = 1): number[] | null {
    const m = loadHumanPolicy(version);
    if (!m || cands.length === 0) return null;
    const W = m.weights as any;
    const ctx = buildContext(game, playerId);
    const s = version === 2 ? stateFeaturesV2(game, playerId, ctx) : stateFeatures(game, playerId, ctx);
    const logits = cands.map(c => {
        const x = s.concat(version === 2 ? candFeaturesV2(game, playerId, c, ctx) : candFeatures(game, playerId, c, ctx));
        const h1 = matvec(W['net.0.weight'], W['net.0.bias'], x, true);
        const h2 = matvec(W['net.2.weight'], W['net.2.bias'], h1, true);
        return matvec(W['net.4.weight'], W['net.4.bias'], h2, false)[0];
    });
    const mx = Math.max(...logits);
    const ex = logits.map(l => Math.exp(l - mx)); const z = ex.reduce((a, b) => a + b, 0);
    return ex.map(e => e / z);
}

/** 정책 확률 상위 K개만 남긴다(pass_round·연방은 항상 유지 — 룰상 안전판). 순서는 확률 내림차순. */
export function pruneByHumanPolicy<T extends HPCandidate>(game: ServerGameState, playerId: string, cands: T[], k: number, version: 1 | 2 = 1): { kept: T[]; probs: number[] } | null {
    const probs = humanPolicyProbs(game, playerId, cands, version);
    if (!probs) return null;
    const idx = cands.map((_, i) => i).sort((a, b) => probs[b] - probs[a]);
    const keep = new Set(idx.slice(0, k));
    cands.forEach((c, i) => { if (c.type === 'pass_round' || c.type === 'form_federation') keep.add(i); });
    const kept = idx.filter(i => keep.has(i)).map(i => cands[i]);
    return { kept, probs: idx.filter(i => keep.has(i)).map(i => probs[i]) };
}
