/**
 * 릿지(선형) 가치망 학습기 — 사용자 통찰(2026-07-13): "게임 5판이면 배울 건 배운다 / 좌석 세면 209석"이 적중.
 * 40차원 MLP는 77게임 규모에서 과적합(valMAE 33.9 > 상수 24.3, 가이아행성 −171 병리)이지만,
 * 릿지 닫힌형은 valMAE 23.0 < 상수 24.0 + 엔진축 4/7+ 양수로 viability 게이트 첫 통과.
 *
 * 저장 포맷: 기존 ValueNet MLP JSON에 선형함수를 *정확히* 임베딩 —
 *   a1_0 = ReLU(w·x + C) (C=1000, 피처 유계라 항상 양수 → 항등), a2_0 = ReLU(a1_0), out = a2_0 + (b − C).
 *   나머지 유닛은 0 가중치. → valueNet.ts/evaluator 수정 없이 useValueNet/azValueLeaf가 그대로 소비.
 *
 * 실행: npx tsx scripts/trainRidgeValueNet.ts   (env: LAMBDA=50 OUT=server/ai/valueNet.json)
 */
import fs from 'fs';
import readline from 'readline';
import { FEATURE_DIM, FEATURE_NAMES } from '../server/ai/features';

const DATA = 'data/human-features.jsonl';
const OUT = process.env.OUT || 'server/ai/valueNet.json';
const LAMBDA = Number(process.env.LAMBDA) || 50;
const C = 1000; // ReLU 항등 오프셋

async function main() {
    const rows: { y: number, g: string, f: number[] }[] = [];
    for await (const line of readline.createInterface({ input: fs.createReadStream(DATA) })) {
        try { const j = JSON.parse(line); if (j?.f?.length === FEATURE_DIM) rows.push(j); } catch { /* skip */ }
    }
    const games = [...new Set(rows.map(r => r.g))];
    const valG = new Set(games.filter((_, i) => i % 5 === 0));
    const tr = rows.filter(r => !valG.has(r.g)), va = rows.filter(r => valG.has(r.g));
    const D = FEATURE_DIM;

    // 닫힌형 릿지: (X'X + λI)w = X'y (절편은 비정칙)
    const XtX = Array.from({ length: D + 1 }, () => new Float64Array(D + 1));
    const Xty = new Float64Array(D + 1);
    for (const r of tr) {
        const x = [...r.f, 1];
        for (let i = 0; i <= D; i++) { Xty[i] += x[i] * r.y; for (let j = i; j <= D; j++) XtX[i][j] += x[i] * x[j]; }
    }
    for (let i = 0; i <= D; i++) for (let j = 0; j < i; j++) XtX[i][j] = XtX[j][i];
    for (let i = 0; i < D; i++) XtX[i][i] += LAMBDA;
    const A = XtX.map((row, i) => [...row, Xty[i]]);
    for (let c = 0; c <= D; c++) {
        let p = c; for (let r2 = c + 1; r2 <= D; r2++) if (Math.abs(A[r2][c]) > Math.abs(A[p][c])) p = r2;
        [A[c], A[p]] = [A[p], A[c]];
        for (let r2 = 0; r2 <= D; r2++) {
            if (r2 === c || !A[c][c]) continue;
            const f = A[r2][c] / A[c][c];
            for (let k = c; k <= D + 1; k++) A[r2][k] -= f * A[c][k];
        }
    }
    const w = A.map((row, i) => row[D + 1] / (row[i] || 1));
    const bias = w[D];
    const pred = (x: number[]) => { let s = bias; for (let i = 0; i < D; i++) s += w[i] * x[i]; return s; };

    const mae = (rs: typeof rows) => rs.reduce((a, r) => a + Math.abs(pred(r.f) - r.y), 0) / rs.length;
    const mean = tr.reduce((a, r) => a + r.y, 0) / tr.length;
    const constMae = va.reduce((a, r) => a + Math.abs(mean - r.y), 0) / va.length;
    console.log(`릿지(λ=${LAMBDA}) valMAE: ${mae(va).toFixed(1)} | 상수기준: ${constMae.toFixed(1)} | train ${tr.length} val ${va.length} (게임분할)`);
    console.log('가중치 상위(|w|):', w.slice(0, D).map((v, i) => [FEATURE_NAMES[i], v] as const)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8).map(([n, v]) => `${n}=${v.toFixed(1)}`).join(' '));

    // MLP 임베딩 (IN→32→16→1, 유닛0만 사용)
    const H1 = 32, H2 = 16;
    const W1 = new Array(H1 * D).fill(0); const b1 = new Array(H1).fill(0);
    for (let j = 0; j < D; j++) W1[j] = w[j]; // row 0 = w
    b1[0] = C;
    const W2 = new Array(H2 * H1).fill(0); const b2 = new Array(H2).fill(0);
    W2[0] = 1; // row0 <- a1_0
    const W3 = new Array(H2).fill(0); const b3 = [bias - C];
    W3[0] = 1;
    fs.writeFileSync(OUT, JSON.stringify({ dim: D, h1: H1, h2: H2, W1, b1, W2, b2, W3, b3 }));
    console.log(`저장: ${OUT} (선형 임베딩, dim=${D})`);
}
main().then(() => process.exit(0));
