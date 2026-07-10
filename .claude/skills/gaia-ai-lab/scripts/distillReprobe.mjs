#!/usr/bin/env node
// 오프라인 증류 리프로브: 수집된 결정별 {heur[], baseF[], richF[]}로 모델을 학습해
// "형제 후보를 휴리스틱처럼 랭킹하는가"(top-1 일치율)를 측정. self-play 재실행 불필요.
// 릿지회귀(닫힌형, 메모리안전) — 피처가 랭킹정보를 담는지의 하한. baseF(33) vs richF(99) 비교.
// 사용법: node distillReprobe.mjs <path-to-sibling-probe.jsonl> [base|rich]
import { readFileSync } from 'fs';

const FILE = process.argv[2];
const WHICH = process.argv[3] || 'both';
if (!FILE) { console.error('need data file'); process.exit(1); }

const decs = readFileSync(FILE, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(d => d && d.heur && d.heur.length >= 2 && d.baseF && d.richF);
console.log(`decisions(>=2 cand): ${decs.length}`);

// split by decision (80/20 deterministic by index parity-ish)
const train = [], val = [];
decs.forEach((d, i) => (i % 5 === 0 ? val : train).push(d));
console.log(`train=${train.length} val=${val.length}`);

function featSel(d, which) { return which === 'base' ? d.baseF : d.richF; }

// standardize features from train, center target
function fit(which) {
  const F = featSel(train[0], which)[0].length;
  // collect train samples
  const Xs = [], ys = [];
  for (const d of train) { const fs = featSel(d, which); for (let i = 0; i < d.heur.length; i++) { Xs.push(fs[i]); ys.push(d.heur[i]); } }
  const N = Xs.length;
  // feature mean/std
  const mean = new Float64Array(F), std = new Float64Array(F);
  for (const x of Xs) for (let j = 0; j < F; j++) mean[j] += x[j];
  for (let j = 0; j < F; j++) mean[j] /= N;
  for (const x of Xs) for (let j = 0; j < F; j++) { const d0 = x[j] - mean[j]; std[j] += d0 * d0; }
  for (let j = 0; j < F; j++) std[j] = Math.sqrt(std[j] / N) || 1;
  const yMean = ys.reduce((a, b) => a + b, 0) / N;
  // build normal equations A = Z^T Z + lambda I, b = Z^T (y - yMean), Z standardized (+ intercept col)
  const D = F + 1; // last = intercept (ones)
  const A = Array.from({ length: D }, () => new Float64Array(D));
  const b = new Float64Array(D);
  const z = new Float64Array(D);
  for (let n = 0; n < N; n++) {
    const x = Xs[n];
    for (let j = 0; j < F; j++) z[j] = (x[j] - mean[j]) / std[j];
    z[F] = 1;
    const yc = ys[n] - yMean;
    for (let a = 0; a < D; a++) { const za = z[a]; if (za === 0) continue; b[a] += za * yc; const Aa = A[a]; for (let c = a; c < D; c++) Aa[c] += za * z[c]; }
  }
  for (let a = 0; a < D; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a]; // symmetric
  const lambda = 10.0; // ridge (features standardized)
  for (let j = 0; j < F; j++) A[j][j] += lambda; // don't regularize intercept
  // solve A w = b (Gaussian elimination)
  const M = A.map((row, i) => Float64Array.from([...row, b[i]]));
  for (let col = 0; col < D; col++) {
    let piv = col; for (let r = col + 1; r < D; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const pv = M[col][col] || 1e-9;
    for (let c = col; c <= D; c++) M[col][c] /= pv;
    for (let r = 0; r < D; r++) { if (r === col) continue; const f = M[r][col]; if (f === 0) continue; for (let c = col; c <= D; c++) M[r][c] -= f * M[col][c]; }
  }
  const w = new Float64Array(D); for (let i = 0; i < D; i++) w[i] = M[i][D];
  return { w, mean, std, yMean, F };
}

function predict(model, x) {
  let s = model.w[model.F]; // intercept
  for (let j = 0; j < model.F; j++) s += model.w[j] * ((x[j] - model.mean[j]) / model.std[j]);
  return s;
}

function spearman(a, b) {
  const rank = arr => { const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(arr.length); idx.forEach(([, i], k) => r[i] = k); return r; };
  const ra = rank(a), rb = rank(b), n = a.length; let d2 = 0; for (let i = 0; i < n; i++) { const d = ra[i] - rb[i]; d2 += d * d; }
  return 1 - (6 * d2) / (n * (n * n - 1));
}

function evalModel(which) {
  const model = fit(which);
  let top1 = 0, top3 = 0, tot = 0, rhoSum = 0, rhoN = 0;
  for (const d of val) {
    const fs = featSel(d, which);
    const pred = fs.map(x => predict(model, x));
    const heur = d.heur;
    const pArg = pred.indexOf(Math.max(...pred));
    const hArg = heur.indexOf(Math.max(...heur));
    if (pArg === hArg) top1++;
    // top-3: pred argmax within heur top-3
    const heurOrder = heur.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(x => x[1]);
    if (heurOrder.includes(pArg)) top3++;
    tot++;
    if (heur.length >= 3) { rhoSum += spearman(pred, heur); rhoN++; }
  }
  return { which, dim: model.F, top1: (100 * top1 / tot).toFixed(1), top3: (100 * top3 / tot).toFixed(1), rho: (rhoSum / rhoN).toFixed(3), tot };
}

console.log('\n===== DISTILL REPROBE (ridge, val by decision) =====');
console.log('baseline (raw valueNet, from Phase 1): top-1 36.1%, rho 0.12\n');
for (const which of (WHICH === 'both' ? ['base', 'rich'] : [WHICH])) {
  const r = evalModel(which);
  console.log(`${which.toUpperCase()} (dim=${r.dim}): top-1=${r.top1}%  top-3=${r.top3}%  Spearman=${r.rho}  (n=${r.tot})`);
}
console.log('\nGATE: rich top-1 >=~85 => features carry heuristic ranking (target-noise is the real problem, GO Phase 2b);');
console.log('      rich top-1 <~60 => features cannot represent value ordering (net-leaf dead end).');
