import * as fs from 'fs';
import * as path from 'path';
import type { GaiaGameState, PlayerState } from '@shared/gameConfig';
import { log } from './index';

export type HumanActionJournalEntry = {
  id: string;
  timestamp: number;
  gameId: string;
  round: number;
  phase: string;
  playerId: string;
  playerName: string;
  faction?: string | null;
  action: string;
  details?: string;
  tileId?: string;
  scoreBefore?: number;
  scoreAfter?: number;
  playerBefore?: ReturnType<typeof summarizePlayer>;
  playerAfter?: ReturnType<typeof summarizePlayer>;
};

type HumanGamePayload = {
  version: 1;
  gameId: string;
  createdAt?: number;
  completedAt: string;
  roundNumber: number;
  players: Record<string, ReturnType<typeof summarizePlayer> & { rank: number }>;
  turnOrder: string[];
  gameLog: NonNullable<GaiaGameState['gameLog']>;
  actionJournal: HumanActionJournalEntry[];
};

function summarizePlayer(player?: PlayerState | null) {
  if (!player) return null;
  return {
    name: player.name,
    faction: player.faction,
    score: player.score ?? 0,
    resources: {
      credits: player.credits ?? 0,
      ore: player.ore ?? 0,
      knowledge: player.knowledge ?? 0,
      qic: player.qic ?? 0,
      power1: player.power1 ?? 0,
      power2: player.power2 ?? 0,
      power3: player.power3 ?? 0,
    },
    research: { ...(player.research ?? {}) },
    techTiles: [...(player.techTiles ?? [])],
    federations: player.federations ?? [],
    bonusTile: player.bonusTile,
  };
}

export function recordHumanActionFromLog(game: GaiaGameState & {
  id?: string;
  botPlayerIds?: string[];
  turnStartState?: Record<string, any>;
  humanActionJournal?: HumanActionJournalEntry[];
  simulation?: boolean;
}, playerId: string, action: string, details?: string, tileId?: string) {
  if (game.simulation) return;
  if (!game.id) return;
  if (game.botPlayerIds?.includes(playerId)) return;
  if (!['main', 'startingMines', 'bonusSelection', 'factionBidding'].includes(String(game.currentPhase))) return;

  const player = game.players[playerId];
  if (!player) return;
  if (!game.humanActionJournal) game.humanActionJournal = [];

  const startPlayer = game.turnStartState?.[playerId]?.playerState as PlayerState | undefined;
  game.humanActionJournal.push({
    id: `${game.id}-${Date.now()}-${game.humanActionJournal.length}`,
    timestamp: Date.now(),
    gameId: game.id,
    round: game.roundNumber ?? 0,
    phase: String(game.currentPhase),
    playerId,
    playerName: player.name,
    faction: player.faction,
    action,
    details,
    tileId,
    scoreBefore: startPlayer?.score,
    scoreAfter: player.score,
    playerBefore: summarizePlayer(startPlayer),
    playerAfter: summarizePlayer(player),
  });
}

function buildPayload(game: GaiaGameState & {
  id?: string;
  createdAt?: number;
  humanActionJournal?: HumanActionJournalEntry[];
}): HumanGamePayload {
  const rankedIds = Object.keys(game.players).sort((a, b) => (game.players[b].score ?? 0) - (game.players[a].score ?? 0));
  const players: HumanGamePayload['players'] = {};
  rankedIds.forEach((playerId, index) => {
    players[playerId] = {
      ...(summarizePlayer(game.players[playerId])!),
      rank: index + 1,
    };
  });

  return {
    version: 1,
    gameId: game.id ?? 'unknown',
    createdAt: game.createdAt,
    completedAt: new Date().toISOString(),
    roundNumber: game.roundNumber ?? 0,
    players,
    turnOrder: [...(game.turnOrder ?? [])],
    gameLog: game.gameLog ?? [],
    actionJournal: game.humanActionJournal ?? [],
  };
}

function writeLocalPayload(payload: HumanGamePayload) {
  const dir = path.join(process.cwd(), 'data', 'human-games');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${payload.completedAt.slice(0, 10)}_${payload.gameId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  log(`Human game dataset saved locally: ${filePath}`, 'system', payload.gameId);
}

async function uploadToSupabase(payload: HumanGamePayload) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const tableName = process.env.HUMAN_LOG_SUPABASE_TABLE || 'human_game_sessions';
  if (!supabaseUrl || !serviceKey) {
    writeLocalPayload(payload);
    return;
  }

  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${tableName}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      game_id: payload.gameId,
      completed_at: payload.completedAt,
      payload,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase upload failed: ${res.status} ${body}`);
  }
  log(`Human game dataset uploaded to Supabase: ${payload.gameId}`, 'system', payload.gameId);
}

export async function exportHumanGameDataset(game: GaiaGameState & {
  id?: string;
  createdAt?: number;
  humanActionJournal?: HumanActionJournalEntry[];
}) {
  if ((game as any).simulation) return;
  const payload = buildPayload(game);
  if (payload.actionJournal.length === 0 && payload.gameLog.length === 0) return;

  const storage = (process.env.HUMAN_LOG_STORAGE || '').toLowerCase();
  if (storage === 'supabase') {
    await uploadToSupabase(payload);
    return;
  }
  writeLocalPayload(payload);
}
