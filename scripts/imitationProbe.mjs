// 모방학습 viability PoC: 사람 actionJournal의 (결정시점 상태 → 택한 주요 액션) 매핑이
// base-rate보다 잘 예측되는지 kNN(leave-one-game-out)으로 측정. 풀 replay 불필요(playerBefore만 사용).
import fs from 'fs';
const dir = 'data/human-games';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

// 주요 전략 액션만 (반응/자동 제외: Free Actions, Power Gained, Selected Bonus, Twilight, 빈값)
const MAIN = new Set(['Built Mine','Advanced Research','Upgraded to Trading Station','Upgraded to Research Lab',
  'Federation','Gained Tech Tile','Entered Ship','Academy','Power Action','Used Tech Action','Placed Gaiaformer']);
const TRACKS = ['terraforming','navigation','artificialIntelligence','gaiaProject','economy','science'];

function feat(e) {
  const pb = e.playerBefore; if (!pb) return null;
  const r = pb.resources || {};
  const res = pb.research || {};
  return [
    (e.round||1)/6,
    (pb.score||0)/100,
    (r.ore??0)/15, (r.credits??0)/20, (r.knowledge??0)/15, (r.qic??0)/8,
    ((r.power1??0)+(r.power2??0)+(r.power3??0))/12,
    ...TRACKS.map(t => (res[t]??0)/5),
    (pb.techTiles?.length||0)/8, (pb.federations?.length||0)/3,
  ];
}

// 게임별로 샘플 수집 (leave-one-game-out 위해 게임 인덱스 보존)
const games = [];
for (const f of files) {
  let g; try { g = JSON.parse(fs.readFileSync(dir+'/'+f,'utf8')); } catch { continue; }
  const samples = [];
  for (const e of (g.actionJournal||[])) {
    const label = (e.action||'').replace(/\s*[:(].*/,'').trim();
    const norm = label === 'Built Mine' ? 'Built Mine'
      : label.startsWith('Upgraded to Trading') ? 'Upgraded to Trading Station'
      : label.startsWith('Upgraded to Research') ? 'Upgraded to Research Lab'
      : label.startsWith('Advanced Research') ? 'Advanced Research'
      : MAIN.has(label) ? label : null;
    if (!norm) continue;
    const x = feat(e); if (!x) continue;
    samples.push({ x, y: norm });
  }
  if (samples.length) games.push(samples);
}
const all = games.flat();
console.log(`주요 결정 샘플: ${all.length} (게임 ${games.length}개)`);

// base-rate: 최빈 클래스
const dist = {}; all.forEach(s => dist[s.y]=(dist[s.y]||0)+1);
const sorted = Object.entries(dist).sort((a,b)=>b[1]-a[1]);
const base = sorted[0][1]/all.length;
console.log('클래스 분포:', sorted.map(([k,v])=>k+':'+v).join(', '));
console.log(`base-rate(최빈클래스 ${sorted[0][0]}): ${(base*100).toFixed(1)}%`);

// kNN leave-one-game-out
function dist2(a,b){let s=0;for(let i=0;i<a.length;i++){const d=a[i]-b[i];s+=d*d;}return s;}
const K=15;
let correct=0, n=0;
for (let gi=0; gi<games.length; gi++) {
  const train = games.filter((_,i)=>i!==gi).flat();
  for (const q of games[gi]) {
    const nn = train.map(t=>({y:t.y,d:dist2(q.x,t.x)})).sort((a,b)=>a.d-b.d).slice(0,K);
    const vote={}; nn.forEach(o=>vote[o.y]=(vote[o.y]||0)+1);
    const pred = Object.entries(vote).sort((a,b)=>b[1]-a[1])[0][0];
    if (pred===q.y) correct++;
    n++;
  }
}
const acc = correct/n;
console.log(`\nkNN(K=${K}) leave-one-game-out 정확도: ${(acc*100).toFixed(1)}%  (n=${n})`);
console.log(`base-rate 대비 향상: ${((acc-base)*100).toFixed(1)}%p`);
console.log(acc > base + 0.08 ? '→ 신호 있음: 상태가 액션을 예측. 모방정책 빌드 정당화 가능.'
  : acc > base + 0.02 ? '→ 약한 신호. 데이터 더 필요(불확실).'
  : '→ 신호 미미: 상태→액션 학습 어려움(모방도 데이터 기아).');
