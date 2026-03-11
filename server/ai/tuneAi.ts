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
};

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
        resolve({ gameId: updated.id || gameId, maxScore, scores });
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
  let failures = 0;
  const startedAt = Date.now();
  const logEvery = Math.max(1, Number(process.env.TUNE_LOG_EVERY) || 1);

  for (let i = 0; i < games; i++) {
    try {
      const r = await runOneGame(socket);
      maxScores.push(r.maxScore);
      if (((i + 1) % logEvery) === 0) {
        const elapsedMs = Date.now() - startedAt;
        const done = i + 1;
        const avgMs = elapsedMs / done;
        const remaining = games - done;
        const etaMs = remaining * avgMs;
        const avgWinnerSoFar = maxScores.reduce((a, b) => a + b, 0) / maxScores.length;
        console.log(
          `[tune-ai]   game ${done}/${games} winnerVP=${r.maxScore} avgWinnerVP=${avgWinnerSoFar.toFixed(1)} ` +
          `elapsed=${(elapsedMs / 1000).toFixed(0)}s ETA=${(etaMs / 1000).toFixed(0)}s`
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
  return { avgWinner, finished: maxScores.length, failures };
}

const TUNE_MCTS_MS = Number(process.env.TUNE_MCTS_MS) || 1000;

async function main() {
  console.log(`[tune-ai] Connecting to ${BASE_URL}`);
  console.log(`[tune-ai] Budget: totalGames=${TOTAL_GAMES}, candidates=${CANDIDATES}, gamesPerCandidate=${GAMES_PER_CANDIDATE}, MCTS=${TUNE_MCTS_MS}ms`);
  const socket = await connect();

  await setMctsTimeMs(socket, TUNE_MCTS_MS);
  console.log(`[tune-ai] Server MCTS set to ${TUNE_MCTS_MS}ms for this run`);

  const base = await getWeights(socket);

  let bestWeights = { ...base };
  let bestScore = -Infinity;

  // Always evaluate baseline first
  console.log('[tune-ai] Evaluating baseline...');
  {
    const res = await evalCandidate(socket, base, GAMES_PER_CANDIDATE);
    console.log(`[tune-ai] baseline avgWinnerVP=${res.avgWinner.toFixed(1)} (finished=${res.finished}, failures=${res.failures})`);
    bestScore = res.avgWinner;
    saveWeights(bestWeights);
    console.log(`[tune-ai] Current best saved to ${OUT_PATH} (중단해도 여기까지 유지)`);
  }

  for (let c = 1; c < CANDIDATES; c++) {
    const candidate = mutate(bestWeights, Number(process.env.TUNE_SIGMA) || 0.18);
    const res = await evalCandidate(socket, candidate, GAMES_PER_CANDIDATE);
    const score = res.avgWinner;
    console.log(`[tune-ai] cand ${c + 1}/${CANDIDATES} avgWinnerVP=${score.toFixed(1)} (finished=${res.finished}, failures=${res.failures})`);

    if (score > bestScore && res.finished >= Math.max(3, Math.floor(GAMES_PER_CANDIDATE * 0.7))) {
      bestScore = score;
      bestWeights = candidate;
      saveWeights(bestWeights);
      console.log(`[tune-ai] NEW BEST: ${bestScore.toFixed(1)} → ${OUT_PATH} 저장됨 (중단해도 유지)`);
    }
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

