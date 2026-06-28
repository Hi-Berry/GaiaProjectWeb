// 모방학습 맵-피처 viability probe.
// imitationProbe.mjs(스칼라 only)의 후속: fullGameLog를 시간순 재생해 *결정시점 보드*를 복원하고,
// 공간 피처(클러스터/확장여지/우주선·proto·상대 거리)를 추가했을 때 kNN 정확도가 더 오르는지 측정.
// 비교: 같은 샘플·같은 fold에서 (A) 스칼라 only  vs  (B) 스칼라+맵.  맵게임만 사용.
// 판정: 메모리 기준 base-rate 대비 +8%p 넘으면 정책망 풀빌드 정당화. 그리고 B−A(맵 순효과)가 핵심.
import fs from 'fs';
const dir = 'data/human-games';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

const MAIN = new Set(['Built Mine','Advanced Research','Upgraded to Trading Station','Upgraded to Research Lab',
  'Federation','Gained Tech Tile','Entered Ship','Academy','Power Action','Used Tech Action','Placed Gaiaformer']);
const TRACKS = ['terraforming','navigation','artificialIntelligence','gaiaProject','economy','science'];
const NONPLANET = new Set(['space','deep_space','transdim','lost_fleet_ship']);
const HEX = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
const dist = (a,b) => (Math.abs(a.q-b.q) + Math.abs(a.q+a.r-b.q-b.r) + Math.abs(a.r-b.r))/2;
const isShip = t => (t.type||'').startsWith('ship_');
const isProto = t => t.type==='proto' || t.type==='asteroid';
const isPlanet = t => t.type && !NONPLANET.has(t.type) && !isShip(t);
const spow = s => (s==='planetary_institute'||s==='academy')?3 : (s==='trading_station'||s==='research_lab')?2 : (s==='mine'||s==='lost_planet_mine')?1 : 0;

// 스칼라 피처 (imitationProbe.mjs와 동일)
function baseFeat(e){
  const pb = e.playerBefore; if (!pb) return null;
  const r = pb.resources||{}, res = pb.research||{};
  return [(e.round||1)/6,(pb.score||0)/100,(r.ore??0)/15,(r.credits??0)/20,(r.knowledge??0)/15,(r.qic??0)/8,
    ((r.power1??0)+(r.power2??0)+(r.power3??0))/12,...TRACKS.map(t=>(res[t]??0)/5),
    (pb.techTiles?.length||0)/8,(pb.federations?.length||0)/3];
}

// fullGameLog 한 이벤트를 보드(owner/struct)에 적용
function applyEvent(owner, struct, e){
  const tid = e.tileId; if (!tid) return;
  const a = e.action||'';
  if (/Placed Starting Mine|Built Mine|Placed Mine/i.test(a)) { owner[tid]=e.playerId; struct[tid]='mine'; }
  else if (/Upgraded to Trading/i.test(a)) { owner[tid]=e.playerId; struct[tid]='trading_station'; }
  else if (/Upgraded to Research Lab/i.test(a)) { owner[tid]=e.playerId; struct[tid]='research_lab'; }
  else if (/Academy/i.test(a)) { owner[tid]=e.playerId; struct[tid]='academy'; }
  else if (/Planetary Institute/i.test(a)) { owner[tid]=e.playerId; struct[tid]='planetary_institute'; }
}

// 결정시점 보드(owner/struct)에서 deciding player(pid)의 공간 피처
function mapFeat(geom, owner, struct, pid){
  const tiles = [...geom.values()];
  const mine = tiles.filter(t => owner[t.id]===pid && isPlanet(t));
  if (!mine.length) return new Array(11).fill(0);
  const empties = tiles.filter(t => isPlanet(t) && !owner[t.id]);
  const ships = tiles.filter(isShip);
  const protos = tiles.filter(isProto);
  const opp = tiles.filter(t => owner[t.id] && owner[t.id]!==pid);
  const minTo = arr => arr.length ? Math.min(...arr.map(s=>Math.min(...mine.map(m=>dist(m,s))))) : 9;
  // 클러스터(헥스 인접 연결성분)
  const key = t => t.q+','+t.r;
  const setMine = new Set(mine.map(key));
  const byCoord = new Map(mine.map(t=>[key(t),t]));
  const seen = new Set(); let nClusters=0, maxPower=0;
  for (const m of mine){
    if (seen.has(key(m))) continue;
    nClusters++; let power=0; const stack=[m];
    while (stack.length){ const c=stack.pop(); const ck=key(c); if(seen.has(ck))continue; seen.add(ck);
      power += spow(struct[c.id]);
      for (const [dq,dr] of HEX){ const nk=(c.q+dq)+','+(c.r+dr); if(setMine.has(nk)&&!seen.has(nk)) stack.push(byCoord.get(nk)); } }
    if (power>maxPower) maxPower=power;
  }
  const within = d => empties.filter(t => mine.some(m=>dist(m,t)<=d)).length;
  const sectors = new Set(mine.map(t=>t.sector).filter(x=>x!=null));
  const types = new Set(mine.map(t=>t.type));
  return [
    mine.length/12, nClusters/6, maxPower/10,
    Math.min(minTo(empties),9)/9, within(2)/10, within(3)/15,
    Math.min(minTo(ships),9)/9, Math.min(minTo(protos),9)/9, Math.min(minTo(opp),9)/9,
    sectors.size/8, types.size/7,
  ];
}

const games = [];  // 각 게임: { samples:[{base,map,y}] }
let mapGames=0;
for (const f of files){
  let g; try { g = JSON.parse(fs.readFileSync(dir+'/'+f,'utf8')); } catch { continue; }
  if (!Array.isArray(g.map) || !g.map.length) continue;        // 맵 게임만
  if (!Array.isArray(g.fullGameLog) || !g.fullGameLog.length) continue;
  mapGames++;
  const geom = new Map(); for (const t of g.map) if (t.q!=null) geom.set(t.id,{q:t.q,r:t.r,type:t.type,sector:t.sector,id:t.id});
  const fl = [...g.fullGameLog].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
  const journal = (g.actionJournal||[]).filter(e=>e.timestamp!=null).sort((a,b)=>a.timestamp-b.timestamp);
  const owner={}, struct={}; let fi=0;
  const samples=[];
  for (const e of journal){
    // 이 결정 timestamp 이전의 모든 보드이벤트 적용
    while (fi<fl.length && (fl[fi].timestamp||0) < e.timestamp){ applyEvent(owner,struct,fl[fi]); fi++; }
    const label = (e.action||'').replace(/\s*[:(].*/,'').trim();
    const norm = label==='Built Mine' ? 'Built Mine'
      : label.startsWith('Upgraded to Trading') ? 'Upgraded to Trading Station'
      : label.startsWith('Upgraded to Research') ? 'Upgraded to Research Lab'
      : label.startsWith('Advanced Research') ? 'Advanced Research'
      : MAIN.has(label) ? label : null;
    if (!norm) continue;
    const b = baseFeat(e); if (!b) continue;
    const m = mapFeat(geom, owner, struct, e.playerId);
    samples.push({ base:b, map:m, y:norm });
  }
  if (samples.length) games.push(samples);
}

const all = games.flat();
console.log(`맵 게임 ${mapGames}개, 학습 샘플 ${all.length} (유효 게임 ${games.length}개)`);
const distc={}; all.forEach(s=>distc[s.y]=(distc[s.y]||0)+1);
const sorted=Object.entries(distc).sort((a,b)=>b[1]-a[1]);
const base=sorted[0][1]/all.length;
console.log('클래스:', sorted.map(([k,v])=>k+':'+v).join(', '));
console.log(`base-rate(${sorted[0][0]}): ${(base*100).toFixed(1)}%\n`);

function d2(a,b){let s=0;for(let i=0;i<a.length;i++){const d=a[i]-b[i];s+=d*d;}return s;}
function knn(useMap){
  const K=15; let correct=0,n=0;
  const vec = s => useMap ? [...s.base,...s.map] : s.base;
  for (let gi=0; gi<games.length; gi++){
    const train = games.filter((_,i)=>i!==gi).flat();
    for (const q of games[gi]){
      const qv=vec(q);
      const nn = train.map(t=>({y:t.y,d:d2(qv,vec(t))})).sort((a,b)=>a.d-b.d).slice(0,K);
      const vote={}; nn.forEach(o=>vote[o.y]=(vote[o.y]||0)+1);
      const pred=Object.entries(vote).sort((a,b)=>b[1]-a[1])[0][0];
      if(pred===q.y)correct++; n++;
    }
  }
  return correct/n;
}
const accBase=knn(false), accMap=knn(true);
console.log(`(A) 스칼라 only      : ${(accBase*100).toFixed(1)}%  (base 대비 +${((accBase-base)*100).toFixed(1)}%p)`);
console.log(`(B) 스칼라 + 맵피처   : ${(accMap*100).toFixed(1)}%  (base 대비 +${((accMap-base)*100).toFixed(1)}%p)`);
console.log(`\n★ 맵 순효과 (B−A): ${((accMap-accBase)*100).toFixed(1)}%p`);
console.log(accMap > base+0.08 ? '→ 신호 있음(>+8%p): 맵-피처 정책망 풀빌드 정당화 가능.'
  : (accMap-accBase) > 0.03 ? '→ 맵이 유의미하게 기여(+3%p↑). 데이터 더 모으면 임계 돌파 가능성.'
  : '→ 맵 기여 미미. 피처 설계 or 데이터 더 필요.');
