// 사용자별 플레이 시간 리포트 — data/human-games의 fullGameLog timestamp 기반.
// 사용: node scripts/usageReport.mjs [일수]   (예: 7 → 최근 7일만)
import fs from 'fs';
const days = parseInt(process.argv[2] || '0', 10);
const cutoff = days > 0 ? Date.now() - days * 86400_000 : 0;
const files = fs.readdirSync('data/human-games').filter(f => f.endsWith('.json'));
const per = {};
let games = 0;
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync('data/human-games/' + f, 'utf8')); } catch { continue; }
  const bots = new Set(g.botPlayerIds || []);
  const byPid = {};
  for (const e of g.fullGameLog || []) { if (e.playerId && e.timestamp) (byPid[e.playerId] ??= []).push(e.timestamp); }
  let counted = false;
  for (const [pid, ts] of Object.entries(byPid)) {
    if (bots.has(pid)) continue;
    const start = Math.min(...ts);
    if (cutoff && start < cutoff) continue;
    const name = g.players?.[pid]?.name; if (!name) continue;
    const p = per[name] ??= { games: 0, min: 0, days: new Set() };
    p.games++; p.min += (Math.max(...ts) - start) / 60000; p.days.add(new Date(start).toISOString().slice(0, 10));
    counted = true;
  }
  if (counted) games++;
}
console.log(`${days > 0 ? `최근 ${days}일` : '전체'} · 게임 ${games}판\n이름              게임수   총 플레이   활동일수`);
Object.entries(per).sort((a, b) => b[1].min - a[1].min)
  .forEach(([n, p]) => console.log(`${n.padEnd(14)} ${String(p.games).padStart(4)}   ${(p.min / 60).toFixed(1)}시간   ${p.days.size}일`));
