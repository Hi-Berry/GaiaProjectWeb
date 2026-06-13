/**
 * 결정 테스트: score 계열 피처(현재점수=2, scoreVsMaxOpp=29, scoreVsMeanOpp=30)를 마스킹하고 학습.
 * 모델이 "현재점수 읽기" 지름길을 못 쓰게 강제 → 엔진 구성으로부터 최종VP를 예측하도록.
 * 누출 방지: 먼저 게임 무관하게 row split 후, train에서만 사람 복제(val엔 원본 사람만, 중복 없음).
 */
import fs from 'fs';
import { ValueNet } from '../server/ai/valueNet';
import { FEATURE_DIM } from '../server/ai/features';

const MASK = [2, 29, 30]; // 제거할 피처 인덱스
const HUMAN_WEIGHT = Number(process.env.HW) || 300;
const EPOCHS = Number(process.env.EP) || 25;
const LR = 0.02;

function mask(f: number[]): number[] { const g = f.slice(); for (const i of MASK) g[i] = 0; return g; }
function shuffle<T>(a: T[]) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } }

const lines = fs.readFileSync('data/valuenet-data.jsonl', 'utf8').split('\n').filter(l => l.trim());
const rows: { y: number; f: number[]; bot: boolean }[] = [];
for (const l of lines) { try { const r = JSON.parse(l); if (Array.isArray(r.f) && r.f.length === FEATURE_DIM && typeof r.y === 'number') rows.push({ y: r.y, f: mask(r.f), bot: r.bot !== false }); } catch { } }

shuffle(rows);
const nVal = Math.floor(rows.length * 0.15);
const valRaw = rows.slice(0, nVal);
let train = rows.slice(nVal);
// train에서만 사람 복제 (val 누출 없음)
const extra: typeof train = [];
for (const r of train) if (!r.bot) for (let k = 1; k < HUMAN_WEIGHT; k++) extra.push(r);
train = train.concat(extra);
const valHuman = valRaw.filter(r => !r.bot);
console.log(`train=${train.length} (사람복제포함) | val=${valRaw.length} (사람 ${valHuman.length}) | MASK score-feats=${MASK}`);

const net = new ValueNet(FEATURE_DIM);
for (let e = 0; e < EPOCHS; e++) {
  shuffle(train);
  const lr = LR * (1 - e / (EPOCHS * 1.5));
  for (const r of train) net.trainStep(r.f, r.y, lr);
  if (e % 5 === 0 || e === EPOCHS - 1) {
    let mae = 0; for (const r of valRaw) mae += Math.abs(net.predict(r.f) - r.y); mae /= valRaw.length;
    let hmae = 0; for (const r of valHuman) hmae += Math.abs(net.predict(r.f) - r.y); hmae /= Math.max(1, valHuman.length);
    console.log(`  epoch ${e}: valMAE=${mae.toFixed(1)}  사람valMAE=${hmae.toFixed(1)}`);
  }
}
fs.writeFileSync('/tmp/vn_masked.json', JSON.stringify(net.toJSON()));

// 프로브 (score 마스킹된 base에서 엔진 피처 상승 효과)
const base = new Array(33).fill(0);
base[0] = 1; base[1] = 1 / 6; base[11] = 5.2 / 8; base[12] = 1.25 / 4; base[13] = 2.0 / 3; base[14] = 0.48;
base[22] = 1.18 / 3; base[23] = 2.73 / 6; base[25] = 2.29 / 3; base[26] = 9.24 / 14; base[28] = 1.53 / 6;
const bp = net.predict(base);
console.log(`\n[score 마스킹] 기준 예측VP: ${bp.toFixed(1)}`);
const probes: [string, number, number][] = [
  ['techTiles 2.7→8.5', 23, 8.54 / 6], ['gaiaPlanets 1.5→5.0', 28, 4.97 / 6],
  ['structures 9.2→14', 26, 13.97 / 14], ['federations 1.2→2.6', 22, 2.63 / 3],
  ['tradingStations→2.45', 12, 2.45 / 4], ['mines→6.9', 11, 6.88 / 8], ['ships 2.3→2.7', 25, 2.70 / 3],
];
for (const [label, idx, val] of probes) { const x = base.slice(); x[idx] = val; const p = net.predict(x); console.log(`  ${label.padEnd(22)}: ${p >= bp ? '+' : ''}${(p - bp).toFixed(1)} VP`); }
