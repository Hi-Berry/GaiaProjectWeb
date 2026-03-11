/**
 * 자기대국 러너 (옵션 2): 서버에 접속해 봇 4인 게임을 N판 돌리고 최종 VP를 수집합니다.
 * 사용법: 서버를 띄운 뒤 다른 터미널에서 실행
 *   npm run self-play          # 기본 10판
 *   SELF_PLAY_GAMES=100 npm run self-play
 *   SELF_PLAY_PORT=5000 SELF_PLAY_GAMES=50 npm run self-play
 */

import { io as ioClient, type Socket } from 'socket.io-client';
import path from 'path';
import fs from 'fs';

const PORT = Number(process.env.SELF_PLAY_PORT) || Number(process.env.PORT) || 5000;
const BASE_URL = process.env.SELF_PLAY_BASE_URL || `http://localhost:${PORT}`;
const GAMES = Math.max(1, Math.min(1000, Number(process.env.SELF_PLAY_GAMES) || 10));
const GAME_TIMEOUT_MS = 45 * 60 * 1000; // 45분

export type SelfPlayResult = {
  gameId: string;
  scores: { playerId: string; name: string; faction?: string; score: number }[];
  winner: string;
  maxScore: number;
};

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

function runOneGame(socket: Socket): Promise<SelfPlayResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('game_updated');
      reject(new Error('Game timeout'));
    }, GAME_TIMEOUT_MS);

    socket.emit('create_game', { playerName: 'SelfPlayRunner' }, (res: any) => {
      if (res.error) {
        clearTimeout(timeout);
        reject(new Error(res.error));
        return;
      }
      const { gameId, game } = res;
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
        const winner = scores.find(s => s.score === maxScore)?.playerId ?? '';
        resolve({
          gameId: updated.id || gameId,
          scores,
          winner,
          maxScore,
        });
      });
      socket.emit('auto_setup_test', { gameId, selfPlay: true });
    });
  });
}

async function main() {
  console.log(`[self-play] Connecting to ${BASE_URL} (games=${GAMES}, timeout=${GAME_TIMEOUT_MS / 60000}min)`);
  const socket = await connect();
  console.log('[self-play] Connected. Running games...');

  const results: SelfPlayResult[] = [];
  let timeouts = 0;

  for (let i = 0; i < GAMES; i++) {
    try {
      const result = await runOneGame(socket);
      results.push(result);
      const line = result.scores.map(s => `${s.name}:${s.score}`).join(', ');
      console.log(`[self-play] Game ${i + 1}/${GAMES} done. ${line} (winner: ${result.winner})`);
    } catch (e) {
      timeouts++;
      console.warn(`[self-play] Game ${i + 1}/${GAMES} failed:`, (e as Error).message);
    }
  }

  socket.disconnect();

  // 요약 통계
  const allScores = results.flatMap(r => r.scores.map(s => s.score));
  const maxScores = results.map(r => r.maxScore);
  const avg = allScores.length ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;
  const avgMax = maxScores.length ? maxScores.reduce((a, b) => a + b, 0) / maxScores.length : 0;

  console.log('\n--- Self-play summary ---');
  console.log(`Games finished: ${results.length}/${GAMES}, timeouts: ${timeouts}`);
  console.log(`Avg VP (all players): ${avg.toFixed(1)}, Avg winner VP: ${avgMax.toFixed(1)}`);
  console.log(`Max VP in dataset: ${Math.max(...allScores, 0)}, Min: ${Math.min(...allScores, 0)}`);
  console.log('---');

  // 결과를 JSON으로 저장 (기본: data/selfplay-results.json, SELF_PLAY_OUTPUT으로 변경 가능)
  const defaultDir = path.join(process.cwd(), 'data');
  const outPath = process.env.SELF_PLAY_OUTPUT || path.join(defaultDir, 'selfplay-results.json');
  if (results.length > 0) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ results, summary: { avg, avgMax, count: results.length } }, null, 2));
    console.log(`Results written to ${outPath}`);
  }
}

main().catch(err => {
  console.error('[self-play] Fatal:', err);
  process.exit(1);
});
