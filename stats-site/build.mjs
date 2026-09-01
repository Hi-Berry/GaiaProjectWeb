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
import { spawnSync } from 'child_process';
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

// 매 빌드마다 dist를 비우고 시작 (지워진 리포트/이름 바뀐 스냅샷 잔재 방지)
// 폴더째 rm은 Windows에서 탐색기/편집기가 열고 있으면 EPERM — 파일 단위로 지우고 실패는 무시
fs.mkdirSync(DIST, { recursive: true });
for (const f of fs.readdirSync(DIST)) {
  try { fs.rmSync(path.join(DIST, f), { recursive: true, force: true }); } catch { /* 잠긴 파일은 다음 빌드에서 */ }
}

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

// score_input(Flask) 통계 스냅샷 — ELO/개인별/종족별/명예의전당/게임기록.
// 파이썬이나 앱 폴더가 없으면 경고만 하고 사이트 나머지는 정상 생성.
const SCORE_APP_DIR = 'C:/Users/ColinJang/AI Project/score_input';
const scorePages = [
  { file: 'player-statistics.html', emoji: '📈', title: '개인별 통계 · ELO', description: '점수 기록 기반 개인 성적 + 트루스킬 레이팅 순위' },
  { file: 'race-statistics.html', emoji: '👽', title: '종족별 통계', description: '종족별 승률·평균 점수 (점수 기록 기반)' },
  { file: 'hall-of-fame.html', emoji: '🏆', title: '명예의 전당', description: '역대 최고 점수 기록' },
  { file: 'game-records.html', emoji: '📜', title: '게임 기록', description: '입력된 판별 점수 기록 (읽기 전용 스냅샷)' },
];
let scoreOk = false;
if (fs.existsSync(SCORE_APP_DIR)) {
  const r = spawnSync('python', [path.join(SITE_DIR, 'export_flask.py')], { encoding: 'utf8' });
  if (r.status === 0) {
    scoreOk = true;
    console.log('  ✓ score_input 스냅샷: ' + (r.stdout.trim().split('\n').pop() ?? ''));
  } else {
    console.warn('  ✗ score_input 스냅샷 실패 (통계 사이트 나머지는 정상):');
    console.warn((r.stderr || r.stdout || String(r.error ?? '')).split('\n').slice(-5).join('\n'));
  }
} else {
  console.warn(`  – score_input 폴더 없음(${SCORE_APP_DIR}) — ELO/개인/종족 통계 스냅샷 건너뜀`);
}
const scoreCards = scoreOk ? scorePages.filter((p) => fs.existsSync(path.join(DIST, p.file))) : [];

// 메인 페이지
const cards = reports.map((r) => `
  <a class="report" href="./${r.meta.id}.html">
    <span class="ricon">${r.meta.iconImg ? `<img src="${r.meta.iconImg}" alt="" />` : r.meta.emoji}</span>
    <span class="rbody">
      <h3>${esc(r.meta.title)}</h3>
      <p>${esc(r.meta.description ?? '')}</p>
    </span>
  </a>`).join('');

const scoreCardsHtml = scoreCards.map((p) => `
  <a class="report" href="./${p.file}">
    <span class="ricon">${p.emoji}</span>
    <span class="rbody">
      <h3>${esc(p.title)}</h3>
      <p>${esc(p.description)}</p>
    </span>
  </a>`).join('');

fs.writeFileSync(path.join(DIST, 'index.html'), pageShell({
  title: '가이아 통계',
  emoji: '🌌',
  accent: '#79c99e',
  home: true,
  intro: `우리끼리 가이아 프로젝트 기록실 — 전원 사람 <b>4인 게임 ${games.length}판</b> 기준. 보고 싶은 자료를 고르세요.`,
  bodyHtml: `<div class="reports">${cards}</div>`
    + (scoreCardsHtml ? `<div class="sec"><h2>점수 기록 통계 (score_input)</h2><div class="reports" style="margin-top:0">${scoreCardsHtml}</div></div>` : ''),
  footNote: `리포트 ${reports.length + scoreCards.length}종`,
}));
console.log(`  ✓ index.html — 리포트 ${reports.length}종 + 점수기록 ${scoreCards.length}종`);
console.log(`완료: ${DIST}`);
