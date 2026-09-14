/**
 * 게임 기록 브라우저 — 로그 분석을 매번 스크립트로 새로 만들지 않게 시스템화 (사용자 2026-09-14).
 *   1단계 목록: 날짜 · 참가자(이름/종족/점수) · 라운드 · 봇 표시 — 이름/종족/날짜 검색, 표준(사람 4인) 필터
 *   2단계 게임: 4명 카드(순위·점수·내역·연구·타일·연방) + 라운드 끝 점수판 + 전체 타임라인
 *   3단계 사람: 점수 감사(playerScoreAudit 형식 — 검증 카드 7장 + 액션별 자원 흐름 표 + 점수 내역)
 *
 * 데이터는 표준 필터 없이 전 게임(봇 포함·인원 무관)을 담고 화면에서 걸러 본다 — "디애박 259점"처럼
 * 봇 게임에서 나온 기록도 찾아볼 수 있어야 하므로. 게임별 상세는 games-data/cNN.js 조각으로 나눠(JSONP) 클릭 시 로드.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { canon, isBot, esc, DATA_DIR, EXCLUDE_GAMES, buildStamp } from '../lib/common.mjs';
import { FACTION_KO, FACTION_COLOR, factionFaceB64 } from '../lib/factions.mjs';
import { auditPlayer, breakdownGroups, actionKo, lab, researchStr } from '../lib/audit.mjs';

export const meta = {
  id: 'games', title: '게임 기록 브라우저', emoji: '🗂️', accent: '#8fb8ff', order: 0,
  description: '판 목록 → 4명 카드 → 한 사람 점수 감사. 날짜·이름·종족으로 찾고 클릭해서 파고든다.',
};

const CHUNK = 30;
const BREAK = 10 * 60 * 1000;
const RESK = [['vp', 'VP'], ['c', 'C'], ['o', 'O'], ['k', 'K'], ['q', 'Q'], ['p1', 'P1'], ['p2', 'P2'], ['p3', 'P3']];
const diffStr = (a, b) => {
  if (!a || !b) return '';
  const parts = [];
  for (const [k, l] of RESK) { const x = a[k] ?? 0, y = b[k] ?? 0; if (x !== y) parts.push(`${l} ${x}→${y}`); }
  return parts.join(', ');
};
const rankOf = (P, id) => 1 + Object.values(P).filter((x) => (x.score ?? 0) > (P[id].score ?? 0)).length;

function gameDetail(g, file) {
  const P = g.players; const ids = Object.keys(P);
  const log = [...(g.gameLog ?? [])].sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const ts = log.map((e) => e.timestamp).filter(Boolean).sort((a, b) => a - b);
  let play = 0, breaks = 0;
  for (let i = 1; i < ts.length; i++) { const gap = ts[i] - ts[i - 1]; if (gap >= BREAK) breaks++; else play += gap; }
  const order = g.turnOrder?.length ? g.turnOrder : ids;
  const pidx = Object.fromEntries(ids.map((id, i) => [id, i]));
  // 라운드 끝 점수판: 라운드별 각자의 마지막 snap
  const board = {}; const last = {};
  const tl = [];
  for (const e of log) {
    const r = e.round ?? 0;
    if (e.snap && e.playerId) { last[e.playerId] = e.snap; (board[r] ??= {})[e.playerId] = e.snap; }
    tl.push([e.seq ?? 0, r, e.playerId ? pidx[e.playerId] ?? -1 : -1, actionKo(e.action), [e.details, e.tileId].filter(Boolean).join(' · '), diffStr(e.base, e.snap), e.timestamp ?? 0]);
  }
  const rounds = Object.keys(board).map(Number).sort((a, b) => a - b);
  return {
    id: g.gameId, file, start: ts[0] ?? null, end: ts.at(-1) ?? null, play: Math.round(play / 60000), breaks, rounds: g.roundNumber,
    ps: ids.map((id) => {
      const p = P[id];
      return {
        n: canon(p.name), raw: p.name, f: p.faction, s: p.score ?? 0, rk: rankOf(P, id), bot: isBot(g, id) ? 1 : 0,
        order: order.indexOf(id) + 1, bonus: p.bonusTile ? lab(p.bonusTile) : '', tiles: (p.techTiles ?? []).map(lab), feds: (p.federations ?? []).length,
        research: researchStr(p.research), bd: breakdownGroups(p.scoreBreakdown), audit: auditPlayer(g, id),
      };
    }),
    board: rounds.map((r) => [r, ids.map((id) => board[r][id]?.vp ?? null), ids.map((id) => { const s = board[r][id]; return s ? RESK.slice(1).map(([k, l]) => `${l}${s[k] ?? 0}`).join(' ') : ''; })]),
    tl,
  };
}

export function build({ dist }) {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json') && !EXCLUDE_GAMES.has(f)).sort().reverse();
  const index = []; const chunks = [];
  let cur = {}; let curN = 0;
  for (const f of files) {
    let g; try { g = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { continue; }
    const P = g.players ?? {}; const ids = Object.keys(P);
    if (!ids.length) continue;
    const bots = ids.filter((id) => isBot(g, id)).length;
    const gid = g.gameId ?? f.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace(/\.json$/, '');
    const ci = chunks.length;
    index.push({
      id: gid, d: f.slice(0, 10), c: ci, r: g.roundNumber ?? 0, n: ids.length, bots,
      std: ids.length === 4 && bots === 0 && (g.roundNumber ?? 0) >= 6 ? 1 : 0,
      ps: ids.map((id) => ({ n: canon(P[id].name), f: P[id].faction, s: P[id].score ?? 0, rk: rankOf(P, id), bot: isBot(g, id) ? 1 : 0 })).sort((a, b) => a.rk - b.rk),
    });
    cur[gid] = gameDetail(g, f); curN++;
    if (curN >= CHUNK) { chunks.push(cur); cur = {}; curN = 0; }
  }
  if (curN) chunks.push(cur);
  const dataDir = path.join(dist, 'games-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const sizes = [];
  chunks.forEach((c, i) => {
    const out = `window.__gaiaChunk(${i},${JSON.stringify(c)});`;
    fs.writeFileSync(path.join(dataDir, `c${String(i).padStart(2, '0')}.js`), out);
    sizes.push(out.length);
  });
  const faces = Object.fromEntries(Object.keys(FACTION_KO).map((k) => [k, factionFaceB64(k)]).filter(([, v]) => v));
  const client = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'gamesClient.js'), 'utf8');
  const body = fragment({ index, chunkCount: chunks.length, faces, client });
  // 아티팩트용 조각(doctype/html/head/body 없음 — 게시 도구가 감싼다)
  fs.writeFileSync(path.join(dist, 'games.artifact.html'), body);
  console.log(`    games: ${index.length}판 · 조각 ${chunks.length}개 (최대 ${(Math.max(...sizes) / 1e6).toFixed(1)}MB, 합 ${(sizes.reduce((s, x) => s + x, 0) / 1e6).toFixed(1)}MB)`);
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><a class="back" href="./index.html">← 가이아 통계 홈</a>${body}</body></html>`; // 정적 사이트(dist)에서만 홈 링크 — 아티팩트 조각에는 index.html이 없음
}

function fragment({ index, chunkCount, faces, client }) {
  const DATA = { index, chunkCount, faces, ko: FACTION_KO, color: FACTION_COLOR, stamp: buildStamp() };
  return `<title>가이아 게임 기록실</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Black+Han+Sans&family=IBM+Plex+Sans+KR:wght@400;500;700&family=IBM+Plex+Mono:wght@500;600&display=swap" />
<style>
  :root {
    --bg:#0b0f1a; --panel:#121a2c; --panel2:#0e1524; --line:#22304d; --line2:rgba(34,48,77,.5);
    --ink:#e9edf6; --muted:#8b96ae; --dim:#5f6b85; --acc:#8fb8ff; --acc2:#79c99e;
    --gold:#f2c14e; --silver:#b9c5da; --bronze:#cf8f63; --up:#6fdc8c; --dn:#ff9b9b; --bad:#ff7b7b; --chg:#eab308;
    --sans:'IBM Plex Sans KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif; --mono:'IBM Plex Mono',ui-monospace,Consolas,monospace;
  }
  * { box-sizing:border-box; }
  html { color-scheme:dark; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans); font-size:14px; line-height:1.5;
    background-image:radial-gradient(1100px 460px at 75% -10%, rgba(143,184,255,.10), transparent 60%), radial-gradient(700px 380px at 5% 0%, rgba(121,201,158,.07), transparent 55%); }
  .back { position:fixed; top:8px; right:14px; z-index:5; color:var(--muted); text-decoration:none; font-size:12px; font-weight:700; padding:4px 10px; border-radius:999px; border:1px solid var(--line); background:var(--panel2); }
  .back:hover { color:var(--acc); }
  .wrap { max-width:1280px; margin:0 auto; padding-block:22px 64px; padding-inline:20px; }
  .wrap.wide { max-width:none; }
  a { color:var(--acc); }
  button { font:inherit; color:inherit; }
  :focus-visible { outline:2px solid var(--acc); outline-offset:2px; border-radius:6px; }
  /* 상단 경로 */
  .crumbs { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:13px; color:var(--muted); margin-bottom:14px; min-height:28px; }
  .crumbs button { background:none; border:0; padding:2px 4px; cursor:pointer; color:var(--muted); font-weight:700; border-radius:6px; }
  .crumbs button:hover { color:var(--acc); }
  .crumbs .cur { color:var(--ink); font-weight:700; }
  .crumbs .sep { color:var(--dim); }
  h1 { font-family:'Black Han Sans',var(--sans); font-weight:400; font-size:clamp(30px,5vw,44px); margin:0; letter-spacing:.5px; text-wrap:balance; }
  h1 .green { color:var(--acc); }
  .sub { color:var(--muted); font-size:13.5px; line-height:1.6; margin:8px 0 0; max-width:70ch; }
  .sub b { color:var(--ink); }
  .stamp { display:inline-flex; gap:6px; margin-top:10px; padding:3px 10px; border-radius:999px; border:1px solid var(--line); background:var(--panel2); color:var(--muted); font-size:12px; font-family:var(--mono); }
  /* 필터 바 */
  .bar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin:22px 0 12px; }
  .bar input[type=search], .bar select { background:var(--panel2); border:1px solid var(--line); color:var(--ink); border-radius:8px; padding:7px 10px; font:inherit; font-size:13px; min-width:0; }
  .bar input[type=search] { flex:1 1 260px; }
  .bar label.chk { display:inline-flex; gap:6px; align-items:center; color:var(--muted); font-size:13px; cursor:pointer; white-space:nowrap; }
  .bar .count { margin-left:auto; color:var(--muted); font-family:var(--mono); font-size:12px; white-space:nowrap; }
  /* 게임 목록 */
  .tblwrap { overflow-x:auto; border:1px solid var(--line); border-radius:12px; background:var(--panel); }
  table { border-collapse:collapse; width:100%; }
  th { position:sticky; top:0; z-index:2; background:#16203a; color:var(--muted); font-size:10.5px; text-transform:uppercase; letter-spacing:.09em; padding:9px 10px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }
  td { padding:7px 10px; border-bottom:1px solid var(--line2); vertical-align:middle; }
  tr:last-child td { border-bottom:0; }
  .glist tbody tr { cursor:pointer; }
  .glist tbody tr:hover td { background:rgba(143,184,255,.06); }
  .glist td.d { font-family:var(--mono); font-size:12.5px; white-space:nowrap; color:var(--muted); }
  .glist td.d b { color:var(--ink); font-weight:600; }
  .glist td.tag { white-space:nowrap; font-size:11px; color:var(--dim); font-family:var(--mono); }
  .chips { display:flex; gap:6px; flex-wrap:wrap; }
  .chip { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); background:var(--panel2); border-radius:999px; padding:2px 9px 2px 3px; font-size:12px; white-space:nowrap; }
  .chip img { width:20px; height:20px; border-radius:50%; object-fit:cover; background:#0a0e18; }
  .chip .fdot { width:20px; height:20px; border-radius:50%; background:var(--fc,#556); }
  .chip .nm { font-weight:700; }
  .chip .fc { color:var(--muted); }
  .chip .sc { font-family:var(--mono); font-size:11.5px; color:var(--muted); }
  .chip.win { border-color:rgba(242,193,78,.6); box-shadow:0 0 0 1px rgba(242,193,78,.25) inset; }
  .chip.win .sc { color:var(--gold); font-weight:600; }
  .chip.bot { opacity:.6; border-style:dashed; }
  .chip.hl .nm { color:var(--acc); }
  .pill { display:inline-block; font-size:10.5px; padding:1px 7px; border-radius:999px; border:1px solid var(--line); color:var(--muted); font-family:var(--mono); margin-left:4px; }
  .pill.warn { color:#f0b46a; border-color:rgba(240,180,106,.4); }
  .empty { color:var(--muted); padding:28px; text-align:center; }
  /* 게임 화면 */
  .ghead { display:flex; gap:14px; align-items:flex-end; flex-wrap:wrap; margin-bottom:16px; }
  .ghead .meta { color:var(--muted); font-family:var(--mono); font-size:12.5px; line-height:1.8; }
  .pcards { display:grid; grid-template-columns:repeat(auto-fit,minmax(270px,1fr)); gap:12px; }
  .pcard { text-align:left; background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:14px; cursor:pointer; display:flex; flex-direction:column; gap:10px; min-width:0; transition:border-color .15s, transform .15s; border-top:3px solid var(--fc,var(--line)); }
  .pcard:hover { border-color:var(--acc); transform:translateY(-2px); }
  .pcard .top { display:flex; align-items:center; gap:10px; min-width:0; }
  .pcard img.face { width:44px; height:44px; border-radius:50%; object-fit:cover; background:#0a0e18; border:2px solid var(--fc,var(--line)); flex-shrink:0; }
  .pcard .who { min-width:0; flex:1; }
  .pcard .who .nm { font-size:16px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pcard .who .fc { color:var(--muted); font-size:12px; }
  .pcard .score { font-family:var(--mono); font-size:26px; font-weight:600; line-height:1; text-align:right; }
  .pcard .score small { display:block; font-size:10.5px; color:var(--muted); letter-spacing:.08em; text-transform:uppercase; margin-top:3px; }
  .medal { width:22px; height:22px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-family:var(--mono); font-size:12px; font-weight:600; color:#0b0f1a; flex-shrink:0; }
  .medal.r1 { background:var(--gold); box-shadow:0 0 8px rgba(242,193,78,.45); } .medal.r2 { background:var(--silver); } .medal.r3 { background:var(--bronze); } .medal.r4 { background:#2c3a57; color:var(--muted); }
  .bd { display:flex; flex-direction:column; gap:3px; font-size:11.5px; }
  .bd .bdr { display:grid; grid-template-columns:1fr auto; gap:8px; align-items:center; }
  .bd .bdr .lbl { color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .bd .bdr .val { font-family:var(--mono); text-align:right; min-width:3em; }
  .bd .bdr .val.neg { color:var(--dn); }
  .bd .barbg { grid-column:1 / -1; height:3px; background:var(--panel2); border-radius:2px; overflow:hidden; }
  .bd .barbg i { display:block; height:100%; background:var(--fc,var(--acc)); opacity:.85; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:11.5px; color:var(--muted); }
  .kv b { color:var(--ink); font-weight:500; font-family:var(--mono); font-size:11.5px; }
  .kv .tiles { color:var(--ink); line-height:1.5; }
  .sec { margin-top:28px; }
  .sec > h2 { font-size:12px; letter-spacing:.18em; color:var(--acc); text-transform:uppercase; margin:0 0 12px; display:flex; align-items:center; gap:10px; font-weight:700; }
  .sec > h2::after { content:''; flex:1; height:1px; background:linear-gradient(90deg,var(--line),transparent); }
  .sec > h2 .hint { font-weight:500; letter-spacing:0; text-transform:none; color:var(--dim); font-size:12px; }
  .board td, .board th { text-align:right; font-family:var(--mono); font-size:12.5px; white-space:nowrap; }
  .board td:first-child, .board th:first-child { text-align:left; }
  .board td .res { display:block; color:var(--dim); font-size:10.5px; }
  .board td.lead { color:var(--gold); font-weight:600; }
  /* 타임라인 */
  .tl { display:flex; flex-direction:column; gap:0; }
  .tl .rh { position:sticky; top:0; z-index:1; background:#16203a; border-bottom:1px solid var(--line); padding:6px 10px; font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); font-weight:700; margin-top:10px; border-radius:8px 8px 0 0; }
  .tl .ev { display:grid; grid-template-columns:3.2em 6.5em minmax(160px,1.1fr) minmax(200px,2fr) minmax(160px,1.4fr); gap:10px; padding:4px 10px; border-bottom:1px solid var(--line2); font-size:12px; align-items:baseline; }
  .tl .ev.hl { background:rgba(143,184,255,.07); }
  .tl .ev .seq { color:var(--dim); font-family:var(--mono); font-size:11px; }
  .tl .ev .who { font-weight:700; color:var(--fc,var(--ink)); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tl .ev .who.sys { color:var(--dim); font-weight:500; }
  .tl .ev .act { color:var(--ink); }
  .tl .ev .det { color:var(--muted); overflow-wrap:anywhere; }
  .tl .ev .dif { color:var(--dim); font-family:var(--mono); font-size:11px; overflow-wrap:anywhere; }
  .tl.onlyme .ev:not(.hl) { display:none; }
  .tl.onlyme .ev.hl { background:transparent; }
  @media (max-width:760px) { .tl .ev { grid-template-columns:3em 1fr; } .tl .ev .act, .tl .ev .det, .tl .ev .dif { grid-column:2; } }
  .toggle { display:inline-flex; gap:6px; align-items:center; color:var(--muted); font-size:12px; cursor:pointer; letter-spacing:0; text-transform:none; font-weight:500; }
  /* 사람 화면 (감사) */
  .ptabs { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:16px; }
  .ptabs button { display:inline-flex; align-items:center; gap:8px; background:var(--panel2); border:1px solid var(--line); border-radius:999px; padding:5px 12px 5px 5px; cursor:pointer; font-size:13px; }
  .ptabs button img { width:24px; height:24px; border-radius:50%; object-fit:cover; }
  .ptabs button .sc { font-family:var(--mono); color:var(--muted); font-size:12px; }
  .ptabs button.on { border-color:var(--acc); background:rgba(143,184,255,.12); }
  .ptabs button.on .nm { color:var(--acc); }
  .cards { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 14px; font-size:13px; }
  .card b { color:var(--acc2); } .card .sub { display:block; margin-top:2px; color:var(--muted); font-size:11.5px; }
  .ok { color:var(--up); } .bad { color:var(--bad); font-weight:700; } .na { color:var(--dim); }
  .card.isbad { border-color:rgba(255,123,123,.5); }
  table.audit { font-size:11.5px; }
  .audit th { text-align:right; padding:8px 7px; }
  .audit th.l, .audit td.l { text-align:left; }
  .audit td { padding:3px 6px; border-bottom:1px solid rgba(34,48,77,.45); text-align:right; font-family:var(--mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
  .audit td.l { font-family:var(--sans); white-space:normal; min-width:200px; }
  .audit .sub { color:var(--muted); font-size:11px; }
  .audit tr:nth-child(odd) td { background:rgba(14,21,36,.5); }
  .up { color:var(--up); } .dn { color:var(--dn); }
  .audit td.colsep { border-left:1px solid var(--line); min-width:64px; }
  .audit td.vpcol { border-left:2px solid #3a4c78; background:rgba(121,201,158,.06); }
  .audit .cur { color:#dfe7f6; font-weight:600; } .audit .cur.dim { color:var(--dim); font-weight:400; }
  .audit td em { font-style:normal; font-size:10.5px; margin-left:3px; }
  .audit tr.imp td { background:rgba(139,150,174,.10) !important; }
  .audit tr.imp .cur { color:var(--muted); }
  .audit tr.nolog td.l::after { content:' ·'; color:var(--dim); }
  .audit td.state { text-align:left; font-size:11px; color:var(--dim); white-space:nowrap; }
  .audit td.state.tiles { white-space:normal; min-width:170px; max-width:260px; line-height:1.5; }
  .audit td.state.chg { color:var(--chg); font-weight:700; }
  .audit td.rnd { color:var(--dim); }
  .audit tr.rstart td { border-top:2px solid var(--line); }
  .bdt { margin-top:20px; max-width:480px; }
  .bdt td { font-family:var(--mono); text-align:right; }
  .bdt td.l { font-family:var(--sans); text-align:left; }
  .legend { color:var(--muted); font-size:12px; margin-top:12px; line-height:1.7; max-width:110ch; }
  .loading { color:var(--muted); padding:40px; text-align:center; font-family:var(--mono); }
  .foot { margin-top:34px; color:var(--dim); font-size:12px; line-height:1.7; border-top:1px solid var(--line); padding-top:14px; }
  @media (prefers-reduced-motion:reduce) { .pcard, .pcard:hover { transition:none; transform:none; } }
</style>
<div class="wrap" id="app"><div class="loading">불러오는 중…</div></div>
<script>window.__GAIA=${JSON.stringify(DATA).replace(/</g, '\\u003c')};</script>
<script>${client}</script>
`;
}
