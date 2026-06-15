/**
 * 고급기술타일 0개의 진짜 병목 진단(현재 코드). self-play N판을 돌려 봇별로:
 *  feds(연방 수), greenLeft(미사용 그린), maxLvl/L4+/L5(트랙), advTiles(고급타일 보유)
 * 를 수집한다. 그린토큰이 L5진입 vs 고급타일 vs 미사용으로 어떻게 갈리는지 본다.
 * 사용: 서버 기동 후  SELF_PLAY_GAMES=8 tsx scripts/diagAdvTile.ts
 */
import { io as ioClient, type Socket } from 'socket.io-client';

const PORT = Number(process.env.SELF_PLAY_PORT) || Number(process.env.PORT) || 5000;
const BASE_URL = process.env.SELF_PLAY_BASE_URL || `http://localhost:${PORT}`;
const GAMES = Math.max(1, Math.min(200, Number(process.env.SELF_PLAY_GAMES) || 8));
const GAME_TIMEOUT_MS = 20 * 60 * 1000;
const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];

type Row = { faction: string; score: number; feds: number; greenLeft: number; maxLvl: number; l4plus: number; l5: number; adv: number; sats: number };

function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE_URL, { path: '/socket.io', transports: ['websocket', 'polling'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

function runOneGame(socket: Socket): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('game_updated'); reject(new Error('timeout')); }, GAME_TIMEOUT_MS);
    socket.emit('create_game', { playerName: 'SelfPlayRunner' }, (res: any) => {
      if (res.error) { clearTimeout(timeout); reject(new Error(res.error)); return; }
      const { gameId } = res;
      socket.on('game_updated', (g: any) => {
        if (g.currentPhase !== 'gameEnd') return;
        clearTimeout(timeout);
        socket.off('game_updated');
        // 플레이어별 위성 수: game.satellites[hexId] = playerId | playerId[]
        const satCount: Record<string, number> = {};
        for (const owner of Object.values(g.satellites || {})) {
          const ids = Array.isArray(owner) ? owner : (owner ? [owner] : []);
          for (const id of ids as string[]) satCount[id] = (satCount[id] || 0) + 1;
        }
        const rows: Row[] = Object.entries(g.players || {}).map(([pid, p]: [string, any]) => {
          const feds = Array.isArray(p.federations) ? p.federations : [];
          const greenLeft = feds.filter((e: any) => (typeof e === 'string' ? false : e?.isGreen)).length;
          const lv = TRACKS.map(t => p.research?.[t] ?? 0);
          const adv = (p.techTiles || []).filter((id: string) => String(id).startsWith('adv-')).length;
          return {
            faction: p.faction, score: p.score ?? 0, feds: feds.length, greenLeft,
            maxLvl: Math.max(0, ...lv), l4plus: lv.filter(v => v >= 4).length, l5: lv.filter(v => v >= 5).length, adv,
            sats: satCount[pid] || 0,
          };
        });
        resolve(rows);
      });
      socket.emit('auto_setup_test', { gameId, selfPlay: true });
    });
  });
}

async function main() {
  console.log(`[diag] connecting ${BASE_URL}, games=${GAMES}`);
  const socket = await connect();
  const all: Row[] = [];
  for (let i = 0; i < GAMES; i++) {
    try { const rows = await runOneGame(socket); all.push(...rows); console.log(`[diag] game ${i + 1}/${GAMES} ok (scores ${rows.map(r => r.score).join('/')})`); }
    catch (e) { console.warn(`[diag] game ${i + 1} failed: ${(e as Error).message}`); }
  }
  socket.disconnect();

  const n = all.length;
  const avg = (k: keyof Row) => (all.reduce((s, r) => s + (r[k] as number), 0) / n);
  console.log(`\n=== ${n} bot seats (${GAMES} games) ===`);
  console.log(`score      ${avg('score').toFixed(1)}`);
  console.log(`feds       ${avg('feds').toFixed(2)}   greenLeft ${avg('greenLeft').toFixed(2)}`);
  console.log(`maxLvl     ${avg('maxLvl').toFixed(2)}   L4+ tracks ${avg('l4plus').toFixed(2)}   L5 ${avg('l5').toFixed(2)}`);
  console.log(`advTiles   ${avg('adv').toFixed(2)}`);
  // 연방 효율: 연방당 위성 수 (행동 지표 — self-play에서도 관측 가능). 사람은 적게(1~2), 봇은 많이 쓰면 비효율.
  const withFed = all.filter(r => r.feds > 0);
  const satsPerFed = withFed.length ? withFed.reduce((s, r) => s + r.sats / r.feds, 0) / withFed.length : 0;
  console.log(`\n연방효율   총위성/좌석 ${avg('sats').toFixed(2)}   연방당위성 ${satsPerFed.toFixed(2)}  (사람 목표 ~1-2, 높을수록 비효율적 흩뿌림)`);
  // 그린토큰 행방: 번 그린 ≈ greenLeft + L5(각1) + adv(각1)
  const greenSpentL5 = avg('l5'), greenSpentAdv = avg('adv'), greenLeft = avg('greenLeft');
  console.log(`\n그린토큰 행방(좌석평균): 미사용 ${greenLeft.toFixed(2)}  +  L5진입 ${greenSpentL5.toFixed(2)}  +  고급타일 ${greenSpentAdv.toFixed(2)}  ≈ 번 그린 ${(greenLeft + greenSpentL5 + greenSpentAdv).toFixed(2)}`);
  // 자격 도달률: L4+ 트랙이 있고 그린 보유한 좌석 비율
  const eligibleEver = all.filter(r => r.l4plus >= 1 && (r.greenLeft + r.l5 + r.adv) >= 1).length;
  console.log(`L4+트랙 & 그린≥1 동시 도달 좌석: ${eligibleEver}/${n} (${(eligibleEver / n * 100).toFixed(0)}%)`);
}

main().catch(e => { console.error(e); process.exit(1); });
