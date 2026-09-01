/**
 * 통계 사이트 공용 모듈 — 게임 로더(표준 전처리), 페이지 셸(공통 디자인), 리더보드 유틸.
 *
 * 표준 전처리(사용자 확정): 전원 사람 4인 게임만 · 계정 통합 ALIAS · 제외 게임 EXCLUDE_GAMES.
 * 새 별칭 쌍은 '두 이름이 한 게임에 동시 등장하지 않는지' 검사 후 추가할 것.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = path.join(REPO_ROOT, 'data', 'human-games');
export const IMG_DIR = path.join(REPO_ROOT, 'client', 'public', 'image');

export const ALIAS = {
  '암가': '타클론안함', '암컷가마우지': '타클론안함', '김지선': '타클론안함',
  '222': '하이', 'chrome': '하이', '산타': '디애박', '소통맨': '지수홍', '보노보노': 'mks', 'GUHO': '구오',
  'Hi': '하이', 'HI': '하이', '군성`': '군성', '시리티드': '시리', 'Happygaia': '행복가이아',
};
export const canon = (n) => ALIAS[n] ?? n;
export const EXCLUDE_GAMES = new Set(['2026-07-15_fi1njhdj.json']);
export const isBot = (g, pid) => (g.botPlayerIds ?? []).includes(pid) || /^AI Bot/.test(g.players?.[pid]?.name ?? '');

/** 리포트 판당비율 순위 진입 최소 판수 (표본 왜곡 방지) */
export const MIN_GAMES = 10;

/** 표준 필터를 통과한 게임 전체 로드. 리포트들이 공유(1회 로드). */
export function loadGames() {
  const games = [];
  for (const f of fs.readdirSync(DATA_DIR).filter((x) => x.endsWith('.json'))) {
    if (EXCLUDE_GAMES.has(f)) continue;
    let g;
    try { g = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { continue; }
    const ids = Object.keys(g.players ?? {});
    if (ids.length !== 4) continue;
    if (ids.some((id) => isBot(g, id))) continue;
    games.push({ file: f, game: g });
  }
  return games;
}

/** 플레이어별 참여 판수 (canon 이름 기준) */
export function playerGameCounts(games) {
  const counts = {};
  for (const { game: g } of games) {
    for (const p of Object.values(g.players)) counts[canon(p.name)] = (counts[canon(p.name)] ?? 0) + 1;
  }
  return counts;
}

/** 게임 시각 (정렬용): completedAt > createdAt > 파일명 날짜 */
export function gameTime({ file, game }) {
  return game.completedAt ?? game.createdAt ?? Date.parse(file.slice(0, 10)) ?? 0;
}

/** 한 게임의 플레이어별 최종 순위 [{name, faction, score, rank, bid}] — 동점은 같은 순위.
 *  bid: 종족 비딩으로 낸 VP(양수). biddingUsed: 이 판에 비딩 기록이 하나라도 있는지. */
export function gameRanks(g) {
  const rows = Object.values(g.players).map((p) => ({
    name: canon(p.name), faction: p.faction, score: p.score ?? 0,
    bid: -(p.scoreBreakdown?.other ?? []).filter((o) => o.source === '종족 비딩').reduce((s, o) => s + (o.vp ?? 0), 0),
  }));
  for (const r of rows) r.rank = 1 + rows.filter((x) => x.score > r.score).length;
  rows.biddingUsed = rows.some((r) => r.bid > 0);
  return rows;
}

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
export const b64img = (file) => {
  const mime = file.endsWith('.png') ? 'image/png' : file.endsWith('.jpg') ? 'image/jpeg' : 'image/gif';
  return `data:${mime};base64,${fs.readFileSync(path.join(IMG_DIR, file)).toString('base64')}`;
};

/** 순위 뱃지 클래스 — 1~3위 금은동, 그 아래는 무채색(rest) */
export const medalCls = (i) => ['gold', 'silver', 'bronze'][i] ?? 'rest';

/** {name,cnt,games,per}[] → 포디움 행 HTML. kind: 'cnt' | 'per'
 *  값(pval)과 보조표기(psub)를 분리해 고정폭 정렬 — 자릿수가 달라도 숫자 열이 맞는다. */
export function podiumHtml(rows, kind) {
  if (!rows || rows.length === 0) return '<div class="empty">기록 없음</div>';
  return rows.map((r, i) => `
    <div class="row">
      <span class="medal ${medalCls(i)}">${i + 1}</span>
      <span class="pname">${esc(r.name)}</span>
      <span class="pval">${kind === 'cnt' ? `${r.cnt}개` : r.per.toFixed(2)}</span>
      <span class="psub">${kind === 'cnt' ? `/${r.games}판` : '/판'}</span>
    </div>`).join('');
}

/** 포디움 표시 인원 (사용자 2026-09-01: 3등까지는 아쉬움 → 5등까지) */
export const TOP_N = 5;

/** name→count 맵 → {byCnt, byPer, total} (판당비율은 MIN_GAMES 이상만) */
export function rankTakers(byName, gamesPerPlayer) {
  const rows = Object.entries(byName).map(([name, cnt]) => ({ name, cnt, games: gamesPerPlayer[name] ?? 0, per: cnt / (gamesPerPlayer[name] || 1) }));
  return {
    total: rows.reduce((s, r) => s + r.cnt, 0),
    byCnt: [...rows].sort((a, b) => b.cnt - a.cnt || b.per - a.per).slice(0, TOP_N),
    byPer: rows.filter((r) => r.games >= MIN_GAMES).sort((a, b) => b.per - a.per || b.cnt - a.cnt).slice(0, TOP_N),
  };
}

/** 아이템 카드 (이미지 + 횟수/판당비율 포디움) */
export function itemCard({ label, imgSrc, stat }) {
  return `
  <section class="egg">
    <header class="egg-head">
      <img class="egg-img" src="${imgSrc}" alt="${esc(label)}" width="58" height="58" />
      <div class="egg-title">
        <h3>${esc(label)}</h3>
        <span class="egg-total">총 ${stat.total}개 획득</span>
      </div>
    </header>
    <div class="boards">
      <div class="board"><h4>횟수</h4>${podiumHtml(stat.byCnt, 'cnt')}</div>
      <div class="board"><h4>판당 비율 <span class="cond">${MIN_GAMES}판↑</span></h4>${podiumHtml(stat.byPer, 'per')}</div>
    </div>
  </section>`;
}

const faviconHref = (emoji) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${emoji}</text></svg>`)}`;

/** 생성 일시 스탬프 (로컬 시각) — 모든 페이지 공통 "이 시점 자료 기준" 표기 */
export function buildStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 공통 페이지 셸. bodyHtml에는 .sec/.grid/.egg 구조나 자유 HTML.
 * home=true면 메인 페이지(뒤로가기 링크 없음). iconImg(데이터URI)를 주면 이모지 대신 이미지 아이콘/파비콘.
 */
export function pageShell({ title, emoji, iconImg = null, accent = '#79c99e', intro = '', bodyHtml, footNote = '', home = false }) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<link rel="icon" href="${iconImg ?? faviconHref(emoji)}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Black+Han+Sans&family=IBM+Plex+Sans+KR:wght@400;500;700&family=IBM+Plex+Mono:wght@500;600&display=swap" />
<style>
  :root {
    --bg: #0b0f1a; --panel: #121a2c; --panel2: #0e1524; --line: #22304d;
    --ink: #e9edf6; --muted: #8b96ae; --accent: ${accent};
    --gold: #f2c14e; --silver: #b9c5da; --bronze: #cf8f63;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: 'IBM Plex Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif;
    background-image: radial-gradient(1200px 500px at 70% -10%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 60%),
      radial-gradient(800px 400px at 10% 0%, rgba(90,120,200,.10), transparent 55%);
  }
  .wrap { max-width: 1060px; margin: 0 auto; padding: 32px 20px 64px; }
  .back { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); text-decoration: none;
          font-size: 13px; font-weight: 700; margin-bottom: 18px; }
  .back:hover { color: var(--accent); }
  h1 { font-family: 'Black Han Sans', 'IBM Plex Sans KR', sans-serif; font-weight: 400;
       font-size: clamp(34px, 6vw, 52px); margin: 0; letter-spacing: .5px; text-wrap: balance; }
  h1 .green { color: var(--accent); }
  .sub { color: var(--muted); font-size: 14px; line-height: 1.6; margin: 10px 0 0; max-width: 62ch; }
  .sub b { color: var(--ink); font-weight: 700; }
  .sec { margin-top: 40px; }
  .sec > h2 { font-size: 13px; letter-spacing: .18em; color: var(--accent); text-transform: uppercase;
              margin: 0 0 14px; display: flex; align-items: center; gap: 10px; font-weight: 700; }
  .sec > h2::after { content: ''; flex: 1; height: 1px; background: linear-gradient(90deg, var(--line), transparent); }
  /* [사용자 2026-09-01] 320px 카드에선 보드 2개가 이름을 ...로 짓누름 → 최소 400px(데스크톱 한 줄 2장) */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 14px; }
  @media (max-width: 460px) { .grid { grid-template-columns: 1fr; } }
  .egg { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px 14px 12px;
         display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .egg-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .egg-img { border-radius: 50%; border: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); background: #0a0e18;
             box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 25%, transparent); object-fit: cover; flex-shrink: 0; }
  .egg-title { min-width: 0; }
  .egg-title h3 { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: .01em; }
  .egg-total { color: var(--muted); font-size: 12px; font-family: 'IBM Plex Mono', monospace; }
  .boards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; min-width: 0; }
  .board { background: var(--panel2); border: 1px solid var(--line); border-radius: 10px; padding: 8px 9px 9px; min-width: 0; overflow: hidden; }
  .board h4 { margin: 0 0 7px; font-size: 10.5px; letter-spacing: .1em; color: var(--muted);
              text-transform: uppercase; font-weight: 700; white-space: nowrap; }
  .board h4 .cond { font-weight: 500; letter-spacing: 0; color: #5f6b85; margin-left: 3px; }
  .row { display: flex; align-items: center; gap: 6px; padding: 3.5px 0; min-width: 0; }
  .row + .row { border-top: 1px dashed rgba(139,150,174,.14); }
  .medal { width: 17px; height: 17px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
           font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; font-weight: 600; color: #0b0f1a; flex-shrink: 0; }
  .medal.gold { background: var(--gold); box-shadow: 0 0 8px rgba(242,193,78,.45); }
  .medal.silver { background: var(--silver); }
  .medal.bronze { background: var(--bronze); }
  .medal.rest { background: #2c3a57; color: var(--muted); }
  .pname { font-size: 12.5px; font-weight: 700; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .pval { margin-left: auto; font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums;
          font-size: 11.5px; font-weight: 600; color: var(--accent); white-space: nowrap; flex-shrink: 0; text-align: right; }
  .pval em { font-style: normal; color: var(--muted); font-weight: 500; font-size: 10px; }
  /* 보조표기(/85판, /17회) — 고정폭 우측정렬로 값 숫자열을 맞춘다 (자릿수 달라도 세로 정렬 유지) */
  .psub { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; font-size: 10px;
          color: var(--muted); white-space: nowrap; flex-shrink: 0; width: 3.4em; text-align: left; }
  .empty { color: var(--muted); font-size: 12px; padding: 6px 0; }
  .foot { margin-top: 34px; color: #5f6b85; font-size: 12px; line-height: 1.7; border-top: 1px solid var(--line); padding-top: 14px; }
  /* 메인 페이지 리포트 카드 */
  .reports { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; margin-top: 28px; }
  a.report { display: flex; align-items: center; gap: 14px; background: var(--panel); border: 1px solid var(--line);
             border-radius: 14px; padding: 16px; text-decoration: none; color: var(--ink); min-width: 0;
             transition: border-color .15s, transform .15s; }
  a.report:hover { border-color: color-mix(in srgb, var(--accent) 60%, var(--line)); transform: translateY(-2px); }
  .report .ricon { font-size: 30px; flex-shrink: 0; width: 52px; height: 52px; display: flex; align-items: center;
                   justify-content: center; border-radius: 12px; background: var(--panel2); border: 1px solid var(--line); }
  .report .rbody { min-width: 0; }
  .report .rbody h3 { margin: 0 0 3px; font-size: 15px; font-weight: 700; }
  .report .rbody p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
  .report .ricon img, .h1icon { width: 44px; height: 44px; border-radius: 50%; object-fit: cover;
    border: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 25%, transparent); background: #0a0e18; }
  .h1icon { width: 46px; height: 46px; vertical-align: -6px; margin-right: 4px; }
  .stamp { display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; padding: 4px 10px;
    border-radius: 999px; border: 1px solid var(--line); background: var(--panel2);
    color: var(--muted); font-size: 12px; font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
  /* 통계 표 */
  .tblwrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
  table.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl th { text-align: right; padding: 10px 12px; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase;
    color: var(--muted); border-bottom: 1px solid var(--line); white-space: nowrap; cursor: pointer; user-select: none; }
  .tbl th:hover { color: var(--ink); }
  .tbl th.sorted { color: var(--accent); }
  .tbl th.sorted::after { content: ' ▼'; font-size: 8px; }
  .tbl th.sorted.asc::after { content: ' ▲'; }
  .tbl th:first-child, .tbl td:first-child { text-align: left; }
  .tbl th.l, .tbl td.l { text-align: left; }
  .tbl td { padding: 8px 12px; border-bottom: 1px solid rgba(34,48,77,.5); text-align: right;
    font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tbl td.name { font-family: 'IBM Plex Sans KR', sans-serif; font-weight: 700; }
  .tbl tr:last-child td { border-bottom: none; }
  .tbl tr:nth-child(odd) td { background: rgba(14,21,36,.45); }
  .tbl .top1 td { background: rgba(242,193,78,.10); }
  .tbl .top1 td:first-child { box-shadow: inset 3px 0 0 var(--gold); }
  .tbl .hi { color: var(--accent); font-weight: 600; }
  .tbl .dim { color: var(--muted); }
  .tbl .face { width: 26px; height: 34px; object-fit: cover; border-radius: 6px; vertical-align: middle;
    margin-right: 8px; border: 1px solid var(--line); }
  .tbl .tile { width: 44px; height: 26px; object-fit: contain; border-radius: 4px; vertical-align: middle;
    margin-right: 8px; background: #0a0e18; border: 1px solid var(--line); }
  .tbl .tile.big { width: 78px; height: 46px; border-radius: 6px; margin-right: 0; }
  .mission-img { width: 84px; height: 58px; object-fit: cover; border-radius: 10px; flex-shrink: 0;
    border: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 25%, transparent); background: #0a0e18; }
  .legend { color: var(--muted); font-size: 12px; margin-top: 10px; line-height: 1.6; }
</style>
</head>
<body>
<div class="wrap">
  ${home ? '' : '<a class="back" href="./index.html">← 가이아 통계 홈</a>'}
  <h1>${iconImg ? `<img class="h1icon" src="${iconImg}" alt="" />` : emoji} <span class="green">${esc(title.replace(' 리더보드', '').replace('가이아 ', ''))}</span>${title.includes('리더보드') ? ' 리더보드' : ''}</h1>
  ${intro ? `<p class="sub">${intro}</p>` : ''}
  <div class="stamp">🕐 ${buildStamp()} 시점 자료 기준</div>
  ${bodyHtml}
  <p class="foot">${footNote}${footNote ? ' · ' : ''}계정 통합(ALIAS)·제외 게임 적용 · ${buildStamp()} 생성</p>
</div>
<script>
// 통계 표 헤더 클릭 정렬 — 같은 헤더 다시 클릭 시 오름/내림 토글. 숫자 우선, 아니면 문자열 비교.
document.querySelectorAll('table.tbl').forEach(function (tbl) {
  var ths = tbl.querySelectorAll('thead th');
  ths.forEach(function (th, ci) {
    th.addEventListener('click', function () {
      var tbody = tbl.querySelector('tbody');
      var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
      var asc = th.classList.contains('sorted') && !th.classList.contains('asc');
      ths.forEach(function (t) { t.classList.remove('sorted', 'asc'); });
      th.classList.add('sorted'); if (asc) th.classList.add('asc');
      var val = function (tr) {
        var t = (tr.children[ci] ? tr.children[ci].textContent : '').trim();
        var n = parseFloat(t.replace(/[^0-9.\\-]/g, ''));
        return isNaN(n) ? t : n;
      };
      rows.sort(function (a, b) {
        var x = val(a), y = val(b);
        if (typeof x === 'number' && typeof y === 'number') return asc ? x - y : y - x;
        return asc ? String(x).localeCompare(String(y), 'ko') : String(y).localeCompare(String(x), 'ko');
      });
      rows.forEach(function (r) { tbody.appendChild(r); });
      // '#' 열은 현재 정렬 기준의 순번으로 다시 매김 (원래 순위가 남아 있으면 정렬이 깨져 보임)
      if (ths[0] && ths[0].textContent.trim() === '#') {
        rows.forEach(function (r, i) { if (r.children[0]) r.children[0].textContent = String(i + 1); });
      }
    });
  });
});
</script>
</body>
</html>
`;
}
