// 후보 랭커 공용 피처 (148) — bot.ts earlyRankerScores와 *동일 순서/정규화* 필수. trainEarlyRanker(사람 R1~R2)와
// trainSelfRanker(자가대국 고득점 좌석)가 같은 피처를 쓰므로 봇 쪽은 모델 파일만 바꿔 같은 코드로 점수를 낸다.
export const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
export const NONPLANET = new Set(['space', 'deep_space', 'transdim', 'lost_fleet_ship']);
export const TYPES = ['build_mine', 'upgrade_structure', 'advance_research', 'use_power_action', 'use_ship_action', 'enter_spaceship', 'place_gaiaformer', 'use_tech_action', 'use_bonus_action', 'use_special_action', 'form_federation', 'take_twilight_artifact', 'convert_resource', 'pass_round', 'place_ivits_space_station'];
export const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
export const SHIPS = ['ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'];
export const TARGETS = ['trading_station', 'research_lab', 'academy', 'planetary_institute'];
export const RES = ['credits', 'ore', 'knowledge', 'qic', 'power3']; export const RES_NORM = [20, 10, 10, 5, 8];
export const pwCat = s => { s = (s || '').toLowerCase(); return /ore/.test(s) ? 0 : /credit/.test(s) ? 1 : /know/.test(s) ? 2 : /token/.test(s) ? 3 : /terraform|step|tf/.test(s) ? 4 : 5; };
const D_BASE = 15 + 1 + 4 + 6 + 1 + 6 + 4 + 3; // 40 (통합 랭커 v2와 동일)
export const D = D_BASE + 4 + 1 + TYPES.length * RES.length + 12 * 2 + TARGETS.length; // 148

/** c: 압축 후보 {type, tileId, target, trackId, actionId, shipTileId, actionIndex}
 *  ctx: { geom: Map<tileId,{q,r,type}>, mine: [{q,r}] 내 구조물, res: research, r: resources, round, nEntered } */
export function feat(c, ctx) {
  const f = new Float64Array(D);
  const ti = TYPES.indexOf(c.type); if (ti >= 0) f[ti] = 1;
  let off = 15;
  const tile = c.tileId ? ctx.geom.get(c.tileId) : null;
  f[off] = tile ? 1 : 0; off += 1;
  if (tile && ctx.mine.length) {
    const dOwn = Math.min(...ctx.mine.map(m => dist(m, tile)));
    f[off] = Math.min(dOwn, 9) / 9; f[off + 1] = ctx.mine.filter(m => dist(m, tile) === 1).length / 6; f[off + 2] = ctx.mine.filter(m => dist(m, tile) <= 2).length / 8;
    f[off + 3] = (tile.type && !NONPLANET.has(tile.type) && !String(tile.type).startsWith('ship_')) ? 1 : 0;
  }
  off += 4;
  if (c.type === 'advance_research' && c.trackId) { const k = TRACKS.indexOf(c.trackId); if (k >= 0) f[off + k] = (ctx.res[c.trackId] ?? 0) / 5 || 0.01; }
  off += 6;
  f[off] = ctx.round / 6; off += 1;
  if (c.type === 'use_power_action') f[off + pwCat(c.actionId)] = 1; off += 6;
  let si = -1, slot = -1;
  if (c.type === 'use_ship_action' && c.shipTileId) { si = SHIPS.indexOf(ctx.geom.get(c.shipTileId)?.type); if (si >= 0) f[off + si] = 1; if (c.actionIndex >= 1 && c.actionIndex <= 3) { slot = c.actionIndex - 1; f[off + 4 + slot] = 1; } }
  off += 7; // == D_BASE
  if (c.type === 'enter_spaceship' && c.tileId) { const es = SHIPS.indexOf(tile?.type); if (es >= 0) f[off + es] = 1; }
  off += 4;
  if (c.type === 'enter_spaceship') f[off] = ctx.nEntered / 3; off += 1;
  if (ti >= 0) for (let r = 0; r < RES.length; r++) f[off + ti * RES.length + r] = Math.min(1.5, (ctx.r[RES[r]] ?? 0) / RES_NORM[r]);
  off += TYPES.length * RES.length;
  if (si >= 0 && slot >= 0) { const k = si * 3 + slot; f[off + k * 2] = Math.min(1.5, (ctx.r.qic ?? 0) / 5); f[off + k * 2 + 1] = Math.min(1.5, (ctx.r.knowledge ?? 0) / 10); }
  off += 24;
  if (c.type === 'upgrade_structure') { const k = TARGETS.findIndex(t => String(c.target || '').startsWith(t)); if (k >= 0) f[off + k] = 1; }
  off += 4;
  if (off !== D) throw new Error('feat dim mismatch ' + off + ' vs ' + D);
  return f;
}

export const softmax = ss => { const mx = Math.max(...ss); const ex = ss.map(s => Math.exp(s - mx)); const Z = ex.reduce((a, b) => a + b, 0); return ex.map(x => x / Z); };

/** 소프트맥스 리스트와이즈 Adam 학습. set: [{cands:[Float64Array], y, w?}] (w=샘플 가중치, 기본 1) */
export function trainSoftmax(set, epochs, lr = 0.03, seed0 = 12345) {
  const w = new Float64Array(D); const m = new Float64Array(D), v = new Float64Array(D); const b1 = 0.9, b2 = 0.999, eps = 1e-8; let t = 0;
  let seed = seed0; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const scores = d => d.cands.map(fv => { let s = 0; for (let k = 0; k < D; k++) s += w[k] * fv[k]; return s; });
  for (let ep = 0; ep < epochs; ep++) {
    const ord = set.map((_, i) => i); for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ord[i], ord[j]] = [ord[j], ord[i]]; }
    for (const idx of ord) {
      const d = set[idx]; const p = softmax(scores(d)); t++; const sw = d.w ?? 1;
      const g = new Float64Array(D);
      for (let c = 0; c < d.cands.length; c++) { const coef = (p[c] - (c === d.y ? 1 : 0)) * sw; const fv = d.cands[c]; for (let k = 0; k < D; k++) g[k] += coef * fv[k]; }
      const lrt = lr * Math.sqrt(1 - Math.pow(b2, t)) / (1 - Math.pow(b1, t));
      for (let k = 0; k < D; k++) { const gr = g[k] + 1e-4 * w[k]; m[k] = b1 * m[k] + (1 - b1) * gr; v[k] = b2 * v[k] + (1 - b2) * gr * gr; w[k] -= lrt * m[k] / (Math.sqrt(v[k]) + eps); }
    }
  }
  return w;
}
export const scoreW = (W, d) => d.cands.map(fv => { let s = 0; for (let k = 0; k < D; k++) s += W[k] * fv[k]; return s; });
