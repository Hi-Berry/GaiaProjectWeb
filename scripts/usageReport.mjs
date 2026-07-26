// 사용자별 실제 턴 소모시간 리포트 — 각 액션이 '직전 액션 이후 경과시간'을 행위자에게 귀속.
// (참여구간 방식은 4인 게임에서 4배 과대 → 이 방식이 "누가 몇 분 썼나"의 정답. 5분 초과 공백은 캡.)
// 사용: node scripts/usageReport.mjs [일수]
import fs from 'fs';
const days = parseInt(process.argv[2] || '0', 10);
const cutoff = days > 0 ? Date.now() - days * 86400_000 : 0;
const files = fs.readdirSync('data/human-games').filter(f => f.endsWith('.json'));
const per = {}; let games = 0;
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync('data/human-games/' + f, 'utf8')); } catch { continue; }
  const bots = new Set(g.botPlayerIds || []);
  const fl = (g.fullGameLog || []).filter(e => e.timestamp && e.playerId).sort((a, b) => a.timestamp - b.timestamp);
  if (fl.length < 2) continue;
  if (cutoff && fl[0].timestamp < cutoff) continue;
  const day = new Date(fl[0].timestamp).toISOString().slice(0, 10);
  let counted = false;
  for (let i = 1; i < fl.length; i++) {
    const gap = Math.min(300, (fl[i].timestamp - fl[i - 1].timestamp) / 1000);
    const pid = fl[i].playerId;
    if (bots.has(pid)) continue;
    const name = g.players?.[pid]?.name; if (!name) continue;
    const p = per[name] ??= { games: new Set(), sec: 0, days: new Set() };
    p.sec += gap; p.games.add(f); p.days.add(day); counted = true;
  }
  if (counted) games++;
}
console.log(`${days > 0 ? `최근 ${days}일` : '전체'} · 게임 ${games}판 · (턴 소모시간 귀속 방식, 5분 초과 공백 캡)\n이름              게임수   턴 소모시간   활동일수`);
Object.entries(per).sort((a, b) => b[1].sec - a[1].sec)
  .forEach(([n, p]) => console.log(`${n.padEnd(14)} ${String(p.games.size).padStart(4)}   ${(p.sec / 3600).toFixed(1)}시간   ${p.days.size}일`));
