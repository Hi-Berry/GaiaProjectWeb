// [통합 후보 랭커 — MLP] trainCandidateRankerAll.mjs(선형 39피처)의 비선형 확장.
// 가설(DECISIONS 2026-07-25 기록): 통합 랭커는 "타입 one-hot이 지배해 공간피처가 눌린다" — 즉 필요한 건
//   '타입별로 다른 가중치'인데 선형 모델은 타입×피처 교호작용을 표현할 수 없다(가산만 가능).
//   MLP는 은닉 유닛이 타입 게이트 역할을 할 수 있으므로, 나선형 랭커 중 **비선형이 가장 도움될 후보**.
// 피처·데이터·라벨은 trainCandidateRankerAll.mjs와 1:1 동일 — 바뀌는 건 모델 클래스뿐.
//
// 평가: K-폴드 CV(기본 4) + ★비퇴화(non-degenerate) 지표 병기.
//   후보 피처가 전부 같은 결정(주로 use_ship_action 파라미터 미캡처분)은 어느 모델이든 '자동정답'이라
//   전체 top-1을 부풀린다(DECISIONS: ship 95%는 허수). 실력 판정은 비퇴화 부분집합으로 한다.
//
// 사용: node scripts/trainCandRankerMLP.mjs           (FOLDS=4 EPOCHS=60 기본)
import fs from 'fs';
const dir = 'data/human-games'; const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
const NONPLANET = new Set(['space', 'deep_space', 'transdim', 'lost_fleet_ship']);
const TYPES = ['build_mine', 'upgrade_structure', 'advance_research', 'use_power_action', 'use_ship_action', 'enter_spaceship', 'place_gaiaformer', 'use_tech_action', 'use_bonus_action', 'use_special_action', 'form_federation', 'take_twilight_artifact', 'convert_resource', 'pass_round', 'place_ivits_space_station'];
const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
const pwCat = s => { s = (s || '').toLowerCase(); return /ore/.test(s) ? 0 : /credit/.test(s) ? 1 : /know/.test(s) ? 2 : /token/.test(s) ? 3 : /terraform|step|tf/.test(s) ? 4 : 5; };
const SHIPS = ['ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'];
const SHIP_LBL = [
  ['Rebellion: Gain tech tile', 'ship_rebellion', 1], ['Rebellion: Mine', 'ship_rebellion', 2], ['Rebellion: 2K', 'ship_rebellion', 3],
  ['Twilight: Federation benefit', 'ship_twilight', 1], ['Twilight: Spaceship Fed', 'ship_twilight', 1], ['Twilight: TS', 'ship_twilight', 2], ['Twilight: +3 Range', 'ship_twilight', 3],
  ['TF Mars: Tech tiles', 'ship_tf_mars', 1], ['TF Mars: Gaia Project', 'ship_tf_mars', 2], ['TF Mars: 3C', 'ship_tf_mars', 3],
  ['Eclipse: Planet types', 'ship_eclipse', 1], ['Eclipse: 2K+3P', 'ship_eclipse', 2], ['Eclipse: 6C', 'ship_eclipse', 3],
];
function matchTaken(e, cands, geom) {
  const a = e.action || '', d = (e.details || '').toLowerCase(), tid = e.tileId;
  const fi = (pred) => cands.findIndex(pred);
  if (a === 'Built Mine') return fi(c => c.type === 'build_mine' && c.tileId === tid);
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
  if (sl) {
    const exact = fi(c => c.type === 'use_ship_action' && c.actionIndex === sl[2] && geom.get(c.shipTileId)?.type === sl[1]);
    return exact >= 0 ? exact : fi(c => c.type === 'use_ship_action');
  }
  if (/^Rebellion|^Twilight|^Eclipse|^TF Mars|^Ship Tech/.test(a)) return fi(c => c.type === 'use_ship_action');
  return -1;
}

const decisions = [];
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')) } catch { continue }
  if (!g.map || !g.actionJournal) continue;
  const geom = new Map(); for (const t of g.map) if (t.q != null) geom.set(t.id, { id: t.id, q: t.q, r: t.r, type: t.type, sector: t.sector });
  const owner = new Map();
  for (const e of g.actionJournal) {
    const pid = e.playerId, act = e.action || '', tid = e.tileId;
    if (Array.isArray(e.candidates) && e.candidates.length >= 2 && e.playerBefore) {
      const y = matchTaken(e, e.candidates, geom);
      if (y >= 0) {
        const mine = [...owner.entries()].filter(([, o]) => o === pid).map(([id]) => geom.get(id)).filter(Boolean);
        const res = e.playerBefore.research || {};
        const feats = e.candidates.map(c => {
          const fv = new Array(15 + 1 + 4 + 6 + 1 + 6 + 4 + 3).fill(0);
          const ti = TYPES.indexOf(c.type); if (ti >= 0) fv[ti] = 1;
          let off = 15;
          const tile = c.tileId ? geom.get(c.tileId) : null;
          fv[off] = tile ? 1 : 0; off += 1;
          if (tile && mine.length) {
            const dOwn = Math.min(...mine.map(m => dist(m, tile)));
            fv[off] = Math.min(dOwn, 9) / 9;
            fv[off + 1] = mine.filter(m => dist(m, tile) === 1).length / 6;
            fv[off + 2] = mine.filter(m => dist(m, tile) <= 2).length / 8;
            fv[off + 3] = (tile.type && !NONPLANET.has(tile.type) && !String(tile.type).startsWith('ship_')) ? 1 : 0;
          }
          off += 4;
          if (c.type === 'advance_research' && c.trackId) { const k = TRACKS.indexOf(c.trackId); if (k >= 0) fv[off + k] = (res[c.trackId] ?? 0) / 5 || 0.01; }
          off += 6;
          fv[off] = (e.round || 1) / 6; off += 1;
          if (c.type === 'use_power_action') fv[off + pwCat(c.actionId)] = 1;
          off += 6;
          if (c.type === 'use_ship_action' && c.shipTileId) {
            const st = geom.get(c.shipTileId)?.type; const si = SHIPS.indexOf(st);
            if (si >= 0) fv[off + si] = 1;
            if (c.actionIndex >= 1 && c.actionIndex <= 3) fv[off + 4 + (c.actionIndex - 1)] = 1;
          }
          return fv;
        });
        // 퇴화 판정: 후보 피처가 전부 동일하면 어느 모델이든 자동정답 → 실력 지표에서 제외
        const key0 = feats[0].join(',');
        const degenerate = feats.every(fv => fv.join(',') === key0);
        decisions.push({ cands: feats, y, takenType: e.candidates[y].type, degenerate });
      }
    }
    if (/Built Mine|Placed Starting Mine|Placed Mine|Placed Gaiaformer/i.test(act)) { if (tid) owner.set(tid, pid); }
    else if (/Upgraded to|Academy/i.test(act)) { if (tid && !owner.has(tid)) owner.set(tid, pid); }
  }
}
const D = decisions[0].cands[0].length;
const nDeg = decisions.filter(d => d.degenerate).length;
console.log(`통합 결정 ${decisions.length}, 피처 ${D}, 후보평균 ${(decisions.reduce((s, d) => s + d.cands.length, 0) / decisions.length).toFixed(1)}, 퇴화(자동정답) ${nDeg} (${(nDeg / decisions.length * 100).toFixed(1)}%)`);

const softmax = ss => { const mx = Math.max(...ss); const ex = ss.map(s => Math.exp(s - mx)); const Z = ex.reduce((a, b) => a + b, 0); return ex.map(x => x / Z); };
function mkRnd(seed0) { let seed = seed0; return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; }

function trainLinear(tr, { epochs = 60, lr = 0.05, l2 = 1e-4, seed = 12345 } = {}) {
  const w = new Float64Array(D); const m = new Float64Array(D), v = new Float64Array(D);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8; let t = 0; const rnd = mkRnd(seed);
  const sc = fv => { let s = 0; for (let k = 0; k < D; k++) s += w[k] * fv[k]; return s; };
  for (let ep = 0; ep < epochs; ep++) {
    const ord = tr.map((_, i) => i); for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[ord[i], ord[j]] = [ord[j], ord[i]]; }
    for (const idx of ord) {
      const d = tr[idx]; const p = softmax(d.cands.map(sc)); t++;
      const g = new Float64Array(D);
      for (let c = 0; c < d.cands.length; c++) { const coef = p[c] - (c === d.y ? 1 : 0); const fv = d.cands[c]; for (let k = 0; k < D; k++) g[k] += coef * fv[k]; }
      const lrt = lr * Math.sqrt(1 - Math.pow(b2, t)) / (1 - Math.pow(b1, t));
      for (let k = 0; k < D; k++) { const gr = g[k] + l2 * w[k]; m[k] = b1 * m[k] + (1 - b1) * gr; v[k] = b2 * v[k] + (1 - b2) * gr * gr; w[k] -= lrt * m[k] / (Math.sqrt(v[k]) + eps); }
    }
  }
  return { kind: 'linear', w: [...w], scoreOf: sc };
}

function trainMLP(tr, { H = 16, epochs = 60, lr = 0.02, l2 = 1e-3, seed = 12345, skip = false } = {}) {
  const rnd = mkRnd(seed);
  const gauss = () => { let u = 0, v2 = 0; while (u === 0) u = rnd(); while (v2 === 0) v2 = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v2); };
  const W1 = new Float64Array(H * D), b1v = new Float64Array(H), W2 = new Float64Array(H); let b2v = 0;
  const wLin = new Float64Array(D);
  for (let i = 0; i < H * D; i++) W1[i] = gauss() * Math.sqrt(1 / D);
  for (let i = 0; i < H; i++) W2[i] = gauss() * Math.sqrt(1 / H);
  const LIN0 = H * D + H + H + 1, P = LIN0 + D;
  const mAd = new Float64Array(P), vAd = new Float64Array(P); const B1 = 0.9, B2 = 0.999, eps = 1e-8; let t = 0;
  const fwd = fv => {
    const h = new Float64Array(H);
    for (let j = 0; j < H; j++) { let z = b1v[j]; const off = j * D; for (let k = 0; k < D; k++) z += W1[off + k] * fv[k]; h[j] = Math.tanh(z); }
    let s = b2v; for (let j = 0; j < H; j++) s += W2[j] * h[j];
    if (skip) for (let k = 0; k < D; k++) s += wLin[k] * fv[k];
    return { h, s };
  };
  for (let ep = 0; ep < epochs; ep++) {
    const ord = tr.map((_, i) => i); for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[ord[i], ord[j]] = [ord[j], ord[i]]; }
    for (const idx of ord) {
      const d = tr[idx];
      const fs2 = d.cands.map(fwd); const p = softmax(fs2.map(o => o.s)); t++;
      const g = new Float64Array(P);
      for (let c = 0; c < d.cands.length; c++) {
        const coef = p[c] - (c === d.y ? 1 : 0); if (coef === 0) continue;
        const { h } = fs2[c]; const fv = d.cands[c];
        for (let j = 0; j < H; j++) {
          g[H * D + H + j] += coef * h[j];
          const dpre = coef * W2[j] * (1 - h[j] * h[j]);
          g[H * D + j] += dpre;
          const off = j * D;
          for (let k = 0; k < D; k++) g[off + k] += dpre * fv[k];
        }
        g[LIN0 - 1] += coef;
        if (skip) for (let k = 0; k < D; k++) g[LIN0 + k] += coef * fv[k];
      }
      const lrt = lr * Math.sqrt(1 - Math.pow(B2, t)) / (1 - Math.pow(B1, t));
      const step = (i, cur, decay) => {
        const g2 = g[i] + decay * cur;
        mAd[i] = B1 * mAd[i] + (1 - B1) * g2; vAd[i] = B2 * vAd[i] + (1 - B2) * g2 * g2;
        return cur - lrt * mAd[i] / (Math.sqrt(vAd[i]) + eps);
      };
      for (let i = 0; i < H * D; i++) W1[i] = step(i, W1[i], l2);
      for (let j = 0; j < H; j++) b1v[j] = step(H * D + j, b1v[j], 0);
      for (let j = 0; j < H; j++) W2[j] = step(H * D + H + j, W2[j], l2);
      b2v = step(LIN0 - 1, b2v, 0);
      if (skip) for (let k = 0; k < D; k++) wLin[k] = step(LIN0 + k, wLin[k], 1e-4);
    }
  }
  return { kind: skip ? 'resmlp' : 'mlp', H, W1: [...W1], b1: [...b1v], W2: [...W2], b2: b2v, wLin: skip ? [...wLin] : null, scoreOf: fv => fwd(fv).s };
}

function evalSet(model, set) {
  let c1 = 0, n = 0, c1n = 0, nn = 0, rb = 0; const per = {};
  for (const d of set) {
    const ss = d.cands.map(model.scoreOf);
    let bi = 0; for (let c = 1; c < ss.length; c++) if (ss[c] > ss[bi]) bi = c;
    const hit = bi === d.y ? 1 : 0;
    c1 += hit; n++; rb += 1 / d.cands.length;
    if (!d.degenerate) { c1n += hit; nn++; per[d.takenType] = per[d.takenType] || { n: 0, hit: 0 }; per[d.takenType].n++; per[d.takenType].hit += hit; }
  }
  return { t1: c1 / n, nonDeg: nn ? c1n / nn : 0, nNon: nn, rand: rb / n, per };
}

const FOLDS = Number(process.env.FOLDS) || 4;
const EPOCHS = Number(process.env.EPOCHS) || 60;
// LONG=1: MLP가 60에폭에서 덜 학습된 것 아니냐는 반론 제거용 장기학습 대조(선형도 동일 에폭).
const configs = process.env.LONG === '1' ? [
  { name: 'linear', fn: tr => trainLinear(tr, { epochs: EPOCHS }) },
  { name: 'mlp H=16', fn: tr => trainMLP(tr, { H: 16, epochs: EPOCHS }) },
  { name: 'mlp H=32', fn: tr => trainMLP(tr, { H: 32, epochs: EPOCHS, l2: 3e-3 }) },
] : [
  { name: 'linear', fn: tr => trainLinear(tr, { epochs: EPOCHS }) },
  { name: 'mlp H=16', fn: tr => trainMLP(tr, { H: 16, epochs: EPOCHS }) },
  { name: 'res H=16', fn: tr => trainMLP(tr, { H: 16, epochs: EPOCHS, skip: true }) },
  { name: 'res H=32', fn: tr => trainMLP(tr, { H: 32, epochs: EPOCHS, l2: 3e-3, skip: true }) },
];
const acc = new Map(configs.map(c => [c.name, { all: [], non: [] }]));
const perLast = new Map();
for (let f = 0; f < FOLDS; f++) {
  const tr = [], va = [];
  decisions.forEach((d, i) => ((i % FOLDS === f) ? va : tr).push(d));
  const line = [];
  for (const c of configs) {
    const model = c.fn(tr);
    const V = evalSet(model, va);
    acc.get(c.name).all.push(V.t1); acc.get(c.name).non.push(V.nonDeg);
    if (f === FOLDS - 1) perLast.set(c.name, V.per);
    line.push(`${c.name} ${(V.t1 * 100).toFixed(1)}%/${(V.nonDeg * 100).toFixed(1)}%`);
  }
  console.log(`  fold ${f} (전체/비퇴화): ` + line.join(' | '));
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => { const m0 = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m0) ** 2, 0) / Math.max(1, a.length - 1)); };
const base = acc.get('linear');
console.log(`\n${FOLDS}-폴드 CV (EPOCHS=${EPOCHS})`);
console.log('모델         전체top1    비퇴화top1   비퇴화 선형대비(쌍대차 ± SE)');
for (const c of configs) {
  const r = acc.get(c.name);
  const diff = r.non.map((x, i) => x - base.non[i]);
  const dse = sd(diff) / Math.sqrt(FOLDS);
  console.log(`${c.name.padEnd(12)} ${(mean(r.all) * 100).toFixed(2)}%     ${(mean(r.non) * 100).toFixed(2)}%      ` +
    (c.name === 'linear' ? '(기준)' : `${mean(diff) >= 0 ? '+' : ''}${(mean(diff) * 100).toFixed(2)}%p ± ${(dse * 100).toFixed(2)}`));
}
console.log('\n마지막 폴드 타입별 비퇴화 top-1 (선형 → 최고 MLP):');
const bestMlp = configs.slice(1).sort((a, b) => mean(acc.get(b.name).non) - mean(acc.get(a.name).non))[0].name;
const pl = perLast.get('linear'), pm = perLast.get(bestMlp);
Object.entries(pl).sort((a, b) => b[1].n - a[1].n).slice(0, 10).forEach(([k, x]) => {
  const y = pm[k] || { n: 1, hit: 0 };
  console.log(`  ${k.padEnd(22)} n=${String(x.n).padStart(4)}  ${(x.hit / x.n * 100).toFixed(0)}% → ${(y.hit / y.n * 100).toFixed(0)}%  (${bestMlp})`);
});
console.log('\n게이트: 비퇴화 쌍대차 +2%p 이상 & > 2×SE 여야 봇 통합/h2h로 진행.');
