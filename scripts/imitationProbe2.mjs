// 모방학습 viability PoC v2: 기존 스칼라 피처(playerBefore) + 저널 forward누적 구조물/엔진 피처를 추가해
// kNN(leave-one-game-out) 예측력이 base/v1보다 오르는지 측정. 맵 없이 기존 데이터로 엔진크기 신호를 넣는 실험.
// playerBefore엔 구조물 수가 없어서(자원/연구/타일/연방만) 엔진 크기가 피처에 누락돼 있던 걸 보완.
import fs from 'fs';
const dir = 'data/human-games';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

const MAIN = new Set(['Built Mine','Advanced Research','Upgraded to Trading Station','Upgraded to Research Lab',
  'Federation','Gained Tech Tile','Entered Ship','Academy','Power Action','Used Tech Action','Placed Gaiaformer']);
const TRACKS = ['terraforming','navigation','artificialIntelligence','gaiaProject','economy','science'];

function normLabel(action) {
  const label = (action||'').replace(/\s*[:(].*/,'').trim();
  return label === 'Built Mine' ? 'Built Mine'
    : label.startsWith('Upgraded to Trading') ? 'Upgraded to Trading Station'
    : label.startsWith('Upgraded to Research') ? 'Upgraded to Research Lab'
    : label.startsWith('Advanced Research') ? 'Advanced Research'
    : MAIN.has(label) ? label : null;
}

// 저널 forward누적 엔진 상태(맵 불필요): 이 플레이어가 지금까지 한 빌드/업글/연방/타일/가포 카운트
function emptyEng() { return { mines:0, ts:0, labs:0, big:0, feds:0, tech:0, gf:0, ships:0, builds:0 }; }
function applyEng(eng, label) {
  switch (label) {
    case 'Built Mine': eng.mines++; eng.builds++; break;
    case 'Upgraded to Trading Station': eng.mines = Math.max(0,eng.mines-1); eng.ts++; break;
    case 'Upgraded to Research Lab': eng.ts = Math.max(0,eng.ts-1); eng.labs++; break;
    case 'Academy': eng.labs = Math.max(0,eng.labs-1); eng.big++; break;
    case 'Federation': eng.feds++; break;
    case 'Gained Tech Tile': eng.tech++; break;
    case 'Placed Gaiaformer': eng.gf++; break;
    case 'Entered Ship': eng.ships++; break;
  }
}

// v1 피처(스칼라) + v2 엔진누적 피처
function feat(e, eng, useEng) {
  const pb = e.playerBefore; if (!pb) return null;
  const r = pb.resources || {};
  const res = pb.research || {};
  const base = [
    (e.round||1)/6,
    (pb.score||0)/100,
    (r.ore??0)/15, (r.credits??0)/20, (r.knowledge??0)/15, (r.qic??0)/8,
    ((r.power1??0)+(r.power2??0)+(r.power3??0))/12,
    ...TRACKS.map(t => (res[t]??0)/5),
    (pb.techTiles?.length||0)/8, (pb.federations?.length||0)/3,
  ];
  if (!useEng) return base;
  return [...base,
    eng.mines/8, eng.ts/5, eng.labs/4, eng.big/3, eng.feds/3, eng.tech/6, eng.gf/3, eng.ships/4,
    (eng.mines+eng.ts+eng.labs+eng.big)/14, // 총 구조물(엔진 크기)
  ];
}

function collect(useEng) {
  const games = [];
  for (const f of files) {
    let g; try { g = JSON.parse(fs.readFileSync(dir+'/'+f,'utf8')); } catch { continue; }
    const aj = g.actionJournal || [];
    const engByPlayer = {};
    const samples = [];
    for (const e of aj) {
      const pid = e.playerId || e.playerName || '?';
      if (!engByPlayer[pid]) engByPlayer[pid] = emptyEng();
      const eng = engByPlayer[pid];
      const norm = normLabel(e.action);
      if (norm) {
        const x = feat(e, eng, useEng);
        if (x) samples.push({ x, y: norm });
      }
      // 결정 후 엔진 상태 갱신(다음 결정의 피처에 반영)
      const lbl = (e.action||'').replace(/\s*[:(].*/,'').trim();
      const applyLbl = lbl.startsWith('Upgraded to Trading') ? 'Upgraded to Trading Station'
        : lbl.startsWith('Upgraded to Research') ? 'Upgraded to Research Lab'
        : lbl === 'Built Mine' ? 'Built Mine' : lbl;
      applyEng(eng, applyLbl);
    }
    if (samples.length) games.push(samples);
  }
  return games;
}

function dist2(a,b){let s=0;for(let i=0;i<a.length;i++){const d=a[i]-b[i];s+=d*d;}return s;}
function knnEval(games, K=15) {
  const all = games.flat();
  let correct=0, n=0;
  for (let gi=0; gi<games.length; gi++) {
    const train = games.filter((_,j)=>j!==gi).flat();
    for (const q of games[gi]) {
      const nn = train.map(t=>({y:t.y,d:dist2(q.x,t.x)})).sort((a,b)=>a.d-b.d).slice(0,K);
      const votes={}; for (const z of nn) votes[z.y]=(votes[z.y]||0)+1;
      const pred = Object.entries(votes).sort((a,b)=>b[1]-a[1])[0][0];
      if (pred===q.y) correct++; n++;
    }
  }
  return { acc: correct/n, n };
}

const g1 = collect(false), g2 = collect(true);
const all = g1.flat();
const cls = {}; for (const s of all) cls[s.y]=(cls[s.y]||0)+1;
const sorted = Object.entries(cls).sort((a,b)=>b[1]-a[1]);
const baseRate = sorted[0][1]/all.length;
console.log(`샘플 ${all.length} (게임 ${g1.length}개), 최빈클래스 ${sorted[0][0]} base ${(baseRate*100).toFixed(1)}%`);
const r1 = knnEval(g1), r2 = knnEval(g2);
console.log(`v1 (스칼라만)       kNN: ${(r1.acc*100).toFixed(1)}%  (base 대비 +${((r1.acc-baseRate)*100).toFixed(1)}%p)`);
console.log(`v2 (+엔진누적 피처) kNN: ${(r2.acc*100).toFixed(1)}%  (base 대비 +${((r2.acc-baseRate)*100).toFixed(1)}%p)`);
console.log(`엔진 피처 효과: ${((r2.acc-r1.acc)*100>=0?'+':'')}${((r2.acc-r1.acc)*100).toFixed(1)}%p`);
