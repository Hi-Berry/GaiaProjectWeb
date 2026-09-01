/**
 * 가이아 통계 사이트 빌더 — reports/ 폴더의 리포트를 전부 실행해 dist/에 정적 페이지 생성.
 *
 * 사용: node stats-site/build.mjs   (또는 stats-site/build.bat 더블클릭)
 * 배포: dist/ 폴더를 그대로 정적 호스팅(Netlify 등)에 올리면 됨 (이미지 내장, 외부 의존성 없음).
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
const DIST = path.join(SITE_DIR, 'dist');

console.log('가이아 통계 사이트 빌드 시작…');
const games = loadGames();
const gamesPerPlayer = playerGameCounts(games);
const ctx = { games, gamesPerPlayer };
console.log(`데이터: 전원 사람 4인 게임 ${games.length}판, 플레이어 ${Object.keys(gamesPerPlayer).length}명`);

fs.mkdirSync(DIST, { recursive: true });

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

for (const r of reports) {
  const out = path.join(DIST, `${r.meta.id}.html`);
  try {
    fs.writeFileSync(out, r.build(ctx));
    console.log(`  ✓ ${r.meta.id}.html — ${r.meta.title}`);
  } catch (e) {
    console.error(`  ✗ ${r.meta.id} 실패: ${e?.message}`);
  }
}

// 메인 페이지
const cards = reports.map((r) => `
  <a class="report" href="./${r.meta.id}.html">
    <span class="ricon">${r.meta.iconImg ? `<img src="${r.meta.iconImg}" alt="" />` : r.meta.emoji}</span>
    <span class="rbody">
      <h3>${esc(r.meta.title)}</h3>
      <p>${esc(r.meta.description ?? '')}</p>
    </span>
  </a>`).join('');

fs.writeFileSync(path.join(DIST, 'index.html'), pageShell({
  title: '가이아 통계',
  emoji: '🌌',
  accent: '#79c99e',
  home: true,
  intro: `우리끼리 가이아 프로젝트 기록실 — 전원 사람 <b>4인 게임 ${games.length}판</b> 기준. 보고 싶은 자료를 고르세요.`,
  bodyHtml: `<div class="reports">${cards}</div>`,
  footNote: `리포트 ${reports.length}종`,
}));
console.log(`  ✓ index.html — 리포트 ${reports.length}종`);
console.log(`완료: ${DIST}`);
