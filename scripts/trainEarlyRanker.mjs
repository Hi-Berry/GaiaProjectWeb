// [R1-R2 전용 사람 모방 랭커] 2026-09-08. 배경: 사람 모방(통합 랭커·연구 랭커)이 실전에서 실패한 일반 원인은
// 공변량 이동(봇 결정의 절반이 사람 분포 밖) — R1~R2는 초기 상태가 거의 같아 이동이 최소인 구간이고, 스노우볼 게임이라
// 초반 결정의 가치가 가장 크다. 통합 랭커(v2, 40피처)와 달리 **자원 상태×후보타입 상호작용 피처**를 넣어
// "QIC 3개면 리벨#1, K 2개면 리벨#3" 같은 자원 조건부 선택을 학습한다. 소비 형태(직접-return 오버라이드)에 맞춰
// top-1 정확도와 **마진별 캘리브레이션**(오버라이드 임계 선택용)을 같이 낸다. 피처 순서는 bot.ts earlyRankerScores와 1:1.
// 실행: node scripts/trainEarlyRanker.mjs   (env: EARLY_MAX_ROUND=2 EARLY_EPOCHS=40 EARLY_SAVE=0)
import fs from 'fs';
const dir = 'data/human-games'; const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
const MAX_ROUND = Number(process.env.EARLY_MAX_ROUND || 2);
const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
const NONPLANET = new Set(['space', 'deep_space', 'transdim', 'lost_fleet_ship']);
const TYPES = ['build_mine', 'upgrade_structure', 'advance_research', 'use_power_action', 'use_ship_action', 'enter_spaceship', 'place_gaiaformer', 'use_tech_action', 'use_bonus_action', 'use_special_action', 'form_federation', 'take_twilight_artifact', 'convert_resource', 'pass_round', 'place_ivits_space_station'];
const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
const SHIPS = ['ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'];
const TARGETS = ['trading_station', 'research_lab', 'academy', 'planetary_institute'];
const pwCat = s => { s = (s || '').toLowerCase(); return /ore/.test(s) ? 0 : /credit/.test(s) ? 1 : /know/.test(s) ? 2 : /token/.test(s) ? 3 : /terraform|step|tf/.test(s) ? 4 : 5; };
const SHIP_LBL = [
  ['Rebellion: Gain tech tile', 'ship_rebellion', 1], ['Rebellion: Mine', 'ship_rebellion', 2], ['Rebellion: 2K', 'ship_rebellion', 3],
  ['Twilight: Federation benefit', 'ship_twilight', 1], ['Twilight: Spaceship Fed', 'ship_twilight', 1], ['Twilight: TS', 'ship_twilight', 2], ['Twilight: +3 Range', 'ship_twilight', 3],
  ['TF Mars: Tech tiles', 'ship_tf_mars', 1], ['TF Mars: Gaia Project', 'ship_tf_mars', 2], ['TF Mars: 3C', 'ship_tf_mars', 3],
  ['Eclipse: Planet types', 'ship_eclipse', 1], ['Eclipse: 2K+3P', 'ship_eclipse', 2], ['Eclipse: 6C', 'ship_eclipse', 3],
];
function matchTaken(e, cands, geom) {
  const a = e.action || '', d = (e.details || '').toLowerCase(), tid = e.tileId;
  const fi = (pred) => cands.findIndex(pred);
  if (a === 'Built Mine' || a === 'Built Mine on Asteroid') return fi(c => c.type === 'build_mine' && c.tileId === tid);
  if (/^Upgraded to Trading Station/.test(a)) return fi(c => c.type === 'upgrade_structure' && c.target === 'trading_station' && c.tileId === tid);
  if (/^Upgraded to Research Lab/.test(a)) return fi(c => c.type === 'upgrade_structure' && c.target === 'research_lab' && c.tileId === tid);
  if (/^Upgraded to Planetary/.test(a)) return fi(c => c.type === 'upgrade_structure' && c.target === 'planetary_institute' && c.tileId === tid);
  if (/^Upgraded to Academy/.test(a)) return fi(c => c.type === 'upgrade_structure' && String(c.target || '').startsWith('academy') && c.tileId === tid);
  if (a === 'Advanced Research') { const dd = d.replace(/\s/g, ''); return fi(c => c.type === 'advance_research' && dd.includes(String(c.trackId || '').toLowerCase())); }
  if (a === 'Power Action') return fi(c => c.type === 'use_power_action' && pwCat(c.actionId) === pwCat(d));
  if (a === 'Entered Ship') return fi(c => c.type === 'enter_spaceship' && (!tid || c.tileId === tid));
  if (a === 'Placed Gaiaformer') return fi(c => c.type === 'place_gaiaformer' && c.tileId === tid);
  if (a === 'Used Tech Action') return fi(c => c.type === 'use_tech_action' && (!tid || c.tileId === tid));
  if (a === 'Federation') return fi(c => c.type === 'form_federation');
  const sl = SHIP_LBL.find(([p]) => a.startsWith(p));
  if (sl) return fi(c => c.type === 'use_ship_action' && c.actionIndex === sl[2] && geom.get(c.shipTileId)?.type === sl[1]); // 정확 매칭만
  return -1;
}
// ── 피처 (bot.ts earlyRankerScores와 동일 순서) ──
const D_BASE = 15 + 1 + 4 + 6 + 1 + 6 + 4 + 3; // 40 (통합 랭커 v2와 동일)
const RES = ['credits', 'ore', 'knowledge', 'qic', 'power3']; const RES_NORM = [20, 10, 10, 5, 8];
const D = D_BASE + 4 /*enter ship type*/ + 1 /*enter: n entered*/ + TYPES.length * RES.length /*type×res 75*/ + 12 * 2 /*shipslot×(qic,K) 24*/ + TARGETS.length /*upgrade target 4*/;
function feat(c, ctx) {
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
const decisions = []; let gi = 0; let skippedNoMatch = 0, total = 0;
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')); } catch { continue; }
  if (!g.map || !g.actionJournal) continue; gi++;
  const geom = new Map(); for (const t of g.map) if (t.q != null) geom.set(t.id, { id: t.id, q: t.q, r: t.r, type: t.type });
  const owner = new Map(); const entered = {};
  for (const e of g.actionJournal) {
    const pid = e.playerId, act = e.action || '', tid = e.tileId; const round = e.round || 1;
    if (round <= MAX_ROUND && Array.isArray(e.candidates) && e.candidates.length >= 2 && e.playerBefore) {
      total++;
      const y = matchTaken(e, e.candidates, geom);
      if (y >= 0) {
        const mine = [...owner.entries()].filter(([, o]) => o === pid).map(([id]) => geom.get(id)).filter(Boolean);
        const ctx = { geom, mine, res: e.playerBefore.research || {}, r: e.playerBefore.resources || {}, round, nEntered: (entered[pid] || 0) };
        decisions.push({ cands: e.candidates.map(c => feat(c, ctx)), y, takenType: e.candidates[y].type, label: act.replace(/\s*\(.*$/, '').slice(0, 26), game: gi, round });
      } else skippedNoMatch++;
    }
    if (/Built Mine|Placed Starting Mine|Placed Mine|Placed Gaiaformer/i.test(act)) { if (tid) owner.set(tid, pid); }
    else if (/Upgraded to|Academy/i.test(act)) { if (tid && !owner.has(tid)) owner.set(tid, pid); }
    if (act === 'Entered Ship') entered[pid] = (entered[pid] || 0) + 1;
  }
}
console.log(`R<=${MAX_ROUND} 결정(후보 캡처) ${total}, 매칭 ${decisions.length}(${(decisions.length / total * 100).toFixed(0)}%), 피처 ${D}, 후보평균 ${(decisions.reduce((s, d) => s + d.cands.length, 0) / decisions.length).toFixed(1)}, 게임 ${gi}`);
const tr = [], va = []; decisions.forEach(d => ((d.game % 5 === 0) ? va : tr).push(d)); // 게임 단위 홀드아웃(20%)
const softmax = ss => { const mx = Math.max(...ss); const ex = ss.map(s => Math.exp(s - mx)); const Z = ex.reduce((a, b) => a + b, 0); return ex.map(x => x / Z); };
function train(set, epochs) {
  const w = new Float64Array(D); const m = new Float64Array(D), v = new Float64Array(D); const b1 = 0.9, b2 = 0.999, eps = 1e-8; let t = 0;
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const scores = d => d.cands.map(fv => { let s = 0; for (let k = 0; k < D; k++) s += w[k] * fv[k]; return s; });
  for (let ep = 0; ep < epochs; ep++) {
    const ord = set.map((_, i) => i); for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ord[i], ord[j]] = [ord[j], ord[i]]; }
    for (const idx of ord) {
      const d = set[idx]; const p = softmax(scores(d)); t++;
      const g = new Float64Array(D);
      for (let c = 0; c < d.cands.length; c++) { const coef = p[c] - (c === d.y ? 1 : 0); const fv = d.cands[c]; for (let k = 0; k < D; k++) g[k] += coef * fv[k]; }
      const lrt = 0.03 * Math.sqrt(1 - Math.pow(b2, t)) / (1 - Math.pow(b1, t));
      for (let k = 0; k < D; k++) { const gr = g[k] + 1e-4 * w[k]; m[k] = b1 * m[k] + (1 - b1) * gr; v[k] = b2 * v[k] + (1 - b2) * gr * gr; w[k] -= lrt * m[k] / (Math.sqrt(v[k]) + eps); }
    }
  }
  return w;
}
const EPOCHS = Number(process.env.EARLY_EPOCHS || 40);
const t0 = Date.now(); const w = train(tr, EPOCHS); console.log(`학습 ${tr.length}결정 ${EPOCHS}ep ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const scoreW = (W, d) => d.cands.map(fv => { let s = 0; for (let k = 0; k < D; k++) s += W[k] * fv[k]; return s; });
function evalSet(W, set) {
  const per = {}; let c1 = 0, rnd2 = 0, bot0 = 0; const cal = {}; const byLabel = {};
  for (const d of set) {
    const p = softmax(scoreW(W, d)); let bi = 0; for (let c = 1; c < p.length; c++) if (p[c] > p[bi]) bi = c;
    const sorted = [...p].sort((a, b) => b - a); const margin = sorted[0] - (sorted[1] ?? 0);
    per[d.takenType] = per[d.takenType] || { n: 0, hit: 0 }; per[d.takenType].n++;
    const hit = bi === d.y; if (hit) { c1++; per[d.takenType].hit++; }
    if (d.y === 0) bot0++;
    rnd2 += 1 / d.cands.length;
    const b = Math.min(9, Math.floor(margin * 10)); cal[b] = cal[b] || { n: 0, hit: 0, types: {} }; cal[b].n++; if (hit) cal[b].hit++;
    const pt = TYPES[d.cands[bi].findIndex((x, i) => i < 15 && x === 1)] || '?'; cal[b].types[pt] = (cal[b].types[pt] || 0) + 1;
    byLabel[d.label] = byLabel[d.label] || { n: 0, hit: 0 }; byLabel[d.label].n++; if (hit) byLabel[d.label].hit++;
  }
  return { t1: c1 / set.length, rand: rnd2 / set.length, bot0: bot0 / set.length, per, cal, byLabel, n: set.length };
}
const va2 = evalSet(w, va), tr2 = evalSet(w, tr);
console.log(`train ${tr.length} val ${va.length} | val top1 ${(va2.t1 * 100).toFixed(1)}% (무작위 ${(va2.rand * 100).toFixed(1)}%, 봇순서[0] ${(va2.bot0 * 100).toFixed(1)}%) | train ${(tr2.t1 * 100).toFixed(1)}%`);
{ const br={}; for(const d of va){ const p=softmax(scoreW(w,d)); let bi=0; for(let c=1;c<p.length;c++) if(p[c]>p[bi]) bi=c; const so=[...p].sort((a,b)=>b-a); const m=so[0]-(so[1]??0); br[d.round]=br[d.round]||{n:0,hit:0,hi:0,hiHit:0}; br[d.round].n++; if(bi===d.y) br[d.round].hit++; if(m>=0.5){br[d.round].hi++; if(bi===d.y) br[d.round].hiHit++;} } console.log('라운드별 val: '+Object.entries(br).map(([r,x])=>'R'+r+' n='+x.n+' top1 '+(x.hit/x.n*100).toFixed(0)+'% | 마진≥0.5 커버 '+(x.hi/x.n*100).toFixed(0)+'% 정확도 '+(x.hi?(x.hiHit/x.hi*100).toFixed(0):'-')+'%').join('  ||  ')); }
console.log('타입별 val top-1:'); Object.entries(va2.per).sort((a, b) => b[1].n - a[1].n).forEach(([k, x]) => console.log(`  ${k.padEnd(24)} n=${String(x.n).padStart(5)}  ${(x.hit / x.n * 100).toFixed(0)}%`));
console.log('라벨별 val top-1(상위):'); Object.entries(va2.byLabel).sort((a, b) => b[1].n - a[1].n).slice(0, 22).forEach(([k, x]) => console.log(`  ${k.padEnd(28)} n=${String(x.n).padStart(5)}  ${(x.hit / x.n * 100).toFixed(0)}%`));
console.log('마진(p1-p2) 구간별 val: 구간 | 비율 | 정확도 | 누적(>=) 비율/정확도 [top-1 타입 상위3]');
let cumN = 0, cumH = 0; const buckets = Object.keys(va2.cal).map(Number).sort((a, b) => b - a); const cum = {};
for (const b of buckets) { cumN += va2.cal[b].n; cumH += va2.cal[b].hit; cum[b] = { n: cumN, h: cumH }; }
for (const b of buckets.slice().reverse()) { const x = va2.cal[b]; const top = Object.entries(x.types).sort((a, c) => c[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(','); console.log(`  ${(b / 10).toFixed(1)}~ | ${(x.n / va2.n * 100).toFixed(1).padStart(5)}% | ${(x.hit / x.n * 100).toFixed(0).padStart(3)}% | >=: ${(cum[b].n / va2.n * 100).toFixed(1).padStart(5)}% / ${(cum[b].h / cum[b].n * 100).toFixed(0)}%  [${top}]`); }
// 임계별 타입 캘리브레이션(오버라이드 타입 게이트 선택용)
for (const th of [0.4, 0.5, 0.6]) {
  const per = {};
  for (const d of va) { const p = softmax(scoreW(w, d)); let bi = 0; for (let c = 1; c < p.length; c++) if (p[c] > p[bi]) bi = c; const so = [...p].sort((a, b) => b - a); if (so[0] - (so[1] ?? 0) < th) continue; const pt = TYPES[d.cands[bi].findIndex((x, i) => i < 15 && x === 1)] || '?'; per[pt] = per[pt] || { n: 0, hit: 0 }; per[pt].n++; if (bi === d.y) per[pt].hit++; }
  console.log('margin>=' + th + ' 타입별(top-1 타입 기준) n/정확도: ' + Object.entries(per).sort((a, b) => b[1].n - a[1].n).map(([k, x]) => k + ' ' + x.n + '/' + (x.hit / x.n * 100).toFixed(0) + '%').join(' | '));
}
if (process.env.EARLY_SAVE !== '0') {
  const wAll = train(decisions, EPOCHS);
  fs.writeFileSync('server/ai/earlyRanker.json', JSON.stringify({ version: 1, maxRound: MAX_ROUND, featDim: D, types: TYPES, tracks: TRACKS, ships: SHIPS, targets: TARGETS, res: RES, resNorm: RES_NORM, w: [...wAll] }));
  console.log('저장: server/ai/earlyRanker.json (전 데이터 재학습)');
}
