#!/usr/bin/env node
// 공유 1회성 자원(파워 액션)의 "경쟁(contention)" 통계를 게임 로그에서 추출.
// 파워 액션은 매 라운드 리셋되므로, 각 라운드에서 각 액션이 '그 라운드 안에 누군가에게 먹힐 확률'을 P로 계산.
// 출력: server/ai/contention.json  (봇이 "이 자원은 어차피 뺏긴다 → 지금 선점" 판단에 사용)
//
// 사용: node scripts/extractContention.mjs [--dir data/human-games] [--out server/ai/contention.json]
// actionJournal(전체·round 포함)을 1순위 소스로 사용. 없으면 스킵.

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; }
const DIR = arg('--dir', 'data/human-games');
const OUT = arg('--out', 'server/ai/contention.json');

// details 문자열 → 파워 액션 id (gameConfig INITIAL_POWER_ACTIONS와 일치)
function detailsToActionId(d) {
  if (!d) return null;
  if (/\+2 Ore/.test(d)) return 'gain-2-ore';
  if (/\+7 Credits/.test(d)) return 'gain-7-credits';
  if (/\+3 Knowledge/.test(d)) return 'gain-3-knowledge';
  if (/\+2 Knowledge/.test(d)) return 'gain-2-knowledge';
  if (/\+2 Power tokens/.test(d)) return 'gain-2-tokens';
  if (/\+1 Terraform/.test(d)) return 'gain-1-step';
  if (/\+2 Terraform/.test(d)) return 'gain-2-steps';
  return null;
}

const ALL_IDS = ['gain-3-knowledge', 'gain-2-steps', 'gain-2-ore', 'gain-7-credits', 'gain-2-knowledge', 'gain-1-step', 'gain-2-tokens'];

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
let gamesUsed = 0, gamesSkipped = 0;

// perRound[round][actionId] = { reached: #games that reached this round, taken: #games where action taken in this round }
const roundReached = {};      // round -> #games reached
const takenInRound = {};       // round -> actionId -> #games taken that round
// 라운드 내 '몇 번째로 먹혔나'(선점 시급도): 평균 정규화 순번(0=먼저)
const orderSum = {};           // actionId -> sum of normalized turn-position
const orderN = {};

for (const f of files) {
  let g;
  try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { gamesSkipped++; continue; }
  const aj = g.actionJournal;
  if (!Array.isArray(aj) || aj.length === 0) { gamesSkipped++; continue; }

  // 이 게임이 도달한 최대 라운드 (main 단계 기준)
  let maxRound = 0;
  for (const e of aj) if (e && e.phase === 'main' && typeof e.round === 'number' && e.round > maxRound) maxRound = e.round;
  if (maxRound < 1) { gamesSkipped++; continue; }
  gamesUsed++;

  for (let r = 1; r <= maxRound; r++) roundReached[r] = (roundReached[r] || 0) + 1;

  // 라운드별: 어떤 파워액션이 먹혔는지 (게임당 중복 제거: 한 라운드에 같은 액션은 1회만 가능)
  // + 라운드 내 먹힌 순번(timestamp 순) 추적
  const perRoundTaken = {};    // round -> Set(actionId)
  const perRoundSeq = {};      // round -> [actionId in timestamp order]
  const sorted = [...aj].filter(e => e && e.action === 'Power Action' && typeof e.round === 'number' && e.round >= 1)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  for (const e of sorted) {
    const id = detailsToActionId(e.details);
    if (!id) continue;
    const r = e.round;
    (perRoundTaken[r] = perRoundTaken[r] || new Set()).add(id);
    (perRoundSeq[r] = perRoundSeq[r] || []).push(id);
  }
  for (const r of Object.keys(perRoundTaken)) {
    takenInRound[r] = takenInRound[r] || {};
    for (const id of perRoundTaken[r]) takenInRound[r][id] = (takenInRound[r][id] || 0) + 1;
    // 순번 정규화: 그 라운드에 먹힌 파워액션 개수 대비 위치(0=가장 먼저 선점). 시급도 추정.
    const seq = perRoundSeq[r];
    seq.forEach((id, i) => {
      const norm = seq.length > 1 ? i / (seq.length - 1) : 0;
      orderSum[id] = (orderSum[id] || 0) + norm;
      orderN[id] = (orderN[id] || 0) + 1;
    });
  }
}

// 집계: byAction[id] = { perRound: {r: P(taken|reached)}, overall: 평균 P, earlyOrder: 평균 선점순번(0~1, 낮을수록 먼저) }
const byAction = {};
for (const id of ALL_IDS) {
  const perRound = {};
  let pSum = 0, pN = 0;
  for (let r = 1; r <= 6; r++) {
    const reached = roundReached[r] || 0;
    if (reached === 0) continue;
    const taken = (takenInRound[r] && takenInRound[r][id]) || 0;
    const p = taken / reached;
    perRound[r] = +p.toFixed(3);
    pSum += p; pN++;
  }
  byAction[id] = {
    perRound,
    overall: pN ? +(pSum / pN).toFixed(3) : 0,
    earlyOrder: orderN[id] ? +(orderSum[id] / orderN[id]).toFixed(3) : 1,
    n: orderN[id] || 0,
  };
}

const out = {
  meta: {
    source: DIR,
    games: gamesUsed,
    skipped: gamesSkipped,
    note: 'contention = P(action taken during a round | game reached that round). earlyOrder 0=선점 먼저(시급), 1=늦게.',
  },
  byAction,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

// 콘솔 리포트
console.log(`\n게임 ${gamesUsed}개 사용 (스킵 ${gamesSkipped}). 라운드 도달: ${JSON.stringify(roundReached)}\n`);
console.log('파워 액션 경쟁도 (overall P, 라운드별, 선점순번):');
const ranked = ALL_IDS.map(id => [id, byAction[id]]).sort((a, b) => b[1].overall - a[1].overall);
for (const [id, d] of ranked) {
  const pr = [1, 2, 3, 4, 5, 6].map(r => (d.perRound[r] != null ? d.perRound[r].toFixed(2) : '  - ')).join(' ');
  console.log(`  ${id.padEnd(18)} overall=${d.overall.toFixed(2)}  R[${pr}]  early=${d.earlyOrder.toFixed(2)} (n=${d.n})`);
}
console.log(`\n→ ${OUT} 작성 완료`);
