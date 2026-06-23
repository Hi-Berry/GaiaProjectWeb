import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Gift, Zap, Coins, FlaskConical, Gem, Target, Check, Mountain, Compass } from 'lucide-react';
import type { GaiaGameState as GameState, BonusTile } from '@shared/gameConfig';
import { ALL_BONUS_TILES } from '@shared/gameConfig';
import { useIsMobile } from '@/hooks/use-mobile';
import type { CSSProperties } from 'react';

interface BonusSelectionModalProps {
  open: boolean;
  onClose: () => void;
  game: GameState;
  playerId: string | null;
  onSelectBonusTile: (tileId: string) => void;
  mode: 'initial' | 'pass'; // initial = first selection, pass = selecting when passing
}

function getBonusIcon(tile: BonusTile) {
  if (tile.specialAction === 'terraform_step') return <Mountain className="w-4 h-4 text-amber-400" />;
  if (tile.specialAction === 'range_3') return <Compass className="w-4 h-4 text-cyan-400" />;
  if (tile.specialAction === 'gaia_project') return <Target className="w-4 h-4 text-green-400" />;
  if (tile.income?.power && tile.income.power >= 4) return <Zap className="w-4 h-4 text-purple-400" />;
  if (tile.income?.knowledge) return <FlaskConical className="w-4 h-4 text-blue-400" />;
  if (tile.income?.credits && tile.income.credits >= 3) return <Coins className="w-4 h-4 text-yellow-400" />;
  if (tile.income?.ore) return <Gem className="w-4 h-4 text-zinc-400" />;
  return <Gift className="w-4 h-4 text-zinc-400" />;
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

export function BonusSelectionModal({
  open,
  onClose,
  game,
  playerId,
  onSelectBonusTile,
  mode,
}: BonusSelectionModalProps) {
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const isMobile = useIsMobile();

  const currentPlayer = playerId ? game.players[playerId] : null;
  const currentBonusTile = currentPlayer?.bonusTile
    ? ALL_BONUS_TILES.find(t => t.id === currentPlayer.bonusTile)
    : null;

  const handleConfirm = () => {
    if (selectedTileId) {
      onSelectBonusTile(selectedTileId);
      setSelectedTileId(null);
      onClose();
    }
  };

  const handleTileClick = (tileId: string) => {
    // 패스 모드에서는 클릭하면 바로 선택하고 패스 (확인 버튼 없이)
    if (mode === 'pass') {
      onSelectBonusTile(tileId);
    } else {
      setSelectedTileId(tileId);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        className="max-w-[95vw] sm:max-w-3xl lg:max-w-5xl bg-zinc-950 border-white/10 text-zinc-100 max-h-[90vh] overflow-hidden flex flex-col p-4 sm:p-6"
        /* 모바일: 다른 패널처럼 비율 축소(타일·제목·여백 한꺼번에) */
        style={isMobile ? ({ zoom: 0.82 } as CSSProperties) : undefined}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-black tracking-wider uppercase flex items-center gap-3">
            <Gift className="w-6 h-6 text-primary" />
            {mode === 'initial' ? 'Select Your Bonus Tile' : 'Choose New Bonus Tile'}
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            {mode === 'initial'
              ? 'Select a bonus tile to receive income each round.'
              : 'Return your current bonus tile and select a new one.'}
          </DialogDescription>
        </DialogHeader>

        {/* Current Bonus Tile (only shown in pass mode) */}
        {mode === 'pass' && currentBonusTile && (
          <div className="mb-6 p-4 rounded-xl bg-orange-500/5 border border-orange-500/20 flex items-center gap-6">
            <div className="flex flex-col">
              <div className="text-[10px] uppercase font-bold text-orange-400/70 mb-2 tracking-widest">
                Returning Current Tile
              </div>
              <div className="text-zinc-200 font-black text-lg uppercase">
                {currentBonusTile.label}
              </div>
              <div className="text-zinc-500 text-xs mt-1 max-w-[200px]">
                {currentBonusTile.description}
              </div>
            </div>

            <div className="relative w-16 h-24 rounded-lg overflow-hidden border border-white/10 shadow-lg grayscale opacity-50 ml-auto">
              {(() => {
                const idx = ALL_BONUS_TILES.findIndex(t => t.id === currentBonusTile.id);
                const img = idx !== -1 ? `/image/BoostTile_${idx + 1}.jpg` : null;
                return img ? (
                  <img src={img} className="w-full h-full object-contain" alt="returning tile" />
                ) : null;
              })()}
            </div>
          </div>
        )}

        {/* Available Bonus Tiles Grid */}
        <div className="flex-1 overflow-y-auto p-2 sm:p-4 grid grid-cols-4 min-[360px]:grid-cols-5 sm:grid-cols-6 md:grid-cols-7 lg:grid-cols-8 gap-2 sm:gap-4 auto-rows-max justify-items-center w-full max-h-[70vh]">
          {game.availableBonusTiles.map((tile) => {
            const isSelected = selectedTileId === tile.id;
            const tileIndex = ALL_BONUS_TILES.findIndex(t => t.id === tile.id);
            const tileImg = tileIndex !== -1 ? `/image/BoostTile_${tileIndex + 1}.jpg` : null;

            return (
              <div
                key={tile.id}
                onClick={() => handleTileClick(tile.id)}
                className={`relative rounded-xl overflow-hidden cursor-pointer transition-all duration-300 aspect-[110/180] w-full max-w-[140px] ${isSelected
                  ? 'ring-4 ring-primary ring-offset-2 ring-offset-zinc-950 scale-105 shadow-[0_0_30px_rgba(var(--primary),0.4)]'
                  : 'opacity-70 hover:opacity-100 hover:scale-102 grayscale hover:grayscale-0'
                  }`}
              >
                {tileImg ? (
                  <img
                    src={tileImg}
                    alt={tile.label}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="w-full h-full bg-zinc-900 flex flex-col items-center justify-center p-2 text-center border border-white/5">
                    <span className="text-[10px] font-black text-zinc-500">{tile.label}</span>
                  </div>
                )}

                {/* Selection Overlay */}
                {isSelected && (
                  <div className="absolute inset-0 bg-primary/10 flex items-center justify-center pointer-events-none">
                    <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shadow-lg">
                      <Check className="w-5 h-5 text-black" />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {game.availableBonusTiles.length === 0 && (
          <div className="text-center text-zinc-500 py-8">
            No bonus tiles available
          </div>
        )}

        <DialogFooter className="mt-4">
          {mode === 'pass' ? (
            // 패스 모드에서는 Cancel 버튼만 표시 (타일 클릭 시 바로 선택됨)
            <Button
              variant="outline"
              onClick={onClose}
              className="border-zinc-700 text-zinc-400 hover:bg-zinc-800"
            >
              Cancel
            </Button>
          ) : (
            // 초기 선택 모드에서는 Confirm 버튼 표시
            <Button
              onClick={handleConfirm}
              disabled={!selectedTileId}
              className="bg-primary hover:bg-primary/90 text-black font-bold uppercase tracking-wider"
            >
              Confirm Selection
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
