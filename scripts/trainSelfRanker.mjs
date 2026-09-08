// [자가대국 고득점 모방 랭커] 2026-09-08. 데이터: data/selfplay-journal.jsonl(AI_SELF_JOURNAL=1 자가대국의 봇 결정: 후보+선택+상태)
// + logs/game_<id>_final_state.json(최종 점수·맵). 사람 모방과 달리 **봇 자신의 상태 분포** 위에서 학습하므로 공변량 이동이 없다.
// 핵심 질문(신호 게이트, h2h 전에 답할 것): "고득점 좌석의 결정이 저득점 좌석의 결정과 상태-조건부로 구분되는가?"
//   TOP(게임 내 1등 좌석) 결정으로 학습한 랭커가 홀드아웃 TOP 결정을 BOTTOM(꼴등 좌석) 결정보다 잘 맞추고, BOTTOM 학습 랭커는 반대면
//   정책 차이가 존재. 둘이 같으면 봇은 상태-조건부로 같은 정책이고 점수 차는 상황(맵·종족·상대) 탓 → 모방으로 얻을 게 없음.
// 실행: node scripts/trainSelfRanker.mjs [--save]   (env: SELF_EPOCHS=30 SELF_MIN_REL=15)
import fs from 'fs';
import path from 'path';
import { TYPES, TRACKS, SHIPS, TARGETS, RES, RES_NORM, D, feat, softmax, trainSoftmax, scoreW } from './lib/rankerFeat.mjs';

const EPOCHS = Number(process.env.SELF_EPOCHS || 30);
const MIN_REL = Number(process.env.SELF_MIN_REL || 15); // TOP = 게임 평균 대비 +15 이상, BOTTOM = −15 이하
const SAVE = process.argv.includes('--save');

const lines = fs.readFileSync('data/selfplay-journal.jsonl', 'utf8').split('\n').filter(Boolean);
const recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const games = new Map(); // gameId -> {geom, scores:{pid:score}, mean}
for (const g of new Set(recs.map(r => r.g))) {
  const f = path.join('logs', `game_${g}_final_state.json`);
  let st; try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  if ((st.roundNumber ?? 0) < 6) continue;
  const geom = new Map(); for (const t of st.map || []) if (t.q != null) geom.set(t.id, { q: t.q, r: t.r, type: t.type });
  const scores = {}; for (const [pid, p] of Object.entries(st.players || {})) scores[pid] = p.score ?? 0;
  const vals = Object.values(scores); if (vals.length < 2) continue;
  games.set(g, { geom, scores, mean: vals.reduce((a, b) => a + b, 0) / vals.length, max: Math.max(...vals), min: Math.min(...vals) });
}
const decisions = [];
let gi = 0; const gIndex = new Map();
for (const r of recs) {
  const G = games.get(r.g); if (!G) continue;
  if (!gIndex.has(r.g)) gIndex.set(r.g, gi++);
  const score = G.scores[r.p]; if (score == null) continue;
  const rel = score - G.mean;
  const mine = (r.my || []).map(id => G.geom.get(id)).filter(Boolean);
  const ctx = { geom: G.geom, mine, res: r.rs || {}, r: r.res || {}, round: r.r || 1, nEntered: r.ne || 0 };
  const cands = r.cands.map(c => feat(c, ctx));
  decisions.push({ cands, y: r.y, rel, score, isTop: score === G.max, isBot: score === G.min, round: r.r, game: gIndex.get(r.g), type: r.cands[r.y].type });
}
console.log(`저널 ${recs.length}줄 · 완주 게임 ${games.size} · 결정 ${decisions.length} · 후보평균 ${(decisions.reduce((s, d) => s + d.cands.length, 0) / decisions.length).toFixed(1)}`);
const va = decisions.filter(d => d.game % 5 === 0), tr = decisions.filter(d => d.game % 5 !== 0);
const TOPtr = tr.filter(d => d.rel >= MIN_REL), BOTtr = tr.filter(d => d.rel <= -MIN_REL);
const TOPva = va.filter(d => d.rel >= MIN_REL), BOTva = va.filter(d => d.rel <= -MIN_REL);
console.log(`train TOP(rel>=+${MIN_REL}) ${TOPtr.length} · BOTTOM(rel<=-${MIN_REL}) ${BOTtr.length} · ALL ${tr.length} | val TOP ${TOPva.length} · BOTTOM ${BOTva.length} · ALL ${va.length}`);

const top1 = (W, set) => { let h = 0; for (const d of set) { const p = softmax(scoreW(W, d)); let bi = 0; for (let c = 1; c < p.length; c++) if (p[c] > p[bi]) bi = c; if (bi === d.y) h++; } return set.length ? h / set.length : NaN; };
const pct = x => (x * 100).toFixed(1) + '%';
const t0 = Date.now();
const wAll = trainSoftmax(tr, EPOCHS), wTop = trainSoftmax(TOPtr, EPOCHS), wBot = trainSoftmax(BOTtr, EPOCHS);
console.log(`학습 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log('── 신호 게이트(홀드아웃 top-1) ──');
console.log(`ALL 랭커 : TOP결정 ${pct(top1(wAll, TOPva))} · BOTTOM결정 ${pct(top1(wAll, BOTva))} · 전체 ${pct(top1(wAll, va))}  (봇 자기 정책 예측 가능도)`);
console.log(`TOP 랭커 : TOP결정 ${pct(top1(wTop, TOPva))} · BOTTOM결정 ${pct(top1(wTop, BOTva))}`);
console.log(`BOT 랭커 : TOP결정 ${pct(top1(wBot, TOPva))} · BOTTOM결정 ${pct(top1(wBot, BOTva))}`);
// 정책 불일치율: 같은 상태에서 TOP·BOTTOM 랭커의 top-1이 다른 비율 + 어떤 타입으로 갈리는가
let diff = 0; const shift = {};
for (const d of va) { const a = scoreW(wTop, d), b = scoreW(wBot, d); const ia = a.indexOf(Math.max(...a)), ib = b.indexOf(Math.max(...b)); if (ia !== ib) { diff++; const key = `${TYPES[d.cands[ib].findIndex((x, i) => i < 15 && x === 1)]}→${TYPES[d.cands[ia].findIndex((x, i) => i < 15 && x === 1)]}`; shift[key] = (shift[key] || 0) + 1; } }
console.log(`TOP vs BOTTOM 랭커 top-1 불일치: ${pct(diff / va.length)} | 주요 이동(BOTTOM→TOP): ${Object.entries(shift).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + ' ' + v).join(' | ')}`);
// 라운드별 타입 분포 차이(TOP vs BOTTOM 실제 선택)
const dist = set => { const o = {}; for (const d of set) o[d.type] = (o[d.type] || 0) + 1 / set.length; return o; };
for (const rnd of [1, 2, 3, 4, 5, 6]) {
  const T = dist(decisions.filter(d => d.rel >= MIN_REL && d.round === rnd)), B = dist(decisions.filter(d => d.rel <= -MIN_REL && d.round === rnd));
  const keys = [...new Set([...Object.keys(T), ...Object.keys(B)])].map(k => ({ k, d: (T[k] || 0) - (B[k] || 0) })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 4);
  console.log(`R${rnd} 선택분포 TOP−BOTTOM: ` + keys.map(x => `${x.k} ${(x.d * 100).toFixed(1).padStart(5)}pp`).join(' | '));
}
if (SAVE) {
  const wFinal = trainSoftmax(decisions.filter(d => d.rel >= MIN_REL), EPOCHS);
  fs.writeFileSync('server/ai/selfRanker.json', JSON.stringify({ version: 1, maxRound: 6, featDim: D, types: TYPES, tracks: TRACKS, ships: SHIPS, targets: TARGETS, res: RES, resNorm: RES_NORM, w: [...wFinal] }));
  console.log('저장: server/ai/selfRanker.json (TOP 좌석 전 데이터 재학습)');
}
