/**
 * 옵션 2(자기대국 + 휴리스틱 튜닝) 구현: Evaluator 가중치를 탐색해서 저장.
 *
 * 전제: 서버가 실행 중이어야 함.
 *   터미널 1: npm run dev
 *   터미널 2: TUNE_GAMES=1000 npm run tune-ai
 *
 * 결과: server/ai/aiWeights.json 에 베스트 가중치 저장 (서버 재시작 시 자동 적용)
 */

import { io as ioClient, type Socket } from 'socket.io-client';
import fs from 'fs';
import path from 'path';

type EvaluatorWeights = Record<string, number>;
type EvaluatorWeightsProfile = {
  global: EvaluatorWeights;
  byFaction?: Record<string, EvaluatorWeights>;
};
type WeightsPayload = EvaluatorWeights | EvaluatorWeightsProfile;

const FAST_TUNE = String(process.env.FAST_TUNE || '').trim() === '1';
const PORT = Number(process.env.SELF_PLAY_PORT) || Number(process.env.PORT) || 5000;
const BASE_URL = process.env.SELF_PLAY_BASE_URL || `http://localhost:${PORT}`;

const TOTAL_GAMES = Math.max(10, Math.min(5000, Number(process.env.TUNE_GAMES) || (FAST_TUNE ? 200 : 1000)));
const GAMES_PER_CANDIDATE = Math.max(5, Math.min(60, Number(process.env.TUNE_GPC) || (FAST_TUNE ? 10 : 20)));
const CANDIDATES = Math.max(2, Math.floor(TOTAL_GAMES / GAMES_PER_CANDIDATE));
const GAME_TIMEOUT_MS = (Number(process.env.TUNE_GAME_TIMEOUT_MIN) || (FAST_TUNE ? 20 : 45)) * 60 * 1000;

const OUT_PATH = process.env.AI_WEIGHTS_OUTPUT || path.join(process.cwd(), 'server', 'ai', 'aiWeights.json');

function saveWeights(weights: WeightsPayload) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(weights, null, 2));
}

function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE_URL, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

function emitAsync<T = any>(socket: Socket, event: string, payload: any): Promise<T> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res: T) => resolve(res));
  });
}

async function setWeights(socket: Socket, weights: WeightsPayload) {
  const token = process.env.AI_TUNING_TOKEN;
  const res: any = await emitAsync(socket, 'admin_set_ai_weights', { weights, token });
  if (res?.error) throw new Error(res.error);
  return res.weights as WeightsPayload;
}

async function getWeights(socket: Socket) {
  const res: any = await emitAsync(socket, 'admin_get_ai_weights', {});
  if (res?.error) throw new Error(res.error);
  return res.weights as WeightsPayload;
}

/** 서버 MCTS 생각 시간(ms) 설정. tune 중에는 짧게(기본 1000). null이면 복원 */
async function setMctsTimeMs(socket: Socket, timeMs: number | null) {
  const token = process.env.AI_TUNING_TOKEN;
  const res: any = await emitAsync(socket, 'admin_set_mcts_time_ms', { timeMs, token });
  if (res?.error) throw new Error(res.error);
}

type OneGameResult = {
  gameId: string;
  maxScore: number;
  scores: { playerId: string; name: string; faction?: string; score: number }[];
  /** winner의 건설된 건물 티어 합 (mine=1, TS/lab=2, PI/academy=3 or 4) */
  winnerStructureTierSum: number;
};

function isProfile(weights: WeightsPayload): weights is EvaluatorWeightsProfile {
  return !!weights && typeof weights === 'object' && 'global' in (weights as any);
}

function getGlobalWeights(weights: WeightsPayload): EvaluatorWeights {
  return isProfile(weights) ? weights.global : weights;
}

function getFactionWeights(weights: WeightsPayload, factionId: string): EvaluatorWeights {
  if (!isProfile(weights)) return weights;
  const patch = weights.byFaction?.[factionId] || {};
  return { ...weights.global, ...patch };
}

function upsertFactionWeights(base: WeightsPayload, factionId: string, nextFactionWeights: EvaluatorWeights): EvaluatorWeightsProfile {
  const profile: EvaluatorWeightsProfile = isProfile(base)
    ? { global: { ...base.global }, byFaction: { ...(base.byFaction || {}) } }
    : { global: { ...base }, byFaction: {} };
  profile.byFaction = profile.byFaction || {};
  profile.byFaction[factionId] = { ...nextFactionWeights };
  return profile;
}

/** 라운드 미션 등으로 1위 VP만 보면 왜곡되므로, 튜닝 로그에는 항상 4인 전원 점수 출력 */
function formatScoreboardAll(
  scores: OneGameResult['scores'],
  opts?: { sort?: 'desc' | 'asc' }
): string {
  const dir = opts?.sort === 'asc' ? 1 : -1;
  const sorted = [...scores].sort((a, b) => dir * (a.score - b.score));
  return sorted
    .map((s) => {
      const label = s.faction || s.name || s.playerId.slice(0, 8);
      return `${label}=${s.score}`;
    })
    .join(' | ');
}

function structureTier(structure: string, faction: string): number {
  switch (structure) {
    case 'mine': case 'lost_planet_mine': return 1;
    case 'trading_station': return 2;
    case 'research_lab': return 2;
    case 'planetary_institute': return (faction === 'bescods' || faction === 'ivits') ? 4 : 3;
    case 'academy': return (faction === 'bescods' || faction === 'ivits') ? 4 : 3;
    default: return 0;
  }
}

function computeStructureTierSum(map: any[], playerId: string, faction: string): number {
  let sum = 0;
  for (const t of map || []) {
    if (t.ownerId === playerId && t.structure && t.structure !== 'ship') {
      sum += structureTier(t.structure, faction);
    }
    if (t.parasiticMine?.ownerId === playerId) sum += 1;
  }
  return sum;
}

function runOneGame(socket: Socket): Promise<OneGameResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('game_updated');
      reject(new Error('Game timeout'));
    }, GAME_TIMEOUT_MS);

    socket.emit('create_game', { playerName: 'TuneRunner' }, (res: any) => {
      if (res?.error) {
        clearTimeout(timeout);
        reject(new Error(res.error));
        return;
      }
      const { gameId } = res;
      socket.on('game_updated', (updated: any) => {
        if (updated.currentPhase !== 'gameEnd') return;
        clearTimeout(timeout);
        socket.off('game_updated');
        const players = updated.players || {};
        const scores = Object.entries(players).map(([playerId, p]: [string, any]) => ({
          playerId,
          name: p.name || playerId,
          faction: p.faction,
          score: typeof p.score === 'number' ? p.score : 0,
        }));
        const maxScore = Math.max(...scores.map(s => s.score));
        const winnerId = scores.find(s => s.score === maxScore)?.playerId;
        const winner = winnerId ? players[winnerId] : null;
        const map = updated.map || [];
        const winnerStructureTierSum = winnerId && winner
          ? computeStructureTierSum(map, winnerId, winner.faction || '')
          : 0;
        resolve({
          gameId: updated.id || gameId,
          maxScore,
          scores,
          winnerStructureTierSum,
        });
      });
      socket.emit('auto_setup_test', { gameId, selfPlay: true });
    });
  });
}

function randn(): number {
  // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function mutate(base: EvaluatorWeights, sigma = 0.18): EvaluatorWeights {
  const out: EvaluatorWeights = { ...base };
  const keys = Object.keys(out);
  for (const k of keys) {
    const x = out[k];
    if (typeof x !== 'number' || !Number.isFinite(x)) continue;
    // multiplicative jitter around base; keep sign positive
    const factor = Math.exp(randn() * sigma);
    out[k] = Math.max(0, x * factor);
  }
  return out;
}

async function evalCandidate(socket: Socket, weights: WeightsPayload, games: number) {
  await setWeights(socket, weights);
  const maxScores: number[] = [];
  const winnerStructureTierSums: number[] = [];
  const allResults: OneGameResult[] = [];
  let failures = 0;
  const startedAt = Date.now();
  const logEvery = Math.max(1, Number(process.env.TUNE_LOG_EVERY) || (FAST_TUNE ? 10 : 1));

  for (let i = 0; i < games; i++) {
    try {
      const r = await runOneGame(socket);
      allResults.push(r);
      maxScores.push(r.maxScore);
      winnerStructureTierSums.push(r.winnerStructureTierSum);
      if (((i + 1) % logEvery) === 0) {
        const elapsedMs = Date.now() - startedAt;
        const done = i + 1;
        const avgMs = elapsedMs / done;
        const remaining = games - done;
        const etaMs = remaining * avgMs;
        const avgWinnerSoFar = maxScores.reduce((a, b) => a + b, 0) / maxScores.length;
        const avgTierSoFar = winnerStructureTierSums.length
          ? winnerStructureTierSums.reduce((a, b) => a + b, 0) / winnerStructureTierSums.length
          : 0;
        console.log(
          `[tune-ai]   game ${done}/${games} allVP=[${formatScoreboardAll(r.scores)}] winnerVP=${r.maxScore} ` +
          `avgWinnerVP=${avgWinnerSoFar.toFixed(1)} avgWinnerStructureTierSum=${avgTierSoFar.toFixed(1)} ` +
          `elapsed=${(elapsedMs / 1000).toFixed(0)}s ETA=${(etaMs / 1000).toFixed(0)}s`
        );
      }
    } catch (e) {
      failures++;
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(`[tune-ai]   game ${i + 1}/${games} failed (failures=${failures}) reason=${reason}`);
    }
  }

  const targetFaction = (process.env.TUNE_FACTION || '').trim();
  const targetFactionScores: number[] = [];
  if (targetFaction) {
    for (const r of allResults) {
      for (const s of r.scores) {
        if (s.faction === targetFaction) targetFactionScores.push(s.score);
      }
    }
  }

  const avgWinner = maxScores.length ? maxScores.reduce((a, b) => a + b, 0) / maxScores.length : 0;
  const avgTargetFaction = targetFactionScores.length
    ? targetFactionScores.reduce((a, b) => a + b, 0) / targetFactionScores.length
    : 0;
  const avgWinnerStructureTierSum = winnerStructureTierSums.length
    ? winnerStructureTierSums.reduce((a, b) => a + b, 0) / winnerStructureTierSums.length
    : 0;
  const finished = maxScores.length;
  const finishRate = games > 0 ? finished / games : 0;
  // Penalize unstable candidates that timeout/fail often.
  const reliabilityPenalty = Math.max(0, 1 - finishRate) * 20;
  const baseScore = targetFaction ? avgTargetFaction : avgWinner;
  const adjustedScore = baseScore - reliabilityPenalty;
  return { avgWinner, avgTargetFaction, avgWinnerStructureTierSum, finished, failures, finishRate, adjustedScore, targetFactionSamples: targetFactionScores.length };
}

const TUNE_MCTS_MS = Number(process.env.TUNE_MCTS_MS) || (FAST_TUNE ? 300 : 1500);

async function main() {
  console.log(`[tune-ai] Connecting to ${BASE_URL}`);
  if (FAST_TUNE) {
    console.log('[tune-ai] FAST_TUNE=1 enabled (faster/less stable estimates)');
  }
  console.log(`[tune-ai] Budget: totalGames=${TOTAL_GAMES}, candidates=${CANDIDATES}, gamesPerCandidate=${GAMES_PER_CANDIDATE}, MCTS=${TUNE_MCTS_MS}ms`);
  const runForever = String(process.env.TUNE_RUN_FOREVER || '').trim() === '1';
  const updateEvery = Math.max(1, Number(process.env.TUNE_UPDATE_EVERY) || (FAST_TUNE ? 5 : 10));
  const reshuffleEvery = Math.max(5, Number(process.env.TUNE_RESHUFFLE_EVERY) || (FAST_TUNE ? 25 : 20));
  if (runForever) {
    console.log(`[tune-ai] RUN_FOREVER enabled: updateEvery=${updateEvery} games, reshuffleEvery=${reshuffleEvery} games`);
  }
  if (updateEvery < 10) {
    console.log(`[tune-ai] 권장: 평가당 게임 수가 적으면 분산이 커서 개선이 잘 안 보일 수 있음. TUNE_UPDATE_EVERY=10 이상 권장`);
  }
  const socket = await connect();
  let bestScore = -Infinity;
  try {
    await setMctsTimeMs(socket, TUNE_MCTS_MS);
    console.log(`[tune-ai] Server MCTS set to ${TUNE_MCTS_MS}ms for this run`);

    const base = await getWeights(socket);
    const targetFaction = (process.env.TUNE_FACTION || '').trim();
    if (targetFaction) {
      console.log(`[tune-ai] Faction-specific tuning enabled: ${targetFaction}`);
    }

    let bestWeights: WeightsPayload = isProfile(base)
      ? { global: { ...base.global }, byFaction: { ...(base.byFaction || {}) } }
      : { ...base };
    let totalEvaluatedGames = 0;

    const sigma = Number(process.env.TUNE_SIGMA) || 0.20;
    const minDelta = Number(process.env.TUNE_MIN_IMPROVEMENT) || (FAST_TUNE ? 0.3 : 0.7);

    const evalAndMaybeUpdate = async (label: string, weights: WeightsPayload, games: number) => {
      const res = await evalCandidate(socket, weights, games);
      totalEvaluatedGames += games;
      const bestStr = bestScore > -Infinity ? ` currentBest=${bestScore.toFixed(2)}` : '';
      console.log(
        `[tune-ai] ${label} avgWinnerVP=${res.avgWinner.toFixed(2)}` +
        `${targetFaction ? ` avg(${targetFaction})=${res.avgTargetFaction.toFixed(2)} samples=${res.targetFactionSamples}` : ''} ` +
        `adjusted=${res.adjustedScore.toFixed(2)} ` +
        `finishRate=${(res.finishRate * 100).toFixed(0)}% avgWinnerStructureTierSum=${res.avgWinnerStructureTierSum.toFixed(1)}` +
        `${bestStr} (finished=${res.finished}, failures=${res.failures}, totalGames=${totalEvaluatedGames})`
      );
      return res;
    };

    const passesBudget = () => runForever ? true : (totalEvaluatedGames < TOTAL_GAMES);

    // Baseline first
    console.log('[tune-ai] Evaluating baseline...');
    {
      const res = await evalAndMaybeUpdate('baseline', base, updateEvery);
      bestScore = res.adjustedScore;
      saveWeights(bestWeights);
      console.log(`[tune-ai] Current best saved to ${OUT_PATH} (중단해도 여기까지 유지)`);
    }

    // Running mode: keep proposing a new candidate, evaluate, update best. Periodically re-evaluate best ("reshuffle").
    let cycle = 0;
    while (passesBudget()) {
      cycle++;
      const candidate = targetFaction
        ? upsertFactionWeights(bestWeights, targetFaction, mutate(getFactionWeights(bestWeights, targetFaction), sigma))
        : (isProfile(bestWeights)
          ? { global: mutate(bestWeights.global, sigma), byFaction: { ...(bestWeights.byFaction || {}) } }
          : mutate(getGlobalWeights(bestWeights), sigma));
      const res = await evalAndMaybeUpdate(`cand cycle=${cycle}`, candidate, updateEvery);
      const score = res.adjustedScore;
      const minFinished = Math.max(3, Math.floor(updateEvery * 0.7));
      const accept = (score - bestScore) >= minDelta && res.finished >= minFinished;
      if (accept) {
        bestScore = score;
        bestWeights = candidate;
        saveWeights(bestWeights);
        console.log(`[tune-ai] NEW BEST(adjusted): ${bestScore.toFixed(2)} → ${OUT_PATH} 저장됨`);
      }

      if (runForever && (totalEvaluatedGames % reshuffleEvery === 0)) {
        console.log(`[tune-ai] Reshuffle @ ${totalEvaluatedGames} games: re-evaluating current best...`);
        const reshuffleRes = await evalAndMaybeUpdate('best@checkpoint', bestWeights, updateEvery);
        if (reshuffleRes.finished >= Math.max(3, Math.floor(updateEvery * 0.7))) {
          bestScore = reshuffleRes.adjustedScore;
          console.log(`[tune-ai] bestScore 보정(adjusted) → ${bestScore.toFixed(2)}`);
        }
      }

      if (!runForever && totalEvaluatedGames >= TOTAL_GAMES) break;
    }

    console.log(`[tune-ai] Best weights in ${OUT_PATH}`);
    await setWeights(socket, bestWeights);
    console.log(`[tune-ai] Done. Best adjustedScore=${bestScore.toFixed(2)}`);
  } finally {
    try {
      await setMctsTimeMs(socket, null);
    } catch (e) {
      console.error('[tune-ai] Failed to restore MCTS time override:', e);
    }
    socket.disconnect();
  }
}

main().catch(err => {
  console.error('[tune-ai] Fatal:', err);
  process.exit(1);
});

