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

type Model = { hidden: number; state_dim: number; cand_dim: number; weights: Record<string, number[][] | number[]>; val_top1?: number };
let _model: Model | null | undefined;
export function loadHumanPolicy(): Model | null {
    if (_model !== undefined) return _model;
    try {
        const p = path.resolve(process.cwd(), 'server/ai/humanPolicy.json');
        _model = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!_model || _model.state_dim !== STATE_DIM || _model.cand_dim !== CAND_DIM) { _model = null; }
    } catch { _model = null; }
    return _model;
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
    others: { q: number; r: number }[];
    mySectors: Set<number | undefined>;
    enteredCount: number;
    slotsUsedThisRound: number;
    myActionsThisRound: number;
};

export function buildContext(game: ServerGameState, playerId: string): HPContext {
    const player = game.players[playerId];
    const my = game.map.filter(t => t.ownerId === playerId && t.structure).map(t => ({ id: t.id, q: t.q, r: t.r, type: t.type, sector: t.sector, structure: t.structure as string }));
    const others = game.map.filter(t => t.ownerId && t.ownerId !== playerId && t.structure).map(t => ({ q: t.q, r: t.r }));
    const round = game.roundNumber ?? 1;
    let slots = 0;
    for (const st of Object.values(game.spaceships ?? {})) slots += (st as any)?.usedActionIndices?.length ?? 0;
    let myActs = 0;
    for (const e of game.gameLog ?? []) {
        if ((e as any).playerId === playerId && ((e as any).round ?? 0) === round && !NON_MAIN.has((e as any).action)) myActs++;
    }
    return {
        round, my, others, mySectors: new Set(my.map(t => t.sector)),
        enteredCount: (player?.spaceshipsEntered ?? []).length, slotsUsedThisRound: slots, myActionsThisRound: myActs,
    };
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
export function humanPolicyProbs(game: ServerGameState, playerId: string, cands: HPCandidate[]): number[] | null {
    const m = loadHumanPolicy();
    if (!m || cands.length === 0) return null;
    const W = m.weights as any;
    const ctx = buildContext(game, playerId);
    const s = stateFeatures(game, playerId, ctx);
    const logits = cands.map(c => {
        const x = s.concat(candFeatures(game, playerId, c, ctx));
        const h1 = matvec(W['net.0.weight'], W['net.0.bias'], x, true);
        const h2 = matvec(W['net.2.weight'], W['net.2.bias'], h1, true);
        return matvec(W['net.4.weight'], W['net.4.bias'], h2, false)[0];
    });
    const mx = Math.max(...logits);
    const ex = logits.map(l => Math.exp(l - mx)); const z = ex.reduce((a, b) => a + b, 0);
    return ex.map(e => e / z);
}

/** 정책 확률 상위 K개만 남긴다(pass_round·연방은 항상 유지 — 룰상 안전판). 순서는 확률 내림차순. */
export function pruneByHumanPolicy<T extends HPCandidate>(game: ServerGameState, playerId: string, cands: T[], k: number): { kept: T[]; probs: number[] } | null {
    const probs = humanPolicyProbs(game, playerId, cands);
    if (!probs) return null;
    const idx = cands.map((_, i) => i).sort((a, b) => probs[b] - probs[a]);
    const keep = new Set(idx.slice(0, k));
    cands.forEach((c, i) => { if (c.type === 'pass_round' || c.type === 'form_federation') keep.add(i); });
    const kept = idx.filter(i => keep.has(i)).map(i => cands[i]);
    return { kept, probs: idx.filter(i => keep.has(i)).map(i => probs[i]) };
}
