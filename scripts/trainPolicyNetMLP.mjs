// 비선형(MLP) 사람-모방 정책망 학습. trainPolicyNet.mjs 의 피처/라벨 추출을 *그대로* 복사(봇 통합 호환 필수).
// 입력26 → hidden(ReLU) → 19(softmax). 순수 JS forward/backprop, Adam, L2, 15% 검증분할(i%7===0, 결정적).
// 선형 베이스라인(train 25.6%)과 검증 top-1/top-3 로 정직하게 비교. 최적 모델을 server/ai/policyNetMLP.json 저장.
import fs from 'fs';
const dir='data/human-games'; const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
const MAINSET=new Set(['Built Mine','Advanced Research','Upgraded to Trading Station','Upgraded to Research Lab','Federation','Gained Tech Tile','Entered Ship','Academy','Power Action','Used Tech Action','Placed Gaiaformer']);
const TRACKS=['terraforming','navigation','artificialIntelligence','gaiaProject','economy','science'];
const SHIP=new Set(['ship_twilight','ship_rebellion','ship_tf_mars','ship_eclipse']);
const NONPLANET=new Set(['space','deep_space','lost_fleet_ship','ship_rebellion','ship_twilight','ship_tf_mars','ship_eclipse','asteroid','proto','gaia']);
const HEX=[[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
const dist=(a,b)=>(Math.abs(a.q-b.q)+Math.abs(a.q+a.r-b.q-b.r)+Math.abs(a.r-b.r))/2;
const labelOf=(act,details)=>{if(!MAINSET.has(act))return null;
  if(/Advanced Research/i.test(act)){const tr=(details||'').split(/ to level/i)[0].trim();return tr?('R:'+tr):'Advanced Research';}
  if(/Power Action/i.test(act)){const d=details||'';
    if(/Ore/i.test(d))return'Pw:ore';if(/Credit/i.test(d))return'Pw:credits';
    if(/Knowledge/i.test(d))return'Pw:knowledge';if(/Token/i.test(d))return'Pw:tokens';
    if(/Terraform|step/i.test(d))return'Pw:tf';return'Pw:other';}
  return act;};
function scalarFeat(e){const pb=e.playerBefore;if(!pb)return null;const r=pb.resources||{},res=pb.research||{};
  return [(e.round||1)/6,(pb.score||0)/100,(r.ore??0)/15,(r.credits??0)/20,(r.knowledge??0)/15,(r.qic??0)/8,((r.power1??0)+(r.power2??0)+(r.power3??0))/12,...TRACKS.map(t=>(res[t]??0)/5),(pb.techTiles?.length||0)/8,(pb.federations?.length||0)/3];}

const samplesAll=[];
for(const f of files){let g;try{g=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8'))}catch{continue}
  if(!g.map||!g.map.length||!g.actionJournal)continue;
  const geom=new Map();for(const t of g.map)if(t.q!=null)geom.set(t.id,{q:t.q,r:t.r,type:t.type,sector:t.sector});
  const ships=[...geom.values()].filter(t=>SHIP.has(t.type)),protos=[...geom.values()].filter(t=>t.type==='proto'||t.type==='asteroid');
  const owner=new Map(),eng={};
  for(const e of g.actionJournal){const pid=e.playerId,act=e.action||'',tid=e.tileId,lab=labelOf(act,e.details);
    if(lab&&e.playerBefore){const mine=[...owner.entries()].filter(([,o])=>o===pid).map(([id])=>geom.get(id)).filter(Boolean);
      const planets=mine.filter(t=>!NONPLANET.has(t.type)),types=new Set(planets.map(t=>t.type)),sectors=new Set(mine.map(t=>t.sector));
      const nShip=ships.length&&mine.length?Math.min(...ships.map(s=>Math.min(...mine.map(m=>dist(m,s))))):9;
      const nProto=protos.length&&mine.length?Math.min(...protos.map(s=>Math.min(...mine.map(m=>dist(m,s))))):9;
      let adj=0;const set=new Set(mine.map(t=>t.q+','+t.r));for(const m of mine)for(const[dq,dr]of HEX)if(set.has((m.q+dq)+','+(m.r+dr))){adj++;break;}
      const en=eng[pid]||{mines:0,builds:0,ships:0,feds:0,tech:0};
      samplesAll.push({f:[...scalarFeat(e),en.mines/12,en.builds/18,en.ships/3,en.feds/3,en.tech/8,mine.length/12,types.size/7,sectors.size/8,Math.min(nShip,9)/9,Math.min(nProto,9)/9,mine.length?adj/mine.length:0],lab});}
    const en=eng[pid]=eng[pid]||{mines:0,builds:0,ships:0,feds:0,tech:0};
    if(/Built Mine|Placed Starting Mine|Placed Mine/i.test(act)){if(tid)owner.set(tid,pid);en.mines++;en.builds++;}
    else if(/Upgraded to/i.test(act))en.builds++;else if(/Entered Ship/i.test(act))en.ships++;
    else if(/Federation/i.test(act))en.feds++;else if(/Gained Tech/i.test(act))en.tech++;
    else if(/Placed Gaiaformer/i.test(act)){if(tid)owner.set(tid,pid);}}}

// ── 라벨/피처 행렬 (선형과 동일) ──
const LABELS=[...new Set(samplesAll.map(s=>s.lab))].sort();
const L=LABELS.length, D=samplesAll[0].f.length; // D=26 (편향은 별도 b벡터)
const X=samplesAll.map(s=>s.f), Y=samplesAll.map(s=>LABELS.indexOf(s.lab));
console.log('학습 샘플 '+samplesAll.length+', 클래스 '+L+', 입력차원 '+D);

// ── 결정적 15% 검증 분할 (i%7===0 → 검증) ──
const trainIdx=[], valIdx=[];
for(let i=0;i<X.length;i++){ (i%7===0?valIdx:trainIdx).push(i); }
console.log('train '+trainIdx.length+' / val '+valIdx.length+' (i%7===0=val)');

// ── 유틸 ──
const relu=x=>x>0?x:0;
function initMat(rows,cols,scale){const m=[];let s=12345+rows*7+cols*13;const rnd=()=>{s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff;};
  for(let i=0;i<rows;i++){const row=new Float64Array(cols);for(let j=0;j<cols;j++)row[j]=(rnd()*2-1)*scale;m.push(row);}return m;}

// forward: 단일 샘플. 반환 {h(pre-relu), a(post-relu), p(softmax)}
function forward(net,x){const {W1,b1,W2,b2,H}=net;
  const z1=new Float64Array(H),a1=new Float64Array(H);
  for(let j=0;j<H;j++){let s=b1[j];const w=W1[j];for(let d=0;d<D;d++)s+=w[d]*x[d];z1[j]=s;a1[j]=s>0?s:0;}
  const lg=new Float64Array(L);let mx=-1e9;
  for(let c=0;c<L;c++){let s=b2[c];const w=W2[c];for(let j=0;j<H;j++)s+=w[j]*a1[j];lg[c]=s;if(s>mx)mx=s;}
  let Z=0;for(let c=0;c<L;c++){lg[c]=Math.exp(lg[c]-mx);Z+=lg[c];}
  for(let c=0;c<L;c++)lg[c]/=Z;
  return {z1,a1,p:lg};}

function evalAcc(net,idx){let c1=0,c3=0;
  for(const i of idx){const {p}=forward(net,X[i]);const y=Y[i];
    // top-1
    let bm=-1,bc=0;for(let c=0;c<L;c++)if(p[c]>bm){bm=p[c];bc=c;}
    if(bc===y)c1++;
    // top-3
    const order=[...p.keys()].sort((a,b)=>p[b]-p[a]);
    if(order[0]===y||order[1]===y||order[2]===y)c3++;}
  return {top1:c1/idx.length, top3:c3/idx.length};}

// ── Adam 학습 ──
function train(H,lr,epochs,l2,batch){
  const net={H,W1:initMat(H,D,Math.sqrt(2/D)),b1:new Float64Array(H),W2:initMat(L,H,Math.sqrt(2/H)),b2:new Float64Array(L)};
  // Adam 모멘트
  const mW1=initMat(H,D,0),vW1=initMat(H,D,0),mb1=new Float64Array(H),vb1=new Float64Array(H);
  const mW2=initMat(L,H,0),vW2=initMat(L,H,0),mb2=new Float64Array(L),vb2=new Float64Array(L);
  const b1c=0.9,b2c=0.999,eps=1e-8;let t=0;
  // 셔플용(결정적)
  let seed=987654321;const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
  const order=trainIdx.slice();
  for(let ep=0;ep<epochs;ep++){
    // shuffle
    for(let i=order.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
    for(let bs=0;bs<order.length;bs+=batch){
      const bend=Math.min(bs+batch,order.length),bn=bend-bs;t++;
      // 그라디언트 누적
      const gW1=initMat(H,D,0),gb1=new Float64Array(H),gW2=initMat(L,H,0),gb2=new Float64Array(L);
      for(let bi=bs;bi<bend;bi++){const i=order[bi],x=X[i],y=Y[i];
        const {z1,a1,p}=forward(net,x);
        // dL/dlogit2 = p - onehot
        const dl2=new Float64Array(L);for(let c=0;c<L;c++)dl2[c]=p[c]-(c===y?1:0);
        // W2,b2 grad + backprop to a1
        const da1=new Float64Array(H);
        for(let c=0;c<L;c++){const g=dl2[c];gb2[c]+=g;const w=W2r(net,c),gw=gW2[c];
          for(let j=0;j<H;j++){gw[j]+=g*a1[j];da1[j]+=g*w[j];}}
        // through relu → z1
        for(let j=0;j<H;j++){const dz=z1[j]>0?da1[j]:0;gb1[j]+=dz;const gw=gW1[j];for(let d=0;d<D;d++)gw[d]+=dz*x[d];}
      }
      // Adam 업데이트 (평균 그라디언트 + L2)
      const inv=1/bn, lrt=lr*Math.sqrt(1-Math.pow(b2c,t))/(1-Math.pow(b1c,t));
      adam(net.W1,gW1,mW1,vW1,H,D,inv,l2,lrt,b1c,b2c,eps);
      adamV(net.b1,gb1,mb1,vb1,H,inv,l2,lrt,b1c,b2c,eps);
      adam(net.W2,gW2,mW2,vW2,L,H,inv,l2,lrt,b1c,b2c,eps);
      adamV(net.b2,gb2,mb2,vb2,L,inv,l2,lrt,b1c,b2c,eps);
    }
  }
  return net;}
function W2r(net,c){return net.W2[c];}
function adam(P,G,M,V,rows,cols,inv,l2,lrt,b1c,b2c,eps){
  for(let i=0;i<rows;i++){const p=P[i],g=G[i],m=M[i],v=V[i];
    for(let j=0;j<cols;j++){const gr=g[j]*inv+l2*p[j];m[j]=b1c*m[j]+(1-b1c)*gr;v[j]=b2c*v[j]+(1-b2c)*gr*gr;
      p[j]-=lrt*m[j]/(Math.sqrt(v[j])+eps);}}}
function adamV(P,G,M,V,n,inv,l2,lrt,b1c,b2c,eps){
  for(let j=0;j<n;j++){const gr=G[j]*inv+l2*P[j];M[j]=b1c*M[j]+(1-b1c)*gr;V[j]=b2c*V[j]+(1-b2c)*gr*gr;
    P[j]-=lrt*M[j]/(Math.sqrt(V[j])+eps);}}

// ── 하이퍼파라미터 스윕 ──
const configs=[
  {H:32,lr:0.005,epochs:400,l2:1e-4,batch:32},
  {H:32,lr:0.003,epochs:500,l2:1e-3,batch:64},
  {H:32,lr:0.002,epochs:800,l2:3e-3,batch:64},
  {H:64,lr:0.003,epochs:600,l2:3e-4,batch:32},
  {H:64,lr:0.002,epochs:800,l2:1e-3,batch:64},
  {H:64,lr:0.002,epochs:800,l2:3e-3,batch:64},
  {H:16,lr:0.003,epochs:800,l2:1e-3,batch:64},
  {H:48,lr:0.002,epochs:900,l2:2e-3,batch:64},
];
let best=null;
for(const cfg of configs){
  const net=train(cfg.H,cfg.lr,cfg.epochs,cfg.l2,cfg.batch);
  const tr=evalAcc(net,trainIdx), va=evalAcc(net,valIdx);
  const gap=(tr.top1-va.top1)*100;
  console.log(`H=${cfg.H} lr=${cfg.lr} ep=${cfg.epochs} l2=${cfg.l2} bs=${cfg.batch} | train t1 ${(tr.top1*100).toFixed(1)}% | val t1 ${(va.top1*100).toFixed(1)}% t3 ${(va.top3*100).toFixed(1)}% | gap ${gap.toFixed(1)}pt${gap>12?' (overfit)':''}`);
  if(!best||va.top1>best.va.top1){best={cfg,net,tr,va};}
}

const {cfg,net,tr,va}=best;
console.log(`\n=== BEST: H=${cfg.H} lr=${cfg.lr} ep=${cfg.epochs} l2=${cfg.l2} bs=${cfg.batch} ===`);
console.log(`train top1 ${(tr.top1*100).toFixed(1)}% | val top1 ${(va.top1*100).toFixed(1)}% | val top3 ${(va.top3*100).toFixed(1)}%`);

const out={version:2,arch:'mlp',activation:'relu',labels:LABELS,featDim:D,hidden:cfg.H,featSpec:'scalar13+eng5+map6',
  W1:net.W1.map(r=>Array.from(r)),b1:Array.from(net.b1),W2:net.W2.map(r=>Array.from(r)),b2:Array.from(net.b2)};
fs.writeFileSync('server/ai/policyNetMLP.json',JSON.stringify(out));
console.log('저장: server/ai/policyNetMLP.json ('+(JSON.stringify(out).length/1024).toFixed(0)+'KB)');
