import { HexGrid, Layout, Hexagon, Text } from 'react-hexgrid';
import { useMap } from '@/hooks/use-game';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { useState, useRef, useCallback } from 'react';
import { TileActionModal } from './TileActionModal';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import type { Tile } from '@shared/schema';
import { SECTOR_CENTERS, PLANET_COLORS } from '@shared/gameConfig';

const HEX_SIZE = 4.8;
const SQRT3 = Math.sqrt(3);

function getHexOffset(q: number, r: number, sectorIdx: number) {
  const center = SECTOR_CENTERS[sectorIdx];
  if (!center) return { x: 0, y: 0 };

  const dq = q - center.q;
  const dr = r - center.r;

  // Pointy top layout math
  const x = HEX_SIZE * SQRT3 * (dq + dr / 2);
  const y = HEX_SIZE * 1.5 * dr;

  return { x, y };
}


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
          <defs>
            {/* Tile Special Patterns - using objectBoundingBox for per-hex anchoring */}
            <pattern id="ts-space" patternContentUnits="objectBoundingBox" width="1" height="1">
              <image href="/map/ts_100.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
            </pattern>
            <pattern id="ts-asteroid" patternContentUnits="objectBoundingBox" width="1" height="1">
              <image href="/map/ts_110.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
            </pattern>
            <pattern id="ts-proto" patternContentUnits="objectBoundingBox" width="1" height="1">
              <image href="/map/ts_111.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
            </pattern>
            <pattern id="ts-rebellion" patternContentUnits="objectBoundingBox" width="1" height="1">
              <image href="/map/ts_112.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
            </pattern>
            <pattern id="ts-tf-mars" patternContentUnits="objectBoundingBox" width="1" height="1">
              <image href="/map/ts_113.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
            </pattern>
            <pattern id="ts-eclipse" patternContentUnits="objectBoundingBox" width="1" height="1">
              <image href="/map/ts_114.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
            </pattern>
            <pattern id="ts-twilight" patternContentUnits="objectBoundingBox" width="1" height="1">
              <image href="/map/ts_115.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
            </pattern>
            <pattern id="ts-gas-cloud" patternContentUnits="objectBoundingBox" width="1" height="1">
              <image href="/map/ts_113.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
            </pattern>
            <pattern id="ts-transdim" patternContentUnits="objectBoundingBox" width="1" height="1">
              <image href="/map/ts_114.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
            </pattern>
            <pattern id="ts-deep-space" patternContentUnits="objectBoundingBox" width="1" height="1">
              <image href="/map/ts_115.png" width="1" height="1" preserveAspectRatio="xMidYMid slice" />
            </pattern>
          </defs>
          <g id="sector-backgrounds-layer">
            {SECTOR_CENTERS.map((center) => {
              const cx = HEX_SIZE * SQRT3 * (center.q + center.r / 2);
              const cy = HEX_SIZE * 1.5 * center.r;

              // Find the actual tile at this center to determine layout ID and rotation
              const slotTile = tiles.find(t => t.q === center.q && t.r === center.r);
              if (!slotTile || slotTile.sector === null) return null;

              const layoutId = slotTile.sector;
              const rotation = slotTile.rotation ?? 0;
              const isExternal = layoutId >= 11 && layoutId !== 90;

              let filename = '';
              let imgSize = 45; // inner default

              let imgW = 45;
              let imgH = 45;
              let offsetX = imgW / 2;
              let offsetY = imgH / 2;

              if (layoutId === 90) {
                return null; // Don't draw background for internal strategic hexes
              } else if (isExternal) {
                // Hardcoded prefix based on available files: Map_B11, O12, B13, B14, O15, O16, B17, O18
                const isSideO = [12, 15, 16, 18].includes(layoutId);
                const prefix = isSideO ? 'Map_O' : 'Map_B';
                filename = `${prefix}${String(layoutId).padStart(2, '0')}.png`;

                imgW = 16.62;
                imgH = 16.8;
                offsetX = 12.47;
                offsetY = 12.0;
              } else {
                filename = `Map_B${String(layoutId + 1).padStart(2, '0')}.gif`;
                imgW = 45;
                imgH = 45;
                offsetX = imgW / 2;
                offsetY = imgH / 2;
              }

              return (
                <image
                  key={`sector-bg-${center.sector}`} // slot index for stable key
                  href={`/map/${filename}`}
                  x={cx - offsetX}
                  y={cy - offsetY}
                  width={imgW}
                  height={imgH}
                  transform={`rotate(${rotation * 60}, ${cx}, ${cy})`}
                  style={{ pointerEvents: 'none', opacity: 1.0 }}
                />
              );
            })}
          </g>

          <Layout size={{ x: HEX_SIZE, y: HEX_SIZE }} flat={false} spacing={1.0} origin={{ x: 0, y: 0 }}>
            {tiles.map((tile) => {
              return (
                <Hexagon
                  key={tile.id}
                  q={tile.q}
                  r={tile.r}
                  s={-tile.q - tile.r}
                  style={{
                    fill: 'transparent', // 배경 이미지가 잘 보이도록 투명하게 설정
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
                  {/* Planet Overlays removed as they are in the background image */}
                  {/* Space Texture (ts_100) - Only for sector 90 (gap hexes) to avoid blurring sector background images */}
                  {(tile.type === 'space' || tile.type === 'deep_space') && tile.sector === 90 && (
                    <circle r="4.8" fill="url(#ts-space)" fillOpacity={0.15} pointerEvents="none" />
                  )}
                  {/* Single-hex Strategic Tiles & Ships (Only for sector 90 to prevent drawing on outer bridges) */}
                  {tile.sector === 90 && (
                    <>
                      {tile.type === 'asteroid' && <circle r="4.15" fill="url(#ts-asteroid)" pointerEvents="none" />}
                      {tile.type === 'proto' && <circle r="4.15" fill="url(#ts-proto)" pointerEvents="none" />}
                      {tile.type === 'ship_rebellion' && <circle r="4.15" fill="url(#ts-rebellion)" pointerEvents="none" transform="rotate(-90)" />}
                      {tile.type === 'ship_tf_mars' && <circle r="4.15" fill="url(#ts-tf-mars)" pointerEvents="none" transform="rotate(-90)" />}
                      {tile.type === 'ship_twilight' && <circle r="4.15" fill="url(#ts-twilight)" pointerEvents="none" transform="rotate(-90)" />}
                      {tile.type === 'ship_eclipse' && <circle r="4.15" fill="url(#ts-eclipse)" pointerEvents="none" transform="rotate(-90)" />}
                    </>
                  )}
                  {/* Outer Sector Highlight Overlay removed as it makes the image blurry */}

                  {/* Sector number removed to keep the map clean */}

                </Hexagon>
              );
            })}
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
