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
  /** winner의 6라운드 수입 합 (roundIncomeTotals[6]) */
  winnerRound6Income?: { ore: number; credits: number; knowledge: number; qic: number; powerCharge: number; powerTokens: number };
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
        const winnerId = scores.find(s => s.score === maxScore)?.playerId;
        const winner = winnerId ? players[winnerId] : null;
        const r6 = winner?.roundIncomeTotals?.[6];
        resolve({
          gameId: updated.id || gameId,
          maxScore,
          scores,
          winnerRound6Income: r6 ? {
            ore: r6.ore ?? 0,
            credits: r6.credits ?? 0,
            knowledge: r6.knowledge ?? 0,
            qic: r6.qic ?? 0,
            powerCharge: r6.powerCharge ?? 0,
            powerTokens: r6.powerTokens ?? 0,
          } : undefined,
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

function sumRound6Income(x?: { ore: number; credits: number; knowledge: number; qic: number; powerCharge: number; powerTokens: number }) {
  if (!x) return 0;
  return (x.ore || 0) + (x.credits || 0) + (x.knowledge || 0) + (x.qic || 0) + (x.powerCharge || 0) + (x.powerTokens || 0);
}

async function evalCandidate(socket: Socket, weights: EvaluatorWeights, games: number) {
  await setWeights(socket, weights);
  const maxScores: number[] = [];
  const winnerR6Income: number[] = [];
  let failures = 0;
  const startedAt = Date.now();
  const logEvery = Math.max(1, Number(process.env.TUNE_LOG_EVERY) || 1);

  for (let i = 0; i < games; i++) {
    try {
      const r = await runOneGame(socket);
      maxScores.push(r.maxScore);
      winnerR6Income.push(sumRound6Income(r.winnerRound6Income));
      if (((i + 1) % logEvery) === 0) {
        const elapsedMs = Date.now() - startedAt;
        const done = i + 1;
        const avgMs = elapsedMs / done;
        const remaining = games - done;
        const etaMs = remaining * avgMs;
        const avgWinnerSoFar = maxScores.reduce((a, b) => a + b, 0) / maxScores.length;
        const avgR6SoFar = winnerR6Income.reduce((a, b) => a + b, 0) / Math.max(1, winnerR6Income.length);
        console.log(
          `[tune-ai]   game ${done}/${games} winnerVP=${r.maxScore} avgWinnerVP=${avgWinnerSoFar.toFixed(1)} ` +
          `avgWinnerR6Income=${avgR6SoFar.toFixed(1)} elapsed=${(elapsedMs / 1000).toFixed(0)}s ETA=${(etaMs / 1000).toFixed(0)}s`
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
  const avgWinnerR6 = winnerR6Income.length ? winnerR6Income.reduce((a, b) => a + b, 0) / winnerR6Income.length : 0;
  return { avgWinner, avgWinnerR6, finished: maxScores.length, failures };
}

const TUNE_MCTS_MS = Number(process.env.TUNE_MCTS_MS) || 1000;

async function main() {
  console.log(`[tune-ai] Connecting to ${BASE_URL}`);
  console.log(`[tune-ai] Budget: totalGames=${TOTAL_GAMES}, candidates=${CANDIDATES}, gamesPerCandidate=${GAMES_PER_CANDIDATE}, MCTS=${TUNE_MCTS_MS}ms`);
  const runForever = String(process.env.TUNE_RUN_FOREVER || '').trim() === '1';
  const updateEvery = Math.max(1, Number(process.env.TUNE_UPDATE_EVERY) || GAMES_PER_CANDIDATE);
  const reshuffleEvery = Math.max(5, Number(process.env.TUNE_RESHUFFLE_EVERY) || 20);
  if (runForever) {
    console.log(`[tune-ai] RUN_FOREVER enabled: updateEvery=${updateEvery} games, reshuffleEvery=${reshuffleEvery} games`);
  }
  const socket = await connect();

  await setMctsTimeMs(socket, TUNE_MCTS_MS);
  console.log(`[tune-ai] Server MCTS set to ${TUNE_MCTS_MS}ms for this run`);

  const base = await getWeights(socket);

  let bestWeights = { ...base };
  let bestScore = -Infinity;
  let totalEvaluatedGames = 0;

  const sigma = Number(process.env.TUNE_SIGMA) || 0.18;

  const evalAndMaybeUpdate = async (label: string, weights: EvaluatorWeights, games: number) => {
    const res = await evalCandidate(socket, weights, games);
    totalEvaluatedGames += games;
    console.log(
      `[tune-ai] ${label} avgWinnerVP=${res.avgWinner.toFixed(1)} avgWinnerR6Income=${res.avgWinnerR6.toFixed(1)} ` +
      `(finished=${res.finished}, failures=${res.failures}, totalGamesEvaluated=${totalEvaluatedGames})`
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

    // "맵 바꾸기"는 create_game마다 랜덤이라 매 판 이미 바뀜.
    // 여기서는 주기적으로 bestWeights를 다시 측정해(reshuffle) 노이즈에 끌리지 않게 한다.
    if (runForever && (totalEvaluatedGames % reshuffleEvery === 0)) {
      console.log(`[tune-ai] Reshuffle checkpoint at ${totalEvaluatedGames} games: re-evaluating current best...`);
      await evalAndMaybeUpdate('best@checkpoint', bestWeights, updateEvery);
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

