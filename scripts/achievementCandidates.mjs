// 업적(achievement) 후보 채굴 — 사람 4인 게임에서 희귀 기록(판 단위·누적)을 세고 달성자를 나열. 사용: node scripts/achievementCandidates.mjs
// 주의: 이 구현에서 항법 5단계 = 잃어버린 행성 자동 획득이라 둘은 같은 기록. 트랙 5단계·연방 5개·타일 10장은 이 모임에선 흔해 업적감 아님(2026-09-14 기준).
import { loadGames, canon, gameRanks } from '../stats-site/lib/common.mjs';
import { FACTION_KO } from '../stats-site/lib/factions.mjs';
const games = loadGames();
const TRACKS = ['terraforming','navigation','artificialIntelligence','gaiaProject','economy','science'];
const TK = { terraforming:'삽', navigation:'항법', artificialIntelligence:'AI', gaiaProject:'가이아', economy:'경제', science:'과학' };
const fedIds = (p) => (p.federations ?? []).map((f) => (typeof f === 'string' ? f : f.rewardId));
const A = {};
const hit = (k, name, tag, val) => (A[k] ??= []).push({ name, tag, val });
const fk = (f) => FACTION_KO[f] ?? f;
const perPlayer = {};
for (const { file, game: g } of games) {
  const P = g.players; const ranks = gameRanks(g); const d = file.slice(0, 10);
  const ids = Object.keys(P); const order = g.turnOrder?.length ? g.turnOrder : ids;
  const board = {};
  for (const e of g.gameLog ?? []) if (e.snap && e.playerId) (board[e.round ?? 0] ??= {})[e.playerId] = e.snap.vp ?? 0;
  const scores = ids.map((id) => P[id].score ?? 0).sort((a, b) => b - a);
  const hasMap = (g.map ?? []).length > 0;
  for (const id of ids) {
    const p = P[id]; const n = canon(p.name); const r = ranks.find((x) => x.name === n && x.faction === p.faction); const won = r?.rank === 1;
    const tag = `${d} ${fk(p.faction)} ${p.score}점`; const sb = p.scoreBreakdown ?? {};
    const pp = perPlayer[n] ??= { games: 0, wins: 0, factions: new Set(), winFactions: new Set(), bestStreak: 0, seq: [] };
    pp.games++; pp.factions.add(p.faction); if (won) { pp.wins++; pp.winFactions.add(p.faction); }
    pp.seq.push({ t: g.completedAt ?? g.createdAt ?? Date.parse(d), won, rank: r?.rank ?? 0 });
    const b = { M: 0, T: 0, L: 0, P: 0, A: 0, gaia: 0, types: new Set() };
    for (const t of g.map ?? []) {
      if (t.ownerId !== id || !t.structure) continue; const s = t.structure;
      if (s === 'mine' || s === 'lost_planet_mine') b.M++; else if (s === 'trading_station') b.T++; else if (s === 'research_lab') b.L++; else if (s === 'planetary_institute') b.P++; else if (s === 'academy') b.A++;
      if (t.type === 'gaia' || t.isGaiaformed) b.gaia++; b.types.add(t.type);
    }
    const res = p.research ?? {}; const lv5 = TRACKS.filter((t) => (res[t] ?? 0) >= 5); const totalLv = TRACKS.reduce((s, t) => s + (res[t] ?? 0), 0);
    const bid = -(sb.other ?? []).filter((o) => o.source === '종족 비딩').reduce((s, o) => s + (o.vp ?? 0), 0);
    const leech = Math.abs(typeof sb.powerReceived === 'number' ? sb.powerReceived : (sb.powerReceived ?? []).reduce((s, x) => s + (x.vp ?? 0), 0));
    const feds = fedIds(p); const tiles = p.techTiles ?? []; const adv = tiles.filter((t) => t.startsWith('adv-')).length;
    const shipEnter = (sb.other ?? []).filter((o) => o.source === '우주선 입장').length;
    const arts = (sb.other ?? []).filter((o) => /^Artifact/i.test(o.source ?? '')).length;
    const remain = sb.remainingResources ?? 0;
    const margin = won ? scores[0] - scores[1] : 0;
    const isLastAt = (rd) => { const v = board[rd]?.[id]; if (v == null) return false; const others = ids.filter((o) => o !== id).map((o) => board[rd]?.[o] ?? 0); return others.every((x) => x >= v) && others.some((x) => x > v); };
    if (p.score >= 250) hit('250점 클럽', n, tag, p.score); else if (p.score >= 220) hit('220점 클럽', n, tag, p.score);
    if (won && p.score < 150) hit('최저점 1위 (150 미만)', n, tag, -p.score);
    if (!won && p.score >= 200) hit('200점 넘고도 1위 못함', n, tag + ` (${r.rank}위)`, p.score);
    if (won && margin >= 50) hit('압승 (2위와 50점 차 이상)', n, tag + ` +${margin}`, margin);
    if (won && ranks.filter((x) => x.rank === 1).length >= 2) hit('공동 1위(동점)', n, tag, p.score);
    if (won && margin === 1) hit('1점 차 승리', n, tag, 1);
    if (!won && r && scores[0] - p.score === 1) hit('1점 차 패배', n, tag, 1);
    if (won && hasMap && b.P === 0) hit('행성의회 없이 1위', n, tag, 0);
    if (hasMap && b.M === 8 && b.T === 4 && b.L === 3 && b.P === 1 && b.A === 2) hit('풀 빌드 (건물 18개 전부 배치)', n, tag, 18);
    if (hasMap && b.A === 2 && won) hit('아카데미 2개 짓고 1위', n, tag, 2);
    if (hasMap && b.types.size >= 8) hit('행성 유형 8종 이상 점유', n, tag, b.types.size);
    if (hasMap && b.gaia >= 5) hit('가이아 행성 5개 이상', n, tag, b.gaia);
    if (lv5.length >= 2) hit('연구 트랙 2개 5단계', n, tag + ` (${lv5.map((t) => TK[t]).join('·')})`, lv5.length);
    if (totalLv >= 24) hit('연구 총 24단계 이상', n, tag, totalLv);
    if (won && (res.terraforming ?? 0) === 0) hit('삽 0단계로 1위', n, tag, 0);
    if (won && (res.navigation ?? 0) === 0) hit('항법 0단계로 1위', n, tag, 0);
    if (won && lv5.length === 0 && totalLv <= 14) hit('연구 14단계 이하로 1위', n, tag, -totalLv);
    for (const t of TRACKS) if ((res[t] ?? 0) >= 5) { hit(`${TK[t]} 5단계 도달`, n, tag, 5); if (won) hit(`${TK[t]} 5단계 찍고 1위`, n, tag, 5); }
    if (won && tiles.length <= 2) hit('기술 타일 2장 이하로 1위', n, tag, -tiles.length);
    if (tiles.length >= 10) hit('기술 타일 10장 이상', n, tag, tiles.length);
    if (adv >= 4) hit('고급 타일 4장 이상', n, tag, adv);
    if (won && feds.length <= 1) hit('연방 1개 이하로 1위', n, tag, -feds.length);
    if (feds.length >= 5) hit('연방 5개 이상', n, tag, feds.length);
    if (won && feds.includes('fed-12vp')) hit('12VP 연방 먹고 1위', n, tag, 12);
    const lost = tiles.includes('lost-planet') || (g.map ?? []).some((t) => t.ownerId === id && t.structure === 'lost_planet_mine');
    if (lost) { hit('잃어버린 행성 획득', n, tag, 1); if (won) hit('잃어버린 행성 먹고 1위', n, tag, 1); }
    if (shipEnter >= 4) hit('우주선 4척 전부 입장', n, tag, shipEnter);
    if (won && shipEnter === 0) hit('우주선 한 척도 안 타고 1위', n, tag, 0);
    if (arts >= 3) hit('인공물 3개 이상', n, tag, arts);
    if (won && order.indexOf(id) === ids.length - 1) hit('마지막 순서 시작으로 1위', n, tag, 4);
    if (won && bid >= 15) hit('비딩 15점 이상 내고 1위', n, tag + ` (비딩 ${bid})`, bid);
    if (won && leech >= 15) hit('파워 리치로 15점 이상 잃고 1위', n, tag + ` (-${leech})`, leech);
    if (won && isLastAt(4)) hit('4라운드 끝 꼴찌에서 1위 (대역전)', n, tag + ` (R4 ${board[4][id]}점)`, 1);
    else if (won && isLastAt(3)) hit('3라운드 끝 꼴찌에서 1위 (역전)', n, tag + ` (R3 ${board[3][id]}점)`, 1);
    if (won && remain === 0) hit('잔여 자원 0으로 1위 (완전 소진)', n, tag, 0);
    if (remain >= 10) hit('잔여 자원 점수 10 이상 (자원 부자)', n, tag, remain);
  }
}
const cum = [];
for (const [n, pp] of Object.entries(perPlayer)) {
  pp.seq.sort((a, b) => a.t - b.t); let s = 0; for (const x of pp.seq) { s = x.won ? s + 1 : 0; pp.bestStreak = Math.max(pp.bestStreak, s); }
  let ls = 0, worst = 0; for (const x of pp.seq) { ls = x.rank === 4 ? ls + 1 : 0; worst = Math.max(worst, ls); }
  let ns = 0, noWin = 0; for (const x of pp.seq) { ns = x.won ? 0 : ns + 1; noWin = Math.max(noWin, ns); }
  cum.push({ n, games: pp.games, wins: pp.wins, fac: pp.factions.size, winFac: pp.winFactions.size, streak: pp.bestStreak, worst, noWin });
}
const top = (k) => [...cum].sort((a, b) => b[k] - a[k]).slice(0, 5).map((x) => `${x.n} ${x[k]}`).join(', ');
console.log(`사람 4인 게임 ${games.length}판 · 플레이어 ${cum.length}명\n## 누적형`);
console.log('종족 가장 많이 써본 (18종 중):', top('fac'));
console.log('서로 다른 종족으로 1위:', top('winFac'));
console.log('연승 최고:', top('streak'));
console.log('연속 4위(꼴찌) 최고:', top('worst'));
console.log('무승 연속 최고:', top('noWin'));
console.log('총 1위 횟수:', top('wins'));
console.log('\n## 판 단위 업적 — 달성 횟수 · 달성자(횟수) | 대표 예시');
for (const k of Object.keys(A).sort((a, b) => A[a].length - A[b].length)) {
  const list = A[k]; const by = {}; for (const x of list) by[x.name] = (by[x.name] ?? 0) + 1;
  const holders = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(', ');
  const ex = [...list].sort((a, b) => b.val - a.val)[0];
  console.log(`- ${k}: ${list.length}회 · ${Object.keys(by).length}명 — ${holders} | 예) ${ex.name} ${ex.tag}`);
}
