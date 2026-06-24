/**
 * 종족별 봇 성적 상시 리포트 — 사용자의 실전 1:3 게임(data/human-games)에서 봇들이 각 종족으로 낸 점수를 집계.
 * "약한 종족부터 교정" 용도. 강한 상대(사용자) 앞 성적이라 self-play보다 의미 있음.
 *
 * 봇 식별: 플레이어 이름이 "AI Bot"으로 시작(전 포맷 공통). 사람=그 외.
 * 출력: 콘솔 표 + data/faction-report.md (약한 순 정렬). 게임 누적될수록 정확.
 *
 * 실행: node scripts/factionReport.mjs   (fetch 후 돌리면 최신 반영)
 */
import fs from 'fs';
import path from 'path';

const DIR = 'data/human-games';
const OUT = 'data/faction-report.md';
const isBotName = (n) => typeof n === 'string' && /^AI Bot/i.test(n.trim());

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort();
const fac = {};   // faction -> {scores:[{s,date}], }
const humanFac = {}; // 사람(목표치) 비교용
let games = 0;

for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  const date = f.slice(0, 10);
  let hadBot = false;
  for (const id of Object.keys(g.players || {})) {
    const p = g.players[id]; const fc = p.faction; if (!fc) continue;
    const rec = { s: p.score ?? 0, date };
    if (isBotName(p.name)) { (fac[fc] = fac[fc] || []).push(rec); hadBot = true; }
    else (humanFac[fc] = humanFac[fc] || []).push(rec);
  }
  if (hadBot) games++;
}

const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const rows = Object.entries(fac).map(([f, recs]) => {
  const scores = recs.map(r => r.s);
  const recent = recs.slice(-5).map(r => r.s); // 최근 5판
  const hs = (humanFac[f] || []).map(r => r.s);
  return {
    faction: f, n: recs.length, avg: avg(scores), min: Math.min(...scores), max: Math.max(...scores),
    recentAvg: avg(recent), humanAvg: hs.length ? avg(hs) : null, gap: hs.length ? avg(hs) - avg(scores) : null,
  };
}).sort((a, b) => a.avg - b.avg); // 약한 순

const fmt = n => n == null ? '  -' : n.toFixed(0).padStart(3);
let md = `# 종족별 봇 성적 (실전 1:3, 약한 순)\n\n`;
md += `_${games}게임 집계 · 봇=상대좌석, 사람=같은 종족 둔 유저 평균(목표치)_\n\n`;
md += `| # | 종족 | 봇평균 | 판수 | 최근5 | 최저~최고 | 사람평균 | 격차 |\n|--|--|--|--|--|--|--|--|\n`;
rows.forEach((r, i) => {
  md += `| ${i + 1} | ${r.faction} | **${fmt(r.avg)}** | ${r.n} | ${fmt(r.recentAvg)} | ${fmt(r.min)}~${fmt(r.max)} | ${fmt(r.humanAvg)} | ${r.gap == null ? '-' : '+' + r.gap.toFixed(0)} |\n`;
});
fs.writeFileSync(OUT, md);

console.log(`\n=== 종족별 봇 성적 (실전 ${games}게임, 약한 순 — 위에서부터 교정 우선) ===`);
console.log('종족'.padEnd(15) + '봇평균  판수  최근5  최저~최고  사람평균(목표)');
rows.forEach(r => {
  console.log(
    r.faction.padEnd(15) +
    fmt(r.avg) + '   ' + String(r.n).padStart(2) + '   ' + fmt(r.recentAvg) + '   ' +
    (fmt(r.min) + '~' + fmt(r.max)).padStart(8) + '   ' + fmt(r.humanAvg) +
    (r.gap != null ? `  (격차 +${r.gap.toFixed(0)})` : '')
  );
});
console.log(`\n저장: ${OUT}`);
