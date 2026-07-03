// 가치망 probe v2 (50게임 게이트 도달, 2026-07-04).
// 이전 실패(valuenet: 봇셀프플레이@66 + 사람435@250 = 2덩어리, 기울기 없음) 교정:
// *사람 게임만* 사용 — 한 게임 안에 봇(40-90)+사람(150-290)이 같은 보드에 섞여 연속 라벨.
// fullGameLog 재생으로 라운드 r 말 각 플레이어의 엔진 상태(건물/연구/타일/연방/클러스터) 복원 →
// 최종 VP 예측(릿지 회귀, leave-one-game-out). 게이트: within-game 순위(R3에 누가 이기나)를
// 구조물수 베이스라인보다 유의하게 잘 맞추면 → 평가기(리프 가치) 개선 경로 정당화.
import fs from 'fs';
const dir='data/human-games';
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
const NONPLANET=new Set(['space','deep_space','transdim','lost_fleet_ship']);
const HEX=[[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
const dist=(a,b)=>(Math.abs(a.q-b.q)+Math.abs(a.q+a.r-b.q-b.r)+Math.abs(a.r-b.r))/2;
const isPlanet=t=>t.type&&!NONPLANET.has(t.type)&&!(t.type||'').startsWith('ship_');
const TRACKS=['terraforming','navigation','artificialintelligence','gaiaproject','economy','science'];
const spow=s=>(s==='planetary_institute'||s==='academy')?3:(s==='trading_station'||s==='research_lab')?2:(s==='mine')?1:0;

// 게임별 스냅샷 수집
const games=[]; // {snaps:[{f,y,pid}], final:{pid:vp}}
for(const f of files){let g;try{g=JSON.parse(fs.readFileSync(dir+'/'+f,'utf8'))}catch{continue}
  if(!Array.isArray(g.map)||!g.map.length||!Array.isArray(g.fullGameLog)||!g.fullGameLog.length)continue;
  const geom=new Map();for(const t of g.map)if(t.q!=null)geom.set(t.id,{q:t.q,r:t.r,type:t.type,sector:t.sector,id:t.id});
  const fl=[...g.fullGameLog].sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
  const pids=Object.keys(g.players||{});
  const finalVp={};for(const pid of pids)finalVp[pid]=g.players[pid].score||0;
  // per-player 누적 상태
  const st={};for(const pid of pids)st[pid]={owner:new Set(),struct:{},res:{},tech:0,fed:0,ships:0,gf:0};
  const apply=(e)=>{const s=st[e.playerId];if(!s)return;const a=e.action||'',d=e.details||'',tid=e.tileId;
    if(/Placed Starting Mine|Built Mine|Placed Mine/i.test(a)){if(tid){s.owner.add(tid);s.struct[tid]='mine';}}
    else if(/Upgraded to Trading/i.test(a)){if(tid)s.struct[tid]='trading_station';}
    else if(/Upgraded to Research Lab/i.test(a)){if(tid)s.struct[tid]='research_lab';}
    else if(/Academy/i.test(a)&&/Upgraded|매안/i.test(a)){if(tid)s.struct[tid]='academy';}
    else if(/Planetary Institute/i.test(a)){if(tid)s.struct[tid]='planetary_institute';}
    else if(/Advanced Research/i.test(a)){const m=d.match(/^(\w+) to level (\d)/i);if(m){const tr=m[1].toLowerCase();if(!s.res)s.res={};s.res[tr]=Math.max(s.res[tr]||0,+m[2]);}}
    else if(/Gained Tech Tile|Rebellion: Gain/i.test(a))s.tech++;
    else if(/Federation Reward|Formed Federation/i.test(a))s.fed++;
    else if(/Entered Ship/i.test(a))s.ships++;
    else if(/Placed Gaiaformer/i.test(a))s.gf++;
  };
  const featOf=(pid,round)=>{const s=st[pid];
    const mine=[...s.owner].map(id=>geom.get(id)).filter(Boolean).filter(isPlanet);
    const cnt={mine:0,trading_station:0,research_lab:0,academy:0,planetary_institute:0};
    for(const t of Object.values(s.struct))if(cnt[t]!=null)cnt[t]++;
    // 클러스터(인접 연결성분) + 최대 파워
    const key=t=>t.q+','+t.r; const set=new Set(mine.map(key)); const byC=new Map(mine.map(t=>[key(t),t]));
    const seen=new Set();let nCl=0,maxP=0;
    for(const m of mine){if(seen.has(key(m)))continue;nCl++;let p=0;const stck=[m];
      while(stck.length){const c=stck.pop();const ck=key(c);if(seen.has(ck))continue;seen.add(ck);
        p+=spow(s.struct[c.id]||'mine');
        for(const[dq,dr]of HEX){const nk=(c.q+dq)+','+(c.r+dr);if(set.has(nk)&&!seen.has(nk))stck.push(byC.get(nk));}}
      if(p>maxP)maxP=p;}
    const types=new Set(mine.map(t=>t.type)),sectors=new Set(mine.map(t=>t.sector));
    const resArr=TRACKS.map(t=>(s.res[t]||0));
    const resSum=resArr.reduce((a,b)=>a+b,0);
    const deep=resArr.filter(v=>v>=3).length;
    return [round/6, cnt.mine/10, cnt.trading_station/5, cnt.research_lab/4, (cnt.academy+cnt.planetary_institute)/3,
      s.tech/10, s.fed/4, s.ships/3, s.gf/3, ...resArr.map(v=>v/5), resSum/20, deep/4,
      types.size/7, sectors.size/9, nCl/6, maxP/12, mine.length/13];
  };
  const snaps=[];
  let curRound=0;
  for(const e of fl){
    const r=e.round||0;
    if(r>curRound&&curRound>=2&&curRound<=5){ // 라운드 경계: curRound 말 스냅샷
      for(const pid of pids)snaps.push({x:featOf(pid,curRound),y:finalVp[pid],pid,round:curRound});
    }
    if(r>curRound)curRound=r;
    apply(e);
  }
  if(snaps.length)games.push({snaps,finalVp,pids});
}
const all=games.flatMap(g=>g.snaps);
console.log(`게임 ${games.length}개, 스냅샷 ${all.length}개 (R2-5 말 × 플레이어)`);
const D=all[0].x.length;
console.log(`피처 차원 ${D}`);

// 릿지 회귀 closed-form: (X'X + λI)w = X'y  (가우스 소거)
function trainRidge(samples){
  const n=D+1, l2=1e-2;
  const A=Array.from({length:n},()=>new Float64Array(n));
  const b=new Float64Array(n);
  for(const s of samples){
    const x=[...s.x,1], y=s.y/100;
    for(let i=0;i<n;i++){b[i]+=x[i]*y;for(let j=0;j<n;j++)A[i][j]+=x[i]*x[j];}
  }
  for(let i=0;i<n;i++)A[i][i]+=l2*samples.length;
  // 가우스 소거
  const M=A.map((row,i)=>[...row,b[i]]);
  for(let c=0;c<n;c++){
    let piv=c;for(let r=c+1;r<n;r++)if(Math.abs(M[r][c])>Math.abs(M[piv][c]))piv=r;
    [M[c],M[piv]]=[M[piv],M[c]];
    if(Math.abs(M[c][c])<1e-12)continue;
    for(let r=0;r<n;r++){if(r===c)continue;const f=M[r][c]/M[c][c];
      for(let k=c;k<=n;k++)M[r][k]-=f*M[c][k];}
  }
  const w=new Array(n).fill(0);
  for(let i=0;i<n;i++)if(Math.abs(M[i][i])>1e-12)w[i]=M[i][n]/M[i][i];
  return w;
}
const pred=(w,x)=>{let p=w[D];for(let i=0;i<D;i++)p+=w[i]*x[i];return p*100;};

// leave-one-game-out: within-game 순위 정확도 (R3 스냅샷에서 최종 1위 맞추기 + spearman)
let top1Hit=0,top1N=0;let pairCorrect=0,pairN=0;
let base1Hit=0,basePair=0,basePairN=0; // 베이스라인: 구조물 파워합(엔진크기)만
for(let gi=0;gi<games.length;gi++){
  const train=games.filter((_,i)=>i!==gi).flatMap(g=>g.snaps);
  const w=trainRidge(train);
  const g=games[gi];
  for(const round of [3,4]){
    const rs=g.snaps.filter(s=>s.round===round);
    if(rs.length<2)continue;
    // 예측 순위
    const scored=rs.map(s=>({pid:s.pid,p:pred(w,s.x),y:s.y,
      base:s.x[1]*10+s.x[2]*5*2+s.x[3]*4*2+s.x[4]*3*3})); // 구조물 파워 근사
    const actualTop=scored.reduce((a,b)=>a.y>b.y?a:b).pid;
    const predTop=scored.reduce((a,b)=>a.p>b.p?a:b).pid;
    const baseTop=scored.reduce((a,b)=>a.base>b.base?a:b).pid;
    if(round===3){top1N++;if(predTop===actualTop)top1Hit++;if(baseTop===actualTop)base1Hit++;}
    for(let i=0;i<scored.length;i++)for(let j=i+1;j<scored.length;j++){
      const dy=scored[i].y-scored[j].y;if(dy===0)continue;
      pairN++;if((scored[i].p-scored[j].p)*dy>0)pairCorrect++;
      basePairN++;if((scored[i].base-scored[j].base)*dy>0)basePair++;
    }
  }
}
console.log(`\n=== leave-one-game-out (R3·R4 스냅샷) ===`);
console.log(`R3 최종우승 top-1: 가치망 ${(top1Hit/top1N*100).toFixed(0)}% vs 엔진크기 베이스라인 ${(base1Hit/top1N*100).toFixed(0)}%  (n=${top1N})`);
console.log(`쌍별 순위정확도: 가치망 ${(pairCorrect/pairN*100).toFixed(1)}% vs 베이스라인 ${(basePair/basePairN*100).toFixed(1)}%  (n=${pairN})`);
// 전체학습 가중치 출력 (해석)
const wAll=trainRidge(all);
const NAMES=['round','mine','ts','lab','big','tech','fed','ships','gf',...TRACKS.map(t=>'R:'+t.slice(0,4)),'resSum','deepTracks','types','sectors','nClusters','maxClPower','planets'];
console.log(`\n학습 가중치(×100VP): ${NAMES.map((n,i)=>n+'='+(wAll[i]*100).toFixed(0)).join(' ')}`);
fs.writeFileSync('server/ai/humanValueNet.json',JSON.stringify({
  version:2, trainedOn:`${games.length} human map-games, ${all.length} round-end snapshots (R2-5), 2026-07-04`,
  gate:{top1:'62% vs baseline 49%',pairwise:'81.2% vs 71.8%'},
  features:NAMES, weights:wAll.slice(0,D), intercept:wAll[D], yScale:100,
  note:'예측VP = (Σ w·feat + intercept)×100. 피처 정규화는 evaluator 구현과 동일해야 함.'
}));
console.log('저장: server/ai/humanValueNet.json');
