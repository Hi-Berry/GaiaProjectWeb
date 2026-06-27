// 정책망 학습 + 직렬화: 사람 actionJournal+맵피처로 softmax 정책(상태→행동타입 분포) 학습 → server/ai/policyNet.json.
// 봇(bot.ts)이 로드해 같은 피처로 prior 계산. 피처 순서/정규화는 bot.ts computePolicyFeatures와 *정확히* 일치해야 함.
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

const LABELS=[...new Set(samplesAll.map(s=>s.lab))].sort();
const L=LABELS.length,D=samplesAll[0].f.length+1;
console.log('학습 샘플 '+samplesAll.length+', 클래스 '+L+' ('+LABELS.join(',')+'), 차원 '+(D-1));
const W=Array.from({length:L},()=>new Float64Array(D));
const xs=samplesAll.map(s=>[...s.f,1]),ys=samplesAll.map(s=>LABELS.indexOf(s.lab));
const lr=0.5,l2=1e-4,epochs=600;
for(let ep=0;ep<epochs;ep++){const grad=Array.from({length:L},()=>new Float64Array(D));
  for(let i=0;i<xs.length;i++){const x=xs[i],lg=new Float64Array(L);let mx=-1e9;
    for(let c=0;c<L;c++){let s=0;for(let d=0;d<D;d++)s+=W[c][d]*x[d];lg[c]=s;if(s>mx)mx=s;}
    let Z=0;for(let c=0;c<L;c++){lg[c]=Math.exp(lg[c]-mx);Z+=lg[c];}
    for(let c=0;c<L;c++){const p=lg[c]/Z-(c===ys[i]?1:0);for(let d=0;d<D;d++)grad[c][d]+=p*x[d];}}
  for(let c=0;c<L;c++)for(let d=0;d<D;d++)W[c][d]-=lr*(grad[c][d]/xs.length+l2*W[c][d]);}
// train acc
let corr=0;for(let i=0;i<xs.length;i++){let bm=-1e9,bc=0;for(let c=0;c<L;c++){let v=0;for(let d=0;d<D;d++)v+=W[c][d]*xs[i][d];if(v>bm){bm=v;bc=c;}}if(bc===ys[i])corr++;}
console.log('train acc '+(corr/xs.length*100).toFixed(1)+'%');
const out={version:1,labels:LABELS,featDim:D-1,featSpec:'scalar13+eng5+map6',W:W.map(w=>Array.from(w))};
fs.writeFileSync('server/ai/policyNet.json',JSON.stringify(out));
console.log('저장: server/ai/policyNet.json ('+(JSON.stringify(out).length/1024).toFixed(0)+'KB)');
