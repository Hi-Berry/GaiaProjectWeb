/**
 * 실제 Socket.IO + 4봇 완주 델타 soak 테스트.
 *
 * 검증:
 *  - capable 클라이언트는 game_updated 전체 상태를 받지 않고 revision 델타를 끝까지 복원
 *  - 의도적으로 델타 1개를 버린 뒤 baseRevision 불일치에서 sync_game 전체 복구
 *  - 진행 중 관전자 입장 및 연결 단절 후 rejoin_game + sync_game 복구
 *  - 구버전 클라이언트는 같은 방에서 계속 game_updated 전체 상태 수신
 *  - 주기적으로 서버 전체 스냅샷과 클라이언트 복원 상태를 바이트 단위 비교
 */
import zlib from 'zlib';
import { io, type Socket } from 'socket.io-client';
import {
  GAME_SYNC_PROTOCOL,
  applyGameStateDelta,
  buildClientGameState,
  type GameDeltaMessage,
  type GameSyncMessage,
} from '../shared/gameSync';

const url = process.env.TEST_SERVER_URL ?? 'http://localhost:5110';
const timeoutMs = Number(process.env.SYNC_SOAK_TIMEOUT_MS) || 15 * 60 * 1000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const wireBytes = (value: unknown) => {
  const json = JSON.stringify(value);
  const raw = Buffer.byteLength(json);
  return raw < 1024 ? raw : zlib.deflateRawSync(Buffer.from(json)).length;
};

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.keys(item).sort().reduce<Record<string, unknown>>((out, key) => {
        out[key] = item[key];
        return out;
      }, {})
      : item
  ));
}

function connectSocket(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
    });
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 10_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', reject);
  });
}

function emitAck<T>(socket: Socket, event: string, payload: unknown, timeout = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(timeout).emit(event, payload, (error: Error | null, response: T & { error?: string }) => {
      if (error) { reject(new Error(`${event} timeout`)); return; }
      if (response?.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

async function waitUntil(label: string, predicate: () => boolean, timeout = 60_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(`${label} timeout`);
    await sleep(25);
  }
}

type SyncResponse = { game: Record<string, unknown>; revision: number; protocol: number };

class DeltaTracker {
  gameId: string;
  socket: Socket;
  wire: Record<string, unknown> = {};
  revision = -1;
  deltaCount = 0;
  fullSnapshotCount = 0;
  recoveryCount = 0;
  checkpointCount = 0;
  deltaRawBytes = 0;
  deltaWireBytes = 0;
  droppedOne = false;
  recoveredDroppedDelta = false;
  private recovering: Promise<void> | null = null;
  private checkpointing = false;
  private lastCheckpointRevision = -1;

  constructor(socket: Socket, gameId: string) {
    this.socket = socket;
    this.gameId = gameId;
  }

  get isCheckpointing(): boolean {
    return this.checkpointing;
  }

  async start(): Promise<void> {
    this.socket.on('game_delta', this.onDelta);
    this.socket.on('game_sync', this.onSync);
    await this.recover('initial');
  }

  stop(): void {
    this.socket.off('game_delta', this.onDelta);
    this.socket.off('game_sync', this.onSync);
  }

  private install(response: SyncResponse): void {
    this.wire = buildClientGameState(response.game, true);
    this.revision = response.revision;
  }

  private recover(reason: string): Promise<void> {
    if (this.recovering) return this.recovering;
    this.recovering = emitAck<SyncResponse>(
      this.socket,
      'sync_game',
      { gameId: this.gameId, protocol: GAME_SYNC_PROTOCOL },
    ).then(response => {
      this.install(response);
      if (reason !== 'initial') {
        this.recoveryCount++;
        if (reason === 'revision-gap') this.recoveredDroppedDelta = true;
      }
    }).finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }

  private onDelta = (message: GameDeltaMessage) => {
    if (message.gameId !== this.gameId) return;
    this.deltaRawBytes += bytes(message);
    this.deltaWireBytes += wireBytes(message);

    // 실제 패킷 유실과 같은 상태를 만든다. 다음 delta의 baseRevision이 어긋나야 한다.
    if (!this.droppedOne && this.deltaCount >= 4) {
      this.droppedOne = true;
      return;
    }
    if (message.revision <= this.revision) return;
    if (message.baseRevision !== this.revision) {
      void this.recover('revision-gap');
      return;
    }
    this.wire = applyGameStateDelta(this.wire, message.delta);
    this.revision = message.revision;
    this.deltaCount++;
    this.maybeCheckpoint();
  };

  private onSync = (message: GameSyncMessage) => {
    if (message.gameId !== this.gameId || message.revision <= this.revision) return;
    this.deltaRawBytes += bytes(message);
    this.deltaWireBytes += wireBytes(message);
    this.wire = message.game;
    this.revision = message.revision;
    this.fullSnapshotCount++;
    this.maybeCheckpoint();
  };

  private maybeCheckpoint(): void {
    if (
      this.checkpointing
      || this.recovering
      || this.revision - this.lastCheckpointRevision < 25
    ) return;
    this.checkpointing = true;
    const requestedAt = this.revision;
    void emitAck<SyncResponse>(
      this.socket,
      'sync_game',
      { gameId: this.gameId, protocol: GAME_SYNC_PROTOCOL },
    ).then(async response => {
      const expected = buildClientGameState(response.game, true);
      // Socket.IO는 한 연결의 순서를 보장하지만 ack와 room broadcast가 서로 다른 큐에서 전달될 수 있다.
      // ack가 먼저 왔다면 해당 revision까지 잠시 기다리고, 이미 더 진행됐으면 이번 비교만 건너뛴다.
      if (this.revision < response.revision) {
        await waitUntil(
          'checkpoint delta delivery',
          () => this.revision >= response.revision || !!fatalError,
          2_000,
        );
      }
      if (this.revision > response.revision) {
        this.lastCheckpointRevision = Math.max(requestedAt, response.revision);
        return;
      }
      if (this.revision < response.revision) {
        throw new Error(`checkpoint revision stalled local=${this.revision} server=${response.revision}`);
      }
      if (stable(this.wire) !== stable(expected)) {
        throw new Error(`checkpoint state mismatch at revision ${response.revision}`);
      }
      this.checkpointCount++;
      this.lastCheckpointRevision = Math.max(requestedAt, response.revision);
    }).catch(error => {
      fatal(error);
    }).finally(() => {
      this.checkpointing = false;
    });
  }
}

let fatalError: Error | null = null;
function fatal(error: unknown): void {
  fatalError = error instanceof Error ? error : new Error(String(error));
}

const sockets: Socket[] = [];
const host = await connectSocket();
sockets.push(host);

const created = await emitAck<{ gameId: string; playerId: string }>(
  host,
  'create_game',
  { playerName: 'sync-soak-host' },
);
const { gameId, playerId } = created;

let hostFullAfterCapability = 0;
host.on('game_updated', () => hostFullAfterCapability++);
const hostTracker = new DeltaTracker(host, gameId);
await hostTracker.start();

// 구버전 관전자는 capability 협상을 하지 않아 전체 상태를 계속 받아야 한다.
const legacy = await connectSocket();
sockets.push(legacy);
let legacyFullCount = 0;
let legacyRawBytes = 0;
let legacyWireBytes = 0;
let legacyEnded = false;
legacy.on('game_updated', (game: Record<string, unknown>) => {
  if (game.id !== gameId) return;
  legacyFullCount++;
  legacyRawBytes += bytes(game);
  legacyWireBytes += wireBytes(game);
  if (game.currentPhase === 'gameEnd') legacyEnded = true;
});
await emitAck(legacy, 'watch_game', { gameId, name: 'legacy-observer' });

await emitAck(host, 'admin_set_mcts_time_ms', { timeMs: 15, token: undefined });
await emitAck(host, 'admin_set_bot_delay_ms', { delayMs: 0, token: undefined });
host.emit('auto_setup_test', { gameId, selfPlay: true });

// 자동 세팅·초반 행동 중 실제 delta 하나를 버리고 전체 복구되는지 확인한다.
await waitUntil(
  'intentional delta-gap recovery',
  () => hostTracker.recoveredDroppedDelta || !!fatalError,
  90_000,
);
if (fatalError) throw fatalError;

// 진행 중 새 관전자 입장 + capability 협상.
const capableSpectator = await connectSocket();
sockets.push(capableSpectator);
const watched = await emitAck<{ spectatorId: string }>(
  capableSpectator,
  'watch_game',
  { gameId, name: 'delta-observer' },
);
let spectatorTracker = new DeltaTracker(capableSpectator, gameId);
await spectatorTracker.start();
const spectatorStartRevision = spectatorTracker.revision;

await waitUntil(
  'spectator receives deltas',
  () => spectatorTracker.revision >= spectatorStartRevision + 15
    || spectatorTracker.wire.currentPhase === 'gameEnd'
    || !!fatalError,
  120_000,
);
if (fatalError) throw fatalError;

// 모바일 백그라운드/NAT 단절과 같은 상황: 관전자 소켓을 끊고 봇 진행 중 재접속한다.
spectatorTracker.stop();
capableSpectator.disconnect();
await sleep(300);

const reconnectedSpectator = await connectSocket();
sockets.push(reconnectedSpectator);
await emitAck(
  reconnectedSpectator,
  'rejoin_game',
  { gameId, playerId: watched.spectatorId },
);
spectatorTracker = new DeltaTracker(reconnectedSpectator, gameId);
await spectatorTracker.start();
const reconnectRevision = spectatorTracker.revision;

// start()가 sync_game 응답을 그대로 기준점으로 설치한다. 게임 ID와 revision 전진을 확인한다.
if (spectatorTracker.wire.id !== gameId || reconnectRevision < spectatorStartRevision) {
  throw new Error(
    `spectator reconnect baseline mismatch game=${String(spectatorTracker.wire.id)} `
    + `revision=${reconnectRevision}/${spectatorStartRevision}`,
  );
}

// games.set(restored)로 게임 객체가 통째 교체되는 실제 롤백 경로도 델타 기준점을 깨지 않는지 검증한다.
let rollbackApplied = false;
const rollbackDeadline = Date.now() + 30_000;
while (!rollbackApplied && Date.now() < rollbackDeadline && hostTracker.wire.currentPhase !== 'gameEnd') {
  if (hostTracker.wire.currentPhase === 'main' && hostTracker.revision >= 100) {
    try {
      await emitAck(
        host,
        'admin_rollback_turn',
        { gameId, adminCode: '0011' },
      );
      rollbackApplied = true;
      break;
    } catch {
      // 막 라운드가 바뀌었거나 아직 턴 스냅샷이 없는 짧은 구간이면 다음 main 상태에서 재시도.
    }
  }
  await sleep(20);
}
if (!rollbackApplied) throw new Error('could not exercise admin rollback during bot game');

const startedAt = Date.now();
try {
  await waitUntil(
    'full bot game completion',
    () => hostTracker.wire.currentPhase === 'gameEnd' || !!fatalError,
    timeoutMs,
  );
  if (fatalError) throw fatalError;
  await waitUntil('legacy gameEnd', () => legacyEnded, 10_000);
  await waitUntil('checkpoint completion', () => !hostTracker.isCheckpointing, 10_000);

  const finalSync = await emitAck<SyncResponse>(
    host,
    'sync_game',
    { gameId, protocol: GAME_SYNC_PROTOCOL },
  );
  const finalExpected = buildClientGameState(finalSync.game, true);
  if (finalSync.revision !== hostTracker.revision) {
    throw new Error(`final revision mismatch local=${hostTracker.revision} server=${finalSync.revision}`);
  }
  if (stable(finalExpected) !== stable(hostTracker.wire)) {
    throw new Error('final reconstructed state mismatch');
  }
  if (hostFullAfterCapability !== 0) {
    throw new Error(`capable host received ${hostFullAfterCapability} legacy full updates`);
  }
  if (legacyFullCount < 10 || !legacyEnded) {
    throw new Error(`legacy compatibility insufficient: full=${legacyFullCount}, ended=${legacyEnded}`);
  }
  if (!hostTracker.recoveredDroppedDelta) {
    throw new Error('intentional revision gap was not recovered');
  }
  if (spectatorTracker.revision < reconnectRevision) {
    throw new Error('spectator revision moved backwards after reconnect');
  }

  const reduction = legacyWireBytes > 0
    ? 100 * (1 - hostTracker.deltaWireBytes / legacyWireBytes)
    : 0;
  const players = finalExpected.players as Record<string, { score?: number; faction?: string }>;
  const scoreLine = Object.values(players)
    .map(player => `${player.faction ?? 'unknown'}:${player.score ?? 0}`)
    .join(', ');

  console.log('[SYNC-SOAK] PASS');
  console.log(
    `[SYNC-SOAK] game=${gameId} rev=${hostTracker.revision} deltas=${hostTracker.deltaCount} `
    + `fullFallbacks=${hostTracker.fullSnapshotCount} checkpoints=${hostTracker.checkpointCount} `
    + `recoveries=${hostTracker.recoveryCount}`,
  );
  console.log(
    `[SYNC-SOAK] legacyFull=${legacyFullCount} legacyWire=${legacyWireBytes}B `
    + `deltaWire=${hostTracker.deltaWireBytes}B estimatedReduction=${reduction.toFixed(1)}%`,
  );
  console.log(
    `[SYNC-SOAK] spectator reconnect rev=${reconnectRevision}, `
    + `rollback=${rollbackApplied ? 'ok' : 'missing'}, `
    + `elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s, scores=${scoreLine}`,
  );
} finally {
  hostTracker.stop();
  spectatorTracker.stop();
  for (const socket of sockets) socket.disconnect();
}
