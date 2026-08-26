// 유저별 종족 분포 — 4인 전원 사람 판, 계정 통합, 제외게임 적용.
// "특정 유저만 확장 종족이 자주 나온다" 검증: 확장 종족(모웨이드·자이언트·팅커·다칸)이 등장한 판 안에서
// '그 유저가 확장 종족을 든 횟수'를 같은 판 기대치(판당 확장 종족 수 / 4)와 비교한다.
// 실행: node scripts/playerFactionReport.mjs
import fs from 'fs';
import path from 'path';

const DIR = 'data/human-games';
const isBot = (g, pid) => (g.botPlayerIds ?? []).includes(pid) || /^AI Bot/.test(g.players?.[pid]?.name ?? '');
const ALIAS = {
  '암가': '타클론안함', '암컷가마우지': '타클론안함', '김지선': '타클론안함',
  '222': '하이', 'chrome': '하이', '산타': '디애박', '소통맨': '지수홍', '보노보노': 'mks', 'GUHO': '구오',
  'Hi': '하이', 'HI': '하이', '군성`': '군성', '시리티드': '시리', 'Happygaia': '행복가이아',
};
const canon = (n) => ALIAS[n] ?? n;
const EXCLUDE_GAMES = new Set(['2026-07-15_fi1njhdj.json']);

const EXPANSION = new Set(['moweyip', 'space_giants', 'tinkeroids', 'darkanians']);
const NAME = {
  terran: 'Terrans', lantids: 'Lantids', hadsch_hallas: 'HadschH', ivits: 'Ivits',
  geodens: 'Geodens', bal_tak: 'BalTak', xenos: 'Xenos', gleens: 'Gleens',
  taklons: 'Taklons', ambas: 'Ambas', bescods: 'Bescods', firaks: 'Firaks',
  itars: 'Itars', nevlas: 'Nevlas', moweyip: '모웨이드', space_giants: '자이언트',
  tinkeroids: '팅커', darkanians: '다칸',
};

const byUser = {}; // name -> { games, fac: {facId: n}, expGames, expActual, expExpected }
let games = 0, expansionGames = 0;

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
  if (EXCLUDE_GAMES.has(f)) continue;
  let g; try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  const ids = Object.keys(g.players ?? {});
  if (ids.length !== 4 || ids.some((id) => isBot(g, id))) continue;
  const seats = ids.map((id) => g.players[id]).filter((p) => p.faction);
  if (seats.length !== 4) continue;
  games++;
  const expCount = seats.filter((p) => EXPANSION.has(p.faction)).length;
  if (expCount > 0) expansionGames++;
  for (const p of seats) {
    const b = byUser[canon(p.name)] ??= { games: 0, fac: {}, expGames: 0, expActual: 0, expExpected: 0 };
    b.games++;
    b.fac[p.faction] = (b.fac[p.faction] || 0) + 1;
    if (expCount > 0) {
      b.expGames++;
      b.expExpected += expCount / 4; // 같은 판에서 무작위 좌석이면 이만큼 확장 종족을 들었을 기대치
      if (EXPANSION.has(p.faction)) b.expActual++;
    }
  }
}

console.log(`4인 전원 사람 판 ${games}개 (계정 통합 · 제외게임 반영) — 확장 종족 등장 판 ${expansionGames}개\n`);

console.log('■ 유저별 확장 종족 — 확장 종족이 뜬 판 기준, 기대치 대비 (10판 이상)');
console.log('유저'.padEnd(14) + '판'.padStart(4) + '확장판'.padStart(6) + '실제'.padStart(6) + '기대'.padStart(8) + '실제/기대'.padStart(10) + '  z(초과 유의성)');
const users = Object.entries(byUser).filter(([, b]) => b.games >= 10).sort((a, b) => b[1].games - a[1].games);
for (const [name, b] of users) {
  const ratio = b.expExpected > 0 ? b.expActual / b.expExpected : 0;
  // 이항 근사: 각 확장판에서 p=expCount/4 로 확장 종족을 들 확률 → 분산 합으로 z
  // (판별 p가 달라 정확치는 아니지만 p(1-p)<=0.25 근사로 충분)
  const varSum = b.expExpected * (1 - b.expExpected / Math.max(1, b.expGames));
  const z = varSum > 0 ? (b.expActual - b.expExpected) / Math.sqrt(varSum) : 0;
  console.log(name.padEnd(14) + String(b.games).padStart(4) + String(b.expGames).padStart(6)
    + String(b.expActual).padStart(6) + b.expExpected.toFixed(1).padStart(8)
    + (ratio ? ratio.toFixed(2) : '·').padStart(10) + `  ${z >= 0 ? '+' : ''}${z.toFixed(1)}σ`);
}

console.log('\n■ 유저별 종족 분포 — 많이 나온 순 상위 6 (횟수, 자기 판 대비 %)');
for (const [name, b] of users) {
  const top = Object.entries(b.fac).sort((x, y) => y[1] - x[1]).slice(0, 6)
    .map(([fac, n]) => `${NAME[fac] ?? fac} ${n}(${(100 * n / b.games).toFixed(0)}%)`).join(' · ');
  console.log(`${name.padEnd(14)} ${top}`);
}

console.log('\n■ 유저 × 확장 종족 상세 (횟수)');
const EXP_LIST = ['moweyip', 'space_giants', 'tinkeroids', 'darkanians'];
console.log('유저'.padEnd(14) + EXP_LIST.map((f) => NAME[f].padStart(8)).join('') + '합계'.padStart(8));
for (const [name, b] of users) {
  const cnts = EXP_LIST.map((f) => b.fac[f] || 0);
  console.log(name.padEnd(14) + cnts.map((n) => String(n).padStart(8)).join('') + String(cnts.reduce((s, n) => s + n, 0)).padStart(8));
}
