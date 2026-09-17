// 채택된 뱃지(업적) 달성자 목록 — 사용자가 실제로 넣은 뱃지만. 사용: node scripts/badgeHolders.mjs
// 기준: 사람 4인 게임(표준 필터, 계정 통합·제외 게임 적용). 새 뱃지가 채택되면 BADGES에 조건 하나 추가.
// 후보 탐색(아직 뱃지 아닌 희귀 기록)은 scripts/achievementCandidates.mjs.
import { loadGames, canon, gameRanks } from '../stats-site/lib/common.mjs';
import { FACTION_KO } from '../stats-site/lib/factions.mjs';
import { FACTIONS } from '../shared/gameConfig.ts';

const fedIds = (p) => (p.federations ?? []).map((f) => (typeof f === 'string' ? f : f.rewardId));
/** 한 판에서 그 사람이 집은 인공물 수 — gameLog의 art-* tileId로 셈(연방 혜택 인공물은 ship-fed-* 줄이 따라붙어 중복되므로 art-만) */
const artifactCount = (g, pid) => new Set((g.gameLog ?? []).filter((e) => e.playerId === pid && /^Artifact/.test(e.action ?? '') && /^art-/.test(e.tileId ?? '')).map((e) => `${e.tileId}@${e.timestamp}`)).size;
const NORMAL_TECH9 = new Set(['tech-inc-1o-1p', 'tech-inc-4c', 'tech-inc-1k-1c', 'tech-imm-7vp', 'tech-imm-1k-planet', 'tech-imm-1o-1q', 'tech-gaia-3vp', 'tech-big-4str', 'tech-act-4p']);
/** 게임 중 획득한 일반 기술 타일 9종 집합 — 고급 타일로 덮여 종료 techTiles에서 빠진 것도 포함 (Gained Tech Tile / Rebellion / Advanced Tech Tile 로그의 tileId·details) */
const normalTechAcquired = (g, pid) => {
  const got = new Set();
  for (const e of (g.fullGameLog ?? g.gameLog ?? [])) {
    if (e.playerId !== pid || !/Gained Tech Tile|Rebellion: Gained Tech|Advanced Tech Tile/.test(e.action ?? '')) continue;
    for (const id of [e.tileId, ...((e.details ?? '').match(/(?<![a-z-])tech-[a-z0-9-]+/g) ?? [])]) if (NORMAL_TECH9.has(id)) got.add(id);
  }
  return got;
};
const shipEntries = (p) => (p.scoreBreakdown?.other ?? []).filter((o) => o.source === '우주선 입장').length;
/** 그 사람이 건물을 지은 가이아 행성 수 — 가이아포밍한 초차원도 저장 시점 type이 'gaia'라 함께 세진다(isGaiaformed 플래그 불필요) */
/** 종족 id → 홈 행성 타입 / 시작 광산 수 (shared 설정을 그대로 읽는다 — 여기 다시 적으면 갈라진다) */
const HOME = Object.fromEntries(FACTIONS.map((f) => [f.id, f.homePlanet]));
const START_MINES = Object.fromEntries(FACTIONS.map((f) => [f.id, f.startingMines ?? 2]));
/** 그 사람이 건물을 올린 모행성 타입 타일 수 (시작 광산 포함) */
const homePlanets = (g, pid, faction) => (g.map ?? []).filter((t) => t.ownerId === pid && t.structure && t.type === HOME[faction]).length;
const gaiaPlanets = (g, pid) => (g.map ?? []).filter((t) => t.ownerId === pid && t.structure && t.type === 'gaia').length;

/** 뱃지 정의: id, 이름, 조건(g, pid, p, won) → boolean.  won = 그 판 1위(동점 포함) */
export const BADGES = [
  { id: 'win-free-mine-fed', name: '무한거리 광산 연방 먹고 승리', test: (g, pid, p, won) => won && fedIds(p).includes('ship-fed-mine-free') },
  { id: 'win-4-artifacts', name: '계란(인공물) 4개 먹고 승리', test: (g, pid, p, won) => won && artifactCount(g, pid) >= 4 },
  { id: 'win-no-ship', name: '우주선 안 들어가고 승리', test: (g, pid, p, won) => won && shipEntries(p) === 0 },
  { id: 'win-4-adv-tiles', name: '고급 기술 타일 4개 먹고 승리', test: (g, pid, p, won) => won && (p.techTiles ?? []).filter((t) => t.startsWith('adv-')).length >= 4 },
  { id: 'win-act-3k', name: 'ACT 3K 기술 타일 먹고 승리', test: (g, pid, p, won) => won && (p.techTiles ?? []).includes('adv-act-3k') },
  // [사용자 2026-09-16] 일반 9종 전부(덮은 것 포함, 획득 로그 기준 — 저장 players엔 coveredTechTiles가 없음) + 아이타·파이락 제외. 서버 id와 동일.
  { id: 'normal_tech9_other_factions', name: '일반 기술 타일 9종 전부 획득 (아이타·파이락 제외)', winOnly: false,
    test: (g, pid, p, won) => !['itars', 'firaks'].includes(p.faction) && normalTechAcquired(g, pid).size >= 9 },
  // [사용자 2026-09-17] 가이아 행성 10개 이상 + 1위. 서버 BADGE_RULES와 같은 id.
  //   실측(사람 4인 327판): 10개 이상 17회·11명 중 1위는 4명뿐(최고 11개).
  { id: 'gaia10-win', name: '가이아 행성 10개 먹고 승리',
    test: (g, pid, p, won) => won && gaiaPlanets(g, pid) >= 10 },
  // [사용자 2026-09-17] 모행성을 시작 배치 말고는 추가로 점령하지 않고 1위. 시작 광산 2개 종족만 대상(1개 종족은 거저 됨, 제노스는 3개).
  //   시작 광산을 행성의회·아카데미로 키우는 건 무관 — 타일 수만 본다(실측 달성자 10명 전원이 업그레이드함).
  { id: 'no-extra-home-win', name: '모행성 안 늘리고 승리',
    test: (g, pid, p, won) => won && START_MINES[p.faction] === 2 && (g.map ?? []).length > 0 && homePlanets(g, pid, p.faction) <= 2 },
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
