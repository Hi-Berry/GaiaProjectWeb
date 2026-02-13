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
  if (tile.income?.ore) return <Gem className="w-4 h-4 text-orange-400" />;
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
      <DialogContent className="max-w-3xl bg-zinc-950 border-white/10 text-zinc-100">
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
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <div className="text-[10px] uppercase font-bold text-red-400 mb-2">
              Returning This Tile:
            </div>
            <div className="flex items-center gap-2">
              {getBonusIcon(currentBonusTile)}
              <span className="text-sm font-bold text-zinc-200">{currentBonusTile.label}</span>
              {currentBonusTile.passBonus && (
                <Badge variant="outline" className="text-[9px] bg-emerald-500/10 border-emerald-500/30 text-emerald-400 ml-auto">
                  Pass: {currentBonusTile.passBonus.vp}VP/{getPassBonusLabel(currentBonusTile.passBonus.type)}
                </Badge>
              )}
            </div>
          </div>
        )}

        {/* Available Bonus Tiles Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-[400px] overflow-y-auto p-1">
          {game.availableBonusTiles.map((tile) => {
            const isSelected = selectedTileId === tile.id;

            return (
              <div
                key={tile.id}
                onClick={() => handleTileClick(tile.id)}
                className={`relative p-4 rounded-xl border-2 cursor-pointer transition-all duration-200 ${
                  isSelected
                    ? 'bg-primary/20 border-primary shadow-[0_0_20px_rgba(var(--primary),0.2)]'
                    : 'bg-zinc-900/50 border-white/10 hover:border-white/30 hover:bg-zinc-800/50'
                }`}
              >
                {/* Selection indicator */}
                {isSelected && (
                  <div className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-primary flex items-center justify-center">
                    <Check className="w-4 h-4 text-black" />
                  </div>
                )}

                {/* Tile Header */}
                <div className="flex items-center gap-2 mb-3">
                  {getBonusIcon(tile)}
                  <span className="text-[11px] font-black uppercase tracking-wider text-zinc-100">
                    {tile.label}
                  </span>
                </div>

                {/* Income Display */}
                {tile.income && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {tile.income.ore && (
                      <Badge variant="outline" className="text-[9px] bg-orange-500/10 border-orange-500/30 text-orange-400">
                        +{tile.income.ore}O
                      </Badge>
                    )}
                    {tile.income.credits && (
                      <Badge variant="outline" className="text-[9px] bg-yellow-500/10 border-yellow-500/30 text-yellow-400">
                        +{tile.income.credits}C
                      </Badge>
                    )}
                    {tile.income.knowledge && (
                      <Badge variant="outline" className="text-[9px] bg-blue-500/10 border-blue-500/30 text-blue-400">
                        +{tile.income.knowledge}K
                      </Badge>
                    )}
                    {tile.income.qic && (
                      <Badge variant="outline" className="text-[9px] bg-green-500/10 border-green-500/30 text-green-400">
                        +{tile.income.qic}Q
                      </Badge>
                    )}
                    {tile.income.power && (
                      <Badge variant="outline" className="text-[9px] bg-purple-500/10 border-purple-500/30 text-purple-400">
                        +{tile.income.power}P
                      </Badge>
                    )}
                    {tile.income.powerTokens && (
                      <Badge variant="outline" className="text-[9px] bg-violet-500/10 border-violet-500/30 text-violet-400">
                        +{tile.income.powerTokens} Tok
                      </Badge>
                    )}
                  </div>
                )}

                {/* Pass Bonus Display */}
                {tile.passBonus && (
                  <div className="mb-2">
                    <Badge variant="outline" className="text-[9px] bg-emerald-500/10 border-emerald-500/30 text-emerald-400">
                      Pass: {tile.passBonus.vp}VP/{getPassBonusLabel(tile.passBonus.type)}
                    </Badge>
                  </div>
                )}

                {/* Special Action */}
                {tile.specialAction && (
                  <div className="mb-2">
                    <Badge variant="outline" className="text-[9px] bg-cyan-500/10 border-cyan-500/30 text-cyan-400">
                      ACT: {getActionLabel(tile.specialAction)}
                    </Badge>
                  </div>
                )}

                {/* Description */}
                <div className="text-[9px] text-zinc-500 leading-relaxed mt-2">
                  {tile.description}
                </div>
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
