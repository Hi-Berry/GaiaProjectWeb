// 모방학습 *타일선택* viability probe (진짜 타깃 = 배치).
// 사람의 각 "광산 건설" 결정에서, 그 시점 보드를 복원하고 도달가능 빈 행성 후보들 중
// 사람이 *실제로 고른 타일*을 공간피처로 예측할 수 있나? (top-1 정확도)
// 비교: random / nearest-own 휴리스틱 / 학습된 로지스틱(leave-one-game-out).
// 신호 있으면(>random·>nearest-own) → 배치 정책망이 진짜 레버.
import fs from 'fs';
const dir='data/human-games';
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
const NONPLANET=new Set(['space','deep_space','transdim','lost_fleet_ship']);
const HEX=[[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
const dist=(a,b)=>(Math.abs(a.q-b.q)+Math.abs(a.q+a.r-b.q-b.r)+Math.abs(a.r-b.r))/2;
const isShip=t=>(t.type||'').startsWith('ship_');
const isProto=t=>t.type==='proto'||t.type==='asteroid';
const isPlanet=t=>t.type&&!NONPLANET.has(t.type)&&!isShip(t);
function applyEvent(owner,struct,e){const tid=e.tileId;if(!tid)return;const a=e.action||'';
  if(/Placed Starting Mine|Built Mine|Placed Mine/i.test(a)){owner[tid]=e.playerId;struct[tid]='mine';}
  else if(/Upgraded to Trading/i.test(a)){owner[tid]=e.playerId;struct[tid]='trading_station';}
  else if(/Upgraded to Research Lab/i.test(a)){owner[tid]=e.playerId;struct[tid]='research_lab';}
  else if(/Academy/i.test(a)){owner[tid]=e.playerId;struct[tid]='academy';}
  else if(/Planetary Institute/i.test(a)){owner[tid]=e.playerId;struct[tid]='planetary_institute';}}

// 후보 타일의 공간 피처 (deciding player pid 기준, 결정시점 보드)
function tileFeat(geom,owner,pid,cand,mine,empties,ships,protos,opp,myTypes,mySectors){
  const md=arr=>arr.length?Math.min(...arr.map(s=>dist(cand,s))):9;
  const dOwn=md(mine), dOpp=md(opp), dShip=md(ships), dProto=md(protos);
  const adjEmpty=empties.filter(t=>t.id!==cand.id&&dist(t,cand)===1).length;
  // 클러스터 다리: cand가 인접(dist1)으로 닿는 *서로 다른* 내 클러스터 수 ≥2 → 위성붕괴 후보
  const adjOwn=mine.filter(m=>dist(m,cand)===1);
  const newSector=mySectors.has(cand.sector)?0:1;
  const newType=myTypes.has(cand.type)?0:1;
  return [
    Math.min(dOwn,9)/9, Math.min(dOpp,9)/9, Math.min(dShip,9)/9, Math.min(dProto,9)/9,
    adjEmpty/6, adjOwn.length/6, newSector, newType,
  ];
}

const games=[];
for(const f of files){let g;try{g=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8'))}catch{continue}
  if(!Array.isArray(g.map)||!g.map.length||!Array.isArray(g.fullGameLog)||!g.fullGameLog.length)continue;
  const geom=new Map();for(const t of g.map)if(t.q!=null)geom.set(t.id,{q:t.q,r:t.r,type:t.type,sector:t.sector,id:t.id});
  const fl=[...g.fullGameLog].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
  const journal=(g.actionJournal||[]).filter(e=>e.timestamp!=null).sort((a,b)=>a.timestamp-b.timestamp);
  const owner={},struct={};let fi=0;const decisions=[];
  for(const e of journal){
    while(fi<fl.length&&(fl[fi].timestamp||0)<e.timestamp){applyEvent(owner,struct,fl[fi]);fi++;}
    // 광산 건설 결정만 (배치 결정)
    if(!/Built Mine|Placed Mine/i.test(e.action||''))continue;
    const chosen=e.tileId; if(!chosen||!geom.has(chosen))continue;
    const pid=e.playerId;
    const tiles=[...geom.values()];
    const mine=tiles.filter(t=>owner[t.id]===pid&&isPlanet(t));
    if(!mine.length)continue;
    // 후보: 내 타일 dist≤4 이내 빈 행성 + 실제선택(항상 포함)
    const empties=tiles.filter(t=>isPlanet(t)&&!owner[t.id]);
    let cands=empties.filter(t=>mine.some(m=>dist(m,t)<=4));
    if(!cands.some(c=>c.id===chosen)){const ct=geom.get(chosen);if(ct)cands.push(ct);}
    if(cands.length<2)continue; // 선택지 없으면 스킵
    const ships=tiles.filter(isShip),protos=tiles.filter(isProto),opp=tiles.filter(t=>owner[t.id]&&owner[t.id]!==pid);
    const myTypes=new Set(mine.map(t=>t.type)),mySectors=new Set(mine.map(t=>t.sector));
    const feats=cands.map(c=>tileFeat(geom,owner,pid,c,mine,empties,ships,protos,opp,myTypes,mySectors));
    const chosenIdx=cands.findIndex(c=>c.id===chosen);
    decisions.push({feats,chosenIdx,nCand:cands.length,cands});
  }
  if(decisions.length)games.push(decisions);
}
const allDec=games.flat();
console.log(`타일선택 결정: ${allDec.length} (게임 ${games.length}개)`);
const avgCand=allDec.reduce((a,d)=>a+d.nCand,0)/allDec.length;
console.log(`평균 후보 수: ${avgCand.toFixed(1)} → random top-1 ≈ ${(100/avgCand).toFixed(1)}%\n`);

// 휴리스틱: nearest-own (피처[5]=adjOwn 큰 것, 아니면 [0]=dOwn 작은 것)
let nearOwnHit=0;
for(const d of allDec){
  let best=0,bestS=-1;
  d.feats.forEach((f,i)=>{const s=f[5]*2 - f[0];if(s>bestS){bestS=s;best=i;}}); // adj 우선, 가까운 own
  if(best===d.chosenIdx)nearOwnHit++;
}
console.log(`nearest-own 휴리스틱 top-1: ${(nearOwnHit/allDec.length*100).toFixed(1)}%`);

// 학습 로지스틱 랭커 (leave-one-game-out): 후보별 chosen=1/0 이진, softmax over 후보
const D=allDec[0].feats[0].length;
function train(trainDecs){
  const w=new Array(D).fill(0);const lr=0.3;
  for(let ep=0;ep<300;ep++){const g=new Array(D).fill(0);
    for(const d of trainDecs){
      const sc=d.feats.map(f=>f.reduce((s,v,i)=>s+v*w[i],0));
      const mx=Math.max(...sc);let Z=0;const ex=sc.map(s=>{const e=Math.exp(s-mx);Z+=e;return e;});
      for(let c=0;c<d.feats.length;c++){const p=ex[c]/Z-(c===d.chosenIdx?1:0);for(let i=0;i<D;i++)g[i]+=p*d.feats[c][i];}
    }
    for(let i=0;i<D;i++)w[i]-=lr*(g[i]/trainDecs.length+0.001*w[i]);
  }
  return w;
}
let lrHit=0,n=0;
for(let gi=0;gi<games.length;gi++){
  const tr=games.filter((_,i)=>i!==gi).flat();
  const w=train(tr);
  for(const d of games[gi]){
    const sc=d.feats.map(f=>f.reduce((s,v,i)=>s+v*w[i],0));
    let best=0;sc.forEach((s,i)=>{if(s>sc[best])best=i;});
    if(best===d.chosenIdx)lrHit++; n++;
  }
}
const wAll=train(allDec);
console.log(`학습 로지스틱 랭커 top-1: ${(lrHit/n*100).toFixed(1)}%  (n=${n})`);
console.log(`\n학습된 가중치 [dOwn,dOpp,dShip,dProto,adjEmpty,adjOwn,newSector,newType]:`);
console.log('  ['+wAll.map(x=>x.toFixed(2)).join(', ')+']');
const randBase=100/avgCand;
const lrAcc=lrHit/n*100;
console.log(`\n★ 학습 랭커 ${lrAcc.toFixed(1)}% vs random ${randBase.toFixed(1)}% = +${(lrAcc-randBase).toFixed(1)}%p`);
console.log(lrAcc>randBase*2 ? '→ 강한 신호: 사람 타일선택이 공간피처로 예측됨. 배치 정책망 정당화.'
  : lrAcc>randBase*1.3 ? '→ 중간 신호: 부분 예측. 피처 보강/데이터로 키울 여지.'
  : '→ 약함: 타일선택이 이 피처로 잘 안 잡힘.');
