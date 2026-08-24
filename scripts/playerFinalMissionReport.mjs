// 플레이어별(사람) 최종 미션 등장 횟수와 회당 평균 획득 VP — 4인 판만.
// 미션별 획득 VP는 scoreBreakdown.finalMissionDetails(vp, missionId)에서 읽는다.
// 주의: 0점 미션은 details에서 아예 빠진다(1040명 중 328명이 항목 2개 미만, vp=0 항목 0건).
//   → 판의 미션 목록은 4인 전원 details의 합집합으로 복원하고, 기록 없는 플레이어는 0점으로 센다.
// 실행: node scripts/playerFinalMissionReport.mjs
import fs from 'fs';
import path from 'path';

const DIR = 'data/human-games';
const isBot = (g, pid) => (g.botPlayerIds ?? []).includes(pid) || /^AI Bot/.test(g.players?.[pid]?.name ?? '');

const FM = {
  fm_total_structures: '건물수', fm_federation_buildings: '연방건물', fm_sectors: '섹터수',
  fm_outer_sectors: '외곽섹터', fm_gaia_planets: '가이아', fm_satellites: '위성수',
  fm_pi_academy_distance: '의회거리', fm_planet_types: '행성유형', fm_asteroid_buildings: '소행성',
};

// 표준 계정 통합(2026-08-18 사용자 확인, adv3kReport 등과 동일). 새 쌍을 넣기 전에
// '두 이름이 한 게임에 동시 등장하지 않는지'를 반드시 검사한다 — 동시 등장하면 다른 사람.
const ALIAS = {
  '암가': '타클론안함', '암컷가마우지': '타클론안함', '김지선': '타클론안함',
  '222': '하이', 'chrome': '하이', '산타': '디애박', '소통맨': '지수홍', '보노보노': 'mks',
  // [사용자 2026-08-24 이 리포트에서 추가 확인] Hi·HI=하이, 군성`=군성. 시리티드=시리,
  // Happygaia=행복가이아는 동시등장 검사 통과한 추정 쌍.
  'Hi': '하이', 'HI': '하이', '군성`': '군성', '시리티드': '시리', 'Happygaia': '행복가이아',
};
const canon = (name) => ALIAS[name] ?? name;
/** [사용자 2026-08-11] 두 사람이 계정 2개씩 쓴 판(chrome·Hi=하이 / 산타·디애박=디애박) — 사람 단위 통계에서 제외 */
const EXCLUDE_GAMES = new Set(['2026-07-15_fi1njhdj.json']);

const byPlayer = {};      // name -> {games, n, sum}
const cell = {};          // name|fm -> {n, sum}
const fmSeen = {};        // fm -> instance count(플레이어 단위 아님, 판 단위)
let games = 0;

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  if (EXCLUDE_GAMES.has(f)) continue;
  let g; try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  const ids = Object.keys(g.players ?? {});
  if (ids.length !== 4) continue;
  // [사용자 2026-08-24] 봇이 1명이라도 낀 판은 통째로 제외 — 전원 사람 4인 판만
  if (ids.some((id) => isBot(g, id))) continue;
  // 판의 최종 미션 목록: 전원(봇 포함) details 합집합 — 0점 미션은 개인 기록에서 빠지기 때문
  const gameFms = [...new Set(ids.flatMap((id) => (g.players[id].scoreBreakdown?.finalMissionDetails ?? []).map((d) => d.missionId)))];
  if (gameFms.length === 0) continue; // breakdown 없는 판(미완주·구버전 저장)은 제외
  // 최종 점수까지 간 사람 플레이어만 집계 (breakdown 자체가 없는 개인은 판정 불가라 제외)
  const humans = ids.filter((id) => !isBot(g, id))
    .map((id) => g.players[id])
    .filter((p) => Array.isArray(p.scoreBreakdown?.finalMissionDetails));
  if (humans.length === 0) continue;
  games++;
  for (const p of humans) {
    const b = byPlayer[canon(p.name)] ??= { games: 0, n: 0, sum: 0 };
    b.games++;
    for (const fm of gameFms) {
      const vp = p.scoreBreakdown.finalMissionDetails.find((d) => d.missionId === fm)?.vp ?? 0;
      b.n++; b.sum += vp;
      const c = cell[canon(p.name) + '|' + fm] ??= { n: 0, sum: 0 };
      c.n++; c.sum += vp;
    }
  }
  for (const fm of gameFms) (fmSeen[fm] ??= { games: 0 }).games++;
}

console.log(`4인 판 중 최종점수 breakdown 있는 판 ${games}개 (전원 사람 4인 판만 — 봇 낀 판 제외)\n`);

console.log('■ 플레이어별 종합 — 최종미션 등장 횟수(판당 2개)와 회당 평균 획득 VP');
console.log('플레이어'.padEnd(16) + '판'.padStart(4) + '미션횟수'.padStart(8) + '평균VP'.padStart(8));
const players = Object.entries(byPlayer).sort((a, b) => b[1].games - a[1].games);
for (const [name, b] of players) {
  console.log(name.padEnd(16) + String(b.games).padStart(4) + String(b.n).padStart(8) + (b.sum / b.n).toFixed(2).padStart(8));
}

console.log('\n■ 플레이어 × 최종미션 — 등장횟수와 평균 획득 VP (평균/횟수)');
const fms = Object.keys(fmSeen).sort((a, b) => fmSeen[b].games - fmSeen[a].games);
console.log('플레이어'.padEnd(16) + fms.map((f) => (FM[f] ?? f).padStart(10)).join(''));
for (const [name] of players) {
  let row = name.padEnd(16);
  for (const fm of fms) {
    const c = cell[name + '|' + fm];
    row += (c ? (c.sum / c.n).toFixed(1) + '/' + c.n : '·').padStart(10);
  }
  console.log(row);
}
console.log('\n(등장 판수: ' + fms.map((f) => `${FM[f] ?? f} ${fmSeen[f].games}`).join(', ') + ')');
