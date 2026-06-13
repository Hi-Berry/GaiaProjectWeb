// 가치망 viability 프로브: 종반(R6) 평균적 봇 상태에서 엔진 피처를 +1단위 늘렸을 때
// 모델 예측 최종VP가 오르는지 확인. 오르면 → 1-ply re-ranker로 쓰면 봇이 엔진을 더 짓도록 유도됨.
// 사용: node scripts/probeValueNet.mjs /tmp/vn_probe.json
import fs from 'fs';

const NET = process.argv[2] || '/tmp/vn_probe.json';
const w = JSON.parse(fs.readFileSync(NET, 'utf8'));

function relu(x){return x>0?x:0;}
function predict(x){
  const {dim,h1,h2,W1,b1,W2,b2,W3,b3}=w;
  const a1=[];for(let i=0;i<h1;i++){let s=b1[i];for(let j=0;j<dim;j++)s+=W1[i*dim+j]*x[j];a1[i]=relu(s);}
  const a2=[];for(let i=0;i<h2;i++){let s=b2[i];for(let j=0;j<h1;j++)s+=W2[i*h1+j]*a1[j];a2[i]=relu(s);}
  let y=b3[0];for(let j=0;j<h2;j++)y+=W3[j]*a2[j];
  return y*100;
}

// FEATURE_NAMES 순서/정규화 스케일 (features.ts와 일치)
const NAMES=['round','remainingRounds','score','ore','credits','knowledge','qic','power1','power2','power3','brainBowl',
'mines','tradingStations','labs','pInstitutes','academies','res_tf','res_nav','res_ai','res_gaia','res_econ','res_sci',
'federations','techTiles','gaiaformers','shipsEntered','planetsOwned','distinctTypes','gaiaPlanets','scoreVsMaxOpp','scoreVsMeanOpp','structsVsMeanOpp','researchSumVsMeanOpp'];
// 종반 봇 평균 상태 (앞서 측정한 R5+ 봇 평균을 정규화해 근사). round=6.
const base=new Array(33).fill(0);
base[0]=6/6; base[1]=1/6; base[2]=66/100; base[11]=5.2/8; base[12]=1.25/4; base[13]=2.0/3; base[14]=0.48/1;
base[22]=1.18/3; base[23]=2.73/6; base[25]=2.29/3; base[26]=9.24/14; base[28]=1.53/6;
// 각 엔진 피처를 "사람 수준"으로 올렸을 때 예측 변화
const probes=[
  ['techTiles 2.7→8.5', 23, (8.54)/6],
  ['gaiaPlanets 1.5→5.0', 28, 4.97/6],
  ['structures 9.2→14', 26, 13.97/14],
  ['federations 1.2→2.6', 22, 2.63/3],
  ['tradingStations 1.25→2.45', 12, 2.45/4],
  ['mines 5.2→6.9', 11, 6.88/8],
  ['shipsEntered 2.3→2.7', 25, 2.70/3],
];
const base_pred=predict(base);
console.log('기준(종반 봇 평균) 예측 최종VP:', base_pred.toFixed(1));
console.log('\n엔진 피처를 사람 수준으로 ↑ 했을 때 예측VP 변화 (양수=엔진 지을수록 좋다고 학습됨):');
for(const [label,idx,val] of probes){
  const x=base.slice(); x[idx]=val;
  const p=predict(x);
  console.log('  '+label.padEnd(26)+': '+(p>=base_pred?'+':'')+(p-base_pred).toFixed(1)+' VP  (→'+p.toFixed(1)+')');
}
