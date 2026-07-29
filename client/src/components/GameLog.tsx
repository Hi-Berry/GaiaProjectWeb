import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useState, useRef, Fragment, type CSSProperties } from 'react';
import { ChevronsUp, Layers } from 'lucide-react';
import { type GaiaGameState as GameState, ALL_BONUS_TILES, ALL_TECH_TILES, ALL_ADVANCED_TECH_TILES, SHIP_TECH_TILES, FACTIONS, PLANET_COLORS, RESEARCH_TRACKS, FEDERATION_REWARDS, SPACESHIP_FEDERATION_REWARDS, GLEENS_FEDERATION_REWARD, ARTIFACTS, FINAL_MISSION_LABELS } from '@shared/gameConfig';
import { Clock } from 'lucide-react';
import { raceFaceSrc } from '@/lib/racePortrait';

/** #rrggbb → rgba 문자열 (연한 테두리용). */
function hexToRgba(hex: string | undefined, alpha: number): string {
  const h = (hex || '').replace('#', '');
  if (h.length < 6) return `rgba(255,255,255,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

interface GameLogProps {
  game: GameState;
  onEntryMouseEnter?: (tileId: string) => void;
  onEntryMouseLeave?: () => void;
  hideHeader?: boolean;
  className?: string;
  maxHeight?: string;
  textScale?: number;
  /** 최신/라운드 점프 툴바 표시 여부 (기본 true). 도크에서는 'Game Log' 타이틀 클릭으로 토글. */
  showToolbar?: boolean;
  /** [롤백] 호스트+진행중이면 로그 상세에 '여기로 롤백' 버튼 노출 */
  canRollback?: boolean;
  /** [롤백] 클릭 시 해당 로그 seq로 롤백 요청 (label = 클릭한 로그 요약) */
  onRollbackToSeq?: (seq: number, label?: string) => void;
}

export function GameLog({
  game,
  onEntryMouseEnter,
  onEntryMouseLeave,
  hideHeader = false,
  className = "",
  maxHeight = "400px",
  textScale = 1,
  showToolbar = true,
  canRollback = false,
  onRollbackToSeq,
}: GameLogProps) {
  const logs = game.gameLog || [];
  // 로그 클릭 시 그 액션 전후 점수/자원 변동 표시 (게임 정상 진행 점검용)
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  type Snap = NonNullable<NonNullable<GameState['gameLog']>[number]['snap']>;
  const STAT_DEFS: Array<[keyof Snap, string]> = [['vp', 'VP'], ['c', 'C'], ['o', 'O'], ['k', 'K'], ['q', 'Q'], ['p1', 'P1'], ['p2', 'P2'], ['p3', 'P3']];
  /** origIdx(시간순 인덱스) 기준 같은 플레이어의 직전 스냅샷 */
  const prevSnapFor = (origIdx: number, playerId: string): Snap | null => {
    for (let j = origIdx - 1; j >= 0; j--) {
      const e = logs[j];
      if (e?.playerId === playerId && e.snap) return e.snap;
    }
    return null;
  };

  // [플레이어 필터] 특정 플레이어 로그만 보기 (사용자 요청). null=전체.
  const [filterPlayerId, setFilterPlayerId] = useState<string | null>(null);
  // 로그에 등장하는 플레이어 목록(등장 순서 유지, 중복 제거) — 필터 칩용.
  const logPlayerIds: string[] = [];
  for (const l of logs) { const pid = (l as any)?.playerId; if (pid && game.players[pid] && !logPlayerIds.includes(pid)) logPlayerIds.push(pid); }

  // 라운드 점프: 각 라운드의 '첫(시간순) 로그' origIndex와 DOM 노드 ref
  const [showRounds, setShowRounds] = useState(false);
  const topRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const roundRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const roundsPresent: number[] = [];
  for (let i = 0; i < logs.length; i++) {
    const r = logs[i]?.round;
    if (typeof r === 'number' && !roundsPresent.includes(r)) roundsPresent.push(r);
  }
  roundsPresent.sort((a, b) => a - b);
  // 스크롤 가능한 조상 컨테이너 찾기 (sticky 툴바를 타깃하면 스크롤이 안 움직이는 버그 방지)
  const getScrollParent = (): HTMLElement | null => {
    let el: HTMLElement | null = rootRef.current?.parentElement ?? null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return null;
  };
  // 최신순(역순) 표시 → 최신 로그는 맨 위. 스크롤 컨테이너를 맨 위로.
  const scrollToTop = () => {
    const sp = getScrollParent();
    if (sp) sp.scrollTo({ top: 0, behavior: 'smooth' });
    else rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const scrollToRound = (r: number) => {
    roundRefs.current[r]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setShowRounds(false);
  };
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
    | { src: string; alt: string; rotateDeg?: number }
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
    // 우주선 입장: 글자 대신 맵 타일 이미지(/map/ts_*)로 표시. 우주선 종류는 tileId로 맵에서 조회.
    if (/^Entered Ship$/i.test(actionText)) {
      const SHIP_MAP_IMG: Record<string, string> = {
        ship_rebellion: '/map/ts_112.png',
        ship_tf_mars: '/map/ts_113.png',
        ship_eclipse: '/map/ts_114.png',
        ship_twilight: '/map/ts_115.png',
      };
      const shipType = (log.tileId ? game.map?.find(t => t.id === log.tileId)?.type : undefined)
        ?? details.match(/ship_(?:eclipse|twilight|rebellion|tf_mars)/i)?.[0];
      const src = shipType ? SHIP_MAP_IMG[shipType] : undefined;
      // 맵에 보이는 각도와 동일하게 -90° 회전 (맵 우주선 타일도 rotate(-90))
      if (src) return { src, alt: shipType ?? 'ship', rotateDeg: -90 };
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

  // 확장행성(모웨/팅커 3삽) 로그: 홈행성 타입 토큰을 각 행성 색(PLANET_COLORS)으로 — 정확 단어매치라
  //   "terraforming" 속 "terra"엔 안 걸림. 사용자 요청("글자에 종족/행성 색").
  const HOME_PLANET_TYPE_RE = /(\b(?:terra|oxide|volcanic|desert|swamp|titanium|ice)\b)/g;
  const renderPlanetColored = (details: string, fallbackClassName: string) => {
    const parts = details.split(HOME_PLANET_TYPE_RE);
    return (
      <span className={fallbackClassName}>
        {parts.map((p, i) => {
          const color = (PLANET_COLORS as Record<string, string>)[p];
          return color
            ? <span key={i} style={{ color, fontWeight: 900 }}>{p}</span>
            : <span key={i}>{p}</span>;
        })}
      </span>
    );
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
    <div ref={rootRef} className={`space-y-1 flex flex-col ${!hideHeader ? "px-3 py-2" : "p-0"}`}>
      {/* 라운드 점프 + 최신으로 — 상단 고정 툴바 (showToolbar일 때만) */}
      {showToolbar && (
      <div ref={topRef} className="sticky top-0 z-20 -mx-0.5 px-0.5 py-1 bg-zinc-950/95 backdrop-blur flex flex-col gap-1 border-b border-white/10">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={scrollToTop}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 text-[10px] font-bold border border-white/10"
            title="최신 로그로(맨 위)"
          >
            <ChevronsUp className="w-3 h-3" /> 최신
          </button>
          {roundsPresent.length > 0 && (
            <button
              type="button"
              onClick={() => setShowRounds((v) => !v)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border ${showRounds ? 'bg-blue-600 border-blue-500 text-white' : 'bg-zinc-800/80 border-white/10 text-zinc-200 hover:bg-zinc-700'}`}
              title="라운드로 점프"
            >
              <Layers className="w-3 h-3" /> 라운드
            </button>
          )}
          {showRounds && roundsPresent.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => scrollToRound(r)}
              className="px-1.5 py-0.5 rounded bg-zinc-800/80 hover:bg-blue-600 text-zinc-200 hover:text-white text-[10px] font-black border border-white/10 tabular-nums"
              title={`${r}라운드 시작으로`}
            >
              {r}R
            </button>
          ))}
        </div>
        {/* [플레이어 필터] 로그에 등장한 플레이어 칩 — 클릭 시 그 플레이어 로그만. 다시 클릭/전체로 해제. */}
        {logPlayerIds.length > 1 && (
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-[9px] text-zinc-500 font-black shrink-0">필터</span>
            <button
              type="button"
              onClick={() => setFilterPlayerId(null)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${filterPlayerId === null ? 'bg-blue-600 border-blue-500 text-white' : 'bg-zinc-800/80 border-white/10 text-zinc-300 hover:bg-zinc-700'}`}
            >전체</button>
            {logPlayerIds.map((pid) => {
              const p = game.players[pid];
              const face = p?.faction ? raceFaceSrc(p.faction) : null;
              const nm = (p?.name || p?.faction || pid).slice(0, 7);
              const sel = filterPlayerId === pid;
              return (
                <button
                  key={pid}
                  type="button"
                  onClick={() => setFilterPlayerId(sel ? null : pid)}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ${sel ? 'bg-blue-600 border-blue-500 text-white' : 'bg-zinc-800/80 border-white/10 text-zinc-300 hover:bg-zinc-700'}`}
                  title={p?.name || pid}
                >
                  {face && <img src={face} alt="" className="w-3.5 h-3.5 rounded-sm object-cover" />}
                  <span className="truncate max-w-[60px]">{nm}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      )}
      {logs.length === 0 ? (
        <div className="text-center text-zinc-500 text-sm py-8 uppercase tracking-widest font-black opacity-30">
          No actions yet
        </div>
      ) : (
        [...logs].reverse().filter((log) => !filterPlayerId || (log as any).playerId === filterPlayerId).map((log, index, reversedLogs) => {
          // 최신순 표시 유지. 라운드 라벨은 블록 '하단'(그 라운드의 가장 오래된 로그 아래)에:
          // 화면에서 바로 아래(더 오래된) 항목과 라운드가 다르거나 마지막이면 이 항목이 해당 라운드의 첫(시간상) 로그.
          const nextOlder = index < reversedLogs.length - 1 ? reversedLogs[index + 1] : null;
          const isRoundFooter = typeof log.round === 'number' && (!nextOlder || nextOlder.round !== log.round);
          const actionText = log.action || '';
          const isPowerAction = /power|income|energy|bowl/i.test(actionText) || /Accepted|Declined/i.test(actionText);
          const isMainAction = /AI Move|Built|Upgraded|Advanced|Pass|Pass Round|Gaia Project|Federation|Chosen/i.test(actionText) && !isPowerAction;
          const isBonusTilePickLog = /^Selected Bonus Tile$/i.test(actionText);
          const isBonusSwapLog = /^Selected Bonus$/i.test(actionText);
          const isBonusTileLog = isBonusTilePickLog || isBonusSwapLog;
          // 연방 보상/트왈라잇 재수령: 이미지만으로 충분 → 상세 텍스트(점수/보상 라벨) 숨김
          const hideDetailsText = /^Twilight: (Federation benefit|Spaceship Fed)$/i.test(actionText) || /^Federation Reward$/i.test(actionText);

          const player = log.playerId ? game.players[log.playerId] : undefined;
          const factionObj = player?.faction ? FACTIONS.find(f => f.id === player.faction) : undefined;
          const factionColor = factionObj?.color;
          const portraitSrc = player?.faction ? raceFaceSrc(player.faction) : null;
          const primaryImg = getLogPrimaryImage(log, player?.faction);

          return (
            <Fragment key={index}>
            <div
              onMouseEnter={() => log.tileId && onEntryMouseEnter?.(log.tileId)}
              onMouseLeave={() => onEntryMouseLeave?.()}
              onClick={() => setOpenIdx((prev) => (prev === index ? null : index))}
              title="클릭해서 점수·자원 변동 보기"
              className={`flex ${isBonusTileLog ? 'items-center gap-1.5 py-0 px-1.5' : 'items-center gap-2 py-1 px-2'} rounded-lg border transition-all duration-200 ${isMainAction
                ? 'bg-zinc-800/40 shadow-[0_0_15px_rgba(0,0,0,0.3)]'
                : isPowerAction
                  ? 'bg-zinc-950/20 opacity-90'
                  : 'bg-zinc-900/30'
                } ${log.tileId ? 'cursor-pointer hover:bg-zinc-800/80' : 'hover:bg-zinc-800/60'}`}
              style={{
                // 칸 전체를 종족색으로 연하게 두름 (좌측 바 대체). 종족 없으면 액션 유형별 폴백.
                borderColor: factionColor ? hexToRgba(factionColor, 0.45) : (isMainAction ? 'rgba(59,130,246,0.35)' : 'rgba(255,255,255,0.08)'),
                // 라운드 점프 시 상단 고정 툴바에 가리지 않도록 여백
                scrollMarginTop: '2.75rem',
              }}
            >
              {portraitSrc && (
                // 왼쪽에 종족 얼굴 초상(비딩 화면과 동일 이미지) — 색만으로 헷갈리는 종족 구분용.
                <img
                  src={portraitSrc}
                  alt={factionObj?.name}
                  title={player?.name}
                  loading="lazy"
                  className="shrink-0 self-center rounded-md object-cover object-center select-none"
                  style={{
                    width: `${32 * (textScale ?? 1)}px`,
                    height: `${27 * (textScale ?? 1)}px`,
                  }}
                />
              )}
              <div className="flex-1 min-w-0">
                <div
                  className={`flex items-center min-w-0 ${isBonusTileLog ? 'gap-1.5' : 'gap-2'}`}
                  style={mainTextStyle}
                >
                  {primaryImg && (
                    // 로그 배율(textScale)에 맞춰 이미지도 함께 확대 (zoom은 레이아웃 흐름 유지하며 스케일 — 미니뷰와 동일 방식)
                    <span className="inline-flex items-center shrink-0" style={textScale !== 1 ? ({ zoom: textScale } as CSSProperties) : undefined}>
                    {(() => {
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
                            style={primaryImg.rotateDeg ? { transform: `rotate(${primaryImg.rotateDeg}deg)` } : undefined}
                            loading="lazy"
                            onError={(e) => {
                              // 에셋이 없는 경우(예: 일부 행성 타입/구조 조합) 깨진 이미지 표시를 숨김
                              (e.currentTarget as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        </div>
                      );
                    })()}
                    </span>
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
                      {(log.action === '모웨이드 확장 행성' || log.action === '팅커로이드 확장 행성')
                        ? renderPlanetColored(
                            log.details,
                            `${isMainAction ? 'text-zinc-200 font-bold' : 'text-zinc-300 font-medium'}`
                          )
                        : renderDetailsMultiline(
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
                {/* 클릭 시: 이 액션 후 점수/자원(결과) + 이 액션으로 인한 변동(base=액션 직전 대비) */}
                {openIdx === index && (() => {
                  const snap = log.snap;
                  if (!snap) {
                    return (
                      <div className="mt-1 border-t border-white/10 pt-1 text-zinc-500" style={secondaryTextStyle}>
                        이 로그에는 스냅샷이 없습니다 (수정 이전 기록).
                      </div>
                    );
                  }
                  // 원본 시간순 인덱스: 필터 시 index가 어긋나므로 로그 객체로 직접 찾음(스냅샷 diff 정확).
                  const origIdx = logs.indexOf(log);
                  // base(이 액션 직전 스냅샷)가 있으면 '이 액션만'의 변동. 없으면(구 로그) 같은 플레이어 직전 로그로 폴백.
                  const prev = log.base ?? prevSnapFor(origIdx, log.playerId);
                  return (
                    <div className="mt-1 border-t border-white/10 pt-1 flex flex-col gap-0.5" style={secondaryTextStyle}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-zinc-300">
                        <span className="text-zinc-500 font-bold">결과</span>
                        {STAT_DEFS.map(([k, label]) => (
                          <span key={k} className="tabular-nums">{label} <span className="font-bold text-zinc-100">{snap[k]}</span></span>
                        ))}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-zinc-500 font-bold">변동</span>
                        {prev ? (() => {
                          const diffs = STAT_DEFS
                            .map(([k, label]) => [label, snap[k] - prev[k]] as [string, number])
                            .filter(([, d]) => d !== 0);
                          if (diffs.length === 0) return <span className="text-zinc-500">변화 없음</span>;
                          return diffs.map(([label, d]) => (
                            <span key={label} className={`font-bold tabular-nums ${d > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {d > 0 ? '+' : ''}{d} {label}
                            </span>
                          ));
                        })() : (
                          <span className="text-zinc-500">직전 기록 없음 (이 플레이어 첫 로그)</span>
                        )}
                      </div>
                    </div>
                  );
                })()}
                {/* [롤백] 호스트만: 이 지점(턴 시작)으로 되돌리기 요청 — 다른 사람 전원 동의 시 실행 */}
                {openIdx === index && canRollback && typeof log.seq === 'number' && onRollbackToSeq && (
                  <div className="mt-1">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onRollbackToSeq(log.seq!, `${log.playerName}: ${log.action}`); }}
                      className="px-2 py-0.5 rounded bg-amber-700/70 hover:bg-amber-600 text-white text-[10px] font-bold border border-amber-400/30"
                      title="이 지점의 턴 시작으로 롤백 요청 (다른 사람 전원 동의 필요)"
                    >
                      ↩ 여기로 롤백 요청
                    </button>
                  </div>
                )}
              </div>
            </div>
            {isRoundFooter && typeof log.round === 'number' && (
              <div
                ref={(el) => { roundRefs.current[log.round as number] = el; }}
                style={{ scrollMarginTop: '2.75rem' }}
                className="flex items-center gap-2 px-1 pt-1 pb-2 select-none"
              >
                <div className="h-px flex-1 bg-gradient-to-r from-transparent to-blue-500/60" />
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-300 shrink-0">Round {log.round}</span>
                <div className="h-px flex-1 bg-gradient-to-l from-transparent to-blue-500/60" />
              </div>
            )}
            </Fragment>
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
