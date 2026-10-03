// 게임시간 점유/판당 사용 분 — 뱃지 정의를 모르는 상태에서 (마루 19.7%/17.1분, 시리 18.0%/16.1분, 지수홍 18.8%/17.7분)에 맞는 산식 탐색
import fs from 'fs';
const d = 'data/human-games/';
const names = ['마루', '시리', '지수홍', '아이페르'];
const mainOnly = (e) => e.phase === 'main' && e.round >= 1;
const variants = {
  'main cap120 /span': { f: mainOnly, cap: 120, den: 'span' },
  'main cap300 /span': { f: mainOnly, cap: 300, den: 'span' },
  'main cap600 /span': { f: mainOnly, cap: 600, den: 'span' },
  'main cap900 /span': { f: mainOnly, cap: 900, den: 'span' },
  'main nocap /span': { f: mainOnly, cap: 1e9, den: 'span' },
  'main cap300 /sum': { f: mainOnly, cap: 300, den: 'sum' },
  'all cap120 /span': { f: () => true, cap: 120, den: 'span' },
  'all cap300 /span': { f: () => true, cap: 300, den: 'span' },
  'all cap600 /span': { f: () => true, cap: 600, den: 'span' },
  'all nocap /span': { f: () => true, cap: 1e9, den: 'span' },
};
const R = {};
for (const k in variants) R[k] = {};
let ng = 0;
for (const f of fs.readdirSync(d).filter((f) => f.endsWith('.json'))) {
  let g;
  try { g = JSON.parse(fs.readFileSync(d + f, 'utf8')); } catch { continue; }
  const ps = Object.values(g.players || {});
  if (ps.length !== 4 || (g.botPlayerIds || []).length > 0 || ps.some((p) => /^AI Bot/.test(p.name))) continue;
  const L = (g.fullGameLog || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  if (L.length < 50) continue;
  ng++;
  const span = (L[L.length - 1].timestamp - L[0].timestamp) / 1000;
  for (const [k, v] of Object.entries(variants)) {
    const per = {};
    let sum = 0;
    for (let i = 1; i < L.length; i++) {
      const e = L[i];
      if (!v.f(e)) continue;
      const gap = (e.timestamp - L[i - 1].timestamp) / 1000;
      if (gap < 0 || gap > v.cap) continue;
      per[e.playerName] = (per[e.playerName] || 0) + gap;
      sum += gap;
    }
    for (const [nm, t] of Object.entries(per)) {
      const r = (R[k][nm] ??= { n: 0, min: 0, share: 0 });
      r.n++;
      r.min += t / 60;
      r.share += t / (v.den === 'span' ? span : sum);
    }
  }
}
console.log('games', ng);
for (const k in R) {
  console.log(k);
  for (const nm of names) {
    const r = R[k][nm];
    if (r) console.log('  ', nm, r.n, '판당', (r.min / r.n).toFixed(1), '분', ((100 * r.share) / r.n).toFixed(1) + '%');
  }
}
