import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { CSSProperties } from 'react';
import { type GaiaGameState as GameState, ALL_BONUS_TILES, ALL_TECH_TILES, ALL_ADVANCED_TECH_TILES, SHIP_TECH_TILES, FACTIONS, PLANET_COLORS, RESEARCH_TRACKS, FEDERATION_REWARDS, SPACESHIP_FEDERATION_REWARDS, GLEENS_FEDERATION_REWARD, ARTIFACTS, FINAL_MISSION_LABELS } from '@shared/gameConfig';
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

  // 파워액션 보드 스트립(7등분)에서 로그 details → 칸 인덱스 매핑 (순서 = INITIAL_POWER_ACTIONS = powerAction.jpg 좌→우)
  const POWER_ACTION_STRIP: Array<{ re: RegExp; idx: number }> = [
    { re: /\+3 Knowledge/, idx: 0 },
    { re: /\+2 Terraform steps/, idx: 1 },
    { re: /\+2 Ore/, idx: 2 },
    { re: /\+7 Credits/, idx: 3 },
    { re: /\+2 Knowledge/, idx: 4 },
    { re: /\+1 Terraform step/, idx: 5 },
    { re: /\+2 Power tokens/, idx: 6 },
  ];
  // 우주선 액션 스트립(3등분) — 서버 addGameLog 액션명 → 우주선/칸 매핑
  const SHIP_ACTION_STRIP_IMG: Record<string, string> = {
    ship_twilight: '/image/ActionTwilight.jpg',
    ship_rebellion: '/image/ActionRebellion.jpg',
    ship_tf_mars: '/image/ActionTFMars.jpg',
    ship_eclipse: '/image/ActionEclipse.jpg',
  };
  const SHIP_ACTION_STRIP: Array<{ re: RegExp; ship: string; idx: number }> = [
    // 'Twilight: Federation benefit'는 여기서 처리하지 않음 — 받은 연방 보상 gif를 보여주도록 아래 Federation 분기로 떨어뜨린다.
    { re: /^Twilight: TS → Research Lab/i, ship: 'ship_twilight', idx: 1 },
    { re: /^Twilight: \+3 Range/i, ship: 'ship_twilight', idx: 2 },
    { re: /^Rebellion: Gain tech tile/i, ship: 'ship_rebellion', idx: 0 },
    { re: /^Rebellion: Mine → TS/i, ship: 'ship_rebellion', idx: 1 },
    { re: /^Rebellion: 2K → 1Q 2C/i, ship: 'ship_rebellion', idx: 2 },
    { re: /^TF Mars: Tech tiles \+ 2 VP/i, ship: 'ship_tf_mars', idx: 0 },
    { re: /^TF Mars: Gaia Project/i, ship: 'ship_tf_mars', idx: 1 },
    { re: /^TF Mars: 3C → 1 Terraform/i, ship: 'ship_tf_mars', idx: 2 },
    { re: /^Eclipse: Planet types \+ 2 VP/i, ship: 'ship_eclipse', idx: 0 },
    { re: /^Eclipse: 2K\+3P → Research/i, ship: 'ship_eclipse', idx: 1 },
    { re: /^Eclipse: 6C → Build mine/i, ship: 'ship_eclipse', idx: 2 },
  ];

  type LogPrimaryImage =
    | { src: string; alt: string }
    | { strip: string; cols: number; index: number; alt: string; extraSrc?: string }
    | { swap: { fromSrc: string | null; toSrc: string | null; bonusVp?: number; advTiles?: Array<{ tileId: string; vp: number }> }; alt: string };

  const getLogPrimaryImage = (log: { action: string; details?: string; tileId?: string }, playerFactionId?: string | null): LogPrimaryImage | null => {
    const actionText = log.action || '';
    const details = log.details || '';

    // Power Action — 미니뷰처럼 보드 스트립에서 해당 칸만 크롭해 표시
    if (/^Power Action$/i.test(actionText)) {
      const found = POWER_ACTION_STRIP.find(x => x.re.test(details));
      if (found) return { strip: '/image/powerAction.jpg', cols: 7, index: found.idx, alt: details || 'Power Action' };
    }
    // 트왈라잇 액션1(3QIC): 연방 해택 재수령 — 트왈라잇 액션 스트립(idx0=3정큐 칸) + 받은 연방 보상 gif를 함께 표시
    if (/^Twilight: (Federation benefit|Spaceship Fed)$/i.test(actionText)) {
      const rid = log.tileId && /^(gleens-fed-|ship-fed-|fed-)/i.test(log.tileId) ? log.tileId : undefined;
      let fedSrc: string | undefined;
      if (rid === GLEENS_FEDERATION_REWARD.id) {
        fedSrc = '/image/Federation_15.gif';
      } else if (rid) {
        const fi = FEDERATION_REWARDS.findIndex(f => f.id === rid);
        if (fi !== -1) fedSrc = `/image/Federation_${fi + 1}.gif`;
        else {
          const si = SPACESHIP_FEDERATION_REWARDS.findIndex(f => f.id === rid);
          if (si !== -1) fedSrc = `/image/Federation_${si + 7}.gif`;
        }
      }
      return { strip: SHIP_ACTION_STRIP_IMG['ship_twilight'], cols: 3, index: 0, alt: actionText, extraSrc: fedSrc };
    }
    // Ship Action — 우주선 액션 스트립에서 해당 칸 크롭
    {
      const found = SHIP_ACTION_STRIP.find(x => x.re.test(actionText));
      if (found) return { strip: SHIP_ACTION_STRIP_IMG[found.ship], cols: 3, index: found.idx, alt: actionText };
    }

    // Final Mission — tileId에 담긴 missionId로 EGS 이미지 표시
    if (/^Final Mission$/i.test(actionText)) {
      const missionId = log.tileId;
      if (missionId) {
        const idx = Object.keys(FINAL_MISSION_LABELS).indexOf(missionId);
        if (idx !== -1) return { src: `/image/EGS_${idx + 1}.jpg`, alt: FINAL_MISSION_LABELS[missionId] ?? missionId };
      }
    }

    // Bonus tiles
    if (/^Selected Bonus Tile$/i.test(actionText)) {
      const img = getBonusTileImgByLabel(details);
      if (img) return { src: img, alt: details || 'Bonus Tile' };
    }
    if (/^Selected Bonus$/i.test(actionText)) {
      // 패스 교체: passInfo(있으면) 우선, 없으면 details 파싱 → 반납 타일 → 가져간 타일
      const info = (log as { passInfo?: { returnedTileId?: string; tookTileId?: string; bonusVp?: number; advTiles?: Array<{ tileId: string; vp: number }> } }).passInfo;
      const tookId = info?.tookTileId ?? details.match(/\btook\s+(bon-[a-z0-9-]+)\b/i)?.[1];
      const returnedId = info?.returnedTileId ?? details.match(/\bReturned\s+(bon-[a-z0-9-]+)\b/i)?.[1];
      const toSrc = getBonusTileImgById(tookId);
      const fromSrc = getBonusTileImgById(returnedId);
      if (toSrc || fromSrc) return { swap: { fromSrc, toSrc, bonusVp: info?.bonusVp, advTiles: info?.advTiles }, alt: tookId || 'Bonus Tile' };
    }

    // Tech tiles (기술 타일 획득 + 기술 타일 액션 사용 로그)
    if (/Tech Tile|Gained Tech Tile|Advanced Tech Tile|Ship Tech|Tech Action/i.test(actionText) || /tech-(inc|imm|gaia|big|act)|adv-|ship-tech-/i.test(details)) {
      // 통합 로그는 details에 타일 정보가 없고 log.tileId에 기술 타일 id가 담김
      let tid = log.tileId && getTechTileImgById(log.tileId) ? log.tileId : undefined;
      if (!tid) tid = details.match(/\b(tech-[a-z0-9-]+|adv-[a-z0-9-]+|ship-tech-[a-z0-9+-]+)\b/i)?.[1];

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

    // Artifacts — 서버는 인공물 획득/사용 로그의 tileId에 art id를 담아 보냄(기술/연방 로그와 동일 패턴)
    if (/Artifact/i.test(actionText) || (log.tileId && /^art-[a-z0-9-]+$/i.test(log.tileId)) || /art-[a-z0-9-]+/i.test(details)) {
      const artId = (log.tileId && /^art-[a-z0-9-]+$/i.test(log.tileId)) ? log.tileId : details.match(/\b(art-[a-z0-9-]+)\b/i)?.[1];
      if (artId) {
         const artIndex = ARTIFACTS.findIndex(a => a.id === artId);
         if (artIndex !== -1) return { src: `/image/Art${artIndex + 1}.png`, alt: artId };
      }
    }

    // Federations (트왈라잇 연방 재수령 등은 log.tileId에 연방 보상 id가 담김)
    if (/Formed Federation|Gained Federation|Federation|Spaceship Fed/i.test(actionText) || /gleens-fed-[a-z0-9-]+|ship-fed-[a-z0-9-]+|fed-[a-z0-9-]+/i.test(details)) {
      const tidMatch = log.tileId && /^(gleens-fed-|ship-fed-|fed-)/i.test(log.tileId) ? log.tileId : undefined;
      const fedMatch = tidMatch ? [tidMatch, tidMatch] : details.match(/\b(gleens-fed-[a-z0-9-]+|ship-fed-[a-z0-9-]+|fed-[a-z0-9-]+)\b/i);
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

  /** details를 여러 줄로 분해: ' · ' 구분자와 끝의 점수 괄호 ' (+NVP ...)'를 각각 줄로 */
  const splitDetailLines = (details: string): string[] => {
    let s = details;
    // 점수 괄호 앞에 줄바꿈 표식 삽입 (+3VP ...), (+7 VP) 등
    s = s.replace(/\s*(\(\+?\d+\s*VP[^)]*\))/gi, '\n$1');
    // 명시적 구분자
    s = s.replace(/\s*·\s*/g, '\n');
    return s.split('\n').map(x => x.trim()).filter(Boolean);
  };

  const renderDetailsMultiline = (details: string, fallbackClassName: string) => {
    const lines = splitDetailLines(details);
    if (lines.length <= 1) return renderDetailsWithTrackColor(details, fallbackClassName);
    return (
      <span className="flex flex-col gap-0 leading-tight">
        {lines.map((line, i) => (
          <span key={i}>{renderDetailsWithTrackColor(line, fallbackClassName)}</span>
        ))}
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
          // 연방 보상/트왈라잇 재수령: 이미지만으로 충분 → 상세 텍스트(점수/보상 라벨) 숨김
          const hideDetailsText = /^Twilight: (Federation benefit|Spaceship Fed)$/i.test(actionText) || /^Federation Reward$/i.test(actionText);

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
                // 좌측 바는 항상 종족색 우선 (AI 피드백 여부는 시안 ring으로 따로 표시)
                borderLeftColor: factionColor ? factionColor : (isAiFeedbackLog ? '#22d3ee' : isMainAction ? '#3b82f6' : '#52525b')
              }}
            >
              <div className="flex-1 min-w-0">
                <div
                  className={`flex items-center min-w-0 ${isBonusTileLog ? 'gap-1.5' : 'gap-2'}`}
                  style={mainTextStyle}
                >
                  {primaryImg && (
                    (() => {
                      // 보너스 패스 교체: 반납 타일(+패스점수) → 가져간 타일, 고급 패스 타일 이미지+점수
                      if ('swap' in primaryImg) {
                        const { fromSrc, toSrc, bonusVp, advTiles } = primaryImg.swap;
                        const boostImg = (src: string, dim: boolean) => (
                          <div className={`h-9 w-[5rem] sm:h-10 sm:w-[5.5rem] overflow-hidden flex-shrink-0 flex items-center justify-center ${dim ? 'grayscale opacity-50' : ''}`}>
                            <img src={src} alt={primaryImg.alt} title={log.details || primaryImg.alt} loading="lazy"
                              className="h-full w-full min-h-0 min-w-0 object-contain object-center -rotate-90 origin-center scale-[2.0]"
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                          </div>
                        );
                        return (
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <div className="flex items-center gap-1">
                              {/* 실제 교체(가져간 타일 있음)일 때만 반납 타일을 흐리게. 라운드6은 그대로 유지 */}
                              {fromSrc && boostImg(fromSrc, !!toSrc)}
                              {typeof bonusVp === 'number' && bonusVp > 0 && (
                                <span className="text-emerald-400 font-black text-[10px] shrink-0">+{bonusVp} VP</span>
                              )}
                              {fromSrc && toSrc && <span className="text-zinc-500 font-black text-sm shrink-0">→</span>}
                              {toSrc && boostImg(toSrc, false)}
                            </div>
                            {advTiles && advTiles.length > 0 && (
                              <div className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
                                {advTiles.map((a, i) => {
                                  const src = getTechTileImgById(a.tileId);
                                  return (
                                    <span key={i} className="flex items-center gap-0.5 shrink-0" title={a.tileId}>
                                      {src && (
                                        <span className="h-6 w-10 rounded-sm overflow-hidden inline-block">
                                          <img src={src} alt={a.tileId} loading="lazy" className="w-full h-full object-contain"
                                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                                        </span>
                                      )}
                                      <span className="text-emerald-400 font-black text-[10px]">+{a.vp} VP</span>
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      }
                      // 파워/우주선 액션: 보드 스트립에서 해당 칸만 크롭 (미니뷰와 동일한 모습)
                      if ('strip' in primaryImg) {
                        const stripBox = (
                          <div className="relative h-7 w-8 rounded-sm overflow-hidden flex-shrink-0 border border-white/10">
                            <img
                              src={primaryImg.strip}
                              alt={primaryImg.alt}
                              title={log.details || primaryImg.alt}
                              loading="lazy"
                              className="absolute"
                              style={{ bottom: 0, left: `${-100 * primaryImg.index}%`, width: `${100 * primaryImg.cols}%`, maxWidth: 'none', height: 'auto' }}
                              onError={(e) => {
                                (e.currentTarget as HTMLImageElement).style.display = 'none';
                              }}
                            />
                          </div>
                        );
                        // 트왈라잇 연방 재수령: 액션 스트립 옆에 받은 연방 보상 gif도 함께 표시
                        if (primaryImg.extraSrc) {
                          return (
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {stripBox}
                              <img
                                src={primaryImg.extraSrc}
                                alt={primaryImg.alt}
                                title={log.details || primaryImg.alt}
                                loading="lazy"
                                className="h-7 w-7 rounded-sm object-cover flex-shrink-0 border border-white/10"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                              />
                            </div>
                          );
                        }
                        return stripBox;
                      }
                      const isBonus = primaryImg.src.startsWith('/image/BoostTile_');
                      const isTech = primaryImg.src.startsWith('/tech/');
                      const isBuilding = primaryImg.src.startsWith('/image/buildings/');
                      const isMission = primaryImg.src.startsWith('/image/EGS_');
                      const bonusHero = isBonus && isBonusTileLog;

                      // 보너스: 높이를 텍스트 한 줄에 맞춤 — 과한 고정 높이 + contain은 위아래 빈 띠만 만듦
                      const wrapperClass = bonusHero
                        ? `h-9 w-[5rem] sm:h-10 sm:w-[5.5rem] overflow-hidden flex-shrink-0 flex items-center justify-center ${isPowerAction ? 'opacity-60 grayscale' : ''}`
                        : isBonus
                          ? `h-7 w-12 rounded-sm overflow-visible flex-shrink-0 ${isPowerAction ? 'opacity-60 grayscale' : ''}`
                          : isTech || isMission
                            ? `h-7 w-12 rounded-sm overflow-hidden flex-shrink-0 ${isPowerAction ? 'opacity-60 grayscale' : ''}`
                            : `h-7 w-7 rounded-sm overflow-hidden flex-shrink-0 ${isPowerAction ? 'opacity-60 grayscale' : ''}`;

                      const imgClass = bonusHero
                        ? 'h-full w-full min-h-0 min-w-0 object-contain object-center -rotate-90 origin-center scale-[2.0]'
                        : isBonus
                          ? 'w-full h-full object-contain scale-[2.0] origin-center'
                          : isTech || isMission
                            ? 'w-full h-full object-contain'
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
                  {/* 패스 교체 로그는 이미지(반납→가져감)만으로 충분 → 텍스트 생략 */}
                  {isBonusTilePickLog && log.details && (
                    <div className="min-w-0 flex-1 flex flex-col gap-0 leading-none">
                      <span className="text-zinc-200 font-bold break-words" style={secondaryTextStyle}>
                        {log.details}
                      </span>
                    </div>
                  )}
                  {!isBonusTileLog && !hideDetailsText && log.details && (
                    <span className="ml-1.5 min-w-0">
                      {renderDetailsMultiline(
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
