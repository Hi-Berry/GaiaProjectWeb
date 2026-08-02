// Path B — 휴리스틱 가중치 진화 하니스 (POC)
// 기존 tuneAiAuto의 결함(fitness=자가대국 절대점수 + aiWeights.json 덮어씀)을 교정:
//   - fitness = head2head(후보 challenger vs 챔피언 aiWeights.json) VP마진 = 우리가 신뢰하는 채택기준과 동일
//   - 챔피언 aiWeights.json은 절대 안 건드림. 후보는 server/ai/aiWeights.tuneCand.json에만 씀.
//   - (1+1)-ES 힐클라임 POC: best 섭동 → h2h 평가 → 마진 >= 임계면 수용. CMA-ES는 하니스 검증 후 확장.
//
// 사용: node scripts/tuneWeightsH2H.mjs [cycles] [gamesPerEval] [sigma]
//   기본 cycles=2 games=40 sigma=0.15. 결과 후보는 aiWeights.tuneCand.json + tuneWeightsH2H-log.txt.
//   ★이건 POC/스모크 — 후보가 좋아도 자동 채택 안 함. 사람이 aiWeights.json으로 승격 결정.
import fs from 'fs';
import { spawn } from 'child_process';

const ROOT = process.cwd();
const CHAMP = `${ROOT}/server/ai/aiWeights.json`;
const CAND = `${ROOT}/server/ai/aiWeights.tuneCand.json`;
const REPORT = `${ROOT}/data/h2h-tune-report.json`;
const LOG = `${ROOT}/data/tuneWeightsH2H-log.txt`;

const CYCLES = Math.max(1, Number(process.argv[2]) || 2);
const GAMES = Math.max(20, Number(process.argv[3]) || 40);
const SIGMA = Number(process.argv[4]) || 0.15;
const MIN_MARGIN = Number(process.env.MIN_MARGIN) || 1.0; // 후보 채택 최소 VP마진(POC: 노이즈 위라 보수적)

// 오늘 야간 분석이 지목한 확장/캐시아웃 관련 가중치만 섭동(전역 32차원 전체는 POC엔 과함)
// [2026-08-01 사용자 "룰을 잘 못 만드는 것 같다"] 손으로 가치 보너스를 얹는 방식이 오늘만 4연속 실패
// (reach 3종·advL4Chase). '어떤 룰을 쓸까'가 아니라 '기존 평가기 가중치를 측정이 직접 고르게' 전환.
// POC의 확장 관련 9개 → 전역 32차원 중 핵심 축 23개로 확대(자원가치·건물·연구·연방·파워·VP시점).
const TUNABLE = [
  'structureMine', 'structureTradingStation', 'structureResearchLab',
  'structurePlanetaryInstitute', 'structureAcademy',
  'researchTerraforming', 'researchNavigation', 'researchGaiaProject', 'researchEconomy', 'researchScience',
  'gaiaformerValueEach', 'federationValueEach',
  'oreValue', 'creditsValue', 'knowledgeValue', 'qicWeightEarly', 'qicWeightLate',
  'power2Value', 'power3Value', 'vpWeightEarly', 'vpWeightLate',
  'resourceMultiplierEarly', 'resourceMultiplierLate',
]

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}
function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function mutate(globalW, sigma, rng) {
  const out = { ...globalW };
  for (const k of TUNABLE) {
    if (typeof out[k] !== 'number') continue;
    // 로그정규 섭동(음수 방지, 스케일 비례)
    const factor = Math.exp((rng() * 2 - 1) * sigma);
    out[k] = Math.max(0, out[k] * factor);
  }
  return out;
}
// 시드 RNG (재현성 — 스크립트라 Math.random 써도 되지만 로그에 남기려 시드 고정)
function makeRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function runH2H(candPath, games) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      AI_CHALLENGER_WEIGHTS: candPath,        // 챌린저 = 후보 가중치 (챔피언 A = aiWeights.json)
      H2H_GAMES: String(games), H2H_MCTS_MS: '400', H2H_WORKERS: '6',
      H2H_REPORT: REPORT, H2H_BASE_PORT: '5400',
    };
    const p = spawn('cmd.exe', ['/d', '/s', '/c', 'npx tsx server/ai/headToHead.ts'], {
      cwd: ROOT, env, stdio: 'ignore', windowsHide: true,
    });
    p.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`h2h exit ${code}`));
      try {
        const r = loadJson(REPORT);
        resolve({ margin: r.vpMarginMean, se: r.vpMarginSE, winRate: r.bWinRate, weightsDiffer: r.config?.weightsDiffer });
      } catch (e) { reject(e); }
    });
  });
}

async function main() {
  fs.writeFileSync(LOG, ''); // 로그 초기화
  log(`Path B POC 시작: cycles=${CYCLES} games=${GAMES} sigma=${SIGMA} 튜닝대상=${TUNABLE.length}개`);
  log(`챔피언(불변)=${CHAMP} | 후보=${CAND} | ★aiWeights.json 절대 안 건드림`);

  const champ = loadJson(CHAMP);
  const champGlobal = champ.global || champ;
  let best = JSON.parse(JSON.stringify(champ));
  let bestMargin = 0; // 챔피언 vs 챔피언 = 0 기준

  const rng = makeRng(20260723);
  for (let c = 1; c <= CYCLES; c++) {
    const candGlobal = mutate(best.global || best, SIGMA, rng);
    const cand = best.global ? { ...best, global: candGlobal } : candGlobal;
    fs.writeFileSync(CAND, JSON.stringify(cand, null, 2));
    const changed = TUNABLE.map(k => `${k}:${(champGlobal[k] ?? 0).toFixed(0)}→${(candGlobal[k] ?? 0).toFixed(0)}`).join(' ');
    log(`cycle ${c}/${CYCLES} 평가중... ${changed}`);
    try {
      const { margin, se, winRate, weightsDiffer } = await runH2H(CAND, GAMES);
      const accepted = margin >= MIN_MARGIN;
      log(`cycle ${c}: VP마진 ${margin?.toFixed(2)}±${se?.toFixed(2)} 승률 ${(winRate * 100)?.toFixed(1)}% weightsDiffer=${weightsDiffer}${accepted ? '  <-- 수용' : ''}`);
      if (accepted && margin > bestMargin) { bestMargin = margin; best = cand.global ? cand : { global: cand }; fs.writeFileSync(CAND, JSON.stringify(best, null, 2)); }
    } catch (e) {
      log(`cycle ${c} 실패: ${e.message}`);
    }
  }
  log(`완료. bestMargin=${bestMargin.toFixed(2)} (0=챔피언 동급). 후보파일=${CAND}`);
  log(`★검토용: 이 후보를 aiWeights.json으로 승격하려면 더 큰 판수(120+)로 재검증 후 사람이 결정.`);
}
main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
