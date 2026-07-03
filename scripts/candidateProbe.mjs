// per-candidate 학습 probe (2026-07-04). humanCandidates 캡처(18게임 3702결정) 활용.
// 질문: "봇이 생성한 같은 후보 리스트에서 사람이 고른 것을 예측할 수 있나?"
// = 평가기가 모르는 *새 결정정보* (blend 실패 후 유일 잔여 학습경로 — 재랭커는 원리상 중복 불가).
// ① 커버리지: 사람 수가 봇 후보에 존재하는 비율 (후보생성 갭 진단 — 없으면 봇은 그 수를 영원히 못 둠)
// ② 학습 소프트맥스 재랭커(LOGO): top-1 vs random / 봇 후보순서[0] 베이스라인
import fs from 'fs';
const dir='data/human-games';
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
const NONPLANET=new Set(['space','deep_space','transdim','lost_fleet_ship']);
const HEX=[[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
const dist=(a,b)=>(Math.abs(a.q-b.q)+Math.abs(a.q+a.r-b.q-b.r)+Math.abs(a.r-b.r))/2;
const isPlanet=t=>t.type&&!NONPLANET.has(t.type)&&!(t.type||'').startsWith('ship_');
const TRACKS=['terraforming','navigation','artificialIntelligence','gaiaProject','economy','science'];
const CTYPES=['build_mine','upgrade_structure','advance_research','enter_spaceship','place_gaiaformer',
  'use_power_action','form_federation','use_ship_action','use_tech_action','use_special_action',
  'use_bonus_action','take_twilight_artifact','pass_round','convert_resource','other'];

// 사람 액션 → 후보 매처. null=매칭불가(스킵), -1=후보에 없음(커버리지 갭)
function matchCandidate(e, cands){
  const a=(e.action||''), d=(e.details||''), tid=e.tileId;
  const find=(pred)=>{const i=cands.findIndex(pred);return i;};
  if(/^Built Mine|^Placed Mine/i.test(a)) return find(c=>c.type==='build_mine'&&c.tileId===tid);
  if(/^Advanced Research/i.test(a)){
    const m=d.match(/^(\w+) to level/i); if(!m)return null;
    const tr=m[1].toLowerCase();
    return find(c=>c.type==='advance_research'&&(c.trackId||'').toLowerCase()===tr);
  }
  if(/^Upgraded to Trading/i.test(a)) return find(c=>c.type==='upgrade_structure'&&c.target==='trading_station'&&c.tileId===tid);
  if(/^Upgraded to Research Lab/i.test(a)) return find(c=>c.type==='upgrade_structure'&&c.target==='research_lab'&&c.tileId===tid);
  if(/^Academy|Upgraded to Academy/i.test(a)) return find(c=>c.type==='upgrade_structure'&&String(c.target||'').startsWith('academy')&&c.tileId===tid);
  if(/Planetary Institute/i.test(a)) return find(c=>c.type==='upgrade_structure'&&c.target==='planetary_institute'&&c.tileId===tid);
  if(/^Entered Ship/i.test(a)) return find(c=>c.type==='enter_spaceship'&&c.tileId===tid);
  if(/^Placed Gaiaformer/i.test(a)) return find(c=>c.type==='place_gaiaformer'&&c.tileId===tid);
  if(/^Formed Federation|^Federation$/i.test(a)) return find(c=>c.type==='form_federation');
  if(/^Power Action/i.test(a)){
    const kw = /ore/i.test(d)?'ore' : /credit/i.test(d)?'credit' : /knowledge/i.test(d)?'knowledge'
      : /token/i.test(d)?'token' : /step|terraform/i.test(d)?'step' : null;
    if(!kw)return null;
    const kwMatch=(id)=>({ore:/ore/,credit:/credit/,knowledge:/knowledge/,token:/token/,step:/step/}[kw]).test(id);
    const hits=cands.map((c,i)=>({c,i})).filter(x=>x.c.type==='use_power_action'&&kwMatch(String(x.c.actionId||'')));
    if(hits.length===1)return hits[0].i;
    return null; // 모호하면 스킵(보수적)
  }
  return null; // 그 외 타입은 매칭 규칙 없음 → 스킵
}

// 보드 재생 (probeTile과 동일)
function applyEvent(owner,struct,e){const tid=e.tileId;if(!tid)return;const a=e.action||'';
  if(/Placed Starting Mine|Built Mine|Placed Mine/i.test(a)){owner[tid]=e.playerId;struct[tid]='mine';}
  else if(/Upgraded to Trading/i.test(a)){owner[tid]=e.playerId;struct[tid]='trading_station';}
  else if(/Upgraded to Research Lab/i.test(a)){owner[tid]=e.playerId;struct[tid]='research_lab';}
  else if(/Academy/i.test(a)){owner[tid]=e.playerId;struct[tid]='academy';}
  else if(/Planetary Institute/i.test(a)){owner[tid]=e.playerId;struct[tid]='planetary_institute';}}

// 후보 피처: type one-hot + 기하(타일후보) + 상태 소수
function candFeat(c, ctx){
  const t=CTYPES.indexOf(CTYPES.includes(c.type)?c.type:'other');
  const oneHot=new Array(CTYPES.length).fill(0); oneHot[t]=1;
  let dOwn=0,adjOwn=0,dOpp=0,newType=0,tfSteps=0,dShip=0;
  if(c.tileId&&ctx.geom.has(c.tileId)&&(c.type==='build_mine'||c.type==='place_gaiaformer'||c.type==='enter_spaceship')){
    const tile=ctx.geom.get(c.tileId);
    const md=arr=>arr.length?Math.min(...arr.map(s=>dist(tile,s))):9;
    dOwn=Math.min(md(ctx.mine),9)/9; dOpp=Math.min(md(ctx.opp),9)/9; dShip=Math.min(md(ctx.ships),9)/9;
    adjOwn=ctx.mine.filter(m=>dist(m,tile)===1).length/6;
    newType=ctx.myTypes.has(tile.type)?0:1;
  }
  // advance_research: 그 트랙 현재 레벨 (완주성)
  let trLevel=0;
  if(c.type==='advance_research'&&c.trackId){
    trLevel=(ctx.research[c.trackId]||0)/5;
  }
  // upgrade: 티어
  const upTier=c.type==='upgrade_structure'?(c.target==='trading_station'?0.33:String(c.target).startsWith('academy')||c.target==='planetary_institute'?1:0.66):0;
  return [...oneHot,dOwn,adjOwn,dOpp,dShip,newType,trLevel,upTier,ctx.round/6,ctx.ore/10,ctx.credits/15,ctx.knowledge/10,ctx.qic/5];
}

const games=[];
let total=0,matched=0,missing=0,skipped=0;
const missingByType={};
for(const f of files){let g;try{g=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8'))}catch{continue}
  if(!Array.isArray(g.map)||!g.map.length)continue;
  const geom=new Map();for(const t of g.map)if(t.q!=null)geom.set(t.id,{q:t.q,r:t.r,type:t.type,sector:t.sector,id:t.id});
  const fl=[...(g.fullGameLog||[])].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
  const journal=(g.actionJournal||[]).filter(e=>e.timestamp!=null).sort((a,b)=>a.timestamp-b.timestamp);
  const owner={},struct={};let fi=0;const decs=[];
  for(const e of journal){
    while(fi<fl.length&&(fl[fi].timestamp||0)<e.timestamp){applyEvent(owner,struct,fl[fi]);fi++;}
    if(!e.candidates||e.candidates.length<2)continue;
    total++;
    const idx=matchCandidate(e,e.candidates);
    if(idx===null){skipped++;continue;}
    if(idx<0){missing++;const k=(e.action||'').replace(/\s*[:(].*/,'').trim();missingByType[k]=(missingByType[k]||0)+1;continue;}
    matched++;
    // 컨텍스트 (결정시점)
    const pid=e.playerId;
    const tiles=[...geom.values()];
    const mine=tiles.filter(t=>owner[t.id]===pid&&isPlanet(t));
    const opp=tiles.filter(t=>owner[t.id]&&owner[t.id]!==pid);
    const ships=tiles.filter(t=>(t.type||'').startsWith('ship_'));
    const myTypes=new Set(mine.map(t=>t.type));
    const pb=e.playerBefore||{},r=pb.resources||{};
    const ctx={geom,mine,opp,ships,myTypes,research:pb.research||{},round:e.round||1,
      ore:r.ore??0,credits:r.credits??0,knowledge:r.knowledge??0,qic:r.qic??0};
    const feats=e.candidates.map(c=>candFeat(c,ctx));
    decs.push({feats,chosen:idx,n:e.candidates.length});
  }
  if(decs.length)games.push(decs);
}
console.log(`결정 ${total} | 매칭성공 ${matched} | ★후보에 없음 ${missing} (${(missing/(matched+missing)*100).toFixed(1)}% = 후보생성 갭) | 매칭규칙없어 스킵 ${skipped}`);
console.log(`후보에 없던 사람 수 top5: ${Object.entries(missingByType).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>k+':'+v).join(', ')}`);
const all=games.flat();
const avgN=all.reduce((a,d)=>a+d.n,0)/all.length;
console.log(`\n학습 결정 ${all.length} (게임 ${games.length}), 평균 후보 ${avgN.toFixed(1)} → random ${(100/avgN).toFixed(1)}%`);
// 봇 후보순서 [0] 베이스라인
let pos0=0; for(const d of all)if(d.chosen===0)pos0++;
console.log(`봇 후보순서[0] 베이스라인: ${(pos0/all.length*100).toFixed(1)}%`);

// 소프트맥스 랭커 (probeTile과 동일)
const D=all[0].feats[0].length;
function train(decs){
  const w=new Array(D).fill(0);const lr=0.3;
  for(let ep=0;ep<250;ep++){const g=new Array(D).fill(0);
    for(const d of decs){
      const sc=d.feats.map(f=>f.reduce((s,v,i)=>s+v*w[i],0));
      const mx=Math.max(...sc);let Z=0;const ex=sc.map(s=>{const e=Math.exp(s-mx);Z+=e;return e;});
      for(let c=0;c<d.feats.length;c++){const p=ex[c]/Z-(c===d.chosen?1:0);for(let i=0;i<D;i++)g[i]+=p*d.feats[c][i];}
    }
    for(let i=0;i<D;i++)w[i]-=lr*(g[i]/decs.length+0.001*w[i]);
  }
  return w;
}
let hit=0,n=0,hit3=0;
for(let gi=0;gi<games.length;gi++){
  const tr=games.filter((_,i)=>i!==gi).flat();
  const w=train(tr);
  for(const d of games[gi]){
    const sc=d.feats.map(f=>f.reduce((s,v,i)=>s+v*w[i],0));
    const order=sc.map((s,i)=>i).sort((a,b)=>sc[b]-sc[a]);
    if(order[0]===d.chosen)hit++;
    if(order.slice(0,3).includes(d.chosen))hit3++;
    n++;
  }
}
console.log(`\n=== 학습 재랭커 (LOGO) ===`);
console.log(`top-1: ${(hit/n*100).toFixed(1)}%  top-3: ${(hit3/n*100).toFixed(1)}%  (n=${n})`);
console.log(`vs random ${(100/avgN).toFixed(1)}% / 봇순서[0] ${(pos0/all.length*100).toFixed(1)}%`);
const wAll=train(all);
const NAMES=[...CTYPES.map(t=>'T:'+t.slice(0,12)),'dOwn','adjOwn','dOpp','dShip','newType','trLevel','upTier','round','ore','cred','know','qic'];
console.log(`\n가중치: ${NAMES.map((nm,i)=>nm+'='+wAll[i].toFixed(2)).join(' ')}`);
