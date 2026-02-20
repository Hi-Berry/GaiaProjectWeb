import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Gift, Zap, Coins, FlaskConical, Gem, Target, Compass, Mountain, Award } from 'lucide-react';
import type { GaiaGameState as GameState, BonusTile } from '@shared/gameConfig';
import { ALL_BONUS_TILES, FACTIONS, FEDERATION_REWARDS } from '@shared/gameConfig';

interface BonusTilesProps {
  game: GameState;
  playerId: string | null;
  onSelectBonusTile?: (tileId: string) => void;
  onUseBonusAction?: () => void;
  isSelectionMode?: boolean;
}

function getBonusIcon(tile: BonusTile) {
  if (tile.specialAction === 'terraform_step') return <Mountain className="w-3 h-3 text-amber-400" />;
  if (tile.specialAction === 'range_3') return <Compass className="w-3 h-3 text-cyan-400" />;
  if (tile.specialAction === 'gaia_project') return <Target className="w-3 h-3 text-green-400" />;
  if (tile.income?.power && tile.income.power >= 4) return <Zap className="w-3 h-3 text-purple-400" />;
  if (tile.income?.knowledge) return <FlaskConical className="w-3 h-3 text-blue-400" />;
  if (tile.income?.credits && tile.income.credits >= 3) return <Coins className="w-3 h-3 text-yellow-400" />;
  if (tile.income?.ore) return <Gem className="w-3 h-3 text-orange-400" />;
  return <Gift className="w-3 h-3 text-zinc-400" />;
}

function getPassBonusLabel(type: string): string {
  const labels: Record<string, string> = {
    'big_building': 'Big Bldg',
    'mine': 'Mine',
    'trading_station': 'TS',
    'research_lab': 'Lab',
    'gaiaformer': 'GF',
    'planet_type': 'Type',
    'gaia': 'Gaia',
    'bridge_sector': 'Bridge',
  };
  return labels[type] || type;
}

function getActionLabel(action: string): string {
  const labels: Record<string, string> = {
    'terraform_step': 'Free TF Step',
    'gaia_project': 'Gaia Project',
    'range_3': '+3 Range',
  };
  return labels[action] || action;
}

function BonusTileCard({
  tile,
  isOwned,
  ownerName,
  ownerColor,
  isSelectable,
  isUsed,
  hasAction,
  onSelect,
  onUseAction,
}: {
  tile: BonusTile;
  isOwned: boolean;
  ownerName?: string;
  ownerColor?: string;
  isSelectable: boolean;
  isUsed?: boolean;
  hasAction?: boolean;
  onSelect?: () => void;
  onUseAction?: () => void;
}) {
  return (
    <div
      className={`relative p-3 rounded-xl border transition-all duration-300 ${
        isOwned
          ? 'bg-primary/10 border-primary/30 shadow-[0_0_15px_rgba(var(--primary),0.1)]'
          : isSelectable
          ? 'bg-zinc-900/50 border-white/10 hover:border-primary/50 hover:bg-zinc-800/50 cursor-pointer'
          : 'bg-zinc-900/30 border-white/5 opacity-60'
      }`}
      onClick={isSelectable && onSelect ? onSelect : undefined}
    >
      {/* Owner indicator */}
      {isOwned && ownerColor && (
        <div
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full border-2 border-zinc-900"
          style={{ backgroundColor: ownerColor }}
          title={ownerName}
        />
      )}

      {/* Tile Header */}
      <div className="flex items-center gap-2 mb-2">
        {getBonusIcon(tile)}
        <span className="text-[10px] font-black uppercase tracking-wider text-zinc-200">
          {tile.label}
        </span>
      </div>

      {/* Income Display */}
      {tile.income && (
        <div className="flex flex-wrap gap-1 mb-2">
          {tile.income.ore && (
            <Badge variant="outline" className="text-[8px] bg-orange-500/10 border-orange-500/30 text-orange-400">
              +{tile.income.ore}O
            </Badge>
          )}
          {tile.income.credits && (
            <Badge variant="outline" className="text-[8px] bg-yellow-500/10 border-yellow-500/30 text-yellow-400">
              +{tile.income.credits}C
            </Badge>
          )}
          {tile.income.knowledge && (
            <Badge variant="outline" className="text-[8px] bg-blue-500/10 border-blue-500/30 text-blue-400">
              +{tile.income.knowledge}K
            </Badge>
          )}
          {tile.income.qic && (
            <Badge variant="outline" className="text-[8px] bg-green-500/10 border-green-500/30 text-green-400">
              +{tile.income.qic}Q
            </Badge>
          )}
          {tile.income.power && (
            <Badge variant="outline" className="text-[8px] bg-purple-500/10 border-purple-500/30 text-purple-400">
              +{tile.income.power}P
            </Badge>
          )}
          {tile.income.powerTokens && (
            <Badge variant="outline" className="text-[8px] bg-violet-500/10 border-violet-500/30 text-violet-400">
              +{tile.income.powerTokens} Tokens
            </Badge>
          )}
        </div>
      )}

      {/* Pass Bonus Display */}
      {tile.passBonus && (
        <div className="mb-2">
          <Badge variant="outline" className="text-[8px] bg-emerald-500/10 border-emerald-500/30 text-emerald-400">
            Pass: {tile.passBonus.vp}VP/{getPassBonusLabel(tile.passBonus.type)}
          </Badge>
        </div>
      )}

      {/* Special Action */}
      {tile.specialAction && (
        <div className="mb-2">
          <Badge variant="outline" className="text-[8px] bg-cyan-500/10 border-cyan-500/30 text-cyan-400">
            ACT: {getActionLabel(tile.specialAction)}
          </Badge>
        </div>
      )}

      {/* Use Action Button (only for owned tiles) */}
      {tile.specialAction && isOwned && (
        <Button
          size="sm"
          variant="outline"
          className={`w-full h-6 text-[8px] uppercase mt-2 ${
            isUsed
              ? 'opacity-30 cursor-not-allowed'
              : 'border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10'
          }`}
          disabled={isUsed}
          onClick={(e) => {
            e.stopPropagation();
            onUseAction?.();
          }}
        >
          {isUsed ? 'Used' : 'Use Action'}
        </Button>
      )}


      {/* Description Tooltip */}
      <div className="mt-2 text-[8px] text-zinc-500 leading-tight">
        {tile.description}
      </div>
    </div>
  );
}

export function BonusTiles({
  game,
  playerId,
  onSelectBonusTile,
  onUseBonusAction,
  isSelectionMode = false,
}: BonusTilesProps) {
  const currentPlayer = playerId ? game.players[playerId] : null;

  // Get all players' bonus tiles
  const playerBonusTiles = Object.entries(game.players)
    .filter(([_, p]) => p.bonusTile)
    .map(([id, p]) => {
      const faction = FACTIONS.find(f => f.id === p.faction);
      return {
        tileId: p.bonusTile!,
        playerId: id,
        playerName: p.name,
        playerColor: faction?.color || '#666',
      };
    });

  const pool = game.federationPool ?? {};
  return (
    <Card className="w-full bg-zinc-950 border-white/5 text-zinc-100 overflow-hidden font-orbitron">
      <CardContent className="p-4 space-y-6">
        {/* Bonus Tiles — first */}
        <div className="space-y-3">
          <h3 className="text-xs font-black uppercase tracking-widest text-primary flex items-center gap-2">
            <Gift className="w-4 h-4" />
            {isSelectionMode ? 'Select Bonus' : 'Bonus Tiles'}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {/* Available Bonus Tiles */}
              {game.availableBonusTiles.map((tile) => (
                <BonusTileCard
                  key={tile.id}
                  tile={tile}
                  isOwned={false}
                  isSelectable={isSelectionMode && !!onSelectBonusTile}
                  onSelect={() => onSelectBonusTile?.(tile.id)}
                />
              ))}

              {/* Player-owned Bonus Tiles */}
              {!isSelectionMode &&
                playerBonusTiles.map(({ tileId, playerId: ownerId, playerName, playerColor }) => {
                  const tile = ALL_BONUS_TILES.find(t => t.id === tileId);
                  if (!tile) return null;

                  const isCurrentPlayer = ownerId === playerId;
                  const owner = game.players[ownerId];

                  return (
                    <BonusTileCard
                      key={`owned-${tileId}`}
                      tile={tile}
                      isOwned={true}
                      ownerName={playerName}
                      ownerColor={playerColor}
                      isSelectable={false}
                      isUsed={isCurrentPlayer ? owner?.usedBonusAction : undefined}
                      hasAction={!!tile.specialAction}
                      onUseAction={isCurrentPlayer ? onUseBonusAction : undefined}
                    />
                  );
                })}
              {game.availableBonusTiles.length === 0 && !isSelectionMode && playerBonusTiles.length === 0 && (
                <div className="text-center text-zinc-500 text-sm py-8 col-span-full">
                  No bonus tiles available
                </div>
              )}
          </div>
        </div>

        {/* Federation (remaining) — compact, below Bonus Tiles */}
        <div className="space-y-1.5">
          <h3 className="text-[10px] font-black uppercase tracking-widest text-amber-400 flex items-center gap-1.5">
            <Award className="w-3 h-3" />
            Federation (remaining)
          </h3>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
            {FEDERATION_REWARDS.map((r) => {
              const n = pool[r.id] ?? 0;
              return (
                <div
                  key={r.id}
                  className="px-1.5 py-1 rounded-md bg-amber-950/40 border border-amber-500/30 flex flex-col items-center justify-center gap-0"
                >
                  <span className="text-[9px] font-bold text-amber-200 text-center leading-tight truncate max-w-full">{r.label}</span>
                  <span className="text-xs font-black text-amber-400">×{n}</span>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Compact version for PlayerPanel
export function PlayerBonusTile({
  game,
  playerId,
  onUseBonusAction,
}: {
  game: GameState;
  playerId: string | null;
  onUseBonusAction?: () => void;
}) {
  if (!playerId) return null;

  const player = game.players[playerId];
  if (!player?.bonusTile) return null;

  const tile = ALL_BONUS_TILES.find(t => t.id === player.bonusTile);
  if (!tile) return null;

  return (
    <div className="space-y-2">
      <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground">
        Bonus Tile
      </h4>
      <div className="p-3 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20">
        <div className="flex items-center gap-2 mb-2">
          {getBonusIcon(tile)}
          <span className="text-[11px] font-black uppercase tracking-wider text-zinc-100">
            {tile.label}
          </span>
        </div>

        {/* Income badges */}
        <div className="flex flex-wrap gap-1 mb-2">
          {tile.income?.ore && (
            <Badge variant="outline" className="text-[7px] bg-orange-500/10 border-orange-500/20 text-orange-400 px-1.5 py-0">
              +{tile.income.ore}O
            </Badge>
          )}
          {tile.income?.credits && (
            <Badge variant="outline" className="text-[7px] bg-yellow-500/10 border-yellow-500/20 text-yellow-400 px-1.5 py-0">
              +{tile.income.credits}C
            </Badge>
          )}
          {tile.income?.knowledge && (
            <Badge variant="outline" className="text-[7px] bg-blue-500/10 border-blue-500/20 text-blue-400 px-1.5 py-0">
              +{tile.income.knowledge}K
            </Badge>
          )}
          {tile.income?.qic && (
            <Badge variant="outline" className="text-[7px] bg-green-500/10 border-green-500/20 text-green-400 px-1.5 py-0">
              +{tile.income.qic}Q
            </Badge>
          )}
          {tile.income?.power && (
            <Badge variant="outline" className="text-[7px] bg-purple-500/10 border-purple-500/20 text-purple-400 px-1.5 py-0">
              +{tile.income.power}P
            </Badge>
          )}
          {tile.income?.powerTokens && (
            <Badge variant="outline" className="text-[7px] bg-violet-500/10 border-violet-500/20 text-violet-400 px-1.5 py-0">
              +{tile.income.powerTokens}Tok
            </Badge>
          )}
        </div>

        {/* Pass Bonus */}
        {tile.passBonus && (
          <Badge variant="outline" className="text-[7px] bg-emerald-500/10 border-emerald-500/20 text-emerald-400 px-1.5 py-0">
            Pass: {tile.passBonus.vp}VP/{getPassBonusLabel(tile.passBonus.type)}
          </Badge>
        )}

        {/* Special Action indicator */}
        {tile.specialAction && (
          <Badge variant="outline" className="text-[7px] bg-cyan-500/10 border-cyan-500/20 text-cyan-400 px-1.5 py-0 ml-1">
            ACT: {getActionLabel(tile.specialAction)}
          </Badge>
        )}

        {/* Special Action Button */}
        {tile.specialAction && (
          <Button
            size="sm"
            variant="outline"
            className={`w-full h-7 text-[9px] uppercase mt-2 ${
              player.usedBonusAction
                ? 'opacity-30 cursor-not-allowed bg-zinc-900'
                : 'border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10'
            }`}
            disabled={player.usedBonusAction}
            onClick={onUseBonusAction}
          >
            {player.usedBonusAction ? 'Action Used' : 'Use Special Action'}
          </Button>
        )}
      </div>
    </div>
  );
}
