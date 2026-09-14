// 채택된 뱃지(업적) 달성자 목록 — 사용자가 실제로 넣은 뱃지만. 사용: node scripts/badgeHolders.mjs
// 기준: 사람 4인 게임(표준 필터, 계정 통합·제외 게임 적용). 새 뱃지가 채택되면 BADGES에 조건 하나 추가.
// 후보 탐색(아직 뱃지 아닌 희귀 기록)은 scripts/achievementCandidates.mjs.
import { loadGames, canon, gameRanks } from '../stats-site/lib/common.mjs';
import { FACTION_KO } from '../stats-site/lib/factions.mjs';

const fedIds = (p) => (p.federations ?? []).map((f) => (typeof f === 'string' ? f : f.rewardId));
/** 한 판에서 그 사람이 집은 인공물 수 — gameLog의 art-* tileId로 셈(연방 혜택 인공물은 ship-fed-* 줄이 따라붙어 중복되므로 art-만) */
const artifactCount = (g, pid) => new Set((g.gameLog ?? []).filter((e) => e.playerId === pid && /^Artifact/.test(e.action ?? '') && /^art-/.test(e.tileId ?? '')).map((e) => `${e.tileId}@${e.timestamp}`)).size;
const shipEntries = (p) => (p.scoreBreakdown?.other ?? []).filter((o) => o.source === '우주선 입장').length;

/** 뱃지 정의: id, 이름, 조건(g, pid, p, won) → boolean.  won = 그 판 1위(동점 포함) */
export const BADGES = [
  { id: 'win-free-mine-fed', name: '무한거리 광산 연방 먹고 승리', test: (g, pid, p, won) => won && fedIds(p).includes('ship-fed-mine-free') },
  { id: 'win-4-artifacts', name: '계란(인공물) 4개 먹고 승리', test: (g, pid, p, won) => won && artifactCount(g, pid) >= 4 },
  { id: 'win-no-ship', name: '우주선 안 들어가고 승리', test: (g, pid, p, won) => won && shipEntries(p) === 0 },
  { id: 'win-4-adv-tiles', name: '고급 기술 타일 4개 먹고 승리', test: (g, pid, p, won) => won && (p.techTiles ?? []).filter((t) => t.startsWith('adv-')).length >= 4 },
  { id: 'win-act-3k', name: 'ACT 3K 기술 타일 먹고 승리', test: (g, pid, p, won) => won && (p.techTiles ?? []).includes('adv-act-3k') },
];

const games = loadGames();
const out = Object.fromEntries(BADGES.map((b) => [b.id, []]));
for (const { file, game: g } of games) {
  const ranks = gameRanks(g);
  for (const [pid, p] of Object.entries(g.players)) {
    const n = canon(p.name); const r = ranks.find((x) => x.name === n && x.faction === p.faction); const won = r?.rank === 1;
    for (const b of BADGES) if (b.test(g, pid, p, won)) out[b.id].push({ n, d: file.slice(0, 10), fac: FACTION_KO[p.faction] ?? p.faction, score: p.score ?? 0, id: g.gameId ?? file });
  }
}
console.log(`사람 4인 게임 ${games.length}판 기준 뱃지 달성자\n`);
for (const b of BADGES) {
  const list = out[b.id]; const by = {}; for (const x of list) (by[x.n] ??= []).push(x);
  console.log(`## ${b.name} — ${list.length}회 · ${Object.keys(by).length}명`);
  for (const [n, xs] of Object.entries(by).sort((a, b2) => b2[1].length - a[1].length)) console.log(`  ${n}${xs.length > 1 ? ` ×${xs.length}` : ''}: ${xs.map((x) => `${x.d} ${x.fac} ${x.score}점`).join(' / ')}`);
  if (!list.length) console.log('  (아직 없음)');
  console.log('');
}
