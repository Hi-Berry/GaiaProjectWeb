import { io as ioClient, type Socket } from 'socket.io-client';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { FACTIONS } from '@shared/gameConfig';

type EvaluatorWeights = Record<string, number>;
type EvaluatorWeightsProfile = {
  global: EvaluatorWeights;
  byFaction?: Record<string, EvaluatorWeights>;
};
type WeightsPayload = EvaluatorWeights | EvaluatorWeightsProfile;

type OneGameResult = {
  gameId: string;
  maxScore: number;
  scores: { playerId: string; name: string; faction?: string; score: number }[];
};

type Worker = {
  idx: number;
  port: number;
  proc: ChildProcess;
  socket: Socket;
};

const FAST_TUNE = String(process.env.FAST_TUNE || '').trim() === '1';
const WORKERS = Math.max(1, Number(process.env.TUNE_WORKERS) || 3);
const BASE_PORT = Math.max(1000, Number(process.env.TUNE_BASE_PORT) || 5100);
const TOTAL_GAMES = Math.max(20, Number(process.env.TUNE_GAMES) || (FAST_TUNE ? 240 : 600));
const UPDATE_EVERY = Math.max(2, Number(process.env.TUNE_UPDATE_EVERY) || (FAST_TUNE ? 12 : 20));
const TUNE_MCTS_MS = Math.max(50, Number(process.env.TUNE_MCTS_MS) || (FAST_TUNE ? 250 : 800));
const GAME_TIMEOUT_MS = (Number(process.env.TUNE_GAME_TIMEOUT_MIN) || (FAST_TUNE ? 18 : 35)) * 60 * 1000;
const SIGMA = Number(process.env.TUNE_SIGMA) || 0.2;
const MIN_DELTA = Number(process.env.TUNE_MIN_IMPROVEMENT) || (FAST_TUNE ? 0.25 : 0.6);
const TARGET_FACTION = String(process.env.TUNE_FACTION || '').trim();
const AUTO_FACTION_MODE = String(process.env.TUNE_FACTION_MODE || '').trim().toLowerCase(); // 'roundrobin'
const OUT_PATH = process.env.AI_WEIGHTS_OUTPUT || path.join(process.cwd(), 'server', 'ai', 'aiWeights.json');
const LOG_EVERY = Math.max(1, Number(process.env.TUNE_LOG_EVERY) || (FAST_TUNE ? 1 : 2));

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

function saveWeights(weights: WeightsPayload) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(weights, null, 2));
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

async function getWeights(socket: Socket): Promise<WeightsPayload> {
  const res: any = await emitAsync(socket, 'admin_get_ai_weights', {});
  if (res?.error) throw new Error(res.error);
  return res.weights as WeightsPayload;
}

async function setMctsTimeMs(socket: Socket, timeMs: number | null) {
  const token = process.env.AI_TUNING_TOKEN;
  const res: any = await emitAsync(socket, 'admin_set_mcts_time_ms', { timeMs, token });
  if (res?.error) throw new Error(res.error);
}

function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function mutate(base: EvaluatorWeights, sigma = 0.18): EvaluatorWeights {
  const out: EvaluatorWeights = { ...base };
  for (const k of Object.keys(out)) {
    const x = out[k];
    if (typeof x !== 'number' || !Number.isFinite(x)) continue;
    out[k] = Math.max(0, x * Math.exp(randn() * sigma));
  }
  return out;
}

function splitGames(total: number, buckets: number): number[] {
  const base = Math.floor(total / buckets);
  const rem = total % buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < rem ? 1 : 0));
}

function formatScoreboard(scores: OneGameResult['scores']): string {
  return [...scores]
    .sort((a, b) => b.score - a.score)
    .map(s => `${s.faction || s.name}=${s.score}`)
    .join(' | ');
}

async function runOneGame(socket: Socket): Promise<OneGameResult> {
  return new Promise((resolve, reject) => {
    let gameId = '';
    const onUpdate = (updated: any) => {
      if (!gameId) return;
      if (updated?.id !== gameId) return;
      if (updated.currentPhase !== 'gameEnd') return;
      cleanup();
      const players = updated.players || {};
      const scores = Object.entries(players).map(([playerId, p]: [string, any]) => ({
        playerId,
        name: p.name || playerId,
        faction: p.faction,
        score: typeof p.score === 'number' ? p.score : 0,
      }));
      const maxScore = Math.max(...scores.map(s => s.score));
      resolve({ gameId, maxScore, scores });
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('game_updated', onUpdate);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Game timeout'));
    }, GAME_TIMEOUT_MS);

    socket.on('game_updated', onUpdate);
    socket.emit('create_game', { playerName: 'TuneAutoRunner' }, (res: any) => {
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

async function evalOnWorker(worker: Worker, weights: WeightsPayload, games: number) {
  await setWeights(worker.socket, weights);
  const maxScores: number[] = [];
  const targetFactionScores: number[] = [];
  let failures = 0;
  for (let i = 0; i < games; i++) {
    try {
      const r = await runOneGame(worker.socket);
      maxScores.push(r.maxScore);
      if (((i + 1) % LOG_EVERY) === 0) {
        console.log(
          `[tune-ai:auto][w${worker.idx + 1}] game ${i + 1}/${games} ` +
          `winnerVP=${r.maxScore} allVP=[${formatScoreboard(r.scores)}]`
        );
      }
      if (TARGET_FACTION) {
        for (const s of r.scores) if (s.faction === TARGET_FACTION) targetFactionScores.push(s.score);
      }
    } catch (e) {
      failures++;
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(`[tune-ai:auto][w${worker.idx + 1}] game ${i + 1}/${games} failed reason=${reason}`);
    }
  }
  const finished = maxScores.length;
  const finishRate = games > 0 ? finished / games : 0;
  const avgWinner = finished ? maxScores.reduce((a, b) => a + b, 0) / finished : 0;
  const avgTarget = targetFactionScores.length ? targetFactionScores.reduce((a, b) => a + b, 0) / targetFactionScores.length : 0;
  return { finished, failures, finishRate, avgWinner, avgTarget, samples: targetFactionScores.length };
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

async function waitForServer(port: number, maxAttempts = 30): Promise<Socket> {
  const baseUrl = `http://localhost:${port}`;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await connectSocket(baseUrl);
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error(`Failed to connect server on port ${port}`);
}

function startServerProcess(port: number): ChildProcess {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'cmd.exe' : 'npx';
  const args = isWin ? ['/d', '/s', '/c', 'npx tsx server/index.ts'] : ['tsx', 'server/index.ts'];
  return spawn(cmd, args, {
    cwd: process.cwd(),
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
    workers.push({ idx: i, port, proc, socket });
    console.log(`[tune-ai:auto] Worker #${i + 1} ready on :${port}`);
  }
  return workers;
}

async function shutdownWorkers(workers: Worker[]) {
  await Promise.all(workers.map(async (w) => {
    try { await setMctsTimeMs(w.socket, null); } catch { }
    try { w.socket.disconnect(); } catch { }
    try { w.proc.kill(); } catch { }
  }));
}

async function evaluateParallel(workers: Worker[], weights: WeightsPayload, totalGames: number) {
  const gameSplit = splitGames(totalGames, workers.length);
  const partials = await Promise.all(workers.map((w, i) => evalOnWorker(w, weights, gameSplit[i])));
  const finished = partials.reduce((a, x) => a + x.finished, 0);
  const failures = partials.reduce((a, x) => a + x.failures, 0);
  const weightedWinnerSum = partials.reduce((a, x) => a + x.avgWinner * x.finished, 0);
  const weightedTargetSum = partials.reduce((a, x) => a + x.avgTarget * x.samples, 0);
  const targetSamples = partials.reduce((a, x) => a + x.samples, 0);
  const avgWinner = finished > 0 ? weightedWinnerSum / finished : 0;
  const avgTarget = targetSamples > 0 ? weightedTargetSum / targetSamples : 0;
  const finishRate = totalGames > 0 ? finished / totalGames : 0;
  const reliabilityPenalty = Math.max(0, 1 - finishRate) * 20;
  const baseScore = TARGET_FACTION ? avgTarget : avgWinner;
  const adjustedScore = baseScore - reliabilityPenalty;
  return { finished, failures, finishRate, avgWinner, avgTarget, targetSamples, adjustedScore };
}

function getAutoFactionSequence(): string[] {
  // Use known factions list; fallback to empty (global-only).
  const ids = (FACTIONS || []).map((f: any) => f?.id).filter((x: any): x is string => typeof x === 'string' && x.length > 0);
  // Exclude 'none' or placeholder if any.
  return Array.from(new Set(ids)).filter((id) => id !== 'none');
}

async function main() {
  console.log(`[tune-ai:auto] workers=${WORKERS}, basePort=${BASE_PORT}, totalGames=${TOTAL_GAMES}, updateEvery=${UPDATE_EVERY}, mcts=${TUNE_MCTS_MS}ms`);
  const autoSeq = getAutoFactionSequence();
  const useAuto = !TARGET_FACTION && AUTO_FACTION_MODE === 'roundrobin' && autoSeq.length > 0;
  if (TARGET_FACTION) console.log(`[tune-ai:auto] faction-specific tuning: ${TARGET_FACTION}`);
  else if (useAuto) console.log(`[tune-ai:auto] faction tuning mode=roundrobin (${autoSeq.length} factions)`);

  const workers = await bootWorkers();
  try {
    await Promise.all(workers.map(w => setMctsTimeMs(w.socket, TUNE_MCTS_MS)));
    const base = await getWeights(workers[0].socket);
    let bestWeights: WeightsPayload = isProfile(base)
      ? { global: { ...base.global }, byFaction: { ...(base.byFaction || {}) } }
      : { ...base };

    let totalDone = 0;
    let cycle = 0;
    const baseline = await evaluateParallel(workers, bestWeights, UPDATE_EVERY);
    totalDone += UPDATE_EVERY;
    let bestScore = baseline.adjustedScore;
    saveWeights(bestWeights);
    console.log(`[tune-ai:auto] baseline avgWinner=${baseline.avgWinner.toFixed(2)} adjusted=${baseline.adjustedScore.toFixed(2)} finishRate=${(baseline.finishRate * 100).toFixed(0)}%`);

    while (totalDone < TOTAL_GAMES) {
      cycle++;
      const cycleFaction = TARGET_FACTION || (useAuto ? autoSeq[(cycle - 1) % autoSeq.length] : '');
      const candidate = cycleFaction
        ? upsertFactionWeights(bestWeights, cycleFaction, mutate(getFactionWeights(bestWeights, cycleFaction), SIGMA))
        : (isProfile(bestWeights)
          ? { global: mutate(bestWeights.global, SIGMA), byFaction: { ...(bestWeights.byFaction || {}) } }
          : mutate(getGlobalWeights(bestWeights), SIGMA));

      const res = await evaluateParallel(workers, candidate, UPDATE_EVERY);
      totalDone += UPDATE_EVERY;
      const improved = (res.adjustedScore - bestScore) >= MIN_DELTA && res.finished >= Math.max(2, Math.floor(UPDATE_EVERY * 0.7));
      console.log(
        `[tune-ai:auto] cycle=${cycle} avgWinner=${res.avgWinner.toFixed(2)}` +
        `${cycleFaction ? ` avg(${cycleFaction})=${res.avgTarget.toFixed(2)} samples=${res.targetSamples}` : ''} ` +
        `adjusted=${res.adjustedScore.toFixed(2)} best=${bestScore.toFixed(2)} finishRate=${(res.finishRate * 100).toFixed(0)}%` +
        `${improved ? '  <-- NEW BEST' : ''}`
      );

      if (improved) {
        bestScore = res.adjustedScore;
        bestWeights = candidate;
        saveWeights(bestWeights);
      }
    }

    await setWeights(workers[0].socket, bestWeights);
    console.log(`[tune-ai:auto] done. bestAdjusted=${bestScore.toFixed(2)} saved=${OUT_PATH}`);
  } finally {
    await shutdownWorkers(workers);
  }
}

main().catch((err) => {
  console.error('[tune-ai:auto] Fatal:', err);
  process.exit(1);
});

