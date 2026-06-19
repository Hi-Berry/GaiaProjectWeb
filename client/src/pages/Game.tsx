import { useState, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useDragControls } from 'framer-motion';
import { useParams, useLocation } from 'wouter';
import { GameClient, getSocket, getStoredPlayerId, getStoredSpectatorId, storePlayerId, type GameState, type PlayerState } from '@/lib/gameClient';
import { playerIdsForFactionBiddingUi } from '@/lib/factionBiddingPlayerOrder';

import { ResearchBoard } from '@/components/ResearchBoard';
import { RoundBoard } from '@/components/RoundBoard';
import { GameBoard } from '@/components/GameBoard';
import { BonusTiles } from '@/components/BonusTiles';
import { BonusSelectionModal } from '@/components/BonusSelectionModal';
import { FreeActionsDialog } from '@/components/FreeActionsDialog';
import { ChatPanel } from '@/components/ChatPanel';

import { PlayerPanel } from '@/components/PlayerPanel';
import { GameLog } from '@/components/GameLog';
import { ClickDebugOverlay } from '@/components/ClickDebugOverlay'; // [임시] 클릭 진단
import { FactionSelect } from '@/components/FactionSelect';
import { FactionBiddingPanel } from '@/components/FactionBiddingPanel';
import { GameLobby } from '@/components/GameLobby';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { playMyTurnSound, playOtherTurnSound, playPowerReceiveSound } from '@/lib/audio';
import { ArrowLeft, Users, Gift, Clock, User, ChevronDown, ChevronUp, Gamepad2, FlaskConical, Layers, Trophy, Star, Flag, Shield, Ship, Mountain, Menu, X, Eye, ChevronRight } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AdminModeDialog } from '@/components/AdminModeDialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';

import { FACTIONS, RESEARCH_TRACKS, ALL_TECH_TILES, SHIP_TECH_TILES, ALL_ADVANCED_TECH_TILES, ALL_BONUS_TILES, FEDERATION_REWARDS, SPACESHIP_FEDERATION_REWARDS, GLEENS_FEDERATION_REWARD, BUILDING_LIMITS, PLANET_COLORS, HOME_PLANETS, getTerraformSteps, getTerraformStepsForFaction, getGaiaBaseQic, getTerraformCost, getRange, getEffectiveBaseRange, getDistance, hasNearbyPlayersForTradingDiscount, getFederationEntries, isTechTileCovered, ARTIFACTS, getNextRoundIncomePreview, findOptimalIncomeOrder, simulateIncomeOrder, ROUND_MISSION_POOL, FINAL_MISSION_LABELS, getFinalMissionValue, getFinalMissionVp, canSpendTaklonsPower } from '@shared/gameConfig';
import type { StructureType, ResearchTrack, PlanetType } from '@shared/gameConfig';

/** 팅커로이드 라운드 Special 액션 ID → 라벨 (1–3라운드: 1TF+광산, 1QIC, 4파워 / 4–6라운드: 3K, 2QIC, 3TF+광산) */
const TINKEROID_SPECIAL_LABELS: Record<string, string> = {
  'tinkeroid-1tf-mine': '1 TF + 광산 건설',
  'tinkeroid-1qic': '1 QIC',
  'tinkeroid-4power': '4 파워',
  'tinkeroid-3k': '3 지식',
  'tinkeroid-2qic': '2 QIC',
  'tinkeroid-3tf-mine': '3 TF + 광산 건설',
};

type PotentialAction =
  | { type: 'buildMine', tileId: string, useGaiaformer?: boolean }
  | { type: 'upgrade', tileId: string, target: StructureType | 'academy_left' | 'academy_right' }
  | { type: 'advanceTech', trackId: ResearchTrack }
  | { type: 'usePowerAction', actionId: string }
  | { type: 'useTechAction', tileId: string }
  | { type: 'useSpecialAction', actionId: string }
  | { type: 'bonusAction' };

const MIN_MINI_WIDTH = 280;
const MAX_MINI_WIDTH = 600;
const MINI_CONTENT_BASE_WIDTH = 340;
// 미니 패널 콘텐츠 좌우 여백. 스크롤 컨테이너의 우측 패딩(6px)+세로 스크롤바(5px)=11px를
// 확보하지 않으면 콘텐츠 오른쪽 끝(연구 트랙 6열의 마지막 열)이 스크롤바에 가려 안 보임 → 14로 상향.
const MINI_CONTENT_SIDE_GUTTER = 14;
const getMiniContentScale = (width: number) => Math.max(0.1, (width - MINI_CONTENT_SIDE_GUTTER) / MINI_CONTENT_BASE_WIDTH);

/** 미니 패널: 폭에 맞춰 내용을 축소 렌더링 */
function MiniScaledContent({ panelWidth, children, className }: { panelWidth: number; children: ReactNode; className?: string }) {
  const scale = getMiniContentScale(panelWidth);

  return (
    <div className={className} style={{ width: MINI_CONTENT_BASE_WIDTH * scale }}>
      {/* 
        NOTE:
        - transform+absolute 기반 스케일은 실제 스크롤 높이를 과소계산하는 케이스가 있어
          (특히 overflow-visible + 복잡한 레이아웃) 작은 화면에서 아래가 안 보일 수 있음.
        - zoom은 레이아웃 흐름을 유지하면서 축소돼 스크롤 컨테이너가 자연스럽게 높이를 계산함.
      */}
      <div
        style={{
          width: MINI_CONTENT_BASE_WIDTH,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          zoom: scale as any,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default function Game() {
  const params = useParams<{ matchID: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const gameId = params.matchID;
  const [game, setGame] = useState<GameState | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(gameId ? getStoredPlayerId(gameId) : null);
  const [isSpectator, setIsSpectator] = useState(false);
  const [pendingAction, setPendingAction] = useState<PotentialAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(false);
  const [isResearchOpen, setIsResearchOpen] = useState(false);
  const [isBonusTilesOpen, setIsBonusTilesOpen] = useState(false);
  const [isFreeActionsOpen, setIsFreeActionsOpen] = useState(false);
  const isMyTurn = game?.turnOrder && game?.currentPlayerIndex !== undefined ? game.turnOrder[game.currentPlayerIndex] === playerId : false;
  /** 우주선 기술 타일 2TF+Mine 플로우가 "미니 R패널"에서 시작됐는지 (자동 R창 열고닫기 억제용) */
  const [shipTech2TfMineFromMini, setShipTech2TfMineFromMini] = useState(false);
  const [confirmPassWithTileId, setConfirmPassWithTileId] = useState<string | null>(null);
  /** 연방 선언 시 불필요한 위성 경고 다이얼로그 (서버 federation_redundant_warning 수신 시) */
  const [federationRedundantWarning, setFederationRedundantWarning] = useState<{ count: number } | null>(null);
  /** 프리액션 모드: 내 상태창에서 자원/파워 숫자 클릭으로 즉시 변환 */
  const [freeActionMode, setFreeActionMode] = useState(false);
  /** 네뷸라 의회: 직전 O 클릭(2P→1O)을 다음 클릭에서 3P→2O / 2P→1O+1C로 승격하기 위한 체인 추적 */
  const nevlasOreChainRef = useRef<{ expectP3: number; expectOre: number } | null>(null);
  /** 파워/우주선 액션: 3그릇 부족분을 2그릇 태우기(1소모+1이동)로 충당할지 확인 다이얼로그 */
  const [confirmBurnAction, setConfirmBurnAction] = useState<
    | { kind: 'power'; actionId: string; burns: number; closeResearchOverlay?: boolean }
    | { kind: 'ship'; shipTileId: string; actionIndex: number; targetTileId?: string; burns: number; label: string; fromOverlay?: boolean }
    | null
  >(null);
  /** 하이브 우주정거장 배치 모드: 켜면 안내 모달 표시, 다른 액션 차단, 빈 우주 클릭 후 배치하면 종료 */
  const [ivitsSpaceStationMode, setIvitsSpaceStationMode] = useState(false);
  /** 엠바스(Ambas) Special: 의회↔광산 교체 모드 (광산 클릭 시 교체 실행) */
  const [ambasSwapPiMineMode, setAmbasSwapPiMineMode] = useState(false);
  /** 매안(Bescods) Special: 가장 낮은 트랙 +1 선택 다이얼로그 */
  const [bescodsAdvanceLowestOpen, setBescodsAdvanceLowestOpen] = useState(false);
  /** 파이락(Firaks) Downgrade: true면 연구소 클릭 대기, 선택된 연구소 타일 ID면 트랙 선택 다이얼로그 */
  const [firaksDowngradeMode, setFiraksDowngradeMode] = useState(false);
  const [firaksDowngradeLabTileId, setFiraksDowngradeLabTileId] = useState<string | null>(null);
  /** 모웨이드(Moweyip) Special: 링 놓기 — 본인 건물 클릭 시 링 배치 */
  const [moweyipPlaceRingMode, setMoweyipPlaceRingMode] = useState(false);
  /** 보너스 타일 선택 단계에서 패널 접기/펼치기 (맵 보면서 선택 가능) */
  const [isBonusSelectionPanelExpanded, setIsBonusSelectionPanelExpanded] = useState(true);
  /** L 키: 게임 로그 오버레이 (평소에는 UI 없음) */
  const [isLogPanelOpen, setIsLogPanelOpen] = useState(false);
  /** 플레이어 상세(클릭 시) 팝오버 배율 */
  const [playerDetailScale, setPlayerDetailScale] = useState<1 | 1.5 | 2>(() => {
    const v = parseFloat(localStorage.getItem('player-detail-scale') || '1');
    return v === 2 ? 2 : v === 1.5 ? 1.5 : 1;
  });
  /** 오른쪽 플레이어 요약: 클릭 시 펼쳐서 연방·기술타일·인공물·Special 사용여부 등 표시 */
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null);
  /** 맵 줌/팬: 페이즈 전환 시에도 유지 (localStorage 연동) */
  const [mapZoom, setMapZoom] = useState(1);
  const [mapPan, setMapPan] = useState({ x: 0, y: 0 });
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    const saved = localStorage.getItem('is-sidebar-open');
    return saved !== null ? saved === 'true' : true;
  });
  const LOG_TEXT_SCALES = [1, 1.5, 2] as const;
  const [logTextScale, setLogTextScale] = useState<(typeof LOG_TEXT_SCALES)[number]>(() => {
    const saved = localStorage.getItem('game-log-text-scale');
    const n = saved ? parseFloat(saved) : 1;
    return LOG_TEXT_SCALES.includes(n as (typeof LOG_TEXT_SCALES)[number]) ? n as (typeof LOG_TEXT_SCALES)[number] : 1;
  });
  // 데스크톱 사이드바 도킹 로그 높이(vh). 줄이면 플레이어 상태(4번째 등)가 더 보임.
  const LOG_DOCK_MIN_VH = 16;
  const LOG_DOCK_MAX_VH = 60;
  const [logDockHeightVh, setLogDockHeightVh] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem('game-log-dock-height') ?? '');
    return Number.isFinite(saved) ? Math.min(60, Math.max(16, saved)) : 36;
  });
  /** 도크 로그의 최신/라운드 점프 툴바 표시 (Game Log 타이틀 클릭으로 토글, 기본 숨김) */
  const [logToolsOpen, setLogToolsOpen] = useState(false);
  const adjustLogDockHeight = (delta: number) => {
    setLogDockHeightVh((prev) => {
      const next = Math.min(LOG_DOCK_MAX_VH, Math.max(LOG_DOCK_MIN_VH, prev + delta));
      localStorage.setItem('game-log-dock-height', String(next));
      return next;
    });
  };
  const SIDEBAR_MIN_WIDTH = 280;
  const SIDEBAR_MAX_WIDTH = 720;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem('sidebar-width');
    const n = saved ? parseInt(saved, 10) : 340;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, isNaN(n) ? 340 : n));
  });
  const [isZoomInitialized, setIsZoomInitialized] = useState(false);

  const startSidebarResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    let lastWidth = startWidth;
    const maxAllowed = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - 200));
    const onMove = (moveEvent: MouseEvent) => {
      // 사이드바는 우측에 붙어있으므로 왼쪽으로 드래그(마우스가 왼쪽으로) = 너비 증가
      const dx = startX - moveEvent.clientX;
      const w = Math.min(maxAllowed, Math.max(SIDEBAR_MIN_WIDTH, startWidth + dx));
      lastWidth = w;
      setSidebarWidth(w);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem('sidebar-width', String(lastWidth));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // 상태 영역 ↕ 로그 영역 분할 드래그
  // 로컬 스토리지 로드 (gameId가 준비되면 한 번만)
  useEffect(() => {
    if (gameId && !isZoomInitialized) {
      const savedZoom = localStorage.getItem(`game-zoom-${gameId}`);
      const savedPan = localStorage.getItem(`game-pan-${gameId}`);
      if (savedZoom) setMapZoom(parseFloat(savedZoom));
      if (savedPan) setMapPan(JSON.parse(savedPan));
      setIsZoomInitialized(true);
    }
  }, [gameId, isZoomInitialized]);

  // 로컬 스토리지 저장 (초기화 완료 후에만)
  useEffect(() => {
    if (gameId && isZoomInitialized) {
      localStorage.setItem(`game-zoom-${gameId}`, mapZoom.toString());
      localStorage.setItem(`game-pan-${gameId}`, JSON.stringify(mapPan));
      localStorage.setItem('is-sidebar-open', String(isSidebarOpen));
    }
  }, [gameId, mapZoom, mapPan, isSidebarOpen, isZoomInitialized]);

  // 종족 비딩 단계에선 사이드바를 강제로 펼침 — 비딩 패널이 상태창 영역을 덮어 표시되므로
  // 사이드바가 접혀 있으면(너비 0) 패널도 안 보인다.
  useEffect(() => {
    if (game?.currentPhase === 'factionBidding') setIsSidebarOpen(true);
  }, [game?.currentPhase]);

  // 패스 시 보너스 타일 선택 대기 상태 확인
  const isPendingBonusSelection = game?.pendingBonusSelection === playerId;
  const [highlightedTileId, setHighlightedTileId] = useState<string | null>(null);
  const [advanceTechDialog, setAdvanceTechDialog] = useState<{ open: boolean; trackId: ResearchTrack | null }>({ open: false, trackId: null });
  // 팅커로이드 라운드 Special 팝업 접기(맵·라운드 보며 고르기)
  const [tinkeroidSpecialCollapsed, setTinkeroidSpecialCollapsed] = useState(false);
  const [isFactionSelectOpen, setIsFactionSelectOpen] = useState(false);
  /** 트왈라잇 액션2: TS→연구소 업그레이드 시 선택할 교역소 타일 (shipTileId) */
  const [pendingTwilightTSUpgrade, setPendingTwilightTSUpgrade] = useState<string | null>(null);
  /** Rebellion 액션2: 광산→교역소 업그레이드 시 선택할 광산 타일 (shipTileId) */
  const [pendingRebellionMineToTS, setPendingRebellionMineToTS] = useState<string | null>(null);
  /** 테란 의회: 가이아포머 토큰 해택 선택 (4→QIC/K, 3→O, 1→C) */
  const [terranCouncilChoice, setTerranCouncilChoice] = useState({ qic: 0, knowledge: 0, ore: 0, credits: 0 });
  /** 타클론 파워 수신 선택: Brain First(기본) ↔ PI 1st 둘 중 하나만 켜짐(라디오). 기본은 브레인 스톤 우선 */
  const [powerOfferBrainFirst, setPowerOfferBrainFirst] = useState(true);
  const [powerOfferPiAddFirst, setPowerOfferPiAddFirst] = useState(false);
  /** 한 컴퓨터 4인플: 방장 브라우저인지 (턴 바뀔 때 조작 플레이어 자동 전환용) */
  const isHostSessionRef = useRef(
    gameId ? localStorage.getItem(`is-host-${gameId}`) === 'true' : false
  );
  const [isResearchPinned, setIsResearchPinned] = useState(
    gameId ? localStorage.getItem(`is-research-pinned-${gameId}`) === 'true' : false
  );
  const [isBonusPinned, setIsBonusPinned] = useState(
    gameId ? localStorage.getItem(`is-bonus-pinned-${gameId}`) === 'true' : false
  );
  // 미니뷰(Tactical Overview)는 한 번 열면 언마운트하지 않고 CSS로만 숨긴다 → 재오픈 시 이미지 재로딩 깜빡임 방지.
  const [bonusMiniMounted, setBonusMiniMounted] = useState(isBonusPinned);
  useEffect(() => { if (isBonusPinned) setBonusMiniMounted(true); }, [isBonusPinned]);
  const [hoveredPlayerId, setHoveredPlayerId] = useState<string | null>(null);
  // 미니뷰가 뷰포트 밖으로 못 나가게 클램프
  // 좌상단 좌표 기준이므로 (0, 0)이 최소값. 우/하단은 일부만 보여도 다시 드래그 가능하게 마진
  const clampMiniPos = (pos: { x: number; y: number }) => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const VISIBLE_MIN = 80;
    return {
      x: Math.max(0, Math.min(vw - VISIBLE_MIN, pos.x)),
      y: Math.max(0, Math.min(vh - VISIBLE_MIN, pos.y)),
    };
  };
  const [researchPos, setResearchPos] = useState(() => {
    const saved = gameId ? localStorage.getItem(`research-pos-${gameId}`) : null;
    const initial = saved ? JSON.parse(saved) : { x: 20, y: 90 };
    return clampMiniPos(initial);
  });
  const [bonusPos, setBonusPos] = useState(() => {
    const saved = gameId ? localStorage.getItem(`bonus-pos-${gameId}`) : null;
    const initial = saved ? JSON.parse(saved) : { x: 380, y: 90 };
    return clampMiniPos(initial);
  });

  // 뷰포트 크기가 줄어도 클램프 (창 리사이즈 대응)
  useEffect(() => {
    const handler = () => {
      setResearchPos((p: { x: number; y: number }) => clampMiniPos(p));
      setBonusPos((p: { x: number; y: number }) => clampMiniPos(p));
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  const [researchMiniWidth, setResearchMiniWidth] = useState(() => {
    const saved = gameId ? localStorage.getItem(`research-mini-width-${gameId}`) : null;
    const n = saved ? parseInt(saved, 10) : 340;
    return Math.min(MAX_MINI_WIDTH, Math.max(MIN_MINI_WIDTH, isNaN(n) ? 340 : n));
  });
  const [researchMiniHeight, setResearchMiniHeight] = useState(() => {
    const saved = gameId ? localStorage.getItem(`research-mini-height-${gameId}`) : null;
    const n = saved ? parseInt(saved, 10) : 650;
    return isNaN(n) ? 650 : n;
  });

  const [bonusMiniWidth, setBonusMiniWidth] = useState(() => {
    const saved = gameId ? localStorage.getItem(`bonus-mini-width-${gameId}`) : null;
    const n = saved ? parseInt(saved, 10) : 340;
    return Math.min(MAX_MINI_WIDTH, Math.max(MIN_MINI_WIDTH, isNaN(n) ? 340 : n));
  });
  const [bonusMiniHeight, setBonusMiniHeight] = useState(() => {
    const saved = gameId ? localStorage.getItem(`bonus-mini-height-${gameId}`) : null;
    const n = saved ? parseInt(saved, 10) : 420;
    return isNaN(n) ? 420 : n;
  });

  /** 리서치 미니뷰 첫 오픈 시 콘텐츠 실제 높이에 맞춰 자동 크기 조정 (하단 잘림 방지). 사용자가 직접 리사이즈해 저장된 높이가 있으면 건드리지 않음 */
  const researchMiniScrollRef = useRef<HTMLDivElement | null>(null);
  const researchMiniAutoSizedRef = useRef(false);
  useEffect(() => {
    if (!isResearchPinned || researchMiniAutoSizedRef.current) return;
    const saved = gameId ? localStorage.getItem(`research-mini-height-${gameId}`) : null;
    if (saved) { researchMiniAutoSizedRef.current = true; return; }
    const t = setTimeout(() => {
      const el = researchMiniScrollRef.current;
      if (!el) return;
      const headerH = 36; // 타이틀바 높이
      const desired = el.scrollHeight + headerH + 4;
      const maxH = Math.min(900, window.innerHeight * 0.95 - researchPos.y);
      setResearchMiniHeight(Math.max(200, Math.min(desired, maxH)));
      researchMiniAutoSizedRef.current = true;
    }, 80);
    return () => clearTimeout(t);
  }, [isResearchPinned, gameId, researchPos.y, !!game]);

  const researchDragControls = useDragControls();
  const bonusDragControls = useDragControls();
  const [showGameEndScore, setShowGameEndScore] = useState(false);
  const [aiFeedbackOpen, setAiFeedbackOpen] = useState(false);
  const [aiFeedbackRating, setAiFeedbackRating] = useState<'bad' | 'questionable' | 'good'>('bad');
  const [aiFeedbackExpertMove, setAiFeedbackExpertMove] = useState('');
  const [aiFeedbackReason, setAiFeedbackReason] = useState('');
  const [aiFeedbackSubmitting, setAiFeedbackSubmitting] = useState(false);
  const [selectedAiFeedbackActionId, setSelectedAiFeedbackActionId] = useState<string | null>(null);
  const [isAdminModeOpen, setIsAdminModeOpen] = useState(false);

  const lastResizeWidthRef = useRef<number>(340);
  const lastResizeHeightRef = useRef<number>(500);

  const startResize = (panel: 'research' | 'bonus', axis: 'x' | 'y' | 'both', e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = panel === 'research' ? researchMiniWidth : bonusMiniWidth;
    const startHeight = panel === 'research' ? researchMiniHeight : bonusMiniHeight;

    lastResizeWidthRef.current = startWidth;
    lastResizeHeightRef.current = startHeight;

    const setWidth = panel === 'research' ? setResearchMiniWidth : setBonusMiniWidth;
    const setHeight = panel === 'research' ? setResearchMiniHeight : setBonusMiniHeight;

    const keyW = panel === 'research' ? `research-mini-width-${gameId}` : `bonus-mini-width-${gameId}`;
    const keyH = panel === 'research' ? `research-mini-height-${gameId}` : `bonus-mini-height-${gameId}`;

    // 미니뷰가 화면 밖으로 튀어나가지 않도록 뷰포트 기반 동적 상한 (창 위치까지 고려)
    const panelPos = panel === 'research' ? researchPos : bonusPos;
    const margin = 20;
    const maxWForViewport = Math.max(MIN_MINI_WIDTH, window.innerWidth - panelPos.x - margin);
    const maxHForViewport = Math.max(200, window.innerHeight - panelPos.y - margin);
    const maxW = Math.min(MAX_MINI_WIDTH, maxWForViewport);
    const maxH = Math.min(900, maxHForViewport);
    const MIN_H = 200;

    const onMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      // 축별 독립 처리 — 사용자가 가로 드래그하면 가로만, 세로면 세로만, 대각이면 둘 다
      if (axis === 'x' || axis === 'both') {
        const w = Math.min(maxW, Math.max(MIN_MINI_WIDTH, startWidth + dx));
        lastResizeWidthRef.current = w;
        setWidth(w);
        if (gameId) localStorage.setItem(keyW, String(w));
      }
      if (axis === 'y' || axis === 'both') {
        const h = Math.min(maxH, Math.max(MIN_H, startHeight + dy));
        lastResizeHeightRef.current = h;
        setHeight(h);
        if (gameId) localStorage.setItem(keyH, String(h));
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (gameId) {
        if (axis === 'x' || axis === 'both') localStorage.setItem(keyW, String(lastResizeWidthRef.current));
        if (axis === 'y' || axis === 'both') localStorage.setItem(keyH, String(lastResizeHeightRef.current));
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Sound notification tracking
  const lastActivePlayerRef = useRef<string | null>(null);
  const lastWasMyTurnRef = useRef(false);
  const lastPendingBonusSelectionRef = useRef<string | null>(null);
  const lastWasMyBonusRef = useRef(false);
  const lastPendingTechSelectionRef = useRef<string | null>(null);
  const lastWasMyTechRef = useRef(false);
  const lastPowerStateRef = useRef({ p1: 0, p2: 0, p3: 0, bs: 0 });
  const prevPhaseRef = useRef<string | undefined>(undefined);

  // 결과창: phase가 gameEnd로 바뀌는 순간(또는 최초 로드가 이미 gameEnd일 때)에만 한 번 열기 (관전 시 game_updated 재수신으로 창이 다시 열리는 현상 방지)
  useEffect(() => {
    const phase = game?.currentPhase;
    if (phase === 'gameEnd' && prevPhaseRef.current !== 'gameEnd') {
      setShowGameEndScore(true);
    }
    // 관전/재연결 등으로 game이 잠깐 undefined가 되는 경우 prevPhaseRef가 리셋되면
    // 이후 gameEnd를 다시 받았을 때 결과창이 "또" 열릴 수 있으므로, undefined로 덮어쓰지 않는다.
    if (phase != null) prevPhaseRef.current = phase;
  }, [game?.currentPhase]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setIsAdminModeOpen(true);
        return;
      }
      if (e.key.toLowerCase() === 'f') {
        const isMyTurn = game?.turnOrder[game?.currentPlayerIndex ?? -1] === playerId;
        if (!isMyTurn || game?.currentPhase !== 'main') return;
        setIsFreeActionsOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [game, playerId]);

  // 이미지 프리로드(브라우저 캐시 워밍): Research/미니뷰는 닫으면 언마운트돼 <img>가 파괴됐다 다시 그려지면서
  // 재로딩 깜빡임이 생긴다. 자주 쓰는 이미지를 한 번 로드해 캐시에 올려두면, 재마운트 시 즉시 표시된다.
  useEffect(() => {
    const urls: string[] = [];
    [...ALL_TECH_TILES, ...ALL_ADVANCED_TECH_TILES, ...SHIP_TECH_TILES].forEach(t => { if (t.image) urls.push(t.image); });
    FEDERATION_REWARDS.forEach((_, i) => urls.push(`/image/Federation_${i + 1}.gif`));
    SPACESHIP_FEDERATION_REWARDS.forEach((_, i) => urls.push(`/image/Federation_${i + 7}.gif`));
    ARTIFACTS.forEach((_, i) => urls.push(`/image/Art${i + 1}.png`));
    ALL_BONUS_TILES.forEach((_, i) => urls.push(`/image/BoostTile_${i + 1}.jpg`));
    // 라운드 점수 타일(RS_*.gif) — RoundBoard의 id.replace('rs','') 규칙과 동일
    ROUND_MISSION_POOL.forEach(t => urls.push(`/image/RS_${t.id.replace('rs', '')}.gif`));
    // 최종 미션(EGS_*.jpg) — FINAL_MISSION_LABELS 키 인덱스 기준
    Object.keys(FINAL_MISSION_LABELS).forEach((_, i) => urls.push(`/image/EGS_${i + 1}.jpg`));
    const imgs = Array.from(new Set(urls)).map(u => { const img = new Image(); img.src = u; return img; });
    (window as any).__gaiaPreloadedImages = imgs; // GC 방지용 참조 유지
  }, []);

  const handleConfirm = () => {
    if (!pendingAction || !gameId) return;

    if (pendingAction.type === 'buildMine') {
      GameClient.buildMine(gameId, (pendingAction as any).tileId, (pendingAction as any).useGaiaformer);
    } else if (pendingAction.type === 'upgrade') {
      GameClient.upgradeStructure(gameId, (pendingAction as any).tileId, (pendingAction as any).target);
    } else if (pendingAction.type === 'advanceTech') {
      GameClient.advanceTech(gameId, (pendingAction as any).trackId);
    } else if (pendingAction.type === 'usePowerAction') {
      GameClient.usePowerAction(gameId, (pendingAction as any).actionId);
    } else if (pendingAction.type === 'useTechAction') {
      GameClient.useTechAction(gameId, (pendingAction as any).tileId);
    } else if (pendingAction.type === 'useSpecialAction') {
      GameClient.useSpecialAction(gameId, (pendingAction as any).actionId);
    } else if (pendingAction.type === 'bonusAction') {
      GameClient.useBonusAction(gameId);
    }

    setPendingAction(null);
  };

  useEffect(() => {
    if (!gameId) {
      setError('No game ID provided');
      setLoading(false);
      return;
    }

    const fetchGame = async () => {
      try {
        const storedPlayerId = getStoredPlayerId(gameId);
        const storedSpectatorId = getStoredSpectatorId(gameId);

        if (storedPlayerId) {
          try {
            const { game: gameData } = await GameClient.rejoinGame(gameId, storedPlayerId);
            setGame(gameData);
            setLoading(false);
            return;
          } catch {
          }
        }

        if (storedSpectatorId) {
          try {
            const { game: gameData } = await GameClient.rejoinGame(gameId, storedSpectatorId);
            setGame(gameData);
            setPlayerId(null);
            setIsSpectator(true);
            setLoading(false);
            return;
          } catch {
            // 서버 재시작 등으로 관전자 재접속 실패 시 get_game으로 불러와도 관전자 UI 유지
          }
        }

        const { game: gameData } = await GameClient.getGame(gameId);
        setGame(gameData);
        if (storedSpectatorId) {
          setPlayerId(null);
          setIsSpectator(true);
        }
      } catch (err: any) {
        console.error('Failed to fetch game:', err);
        setError(err.message || 'Failed to load game');
      } finally {
        setLoading(false);
      }
    };

    const socket = getSocket();
    socket.on('connect', fetchGame);

    if (socket.connected) {
      fetchGame();
    }

    const unsubGame = GameClient.onGameUpdated((updatedGame) => {
      if (updatedGame.id !== gameId) return;
      if (updatedGame.hostId === playerId) isHostSessionRef.current = true;
      setGame(updatedGame);
      // 자동 전환은 useEffect(game?.turnOrder, currentPlayerIndex)에서 처리
      // 메인 액션을 이미 한 상태면 추가 액션 선택 불가 → 대기 중인 선택 초기화
      const isCurrentPlayer = updatedGame.turnOrder[updatedGame.currentPlayerIndex] === playerId;
      if (isCurrentPlayer && updatedGame.hasDoneMainAction) {
        setPendingAction(null);
        setAdvanceTechDialog((prev) => (prev.open ? { open: false, trackId: null } : prev));
        setPendingTwilightTSUpgrade(null);
        setPendingRebellionMineToTS(null);
      }
    });

    const unsubError = GameClient.onError((err) => {
      toast({
        title: 'Error',
        description: err.message,
        variant: 'destructive',
      });
    });

    const unsubGameError = GameClient.onGameError((err) => {
      const message =
        typeof (err as any) === 'string'
          ? (err as any)
          : (err as any)?.message ?? '알 수 없는 오류';
      toast({
        title: '오류',
        description: message,
        variant: 'destructive',
      });
    });

    const unsubFedRedundant = GameClient.onFederationRedundantWarning((data) => {
      setFederationRedundantWarning({ count: data?.count ?? 1 });
    });

    // 방장이 방을 삭제하면 방 안의 모두를 로비로 내보낸다
    const unsubDeleted = GameClient.onGameDeleted((payload) => {
      if (payload?.gameId && payload.gameId !== gameId) return;
      if (gameId) localStorage.removeItem(`gaia-${gameId}-spectatorId`);
      toast({ title: '방이 삭제되었습니다', description: '방장이 방을 삭제했습니다.' });
      setLocation('/');
    });

    return () => {
      socket.off('connect', fetchGame);
      unsubGame();
      unsubError();
      unsubGameError();
      unsubFedRedundant();
      unsubDeleted();
    };
  }, [gameId, playerId, toast]);

  // 방장 세션 표시: 초기 로드/재접속 시에도 설정 (game_updated만으로는 첫 로드에서 설정 안 됨)
  useEffect(() => {
    if (game && playerId && game.hostId === playerId) {
      isHostSessionRef.current = true;
      if (gameId) localStorage.setItem(`is-host-${gameId}`, 'true');
    }
  }, [game?.hostId, playerId, gameId]);

  // 우주선 기술 타일(2TF+Mine) UX:
  // 1) 타일 선택 직후 pendingShipTechMine이면 (오버레이 R창에서 골랐을 때만) R창 자동 닫기
  // 2) 광산 건설 완료 후 pendingShipTechTrackAdvance이면 (오버레이 R창에서 골랐을 때만) R창 자동 열기
  // 3) 트랙까지 올리고 pending이 모두 사라지면 플래그 리셋
  /** R창에서 선택해야 하는 보류 항목(타일/트랙/덮기)이 내 것으로 남아있는지 */
  const hasPendingResearchSelection = !!(game && playerId && (
    game.pendingTechTileSelection?.playerId === playerId ||
    game.pendingShipTechTrackAdvance?.playerId === playerId ||
    game.pendingAdvancedTechTrackAdvance?.playerId === playerId ||
    game.pendingAdvancedTechCover?.playerId === playerId
  ));
  /** 선택 대기 중에 사용자가 X로 닫으면 자동 재오픈을 멈추고 '다시 열기' 버튼만 표시 */
  const [researchAutoOpenSuppressed, setResearchAutoOpenSuppressed] = useState(false);
  useEffect(() => {
    if (researchAutoOpenSuppressed && !hasPendingResearchSelection) setResearchAutoOpenSuppressed(false);
  }, [researchAutoOpenSuppressed, hasPendingResearchSelection]);

  useEffect(() => {
    if (!game || !playerId) return;
    const minePending = game.pendingShipTechMine?.playerId === playerId;
    const trackPending = game.pendingShipTechTrackAdvance?.playerId === playerId;

    if (minePending && !shipTech2TfMineFromMini) {
      // 1단계: R 오버레이 닫고 맵에서 광산 짓게 유도
      if (isResearchOpen) setIsResearchOpen(false);
    }

    if (trackPending && !shipTech2TfMineFromMini && !researchAutoOpenSuppressed) {
      // 2단계: 트랙 올리도록 R 오버레이 자동 오픈 (사용자가 닫았으면 다시 안 엶)
      if (!isResearchOpen) setIsResearchOpen(true);
    }

    if (!minePending && !trackPending && shipTech2TfMineFromMini) {
      // 3단계 완료 후 플래그 리셋
      setShipTech2TfMineFromMini(false);
    }
  }, [
    game?.pendingShipTechMine?.playerId,
    game?.pendingShipTechTrackAdvance?.playerId,
    playerId,
    isResearchOpen,
    shipTech2TfMineFromMini,
    researchAutoOpenSuppressed,
  ]);

  // 방장일 경우 현재 턴 플레이어(봇)로 자동 전환하는 기능이 있었으나,
  // 온라인 멀티플레이 시 다른 사람의 턴일 때 방장 화면이 강제로 바뀌는 문제가 있어 제거/주석 처리.
  // 로컬 멀티플레이를 지원하려면 봇 턴일 때만 봇으로 전환되거나 별도의 '로컬 모드' 플래그가 필요합니다.
  useEffect(() => {
    if (!gameId || !game || !isHostSessionRef.current) return;
    const phase = game.currentPhase;
    if (phase === 'lobby' || phase === 'factionSelect' || phase === 'factionBidding' || phase === 'startingMines') return;

    // // 수익 선택 대기 중인 플레이어가 봇이면 포커스 이동 (사람일 때는 이동 안 함)
    // const pendingIncome = game.pendingIncomeOrder;
    // if (pendingIncome && game.botPlayerIds?.includes(pendingIncome.playerId)) {
    //   if (pendingIncome.playerId !== playerId) {
    //     setPlayerId(pendingIncome.playerId);
    //     storePlayerId(gameId, pendingIncome.playerId);
    //   }
    //   return;
    // }

    // const currentActivePlayerId = game.turnOrder[game.currentPlayerIndex];
    // if (currentActivePlayerId && currentActivePlayerId !== playerId) {
    //   if (game.currentPhase === 'bonusSelection' && game.pendingBonusSelection) {
    //     const isBot = game.botPlayerIds?.includes(game.pendingBonusSelection);
    //     // 봇의 차례일 때 방장이 대신 턴을 할 수 있게 봇으로만 전환
    //     if (isBot && game.pendingBonusSelection !== playerId) {
    //       setPlayerId(game.pendingBonusSelection);
    //       storePlayerId(gameId, game.pendingBonusSelection);
    //     }
    //     return;
    //   }

    //   // 봇 턴일 때만 자동 전환
    //   if (game.botPlayerIds?.includes(currentActivePlayerId)) {
    //     setPlayerId(currentActivePlayerId);
    //     storePlayerId(gameId, currentActivePlayerId);
    //   }
    // }
  }, [gameId, game?.turnOrder, game?.currentPlayerIndex, game?.currentPhase, game?.pendingBonusSelection, game?.pendingIncomeOrder?.playerId, game?.botPlayerIds, playerId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault(); // 스크롤 방지
        const newVal = !(isResearchPinned && isBonusPinned);
        setIsResearchPinned(newVal);
        setIsBonusPinned(newVal);
        if (gameId) {
          localStorage.setItem(`is-research-pinned-${gameId}`, String(newVal));
          localStorage.setItem(`is-bonus-pinned-${gameId}`, String(newVal));
        }
      }
      if (e.key.toLowerCase() === 'r') {
        setIsResearchOpen(prev => !prev);
        setIsBonusTilesOpen(false);
      }
      if (e.key.toLowerCase() === 't') {
        setIsBonusTilesOpen(prev => !prev);
        setIsResearchOpen(false);
      }
      if (e.key.toLowerCase() === 'l') {
        setIsLogPanelOpen((prev) => !prev);
      }
      if (e.key === 'Escape') {
        setIsResearchOpen(false);
        setIsBonusTilesOpen(false);
        setIsLogPanelOpen(false);
        setShowGameEndScore(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isResearchOpen, isBonusTilesOpen, isResearchPinned, isBonusPinned, gameId]);

  // 개발 중: 테스트 모드일 때 종족 선택 단계에서 하이브(ivits) 자동 선택
  useEffect(() => {
    if (!game || !gameId || !playerId) return;
    const cur = game.players[playerId];
    if (!cur?.faction && game.isTestMode && game.currentPhase !== 'factionBidding' && (game.currentPhase === 'factionSelect' || game.currentPhase === 'startingMines')) {
      GameClient.selectFaction(gameId, 'ivits');
    }
  }, [game?.currentPhase, game?.isTestMode, game?.players, gameId, playerId]);

  // 연구소/아카데미 건설 시 기술 타일 선택이 R창 안에만 있으므로, 필요 시 R창 자동 오픈
  // [버그수정] 새 강제 타일선택(pendingTechTileSelection)이 생기면 이전에 X로 닫아 억제됐더라도 다시 연다.
  //   (이전엔 researchAutoOpenSuppressed 때문에 트왈라잇 연구소 등 두 번째 타일선택 창이 안 떠 소프트락 — 사용자 관찰)
  //   tileId도 의존성에 넣어 같은 플레이어가 연속으로 새 타일선택을 받는 경우(playerId 불변)도 감지.
  useEffect(() => {
    if (!game || !playerId) return;
    if (game.botPlayerIds?.includes(playerId)) return; // 봇의 턴을 관전 중일 때는 자동 오픈 방지
    if (game.pendingTechTileSelection?.playerId === playerId) {
      setResearchAutoOpenSuppressed(false); // 강제 선택이 생기면 억제 해제(닫아둔 상태여도 다시 연다)
      setIsResearchOpen(true);
    }
  }, [game?.pendingTechTileSelection?.playerId, game?.pendingTechTileSelection?.tileId, playerId, game?.botPlayerIds]);

  // 테란 의회 다이얼로그가 열릴 때 선택 초기화
  useEffect(() => {
    if (game?.pendingTerranCouncilBenefit?.playerId === playerId) {
      setTerranCouncilChoice({ qic: 0, knowledge: 0, ore: 0, credits: 0 });
    }
  }, [game?.pendingTerranCouncilBenefit?.playerId, playerId]);

  // Turn behavior notification sounds
  useEffect(() => {
    if (!game || !game.turnOrder || game.currentPlayerIndex === undefined) return;

    const activePlayerId = game.turnOrder[game.currentPlayerIndex];
    const isMyTurn = activePlayerId === playerId;

    // 1. Turn change notifications
    if (activePlayerId !== lastActivePlayerRef.current || isMyTurn !== lastWasMyTurnRef.current) {
      if (isMyTurn && !lastWasMyTurnRef.current) {
        playMyTurnSound();
      } else if (!isMyTurn && activePlayerId && activePlayerId !== lastActivePlayerRef.current) {
        playOtherTurnSound();
      }
      lastActivePlayerRef.current = activePlayerId;
      lastWasMyTurnRef.current = isMyTurn;
    }

    // 2. Special cases: Bonus selection
    const pendingBonus = game.pendingBonusSelection;
    const isMyBonus = pendingBonus === playerId;
    if (pendingBonus !== lastPendingBonusSelectionRef.current || isMyBonus !== lastWasMyBonusRef.current) {
      if (isMyBonus && !lastWasMyBonusRef.current) {
        playMyTurnSound();
      } else if (!isMyBonus && pendingBonus && pendingBonus !== lastPendingBonusSelectionRef.current) {
        playOtherTurnSound();
      }
      lastPendingBonusSelectionRef.current = pendingBonus || null;
      lastWasMyBonusRef.current = isMyBonus;
    }

    // 3. Special cases: Tech selection
    const pendingTechPlayer = game.pendingTechTileSelection?.playerId;
    const isMyTech = pendingTechPlayer === playerId;
    if (pendingTechPlayer !== lastPendingTechSelectionRef.current || isMyTech !== lastWasMyTechRef.current) {
      if (isMyTech && !lastWasMyTechRef.current) {
        playMyTurnSound();
      } else if (!isMyTech && pendingTechPlayer && pendingTechPlayer !== lastPendingTechSelectionRef.current) {
        playOtherTurnSound();
      }
      lastPendingTechSelectionRef.current = pendingTechPlayer || null;
      lastWasMyTechRef.current = isMyTech;
    }
  }, [game?.currentPlayerIndex, game?.turnOrder, game?.pendingBonusSelection, game?.pendingTechTileSelection?.playerId, playerId]);

  // Power Receive sound notification
  useEffect(() => {
    if (!game || !playerId) return;
    const player = game.players[playerId];
    if (!player) return;

    const { power1: p1, power2: p2, power3: p3, brainStoneBowl: bs } = player;
    const last = lastPowerStateRef.current;

    // 파워가 상위 볼로 이동했는지 또는 브레인스톤이 전진했는지 확인
    // p2나 p3가 증가하거나, 브레인스톤이 더 높은 볼로 이동하면 소리 재생
    const p2Increased = p2 > last.p2;
    const p3Increased = p3 > last.p3;
    const bsMovedUp = (bs !== undefined && last.bs !== undefined && bs > last.bs);

    // p1이 줄어들면서 p2나 p3가 늘어난 경우 (충전)
    if ((p2Increased || p3Increased || bsMovedUp) && (p1 < last.p1 || p2 < last.p2 || (bs !== undefined && last.bs !== undefined && bs > last.bs))) {
      // 단, 본인이 메인 액션 중일 때는 너무 시끄러울 수 있으므로 
      // 상대방의 액션으로 인해 파워를 받는 경우(Passive)나 수익 단계 등에서 유용
      playPowerReceiveSound();
    }

    lastPowerStateRef.current = { p1, p2, p3, bs: bs ?? 0 };
  }, [game?.players[playerId ?? '']?.power1, game?.players[playerId ?? '']?.power2, game?.players[playerId ?? '']?.power3, game?.players[playerId ?? '']?.brainStoneBowl, playerId]);

  // Power offer reminder: 내게 온 파워 제안을 안 누르면 5초마다 알림음
  useEffect(() => {
    if (!game || !playerId) return;
    if (isSpectator) return;

    const myPendingOffers = (game.pendingPowerOffers ?? []).filter(
      (o) => o && !o.responded && o.targetPlayerId === playerId,
    );
    if (myPendingOffers.length === 0) return;

    const interval = window.setInterval(() => {
      // 입력 중에는 방해하지 않기
      const el = document.activeElement;
      const isTyping = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (isTyping) return;
      playPowerReceiveSound();
    }, 5000);

    // 첫 알림은 5초 뒤(즉시 울리면 너무 시끄러움)
    const t = window.setTimeout(() => {
      const el = document.activeElement;
      const isTyping = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (!isTyping) playPowerReceiveSound();
    }, 5000);

    return () => {
      window.clearTimeout(t);
      window.clearInterval(interval);
    };
  }, [game?.pendingPowerOffers, playerId, isSpectator]);

  const selectTechTileWithLevel5Confirm = (techTileId: string, trackId?: string, options?: { fromMini?: boolean }) => {
    if (!gameId || !game || !playerId) return;

    // 탑승하지 않은 우주선의 기술 타일은 선택 불가 — 에러만 띄우고 전송하지 않음(턴이 넘어가지 않게).
    // (서버에서도 방어하지만, 잘못 클릭 시 턴을 잃지 않도록 클라이언트에서 먼저 차단)
    if (techTileId.startsWith('ship-tech-') && !(game.availableShipTechTileIds?.includes(techTileId))) {
      toast({
        title: '선택할 수 없는 기술 타일',
        description: '탑승하지 않은 우주선의 기술 타일입니다. 먼저 해당 우주선에 탑승하세요.',
        variant: 'destructive',
      });
      return;
    }

    if (techTileId === 'ship-tech-2tf-mine') setShipTech2TfMineFromMini(Boolean(options?.fromMini));

    let advanceToLevel5: boolean | undefined;
    if (trackId) {
      const track = trackId as ResearchTrack;
      const player = game.players[playerId];
      const currentLevel = player?.research?.[track] ?? 0;
      if (player && currentLevel === 4) {
        const isLevel5Taken = Object.entries(game.players).some(([pid, p]) => pid !== playerId && (p.research?.[track] ?? 0) >= 5);
        const hasGreenFederation = getFederationEntries(player as PlayerState).some((f) => f.isGreen);
        if (isLevel5Taken) {
          advanceToLevel5 = false;
          toast({ title: '5단계 진입 불가', description: '이미 다른 플레이어가 해당 트랙 5단계에 있어 기술 타일만 획득합니다.' });
        } else if (!hasGreenFederation) {
          advanceToLevel5 = false;
          toast({ title: '연방 토큰 없음', description: '초록 연방이 없어 기술 타일만 획득하고 4단계에 머뭅니다.' });
        } else {
          advanceToLevel5 = window.confirm(`${track} 5단계로 올라가려면 초록 연방 1개를 소모합니다.\n5단계로 올라갈까요?\n\n취소하면 기술 타일만 받고 4단계에 머뭅니다.`);
        }
      }
    }

    GameClient.selectTechTile(gameId, techTileId, trackId, advanceToLevel5);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="space-y-4 text-center">
          <Skeleton className="w-64 h-64 rounded-full mx-auto" />
          <p className="text-muted-foreground animate-pulse">Loading game...</p>
        </div>
      </div>
    );
  }

  if (error || !game) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold text-destructive">Error</h1>
          <p className="text-muted-foreground">{error || 'Game not found'}</p>
          <Button onClick={() => setLocation('/')} data-testid="button-back-lobby">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Lobby
          </Button>
        </div>
      </div>
    );
  }

  const currentPlayer = playerId ? game.players[playerId] : null;

  /** 파워액션 공용 핸들러: 3그릇이 부족해도 2그릇 태우기로 충당 가능하면 확인 후 실행 */
  const handleUsePowerAction = (actionId: string, options?: { closeResearchOverlay?: boolean }) => {
    if (!gameId || game.hasDoneMainAction) return;
    const action = game.powerActions?.find(a => a.id === actionId);
    const cur = currentPlayer;
    if (action && cur) {
      if (action.costType === 'power') {
        // Nevlas 의회: 3그릇 토큰 1개 = 파워 2 → 필요 토큰 수 절반(올림) (서버 executeUsePowerAction와 일치)
        const hasNevlasPI = cur.faction === 'nevlas' && game.map?.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
        const needTokens = hasNevlasPI ? Math.ceil((action.cost as number) / 2) : (action.cost as number);
        if (cur.faction === 'taklons') {
          // 타클론은 브레인 스톤 선택지가 있어 자동 태우기 제외
          if (!canSpendTaklonsPower(cur, 3, action.cost as number)) {
            toast({ title: '파워 부족', description: '3그릇(브레인 스톤 포함)에서 낼 파워가 부족합니다.', variant: 'destructive' });
            return;
          }
        } else if ((cur.power3 ?? 0) < needTokens) {
          const burns = needTokens - (cur.power3 ?? 0);
          // 태우기 1회 = 2그릇에서 1개 소모 + 1개를 3그릇으로 이동
          if ((cur.power2 ?? 0) >= burns * 2) {
            setConfirmBurnAction({ kind: 'power', actionId, burns, closeResearchOverlay: options?.closeResearchOverlay });
            return;
          }
          toast({ title: '파워 부족', description: '3그릇 파워가 부족하고, 2그릇 태우기로도 충당할 수 없습니다.', variant: 'destructive' });
          return;
        }
      }
      if (action.costType === 'qic' && (cur.qic ?? 0) < action.cost) {
        toast({ title: 'QIC 부족', description: 'QIC가 부족합니다.', variant: 'destructive' });
        return;
      }
    }
    if (options?.closeResearchOverlay && (actionId === 'gain-1-step' || actionId === 'gain-2-steps')) setIsResearchOpen(false);
    GameClient.usePowerAction(gameId, actionId);
  };

  /** 우주선 액션 비용 (서버 use_ship_action과 일치) */
  const SHIP_ACTION_COSTS: Record<string, Record<number, { qic?: number; ore?: number; knowledge?: number; credits?: number; power?: number }>> = {
    ship_twilight: { 1: { qic: 3 }, 2: { ore: 2, power: 3 }, 3: { knowledge: 1 } },
    ship_rebellion: { 1: { qic: 3 }, 2: { ore: 1, power: 3 }, 3: { knowledge: 2 } },
    ship_tf_mars: { 1: { qic: 2 }, 2: { power: 2 }, 3: { credits: 3 } },
    ship_eclipse: { 1: { qic: 2 }, 2: { knowledge: 2, power: 3 }, 3: { credits: 6 } },
  };
  const SHIP_TOAST_NAMES: Record<string, string> = { ship_twilight: 'Twilight', ship_rebellion: 'Rebellion', ship_tf_mars: 'TF Mars', ship_eclipse: 'Eclipse' };
  const SHIP_TOAST_LABELS: Record<string, [string, string, string]> = {
    ship_twilight: ['1: 3Q → Fed', '2: 2O+3P → TS→Lab', '3: 1K → +3 Range'],
    ship_rebellion: ['1: 3Q → Tech', '2: 1O+3P → M→TS', '3: 2K → 1Q 2C'],
    ship_tf_mars: ['1: 2Q → VP', '2: 2P → Gaia', '3: 3C → 1 TF'],
    ship_eclipse: ['1: 2Q → VP', '2: 2K+3P → Research', '3: 6C → Ast'],
  };

  /** 비용 검증 통과 후 실제 진행: 타깃 선택 모드 진입 또는 서버 호출 */
  const proceedShipAction = (shipTileId: string, actionIndex: number, targetTileId?: string, options?: { fromOverlay?: boolean }) => {
    if (!gameId) return;
    const shipTile = game.map.find(t => t.id === shipTileId);
    if (actionIndex === 2 && targetTileId == null) {
      if (shipTile?.type === 'ship_twilight') {
        setPendingTwilightTSUpgrade(shipTileId);
        if (options?.fromOverlay) setIsResearchOpen(false);
        return;
      }
      if (shipTile?.type === 'ship_rebellion') {
        setPendingRebellionMineToTS(shipTileId);
        if (options?.fromOverlay) setIsResearchOpen(false);
        return;
      }
      if (shipTile?.type === 'ship_tf_mars' && options?.fromOverlay) {
        GameClient.useShipAction(gameId, shipTileId, actionIndex, targetTileId);
        setIsResearchOpen(false);
        return;
      }
    }
    GameClient.useShipAction(gameId, shipTileId, actionIndex, targetTileId);
    setPendingTwilightTSUpgrade(null);
    setPendingRebellionMineToTS(null);
    if (options?.fromOverlay) {
      const name = SHIP_TOAST_NAMES[shipTile?.type || ''] || shipTile?.type;
      const label = shipTile?.type ? SHIP_TOAST_LABELS[shipTile.type]?.[actionIndex - 1] : '';
      toast({ title: `${name} 액션`, description: label || `액션 ${actionIndex}`, variant: 'default' });
      // Eclipse 2번(연구), Rebellion 1번(3Q 타일)은 R창 유지 → 타일/트랙 선택
      const keepROpen = (shipTile?.type === 'ship_eclipse' && actionIndex === 2) || (shipTile?.type === 'ship_rebellion' && actionIndex === 1);
      if (!keepROpen) setIsResearchOpen(false);
    }
  };

  /** 우주선 액션 공용 핸들러: 비용 사전 검증 (서버는 부족 시 조용히 무시하므로 클라에서 안내) + 파워 부족 시 2그릇 태우기 확인 */
  const handleUseShipAction = (shipTileId: string, actionIndex: number, targetTileId?: string, options?: { fromOverlay?: boolean }) => {
    if (!gameId) return;
    const shipTile = game.map.find(t => t.id === shipTileId);
    const cur = currentPlayer;
    const cost = shipTile ? SHIP_ACTION_COSTS[shipTile.type]?.[actionIndex] : undefined;
    if (shipTile && cur && cost) {
      if (cost.qic && (cur.qic ?? 0) < cost.qic) { toast({ title: 'QIC 부족', description: `${cost.qic} QIC가 필요합니다.`, variant: 'destructive' }); return; }
      if (cost.ore && (cur.ore ?? 0) < cost.ore) { toast({ title: '광물 부족', description: `${cost.ore} 광물이 필요합니다.`, variant: 'destructive' }); return; }
      if (cost.knowledge && (cur.knowledge ?? 0) < cost.knowledge) { toast({ title: '지식 부족', description: `${cost.knowledge} 지식이 필요합니다.`, variant: 'destructive' }); return; }
      if (cost.credits && (cur.credits ?? 0) < cost.credits) { toast({ title: '크레딧 부족', description: `${cost.credits} 크레딧이 필요합니다.`, variant: 'destructive' }); return; }
      // 타클론은 브레인 스톤 선택지가 있어 서버 검증에 맡김 (자동 태우기 제외)
      if (cost.power && cur.faction !== 'taklons') {
        const hasNevlasPI = cur.faction === 'nevlas' && game.map?.some(t => t.ownerId === playerId && t.structure === 'planetary_institute');
        const needTokens = hasNevlasPI ? Math.ceil(cost.power / 2) : cost.power;
        if ((cur.power3 ?? 0) < needTokens) {
          const burns = needTokens - (cur.power3 ?? 0);
          if ((cur.power2 ?? 0) >= burns * 2) {
            const label = SHIP_TOAST_LABELS[shipTile.type]?.[actionIndex - 1] ?? `${SHIP_TOAST_NAMES[shipTile.type]} 액션 ${actionIndex}`;
            setConfirmBurnAction({ kind: 'ship', shipTileId, actionIndex, targetTileId, burns, label, fromOverlay: options?.fromOverlay });
            return;
          }
          toast({ title: '파워 부족', description: '3그릇 파워가 부족하고, 2그릇 태우기로도 충당할 수 없습니다.', variant: 'destructive' });
          return;
        }
      }
    }
    proceedShipAction(shipTileId, actionIndex, targetTileId, options);
  };

  /** 프리액션 모드: 내 상태창 자원/파워 클릭 → 즉시 변환. 네뷸라 의회는 O 연속 클릭(3P→2O)·O 후 C(2P→1O+1C) 체인 지원 */
  const handleFreeActionClick = (kind: 'ore' | 'knowledge' | 'qic' | 'credit' | 'bowl1' | 'bowl2' | 'bowl3' | 'baltak-gf') => {
    if (!gameId || !currentPlayer) return;
    const p = currentPlayer;
    const isTak = p.faction === 'taklons';
    const hasNevPI = p.faction === 'nevlas' && (game.map?.some(t => t.ownerId === playerId && t.structure === 'planetary_institute') ?? false);
    // 직전 O 클릭 체인 검증 (그 사이 다른 경로로 자원이 바뀌었으면 무효)
    const chain = nevlasOreChainRef.current;
    const chainValid = !!chain && hasNevPI && (p.power3 ?? 0) === chain.expectP3 && (p.ore ?? 0) === chain.expectOre;
    nevlasOreChainRef.current = null;

    const needPower = (cost: number) => {
      const ok = isTak ? canSpendTaklonsPower(p, 3, cost) : hasNevPI ? (p.power3 ?? 0) >= Math.ceil(cost / 2) : (p.power3 ?? 0) >= cost;
      if (!ok) toast({ title: '파워 부족', description: '3그릇 파워가 부족합니다.', variant: 'destructive' });
      return ok;
    };

    switch (kind) {
      case 'ore':
        if (chainValid) {
          // 의회 네뷸라: 직전 2P→1O를 3P→2O로 승격 (토큰 1개만 추가 소모)
          if ((p.power3 ?? 0) < 1) { toast({ title: '파워 부족', description: '3그릇 파워가 부족합니다.', variant: 'destructive' }); return; }
          GameClient.undoFreeAction(gameId, 1);
          GameClient.convertResource(gameId, '3power-to-2ore');
          return;
        }
        if (!needPower(3)) return;
        GameClient.convertResource(gameId, '3power-to-1ore');
        if (hasNevPI) nevlasOreChainRef.current = { expectP3: (p.power3 ?? 0) - 2, expectOre: (p.ore ?? 0) + 1 };
        return;
      case 'credit':
        if (chainValid) {
          // 의회 네뷸라: 직전 2P→1O를 2P→1O+1C로 승격 (추가 소모 없음)
          GameClient.undoFreeAction(gameId, 1);
          GameClient.convertResource(gameId, '2power-to-1ore-1credit');
          return;
        }
        // 타클론 브레인 우선 + 브레인스톤이 3그릇: 1파워(=1C) 대신 브레인스톤(3파워)을 3C로 바꿔 그릇1로 (사용자 요청)
        if (isTak && (p.taklonsBrainPriority ?? true) && !p.brainStoneInGaia && p.brainStoneBowl === 3) {
          GameClient.convertResource(gameId, '1brain-to-3credit');
          return;
        }
        if (!needPower(1)) return;
        GameClient.convertResource(gameId, '1power-to-1credit');
        return;
      case 'knowledge':
        if (!needPower(4)) return;
        GameClient.convertResource(gameId, '4power-to-1knowledge');
        return;
      case 'qic':
        if (p.faction === 'gleens' && !(game.map?.some(t => t.ownerId === playerId && t.structure === 'academy' && t.academyType === 'right'))) {
          toast({ title: '사용 불가', description: '글린은 오른쪽 아카데미가 있어야 QIC 변환이 가능합니다.', variant: 'destructive' });
          return;
        }
        if (!needPower(4)) return;
        GameClient.convertResource(gameId, '4power-to-1qic');
        return;
      case 'bowl1':
        if ((p.ore ?? 0) < 1) { toast({ title: '광물 부족', description: '광물이 1개 필요합니다.', variant: 'destructive' }); return; }
        GameClient.convertResource(gameId, '1ore-to-1token');
        return;
      case 'bowl2': {
        const brainIn2 = isTak && (p as any).brainStoneBowl === 2 && !(p as any).brainStoneInGaia;
        if ((p.power2 ?? 0) < (brainIn2 ? 1 : 2)) { toast({ title: '파워 부족', description: '2그릇에 태울 파워가 부족합니다.', variant: 'destructive' }); return; }
        GameClient.burnPower(gameId);
        return;
      }
      case 'bowl3':
        // 제노스: 1O → 토큰이 3그릇으로 (서버 1ore-to-1token 규칙)
        if ((p.ore ?? 0) < 1) { toast({ title: '광물 부족', description: '광물이 1개 필요합니다.', variant: 'destructive' }); return; }
        GameClient.convertResource(gameId, '1ore-to-1token');
        return;
      case 'baltak-gf': {
        const avail = (p.gaiaformers ?? 0) - ((p as any).balTakGaiaformersUsedForQic ?? 0);
        if (p.faction !== 'bal_tak' || avail < 1) { toast({ title: '사용 불가', description: '사용 가능한 가이아포머가 없습니다.', variant: 'destructive' }); return; }
        GameClient.useBalTakGaiaformerToQic(gameId);
        return;
      }
    }
  };

  /** R창·미니 R·맵에서 트랙 클릭 시: Eclipse 2K+3P / 우주선·고급기술 보상 / 일반 4K 연구 구분 */
  const handleResearchAdvanceTech = (trackId: ResearchTrack, options?: { closeResearchOverlay?: boolean }) => {
    if (!gameId || !playerId) return;

    if (game.pendingEclipseResearch?.playerId === playerId) {
      GameClient.eclipseAdvanceTrack(gameId, trackId);
      if (options?.closeResearchOverlay) setIsResearchOpen(false);
      return;
    }
    if (game.pendingShipTechTrackAdvance?.playerId === playerId) {
      GameClient.advanceTech(gameId, trackId);
      return;
    }
    if (game.pendingAdvancedTechTrackAdvance?.playerId === playerId) {
      GameClient.advanceTech(gameId, trackId);
      return;
    }

    if (game.hasDoneMainAction) return;

    const player = game.players[playerId];
    if (!player) return;

    if (player.pendingTerraformSteps && player.pendingTerraformSteps > 0) {
      toast({
        title: 'Cannot Advance Tech',
        description: 'Terraform action active. Only mine building is allowed.',
        variant: 'destructive',
      });
      return;
    }

    if (player.knowledge < 4) {
      toast({
        title: 'Cannot Advance',
        description: 'Requires 4 Knowledge.',
        variant: 'destructive',
      });
      return;
    }

    if (options?.closeResearchOverlay) setIsResearchOpen(false);
    setAdvanceTechDialog({ open: true, trackId });
  };

  // boardgame.io doesn't always use currentPlayerIndex this way in custom setups, 
  // but we'll follow our server logic.
  const isCurrentTurn = game.turnOrder[game.currentPlayerIndex] === playerId;
  const pendingTurnEndPlayerId = game.pendingTurnEndPlayerId;
  const pendingTurnEndPlayerName = pendingTurnEndPlayerId ? (game.players[pendingTurnEndPlayerId]?.name ?? pendingTurnEndPlayerId) : null;
  const pendingPowerWaiters = (() => {
    const offers = game.pendingPowerOffers?.filter((o) => o && !o.responded) ?? [];
    const byTarget = new Map<string, number>();
    for (const o of offers) {
      byTarget.set(o.targetPlayerId, (byTarget.get(o.targetPlayerId) ?? 0) + 1);
    }
    return Array.from(byTarget.entries()).map(([id, offerCount]) => ({
      id,
      name: game.players[id]?.name ?? id,
      offerCount,
    }));
  })();


  if (game.currentPhase === 'lobby') {
    return (
      <GameLobby
        game={game}
        gameId={gameId!}
        playerId={playerId}
        isSpectator={isSpectator}
        onStartGame={() => GameClient.startGame(gameId!)}
        onLeave={() => {
          if (isSpectator) {
            localStorage.removeItem(`gaia-${gameId}-spectatorId`);
            setLocation('/');
          } else {
            GameClient.leaveGame(gameId!);
            setLocation('/');
          }
        }}
        onAddPlayer={playerId === game.hostId ? async (playerName) => {
          if (!gameId) return;
          const res = await GameClient.hostAddPlayer(gameId, playerName);
          setGame(res.game);
        } : undefined}
        onAddBot={playerId === game.hostId ? async (botName) => {
          if (!gameId) return;
          const res = await GameClient.hostAddBot(gameId, botName);
          setGame(res.game);
        } : undefined}
        onRemovePlayer={playerId === game.hostId ? async (targetPlayerId) => {
          if (!gameId) return;
          try {
            const { game: updated } = await GameClient.removePlayer(gameId, targetPlayerId);
            setGame(updated);
          } catch (e) {
            toast({ title: '삭제 실패', description: (e as Error).message, variant: 'destructive' });
          }
        } : undefined}
        onAutoSetupTest={() => {
          if (gameId) GameClient.autoSetupTest(gameId);
        }}
        onDeleteRoom={playerId === game.hostId ? async () => {
          if (!gameId) return;
          try {
            await GameClient.deleteGame(gameId);
          } catch (e) {
            toast({ title: '삭제 실패', description: (e as Error).message, variant: 'destructive' });
            return;
          }
          setLocation('/');
        } : undefined}
      />
    );
  }

  const GameEndScoreModal = () => {
    if (game.currentPhase !== 'gameEnd') return null;

    const playersWithScores = game.turnOrder
      .map(pid => ({ pid, player: game.players[pid], faction: FACTIONS.find(f => f.id === game.players[pid]?.faction) }))
      .filter(x => x.player)
      .sort((a, b) => (b.player!.score ?? 0) - (a.player!.score ?? 0));

    const getRoundMissionImage = (id: string) => {
      if (!id) return null;
      const numStr = id.replace('rs', '');
      return `/image/RS_${numStr}.gif`;
    };

    const getFinalMissionImage = (missionId: string) => {
      const missionKeys = Object.keys(FINAL_MISSION_LABELS);
      const missionIndex = missionKeys.indexOf(missionId);
      return missionIndex !== -1 ? `/image/EGS_${missionIndex + 1}.jpg` : null;
    };

    const getBonusTileImage = (tileId: string) => {
      const tileIndex = ALL_BONUS_TILES.findIndex(t => t.id === tileId);
      return tileIndex !== -1 ? `/image/BoostTile_${tileIndex + 1}.jpg` : null;
    };

    const getFederationImage = (rewardId: string) => {
      if (rewardId === GLEENS_FEDERATION_REWARD.id) return '/image/Federation_15.gif';
      let rewardIndex = FEDERATION_REWARDS.findIndex(r => r.id === rewardId);
      if (rewardIndex !== -1) return `/image/Federation_${rewardIndex + 1}.gif`;
      rewardIndex = SPACESHIP_FEDERATION_REWARDS.findIndex(r => r.id === rewardId);
      if (rewardIndex !== -1) return `/image/Federation_${rewardIndex + 7}.gif`;
      return null;
    };

    const getTechTileImage = (tileId: string) => {
      const t = ALL_TECH_TILES.find(x => x.id === tileId) || ALL_ADVANCED_TECH_TILES.find(x => x.id === tileId) || (SHIP_TECH_TILES as any[]).find(x => x.id === tileId);
      return t?.image ?? null;
    };

    const getArtifactImage = (artifactId: string) => {
      const idx = ARTIFACTS.findIndex(a => a.id === artifactId);
      return idx !== -1 ? `/image/Art${idx + 1}.png` : null;
    };

    return (
      <AlertDialog open={showGameEndScore} onOpenChange={setShowGameEndScore}>
        <AlertDialogContent className="bg-zinc-950/95 border-zinc-700 w-[92vw] max-w-7xl h-[90vh] max-h-[90vh] overflow-hidden flex flex-col p-0 shadow-2xl shadow-black">
          <AlertDialogHeader className="p-6 pb-2 shrink-0">
            <div className="flex items-center justify-between">
              <AlertDialogTitle className="text-3xl font-black uppercase tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-amber-400 via-yellow-200 to-amber-500 drop-shadow-sm font-orbitron">
                🏆 FINAL VICTORY BOARD
              </AlertDialogTitle>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setShowGameEndScore(false)} className="border-zinc-700 hover:bg-zinc-800 text-zinc-300 font-bold uppercase tracking-widest text-xs h-9">
                  Keep Exploring
                </Button>
                <Button variant="destructive" onClick={() => setLocation('/')} className="font-bold uppercase tracking-widest text-xs h-9 shadow-[0_0_15px_rgba(239,68,68,0.3)]">
                  Exit to Lobby
                </Button>
              </div>
            </div>
          </AlertDialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col p-6 pt-2 custom-scrollbar">
            <Tabs defaultValue={playersWithScores[0]?.pid} className="flex-1 flex flex-col min-h-0">
              <TabsList className="bg-zinc-900/50 p-1 rounded-xl border border-white/5 self-start mb-6">
                {playersWithScores.map(({ pid, player, faction }) => (
                  <TabsTrigger
                    key={pid}
                    value={pid}
                    className="data-[state=active]:bg-zinc-800 data-[state=active]:text-white font-bold py-2 px-6 rounded-lg transition-all"
                    style={{
                      borderBottom: '3px solid transparent',
                      ...(pid === (playersWithScores[0]?.pid) ? {} : {})
                    }}
                  >
                    <div className="flex flex-col items-start gap-0.5">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: faction?.color || '#888' }} />
                        <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-black">{faction?.name || 'Unknown'}</span>
                      </div>
                      <div className="flex items-center gap-1.5 ml-4">
                        <span className="text-sm">{player!.name}</span>
                        <span className="text-xs opacity-50 tabular-nums">{player!.score} VP</span>
                      </div>
                    </div>
                  </TabsTrigger>
                ))}
              </TabsList>

              {playersWithScores.map(({ pid, player, faction }) => {
                const b = player!.scoreBreakdown!;
                const color = faction?.color ?? '#888';
                const roundMissionsSum = b.roundMissions.reduce((s, m) => s + m.vp, 0);
                const bonusTilePassSum = b.bonusTilePass.reduce((s, m) => s + m.vp, 0);
                const techTilesSum = b.techTiles.reduce((s, t) => s + t.vp, 0);
                const spaceshipsSum = b.spaceships.reduce((s, x) => s + x.vp, 0);
                const otherSum = b.other.reduce((s, o) => s + o.vp, 0);
                const remainingResourcesVp = b.remainingResources ?? 0;
                const rawBreakdownTotal = 10 + roundMissionsSum + bonusTilePassSum + techTilesSum + b.finalMissions + b.researchTracks + remainingResourcesVp - b.powerReceived + spaceshipsSum + otherSum;
                const legacyScoreAdjustment = (player!.score ?? 0) - rawBreakdownTotal;
                const breakdownTotal = rawBreakdownTotal + legacyScoreAdjustment;

                return (
                  <TabsContent key={pid} value={pid} className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
                      {/* LH Column: Summary & Full Score Breakdown */}
                      <div className="md:col-span-4 space-y-6">
                        <Card className="bg-zinc-900/40 border-white/5 overflow-hidden">
                          <div className="p-6 space-y-4">
                            <div className="flex flex-col items-center gap-2 text-center">
                              <div className="w-20 h-20 rounded-2xl flex items-center justify-center text-4xl shadow-2xl relative group mb-2" style={{ backgroundColor: `${color}20`, border: `2px solid ${color}40` }}>
                                <span className="drop-shadow-lg group-hover:scale-110 transition-transform">🚀</span>
                                <div className="absolute inset-0 bg-gradient-to-br from-white/10 to-transparent pointer-events-none" />
                              </div>
                              <h3 className="text-2xl font-black text-white uppercase tracking-wider">{player!.name}</h3>
                              <p className="text-zinc-500 font-bold uppercase tracking-widest text-xs" style={{ color: `${color}cc` }}>{faction?.name || 'Unknown Faction'}</p>
                            </div>

                            <div className="pt-4 border-t border-white/5">
                              <div className="flex justify-between items-end mb-1">
                                <span className="text-zinc-500 font-bold uppercase tracking-widest text-[10px]">Total Score</span>
                                <span className="text-4xl font-black tabular-nums text-white drop-shadow-[0_0_10px_rgba(255,255,255,0.2)]">{player!.score} <span className="text-sm font-bold text-zinc-500 tracking-normal uppercase">VP</span></span>
                              </div>
                              {legacyScoreAdjustment !== 0 && (
                                <p className="text-[10px] text-amber-400 mt-1">미분류/레거시 보정 {legacyScoreAdjustment >= 0 ? '+' : ''}{legacyScoreAdjustment} VP 포함</p>
                              )}
                            </div>
                          </div>
                        </Card>

                        {/* 전체 점수 내역 (Breakdown 합계 = Total Score와 일치해야 함) */}
                        <div className="space-y-4">
                          <h4 className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em] px-1">Score Breakdown</h4>
                          <div className="bg-zinc-900/20 rounded-xl border border-white/5 divide-y divide-white/5">
                            <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                              <span className="text-xs font-bold text-zinc-400">Starting Bonus</span>
                              <span className="text-sm font-black text-amber-500/80">+10 VP</span>
                            </div>
                            {roundMissionsSum !== 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">Round Missions</span>
                                <span className="text-sm font-black text-amber-400/90">+{roundMissionsSum} VP</span>
                              </div>
                            )}
                            {bonusTilePassSum !== 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">Bonus Tile Pass</span>
                                <span className="text-sm font-black text-yellow-400/90">+{bonusTilePassSum} VP</span>
                              </div>
                            )}
                            {techTilesSum !== 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">Tech Tiles</span>
                                <span className="text-sm font-black text-purple-400/90">+{techTilesSum} VP</span>
                              </div>
                            )}
                            {b.finalMissions > 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">Final Missions</span>
                                <span className="text-sm font-black text-blue-400/90">+{b.finalMissions} VP</span>
                              </div>
                            )}
                            {b.researchTracks > 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">Research Board End</span>
                                <span className="text-sm font-black text-cyan-400">+{b.researchTracks} VP</span>
                              </div>
                            )}
                            {remainingResourcesVp > 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">남은 자원 (O+C+Q+K) 3당 1 VP</span>
                                <span className="text-sm font-black text-emerald-400/90">+{remainingResourcesVp} VP</span>
                              </div>
                            )}
                            {b.powerReceived > 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-bold text-red-400/80">Power Reception Tax</span>
                                <span className="text-sm font-black text-red-500">−{b.powerReceived} VP</span>
                              </div>
                            )}
                            {spaceshipsSum !== 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">Spaceship Missions</span>
                                <span className="text-sm font-black text-cyan-400/90">+{spaceshipsSum} VP</span>
                              </div>
                            )}
                            {(() => {
                              const grouped = b.other.reduce((acc, curr) => {
                                // 연방 관련 소스("Federation" 영문 또는 "연방" 한글)는 한 줄(Federations 총합)로 묶음
                                const isFederation = curr.source.toLowerCase().includes('federation') || curr.source.includes('연방');
                                const sourceName = isFederation ? 'Federations' : curr.source;

                                const existing = acc.find(item => item.source === sourceName);
                                if (existing) existing.vp += curr.vp;
                                else acc.push({ source: sourceName, vp: curr.vp });
                                return acc;
                              }, [] as { source: string; vp: number }[]);

                              return grouped.map((item, i) => (
                                <div key={i} className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                  <span className="text-xs font-bold text-zinc-400">{item.source}</span>
                                  <span className="text-sm font-black text-zinc-100">{item.vp >= 0 ? '+' : ''}{item.vp} VP</span>
                                </div>
                              ));
                            })()}
                            {legacyScoreAdjustment !== 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-bold text-amber-400/90">미분류/레거시 보정</span>
                                <span className="text-sm font-black text-amber-300">{legacyScoreAdjustment >= 0 ? '+' : ''}{legacyScoreAdjustment} VP</span>
                              </div>
                            )}
                            <div className="p-3 flex justify-between items-center border-t border-white/10 bg-white/[0.02]">
                              <span className="text-xs font-black text-zinc-300 uppercase tracking-wider">Breakdown 합계</span>
                              <span className="text-sm font-black tabular-nums text-white">= {breakdownTotal} VP</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* RH Column: Visual Assets Grid */}
                      <div className="md:col-span-8 space-y-8">
                        {/* Round Missions */}
                        <section>
                          <div className="flex items-center gap-2 mb-4">
                            <Trophy className="w-4 h-4 text-amber-500" />
                            <h4 className="text-xs font-black text-white uppercase tracking-widest">Round Achievements</h4>
                          </div>
                          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                            {game.roundScoringTiles.map((tile, idx) => {
                              const vp = b.roundMissions.filter(m => m.round === idx + 1).reduce((s, m) => s + m.vp, 0);
                              const img = getRoundMissionImage(tile.id);
                              return (
                                <div key={idx} className="flex flex-col items-center gap-2 group">
                                  <div className="relative aspect-[2/3] w-full bg-zinc-900/60 rounded-lg border border-white/5 overflow-hidden shadow-lg group-hover:border-white/20 transition-all">
                                    {img ? (
                                      <img src={img} alt={tile.label} className="w-full h-full object-contain p-1" />
                                    ) : (
                                      <div className="w-full h-full flex items-center justify-center text-[10px] text-zinc-600 font-bold">R{idx + 1}</div>
                                    )}
                                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 pt-4 text-center">
                                      <span className="text-[10px] font-black text-white">ROUND {idx + 1}</span>
                                    </div>
                                  </div>
                                  {vp > 0 && <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 hover:bg-amber-500/30 font-black tabular-nums">+{vp}</Badge>}
                                </div>
                              );
                            })}
                          </div>
                        </section>

                        <div className="flex flex-col gap-8">
                          {/* Bonus Tiles — 한 줄로 쭉 붙여서 (80×128), 위에 단독 배치 */}
                          <section className="min-w-0">
                            <div className="flex items-center gap-2 mb-4">
                              <Star className="w-4 h-4 text-yellow-500" />
                              <h4 className="text-xs font-black text-white uppercase tracking-widest">Bonus Tiles</h4>
                            </div>
                            <div className="flex flex-nowrap gap-1 justify-start">
                              {[1, 2, 3, 4, 5, 6].map((r) => {
                                const passItem = b.bonusTilePass.find(m => m.round === r);
                                const tileId = passItem?.tileId ?? (r === 6 ? player!.bonusTile : undefined);
                                const vp = passItem?.vp ?? 0;
                                const img = tileId ? getBonusTileImage(tileId) : null;
                                return (
                                  <div key={r} className="flex flex-col items-center gap-1 shrink-0 group">
                                    <div className="relative w-20 flex flex-col items-center justify-center rounded-lg border border-white/5 overflow-hidden shadow-lg group-hover:border-yellow-500/30 transition-all bg-zinc-900/60" style={{ height: '128px' }}>
                                      {img ? (
                                        <img src={img} alt={tileId ?? `R${r}`} className="w-full h-full object-contain p-1" />
                                      ) : (
                                        <div className="flex flex-col items-center gap-1">
                                          <Star className="w-4 h-4 text-zinc-700" />
                                          <div className="text-[8px] text-zinc-600 font-black uppercase tracking-tighter">{'R' + r}</div>
                                        </div>
                                      )}
                                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1 text-center">
                                        <span className="text-[8px] font-black text-white">{'R' + r}</span>
                                      </div>
                                    </div>
                                    {vp > 0 && <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 hover:bg-yellow-500/30 font-black tabular-nums mt-1">+{vp}</Badge>}
                                  </div>
                                );
                              })}
                            </div>
                          </section>

                          {/* Final Missions — 이미지 2장 작은 크기(144×108), 우측 하단에 점수만 */}
                          <section className="min-w-0">
                            <div className="flex items-center gap-2 mb-4">
                              <Flag className="w-4 h-4 text-blue-500" />
                              <h4 className="text-xs font-black text-white uppercase tracking-widest">Endgame Missions</h4>
                            </div>
                            <div className="flex flex-col gap-3">
                              {(game.finalMissionIds ?? []).map((mid) => {
                                const img = getFinalMissionImage(mid);
                                const label = FINAL_MISSION_LABELS[mid] ?? mid;
                                const ranking = game.turnOrder.map((p) => ({
                                  rid: p,
                                  value: getFinalMissionValue(game, p, mid),
                                  vp: getFinalMissionVp(game, p, mid),
                                  name: game.players[p]?.name ?? p,
                                  color: FACTIONS.find(f => f.id === game.players[p]?.faction)?.color ?? '#888',
                                })).sort((a, b) => b.value - a.value || b.vp - a.vp);
                                return (
                                  <div key={mid} className="flex items-center gap-3 bg-zinc-900/40 rounded-lg border border-white/5 p-2 shadow-lg">
                                    {/* 미션 이미지 (작게) + 이름 오버레이 */}
                                    <div className="relative w-24 h-[72px] shrink-0 rounded-md overflow-hidden border border-white/5 bg-black/40">
                                      {img ? (
                                        <img src={img} alt={mid} className="w-full h-full object-cover" />
                                      ) : (
                                        <div className="w-full h-full flex items-center justify-center text-[9px] text-zinc-600 text-center px-1">{label}</div>
                                      )}
                                    </div>
                                    {/* 순위대로 4명 + 내 행 강조 */}
                                    <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
                                      {ranking.map((r, ri) => {
                                        const isMe = r.rid === pid;
                                        return (
                                          <div key={r.rid} className={`flex items-center gap-2 px-2 py-0.5 rounded ${isMe ? 'bg-blue-500/10 ring-1 ring-blue-400/60' : ''}`}>
                                            <span className="text-[10px] font-black text-zinc-500 w-3 shrink-0 tabular-nums">{ri + 1}</span>
                                            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                                            <span className={`text-xs truncate flex-1 min-w-0 ${isMe ? 'font-black text-white' : 'font-bold text-zinc-300'}`}>{r.name}</span>
                                            <span className="text-sm font-black text-white tabular-nums shrink-0" title="미션 달성 수치">{r.value}</span>
                                            {r.vp > 0 && <span className="text-sm font-black tabular-nums shrink-0 text-blue-400 w-8 text-right">+{r.vp}</span>}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            <div className="mt-2 text-right">
                              <span className="text-[10px] font-bold text-zinc-500 mr-2 uppercase">Subtotal:</span>
                              <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 font-black">+{b.finalMissions} VP</Badge>
                            </div>
                          </section>
                        </div>

                        {/* Technology and Federations */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                          {/* Tech Tiles Grid */}
                          <section>
                            <div className="flex items-center gap-2 mb-4">
                              <FlaskConical className="w-4 h-4 text-purple-500" />
                              <h4 className="text-xs font-black text-white uppercase tracking-widest">Technology Portfolio</h4>
                            </div>
                            <div className="grid grid-cols-4 gap-2">
                              {(() => {
                                const grouped = b.techTiles.reduce((acc, curr) => {
                                  const existing = acc.find(t => t.tileId === curr.tileId);
                                  if (existing) existing.vp += curr.vp;
                                  else acc.push({ ...curr });
                                  return acc;
                                }, [] as { tileId: string; vp: number }[]);

                                return grouped.map(({ tileId, vp }, i) => {
                                  const img = getTechTileImage(tileId);
                                  return (
                                    <div key={i} className="flex flex-col items-center gap-1 group">
                                      <div className="w-full aspect-[4/3] bg-zinc-900 border border-white/5 rounded-lg overflow-hidden flex items-center justify-center p-1 group-hover:border-purple-500/50 transition-colors">
                                        {img ? (
                                          <img src={img} alt={tileId} className="w-full h-full object-contain" />
                                        ) : (
                                          <span className="text-[8px] text-zinc-600 text-center">{tileId}</span>
                                        )}
                                      </div>
                                      <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 hover:bg-purple-500/30 font-black tabular-nums mt-1">+{vp}</Badge>
                                    </div>
                                  );
                                });
                              })()}
                              {b.techTiles.length === 0 && (
                                <div className="col-span-4 h-16 flex items-center justify-center text-[10px] text-zinc-600 italic">No technology tokens acquired.</div>
                              )}
                            </div>
                          </section>

                          {/* Federations — Tactical Overview 비슷한 컴팩트 크기(64×64) */}
                          <section>
                            <div className="flex items-center gap-2 mb-4">
                              <Shield className="w-4 h-4 text-emerald-500" />
                              <h4 className="text-xs font-black text-white uppercase tracking-widest">Established Federations</h4>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {(player!.federations ?? []).map((fed, i) => {
                                const img = getFederationImage(typeof fed === 'string' ? fed : fed.rewardId);
                                const rid = typeof fed === 'string' ? fed : fed.rewardId;
                                const allRewards = [...FEDERATION_REWARDS, ...SPACESHIP_FEDERATION_REWARDS, GLEENS_FEDERATION_REWARD] as any[];
                                const vp = allRewards.find(r => r.id === rid)?.vp || 0;
                                return (
                                  <div key={i} className="flex flex-col items-center gap-1 group">
                                    <div className="w-16 h-16 bg-zinc-900 border border-white/5 rounded-xl overflow-hidden flex items-center justify-center p-1 group-hover:border-emerald-500/50 transition-colors shrink-0">
                                      {img ? (
                                        <img src={img} alt={rid} className="w-full h-full object-contain" />
                                      ) : (
                                        <span className="text-[8px] text-zinc-600 text-center">{rid}</span>
                                      )}
                                    </div>
                                    <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/30 font-black tabular-nums mt-1">+{vp}</Badge>
                                  </div>
                                );
                              })}
                              {(!player!.federations || player!.federations.length === 0) && (
                                <div className="h-16 flex items-center justify-center text-[10px] text-zinc-600 italic">No federations established.</div>
                              )}
                            </div>
                          </section>

                          {/* 인공물 (트왈라잇): 이미지 + 점수 표시 */}
                          {(player!.artifacts?.length ?? 0) > 0 && (
                            <section>
                              <div className="flex items-center gap-2 mb-4">
                                <span className="text-amber-400 font-black text-xs uppercase tracking-widest">Artifacts</span>
                              </div>
                              <div className="grid grid-cols-4 gap-2">
                                {(player!.artifacts ?? []).map((aid, i) => {
                                  const img = getArtifactImage(aid);
                                  const label = ARTIFACTS.find(a => a.id === aid)?.label ?? aid;
                                  return (
                                    <div key={i} className="flex flex-col items-center gap-1 group">
                                      <div className="w-full aspect-square bg-zinc-900 border border-amber-500/20 rounded-xl overflow-hidden flex items-center justify-center p-1 group-hover:border-amber-500/50 transition-colors">
                                        {img ? (
                                          <img src={img} alt={label} className="w-full h-full object-contain" title={label} />
                                        ) : (
                                          <span className="text-[8px] text-zinc-600 text-center truncate px-1">{label}</span>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                              {b.other.some(o => o.source.startsWith('Artifact:')) && (
                                <div className="mt-1 text-right">
                                  <span className="text-[10px] font-bold text-zinc-500 mr-2 uppercase">Artifact VP:</span>
                                  <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 font-black">
                                    +{b.other.filter(o => o.source.startsWith('Artifact:')).reduce((s, o) => s + o.vp, 0)} VP
                                  </Badge>
                                </div>
                              )}
                            </section>
                          )}
                        </div>

                        {/* Special Extras: Spaceships & Proto */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
                          {b.spaceships.length > 0 && (
                            <section>
                              <div className="flex items-center gap-2 mb-4">
                                <Ship className="w-4 h-4 text-cyan-500" />
                                <h4 className="text-xs font-black text-white uppercase tracking-widest">Spaceship Missions</h4>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {(() => {
                                  // 우주선별 액션 스트립 이미지(가로 3칸). 액션 1회 사용 = 해당 액션 1/3 슬라이스 + 점수 한 장.
                                  const SHIP_ACTION_IMG: Record<string, string> = {
                                    ship_twilight: '/image/ActionTwilight.jpg',
                                    ship_rebellion: '/image/ActionRebellion.jpg',
                                    ship_tf_mars: '/image/ActionTFMars.jpg',
                                    ship_eclipse: '/image/ActionEclipse.jpg',
                                  };
                                  return b.spaceships.map((entry, i) => {
                                    const img = entry.shipType ? SHIP_ACTION_IMG[entry.shipType] : undefined;
                                    const thirdIdx = Math.min(2, Math.max(0, (entry.actionIndex ?? 1) - 1)); // 0|1|2
                                    return (
                                      <div key={i} className="flex flex-col items-center gap-1 group">
                                        {img ? (
                                          <div
                                            className="w-16 h-16 rounded-lg border border-cyan-500/30 overflow-hidden group-hover:border-cyan-400/60 transition-colors"
                                            style={{
                                              backgroundImage: `url(${img})`,
                                              backgroundSize: '300% 100%',
                                              backgroundPosition: `${thirdIdx * 50}% center`,
                                              backgroundRepeat: 'no-repeat',
                                            }}
                                            title={`${entry.shipTileId || 'Spaceship'} · +${entry.vp} VP`}
                                          />
                                        ) : (
                                          <div className="w-16 h-16 rounded-lg border border-white/5 bg-zinc-900/40 flex items-center justify-center text-[8px] text-zinc-500 text-center px-1">
                                            {entry.shipTileId || 'Spaceship'}
                                          </div>
                                        )}
                                        <Badge className="bg-cyan-500/20 text-cyan-400 border-cyan-500/30 h-5 px-1.5 font-black tabular-nums">+{entry.vp}</Badge>
                                      </div>
                                    );
                                  });
                                })()}
                              </div>
                            </section>
                          )}

                          {/* Proto Planet highlight if achieved */}
                          {b.other.some(o => o.source === 'Proto Planet') && (
                            <section>
                              <div className="flex items-center gap-2 mb-4">
                                <Mountain className="w-4 h-4 text-cyan-300" />
                                <h4 className="text-xs font-black text-white uppercase tracking-widest">Scientific Milestone</h4>
                              </div>
                              <Card className="bg-gradient-to-br from-cyan-900/20 to-blue-900/20 border-cyan-800/30 overflow-hidden shadow-lg shadow-cyan-950/20">
                                <div className="p-4 flex items-center gap-4">
                                  <div className="w-12 h-12 bg-black/40 rounded-lg flex items-center justify-center p-1 border border-cyan-400/20">
                                    <img src="/map/ts_111.png" alt="Proto Planet" className="w-full h-full object-contain" />
                                  </div>
                                  <div>
                                    <div className="text-[10px] font-black text-cyan-300 tracking-widest uppercase">Proto Planet Colonized</div>
                                    <div className="text-sm font-black text-white">+6 VP <span className="text-[10px] font-bold text-zinc-500">(3 Terraforming)</span></div>
                                  </div>
                                </div>
                              </Card>
                            </section>
                          )}
                        </div>
                      </div>
                    </div>
                  </TabsContent>
                );
              })}
            </Tabs>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    );
  };

  // Starting Mines Phase - 게임 화면 표시하고 종족 선택 UI 포함
  if (game.currentPhase === 'startingMines') {
    const currentPlayer = playerId ? game.players[playerId] : null;
    const needsFactionSelection = !currentPlayer?.faction;

    // 게임 화면을 먼저 표시하고, 종족이 없으면 오버레이로 종족 선택
    // (아래 main 게임 화면 코드로 계속하되, 종족 선택 오버레이 추가)
  }

  if (game.currentPhase === 'factionSelect') {
    // 집 배치 후 모든 플레이어가 종족을 선택했는지 확인
    // 게임 화면을 표시하고 종족 선택 오버레이 추가
    const currentPlayer = playerId ? game.players[playerId] : null;
    const needsFactionSelection = !currentPlayer?.faction;

    // 게임 화면 표시 (아래 main 게임 화면 코드로 계속하되, 종족 선택 오버레이 추가)
  }

  // Bonus Selection Phase: 메인 레이아웃(맵+사이드바) 유지, 하단에 접었다 펼칠 수 있는 패널로 표시
  const isBonusSelectionPhase = game.currentPhase === 'bonusSelection';
  const isMyTurnBonusSelection = isBonusSelectionPhase && game.pendingBonusSelection === playerId;
  const waitingPlayerBonus = game.pendingBonusSelection ? game.players[game.pendingBonusSelection] : null;

  /** 플레이어별 맵에서 건물 개수 (다른 플레이어 UI용, 광산은 잊혀진 행성·기생·가상 포함) */
  const getStructureCountsForPlayer = (g: GameState, pid: string) => {
    const owned = (g.map ?? []).filter((t: { ownerId: string | null }) => t.ownerId === pid);
    // M x/8 표시용: 실제 '광산 토큰'을 쓰는 것만(보드 광산 + 란티다 기생광산).
    // 잊혀진 행성(Nav5)·가상 광산(인공물)은 별도 토큰이라 한도/표시에서 제외.
    const physicalMineCount = owned.filter((t: { structure: string | null }) => t.structure === 'mine').length
      + (g.map ?? []).filter((t: { parasiticMine?: { ownerId: string } }) => t.parasiticMine?.ownerId === pid).length;
    const lostPlanetCount = owned.filter((t: { structure: string | null }) => t.structure === 'lost_planet_mine').length;
    const virtualMineCount = (g.players[pid]?.virtualMineAsteroid ? 1 : 0) + (g.players[pid]?.virtualMineProto ? 1 : 0);
    // 점수/패스 보너스(광산당 VP)용: 잊혀진 행성·가상 광산 포함(서버 getMineCountForPassAndBonuses와 일치).
    const mineCount = physicalMineCount + lostPlanetCount + virtualMineCount;
    const tsCount = owned.filter((t: { structure: string | null }) => t.structure === 'trading_station').length;
    const labCount = owned.filter((t: { structure: string | null }) => t.structure === 'research_lab').length;
    const piCount = owned.filter((t: { structure: string | null }) => t.structure === 'planetary_institute').length;
    const academyLeft = owned.filter((t: { structure: string | null; academyType?: string }) => t.structure === 'academy' && (t.academyType === 'left' || t.academyType == null)).length;
    const academyRight = owned.filter((t: { structure: string | null; academyType?: string }) => t.structure === 'academy' && t.academyType === 'right').length;
    return { mineCount, physicalMineCount, tsCount, labCount, piCount, academyLeft, academyRight };
  };

  const getActionCost = (action: PotentialAction) => {
    if (!game || !playerId) return null;
    const player = game.players[playerId];
    const faction = FACTIONS.find(f => f.id === player.faction);
    if (!faction) return null;

    switch (action.type) {
      case 'buildMine': {
        const tile = game.map.find(t => t.id === action.tileId);
        if (!tile) return null;
        const baseRange = getEffectiveBaseRange(player);
        const rangeTiles = game.map.filter(t => (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') || t.spaceStation?.ownerId === playerId || t.parasiticMine?.ownerId === playerId);
        const minDist = rangeTiles.length > 0 ? Math.min(...rangeTiles.map(t => getDistance(t, tile))) : 0;
        const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
        const freeMine = !!player.nextMineFreeFromShipTech || !!player.spaceshipFed3TfMineFree;
        let oreCost = freeMine ? 0 : 1;
        let credits = freeMine ? 0 : 2;
        let qicCost = neededQIC;

        // 란티다 기생 광산 체크: 테라포밍 비용 없음
        const isLantidaParasitic = player.faction === 'lantids' &&
          tile.structure !== null &&
          tile.ownerId !== playerId &&
          tile.ownerId != null &&
          !tile.parasiticMine;

        if (isLantidaParasitic) {
          return { ore: 1, credits: 2, qic: qicCost, terraformSteps: 0 };
        }

        const terraformingLevel = player.research.terraforming || 0;
        let terraformSteps = 0;
        let needsExtraTerraforming = false;

        if (tile.type === 'gaia') {
          // 포머 설치된 곳(내 포머가 회수 대기 중)은 거리 QIC 및 기본 Gaia QIC 모두 면제
          // (포머 배치 시 거리 QIC를 이미 지불했음)
          if (tile.hasGaiaformer && player.pendingGaiaformerTiles?.includes(tile.id)) {
            qicCost = 0;
          }
          else if (faction.id === 'gleens') {
            oreCost += 1;
          } else {
            qicCost += getGaiaBaseQic(faction.id);
          }
        } else {
          if (tile.type === 'proto' && faction.homePlanet === 'proto') {
            oreCost = freeMine ? 0 : 1;
          } else if (tile.type === 'asteroid') {
            // 소행성은 가이아 포머만 사용 (비용 0, QIC만 필요 시 사용)
            oreCost = 0;
            credits = 0;
            // 테라포밍 비용 없음
            // 가이아 포머 정보는 별도로 처리
          } else if (tile.type === 'space' || tile.type === 'deep_space' || tile.type.includes('ship')) {
            return null;
          } else {
            // Proto + 일반 행성 (확장 4종족 규칙 반영)
            terraformSteps = getTerraformStepsForFaction(game, faction.id, tile.type as PlanetType);
            const pendingTerraformSteps = player.pendingTerraformSteps || 0;
            const discountSteps = Math.min(pendingTerraformSteps, terraformSteps);
            const actualSteps = terraformSteps - discountSteps;
            const terraformCostPerStep = getTerraformCost(terraformingLevel);
            // 광산 자체는 무료일 수 있으나 테라포밍 비용은 discountSteps 차감 후 남은 단계만큼 지불해야 함
            // spaceshipFed3TfMineFree인 경우 서버 로직에서 비용을 0으로 처리하므로 클라이언트도 동일하게 맞춤
            const terraformOreCost = player.spaceshipFed3TfMineFree ? 0 : actualSteps * terraformCostPerStep;
            oreCost += terraformOreCost;
            if (actualSteps > 0 && terraformingLevel < 3 && actualSteps > 1) {
              needsExtraTerraforming = true;
            }
          }
        }
        const pendingTerraformSteps = player.pendingTerraformSteps || 0;
        const discountSteps = Math.min(pendingTerraformSteps, terraformSteps);

        // 소행성의 경우 가이아 포머 정보 추가
        const isAsteroid = tile.type === 'asteroid';
        return {
          ore: oreCost,
          credits: isAsteroid ? 0 : credits,
          qic: qicCost,
          terraformSteps,
          terraformingLevel,
          needsExtraTerraforming,
          terraformDiscount: discountSteps,
          gaiaformers: isAsteroid ? 1 : undefined, // 소행성일 때 가이아 포머 1개 필요
        };
      }
      case 'upgrade': {
        const tile = game.map.find(t => t.id === action.tileId);
        if (!tile || !tile.structure) return null;
        if (tile.structure === 'mine' && action.target === 'trading_station') {
          const discount = playerId && hasNearbyPlayersForTradingDiscount(game.map, tile, playerId);
          return { ore: 2, credits: discount ? 3 : 6 };
        }
        if (tile.structure === 'trading_station' && action.target === 'research_lab') return { ore: 3, credits: 5 };
        if (tile.structure === 'trading_station' && action.target === 'planetary_institute') return { ore: 4, credits: 6 };
        // 매안(Bescods) 전용: 연구소 → 의회 (교역소가 아니라 연구소에서 PI를 짓는 경로)
        if (tile.structure === 'research_lab' && action.target === 'planetary_institute') return { ore: 4, credits: 6 };
        if (tile.structure === 'research_lab' && (action.target === 'academy' || action.target === 'academy_left' || action.target === 'academy_right')) return { ore: 6, credits: 6 };
        // 매안(Bescods) 전용: 교역소 → 아카데미 (일반 진영은 연구소→아카데미)
        if (tile.structure === 'trading_station' && (action.target === 'academy' || action.target === 'academy_left' || action.target === 'academy_right')) return { ore: 6, credits: 6 };
        return null;
      }
      case 'advanceTech': return { knowledge: 4 };
      default: return null;
    }
  };

  const cost = pendingAction ? getActionCost(pendingAction) : null;

  const isHost = (game && playerId === game.hostId) || isHostSessionRef.current;
  const selectedBotAction = selectedAiFeedbackActionId
    ? game?.botActionsForFeedback?.find((a) => a.id === selectedAiFeedbackActionId) ?? game?.lastBotActionForFeedback
    : game?.lastBotActionForFeedback;
  const selectedBotActionLabel = selectedBotAction
    ? `${selectedBotAction.playerName}: ${selectedBotAction.actionType}${selectedBotAction.params ? ` ${JSON.stringify(selectedBotAction.params)}` : ''}`
    : '';

  const submitAiFeedback = async () => {
    if (!gameId || !selectedBotAction) return;
    const reason = aiFeedbackReason.trim();
    const expertMove = aiFeedbackExpertMove.trim();
    if (!reason && !expertMove) {
      toast({ title: '메모 필요', description: '추천 수나 이유 중 하나는 남겨주세요.', variant: 'destructive' });
      return;
    }
    setAiFeedbackSubmitting(true);
    try {
      await GameClient.submitAiFeedback(gameId, {
        actionId: selectedBotAction.id,
        rating: aiFeedbackRating,
        expertMove,
        reason,
      });
      toast({ title: 'AI 피드백 저장됨', description: 'server/ai/expertFeedback.jsonl에 기록했습니다.' });
      setAiFeedbackOpen(false);
      setAiFeedbackExpertMove('');
      setAiFeedbackReason('');
      setAiFeedbackRating('bad');
      setSelectedAiFeedbackActionId(null);
    } catch (err: any) {
      toast({ title: '저장 실패', description: err?.message || 'AI 피드백 저장에 실패했습니다.', variant: 'destructive' });
    } finally {
      setAiFeedbackSubmitting(false);
    }
  };

  const openAiFeedbackForAction = (actionId: string) => {
    setSelectedAiFeedbackActionId(actionId);
    setAiFeedbackOpen(true);
  };

  return (
    // h-screen(100vh)은 모바일에서 실제 가시 높이보다 커서 하단 버튼이 밀리고 페이지가 스크롤됨 → 100dvh로 고정
    <div className="flex h-[100dvh] overflow-hidden bg-background font-sans text-foreground relative">
      {/* [임시] 클릭 지점 요소 진단 오버레이 — 우측 맵 클릭 안 되는 원인 파악용. 진단 후 제거. */}
      <ClickDebugOverlay />
      {/* 관전자 표시: 전체 상단을 덮지 않도록 작은 플로팅 배지로만 표시 */}
      {isSpectator && typeof document !== 'undefined' && createPortal(
        <div className="fixed left-3 bottom-3 z-[120] rounded-full border border-amber-300/40 bg-zinc-950/85 px-3 py-1.5 text-amber-200 text-xs font-bold flex items-center gap-2 shadow-lg backdrop-blur-md">
          <Eye className="w-3.5 h-3.5 shrink-0" />
          <span>관전 중</span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 rounded-full border-amber-300/30 bg-amber-300/10 px-2 text-[10px] font-bold text-amber-100 hover:bg-amber-300/20 hover:text-white"
            onClick={() => {
              if (gameId) localStorage.removeItem(`gaia-${gameId}-spectatorId`);
              setLocation('/');
            }}
          >
            나가기
          </Button>
        </div>,
        document.body
      )}

      <AlertDialog open={aiFeedbackOpen} onOpenChange={setAiFeedbackOpen}>
        <AlertDialogContent className="bg-zinc-950 border-zinc-700 max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-white font-black">AI 수 평가 남기기</AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              마지막 봇 액션과 현재 상태 요약이 함께 저장됩니다. 나중에 후보 생성/평가 함수 개선에 사용합니다.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3">
            <div className="rounded-lg border border-white/10 bg-zinc-900/80 p-2 text-xs text-zinc-300">
              <div className="text-cyan-300 font-bold mb-1">대상 수</div>
              <div className="break-words">{selectedBotActionLabel || '평가할 AI 수를 로그에서 선택하세요.'}</div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {([
                ['bad', '나쁜 수'],
                ['questionable', '애매함'],
                ['good', '좋은 수'],
              ] as const).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant={aiFeedbackRating === value ? 'default' : 'outline'}
                  className={aiFeedbackRating === value ? 'bg-cyan-600 hover:bg-cyan-500 text-white' : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'}
                  onClick={() => setAiFeedbackRating(value)}
                >
                  {label}
                </Button>
              ))}
            </div>

            <div>
              <label className="text-xs font-bold text-zinc-300">더 좋은 수 / 추천 방향</label>
              <Textarea
                value={aiFeedbackExpertMove}
                onChange={(e) => setAiFeedbackExpertMove(e.target.value)}
                placeholder="예: 경제 4단계, 2O 파워 액션 후 연방 준비, 이 보너스 타일 패스 등"
                className="mt-1 min-h-[72px] bg-zinc-900 border-zinc-700 text-zinc-100"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-zinc-300">이유 / 고수 판단 근거</label>
              <Textarea
                value={aiFeedbackReason}
                onChange={(e) => setAiFeedbackReason(e.target.value)}
                placeholder="왜 나쁜지, 어떤 목표/타이밍/상대 상황 때문에 다른 수가 좋은지 적어주세요."
                className="mt-1 min-h-[110px] bg-zinc-900 border-zinc-700 text-zinc-100"
              />
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel className="bg-zinc-900 border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-white">
              취소
            </AlertDialogCancel>
            <Button
              className="bg-cyan-600 hover:bg-cyan-500 text-white font-black"
              disabled={aiFeedbackSubmitting || !selectedBotAction}
              onClick={submitAiFeedback}
            >
              {aiFeedbackSubmitting ? '저장 중...' : '저장'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Sidebar Overlay (Left) */}
      <div className="absolute left-0 top-0 bottom-0 w-64 md:w-80 transition-all duration-300 flex flex-col z-[50] pointer-events-none *:pointer-events-auto">
        {/* 상단 툴바: 미니뷰 토글 및 (방장 전용) 플레이어 전환 */}
        <div className="p-2 border-border space-y-2 md:bg-transparent backdrop-blur-sm md:backdrop-blur-none block w-full max-w-full relative z-[110]">
          {pendingTurnEndPlayerName && pendingPowerWaiters.length > 0 && (
            <div className="bg-amber-500/20 border border-amber-400/40 text-amber-100 rounded-lg px-3 py-2 text-xs md:text-sm">
              <div className="flex items-start gap-2">
                <Clock className="w-4 h-4 shrink-0 text-amber-300 mt-0.5 animate-pulse" />
                <p className="leading-snug">
                  <strong>{pendingTurnEndPlayerName}</strong> 턴 · 파워 수락 대기 중
                  <span className="block text-[10px] text-amber-200/75 font-medium mt-0.5">
                    아래 플레이어가 모두 응답하면 다음 턴으로 넘어갑니다
                  </span>
                </p>
              </div>
              <ul className="mt-2 space-y-1 border-l-2 border-amber-400/35 pl-2.5">
                <AnimatePresence mode="popLayout">
                  {pendingPowerWaiters.map((w) => (
                    <motion.li
                      key={w.id}
                      layout
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                      className="flex items-center gap-2 overflow-hidden"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 animate-pulse" />
                      <span className="font-bold text-amber-50 truncate">{w.name}</span>
                      {w.id === playerId && (
                        <Badge variant="outline" className="h-4 px-1 text-[9px] border-amber-400/50 text-amber-200 shrink-0">
                          나
                        </Badge>
                      )}
                      {w.offerCount > 1 && (
                        <span className="text-[10px] text-amber-300/70 shrink-0">제안 {w.offerCount}건</span>
                      )}
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </div>
          )}
          <div className="flex gap-1 items-end bg-black/80 rounded-lg p-1 md:p-0 md:bg-transparent shadow-xl md:shadow-none">
            {/* 방장 전용: 한 컴퓨터 4인플 시 조작 플레이어 전환 */}
            {!isSpectator && isHost && game && game.turnOrder.length > 1 && (
              <div className="flex-1 space-y-1">
                <label className="text-xs text-muted-foreground flex items-center gap-1">
                  <Gamepad2 className="w-3.5 h-3.5" />
                  <span className="hidden md:inline">조작할 플레이어 & 보드 고정</span>
                </label>
                <Select
                  value={playerId ?? ''}
                  onValueChange={async (id) => {
                    if (!gameId || id === playerId) return;
                    try {
                      const { game: updated } = await GameClient.switchPlayer(gameId, id);
                      setGame(updated);
                      setPlayerId(id);
                      storePlayerId(gameId, id);
                    } catch (e: any) {
                      toast({ title: '전환 실패', description: e?.message, variant: 'destructive' });
                    }
                  }}
                >
                  <SelectTrigger className="h-9 text-xs w-full">
                    <SelectValue placeholder="플레이어 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {game.turnOrder.filter(id => id === game.hostId || game.hostAddedPlayerIds?.includes(id)).map((id) => {
                      const p = game.players[id];
                      return (
                        <SelectItem key={id} value={id} className="text-xs">
                          {p?.name ?? id} {id === game.hostId ? '(Host)' : ''}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0 text-purple-600 hover:text-purple-700 hover:bg-purple-100 dark:text-purple-400 dark:hover:bg-purple-900/50"
                onClick={() => {
                  const newVal = !(isResearchPinned && isBonusPinned);
                  setIsResearchPinned(newVal);
                  setIsBonusPinned(newVal);
                  if (gameId) {
                    localStorage.setItem(`is-research-pinned-${gameId}`, String(newVal));
                    localStorage.setItem(`is-bonus-pinned-${gameId}`, String(newVal));
                  }
                }}
                title="모든 미니보드 켜기/끄기 (Toggle All Mini Boards)"
              >
                <Layers className="w-4 h-4" />
              </Button>
              <Button
                variant={isResearchPinned ? 'default' : 'outline'}
                size="icon"
                className={`h-9 w-9 shrink-0 ${isResearchPinned ? 'bg-blue-600 hover:bg-blue-500' : ''}`}
                onClick={() => {
                  const newVal = !isResearchPinned;
                  setIsResearchPinned(newVal);
                  if (gameId) localStorage.setItem(`is-research-pinned-${gameId}`, String(newVal));
                }}
                title="연구 보드 고정 (Research Board Pin)"
              >
                <FlaskConical className="w-4 h-4" />
              </Button>
              <Button
                variant={isBonusPinned ? 'default' : 'outline'}
                size="icon"
                className={`h-9 w-9 shrink-0 ${isBonusPinned ? 'bg-amber-600 hover:bg-amber-500' : ''}`}
                onClick={() => {
                  const newVal = !isBonusPinned;
                  setIsBonusPinned(newVal);
                  if (gameId) localStorage.setItem(`is-bonus-pinned-${gameId}`, String(newVal));
                }}
                title="보너스 타일 고정 (Bonus Tiles Pin)"
              >
                <Gift className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Game End: Show Score Button */}
        {game.currentPhase === 'gameEnd' && (
          <div className="p-2 md:p-4 border-t border-border mt-auto block bg-black/80 md:bg-transparent backdrop-blur-sm md:backdrop-blur-none w-full max-w-full">
            <Button
              className="w-full bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs md:text-sm"
              onClick={() => setShowGameEndScore(true)}
            >
              <Trophy className="w-4 h-4 md:hidden" />
              <span className="hidden md:inline">🏆 최종 점수 보기 (Final Score)</span>
            </Button>
          </div>
        )}
        <div className="mt-auto flex flex-col justify-end pointer-events-none">

        {/* 왼쪽 하단 액션 버튼 토글 */}
        <div className="pointer-events-auto p-2 md:hidden bg-zinc-950/80 backdrop-blur w-fit rounded-tr-xl relative z-[100] mt-auto">
          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10 rounded-full bg-zinc-900 border-zinc-700 shadow-xl"
            onClick={() => setIsLeftPanelOpen(!isLeftPanelOpen)}
          >
            {isLeftPanelOpen ? <span className="text-xl">×</span> : <ChevronRight className="w-5 h-5" />}
          </Button>
        </div>

        <div className={`p-2 md:p-4 md:mt-0 space-y-2 pointer-events-none *:pointer-events-auto bg-black/80 md:bg-transparent backdrop-blur-sm md:backdrop-blur-none ${isLeftPanelOpen ? 'block' : 'hidden md:block'} w-full max-w-full rounded-tr-lg relative z-[100]`}>
          {(() => {
            const canUseFreeActions = isCurrentTurn && game?.currentPhase === 'main';
            return (
              <Button
                variant={isFreeActionsOpen ? 'default' : 'outline'}
                className="w-full justify-start md:justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95 border-purple-500/40 text-purple-300 hover:bg-purple-500/20 disabled:opacity-30"
                disabled={!canUseFreeActions}
                onClick={() => {
                  if (canUseFreeActions) setIsFreeActionsOpen(!isFreeActionsOpen);
                }}
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="h-5 w-5 p-0 flex items-center justify-center bg-purple-500/30 border-purple-500/50 text-[8px]">F</Badge>
                  <span className="md:inline">Free Actions</span>
                </div>
                <span className="hidden md:inline">{isFreeActionsOpen ? 'Close' : 'Open'}</span>
              </Button>
            );
          })()}
          <Button
            variant={isBonusTilesOpen ? 'default' : 'outline'}
            className="w-full justify-start md:justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95"
            onClick={() => {
              setIsBonusTilesOpen(!isBonusTilesOpen);
              setIsResearchOpen(false);
            }}
          >
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="h-5 w-5 p-0 flex items-center justify-center bg-black/50 border-white/20 text-[8px]">T</Badge>
              <span className="md:inline">Tactical Overview</span>
            </div>
            <span className="hidden md:inline">{isBonusTilesOpen ? 'Close' : 'Open'}</span>
          </Button>
          <Button
            variant={isResearchOpen ? 'default' : 'outline'}
            className="w-full justify-start md:justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95"
            onClick={() => {
              setIsResearchOpen(!isResearchOpen);
              setIsBonusTilesOpen(false);
            }}
          >
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="h-5 w-5 p-0 flex items-center justify-center bg-black/50 border-white/20 text-[8px]">R</Badge>
              <span className="md:inline">Research Board</span>
            </div>
            <span className="hidden md:inline">{isResearchOpen ? 'Close' : 'Open'}</span>
          </Button>
          {/* 아카데미(오른쪽) 보유 시: QIC 받기 (Special) */}
          {game?.currentPhase === 'main' && game.turnOrder?.[game.currentPlayerIndex] === playerId && !currentPlayer?.usedSpecialActions?.includes('academy-qic') && game?.map?.some((t: { ownerId: string | null; structure: string | null; academyType?: string }) => t.ownerId === playerId && t.structure === 'academy' && t.academyType === 'right') && (
            <Button
              variant="outline"
              className="w-full justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95 border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/20"
              onClick={() => {
                if (game.hasDoneMainAction) return;
                GameClient.useSpecialAction(gameId!, 'academy-qic');
              }}
            >
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-5 w-5 p-0 flex items-center justify-center bg-cyan-500/30 border-cyan-500/50 text-[8px]">S</Badge>
                {currentPlayer?.faction === 'bal_tak' ? '아카데미 (4C)' : '아카데미 QIC'}
              </div>
              Special
            </Button>
          )}
          {/* 하이브 전용: 우주정거장 놓기 (Special) — 클릭 시 모달 + 배치 모드 */}
          {game?.currentPhase === 'main' && game.turnOrder?.[game.currentPlayerIndex] === playerId && !game.hasDoneMainAction && currentPlayer?.faction === 'ivits' && !currentPlayer.usedIvitsSpaceStationThisRound && (
            <Button
              variant={ivitsSpaceStationMode ? 'default' : 'outline'}
              className="w-full justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95 border-amber-500/40 text-amber-300 hover:bg-amber-500/20"
              onClick={() => setIvitsSpaceStationMode(true)}
            >
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-5 w-5 p-0 flex items-center justify-center bg-amber-500/30 border-amber-500/50 text-[8px]">S</Badge>
                우주정거장 놓기
              </div>
              Special
            </Button>
          )}
          {/* 엠바스 전용: 의회↔광산 교체 (Special) — 의회 보유 시 라운드당 1회 */}
          {game?.currentPhase === 'main' && game.turnOrder?.[game.currentPlayerIndex] === playerId && !game.hasDoneMainAction && currentPlayer?.faction === 'ambas' && !currentPlayer?.usedSpecialActions?.includes('ambas-swap-pi-mine') && game?.map?.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute') && (
            <Button
              variant={ambasSwapPiMineMode ? 'default' : 'outline'}
              className="w-full justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95 border-amber-500/40 text-amber-300 hover:bg-amber-500/20"
              onClick={() => setAmbasSwapPiMineMode(true)}
            >
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-5 w-5 p-0 flex items-center justify-center bg-amber-500/30 border-amber-500/50 text-[8px]">S</Badge>
                의회↔광산 교체
              </div>
              Special
            </Button>
          )}
          {/* 매안(Bescods) 전용: 가장 낮은 트랙 +1 (Special) — 라운드당 1회 */}
          {game?.currentPhase === 'main' && game.turnOrder?.[game.currentPlayerIndex] === playerId && !game.hasDoneMainAction && currentPlayer?.faction === 'bescods' && !currentPlayer?.usedSpecialActions?.includes('bescods-advance-lowest') && (
            <Button
              variant={bescodsAdvanceLowestOpen ? 'default' : 'outline'}
              className="w-full justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95 border-amber-500/40 text-amber-300 hover:bg-amber-500/20"
              onClick={() => setBescodsAdvanceLowestOpen(true)}
            >
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-5 w-5 p-0 flex items-center justify-center bg-amber-500/30 border-amber-500/50 text-[8px]">S</Badge>
                가장 낮은 트랙 +1
              </div>
              Special
            </Button>
          )}
          {/* 파이락(Firaks) Downgrade: 의회 보유 시 연구소→교역소 + 트랙 1칸, 라운드당 1회 */}
          {game?.currentPhase === 'main' && game.turnOrder?.[game.currentPlayerIndex] === playerId && !game.hasDoneMainAction && currentPlayer?.faction === 'firaks' && !currentPlayer?.usedSpecialActions?.includes('firaks-downgrade') && game?.map?.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute') && game?.map?.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'research_lab') && (
            <Button
              variant={firaksDowngradeMode ? 'default' : 'outline'}
              className="w-full justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95 border-amber-500/40 text-amber-300 hover:bg-amber-500/20"
              onClick={() => setFiraksDowngradeMode(true)}
            >
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-5 w-5 p-0 flex items-center justify-center bg-amber-500/30 border-amber-500/50 text-[8px]">S</Badge>
                Downgrade (Lab→TS+트랙)
              </div>
              Special
            </Button>
          )}
          {/* 모웨이드(Moweyip) 전용: 링 놓기 — 의회 보유 시 본인 건물 하나에 링 배치 (+2 파워 수신/연방), 라운드당 1회 */}
          {game?.currentPhase === 'main' && game.turnOrder?.[game.currentPlayerIndex] === playerId && !game.hasDoneMainAction && currentPlayer?.faction === 'moweyip' && !currentPlayer?.usedSpecialActions?.includes('moweyip-place-ring') && game?.map?.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute') && game?.map?.some((t: { ownerId: string | null; structure: string | null; moweyipRing?: boolean }) => t.ownerId === playerId && t.structure && t.structure !== 'ship' && !t.moweyipRing) && (
            <Button
              variant={moweyipPlaceRingMode ? 'default' : 'outline'}
              className="w-full justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95 border-amber-500/40 text-amber-300 hover:bg-amber-500/20"
              onClick={() => setMoweyipPlaceRingMode(true)}
            >
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-5 w-5 p-0 flex items-center justify-center bg-amber-500/30 border-amber-500/50 text-[8px]">S</Badge>
                링 놓기 (+2 파워)
              </div>
              Special
            </Button>
          )}
          {/* 스페이스 자이언트 전용: 매 라운드 1회 2테라포밍 단계 획득 (메인 액션 소모 안 함) */}
          {game?.currentPhase === 'main' && game.turnOrder?.[game.currentPlayerIndex] === playerId && currentPlayer?.faction === 'space_giants' && !currentPlayer?.usedSpecialActions?.includes('space_giants-2tf') && (
            <Button
              variant="outline"
              className="w-full justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95 border-amber-500/40 text-amber-300 hover:bg-amber-500/20"
              onClick={() => {
                if (game.hasDoneMainAction) return;
                GameClient.useSpecialAction(gameId!, 'space_giants-2tf');
              }}
            >
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-5 w-5 p-0 flex items-center justify-center bg-amber-500/30 border-amber-500/50 text-[8px]">S</Badge>
                +2 테라포밍
              </div>
              Special
            </Button>
          )}
          {/* 팅커로이드: 라운드 시작 시 고른 Special 1회 사용 (메인 액션) */}
          {game?.currentPhase === 'main' && game.turnOrder?.[game.currentPlayerIndex] === playerId && currentPlayer?.faction === 'tinkeroids' && currentPlayer?.tinkeroidRoundSpecialId && !currentPlayer?.usedSpecialActions?.includes('tinkeroid-special') && (
            <Button
              variant="outline"
              className="w-full justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95 border-amber-500/40 text-amber-300 hover:bg-amber-500/20"
              onClick={() => {
                if (game.hasDoneMainAction) return;
                if (currentPlayer?.tinkeroidRoundSpecialId) {
                  GameClient.useSpecialAction(gameId!, currentPlayer.tinkeroidRoundSpecialId);
                }
              }}
            >
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-5 w-5 p-0 flex items-center justify-center bg-amber-500/30 border-amber-500/50 text-[8px]">S</Badge>
                {TINKEROID_SPECIAL_LABELS[currentPlayer.tinkeroidRoundSpecialId] ?? currentPlayer.tinkeroidRoundSpecialId}
              </div>
              Special
            </Button>
          )}
        </div>
        </div>
      </div>

      <main className="flex-1 flex flex-col overflow-hidden bg-zinc-900/20 relative">
        <div className="flex-1 min-h-0">
          <GameBoard
            game={game}
            playerId={playerId}
            hoveredPlayerId={hoveredPlayerId}
            onPlaceStartingMine={(tileId, factionId) => {
              const player = game.players[playerId!];
              // 종족이 없으면 종족 선택 필요
              if (!player.faction && !factionId) {
                toast({
                  title: 'Faction Required',
                  description: 'Please select a faction first.',
                  variant: 'destructive',
                });
                return;
              }
              GameClient.placeStartingMine(gameId!, tileId, factionId || player.faction || undefined);
            }}
            onToggleFactionSelect={() => setIsFactionSelectOpen(!isFactionSelectOpen)}
            isFactionSelectOpen={isFactionSelectOpen}
            showFactionSelectButton={((game.currentPhase === 'startingMines' || game.currentPhase === 'factionSelect') && currentPlayer && !currentPlayer.faction) || false}
            onFederationToggleMode={() => gameId && GameClient.federationToggleMode(gameId)}
            onFederationToggleHex={(tileId) => gameId && GameClient.federationToggleHex(gameId, tileId)}
            onFederationComplete={() => gameId && GameClient.federationComplete(gameId)}
            ivitsSpaceStationMode={ivitsSpaceStationMode}
            onCancelIvitsSpaceStation={() => setIvitsSpaceStationMode(false)}
            onPlaceIvitsSpaceStation={(tileId) => {
              if (gameId) GameClient.placeIvitsSpaceStation(gameId, tileId);
              setIvitsSpaceStationMode(false);
            }}
            onPlaceLostPlanet={(tileId, qicToSpend) => {
              if (gameId) GameClient.placeLostPlanet(gameId, tileId, qicToSpend);
            }}
            ambasSwapPiMineMode={ambasSwapPiMineMode}
            onAmbasSwapPiMine={(mineTileId) => {
              if (gameId) {
                GameClient.ambasSwapPiMine(gameId, mineTileId);
                setAmbasSwapPiMineMode(false);
              }
            }}
            onCancelAmbasSwapPiMine={() => setAmbasSwapPiMineMode(false)}
            firaksDowngradeMode={firaksDowngradeMode}
            onFiraksDowngradeSelectLab={(tileId) => setFiraksDowngradeLabTileId(tileId)}
            onCancelFiraksDowngrade={() => { setFiraksDowngradeMode(false); setFiraksDowngradeLabTileId(null); }}
            moweyipPlaceRingMode={moweyipPlaceRingMode}
            onMoweyipPlaceRing={(tileId) => {
              if (gameId) {
                GameClient.moweyipPlaceRing(gameId, tileId);
                setMoweyipPlaceRingMode(false);
              }
            }}
            onCancelMoweyipPlaceRing={() => setMoweyipPlaceRingMode(false)}
            onEnterSpaceship={(tileId, useRangeBonus, qicToUse) => GameClient.enterSpaceship(gameId!, tileId, useRangeBonus, qicToUse)}
            onUseShipAction={(shipTileId, actionIndex, targetTileId) => handleUseShipAction(shipTileId, actionIndex, targetTileId)}
            onTakeTwilightArtifact={(artifactId) => GameClient.takeTwilightArtifact(gameId!, artifactId)}
            onEclipseBuildAsteroidMine={(tileId, qicToSpend) => GameClient.eclipseBuildAsteroidMine(gameId!, tileId, qicToSpend)}
            zoomValue={mapZoom}
            panValue={mapPan}
            onZoomChange={setMapZoom}
            onPanChange={setMapPan}
            onBuildMine={(tileId, useGaiaformer) => {
              const player = game.players[playerId!];
              const isPendingGaiaBuild = (player?.pendingGaiaformerTiles || []).includes(tileId);
              /** 메인 액션 후에도 파워로 받은 테라 스텝으로 광산을 이어 지을 수 있음 — 이 경우 막으면 안 됨 */
              const terraformStepMinePending = (player?.pendingTerraformSteps ?? 0) > 0;
              if (
                game.hasDoneMainAction &&
                (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId) &&
                (!game.pendingTFMarsGaiaProject || game.pendingTFMarsGaiaProject.playerId !== playerId) &&
                !isPendingGaiaBuild &&
                !terraformStepMinePending
              ) {
                return;
              }
              const tile = game.map.find(t => t.id === tileId);
              if (!tile || !playerId) return;

              const faction = FACTIONS.find(f => f.id === player.faction);
              if (!faction) return;

              // Check distance and reachability (+3 거리 보너스 반영)
              const baseRange = getEffectiveBaseRange(player);
              const rangeTiles = game.map.filter(t =>
                (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') ||
                (t.spaceStation?.ownerId === playerId) ||
                (t.parasiticMine?.ownerId === playerId)
              );
              if (rangeTiles.length === 0) return;

              const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));

              // Calculate maximum possible range with all available QIC
              const maxPossibleRange = baseRange + (player.qic * 2);

              // Check if planet is unreachable even with all QIC
              // 단, 내 포머가 이미 설치/회수대기 중인 칸은 거리 체크 면제 (배치 시 거리 QIC 지불 완료)
              if (!isPendingGaiaBuild && minDist > maxPossibleRange) {
                toast({
                  title: 'Cannot Build',
                  description: `Planet is too far away. Distance: ${minDist}, Max range with ${player.qic} QIC: ${maxPossibleRange}`,
                  variant: 'destructive',
                });
                return;
              }

              const potentialCost = getActionCost({ type: 'buildMine', tileId });
              if (!potentialCost) return;

              // 소행성은 가이아 포머 체크만 필요
              if (tile.type === 'asteroid') {
                if (!player.gaiaformers || player.gaiaformers <= 0) {
                  toast({
                    title: 'Cannot Build',
                    description: 'You need at least 1 Gaiaformer to build on an Asteroid.',
                    variant: 'destructive',
                  });
                  return;
                }
                if (player.qic < (potentialCost.qic ?? 0)) {
                  toast({
                    title: 'Cannot Build',
                    description: `Not enough QIC. Required: ${potentialCost.qic ?? 0}QIC`,
                    variant: 'destructive',
                  });
                  return;
                }
              } else {
                if (player.ore < (potentialCost.ore ?? 0) || player.credits < (potentialCost.credits ?? 0) || player.qic < (potentialCost.qic ?? 0)) {
                  toast({
                    title: 'Cannot Build',
                    description: `Not enough resources. Required: ${potentialCost.ore ?? 0}O, ${potentialCost.credits ?? 0}C, ${potentialCost.qic ?? 0}QIC`,
                    variant: 'destructive',
                  });
                  return;
                }
              }

              if (game.hasDoneMainAction || (player.pendingTerraformSteps && player.pendingTerraformSteps > 0)) {
                GameClient.buildMine(gameId!, tileId, useGaiaformer);
                return;
              }

              setPendingAction({ type: 'buildMine', tileId, useGaiaformer });
            }}
            onUpgrade={(tileId, target) => {
              if (game.hasDoneMainAction) return;
              // 테라포밍 액션 사용 중이면 업그레이드 금지
              const player = game.players[playerId!];
              if (player.pendingTerraformSteps && player.pendingTerraformSteps > 0) {
                toast({
                  title: 'Cannot Upgrade',
                  description: 'Terraform action active. Only mine building is allowed.',
                  variant: 'destructive',
                });
                return;
              }
              const potentialCost = getActionCost({ type: 'upgrade', tileId, target });
              if (!potentialCost) {
                // 비용 매핑 누락 시 조용히 죽지 않고 알린다 (예: 진영 특수 업그레이드 경로 미반영)
                toast({
                  title: 'Cannot Upgrade',
                  description: `이 업그레이드 경로의 비용 정보가 없습니다 (${game.map.find(t => t.id === tileId)?.structure ?? '?'} → ${target}). 버그일 수 있어요.`,
                  variant: 'destructive',
                });
                return;
              }

              if (player.ore < (potentialCost.ore ?? 0) || player.credits < (potentialCost.credits ?? 0)) {
                toast({
                  title: 'Cannot Upgrade',
                  description: 'Not enough resources.',
                  variant: 'destructive',
                });
                return;
              }
              setPendingAction({ type: 'upgrade', tileId, target });
            }}
            onAdvanceTech={(trackId) => handleResearchAdvanceTech(trackId)}
            onUsePowerAction={(actionId) => handleUsePowerAction(actionId)}
            onEndTurn={() => GameClient.endTurn(gameId!)}
            highlightedTileId={highlightedTileId}
            onPlaceGaiaformer={(tileId, qicUsed) => GameClient.placeGaiaformer(gameId!, tileId, qicUsed)}
            pendingTwilightTSUpgrade={pendingTwilightTSUpgrade}
            pendingRebellionMineToTS={pendingRebellionMineToTS}
            onTwilightTSUpgrade={(tileId) => {
              if (!gameId || !pendingTwilightTSUpgrade) return;
              GameClient.useShipAction(gameId, pendingTwilightTSUpgrade, 2, tileId);
              setPendingTwilightTSUpgrade(null);
              toast({ title: 'Twilight 액션', description: '2: 2O+3P → TS→Lab', variant: 'default' });
            }}
            onRebellionMineToTS={(tileId) => {
              if (!gameId || !pendingRebellionMineToTS) return;
              GameClient.useShipAction(gameId, pendingRebellionMineToTS, 2, tileId);
              setPendingRebellionMineToTS(null);
              toast({ title: 'Rebellion 액션', description: '2: 1O+3P → M→TS', variant: 'default' });
            }}
            isSidebarOpen={isSidebarOpen}
            sidebarWidth={isSidebarOpen ? sidebarWidth : 0}
            onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
            playerDetailScale={playerDetailScale}
            onTogglePlayerDetailScale={() => {
              setPlayerDetailScale((prev) => {
                const next: 1 | 1.5 | 2 = prev === 1 ? 1.5 : prev === 1.5 ? 2 : 1;
                localStorage.setItem('player-detail-scale', String(next));
                return next;
              });
            }}
          />
        </div>

        {/* Dashboards Area: 제거 (라운드 보드를 오버레이로 이동함). 관전자에게는 보너스 선택 패널 비표시 */}
        <AnimatePresence>
          {isBonusSelectionPhase && !isSpectator && (
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className={`absolute bottom-0 left-0 right-0 border-t border-white/10 bg-zinc-950/95 backdrop-blur flex flex-col shrink-0 shadow-[0_-8px_32px_rgba(0,0,0,0.5)] z-[120] ${isSidebarOpen ? 'max-md:!right-[var(--sidebar-w)]' : ''}`}
              style={isSidebarOpen ? ({ ['--sidebar-w' as string]: `${sidebarWidth}px` } as CSSProperties) : undefined}
            >
              <button
                type="button"
                onClick={() => setIsBonusSelectionPanelExpanded((v) => !v)}
                className="flex items-center justify-between gap-4 w-full px-6 py-4 hover:bg-white/5 transition-colors text-left"
              >
                <div className="flex items-center gap-4">
                  <div className="relative">
                    <Gift className="w-6 h-6 text-primary shrink-0" />
                    {isMyTurnBonusSelection && (
                      <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-primary rounded-full animate-ping" />
                    )}
                  </div>
                  <div className="flex flex-col">
                    <span className="font-black uppercase tracking-[0.2em] text-white text-sm">
                      Bonus Tile Selection
                    </span>
                    {isMyTurnBonusSelection ? (
                      <span className="text-[10px] text-zinc-400 font-medium">It's your turn to choose a bonus tile</span>
                    ) : (
                      <span className="text-[10px] text-amber-400/90 flex items-center gap-1.5 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                        Waiting for {waitingPlayerBonus?.name ?? 'other player'}...
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="h-8 w-px bg-white/10" />
                  <span className="text-zinc-400 p-2 hover:bg-white/5 rounded-full transition-colors">
                    {isBonusSelectionPanelExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
                  </span>
                </div>
              </button>
              {isBonusSelectionPanelExpanded && (
                <div className="px-4 sm:px-6 pb-6 pt-2 max-h-[45vh] overflow-y-auto border-t border-white/5 custom-scrollbar bg-black/20 w-full min-w-0">
                  <BonusTiles
                    game={game}
                    playerId={playerId}
                    isSelectionMode={isMyTurnBonusSelection}
                    onSelectBonusTile={isMyTurnBonusSelection ? ((tileId) => GameClient.selectBonusTile(gameId!, tileId)) : undefined}
                  />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Bonus Tiles Overlay */}
        {isBonusTilesOpen && (
          <div className="fixed inset-0 z-[200] bg-black/90 backdrop-blur-xl flex flex-col items-center justify-center p-6 animate-in fade-in zoom-in duration-300">
            <div className="w-full max-w-5xl h-full flex flex-col gap-4">
              <div className="flex justify-between items-center bg-zinc-900/50 p-4 rounded-2xl border border-white/5 shadow-2xl">
                <div className="flex items-center gap-4">
                  <Gift className="w-5 h-5 text-primary" />
                  <h2 className="text-xl font-black uppercase tracking-widest text-white">Tactical Overview</h2>
                  <Badge className="bg-primary/20 text-primary border-primary/20">Hotkey: E</Badge>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full w-10 h-10 hover:bg-white/10 text-white"
                  onClick={() => setIsBonusTilesOpen(false)}
                >
                  ✕
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto rounded-2xl shadow-inner bg-black/20 p-4 space-y-8 custom-scrollbar">
                <div className="max-w-6xl mx-auto">
                  <RoundBoard
                    game={game}
                    playerId={playerId}
                    onEndGame={() => setConfirmPassWithTileId('dummy')}
                  />
                </div>
                <div className="h-[1px] bg-white/5 w-full" />
                <BonusTiles
                  game={game}
                  playerId={playerId}
                  onSelectBonusTile={isMyTurnBonusSelection ? ((tileId) => GameClient.selectBonusTile(gameId!, tileId)) : isMyTurn ? ((tileId) => {
                    if (game.roundNumber === 6) {
                      setConfirmPassWithTileId('dummy');
                    } else {
                      setConfirmPassWithTileId(tileId);
                    }
                  }) : undefined}
                  onUseBonusAction={() => {
                    const player = game.players[playerId!];
                    if (player.usedBonusAction) return;
                    // 테라포밍 액션인 경우 Research Board 닫기
                    const bonusTile = game.availableBonusTiles.find(t => t.id === player.bonusTile) ||
                      (player.bonusTile ? ALL_BONUS_TILES.find(t => t.id === player.bonusTile) : null);
                    if (bonusTile?.specialAction === 'terraform_step') {
                      setIsResearchOpen(false);
                    }
                    GameClient.useBonusAction(gameId!);
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {/* 선택 대기 중 R창을 닫고 맵을 보는 동안: 다시 열기 플로팅 버튼 */}
        {!isResearchOpen && researchAutoOpenSuppressed && hasPendingResearchSelection && (
          <button
            type="button"
            onClick={() => { setResearchAutoOpenSuppressed(false); setIsResearchOpen(true); }}
            className="fixed top-36 left-1/2 -translate-x-1/2 z-[130] flex items-center gap-2 px-4 py-2 rounded-full bg-blue-900/90 backdrop-blur border border-blue-400/60 text-blue-100 text-xs font-black uppercase tracking-wider shadow-[0_0_20px_rgba(59,130,246,0.4)] hover:bg-blue-800 transition-colors"
          >
            <FlaskConical className="w-4 h-4" />
            Research 창 다시 열기
            <span className="text-[9px] font-bold text-blue-300/90 normal-case">(타일/트랙 선택 대기 중)</span>
          </button>
        )}

        {/* Research Board Overlay */}
        {isResearchOpen && (
          <div className="fixed inset-0 z-[200] bg-black/90 backdrop-blur-xl flex flex-col items-center justify-center p-6 animate-in fade-in zoom-in duration-300">
            <div className="w-full max-w-7xl h-full flex flex-col gap-4">
              <div className="flex justify-between items-center bg-zinc-900/50 p-4 rounded-2xl border border-white/5 shadow-2xl">
                <div className="flex items-center gap-4">
                  <h2 className="text-xl font-black uppercase tracking-widest text-white">Research & Technology</h2>
                  <Badge className="bg-primary/20 text-primary border-primary/20">Hotkey: R</Badge>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full w-10 h-10 hover:bg-white/10 text-white"
                  onClick={() => {
                    // 타일/트랙 선택 대기 중에 닫으면: 자동 재오픈 멈추고 '다시 열기' 버튼으로 맵을 볼 수 있게
                    if (hasPendingResearchSelection) setResearchAutoOpenSuppressed(true);
                    setIsResearchOpen(false);
                  }}
                >
                  ✕
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto rounded-2xl shadow-inner bg-black/20 p-2 custom-scrollbar">
                <ResearchBoard
                  game={game}
                  playerId={playerId}
                  onUsePowerAction={(actionId) => handleUsePowerAction(actionId, { closeResearchOverlay: true })}
                  onUseHadschHallasPIAction={(actionId) => {
                    if (game.hasDoneMainAction) return;
                    GameClient.useHadschHallasPIAction(gameId!, actionId);
                  }}
                  onUseBalTakGaiaformerToQic={() => {
                    // 프리액션: 메인 액션 후에도 사용 가능
                    GameClient.useBalTakGaiaformerToQic(gameId!);
                  }}
                  onGainTechTile={(tileId) => GameClient.gainTechTile(gameId!, tileId)}
                  onUseTechAction={(tileId) => {
                    if (!isMyTurn || game.currentPhase !== 'main') {
                      toast({ title: '사용 불가', description: '내 턴 메인 단계에서만 사용할 수 있습니다.', variant: 'destructive' });
                      return;
                    }
                    if (game.hasDoneMainAction) {
                      toast({ title: '사용 불가', description: '이미 메인 액션을 사용했습니다.', variant: 'destructive' });
                      return;
                    }
                    GameClient.useTechAction(gameId!, tileId);
                  }}
                  onAdvanceTech={(trackId) => handleResearchAdvanceTech(trackId, { closeResearchOverlay: true })}
                  onSelectTechTile={(techTileId, trackId) => {
                    // 오버레이 R창에서 선택한 경우: 자동 닫기/열기 동작하도록 플래그 OFF
                    selectTechTileWithLevel5Confirm(techTileId, trackId, { fromMini: false });
                  }}
                  onSelectAdvancedTechTile={(advancedTileId, trackId) => { if (gameId) GameClient.selectAdvancedTechTile(gameId, advancedTileId, trackId); }}
                  onConfirmAdvancedTechCover={(coverTileId) => { if (gameId) GameClient.confirmAdvancedTechCover(gameId, coverTileId); }}
                  onTakeTwilightArtifact={(artifactId) => { if (gameId) GameClient.takeTwilightArtifact(gameId, artifactId); }}
                  onUseAcademyQic={() => {
                    if (game.hasDoneMainAction) return;
                    if (gameId) GameClient.useSpecialAction(gameId, 'academy-qic');
                  }}
                  onEndTurn={() => { if (gameId) GameClient.endTurn(gameId); setIsResearchOpen(false); }}
                  onResetTurn={() => { if (gameId) GameClient.resetTurn(gameId); }}
                  onUseShipAction={(shipTileId, actionIndex, targetTileId) => handleUseShipAction(shipTileId, actionIndex, targetTileId, { fromOverlay: true })}
                />
              </div>
            </div>
          </div>
        )}

        {/* Pass 시 보너스 타일 선택 모달 (0라운드 초기 선택은 하단 패널만 사용, X/Cancel 없음). 관전자에게는 미표시 */}
        <BonusSelectionModal
          open={!isSpectator && isPendingBonusSelection && game.currentPhase !== 'bonusSelection'}
          onClose={() => {
            if (!isPendingBonusSelection) {
              setConfirmPassWithTileId(null);
            }
            // pendingBonusSelection이 있으면 취소 불가 (필수 선택)
          }}
          game={game}
          playerId={playerId}
          mode="pass"
          onSelectBonusTile={(tileId) => {
            GameClient.passRound(gameId!, tileId);
            setConfirmPassWithTileId(null);
          }}
        />

        {/* Pass Confirmation Dialog (When selecting bonus tile from overlay) */}
        {(() => {
          const currentPlayer = playerId ? game.players[playerId] : null;
          const currentBonusTile = currentPlayer?.bonusTile ? ALL_BONUS_TILES.find(t => t.id === currentPlayer.bonusTile) : null;
          const selectedBonusTile = confirmPassWithTileId && confirmPassWithTileId !== 'dummy' ? ALL_BONUS_TILES.find(t => t.id === confirmPassWithTileId) : null;

          let passBonusVp = 0;
          if (currentBonusTile?.passBonus && playerId && currentPlayer) {
            const counts = getStructureCountsForPlayer(game, playerId);
            const { type, vp } = currentBonusTile.passBonus;
            const myMapTiles = game.map.filter(t => t.ownerId === playerId);
            switch (type) {
              case 'mine':
                passBonusVp = counts.mineCount * vp; break;
              case 'trading_station':
                passBonusVp = counts.tsCount * vp; break;
              case 'research_lab':
                passBonusVp = counts.labCount * vp; break;
              case 'big_building':
                passBonusVp = (counts.piCount + counts.academyLeft + counts.academyRight) * vp; break;
              case 'gaiaformer':
                // 맵에 있는 가이아포머 (이미 지어진 거 말고 트랜스딤 등에 얹혀진 거) + 내 가이아포머 구역 트랙 값
                // 실제 계산: 내가 가진 최대 가이아포머 수 (테라포밍+광산 지어져서 파괴된 거 빼고)
                // 간단히: 현재 열린 가이아포머 컴포넌트 전체 개수 활용, 또는 맵 위 + 개인판
                passBonusVp = (currentPlayer.gaiaformers ?? 0) * vp; // 편의상 개인판 대기중인 것만 (서버 로직과 동일해야 함)
                // 서버의 정확한 로직: 맵 위(hasGaiaformer=true & owner=나) + 개인판(player.gaiaformers) => 파괴 안 된 전체 개수
                const activeGaiaformersOnMap = game.map.filter(t => t.hasGaiaformer && currentPlayer.pendingGaiaformerTiles?.includes(t.id)).length;
                const nextRoundGaiaformers = currentPlayer.gaiaformerPlacedThisRound?.length ?? 0;
                passBonusVp = ((currentPlayer.gaiaformers ?? 0) + activeGaiaformersOnMap + nextRoundGaiaformers) * vp;
                break;
              case 'gaia':
                passBonusVp = myMapTiles.filter(t => t.type === 'gaia' && t.structure != null && t.structure !== 'ship').length * vp;
                break;
              case 'planet_type':
                passBonusVp = new Set(myMapTiles.filter(t => t.structure != null && t.structure !== 'ship').map(t => t.type)).size * vp;
                break;
              case 'bridge_sector':
                // 서버 로직과 동일하게 "외곽 브릿지 섹터(11~18)"만 카운트
                passBonusVp = new Set(
                  myMapTiles
                    .filter(
                      t =>
                        t.structure != null &&
                        t.structure !== 'ship' &&
                        typeof t.sector === 'number' &&
                        t.sector >= 11 &&
                        t.sector <= 18
                    )
                    .map(t => t.sector)
                ).size * vp;
                break;
            }
          }

          // 고급 기술 타일 패스 보너스 (서버 applyAdvancedTechTilePassEffect와 동일 계산)
          const advPassItems: { tile: (typeof ALL_ADVANCED_TECH_TILES)[number]; vp: number }[] = [];
          if (playerId && currentPlayer) {
            const myTiles = game.map.filter(t => t.ownerId === playerId);
            const occupiesSector = (t: (typeof game.map)[number]) =>
              (t.ownerId === playerId && !!t.structure && t.structure !== 'ship') || t.parasiticMine?.ownerId === playerId;
            for (const tid of currentPlayer.techTiles ?? []) {
              const tile = ALL_ADVANCED_TECH_TILES.find(t => t.id === tid);
              if (!tile) continue;
              let vp: number;
              if (tid === 'adv-pass-1vp-type') vp = new Set(myTiles.filter(t => t.structure && t.type !== 'space').map(t => t.type)).size;
              else if (tid === 'adv-pass-3vp-lab') vp = myTiles.filter(t => t.structure === 'research_lab').length * 3;
              else if (tid === 'adv-pass-3vp-fed') vp = getFederationEntries(currentPlayer).length * 3;
              else if (tid === 'adv-pass-2vp-asteroid') vp = myTiles.filter(t => t.type === 'asteroid').length * 2;
              else if (tid === 'adv-pass-2vp-outer') vp = new Set(game.map.filter(t => typeof t.sector === 'number' && t.sector >= 11 && t.sector <= 18 && occupiesSector(t)).map(t => t.sector)).size * 2;
              else continue;
              advPassItems.push({ tile, vp });
            }
          }

          // 패스 전 경고: 이번 라운드에 아직 안 쓴 1회용 특수 액션(4pw 기술타일·아카데미 QIC·의회 액션·종족 스페셜 등) 검출.
          // 라운드 전환 시 서버에서 usedTechActions/usedSpecialActions/usedBonusAction/PI액션이 리셋되므로, 패스하면 이번 라운드분은 영구히 날아간다.
          const unusedAbilities: string[] = [];
          if (playerId && currentPlayer) {
            const used = currentPlayer.usedSpecialActions ?? [];
            const hasStructure = (s: string) => game.map?.some(t => t.ownerId === playerId && t.structure === s) ?? false;
            const hasPI = hasStructure('planetary_institute');
            // 1) 기술 타일 액션 (예: ACT: 4P, ACT: 3K, ACT: 3O, ACT: 1Q+5C)
            (currentPlayer.techTiles ?? []).forEach(tid => {
              const tile = ALL_TECH_TILES.find(t => t.id === tid) ?? ALL_ADVANCED_TECH_TILES.find(t => t.id === tid);
              if (tile?.specialAction && !(currentPlayer.usedTechActions ?? []).includes(tid)) unusedAbilities.push(`기술: ${tile.label}`);
            });
            // 2) 보너스 타일 특수 액션 (1테라/가이아/+3거리)
            if (currentBonusTile?.specialAction && !currentPlayer.usedBonusAction) {
              const names: Record<string, string> = { terraform_step: '1테라', gaia_project: '가이아', range_3: '+3거리' };
              unusedAbilities.push(`보너스: ${names[currentBonusTile.specialAction] ?? currentBonusTile.specialAction}`);
            }
            // 3) 아카데미(오른쪽) QIC/4C 액션 — 사용자가 말한 "1qic"
            if (game.map?.some(t => t.ownerId === playerId && t.structure === 'academy' && t.academyType === 'right') && !used.includes('academy-qic')) {
              unusedAbilities.push(currentPlayer.faction === 'bal_tak' ? '아카데미(4C)' : '아카데미(1QIC)');
            }
            // 4) 의회(PI) 액션 — 하드쉬 할라: 크레딧으로 자원 전환 (감당 가능한 것만)
            (currentPlayer.hadschHallasPIActions ?? []).forEach(a => {
              if (!a.isUsed && (currentPlayer.credits ?? 0) >= a.costCredits) unusedAbilities.push(`의회: ${a.label}`);
            });
            // 5) 종족 스페셜 액션 (PI 필요한 것은 PI 보유 시에만)
            if (currentPlayer.faction === 'bescods' && !used.includes('bescods-advance-lowest')) unusedAbilities.push('매안: 최저트랙+1');
            if (currentPlayer.faction === 'ivits' && !currentPlayer.usedIvitsSpaceStationThisRound) unusedAbilities.push('하이브: 우주정거장');
            if (currentPlayer.faction === 'moweyip' && hasPI && !used.includes('moweyip-place-ring')) unusedAbilities.push('모웨이드: 링');
            if (currentPlayer.faction === 'ambas' && hasPI && !used.includes('ambas-swap-pi-mine')) unusedAbilities.push('엠바스: PI-광산 교체');
            if (currentPlayer.faction === 'firaks' && hasPI && !used.includes('firaks-downgrade')) unusedAbilities.push('파이락: 다운그레이드');
            if (currentPlayer.faction === 'gleens' && !used.includes('gleens-2nav')) unusedAbilities.push('글린: +2항해');
            if (currentPlayer.faction === 'space_giants' && !used.includes('space_giants-2tf')) unusedAbilities.push('거인: 2테라');
            if (currentPlayer.faction === 'tinkeroids' && currentPlayer.tinkeroidRoundSpecialId && !used.includes('tinkeroid-special')) {
              unusedAbilities.push(`팅커: ${currentPlayer.tinkeroidRoundSpecialId.replace('tinkeroid-', '')}`);
            }
          }

          return (
            <AlertDialog open={!!confirmPassWithTileId} onOpenChange={(open) => !open && setConfirmPassWithTileId(null)}>
              <AlertDialogContent className="bg-zinc-950 border-white/10 text-zinc-100 max-w-lg">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white font-black uppercase tracking-wider flex items-center gap-2">
                    <Gift className="w-5 h-5 text-primary" />
                    Choose New Bonus Tile
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-300">
                    {confirmPassWithTileId === 'dummy'
                      ? '라운드를 종료하고 게임을 끝내시겠습니까? (마지막 라운드이므로 새 보너스 타일을 선택하지 않습니다.)'
                      : '라운드를 종료하고 보너스 타일을 교체하시겠습니까?'}
                  </AlertDialogDescription>
                </AlertDialogHeader>

                {unusedAbilities.length > 0 && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
                    <p className="text-amber-300 font-bold text-sm flex items-center gap-1.5">
                      ⚠️ 아직 안 쓴 특수 액션이 {unusedAbilities.length}개 있어요
                    </p>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {unusedAbilities.map((a, i) => (
                        <span key={i} className="text-[11px] font-bold text-amber-200 bg-amber-500/15 border border-amber-500/30 rounded px-2 py-0.5">
                          {a}
                        </span>
                      ))}
                    </div>
                    <p className="text-[11px] text-amber-200/70 mt-2">패스하면 이번 라운드에 다시 쓸 수 없습니다. 정말 패스할까요?</p>
                  </div>
                )}

                <div className="flex items-start justify-center gap-8 py-6">
                  {currentBonusTile && (
                    <div className="flex flex-col items-center gap-3">
                      <span className="text-[10px] text-orange-400 font-bold uppercase tracking-widest bg-orange-500/10 px-2 py-0.5 rounded">Returning</span>
                      <div className="relative w-24 h-36 rounded-lg overflow-hidden border border-white/10 shadow-lg grayscale opacity-50">
                        {(() => {
                          const idx = ALL_BONUS_TILES.findIndex(t => t.id === currentBonusTile.id);
                          return idx !== -1 ? <img src={`/image/BoostTile_${idx + 1}.jpg`} className="w-full h-full object-contain" alt="returning" /> : null;
                        })()}
                      </div>
                      {passBonusVp > 0 && (
                        <div className="text-emerald-400 font-black text-sm bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/20 shadow-[0_0_10px_rgba(16,185,129,0.2)]">
                          +{passBonusVp} VP
                        </div>
                      )}
                    </div>
                  )}
                  {currentBonusTile && selectedBonusTile && confirmPassWithTileId !== 'dummy' && (
                    <div className="text-zinc-600 font-black text-3xl h-36 flex items-center" style={{ marginTop: '28px' }}>→</div>
                  )}
                  {selectedBonusTile && confirmPassWithTileId !== 'dummy' && (
                    <div className="flex flex-col items-center gap-3">
                      <span className="text-[10px] text-primary font-bold uppercase tracking-widest bg-primary/10 px-2 py-0.5 rounded">Selecting</span>
                      <div className="relative w-24 h-36 rounded-lg overflow-hidden border border-primary/50 shadow-[0_0_20px_rgba(var(--primary),0.2)]">
                        {(() => {
                          const idx = ALL_BONUS_TILES.findIndex(t => t.id === selectedBonusTile.id);
                          return idx !== -1 ? <img src={`/image/BoostTile_${idx + 1}.jpg`} className="w-full h-full object-contain" alt="selecting" /> : null;
                        })()}
                      </div>
                    </div>
                  )}
                </div>

                {advPassItems.length > 0 && (
                  <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-4 py-3">
                    <p className="text-[10px] text-cyan-400 font-bold uppercase tracking-widest mb-2">고급 기술 패스 보너스</p>
                    <div className="flex flex-wrap items-start justify-center gap-4">
                      {advPassItems.map(({ tile, vp }) => (
                        <div key={tile.id} className="flex flex-col items-center gap-1.5" title={`${tile.label}: ${tile.description}`}>
                          {tile.image ? (
                            <img src={tile.image} alt={tile.label} className="h-14 w-auto object-contain rounded border border-cyan-500/30" />
                          ) : (
                            <div className="text-[10px] font-bold text-zinc-100 h-14 flex items-center">{tile.label}</div>
                          )}
                          <div className="text-emerald-400 font-black text-xs bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                            +{vp} VP
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <AlertDialogFooter>
                  <AlertDialogCancel className="bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-primary hover:bg-primary/90 text-black font-bold"
                    onClick={() => {
                      if (confirmPassWithTileId && confirmPassWithTileId !== 'dummy') {
                        GameClient.passRound(gameId!, confirmPassWithTileId);
                      } else {
                        GameClient.passRound(gameId!, undefined);
                      }
                      setConfirmPassWithTileId(null);
                    }}
                  >
                    Ok
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
        })()}

        {/* 기술 타일 선택은 R창 내 ResearchBoard에서 처리 (팝업 없음) */}

        {/* Advance Tech Confirmation Dialog */}
        <AlertDialog open={advanceTechDialog.open} onOpenChange={(open) => setAdvanceTechDialog({ open, trackId: null })}>
          <AlertDialogContent className="bg-zinc-900 border-zinc-700">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-white font-black uppercase tracking-wider">
                기술 연구
              </AlertDialogTitle>
              <AlertDialogDescription className="text-zinc-300">
                {advanceTechDialog.trackId && (
                  <>
                    <span className="text-blue-400 font-bold">
                      {RESEARCH_TRACKS.find(t => t.id === advanceTechDialog.trackId)?.name || advanceTechDialog.trackId}
                    </span>
                    {' '}기술을 <span className="text-yellow-400 font-bold">4 Knowledge</span>로 올립니다. 하시겠습니까?
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700">
                취소
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-blue-600 hover:bg-blue-500 text-white font-bold"
                onClick={() => {
                  if (advanceTechDialog.trackId) {
                    GameClient.advanceTech(gameId!, advanceTechDialog.trackId);
                  }
                  setAdvanceTechDialog({ open: false, trackId: null });
                }}
              >
                확인
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* 매안(Bescods) Special: 가장 낮은 트랙 중 하나 +1 선택 */}
        {bescodsAdvanceLowestOpen && currentPlayer?.faction === 'bescods' && (() => {
          const tracks = RESEARCH_TRACKS;
          const levels = tracks.map(t => currentPlayer?.research?.[t.id as ResearchTrack] ?? 0);
          const minLevel = Math.min(...levels);
          const lowestTracks = tracks.filter(t => {
            const lvl = currentPlayer?.research?.[t.id as ResearchTrack] ?? 0;
            return lvl === minLevel && lvl < 5;
          });
          return (
            <AlertDialog open={true} onOpenChange={(open) => { if (!open) setBescodsAdvanceLowestOpen(false); }}>
              <AlertDialogContent className="bg-zinc-900 border-amber-500/40 max-w-sm">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-amber-300 font-black uppercase tracking-wider">매안(Bescods) Special</AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-300">
                    가장 낮은 트랙(Lv.{minLevel}) 중 올릴 트랙을 선택하세요. (비용 없음)
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="grid grid-cols-2 gap-2 py-2">
                  {lowestTracks.length === 0 ? (
                    <p className="col-span-2 text-zinc-500 text-sm">모든 트랙이 Lv.5입니다.</p>
                  ) : (
                    lowestTracks.map((track) => (
                      <Button
                        key={track.id}
                        variant="outline"
                        className="bg-zinc-800 border-amber-500/40 text-amber-200 hover:bg-amber-500/20"
                        onClick={() => {
                          if (gameId) GameClient.bescodsAdvanceLowestTrack(gameId, track.id);
                          setBescodsAdvanceLowestOpen(false);
                        }}
                      >
                        {track.name} (Lv.{minLevel})
                      </Button>
                    ))
                  )}
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-amber-500/40 text-amber-300 hover:bg-amber-500/20" onClick={() => setBescodsAdvanceLowestOpen(false)}>
                    취소
                  </AlertDialogCancel>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
        })()}

        {/* 팅커로이드: 라운드 시작 시 Special 1개 선택 (2~3개 중 선택, 1개면 자동 지정) */}
        {(() => {
          const pending = (game as any).pendingTinkeroidSpecialChoice;
          if (!pending) return null;
          const isTargetMe = pending.playerId === playerId;
          const viewingBot = playerId && game.botPlayerIds?.includes(playerId);
          const targetHuman = !game.botPlayerIds?.includes(pending.playerId);
          if (!(isTargetMe || (viewingBot && targetHuman))) return null;

          const labelOf = (actionId: string) => TINKEROID_SPECIAL_LABELS[actionId as keyof typeof TINKEROID_SPECIAL_LABELS] ?? actionId;

          // 접힌 상태: 모달 배경 없이 하단 작은 바 → 맵·라운드 보면서 바로 선택 가능
          if (tinkeroidSpecialCollapsed) {
            return (
              <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex flex-wrap items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-900/95 border border-amber-500/50 shadow-2xl max-w-[92vw]">
                <span className="text-amber-300 text-xs font-bold shrink-0">팅커로이드 R{pending.round} Special:</span>
                {pending.options.map((actionId: string) => (
                  <Button
                    key={actionId}
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs bg-zinc-800 border-amber-500/40 text-amber-200 hover:bg-amber-500/20"
                    onClick={() => gameId && GameClient.tinkeroidChooseSpecial(gameId, actionId)}
                  >
                    {labelOf(actionId)}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-amber-400 hover:text-white shrink-0" onClick={() => setTinkeroidSpecialCollapsed(false)}>펼치기</Button>
              </div>
            );
          }

          return (
            <AlertDialog open={true} onOpenChange={() => { }}>
              <AlertDialogContent className="bg-zinc-900 border-amber-500/40 max-w-sm">
                <AlertDialogHeader>
                  <div className="flex items-center justify-between gap-2">
                    <AlertDialogTitle className="text-amber-300 font-black uppercase tracking-wider">팅커로이드: 라운드 Special 선택</AlertDialogTitle>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-zinc-400 hover:text-amber-200 shrink-0" onClick={() => setTinkeroidSpecialCollapsed(true)} title="접기 (맵·라운드 보기)">접기</Button>
                  </div>
                  <AlertDialogDescription className="text-zinc-300">
                    라운드 {pending.round}에 사용할 Special을 하나 고르세요. (게임 중 각 액션은 1회만 선택 가능)
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="grid gap-2 py-2">
                  {pending.options.map((actionId: string) => (
                    <Button
                      key={actionId}
                      variant="outline"
                      className="w-full justify-start bg-zinc-800 border-amber-500/40 text-amber-200 hover:bg-amber-500/20"
                      onClick={() => gameId && GameClient.tinkeroidChooseSpecial(gameId, actionId)}
                    >
                      {labelOf(actionId)}
                    </Button>
                  ))}
                </div>
              </AlertDialogContent>
            </AlertDialog>
          );
        })()}

        {/* 파이락(Firaks) Downgrade: 연구소 선택 후 올릴 트랙 선택 */}
        {firaksDowngradeLabTileId && currentPlayer?.faction === 'firaks' && gameId && (
          <AlertDialog open={true} onOpenChange={(open) => { if (!open) { setFiraksDowngradeLabTileId(null); setFiraksDowngradeMode(false); } }}>
            <AlertDialogContent className="bg-zinc-900 border-amber-500/40 max-w-sm">
              <AlertDialogHeader>
                <AlertDialogTitle className="text-amber-300 font-black uppercase tracking-wider">파이락 Downgrade: 트랙 선택</AlertDialogTitle>
                <AlertDialogDescription className="text-zinc-300">
                  선택한 연구소가 교역소로 바뀌고, 올릴 트랙을 선택하세요. (1칸, 비용 없음)
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="grid grid-cols-2 gap-2 py-2">
                {RESEARCH_TRACKS.map((track) => {
                  const level = currentPlayer?.research?.[track.id as ResearchTrack] ?? 0;
                  const disabled = level >= 5;
                  return (
                    <Button
                      key={track.id}
                      variant="outline"
                      className="bg-zinc-800 border-amber-500/40 text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
                      disabled={disabled}
                      onClick={() => {
                        GameClient.firaksDowngrade(gameId, firaksDowngradeLabTileId, track.id);
                        setFiraksDowngradeLabTileId(null);
                        setFiraksDowngradeMode(false);
                      }}
                    >
                      {track.name} (Lv.{level})
                    </Button>
                  );
                })}
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel className="border-amber-500/40 text-amber-300 hover:bg-amber-500/20" onClick={() => { setFiraksDowngradeLabTileId(null); setFiraksDowngradeMode(false); }}>
                  취소
                </AlertDialogCancel>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {/* 거리 5 잊혀진 행성 배치 안내 — 상단은 다른 UI를 가려서 하단 중앙(테라포밍 안내 등과 동일 위치)으로 이동 */}
        {game.pendingLostPlanet?.playerId === playerId && (
          <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-indigo-900/90 border border-indigo-400/50 text-indigo-200 text-sm font-medium shadow-lg">
            잊혀진 행성 배치: 맵에서 <span className="text-white">위성 없는 빈 우주 타일</span>을 클릭한 뒤 오른쪽 패널에서 배치하세요.
          </div>
        )}

        {/* Power Offer Floating Bar */}
        <AnimatePresence>
          {game.pendingPowerOffers && game.pendingPowerOffers.length > 0 && (
            game.pendingPowerOffers
              .filter(offer => {
                if (!offer || offer.responded) return false;
                // 오직 본인에게 온 제안만 표시 (봇이 대신 결정하는 경우 화면에 띄우지 않음)
                return offer.targetPlayerId === playerId;
              })
              // 빌드 순서(FIFO)대로 한 번에 하나씩만 표시. 여러 개를 동시 렌더하면 모두 같은 고정 위치에
              // 겹쳐 쌓여 마지막(나중에 지은 건물)이 위로 와 역순으로 처리되던 문제 수정(사용자 관찰).
              .slice(0, 1)
              .map(offer => {
                if (!offer) return null;
                const sourcePlayer = game.players[offer.sourcePlayerId];
                const vpTooLow = offer.vpCost > (currentPlayer?.score || 0);

                return (
                  <motion.div
                    key={offer.id}
                    initial={{ y: -50, x: '-50%', opacity: 0 }}
                    animate={{ y: 0, x: '-50%', opacity: 1 }}
                    exit={{ y: -50, x: '-50%', opacity: 0 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                    className="fixed top-24 left-1/2 z-[65] flex items-center gap-4 p-2 px-4 bg-zinc-900/95 backdrop-blur-xl border border-blue-500/50 rounded-full shadow-[0_0_30px_rgba(59,130,246,0.2)] max-w-[95vw]"
                  >
                    <div className="flex items-center gap-3 border-r border-white/10 pr-4">
                      <div className="flex flex-col shrink-0 mr-2">
                        <h3 className="text-blue-400 font-black uppercase tracking-tighter text-[9px] leading-none">
                          Power Offer
                        </h3>
                        <span className="text-[10px] text-zinc-400 font-bold">from {sourcePlayer?.name}</span>
                      </div>

                      <div className="flex items-center gap-4 shrink-0">
                        <div className="flex flex-col items-center">
                          <span className="text-lg font-black text-blue-400 leading-none">+{offer.amount}</span>
                          <span className="text-[8px] uppercase text-zinc-500 font-bold tracking-tighter">Power</span>
                        </div>
                        <div className="flex flex-col items-center">
                          <span className={`text-lg font-black leading-none ${vpTooLow ? 'text-red-500' : 'text-zinc-300'}`}>{offer.vpCost}</span>
                          <span className="text-[8px] uppercase text-zinc-500 font-bold tracking-tighter">VP Cost</span>
                        </div>
                      </div>
                    </div>

                    {currentPlayer?.faction === 'taklons' && (
                      <div className="flex items-center gap-2 border-r border-white/10 pr-4">
                        <Button
                          size="sm"
                          variant="ghost"
                          className={`h-7 px-2 text-[9px] font-bold uppercase transition-colors ${powerOfferBrainFirst ? 'text-amber-400 bg-amber-400/10' : 'text-zinc-500'}`}
                          onClick={() => { setPowerOfferBrainFirst(true); setPowerOfferPiAddFirst(false); }}
                          title="브레인 스톤 우선 수령 (켜면 PI 1st는 꺼짐)"
                        >
                          Brain First
                        </Button>
                        {game?.map && (currentPlayer as PlayerState) && game.map.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className={`h-7 px-2 text-[9px] font-bold uppercase transition-colors ${powerOfferPiAddFirst ? 'text-amber-400 bg-amber-400/10' : 'text-zinc-500'}`}
                            onClick={() => { setPowerOfferPiAddFirst(true); setPowerOfferBrainFirst(false); }}
                            title="의회 효과(1그릇 추가) 우선 적용 (켜면 Brain First는 꺼짐)"
                          >
                            PI 1st
                          </Button>
                        )}
                      </div>
                    )}

                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-3 border-red-500/30 hover:bg-red-500/10 text-red-500 text-[10px] font-black uppercase"
                        onClick={() => {
                          if (gameId) GameClient.respondPowerOffer(gameId, offer.id, false);
                        }}
                      >
                        Decline
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 px-4 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-black uppercase shadow-lg shadow-blue-900/20"
                        onClick={() => {
                          if (gameId) GameClient.respondPowerOffer(gameId, offer.id, true, currentPlayer?.faction === 'taklons' ? powerOfferBrainFirst : undefined, (currentPlayer as PlayerState)?.faction === 'taklons' && game?.map?.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute') ? powerOfferPiAddFirst : undefined);
                        }}
                      >
                        Accept
                      </Button>
                    </div>
                  </motion.div>
                );
              })
          )}
        </AnimatePresence>

        {/* 연방 선언: 불필요한 위성 포함 경고 */}
        {federationRedundantWarning && gameId && (
          <AlertDialog open={true} onOpenChange={(open) => !open && setFederationRedundantWarning(null)}>
            <AlertDialogContent className="bg-zinc-950 border-white/10 text-zinc-100 max-w-md">
              <AlertDialogHeader>
                <AlertDialogTitle className="text-white font-black uppercase tracking-wider">
                  ⚠️ 위성이 필요 이상으로 포함됨
                </AlertDialogTitle>
                <AlertDialogDescription className="text-zinc-300">
                  일부 위성을 제외해도 연방이 가능합니다.
                  <br />그래도 진행하시겠습니까?
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700">
                  취소 (위성 다시 선택)
                </AlertDialogCancel>
                <AlertDialogAction
                  className="bg-amber-600 hover:bg-amber-500 text-white font-bold"
                  onClick={() => {
                    GameClient.federationComplete(gameId, true);
                    setFederationRedundantWarning(null);
                  }}
                >
                  그래도 진행
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {/* 파워/우주선 액션: 3그릇 부족분을 2그릇 태우기로 충당할지 확인 */}
        {confirmBurnAction && gameId && (() => {
          const { burns } = confirmBurnAction;
          const label = confirmBurnAction.kind === 'power'
            ? (game.powerActions?.find(a => a.id === confirmBurnAction.actionId)?.label ?? confirmBurnAction.actionId)
            : confirmBurnAction.label;
          return (
            <AlertDialog open={true} onOpenChange={(open) => !open && setConfirmBurnAction(null)}>
              <AlertDialogContent className="bg-zinc-950 border-white/10 text-zinc-100 max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white font-black uppercase tracking-wider">
                    파워를 태우고 액션할까요?
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-300">
                    3그릇 파워가 <strong className="text-purple-300">{burns}개</strong> 부족합니다.
                    2그릇에서 <strong className="text-purple-300">{burns}개</strong>를 태우면(추가로 {burns}개가 3그릇으로 이동, 총 2그릇 {burns * 2}개 사용)
                    바로 <strong className="text-white">{label}</strong> 액션을 실행할 수 있습니다.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-purple-600 hover:bg-purple-500 text-white font-bold"
                    onClick={() => {
                      for (let i = 0; i < burns; i++) GameClient.burnPower(gameId);
                      if (confirmBurnAction.kind === 'power') {
                        if (confirmBurnAction.closeResearchOverlay && (confirmBurnAction.actionId === 'gain-1-step' || confirmBurnAction.actionId === 'gain-2-steps')) setIsResearchOpen(false);
                        GameClient.usePowerAction(gameId, confirmBurnAction.actionId);
                      } else {
                        proceedShipAction(confirmBurnAction.shipTileId, confirmBurnAction.actionIndex, confirmBurnAction.targetTileId, { fromOverlay: confirmBurnAction.fromOverlay });
                      }
                      setConfirmBurnAction(null);
                    }}
                  >
                    OK (태우고 실행)
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
        })()}

        {/* Twilight 액션1: 보유 연방 중 하나 선택해서 해택 재수령 */}
        {game.pendingTwilightFederation && game.pendingTwilightFederation.playerId === playerId && gameId && (() => {
          const myFedIds = getFederationEntries(currentPlayer as PlayerState).map((f) => f.rewardId);
          const myRewards = myFedIds.map((id) => FEDERATION_REWARDS.find((r) => r.id === id) || SPACESHIP_FEDERATION_REWARDS.find((r) => r.id === id) || (id === GLEENS_FEDERATION_REWARD.id ? GLEENS_FEDERATION_REWARD : undefined)).filter(Boolean);
          return (
            <AlertDialog open={true} onOpenChange={() => { }}>
              <AlertDialogContent className="bg-zinc-900 border-zinc-700 max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white font-black uppercase tracking-wider">Twilight: 연방 해택 재수령</AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-300">보유한 연방 중 받을 보상을 하나 선택하세요 (3Q 지불됨).</AlertDialogDescription>
                </AlertDialogHeader>
                <div className="grid grid-cols-2 gap-2 py-4">
                  {myRewards.length === 0 ? (
                    <p className="col-span-2 text-zinc-500 text-sm italic">보유한 연방이 없습니다.</p>
                  ) : (
                    myRewards.map((reward) => {
                      if (!reward) return null;
                      let imgUrl: string | null = null;
                      if (reward.id === GLEENS_FEDERATION_REWARD.id) imgUrl = '/image/Federation_15.gif';
                      else {
                        const fedIdx = FEDERATION_REWARDS.findIndex(r => r.id === reward.id);
                        if (fedIdx !== -1) imgUrl = `/image/Federation_${fedIdx + 1}.gif`;
                        else {
                          const shipIdx = SPACESHIP_FEDERATION_REWARDS.findIndex(r => r.id === reward.id);
                          if (shipIdx !== -1) imgUrl = `/image/Federation_${shipIdx + 7}.gif`;
                        }
                      }
                      return (
                        <Button
                          key={reward.id}
                          variant="outline"
                          title={reward.label}
                          className="bg-zinc-800 border-zinc-700 hover:bg-zinc-700 hover:border-zinc-500 text-white transition-all h-24 px-4"
                          onClick={() => GameClient.confirmTwilightFederation(gameId, reward.id)}
                        >
                          {imgUrl ? (
                            <img src={imgUrl} alt={reward.label} className="h-[52px] w-auto object-contain" />
                          ) : (
                            <span className="font-bold">{reward.label}</span>
                          )}
                        </Button>
                      );
                    })
                  )}
                </div>
                <AlertDialogFooter>
                  <Button
                    variant="ghost"
                    className="text-zinc-400 hover:text-white hover:bg-zinc-800"
                    onClick={() => GameClient.cancelTwilightFederation(gameId)}
                  >
                    취소 (Action Cancel)
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
        })()}

        {/* 연방 구현: 보상 선택 (7파워 이상 연방 형성 후) — 일반 풀(남은 개수 표시) + 입장한 우주선 연방만 */}
        {game.pendingFederationReward && game.pendingFederationReward.playerId === playerId && gameId && (() => {
          const currentPlayer = game.players[playerId];
          const enteredShipTileIds = currentPlayer?.spaceshipsEntered ?? [];
          const byShip = game.spaceshipFederationByShip || {};
          const shipRewardsAvailable = Object.entries(byShip)
            .filter(([shipType]) => game.map.some((t) => t.type === shipType && enteredShipTileIds.includes(t.id)))
            .filter(([, rewardId]) => !Object.values(game.players).some((p) => getFederationEntries(p).some((e) => e.rewardId === rewardId)))
            .map(([shipType, rewardId]) => ({ shipType, reward: SPACESHIP_FEDERATION_REWARDS.find((r) => r.id === rewardId) }))
            .filter((x) => x.reward);
          return (
            <AlertDialog open={true} onOpenChange={() => { }}>
              <AlertDialogContent className="bg-zinc-900 border-zinc-700 max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white font-black uppercase tracking-wider">연방 보상 선택</AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-300">받을 연방 보상을 하나 선택하세요.</AlertDialogDescription>
                </AlertDialogHeader>
                <div className="grid grid-cols-2 gap-2 py-4">
                  {FEDERATION_REWARDS.filter((r) => (game.federationPool?.[r.id] ?? 0) > 0).map((reward) => {
                    const remaining = game.federationPool?.[reward.id] ?? 0;
                    const rewardIndex = FEDERATION_REWARDS.findIndex(r => r.id === reward.id);
                    const imgUrl = rewardIndex !== -1 ? `/image/Federation_${rewardIndex + 1}.gif` : null;

                    return (
                      <Button
                        key={reward.id}
                        variant="outline"
                        className="bg-zinc-800 border-zinc-600 h-24 px-4"
                        onClick={() => GameClient.federationSelectReward(gameId, reward.id)}
                      >
                        <div className="flex flex-col items-center gap-2">
                          {imgUrl ? (
                            <img src={imgUrl} alt={reward.label} className="h-[52px] w-auto object-contain" />
                          ) : (
                            <span className="font-bold">{reward.label}</span>
                          )}
                          <span className="text-zinc-500 text-[10px]">({remaining} left)</span>
                        </div>
                      </Button>
                    );
                  })}
                  {shipRewardsAvailable.map(({ shipType, reward }) => {
                    if (!reward) return null;
                    const rewardIndex = SPACESHIP_FEDERATION_REWARDS.findIndex(r => r.id === reward.id);
                    const imgUrl = rewardIndex !== -1 ? `/image/Federation_${rewardIndex + 7}.gif` : null;
                    return (
                      <Button
                        key={`${shipType}-${reward.id}`}
                        variant="outline"
                        className="bg-cyan-950/50 border-cyan-500/50 h-24 px-4"
                        onClick={() => GameClient.federationSelectReward(gameId, reward.id)}
                      >
                        <div className="flex flex-col items-center gap-2">
                          {imgUrl ? (
                            <img src={imgUrl} alt={reward.label} className="h-[52px] w-auto object-contain" />
                          ) : (
                            <span className="font-bold">🚀 {reward.label}</span>
                          )}
                        </div>
                      </Button>
                    );
                  })}
                </div>
                <AlertDialogFooter>
                  {/* 취소: 턴 시작 상태로 복구 → 연방 형성(위성 배치·토큰 소비) 자체를 되돌림 */}
                  <Button
                    variant="outline"
                    className="border-zinc-600 text-zinc-300 hover:bg-zinc-800"
                    onClick={() => GameClient.resetTurn(gameId)}
                  >
                    취소 (연방 형성 되돌리기)
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
        })()}

        {/* Itars PI: Gaiaformer 4개당 기술 타일 1개 vs 그만하고 나머지 1그릇 복귀 */}
        {(() => {
          const pending = game.pendingItarsGaiaformerExchange;
          if (!pending) return null;
          const isTargetMe = pending.playerId === playerId;
          const viewingBot = playerId && game.botPlayerIds?.includes(playerId);
          const targetHuman = !game.botPlayerIds?.includes(pending.playerId);
          if (!(isTargetMe || (viewingBot && targetHuman))) return null;

          return (
            <AlertDialog open={true} onOpenChange={() => { }}>
              <AlertDialogContent className="bg-zinc-900 border-zinc-700 max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white font-black uppercase tracking-wider">Itars 의회</AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-300">
                    가이아포머 공간에 <strong>{pending.tokensRemaining}개</strong> 토큰이 있습니다. 4개를 제거하고 기술 타일 1개를 가져오시겠습니까? (그만 선택 시 나머지는 1그릇으로 복귀)
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <Button
                    variant="outline"
                    className="border-zinc-600 text-zinc-300 hover:bg-zinc-800"
                    onClick={() => gameId && GameClient.itarsGaiaformerExchangeChoice(gameId, false)}
                  >
                    그만하고 1그릇으로
                  </Button>
                  <Button
                    className="bg-amber-600 hover:bg-amber-500 text-white font-bold"
                    disabled={pending.tokensRemaining < 4}
                    onClick={() => gameId && GameClient.itarsGaiaformerExchangeChoice(gameId, true)}
                  >
                    4개 제거하고 기술 타일 가져오기
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
        })()}

        {/* Terran Council: Gaiaformer tokens → Bowl 2, then exchange (4=QIC/K, 3=O, 1=C) */}
        {(() => {
          const pending = game.pendingTerranCouncilBenefit;
          if (!pending) return null;
          const isTargetMe = pending.playerId === playerId;
          const viewingBot = playerId && game.botPlayerIds?.includes(playerId);
          const targetHuman = !game.botPlayerIds?.includes(pending.playerId);
          if (!(isTargetMe || (viewingBot && targetHuman))) return null;

          const { tokenCount } = pending;
          const cost = terranCouncilChoice.qic * 4 + terranCouncilChoice.knowledge * 4 + terranCouncilChoice.ore * 3 + terranCouncilChoice.credits * 1;
          const valid = cost <= tokenCount;
          return (
            <AlertDialog open={true} onOpenChange={() => { }}>
              <AlertDialogContent className="bg-zinc-900 border-zinc-700 max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white font-black uppercase tracking-wider">Terran Council</AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-300">
                    {tokenCount} tokens returned to Bowl 2. Exchange: 4 tokens → 1 QIC or 1 K; 3 → 1 O; 1 → 1 C. Choose benefits (total cost ≤ {tokenCount}).
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="grid grid-cols-2 gap-3 py-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zinc-300 text-sm">1 QIC (4)</span>
                    <div className="flex items-center gap-1">
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, qic: Math.max(0, c.qic - 1) }))}>−</Button>
                      <span className="w-6 text-center text-white font-mono">{terranCouncilChoice.qic}</span>
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, qic: c.qic + 1 }))}>+</Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zinc-300 text-sm">1 K (4)</span>
                    <div className="flex items-center gap-1">
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, knowledge: Math.max(0, c.knowledge - 1) }))}>−</Button>
                      <span className="w-6 text-center text-white font-mono">{terranCouncilChoice.knowledge}</span>
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, knowledge: c.knowledge + 1 }))}>+</Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zinc-300 text-sm">1 O (3)</span>
                    <div className="flex items-center gap-1">
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, ore: Math.max(0, c.ore - 1) }))}>−</Button>
                      <span className="w-6 text-center text-white font-mono">{terranCouncilChoice.ore}</span>
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, ore: c.ore + 1 }))}>+</Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zinc-300 text-sm">1 C (1)</span>
                    <div className="flex items-center gap-1">
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, credits: Math.max(0, c.credits - 1) }))}>−</Button>
                      <span className="w-6 text-center text-white font-mono">{terranCouncilChoice.credits}</span>
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, credits: c.credits + 1 }))}>+</Button>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-zinc-400 mb-2">Spent: {cost} / {tokenCount} tokens</p>
                <AlertDialogFooter>
                  <Button
                    className="bg-amber-600 hover:bg-amber-500 text-white font-bold"
                    disabled={!valid}
                    onClick={() => {
                      if (gameId) {
                        GameClient.terranCouncilConfirmBenefits(gameId, terranCouncilChoice.qic, terranCouncilChoice.knowledge, terranCouncilChoice.ore, terranCouncilChoice.credits);
                        setTerranCouncilChoice({ qic: 0, knowledge: 0, ore: 0, credits: 0 });
                      }
                    }}
                  >
                    Confirm
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
        })()}

        {/* TF Mars 액션2 / 보너스 타일(2P|ACT:GP): 가이아 프로젝트 (Transdim에 가이아포머 배치) */}
        {game.pendingTFMarsGaiaProject && game.pendingTFMarsGaiaProject.playerId === playerId && gameId && (
          <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 px-4 py-3 rounded-lg bg-zinc-900 border border-purple-500 shadow-2xl">
            <span className="text-purple-300 font-medium whitespace-nowrap">
              {game.pendingTFMarsGaiaProject.shipTileId === 'bonus-gaia'
                ? '보너스 액션: 보라색(Transdim) 행성에 가이아포머 배치'
                : 'TF Mars 액션: 보라색(Transdim) 행성에 가이아포머 배치'}
            </span>
            <Button variant="outline" size="sm" className="bg-zinc-800 border-zinc-600 text-zinc-300 hover:bg-zinc-700 whitespace-nowrap shrink-0" onClick={() => GameClient.skipTFMarsGaiaProject(gameId)}>
              액션포기
            </Button>
          </div>
        )}

        {/* Eclipse 액션2: 연구 트랙 선택 (2K+3P로 원하는 트랙 1칸) */}
        {game.pendingEclipseResearch && game.pendingEclipseResearch.playerId === playerId && gameId && (
          <AlertDialog open={true} onOpenChange={() => { }}>
            <AlertDialogContent className="bg-zinc-900 border-zinc-700 max-w-md">
              <AlertDialogHeader>
                <AlertDialogTitle className="text-white font-black uppercase tracking-wider">Eclipse: 연구 트랙</AlertDialogTitle>
                <AlertDialogDescription className="text-zinc-300">올릴 연구 트랙을 선택하세요 (2K+3P 지불됨).</AlertDialogDescription>
              </AlertDialogHeader>
              <div className="grid grid-cols-2 gap-2 py-4">
                {RESEARCH_TRACKS.map((track) => {
                  const level = currentPlayer?.research?.[track.id as ResearchTrack] ?? 0;
                  const disabled = level >= 5;
                  return (
                    <Button
                      key={track.id}
                      variant="outline"
                      className="bg-zinc-800 border-zinc-600 hover:bg-zinc-700 text-zinc-100"
                      disabled={disabled}
                      onClick={() => GameClient.eclipseAdvanceTrack(gameId, track.id as ResearchTrack)}
                    >
                      {track.name} (Lv.{level})
                    </Button>
                  );
                })}
              </div>
              <AlertDialogFooter>
                <Button
                  variant="outline"
                  className="w-full bg-transparent border-zinc-600 hover:bg-zinc-800 text-zinc-300"
                  onClick={() => GameClient.cancelEclipseResearch(gameId)}
                >
                  취소 (Cancel)
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {/* Eclipse 액션3: 소행성 광산 — 맵에서 초록 테두리 소행성 클릭으로 건설 (모달 없음) */}
        {game.pendingEclipseAsteroidMine && game.pendingEclipseAsteroidMine.playerId === playerId && (
          <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-zinc-900/95 border border-green-500/50 text-green-400 text-sm font-medium shadow-lg flex items-center gap-2">
            Eclipse: 맵에서 <span className="font-bold text-green-300">초록 테두리</span> 소행성을 클릭하여 광산 건설 (6C)
            <Button variant="ghost" size="sm" className="text-green-400 hover:text-white shrink-0" onClick={() => gameId && GameClient.cancelEclipseAsteroidMine(gameId)}>취소 (6C 환불)</Button>
          </div>
        )}
        {/* 우주선 기술(2TF+Mine): 맵에서 행성 클릭으로 건설 */}
        {game.pendingShipTechMine && game.pendingShipTechMine.playerId === playerId && (
          <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-zinc-900/95 border border-orange-500/50 text-orange-400 text-sm font-medium shadow-lg">
            Ship Tech (2TF+Mine): 맵에서 <span className="font-bold text-orange-300">행성을 클릭</span>하여 광산 건설
          </div>
        )}
        {/* Twilight 액션2 / Rebellion 액션2: 맵에서 보라 테두리 건물 클릭으로 선택 */}
        {(pendingTwilightTSUpgrade || pendingRebellionMineToTS) && (
          <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-zinc-900/95 border border-violet-500/50 text-violet-300 text-sm font-medium shadow-lg flex items-center gap-2">
            {pendingTwilightTSUpgrade && 'Twilight: 맵에서 보라 테두리 교역소를 클릭하여 연구소로 업그레이드 (2O, 3P)'}
            {pendingRebellionMineToTS && 'Rebellion: 맵에서 보라 테두리 광산을 클릭하여 교역소로 변경 (1O, 3P)'}
            <Button variant="ghost" size="sm" className="text-violet-400 hover:text-white shrink-0" onClick={() => { setPendingTwilightTSUpgrade(null); setPendingRebellionMineToTS(null); }}>취소</Button>
          </div>
        )}
        {/* 엠바스 Special: 의회↔광산 교체 — 맵에서 내 광산 클릭 */}
        {ambasSwapPiMineMode && (
          <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-zinc-900/95 border border-amber-500/50 text-amber-300 text-sm font-medium shadow-lg flex items-center gap-2">
            엠바스: 맵에서 <span className="font-bold text-amber-200">교체할 내 광산</span>을 클릭하면 의회와 위치가 바뀝니다.
            <Button variant="ghost" size="sm" className="text-amber-400 hover:text-white shrink-0" onClick={() => setAmbasSwapPiMineMode(false)}>취소</Button>
          </div>
        )}
        {/* 파이락 Downgrade: 연구소 클릭 → 트랙 선택 */}
        {firaksDowngradeMode && !firaksDowngradeLabTileId && (
          <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-zinc-900/95 border border-amber-500/50 text-amber-300 text-sm font-medium shadow-lg flex items-center gap-2">
            파이락: 맵에서 <span className="font-bold text-amber-200">다운그레이드할 연구소</span>를 클릭한 뒤, 올릴 트랙을 선택하세요.
            <Button variant="ghost" size="sm" className="text-amber-400 hover:text-white shrink-0" onClick={() => { setFiraksDowngradeMode(false); setFiraksDowngradeLabTileId(null); }}>취소</Button>
          </div>
        )}
        {/* 활성 스페셜 액션(2단계) 안내 배너 */}
        {game && game.turnOrder[game.currentPlayerIndex] === playerId && currentPlayer && (
          <>
            {(currentPlayer.pendingTerraformSteps ?? 0) > 0 && (
              <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[55] px-4 py-3 rounded-lg bg-orange-950/90 border border-orange-500/50 text-orange-200 text-sm font-bold shadow-2xl flex items-center gap-4 animate-in slide-in-from-bottom-5">
                <span>테라포밍 액션 사용 중 ({currentPlayer.pendingTerraformSteps}단계 남음)</span>
                <Button variant="outline" size="sm" className="bg-zinc-800 border-zinc-600 text-zinc-300 hover:bg-zinc-700 whitespace-nowrap shrink-0 h-7" onClick={() => { GameClient.resetTurn(gameId!); setPendingAction(null); }}>취소 (Undo)</Button>
              </div>
            )}
            {(currentPlayer.rangeBonusActive || currentPlayer.tempRangeBonus) && (
              <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[55] px-4 py-3 rounded-lg bg-purple-950/90 border border-purple-500/50 text-purple-200 text-sm font-bold shadow-2xl flex items-center gap-4 animate-in slide-in-from-bottom-5">
                <span>+3 거리 보너스 적용 중</span>
                <Button variant="outline" size="sm" className="bg-zinc-800 border-zinc-600 text-zinc-300 hover:bg-zinc-700 whitespace-nowrap shrink-0 h-7" onClick={() => { GameClient.resetTurn(gameId!); setPendingAction(null); }}>취소 (Undo)</Button>
              </div>
            )}
            {currentPlayer.gleensNavBonusActive && (
              <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[55] px-4 py-3 rounded-lg bg-green-950/90 border border-green-500/50 text-green-200 text-sm font-bold shadow-2xl flex items-center gap-4 animate-in slide-in-from-bottom-5">
                <span>글린 특수 액션: +2 거리 적용 중</span>
                <Button variant="outline" size="sm" className="bg-zinc-800 border-zinc-600 text-zinc-300 hover:bg-zinc-700 whitespace-nowrap shrink-0 h-7" onClick={() => { GameClient.resetTurn(gameId!); setPendingAction(null); }}>취소 (Undo)</Button>
              </div>
            )}
          </>
        )}
        {/* 모웨이드 링 놓기: 링 없는 본인 건물 클릭 */}
        {moweyipPlaceRingMode && (
          <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-zinc-900/95 border border-amber-500/50 text-amber-300 text-sm font-medium shadow-lg flex items-center gap-2">
            모웨이드: 맵에서 <span className="font-bold text-amber-200">링을 놓을 본인 건물</span>을 클릭하세요. (+2 파워 수신/연방)
            <Button variant="ghost" size="sm" className="text-amber-400 hover:text-white shrink-0" onClick={() => setMoweyipPlaceRingMode(false)}>취소</Button>
          </div>
        )}
        {/* 우주선 기술 타일 획득 후: 하단 풀 3개처럼 6개 트랙 중 원하는 트랙 1칸 진행 */}
        {game.pendingShipTechTrackAdvance?.playerId === playerId && (
          <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-zinc-900/95 border border-amber-500/50 text-amber-300 text-sm font-medium shadow-lg">
            우주선 기술 타일 보상: R창에서 올릴 트랙을 클릭하세요 (6개 중 1개)
          </div>
        )}

        {/* Income Selection Dialog - 수익 단계에서 맨 앞에 표시 (z-[100]). 수익 차례인 플레이어에게만 표시 */}
        {(() => {
          const pending = game.pendingIncomeOrder;
          if (!pending) return null;
          if (pending.playerId !== playerId) return null;

          const actualPlayer = game.players[pending.playerId];
          if (!actualPlayer) return null;

          return (
            <AlertDialog open={true} onOpenChange={() => { }}>
              <AlertDialogContent className="bg-zinc-900 border-zinc-700 max-w-2xl">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white font-black uppercase tracking-wider text-xl">
                    수익 선택 (Income Phase)
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-300">
                    받을 수익(파워/토큰)을 하나씩 선택하세요. 모두 받으면 Finish를 눌러주세요.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="space-y-4 py-4">
                  {pending.incomeItems.length > 0 ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-sm font-bold text-zinc-300">받을 수익</span>
                        <Button
                          className="bg-amber-500/20 border-amber-500/40 text-amber-300 hover:bg-amber-500/30 font-bold"
                          variant="secondary"
                          size="sm"
                          onClick={() => gameId && GameClient.selectAllIncomeItems(gameId)}
                        >
                          자동 받기 (수익 모두 받기)
                        </Button>
                        <span className="text-xs text-zinc-400 font-mono ml-2 px-2 py-1 rounded bg-zinc-800/80 border border-white/10">
                          현재 파워: <span className="text-blue-400 font-bold">{actualPlayer.power1 ?? 0}</span> / <span className="text-cyan-400 font-bold">{actualPlayer.power2 ?? 0}</span> / <span className="text-amber-400 font-bold">{actualPlayer.power3 ?? 0}</span> (1/2/3그릇)
                        </span>
                      </div>
                      {pending.incomeItems.length > 0 && (() => {
                        const best = simulateIncomeOrder(
                          actualPlayer,
                          findOptimalIncomeOrder(actualPlayer, [...pending.incomeItems])
                        );
                        const brainNote = actualPlayer.faction === 'taklons' && !actualPlayer.brainStoneInGaia && best.brainStoneBowl
                          ? ` · 🧠${best.brainStoneBowl}그릇`
                          : '';
                        return (
                          <p className="text-[10px] text-zinc-500">
                            자동 받기 시 결과: 1/2/3그릇 → <span className="font-mono text-zinc-300 font-bold">{best.p1} / {best.p2} / {best.p3}</span>{brainNote}
                          </p>
                        );
                      })()}
                      <div className="grid grid-cols-3 gap-3">
                        {pending.incomeItems.map((item) => {
                          let preview = '';
                          const { power1, power2, power3 } = actualPlayer;
                          const after = simulateIncomeOrder(actualPlayer, [item]);
                          if (item.type === 'power') {
                            preview = `${power1 ?? 0}/${power2 ?? 0}/${power3 ?? 0} → ${after.p1}/${after.p2}/${after.p3}`;
                            if (actualPlayer.faction === 'taklons' && !actualPlayer.brainStoneInGaia && after.brainStoneBowl) {
                              preview += ` ·🧠${after.brainStoneBowl}`;
                            }
                          } else if (item.type === 'tokens') {
                            preview = `${power1 ?? 0}/${power2 ?? 0}/${power3 ?? 0} → ${after.p1}/${after.p2}/${after.p3}`;
                          }

                          return (
                            <button
                              key={item.id}
                              className={`p-4 rounded-lg border-2 transition-all hover:scale-105 ${item.type === 'power'
                                ? 'bg-blue-500/10 border-blue-500/30 hover:border-blue-500/60 hover:bg-blue-500/20'
                                : 'bg-cyan-500/10 border-cyan-500/30 hover:border-cyan-500/60 hover:bg-cyan-500/20'
                                }`}
                              onClick={() => {
                                if (gameId) {
                                  GameClient.selectIncomeItem(gameId, item.id);
                                }
                              }}
                            >
                              <div className={`text-2xl font-black ${item.type === 'power' ? 'text-blue-400' : 'text-cyan-400'}`}>
                                {item.amount}
                              </div>
                              <div className="text-xs uppercase text-zinc-400 font-bold mt-1">
                                {item.type === 'power' ? 'Power' : 'Tokens'}
                              </div>
                              {preview && (
                                <div className="text-[9px] text-zinc-500 mt-1.5 font-mono">
                                  {preview}
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="text-center text-zinc-400 py-2">
                        모든 수익을 받았습니다. Finish를 눌러주세요.
                      </div>
                      <div className="text-center">
                        <span className="text-xs text-zinc-500 font-mono px-2 py-1 rounded bg-zinc-800/80 border border-white/10">
                          결과 상태 — 파워 1/2/3그릇: <span className="text-blue-400 font-bold">{actualPlayer.power1 ?? 0}</span> / <span className="text-cyan-400 font-bold">{actualPlayer.power2 ?? 0}</span> / <span className="text-amber-400 font-bold">{actualPlayer.power3 ?? 0}</span>
                        </span>
                      </div>
                    </div>
                  )}
                  {pending.appliedItems && pending.appliedItems.length > 0 && (
                    <div className="pt-4 border-t border-white/10">
                      <div className="text-xs text-zinc-400 mb-2">받은 수익:</div>
                      <div className="flex flex-wrap gap-2">
                        {pending.appliedItems.map((item, idx) => (
                          <div
                            key={idx}
                            className={`px-2 py-1 rounded text-xs font-bold ${item.type === 'power' ? 'bg-blue-500/20 text-blue-400' : 'bg-cyan-500/20 text-cyan-400'
                              }`}
                          >
                            {item.amount} {item.type === 'power' ? 'P' : 'T'}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <AlertDialogFooter className="flex justify-between">
                  {pending.appliedItems && pending.appliedItems.length > 0 && (
                    <Button
                      variant="outline"
                      className="bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20"
                      onClick={() => {
                        if (gameId) {
                          GameClient.undoIncomeItem(gameId);
                        }
                      }}
                    >
                      Undo
                    </Button>
                  )}
                  <div className="flex gap-2 ml-auto">
                    {pending.incomeItems.length === 0 && (
                      <AlertDialogAction
                        className="bg-green-600 hover:bg-green-500 text-white font-bold"
                        onClick={(e) => {
                          e.preventDefault();
                          if (gameId) {
                            GameClient.finishIncomeSelection(gameId);
                          }
                        }}
                      >
                        Finish
                      </AlertDialogAction>
                    )}
                  </div>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
        })()}

        {/* 종족 선택 토글 버튼은 GameBoard의 Round 표시 영역에 추가됨 */}

        {/* 종족 선택 패널 (토글) */}
        {isFactionSelectOpen && ((game.currentPhase === 'startingMines' || game.currentPhase === 'factionSelect') && currentPlayer && !currentPlayer.faction) && (
          <div className={`absolute top-20 z-50 w-96 max-h-[80vh] overflow-y-auto bg-zinc-900/95 border border-zinc-700 rounded-xl p-4 shadow-2xl transition-all duration-300 ease-in-out ${isSidebarOpen ? 'right-[356px]' : 'right-4'}`}>
            <FactionSelect
              game={game}
              playerId={playerId}
              onSelectFaction={(factionId, turnOrder) => GameClient.selectFaction(gameId!, factionId, turnOrder)}
              onConfirm={() => {
                if (game.currentPhase === 'factionSelect') {
                  GameClient.confirmFactions(gameId!);
                }
                setIsFactionSelectOpen(false);
              }}
            />
          </div>
        )}

      </main>

      {/* Right Sidebar */}
      <div
        className={`
        ${isSidebarOpen ? 'translate-x-0 opacity-100 md:relative fixed' : 'w-0 translate-x-full lg:translate-x-0 lg:w-0 opacity-0 overflow-hidden pointer-events-none fixed'}
        right-0 top-0 bottom-0 z-[80]
        transition-[transform,opacity] duration-300 ease-in-out
        border-l border-border bg-card/95 backdrop-blur-sm lg:bg-card flex flex-col shadow-2xl lg:shadow-none
        max-w-[85vw] md:max-w-none
        relative
      `}
        style={isSidebarOpen ? { width: sidebarWidth } : undefined}
      >
        {/* 사이드바 너비 리사이즈 핸들 (왼쪽 가장자리) */}
        {isSidebarOpen && (
          <div
            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors z-[125] hidden md:block"
            title="드래그하여 너비 조절"
            onMouseDown={startSidebarResize}
          />
        )}
        {/* 종족 비딩 패널: 상태창+로그 영역을 통째로 덮는 오버레이(가운데 맵/미니뷰는 그대로 보임) */}
        {game.currentPhase === 'factionBidding' && (
          <FactionBiddingPanel game={game} gameId={gameId!} playerId={playerId} />
        )}
        {isSidebarOpen && (
          <div className="flex flex-col h-full w-full md:min-w-[308px] overflow-hidden">
            <div className="flex-1 min-h-0 flex flex-col gap-4 p-4 overflow-y-auto custom-scrollbar">
              {/* 연방 구현: GameBoard의 줌 컨트롤 좌측으로 이동됨 */}


              {/* 플레이어 영역: 콘텐츠 높이만 사용(flex-none으로 줄어들지 않음), 빈 공간 없음 */}
              <div className="space-y-2 md:space-y-4 flex-none overflow-visible">
                <div className="space-y-1.5 md:space-y-2">
              {(game.currentPhase === 'factionBidding' && game.factionBidding
                ? playerIdsForFactionBiddingUi(game, game.factionBidding)
                : [...(game.turnOrder ?? Object.keys(game.players))].sort((a, b) => {
                    const pa = game.players[a];
                    const pb = game.players[b];
                    if (pa?.hasPassed && !pb?.hasPassed) return 1;
                    if (!pa?.hasPassed && pb?.hasPassed) return -1;
                    return 0;
                  })
              ).map((id) => {
                const p = game.players[id] as PlayerState | undefined;
                if (!p) return null;
                const fedEntries = getFederationEntries(p);
                const faction = p.faction ? FACTIONS.find((f) => f.id === p.faction) : null;
                const isBot = game.botPlayerIds?.includes(id);
                const isYou = id === playerId && !isBot;
                const isCurrentTurn = game.turnOrder?.[game.currentPlayerIndex] === id;
                const expanded = expandedPlayerId === id;
                const counts = getStructureCountsForPlayer(game, id);
                const incRaw = getNextRoundIncomePreview(id, game, { excludeBonusTiles: true });
                // 마지막 라운드(6)엔 받을 다음 수익이 없으므로 상태창 수익 표시(+N)를 숨긴다(사용자 요청)
                const inc = game.roundNumber >= 6
                  ? { ...incRaw, ore: 0, credits: 0, knowledge: 0, qic: 0, powerTokens: 0, powerCharge: 0 }
                  : incRaw;
                const hasPassed = p.hasPassed;

                // 연방 건물 파워: (연방 헥스에 포함된 내 건물 파워 / 전체 내 건물 파워).
                // 연방 파워 산정과 동일하게 내 구조물(우주선 제외) + 란티다 기생광산 + 우주정거장을 합산.
                // 파워값: PI/Academy=3(big타일 시 4) / TS·Lab=2 / 광산=1 / 기생광산·우주정거장=1.
                const { fedBuildingPower, totalBuildingPower } = (() => {
                  const hasBig = p.techTiles?.includes('tech-big-4str') ?? false;
                  const structPower = (s: StructureType | null | undefined): number => {
                    switch (s) {
                      case 'planetary_institute':
                      case 'academy': return hasBig ? 4 : 3;
                      case 'trading_station':
                      case 'research_lab': return 2;
                      case 'mine':
                      case 'lost_planet_mine': return 1;
                      default: return 0;
                    }
                  };
                  const fedHexes = new Set(game.playerFederationHexes?.[id] ?? []);
                  let total = 0, fed = 0;
                  for (const t of game.map) {
                    let tp = 0;
                    if (t.ownerId === id && t.structure && t.structure !== 'ship') tp += structPower(t.structure);
                    if (t.parasiticMine?.ownerId === id) tp += 1;
                    if (t.spaceStation?.ownerId === id) tp += 1;
                    if (tp === 0) continue;
                    total += tp;
                    if (fedHexes.has(t.id)) fed += tp;
                  }
                  return { fedBuildingPower: fed, totalBuildingPower: total };
                })();

                const renderActionBtn = (
                  isUsed: boolean,
                  canUse: boolean,
                  actionId: string,
                  label: string,
                  colorStr: string,
                  activeClass: string,
                  title?: string
                ) => {
                  if (canUse && !isUsed) {
                    return (
                      <button
                        key={actionId}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (gameId) {
                            if (actionId === 'bonusAction') {
                              GameClient.useBonusAction(gameId);
                            } else if (actionId === 'ivits-space-station') {
                              setIvitsSpaceStationMode(true);
                            } else if (actionId === 'bescods-advance-lowest') {
                              setBescodsAdvanceLowestOpen(true);
                            } else if (actionId === 'ambas-swap-pi-mine') {
                              setAmbasSwapPiMineMode(true);
                            } else if (actionId === 'moweyip-place-ring') {
                              setMoweyipPlaceRingMode(true);
                            } else if (actionId === 'firaks-downgrade') {
                              setFiraksDowngradeMode(true);
                            } else if (
                              actionId === 'tech-act-4p' ||
                              actionId === 'adv-act-3k' ||
                              actionId === 'adv-act-3o' ||
                              actionId === 'adv-act-1q-5c'
                            ) {
                              GameClient.useTechAction(gameId, actionId);
                            } else {
                              GameClient.useSpecialAction(gameId, actionId);
                            }
                            // 액션 선택 후 상태창(상세 팝오버) 자동 닫기 — 맵 클릭이 필요한 액션(우주정거장/교환/링/다운그레이드 등)을 위해
                            setExpandedPlayerId(null);
                          }
                        }}
                        className={`px-1 py-0.5 rounded-[3px] text-[9px] border cursor-pointer active:scale-95 transition-all shadow-sm ${activeClass}`}
                        title={title}
                      >
                        {label} 사용
                      </button>
                    );
                  }
                  return (
                    <span
                      key={actionId}
                      className={`px-1 py-0.5 rounded-[3px] text-[9px] border transition-colors ${isUsed ? 'bg-zinc-800/60 text-zinc-500 line-through border-transparent' : colorStr}`}
                      title={title}
                    >
                      {label}
                    </span>
                  );
                };

                const bonusForDetail = p.bonusTile ? ALL_BONUS_TILES.find((t) => t.id === p.bonusTile) : undefined;
                const hasBonusDetailRow = !!(bonusForDetail?.specialAction);
                const hasPIForDetail = game.map?.some((t: any) => t.ownerId === id && t.structure === 'planetary_institute') ?? false;
                const ownedPlanetCounts = (() => {
                  const counts: Partial<Record<PlanetType, number>> = {};
                  game.map
                    ?.filter((t) => t.ownerId === id && t.structure && t.structure !== 'ship')
                    .forEach((t) => {
                      // 잊혀진 행성(검은 행성)은 우주(space) 칸에 lost_planet_mine으로 놓이므로 tile.type이 아닌 구조물로 카운트
                      if (t.structure === 'lost_planet_mine') { counts['lost_planet'] = (counts['lost_planet'] ?? 0) + 1; return; }
                      const type = t.type as PlanetType;
                      if (type === 'space' || type === 'deep_space' || type.startsWith('ship_') || type === 'lost_fleet_ship') return;
                      counts[type] = (counts[type] ?? 0) + 1;
                    });
                  // 인공물 가상 광산(소행성/원시행성)도 보유 행성 유형으로 표시 (점수 계산과 일관)
                  const pl = game.players[id];
                  if (pl?.virtualMineAsteroid) counts['asteroid'] = (counts['asteroid'] ?? 0) + 1;
                  if (pl?.virtualMineProto) counts['proto'] = (counts['proto'] ?? 0) + 1;
                  return counts;
                })();
                const planetLabel = (type: PlanetType) => {
                  if (type === 'terra') return '파';
                  if (type === 'volcanic') return '빨';
                  if (type === 'titanium') return '검';
                  if (type === 'swamp') return '갈';
                  if (type === 'ice') return '흰';
                  if (type === 'desert') return '노';
                  if (type === 'oxide') return '주';
                  if (type === 'gaia') return '가이아';
                  if (type === 'asteroid') return '소행성';
                  if (type === 'proto') return '원시';
                  if (type === 'lost_planet') return '검은';
                  return type;
                };
                const homePlanet = faction?.homePlanet;
                const terraformStepFor = (type: PlanetType) => {
                  if (!p.faction) return homePlanet ? getTerraformSteps(homePlanet, type) : 0;
                  return getTerraformStepsForFaction(game, p.faction, type);
                };
                const homeTypes = homePlanet && HOME_PLANETS.includes(homePlanet) ? [homePlanet] : [];
                const stepTypes = HOME_PLANETS.filter((type) => type !== homePlanet);
                const neutralTypes = ['gaia', 'asteroid', 'proto', 'lost_planet'] as PlanetType[];
                const planetGroups: Array<{ label: string; types: PlanetType[] }> = [
                  { label: '홈', types: homeTypes },
                  { label: '1', types: stepTypes.filter((type) => terraformStepFor(type) === 1) },
                  { label: '2', types: stepTypes.filter((type) => terraformStepFor(type) === 2) },
                  { label: '3', types: stepTypes.filter((type) => terraformStepFor(type) >= 3) },
                  { label: '중립', types: neutralTypes },
                ].filter((group) => group.types.length > 0);
                const allDisplayedPlanetTypes: PlanetType[] = [...HOME_PLANETS, 'gaia', 'asteroid', 'proto', 'lost_planet'];
                const ownedPlanetTypeCount = allDisplayedPlanetTypes
                  .filter((type) => (ownedPlanetCounts[type] ?? 0) > 0)
                  .length;
                // 섹터 점유: 내 건물 + 란티다 기생 광산 (서버 tileOccupiesSector·fm_sectors와 동일하게 기생 포함)
                const sectorOccupyingTiles = game.map?.filter((t) => (t.ownerId === id && t.structure && t.structure !== 'ship') || t.parasiticMine?.ownerId === id) ?? [];
                const occupiedSectorCount = new Set(
                  sectorOccupyingTiles
                    .filter((t) => typeof t.sector === 'number' && t.sector < 11)
                    .map((t) => t.sector)
                ).size;
                const occupiedOuterSectorCount = new Set(
                  sectorOccupyingTiles
                    .filter((t) => typeof t.sector === 'number' && t.sector >= 11 && t.sector < 20)
                    .map((t) => t.sector)
                ).size;
                const satelliteCount = Object.values(game.satellites ?? {})
                  .filter((ids) => Array.isArray(ids) && ids.includes(id))
                  .length;
                const hasPlanetTypeDetailRow = true;
                const canDoMainForDetail = isYou && isCurrentTurn && !game.hasDoneMainAction;
                const hasSpecialDetailRow = (() => {
                  if ((p.techTiles ?? []).some((tid) => {
                    const tile = ALL_TECH_TILES.find((t) => t.id === tid) ?? ALL_ADVANCED_TECH_TILES.find((t) => t.id === tid);
                    return !!tile?.specialAction;
                  })) return true;
                  if (game.map?.some((t) => t.ownerId === id && t.structure === 'academy' && t.academyType === 'right')) return true;
                  if (p.faction === 'bescods' || p.faction === 'ivits' || p.faction === 'gleens' || p.faction === 'space_giants') return true;
                  if (p.faction === 'moweyip' && hasPIForDetail) return true;
                  if (p.faction === 'ambas' && hasPIForDetail) return true;
                  if (p.faction === 'firaks' && hasPIForDetail) return true;
                  if (p.faction === 'tinkeroids' && p.tinkeroidRoundSpecialId) return true;
                  if (p.faction === 'bal_tak') {
                    if ((p.balTakGaiaformersUsedForQic ?? 0) > 0) return true;
                  }
                  return false;
                })();
                const hasPlayerDetailContent =
                  hasPlanetTypeDetailRow ||
                  fedEntries.length > 0 ||
                  (p.techTiles?.length ?? 0) > 0 ||
                  (p.artifacts?.length ?? 0) > 0 ||
                  hasBonusDetailRow ||
                  hasSpecialDetailRow;

                return (
                  <Popover key={id} open={expandedPlayerId === id} onOpenChange={(open) => setExpandedPlayerId(open ? id : null)}>
                    <div
                      onMouseEnter={() => setHoveredPlayerId(id)}
                      onMouseLeave={() => setHoveredPlayerId(null)}
                      className={`rounded-lg border text-sm overflow-visible relative transition-all duration-300
                    ${isCurrentTurn && !hasPassed
                          ? 'border-amber-400/80 bg-amber-500/10 shadow-[0_0_12px_rgba(251,191,36,0.3)]'
                          : isYou
                            ? 'bg-primary/15 border-primary/50'
                            : 'bg-muted/50 border-border'
                        } ${hasPassed ? 'grayscale opacity-60 brightness-[0.7]' : ''}`}
                    >
                      <PopoverTrigger asChild>
                        <div
                          role="button"
                          tabIndex={0}
                          className={`w-full text-left flex items-stretch min-w-0 hover:bg-white/5 transition-colors focus:outline-none rounded-lg group ${hasPassed ? 'cursor-default' : ''}`}
                        >
                          {/* Left: Main info, Buildings, Resources */}
                          <div className="flex-1 flex flex-col p-1.5 md:p-2.5 pr-1 md:pr-2 min-w-0">
                            {/* Score / Name / Bid Row */}
                            <div className="flex items-center gap-2 min-w-0 mb-1 md:mb-1.5">
                              <span className="w-5 md:w-7 text-left text-sm md:text-base font-bold text-white flex-shrink-0 tabular-nums leading-none">
                                {p.score}
                              </span>

                              <div className="flex items-center gap-1 md:gap-1.5 min-w-0 flex-1">
                                <div className="w-2 h-2 md:w-2.5 md:h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: faction?.color ?? '#666' }} />
                                <span className="truncate font-medium text-xs md:text-sm text-zinc-200">
                                  {game.currentPhase === 'factionBidding' && faction && p.selectedTurnOrder != null && (
                                    <span className="text-zinc-500 font-mono tabular-nums mr-1">[{p.selectedTurnOrder}]</span>
                                  )}
                                  {faction ? `${faction.name} (${p.name})` : p.name}
                                </span>

                                {/* Toggles */}
                                {isYou && <span className="text-[8px] md:text-[10px] text-primary flex-shrink-0">(나)</span>}
                                {isCurrentTurn && !hasPassed && (
                                  <span className="flex items-center gap-1 flex-shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shadow-[0_0_6px_rgba(251,191,36,0.8)]" />
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
                                {isYou && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation(); e.preventDefault();
                                      nevlasOreChainRef.current = null;
                                      // Off로 전환 시: Undo All과 동일하게 이번 턴 프리액션 전부 되돌림
                                      if (freeActionMode && gameId) {
                                        const undoCount = game.freeActionUndoStack?.length ?? ((game as any).freeActionUndoState ? 1 : 0);
                                        if (undoCount > 0) GameClient.undoFreeAction(gameId, undoCount);
                                      }
                                      setFreeActionMode(v => !v);
                                    }}
                                    className={`text-[9px] font-black uppercase tracking-tight rounded border px-1.5 py-0.5 leading-none transition-colors ${freeActionMode ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-300 shadow-[0_0_6px_rgba(16,185,129,0.4)]' : 'bg-zinc-800/80 border-zinc-600/60 text-zinc-400 hover:text-zinc-200'}`}
                                    title="프리액션 모드: 켜면 자원(O/K/Q/C)·파워(1·2그릇) 숫자 클릭으로 즉시 변환. 끄면 이번에 한 프리액션을 모두 되돌립니다 (Undo All)"
                                  >
                                    FA {freeActionMode ? 'ON' : 'OFF'}
                                  </button>
                                )}
                                {(p.factionBidVp ?? 0) > 0 && (
                                  <span
                                    className="inline-flex min-w-[2.75rem] items-center justify-center rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] leading-none text-rose-300 font-semibold tabular-nums"
                                    title={`비딩: −${p.factionBidVp}VP`}
                                  >
                                    −{p.factionBidVp}
                                  </span>
                                )}
                                {hasPassed && (
                                  <span className="text-[9px] font-bold text-zinc-500 border border-zinc-700 rounded px-1">PASSED</span>
                                )}
                              </div>
                            </div>

                            {/* Buildings */}
                            <div className="flex justify-between items-baseline mb-0.5 md:mb-1 text-[10px] md:text-xs text-zinc-500 font-mono tracking-tighter md:tracking-normal w-full">
                              M<span className="text-amber-300/90">{counts.physicalMineCount}</span>/{BUILDING_LIMITS.mine}
                              <span className="mx-0.5 md:mx-1">TS</span><span className="text-yellow-400/90">{counts.tsCount}</span>/{BUILDING_LIMITS.trading_station}
                              <span className="mx-0.5 md:mx-1">Lab</span><span className="text-blue-400/90">{counts.labCount}</span>/{BUILDING_LIMITS.research_lab}
                              <span className="mx-0.5 md:mx-1">PI</span><span className="text-purple-400/90">{counts.piCount}</span>/{BUILDING_LIMITS.planetary_institute}
                              <span className="mx-0.5 md:mx-1">A</span><span className="text-indigo-400/90">{counts.academyLeft}+{counts.academyRight}</span>/{BUILDING_LIMITS.academy}
                            </div>

                            {/* Resources & Power / Gaiaformers */}
                            <div className="flex flex-row gap-2 mt-1 border-t border-white/10 pt-1.5">
                              {/* Left: 2x2 Resource Grid (O C / K Q) — 프리액션 모드 시 가능한 변환만 클릭 박스 표시 */}
                              {(() => {
                                const faActive = isYou && freeActionMode;
                                const faIsTak = p.faction === 'taklons';
                                const faNevPI = p.faction === 'nevlas' && (game.map?.some(t => t.ownerId === id && t.structure === 'planetary_institute') ?? false);
                                const faCanPow = (cost: number) =>
                                  faIsTak ? canSpendTaklonsPower(p as any, 3, cost) : faNevPI ? (p.power3 ?? 0) >= Math.ceil(cost / 2) : (p.power3 ?? 0) >= cost;
                                const faCan: Record<'ore' | 'knowledge' | 'qic' | 'credit', boolean> = {
                                  ore: faCanPow(3),
                                  credit: faCanPow(1),
                                  knowledge: faCanPow(4),
                                  qic: faCanPow(4) && !(p.faction === 'gleens' && !game.map?.some(t => t.ownerId === id && t.structure === 'academy' && t.academyType === 'right')),
                                };
                                // w-fit: 그리드 칸 폭과 무관하게 내용물(라벨+숫자+수입)에 정확히 맞는 박스
                                const faCellCls = (kind: 'ore' | 'knowledge' | 'qic' | 'credit') =>
                                  faActive && faCan[kind] ? ' w-fit cursor-pointer rounded ring-1 ring-emerald-400/40 hover:bg-emerald-500/15 px-0.5 -mx-0.5 transition-colors' : '';
                                const faClick = (kind: 'ore' | 'knowledge' | 'qic' | 'credit') =>
                                  faActive && faCan[kind] ? (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); handleFreeActionClick(kind); } : undefined;
                                const faTitle = (kind: 'ore' | 'knowledge' | 'qic' | 'credit', text: string) =>
                                  faActive && faCan[kind] ? text : undefined;
                                return (
                              <div className="grid grid-cols-2 gap-x-2 gap-y-1 w-1/2 tabular-nums">
                                {/* O: Ore */}
                                <div className={`flex items-center justify-start${faCellCls('ore')}`} onClick={faClick('ore')} title={faTitle('ore', '프리액션: 3P → 1O (네뷸라 의회: 한번 더 누르면 3P→2O)')}>
                                  <span className="text-zinc-300 w-[10px] md:w-3 text-xs md:text-sm font-bold shrink-0 text-center">O</span>
                                  <span style={{ color: '#f5f5f0' }} className="font-black text-sm md:text-base ml-0.5 shrink-0 leading-none">{p.ore ?? 0}</span>
                                  {inc.ore > 0 && (
                                    <span className="text-[10px] md:text-xs text-zinc-400 font-medium ml-0.5 shrink-0 leading-none">(+{inc.ore})</span>
                                  )}
                                </div>
                                {/* C: Credits */}
                                <div className={`flex items-center justify-start${faCellCls('credit')}`} onClick={faClick('credit')} title={faTitle('credit', '프리액션: 1P → 1C (네뷸라 의회: O 직후 누르면 2P→1O+1C)')}>
                                  <span className="text-yellow-400 w-[10px] md:w-3 text-xs md:text-sm font-bold shrink-0 text-center">C</span>
                                  <span style={{ color: '#FFE74C' }} className="font-black text-sm md:text-base ml-0.5 shrink-0 leading-none">{p.credits ?? 0}</span>
                                  {inc.credits > 0 && (
                                    <span className="text-[10px] md:text-xs text-zinc-400 font-medium ml-0.5 shrink-0 leading-none">(+{inc.credits})</span>
                                  )}
                                </div>
                                {/* K: Knowledge */}
                                <div className={`flex items-center justify-start${faCellCls('knowledge')}`} onClick={faClick('knowledge')} title={faTitle('knowledge', '프리액션: 4P → 1K')}>
                                  <span className="text-blue-400 w-[10px] md:w-3 text-xs md:text-sm font-bold shrink-0 text-center">K</span>
                                  <span style={{ color: '#2E5EAA' }} className="font-black text-sm md:text-base ml-0.5 shrink-0 leading-none">{p.knowledge ?? 0}</span>
                                  {inc.knowledge > 0 && (
                                    <span className="text-[10px] md:text-xs text-zinc-400 font-medium ml-0.5 shrink-0 leading-none">(+{inc.knowledge})</span>
                                  )}
                                </div>
                                {/* Q: QIC */}
                                <div className={`flex items-center justify-start${faCellCls('qic')}`} onClick={faClick('qic')} title={faTitle('qic', '프리액션: 4P → 1Q')}>
                                  <span className="text-green-400 w-[10px] md:w-3 text-xs md:text-sm font-bold shrink-0 text-center">Q</span>
                                  <span style={{ color: '#38B000' }} className="font-black text-sm md:text-base ml-0.5 shrink-0 leading-none">{p.qic ?? 0}</span>
                                  {inc.qic > 0 && (
                                    <span className="text-[10px] md:text-xs text-zinc-400 font-medium ml-0.5 shrink-0 leading-none">(+{inc.qic})</span>
                                  )}
                                </div>
                              </div>
                                );
                              })()}

                              {/* Right: Gaiaformer & Power */}
                              <div className="flex flex-col gap-1 w-1/2 justify-center pl-2 border-l border-white/10">
                                {/* Gaiaformers Row & Power Income */}
                                <div className="flex justify-between items-center w-full min-h-[14px]" title="가이아포머 (불 켜진 점: 사용 가능, X: 소행성 파괴, 어두운 점: 맵 배치)">
                                  {(() => {
                                    // 발타크: 프리액션 모드에서 사용 가능한(잠기지 않은) 포머 클릭 → 1포머 → 1QIC
                                    const balTakAvail = (p.gaiaformers ?? 0) - ((p as any).balTakGaiaformersUsedForQic ?? 0);
                                    const canBalTakGf = isYou && freeActionMode && p.faction === 'bal_tak' && balTakAvail >= 1;
                                    return (
                                  <div
                                    className={`flex gap-1.5 items-center${canBalTakGf ? ' cursor-pointer rounded ring-1 ring-emerald-400/40 hover:bg-emerald-500/15 px-0.5 -mx-0.5 transition-colors' : ''}`}
                                    onClick={canBalTakGf ? (e) => { e.stopPropagation(); e.preventDefault(); handleFreeActionClick('baltak-gf'); } : undefined}
                                    title={canBalTakGf ? '프리액션: 가이아포머 1개 → 1QIC (다음 라운드까지 잠김)' : undefined}
                                  >
                                    {(() => {
                                      const gpLevel = p.research?.gaiaProject ?? 0;
                                      const totalGF = gpLevel >= 4 ? 3 : gpLevel >= 3 ? 2 : gpLevel >= 1 ? 1 : 0;
                                      // 발타크: QIC로 보낸 포머는 다음 라운드까지 잠김 → 가이아 보낸 것과 같은 UI(보라 점)로 표시
                                      const lockedGF = p.faction === 'bal_tak' ? ((p as any).balTakGaiaformersUsedForQic ?? 0) : 0;
                                      const availableGF = Math.max(0, (p.gaiaformers ?? 0) - lockedGF);
                                      const destroyedGF = p.destroyedGaiaformers ?? 0;
                                      const onMapGF = Math.max(0, totalGF - availableGF - lockedGF - destroyedGF);

                                      if (totalGF === 0) return <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-tighter leading-none">No GF</span>;

                                      const dots = [];
                                      // 1. Destroyed (Red)
                                      for (let i = 0; i < destroyedGF; i++) {
                                        dots.push(<div key={`d-${i}`} className="w-2.5 h-2.5 rounded-full bg-red-500 shadow-[0_0_3px_rgba(239,68,68,0.4)]" />);
                                      }
                                      // 2. Available (Glow)
                                      for (let i = 0; i < availableGF; i++) {
                                        dots.push(<div key={`a-${i}`} className="w-2.5 h-2.5 rounded-full bg-teal-400 shadow-[0_0_5px_rgba(45,212,191,0.5)] transition-colors" />);
                                      }
                                      // 3. Locked (발타크 QIC 사용분) + On Map (Purple)
                                      for (let i = 0; i < lockedGF + onMapGF; i++) {
                                        dots.push(<div key={`m-${i}`} className="w-2.5 h-2.5 rounded-full bg-purple-500 shadow-[0_0_3px_rgba(168,85,247,0.4)] transition-colors" />);
                                      }

                                      return dots.slice(0, totalGF);
                                    })()}
                                  </div>
                                    );
                                  })()}

                                  <div className="flex items-center gap-1 shrink-0">
                                    {inc.powerTokens > 0 && (
                                      <span className="text-[10px] md:text-xs text-zinc-400 font-bold">+{inc.powerTokens}Tok</span>
                                    )}
                                    {inc.powerCharge > 0 && (
                                      <span className="flex items-center text-[10px] md:text-xs text-zinc-400 font-bold">
                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" className="mr-0.5">
                                          <path d="M3 12a9 9 0 0 1 18 0" />
                                          <path d="M21 12l-4-4M21 12l-4 4" />
                                        </svg>
                                        {inc.powerCharge}
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {/* Power Row */}
                                <div className="flex bg-black/40 rounded px-2 py-1 border border-white/10 items-center justify-between w-full mt-0.5" title="가이아 구역 | 1, 2, 3그릇 파워">
                                  <div className="flex gap-2.5 items-center w-full justify-between">
                                    <span className="flex items-center gap-1 shrink-0" title={p.faction === 'taklons' && (p as any).brainStoneInGaia ? '가이아 구역 (브레인 스톤 포함)' : undefined}>
                                      <span className="text-emerald-400 font-black text-sm md:text-base leading-none">{p.gaiaformerPower ?? 0}</span>
                                      {p.faction === 'taklons' && (p as any).brainStoneInGaia && (
                                        <span className="text-[10px] leading-none" aria-hidden>🧠</span>
                                      )}
                                    </span>
                                    <div className="w-[1px] h-4 bg-white/20 shrink-0" />
                                    <div className="flex gap-2.5 items-center justify-between w-full">
                                      {(() => {
                                        const faBoxCls = ' cursor-pointer rounded ring-1 ring-emerald-400/40 hover:bg-emerald-500/15 px-0.5 -mx-0.5 transition-colors';
                                        const brainIn2 = p.faction === 'taklons' && (p as any).brainStoneBowl === 2 && !(p as any).brainStoneInGaia;
                                        // 제노스는 1O→토큰이 3그릇으로 가므로 1그릇 대신 3그릇에 클릭 박스
                                        const canBowl1 = isYou && freeActionMode && p.faction !== 'xenos' && (p.ore ?? 0) >= 1;
                                        const canBowl2 = isYou && freeActionMode && (p.power2 ?? 0) >= (brainIn2 ? 1 : 2);
                                        const canBowl3 = isYou && freeActionMode && p.faction === 'xenos' && (p.ore ?? 0) >= 1;
                                        return (
                                          <>
                                      <span
                                        className={`flex items-center gap-0.5${canBowl1 ? faBoxCls : ''}`}
                                        onClick={canBowl1 ? (e) => { e.stopPropagation(); e.preventDefault(); handleFreeActionClick('bowl1'); } : undefined}
                                        title={canBowl1 ? '프리액션: 1O → 토큰 1개 (1그릇)' : undefined}
                                      >
                                        <span className="text-blue-400 font-black text-sm md:text-base leading-none">{p.power1 ?? 0}</span>
                                        {p.faction === 'taklons' && (p as any).brainStoneBowl === 1 && !(p as any).brainStoneInGaia && (
                                          <span className="text-[10px] leading-none">🧠</span>
                                        )}
                                      </span>
                                      <span
                                        className={`flex items-center gap-0.5${canBowl2 ? faBoxCls : ''}`}
                                        onClick={canBowl2 ? (e) => { e.stopPropagation(); e.preventDefault(); handleFreeActionClick('bowl2'); } : undefined}
                                        title={canBowl2 ? '프리액션: 태우기 (2그릇 1개 소모 + 1개 3그릇 이동)' : undefined}
                                      >
                                        <span className="text-cyan-400 font-black text-sm md:text-base leading-none">{p.power2 ?? 0}</span>
                                        {p.faction === 'taklons' && (p as any).brainStoneBowl === 2 && !(p as any).brainStoneInGaia && (
                                          <span className="text-[10px] leading-none">🧠</span>
                                        )}
                                      </span>
                                      <span
                                        className={`flex items-center gap-0.5${canBowl3 ? faBoxCls : ''}`}
                                        onClick={canBowl3 ? (e) => { e.stopPropagation(); e.preventDefault(); handleFreeActionClick('bowl3'); } : undefined}
                                        title={canBowl3 ? '프리액션: 1O → 토큰 1개 (제노스: 3그릇으로)' : undefined}
                                      >
                                        <span className="text-amber-400 font-black text-sm md:text-base leading-none">{p.power3 ?? 0}</span>
                                        {p.faction === 'taklons' && (p as any).brainStoneBowl === 3 && !(p as any).brainStoneInGaia && (
                                          <span className="text-[10px] leading-none">🧠</span>
                                        )}
                                      </span>
                                          </>
                                        );
                                      })()}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Right Edge: Pass Tile Image + Chevron (spanning full height) */}
                          <div className="flex flex-col items-center justify-center p-2 border-l border-white/5 bg-black/10 shrink-0 w-[52px]">
                            {p.bonusTile && (() => {
                              const bonusIndex = ALL_BONUS_TILES.findIndex(t => t.id === p.bonusTile);
                              if (bonusIndex === -1) return null;
                              const tile = ALL_BONUS_TILES[bonusIndex];
                              const bonusUsed = !!p.usedBonusAction;
                              // 내 턴, 메인 액션 전, 스페셜 액션이 있는 보너스 타일이면 클릭으로 바로 액션 실행 (상태창 안 열고)
                              const canUseBonus = isYou && isCurrentTurn && !game.hasDoneMainAction && !!tile.specialAction && !bonusUsed;
                              const actionNames: Record<string, string> = { terraform_step: '1테라', gaia_project: '가이아', range_3: '+3거리' };
                              return (
                                <img
                                  src={`/image/BoostTile_${bonusIndex + 1}.jpg`}
                                  alt={tile.label}
                                  onClick={canUseBonus ? (e) => {
                                    e.stopPropagation(); e.preventDefault();
                                    if (!gameId) return;
                                    if (tile.specialAction === 'terraform_step') setIsResearchOpen(false);
                                    GameClient.useBonusAction(gameId);
                                  } : undefined}
                                  className={`w-10 h-auto object-contain rounded ${bonusUsed ? 'grayscale opacity-50 brightness-75' : 'drop-shadow-[0_0_3px_rgba(251,191,36,0.5)]'} ${canUseBonus ? 'cursor-pointer ring-1 ring-emerald-400/50 hover:ring-emerald-300 hover:scale-105 transition-all' : ''}`}
                                  title={canUseBonus ? `보너스 타일 액션 실행: ${actionNames[tile.specialAction!] ?? tile.specialAction}` : `현재 패스 타일: ${tile.label}${bonusUsed ? ' (액션 사용됨)' : ''}`}
                                />
                              );
                            })()}
                          </div>
                        </div>
                      </PopoverTrigger>
                      {expandedPlayerId === id && (
                        <PopoverContent
                          side="left"
                          align="start"
                          className="w-72 bg-zinc-950/95 backdrop-blur border border-white/20 rounded-xl p-3 shadow-[0_0_30px_rgba(0,0,0,0.8)] z-[140] text-[10px] space-y-2"
                          style={{ zoom: playerDetailScale }}
                        >
                          {!hasPlayerDetailContent && (
                            <p className="text-[9px] text-zinc-400 text-center leading-relaxed px-1">
                              이 플레이어의 <span className="text-zinc-300">연방 보상 · 기술 타일 · 인공물 · 보너스/스페셜 액션</span> 상태를 보는 창입니다. 지금은 표시할 항목이 없습니다.
                            </p>
                          )}
                          {hasPlanetTypeDetailRow && (
                            <div className="flex gap-0 items-stretch">
                              <div className="w-[3rem] shrink-0 flex items-center justify-center px-0.5">
                                <span className="text-muted-foreground font-medium text-[9px] leading-snug text-center">행성</span>
                              </div>
                              <div className="w-px self-stretch shrink-0 bg-white/15" aria-hidden />
                              <div className="flex flex-wrap gap-1 flex-1 min-w-0 pl-2 content-center py-0.5">
                                <div className="w-full text-[9px] text-zinc-500 font-bold leading-none flex flex-wrap gap-x-1.5 gap-y-0.5">
                                  <span>유형 {ownedPlanetTypeCount}개</span>
                                  {occupiedSectorCount > 0 && <span>/ 판 {occupiedSectorCount}개</span>}
                                  {occupiedOuterSectorCount > 0 && <span>/ 외각 {occupiedOuterSectorCount}개</span>}
                                  {satelliteCount > 0 && <span>/ 위성 {satelliteCount}개</span>}
                                </div>
                                {planetGroups.map((group, groupIndex) => (
                                  <div key={groupIndex} className="flex flex-wrap items-center gap-0.5">
                                    {groupIndex > 0 && (
                                      <span className="mx-0.5 text-[9px] font-black text-white/20 leading-none">/</span>
                                    )}
                                    {group.types.map((type) => {
                                      const count = ownedPlanetCounts[type] ?? 0;
                                      const isOwned = count > 0;
                                      const showCount = type === 'gaia' || type === 'asteroid' || count > 1;
                                      const isThreeStep = group.label === '3';
                                      const color = PLANET_COLORS[type] ?? (type === 'lost_planet' ? '#f8fafc' : '#ffffff');
                                      const label = planetLabel(type);
                                      return (
                                        <div
                                          key={type}
                                          className={`relative inline-flex items-center justify-center rounded-full border transition-all ${isOwned ? 'w-4 h-4 border-white/70 bg-black/40 opacity-100 shadow-[0_0_6px_rgba(255,255,255,0.15)]' : 'w-3.5 h-3.5 border-white/15 bg-black/20 opacity-65'}`}
                                          title={`${label}: ${count}${isThreeStep ? ' (3삽)' : ''}`}
                                        >
                                          <span
                                            className={`${isOwned ? 'w-3 h-3' : 'w-2.5 h-2.5'} rounded-full border border-black/30 shadow-sm`}
                                            style={{ backgroundColor: color }}
                                          />
                                          {showCount && (
                                            <span className={`absolute -bottom-1 -right-1 text-[7px] font-black leading-none rounded px-[2px] ${isOwned ? 'bg-zinc-100 text-black' : 'bg-zinc-800 text-zinc-400'}`}>
                                              {count}
                                            </span>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {fedEntries.length > 0 && (
                            <div className="flex gap-0 items-stretch">
                              <div className="w-[3rem] shrink-0 flex flex-col items-center justify-center px-0.5 gap-0.5">
                                <span className="text-muted-foreground font-medium text-[9px] leading-snug text-center">연방</span>
                                <span
                                  className="text-muted-foreground/80 font-bold text-[8px] leading-none tabular-nums text-center"
                                  title="연방에 포함된 건물 파워 / 전체 건물 파워"
                                >
                                  {fedBuildingPower}/{totalBuildingPower}
                                </span>
                              </div>
                              <div className="w-px self-stretch shrink-0 bg-white/15" aria-hidden />
                              <div className="flex flex-wrap gap-x-1.5 gap-y-0.5 flex-1 min-w-0 pl-2 content-center py-0.5">
                                {fedEntries.map((f, i) => {
                                  const reward = FEDERATION_REWARDS.find((r) => r.id === f.rewardId) || SPACESHIP_FEDERATION_REWARDS.find((r) => r.id === f.rewardId) || (f.rewardId === GLEENS_FEDERATION_REWARD.id ? GLEENS_FEDERATION_REWARD : undefined);
                                  const label = reward?.label ?? f.rewardId;

                                  // Determine image index
                                  let imgIdx = -1;
                                  if (f.rewardId === GLEENS_FEDERATION_REWARD.id) {
                                    imgIdx = 15;
                                  } else {
                                    const regIdx = FEDERATION_REWARDS.findIndex(r => r.id === f.rewardId);
                                    if (regIdx !== -1) {
                                      imgIdx = regIdx + 1;
                                    } else {
                                      const shipIdx = SPACESHIP_FEDERATION_REWARDS.findIndex(r => r.id === f.rewardId);
                                      if (shipIdx !== -1) imgIdx = shipIdx + 7;
                                    }
                                  }
                                  const imgUrl = imgIdx !== -1 ? `/image/Federation_${imgIdx}.gif` : null;

                                  return (
                                    <div
                                      key={`${f.rewardId}-${i}`}
                                      className="relative group cursor-help"
                                      title={`${label} (${f.isGreen ? '미사용' : '사용됨'})`}
                                    >
                                      {imgUrl ? (
                                        <img
                                          src={imgUrl}
                                          className={`h-[32px] w-auto object-contain border border-white/10 rounded transition-all ${f.isGreen ? 'brightness-110 saturate-[1.1]' : 'grayscale opacity-60 brightness-75'}`}
                                          alt={label}
                                        />
                                      ) : (
                                        <Badge variant="outline" className={`text-[8px] px-1 py-0 ${f.isGreen ? 'bg-primary/20 border-primary/30 text-primary' : 'bg-zinc-800 border-zinc-700 text-zinc-300'}`}>
                                          {label}
                                        </Badge>
                                      )}
                                      {/* 사용 여부는 흑백 대신 점 마커로 구분 (정보 가독성 유지): 미사용=초록, 사용=빨강 */}
                                      <div className={`absolute -top-1 -right-1 w-2 h-2 rounded-full border border-black shadow-sm ${f.isGreen ? 'bg-green-500' : 'bg-red-500'}`} />
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                          {(p.techTiles?.length ?? 0) > 0 && (
                            <div className="flex gap-0 items-stretch">
                              <div className="w-[3rem] shrink-0 flex items-center justify-center px-0.5">
                                <span className="text-muted-foreground font-medium text-[9px] leading-snug text-center">기술 타일</span>
                              </div>
                              <div className="w-px self-stretch shrink-0 bg-white/15" aria-hidden />
                              <div className="flex flex-wrap gap-1.5 flex-1 min-w-0 pl-2 content-center py-0.5">
                                {(p.techTiles ?? []).map((tileId) => {
                                  const tile = ALL_TECH_TILES.find((t) => t.id === tileId) ??
                                    SHIP_TECH_TILES.find((t) => t.id === tileId) ??
                                    ALL_ADVANCED_TECH_TILES.find((t) => t.id === tileId);
                                  const covered = isTechTileCovered(p, tileId);

                                  if (!tile?.image) {
                                    const isAdv = tileId.startsWith('adv-');
                                    return (
                                      <span
                                        key={tileId}
                                        className={`px-1.5 py-0.5 rounded text-[9px] ${covered ? 'bg-zinc-700/60 text-zinc-500 line-through' : isAdv ? 'bg-cyan-900/50 text-cyan-300 border border-cyan-500/30' : 'bg-yellow-900/30 text-yellow-200/90 border border-yellow-500/20'}`}
                                        title={tile?.description}
                                      >
                                        {tile?.label ?? tileId}
                                      </span>
                                    );
                                  }

                                  return (
                                    <div key={tileId} className="relative group cursor-help" title={`${tile.label}: ${tile.description}${covered ? ' (덮힘)' : ''}`}>
                                      <img
                                        src={tile.image}
                                        alt={tile.label}
                                        className={`w-10 h-auto object-contain rounded border border-white/10 transition-all ${covered ? 'grayscale opacity-60 brightness-75' : 'hover:scale-110 shadow-sm shadow-black'}`}
                                      />
                                      {covered && (
                                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                          <div className="w-full h-0.5 bg-red-500/50 rotate-45" />
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                          {(p.artifacts?.length ?? 0) > 0 && (
                            <div className="flex gap-0 items-stretch">
                              <div className="w-[3rem] shrink-0 flex items-center justify-center px-0.5">
                                <span className="text-muted-foreground font-medium text-[9px] leading-snug text-center">인공물</span>
                              </div>
                              <div className="w-px self-stretch shrink-0 bg-white/15" aria-hidden />
                              <div className="flex flex-wrap gap-1 flex-1 min-w-0 pl-2 content-center py-0.5">
                                {(p.artifacts ?? []).map((aid) => {
                                  const art = ARTIFACTS.find((a) => a.id === aid);
                                  const artIndex = ARTIFACTS.findIndex((a) => a.id === aid);
                                  const artImgUrl = artIndex !== -1 ? `/image/Art${artIndex + 1}.png` : null;
                                  return art ? (
                                    <div key={aid} className="relative group cursor-help" title={`${art.label}: ${art.description}`}>
                                      {artImgUrl ? (
                                        <img
                                          src={artImgUrl}
                                          alt={art.label}
                                          className="w-10 h-auto object-contain rounded border border-purple-500/30 bg-purple-900/20 hover:scale-110 shadow-sm shadow-black transition-all"
                                        />
                                      ) : (
                                        <span className="px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-200 text-[9px]">{art.label}</span>
                                      )}
                                      {/* Tooltip */}
                                      <div className="absolute top-full mt-2 left-1/2 -translate-x-1/2 hidden group-hover:block z-[110] w-48 p-2 bg-zinc-950 border border-purple-500/20 rounded-lg shadow-2xl">
                                        <div className="text-[10px] font-black text-purple-400 mb-1 uppercase pb-1 border-b border-white/5">
                                          {art.label}
                                        </div>
                                        <p className="text-[10px] text-zinc-300 leading-relaxed font-medium">
                                          {art.description}
                                        </p>
                                      </div>
                                    </div>
                                  ) : null;
                                })}
                              </div>
                            </div>
                          )}
                          {hasBonusDetailRow && bonusForDetail?.specialAction && (() => {
                            const bonus = bonusForDetail;
                            const actionNames: Record<string, string> = {
                              'terraform_step': '1테라',
                              'gaia_project': '가이아',
                              'range_3': '+3거리'
                            };
                            const actionLabel = actionNames[bonus.specialAction!] || bonus.specialAction;
                            const isUsed = p.usedBonusAction;
                            const canUse = isYou && isCurrentTurn && !game.hasDoneMainAction;
                            return (
                              <div className="flex gap-0 items-stretch">
                                <div className="w-[3rem] shrink-0 flex items-center justify-center px-0.5">
                                  <span className="text-muted-foreground font-medium text-[9px] leading-snug text-center">보너스</span>
                                </div>
                                <div className="w-px self-stretch shrink-0 bg-white/15" aria-hidden />
                                <div className="flex flex-wrap gap-1 flex-1 min-w-0 pl-2 content-center py-0.5">
                                  {renderActionBtn(
                                    isUsed,
                                    canUse,
                                    'bonusAction',
                                    `보너스 Special: ${actionLabel}`,
                                    'bg-emerald-500/20 text-emerald-400 border-emerald-500/30 font-bold',
                                    'bg-emerald-600 hover:bg-emerald-500 text-white font-bold',
                                    `보너스 타일 액션: ${actionLabel}`
                                  )}
                                </div>
                              </div>
                            );
                          })()}

                          {/* Unified Special Actions Status */}
                          {(() => {
                                const actionNodes: React.ReactNode[] = [];
                                const canDoMain = isYou && isCurrentTurn && !game.hasDoneMainAction;

                                // Tech Tile Special Actions
                                (p.techTiles ?? []).forEach((tid) => {
                                  const tile = ALL_TECH_TILES.find((t) => t.id === tid) ?? ALL_ADVANCED_TECH_TILES.find((t) => t.id === tid);
                                  if (!tile?.specialAction) return;
                                  const isUsed = p.usedTechActions?.includes(tid) ?? false;
                                  actionNodes.push(
                                    renderActionBtn(
                                      isUsed, canDoMain, tid, `기술:${tile.label}`,
                                      'bg-amber-500/20 text-amber-300 border-amber-500/30 font-bold',
                                      'bg-amber-500/20 text-amber-300 border-amber-500/30 font-bold hover:bg-amber-500/40',
                                      `기술 타일: ${tile.label}`
                                    )
                                  );
                                });

                                // Academy (Right)
                                const hasAcademyRight = game.map?.some(t => t.ownerId === id && t.structure === 'academy' && t.academyType === 'right');
                                if (hasAcademyRight) {
                                  const isUsed = p.usedSpecialActions?.includes('academy-qic') ?? false;
                                  const label = p.faction === 'bal_tak' ? '아카데미(4C)' : '아카데미(QIC)';
                                  actionNodes.push(
                                    renderActionBtn(
                                      isUsed, canDoMain, 'academy-qic', label,
                                      'bg-cyan-500/20 text-cyan-400 border-cyan-500/30 font-bold',
                                      'bg-cyan-500/20 text-cyan-400 border-cyan-500/30 font-bold hover:bg-cyan-500/40'
                                    )
                                  );
                                }

                                // Bescods
                                if (p.faction === 'bescods') {
                                  actionNodes.push(
                                    renderActionBtn(
                                      p.usedSpecialActions?.includes('bescods-advance-lowest') ?? false, canDoMain, 'bescods-advance-lowest', '매안:최저트랙+1',
                                      'bg-blue-500/20 text-blue-300 border-blue-500/30 font-bold',
                                      'bg-blue-500/20 text-blue-300 border-blue-500/30 font-bold hover:bg-blue-500/40'
                                    )
                                  );
                                }

                                // Ivits
                                if (p.faction === 'ivits') {
                                  actionNodes.push(
                                    renderActionBtn(
                                      p.usedIvitsSpaceStationThisRound ?? false, canDoMain, 'ivits-space-station', '하이브:우주정거장',
                                      'bg-orange-500/20 text-orange-300 border-orange-500/40 font-bold',
                                      'bg-orange-500/20 text-orange-300 border-orange-500/40 font-bold hover:bg-orange-500/40'
                                    )
                                  );
                                }

                                // Moweyip
                                const hasPI = game.map?.some((t: any) => t.ownerId === id && t.structure === 'planetary_institute') ?? false;
                                if (p.faction === 'moweyip' && hasPI) {
                                  actionNodes.push(
                                    renderActionBtn(
                                      (p as any).usedSpecialActions?.includes('moweyip-place-ring') ?? false, canDoMain, 'moweyip-place-ring', '모웨이드:링',
                                      'bg-emerald-500/20 text-emerald-400 border-emerald-500/40 font-bold',
                                      'bg-emerald-500/20 text-emerald-400 border-emerald-500/40 font-bold hover:bg-emerald-500/40'
                                    )
                                  );
                                }

                                // Ambas
                                if (p.faction === 'ambas' && hasPI) {
                                  actionNodes.push(
                                    renderActionBtn(
                                      (p as any).usedSpecialActions?.includes('ambas-swap-pi-mine') ?? false, canDoMain, 'ambas-swap-pi-mine', '엠바스:PI-Mine교체',
                                      'bg-amber-500/20 text-amber-300 border-amber-500/40 font-bold',
                                      'bg-amber-500/20 text-amber-300 border-amber-500/40 font-bold hover:bg-amber-500/40'
                                    )
                                  );
                                }

                                // Firaks
                                if (p.faction === 'firaks' && hasPI) {
                                  actionNodes.push(
                                    renderActionBtn(
                                      (p as any).usedSpecialActions?.includes('firaks-downgrade') ?? false, canDoMain, 'firaks-downgrade', '파이락:다운그레이드',
                                      'bg-red-500/20 text-red-400 border-red-500/40 font-bold',
                                      'bg-red-500/20 text-red-400 border-red-500/40 font-bold hover:bg-red-500/40'
                                    )
                                  );
                                }

                                // Gleens
                                if (p.faction === 'gleens') {
                                  actionNodes.push(
                                    renderActionBtn(
                                      (p as any).usedSpecialActions?.includes('gleens-2nav') ?? false, canDoMain, 'gleens-2nav', '글린:+2항해',
                                      'bg-teal-500/20 text-teal-300 border-teal-500/40 font-bold',
                                      'bg-teal-500/20 text-teal-300 border-teal-500/40 font-bold hover:bg-teal-500/40'
                                    )
                                  );
                                }

                                // Space Giants
                                if (p.faction === 'space_giants') {
                                  actionNodes.push(
                                    renderActionBtn(
                                      (p as any).usedSpecialActions?.includes('space_giants-2tf') ?? false, canDoMain, 'space_giants-2tf', '거인:2테라',
                                      'bg-orange-500/20 text-orange-400 border-orange-500/40 font-bold',
                                      'bg-orange-500/20 text-orange-400 border-orange-500/40 font-bold hover:bg-orange-500/40'
                                    )
                                  );
                                }

                                // Tinkeroids
                                if (p.faction === 'tinkeroids' && p.tinkeroidRoundSpecialId) {
                                  actionNodes.push(
                                    renderActionBtn(
                                      (p as any).usedSpecialActions?.includes('tinkeroid-special') ?? false, canDoMain, p.tinkeroidRoundSpecialId, `팅커:${p.tinkeroidRoundSpecialId.replace('tinkeroid-', '')}`,
                                      'bg-pink-500/20 text-pink-300 border-pink-500/40 font-bold',
                                      'bg-pink-500/20 text-pink-300 border-pink-500/40 font-bold hover:bg-pink-500/40'
                                    )
                                  );
                                }

                                // BalTak Manual QIC Conversion (Info + Action)
                                if (p.faction === 'bal_tak') {
                                  if ((p.balTakGaiaformersUsedForQic ?? 0) > 0) {
                                    actionNodes.push(
                                      <span key="bal_tak-qic-info" className="px-1 py-0.5 rounded-[3px] text-[9px] border bg-teal-500/20 text-teal-300 border-teal-500/40 font-bold cursor-help" title="포머를 QIC 대신 사용한 누적 횟수">
                                        포머→QIC:{p.balTakGaiaformersUsedForQic}회
                                      </span>
                                    );
                                  }
                                }

                                if (actionNodes.length === 0) return null;
                                return (
                                  <div className="flex gap-0 items-stretch">
                                    <div className="w-[3rem] shrink-0 flex items-center justify-center px-0.5">
                                      <span className="text-muted-foreground font-medium text-[9px] leading-snug text-center">스페셜</span>
                                    </div>
                                    <div className="w-px self-stretch shrink-0 bg-white/15" aria-hidden />
                                    <div className="flex flex-wrap gap-1 flex-1 min-w-0 pl-2 content-center py-0.5">{actionNodes}</div>
                                  </div>
                                );
                              })()}
                        </PopoverContent>
                      )}
                    </div>
                  </Popover>
                );
              })}
              </div>
            </div>

            </div>

            {/* Game Log — 상태 영역 아래 항상 표시 (L키 하단시트와 별개, 데스크톱만) */}
            <div className="border-t border-white/10 flex-none flex-col hidden md:flex" style={{ height: `${logDockHeightVh}vh` }}>
              <div className="flex items-center justify-between gap-2 shrink-0 px-4 pt-3 pb-2">
                <button
                  type="button"
                  onClick={() => setLogToolsOpen(v => !v)}
                  className={`font-semibold flex items-center gap-2 text-xs md:text-sm rounded px-1 -mx-1 transition-colors hover:text-white ${logToolsOpen ? 'text-blue-300' : ''}`}
                  title="클릭: 최신/라운드 점프 표시"
                >
                  <Clock className="w-3.5 h-3.5 text-blue-400" /> Game Log
                  {logToolsOpen ? <ChevronUp className="w-3 h-3 opacity-60" /> : <ChevronDown className="w-3 h-3 opacity-60" />}
                </button>
                <div className="flex items-center gap-1">
                  {LOG_TEXT_SCALES.map((scale) => (
                    <Button
                      key={scale}
                      type="button"
                      variant={logTextScale === scale ? 'default' : 'outline'}
                      size="sm"
                      className={`h-6 px-1.5 text-[10px] font-black leading-none ${logTextScale === scale ? 'bg-blue-600 hover:bg-blue-500 text-white' : 'border-white/10 bg-zinc-900/60 text-zinc-400 hover:bg-zinc-800 hover:text-white'}`}
                      onClick={() => {
                        setLogTextScale(scale);
                        localStorage.setItem('game-log-text-scale', String(scale));
                      }}
                    >
                      *{scale * 100}
                    </Button>
                  ))}
                  {/* 로그창 높이 조절 (줄이면 플레이어 상태가 더 보임) */}
                  <div className="flex items-center ml-1 border-l border-white/10 pl-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      title="로그창 키우기"
                      disabled={logDockHeightVh >= LOG_DOCK_MAX_VH}
                      className="h-6 w-6 border-white/10 bg-zinc-900/60 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-30"
                      onClick={() => adjustLogDockHeight(6)}
                    >
                      <ChevronUp className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      title="로그창 줄이기 (플레이어 상태 더 보기)"
                      disabled={logDockHeightVh <= LOG_DOCK_MIN_VH}
                      className="h-6 w-6 ml-0.5 border-white/10 bg-zinc-900/60 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-30"
                      onClick={() => adjustLogDockHeight(-6)}
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
              <div
                className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 pb-3"
                onWheel={(e) => e.stopPropagation()}
              >
                {(!game.gameLog || game.gameLog.length === 0) ? (
                  <div className="text-center text-muted-foreground text-xs py-8">
                    No actions yet
                  </div>
                ) : (
                  <GameLog
                    game={game}
                    hideHeader
                    className="w-full"
                    maxHeight="none"
                    textScale={logTextScale}
                    showToolbar={logToolsOpen}
                    onEntryMouseEnter={(tileId) => setHighlightedTileId(tileId)}
                    onEntryMouseLeave={() => setHighlightedTileId(null)}
                    onAiFeedbackClick={openAiFeedbackForAction}
                  />
                )}
              </div>
            </div>

            {/* Free Actions Modal */}
            <FreeActionsDialog
              open={isFreeActionsOpen}
              onOpenChange={setIsFreeActionsOpen}
              game={game}
              playerId={playerId}
              isCurrentTurn={isMyTurn}
              onConvertResource={(type, useBrain) => GameClient.convertResource(gameId!, type, useBrain)}
              onBurnPower={(useBrain) => {
                if (gameId) GameClient.burnPower(gameId, useBrain);
              }}
              onUseBalTakGaiaformerToQic={() => {
                if (gameId) GameClient.useBalTakGaiaformerToQic(gameId);
              }}
              onUndoFreeAction={(steps) => {
                if (gameId) GameClient.undoFreeAction(gameId, steps);
              }}
              onUseHadschHallasPIAction={(actionId) => {
                if (gameId) GameClient.useHadschHallasPIAction(gameId, actionId);
              }}
            />
          </div>
        )}
      </div>

      {game && (
        <AdminModeDialog
          open={isAdminModeOpen}
          onOpenChange={setIsAdminModeOpen}
          game={game}
        />
      )}

      {/* 모바일 전용 로그 버튼 — 도킹 로그는 md미만에서 hidden이고 하단시트는 L키로만 열려서
          터치 기기에선 로그 접근 경로가 없던 문제 수정(우하단 플로팅, 시트 열리면 숨김). 데스크톱은 기존 L키/도킹 유지. */}
      {game && !isLogPanelOpen && (
        <button
          type="button"
          aria-label="게임 로그 열기"
          title="게임 로그"
          onClick={() => setIsLogPanelOpen(true)}
          className="md:hidden fixed right-3 bottom-3 z-[115] h-12 w-12 rounded-full border border-white/15 bg-zinc-900/90 text-blue-300 shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur flex items-center justify-center active:scale-95 transition-transform"
          style={{
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)',
            right: 'calc(env(safe-area-inset-right, 0px) + 0.75rem)',
          }}
        >
          <Clock className="w-5 h-5" />
        </button>
      )}

      {/* L 키: 게임 로그 — 평소 UI 없음, 하단 시트로 절반 정도 올라옴 */}
      <AnimatePresence>
        {isLogPanelOpen && game && (
          <>
            <motion.button
              type="button"
              aria-label="로그 닫기"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[117] bg-black/25 backdrop-blur-[1px]"
              onClick={() => setIsLogPanelOpen(false)}
            />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className={`fixed bottom-0 left-0 right-0 z-[118] flex flex-col h-[min(50vh,540px)] max-h-[55vh] border-t border-white/10 bg-zinc-950/95 backdrop-blur shadow-[0_-8px_32px_rgba(0,0,0,0.5)] ${isSidebarOpen ? 'max-md:!right-[var(--sidebar-w)]' : ''}`}
              style={isSidebarOpen ? ({ ['--sidebar-w' as string]: `${sidebarWidth}px` } as CSSProperties) : undefined}
            >
              <div className="flex items-center justify-between gap-4 shrink-0 border-b border-white/10 px-4 sm:px-6 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Clock className="w-5 h-5 text-blue-400 shrink-0" />
                  <span className="font-black uppercase tracking-[0.2em] text-white text-sm truncate">
                    Game Log
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="flex items-center gap-1">
                    {LOG_TEXT_SCALES.map((scale) => (
                      <Button
                        key={scale}
                        type="button"
                        variant={logTextScale === scale ? 'default' : 'outline'}
                        size="sm"
                        className={`h-7 px-2 text-[10px] font-black leading-none ${logTextScale === scale ? 'bg-blue-600 hover:bg-blue-500 text-white' : 'border-white/10 bg-zinc-900/60 text-zinc-400 hover:bg-zinc-800 hover:text-white'}`}
                        onClick={() => {
                          setLogTextScale(scale);
                          localStorage.setItem('game-log-text-scale', String(scale));
                        }}
                      >
                        *{scale * 100}
                      </Button>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-zinc-400 hover:text-white hover:bg-white/10 shrink-0"
                    onClick={() => setIsLogPanelOpen(false)}
                    title="닫기 (L / Esc)"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              <div
                className="flex-1 min-h-0 overflow-y-auto overscroll-contain custom-scrollbar px-4 sm:px-6 py-3 bg-black/20"
                onWheel={(e) => e.stopPropagation()}
              >
                {(!game.gameLog || game.gameLog.length === 0) ? (
                  <div className="text-center text-muted-foreground text-sm py-12">
                    No actions yet
                  </div>
                ) : (
                  <GameLog
                    game={game}
                    hideHeader
                    className="w-full"
                    maxHeight="none"
                    textScale={logTextScale}
                    onEntryMouseEnter={(tileId) => setHighlightedTileId(tileId)}
                    onEntryMouseLeave={() => setHighlightedTileId(null)}
                    onAiFeedbackClick={openAiFeedbackForAction}
                  />
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(pendingAction || (game && game.hasDoneMainAction && game.turnOrder[game.currentPlayerIndex] === playerId && game.currentPhase === 'main' && !game.pendingTurnEndPlayerId && !game.botPlayerIds?.includes(playerId) && (!game.pendingTFMarsGaiaProject || game.pendingTFMarsGaiaProject.playerId !== playerId) && (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId) && (!game.pendingSpaceshipFedMine || game.pendingSpaceshipFedMine.playerId !== playerId) && (!game.pendingLostPlanet || game.pendingLostPlanet.playerId !== playerId))) && (
          <motion.div
            initial={{ y: -50, x: '-50%', opacity: 0 }}
            animate={{ y: 0, x: '-50%', opacity: 1 }}
            exit={{ y: -50, x: '-50%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-20 z-[130] flex items-center gap-4 p-2 px-4 bg-zinc-900/95 backdrop-blur-xl border border-yellow-500/50 rounded-full shadow-[0_0_30px_rgba(234,179,8,0.2)] max-w-[95vw]"
            style={{
              left: isSidebarOpen ? `calc((100% - ${sidebarWidth}px) / 2)` : '50%',
            }}
          >
            {/* Title & Costs (Left Side) */}
            <div className="flex items-center gap-3 border-r border-white/10 pr-4">
              <div className="flex flex-col shrink-0 mr-2">
                <h3 className="text-yellow-500 font-black uppercase tracking-tighter text-[9px] leading-none">
                  {pendingAction ? 'Confirm Action' : 'Turn Management'}
                </h3>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {pendingAction ? (() => {
                  const c = cost as any;
                  const parts: { key: string; val: number; label: string; cls: string; note?: string }[] = [];
                  if (c?.ore > 0) parts.push({ key: 'ore', val: c.ore, label: 'Ore', cls: c.needsExtraTerraforming ? 'text-red-500' : 'text-orange-500', note: c.terraformSteps > 0 ? `${c.terraformSteps}테라` : undefined });
                  if (c?.credits > 0) parts.push({ key: 'cr', val: c.credits, label: 'Cr', cls: 'text-yellow-500' });
                  if (c?.gaiaformers > 0) parts.push({ key: 'gf', val: c.gaiaformers, label: 'GF', cls: 'text-cyan-400' });
                  if (c?.knowledge > 0) parts.push({ key: 'kn', val: c.knowledge, label: 'Kn', cls: 'text-blue-400' });
                  if (c?.qic > 0) parts.push({ key: 'qic', val: c.qic, label: 'QIC', cls: 'text-green-400' });
                  if (parts.length === 0) {
                    return (
                      <span className="text-emerald-400 font-black text-sm uppercase tracking-wider">
                        {pendingAction.type === 'buildMine' ? 'Free Mine' : '무료'}
                      </span>
                    );
                  }
                  return (
                    <div className="flex items-center gap-3">
                      {parts.map((part) => (
                        <div key={part.key} className="flex items-center gap-1">
                          <span className={`text-base font-black leading-none ${part.cls}`}>{part.val}</span>
                          <span className="text-[8px] uppercase text-zinc-500 font-bold tracking-tighter">{part.label}</span>
                          {part.note && <span className="text-[8px] text-zinc-400">({part.note})</span>}
                        </div>
                      ))}
                    </div>
                  );
                })() : (
                  <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest">
                    {game.pendingShipTechMine && game.pendingShipTechMine.playerId === playerId ? 'Pending Mine Construction' : game.pendingSpaceshipFedMine && game.pendingSpaceshipFedMine.playerId === playerId ? 'Pending Spaceship Fed Mine' : 'Main Action Done'}
                  </span>
                )}
              </div>
            </div>

            {/* Action Buttons (Right Side) */}
            <div className="flex items-center gap-1.5">
              {pendingAction && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-3 border-white/10 hover:bg-white/5 text-[10px] font-black uppercase tracking-tight"
                    onClick={() => setPendingAction(null)}
                  >
                    Undo
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 px-4 bg-yellow-500 text-black hover:bg-yellow-400 text-[10px] font-black uppercase tracking-tight shadow-lg"
                    onClick={handleConfirm}
                  >
                    Confirm
                  </Button>
                  <div className="h-5 w-[1px] bg-white/10 mx-1" />
                </>
              )}

              {/* Reset/End Turn (Integrated inside bar) */}
              {game && game.hasDoneMainAction && game.turnOrder[game.currentPlayerIndex] === playerId && game.currentPhase === 'main' && !game.pendingTurnEndPlayerId && (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId) && (!game.pendingSpaceshipFedMine || game.pendingSpaceshipFedMine.playerId !== playerId) && (!game.pendingLostPlanet || game.pendingLostPlanet.playerId !== playerId) && (!game.players[playerId]?.pendingTerraformSteps || game.players[playerId].pendingTerraformSteps === 0) && (
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-3 border-red-500/30 text-red-500 hover:bg-red-500/10 text-[10px] font-black uppercase tracking-tight"
                    onClick={() => GameClient.resetTurn(gameId!)}
                  >
                    Reset
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 px-4 bg-green-600 text-white hover:bg-green-500 text-[10px] font-black uppercase tracking-tight shadow-lg border-b-2 border-green-800"
                    onClick={async () => {
                      if (gameId) {
                        try {
                          await GameClient.endTurn(gameId);
                        } catch (e: any) {
                          toast({ title: '턴 종료 실패', description: e.message, variant: 'destructive' });
                        }
                      }
                    }}
                  >
                    End Turn
                  </Button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isResearchPinned && (
          <motion.div
            key="research-mini"
            drag
            dragControls={researchDragControls}
            dragListener={false}
            dragMomentum={false}
            initial={researchPos}
            animate={researchPos}
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.1 } }}
            onDragEnd={(_, info) => {
              const newPos = clampMiniPos({ x: researchPos.x + info.offset.x, y: researchPos.y + info.offset.y });
              setResearchPos(newPos);
              if (gameId) localStorage.setItem(`research-pos-${gameId}`, JSON.stringify(newPos));
            }}
            className="fixed z-[110] border border-white/20 bg-zinc-950/90 backdrop-blur-md rounded-xl shadow-2xl overflow-hidden flex flex-col pointer-events-auto left-0 top-0"
            style={{ width: researchMiniWidth, height: researchMiniHeight, maxHeight: '95vh' }}
          >
            <div
              className="bg-blue-900/40 px-3 py-2 flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing border-b border-white/10"
              onPointerDown={(e) => researchDragControls.start(e)}
            >
              <span className="text-[11px] font-black uppercase text-blue-200 flex items-center gap-2 select-none">
                <FlaskConical className="w-3.5 h-3.5" /> Research Board
              </span>
              <Button variant="ghost" size="icon" className="h-5 w-5 text-blue-300 hover:text-white" onClick={() => { setIsResearchPinned(false); localStorage.setItem(`is-research-pinned-${gameId}`, 'false'); }}>
                ✕
              </Button>
            </div>
            <div
              ref={researchMiniScrollRef}
              className="flex-1 min-h-0 h-0 pl-0 pr-[6px] pb-10 overflow-y-auto overflow-x-hidden overscroll-contain custom-scrollbar"
              style={{ WebkitOverflowScrolling: 'touch' }}
              onWheel={(e) => e.stopPropagation()}
            >
              <MiniScaledContent panelWidth={researchMiniWidth}>
                <ResearchBoard
                  game={game}
                  playerId={playerId}
                  isMini={true}
                onUsePowerAction={(actionId) => handleUsePowerAction(actionId)}
                onUseHadschHallasPIAction={(actionId) => GameClient.useHadschHallasPIAction(gameId!, actionId)}
                onUseBalTakGaiaformerToQic={() => GameClient.useBalTakGaiaformerToQic(gameId!)}
                onGainTechTile={(tileId) => GameClient.gainTechTile(gameId!, tileId)}
                onUseTechAction={(tileId) => {
                  if (!isMyTurn || game.currentPhase !== 'main') {
                    toast({ title: '사용 불가', description: '내 턴 메인 단계에서만 사용할 수 있습니다.', variant: 'destructive' });
                    return;
                  }
                  if (game.hasDoneMainAction) {
                    toast({ title: '사용 불가', description: '이미 메인 액션을 사용했습니다.', variant: 'destructive' });
                    return;
                  }
                  GameClient.useTechAction(gameId!, tileId);
                }}
                onAdvanceTech={(trackId) => handleResearchAdvanceTech(trackId)}
                onSelectTechTile={(techTileId, trackId) => {
                  // 미니 R패널에서 선택한 경우: 자동 R창 열고닫기 하지 않도록 플래그 ON
                  selectTechTileWithLevel5Confirm(techTileId, trackId, { fromMini: true });
                }}
                onSelectAdvancedTechTile={(advId, trackId) => GameClient.selectAdvancedTechTile(gameId!, advId, trackId)}
                onConfirmAdvancedTechCover={(coverId) => GameClient.confirmAdvancedTechCover(gameId!, coverId)}
                onTakeTwilightArtifact={(artId) => GameClient.takeTwilightArtifact(gameId!, artId)}
                onUseAcademyQic={() => GameClient.useSpecialAction(gameId!, 'academy-qic')}
                onEndTurn={() => GameClient.endTurn(gameId!)}
                onResetTurn={() => GameClient.resetTurn(gameId!)}
                onUseShipAction={(shipTileId, actionIndex, targetTileId) => handleUseShipAction(shipTileId, actionIndex, targetTileId)}
                />
              </MiniScaledContent>
            </div>
            {/* Right Resize Handle */}
            <div
              className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize shrink-0 hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors z-[120]"
              title="드래그하여 너비 조절"
              onMouseDown={(e) => startResize('research', 'x', e)}
            />
            {/* Bottom Resize Handle */}
            <div
              className="absolute bottom-0 left-0 right-0 h-1.5 cursor-row-resize hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors z-[120]"
              title="드래그하여 높이 조절"
              onMouseDown={(e) => startResize('research', 'y', e)}
            />
            {/* Corner Resize Handle */}
            <div
              className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize hover:bg-blue-500/50 active:bg-blue-500/70 z-[130] flex items-end justify-end p-0.5 group"
              title="드래그하여 대각선 크기 조절"
              onMouseDown={(e) => startResize('research', 'both', e)}
            >
              <div className="w-2 h-2 border-r border-b border-blue-400 group-hover:border-white transition-colors" />
            </div>
          </motion.div>
        )}

        {bonusMiniMounted && (
          <motion.div
            key="bonus-mini"
            drag
            dragControls={bonusDragControls}
            dragListener={false}
            dragMomentum={false}
            initial={bonusPos}
            animate={bonusPos}
            onDragEnd={(_, info) => {
              const newPos = clampMiniPos({ x: bonusPos.x + info.offset.x, y: bonusPos.y + info.offset.y });
              setBonusPos(newPos);
              if (gameId) localStorage.setItem(`bonus-pos-${gameId}`, JSON.stringify(newPos));
            }}
            // 닫아도 언마운트하지 않고 display:none으로만 숨김 → RoundBoard 이미지 DOM 유지(재오픈 즉시 표시)
            className={`fixed z-[110] border border-white/20 bg-zinc-950/90 backdrop-blur-md rounded-xl shadow-2xl overflow-hidden flex flex-col pointer-events-auto left-0 top-0 ${isBonusPinned ? '' : 'hidden'}`}
            style={{ width: bonusMiniWidth, height: bonusMiniHeight, maxHeight: '95vh' }}
          >
            <div
              className="bg-amber-900/40 px-3 py-2 flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing border-b border-white/10"
              onPointerDown={(e) => bonusDragControls.start(e)}
            >
              <span className="text-[11px] font-black uppercase text-amber-200 flex items-center gap-2 select-none">
                <Gift className="w-3.5 h-3.5" /> Tactical Overview
              </span>
              <Button variant="ghost" size="icon" className="h-5 w-5 text-amber-300 hover:text-white" onClick={() => { setIsBonusPinned(false); localStorage.setItem(`is-bonus-pinned-${gameId}`, 'false'); }}>
                ✕
              </Button>
            </div>
            <div
              className="flex-1 min-h-0 h-0 pl-0 pr-[6px] pb-10 overflow-y-auto overflow-x-hidden overscroll-contain custom-scrollbar"
              style={{ WebkitOverflowScrolling: 'touch' }}
              onWheel={(e) => e.stopPropagation()}
            >
              <MiniScaledContent panelWidth={bonusMiniWidth} className="flex flex-col gap-4">
                <RoundBoard
                  game={game}
                  playerId={playerId}
                  isMini={true}
                />
                <div className="h-[1px] bg-white/10 w-full" />
                <BonusTiles
                  game={game}
                  playerId={playerId}
                  isMini={true}
                  onSelectBonusTile={isMyTurnBonusSelection ? ((id) => GameClient.selectBonusTile(gameId!, id)) : isMyTurn ? ((id) => {
                    if (game.roundNumber === 6) {
                      setConfirmPassWithTileId('dummy');
                    } else {
                      setConfirmPassWithTileId(id);
                    }
                  }) : undefined}
                  onUseBonusAction={() => GameClient.useBonusAction(gameId!)}
                />
              </MiniScaledContent>
            </div>
            {/* Right Resize Handle */}
            <div
              className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize shrink-0 hover:bg-amber-500/30 active:bg-amber-500/50 transition-colors z-[120]"
              title="드래그하여 너비 조절"
              onMouseDown={(e) => startResize('bonus', 'x', e)}
            />
            {/* Bottom Resize Handle */}
            <div
              className="absolute bottom-0 left-0 right-0 h-1.5 cursor-row-resize hover:bg-amber-500/30 active:bg-amber-500/50 transition-colors z-[120]"
              title="드래그하여 높이 조절"
              onMouseDown={(e) => startResize('bonus', 'y', e)}
            />
            {/* Corner Resize Handle */}
            <div
              className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize hover:bg-amber-500/50 active:bg-amber-500/70 z-[130] flex items-end justify-end p-0.5 group"
              title="드래그하여 대각선 크기 조절"
              onMouseDown={(e) => startResize('bonus', 'both', e)}
            >
              <div className="w-2 h-2 border-r border-b border-amber-400 group-hover:border-white transition-colors" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <GameEndScoreModal />

      {/* 인게임 채팅 — 하단 좌측, 최상위 레이어. 참가자/관전자만 노출 */}
      {game && gameId && (isSpectator || (!!playerId && !!game.players[playerId])) && (
        <ChatPanel gameId={gameId} game={game} canChat={true} selfId={playerId} />
      )}
    </div>
  );
}
