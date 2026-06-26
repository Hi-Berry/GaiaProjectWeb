// 모방학습 viability PoC v3: v2(스칼라+엔진누적) + 맵 geometry 피처.
// 사람게임의 actionJournal을 forward 재생해 각 결정시점의 소유 타일을 복원하고(최종 g.map geometry 사용),
// 맵 기반 피처(소유 행성유형 다양성·섹터 분포·우주선/프로토까지 거리·인접 클러스터)를 추가.
// 맵 피처가 v2(+7.1%p)보다 예측력을 올리면 → 정책망 풀빌드 정당화(알파고 PUCT prior).
import fs from 'fs';
const dir = 'data/human-games';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

const MAIN = new Set(['Built Mine','Advanced Research','Upgraded to Trading Station','Upgraded to Research Lab',
  'Federation','Gained Tech Tile','Entered Ship','Academy','Power Action','Used Tech Action','Placed Gaiaformer']);
const TRACKS = ['terraforming','navigation','artificialIntelligence','gaiaProject','economy','science'];
const SHIP_TYPES = new Set(['ship_twilight','ship_rebellion','ship_tf_mars','ship_eclipse']);
const NONPLANET = new Set(['space','deep_space','lost_fleet_ship','ship_rebellion','ship_twilight','ship_tf_mars','ship_eclipse','asteroid','proto','gaia']);
const HEX = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
const dist = (a,b)=>(Math.abs(a.q-b.q)+Math.abs(a.q+a.r-b.q-b.r)+Math.abs(a.r-b.r))/2;
const labelOf = a => MAIN.has(a) ? a : null;

function scalarFeat(e){
  const pb=e.playerBefore; if(!pb) return null; const r=pb.resources||{}, res=pb.research||{};
  return [(e.round||1)/6,(pb.score||0)/100,(r.ore??0)/15,(r.credits??0)/20,(r.knowledge??0)/15,(r.qic??0)/8,
    ((r.power1??0)+(r.power2??0)+(r.power3??0))/12,...TRACKS.map(t=>(res[t]??0)/5),
    (pb.techTiles?.length||0)/8,(pb.federations?.length||0)/3];
}

// 게임 로드 (맵+저널 있는 것만)
const games=[];
for(const f of files){let g;try{g=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8'))}catch{continue}
  if(!g.map||!g.map.length||!g.actionJournal||!g.actionJournal.length) continue;
  const geom=new Map(); for(const t of g.map) if(t.q!=null) geom.set(t.id,{q:t.q,r:t.r,type:t.type,sector:t.sector});
  const shipTiles=[...geom.values()].filter(t=>SHIP_TYPES.has(t.type));
  const protoTiles=[...geom.values()].filter(t=>t.type==='proto'||t.type==='asteroid');
  // forward 재생: 소유 추적
  const owner=new Map(); // tileId -> playerId
  const eng={}; // pid -> cumulative engine
  const samples=[];
  for(const e of g.actionJournal){
    const pid=e.playerId, act=e.action||'', tid=e.tileId;
    // 결정 샘플 기록(소유 적용 *전* = 그 결정 시점 상태)
    const lab=labelOf(act);
    if(lab && e.playerBefore){
      const mine=[...owner.entries()].filter(([,o])=>o===pid).map(([id])=>geom.get(id)).filter(Boolean);
      const planets=mine.filter(t=>!NONPLANET.has(t.type));
      const types=new Set(planets.map(t=>t.type)), sectors=new Set(mine.map(t=>t.sector));
      const nShip=shipTiles.length&&mine.length?Math.min(...shipTiles.map(s=>Math.min(...mine.map(m=>dist(m,s))))):9;
      const nProto=protoTiles.length&&mine.length?Math.min(...protoTiles.map(s=>Math.min(...mine.map(m=>dist(m,s))))):9;
      // 인접 클러스터: 내 타일 중 다른 내 타일과 인접한 비율(연방 잠재)
      let adj=0; const set=new Set(mine.map(t=>t.q+','+t.r));
      for(const m of mine) for(const[dq,dr]of HEX) if(set.has((m.q+dq)+','+(m.r+dr))){adj++;break;}
      const en=eng[pid]||{mines:0,builds:0,ships:0,feds:0,tech:0};
      const mapFeat=[mine.length/12, types.size/7, sectors.size/8, Math.min(nShip,9)/9, Math.min(nProto,9)/9, mine.length?adj/mine.length:0];
      const engFeat=[en.mines/12,en.builds/18,en.ships/3,en.feds/3,en.tech/8];
      samples.push({f:[...scalarFeat(e),...engFeat,...mapFeat], y:lab});
    }
    // 소유/엔진 갱신
    const en=eng[pid]=eng[pid]||{mines:0,builds:0,ships:0,feds:0,tech:0};
    if(/Built Mine|Placed Starting Mine|Placed Mine/i.test(act)){if(tid)owner.set(tid,pid);en.mines++;en.builds++;}
    else if(/Upgraded to/i.test(act)){en.builds++;}
    else if(/Entered Ship/i.test(act)){en.ships++;}
    else if(/Federation/i.test(act)){en.feds++;}
    else if(/Gained Tech/i.test(act)){en.tech++;}
    else if(/Placed Gaiaformer/i.test(act)){if(tid)owner.set(tid,pid);}
  }
  if(samples.length) games.push(samples);
}

const all=games.flat();
console.log('맵보유 게임 '+games.length+', 결정샘플 '+all.length);
const dim=all[0].f.length;
// 클래스 분포 + base
const cnt={}; for(const s of all) cnt[s.y]=(cnt[s.y]||0)+1;
const base=Math.max(...Object.values(cnt))/all.length;
console.log('base-rate: '+(base*100).toFixed(1)+'%');

// kNN leave-one-game-out (정규화는 0..1 가정)
function knn(K, useMap){
  let correct=0,total=0;
  for(let gi=0; gi<games.length; gi++){
    const test=games[gi], train=games.filter((_,i)=>i!==gi).flat();
    for(const q of test){
      const qf=useMap?q.f:q.f.slice(0,dim-6); // 맵 피처(마지막 6개) 제외 옵션
      const nb=[];
      for(const t of train){
        const tf=useMap?t.f:t.f.slice(0,dim-6);
        let d=0; for(let k=0;k<qf.length;k++){const x=qf[k]-tf[k];d+=x*x;}
        nb.push([d,t.y]);
      }
      nb.sort((a,b)=>a[0]-b[0]);
      const vote={}; for(let k=0;k<K;k++){vote[nb[k][1]]=(vote[nb[k][1]]||0)+1;}
      const pred=Object.entries(vote).sort((a,b)=>b[1]-a[1])[0][0];
      if(pred===q.y)correct++; total++;
    }
  }
  return correct/total;
}
const accNoMap=knn(15,false), accMap=knn(15,true);
console.log('v2 (스칼라+엔진, 맵제외)  kNN: '+(accNoMap*100).toFixed(1)+'%  (base 대비 +'+((accNoMap-base)*100).toFixed(1)+'%p)');
console.log('v3 (+맵 geometry 피처)    kNN: '+(accMap*100).toFixed(1)+'%  (base 대비 +'+((accMap-base)*100).toFixed(1)+'%p)');
console.log('맵 피처 효과: +'+((accMap-accNoMap)*100).toFixed(1)+'%p');
console.log((accMap-base>=0.08)?'→ ★ 게이트(+8%p) 돌파! 정책망 풀빌드 정당화.':'→ 게이트 미달, 추가 데이터/피처 필요.');
