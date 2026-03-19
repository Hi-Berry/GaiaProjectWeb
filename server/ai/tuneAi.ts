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

const PORT = Number(process.env.SELF_PLAY_PORT) || Number(process.env.PORT) || 5000;
const BASE_URL = process.env.SELF_PLAY_BASE_URL || `http://localhost:${PORT}`;

const TOTAL_GAMES = Math.max(10, Math.min(5000, Number(process.env.TUNE_GAMES) || 1000));
const GAMES_PER_CANDIDATE = Math.max(5, Math.min(60, Number(process.env.TUNE_GPC) || 20));
const CANDIDATES = Math.max(2, Math.floor(TOTAL_GAMES / GAMES_PER_CANDIDATE));
const GAME_TIMEOUT_MS = 45 * 60 * 1000;

const OUT_PATH = process.env.AI_WEIGHTS_OUTPUT || path.join(process.cwd(), 'server', 'ai', 'aiWeights.json');

function saveWeights(weights: EvaluatorWeights) {
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

async function setWeights(socket: Socket, weights: EvaluatorWeights) {
  const token = process.env.AI_TUNING_TOKEN;
  const res: any = await emitAsync(socket, 'admin_set_ai_weights', { weights, token });
  if (res?.error) throw new Error(res.error);
  return res.weights as EvaluatorWeights;
}

async function getWeights(socket: Socket) {
  const res: any = await emitAsync(socket, 'admin_get_ai_weights', {});
  if (res?.error) throw new Error(res.error);
  return res.weights as EvaluatorWeights;
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

async function evalCandidate(socket: Socket, weights: EvaluatorWeights, games: number) {
  await setWeights(socket, weights);
  const maxScores: number[] = [];
  const winnerStructureTierSums: number[] = [];
  let failures = 0;
  const startedAt = Date.now();
  const logEvery = Math.max(1, Number(process.env.TUNE_LOG_EVERY) || 1);

  for (let i = 0; i < games; i++) {
    try {
      const r = await runOneGame(socket);
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
          `[tune-ai]   game ${done}/${games} winnerVP=${r.maxScore} avgWinnerVP=${avgWinnerSoFar.toFixed(1)} ` +
          `avgWinnerStructureTierSum=${avgTierSoFar.toFixed(1)} elapsed=${(elapsedMs / 1000).toFixed(0)}s ETA=${(etaMs / 1000).toFixed(0)}s`
        );
      }
    } catch {
      failures++;
      if (((i + 1) % logEvery) === 0) {
        const elapsedMs = Date.now() - startedAt;
        console.log(`[tune-ai]   game ${i + 1}/${games} failed (failures=${failures}) elapsed=${(elapsedMs / 1000).toFixed(0)}s`);
      }
    }
  }

  const avgWinner = maxScores.length ? maxScores.reduce((a, b) => a + b, 0) / maxScores.length : 0;
  const avgWinnerStructureTierSum = winnerStructureTierSums.length
    ? winnerStructureTierSums.reduce((a, b) => a + b, 0) / winnerStructureTierSums.length
    : 0;
  return { avgWinner, avgWinnerStructureTierSum, finished: maxScores.length, failures };
}

const TUNE_MCTS_MS = Number(process.env.TUNE_MCTS_MS) || 1500;

async function main() {
  console.log(`[tune-ai] Connecting to ${BASE_URL}`);
  console.log(`[tune-ai] Budget: totalGames=${TOTAL_GAMES}, candidates=${CANDIDATES}, gamesPerCandidate=${GAMES_PER_CANDIDATE}, MCTS=${TUNE_MCTS_MS}ms`);
  const runForever = String(process.env.TUNE_RUN_FOREVER || '').trim() === '1';
  const updateEvery = Math.max(1, Number(process.env.TUNE_UPDATE_EVERY) || 10);
  const reshuffleEvery = Math.max(5, Number(process.env.TUNE_RESHUFFLE_EVERY) || 20);
  if (runForever) {
    console.log(`[tune-ai] RUN_FOREVER enabled: updateEvery=${updateEvery} games, reshuffleEvery=${reshuffleEvery} games`);
  }
  if (updateEvery < 10) {
    console.log(`[tune-ai] 권장: 평가당 게임 수가 적으면 분산이 커서 개선이 잘 안 보일 수 있음. TUNE_UPDATE_EVERY=10 이상 권장`);
  }
  const socket = await connect();

  await setMctsTimeMs(socket, TUNE_MCTS_MS);
  console.log(`[tune-ai] Server MCTS set to ${TUNE_MCTS_MS}ms for this run`);

  const base = await getWeights(socket);

  let bestWeights = { ...base };
  let bestScore = -Infinity;
  let totalEvaluatedGames = 0;

  const sigma = Number(process.env.TUNE_SIGMA) || 0.20;

  const evalAndMaybeUpdate = async (label: string, weights: EvaluatorWeights, games: number) => {
    const res = await evalCandidate(socket, weights, games);
    totalEvaluatedGames += games;
    const bestStr = bestScore > -Infinity ? ` currentBest=${bestScore.toFixed(1)}` : '';
    console.log(
      `[tune-ai] ${label} avgWinnerVP=${res.avgWinner.toFixed(1)} avgWinnerStructureTierSum=${res.avgWinnerStructureTierSum.toFixed(1)}` +
      `${bestStr} (finished=${res.finished}, failures=${res.failures}, totalGames=${totalEvaluatedGames})`
    );
    return res;
  };

  const passesBudget = () => runForever ? true : (totalEvaluatedGames < TOTAL_GAMES);

  // Baseline first
  console.log('[tune-ai] Evaluating baseline...');
  {
    const res = await evalAndMaybeUpdate('baseline', base, updateEvery);
    bestScore = res.avgWinner;
    saveWeights(bestWeights);
    console.log(`[tune-ai] Current best saved to ${OUT_PATH} (중단해도 여기까지 유지)`);
  }

  // Running mode: keep proposing a new candidate, evaluate, update best. Periodically re-evaluate best ("reshuffle").
  let cycle = 0;
  while (passesBudget()) {
    cycle++;
    const candidate = mutate(bestWeights, sigma);
    const res = await evalAndMaybeUpdate(`cand cycle=${cycle}`, candidate, updateEvery);
    const score = res.avgWinner;
    const accept = score > bestScore && res.finished >= Math.max(3, Math.floor(updateEvery * 0.7));
    if (accept) {
      bestScore = score;
      bestWeights = candidate;
      saveWeights(bestWeights);
      console.log(`[tune-ai] NEW BEST: ${bestScore.toFixed(1)} → ${OUT_PATH} 저장됨 (중단해도 유지)`);
    }

    // 주기적으로 현재 best를 재측정해서 bestScore를 보정 (운으로 올라갔던 수치를 내려서, 이후 후보 수용이 잘 되게).
    if (runForever && (totalEvaluatedGames % reshuffleEvery === 0)) {
      console.log(`[tune-ai] Reshuffle @ ${totalEvaluatedGames} games: re-evaluating current best...`);
      const reshuffleRes = await evalAndMaybeUpdate('best@checkpoint', bestWeights, updateEvery);
      const newBestScore = reshuffleRes.avgWinner;
      if (reshuffleRes.finished >= Math.max(3, Math.floor(updateEvery * 0.7))) {
        bestScore = newBestScore;
        console.log(`[tune-ai] bestScore 보정 → ${bestScore.toFixed(1)} (이후 후보는 이걸 넘어야 NEW BEST)`);
      }
    }

    if (!runForever && totalEvaluatedGames >= TOTAL_GAMES) break;
  }

  console.log(`[tune-ai] Best weights in ${OUT_PATH}`);

  // Apply best to running server and restore MCTS time
  await setWeights(socket, bestWeights);
  await setMctsTimeMs(socket, null);
  socket.disconnect();

  console.log(`[tune-ai] Done. Best avgWinnerVP=${bestScore.toFixed(1)}`);
}

main().catch(err => {
  console.error('[tune-ai] Fatal:', err);
  process.exit(1);
});

