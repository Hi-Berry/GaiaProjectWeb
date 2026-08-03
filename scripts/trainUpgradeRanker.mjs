// 업그레이드 전용 per-candidate 랭커 — 통합 랭커가 이 타입을 val 12%로 거의 못 맞히는데(후보 61,357개로 최대
// 데이터) 피처가 '타입 one-hot + 타일 공간'뿐이라 "어느 건물을 무엇으로 올릴지"의 근거가 하나도 없었기 때문.
// 사용자(2026-08-01): "지금 로그에 모든 정보가 있잖아" → 배포 없이 기존 로그만으로 캐낼 수 있는 최대 광맥.
//
// 업그레이드 전용 피처(14):
//  0-3  target one-hot: TS / lab / PI / academy(좌우 합침)
//  4    fromMine        : 광산→TS 인가 (1) — 확장 파이프라인
//  5    powerGain/2     : 이 업글로 늘어나는 건물 파워 (mine1→TS2=+1, TS2→lab2=0, TS2→PI3=+1, lab2→aca3=+1)
//  6    clusterPow/7    : 업글 후 이 타일이 속한 dist1 연결 군집 파워 (연방 성립선 7)
//  7    reaches7        : 그 군집이 7 이상이 되면 1 (연방 즉시 가능)
//  8    adjOpp/3        : 인접 상대 건물 수 (파워 누수 제공 = 사람이 싫어하는 요소이자 TS 할인 요소)
//  9    dOwn/9          : 내 다른 건물까지 최소 거리
//  10   ownedSame/4     : 같은 종류를 이미 몇 개 보유 (체감효용)
//  11   round/6
//  12   givesTech       : 연구소·아카데미 = 기술타일 트리거
//  13   isFedMember     : 이미 연방에 속한 타일인가 (연방 밖 확장 vs 안쪽 강화 구분)
import fs from 'fs';
const dir = 'data/human-games'; const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
const powOf = s => s === 'gaiaformer' ? 0 : s === 'mine' ? 1 : (s === 'trading_station' || s === 'research_lab') ? 2 : (s === 'planetary_institute' || s === 'academy') ? 3 : 1;
const normTarget = t => String(t || '').startsWith('academy') ? 'academy' : String(t || '');
const TARGETS = ['trading_station', 'research_lab', 'planetary_institute', 'academy'];

function clusterPowerAfter(tile, myTiles, upgradedPow) {
  const seen = new Set([tile.id]);
  let total = upgradedPow;
  const queue = [tile];
  while (queue.length) {
    const cur = queue.shift();
    for (const m of myTiles) {
      if (seen.has(m.id)) continue;
      if (dist(cur, m) <= 1) { seen.add(m.id); total += m.pow; queue.push(m); }
    }
  }
  return total;
}

const decisions = [];
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')) } catch { continue }
  if (!g.map || !g.actionJournal) continue;
  const geom = new Map(); for (const t of g.map) if (t.q != null) geom.set(t.id, { id: t.id, q: t.q, r: t.r, type: t.type, sector: t.sector });
  const owner = new Map(); const struct = new Map();
  for (const e of g.actionJournal) {
    const pid = e.playerId, act = e.action || '', tid = e.tileId;
    const cands = (e.candidates || []).filter(c => c.type === 'upgrade_structure' && c.tileId && geom.has(c.tileId));
    if (cands.length >= 2) {
      // 실제로 고른 업그레이드 찾기: 로그 액션명 → target, tileId 일치
      let takenTarget = null;
      if (/^Upgraded to Trading Station/.test(act)) takenTarget = 'trading_station';
      else if (/^Upgraded to Research Lab/.test(act)) takenTarget = 'research_lab';
      else if (/^Upgraded to Planetary/.test(act)) takenTarget = 'planetary_institute';
      else if (/^Upgraded to Academy|Academy/.test(act)) takenTarget = 'academy';
      const y = takenTarget == null ? -1
        : cands.findIndex(c => c.tileId === tid && normTarget(c.target) === takenTarget);
      if (y >= 0) {
        const myTiles = [...owner.entries()].filter(([, o]) => o === pid)
          .map(([id]) => ({ ...geom.get(id), pow: powOf(struct.get(id)), st: struct.get(id) })).filter(t => t.id);
        const oppTiles = [...owner.entries()].filter(([, o]) => o !== pid).map(([id]) => geom.get(id)).filter(Boolean);
        const ownedCount = {}; for (const m of myTiles) ownedCount[m.st] = (ownedCount[m.st] || 0) + 1;
        const feats = cands.map(c => {
          const tile = geom.get(c.tileId);
          const tgt = normTarget(c.target);
          const fromSt = struct.get(c.tileId);
          const newPow = tgt === 'trading_station' || tgt === 'research_lab' ? 2 : 3;
          const powerGain = Math.max(0, newPow - powOf(fromSt));
          const others = myTiles.filter(m => m.id !== c.tileId);
          const cPow = clusterPowerAfter(tile, others, newPow);
          const adjOpp = oppTiles.filter(o => dist(o, tile) === 1).length;
          const dOwn = others.length ? Math.min(...others.map(m => dist(m, tile))) : 9;
          const f = new Array(14).fill(0);
          const ti = TARGETS.indexOf(tgt); if (ti >= 0) f[ti] = 1;
          f[4] = fromSt === 'mine' ? 1 : 0;
          f[5] = powerGain / 2;
          f[6] = Math.min(cPow, 7) / 7;
          f[7] = cPow >= 7 ? 1 : 0;
          f[8] = Math.min(adjOpp, 3) / 3;
          f[9] = Math.min(dOwn, 9) / 9;
          f[10] = Math.min(ownedCount[tgt === 'academy' ? 'academy' : tgt] || 0, 4) / 4;
          f[11] = (e.round || 1) / 6;
          f[12] = (tgt === 'research_lab' || tgt === 'academy') ? 1 : 0;
          f[13] = 0; // 연방 소속 여부는 로그에 없어 0 고정(자리 확보 — 추후 fed hex 기록되면 채움)
          return f;
        });
        decisions.push({ cands: feats, y });
      }
    }
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
const D = 14;
console.log('업그레이드 결정 ' + decisions.length + ', 후보수평균 ' + (decisions.reduce((s, d) => s + d.cands.length, 0) / decisions.length).toFixed(1));
const tr = [], va = []; decisions.forEach((d, i) => (i % 7 === 0 ? va : tr).push(d));
let w = new Float64Array(D);
const scores = d => d.cands.map(fv => { let s = 0; for (let k = 0; k < D; k++) s += w[k] * fv[k]; return s; });
const softmax = ss => { const mx = Math.max(...ss); const ex = ss.map(s => Math.exp(s - mx)); const Z = ex.reduce((a, b) => a + b, 0); return ex.map(x => x / Z); };
const m = new Float64Array(D), v = new Float64Array(D); const b1 = 0.9, b2 = 0.999, eps = 1e-8; let t = 0;
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let ep = 0; ep < 150; ep++) {
  const ord = tr.map((_, i) => i); for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1));[ord[i], ord[j]] = [ord[j], ord[i]]; }
  for (const idx of ord) {
    const d = tr[idx]; const p = softmax(scores(d)); t++;
    const gr = new Float64Array(D);
    for (let c = 0; c < d.cands.length; c++) { const coef = p[c] - (c === d.y ? 1 : 0); const fv = d.cands[c]; for (let k = 0; k < D; k++) gr[k] += coef * fv[k]; }
    const lrt = 0.05 * Math.sqrt(1 - Math.pow(b2, t)) / (1 - Math.pow(b1, t));
    for (let k = 0; k < D; k++) { const g2 = gr[k] + 1e-4 * w[k]; m[k] = b1 * m[k] + (1 - b1) * g2; v[k] = b2 * v[k] + (1 - b2) * g2 * g2; w[k] -= lrt * m[k] / (Math.sqrt(v[k]) + eps); }
  }
}
const ev = set => { let c1 = 0, rb = 0; for (const d of set) { const p = softmax(scores(d)); let bi = 0; for (let c = 1; c < p.length; c++) if (p[c] > p[bi]) bi = c; if (bi === d.y) c1++; rb += 1 / d.cands.length; } return { t1: c1 / set.length, rand: rb / set.length }; };
const V = ev(va), T = ev(tr);
console.log(`train ${tr.length} val ${va.length} | val top1 ${(V.t1 * 100).toFixed(1)}% (무작위 ${(V.rand * 100).toFixed(1)}%) | train ${(T.t1 * 100).toFixed(1)}%`);
const FEATS = ['tgtTS', 'tgtLab', 'tgtPI', 'tgtAca', 'fromMine', 'powerGain', 'clusterPow', 'reaches7', 'adjOpp', 'dOwn', 'ownedSame', 'round', 'givesTech', 'isFedMember'];
console.log('가중치:'); FEATS.forEach((n, i) => console.log(`  ${n.padEnd(11)} ${w[i].toFixed(3)}`));
fs.writeFileSync('server/ai/upgradeRanker.json', JSON.stringify({
  version: 1, features: FEATS, weights: [...w], valTop1: V.t1, randomBaseline: V.rand, decisions: decisions.length,
  note: '업그레이드 전용 랭커. 통합 랭커(candRankerAll v2)의 이 타입 val 12% 대체용.',
}, null, 1));
console.log('저장: server/ai/upgradeRanker.json');
