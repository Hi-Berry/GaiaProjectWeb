// 뱃지 '모행성 안 늘리고 승리' 이미지 제작 요청문 생성기 — 사용: node scripts/genBadgeImagePrompt.mjs
//
// 왜 스크립트인가: 뱃지 이미지는 사람이 생성기(또는 그림 그리는 사람)에게 맡기는데, 요청문에 들어갈
//   조건·희소성·달성자는 매번 로그에서 다시 세야 정확하다. 손으로 옮기면 게임이 쌓일 때마다 숫자가 틀어진다.
//   그래서 실측 → 요청문을 한 번에 뽑는다. 이미지 API는 호출하지 않는다(키·의존성 없음, 출력은 붙여넣기용 텍스트).
//
// 조건: 모행성(자기 종족 홈 행성 타입)에 시작 배치 광산 말고는 한 채도 더 짓지 않고 1위.
//   초기 광산이 2개인 종족만 대상 — 모웨이드·스페이스 자이언트처럼 1개로 시작하는 종족은 '안 늘렸다'가
//   거저 되기 때문(실측: 초기배치 외 0개 1위 32회 중 18회가 프로토 2종). 제노스는 3개로 시작해 역시 기준이 다르다.
//   대상/제외는 shared/gameConfig 의 startingMines 를 그대로 읽어 판정한다(종족 목록을 여기 또 적으면 갈라진다).
//
// 옵션:
//   --json     달성자 목록을 JSON으로 (사이트 admin 스크립트에 물릴 때)
//   --all      제외된 종족(초기 1개·3개)도 참고로 함께 출력
import { loadGames, canon, gameRanks } from '../stats-site/lib/common.mjs';
import { FACTION_KO } from '../stats-site/lib/factions.mjs';
import { FACTIONS } from '../shared/gameConfig.ts';

const BADGE = {
  id: 'no-extra-home-win',
  name: '모행성 안 늘리고 승리',
  en: 'Homeworld Untouched',
  desc: '모행성(자기 색) 행성을 시작 2칸 말고는 하나도 더 점령하지 않고 1위 (시작 광산을 행성의회·아카데미로 키우는 건 무관)',
};
/** 이 뱃지가 노리는 초기 광산 수 — 이 값으로 시작하는 종족만 대상 */
const START_MINES = 2;

/** 이미지 스타일 — 다른 뱃지와 톤을 맞추려면 여기만 고치면 된다 */
const STYLE = {
  ko: '원형 엠블럼, 가이아 프로젝트 보드게임 톤의 SF 아이콘, 어두운 우주 배경, 단순하고 또렷한 실루엣, 작게 줄여도 알아볼 수 있게',
  en: 'circular emblem badge, sci-fi board-game icon style, dark space background, bold simple silhouette, readable at 64px, flat vector with subtle metallic rim, no text, no lettering',
  motif_ko: '가운데에 광산 2개만 박힌 고향 행성 하나, 그 둘레로 다른 색 행성들에 퍼진 건물들 — "고향은 그대로, 바깥으로만 뻗었다"가 한눈에 보이게',
  motif_en: 'center: a single home planet holding just two structures and nothing more; around it, a ring of differently-colored alien planets covered with settlements and structures; the contrast reads as "home untouched, expansion outward"',
};

const F = Array.isArray(FACTIONS) ? FACTIONS : Object.values(FACTIONS);
const HOME = Object.fromEntries(F.map((f) => [f.id, f.homePlanet]));
const START = Object.fromEntries(F.map((f) => [f.id, f.startingMines ?? 2]));
const ko = (id) => FACTION_KO[id] ?? id;

/** 그 사람이 건물을 올린 모행성 타입 타일 수 (시작 광산 포함) */
const homeBuilt = (g, pid, faction) =>
  (g.map ?? []).filter((t) => t.ownerId === pid && t.structure && t.type === HOME[faction]).length;

const games = loadGames();
const rows = [];
for (const { file, game: g } of games) {
  if (!(g.map ?? []).length) continue; // 맵 없는 옛 로그는 판정 불가
  const ranks = gameRanks(g);
  for (const [pid, p] of Object.entries(g.players)) {
    if (!HOME[p.faction]) continue;
    const n = canon(p.name);
    const r = ranks.find((x) => x.name === n && x.faction === p.faction);
    const start = START[p.faction];
    const built = homeBuilt(g, pid, p.faction);
    rows.push({
      d: file.slice(0, 10), n, fid: p.faction, fac: ko(p.faction), start, built,
      extra: built - start, score: p.score ?? 0, rank: r?.rank ?? 0,
      won: r?.rank === 1, eligible: start === START_MINES,
    });
  }
}

const hit = (r) => r.eligible && r.extra <= 0;
const holders = rows.filter((r) => hit(r) && r.won).sort((a, b) => a.d.localeCompare(b.d));
const tried = rows.filter(hit);                      // 순위 무관 = 이 플레이를 한 판
const pool = rows.filter((r) => r.eligible);          // 대상 종족 플레이어-판 전체

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(holders.map((r) => ({
    badge_id: BADGE.id, player: r.n, badge_name: BADGE.name,
    note: `${r.fac} ${r.score}점 1위`, date: r.d,
  })), null, 2));
  process.exit(0);
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : '-');
const names = [...new Set(holders.map((r) => r.n))];
const byFac = {};
for (const r of holders) byFac[r.fac] = (byFac[r.fac] ?? 0) + 1;
const excluded = [...new Set(rows.filter((r) => !r.eligible).map((r) => `${r.fac}(초기 ${r.start})`))].sort();

console.log(`# 뱃지 이미지 요청서 — ${BADGE.name} (${BADGE.id})`);
console.log(`생성: node scripts/genBadgeImagePrompt.mjs · 기준 사람 4인 ${games.length}판\n`);

console.log('## 조건');
console.log(`  ${BADGE.desc}`);
console.log(`  대상: 시작 광산 ${START_MINES}개 종족만 · 제외: ${excluded.join(', ')}\n`);

console.log('## 희소성 (요청문에 쓸 근거)');
console.log(`  대상 종족 플레이어-판 ${pool.length}건 중 모행성 안 늘린 판 ${tried.length}건 (${pct(tried.length, pool.length)})`);
console.log(`  그중 1위 ${holders.length}회 · ${names.length}명 (승률 ${pct(holders.length, tried.length)})`);
console.log(`  종족 분포: ${Object.entries(byFac).sort((a, b) => b[1] - a[1]).map(([f, c]) => `${f} ${c}`).join(' · ') || '(없음)'}\n`);

console.log(`## 달성자 ${holders.length}회 · ${names.length}명 (사이트 admin 양식)`);
for (const r of holders) console.log(`  ${r.n} | ${r.fac} ${r.score}점 1위 | ${r.d}`);
if (!holders.length) console.log('  (아직 없음)');
console.log('');

console.log('## 이미지 만들어 달라고 할 때 그대로 붙여넣기 (한국어)');
console.log(`가이아 프로젝트 기록 사이트에 쓸 업적 뱃지 아이콘을 하나 만들어 주세요.`);
console.log(`- 뱃지 이름: ${BADGE.name}`);
console.log(`- 의미: ${BADGE.desc}. 고향 행성은 시작 2칸 그대로 두고 남의 색 행성으로만 뻗어 나가 이긴 판입니다.`);
console.log(`- 희귀도: 사람 4인 ${games.length}판(대상 종족 참가 ${pool.length}석) 중 ${holders.length}번뿐 나온 기록`);
console.log(`- 그림: ${STYLE.motif_ko}`);
console.log(`- 스타일: ${STYLE.ko}`);
console.log(`- 글자는 넣지 말고, 정사각형 투명 배경 PNG로 주세요.\n`);

console.log('## 영어 프롬프트 (이미지 생성기용)');
console.log(`Achievement badge icon for a Gaia Project board-game stats site. Concept: "${BADGE.en}" (${BADGE.name}) — winning the game without ever building on your home planet type beyond the two starting mines. ${STYLE.motif_en}. ${STYLE.en}. Square canvas, transparent background, PNG.`);

if (process.argv.includes('--all')) {
  console.log('\n## (참고) 제외 종족에서 같은 플레이를 한 1위');
  for (const r of rows.filter((r) => !r.eligible && r.extra <= 0 && r.won).sort((a, b) => a.d.localeCompare(b.d))) {
    console.log(`  ${r.d} ${r.n} ${r.fac} 모행성 ${r.built}개=초기${r.start} ${r.score}점`);
  }
}
