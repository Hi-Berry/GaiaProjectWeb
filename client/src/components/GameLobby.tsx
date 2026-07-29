import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import type { GameState } from '@/lib/gameClient';
import { Users, Play, ArrowLeft, UserPlus, Trash2 } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { GameClient } from '@/lib/gameClient';

interface GameLobbyProps {
  game: GameState;
  gameId: string;
  playerId: string | null;
  isSpectator?: boolean;
  onStartGame: () => void;
  onLeave: () => void;
  onAddPlayer?: (playerName?: string) => Promise<void>;
  onAddBot?: (botName?: string) => Promise<void>;
  /** 방장 전용: 추가한 플레이어/봇 제거 (잘못 추가 시) */
  onRemovePlayer?: (targetPlayerId: string) => void | Promise<void>;
  onAutoSetupTest?: () => void;
  /** 방장 전용: 시작 전 방 삭제 후 로비로 나가기 */
  onDeleteRoom?: () => void;
}

export function GameLobby({ game, gameId, playerId, isSpectator, onStartGame, onLeave, onAddPlayer, onAddBot, onRemovePlayer, onAutoSetupTest, onDeleteRoom }: GameLobbyProps) {
  const playerEntries = Object.entries(game.players);
  const playerCount = playerEntries.length;
  const maxPlayers = game.maxPlayers || 4;
  const isHost = !isSpectator && playerId === game.hostId;
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
    // 좌하단 고정 채팅 버튼(~60px)이 맨 아래 힌트 텍스트를 가리지 않도록 모바일에서 하단 여백 확보(사용자 관찰)
    <div className="min-h-screen bg-background p-8 pb-24 md:pb-8">
      <div className="max-w-2xl mx-auto space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold tracking-tight font-orbitron">
            Game Lobby
          </h1>
          <p className="text-muted-foreground font-mono">
            Game ID: {game.id}
          </p>
          {isSpectator && (
            <Badge variant="secondary" className="bg-amber-500/20 text-amber-600 border-amber-500/40">
              관전 중 — 턴 없음
            </Badge>
          )}
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
                    {onRemovePlayer && id !== game.hostId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-red-400 hover:text-red-300 hover:bg-red-950/40"
                        onClick={() => onRemovePlayer(id)}
                        title="이 플레이어/봇 제거"
                      >
                        <Trash2 className="w-4 h-4 mr-1" />
                        삭제
                      </Button>
                    )}
                  </div>
                </div>
              ))}

              {/* 빈 칸: 항상 maxPlayers 개만 표시. 첫 빈 칸에 방장이면 "플레이어 추가" UI */}
              {Array.from({ length: maxPlayers - playerCount }).map((_, i) => (
                <div
                  key={`empty-${i}`}
                  className={`flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-lg border border-dashed ${i === 0 && isHost && onAddPlayer ? 'border-primary/50 bg-primary/5' : 'border-muted-foreground/30'
                    }`}
                >
                  {i === 0 && isHost && onAddPlayer ? (
                    <>
                      <div className="flex gap-2 flex-1 w-full">
                        <Input
                          placeholder="이름 (선택)"
                          value={addName}
                          onChange={(e) => setAddName(e.target.value)}
                          className="h-9 flex-1"
                          onKeyDown={(e) => e.key === 'Enter' && handleAddPlayer()}
                        />
                        <Button
                          size="sm"
                          onClick={handleAddPlayer}
                          disabled={adding || addingBot}
                          data-testid="button-add-player"
                          className="whitespace-nowrap"
                        >
                          <UserPlus className="w-4 h-4 mr-1" />
                          {adding ? '추가 중…' : '추가'}
                        </Button>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={handleAddBot}
                        disabled={adding || addingBot}
                        data-testid="button-add-ai"
                        className="bg-orange-500/10 text-orange-500 hover:bg-orange-500/20 border-orange-500/20 w-full sm:w-auto"
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
          <CardFooter className="flex flex-col sm:flex-row justify-between gap-4">
            <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
              <Button
                variant="outline"
                onClick={onLeave}
                data-testid="button-leave-lobby"
                className="w-full sm:w-auto"
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Leave
              </Button>
              {isHost && onDeleteRoom && (
                <Button
                  variant="outline"
                  onClick={() => { if (window.confirm('이 방을 삭제하고 로비로 나갈까요?')) onDeleteRoom(); }}
                  data-testid="button-delete-room"
                  className="w-full sm:w-auto border-red-500/40 text-red-400 hover:bg-red-950/40 hover:text-red-300"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  방 삭제
                </Button>
              )}
            </div>

            {isHost && (
              <div className="flex flex-col gap-3 w-full sm:w-auto">
                <div className="flex items-center space-x-2 rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2">
                  <Checkbox
                    id="use-faction-bidding"
                    checked={!!game.useFactionBidding}
                    onCheckedChange={async (v) => {
                      try {
                        await GameClient.setUseFactionBidding(gameId, v === true);
                      } catch (e) {
                        console.error(e);
                      }
                    }}
                  />
                  <Label htmlFor="use-faction-bidding" className="text-sm cursor-pointer leading-tight">
                    종족 비딩 사용 (경매 후 종족·턴 선택, AI는 랜덤 즉시 배정)
                  </Label>
                </div>
                <div className="flex items-center space-x-2 rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2">
                  <Checkbox
                    id="friendly-match"
                    checked={!!game.friendlyMatch}
                    onCheckedChange={async (v) => {
                      try {
                        await GameClient.setFriendlyMatch(gameId, v === true);
                      } catch (e) {
                        console.error(e);
                      }
                    }}
                  />
                  <Label htmlFor="friendly-match" className="text-sm cursor-pointer leading-tight">
                    친선전 (기록 사이트에 자동 저장되지 않습니다)
                  </Label>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    variant="secondary"
                    onClick={onAutoSetupTest}
                    className="bg-purple-500/10 text-purple-500 hover:bg-purple-500/20 border-purple-500/20 text-xs sm:text-sm"
                  >
                    Auto Setup (Random)
                  </Button>
                  <Button
                    onClick={onStartGame}
                    disabled={!canStart}
                    data-testid="button-start-game"
                    className="w-full sm:w-auto"
                  >
                    <Play className="w-4 h-4 mr-2" />
                    Start Game {!canStart && '(Need 1+)'}
                  </Button>
                </div>
              </div>
            )}

            {!isHost && (
              <div className="flex flex-col gap-2 w-full sm:w-auto sm:items-end">
                {/* [사용자] 방에 있는 다른 사람도 현재 옵션 확인 가능 (읽기전용) */}
                <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs w-full sm:w-auto">
                  <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">게임 옵션</div>
                  <div className={game.useFactionBidding ? 'text-amber-300 font-bold' : 'text-zinc-500'}>
                    {game.useFactionBidding ? '☑' : '☐'} 종족 비딩 {game.useFactionBidding ? '사용' : '미사용'}
                  </div>
                  <div className={game.friendlyMatch ? 'text-emerald-300 font-bold' : 'text-zinc-500'}>
                    {game.friendlyMatch ? '☑' : '☐'} 친선전 {game.friendlyMatch ? '(기록 미저장)' : '(기록 저장)'}
                  </div>
                </div>
                <div className="text-muted-foreground text-sm text-center sm:text-right">
                  {isSpectator ? '관전 중입니다. 시작되면 경기가 보입니다.' : 'Waiting for host to start the game...'}
                </div>
              </div>
            )}
          </CardFooter>
        </Card>

        <div className="text-center text-sm text-muted-foreground">
          {isHost && onAddPlayer
            ? '"플레이어 추가" / "AI 봇 추가"로 자리를 채우고, 잘못 추가했으면 "삭제"로 제거하세요'
            : 'Share the game ID with friends to let them join'}
        </div>
      </div>
    </div>
  );
}
