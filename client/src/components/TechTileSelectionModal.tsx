import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { GaiaGameState as GameState, ResearchTrack } from '@shared/gameConfig';
import { ALL_TECH_TILES, RESEARCH_TRACKS, SHIP_TECH_TILES, getFirstTrackTile, findTrackByTileId } from '@shared/gameConfig';
import { GraduationCap, X } from 'lucide-react';

interface TechTileSelectionModalProps {
  open: boolean;
  onClose: () => void;
  game: GameState;
  playerId: string | null;
  onSelectTechTile: (techTileId: string, trackId?: string) => void;
}

export function TechTileSelectionModal({
  open,
  onClose,
  game,
  playerId,
  onSelectTechTile,
}: TechTileSelectionModalProps) {
  const [selectedTileId, setSelectedTileId] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<ResearchTrack | null>(null);

  if (!game.pendingTechTileSelection || game.pendingTechTileSelection.playerId !== playerId) {
    return null;
  }

  const handleTileClick = (tileId: string) => {
    setSelectedTileId(tileId);
    const trackId = findTrackByTileId(game.techTilesByTrack, tileId);
    if (trackId) setSelectedTrackId(null);
    else setSelectedTrackId(null);
  };

  const handleConfirm = () => {
    if (!selectedTileId) return;

    const isShipTech = SHIP_TECH_TILES.some(t => t.id === selectedTileId);
    if (isShipTech) {
      onSelectTechTile(selectedTileId);
      setSelectedTileId(null);
      setSelectedTrackId(null);
      onClose();
      return;
    }

    const trackIdFromTile = findTrackByTileId(game.techTilesByTrack, selectedTileId);
    if (trackIdFromTile) {
      onSelectTechTile(selectedTileId, trackIdFromTile);
    } else {
      if (!selectedTrackId && !isRebellionGain) return;
      onSelectTechTile(selectedTileId, selectedTrackId || undefined);
    }
    setSelectedTileId(null);
    setSelectedTrackId(null);
    onClose();
  };

  const selectedTile = selectedTileId ? (ALL_TECH_TILES.find(t => t.id === selectedTileId) || SHIP_TECH_TILES.find(t => t.id === selectedTileId)) : null;
  const isFromPool = selectedTileId && !findTrackByTileId(game.techTilesByTrack, selectedTileId) && !SHIP_TECH_TILES.some(t => t.id === selectedTileId);
  const isRebellionGain = game.pendingTechTileSelection.structureType === 'rebellion_gain';
  const needsTrackSelection = isFromPool && !selectedTrackId && !isRebellionGain;
  const availableShipTiles = (game.availableShipTechTileIds || []).map(id => SHIP_TECH_TILES.find(t => t.id === id)).filter(Boolean);

  const isOpen = Boolean(open);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto bg-zinc-950 border-white/10 text-zinc-100">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-black uppercase tracking-widest">
            <GraduationCap className="w-5 h-5 text-primary" />
            Select Technology Tile
          </DialogTitle>
          <p className="text-sm text-zinc-400">
            Choose a technology tile. Tiles under tracks will advance that track. Pool tiles require track selection.
          </p>
        </DialogHeader>

        <div className="space-y-6">
          {/* Tech Tiles by Track (6개) */}
          <div>
            <h3 className="text-sm font-black uppercase tracking-wider text-zinc-400 mb-3">
              Technology Tiles by Track (6)
            </h3>
            <div className="grid grid-cols-3 gap-3">
              {RESEARCH_TRACKS.map((track) => {
                const tile = getFirstTrackTile(game.techTilesByTrack, track.id as ResearchTrack);
                if (!tile) return null;
                const isSelected = selectedTileId === tile.id;

                return (
                  <div
                    key={track.id}
                    onClick={() => handleTileClick(tile.id)}
                    className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-primary/20 border-primary shadow-[0_0_20px_rgba(var(--primary),0.2)]'
                        : 'bg-zinc-900/50 border-white/10 hover:border-white/30 hover:bg-zinc-800/50'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <Badge variant="outline" className="text-[9px] font-black uppercase">
                        {track.name}
                      </Badge>
                      {isSelected && (
                        <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                          <X className="w-3 h-3 text-black" />
                        </div>
                      )}
                    </div>
                    <div className="text-[11px] font-black uppercase text-zinc-100 mb-1">
                      {tile.label}
                    </div>
                    <div className="text-[9px] text-zinc-400 line-clamp-2">
                      {tile.description}
                    </div>
                    {isSelected && (
                      <div className="mt-2 text-[9px] text-primary font-bold">
                        ✓ Will advance {track.name} track
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Ship Tech Tiles (입장한 우주선 전용) */}
          {availableShipTiles.length > 0 && (
            <div>
              <h3 className="text-sm font-black uppercase tracking-wider text-cyan-400 mb-3">
                Ship Tech Tiles
              </h3>
              <div className="grid grid-cols-3 gap-3">
                {availableShipTiles.map((tile) => {
                  if (!tile) return null;
                  const isSelected = selectedTileId === tile.id;
                  return (
                    <div
                      key={tile.id}
                      onClick={() => { setSelectedTileId(tile.id); setSelectedTrackId(null); }}
                      className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                        isSelected ? 'bg-cyan-500/20 border-cyan-500' : 'bg-zinc-900/50 border-cyan-500/30 hover:border-cyan-500/60'
                      }`}
                    >
                      <Badge variant="outline" className="text-[9px] font-black uppercase bg-cyan-500/10 border-cyan-500/30 text-cyan-400 mb-2">Ship</Badge>
                      <div className="text-[11px] font-black uppercase text-zinc-100 mb-1">{tile.label}</div>
                      <div className="text-[9px] text-zinc-400 line-clamp-2">{tile.description}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tech Tiles Pool (3개) */}
          <div>
            <h3 className="text-sm font-black uppercase tracking-wider text-zinc-400 mb-3">
              Technology Tiles Pool (3) - Select Track
            </h3>
            <div className="grid grid-cols-3 gap-3">
              {game.techTilesPool?.map((tile, idx) => {
                if (!tile) return <div key={`pool-empty-${idx}`} className="p-4 rounded-xl border-2 border-dashed border-white/10 bg-zinc-900/30 flex items-center justify-center text-[9px] text-zinc-500 min-h-[6rem]">빈 칸</div>;
                const isSelected = selectedTileId === tile.id;

                return (
                  <div
                    key={tile.id}
                    onClick={() => handleTileClick(tile.id)}
                    className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-yellow-500/20 border-yellow-500 shadow-[0_0_20px_rgba(234,179,8,0.2)]'
                        : 'bg-zinc-900/50 border-yellow-500/20 hover:border-yellow-500/50 hover:bg-zinc-800/50'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <Badge variant="outline" className="text-[9px] font-black uppercase bg-yellow-500/10 border-yellow-500/30 text-yellow-500">
                        Pool
                      </Badge>
                      {isSelected && (
                        <div className="w-5 h-5 rounded-full bg-yellow-500 flex items-center justify-center">
                          <X className="w-3 h-3 text-black" />
                        </div>
                      )}
                    </div>
                    <div className="text-[11px] font-black uppercase text-zinc-100 mb-1">
                      {tile.label}
                    </div>
                    <div className="text-[9px] text-zinc-400 line-clamp-2">
                      {tile.description}
                    </div>
                    {isSelected && (
                      <div className="mt-2 text-[9px] text-yellow-500 font-bold">
                        Select track below
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Track Selection (Pool tile 선택 시) */}
          {needsTrackSelection && (
            <div>
              <h3 className="text-sm font-black uppercase tracking-wider text-zinc-400 mb-3">
                Select Research Track to Advance
              </h3>
              <div className="grid grid-cols-3 gap-2">
                {RESEARCH_TRACKS.map((track) => {
                  const isSelected = selectedTrackId === track.id;
                  const currentLevel = game.players[playerId!]?.research[track.id] || 0;

                  return (
                    <button
                      key={track.id}
                      onClick={() => setSelectedTrackId(track.id)}
                      className={`p-3 rounded-lg border-2 transition-all ${
                        isSelected
                          ? 'bg-primary/20 border-primary'
                          : 'bg-zinc-900/50 border-white/10 hover:border-white/30'
                      }`}
                    >
                      <div className="text-[10px] font-black uppercase text-zinc-100">
                        {track.name}
                      </div>
                      <div className="text-[9px] text-zinc-400 mt-1">
                        Level: {currentLevel}/5
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!selectedTileId || Boolean(needsTrackSelection)}
            className="bg-primary hover:bg-primary/80"
          >
            Confirm Selection
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
