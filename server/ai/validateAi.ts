/**
 * Validate a candidate AI weights file against a baseline using held-out self-play.
 *
 * This does not train. It runs separate batches with baseline and candidate weights,
 * compares aggregate VP metrics, writes a report, and optionally promotes the
 * candidate to aiWeights.json when it clears the threshold.
 */

import { io as ioClient, type Socket } from 'socket.io-client';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

type EvaluatorWeights = Record<string, number>;
type EvaluatorWeightsProfile = {
  global: EvaluatorWeights;
  byFaction?: Record<string, EvaluatorWeights>;
};
type WeightsPayload = EvaluatorWeights | EvaluatorWeightsProfile;

type GameScore = { playerId: string; name: string; faction?: string; score: number };
type OneGameResult = { gameId: string; scores: GameScore[]; winnerScore: number };
type EvalSummary = {
  label: string;
  requestedGames: number;
  finished: number;
  failures: number;
  finishRate: number;
  avgAllVp: number;
  avgWinnerVp: number;
  avgLowestVp: number;
  avgSpread: number;
  adjustedScore: number;
};

type Worker = {
  idx: number;
  port: number;
  proc: ChildProcess;
  socket: Socket;
};

const ROOT = process.cwd();
const BASELINE_PATH = process.env.AI_BASELINE_WEIGHTS || path.join(ROOT, 'server', 'ai', 'aiWeights.json');
const CANDIDATE_PATH = process.env.AI_CANDIDATE_WEIGHTS || path.join(ROOT, 'server', 'ai', 'aiWeights.candidate.json');
const REPORT_PATH = process.env.AI_VALIDATE_REPORT || path.join(ROOT, 'data', 'ai-validation-report.json');

const WORKERS = Math.max(1, Number(process.env.VALIDATE_WORKERS) || 3);
const BASE_PORT = Math.max(1000, Number(process.env.VALIDATE_BASE_PORT) || 5200);
const GAMES = Math.max(8, Number(process.env.VALIDATE_GAMES) || 120);
const MCTS_MS = Math.max(50, Number(process.env.VALIDATE_MCTS_MS) || 500);
const GAME_TIMEOUT_MS = (Number(process.env.VALIDATE_GAME_TIMEOUT_MIN) || 35) * 60 * 1000;
const MIN_IMPROVEMENT = Number(process.env.VALIDATE_MIN_IMPROVEMENT) || 0.5;
const MIN_FINISH_RATE = Number(process.env.VALIDATE_MIN_FINISH_RATE) || 0.8;
const PROMOTE = String(process.env.VALIDATE_PROMOTE || '').trim() === '1';

function readWeights(filePath: string): WeightsPayload {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as WeightsPayload;
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
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
}

async function setMctsTimeMs(socket: Socket, timeMs: number | null) {
  const token = process.env.AI_TUNING_TOKEN;
  const res: any = await emitAsync(socket, 'admin_set_mcts_time_ms', { timeMs, token });
  if (res?.error) throw new Error(res.error);
}

function connectSocket(baseUrl: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

async function waitForServer(port: number, maxAttempts = 45): Promise<Socket> {
  const baseUrl = `http://localhost:${port}`;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await connectSocket(baseUrl);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Failed to connect validation server on port ${port}`);
}

function startServerProcess(port: number): ChildProcess {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'cmd.exe' : 'npx';
  const args = isWin ? ['/d', '/s', '/c', 'npx tsx server/index.ts'] : ['tsx', 'server/index.ts'];
  return spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'development' },
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function bootWorkers(): Promise<Worker[]> {
  const workers: Worker[] = [];
  for (let i = 0; i < WORKERS; i++) {
    const port = BASE_PORT + i;
    const proc = startServerProcess(port);
    const socket = await waitForServer(port);
    await setMctsTimeMs(socket, MCTS_MS);
    workers.push({ idx: i, port, proc, socket });
    console.log(`[validate-ai] worker #${i + 1} ready on :${port}`);
  }
  return workers;
}

async function shutdownWorkers(workers: Worker[]) {
  await Promise.all(workers.map(async (worker) => {
    try { await setMctsTimeMs(worker.socket, null); } catch { }
    try { worker.socket.disconnect(); } catch { }
    try { worker.proc.kill(); } catch { }
  }));
}

function splitGames(total: number, buckets: number): number[] {
  const base = Math.floor(total / buckets);
  const rem = total % buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < rem ? 1 : 0));
}

function runOneGame(socket: Socket): Promise<OneGameResult> {
  return new Promise((resolve, reject) => {
    let gameId = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Game timeout'));
    }, GAME_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('game_updated', onUpdate);
    };

    const onUpdate = (updated: any) => {
      if (!gameId || updated?.id !== gameId || updated.currentPhase !== 'gameEnd') return;
      cleanup();
      const scores = Object.entries(updated.players || {}).map(([playerId, p]: [string, any]) => ({
        playerId,
        name: p.name || playerId,
        faction: p.faction,
        score: typeof p.score === 'number' ? p.score : 0,
      }));
      resolve({
        gameId,
        scores,
        winnerScore: Math.max(...scores.map(s => s.score)),
      });
    };

    socket.on('game_updated', onUpdate);
    socket.emit('create_game', { playerName: 'ValidateRunner' }, (res: any) => {
      if (res?.error) {
        cleanup();
        reject(new Error(res.error));
        return;
      }
      gameId = res.gameId;
      socket.emit('auto_setup_test', { gameId, selfPlay: true });
    });
  });
}

async function evalOnWorker(worker: Worker, weights: WeightsPayload, games: number): Promise<OneGameResult[]> {
  await setWeights(worker.socket, weights);
  const results: OneGameResult[] = [];
  for (let i = 0; i < games; i++) {
    try {
      const result = await runOneGame(worker.socket);
      results.push(result);
      console.log(
        `[validate-ai][w${worker.idx + 1}] game ${i + 1}/${games} ` +
        result.scores.map(s => `${s.faction || s.name}=${s.score}`).join(' | ')
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[validate-ai][w${worker.idx + 1}] game ${i + 1}/${games} failed: ${reason}`);
    }
  }
  return results;
}

function summarize(label: string, requestedGames: number, results: OneGameResult[]): EvalSummary {
  const allScores = results.flatMap(r => r.scores.map(s => s.score));
  const winnerScores = results.map(r => r.winnerScore);
  const lowestScores = results.map(r => Math.min(...r.scores.map(s => s.score)));
  const spreads = results.map(r => {
    const scores = r.scores.map(s => s.score);
    return Math.max(...scores) - Math.min(...scores);
  });
  const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const finished = results.length;
  const failures = requestedGames - finished;
  const finishRate = requestedGames > 0 ? finished / requestedGames : 0;
  const reliabilityPenalty = Math.max(0, 1 - finishRate) * 30;
  const adjustedScore = avg(allScores) + avg(winnerScores) * 0.15 - reliabilityPenalty;
  return {
    label,
    requestedGames,
    finished,
    failures,
    finishRate,
    avgAllVp: avg(allScores),
    avgWinnerVp: avg(winnerScores),
    avgLowestVp: avg(lowestScores),
    avgSpread: avg(spreads),
    adjustedScore,
  };
}

async function evaluate(workers: Worker[], label: string, weights: WeightsPayload): Promise<EvalSummary> {
  console.log(`[validate-ai] evaluating ${label} (${GAMES} games)`);
  const split = splitGames(GAMES, workers.length);
  const batches = await Promise.all(workers.map((worker, i) => evalOnWorker(worker, weights, split[i])));
  const summary = summarize(label, GAMES, batches.flat());
  console.log(
    `[validate-ai] ${label}: avgAll=${summary.avgAllVp.toFixed(2)} avgWinner=${summary.avgWinnerVp.toFixed(2)} ` +
    `avgLowest=${summary.avgLowestVp.toFixed(2)} spread=${summary.avgSpread.toFixed(2)} ` +
    `adjusted=${summary.adjustedScore.toFixed(2)} finishRate=${(summary.finishRate * 100).toFixed(0)}%`
  );
  return summary;
}

async function main() {
  if (!fs.existsSync(BASELINE_PATH)) throw new Error(`Baseline weights not found: ${BASELINE_PATH}`);
  if (!fs.existsSync(CANDIDATE_PATH)) throw new Error(`Candidate weights not found: ${CANDIDATE_PATH}`);

  console.log(`[validate-ai] baseline=${BASELINE_PATH}`);
  console.log(`[validate-ai] candidate=${CANDIDATE_PATH}`);
  console.log(`[validate-ai] workers=${WORKERS}, games=${GAMES}, mcts=${MCTS_MS}ms, promote=${PROMOTE}`);

  const baseline = readWeights(BASELINE_PATH);
  const candidate = readWeights(CANDIDATE_PATH);
  const workers = await bootWorkers();
  try {
    const baselineSummary = await evaluate(workers, 'baseline', baseline);
    const candidateSummary = await evaluate(workers, 'candidate', candidate);
    const improvement = candidateSummary.adjustedScore - baselineSummary.adjustedScore;
    const shouldPromote = PROMOTE &&
      candidateSummary.finishRate >= MIN_FINISH_RATE &&
      improvement >= MIN_IMPROVEMENT;
    const report = {
      createdAt: new Date().toISOString(),
      baselinePath: BASELINE_PATH,
      candidatePath: CANDIDATE_PATH,
      settings: { workers: WORKERS, games: GAMES, mctsMs: MCTS_MS, minImprovement: MIN_IMPROVEMENT, minFinishRate: MIN_FINISH_RATE },
      baseline: baselineSummary,
      candidate: candidateSummary,
      improvement,
      promoted: shouldPromote,
    };
    writeJson(REPORT_PATH, report);

    if (shouldPromote) {
      fs.copyFileSync(CANDIDATE_PATH, BASELINE_PATH);
      console.log(`[validate-ai] PROMOTED candidate → ${BASELINE_PATH} (improvement=${improvement.toFixed(2)})`);
    } else {
      console.log(`[validate-ai] not promoted (improvement=${improvement.toFixed(2)}, report=${REPORT_PATH})`);
    }
  } finally {
    await shutdownWorkers(workers);
  }
}

main().catch((err) => {
  console.error('[validate-ai] Fatal:', err);
  process.exit(1);
});
