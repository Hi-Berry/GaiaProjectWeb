// 맵-피처 추출 모듈 (모방학습 전제조건). HexTile q/r 축좌표로 인접/클러스터/buildable을 plain JS로 계산.
// 봇 final_state(g.map 보유)로 검증 가능 → 사람 게임에 g.map 저장(c3c0609)되면 결정시점 보드복원에 재사용.
// imitationProbe2가 입증: 스칼라/엔진카운트는 null(+3.5%p) → 위치/클러스터 피처가 진짜 leverage.

// 축좌표 6방향 인접
const HEX_DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,-1],[-1,1]];
const PLANET = t => t && t.type && !['space','deep_space'].includes(t.type) && !String(t.type).startsWith('ship');
// 연방 파워(표준 Gaia): mine1 / TS·lab2 / PI·academy3
const POWER = { mine:1, lost_planet_mine:1, trading_station:2, research_lab:2, planetary_institute:3, academy:3 };

function key(q,r){ return q+','+r; }

/** 플레이어 소유 구조물 타일들의 연결요소(클러스터)별 파워 합. 인접=q/r 6방향. */
export function clusterPowers(map, playerId) {
  const mine = map.filter(t => t.ownerId === playerId && t.structure && POWER[t.structure] != null);
  const pos = new Map(mine.map(t => [key(t.q,t.r), t]));
  const seen = new Set();
  const clusters = [];
  for (const t of mine) {
    const k0 = key(t.q,t.r);
    if (seen.has(k0)) continue;
    let power = 0; const stack = [t];
    seen.add(k0);
    while (stack.length) {
      const c = stack.pop();
      power += POWER[c.structure] || 0;
      for (const [dq,dr] of HEX_DIRS) {
        const nk = key(c.q+dq, c.r+dr);
        if (pos.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(pos.get(nk)); }
      }
    }
    clusters.push(power);
  }
  return clusters.sort((a,b)=>b-a);
}

/** 플레이어 구조물에 인접한 '빈 행성타일' 수(확장 여지의 근사 — range 무시, 인접만). */
export function buildableAdjacent(map, playerId) {
  const owned = map.filter(t => t.ownerId === playerId && t.structure);
  const empty = new Map(map.filter(t => !t.ownerId && PLANET(t)).map(t => [key(t.q,t.r), t]));
  const adj = new Set();
  for (const t of owned) for (const [dq,dr] of HEX_DIRS) {
    const nk = key(t.q+dq, t.r+dr);
    if (empty.has(nk)) adj.add(nk);
  }
  return adj.size;
}

/** 모방학습용 맵-피처 벡터(정규화). 결정 시점 보드 + 행위 플레이어. */
export function mapFeatureVector(map, playerId) {
  const owned = map.filter(t => t.ownerId === playerId && t.structure && t.structure !== 'ship');
  const cp = clusterPowers(map, playerId);
  const types = new Set(owned.map(t => t.type).filter(Boolean));
  const sectors = new Set(owned.map(t => t.sector));
  const near7 = cp.filter(p => p >= 5 && p < 7).length; // 연방 완성 임박 클러스터
  return [
    owned.length / 14,                       // 엔진 크기
    cp.length / 6,                           // 클러스터 개수(분산도)
    (cp[0] || 0) / 7,                        // 최대 클러스터 파워(연방 근접)
    near7 / 3,                               // 완성임박 클러스터 수
    buildableAdjacent(map, playerId) / 10,   // 확장 여지
    types.size / 7,                          // 행성타입 다양성(최종미션)
    sectors.size / 6,                        // 섹터 다양성(최종미션)
  ];
}

// ---- 자기검증: 봇 final_state 맵으로 피처 계산이 동작/합리적인지 확인 ----
import fs from 'fs';
if (process.argv[1] && process.argv[1].endsWith('mapFeatures.mjs')) {
  const dir = 'logs';
  const files = fs.readdirSync(dir).filter(f => f.includes('final_state')).slice(0, 200);
  let tested = 0, sumStructs = 0, sumClusters = 0, sumMaxPow = 0, sumFedReady = 0;
  for (const f of files) {
    let g; try { g = JSON.parse(fs.readFileSync(dir+'/'+f,'utf8')); } catch { continue; }
    if (!g.map || !g.map.length || g.roundNumber < 6) continue;
    for (const pid of Object.keys(g.players || {})) {
      const cp = clusterPowers(g.map, pid);
      const owned = g.map.filter(t => t.ownerId === pid && t.structure && t.structure !== 'ship');
      if (owned.length === 0) continue;
      tested++;
      sumStructs += owned.length;
      sumClusters += cp.length;
      sumMaxPow += (cp[0] || 0);
      sumFedReady += cp.filter(p => p >= 7).length;
    }
  }
  console.log(`[자기검증] 봇 ${tested}명 맵-피처 계산 성공:`);
  console.log(`  평균 구조물 ${(sumStructs/tested).toFixed(1)}, 클러스터 ${(sumClusters/tested).toFixed(1)}개, 최대클러스터파워 ${(sumMaxPow/tested).toFixed(1)}, 7+파워(연방가능) 클러스터 ${(sumFedReady/tested).toFixed(2)}개`);
  console.log(`  → 사람게임 g.map 누적되면 imitationProbe가 이 mapFeatureVector를 결정시점 보드복원에 재사용.`);
}
