import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import type { GameState } from '@/lib/gameClient';
import { Users, Play, ArrowLeft, UserPlus, Gamepad2 } from 'lucide-react';

interface GameLobbyProps {
  game: GameState;
  gameId: string;
  playerId: string | null;
  onStartGame: () => void;
  onLeave: () => void;
  onAddPlayer?: (playerName?: string) => Promise<void>;
  onAddBot?: (botName?: string) => Promise<void>;
  onSwitchPlayer?: (targetPlayerId: string) => Promise<void>;
}

export function GameLobby({ game, gameId, playerId, onStartGame, onLeave, onAddPlayer, onAddBot, onSwitchPlayer }: GameLobbyProps) {
  const playerEntries = Object.entries(game.players);
  const playerCount = playerEntries.length;
  const maxPlayers = game.maxPlayers || 4;
  const isHost = playerId === game.hostId;
  const canStart = playerCount >= 1;
  const [addName, setAddName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addingBot, setAddingBot] = useState(false);

  const handleAddPlayer = async () => {
    if (!onAddPlayer || adding || playerCount >= maxPlayers) return;
    setAdding(true);
    try {
      await onAddPlayer(addName.trim() || undefined);
      setAddName('');
    } finally {
      setAdding(false);
    }
  };

  const handleAddBot = async () => {
    if (!onAddBot || addingBot || playerCount >= maxPlayers) return;
    setAddingBot(true);
    try {
      await onAddBot(addName.trim() || undefined);
      setAddName('');
    } finally {
      setAddingBot(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-2xl mx-auto space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold tracking-tight font-orbitron">
            Game Lobby
          </h1>
          <p className="text-muted-foreground font-mono">
            Game ID: {game.id}
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Players ({playerCount}/{maxPlayers})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {playerEntries.map(([id, player]) => (
                <div
                  key={id}
                  className={`flex items-center justify-between p-3 rounded-lg border ${id === playerId ? 'bg-primary/10 border-primary' : 'bg-muted'
                    }`}
                  data-testid={`player-${id}`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 rounded-full bg-green-500" />
                    <span className="font-medium">{player.name}</span>
                    {game.botPlayerIds?.includes(id) && (
                      <Badge variant="secondary" className="bg-orange-500/20 text-orange-500 border-orange-500/30">BOT</Badge>
                    )}
                    {id === playerId && (
                      <Badge variant="outline">(조작 중)</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {id === game.hostId && <Badge>Host</Badge>}
                    {onSwitchPlayer && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8"
                        disabled={id === playerId}
                        onClick={() => onSwitchPlayer(id)}
                        title="이 플레이어로 조작 전환"
                      >
                        <Gamepad2 className="w-4 h-4 mr-1" />
                        {id === playerId ? '현재' : '조작'}
                      </Button>
                    )}
                  </div>
                </div>
              ))}

              {/* 빈 칸: 항상 maxPlayers 개만 표시. 첫 빈 칸에 방장이면 "플레이어 추가" UI */}
              {Array.from({ length: maxPlayers - playerCount }).map((_, i) => (
                <div
                  key={`empty-${i}`}
                  className={`flex items-center gap-2 p-3 rounded-lg border border-dashed ${i === 0 && isHost && onAddPlayer ? 'border-primary/50 bg-primary/5' : 'border-muted-foreground/30'
                    }`}
                >
                  {i === 0 && isHost && onAddPlayer ? (
                    <>
                      <Input
                        placeholder="이름 (선택)"
                        value={addName}
                        onChange={(e) => setAddName(e.target.value)}
                        className="max-w-[120px] h-9 flex-1"
                        onKeyDown={(e) => e.key === 'Enter' && handleAddPlayer()}
                      />
                      <Button
                        size="sm"
                        onClick={handleAddPlayer}
                        disabled={adding || addingBot}
                        data-testid="button-add-player"
                      >
                        <UserPlus className="w-4 h-4 mr-1" />
                        {adding ? '추가 중…' : '플레이어 추가'}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={handleAddBot}
                        disabled={adding || addingBot}
                        data-testid="button-add-ai"
                        className="bg-orange-500/10 text-orange-500 hover:bg-orange-500/20 border-orange-500/20"
                      >
                        <Play className="w-4 h-4 mr-1" />
                        {addingBot ? '봇 추가 중…' : 'AI 봇 추가'}
                      </Button>
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      {isHost && onAddPlayer ? '플레이어 추가로 채우기' : 'Waiting for player...'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
          <CardFooter className="flex justify-between gap-4">
            <Button
              variant="outline"
              onClick={onLeave}
              data-testid="button-leave-lobby"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Leave
            </Button>

            {isHost && (
              <Button
                onClick={onStartGame}
                disabled={!canStart}
                data-testid="button-start-game"
              >
                <Play className="w-4 h-4 mr-2" />
                Start Game {!canStart && '(Need 1+ players)'}
              </Button>
            )}

            {!isHost && (
              <div className="text-muted-foreground text-sm">
                Waiting for host to start the game...
              </div>
            )}
          </CardFooter>
        </Card>

        <div className="text-center text-sm text-muted-foreground">
          {isHost && onAddPlayer
            ? '한 컴퓨터에서 "플레이어 추가" 후 "조작"으로 교대하며 4인플 가능'
            : 'Share the game ID with friends to let them join'}
        </div>
      </div>
    </div>
  );
}
