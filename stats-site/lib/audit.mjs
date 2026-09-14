/**
 * 한 사람 한 판 점수 감사 — 데이터 산출 모듈 (scripts/playerScoreAudit.mjs 의 계산부를 공용화).
 * HTML은 만들지 않고, 게임 브라우저(reports/games.mjs)와 감사 스크립트가 같이 쓸 수 있는 순수 데이터만 돌려준다.
 *
 * 자원·VP 흐름은 gameLog의 base(직전)/snap(직후) 스냅샷 체인으로 따라간다 — actionJournal의 playerBefore/After는
 * 복합 액션에서 stale(첫 단계 시점에 굳거나 후속 효과 전에 찍힘). journal은 행의 뼈대(그 사람의 모든 액션)와
 * 연구·기술 타일 상태, gameLog에 없는 자동 액션(종족 PI 변환 등) 표시에만 쓴다.
 */
import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from './common.mjs';

/** 타일 id → 표시 라벨 (shared/gameConfig.ts 에서 id/label 쌍 추출) */
let _label = null;
export function tileLabels() {
  if (_label) return _label;
  _label = {};
  try {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'shared', 'gameConfig.ts'), 'utf8');
    for (const m of src.matchAll(/\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'/g)) _label[m[1]] = m[2];
  } catch { /* 라벨 없으면 id 그대로 */ }
  return _label;
}
export const lab = (id) => tileLabels()[id] ?? id;

/** 액션명 한글 (scripts/gameDetailLog.mjs 와 동일) */
export const ACTION_KO = {
  'Selected Faction': '종족 선택', 'Placed Starting Mine': '시작 광산 배치', 'Placed Starting Planetary Institute': '시작 행성연구소 배치',
  'Selected Bonus Tile': '보너스 타일 선택', 'Selected Bonus': '패스 · 보너스 타일 선택', 'Round Start': '라운드 시작', 'Income Order': '수입',
  'Built Mine': '광산 건설', 'Built Mine on Asteroid': '소행성 광산 건설', 'Built Mine on Proto': '원시행성 광산 건설',
  'Upgraded to Trading Station': '교역소 승급', 'Upgraded to Research Lab': '연구소 승급', 'Upgraded to Academy': '아카데미 승급',
  'Upgraded to Planetary Institute': '행성연구소 승급', 'Academy (Right)': '아카데미(우) 특수 액션', 'Advanced Research': '연구 진행',
  'Gained Tech Tile': '기술 타일 획득', 'Advanced Tech Tile': '고급 기술 타일 획득', 'Power Action': '파워 액션', 'Free Actions': '자유 행동(자원 변환)',
  'Undo Free Action': '자유 행동 취소', 'Used Tech Action': '기술 타일 액션', 'Bonus Action': '보너스 타일 액션', 'Federation': '연방 결성',
  'Federation Reward': '연방 보상', 'Placed Gaiaformer': '가이아포머 배치', 'Entered Ship': '우주선 입장', 'Final Mission': '최종 임무 채점',
  'Game Finished': '게임 종료', 'Power Burn': '파워 소각', 'Geodens Council': '기오덴 의회', 'Lost Planet (Nav 5)': '잃어버린 행성(항법 5)',
  'Terra Reward': '테라포밍 트랙 보상', 'Economy Track Reward': '경제 트랙 보상', 'Pass Round': '패스', 'Power Gained': '파워 획득(리치)',
};
export const actionKo = (a) => ACTION_KO[a] ?? a;

export const RES = [['credits', 'C'], ['ore', 'O'], ['knowledge', 'K'], ['qic', 'Q'], ['power1', 'P1'], ['power2', 'P2'], ['power3', 'P3']];
export const GKEY = { credits: 'c', ore: 'o', knowledge: 'k', qic: 'q', power1: 'p1', power2: 'p2', power3: 'p3' };
export const GK = Object.values(GKEY);
export const TRACK = [['terraforming', '삽'], ['navigation', '항'], ['artificialIntelligence', 'AI'], ['gaiaProject', '가'], ['economy', '경'], ['science', '과']];
export const researchStr = (r) => TRACK.filter(([k]) => (r?.[k] ?? 0) > 0).map(([k, s]) => `${s}${r[k]}`).join(' ');

const BUILD_DELTA = {
  'Placed Starting Mine': { M: 1 }, 'Placed Starting Planetary Institute': { P: 1 },
  'Built Mine': { M: 1 }, 'Built Mine on Asteroid': { M: 1 }, 'Built Mine on Proto': { M: 1 }, 'Eclipse: Built mine on asteroid': { M: 1 }, 'Lost Planet (Nav 5)': { M: 1 },
  'Upgraded to Trading Station': { M: -1, T: 1 }, 'Rebellion: Mine → TS': { M: -1, T: 1 },
  'Upgraded to Research Lab': { T: -1, L: 1 }, 'Twilight: TS → Research Lab': { T: -1, L: 1 },
  'Upgraded to Academy': { L: -1, A: 1 }, 'Upgraded to Planetary Institute': { T: -1, P: 1 }, 'Firaks: Downgrade': { L: -1, T: 1 },
};
export const bStr = (b) => `M${b.M}·T${b.T}·L${b.L}·P${b.P}·A${b.A}`;
const START_VP = 10;
const RESEARCH_ACTS = /Research|Tech Tile|Advanced track|Selected Faction|Placed Starting/;

/** scoreBreakdown → {항목: VP} 그룹 (finalMissionDetails 중복 제외, other는 source별, 연방 VP는 합침, 파워수령은 차감) */
export function breakdownGroups(sb = {}) {
  const sumArr = (v) => (Array.isArray(v) ? v.reduce((s, x) => s + (x.vp ?? 0), 0) : typeof v === 'number' ? v : 0);
  const groups = {};
  for (const [k, v] of Object.entries(sb)) {
    if (k === 'finalMissionDetails') continue;
    if (k === 'other' && Array.isArray(v)) {
      for (const x of v) { const src = /연방/.test(x.source) ? '연방 보상 VP' : x.source; groups[`other · ${src}`] = (groups[`other · ${src}`] ?? 0) + (x.vp ?? 0); }
    } else groups[k] = (groups[k] ?? 0) + (k === 'powerReceived' ? -Math.abs(sumArr(v)) : sumArr(v));
  }
  return groups;
}

/**
 * 감사 데이터.
 * rows: 배열 행 — 일반/자동 행 [round, action, details, flag(0 일반·1 gameLog 없음), vp, dvp, cur[7], dres[7], bStr, research, tiles[], bChg, ups, tAdded]
 *       액션 외 변동 행 [round, null, pendingAuto(0/1), 2, vp, dvp, cur[7], dres[7]]
 * cards: [{ok: true|false|null, html}] 검증 카드 7장. groups/total/bid: 점수 내역.
 */
export function auditPlayer(g, pid) {
  const me = g.players[pid];
  const aj = (g.actionJournal ?? []).filter((a) => a && a.playerId === pid).sort((a, b) => a.timestamp - b.timestamp);
  const glog = (g.gameLog ?? []).filter((e) => e && e.playerId === pid && e.base && e.snap).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const toG = (res) => Object.fromEntries(RES.map(([k]) => [GKEY[k], res?.[k] ?? 0]));
  const used = new Set();
  const matchLog = (a) => {
    let best = null, bd = 3000;
    for (const e of glog) { if (used.has(e) || e.action !== a.action) continue; const dt = Math.abs((e.timestamp ?? 0) - a.timestamp); if (dt < bd) { bd = dt; best = e; } }
    if (best) used.add(best);
    return best;
  };
  const b = { M: 0, T: 0, L: 0, P: 0, A: 0 };
  let chain = null, disp = null, prevJ = null, prevScore = START_VP, matched = 0, pendingAuto = false;
  let implicitRows = 0, implicitSuspect = 0, researchUps = 0, researchOdd = 0, tilesInside = 0;
  const rows = [];
  for (const a of aj) {
    const after = a.playerAfter ?? {};
    const e = matchLog(a);
    let cur, dres, scoreAfter, dvp;
    if (e) {
      matched++;
      if (chain) {
        const d = GK.map((k) => (e.base[k] ?? 0) - (chain[k] ?? 0));
        const dv = (e.base.vp ?? 0) - (chain.vp ?? 0);
        if (dv || d.some(Boolean)) {
          implicitRows++;
          const suspect = !pendingAuto && (dv || d.slice(0, 4).some(Boolean));
          if (suspect) implicitSuspect++;
          rows.push([a.round ?? 0, null, pendingAuto ? 1 : 0, 2, e.base.vp ?? 0, dv, GK.map((k) => e.base[k] ?? 0), d]);
        }
      }
      cur = GK.map((k) => e.snap[k] ?? 0); dres = GK.map((k) => (e.snap[k] ?? 0) - (e.base[k] ?? 0));
      scoreAfter = e.snap.vp ?? prevScore; dvp = scoreAfter - (e.base.vp ?? prevScore);
      chain = e.snap; disp = e.snap; pendingAuto = false;
    } else {
      const c = toG(after.resources); const ref = disp ?? c;
      cur = GK.map((k) => c[k] ?? 0); dres = GK.map((k) => (c[k] ?? 0) - (ref[k] ?? 0));
      scoreAfter = prevScore; dvp = 0;
      disp = c; pendingAuto = true;
    }
    const bd = BUILD_DELTA[a.action]; let bChg = 0;
    if (bd) { for (const k in bd) b[k] += bd[k]; bChg = 1; }
    const ups = TRACK.reduce((s, [k]) => s + Math.max(0, (after.research?.[k] ?? 0) - (prevJ?.research?.[k] ?? 0)), 0);
    if (ups) { researchUps += ups; if (!RESEARCH_ACTS.test(a.action) && a.round > 0) researchOdd += ups; }
    const tAdded = (after.techTiles?.length ?? 0) - (prevJ?.techTiles?.length ?? 0);
    if (tAdded > 0) tilesInside += tAdded;
    rows.push([a.round ?? 0, a.action, a.details ?? '', e ? 0 : 1, scoreAfter, dvp, cur, dres, bStr(b), researchStr(after.research), (tAdded > 0 || !prevJ) ? (after.techTiles ?? []).map(lab) : 0, bChg, ups ? 1 : 0, tAdded > 0 ? 1 : 0]);
    prevJ = after; prevScore = scoreAfter;
  }
  const finalLevels = TRACK.reduce((s, [k]) => s + (me.research?.[k] ?? 0), 0);

  const sb = me.scoreBreakdown ?? {};
  const groups = breakdownGroups(sb);
  const total = Object.values(groups).reduce((s, x) => s + x, 0);
  const bid = -(sb.other ?? []).filter((x) => x.source === '종족 비딩').reduce((s, x) => s + (x.vp ?? 0), 0);
  const lastScore = prevScore;
  const settle = (me.score ?? 0) - lastScore;
  const endItems = (sb.researchTracks ?? 0) + (sb.remainingResources ?? 0);
  const endExpected = endItems - bid;
  const mapB = { M: 0, T: 0, L: 0, P: 0, A: 0 };
  for (const t of g.map ?? []) {
    if (t.ownerId !== pid || !t.structure) continue;
    const s = t.structure;
    if (s === 'mine' || s === 'lost_planet_mine') mapB.M++; else if (s === 'trading_station') mapB.T++; else if (s === 'research_lab') mapB.L++; else if (s === 'planetary_institute') mapB.P++; else if (s === 'academy') mapB.A++;
  }
  const hasMap = Array.isArray(g.map) && g.map.length > 0;
  const cards = [
    { ok: START_VP + total === me.score, html: `시작 ${START_VP} + 내역합(파워수령 차감) = 최종 점수 <b>${START_VP}+${total} vs ${me.score}</b>` },
    bid ? { ok: true, html: `비딩 반영 <b>비딩 전 ${me.score + bid}점 − 종족 비딩 ${bid} = ${me.score}점</b>` } : { ok: null, html: `종족 비딩 없음` },
    { ok: settle === endExpected, html: `마지막 액션 로그(${lastScore}) 이후 종료 정산 증가분 <b>+${settle}</b> <span class="sub">= 연구 트랙 ${sb.researchTracks ?? 0} + 잔여 자원 ${sb.remainingResources ?? 0}${bid ? ` − 비딩 ${bid}` : ''} = ${endExpected}</span>` },
    hasMap ? { ok: bStr(b) === bStr(mapB), html: `건물 재구성 = 최종 맵 상태 <b>재구성 ${bStr(b)} vs 맵 ${bStr(mapB)}</b>` } : { ok: null, html: `건물 재구성 <b>${bStr(b)}</b> <span class="sub">(맵 저장 없는 로그 — 대조 불가)</span>` },
    { ok: researchUps === finalLevels && researchOdd === 0, html: `연구 재구성 = 최종 research <b>액션에서 ${researchUps}단계 vs 최종 ${finalLevels}단계 (${researchStr(me.research)})${researchOdd ? ` · 연구 무관 액션에서 ${researchOdd}단계` : ''}</b>` },
    { ok: tilesInside === (me.techTiles ?? []).length, html: `기술 타일 재구성 = 최종 보유 <b>${tilesInside}장 vs 실제 ${(me.techTiles ?? []).length}장</b>` },
    { ok: null, html: `액션 외 변동 구간 <b>${implicitRows}회</b> · 그중 자동 액션으로 설명 안 되는 VP·자원 변동 <b>${implicitSuspect}회</b> <span class="sub">gameLog 스냅샷 대조 ${matched}/${aj.length} 액션, 나머지 ${aj.length - matched}개는 ·표시 자동 액션</span>` },
  ];
  return { rows, cards, groups, total, bid, actions: aj.length, matched, implicitRows, implicitSuspect, startVp: START_VP };
}
