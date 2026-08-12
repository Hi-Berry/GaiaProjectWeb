import { io, type Socket } from 'socket.io-client';
import { applyGameStateDelta, buildClientGameState } from '../shared/gameSync';

const url = process.env.TEST_SERVER_URL ?? 'http://localhost:5101';
const timeoutMs = 5000;

function connectedSocket(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, { path: '/socket.io', transports: ['websocket'] });
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', reject);
  });
}

function emitAck<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} ack timeout`)), timeoutMs);
    socket.emit(event, payload, (response: T & { error?: string }) => {
      clearTimeout(timer);
      if (response?.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

function nextEvent<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timeout`)), timeoutMs);
    socket.once(event, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

const host = await connectedSocket();
const legacy = await connectedSocket();
let hostFullCount = 0;
let legacyFullCount = 0;
host.on('game_updated', () => hostFullCount++);
legacy.on('game_updated', () => legacyFullCount++);

try {
  const created = await emitAck<{ gameId: string; playerId: string }>(
    host,
    'create_game',
    { playerName: 'delta-host' },
  );

  const sync = await emitAck<{ game: Record<string, unknown>; revision: number }>(
    host,
    'sync_game',
    { gameId: created.gameId, protocol: 1 },
  );
  let wire = buildClientGameState(sync.game, true);
  let revision = sync.revision;
  const fullCountAfterSync = hostFullCount;

  const deltaPromise = nextEvent<{
    gameId: string;
    baseRevision: number;
    revision: number;
    delta: Parameters<typeof applyGameStateDelta>[1];
  }>(host, 'game_delta');
  await emitAck(host, 'host_add_player', { gameId: created.gameId, playerName: 'second' });
  const firstDelta = await deltaPromise;
  if (firstDelta.baseRevision !== revision) throw new Error('first delta base revision mismatch');
  wire = applyGameStateDelta(wire, firstDelta.delta);
  revision = firstDelta.revision;
  if (!(wire.players as Record<string, unknown>) || Object.keys(wire.players as object).length !== 2) {
    throw new Error('delta did not reconstruct added player');
  }
  if (hostFullCount !== fullCountAfterSync) {
    throw new Error('delta-capable socket also received full game_updated');
  }

  await emitAck(
    legacy,
    'join_game',
    { gameId: created.gameId, playerName: 'legacy-player' },
  );
  await new Promise(resolve => setTimeout(resolve, 50));
  if (legacyFullCount < 1) throw new Error('legacy socket did not receive full game_updated');

  const resync = await emitAck<{ game: Record<string, unknown>; revision: number }>(
    host,
    'sync_game',
    { gameId: created.gameId, protocol: 1 },
  );
  if (resync.revision < revision) throw new Error('resync revision moved backwards');
  if (Object.keys((resync.game.players ?? {}) as object).length !== 3) {
    throw new Error('resync full snapshot is not current');
  }

  console.log(
    `OK: delta revision ${sync.revision}→${firstDelta.revision}, `
    + `legacy full=${legacyFullCount}, automatic full resync revision=${resync.revision}`,
  );
} finally {
  host.disconnect();
  legacy.disconnect();
}
