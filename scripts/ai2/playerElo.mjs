// [ai2 2026-10-19] 사람 실력 점수 = 사람 4인 완주 게임 전체(봇 낀 판 제외)의 Elo(판 안 쌍대 비교, 시간순, K=16).
//   이전 '실력 가중'은 상태 기록이 있는 60판만 보고 (점수−상대 평균)으로 매겨 순위가 크게 틀렸다(사용자 지적).
//   출력: data/ai2/player_elo.json { 이름: { elo, games } }   사용: node scripts/ai2/playerElo.mjs
import fs from 'fs';
const dir = 'data/human-games'; const games = [];
for (const f of fs.readdirSync(dir).sort()) {
  let d; try { d = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')); } catch { continue; }
  const ids = Object.keys(d.players || {});
  if (ids.length !== 4 || (d.botPlayerIds || []).length || d.roundNumber !== 6) continue;
  const sc = ids.map(id => ({ n: (d.players[id].name || '').trim(), s: d.players[id].score || 0 }));
  if (sc.some(x => !x.n || /^AI Bot/.test(x.n))) continue;
  games.push(sc);
}
const elo = {}, cnt = {}; const K = 16;
for (const g of games) {
  const r = g.map(x => elo[x.n] ?? 1500); const d = g.map(() => 0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i !== j) {
    const e = 1 / (1 + 10 ** ((r[j] - r[i]) / 400)); const s = g[i].s > g[j].s ? 1 : g[i].s < g[j].s ? 0 : 0.5; d[i] += K * (s - e) / 3;
  }
  g.forEach((x, i) => { elo[x.n] = r[i] + d[i]; cnt[x.n] = (cnt[x.n] || 0) + 1; });
}
const out = Object.fromEntries(Object.keys(elo).map(n => [n, { elo: Math.round(elo[n]), games: cnt[n] }]));
fs.writeFileSync('data/ai2/player_elo.json', JSON.stringify(out, null, 1));
console.log(`사람 4인 게임 ${games.length}판 · ${Object.keys(out).length}명 → data/ai2/player_elo.json`);
