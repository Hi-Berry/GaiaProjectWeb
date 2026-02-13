import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { GameState } from '@/lib/gameClient';
import { Check } from 'lucide-react';
import { useState } from 'react';

import { FACTIONS, RESEARCH_TRACKS, ALL_TECH_TILES, PLANET_COLORS, FINAL_MISSION_LABELS } from '@shared/gameConfig';

interface FactionSelectProps {
  game: GameState;
  playerId: string | null;
  onSelectFaction: (factionId: string, turnOrder?: number) => void;
  onConfirm: () => void;
}

export function FactionSelect({ game, playerId, onSelectFaction, onConfirm }: FactionSelectProps) {
  const currentPlayer = playerId ? game.players[playerId] : null;
  const selectedFaction = currentPlayer?.faction;
  const [selectedTurnOrder, setSelectedTurnOrder] = useState<number | null>(null);

  const takenFactions = Object.entries(game.players)
    .filter(([id]) => id !== playerId)
    .map(([, p]) => p.faction)
    .filter(Boolean);

  const allSelected = Object.values(game.players).every(p => p.faction !== null);

  // 선택된 턴 순서들 (다른 플레이어가 선택한 것)
  const takenTurnOrders = Object.entries(game.players)
    .filter(([id]) => id !== playerId)
    .map(([, p]) => (p as any).selectedTurnOrder)
    .filter((order): order is number => typeof order === 'number');

  // 사용 가능한 턴 순서 (1부터 플레이어 수까지)
  const numPlayers = Object.keys(game.players).length;
  const availableTurnOrders = Array.from({ length: numPlayers }, (_, i) => i + 1);

  const finalMissionIds = game.finalMissionIds ?? [];

  return (
    <div className="space-y-4">
        <div className="text-center space-y-1">
          <h1 className="text-xl font-bold tracking-tight font-orbitron">
            Choose Your Faction
          </h1>
          <p className="text-xs text-muted-foreground">
            Select faction and turn order
          </p>
        </div>

        {/* 이번 게임 최종 미션 (종족 고르기 전에 확인) */}
        {finalMissionIds.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2">
            <p className="text-[10px] uppercase font-bold text-amber-400/90 tracking-widest mb-1.5">
              이번 게임 최종 미션 (6라운드 종료 시 1/2/3등 18·12·6점)
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-amber-200/95">
              {finalMissionIds.map((id) => (
                <span key={id}>{FINAL_MISSION_LABELS[id] ?? id}</span>
              ))}
            </div>
          </div>
        )}

        {/* Turn Order Selection */}
        <div className="space-y-2">
          <p className="text-sm font-semibold text-zinc-300">Turn Order</p>
          <div className="grid grid-cols-4 gap-2">
            {availableTurnOrders.map((order) => {
              const isTaken = takenTurnOrders.includes(order);
              const isSelected = selectedTurnOrder === order;
              return (
                <Button
                  key={order}
                  variant={isSelected ? 'default' : 'outline'}
                  size="sm"
                  className={`h-10 ${isSelected ? 'bg-blue-600 hover:bg-blue-500' : ''} ${isTaken ? 'opacity-40 cursor-not-allowed' : ''}`}
                  disabled={isTaken}
                  onClick={() => !isTaken && setSelectedTurnOrder(order)}
                >
                  {order}
                  {isTaken && <span className="ml-1 text-xs">(Taken)</span>}
                </Button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {FACTIONS.map((faction) => {
            const isSelected = selectedFaction === faction.id;

            // Check if this specific faction is taken by someone else
            const isFactionTaken = takenFactions.includes(faction.id);

            // Check if this color is taken by someone else
            const isColorTaken = Object.entries(game.players).some(([id, p]) => {
              if (id === playerId || !p.faction) return false;
              const otherFaction = FACTIONS.find(f => f.id === p.faction);
              return otherFaction?.color === faction.color;
            });

            const isDisabled = isFactionTaken || isColorTaken;

            return (
              <Card
                key={faction.id}
                className={`cursor-pointer transition-all ${isSelected ? 'ring-2 ring-primary' : ''
                  } ${isDisabled ? 'opacity-40 grayscale-[0.5]' : selectedTurnOrder === null ? 'opacity-60' : 'hover-elevate'}`}
                onClick={() => {
                  if (!isDisabled && selectedTurnOrder !== null) {
                    onSelectFaction(faction.id, selectedTurnOrder);
                  }
                }}
                data-testid={`faction-${faction.id}`}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm">{faction.name}</CardTitle>
                    {isSelected && (
                      <Check className="w-5 h-5 text-primary" />
                    )}
                    {isFactionTaken ? (
                      <Badge variant="secondary">Taken</Badge>
                    ) : isColorTaken ? (
                      <Badge variant="outline" className="text-slate-500 border-slate-500">Color Taken</Badge>
                    ) : null}
                  </div>
                  <div
                    className="h-1 rounded-full mt-1"
                    style={{ backgroundColor: faction.color }}
                  />
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground capitalize">
                    Home Planet: {faction.homePlanet}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="flex justify-center">
          {selectedFaction && !allSelected && (
            <div className="text-center space-y-2">
              <p className="text-muted-foreground">
                Waiting for other players to select their factions...
              </p>
              <div className="flex gap-2 justify-center flex-wrap">
                {Object.entries(game.players).map(([id, player]) => (
                  <Badge
                    key={id}
                    variant={player.faction ? 'default' : 'secondary'}
                  >
                    {player.name}: {player.faction || 'Selecting...'}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {allSelected && (
            <Button
              size="lg"
              className="w-full"
              onClick={onConfirm}
              data-testid="button-confirm-factions"
            >
              Continue to Mine Placement
            </Button>
          )}
          {selectedFaction && !selectedTurnOrder && (
            <p className="text-xs text-yellow-400 text-center">Please select a turn order</p>
          )}
        </div>
    </div>
  );
}
