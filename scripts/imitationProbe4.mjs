// 모방학습 v4: kNN(약한 하한) 대신 *트레인드 softmax 분류기*가 같은 v3피처로 게이트(+8%p)를 넘는지.
// 알파고 정책망은 트레인드 net이므로 이게 진짜 viability 판정. 순수 JS GD(라이브러리 없음).
import fs from 'fs';
const dir='data/human-games'; const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
const MAIN=new Set(['Built Mine','Advanced Research','Upgraded to Trading Station','Upgraded to Research Lab','Federation','Gained Tech Tile','Entered Ship','Academy','Power Action','Used Tech Action','Placed Gaiaformer']);
const TRACKS=['terraforming','navigation','artificialIntelligence','gaiaProject','economy','science'];
const SHIP=new Set(['ship_twilight','ship_rebellion','ship_tf_mars','ship_eclipse']);
const NONPLANET=new Set(['space','deep_space','lost_fleet_ship','ship_rebellion','ship_twilight','ship_tf_mars','ship_eclipse','asteroid','proto','gaia']);
const HEX=[[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
const dist=(a,b)=>(Math.abs(a.q-b.q)+Math.abs(a.q+a.r-b.q-b.r)+Math.abs(a.r-b.r))/2;
const labelOf=a=>MAIN.has(a)?a:null;
function scalarFeat(e){const pb=e.playerBefore;if(!pb)return null;const r=pb.resources||{},res=pb.research||{};
  return [(e.round||1)/6,(pb.score||0)/100,(r.ore??0)/15,(r.credits??0)/20,(r.knowledge??0)/15,(r.qic??0)/8,((r.power1??0)+(r.power2??0)+(r.power3??0))/12,...TRACKS.map(t=>(res[t]??0)/5),(pb.techTiles?.length||0)/8,(pb.federations?.length||0)/3];}

const games=[];
for(const f of files){let g;try{g=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8'))}catch{continue}
  if(!g.map||!g.map.length||!g.actionJournal)continue;
  const geom=new Map();for(const t of g.map)if(t.q!=null)geom.set(t.id,{q:t.q,r:t.r,type:t.type,sector:t.sector});
  const ships=[...geom.values()].filter(t=>SHIP.has(t.type)),protos=[...geom.values()].filter(t=>t.type==='proto'||t.type==='asteroid');
  const owner=new Map(),eng={},samples=[];
  for(const e of g.actionJournal){const pid=e.playerId,act=e.action||'',tid=e.tileId,lab=labelOf(act);
    if(lab&&e.playerBefore){const mine=[...owner.entries()].filter(([,o])=>o===pid).map(([id])=>geom.get(id)).filter(Boolean);
      const planets=mine.filter(t=>!NONPLANET.has(t.type)),types=new Set(planets.map(t=>t.type)),sectors=new Set(mine.map(t=>t.sector));
      const nShip=ships.length&&mine.length?Math.min(...ships.map(s=>Math.min(...mine.map(m=>dist(m,s))))):9;
      const nProto=protos.length&&mine.length?Math.min(...protos.map(s=>Math.min(...mine.map(m=>dist(m,s))))):9;
      let adj=0;const set=new Set(mine.map(t=>t.q+','+t.r));for(const m of mine)for(const[dq,dr]of HEX)if(set.has((m.q+dq)+','+(m.r+dr))){adj++;break;}
      const en=eng[pid]||{mines:0,builds:0,ships:0,feds:0,tech:0};
      samples.push({f:[...scalarFeat(e),en.mines/12,en.builds/18,en.ships/3,en.feds/3,en.tech/8,mine.length/12,types.size/7,sectors.size/8,Math.min(nShip,9)/9,Math.min(nProto,9)/9,mine.length?adj/mine.length:0],y:lab});}
    const en=eng[pid]=eng[pid]||{mines:0,builds:0,ships:0,feds:0,tech:0};
    if(/Built Mine|Placed Starting Mine|Placed Mine/i.test(act)){if(tid)owner.set(tid,pid);en.mines++;en.builds++;}
    else if(/Upgraded to/i.test(act))en.builds++;else if(/Entered Ship/i.test(act))en.ships++;
    else if(/Federation/i.test(act))en.feds++;else if(/Gained Tech/i.test(act))en.tech++;
    else if(/Placed Gaiaformer/i.test(act)){if(tid)owner.set(tid,pid);}}
  if(samples.length)games.push(samples);}

const all=games.flat();const labels=[...new Set(all.map(s=>s.y))];const L=labels.length;const D=all[0].f.length+1;//+bias
const cnt={};for(const s of all)cnt[s.y]=(cnt[s.y]||0)+1;const base=Math.max(...Object.values(cnt))/all.length;
console.log('게임 '+games.length+', 샘플 '+all.length+', 클래스 '+L+', 차원 '+(D-1)+', base '+(base*100).toFixed(1)+'%');

// 5-fold by game
function softmaxTrain(train,test,epochs=300,lr=0.5,l2=1e-4){
  const W=Array.from({length:L},()=>new Float64Array(D));
  const xs=train.map(s=>[...s.f,1]),ys=train.map(s=>labels.indexOf(s.y));
  for(let ep=0;ep<epochs;ep++){const grad=Array.from({length:L},()=>new Float64Array(D));
    for(let i=0;i<xs.length;i++){const x=xs[i],logit=new Float64Array(L);let mx=-1e9;
      for(let c=0;c<L;c++){let s=0;for(let d=0;d<D;d++)s+=W[c][d]*x[d];logit[c]=s;if(s>mx)mx=s;}
      let Z=0;for(let c=0;c<L;c++){logit[c]=Math.exp(logit[c]-mx);Z+=logit[c];}
      for(let c=0;c<L;c++){const p=logit[c]/Z-(c===ys[i]?1:0);for(let d=0;d<D;d++)grad[c][d]+=p*x[d];}}
    for(let c=0;c<L;c++)for(let d=0;d<D;d++)W[c][d]-=lr*(grad[c][d]/xs.length+l2*W[c][d]);}
  let correct=0;for(const s of test){const x=[...s.f,1];let best=-1,bm=-1e9;
    for(let c=0;c<L;c++){let v=0;for(let d=0;d<D;d++)v+=W[c][d]*x[d];if(v>bm){bm=v;best=c;}}
    if(labels[best]===s.y)correct++;}
  return correct/test.length;}

let accSum=0,folds=5;
for(let k=0;k<folds;k++){const test=games.filter((_,i)=>i%folds===k).flat();const train=games.filter((_,i)=>i%folds!==k).flat();
  const a=softmaxTrain(train,test);accSum+=a*test.length;}
const acc=accSum/all.length;
console.log('트레인드 softmax (5-fold by game) 정확도: '+(acc*100).toFixed(1)+'%  (base 대비 +'+((acc-base)*100).toFixed(1)+'%p)');
console.log((acc-base>=0.08)?'→ ★★ 게이트(+8%p) 돌파! 트레인드 정책망 viable → 풀빌드 정당화.':'→ 게이트 미달. 데이터 더 필요(사람 1:3 누적).');
