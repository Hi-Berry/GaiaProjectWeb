/** 고급 기술 타일 랭킹 — 한 판에서 타일 하나가 벌어준 VP 합계(scoreBreakdown.techTiles) 기준. */
import path from 'path';
import fs from 'fs';
import { REPO_ROOT, gameRanks, pageShell, esc } from '../lib/common.mjs';

export const meta = {
  id: 'advtiles',
  order: 6,
  title: '고급 타일 랭킹',
  emoji: '🎖️',
  accent: '#5eead4',
  description: '고급 기술 타일 한 장으로 가장 많이 벌어간 기록 TOP 20 + 타일별 통계',
};

/** id → {label, img(/tech/TechTile_A*.png)} — gameConfig ALL_ADVANCED_TECH_TILES와 동일 매핑 */
const ADV = {
  'adv-act-3k': { label: '액션: 지식 3', img: 'TechTile_A1.png' },
  'adv-act-3o': { label: '액션: 광석 3', img: 'TechTile_A13.png' },
  'adv-act-1q-5c': { label: '액션: 정큐 1 + 크레딧 5', img: 'TechTile_A8.png' },
  'adv-vp-build-mine': { label: '광산 건설마다 3VP', img: 'TechTile_A11.png' },
  'adv-vp-build-ts': { label: '교역소 건설마다 3VP', img: 'TechTile_A12.png' },
  'adv-vp-research': { label: '연구 전진마다 2VP', img: 'TechTile_A9.png' },
  'adv-vp-terraform': { label: '테라포밍 스텝마다 2VP', img: 'TechTile_A20.png' },
  'adv-vp-qic-action': { label: '정큐 액션마다 4VP', img: 'TechTile_A19.png' },
  'adv-imm-1o-sector': { label: '즉시: 섹터당 광석 1', img: 'TechTile_A15.png' },
  'adv-imm-4vp-ts': { label: '즉시: 교역소×4 VP', img: 'TechTile_A6.png' },
  'adv-imm-2vp-mine': { label: '즉시: 광산×2 VP', img: 'TechTile_A2.png' },
  'adv-imm-2vp-sector': { label: '즉시: 섹터×2 VP', img: 'TechTile_A3.png' },
  'adv-imm-4vp-outer': { label: '즉시: 외곽 섹터×4 VP', img: 'TechTile_A21.png' },
  'adv-imm-6vp-big': { label: '즉시: 대형건물×6 VP', img: 'TechTile_A16.png' },
  'adv-imm-2vp-gaia': { label: '즉시: 가이아×2 VP', img: 'TechTile_A14.png' },
  'adv-imm-5vp-fed': { label: '즉시: 연방×5 VP', img: 'TechTile_A4.png' },
  'adv-pass-1vp-type': { label: '패스: 행성유형×1 VP', img: 'TechTile_A10.png' },
  'adv-pass-3vp-lab': { label: '패스: 연구소×3 VP', img: 'TechTile_A7.png' },
  'adv-pass-3vp-fed': { label: '패스: 연방×3 VP', img: 'TechTile_A5.png' },
  'adv-pass-2vp-asteroid': { label: '패스: 소행성×2 VP', img: 'TechTile_A18.png' },
  'adv-pass-2vp-outer': { label: '패스: 외곽 섹터×2 VP', img: 'TechTile_A17.png' },
  // [사용자 2026-09-01] 일반 기술 타일이지만 점수 누적형이라 함께 집계
  'tech-gaia-3vp': { label: '가이아 광산마다 3VP (일반)', img: 'TechTile_B6.png' },
};
const COUNTED = /^(adv-|tech-gaia-3vp$)/;

const tileImgB64 = (() => {
  const cache = {};
  return (id) => {
    const def = ADV[id];
    if (!def) return null;
    if (!(id in cache)) {
      const p = path.join(REPO_ROOT, 'client', 'public', 'tech', def.img);
      cache[id] = fs.existsSync(p) ? `data:image/png;base64,${fs.readFileSync(p).toString('base64')}` : null;
    }
    return cache[id];
  };
})();


export function build({ games }) {
  const cases = []; // {game, date, name, tile, vp, won}
  const perTile = {}; // tile -> {n, vpSum, best, bestBy, bestGame}
  for (const { file, game: g } of games) {
    const ranks = gameRanks(g);
    for (const p of Object.values(g.players)) {
      const sums = {};
      for (const t of p.scoreBreakdown?.techTiles ?? []) {
        if (!COUNTED.test(t.tileId ?? '')) continue;
        sums[t.tileId] = (sums[t.tileId] ?? 0) + (t.vp ?? 0);
      }
      const name = ranks.find((r) => r.score === (p.score ?? 0) && r.faction === p.faction)?.name ?? p.name;
      for (const [tile, vp] of Object.entries(sums)) {
        const date = file.slice(0, 10); // [사용자] 게임은 날짜만 표기 (아이디 제외)
        cases.push({ game: date, name, tile, vp });
        const s = (perTile[tile] ??= { n: 0, vpSum: 0, best: 0, bestBy: '', bestGame: '' });
        s.n++; s.vpSum += vp;
        if (vp > s.best) { s.best = vp; s.bestBy = name; s.bestGame = date; }
      }
    }
  }
  cases.sort((a, b) => b.vp - a.vp);

  const medal = (i) => (i < 3 ? `<span class="rk m${i + 1}">${i + 1}</span>` : `<span class="rk">${i + 1}</span>`);
  const tileImg = (id) => {
    const def = ADV[id] ?? { label: id };
    const img = tileImgB64(id);
    return img ? `<img class="tile2" src="${img}" alt="${esc(def.label)}" title="${esc(def.label)}" />`
      : `<span class="tile2 alt">${esc(def.label)}</span>`;
  };

  const topRows = cases.slice(0, 22).map((c, i) => `
    <div class="trow${i === 0 ? ' first' : ''}">
      ${medal(i)}
      ${tileImg(c.tile)}
      <div class="tmain"><b>${esc(c.name)}</b><span class="tsub">${esc(c.game)}</span></div>
      <div class="tvp">${c.vp}<em>점</em></div>
    </div>`).join('');

  const tileRows = Object.entries(perTile)
    .map(([tile, s]) => ({ tile, ...s, avg: s.vpSum / s.n }))
    .sort((a, b) => b.best - a.best)
    .map((r, i) => `
    <div class="trow${i === 0 ? ' first' : ''}">
      ${tileImg(r.tile)}
      <div class="tmain"><b>${r.n}회 획득</b><span class="tsub">평균 ${r.avg.toFixed(1)}점</span></div>
      <div class="tbest"><div class="tvp">${r.best}<em>점</em></div><span class="tsub">${esc(r.bestBy)} · ${esc(r.bestGame)}</span></div>
    </div>`).join('');

  const body = `
  <style>
    .cols2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 24px; align-items: start; }
    @media (max-width: 860px) { .cols2 { grid-template-columns: 1fr; } }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px; min-width: 0; }
    .panel > h2 { font-size: 12px; letter-spacing: .16em; color: var(--accent); text-transform: uppercase;
      margin: 2px 2px 10px; font-weight: 700; }
    .trow { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 10px; min-width: 0; }
    .trow:nth-child(odd) { background: var(--panel2); }
    .trow.first { background: rgba(242,193,78,.10); box-shadow: inset 3px 0 0 var(--gold); }
    .rk { width: 20px; text-align: center; font-family: 'IBM Plex Mono', monospace; font-size: 11px;
      color: var(--muted); flex-shrink: 0; }
    .rk.m1, .rk.m2, .rk.m3 { width: 20px; height: 20px; border-radius: 50%; display: inline-flex;
      align-items: center; justify-content: center; color: #0b0f1a; font-weight: 700; }
    .rk.m1 { background: var(--gold); box-shadow: 0 0 8px rgba(242,193,78,.45); }
    .rk.m2 { background: var(--silver); } .rk.m3 { background: var(--bronze); }
    .tile2 { width: 96px; height: 56px; object-fit: contain; border-radius: 8px; background: #0a0e18;
      border: 1px solid var(--line); flex-shrink: 0; }
    .tile2.alt { display: inline-flex; align-items: center; justify-content: center; font-size: 10px; color: var(--muted); }
    .tmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .tmain b { font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tsub { font-size: 10.5px; color: var(--muted); font-family: 'IBM Plex Mono', monospace; white-space: nowrap; }
    .tbest { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; flex-shrink: 0; }
    .tvp { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; font-size: 18px;
      font-weight: 700; color: var(--accent); white-space: nowrap; flex-shrink: 0; }
    .tvp em { font-style: normal; font-size: 11px; color: var(--muted); margin-left: 1px; }
  </style>
  <div class="cols2">
    <div class="panel">
      <h2>한 장으로 최다 득점 TOP</h2>
      ${topRows}
    </div>
    <div class="panel">
      <h2>타일별 통계 (최고 기록순)</h2>
      ${tileRows}
    </div>
  </div>
  <p class="legend">점수 = 그 판에서 그 타일이 벌어준 VP 합계(즉시 + 액션/패스 누적, 점수 내역 기준) ·
    일반 타일 중 점수형인 '가이아 광산마다 3VP' 포함 · 자원/액션형 타일은 VP를 직접 주지 않아 낮게/안 잡힘 ·
    타일 이미지에 마우스를 올리면 이름 표시.</p>`;

  return pageShell({
    title: meta.title, emoji: meta.emoji, accent: meta.accent,
    intro: `전원 사람 <b>4인 게임 ${games.length}판</b>에서 고급 기술 타일 한 장이 벌어준 점수 기록.`,
    bodyHtml: body,
    footNote: '집계: 게임 종료 시점 점수 내역(scoreBreakdown.techTiles)의 adv-* 항목 합산',
  });
}
