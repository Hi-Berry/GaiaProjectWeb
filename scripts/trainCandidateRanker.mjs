// [path B 착수] per-candidate 배치 랭커: build/upgrade 결정에서, 봇이 낸 후보 타일들 중
// 사람이 고른 것을 공간 피처로 랭킹 학습. placementPolicy(8피처 top1 17.8%)의 후속 — 데이터↑ + 후보-내-랭킹.
// self-play 검증 불가(placement) → sibling top-1(사람 픽을 형제 중 1위로?)로 오프라인 판정. 무작위≈1/후보수.
import fs from 'fs';
const dir='data/human-games'; const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
const HEX=[[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
const dist=(a,b)=>(Math.abs(a.q-b.q)+Math.abs(a.q+a.r-b.q-b.r)+Math.abs(a.r-b.r))/2;
const PLACE=new Set(['build_mine','upgrade_structure']);
const POW={mine:1,trading_station:2,research_lab:2,planetary_institute:3,academy:3};
const TARGETS=['mine','trading_station','research_lab','planetary_institute','academy','academy_left','academy_right'];
// 구조물 파워값 추정용(placeGaiaformer 등 무시)
const structPow=(s)=>POW[s]??0;

// 결정 하나 = {cands:[{feat[]}], y: chosenIdx}
const decisions=[];
for(const f of files){let g;try{g=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8'))}catch{continue}
  if(!g.map||!g.actionJournal)continue;
  const geom=new Map();for(const t of g.map)if(t.q!=null)geom.set(t.id,{id:t.id,q:t.q,r:t.r,type:t.type,sector:t.sector});
  // owner/struct 재구성(actionJournal 재생)
  const owner=new Map(); // tileId -> {pid, struct}
  for(const e of g.actionJournal){
    const pid=e.playerId, act=e.action||'', tid=e.tileId;
    // ─ 결정 캡처(빌드/업글 후보가 있고 tileId로 taken 매칭되는 것만) ─
    if(Array.isArray(e.candidates)&&e.candidates.length){
      const placeCands=e.candidates.filter(c=>PLACE.has(c.type)&&c.tileId&&geom.has(c.tileId));
      const chosen=placeCands.findIndex(c=>c.tileId===e.tid||c.tileId===tid);
      if(placeCands.length>=2 && chosen>=0){
        // 내 건물들(현시점)
        const mine=[...owner.entries()].filter(([,o])=>o.pid===pid).map(([id,o])=>({...geom.get(id),struct:o.struct})).filter(t=>t.q!=null);
        const feats=placeCands.map(c=>{
          const t=geom.get(c.tileId);
          const dOwn=mine.length?Math.min(...mine.map(m=>dist(m,t))):9;
          const adj1=mine.filter(m=>dist(m,t)===1).length;
          const near2=mine.filter(m=>dist(m,t)<=2);
          const fedPow=near2.reduce((s,m)=>s+structPow(m.struct),0); // 2헥스내 내 파워합=연방잠재력
          const near2n=near2.length;
          const tgt=c.target||(c.type==='build_mine'?'mine':'');
          const tgtOneHot=TARGETS.map(x=>x===tgt?1:0);
          const isUpgrade=c.type==='upgrade_structure'?1:0;
          return [
            Math.min(dOwn,9)/9,      // 내건물 최근접거리(작을수록 밀집)
            adj1/6,                  // 인접(dist1) 내건물 수
            near2n/8,                // 2헥스내 내건물 수
            fedPow/12,               // 2헥스내 파워합(연방잠재력)
            isUpgrade,               // 업글 vs 신규광산
            ...tgtOneHot,            // 목표 구조물
          ];
        });
        decisions.push({cands:feats, y:chosen, round:e.round||1});
      }
    }
    // ─ 상태 갱신 ─
    if(/Built Mine|Placed Starting Mine|Placed Mine/i.test(act)){if(tid)owner.set(tid,{pid,struct:'mine'});}
    else if(/Upgraded to Trading Station/i.test(act)){if(tid)owner.set(tid,{pid,struct:'trading_station'});}
    else if(/Upgraded to Research Lab/i.test(act)){if(tid)owner.set(tid,{pid,struct:'research_lab'});}
    else if(/Upgraded to Planetary Institute/i.test(act)){if(tid)owner.set(tid,{pid,struct:'planetary_institute'});}
    else if(/Academy/i.test(act)){if(tid)owner.set(tid,{pid,struct:'academy'});}
  }
}
const D=decisions[0].cands[0].length;
console.log('배치 결정 '+decisions.length+', 후보피처차원 '+D+', 후보수평균 '+(decisions.reduce((s,d)=>s+d.cands.length,0)/decisions.length).toFixed(1));

// 결정적 15% val
const tr=[],va=[];decisions.forEach((d,i)=>(i%7===0?va:tr).push(d));
console.log('train '+tr.length+' / val '+va.length);

// ─ 선형 랭커: score = w·feat, softmax over cands, CE to chosen ─
let w=new Float64Array(D), b=0; // b는 상수라 상쇄되지만 유지
function scores(d){return d.cands.map(f=>{let s=0;for(let k=0;k<D;k++)s+=w[k]*f[k];return s;});}
function softmax(ss){const mx=Math.max(...ss);const ex=ss.map(s=>Math.exp(s-mx));const Z=ex.reduce((a,b)=>a+b,0);return ex.map(e=>e/Z);}
function accSet(set){let c1=0,c3=0;for(const d of set){const p=softmax(scores(d));
  const order=[...p.keys()].sort((a,b)=>p[b]-p[a]);
  if(order[0]===d.y)c1++; if(order.slice(0,3).includes(d.y))c3++;}
  return {t1:c1/set.length,t3:c3/set.length};}
// 무작위 baseline
const randBase=va.reduce((s,d)=>s+1/d.cands.length,0)/va.length;

// Adam
const m=new Float64Array(D),v=new Float64Array(D);const b1=0.9,b2=0.999,eps=1e-8;let t=0;
const lr=0.05,l2=1e-4,epochs=300;
let seed=12345;const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
for(let ep=0;ep<epochs;ep++){
  const ord=tr.map((_,i)=>i);for(let i=ord.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[ord[i],ord[j]]=[ord[j],ord[i]];}
  for(const idx of ord){const d=tr[idx];const p=softmax(scores(d));t++;
    // grad: sum_c (p_c - [c==y]) * feat_c
    const g=new Float64Array(D);
    for(let c=0;c<d.cands.length;c++){const coef=p[c]-(c===d.y?1:0);const f=d.cands[c];for(let k=0;k<D;k++)g[k]+=coef*f[k];}
    const lrt=lr*Math.sqrt(1-Math.pow(b2,t))/(1-Math.pow(b1,t));
    for(let k=0;k<D;k++){const gr=g[k]+l2*w[k];m[k]=b1*m[k]+(1-b1)*gr;v[k]=b2*v[k]+(1-b2)*gr*gr;w[k]-=lrt*m[k]/(Math.sqrt(v[k])+eps);}}
}
const trA=accSet(tr),vaA=accSet(va);
console.log(`\n=== 배치 랭커(선형, D=${D}) ===`);
console.log(`무작위 baseline sibling top1 ≈ ${(randBase*100).toFixed(1)}%`);
console.log(`train top1 ${(trA.t1*100).toFixed(1)}% | val top1 ${(vaA.t1*100).toFixed(1)}% top3 ${(vaA.t3*100).toFixed(1)}%`);
const FN=['dOwn','adj1','near2n','fedPow','isUpgrade',...TARGETS.map(x=>'tgt:'+x)];
console.log('가중치(사람 배치 선호):');
FN.forEach((n,k)=>console.log(`  ${n.padEnd(18)} ${w[k]>=0?'+':''}${w[k].toFixed(2)}`));
