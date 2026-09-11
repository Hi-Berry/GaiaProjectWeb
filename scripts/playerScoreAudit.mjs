// 한 사람의 한 판 점수 감사 페이지(HTML) — "이 점수가 맞나"를 액션 단위로 따라가며 검증.
// 이전에 수작업으로 만들던 '디애박 엠바스 256점 감사'(09-03)·'가야 다카니안 207점 감사'(09-08)와 같은 형식.
// 사용:  node scripts/playerScoreAudit.mjs 2026-09-09_2mxhog2b mks
//        node scripts/playerScoreAudit.mjs 2026-09-09_2mxhog2b hadsch_hallas     (종족 id로도 지정 가능)
//        node scripts/playerScoreAudit.mjs --faction=hadsch_hallas                (그 종족을 한 사람 4인 게임 중 무작위)
// 출력: data/audit/<게임파일>_<이름>.html  (Artifact로 게시해서 봄)
//
// 검증 항목(상단 카드): ①시작10+내역합=최종 ②비딩 반영 ③마지막 액션 후 종료정산 증가분 ④건물 재구성=최종 맵
// ⑤연구 변화가 전부 액션에 귀속 ⑥기술 타일 획득이 전부 액션에 귀속 ⑦액션 외 변동 횟수.
// 본문 표: 그 사람의 액션 하나=한 행. 자원 칸은 '액션 후 보유(±변동)'. 회색 〈액션 외 변동〉 행은 내 액션 사이에
// 생긴 변화(다른 사람 턴의 leech 수락, 수익 세부 등) — 직전 액션의 후 보유와 다음 액션의 전 보유의 차이.
import fs from 'fs';
import path from 'path';
import { canon, isBot, DATA_DIR, REPO_ROOT } from '../stats-site/lib/common.mjs';
import { FACTION_KO } from '../stats-site/lib/factions.mjs';

const args = process.argv.slice(2);
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=').slice(1).join('=') || null;
const pos = args.filter((a) => !a.startsWith('--'));
const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort();
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));

let file, who;
if (pos[0]) {
  file = files.find((f) => f.startsWith(pos[0]) || f.includes(`_${pos[0]}.json`));
  if (!file) { console.error(`게임 없음: ${pos[0]}`); process.exit(1); }
  who = pos[1] ?? opt('faction');
} else if (opt('faction')) {
  const fac = opt('faction');
  const cands = files.filter((f) => { const g = load(f); const ids = Object.keys(g.players ?? {}); return ids.length === 4 && !ids.some((id) => isBot(g, id)) && g.roundNumber >= 6 && ids.some((id) => g.players[id].faction === fac); });
  file = cands[Math.floor(Math.random() * cands.length)];
  who = fac;
} else { console.error('사용법 참조(파일 머리말)'); process.exit(1); }

const g = load(file);
const P = g.players;
const pid = Object.keys(P).find((id) => P[id].faction === who || canon(P[id].name) === who || P[id].name === who);
if (!pid) { console.error(`플레이어/종족 없음: ${who}`); process.exit(1); }
const me = P[pid];
const NAME = canon(me.name);
const FAC = FACTION_KO[me.faction] ?? me.faction;
const gameId = g.gameId ?? file.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace(/\.json$/, '');
const date = file.slice(0, 10);

// 타일 라벨 (shared/gameConfig.ts 에서 id/label 추출)
const LABEL = {};
try {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'shared', 'gameConfig.ts'), 'utf8');
  for (const m of src.matchAll(/\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'/g)) LABEL[m[1]] = m[2];
} catch {}
const lab = (id) => LABEL[id] ?? id;

const RES = [['credits', 'C'], ['ore', 'O'], ['knowledge', 'K'], ['qic', 'Q'], ['power1', 'P1'], ['power2', 'P2'], ['power3', 'P3']];
const TRACK = [['terraforming', '삽'], ['navigation', '항'], ['artificialIntelligence', 'AI'], ['gaiaProject', '가'], ['economy', '경'], ['science', '과']];
const resStr = (r) => TRACK.filter(([k]) => (r?.[k] ?? 0) > 0).map(([k, s]) => `${s}${r[k]}`).join(' ');
const BUILD_DELTA = {
  'Placed Starting Mine': { M: 1 }, 'Placed Starting Planetary Institute': { P: 1 },
  'Built Mine': { M: 1 }, 'Built Mine on Asteroid': { M: 1 }, 'Built Mine on Proto': { M: 1 }, 'Eclipse: Built mine on asteroid': { M: 1 }, 'Lost Planet (Nav 5)': { M: 1 },
  'Upgraded to Trading Station': { M: -1, T: 1 }, 'Rebellion: Mine → TS': { M: -1, T: 1 },
  'Upgraded to Research Lab': { T: -1, L: 1 }, 'Twilight: TS → Research Lab': { T: -1, L: 1 },
  'Upgraded to Academy': { L: -1, A: 1 }, 'Upgraded to Planetary Institute': { T: -1, P: 1 }, 'Firaks: Downgrade': { L: -1, T: 1 },
};
const bStr = (b) => `M${b.M}·T${b.T}·L${b.L}·P${b.P}·A${b.A}`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const cell = (val, delta, cls = '') => {
  const d = delta ?? 0;
  const em = d ? `<em class="${d > 0 ? 'up' : 'dn'}">(${d > 0 ? '+' : ''}${d})</em>` : '';
  return `<td class="colsep ${cls}"><span class="cur${d ? '' : ' dim'}">${val ?? ''}</span>${em}</td>`;
};

// ── 저널 순회 ─────────────────────────────────────────────────────────────
// 행의 뼈대는 actionJournal(그 사람의 모든 액션). 자원·VP 흐름은 gameLog의 base(직전)/snap(직후) 스냅샷 체인으로 따라간다 —
// journal의 playerBefore/After는 복합 액션에서 첫 단계 시점에 굳거나(before) 후속 효과(라운드 임무 VP, 연방 보상 크레딧) 전에
// 찍혀(after) 신뢰할 수 없다. journal은 연구·기술 타일 상태와 gameLog에 없는 자동 액션(종족 PI 변환 등) 표시에만 쓴다.
const aj = (g.actionJournal ?? []).filter((a) => a && a.playerId === pid).sort((a, b) => a.timestamp - b.timestamp);
const glog = (g.gameLog ?? []).filter((e) => e && e.playerId === pid && e.base && e.snap).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
const GKEY = { credits: 'c', ore: 'o', knowledge: 'k', qic: 'q', power1: 'p1', power2: 'p2', power3: 'p3' };
const toG = (res) => Object.fromEntries(RES.map(([k]) => [GKEY[k], res?.[k] ?? 0]));
const used = new Set();
const matchLog = (a) => { // 같은 액션명, 가장 가까운 시각(±3s), 미사용
  let best = null, bd = 3000;
  for (const e of glog) { if (used.has(e) || e.action !== a.action) continue; const dt = Math.abs((e.timestamp ?? 0) - a.timestamp); if (dt < bd) { bd = dt; best = e; } }
  if (best) used.add(best);
  return best;
};
const START_VP = 10;
const b = { M: 0, T: 0, L: 0, P: 0, A: 0 };
let chain = null;      // 마지막 gameLog snap (검증용 상태 체인)
let disp = null;       // 마지막으로 표에 보인 상태 (자동 액션 행의 변동 계산용)
let prevJ = null, prevScore = START_VP, matched = 0, pendingAuto = false;
let implicitRows = 0, implicitSuspect = 0, researchUps = 0, researchOdd = 0, tilesInside = 0;
const RESEARCH_ACTS = /Research|Tech Tile|Advanced track|Selected Faction|Placed Starting/;
const GK = Object.values(GKEY);
const rows = [];
for (const a of aj) {
  const after = a.playerAfter;
  const e = matchLog(a);
  let cur, dres, scoreAfter, dvp;
  if (e) {
    matched++;
    if (chain) { // 〈액션 외 변동〉: 직전 snap → 이번 base
      const d = GK.map((k) => (e.base[k] ?? 0) - (chain[k] ?? 0));
      const dv = (e.base.vp ?? 0) - (chain.vp ?? 0);
      if (dv || d.some(Boolean)) {
        implicitRows++;
        const suspect = !pendingAuto && (dv || d.slice(0, 4).some(Boolean));
        if (suspect) implicitSuspect++;
        rows.push(`<tr class="imp"><td></td><td class="l">〈액션 외 변동${pendingAuto ? ' · 위 ·표시 자동 액션 포함' : ''}〉 <span class="sub">leech 수락·수익·의회 등</span></td>${cell(e.base.vp, dv, 'vpcol')}${GK.map((k, i) => cell(e.base[k], d[i])).join('')}<td class="colsep state dim2"></td><td class="state dim2"></td><td class="colsep state dim2"></td></tr>`);
      }
    }
    cur = e.snap; dres = GK.map((k) => (e.snap[k] ?? 0) - (e.base[k] ?? 0));
    scoreAfter = e.snap.vp ?? prevScore; dvp = scoreAfter - (e.base.vp ?? prevScore);
    chain = e.snap; disp = e.snap; pendingAuto = false;
  } else { // gameLog에 없는 자동/부속 액션: journal after로 표시, 검증 체인은 건드리지 않음
    cur = toG(after.resources); const ref = disp ?? cur;
    dres = GK.map((k) => (cur[k] ?? 0) - (ref[k] ?? 0));
    scoreAfter = prevScore; dvp = 0;
    disp = cur; pendingAuto = true;
  }
  const bd = BUILD_DELTA[a.action]; let bChg = false;
  if (bd) { for (const k in bd) b[k] += bd[k]; bChg = true; }
  const ups = TRACK.reduce((s, [k]) => s + Math.max(0, (after.research?.[k] ?? 0) - (prevJ?.research?.[k] ?? 0)), 0);
  if (ups) { researchUps += ups; if (!RESEARCH_ACTS.test(a.action) && a.round > 0) researchOdd += ups; }
  const tAdded = (after.techTiles?.length ?? 0) - (prevJ?.techTiles?.length ?? 0);
  if (tAdded > 0) tilesInside += tAdded;
  rows.push(`<tr${e ? '' : ' class="nolog"'}>
      <td>R${a.round ?? 0}</td>
      <td class="l"><b>${esc(a.action)}</b>${a.details ? ` <span class="sub">${esc(a.details)}</span>` : ''}</td>
      ${cell(scoreAfter, dvp, 'vpcol')}${GK.map((k, i) => cell(cur[k], dres[i])).join('')}
      <td class="colsep state${bChg ? ' chg' : ''}">${bStr(b)}</td>
      <td class="state${ups ? ' chg' : ''}">${resStr(after.research)}</td>
      <td class="colsep state tiles${tAdded > 0 ? ' chg' : ''}">${(after.techTiles ?? []).map(lab).map(esc).join(' · ')}</td>
    </tr>`);
  prevJ = after; prevScore = scoreAfter;
}
const finalLevels = TRACK.reduce((s, [k]) => s + (me.research?.[k] ?? 0), 0);

// ── 검증 카드 ─────────────────────────────────────────────────────────────
const sb = me.scoreBreakdown ?? {};
const sumArr = (v) => (Array.isArray(v) ? v.reduce((s, x) => s + (x.vp ?? 0), 0) : typeof v === 'number' ? v : 0);
const groups = {};
for (const [k, v] of Object.entries(sb)) {
  if (k === 'finalMissionDetails') continue; // finalMissions와 중복
  if (k === 'other' && Array.isArray(v)) {
    for (const x of v) { const src = /연방/.test(x.source) ? '연방 보상 VP' : x.source; groups[`other · ${src}`] = (groups[`other · ${src}`] ?? 0) + (x.vp ?? 0); }
  } else groups[k] = (groups[k] ?? 0) + (k === 'powerReceived' ? -Math.abs(sumArr(v)) : sumArr(v));
}
const total = Object.values(groups).reduce((s, x) => s + x, 0);
const bid = -(sb.other ?? []).filter((x) => x.source === '종족 비딩').reduce((s, x) => s + (x.vp ?? 0), 0);
const lastScore = prevScore;
const settle = me.score - lastScore;
const endItems = (sb.researchTracks ?? 0) + (sb.remainingResources ?? 0);
const endExpected = endItems - bid; // 비딩은 종료 정산 때 차감
const mapB = { M: 0, T: 0, L: 0, P: 0, A: 0 };
for (const t of g.map ?? []) {
  if (t.ownerId !== pid || !t.structure) continue;
  const s = t.structure;
  if (s === 'mine' || s === 'lost_planet_mine') mapB.M++; else if (s === 'trading_station') mapB.T++; else if (s === 'research_lab') mapB.L++; else if (s === 'planetary_institute') mapB.P++; else if (s === 'academy') mapB.A++;
}
const ok = (c) => (c ? '<span class="ok">✔</span>' : '<span class="bad">✘</span>');
const cards = [
  `${ok(START_VP + total === me.score)} 시작 ${START_VP} + 내역합(파워수령 차감) = 최종 점수 <b>${START_VP}+${total} vs ${me.score}</b>`,
  bid ? `${ok(true)} 비딩 반영 <b>비딩 전 ${me.score + bid}점 − 종족 비딩 ${bid} = ${me.score}점</b>` : `<span class="ok">–</span> 종족 비딩 없음`,
  `${ok(settle === endExpected)} 마지막 액션 로그(${lastScore}) 이후 종료 정산 증가분 <b>+${settle}</b> <span class="sub">= 연구 트랙 ${sb.researchTracks ?? 0} + 잔여 자원 ${sb.remainingResources ?? 0}${bid ? ` − 비딩 ${bid}` : ''} = ${endExpected}</span>`,
  `${ok(bStr(b) === bStr(mapB))} 건물 재구성 = 최종 맵 상태 <b>재구성 ${bStr(b)} vs 맵 ${bStr(mapB)}</b>`,
  `${ok(researchUps === finalLevels && researchOdd === 0)} 연구 재구성 = 최종 research <b>액션에서 ${researchUps}단계 vs 최종 ${finalLevels}단계 (${resStr(me.research)})${researchOdd ? ` · 연구 무관 액션에서 ${researchOdd}단계` : ''}</b>`,
  `${ok(tilesInside === (me.techTiles ?? []).length)} 기술 타일 재구성 = 최종 보유 <b>${tilesInside}장 vs 실제 ${(me.techTiles ?? []).length}장</b>`,
  `액션 외 변동 구간 <b>${implicitRows}회</b> · 그중 자동 액션으로 설명 안 되는 VP·자원 변동 <b>${implicitSuspect}회</b> <span class="sub">gameLog 스냅샷 대조 ${matched}/${aj.length} 액션, 나머지 ${aj.length - matched}개는 ·표시 자동 액션</span>`,
];

const ranked = Object.keys(P).sort((x, y) => (P[y].score ?? 0) - (P[x].score ?? 0));
const bdRows = Object.entries(groups).sort((x, y) => y[1] - x[1]).map(([k, v]) => `<tr><td class="l">${esc(k)}</td><td class="${v < 0 ? 'dn' : ''}">${v > 0 ? '+' : ''}${v}</td></tr>`).join('');

const html = `<title>${esc(NAME)} ${esc(FAC)} ${me.score}점 감사</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;700&family=IBM+Plex+Mono:wght@500;600&display=swap');
  :root { --bg:#0b0f1a; --panel:#121a2c; --line:#22304d; --ink:#e9edf6; --muted:#8b96ae; --acc:#79c99e; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:'IBM Plex Sans KR',sans-serif; }
  .wrap { max-width:none; margin:0 auto; padding:28px 20px 64px; }
  h1 { font-size:24px; margin:0 0 6px; } .sub0 { color:var(--muted); font-size:13px; margin-bottom:18px; }
  .cards { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 14px; font-size:13px; }
  .card b { color:var(--acc); } .card .sub { display:block; margin-top:2px; }
  .ok { color:#6fdc8c; } .bad { color:#ff7b7b; font-weight:700; }
  .tblwrap { overflow-x:auto; border:1px solid var(--line); border-radius:12px; background:var(--panel); }
  table { border-collapse:collapse; width:100%; font-size:11.5px; }
  th { position:sticky; top:0; background:#16203a; color:var(--muted); font-size:10px; text-transform:uppercase;
       letter-spacing:.08em; padding:8px 7px; border-bottom:1px solid var(--line); text-align:right; z-index:2; }
  th.l, td.l { text-align:left; }
  td { padding:3px 6px; border-bottom:1px solid rgba(34,48,77,.45); text-align:right;
       font-family:'IBM Plex Mono',monospace; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.l { font-family:'IBM Plex Sans KR',sans-serif; white-space:normal; min-width:200px; }
  .sub { color:var(--muted); font-size:11px; }
  tr:nth-child(odd) td { background:rgba(14,21,36,.5); }
  .up { color:#6fdc8c; } .dn { color:#ff9b9b; }
  td.colsep { border-left:1px solid var(--line); min-width:64px; }
  td.vpcol { border-left:2px solid #3a4c78; background:rgba(121,201,158,.06); }
  .cur { color:#dfe7f6; font-weight:600; } .cur.dim { color:#5f6b85; font-weight:400; }
  td em { font-style:normal; font-size:10.5px; margin-left:3px; }
  tr.imp td { background:rgba(139,150,174,.10) !important; }
  tr.imp .cur { color:var(--muted); }
  tr.nolog td.l::after { content:' ·'; color:#5f6b85; }
  td.state { text-align:left; font-size:11px; color:#5f6b85; white-space:nowrap; }
  td.state.tiles { white-space:normal; min-width:170px; max-width:260px; line-height:1.5; }
  td.state.chg { color:#eab308; font-weight:700; }
  td.state.dim2 { color:transparent; }
  .bdt { margin-top:20px; }
  .legend { color:var(--muted); font-size:12px; margin-top:12px; line-height:1.7; }
</style>
<div class="wrap">
  <h1>🔍 ${esc(NAME)} ${esc(FAC)} ${me.score}점 — 판 전체 감사</h1>
  <div class="sub0">${date} (${esc(gameId)}) · ${ranked.length}인: ${ranked.map((id) => `${esc(canon(P[id].name))}(${esc(FACTION_KO[P[id].faction] ?? P[id].faction)}) ${P[id].score}`).join(' / ')} · ${esc(NAME)} 로그 ${aj.length}개 액션</div>

  <div class="cards">
    ${cards.map((c) => `<div class="card">${c}</div>`).join('\n    ')}
  </div>

  <div class="tblwrap">
    <table>
      <thead><tr>
        <th>R</th><th class="l">액션</th>
        <th class="colsep vpcol">VP</th><th class="colsep">C</th><th class="colsep">O</th><th class="colsep">K</th><th class="colsep">Q</th><th class="colsep">P1</th><th class="colsep">P2</th><th class="colsep">P3</th>
        <th class="colsep l">건물</th><th class="l">연구</th><th class="colsep l">기술 타일 (보유 순)</th>
      </tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
  </div>

  <div class="bdt tblwrap" style="max-width:460px">
    <table>
      <thead><tr><th class="l">점수 내역 (scoreBreakdown)</th><th>VP</th></tr></thead>
      <tbody>
        ${bdRows}
        <tr><td class="l"><b>합계 (파워수령 차감 반영)</b></td><td><b>${total}</b> (+시작 ${START_VP} = ${START_VP + total})</td></tr>
      </tbody>
    </table>
  </div>

  <p class="legend">읽는 법: 각 행 = ${esc(NAME)}의 액션 하나. 자원 칸은 <b>액션 후 보유량(±이번 액션 변동)</b> 형식 — 예: <b>4</b><em class="dn">(-3)</em>는 3을 쓰고 4가 남았다는 뜻. 변동 없는 칸은 흐리게.
    회색 〈액션 외 변동〉 행은 내 액션 사이에 생긴 변화(다른 사람 턴의 파워 leech 수락, 수익 단계 세부 등) —
    직전 액션의 '후 보유'와 다음 액션의 '전 보유'의 차이를 그대로 보여주므로, 여기 이상한 값이 있으면 버그 후보입니다.
    액션명 뒤 ' ·'는 gameLog에 대응 항목이 없어 직전 액션 후 상태를 기준으로 변동을 계산한 행(종족 자동 변환 등). 건물 열은 액션 이름으로 재구성한 M(광산)·T(교역소)·L(연구소)·P(행성연구소)·A(아카데미) 수, 노란색은 그 액션으로 바뀐 칸.</p>
</div>
`;

const outPath = opt('out') ?? path.join(REPO_ROOT, 'data', 'audit', `${file.replace(/\.json$/, '')}_${NAME}.html`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, 'utf8');
console.log(`✔ ${path.relative(REPO_ROOT, outPath)}`);
console.log(`${NAME} ${FAC} ${me.score}점 · 액션 ${aj.length} · 액션외변동 ${implicitRows} (의심 ${implicitSuspect})`);
for (const c of cards) console.log('  -', c.replace(/<[^>]+>/g, ''));
