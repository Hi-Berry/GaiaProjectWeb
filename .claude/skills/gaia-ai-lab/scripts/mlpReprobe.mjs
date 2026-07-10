#!/usr/bin/env node
// 오프라인 증류 리프로브 (비선형 MLP). 결정별 {heur[], richF[]}로 MLP(F→H→1, ReLU)를 학습해
// 형제-후보 랭킹 top-1을 측정. 메모리 안전(미니배치 SGD+모멘텀, 타입드배열). 릿지 하한 위의 비선형 상한 추정.
// 사용법: node mlpReprobe.mjs <data.jsonl> [base|rich] [H] [epochs]
import { readFileSync } from 'fs';
const FILE = process.argv[2];
const WHICH = process.argv[3] || 'rich';
const H = Number(process.argv[4] || 64);
const EPOCHS = Number(process.argv[5] || 40);
if (!FILE) { console.error('need data file'); process.exit(1); }

const decs = readFileSync(FILE, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(d => d && d.heur && d.heur.length >= 2 && d.richF && d.baseF);
const train = [], val = [];
decs.forEach((d, i) => (i % 5 === 0 ? val : train).push(d));
const sel = (d) => WHICH === 'base' ? d.baseF : d.richF;
const F = sel(train[0])[0].length;
console.log(`decisions=${decs.length} train=${train.length} val=${val.length} feat=${WHICH}(${F}) H=${H} epochs=${EPOCHS}`);

// flatten train samples
const X = [], Y = [];
for (const d of train) { const fs = sel(d); for (let i = 0; i < d.heur.length; i++) { X.push(fs[i]); Y.push(d.heur[i]); } }
const N = X.length;
// standardize feats + target
const fm = new Float64Array(F), fs2 = new Float64Array(F);
for (const x of X) for (let j = 0; j < F; j++) fm[j] += x[j];
for (let j = 0; j < F; j++) fm[j] /= N;
for (const x of X) for (let j = 0; j < F; j++) { const d0 = x[j] - fm[j]; fs2[j] += d0 * d0; }
for (let j = 0; j < F; j++) fs2[j] = Math.sqrt(fs2[j] / N) || 1;
const ym = Y.reduce((a, b) => a + b, 0) / N; let ys = Math.sqrt(Y.reduce((a, b) => a + (b - ym) * (b - ym), 0) / N) || 1;
const Xn = X.map(x => { const z = new Float64Array(F); for (let j = 0; j < F; j++) z[j] = (x[j] - fm[j]) / fs2[j]; return z; });
const Yn = Y.map(y => (y - ym) / ys);

// MLP params (He init)
const rnd = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
const W1 = new Float64Array(F * H), b1 = new Float64Array(H), W2 = new Float64Array(H), b2r = { v: 0 };
for (let i = 0; i < F * H; i++) W1[i] = (rnd() * 2 - 1) * Math.sqrt(2 / F);
for (let i = 0; i < H; i++) W2[i] = (rnd() * 2 - 1) * Math.sqrt(2 / H);
// momentum
const mW1 = new Float64Array(F * H), mb1 = new Float64Array(H), mW2 = new Float64Array(H); let mb2 = 0;
const lr = 0.01, mom = 0.9, batch = 256;
const hz = new Float64Array(H), ha = new Float64Array(H);
const idx = Array.from({ length: N }, (_, i) => i);
for (let ep = 0; ep < EPOCHS; ep++) {
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  let loss = 0;
  for (let bs = 0; bs < N; bs += batch) {
    const be = Math.min(N, bs + batch), bn = be - bs;
    const gW1 = new Float64Array(F * H), gb1 = new Float64Array(H), gW2 = new Float64Array(H); let gb2 = 0;
    for (let k = bs; k < be; k++) {
      const n = idx[k], x = Xn[n];
      for (let h = 0; h < H; h++) { let s = b1[h]; const off = h * F; for (let j = 0; j < F; j++) s += W1[off + j] * x[j]; hz[h] = s; ha[h] = s > 0 ? s : 0; }
      let yp = b2r.v; for (let h = 0; h < H; h++) yp += W2[h] * ha[h];
      const err = yp - Yn[n]; loss += err * err;
      const dy = 2 * err / bn;
      gb2 += dy; for (let h = 0; h < H; h++) { gW2[h] += dy * ha[h]; const dh = (hz[h] > 0 ? dy * W2[h] : 0); if (dh !== 0) { gb1[h] += dh; const off = h * F; for (let j = 0; j < F; j++) gW1[off + j] += dh * x[j]; } }
    }
    mb2 = mom * mb2 - lr * gb2; b2r.v += mb2;
    for (let h = 0; h < H; h++) { mb1[h] = mom * mb1[h] - lr * gb1[h]; b1[h] += mb1[h]; mW2[h] = mom * mW2[h] - lr * gW2[h]; W2[h] += mW2[h]; }
    for (let i = 0; i < F * H; i++) { mW1[i] = mom * mW1[i] - lr * gW1[i]; W1[i] += mW1[i]; }
  }
  if (ep % 10 === 9 || ep === EPOCHS - 1) console.log(`  epoch ${ep + 1}: train MSE(norm)=${(loss / N).toFixed(4)}`);
}
function pred(x) { let yp = b2r.v; for (let h = 0; h < H; h++) { let s = b1[h]; const off = h * F; for (let j = 0; j < F; j++) s += W1[off + j] * ((x[j] - fm[j]) / fs2[j]); yp += W2[h] * (s > 0 ? s : 0); } return yp; }
function spearman(a, b) { const rank = arr => { const ix = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(arr.length); ix.forEach(([, i], k) => r[i] = k); return r; }; const ra = rank(a), rb = rank(b), n = a.length; let d2 = 0; for (let i = 0; i < n; i++) { const d = ra[i] - rb[i]; d2 += d * d; } return 1 - (6 * d2) / (n * (n * n - 1)); }
let top1 = 0, top3 = 0, tot = 0, rho = 0, rn = 0;
for (const d of val) { const fs = sel(d); const p = fs.map(pred); const pA = p.indexOf(Math.max(...p)); const hA = d.heur.indexOf(Math.max(...d.heur)); if (pA === hA) top1++; const ho = d.heur.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(x => x[1]); if (ho.includes(pA)) top3++; tot++; if (d.heur.length >= 3) { rho += spearman(p, d.heur); rn++; } }
console.log(`\nMLP ${WHICH}(${F}) H=${H}: top-1=${(100 * top1 / tot).toFixed(1)}%  top-3=${(100 * top3 / tot).toFixed(1)}%  Spearman=${(rho / rn).toFixed(3)}  (n=${tot})`);
console.log('GATE: >=~85 GO(features carry ranking; problem=target) / <~60 NO-GO(features cannot represent value).');
