// per-candidate 배치 랭커 v2 — calculatePlacementPolicyScore(bot.ts)와 *동일 8피처*로 학습해
// 가중치만 교체 가능하게. build_mine 후보만(업글은 자기건물이라 배치결정 아님). 112게임.
// 구 placementPolicy(22판, pointwise, top1 17.8%)와 차이: 판수 5배 + 봇 실후보 내 랭킹(softmax CE).
import fs from 'fs';
const dir='data/human-games'; const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
const dist=(a,b)=>(Math.abs(a.q-b.q)+Math.abs(a.q+a.r-b.q-b.r)+Math.abs(a.r-b.r))/2;
const NONPLANET=new Set(['space','deep_space','transdim','lost_fleet_ship']);
const isPlanet=t=>!!t.type&&!NONPLANET.has(t.type)&&!String(t.type).startsWith('ship_');

const decisions=[];
for(const f of files){let g;try{g=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8'))}catch{continue}
  if(!g.map||!g.actionJournal)continue;
  const geom=new Map();for(const t of g.map)if(t.q!=null)geom.set(t.id,{id:t.id,q:t.q,r:t.r,type:t.type,sector:t.sector});
  const ships=[...geom.values()].filter(t=>String(t.type).startsWith('ship_'));
  const protos=[...geom.values()].filter(t=>t.type==='proto'||t.type==='asteroid');
  const owner=new Map(); // tileId -> pid (구조물 보유)
  for(const e of g.actionJournal){
    const pid=e.playerId, act=e.action||'', tid=e.tileId;
    if(Array.isArray(e.candidates)&&e.candidates.length){
      const cands=e.candidates.filter(c=>c.type==='build_mine'&&c.tileId&&geom.has(c.tileId));
      const chosen=cands.findIndex(c=>c.tileId===tid);
      if(cands.length>=2&&chosen>=0){
        const mine=[...owner.entries()].filter(([,o])=>o===pid).map(([id])=>geom.get(id)).filter(Boolean);
        const opp=[...owner.entries()].filter(([,o])=>o!==pid).map(([id])=>geom.get(id)).filter(Boolean);
        if(mine.length===0)continue;
        const ownedIds=new Set(owner.keys());
        const empties=[...geom.values()].filter(t=>isPlanet(t)&&!ownedIds.has(t.id));
        const myTypes=new Set(mine.map(t=>t.type)), mySectors=new Set(mine.map(t=>t.sector));
        const md=(arr,tile)=>arr.length?Math.min(...arr.map(s=>dist(s,tile))):9;
        const feats=cands.map(c=>{
          const tile=geom.get(c.tileId);
          const adjEmpty=empties.filter(t=>t.id!==tile.id&&dist(t,tile)===1).length;
          const adjOwn=mine.filter(m=>dist(m,tile)===1).length;
          return [
            Math.min(md(mine,tile),9)/9, Math.min(md(opp,tile),9)/9, Math.min(md(ships,tile),9)/9, Math.min(md(protos,tile),9)/9,
            adjEmpty/6, adjOwn/6, mySectors.has(tile.sector)?0:1, myTypes.has(tile.type)?0:1,
          ];
        });
        decisions.push({cands:feats,y:chosen});
      }
    }
    if(/Built Mine|Placed Starting Mine|Placed Mine|Placed Gaiaformer/i.test(act)){if(tid)owner.set(tid,pid);}
    else if(/Upgraded to|Academy/i.test(act)){if(tid&&!owner.has(tid))owner.set(tid,pid);}
  }
}
const D=8;
console.log('build_mine 배치 결정 '+decisions.length+', 후보수평균 '+(decisions.reduce((s,d)=>s+d.cands.length,0)/decisions.length).toFixed(1));
const tr=[],va=[];decisions.forEach((d,i)=>(i%7===0?va:tr).push(d));
console.log('train '+tr.length+' / val '+va.length);
let w=new Float64Array(D);
const scores=d=>d.cands.map(f=>{let s=0;for(let k=0;k<D;k++)s+=w[k]*f[k];return s;});
const softmax=ss=>{const mx=Math.max(...ss);const ex=ss.map(s=>Math.exp(s-mx));const Z=ex.reduce((a,b)=>a+b,0);return ex.map(e=>e/Z);};
const accSet=set=>{let c1=0;for(const d of set){const p=softmax(scores(d));let bi=0;for(let c=1;c<p.length;c++)if(p[c]>p[bi])bi=c;if(bi===d.y)c1++;}return c1/set.length;};
const randBase=va.reduce((s,d)=>s+1/d.cands.length,0)/va.length;
const m=new Float64Array(D),v=new Float64Array(D);const b1=0.9,b2=0.999,eps=1e-8;let t=0;
const lr=0.05,l2=1e-4;let seed=12345;const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
for(let ep=0;ep<300;ep++){
  const ord=tr.map((_,i)=>i);for(let i=ord.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[ord[i],ord[j]]=[ord[j],ord[i]];}
  for(const idx of ord){const d=tr[idx];const p=softmax(scores(d));t++;
    const g=new Float64Array(D);
    for(let c=0;c<d.cands.length;c++){const coef=p[c]-(c===d.y?1:0);const f=d.cands[c];for(let k=0;k<D;k++)g[k]+=coef*f[k];}
    const lrt=lr*Math.sqrt(1-Math.pow(b2,t))/(1-Math.pow(b1,t));
    for(let k=0;k<D;k++){const gr=g[k]+l2*w[k];m[k]=b1*m[k]+(1-b1)*gr;v[k]=b2*v[k]+(1-b2)*gr*gr;w[k]-=lrt*m[k]/(Math.sqrt(v[k])+eps);}}
}
console.log(`무작위 baseline ${(randBase*100).toFixed(1)}% | train top1 ${(accSet(tr)*100).toFixed(1)}% | val top1 ${(accSet(va)*100).toFixed(1)}%`);
// 구 가중치와 스케일 맞춤(통합 ×60 강도 동일하게): max|w|를 구 W max(3.57)로 정규화
const OLD=[-3.57,-0.85,0.13,-0.98,-0.54,1.20,0.11,-0.81];
const mx=Math.max(...[...w].map(Math.abs));
const scaled=[...w].map(x=>x/mx*3.57);
const FN=['dOwn','dOpp','dShip','dProto','adjEmpty','adjOwn','newSector','newType'];
console.log('\n피처       구(22판)   신(112판 per-cand, 스케일정합)');
FN.forEach((n,k)=>console.log(`${n.padEnd(10)} ${String(OLD[k]).padStart(7)}   ${scaled[k].toFixed(2)}`));
console.log('\nW_V2 = ['+scaled.map(x=>x.toFixed(2)).join(', ')+']');
