// [배치 랭커 v4 — MLP] v3(11피처 선형 softmax 랭커)의 비선형 확장.
// 동기(2026-08-03): 가중치 튜닝 r-series 소진(r4 0.00 / r5 wash) → 다음 레버 = 아키텍처.
//   가치망 MLP는 7월 kill-gate로 NO-GO 확정(재탕)이지만, 랭커는 (a)실제 채택된 유일한 학습경로
//   (placementPolicyV3 +1.23@120) (b)오프라인 게이트(val top-1)로 h2h 전에 싸게 판정 가능.
// 피처·데이터·라벨은 trainCandidateRankerTileV3.mjs와 **완전 동일**(11피처) — 바뀌는 건 모델 클래스뿐.
//   → 선형 대비 이득이 나오면 그건 순수 '비선형 용량'의 효과.
//
// ★평가는 7-폴드 CV(홀드아웃 i%7==f 회전). 단일 split(val 319건)은 ±2.7%p SE라 선택 노이즈가 커서
//   "H를 여러 개 돌려 제일 좋은 것"이 winner's curse가 된다(스킬 원칙4). 폴드 평균 ± SE로 판정.
//
// 사용:
//   node scripts/trainPlacementMLP.mjs                 # CV 비교(선형 vs MLP 여러 H)
//   H=16 SAVE=1 node scripts/trainPlacementMLP.mjs     # 전체 데이터로 재학습 후 저장
import fs from 'fs';

const dir = 'data/human-games'; const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
const NONPLANET = new Set(['space', 'deep_space', 'transdim', 'lost_fleet_ship']);
const isPlanet = t => !!t.type && !NONPLANET.has(t.type) && !String(t.type).startsWith('ship_');
const powOf = s => s === 'gaiaformer' ? 0 : s === 'mine' ? 1 : (s === 'trading_station' || s === 'research_lab') ? 2 : (s === 'planetary_institute' || s === 'academy') ? 3 : 1;

function clusterPowerAt(tile, myTiles, radius) {
  const seen = new Set(); let total = 1; const queue = [tile];
  while (queue.length) {
    const cur = queue.shift();
    for (const m of myTiles) {
      if (seen.has(m.id)) continue;
      if (dist(cur, m) <= radius) { seen.add(m.id); total += m.pow; queue.push(m); }
    }
  }
  return total;
}

// ---------- 데이터 추출 (v3와 1:1 동일) ----------
const decisions = [];
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')) } catch { continue }
  if (!g.map || !g.actionJournal) continue;
  const geom = new Map(); for (const t of g.map) if (t.q != null) geom.set(t.id, { id: t.id, q: t.q, r: t.r, type: t.type, sector: t.sector });
  const ships = [...geom.values()].filter(t => String(t.type).startsWith('ship_'));
  const protos = [...geom.values()].filter(t => t.type === 'proto' || t.type === 'asteroid');
  const owner = new Map(); const struct = new Map();
  for (const e of g.actionJournal) {
    const pid = e.playerId, act = e.action || '', tid = e.tileId;
    if (Array.isArray(e.candidates) && e.candidates.length) {
      const cands = e.candidates.filter(c => c.type === 'build_mine' && c.tileId && geom.has(c.tileId));
      const chosen = cands.findIndex(c => c.tileId === tid);
      if (cands.length >= 2 && chosen >= 0) {
        const mine = [...owner.entries()].filter(([, o]) => o === pid).map(([id]) => geom.get(id)).filter(Boolean);
        const opp = [...owner.entries()].filter(([, o]) => o !== pid).map(([id]) => geom.get(id)).filter(Boolean);
        if (mine.length === 0) continue;
        const myPow = mine.map(t => ({ ...t, pow: powOf(struct.get(t.id)) }));
        const ownedIds = new Set(owner.keys());
        const empties = [...geom.values()].filter(t => isPlanet(t) && !ownedIds.has(t.id));
        const myTypes = new Set(mine.map(t => t.type)), mySectors = new Set(mine.map(t => t.sector));
        const md = (arr, tile) => arr.length ? Math.min(...arr.map(s => dist(s, tile))) : 9;
        const feats = cands.map(c => {
          const tile = geom.get(c.tileId);
          const adjEmpty = empties.filter(t => t.id !== tile.id && dist(t, tile) === 1).length;
          const adjOwn = mine.filter(m => dist(m, tile) === 1).length;
          const cPow = clusterPowerAt(tile, myPow, 1);
          const sPow = clusterPowerAt(tile, myPow, 2);
          return [
            Math.min(md(mine, tile), 9) / 9, Math.min(md(opp, tile), 9) / 9, Math.min(md(ships, tile), 9) / 9, Math.min(md(protos, tile), 9) / 9,
            adjEmpty / 6, adjOwn / 6, mySectors.has(tile.sector) ? 0 : 1, myTypes.has(tile.type) ? 0 : 1,
            Math.min(cPow, 7) / 7, cPow >= 7 ? 1 : 0, Math.min(sPow, 7) / 7,
          ];
        });
        decisions.push({ cands: feats, y: chosen, game: f });
      }
    }
    if (/Built Mine|Placed Starting Mine|Placed Mine|Placed Gaiaformer/i.test(act)) {
      if (tid) { owner.set(tid, pid); struct.set(tid, /Gaiaformer/i.test(act) ? 'gaiaformer' : 'mine'); }
    } else if (/Upgraded to|Academy/i.test(act)) {
      if (tid && !owner.has(tid)) owner.set(tid, pid);
      if (tid) {
        if (/Trading Station/i.test(act)) struct.set(tid, 'trading_station');
        else if (/Research Lab/i.test(act)) struct.set(tid, 'research_lab');
        else if (/Planetary/i.test(act)) struct.set(tid, 'planetary_institute');
        else if (/Academy/i.test(act)) struct.set(tid, 'academy');
      }
    }
  }
}
const D = 11;
const FEATS = ['dOwn', 'dOpp', 'dShip', 'dProto', 'adjEmpty', 'adjOwn', 'newSector', 'newType', 'clusterPow', 'reaches7', 'sat2Pow'];
console.log(`build_mine 배치 결정 ${decisions.length}, 후보수평균 ${(decisions.reduce((s, d) => s + d.cands.length, 0) / decisions.length).toFixed(1)}, 게임 ${new Set(decisions.map(d => d.game)).size}`);

// ---------- 공통 유틸 ----------
const softmax = ss => { const mx = Math.max(...ss); const ex = ss.map(s => Math.exp(s - mx)); const Z = ex.reduce((a, b) => a + b, 0); return ex.map(x => x / Z); };
function mkRnd(seed0) { let seed = seed0; return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }; }

// ---------- 선형(v3 재현) ----------
function trainLinear(tr, { epochs = 150, lr = 0.05, l2 = 1e-4, seed = 12345 } = {}) {
  const w = new Float64Array(D);
  const m = new Float64Array(D), v = new Float64Array(D); const b1 = 0.9, b2 = 0.999, eps = 1e-8; let t = 0;
  const rnd = mkRnd(seed);
  const score = fv => { let s = 0; for (let k = 0; k < D; k++) s += w[k] * fv[k]; return s; };
  for (let ep = 0; ep < epochs; ep++) {
    const ord = tr.map((_, i) => i); for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[ord[i], ord[j]] = [ord[j], ord[i]]; }
    for (const idx of ord) {
      const d = tr[idx]; const p = softmax(d.cands.map(score)); t++;
      const gr = new Float64Array(D);
      for (let c = 0; c < d.cands.length; c++) { const coef = p[c] - (c === d.y ? 1 : 0); const fv = d.cands[c]; for (let k = 0; k < D; k++) gr[k] += coef * fv[k]; }
      const lrt = lr * Math.sqrt(1 - Math.pow(b2, t)) / (1 - Math.pow(b1, t));
      for (let k = 0; k < D; k++) { const g2 = gr[k] + l2 * w[k]; m[k] = b1 * m[k] + (1 - b1) * g2; v[k] = b2 * v[k] + (1 - b2) * g2 * g2; w[k] -= lrt * m[k] / (Math.sqrt(v[k]) + eps); }
    }
  }
  return { kind: 'linear', w: [...w], scoreOf: fv => { let s = 0; for (let k = 0; k < D; k++) s += w[k] * fv[k]; return s; } };
}

// ---------- MLP: 11 → H(tanh) → 1, 리스트와이즈 softmax CE ----------
// skip=true면 잔차(residual) 구조: score = wLin·x + v·tanh(Wx+b) — 선형항을 그대로 품고 비선형은 '보정'만.
// (선형이 이미 강한 기준선일 때 MLP가 그 밑으로 떨어지는 걸 구조적으로 막는다)
function trainMLP(tr, { H = 16, epochs = 150, lr = 0.02, l2 = 1e-3, seed = 12345, skip = false } = {}) {
  const rnd = mkRnd(seed);
  const gauss = () => { let u = 0, v2 = 0; while (u === 0) u = rnd(); while (v2 === 0) v2 = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v2); };
  const W1 = new Float64Array(H * D), b1v = new Float64Array(H), W2 = new Float64Array(H); let b2v = 0;
  const s1 = Math.sqrt(1 / D), s2 = Math.sqrt(1 / H);
  for (let i = 0; i < H * D; i++) W1[i] = gauss() * s1;
  for (let i = 0; i < H; i++) W2[i] = gauss() * s2;

  const wLin = new Float64Array(D);                  // skip 경로(0 초기화 = 학습으로 선형항 획득)
  const P = H * D + H + H + 1 + D;                   // 파라미터 평탄화: W1 | b1 | W2 | b2 | wLin
  const LIN0 = H * D + H + H + 1;
  const mAd = new Float64Array(P), vAd = new Float64Array(P); const B1 = 0.9, B2 = 0.999, eps = 1e-8; let t = 0;

  const fwd = fv => {                                 // returns {h, s}
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
      const fs2 = d.cands.map(fwd);
      const p = softmax(fs2.map(o => o.s)); t++;
      const g = new Float64Array(P);
      for (let c = 0; c < d.cands.length; c++) {
        const coef = p[c] - (c === d.y ? 1 : 0); if (coef === 0) continue;
        const { h } = fs2[c]; const fv = d.cands[c];
        for (let j = 0; j < H; j++) {
          g[H * D + H + j] += coef * h[j];                      // dW2
          const dpre = coef * W2[j] * (1 - h[j] * h[j]);        // tanh'
          g[H * D + j] += dpre;                                 // db1
          const off = j * D;
          for (let k = 0; k < D; k++) g[off + k] += dpre * fv[k]; // dW1
        }
        g[LIN0 - 1] += coef;                                    // db2
        if (skip) for (let k = 0; k < D; k++) g[LIN0 + k] += coef * fv[k]; // dwLin
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

// ---------- 평가 ----------
function evalTop1(model, set) {
  let c1 = 0, rb = 0, c3 = 0;
  for (const d of set) {
    const ss = d.cands.map(model.scoreOf);
    const order = ss.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).map(x => x[1]);
    if (order[0] === d.y) c1++;
    if (order.slice(0, 3).includes(d.y)) c3++;
    rb += 1 / d.cands.length;
  }
  return { t1: c1 / set.length, t3: c3 / set.length, rand: rb / set.length, n: set.length };
}

const SAVE = process.env.SAVE === '1';
const EPOCHS = Number(process.env.EPOCHS) || 150;

if (!SAVE) {
  // ---------- 7-폴드 CV: 선형 vs MLP(H 스윕) ----------
  const folds = 7;
  const configs = process.env.SWEEP === '1' ? [
    // 2차: MLP에 공정한 조건 부여 — ①선형과 동일 하이퍼(lr .05/l2 1e-4) ②장기학습 ③잔차(skip) 구조
    { name: 'linear(v3)', fn: tr => trainLinear(tr, { epochs: EPOCHS }) },
    { name: 'mlp8 lr.05', fn: tr => trainMLP(tr, { H: 8, epochs: EPOCHS, lr: 0.05, l2: 1e-4 }) },
    { name: 'mlp8 ep400', fn: tr => trainMLP(tr, { H: 8, epochs: 400, lr: 0.02, l2: 1e-3 }) },
    { name: 'mlp8 l2=.01', fn: tr => trainMLP(tr, { H: 8, epochs: EPOCHS, lr: 0.02, l2: 0.01 }) },
    { name: 'res H=4', fn: tr => trainMLP(tr, { H: 4, epochs: EPOCHS, lr: 0.02, l2: 1e-3, skip: true }) },
    { name: 'res H=8', fn: tr => trainMLP(tr, { H: 8, epochs: EPOCHS, lr: 0.02, l2: 1e-3, skip: true }) },
    { name: 'res H=16', fn: tr => trainMLP(tr, { H: 16, epochs: EPOCHS, lr: 0.02, l2: 0.01, skip: true }) },
  ] : [
    { name: 'linear(v3)', fn: tr => trainLinear(tr, { epochs: EPOCHS }) },
    { name: 'mlp H=4', fn: tr => trainMLP(tr, { H: 4, epochs: EPOCHS }) },
    { name: 'mlp H=8', fn: tr => trainMLP(tr, { H: 8, epochs: EPOCHS }) },
    { name: 'mlp H=16', fn: tr => trainMLP(tr, { H: 16, epochs: EPOCHS }) },
    { name: 'mlp H=32', fn: tr => trainMLP(tr, { H: 32, epochs: EPOCHS }) },
  ];
  const results = new Map(configs.map(c => [c.name, []]));
  let randAll = 0, nAll = 0;
  for (let f = 0; f < folds; f++) {
    const tr = [], va = [];
    decisions.forEach((d, i) => ((i % folds === f) ? va : tr).push(d));
    for (const c of configs) {
      const model = c.fn(tr);
      const V = evalTop1(model, va);
      results.get(c.name).push(V.t1);
      if (c === configs[0]) { randAll += V.rand * V.n; nAll += V.n; }
    }
    process.stdout.write(`  fold ${f}: ` + configs.map(c => `${c.name} ${(results.get(c.name)[f] * 100).toFixed(1)}%`).join(' | ') + '\n');
  }
  console.log(`\n무작위 기준 ${(randAll / nAll * 100).toFixed(1)}%  (7-폴드 CV, 결정 ${decisions.length}건)`);
  const base = results.get('linear(v3)');
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const sd = a => { const m0 = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m0) ** 2, 0) / (a.length - 1)); };
  console.log('모델            CV top1      폴드SE     선형대비(쌍대차 ± SE)');
  for (const c of configs) {
    const r = results.get(c.name);
    const diff = r.map((x, i) => x - base[i]);            // 같은 폴드끼리 짝지은 차이 = 분산 작음
    const dm = mean(diff), dse = c.name === 'linear(v3)' ? 0 : sd(diff) / Math.sqrt(folds);
    console.log(`${c.name.padEnd(14)} ${(mean(r) * 100).toFixed(2)}%    ±${(sd(r) / Math.sqrt(folds) * 100).toFixed(2)}    ` +
      (c.name === 'linear(v3)' ? '(기준)' : `${dm >= 0 ? '+' : ''}${(dm * 100).toFixed(2)}%p ± ${(dse * 100).toFixed(2)}`));
  }
  console.log('\n게이트: 쌍대차가 +2%p 이상 & |diff| > 2×SE 여야 h2h로 넘어감(아니면 선형 유지).');
} else {
  // ---------- 전체 데이터 재학습 + 저장 ----------
  const H = Number(process.env.H) || 16;
  const tr = [], va = []; decisions.forEach((d, i) => (i % 7 === 0 ? va : tr).push(d));
  const mlp = trainMLP(tr, { H, epochs: EPOCHS });
  const lin = trainLinear(tr, { epochs: EPOCHS });
  const Vm = evalTop1(mlp, va), Vl = evalTop1(lin, va);
  console.log(`holdout(i%7==0) — mlp H=${H} top1 ${(Vm.t1 * 100).toFixed(1)}% / linear ${(Vl.t1 * 100).toFixed(1)}% / 무작위 ${(Vl.rand * 100).toFixed(1)}%`);

  // ★스케일 정합: bot.ts는 랭커 점수에 ×60을 곱한다. 선형 v3는 max|w|=3.57로 정규화돼 있으므로
  //   MLP도 '결정 내 후보 점수 산포'가 배포 선형과 같아지도록 맞춘다(blast radius 동일 → 순수 모델효과 분리).
  const deployed = JSON.parse(fs.readFileSync('server/ai/placementPolicyV3.json', 'utf8'));
  const depScore = fv => { let s = 0; for (let k = 0; k < D; k++) s += deployed.weights[k] * fv[k]; return s; };
  const spread = sc => {
    let tot = 0, n = 0;
    for (const d of decisions) {
      const ss = d.cands.map(sc); const mu = ss.reduce((a, b) => a + b, 0) / ss.length;
      tot += Math.sqrt(ss.reduce((s, x) => s + (x - mu) ** 2, 0) / ss.length); n++;
    }
    return tot / n;
  };
  const sDep = spread(depScore), sMlp = spread(mlp.scoreOf);
  const k = sDep / sMlp;
  console.log(`스케일 정합: 배포선형 산포 ${sDep.toFixed(3)} / MLP 산포 ${sMlp.toFixed(3)} → 출력 ×${k.toFixed(4)}`);

  fs.writeFileSync('server/ai/placementPolicyMLP.json', JSON.stringify({
    version: 4, arch: `mlp ${D}-${H}(tanh)-1`, features: FEATS, H,
    W1: mlp.W1, b1: mlp.b1, W2: mlp.W2.map(x => x * k), b2: mlp.b2 * k, outScale: k,
    valTop1: Vm.t1, linearTop1: Vl.t1, randomBaseline: Vl.rand, decisions: decisions.length,
    note: 'v3와 동일 11피처·동일 데이터. 출력 산포를 배포 선형(placementPolicyV3.json)에 맞춤 → bot.ts ×60 그대로.',
  }, null, 1));
  console.log('저장: server/ai/placementPolicyMLP.json');
}
