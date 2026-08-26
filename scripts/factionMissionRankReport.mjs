// 종족별 · 최종미션별 최종 등수 통계 — 4인 전원 사람 완주 판만.
// 라운드 미션(rs*)은 저장 로그에 어떤 미션인지 남지 않아 최종 미션(fm_*)만 다룬다.
// 실행: node scripts/factionMissionRankReport.mjs
import fs from 'fs';
import path from 'path';

const DIR = 'data/human-games';
const isBot = (g, pid) => (g.botPlayerIds ?? []).includes(pid) || /^AI Bot/.test(g.players?.[pid]?.name ?? '');

const NAME = {
  terran: 'Terrans', lantids: 'Lantids', hadsch_hallas: 'Hadsch Hallas', ivits: 'Ivits',
  geodens: 'Geodens', bal_tak: "Bal T'aks", xenos: 'Xenos', gleens: 'Gleens',
  taklons: 'Taklons', ambas: 'Ambas', bescods: 'Bescods', firaks: 'Firaks',
  itars: 'Itars', nevlas: 'Nevlas', moweyip: 'Moweyds', space_giants: 'Space Giants',
  tinkeroids: 'Tinkeroids', darkanians: 'Darkanians',
};
const FM = {
  fm_total_structures: '건물 수', fm_federation_buildings: '연방 건물', fm_sectors: '섹터 수',
  fm_outer_sectors: '외곽 섹터', fm_gaia_planets: '가이아 행성', fm_satellites: '위성 수',
  fm_pi_academy_distance: '의회-아카데미 거리', fm_planet_types: '행성 유형', fm_asteroid_buildings: '소행성 건물',
};

const byFaction = {};   // faction -> {games, ranks:[n1,n2,n3,n4], sum}
const byMission = {};   // fm -> {games:Set-count}
const cell = {};        // faction|fm -> {n, sum, wins}
let games = 0;

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  let g; try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  const ids = Object.keys(g.players ?? {});
  if (ids.length !== 4 || ids.some((k) => isBot(g, k))) continue;
  const ranked = ids.map((id) => g.players[id]).filter((p) => p.faction && p.rank >= 1 && p.rank <= 4);
  if (ranked.length !== 4) continue;
  games++;
  // 이 판의 최종 미션 2개 — 아무 플레이어의 finalMissionDetails에서
  const fms = [...new Set(ranked.flatMap((p) => (p.scoreBreakdown?.finalMissionDetails ?? []).map((d) => d.missionId)))];
  for (const p of ranked) {
    const b = byFaction[p.faction] ??= { games: 0, ranks: [0, 0, 0, 0], sum: 0 };
    b.games++; b.ranks[p.rank - 1]++; b.sum += p.rank;
    for (const fm of fms) {
      const c = cell[p.faction + '|' + fm] ??= { n: 0, sum: 0, wins: 0 };
      c.n++; c.sum += p.rank; if (p.rank === 1) c.wins++;
    }
  }
  for (const fm of fms) (byMission[fm] ??= { games: 0 }).games++;
}

console.log(`4인 전원 사람 완주 판 ${games}개\n`);
console.log('■ 종족별 최종 등수');
console.log('종족'.padEnd(14) + '판'.padStart(4) + '  1등 2등 3등 4등' + '  평균등수  우승률');
for (const [fac, b] of Object.entries(byFaction).sort((a, c) => a[1].sum / a[1].games - c[1].sum / c[1].games)) {
  const r = b.ranks;
  console.log((NAME[fac] ?? fac).padEnd(14) + String(b.games).padStart(4)
    + `  ${String(r[0]).padStart(3)} ${String(r[1]).padStart(3)} ${String(r[2]).padStart(3)} ${String(r[3]).padStart(3)}`
    + `   ${(b.sum / b.games).toFixed(2)}   ${(100 * r[0] / b.games).toFixed(0)}%`);
}
console.log('\n■ 최종 미션별 등장 판수');
for (const [fm, m] of Object.entries(byMission).sort((a, c) => c[1].games - a[1].games))
  console.log(`  ${(FM[fm] ?? fm).padEnd(14)} ${m.games}판`);

console.log('\n■ 종족 × 최종미션 — 그 미션이 뜬 판에서의 평균 등수 (판수 3 미만은 · )');
const fms = Object.keys(byMission).sort((a, c) => byMission[c].games - byMission[a].games);
console.log('종족'.padEnd(14) + fms.map((f) => (FM[f] ?? f).slice(0, 5).padStart(7)).join(''));
for (const fac of Object.keys(byFaction).sort((a, c) => byFaction[a].sum / byFaction[a].games - byFaction[c].sum / byFaction[c].games)) {
  let row = (NAME[fac] ?? fac).padEnd(14);
  for (const fm of fms) {
    const c = cell[fac + '|' + fm];
    row += (c && c.n >= 3 ? (c.sum / c.n).toFixed(1) + '/' + c.n : '·').padStart(7);
  }
  console.log(row);
}
