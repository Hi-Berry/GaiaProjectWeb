// 아카이브 봇 게임에서 종족별 평균 행동 지표를 뽑아, 봇이 종족 무관하게 동일 전략을 쓰는지 확인.
import fs from 'fs';
import path from 'path';
const DIR = process.argv[2] || 'data/selfplay-archive';
const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
const byFac = {};
let n = 0;
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.json'))) {
  let g; try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  for (const p of Object.values(g.players || {})) {
    const fac = p.faction; if (!fac) continue;
    const r = p.research || {};
    const a = (byFac[fac] = byFac[fac] || { c: 0, score: 0, fed: 0, tech: 0, adv: 0 });
    TRACKS.forEach(t => { a[t] = (a[t] || 0) + (r[t] ?? 0); });
    a.c++; a.score += p.score ?? 0; a.fed += (p.federations || []).length;
    a.tech += (p.techTiles || []).length;
    a.adv += (p.techTiles || []).filter(id => String(id).startsWith('adv-')).length;
    n++;
  }
}
const rows = Object.entries(byFac).sort((a, b) => b[1].score / b[1].c - a[1].score / a[1].c);
console.log(`samples: ${n}\n`);
console.log('faction'.padEnd(14), 'n'.padStart(4), 'score'.padStart(6), 'gaia'.padStart(5), 'econ'.padStart(5), 'nav'.padStart(5), 'terr'.padStart(5), 'ai'.padStart(4), 'sci'.padStart(4), 'fed'.padStart(5), 'tech'.padStart(5), 'adv'.padStart(4));
for (const [fac, a] of rows) {
  const avg = k => (a[k] / a.c);
  console.log(
    fac.padEnd(14),
    String(a.c).padStart(4),
    avg('score').toFixed(0).padStart(6),
    avg('gaiaProject').toFixed(1).padStart(5),
    avg('economy').toFixed(1).padStart(5),
    avg('navigation').toFixed(1).padStart(5),
    avg('terraforming').toFixed(1).padStart(5),
    avg('artificialIntelligence').toFixed(1).padStart(4),
    avg('science').toFixed(1).padStart(4),
    avg('fed').toFixed(1).padStart(5),
    avg('tech').toFixed(1).padStart(5),
    avg('adv').toFixed(2).padStart(4),
  );
}
