// 실게임(1:3) 봇 연방 수 추적 — 연방 목표(최소2/평균3) 스코어보드. usage: node scripts/fedTracker.mjs [YYYY-MM-DD부터]
import fs from 'fs';
const since = process.argv[2] || '2026-07-11';
const files = fs.readdirSync('data/human-games').filter(f => f.endsWith('.json') && f >= since).sort();
let rows = [];
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync('data/human-games/' + f, 'utf8')); } catch { continue; }
  const bots = new Set(g.botPlayerIds || []);
  for (const [pid, p] of Object.entries(g.players || {})) {
    if (!bots.has(pid) || p.score == null) continue;
    rows.push({ game: f.replace('.json', ''), faction: p.faction, feds: (p.federations || []).length, vp: p.score });
  }
}
if (!rows.length) { console.log('대상 게임 없음 (since ' + since + ')'); process.exit(0); }
const avg = rows.reduce((s, r) => s + r.feds, 0) / rows.length;
const under2 = rows.filter(r => r.feds < 2).length;
console.log(`봇 ${rows.length}석 | 연방 평균 ${avg.toFixed(2)} | 2개 미만 ${under2}석 (${(under2 / rows.length * 100).toFixed(0)}%) | 목표: 평균3·최소2`);
for (const r of rows) console.log(`  ${r.game} ${r.faction} fed${r.feds} vp${r.vp}`);
