#!/usr/bin/env node
// head2head / self-play stdout에서 종족별 평균 점수를 집계해 낮은 순으로 출력.
// head2head 게임 로그 라인 형식: "...A:space_giants=33 | B:darkanians=41 | ..."
// 약한 종족(낮은 평균)부터 전략 보강 대상.
//
// 사용법: node faction-scores.mjs <head2head-output-file>
//   (run-h2h.sh를 백그라운드로 돌렸다면 그 task output 파일 경로를 넘긴다)
import fs from 'fs';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('사용법: node faction-scores.mjs <head2head-output-file>');
  process.exit(1);
}

const txt = fs.readFileSync(file, 'utf8');
const agg = {};
for (const m of txt.matchAll(/[AB]:([a-z_]+)=(-?\d+)/g)) {
  const fac = m[1], sc = Number(m[2]);
  (agg[fac] ??= []).push(sc);
}

const rows = Object.entries(agg)
  .map(([fac, a]) => ({ fac, n: a.length, avg: a.reduce((x, y) => x + y, 0) / a.length }))
  .sort((a, b) => a.avg - b.avg);

const total = Object.values(agg).reduce((s, a) => s + a.length, 0);
if (total === 0) {
  console.error('종족=점수 라인을 못 찾음. head2head 전체 출력 파일이 맞는지 확인(부분/요약만이면 안 됨).');
  process.exit(1);
}
console.log(`총 샘플 ${total} · 종족 ${rows.length}개 (낮은 평균 = 약함 = 보강 우선)\n`);
for (const r of rows) {
  console.log(`${r.avg.toFixed(1).padStart(6)}   ${r.fac.padEnd(15)} (n=${r.n})`);
}
