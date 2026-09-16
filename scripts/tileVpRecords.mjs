/**
 * 인공물별 · 고급 기술 타일별 '한 판에서 그 타일로 가장 많이 벌어간 사람' 기록.
 *
 * 사용자 질문(2026-09-16): "각 인공물별, 고급 기술 타일별 점수 제일 많이 획득한 사람과 점수".
 * 점수가 고정된 인공물(7VP+가상광산, 트랙레벨×3 = 최고 15)은 제외(사용자 지정) — --all 로 포함.
 *
 * 집계: scoreBreakdown.other 의 'Artifact: …' 항목(인공물), scoreBreakdown.techTiles 의 adv-* 항목(득점마다 1행 → 합산).
 * 대상: 전원 사람 4인 게임 · 계정 통합 · 제외 게임 (stats-site/lib/common.mjs 표준 전처리).
 * 사용: node scripts/tileVpRecords.mjs [--all] [--top 3]
 */
import { loadGames, canon, gameRanks } from '../stats-site/lib/common.mjs';
import { factionKo } from '../stats-site/lib/factions.mjs';

const argv = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const TOP = Number(argv('--top', 3));
const ALL = process.argv.includes('--all');

// scoreBreakdown.other source → 표시명. fixed=true 는 점수 고정(또는 트랙레벨×3)이라 기본 제외
const ARTS = {
  'Artifact: Planet types': { label: '3 + 행성유형 VP' },
  'Artifact: Bridge VP': { label: '외곽 구역 ×3 VP' },
  'Artifact: Tracks >= 3': { label: '3레벨↑ 트랙 ×3 VP' },
  'Artifact: Gaia x 3': { label: '가이아 트랙 ×3 VP', fixed: true },
  'Artifact: Science x 3': { label: '과학 트랙 ×3 VP', fixed: true },
  'Artifact: 7 VP + Asteroid': { label: '7VP + 가상광산(소행성)', fixed: true },
  'Artifact: 7 VP + Proto': { label: '7VP + 가상광산(프로토)', fixed: true },
};
const ADV = {
  'adv-vp-build-mine': '광산 건설마다 3VP', 'adv-vp-build-ts': '교역소 건설마다 3VP',
  'adv-vp-research': '연구 전진마다 2VP', 'adv-vp-terraform': '테라포밍 스텝마다 2VP', 'adv-vp-qic-action': '정큐 액션마다 4VP',
  'adv-imm-4vp-ts': '즉시: 교역소×4 VP', 'adv-imm-2vp-mine': '즉시: 광산×2 VP', 'adv-imm-2vp-sector': '즉시: 섹터×2 VP',
  'adv-imm-4vp-outer': '즉시: 외곽 섹터×4 VP', 'adv-imm-6vp-big': '즉시: 대형건물×6 VP', 'adv-imm-2vp-gaia': '즉시: 가이아×2 VP',
  'adv-imm-5vp-fed': '즉시: 연방×5 VP',
  'adv-pass-1vp-type': '패스: 행성유형×1 VP', 'adv-pass-3vp-lab': '패스: 연구소×3 VP', 'adv-pass-3vp-fed': '패스: 연방×3 VP',
  'adv-pass-2vp-asteroid': '패스: 소행성×2 VP', 'adv-pass-2vp-outer': '패스: 외곽 섹터×2 VP',
};

const games = loadGames();
const artCases = {}; // source -> [{vp,name,faction,date,score,rank}]
const advCases = {}; // tileId -> same
for (const { file, game: g } of games) {
  const date = file.slice(0, 10);
  const ranks = gameRanks(g);
  for (const p of Object.values(g.players)) {
    const name = canon(p.name);
    const rk = ranks.find((r) => r.name === name && r.faction === p.faction)?.rank ?? p.rank;
    const base = { name, faction: factionKo(p.faction), date, score: p.score ?? 0, rank: rk };
    // 인공물: 같은 인공물은 한 판에 1회만 발동하지만 혹시 중복 기록되면 합산
    const a = {};
    for (const o of p.scoreBreakdown?.other ?? []) if (o.source in ARTS) a[o.source] = (a[o.source] ?? 0) + (o.vp ?? 0);
    for (const [src, vp] of Object.entries(a)) (artCases[src] ??= []).push({ ...base, vp });
    const t = {};
    for (const e of p.scoreBreakdown?.techTiles ?? []) if (e.tileId in ADV) t[e.tileId] = (t[e.tileId] ?? 0) + (e.vp ?? 0);
    for (const [id, vp] of Object.entries(t)) (advCases[id] ??= []).push({ ...base, vp });
  }
}

const fmt = (c) => `${c.name}(${c.faction}) ${c.vp}점 · ${c.date} · 최종 ${c.score}점 ${c.rank}위`;
function report(title, cases, labelOf) {
  console.log(`\n## ${title}  (사람 4인 게임 ${games.length}판)\n`);
  const rows = Object.entries(cases).sort((x, y) => Math.max(...y[1].map((c) => c.vp)) - Math.max(...x[1].map((c) => c.vp)));
  for (const [id, list] of rows) {
    list.sort((x, y) => y.vp - x.vp || y.score - x.score);
    const n = list.length, avg = (list.reduce((s, c) => s + c.vp, 0) / n).toFixed(1);
    console.log(`### ${labelOf(id)}  — 획득 ${n}회, 평균 ${avg}점`);
    const best = list[0].vp;
    const ties = list.filter((c) => c.vp === best);
    for (const c of ties) console.log(`  1위  ${fmt(c)}`);
    for (const c of list.filter((c) => c.vp < best).slice(0, Math.max(0, TOP - 1))) console.log(`  -    ${fmt(c)}`);
  }
}
const artShown = Object.fromEntries(Object.entries(artCases).filter(([s]) => ALL || !ARTS[s].fixed));
report('인공물', artShown, (s) => ARTS[s].label);
report('고급 기술 타일', advCases, (id) => ADV[id]);
