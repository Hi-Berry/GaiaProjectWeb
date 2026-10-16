// [ai2 2026-10-17] 대결 결과(seatStats)로 새 AI 좌석 vs 같은 판 기존 봇의 점수 출처·지표 비교.
//   사람 기준값 = 실게임 4P 혼합(2026-09~, realGameGap.mjs 10/17 실행)의 사람·봇 좌석 평균.
//   사용: node scripts/ai2/breakdownReport.mjs data/ai2/match/xxx.jsonl
import fs from 'fs';
const HUMAN = { score: [87.1, 193.4], techTiles: [7.81, 44.10], other: [6.21, 27.92], researchTracks: [19.27, 38.36], roundMissions: [14.41, 28.10],
  finalMissions: [15.46, 24.49], spaceships: [7.50, 12.92], bonusTilePass: [12.29, 13.87], powerReceived: [9.92, 10.79], remainingResources: [4.05, 4.44],
  'n:기술타일': [5.17, 9.30], 'n:고급타일': [0.56, 2.28], 'n:연방': [1.72, 4.25], 'n:연구합': [12.87, 18.64],
  'R1 액션': [8.76, 12.13], 'R2 액션': [5.97, 8.69], 'R3 액션': [9.07, 12.25], 'R4 액션': [8.51, 12.92], 'R5 액션': [9.34, 14.80], 'R6 액션': [9.53, 18.20],
  '패스순서': [2.2, 3.4] };
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(l => JSON.parse(l.slice(l.indexOf('{')))).filter(r => r.seatStats && r.ended);
const acc = { ai2: {}, bot: {} };
const push = (k, key, v) => { (acc[k][key] ||= []).push(v); };
const tiles = { ai2: {}, bot: {} };
for (const r of rows) for (const [id, s] of Object.entries(r.seatStats)) {
  const k = id === r.seat ? 'ai2' : 'bot';
  push(k, 'score', s.score);
  for (const [c, v] of Object.entries(s.bd)) push(k, c, v);
  push(k, 'n:기술타일', s.tiles.length); push(k, 'n:고급타일', s.tiles.filter(t => t.startsWith('adv-')).length); push(k, 'n:연방', s.feds); push(k, 'n:연구합', s.res);
  for (let i = 1; i <= 6; i++) push(k, `R${i} 액션`, s.acts[i] ?? 0);
  const po = s.pass.filter(x => x != null); if (po.length) push(k, '패스순서', po.reduce((a, b) => a + b, 0) / po.length);
  for (const t of s.tiles) tiles[k][t] = (tiles[k][t] || 0) + 1;
}
const mean = a => a?.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const f = x => Number.isNaN(x) ? '   -  ' : x.toFixed(2).padStart(6);
console.log(`판 ${rows.length} · 새 AI 좌석 ${acc.ai2.score?.length} · 기존 봇 좌석 ${acc.bot.score?.length}`);
console.log(`${'항목'.padEnd(20)} 새AI  | 같은판봇 | 차이   ‖ 실게임 봇 | 사람  (사람−새AI)`);
for (const key of Object.keys(HUMAN)) {
  const a = mean(acc.ai2[key]), b = mean(acc.bot[key]); const [hb, hh] = HUMAN[key];
  console.log(`${key.padEnd(20)} ${f(a)} | ${f(b)} | ${f(a - b)} ‖ ${f(hb)} | ${f(hh)}  (${f(hh - a)})`);
}
const n = { ai2: acc.ai2.score.length, bot: acc.bot.score.length };
console.log('\n기술 타일 획득/좌석 (새AI | 봇)');
for (const t of [...new Set([...Object.keys(tiles.ai2), ...Object.keys(tiles.bot)])].sort()) console.log(`  ${t.padEnd(24)} ${f((tiles.ai2[t] || 0) / n.ai2)} | ${f((tiles.bot[t] || 0) / n.bot)}`);

// [2026-10-17] 패스 시 자원(라운드별) · 크레딧 부족(≤4)·광석≥3일 때 파워 액션 선택 — 사람 기준: 실게임 9월~ (사람 988회: 7C 61%·2O 7%·2토큰 12%)
const pr = { ai2: {}, bot: {} }; const pw = { ai2: {}, bot: {} };
for (const r of rows) for (const [id, s] of Object.entries(r.seatStats)) {
  const k = id === r.seat ? 'ai2' : 'bot';
  (s.passRes || []).forEach((x, rd) => { if (!x) return; for (const res of ['c', 'o', 'k', 'p3']) (pr[k][`${rd}:${res}`] ||= []).push(x[res] ?? 0); });
  for (const a of (s.pw || [])) { const cond = a.c <= 4 && a.o >= 3 ? 'short' : a.c <= 4 ? 'lowC' : 'ok'; ((pw[k][cond] ||= {})[a.id] = ((pw[k][cond] || {})[a.id] || 0) + 1); }
}
console.log('\n패스 시 자원 (새AI | 봇) — 사람 실게임 4인: 광석 0.8~1.5 · 크레딧 4.8~6.4 · 3번 그릇 0.5~0.9');
for (let rd = 1; rd <= 5; rd++) console.log(`  R${rd} ` + ['c', 'o', 'k', 'p3'].map(res => `${res} ${f(mean(pr.ai2[`${rd}:${res}`]))}|${f(mean(pr.bot[`${rd}:${res}`]))}`).join('  '));
for (const cond of ['short', 'lowC', 'ok']) for (const k of ['ai2', 'bot']) {
  const o = pw[k][cond]; if (!o) continue; const n = Object.values(o).reduce((a, b) => a + b, 0);
  console.log(`  파워액션 ${cond === 'short' ? '크레딧≤4·광석≥3' : cond === 'lowC' ? '크레딧≤4' : '크레딧≥5'} ${k === 'ai2' ? '새AI' : '봇'} n=${n}: ` + Object.entries(o).sort((a, b) => b[1] - a[1]).map(([a, v]) => `${a} ${(100 * v / n).toFixed(0)}%`).join(' · '));
}
