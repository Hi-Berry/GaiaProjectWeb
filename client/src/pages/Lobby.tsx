import { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { GameClient, getSocket } from '@/lib/gameClient';
import { Users, Plus, RefreshCw, Play, LogIn } from 'lucide-react';

interface GameInfo {
  id: string;
  playerCount: number;
  maxPlayers: number;
  phase: string;
  createdAt: number;
}

export default function Lobby() {
  const [, setLocation] = useLocation();
  const [games, setGames] = useState<GameInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);
  const [playerName, setPlayerName] = useState(() => localStorage.getItem('gaia-playerName') || '');
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
      
      const { gameId, playerId } = await GameClient.createGame(playerName);
      
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

      const { playerId } = await GameClient.joinGame(gameId, playerName);
      
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

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Your Info
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-4">
              <Input
                placeholder="Enter your name"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                className="flex-1"
                data-testid="input-player-name"
              />
              <Button
                onClick={handleCreateGame}
                disabled={creating || !playerName.trim() || !connected}
                data-testid="button-create-game"
              >
                <Plus className="w-4 h-4 mr-2" />
                {creating ? 'Creating...' : 'Create Game'}
              </Button>
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
                  <Skeleton key={i} className="h-16 w-full" />
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

                  return (
                    <div
                      key={game.id}
                      className="flex items-center justify-between p-4 border rounded-lg"
                      data-testid={`game-${game.id}`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm">
                            Game #{game.id}
                          </span>
                          {isStarted && (
                            <Badge>In Progress</Badge>
                          )}
                          {isFull && !isStarted && (
                            <Badge variant="secondary">Full</Badge>
                          )}
                        </div>
                        <div className="text-sm text-muted-foreground capitalize">
                          Phase: {game.phase}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge variant="outline">
                          {game.playerCount}/{game.maxPlayers} Players
                        </Badge>
                        <Button
                          variant="secondary"
                          disabled={isFull || isStarted || joining === game.id || !playerName.trim() || !connected}
                          onClick={() => handleJoinGame(game.id)}
                          data-testid={`button-join-${game.id}`}
                        >
                          <LogIn className="w-4 h-4 mr-2" />
                          {joining === game.id ? 'Joining...' : 'Join'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
          <CardFooter className="text-sm text-muted-foreground">
            Games refresh automatically every 5 seconds
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
