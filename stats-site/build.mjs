/**
 * 가이아 통계 사이트 빌더 — reports/ 폴더의 리포트를 전부 실행해 dist/에 정적 페이지 생성.
 *
 * 사용: node stats-site/build.mjs            → dist/ (배포본)
 *       node stats-site/build.mjs --local    → dist/ + dist-local/ (로컬 전용 — 액션 기록까지)
 *       (stats-site/build.bat 더블클릭은 --local 로 돈다)
 * 배포: dist/ 폴더를 그대로 정적 호스팅(Netlify 등)에 올리면 됨 (이미지 내장, 외부 의존성 없음).
 *
 * [사용자 2026-09-30] "배포 페이지에 결과 점수까지는 좋은데 밑에 1라부터 어떤 액션부터 했는지 나오는 건
 *   안 뜨게 해 줘. 내 로컬에서만 보고 싶어."
 *   → dist/(배포본)에는 판별 액션 순서(전체 타임라인·사람별 액션 감사 표)를 **데이터째 넣지 않는다.**
 *     화면에서만 숨기면 games-data/cNN.js 를 열어 누구나 볼 수 있기 때문이다.
 *     전체를 보는 판은 dist-local/ 에 따로 만든다. CI(.github/workflows/stats-site.yml)는 --local 없이
 *     dist/ 만 올리므로 로컬판이 배포될 길이 없다.
 *
 * 새 리포트 추가법: reports/에 .mjs 파일 하나 추가 —
 *   export const meta = { id, title, emoji, accent, description };
 *   export function build({ games, gamesPerPlayer }) { return pageShell({...}); }
 * 메인 페이지 카드는 자동으로 생긴다 (meta.order 낮은 순, 없으면 파일명 순).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadGames, playerGameCounts, pageShell, esc } from './lib/common.mjs';

const SITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.join(SITE_DIR, 'reports');
const DIST = path.join(SITE_DIR, 'dist');             // 배포본 — 액션 순서 없음
const DIST_LOCAL = path.join(SITE_DIR, 'dist-local'); // 로컬 전용 — 전부 포함, 절대 배포하지 않는다
const WANT_LOCAL = process.argv.includes('--local');

console.log('가이아 통계 사이트 빌드 시작…');
const games = loadGames();
const gamesPerPlayer = playerGameCounts(games);
console.log(`데이터: 전원 사람 4인 게임 ${games.length}판, 플레이어 ${Object.keys(gamesPerPlayer).length}명`);

const reports = [];
for (const f of fs.readdirSync(REPORTS_DIR).filter((x) => x.endsWith('.mjs')).sort()) {
  const mod = await import(`./reports/${f}`);
  if (!mod.meta?.id || typeof mod.build !== 'function') {
    console.warn(`  건너뜀(meta/build 없음): ${f}`);
    continue;
  }
  reports.push(mod);
}
reports.sort((a, b) => (a.meta.order ?? 99) - (b.meta.order ?? 99) || a.meta.id.localeCompare(b.meta.id));

/** 한 벌을 outDir 에 만든다. pub=true 면 배포본(판별 액션 순서 제외). */
function buildSite(outDir, pub) {
  console.log(`\n[${pub ? '배포본' : '로컬 전용'}] ${outDir}`);
  // 매 빌드마다 비우고 시작 (지워진 리포트/이름 바뀐 스냅샷 잔재 방지)
  // 폴더째 rm은 Windows에서 탐색기/편집기가 열고 있으면 EPERM — 파일 단위로 지우고 실패는 무시
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) {
    try { fs.rmSync(path.join(outDir, f), { recursive: true, force: true }); } catch { /* 잠긴 파일은 다음 빌드에서 */ }
  }
  const ctx = { games, gamesPerPlayer, dist: outDir, pub }; // dist: 부속 파일(games-data 조각)을 쓰는 리포트용
  for (const r of reports) {
    const out = path.join(outDir, `${r.meta.id}.html`);
    try {
      fs.writeFileSync(out, r.build(ctx));
      console.log(`  ✓ ${r.meta.id}.html — ${r.meta.title}`);
    } catch (e) {
      console.error(`  ✗ ${r.meta.id} 실패: ${e?.message}`);
    }
  }
  writeIndex(outDir, pub);
}

function writeIndex(outDir, pub) {
// 메인 페이지
const cards = reports.map((r) => `
  <a class="report" href="./${r.meta.id}.html">
    <span class="ricon">${r.meta.iconImg ? `<img src="${r.meta.iconImg}" alt="" />` : r.meta.emoji}</span>
    <span class="rbody">
      <h3>${esc(r.meta.title)}</h3>
      <p>${esc(r.meta.description ?? '')}</p>
    </span>
  </a>`).join('');

fs.writeFileSync(path.join(outDir, 'index.html'), pageShell({
  title: '가이아 통계',
  emoji: '🌌',
  accent: '#79c99e',
  home: true,
  intro: `우리끼리 가이아 프로젝트 기록실 — 전원 사람 <b>4인 게임 ${games.length}판</b>의 게임 로그 기준. 보고 싶은 자료를 고르세요.`,
  bodyHtml: `<div class="reports">${cards}</div>`,
  footNote: `리포트 ${reports.length}종${pub ? '' : ' · 로컬 전용판(액션 기록 포함)'}`,
}));
console.log(`  ✓ index.html — 리포트 ${reports.length}종`);
}

buildSite(DIST, true);
if (WANT_LOCAL) buildSite(DIST_LOCAL, false);
console.log(`\n완료: ${DIST}${WANT_LOCAL ? `\n로컬 전용: ${DIST_LOCAL} (배포 금지)` : ''}`);
