/**
 * 가설: 봇 자가대국도 한 게임서 VP 30~103으로 갈리므로(엔진 변동), score를 마스킹하면
 * 봇 데이터(24만, 풍부)만으로 엔진→VP gradient를 배울 수 있다 → 데이터 게이트 우회 가능?
 * (앞선 masked 학습 평탄은 사람 300배 upweight 과적합 탓 의심)
 * BOT-ONLY + score계열 마스킹 + 누출방지 split. 엔진 gradient 프로브로 판정.
 */
import fs from 'fs';
import { ValueNet } from '../server/ai/valueNet';
import { FEATURE_DIM } from '../server/ai/features';

const MASK = [2, 29, 30]; // score, scoreVsMaxOpp, scoreVsMeanOpp 제거 → 엔진 피처로만 예측 강제
const EPOCHS = Number(process.env.EP) || 30;
const LR = 0.02;

function mask(f: number[]): number[] { const g = f.slice(); for (const i of MASK) g[i] = 0; return g; }
function shuffle<T>(a: T[]) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } }

const lines = fs.readFileSync('data/valuenet-data.jsonl', 'utf8').split('\n').filter(l => l.trim());
const rows: { y: number; f: number[] }[] = [];
for (const l of lines) {
  try { const r = JSON.parse(l); if (r.bot === true && Array.isArray(r.f) && r.f.length === FEATURE_DIM && typeof r.y === 'number') rows.push({ y: r.y, f: mask(r.f) }); } catch { }
}
shuffle(rows);
const ys = rows.map(r => r.y).sort((a, b) => a - b);
console.log(`BOT-ONLY 샘플=${rows.length} | y범위: min=${ys[0]} p10=${ys[Math.floor(ys.length*0.1)]} median=${ys[Math.floor(ys.length/2)]} p90=${ys[Math.floor(ys.length*0.9)]} max=${ys[ys.length-1]}`);
const nVal = Math.floor(rows.length * 0.15);
const val = rows.slice(0, nVal), train = rows.slice(nVal);

const net = new ValueNet(FEATURE_DIM);
let bestMAE = Infinity, bestJSON = net.toJSON();
for (let e = 0; e < EPOCHS; e++) {
  shuffle(train);
  const lr = LR * (1 - e / (EPOCHS * 1.5));
  for (const r of train) net.trainStep(r.f, r.y, lr);
  let mae = 0; for (const r of val) mae += Math.abs(net.predict(r.f) - r.y); mae /= val.length;
  if (mae < bestMAE) { bestMAE = mae; bestJSON = net.toJSON(); }
  if (e % 5 === 0 || e === EPOCHS - 1) console.log(`  epoch ${e}: valMAE=${mae.toFixed(2)} VP`);
}
const meanY = train.reduce((s, r) => s + r.y, 0) / train.length;
const baseMAE = val.reduce((s, r) => s + Math.abs(r.y - meanY), 0) / val.length;
console.log(`baseline(predict mean ${meanY.toFixed(1)})=${baseMAE.toFixed(2)} | best valMAE=${bestMAE.toFixed(2)} (개선 ${(baseMAE-bestMAE).toFixed(2)})`);
fs.writeFileSync('server/ai/engineValueNet.json', JSON.stringify(bestJSON));

// 엔진 gradient 프로브 (score 마스킹된 종반 봇 평균 상태)
const net2 = ValueNet.fromJSON(bestJSON);
const base = new Array(33).fill(0);
base[0] = 1; base[1] = 1/6; base[11] = 5.2/8; base[12] = 1.25/4; base[13] = 2.0/3; base[14] = 0.48;
base[22] = 1.18/3; base[23] = 2.73/6; base[25] = 2.29/3; base[26] = 9.24/14; base[28] = 1.53/6;
const bp = net2.predict(base);
console.log(`\n[BOT-ONLY score마스킹] 기준 예측VP: ${bp.toFixed(1)}`);
const probes: [string, number, number][] = [
  ['techTiles 2.7→8.5', 23, 8.54/6], ['gaiaPlanets 1.5→5.0', 28, 4.97/6],
  ['structures 9.2→14', 26, 13.97/14], ['federations 1.2→2.6', 22, 2.63/3],
  ['tradingStations→2.45', 12, 2.45/4], ['mines→6.9', 11, 6.88/8], ['ships 2.3→2.7', 25, 2.70/3],
];
for (const [label, idx, val2] of probes) { const x = base.slice(); x[idx] = val2; console.log(`  ${label.padEnd(22)}: ${net2.predict(x) >= bp ? '+' : ''}${(net2.predict(x) - bp).toFixed(1)} VP`); }
