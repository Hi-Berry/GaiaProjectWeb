import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Gift, Zap, Coins, FlaskConical, Gem, Target, Compass, Mountain, Award, Ship } from 'lucide-react';
import type { GaiaGameState as GameState, BonusTile } from '@shared/gameConfig';
import { ALL_BONUS_TILES, FACTIONS, FEDERATION_REWARDS, SPACESHIP_FEDERATION_REWARDS } from '@shared/gameConfig';

interface BonusTilesProps {
  game: GameState;
  playerId: string | null;
  onSelectBonusTile?: (tileId: string) => void;
  onUseBonusAction?: () => void;
  isSelectionMode?: boolean;
  isMini?: boolean;
}

function getBonusIcon(tile: BonusTile) {
  if (tile.specialAction === 'terraform_step') return <Mountain className="w-3 h-3 text-amber-400" />;
  if (tile.specialAction === 'range_3') return <Compass className="w-3 h-3 text-cyan-400" />;
  if (tile.specialAction === 'gaia_project') return <Target className="w-3 h-3 text-green-400" />;
  if (tile.income?.power && tile.income.power >= 4) return <Zap className="w-3 h-3 text-purple-400" />;
  if (tile.income?.knowledge) return <FlaskConical className="w-3 h-3 text-blue-400" />;
  if (tile.income?.credits && tile.income.credits >= 3) return <Coins className="w-3 h-3 text-yellow-400" />;
  if (tile.income?.ore) return <Gem className="w-3 h-3 text-zinc-400" />;
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
  onSelect,
  hasAction,
  onUseAction,
  isMini,
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
  isMini?: boolean;
}) {
  const tileIndex = ALL_BONUS_TILES.findIndex(t => t.id === tile.id);
  const tileImg = tileIndex !== -1 ? `/image/BoostTile_${tileIndex + 1}.jpg` : null;

  return (
    <div
      className={`relative rounded-lg overflow-hidden transition-all duration-300 ${isOwned
        ? 'ring-2 ring-primary ring-offset-1 ring-offset-zinc-950 shadow-[0_0_15px_rgba(var(--primary),0.2)]'
        : isSelectable
          ? 'hover:scale-105 hover:shadow-xl cursor-pointer'
          : 'opacity-70'
        }`}
      style={{
        // 미니: 라운드 타일과 동일 축소 비율(≈0.45배, 원본 78×249 → 35×113)
        width: isMini ? '35px' : '80px',
        height: isMini ? '113px' : '128px'
      }}
      onClick={isSelectable && onSelect ? onSelect : undefined}
    >
      {tileImg ? (
        <div className="w-full h-full relative group">
          <img
            src={tileImg}
            alt={tile.label}
            className={`w-full h-full object-contain brightness-105 saturate-[1.05] ${isUsed ? 'grayscale brightness-50 opacity-40' : ''
              }`}
          />



          {/* Used Overlay */}
          {isUsed && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className={`bg-black/80 px-1 py-0.5 rounded border border-white/20 font-black text-zinc-500 uppercase tracking-widest rotate-[-12deg] ${isMini ? 'text-[6px]' : 'text-[8px]'}`}>
                Used
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="w-full h-full bg-zinc-900 flex flex-col items-center justify-center p-2 text-center border border-white/5 uppercase">
          <div className="text-[10px] font-black text-zinc-500 mb-2">{tile.label}</div>
          <div className="text-[8px] text-zinc-700 leading-tight">{tile.description}</div>
        </div>
      )}

      {/* Owner indicator */}
      {isOwned && ownerColor && (
        <div
          className="absolute top-1 right-1 w-4 h-4 rounded-full border-2 border-zinc-900 shadow-lg z-20"
          style={{ backgroundColor: ownerColor }}
          title={ownerName}
        />
      )}

      {/* Special Action Overlay on Hover */}
      {isOwned && hasAction && onUseAction && !isUsed && (
        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex flex-col justify-center items-center transition-opacity duration-200 z-30">
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onUseAction();
            }}
            className="h-8 px-3 text-[10px] font-black uppercase bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg pointer-events-auto shadow-cyan-900/50 border border-cyan-400/50"
          >
            Use Action
          </Button>
        </div>
      )}
    </div>
  );
}

export function BonusTiles({
  game,
  playerId,
  onSelectBonusTile,
  onUseBonusAction,
  isSelectionMode = false,
  isMini = false,
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
    <Card className={`w-full text-zinc-100 overflow-hidden font-orbitron ${isMini ? 'border-none bg-transparent shadow-none' : 'bg-zinc-950 border-white/5'}`}>
      <CardContent className={`${isMini ? 'p-0.5' : 'p-4'} ${isMini ? 'space-y-1' : 'space-y-6'}`}>
        {/* Bonus Tiles — first */}
        <div className={isMini ? '' : 'space-y-3'}>
          {!isMini && (
            <h3 className="text-xs font-black uppercase tracking-widest text-primary flex items-center gap-2">
              <Gift className="w-4 h-4" />
              {game.roundNumber === 6 ? 'End Game (Pass)' : (isSelectionMode ? 'Select Bonus' : 'Bonus Tiles')}
            </h3>
          )}
          {game.roundNumber === 6 && !isMini && (
            <p className="text-[10px] text-zinc-500 font-medium mb-2 italic">
              마지막 라운드입니다. 아무 타일이나 클릭하면 다음 라운드 타일 선택 없이 라운드를 종료(패스)합니다.
            </p>
          )}
          <div
            className={
              isMini
                ? 'flex flex-row flex-nowrap overflow-x-auto custom-scrollbar-hide justify-between gap-1.5 px-1 pb-1'
                : isSelectionMode
                  ? 'grid w-full grid-cols-[repeat(auto-fill,minmax(5.25rem,1fr))] gap-3 justify-items-center'
                  : 'flex flex-wrap gap-3'
            }
          >
            {/* Available Bonus Tiles */}
            {game.availableBonusTiles.map((tile) => (
              <BonusTileCard
                key={tile.id}
                tile={tile}
                isOwned={false}
                isMini={isMini}
                isSelectable={isSelectionMode || !!onSelectBonusTile}
                onSelect={onSelectBonusTile ? () => onSelectBonusTile(tile.id) : undefined}
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
                    isMini={isMini}
                    ownerName={playerName}
                    ownerColor={playerColor}
                    isSelectable={false}
                    isUsed={owner?.usedBonusAction}
                    hasAction={!!tile.specialAction}
                    onUseAction={isCurrentPlayer ? onUseBonusAction : undefined}
                  />
                );
              })}
          </div>
        </div>

        {/* Federation Tiles — 보너스 타일 선택 모드에서는 숨김 */}
        {!isSelectionMode && (
        <div className={isMini ? '' : 'space-y-2'}>
          {!isMini && (
            <h3 className="text-[10px] font-black uppercase tracking-widest text-amber-400 flex items-center gap-1.5 border-t border-white/5 pt-3">
              <Award className="w-3 h-3" />
              Federation Tiles
            </h3>
          )}
          <div className={`${isMini ? 'flex flex-row flex-nowrap overflow-x-auto custom-scrollbar-hide gap-4 h-10 items-center px-1' : 'flex flex-wrap gap-x-8 gap-y-4'}`}>
            {FEDERATION_REWARDS.map((r, idx) => {
              const n = pool[r.id] ?? 0;
              if (n === 0) return null;
              const size = isMini ? 35 : 56;
              return (
                <div key={r.id} className="relative group shrink-0" style={{ width: `${size}px`, height: `${size}px` }} title={`${r.label} (${n} left)`}>
                  {Array.from({ length: Math.min(n, 3) }).map((_, i) => (
                    <img
                      key={`${r.id}-${i}`}
                      src={`/image/Federation_${idx + 1}.gif`}
                      alt={r.label}
                      className="absolute object-contain shadow-lg border border-white/5 rounded-md transition-transform group-hover:scale-105"
                      style={{
                        width: `${size}px`,
                        height: `${size}px`,
                        left: `${i * (isMini ? 2 : 4)}px`,
                        top: `${i * (isMini ? -1 : -1.5)}px`,
                        zIndex: i,
                      }}
                    />
                  ))}
                  {n > 3 && (
                    <div className="absolute -bottom-1 -right-1 bg-amber-600 text-[8px] font-black px-1 rounded-full z-10">
                      {n}
                    </div>
                  )}
                </div>
              );
            })}
            {SPACESHIP_FEDERATION_REWARDS.map((r, idx) => {
              const n = pool[r.id] ?? 0;
              if (n === 0) return null;
              const size = isMini ? 35 : 56;
              return (
                <div key={r.id} className="relative group shrink-0" style={{ width: `${size}px`, height: `${size}px` }} title={`${r.label} (${n} left)`}>
                  {Array.from({ length: Math.min(n, 3) }).map((_, i) => (
                    <img
                      key={`${r.id}-${i}`}
                      src={`/image/Federation_${idx + 7}.gif`}
                      alt={r.label}
                      className="absolute object-contain shadow-lg border border-white/5 rounded-md transition-transform group-hover:scale-105"
                      style={{
                        width: `${size}px`,
                        height: `${size}px`,
                        left: `${i * (isMini ? 2 : 4)}px`,
                        top: `${i * (isMini ? -1 : -1.5)}px`,
                        zIndex: i,
                      }}
                    />
                  ))}
                  {n > 3 && (
                    <div className="absolute -bottom-1 -right-1 bg-cyan-600 text-[8px] font-black px-1 rounded-full z-10">
                      {n}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        )}
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
            <Badge variant="outline" className="text-[7px] bg-zinc-500/10 border-zinc-500/20 text-zinc-100 px-1.5 py-0">
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
            className={`w-full h-7 text-[9px] uppercase mt-2 ${player.usedBonusAction
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
