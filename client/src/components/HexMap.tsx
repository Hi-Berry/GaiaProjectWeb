import { HexGrid, Layout, Hexagon, Text } from 'react-hexgrid';
import { useMap } from '@/hooks/use-game';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { useState, useRef, useCallback } from 'react';
import { TileActionModal } from './TileActionModal';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import type { Tile } from '@shared/schema';

const PLANET_COLORS: Record<string, string> = {
  terra: '#2E5EAA',
  oxide: '#D64045',
  volcanic: '#ED9B40',
  desert: '#FFE74C',
  swamp: '#5C4D3C',
  titanium: '#8D99AE',
  ice: '#E0FBFC',
  transdim: '#9D4EDD',
  gaia: '#38B000',
  space: '#1a1d29',
  deep_space: '#0d0f14',
  asteroid: '#EC4899',
  gas_cloud: '#6b5b95',
  lost_fleet_ship: '#E2E8F0',
  ship_rebellion: '#EF4444',
  ship_twilight: '#A855F7',
  ship_tf_mars: '#F97316',
  ship_eclipse: '#3B82F6',
};

const SECTOR_COLORS: Record<number, string> = {
  0: 'rgba(255, 100, 100, 0.6)',
  1: 'rgba(100, 255, 100, 0.6)',
  2: 'rgba(100, 100, 255, 0.6)',
  3: 'rgba(255, 255, 100, 0.6)',
  4: 'rgba(255, 100, 255, 0.6)',
  5: 'rgba(100, 255, 255, 0.6)',
  6: 'rgba(255, 180, 100, 0.6)',
  7: 'rgba(180, 100, 255, 0.6)',
  8: 'rgba(100, 255, 180, 0.6)',
  9: 'rgba(255, 150, 150, 0.6)',
};

const PLAYER_ID = 1;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.2;

export function HexMap() {
  const { data: tiles, isLoading, error } = useMap();
  const [selectedTile, setSelectedTile] = useState<Tile | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isMouseDown, setIsMouseDown] = useState(false);
  const [hasDragged, setHasDragged] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const handleTileClick = (tile: Tile) => {
    if (!hasDragged) {
      setSelectedTile(tile);
      setModalOpen(true);
    }
  };

  const handleZoomIn = useCallback(() => {
    setZoom(prev => Math.min(prev + ZOOM_STEP, MAX_ZOOM));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom(prev => Math.max(prev - ZOOM_STEP, MIN_ZOOM));
  }, []);

  const handleReset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom(prev => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev + delta)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) {
      setIsMouseDown(true);
      setHasDragged(false);
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isMouseDown) {
      const dx = Math.abs(e.clientX - (dragStart.x + pan.x));
      const dy = Math.abs(e.clientY - (dragStart.y + pan.y));
      if (dx > 5 || dy > 5) {
        setHasDragged(true);
      }
      setPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    }
  }, [isMouseDown, dragStart, pan]);

  const handleMouseUp = useCallback(() => {
    setIsMouseDown(false);
    setTimeout(() => setHasDragged(false), 50);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsMouseDown(false);
    setHasDragged(false);
  }, []);

  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="w-64 h-64 rounded-full opacity-20" />
          <p className="text-muted-foreground font-mono animate-pulse">Scanning Sector...</p>
        </div>
      </div>
    );
  }

  if (error || !tiles) {
    return (
      <div className="w-full h-full flex items-center justify-center text-destructive">
        Error loading map system.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-black/20 backdrop-blur-sm rounded-3xl border border-white/5 overflow-hidden relative hex-grid-container"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      style={{ cursor: isMouseDown ? 'grabbing' : 'grab' }}
    >
      <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/dark-matter.png')] opacity-30 pointer-events-none" />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="w-full h-full flex items-center justify-center"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: 'center center',
        }}
      >
        <HexGrid width={1400} height={1200} viewBox="-50 -50 250 250">
          <Layout size={{ x: 4.8, y: 4.8 }} flat={false} spacing={1.0} origin={{ x: 0, y: 0 }}>
            {tiles.map((tile) => (
              <Hexagon
                key={tile.id}
                q={tile.q}
                r={tile.r}
                s={-tile.q - tile.r}
                style={{
                  fill: (tile.sector !== null && tile.sector >= 20 && tile.sector < 30)
                    ? '#3b2f6b' // Highlight C-sectors with purple
                    : '#1a1a1a',
                  stroke: tile.structure
                    ? 'rgba(255,215,0,0.8)'
                    : tile.sector !== null
                      ? SECTOR_COLORS[tile.sector]
                      : 'rgba(255,255,255,0.2)',
                  strokeWidth: tile.structure ? '0.8px' : '0.2px',
                  cursor: 'pointer',
                  fillOpacity: 1.0,
                }}
                className="hex"
                onClick={() => handleTileClick(tile)}
                data-testid={`hex-tile-${tile.id}`}
              >
                {/* Planet Circle */}
                {tile.type !== 'space' && tile.type !== 'deep_space' && !tile.type.includes('ship') && (
                  <g>
                    <circle r="3.2" fill="rgba(0,0,0,0.4)" />
                    <circle
                      r="3.0"
                      fill={PLANET_COLORS[tile.type] || PLANET_COLORS.space}
                    />
                  </g>
                )}
                <Text className="hex-text" style={{ fontSize: '1px', opacity: 0.5 }}>
                  {tile.sector}
                </Text>
              </Hexagon>
            ))}
          </Layout>
        </HexGrid>
      </motion.div>

      {/* Zoom Controls */}
      <div className="absolute bottom-6 right-6 flex flex-col gap-2" data-testid="map-controls">
        <div className="flex gap-2">
          <Button
            size="icon"
            variant="outline"
            onClick={handleZoomIn}
            className="bg-card/80 backdrop-blur border-white/10"
            data-testid="button-zoom-in"
          >
            <ZoomIn className="w-4 h-4" />
          </Button>
          <Button
            size="icon"
            variant="outline"
            onClick={handleZoomOut}
            className="bg-card/80 backdrop-blur border-white/10"
            data-testid="button-zoom-out"
          >
            <ZoomOut className="w-4 h-4" />
          </Button>
          <Button
            size="icon"
            variant="outline"
            onClick={handleReset}
            className="bg-card/80 backdrop-blur border-white/10"
            data-testid="button-zoom-reset"
          >
            <Maximize2 className="w-4 h-4" />
          </Button>
        </div>
        <div className="bg-card/80 backdrop-blur border border-white/10 px-4 py-2 rounded-full text-xs font-mono text-muted-foreground text-center" data-testid="map-zoom">
          {Math.round(zoom * 100)}%
        </div>
      </div>

      {/* Instructions */}
      <div className="absolute top-4 left-4 bg-card/60 backdrop-blur border border-white/10 px-3 py-2 rounded-lg text-xs text-muted-foreground">
        <span className="opacity-70">Scroll to zoom | Drag to pan</span>
      </div>

      <TileActionModal
        tile={selectedTile}
        playerId={PLAYER_ID}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </div>
  );
}
