// per-candidate 배치 랭커 v3 — v2의 8 공간피처 + '연방 잠재력' 4피처.
// 동기(사용자 2026-08-01): 봇 연방 1.66 vs 사람 4.55. 부검 결론은 "총 파워는 충분한데 7파워 군집이 하나뿐"
// (예: 7/5/4 분산) = 배치 단계에서 군집을 설계 못 함. 사람의 배치에는 그 설계가 들어있다고 보고 학습으로 추출.
//
// 추가 피처(모두 후보 타일에 광산 1개를 놓았다고 가정한 '사후' 값):
//   f8  clusterPow/7   : 인접(dist1)으로 연결되는 내 건물 파워합 (새 광산 1 포함), 7로 정규화·클램프
//   f9  reaches7       : 그 군집 파워가 7 이상이면 1 (연방 즉시 성립 가능)
//   f10 sat2Pow/7      : dist≤2(위성 1개로 연결 가능) 범위까지 포함한 파워합 — 위성 브리징 잠재력
// (gapTo7은 clusterPow와 선형종속이라 제외 — 넣으면 최적화가 퇴화해 val 63.1%→56.7%로 하락했음)
// 건물 파워: mine 1 / TS·lab 2 / PI·academy 3 (게임 규칙과 동일, 종족 예외는 학습에선 무시)
import fs from 'fs';
const dir = 'data/human-games'; const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
const NONPLANET = new Set(['space', 'deep_space', 'transdim', 'lost_fleet_ship']);
const isPlanet = t => !!t.type && !NONPLANET.has(t.type) && !String(t.type).startsWith('ship_');
const powOf = s => s === 'gaiaformer' ? 0 : s === 'mine' ? 1 : (s === 'trading_station' || s === 'research_lab') ? 2 : (s === 'planetary_institute' || s === 'academy') ? 3 : 1;

/** 후보 타일에 광산을 놓았을 때 dist1로 연결되는 군집의 파워합 (BFS) */
function clusterPowerAt(tile, myTiles, radius) {
  // myTiles: [{id,q,r,pow}] — 내 건물들. tile 기준으로 radius 이내를 이어붙이며 BFS
  const seen = new Set();
  let total = 1; // 새로 놓는 광산
  const queue = [tile];
  while (queue.length) {
    const cur = queue.shift();
    for (const m of myTiles) {
      if (seen.has(m.id)) continue;
      if (dist(cur, m) <= radius) { seen.add(m.id); total += m.pow; queue.push(m); }
    }
  }
  return total;
}

const decisions = [];
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')) } catch { continue }
  if (!g.map || !g.actionJournal) continue;
  const geom = new Map(); for (const t of g.map) if (t.q != null) geom.set(t.id, { id: t.id, q: t.q, r: t.r, type: t.type, sector: t.sector });
  const ships = [...geom.values()].filter(t => String(t.type).startsWith('ship_'));
  const protos = [...geom.values()].filter(t => t.type === 'proto' || t.type === 'asteroid');
  const owner = new Map();   // tileId -> pid
  const struct = new Map();  // tileId -> structure
  for (const e of g.actionJournal) {
    const pid = e.playerId, act = e.action || '', tid = e.tileId;
    if (Array.isArray(e.candidates) && e.candidates.length) {
      const cands = e.candidates.filter(c => c.type === 'build_mine' && c.tileId && geom.has(c.tileId));
      const chosen = cands.findIndex(c => c.tileId === tid);
      if (cands.length >= 2 && chosen >= 0) {
        const mine = [...owner.entries()].filter(([, o]) => o === pid).map(([id]) => geom.get(id)).filter(Boolean);
        const opp = [...owner.entries()].filter(([, o]) => o !== pid).map(([id]) => geom.get(id)).filter(Boolean);
        if (mine.length === 0) continue;
        const myPow = mine.map(t => ({ ...t, pow: powOf(struct.get(t.id)) }));
        const ownedIds = new Set(owner.keys());
        const empties = [...geom.values()].filter(t => isPlanet(t) && !ownedIds.has(t.id));
        const myTypes = new Set(mine.map(t => t.type)), mySectors = new Set(mine.map(t => t.sector));
        const md = (arr, tile) => arr.length ? Math.min(...arr.map(s => dist(s, tile))) : 9;
        const feats = cands.map(c => {
          const tile = geom.get(c.tileId);
          const adjEmpty = empties.filter(t => t.id !== tile.id && dist(t, tile) === 1).length;
          const adjOwn = mine.filter(m => dist(m, tile) === 1).length;
          const cPow = clusterPowerAt(tile, myPow, 1);
          const sPow = clusterPowerAt(tile, myPow, 2);
          return [
            Math.min(md(mine, tile), 9) / 9, Math.min(md(opp, tile), 9) / 9, Math.min(md(ships, tile), 9) / 9, Math.min(md(protos, tile), 9) / 9,
            adjEmpty / 6, adjOwn / 6, mySectors.has(tile.sector) ? 0 : 1, myTypes.has(tile.type) ? 0 : 1,
            Math.min(cPow, 7) / 7, cPow >= 7 ? 1 : 0, Math.min(sPow, 7) / 7,
          ];
        });
        decisions.push({ cands: feats, y: chosen });
      }
    }
    // 소유 추적은 v2와 완전히 동일하게 유지(기준선 정합) — 가이아포머 포함, 업글은 미소유일 때만 owner 설정.
    // struct는 파워 계산용으로만 별도 기록(가이아포머=파워 0).
    if (/Built Mine|Placed Starting Mine|Placed Mine|Placed Gaiaformer/i.test(act)) {
      if (tid) { owner.set(tid, pid); struct.set(tid, /Gaiaformer/i.test(act) ? 'gaiaformer' : 'mine'); }
    } else if (/Upgraded to|Academy/i.test(act)) {
      if (tid && !owner.has(tid)) owner.set(tid, pid);
      if (tid) {
        if (/Trading Station/i.test(act)) struct.set(tid, 'trading_station');
        else if (/Research Lab/i.test(act)) struct.set(tid, 'research_lab');
        else if (/Planetary/i.test(act)) struct.set(tid, 'planetary_institute');
        else if (/Academy/i.test(act)) struct.set(tid, 'academy');
      }
    }
  }
}
const D = 11;
console.log('build_mine 배치 결정 ' + decisions.length + ', 후보수평균 ' + (decisions.reduce((s, d) => s + d.cands.length, 0) / decisions.length).toFixed(1));
const tr = [], va = []; decisions.forEach((d, i) => (i % 7 === 0 ? va : tr).push(d));
console.log('train ' + tr.length + ' / val ' + va.length);

let w = new Float64Array(D);
const scores = d => d.cands.map(fv => { let s = 0; for (let k = 0; k < D; k++) s += w[k] * fv[k]; return s; });
const softmax = ss => { const mx = Math.max(...ss); const ex = ss.map(s => Math.exp(s - mx)); const Z = ex.reduce((a, b) => a + b, 0); return ex.map(x => x / Z); };
const m = new Float64Array(D), v = new Float64Array(D); const b1 = 0.9, b2 = 0.999, eps = 1e-8; let t = 0;
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let ep = 0; ep < (Number(process.env.EPOCHS)||150); ep++) {
  const ord = tr.map((_, i) => i); for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[ord[i], ord[j]] = [ord[j], ord[i]]; }
  for (const idx of ord) {
    const d = tr[idx]; const p = softmax(scores(d)); t++;
    const gr = new Float64Array(D);
    for (let c = 0; c < d.cands.length; c++) { const coef = p[c] - (c === d.y ? 1 : 0); const fv = d.cands[c]; for (let k = 0; k < D; k++) gr[k] += coef * fv[k]; }
    const lrt = (Number(process.env.LR)||0.05) * Math.sqrt(1 - Math.pow(b2, t)) / (1 - Math.pow(b1, t));
    for (let k = 0; k < D; k++) { const g2 = gr[k] + 1e-4 * w[k]; m[k] = b1 * m[k] + (1 - b1) * g2; v[k] = b2 * v[k] + (1 - b2) * g2 * g2; w[k] -= lrt * m[k] / (Math.sqrt(v[k]) + eps); }
  }
}
const ev = set => { let c1 = 0, rb = 0; for (const d of set) { const p = softmax(scores(d)); let bi = 0; for (let c = 1; c < p.length; c++) if (p[c] > p[bi]) bi = c; if (bi === d.y) c1++; rb += 1 / d.cands.length; } return { t1: c1 / set.length, rand: rb / set.length }; };
const V = ev(va), T = ev(tr);
console.log(`val top1 ${(V.t1 * 100).toFixed(1)}% (무작위 ${(V.rand * 100).toFixed(1)}%) | train ${(T.t1 * 100).toFixed(1)}%`);
const FEATS = ['dOwn', 'dOpp', 'dShip', 'dProto', 'adjEmpty', 'adjOwn', 'newSector', 'newType', 'clusterPow', 'reaches7', 'sat2Pow'];
console.log('가중치:'); FEATS.forEach((n, i) => console.log(`  ${n.padEnd(11)} ${w[i].toFixed(3)}`));
// v2 스케일 정합: bot.ts가 ×60을 곱하므로 max|w|를 v2와 같은 3.57 대역으로 맞춘다
const mx = Math.max(...[...w].map(Math.abs));
const scaled = [...w].map(x => x * (3.57 / mx));
fs.writeFileSync('server/ai/placementPolicyV3.json', JSON.stringify({
  version: 3, features: FEATS, weights: scaled, rawWeights: [...w],
  valTop1: V.t1, randomBaseline: V.rand, decisions: decisions.length,
  note: 'v2 8피처 + 연방잠재력 3피처(clusterPow/reaches7/sat2Pow). 스케일: max|w|=3.57로 v2 정합(bot.ts ×60).',
}, null, 1));
console.log('저장: server/ai/placementPolicyV3.json');
