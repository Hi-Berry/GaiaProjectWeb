/**
 * Evaluator 가중치 그리드 서치 초안 (150 VP 목표).
 *
 * 전제: 서버 실행 중.
 *   터미널 1: npm run dev
 *   터미널 2: npm run tune-ai:grid
 *
 * 후보: 미리 정의한 프리셋들(또는 2~3개 축 그리드). 각 후보당 N판 자기대국 후
 * 평균 우승자 VP가 가장 높은 가중치를 server/ai/aiWeights.json 에 저장.
 *
 * 환경 변수:
 *   TUNE_GRID_GAMES   후보당 게임 수 (기본 10)
 *   TUNE_GRID_MCTS_MS 튜닝 중 MCTS 시간 ms (기본 2000)
 *   SELF_PLAY_PORT    서버 포트
 *   AI_WEIGHTS_OUTPUT 저장 경로 (기본 server/ai/aiWeights.json)
 */

import { io as ioClient, type Socket } from 'socket.io-client';
import fs from 'fs';
import path from 'path';

type EvaluatorWeights = Record<string, number>;

const PORT = Number(process.env.SELF_PLAY_PORT) || Number(process.env.PORT) || 5000;
const BASE_URL = process.env.SELF_PLAY_BASE_URL || `http://localhost:${PORT}`;

const GAMES_PER_CANDIDATE = Math.max(3, Math.min(50, Number(process.env.TUNE_GRID_GAMES) || 10));
const TUNE_MCTS_MS = Number(process.env.TUNE_GRID_MCTS_MS) || 2000;
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

    socket.emit('create_game', { playerName: 'GridSearchRunner' }, (res: any) => {
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

/** 150 VP 쪽으로 유도하는 프리셋들. base에 merge해서 사용 */
const GRID_PRESETS: { name: string; weights: Partial<EvaluatorWeights> }[] = [
  { name: 'baseline', weights: {} },
  {
    name: 'federation_strong',
    weights: {
      federationValueEach: 150,
      structureMine: 55,
      structureRemainingRoundsFactor: 1.2,
    },
  },
  {
    name: 'research5_strong',
    weights: {
      researchLevel5Bonus: 280,
      researchEconomy: 26,
      researchScience: 14,
      researchRemainingRoundsFactor: 0.25,
    },
  },
  {
    name: 'build_heavy',
    weights: {
      structureMine: 55,
      structureTradingStation: 70,
      structureResearchLab: 90,
      structurePlanetaryInstitute: 140,
      structureAcademy: 160,
      structureRemainingRoundsFactor: 1.2,
    },
  },
  {
    name: 'vp_late',
    weights: {
      vpWeightEarly: 4,
      vpWeightLate: 26,
      resourceMultiplierLate: 0.6,
    },
  },
  {
    name: 'balanced_150',
    weights: {
      vpWeightLate: 24,
      federationValueEach: 130,
      researchLevel5Bonus: 240,
      structureAcademy: 150,
      structurePlanetaryInstitute: 130,
      structureRemainingRoundsFactor: 1.1,
    },
  },
];

async function evalCandidate(
  socket: Socket,
  weights: EvaluatorWeights,
  games: number
): Promise<{ avgWinner: number; maxScores: number[]; failures: number }> {
  await setWeights(socket, weights);
  const maxScores: number[] = [];
  let failures = 0;

  for (let i = 0; i < games; i++) {
    try {
      const r = await runOneGame(socket);
      maxScores.push(r.maxScore);
    } catch {
      failures++;
    }
  }

  const avgWinner = maxScores.length
    ? maxScores.reduce((a, b) => a + b, 0) / maxScores.length
    : 0;
  return { avgWinner, maxScores, failures };
}

async function main() {
  console.log(`[tune-ai:grid] Connecting to ${BASE_URL}`);
  console.log(`[tune-ai:grid] Presets=${GRID_PRESETS.length}, gamesPerPreset=${GAMES_PER_CANDIDATE}, MCTS=${TUNE_MCTS_MS}ms`);
  const socket = await connect();

  await setMctsTimeMs(socket, TUNE_MCTS_MS);
  const base = await getWeights(socket);

  const results: { name: string; avgWinner: number; failures: number; weights: EvaluatorWeights }[] = [];

  for (const preset of GRID_PRESETS) {
    const merged: EvaluatorWeights = { ...base, ...preset.weights };
    process.stdout.write(`[tune-ai:grid] Evaluating "${preset.name}" ... `);
    const res = await evalCandidate(socket, merged, GAMES_PER_CANDIDATE);
    results.push({
      name: preset.name,
      avgWinner: res.avgWinner,
      failures: res.failures,
      weights: merged,
    });
    console.log(`avgWinnerVP=${res.avgWinner.toFixed(1)} (failures=${res.failures})`);
  }

  results.sort((a, b) => b.avgWinner - a.avgWinner);
  const best = results[0];
  const bestWeights = best.weights;

  saveWeights(bestWeights);
  console.log('\n--- Grid search summary ---');
  results.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.name}: ${r.avgWinner.toFixed(1)} (failures=${r.failures})`);
  });
  console.log(`Best: "${best.name}" → ${OUT_PATH}`);
  await setMctsTimeMs(socket, null);
  socket.disconnect();
  console.log('[tune-ai:grid] Done.');
}

main().catch(err => {
  console.error('[tune-ai:grid] Fatal:', err);
  process.exit(1);
});
