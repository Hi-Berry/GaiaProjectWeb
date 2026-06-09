import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { CSSProperties } from 'react';
import { type GaiaGameState as GameState, ALL_BONUS_TILES, ALL_TECH_TILES, ALL_ADVANCED_TECH_TILES, SHIP_TECH_TILES, FACTIONS, PLANET_COLORS, RESEARCH_TRACKS, FEDERATION_REWARDS, SPACESHIP_FEDERATION_REWARDS, GLEENS_FEDERATION_REWARD, ARTIFACTS } from '@shared/gameConfig';
import { Clock } from 'lucide-react';

interface GameLogProps {
  game: GameState;
  onEntryMouseEnter?: (tileId: string) => void;
  onEntryMouseLeave?: () => void;
  onAiFeedbackClick?: (actionId: string) => void;
  hideHeader?: boolean;
  className?: string;
  maxHeight?: string;
  textScale?: number;
}

export function GameLog({
  game,
  onEntryMouseEnter,
  onEntryMouseLeave,
  onAiFeedbackClick,
  hideHeader = false,
  className = "",
  maxHeight = "400px",
  textScale = 1
}: GameLogProps) {
  const logs = game.gameLog || [];
  const mainTextStyle: CSSProperties = {
    fontSize: `${11 * textScale}px`,
    lineHeight: `${13 * textScale}px`,
  };
  const secondaryTextStyle: CSSProperties = {
    fontSize: `${10 * textScale}px`,
    lineHeight: `${12 * textScale}px`,
  };

  const getBonusTileImgById = (bonusTileId: string | null | undefined) => {
    if (!bonusTileId) return null;
    const idx = ALL_BONUS_TILES.findIndex(t => t.id === bonusTileId);
    if (idx === -1) return null;
    return `/image/BoostTile_${idx + 1}.jpg`;
  };

  const getBonusTileImgByLabel = (label: string | null | undefined) => {
    if (!label) return null;
    const tile = ALL_BONUS_TILES.find(t => t.label === label);
    return getBonusTileImgById(tile?.id);
  };

  const getTechTileImgById = (techTileId: string | null | undefined) => {
    if (!techTileId) return null;
    const basic = ALL_TECH_TILES.find(t => t.id === techTileId);
    if (basic) return basic.image ?? null;
    const advanced = ALL_ADVANCED_TECH_TILES.find(t => t.id === techTileId);
    if (advanced) return advanced.image ?? null;
    const ship = SHIP_TECH_TILES.find(t => t.id === techTileId);
    if (ship) return ship.image ?? null;
    return null;
  };

  const getBuildingImg = (
    planetType: string | null | undefined,
    structure: 'mine' | 'trading_station' | 'research_lab' | 'planetary_institute' | 'academy' | 'gaiaformer'
  ) => {
    if (!planetType) return null;
    return `/image/buildings/${planetType}_${structure}.png`;
  };

  const getFactionColorNameForBuildingImage = (playerFactionId: string | null | undefined) => {
    if (!playerFactionId) return null;
    const factionColor = FACTIONS.find(f => f.id === playerFactionId)?.color?.toUpperCase();
    if (!factionColor) return null;

    // GameBoard.tsx와 동일한 방식: PLANET_COLORS hex를 역추적해서 파일명 prefix(terra/oxide/...)로 사용
    for (const [key, hex] of Object.entries(PLANET_COLORS)) {
      if ((hex || '').toUpperCase() === factionColor) return key;
    }
    return null;
  };

  const getLogPrimaryImage = (log: { action: string; details?: string; tileId?: string }, playerFactionId?: string | null) => {
    const actionText = log.action || '';
    const details = log.details || '';

    // Bonus tiles
    if (/^Selected Bonus Tile$/i.test(actionText)) {
      const img = getBonusTileImgByLabel(details);
      if (img) return { src: img, alt: details || 'Bonus Tile' };
    }
    if (/^Selected Bonus$/i.test(actionText)) {
      const m = details.match(/\btook\s+(bon-[a-z0-9-]+)\b/i);
      const img = getBonusTileImgById(m?.[1]);
      if (img) return { src: img, alt: m?.[1] || 'Bonus Tile' };
    }

    // Tech tiles
    if (/Tech Tile|Gained Tech Tile|Advanced Tech Tile|Ship Tech/i.test(actionText) || /tech-(inc|imm|gaia|big|act)|adv-|ship-tech-/i.test(details)) {
      let tid = details.match(/\b(tech-[a-z0-9-]+|adv-[a-z0-9-]+|ship-tech-[a-z0-9+-]+)\b/i)?.[1];
      
      if (!tid) {
        const allTiles = [...ALL_TECH_TILES, ...ALL_ADVANCED_TECH_TILES, ...SHIP_TECH_TILES];
        for (const t of allTiles) {
          if (t.label && details.includes(t.label)) {
            tid = t.id;
            break;
          }
        }
      }
      
      const img = getTechTileImgById(tid);
      if (img) return { src: img, alt: tid || 'Tech Tile' };
    }

    // Artifacts
    if (/Took Artifact|Used Artifact/i.test(actionText) || /art-[a-z0-9-]+/i.test(details)) {
      const artMatch = details.match(/\b(art-[a-z0-9-]+)\b/i);
      if (artMatch) {
         const artIndex = ARTIFACTS.findIndex(a => a.id === artMatch[1]);
         if (artIndex !== -1) return { src: `/image/Art${artIndex + 1}.png`, alt: artMatch[1] };
      }
    }

    // Federations
    if (/Formed Federation|Gained Federation|Federation/i.test(actionText) || /gleens-fed-[a-z0-9-]+|ship-fed-[a-z0-9-]+|fed-[a-z0-9-]+/i.test(details)) {
      const fedMatch = details.match(/\b(gleens-fed-[a-z0-9-]+|ship-fed-[a-z0-9-]+|fed-[a-z0-9-]+)\b/i);
      if (fedMatch) {
        const fedId = fedMatch[1];
        if (fedId === GLEENS_FEDERATION_REWARD.id) return { src: '/image/Federation_15.gif', alt: fedId };

        const fedIdx = FEDERATION_REWARDS.findIndex(f => f.id === fedId);
        if (fedIdx !== -1) return { src: `/image/Federation_${fedIdx + 1}.gif`, alt: fedId };
        
        const shipFedIdx = SPACESHIP_FEDERATION_REWARDS.findIndex(f => f.id === fedId);
        if (shipFedIdx !== -1) return { src: `/image/Federation_${shipFedIdx + 7}.gif`, alt: fedId };
      }
    }

    // Buildings: "해당 종족색깔_건물"이 목표이므로 타일 타입(gaia 등)보다 플레이어 팩션 컬러 기준으로 이미지 선택
    const planetType = getFactionColorNameForBuildingImage(playerFactionId) ?? 'titanium';

    if (/Placed Gaiaformer|Gaia Project.*place Gaiaformer|place Gaiaformer/i.test(actionText + ' ' + details)) {
      const img = getBuildingImg(planetType, 'gaiaformer');
      if (img) return { src: img, alt: `${planetType} gaiaformer` };
    }

    if (/^Built Mine\b/i.test(actionText) || /Built Parasitic Mine|Built Mine on/i.test(actionText)) {
      const img = getBuildingImg(planetType, 'mine');
      if (img) return { src: img, alt: `${planetType} mine` };
    }
    if (/^Upgraded to Trading Station\b/i.test(actionText) || /\bMine → TS\b/i.test(actionText)) {
      const img = getBuildingImg(planetType, 'trading_station');
      if (img) return { src: img, alt: `${planetType} trading station` };
    }
    if (/^Upgraded to Research Lab\b/i.test(actionText) || /\bTS → Research Lab\b/i.test(actionText)) {
      const img = getBuildingImg(planetType, 'research_lab');
      if (img) return { src: img, alt: `${planetType} research lab` };
    }
    if (/^Upgraded to Planetary Institute\b/i.test(actionText)) {
      const img = getBuildingImg(planetType, 'planetary_institute');
      if (img) return { src: img, alt: `${planetType} planetary institute` };
    }
    if (/^Upgraded to Academy\b/i.test(actionText)) {
      const img = getBuildingImg(planetType, 'academy');
      if (img) return { src: img, alt: `${planetType} academy` };
    }

    return null;
  };

  const renderDetailsWithTrackColor = (details: string, fallbackClassName: string) => {
    // 서버 로그 포맷 예시:
    // - "terraforming → Lv.3"
    // - "terraforming to level 3 (4K)"
    const m =
      details.match(/\b(terraforming|navigation|artificialIntelligence|gaiaProject|economy|science)\b/)
      ?? null;
    if (!m) return <span className={fallbackClassName}>{details}</span>;

    const trackId = m[1];
    const trackColor = RESEARCH_TRACKS.find(t => t.id === trackId)?.color;
    if (!trackColor) return <span className={fallbackClassName}>{details}</span>;

    const idx = m.index ?? details.indexOf(trackId);
    if (idx < 0) return <span className={fallbackClassName}>{details}</span>;

    const before = details.slice(0, idx);
    const after = details.slice(idx + trackId.length);
    return (
      <span className={fallbackClassName}>
        {before}
        <span style={{ color: trackColor, fontWeight: 900 }}>
          {trackId}
        </span>
        {after}
      </span>
    );
  };

  const content = (
    <div className={`space-y-1 flex flex-col ${!hideHeader ? "px-3 py-2" : "p-0 pr-2"}`}>
      {logs.length === 0 ? (
        <div className="text-center text-zinc-500 text-sm py-8 uppercase tracking-widest font-black opacity-30">
          No actions yet
        </div>
      ) : (
        [...logs].reverse().map((log, index) => {
          const actionText = log.action || '';
          const isPowerAction = /power|income|energy|bowl/i.test(actionText) || /Accepted|Declined/i.test(actionText);
          const isMainAction = /AI Move|Built|Upgraded|Advanced|Pass|Pass Round|Gaia Project|Federation|Chosen/i.test(actionText) && !isPowerAction;
          const isBonusTilePickLog = /^Selected Bonus Tile$/i.test(actionText);
          const isBonusSwapLog = /^Selected Bonus$/i.test(actionText);
          const isBonusTileLog = isBonusTilePickLog || isBonusSwapLog;

          const player = log.playerId ? game.players[log.playerId] : undefined;
          const factionColor = player?.faction ? FACTIONS.find(f => f.id === player.faction)?.color : undefined;
          const primaryImg = getLogPrimaryImage(log, player?.faction);
          const isAiFeedbackLog = !!log.aiFeedbackActionId;

          return (
            <div
              key={index}
              onMouseEnter={() => log.tileId && onEntryMouseEnter?.(log.tileId)}
              onMouseLeave={() => onEntryMouseLeave?.()}
              onClick={() => log.aiFeedbackActionId && onAiFeedbackClick?.(log.aiFeedbackActionId)}
              title={isAiFeedbackLog ? '클릭해서 이 AI 수 평가하기' : undefined}
              className={`flex ${isBonusTileLog ? 'items-center gap-1.5 py-0 px-1.5' : 'items-start gap-2 py-1 px-2'} rounded-lg border-l-4 transition-all duration-200 ${isMainAction
                ? 'bg-zinc-800/40 border-y border-r border-y-white/10 border-r-white/10 shadow-[0_0_15px_rgba(0,0,0,0.3)]'
                : isPowerAction
                  ? 'bg-zinc-950/20 border-y border-r border-y-white/5 border-r-white/5 opacity-90'
                  : 'bg-zinc-900/30 border-y border-r border-y-white/5 border-r-white/5'
                } ${isAiFeedbackLog ? 'cursor-pointer ring-1 ring-cyan-400/20 hover:ring-cyan-300/60 hover:bg-cyan-950/40' : log.tileId ? 'cursor-pointer hover:border-primary/50 hover:bg-zinc-800/80' : 'hover:bg-zinc-800/60'}`}
              style={{
                borderLeftColor: isAiFeedbackLog ? '#22d3ee' : factionColor ? factionColor : (isMainAction ? '#3b82f6' : '#52525b')
              }}
            >
              <div className="flex-1 min-w-0">
                <div
                  className={`flex items-center min-w-0 ${isBonusTileLog ? 'gap-1.5' : 'gap-2'}`}
                  style={mainTextStyle}
                >
                  {primaryImg && (
                    (() => {
                      const isBonus = primaryImg.src.startsWith('/image/BoostTile_');
                      const isTech = primaryImg.src.startsWith('/tech/');
                      const isBuilding = primaryImg.src.startsWith('/image/buildings/');
                      const bonusHero = isBonus && isBonusTileLog;

                      // 보너스: 높이를 텍스트 한 줄에 맞춤 — 과한 고정 높이 + contain은 위아래 빈 띠만 만듦
                      const wrapperClass = bonusHero
                        ? `h-9 w-[5rem] sm:h-10 sm:w-[5.5rem] overflow-hidden flex-shrink-0 flex items-center justify-center ${isPowerAction ? 'opacity-60 grayscale' : ''}`
                        : isBonus
                          ? `h-7 w-12 rounded-sm overflow-visible flex-shrink-0 ${isPowerAction ? 'opacity-60 grayscale' : ''}`
                          : isTech
                            ? `h-7 w-12 rounded-sm overflow-hidden flex-shrink-0 ${isPowerAction ? 'opacity-60 grayscale' : ''}`
                            : `h-7 w-7 rounded-sm overflow-hidden flex-shrink-0 ${isPowerAction ? 'opacity-60 grayscale' : ''}`;

                      const imgClass = bonusHero
                        ? 'h-full w-full min-h-0 min-w-0 object-contain object-center -rotate-90 origin-center scale-[2.0]'
                        : isBonus || isTech
                          ? (isBonus ? 'w-full h-full object-contain scale-[2.0] origin-center' : 'w-full h-full object-contain')
                          : isBuilding
                            ? 'w-full h-full object-cover'
                            : 'w-full h-full object-cover';

                      return (
                        <div className={wrapperClass}>
                          <img
                            src={primaryImg.src}
                            alt={primaryImg.alt}
                            title={log.details || primaryImg.alt}
                            className={imgClass}
                            loading="lazy"
                            onError={(e) => {
                              // 에셋이 없는 경우(예: 일부 행성 타입/구조 조합) 깨진 이미지 표시를 숨김
                              (e.currentTarget as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        </div>
                      );
                    })()
                  )}
                  {!isBonusTileLog && (
                    <span className={`font-black uppercase tracking-tight truncate`} style={factionColor ? { color: factionColor } : (isMainAction ? { color: factionColor || '#3b82f6' } : isPowerAction ? { color: '#a1a1aa', fontSize: `${10 * textScale}px` } : { color: '#d4d4d8' })}>
                      {log.action}
                    </span>
                  )}
                  {isBonusTileLog && log.details && (
                    <div className="min-w-0 flex-1 flex flex-col gap-0 leading-none">
                      {isBonusTilePickLog ? (
                        <span className="text-zinc-200 font-bold break-words" style={secondaryTextStyle}>
                          {log.details}
                        </span>
                      ) : (
                        <span className="min-w-0">
                          {renderDetailsWithTrackColor(
                            log.details,
                            `${isMainAction ? 'text-zinc-200 font-bold' : 'text-zinc-300 font-medium'}`
                          )}
                        </span>
                      )}
                    </div>
                  )}
                  {!isBonusTileLog && log.details && (
                    <span className="ml-1.5 min-w-0">
                      {renderDetailsWithTrackColor(
                        log.details,
                        `${isMainAction ? 'text-zinc-200 font-bold' : 'text-zinc-300 font-medium'}`
                      )}
                    </span>
                  )}
                </div>
                {/* subLogs rendering */}
                {log.subLogs && log.subLogs.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1 border-t border-white/5 pt-1">
                    {log.subLogs.map((subLog, i) => {
                      if (!subLog) return null;
                      const subPlayer = subLog.playerId ? game.players[subLog.playerId] : undefined;
                      const subColor = subPlayer?.faction ? FACTIONS.find(f => f.id === subPlayer.faction)?.color : undefined;
                      const cleanText = subLog.text.replace(`↳ ${subLog.playerName} `, '').replace('↳ ', '');

                      return (
                        <div
                          key={i}
                          className="flex items-center gap-1.5 bg-black/40 border border-white/5 px-2 py-1 rounded shadow-inner"
                          style={{
                            borderLeft: subColor ? `2px solid ${subColor}` : '1px solid #3f3f46',
                            fontSize: `${9 * textScale}px`,
                            lineHeight: `${10 * textScale}px`,
                          }}
                        >
                          <span className="text-zinc-200 font-medium">{cleanText}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );

  if (hideHeader) {
    if (maxHeight === 'none') {
      return <div className={`w-full ${className}`}>{content}</div>;
    }
    return (
      <ScrollArea className={`flex-1 ${className}`} style={{ height: maxHeight }}>
        {content}
      </ScrollArea>
    );
  }

  return (
    <Card className={`w-full bg-zinc-950 border-white/5 text-zinc-100 overflow-hidden font-orbitron shadow-2xl ${className}`}>
      <CardHeader className="py-2 px-3 border-b border-white/5 bg-zinc-900/50">
        <CardTitle className="text-sm font-black tracking-widest uppercase text-zinc-400 flex items-center gap-2">
          <Clock className="w-4 h-4" />
          Game Log
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea style={{ height: maxHeight }}>
          {content}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
