// [통합 per-candidate 정책 v1] 결정 = 봇이 낸 전체 후보 중 사람 픽. 타입 one-hot + 타입별 피처(공간/트랙/파워종류).
// 목표: 전 결정타입 sibling top-1 vs 무작위 — 신호 있으면 getNextMove 재랭커/prior로 통합(다음 단계).
import fs from 'fs';
const dir='data/human-games'; const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
const dist=(a,b)=>(Math.abs(a.q-b.q)+Math.abs(a.q+a.r-b.q-b.r)+Math.abs(a.r-b.r))/2;
const NONPLANET=new Set(['space','deep_space','transdim','lost_fleet_ship']);
const TYPES=['build_mine','upgrade_structure','advance_research','use_power_action','use_ship_action','enter_spaceship','place_gaiaformer','use_tech_action','use_bonus_action','use_special_action','form_federation','take_twilight_artifact','convert_resource','pass_round','place_ivits_space_station'];
const TRACKS=['terraforming','navigation','artificialIntelligence','gaiaProject','economy','science'];
const pwCat=s=>{s=(s||'').toLowerCase();return /ore/.test(s)?0:/credit/.test(s)?1:/know/.test(s)?2:/token/.test(s)?3:/terraform|step|tf/.test(s)?4:5;};
// [v2] 우주선 액션 정확 매칭: 저널 라벨 prefix → (우주선 타입, actionIndex). 후보의 shipTileId는 로그 map의 타일 type으로 타입 판별.
const SHIPS=['ship_rebellion','ship_twilight','ship_tf_mars','ship_eclipse'];
const SHIP_LBL=[
  ['Rebellion: Gain tech tile','ship_rebellion',1],['Rebellion: Mine','ship_rebellion',2],['Rebellion: 2K','ship_rebellion',3],
  ['Twilight: Federation benefit','ship_twilight',1],['Twilight: Spaceship Fed','ship_twilight',1],['Twilight: TS','ship_twilight',2],['Twilight: +3 Range','ship_twilight',3],
  ['TF Mars: Tech tiles','ship_tf_mars',1],['TF Mars: Gaia Project','ship_tf_mars',2],['TF Mars: 3C','ship_tf_mars',3],
  ['Eclipse: Planet types','ship_eclipse',1],['Eclipse: 2K+3P','ship_eclipse',2],['Eclipse: 6C','ship_eclipse',3],
];

function matchTaken(e,cands,geom){
  const a=e.action||'',d=(e.details||'').toLowerCase(),tid=e.tileId;
  const fi=(pred)=>cands.findIndex(pred);
  if(a==='Built Mine')return fi(c=>c.type==='build_mine'&&c.tileId===tid);
  if(/^Upgraded to Trading Station/.test(a))return fi(c=>c.type==='upgrade_structure'&&c.target==='trading_station'&&c.tileId===tid);
  if(/^Upgraded to Research Lab/.test(a))return fi(c=>c.type==='upgrade_structure'&&c.target==='research_lab'&&c.tileId===tid);
  if(/^Upgraded to Planetary/.test(a))return fi(c=>c.type==='upgrade_structure'&&c.target==='planetary_institute'&&c.tileId===tid);
  if(/^Upgraded to Academy/.test(a))return fi(c=>c.type==='upgrade_structure'&&String(c.target||'').startsWith('academy')&&c.tileId===tid);
  if(a==='Advanced Research'){const dd=d.replace(/\s/g,'');return fi(c=>c.type==='advance_research'&&dd.includes(String(c.trackId||'').toLowerCase()));}
  if(a==='Power Action')return fi(c=>c.type==='use_power_action'&&pwCat(c.actionId)===pwCat(d));
  if(a==='Entered Ship')return fi(c=>c.type==='enter_spaceship'&&(!tid||c.tileId===tid));
  if(a==='Placed Gaiaformer')return fi(c=>c.type==='place_gaiaformer'&&c.tileId===tid);
  if(a==='Used Tech Action')return fi(c=>c.type==='use_tech_action'&&(!tid||c.tileId===tid));
  if(a==='Federation')return fi(c=>c.type==='form_federation');
  const sl=SHIP_LBL.find(([p])=>a.startsWith(p));
  if(sl){
    // 파라미터 캡처된 후보는 (타입, actionIndex) 정확 매칭, 아니면 예전처럼 첫 use_ship_action (타입 레벨 신호만)
    const exact=fi(c=>c.type==='use_ship_action'&&c.actionIndex===sl[2]&&geom.get(c.shipTileId)?.type===sl[1]);
    return exact>=0?exact:fi(c=>c.type==='use_ship_action');
  }
  if(/^Rebellion|^Twilight|^Eclipse|^TF Mars|^Ship Tech/.test(a))return fi(c=>c.type==='use_ship_action');
  return -1;
}

const decisions=[];
for(const f of files){let g;try{g=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8'))}catch{continue}
  if(!g.map||!g.actionJournal)continue;
  const geom=new Map();for(const t of g.map)if(t.q!=null)geom.set(t.id,{id:t.id,q:t.q,r:t.r,type:t.type,sector:t.sector});
  const owner=new Map();
  for(const e of g.actionJournal){
    const pid=e.playerId,act=e.action||'',tid=e.tileId;
    if(Array.isArray(e.candidates)&&e.candidates.length>=2&&e.playerBefore){
      const y=matchTaken(e,e.candidates,geom);
      if(y>=0){
        const mine=[...owner.entries()].filter(([,o])=>o===pid).map(([id])=>geom.get(id)).filter(Boolean);
        const res=e.playerBefore.research||{};
        const feats=e.candidates.map(c=>{
          const f=new Array(15+1+4+6+1+6+4+3).fill(0); // [v2] +우주선타입4 +액션슬롯3
          const ti=TYPES.indexOf(c.type); if(ti>=0)f[ti]=1;
          let off=15;
          const tile=c.tileId?geom.get(c.tileId):null;
          f[off]=tile?1:0; off+=1;
          if(tile&&mine.length){
            const dOwn=Math.min(...mine.map(m=>dist(m,tile)));
            f[off]=Math.min(dOwn,9)/9;
            f[off+1]=mine.filter(m=>dist(m,tile)===1).length/6;
            f[off+2]=mine.filter(m=>dist(m,tile)<=2).length/8;
            f[off+3]=(tile.type&&!NONPLANET.has(tile.type)&&!String(tile.type).startsWith('ship_'))?1:0;
          }
          off+=4;
          if(c.type==='advance_research'&&c.trackId){const k=TRACKS.indexOf(c.trackId);if(k>=0)f[off+k]=(res[c.trackId]??0)/5||0.01;}
          off+=6;
          f[off]=(e.round||1)/6; off+=1;
          if(c.type==='use_power_action')f[off+pwCat(c.actionId)]=1;
          off+=6;
          // [v2] 우주선 후보: 어느 우주선의 몇 번째 액션인지 — 파라미터 캡처(2026-07 이후) 게임만 값이 실림
          if(c.type==='use_ship_action'&&c.shipTileId){
            const st=geom.get(c.shipTileId)?.type; const si=SHIPS.indexOf(st);
            if(si>=0)f[off+si]=1;
            if(c.actionIndex>=1&&c.actionIndex<=3)f[off+4+(c.actionIndex-1)]=1;
          }
          return f;
        });
        decisions.push({cands:feats,y,takenType:e.candidates[y].type});
      }
    }
    if(/Built Mine|Placed Starting Mine|Placed Mine|Placed Gaiaformer/i.test(act)){if(tid)owner.set(tid,pid);}
    else if(/Upgraded to|Academy/i.test(act)){if(tid&&!owner.has(tid))owner.set(tid,pid);}
  }
}
const D=decisions[0].cands[0].length;
console.log('통합 결정 '+decisions.length+', 피처 '+D+', 후보평균 '+(decisions.reduce((s,d)=>s+d.cands.length,0)/decisions.length).toFixed(1));
const tr=[],va=[];decisions.forEach((d,i)=>(i%7===0?va:tr).push(d));
let w=new Float64Array(D);
const scores=d=>d.cands.map(fv=>{let s=0;for(let k=0;k<D;k++)s+=w[k]*fv[k];return s;});
const softmax=ss=>{const mx=Math.max(...ss);const ex=ss.map(s=>Math.exp(s-mx));const Z=ex.reduce((a,b)=>a+b,0);return ex.map(x=>x/Z);};
const m=new Float64Array(D),v=new Float64Array(D);const b1=0.9,b2=0.999,eps=1e-8;let t=0;
let seed=12345;const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
for(let ep=0;ep<150;ep++){
  const ord=tr.map((_,i)=>i);for(let i=ord.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[ord[i],ord[j]]=[ord[j],ord[i]];}
  for(const idx of ord){const d=tr[idx];const p=softmax(scores(d));t++;
    const g=new Float64Array(D);
    for(let c=0;c<d.cands.length;c++){const coef=p[c]-(c===d.y?1:0);const fv=d.cands[c];for(let k=0;k<D;k++)g[k]+=coef*fv[k];}
    const lrt=0.05*Math.sqrt(1-Math.pow(b2,t))/(1-Math.pow(b1,t));
    for(let k=0;k<D;k++){const gr=g[k]+1e-4*w[k];m[k]=b1*m[k]+(1-b1)*gr;v[k]=b2*v[k]+(1-b2)*gr*gr;w[k]-=lrt*m[k]/(Math.sqrt(v[k])+eps);}}
}
const evalSet=set=>{const per={};let c1=0,rnd2=0;
  for(const d of set){const p=softmax(scores(d));let bi=0;for(let c=1;c<p.length;c++)if(p[c]>p[bi])bi=c;
    per[d.takenType]=per[d.takenType]||{n:0,hit:0};per[d.takenType].n++;
    if(bi===d.y){c1++;per[d.takenType].hit++;}
    rnd2+=1/d.cands.length;}
  return {t1:c1/set.length,rand:rnd2/set.length,per};};
const va2=evalSet(va),tr2=evalSet(tr);
console.log(`train ${tr.length} val ${va.length} | val top1 ${(va2.t1*100).toFixed(1)}% (무작위 ${(va2.rand*100).toFixed(1)}%) | train ${(tr2.t1*100).toFixed(1)}%`);
console.log('타입별 val top-1:');
Object.entries(va2.per).sort((a,b)=>b[1].n-a[1].n).forEach(([k,x])=>console.log(`  ${k.padEnd(24)} n=${String(x.n).padStart(4)}  ${(x.hit/x.n*100).toFixed(0)}%`));
fs.writeFileSync('server/ai/candRankerAll.v2.json',JSON.stringify({version:2,featDim:D,types:TYPES,tracks:TRACKS,ships:SHIPS,w:[...w]}));
console.log('저장: server/ai/candRankerAll.v2.json (v1은 candRankerAll.json에 유지 — 봇 플래그 candRankerV2로 선택)');
