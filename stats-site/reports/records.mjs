/**
 * 최고 기록 — 인공물별·고급 기술 타일별 '한 판에서 그 한 장으로 가장 많이 벌어간 사람'.
 *
 * 사용자 요청(2026-09-16): scripts/tileVpRecords.mjs 결과를 통계 사이트에서 예쁘게 볼 수 있게.
 * 점수 고정 인공물(7VP+가상광산)과 트랙레벨×3 인공물(가이아·과학, 최고 15)은 사용자 지정으로 제외.
 * 집계: scoreBreakdown.other 의 'Artifact: …'(인공물), scoreBreakdown.techTiles 의 adv-*(득점마다 1행 → 합산).
 */
import path from 'path';
import fs from 'fs';
import { REPO_ROOT, gameRanks, canon, pageShell, esc, b64img } from '../lib/common.mjs';
import { factionKo, factionFaceB64 } from '../lib/factions.mjs';

export const meta = {
  id: 'records',
  order: 6.5,
  title: '한 장 최고 기록',
  emoji: '🏅',
  accent: '#f2c14e',
  description: '인공물·고급 기술 타일 한 장으로 한 판에서 가장 많이 벌어간 사람 — 종류별 1위(동률 포함)와 차순위',
};

/** 인공물: scoreBreakdown.other.source → 표시 (artifacts.mjs 라벨·이미지 번호와 동일) */
const ARTS = [
  { src: 'Artifact: Bridge VP', label: '외곽 구역 ×3 VP', img: 12, unit: '구역', per: 3 },
  { src: 'Artifact: Tracks >= 3', label: '3레벨↑ 트랙 ×3 VP', img: 9, unit: '트랙', per: 3 },
  { src: 'Artifact: Planet types', label: '3 + 행성유형 VP', img: 7, unit: '유형', per: 1, base: 3 },
];
/** 고급 타일 (advtiles.mjs ADV와 동일 매핑). cap: 상한이 있는 즉시형 → 동률 다수 안내용 */
const ADV = {
  'adv-vp-build-mine': { label: '광산 건설마다 3VP', img: 'TechTile_A11.png' },
  'adv-vp-build-ts': { label: '교역소 건설마다 3VP', img: 'TechTile_A12.png' },
  'adv-vp-research': { label: '연구 전진마다 2VP', img: 'TechTile_A9.png' },
  'adv-vp-terraform': { label: '테라포밍 스텝마다 2VP', img: 'TechTile_A20.png' },
  'adv-vp-qic-action': { label: '정큐 액션마다 4VP', img: 'TechTile_A19.png' },
  'adv-imm-4vp-ts': { label: '즉시: 교역소×4 VP', img: 'TechTile_A6.png', cap: 16 },
  'adv-imm-2vp-mine': { label: '즉시: 광산×2 VP', img: 'TechTile_A2.png' },
  'adv-imm-2vp-sector': { label: '즉시: 섹터×2 VP', img: 'TechTile_A3.png' },
  'adv-imm-4vp-outer': { label: '즉시: 외곽 섹터×4 VP', img: 'TechTile_A21.png' },
  'adv-imm-6vp-big': { label: '즉시: 대형건물×6 VP', img: 'TechTile_A16.png', cap: 18 },
  'adv-imm-2vp-gaia': { label: '즉시: 가이아×2 VP', img: 'TechTile_A14.png' },
  'adv-imm-5vp-fed': { label: '즉시: 연방×5 VP', img: 'TechTile_A4.png' },
  'adv-pass-1vp-type': { label: '패스: 행성유형×1 VP', img: 'TechTile_A10.png' },
  'adv-pass-3vp-lab': { label: '패스: 연구소×3 VP', img: 'TechTile_A7.png' },
  'adv-pass-3vp-fed': { label: '패스: 연방×3 VP', img: 'TechTile_A5.png' },
  'adv-pass-2vp-asteroid': { label: '패스: 소행성×2 VP', img: 'TechTile_A18.png' },
  'adv-pass-2vp-outer': { label: '패스: 외곽 섹터×2 VP', img: 'TechTile_A17.png' },
};
const tileB64 = (file) => {
  const p = path.join(REPO_ROOT, 'client', 'public', 'tech', file);
  return fs.existsSync(p) ? `data:image/png;base64,${fs.readFileSync(p).toString('base64')}` : null;
};
// 종족 얼굴은 행마다 data URI를 박으면 파일이 수십 MB가 되므로 CSS 클래스(.f-<id>)로 한 번만 정의
const usedFaces = new Set();
const faceHtml = (fid, extra = '') => {
  if (!factionFaceB64(fid)) return '';
  usedFaces.add(fid);
  return `<span class="face f-${fid}${extra}"></span>`;
};

const SHOW_RUNNERS = 2;   // 1위(동률 전부) 아래에 보여줄 차순위 행 수(차순위 동률은 +2까지 허용)
const TIE_INLINE = 4;     // 1위 동률이 이 수를 넘으면 접어서 표시

export function build({ games }) {
  const artCases = {}; // src -> cases
  const advCases = {}; // tileId -> cases
  for (const { file, game: g } of games) {
    const date = file.slice(0, 10);
    const ranks = gameRanks(g);
    for (const p of Object.values(g.players)) {
      const name = canon(p.name);
      const rank = ranks.find((r) => r.name === name && r.faction === p.faction)?.rank ?? p.rank ?? 0;
      const base = { name, fid: p.faction, date, score: p.score ?? 0, rank };
      const a = {};
      for (const o of p.scoreBreakdown?.other ?? []) if (ARTS.some((d) => d.src === o.source)) a[o.source] = (a[o.source] ?? 0) + (o.vp ?? 0);
      for (const [src, vp] of Object.entries(a)) (artCases[src] ??= []).push({ ...base, vp });
      const t = {};
      for (const e of p.scoreBreakdown?.techTiles ?? []) if (e.tileId in ADV) t[e.tileId] = (t[e.tileId] ?? 0) + (e.vp ?? 0);
      for (const [id, vp] of Object.entries(t)) (advCases[id] ??= []).push({ ...base, vp });
    }
  }

  const who = (c) => `
    <span class="who">
      ${faceHtml(c.fid)}
      <b>${esc(c.name)}</b><span class="fac">${esc(factionKo(c.fid))}</span>
    </span>`;
  const row = (c, cls, medal) => `
    <div class="rrow ${cls}">
      <span class="rmedal">${medal}</span>
      ${who(c)}
      <span class="rmeta">${esc(c.date)} · 최종 ${c.score}점 <em>${c.rank}위</em></span>
      <span class="rvp">${c.vp}<em>점</em></span>
    </div>`;

  function card({ label, imgHtml, cases, cap, note }) {
    cases.sort((x, y) => y.vp - x.vp || y.score - x.score);
    const n = cases.length;
    const avg = n ? (cases.reduce((s, c) => s + c.vp, 0) / n).toFixed(1) : '-';
    const best = cases[0]?.vp ?? 0;
    const ties = cases.filter((c) => c.vp === best);
    const runners = [];
    for (const c of cases) {
      if (c.vp >= best) continue;
      if (runners.length && runners[runners.length - 1].vp !== c.vp && runners.length >= SHOW_RUNNERS) break;
      if (runners.length >= SHOW_RUNNERS + 2) break;
      runners.push(c);
    }
    let top;
    if (ties.length > TIE_INLINE) {
      top = `
      <div class="rrow first">
        <span class="rmedal"><span class="m1">1</span></span>
        <span class="who"><b>${ties.length}명 동률</b><span class="fac">${cap === best ? '상한 점수' : '최고점 공동'}</span></span>
        <span class="rmeta"></span>
        <span class="rvp">${best}<em>점</em></span>
      </div>
      <details class="ties"><summary>동률 ${ties.length}명 보기</summary>
        <div class="tielist">${ties.map((c) => `<span class="chip">${faceHtml(c.fid, ' sm')}${esc(c.name)} <em>${esc(factionKo(c.fid))} · ${esc(c.date)}</em></span>`).join('')}</div>
      </details>`;
    } else {
      top = ties.map((c) => row(c, 'first', '<span class="m1">1</span>')).join('');
    }
    // 차순위 등수: 1위 동률 인원 다음부터, 같은 점수는 같은 등수
    let prev = null, place = ties.length + 1;
    const runnerHtml = runners.map((c, i) => {
      if (prev === null || c.vp !== prev) place = ties.length + 1 + i;
      prev = c.vp;
      return row(c, 'rest', `<span class="mr">${place}</span>`);
    }).join('');
    return `
    <section class="rcard">
      <header class="rhead">
        ${imgHtml}
        <div class="rtitle">
          <h3>${esc(label)}</h3>
          <span class="rstat">획득 ${n}회 · 평균 ${avg}점${note ? ` · ${esc(note)}` : ''}</span>
        </div>
      </header>
      ${n ? top + runnerHtml : '<div class="empty">기록 없음</div>'}
    </section>`;
  }

  const artCards = ARTS
    .map((d) => ({ d, cases: artCases[d.src] ?? [] }))
    .sort((a, b) => Math.max(0, ...b.cases.map((c) => c.vp)) - Math.max(0, ...a.cases.map((c) => c.vp)))
    .map(({ d, cases }) => {
      const best = cases.length ? Math.max(...cases.map((c) => c.vp)) : 0;
      const cnt = d.base ? best - d.base : best / d.per;
      return card({
        label: d.label,
        imgHtml: `<img class="rimg art" src="${b64img(`Art${d.img}.png`)}" alt="${esc(d.label)}" />`,
        cases, note: cases.length ? `최고 = ${d.unit} ${cnt}개` : '',
      });
    }).join('');

  const advCards = Object.entries(ADV)
    .map(([id, d]) => ({ id, d, cases: advCases[id] ?? [] }))
    .sort((a, b) => Math.max(0, ...b.cases.map((c) => c.vp)) - Math.max(0, ...a.cases.map((c) => c.vp)))
    .map(({ d, cases }) => {
      const img = tileB64(d.img);
      return card({
        label: d.label, cap: d.cap,
        imgHtml: img ? `<img class="rimg tile" src="${img}" alt="${esc(d.label)}" />` : `<span class="rimg tile alt">${esc(d.label)}</span>`,
        cases, note: d.cap ? `상한 ${d.cap}점` : '',
      });
    }).join('');

  const faceCss = [...usedFaces].map((fid) => `.face.f-${fid} { background-image: url(${factionFaceB64(fid)}); }`).join('\n    ');
  const body = `
  <style>
    ${faceCss}
    .rgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 14px; }
    @media (max-width: 460px) { .rgrid { grid-template-columns: 1fr; } }
    .rcard { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px 14px 10px;
      display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .rhead { display: flex; align-items: center; gap: 12px; min-width: 0; margin-bottom: 6px; }
    .rimg { flex-shrink: 0; background: #0a0e18; border: 1px solid var(--line); }
    .rimg.art { width: 58px; height: 58px; border-radius: 50%; object-fit: cover;
      border: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
      box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 25%, transparent); }
    .rimg.tile { width: 96px; height: 56px; border-radius: 8px; object-fit: contain; }
    .rimg.tile.alt { display: inline-flex; align-items: center; justify-content: center; font-size: 10px; color: var(--muted); }
    .rtitle { min-width: 0; }
    .rtitle h3 { margin: 0; font-size: 15px; font-weight: 700; }
    .rstat { color: var(--muted); font-size: 11.5px; font-family: 'IBM Plex Mono', monospace; }
    .rrow { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 10px; min-width: 0; }
    .rrow.first { background: rgba(242,193,78,.10); box-shadow: inset 3px 0 0 var(--gold); }
    .rrow.rest:nth-child(even) { background: var(--panel2); }
    .rmedal { width: 20px; flex-shrink: 0; display: inline-flex; justify-content: center; }
    .rmedal .m1 { width: 20px; height: 20px; border-radius: 50%; background: var(--gold); color: #0b0f1a;
      display: inline-flex; align-items: center; justify-content: center; font-family: 'IBM Plex Mono', monospace;
      font-size: 11px; font-weight: 700; box-shadow: 0 0 8px rgba(242,193,78,.45); }
    .rmedal .mr { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--muted); }
    .who { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
    .who b { font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .who .fac { font-size: 11px; color: var(--muted); white-space: nowrap; }
    .face { display: inline-block; width: 22px; height: 28px; border-radius: 5px; border: 1px solid var(--line); flex-shrink: 0;
      background-size: cover; background-position: center; background-color: #0a0e18; }
    .face.sm { width: 16px; height: 20px; border-radius: 4px; vertical-align: -5px; margin-right: 3px; }
    .rmeta { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; font-size: 10.5px;
      color: var(--muted); white-space: nowrap; flex-shrink: 0; }
    .rmeta em { font-style: normal; color: var(--ink); }
    .rvp { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; font-size: 18px; font-weight: 700;
      color: var(--accent); white-space: nowrap; flex-shrink: 0; min-width: 3.2em; text-align: right; }
    .rrow.rest .rvp { font-size: 14px; color: var(--ink); }
    .rvp em { font-style: normal; font-size: 11px; color: var(--muted); margin-left: 1px; }
    details.ties { margin: 0 8px 4px; font-size: 12px; }
    details.ties summary { cursor: pointer; color: var(--muted); padding: 2px 0; }
    details.ties summary:hover { color: var(--accent); }
    .tielist { display: flex; flex-wrap: wrap; gap: 5px; padding: 6px 0 2px; }
    .chip { display: inline-flex; align-items: center; background: var(--panel2); border: 1px solid var(--line);
      border-radius: 999px; padding: 2px 9px 2px 5px; font-size: 11.5px; font-weight: 700; white-space: nowrap; }
    .chip em { font-style: normal; font-weight: 500; color: var(--muted); font-size: 10.5px; margin-left: 4px;
      font-family: 'IBM Plex Mono', monospace; }
    @media (max-width: 520px) { .rmeta { display: none; } }
  </style>
  <div class="sec">
    <h2>인공물</h2>
    <div class="rgrid">${artCards}</div>
    <p class="legend">점수가 정해져 있는 인공물(7VP + 가상광산 2종, 가이아·과학 트랙 레벨×3)은 기록 비교 의미가 없어 뺐다.
      '3레벨↑ 트랙'은 6트랙 전부면 18점, '외곽 구역'은 건물 있는 외곽 구역 수×3.</p>
  </div>
  <div class="sec">
    <h2>고급 기술 타일</h2>
    <div class="rgrid">${advCards}</div>
    <p class="legend">점수 = 그 판에서 그 타일이 벌어준 VP 합계(즉시 + 누적/패스, 점수 내역 기준).
      자원·액션형 3종(지식 3·광석 3·정큐+크레딧)은 VP를 직접 주지 않아 없음.
      즉시형 중 대형건물×6(최대 3채 = 18점)·교역소×4(최대 4채 = 16점)는 상한이 있어 동률이 많다.</p>
  </div>`;

  return pageShell({
    title: meta.title, emoji: meta.emoji, accent: meta.accent,
    intro: `전원 사람 <b>4인 게임 ${games.length}판</b>에서 인공물·고급 기술 타일 <b>한 장</b>으로 한 판에 가장 많이 벌어간 기록.
      1위는 동률 전원, 그 아래 차순위 몇 줄.`,
    bodyHtml: body,
    footNote: '집계: 게임 종료 시점 점수 내역(scoreBreakdown)의 Artifact 항목·adv-* 항목 합산',
  });
}
