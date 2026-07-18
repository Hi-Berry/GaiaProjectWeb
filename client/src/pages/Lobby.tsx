import { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { GameClient, getSocket, storeSpectatorId } from '@/lib/gameClient';
import { Users, Plus, RefreshCw, Play, LogIn, Eye, Clock, Crown } from 'lucide-react';

interface GameInfo {
  id: string;
  playerCount: number;
  maxPlayers: number;
  phase: string;
  createdAt: number;
  hostName: string | null;
  players: Array<{ id: string; name: string; isHost: boolean }>;
}

function formatCreatedAt(ts: number): { relative: string; absolute: string } {
  if (!ts) return { relative: '시간 미상', absolute: '' };
  const d = new Date(ts);
  const absolute = d.toLocaleString('ko-KR', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const diffMs = Date.now() - ts;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return { relative: '방금 전', absolute };
  if (diffMin < 60) return { relative: `${diffMin}분 전`, absolute };
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return { relative: `${diffHr}시간 전`, absolute };
  const diffDay = Math.floor(diffHr / 24);
  return { relative: `${diffDay}일 전`, absolute };
}

export default function Lobby() {
  const [, setLocation] = useLocation();
  const [games, setGames] = useState<GameInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);
  const [watching, setWatching] = useState<string | null>(null);
  const [playerName, setPlayerName] = useState(() => localStorage.getItem('gaia-playerName') || '');
  const [joinPassword, setJoinPassword] = useState(''); // 방 한정 좌석 비번(선택) — 다른 기기 이어하기용
  const [connected, setConnected] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const socket = getSocket();

    socket.on('connect', () => {
      setConnected(true);
      fetchGames();
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    if (socket.connected) {
      setConnected(true);
      fetchGames();
    }

    return () => {
      socket.off('connect');
      socket.off('disconnect');
    };
  }, []);

  const fetchGames = useCallback(async () => {
    try {
      setLoading(true);
      const data = await GameClient.listGames();
      setGames(data.games || []);
    } catch (error) {
      console.error('Failed to fetch games:', error);
      toast({
        title: 'Connection Error',
        description: 'Could not connect to game server.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!connected) return;

    const interval = setInterval(fetchGames, 5000);
    return () => clearInterval(interval);
  }, [connected, fetchGames]);

  const handleCreateGame = async () => {
    if (!playerName.trim()) {
      toast({
        title: 'Name Required',
        description: 'Please enter your name to create a game.',
        variant: 'destructive',
      });
      return;
    }

    try {
      setCreating(true);
      localStorage.setItem('gaia-playerName', playerName);

      const { gameId, playerId } = await GameClient.createGame(playerName, joinPassword.trim() || undefined);

      localStorage.setItem(`gaia-${gameId}-playerId`, playerId);

      toast({
        title: 'Game Created',
        description: 'Waiting for other players to join...',
      });

      setLocation(`/game/${gameId}`);
    } catch (error) {
      console.error('Failed to create game:', error);
      toast({
        title: 'Error',
        description: 'Failed to create game. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setCreating(false);
    }
  };

  const handleJoinGame = async (gameId: string) => {
    if (!playerName.trim()) {
      toast({
        title: 'Name Required',
        description: 'Please enter your name to join a game.',
        variant: 'destructive',
      });
      return;
    }

    try {
      setJoining(gameId);
      localStorage.setItem('gaia-playerName', playerName);

      const { playerId } = await GameClient.joinGame(gameId, playerName, joinPassword.trim() || undefined);

      localStorage.setItem(`gaia-${gameId}-playerId`, playerId);

      toast({
        title: 'Joined Game',
        description: 'Successfully joined the game!',
      });

      setLocation(`/game/${gameId}`);
    } catch (error: any) {
      console.error('Failed to join game:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to join game. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setJoining(null);
    }
  };

  const handleWatchGame = async (gameId: string) => {
    try {
      setWatching(gameId);
      const { spectatorId } = await GameClient.watchGame(gameId);
      storeSpectatorId(gameId, spectatorId);
      toast({
        title: '관전 시작',
        description: '경기를 관람합니다. 턴은 돌아오지 않습니다.',
      });
      setLocation(`/game/${gameId}`);
    } catch (error: any) {
      console.error('Failed to watch game:', error);
      toast({
        title: 'Error',
        description: error.message || '관전 접속에 실패했습니다.',
        variant: 'destructive',
      });
    } finally {
      setWatching(null);
    }
  };

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold tracking-tight font-orbitron">
            Gaia Project: Forgotten Fleet
          </h1>
          <p className="text-muted-foreground">
            Multiplayer space strategy game for 2-4 players
          </p>
          <Badge variant={connected ? 'default' : 'destructive'}>
            {connected ? 'Connected' : 'Connecting...'}
          </Badge>
        </div>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-center text-sm text-amber-200">
          서버는 주기적으로 오전 업데이트 진행됩니다. 진행 중이던 게임이 종료되니 참고 부탁드립니다.
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Your Info
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-3">
              <Input
                placeholder="Enter your name"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                className="w-full sm:flex-1"
                data-testid="input-player-name"
              />
              <Input
                type="password"
                placeholder="비밀번호 (선택)"
                value={joinPassword}
                onChange={(e) => setJoinPassword(e.target.value)}
                className="w-full sm:w-40"
                data-testid="input-join-password"
              />
              <Button
                onClick={handleCreateGame}
                disabled={creating || !playerName.trim() || !connected}
                data-testid="button-create-game"
                className="w-full sm:w-auto shrink-0"
              >
                <Plus className="w-4 h-4 mr-2" />
                {creating ? 'Creating...' : 'Create Game'}
              </Button>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              비밀번호를 걸어두면 다른 기기(폰 등)에서 같은 방에 같은 이름/비밀번호로 이어할 수 있습니다 — 이 방에서만 쓰는 일회용 비밀번호입니다.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <CardTitle className="flex items-center gap-2">
              <Play className="w-5 h-5" />
              Available Games
            </CardTitle>
            <Button
              variant="outline"
              size="icon"
              onClick={fetchGames}
              disabled={loading || !connected}
              data-testid="button-refresh-games"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </CardHeader>
          <CardContent>
            {loading && games.length === 0 ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-24 w-full" />
                ))}
              </div>
            ) : games.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>No games available</p>
                <p className="text-sm mt-1">Create a new game to get started</p>
              </div>
            ) : (
              <div className="space-y-3">
                {games.map((game) => {
                  const isFull = game.playerCount >= game.maxPlayers;
                  const isStarted = game.phase !== 'lobby';
                  const isFinished = game.phase === 'gameEnd';
                  const storedPlayerId = localStorage.getItem(`gaia-${game.id}-playerId`);
                  const canRejoin = !!storedPlayerId;
                  const phaseLabel = isFinished
                    ? '종료'
                    : game.phase === 'lobby'
                      ? '대기 중'
                      : game.phase.replace(/([A-Z])/g, ' $1').trim();
                  const created = formatCreatedAt(game.createdAt);
                  const roster = game.players ?? [];

                  return (
                    <div
                      key={game.id}
                      className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-4 border rounded-lg gap-4 hover:border-primary/30 transition-colors"
                      data-testid={`game-${game.id}`}
                    >
                      <div className="space-y-2 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-bold">
                            #{game.id}
                          </span>
                          {isFinished && (
                            <Badge variant="secondary">종료</Badge>
                          )}
                          {isStarted && !isFinished && (
                            <Badge variant="default">진행 중</Badge>
                          )}
                          {!isStarted && !isFinished && (
                            <Badge variant="outline" className="border-emerald-500/40 text-emerald-400">
                              로비
                            </Badge>
                          )}
                          {isFull && !isStarted && (
                            <Badge variant="secondary">만원</Badge>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1" title={created.absolute}>
                            <Clock className="w-3.5 h-3.5 shrink-0" />
                            {created.relative}
                            {created.absolute ? ` · ${created.absolute}` : ''}
                          </span>
                          <span className="capitalize">단계: {phaseLabel}</span>
                          {game.hostName && (
                            <span className="flex items-center gap-1">
                              <Crown className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                              방장 {game.hostName}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {roster.length === 0 ? (
                            <span className="text-xs text-muted-foreground italic">아직 없음</span>
                          ) : (
                            roster.map((p) => (
                              <Badge
                                key={p.id}
                                variant="secondary"
                                className={`text-xs font-medium ${p.isHost ? 'border-amber-500/40 bg-amber-500/10' : ''}`}
                              >
                                {p.isHost ? '★ ' : ''}{p.name}
                              </Badge>
                            ))
                          )}
                          {Array.from({ length: Math.max(0, game.maxPlayers - roster.length) }).map((_, i) => (
                            <Badge key={`empty-${i}`} variant="outline" className="text-xs text-muted-foreground/50 border-dashed">
                              빈 자리
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 sm:gap-3 w-full sm:w-auto">
                        <Badge variant="outline">
                          {game.playerCount}/{game.maxPlayers} Players
                        </Badge>
                        {canRejoin ? (
                          <Button
                            variant="default"
                            className="bg-green-600 hover:bg-green-500 text-white"
                            onClick={() => setLocation(`/game/${game.id}`)}
                            data-testid={`button-rejoin-${game.id}`}
                          >
                            <LogIn className="w-4 h-4 mr-2" />
                            이어하기
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            disabled={isFull || isStarted || joining === game.id || !playerName.trim() || !connected}
                            onClick={() => handleJoinGame(game.id)}
                            data-testid={`button-join-${game.id}`}
                          >
                            <LogIn className="w-4 h-4 mr-2" />
                            {joining === game.id ? 'Joining...' : 'Join'}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          disabled={watching === game.id || !connected}
                          onClick={() => handleWatchGame(game.id)}
                          data-testid={`button-watch-${game.id}`}
                        >
                          <Eye className="w-4 h-4 mr-2" />
                          {watching === game.id ? '접속 중...' : 'Watch'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
          <CardFooter className="text-sm text-muted-foreground">
            5초마다 자동 새로고침 · 로비(대기 중) 방이 위에, 최근 생성 순
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
