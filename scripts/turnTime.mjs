// 플레이어별 '중요 턴'(메인 액션 1회 = 1턴)당 소요 시간. 사람 4명만 참여한 게임 기준.
// 턴 시간 = 그 턴의 메인 액션 직전까지 그 플레이어의 (자유액션 포함) 로그 항목들이 직전 로그 대비 쓴 시간의 합.
// 파워 받기/거절, 수입 순서는 '턴'이 아니라 응답이라 제외. 한 간격 5분 초과는 자리 비움으로 제외.
import fs from 'fs';
const d = 'data/human-games/';
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['마루', '시리', '지수홍', '아이페르'];
const MAIN = /^(Built Mine|Built Parasitic|Advanced Research|Upgraded to|Power Action|Rebellion|Eclipse|Twilight|Entered Ship|TF Mars|Placed Gaiaformer|Used Tech Action|Bonus Action|Federation$|Artifact|Ship Tech|Final Mission|Academy|Selected Bonus)/;
const SKIP = /^(Received Power|Declined Power|Income Order|Federation Reward|Power Burn)/; // 응답/부수 항목
const CAP = 300;
const med = (a) => { a = [...a].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const S = {};
for (const f of fs.readdirSync(d).filter((f) => f.endsWith('.json'))) {
  let g;
  try { g = JSON.parse(fs.readFileSync(d + f, 'utf8')); } catch { continue; }
  const ps = Object.values(g.players || {});
  if (ps.length !== 4 || (g.botPlayerIds || []).length > 0 || ps.some((p) => /^AI Bot/.test(p.name))) continue;
  const L = (g.fullGameLog || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  if (L.length < 50) continue;
  const acc = {}; // 진행 중인 턴 누적
  for (let i = 1; i < L.length; i++) {
    const e = L[i];
    if (e.phase !== 'main' || e.round < 1 || SKIP.test(e.action)) continue;
    const gap = (e.timestamp - L[i - 1].timestamp) / 1000;
    if (gap < 0 || gap > CAP) { if (MAIN.test(e.action)) acc[e.playerName] = 0; continue; }
    acc[e.playerName] = (acc[e.playerName] || 0) + gap;
    if (MAIN.test(e.action)) {
      (S[e.playerName] ??= { turns: [], games: new Set() });
      S[e.playerName].turns.push(acc[e.playerName]);
      S[e.playerName].games.add(f);
      acc[e.playerName] = 0;
    }
  }
}
console.log('| 플레이어 | 게임 | 턴 수 | 턴당 평균(초) | 턴당 중앙값(초) | 턴당 평균 |');
console.log('|---|---|---|---|---|---|');
for (const nm of names) {
  const s = S[nm];
  if (!s) continue;
  const mean = s.turns.reduce((a, b) => a + b, 0) / s.turns.length;
  const fmt = (x) => `${Math.floor(x / 60)}분 ${Math.round(x % 60)}초`;
  console.log(`| ${nm} | ${s.games.size} | ${s.turns.length} | ${mean.toFixed(1)} | ${med(s.turns).toFixed(1)} | ${fmt(mean)} |`);
}
