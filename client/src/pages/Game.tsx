import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useDragControls } from 'framer-motion';
import { useParams, useLocation } from 'wouter';
import { GameClient, getSocket, getStoredPlayerId, getStoredSpectatorId, storePlayerId, type GameState, type PlayerState } from '@/lib/gameClient';

import { ResearchBoard } from '@/components/ResearchBoard';
import { RoundBoard } from '@/components/RoundBoard';
import { GameBoard } from '@/components/GameBoard';
import { BonusTiles } from '@/components/BonusTiles';
import { BonusSelectionModal } from '@/components/BonusSelectionModal';
import { FreeActionsDialog } from '@/components/FreeActionsDialog';

import { PlayerPanel } from '@/components/PlayerPanel';
import { GameLog } from '@/components/GameLog';
import { FactionSelect } from '@/components/FactionSelect';
import { GameLobby } from '@/components/GameLobby';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
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
import { DebugPanel } from '@/components/DebugPanel';
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

import { FACTIONS, RESEARCH_TRACKS, ALL_TECH_TILES, SHIP_TECH_TILES, ALL_ADVANCED_TECH_TILES, ALL_BONUS_TILES, FEDERATION_REWARDS, SPACESHIP_FEDERATION_REWARDS, BUILDING_LIMITS, getTerraformSteps, getTerraformStepsForFaction, getGaiaBaseQic, getTerraformCost, getRange, getEffectiveBaseRange, getDistance, hasNearbyPlayersForTradingDiscount, getFederationEntries, isTechTileCovered, ARTIFACTS, getNextRoundIncomePreview, FINAL_MISSION_LABELS, getFinalMissionValue, getFinalMissionVp } from '@shared/gameConfig';
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
  /** 오른쪽 플레이어 요약: 클릭 시 펼쳐서 연방·기술타일·인공물·Special 사용여부 등 표시 */
  const [expandedPlayerId, setExpandedPlayerId] = useState<string | null>(null);
  /** 맵 줌/팬: 페이즈 전환 시에도 유지 (localStorage 연동) */
  const [mapZoom, setMapZoom] = useState(1);
  const [mapPan, setMapPan] = useState({ x: 0, y: 0 });
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    const saved = localStorage.getItem('is-sidebar-open');
    return saved !== null ? saved === 'true' : true;
  });
  const [isZoomInitialized, setIsZoomInitialized] = useState(false);

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

  // 패스 시 보너스 타일 선택 대기 상태 확인
  const isPendingBonusSelection = game?.pendingBonusSelection === playerId;
  const [highlightedTileId, setHighlightedTileId] = useState<string | null>(null);
  const [advanceTechDialog, setAdvanceTechDialog] = useState<{ open: boolean; trackId: ResearchTrack | null }>({ open: false, trackId: null });
  const [isFactionSelectOpen, setIsFactionSelectOpen] = useState(false);
  /** 트왈라잇 액션2: TS→연구소 업그레이드 시 선택할 교역소 타일 (shipTileId) */
  const [pendingTwilightTSUpgrade, setPendingTwilightTSUpgrade] = useState<string | null>(null);
  /** Rebellion 액션2: 광산→교역소 업그레이드 시 선택할 광산 타일 (shipTileId) */
  const [pendingRebellionMineToTS, setPendingRebellionMineToTS] = useState<string | null>(null);
  /** 테란 의회: 가이아포머 토큰 해택 선택 (4→QIC/K, 3→O, 1→C) */
  const [terranCouncilChoice, setTerranCouncilChoice] = useState({ qic: 0, knowledge: 0, ore: 0, credits: 0 });
  /** 타클론 파워 수신 선택: 브레인 스톤 우선(기본), 의회 시 1그릇 추가 순서 */
  const [powerOfferBrainFirst, setPowerOfferBrainFirst] = useState(true);
  const [powerOfferPiAddFirst, setPowerOfferPiAddFirst] = useState(true);
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
  const [hoveredPlayerId, setHoveredPlayerId] = useState<string | null>(null);
  const [researchPos, setResearchPos] = useState(() => {
    const saved = gameId ? localStorage.getItem(`research-pos-${gameId}`) : null;
    return saved ? JSON.parse(saved) : { x: 20, y: 90 };
  });
  const [bonusPos, setBonusPos] = useState(() => {
    const saved = gameId ? localStorage.getItem(`bonus-pos-${gameId}`) : null;
    return saved ? JSON.parse(saved) : { x: 380, y: 90 };
  });

  const MIN_MINI_WIDTH = 280;
  const MAX_MINI_WIDTH = 600;
  const [researchMiniWidth, setResearchMiniWidth] = useState(() => {
    const saved = gameId ? localStorage.getItem(`research-mini-width-${gameId}`) : null;
    const n = saved ? parseInt(saved, 10) : 340;
    return Math.min(MAX_MINI_WIDTH, Math.max(MIN_MINI_WIDTH, isNaN(n) ? 340 : n));
  });
  const [bonusMiniWidth, setBonusMiniWidth] = useState(() => {
    const saved = gameId ? localStorage.getItem(`bonus-mini-width-${gameId}`) : null;
    const n = saved ? parseInt(saved, 10) : 340;
    return Math.min(MAX_MINI_WIDTH, Math.max(MIN_MINI_WIDTH, isNaN(n) ? 340 : n));
  });

  const researchDragControls = useDragControls();
  const bonusDragControls = useDragControls();
  const [showGameEndScore, setShowGameEndScore] = useState(false);

  const lastResizeWidthRef = useRef<number>(340);
  const startResize = (panel: 'research' | 'bonus', startX: number, startWidth: number) => {
    lastResizeWidthRef.current = startWidth;
    const setWidth = panel === 'research' ? setResearchMiniWidth : setBonusMiniWidth;
    const key = panel === 'research' ? `research-mini-width-${gameId}` : `bonus-mini-width-${gameId}`;
    const onMove = (e: MouseEvent) => {
      const w = Math.min(MAX_MINI_WIDTH, Math.max(MIN_MINI_WIDTH, startWidth + (e.clientX - startX)));
      lastResizeWidthRef.current = w;
      setWidth(w);
      if (gameId) localStorage.setItem(key, String(w));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (gameId) localStorage.setItem(key, String(lastResizeWidthRef.current));
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

  useEffect(() => {
    if (game?.currentPhase === 'gameEnd') {
      setShowGameEndScore(true);
    }
  }, [game?.currentPhase]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key.toLowerCase() === 'f') {
        const isMyTurn = game?.turnOrder[game?.currentPlayerIndex ?? -1] === playerId;
        if (!isMyTurn || game?.currentPhase !== 'main') return;
        setIsFreeActionsOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [game, playerId]);

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
      toast({
        title: '오류',
        description: err.message,
        variant: 'destructive',
      });
    });

    return () => {
      socket.off('connect', fetchGame);
      unsubGame();
      unsubError();
      unsubGameError();
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
  useEffect(() => {
    if (!game || !playerId) return;
    const minePending = game.pendingShipTechMine?.playerId === playerId;
    const trackPending = game.pendingShipTechTrackAdvance?.playerId === playerId;

    if (minePending && !shipTech2TfMineFromMini) {
      // 1단계: R 오버레이 닫고 맵에서 광산 짓게 유도
      if (isResearchOpen) setIsResearchOpen(false);
    }

    if (trackPending && !shipTech2TfMineFromMini) {
      // 2단계: 트랙 올리도록 R 오버레이 자동 오픈
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
  ]);

  // 방장일 경우 현재 턴 플레이어(봇)로 자동 전환하는 기능이 있었으나,
  // 온라인 멀티플레이 시 다른 사람의 턴일 때 방장 화면이 강제로 바뀌는 문제가 있어 제거/주석 처리.
  // 로컬 멀티플레이를 지원하려면 봇 턴일 때만 봇으로 전환되거나 별도의 '로컬 모드' 플래그가 필요합니다.
  useEffect(() => {
    if (!gameId || !game || !isHostSessionRef.current) return;
    const phase = game.currentPhase;
    if (phase === 'lobby' || phase === 'factionSelect' || phase === 'startingMines') return;

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
      if (e.key === 'Escape') {
        setIsResearchOpen(false);
        setIsBonusTilesOpen(false);
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
    if (!cur?.faction && game.isTestMode && (game.currentPhase === 'factionSelect' || game.currentPhase === 'startingMines')) {
      GameClient.selectFaction(gameId, 'ivits');
    }
  }, [game?.currentPhase, game?.isTestMode, game?.players, gameId, playerId]);

  // 연구소/아카데미 건설 시 기술 타일 선택이 R창 안에만 있으므로, 필요 시 R창 자동 오픈
  useEffect(() => {
    if (!game || !playerId) return;
    if (game.botPlayerIds?.includes(playerId)) return; // 봇의 턴을 관전 중일 때는 자동 오픈 방지
    if (game.pendingTechTileSelection?.playerId === playerId) {
      setIsResearchOpen(true);
    }
  }, [game?.pendingTechTileSelection?.playerId, playerId, game?.botPlayerIds]);

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
  // boardgame.io doesn't always use currentPlayerIndex this way in custom setups, 
  // but we'll follow our server logic.
  const isCurrentTurn = game.turnOrder[game.currentPlayerIndex] === playerId;


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
        onSwitchPlayer={playerId === game.hostId ? async (targetPlayerId) => {
          if (!gameId) return;
          const { game: updated } = await GameClient.switchPlayer(gameId, targetPlayerId);
          setGame(updated);
          setPlayerId(targetPlayerId);
          storePlayerId(gameId, targetPlayerId);
        } : undefined}
        onAutoSetupTest={() => {
          if (gameId) GameClient.autoSetupTest(gameId);
        }}
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
                const breakdownTotal = 10 + roundMissionsSum + bonusTilePassSum + techTilesSum + b.finalMissions + b.researchTracks - b.powerReceived + spaceshipsSum + otherSum;
                const totalMatches = breakdownTotal === (player!.score ?? 0);

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
                              {!totalMatches && (
                                <p className="text-[10px] text-amber-400 mt-1">(Breakdown 합계: {breakdownTotal} VP — 서버 총점과 불일치)</p>
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
                                <span className="text-xs font-bold text-zinc-400">Round Missions (합계)</span>
                                <span className="text-sm font-black text-amber-400/90">+{roundMissionsSum} VP</span>
                              </div>
                            )}
                            {bonusTilePassSum !== 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">Bonus Tile Pass (합계)</span>
                                <span className="text-sm font-black text-yellow-400/90">+{bonusTilePassSum} VP</span>
                              </div>
                            )}
                            {techTilesSum !== 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">Tech Tiles (합계)</span>
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
                            {b.powerReceived > 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-bold text-red-400/80">Power Reception Tax</span>
                                <span className="text-sm font-black text-red-500">−{b.powerReceived} VP</span>
                              </div>
                            )}
                            {spaceshipsSum !== 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">Spaceships (합계)</span>
                                <span className="text-sm font-black text-cyan-400/90">+{spaceshipsSum} VP</span>
                              </div>
                            )}
                            {(() => {
                              const grouped = b.other.reduce((acc, curr) => {
                                const existing = acc.find(item => item.source === curr.source);
                                if (existing) existing.vp += curr.vp;
                                else acc.push({ ...curr });
                                return acc;
                              }, [] as { source: string; vp: number }[]);

                              return grouped.map((item, i) => (
                                <div key={i} className="p-3 flex justify-between items-center group hover:bg-white/[0.02] transition-colors">
                                  <span className="text-xs font-bold text-zinc-400">{item.source}</span>
                                  <span className="text-sm font-black text-zinc-100">{item.vp >= 0 ? '+' : ''}{item.vp} VP</span>
                                </div>
                              ));
                            })()}
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
                              const bItem = b.roundMissions.find(m => m.round === idx + 1);
                              const vp = bItem?.vp || 0;
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
                                  <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 hover:bg-amber-500/30 font-black tabular-nums">+{vp}</Badge>
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
                                    <span className="text-[10px] font-black text-yellow-500/80">+{vp} <span className="text-[8px] opacity-60">VP</span></span>
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
                            <div className="flex flex-wrap gap-3">
                              {(game.finalMissionIds ?? []).map((mid) => {
                                const img = getFinalMissionImage(mid);
                                const missionVp = b.finalMissionDetails?.find(d => d.missionId === mid)?.vp ?? getFinalMissionVp(game, pid, mid);
                                return (
                                  <div key={mid} className="relative w-36 h-[108px] shrink-0 bg-zinc-900/60 rounded-lg border border-white/5 overflow-hidden group shadow-lg">
                                    {img ? (
                                      <img src={img} alt={mid} className="w-full h-full object-cover" />
                                    ) : (
                                      <div className="w-full h-full flex items-center justify-center text-[10px] text-zinc-600">{mid}</div>
                                    )}
                                    <div className="absolute right-1.5 bottom-1.5">
                                      <span className="text-xs font-black text-blue-400 drop-shadow-md">+{missionVp} VP</span>
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
                                      <span className="text-[10px] font-black text-purple-400/80">+{vp}</span>
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
                                const allRewards = [...FEDERATION_REWARDS, ...SPACESHIP_FEDERATION_REWARDS] as any[];
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
                                    <span className="text-[10px] font-black text-emerald-400/80">+{vp}</span>
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
                              <div className="grid grid-cols-1 gap-2">
                                {(() => {
                                  const grouped = b.spaceships.reduce((acc, curr) => {
                                    const existing = acc.find(t => t.shipTileId === curr.shipTileId);
                                    if (existing) existing.vp += curr.vp;
                                    else acc.push({ ...curr });
                                    return acc;
                                  }, [] as { shipTileId: string; vp: number }[]);

                                  return grouped.map(({ shipTileId, vp }, i) => (
                                    <div key={i} className="bg-zinc-900/30 border border-white/5 rounded-lg p-2.5 flex justify-between items-center group hover:bg-zinc-900/50 transition-colors">
                                      <div className="flex items-center gap-2 text-[10px] font-black text-zinc-400">{shipTileId || 'Spaceship Achievement'}</div>
                                      <Badge className="bg-cyan-500/20 text-cyan-400 border-cyan-500/30 h-5 px-1.5 font-black">+{vp}</Badge>
                                    </div>
                                  ));
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
    const mineCount = owned.filter((t: { structure: string | null }) => t.structure === 'mine' || t.structure === 'lost_planet_mine').length
      + (g.map ?? []).filter((t: { parasiticMine?: { ownerId: string } }) => t.parasiticMine?.ownerId === pid).length
      + (g.players[pid]?.virtualMineAsteroid ? 1 : 0)
      + (g.players[pid]?.virtualMineProto ? 1 : 0);
    const tsCount = owned.filter((t: { structure: string | null }) => t.structure === 'trading_station').length;
    const labCount = owned.filter((t: { structure: string | null }) => t.structure === 'research_lab').length;
    const piCount = owned.filter((t: { structure: string | null }) => t.structure === 'planetary_institute').length;
    const academyLeft = owned.filter((t: { structure: string | null; academyType?: string }) => t.structure === 'academy' && (t.academyType === 'left' || t.academyType == null)).length;
    const academyRight = owned.filter((t: { structure: string | null; academyType?: string }) => t.structure === 'academy' && t.academyType === 'right').length;
    return { mineCount, tsCount, labCount, piCount, academyLeft, academyRight };
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
        const rangeTiles = game.map.filter(t => (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') || t.spaceStation?.ownerId === playerId);
        const minDist = rangeTiles.length > 0 ? Math.min(...rangeTiles.map(t => getDistance(t, tile))) : 0;
        const neededQIC = minDist > baseRange ? Math.ceil((minDist - baseRange) / 2) : 0;
        const freeMine = !!player.nextMineFreeFromShipTech;
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
          if (tile.hasGaiaformer) {
            // 포머 설치된 곳은 Qic 소모 없음
          }
          else if (faction.id === 'gleens') {
            oreCost += 1;
          } else {
            qicCost += getGaiaBaseQic(faction.id);
          }
        } else {
          if (tile.type === 'proto' && faction.homePlanet === 'proto') {
            oreCost = 1;
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
            const terraformOreCost = actualSteps * terraformCostPerStep;
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
        if (tile.structure === 'research_lab' && (action.target === 'academy' || action.target === 'academy_left' || action.target === 'academy_right')) return { ore: 6, credits: 6 };
        return null;
      }
      case 'advanceTech': return { knowledge: 4 };
      default: return null;
    }
  };

  const cost = pendingAction ? getActionCost(pendingAction) : null;

  const isHost = (game && playerId === game.hostId) || isHostSessionRef.current;

  return (
    <div className="flex h-screen overflow-hidden bg-background font-sans text-foreground relative">
      {/* 관전자 배너: 포탈로 body에 렌더해 항상 최상단(z-[9999]), 다른 모달/다이얼로그 위에 표시 */}
      {isSpectator && typeof document !== 'undefined' && createPortal(
        <div className="fixed top-0 left-0 right-0 z-[9999] py-2 px-4 bg-amber-500/95 text-zinc-900 font-bold text-center text-sm flex items-center justify-center gap-3 shadow-lg">
          <Eye className="w-4 h-4 shrink-0" />
          관전 중 — 턴이 돌아오지 않으며, 조작할 수 없습니다.
          <Button
            variant="outline"
            size="sm"
            className="border-zinc-700 bg-white/20 hover:bg-white/30 text-zinc-900 h-8"
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

      {/* Sidebar Overlay (Left) */}
      <div className="absolute left-0 top-0 bottom-0 w-64 md:w-80 transition-all duration-300 flex flex-col z-[50] pointer-events-none *:pointer-events-auto">
        {/* 상단 툴바: 미니뷰 토글 및 (방장 전용) 플레이어 전환 */}
        <div className="p-2 border-border space-y-2 md:bg-transparent backdrop-blur-sm md:backdrop-blur-none block w-full max-w-full relative z-[110]">
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
          {/* 팅커로이드: 라운드 시작 시 고른 Special 1회 사용 (메인 액션 소모 안 함) */}
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

      <main className="flex-1 flex flex-col overflow-auto bg-zinc-900/20">
        <div className="flex-1 min-h-[600px]">
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
            onEclipseBuildAsteroidMine={(tileId) => GameClient.eclipseBuildAsteroidMine(gameId!, tileId)}
            zoomValue={mapZoom}
            panValue={mapPan}
            onZoomChange={setMapZoom}
            onPanChange={setMapPan}
            onBuildMine={(tileId, useGaiaformer) => {
              const player = game.players[playerId!];
              const isPendingGaiaBuild = (player?.pendingGaiaformerTiles || []).includes(tileId);
              if (game.hasDoneMainAction && (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId) && (!game.pendingTFMarsGaiaProject || game.pendingTFMarsGaiaProject.playerId !== playerId) && !isPendingGaiaBuild) return;
              const tile = game.map.find(t => t.id === tileId);
              if (!tile || !playerId) return;

              const faction = FACTIONS.find(f => f.id === player.faction);
              if (!faction) return;

              // Check distance and reachability (+3 거리 보너스 반영)
              const baseRange = getEffectiveBaseRange(player);
              const rangeTiles = game.map.filter(t =>
                (t.ownerId === playerId && t.structure !== null && t.structure !== 'ship') ||
                (t.spaceStation?.ownerId === playerId)
              );
              if (rangeTiles.length === 0) return;

              const minDist = Math.min(...rangeTiles.map(t => getDistance(t, tile)));

              // Calculate maximum possible range with all available QIC
              const maxPossibleRange = baseRange + (player.qic * 2);

              // Check if planet is unreachable even with all QIC
              if (minDist > maxPossibleRange) {
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
              if (!potentialCost) return;

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
            onAdvanceTech={(trackId) => {
              if (game.hasDoneMainAction) return;
              // 테라포밍 액션 사용 중이면 기술 연구 금지
              const player = game.players[playerId!];
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
              // 예쁜 다이얼로그 표시
              setAdvanceTechDialog({ open: true, trackId });
            }}
            onUsePowerAction={(actionId) => {
              if (game.hasDoneMainAction) return;
              GameClient.usePowerAction(gameId!, actionId);
            }}
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
            onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
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
              className="absolute bottom-0 left-0 right-[340px] border-t border-white/10 bg-zinc-950/95 backdrop-blur flex flex-col shrink-0 shadow-[0_-8px_32px_rgba(0,0,0,0.5)] z-[120]"
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
                <div className="px-6 pb-6 pt-2 max-h-[45vh] overflow-y-auto border-t border-white/5 custom-scrollbar bg-black/20">
                  <div className="max-w-6xl mx-auto">
                    <BonusTiles
                      game={game}
                      playerId={playerId}
                      isSelectionMode={isMyTurnBonusSelection}
                      onSelectBonusTile={isMyTurnBonusSelection ? ((tileId) => GameClient.selectBonusTile(gameId!, tileId)) : undefined}
                    />
                  </div>
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
                  onSelectBonusTile={isMyTurn ? ((tileId) => {
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
                  onClick={() => setIsResearchOpen(false)}
                >
                  ✕
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto rounded-2xl shadow-inner bg-black/20 p-2 custom-scrollbar">
                <ResearchBoard
                  game={game}
                  playerId={playerId}
                  onUsePowerAction={(actionId) => {
                    const action = game.powerActions?.find(a => a.id === actionId);
                    const cur = currentPlayer;
                    if (action && cur) {
                      if (action.costType === 'power' && (cur.power3 ?? 0) < action.cost) {
                        toast({ title: '파워 부족', description: '3그릇 파워가 부족합니다.', variant: 'destructive' });
                        return;
                      }
                      if (action.costType === 'qic' && (cur.qic ?? 0) < action.cost) {
                        toast({ title: 'QIC 부족', description: 'QIC가 부족합니다.', variant: 'destructive' });
                        return;
                      }
                    }
                    if (actionId === 'gain-1-step' || actionId === 'gain-2-steps') setIsResearchOpen(false);
                    GameClient.usePowerAction(gameId!, actionId);
                  }}
                  onUseHadschHallasPIAction={(actionId) => {
                    if (game.hasDoneMainAction) return;
                    GameClient.useHadschHallasPIAction(gameId!, actionId);
                  }}
                  onUseBalTakGaiaformerToQic={() => {
                    if (game.hasDoneMainAction) return;
                    GameClient.useBalTakGaiaformerToQic(gameId!);
                  }}
                  onGainTechTile={(tileId) => GameClient.gainTechTile(gameId!, tileId)}
                  onUseTechAction={(tileId) => {
                    if (game.hasDoneMainAction) return;
                    GameClient.useTechAction(gameId!, tileId);
                  }}
                  onAdvanceTech={(trackId) => {
                    // Eclipse 2번(2K+3P)으로 트랙 올리기 대기 중이면 확인 없이 해당 트랙 진행
                    if (game.pendingEclipseResearch?.playerId === playerId) {
                      GameClient.eclipseAdvanceTrack(gameId!, trackId);
                      return;
                    }
                    // 우주선 기술 타일 3개 중 하나 획득 후: 6개 트랙 중 원하는 트랙 1칸 무료 진행
                    if (game.pendingShipTechTrackAdvance?.playerId === playerId) {
                      GameClient.advanceTech(gameId!, trackId);
                      return;
                    }
                    // 고급 기술 타일 획득(덮기) 후: 아무 트랙 1칸 무료 진행
                    if (game.pendingAdvancedTechTrackAdvance?.playerId === playerId) {
                      GameClient.advanceTech(gameId!, trackId);
                      return;
                    }
                    // ↑ pending 상태 체크 이후에만 hasDoneMainAction 가드 적용
                    if (game.hasDoneMainAction) return;
                    const player = game.players[playerId!];
                    if (player.knowledge < 4) {
                      toast({ title: 'Cannot Advance', description: 'Requires 4 Knowledge.', variant: 'destructive' });
                      return;
                    }
                    setIsResearchOpen(false);
                    setAdvanceTechDialog({ open: true, trackId });
                  }}
                  onSelectTechTile={(techTileId, trackId) => {
                    // 오버레이 R창에서 선택한 경우: 자동 닫기/열기 동작하도록 플래그 OFF
                    if (techTileId === 'ship-tech-2tf-mine') setShipTech2TfMineFromMini(false);
                    if (gameId) GameClient.selectTechTile(gameId, techTileId, trackId);
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
                  onUseShipAction={(shipTileId, actionIndex, targetTileId) => {
                    const shipTile = game.map.find(t => t.id === shipTileId);
                    const shipNames: Record<string, string> = { ship_twilight: 'Twilight', ship_rebellion: 'Rebellion', ship_tf_mars: 'TF Mars', ship_eclipse: 'Eclipse' };
                    const actionLabels: Record<string, [string, string, string]> = {
                      ship_twilight: ['1: 3Q → Fed', '2: 2O+3P → TS→Lab', '3: 1K → +3 Range'],
                      ship_rebellion: ['1: 3Q → Tech', '2: 1O+3P → M→TS', '3: 2K → 1Q 2C'],
                      ship_tf_mars: ['1: 2Q → VP', '2: 5P → Gaia', '3: 3P → 1 TF'],
                      ship_eclipse: ['1: 2Q → VP', '2: 2K+3P → Research', '3: 6C → Ast'],
                    };
                    if (actionIndex === 2 && targetTileId == null) {
                      if (shipTile?.type === 'ship_twilight') {
                        setPendingTwilightTSUpgrade(shipTileId);
                        setIsResearchOpen(false);
                        return;
                      }
                      if (shipTile?.type === 'ship_rebellion') {
                        setPendingRebellionMineToTS(shipTileId);
                        setIsResearchOpen(false);
                        return;
                      }
                      // TF Mars 2번(가이아 프로젝트): 토스트 없이 서버만 호출 → 가이아포머 배치/건너뛰기 다이얼로그로 진행
                      GameClient.useShipAction(gameId!, shipTileId, actionIndex, targetTileId);
                      setIsResearchOpen(false);
                    }
                    GameClient.useShipAction(gameId!, shipTileId, actionIndex, targetTileId);
                    setPendingTwilightTSUpgrade(null);
                    setPendingRebellionMineToTS(null);
                    const name = shipNames[shipTile?.type || ''] || shipTile?.type;
                    const label = shipTile?.type ? actionLabels[shipTile.type]?.[actionIndex - 1] : '';
                    toast({ title: `${name} 액션`, description: label || `액션 ${actionIndex}`, variant: 'default' });
                    // Eclipse 2번(연구), Rebellion 1번(3Q 타일)은 R창 유지 → 타일/트랙 선택
                    const keepROpen = (shipTile?.type === 'ship_eclipse' && actionIndex === 2) || (shipTile?.type === 'ship_rebellion' && actionIndex === 1);
                    if (!keepROpen) setIsResearchOpen(false);
                  }}
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
                passBonusVp = new Set(myMapTiles.filter(t => t.structure != null && t.structure !== 'ship' && typeof t.sector === 'number').map(t => t.sector)).size * vp;
                break;
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

                <div className="flex items-center justify-center gap-8 py-6">
                  {currentBonusTile && (
                    <div className="flex flex-col items-center gap-3">
                      <span className="text-[10px] text-orange-400 font-bold uppercase tracking-widest bg-orange-500/10 px-2 py-0.5 rounded">Returning</span>
                      <div className="relative w-20 h-32 rounded-lg overflow-hidden border border-white/10 shadow-lg grayscale opacity-50">
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
                    <div className="text-zinc-600 font-black text-3xl">→</div>
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

          return (
            <AlertDialog open={true} onOpenChange={() => { }}>
              <AlertDialogContent className="bg-zinc-900 border-amber-500/40 max-w-sm">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-amber-300 font-black uppercase tracking-wider">팅커로이드: 라운드 Special 선택</AlertDialogTitle>
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
                      {TINKEROID_SPECIAL_LABELS[actionId as keyof typeof TINKEROID_SPECIAL_LABELS] ?? actionId}
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

        {/* 거리 5 잊혀진 행성 배치 안내 */}
        {game.pendingLostPlanet?.playerId === playerId && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-30 px-4 py-2 rounded-lg bg-indigo-900/90 border border-indigo-400/50 text-indigo-200 text-sm font-medium shadow-lg">
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
                          onClick={() => setPowerOfferBrainFirst(!powerOfferBrainFirst)}
                          title="브레인 스톤 우선 수령 여부 토글"
                        >
                          Brain First
                        </Button>
                        {game?.map && (currentPlayer as PlayerState) && game.map.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className={`h-7 px-2 text-[9px] font-bold uppercase transition-colors ${powerOfferPiAddFirst ? 'text-amber-400 bg-amber-400/10' : 'text-zinc-500'}`}
                            onClick={() => setPowerOfferPiAddFirst(!powerOfferPiAddFirst)}
                            title="의회 효과(1그릇 추가) 우선 적용 여부 토글"
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

        {/* Twilight 액션1: 보유 연방 중 하나 선택해서 해택 재수령 */}
        {game.pendingTwilightFederation && game.pendingTwilightFederation.playerId === playerId && gameId && (() => {
          const myFedIds = getFederationEntries(currentPlayer as PlayerState).map((f) => f.rewardId);
          const myRewards = myFedIds.map((id) => FEDERATION_REWARDS.find((r) => r.id === id) || SPACESHIP_FEDERATION_REWARDS.find((r) => r.id === id)).filter(Boolean);
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
                    myRewards.map((reward) => (
                      reward && (
                        <Button
                          key={reward.id}
                          variant="outline"
                          className="bg-zinc-800 border-zinc-700 hover:bg-zinc-700 hover:border-zinc-500 text-white transition-all"
                          onClick={() => GameClient.confirmTwilightFederation(gameId, reward.id)}
                        >
                          {reward.label}
                        </Button>
                      )
                    ))
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
                      className="bg-zinc-800 border-zinc-600"
                      disabled={disabled}
                      onClick={() => GameClient.eclipseAdvanceTrack(gameId, track.id as ResearchTrack)}
                    >
                      {track.name} (Lv.{level})
                    </Button>
                  );
                })}
              </div>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {/* Eclipse 액션3: 소행성 광산 — 맵에서 초록 테두리 소행성 클릭으로 건설 (모달 없음) */}
        {game.pendingEclipseAsteroidMine && game.pendingEclipseAsteroidMine.playerId === playerId && (
          <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-zinc-900/95 border border-green-500/50 text-green-400 text-sm font-medium shadow-lg">
            Eclipse: 맵에서 <span className="font-bold text-green-300">초록 테두리</span> 소행성을 클릭하여 광산 건설 (6C)
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
                        // 서버의 select_all_income_items와 동일한 최적화 시뮬레이션으로 미리보기
                        const items = [...pending.incomeItems];
                        let bestP1 = actualPlayer.power1 ?? 0;
                        let bestP2 = actualPlayer.power2 ?? 0;
                        let bestP3 = actualPlayer.power3 ?? 0;

                        if (items.length <= 8) {
                          const perms = (arr: typeof items): (typeof items)[] => {
                            if (arr.length <= 1) return [arr];
                            const result: (typeof items)[] = [];
                            for (let i = 0; i < arr.length; i++) {
                              const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
                              for (const sub of perms(rest)) result.push([arr[i], ...sub]);
                            }
                            return result;
                          };
                          const allPerms = perms(items);
                          let best = { p1: bestP1, p2: bestP2, p3: bestP3 };
                          for (const order of allPerms) {
                            let p1 = actualPlayer.power1 ?? 0;
                            let p2 = actualPlayer.power2 ?? 0;
                            let p3 = actualPlayer.power3 ?? 0;
                            for (const item of order) {
                              if (item.type === 'tokens') {
                                p1 += item.amount;
                              } else {
                                let rem = item.amount;
                                const from1 = Math.min(rem, p1);
                                p1 -= from1; p2 += from1; rem -= from1;
                                const from2 = Math.min(rem, p2);
                                p2 -= from2; p3 += from2;
                              }
                            }
                            if (
                              p3 > best.p3 ||
                              (p3 === best.p3 && p2 > best.p2) ||
                              (p3 === best.p3 && p2 === best.p2 && p1 > best.p1)
                            ) {
                              best = { p1, p2, p3 };
                            }
                          }
                          bestP1 = best.p1;
                          bestP2 = best.p2;
                          bestP3 = best.p3;
                        } else {
                          // 아이템이 많을 때는 서버와 동일하게 토큰→파워 순으로 처리
                          let p1 = actualPlayer.power1 ?? 0;
                          let p2 = actualPlayer.power2 ?? 0;
                          let p3 = actualPlayer.power3 ?? 0;
                          const sorted = items.slice().sort((a, b) => (a.type === 'tokens' ? -1 : 1));
                          for (const item of sorted) {
                            if (item.type === 'tokens') {
                              p1 += item.amount;
                            } else {
                              let rem = item.amount;
                              const from1 = Math.min(rem, p1);
                              p1 -= from1; p2 += from1; rem -= from1;
                              const from2 = Math.min(rem, p2);
                              p2 -= from2; p3 += from2;
                            }
                          }
                          bestP1 = p1;
                          bestP2 = p2;
                          bestP3 = p3;
                        }
                        return (
                          <p className="text-[10px] text-zinc-500">
                            자동 받기 시 결과: 1/2/3그릇 → <span className="font-mono text-zinc-300 font-bold">{bestP1} / {bestP2} / {bestP3}</span>
                          </p>
                        );
                      })()}
                      <div className="grid grid-cols-3 gap-3">
                        {pending.incomeItems.map((item) => {
                          let preview = '';
                          const { power1, power2, power3 } = actualPlayer;
                          if (item.type === 'power') {
                            let p1 = power1 ?? 0, p2 = power2 ?? 0, p3 = power3 ?? 0;
                            let rem = item.amount;
                            const from1 = Math.min(rem, p1);
                            p1 -= from1; p2 += from1; rem -= from1;
                            const from2 = Math.min(rem, p2);
                            p2 -= from2; p3 += from2;
                            preview = `${power1 ?? 0}/${power2 ?? 0}/${power3 ?? 0} → ${p1}/${p2}/${p3}`;
                          } else if (item.type === 'tokens') {
                            preview = `${power1 ?? 0}/${power2 ?? 0}/${power3 ?? 0} → ${(power1 ?? 0) + item.amount}/${power2 ?? 0}/${power3 ?? 0}`;
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
      <div className={`
        ${isSidebarOpen ? 'w-[340px] translate-x-0 opacity-100 md:relative fixed' : 'w-0 translate-x-full lg:translate-x-0 lg:w-0 opacity-0 overflow-hidden pointer-events-none fixed'}
        right-0 top-0 bottom-0 z-50 lg:z-auto
        transition-all duration-300 ease-in-out
        border-l border-border bg-card/95 backdrop-blur-sm lg:bg-card flex flex-col shadow-2xl lg:shadow-none
        max-w-[85vw] md:max-w-none
      `}>
        {isSidebarOpen && (
          <div className="flex flex-col h-full w-full md:min-w-[308px] overflow-hidden">
            <div className="flex-1 min-h-0 flex flex-col gap-4 p-4 overflow-y-auto custom-scrollbar">
              {/* 연방 구현: 모드 진입/취소 및 완료 (X버튼 포함) */}
              {isMyTurn && game?.currentPhase === 'main' && !game.hasDoneMainAction && !game.pendingFederationReward && (
                <div className="p-3 bg-black/80 border border-sky-500/40 rounded-xl">
                  {game.federationMode?.playerId === playerId ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-[10px] text-sky-300 font-bold">
                        빈 공간(위성)·내 건물 행성·우주정거장 클릭 토글. 내 건물/우주정거장 클릭 시 이어진 행성·우주정거장까지 연방에 포함. 위성 0개도 가능.
                      </p>
                      <div className="rounded-lg border border-sky-500/30 bg-sky-950/40 p-2 text-left">
                        <p className="text-[9px] font-bold text-sky-200 mb-1">연방에 포함될 건물·우주정거장 (클릭할 때마다 갱신)</p>
                        {game.federationPreview ? (
                          <>
                            <ul className="text-[9px] text-zinc-300 space-y-0.5 mb-1">
                              {game.federationPreview.items.length === 0 ? (
                                <li className="text-zinc-500">빈 칸·내 건물 행성·우주정거장을 클릭해 선택하세요</li>
                              ) : (
                                game.federationPreview.items.map((item, i) => (
                                  <li key={`${item.tileId}-${i}`}>{item.label} ({item.power})</li>
                                ))
                              )}
                            </ul>
                            <p className={`text-[10px] font-bold ${game.federationPreview.power >= game.federationPreview.requiredPower ? 'text-green-400' : 'text-amber-400'}`}>
                              파워 {game.federationPreview.power} / {game.federationPreview.requiredPower} 필요
                            </p>
                          </>
                        ) : (
                          <p className="text-[9px] text-zinc-500">파워 계산 중…</p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" className="flex-1 border-sky-500/50 text-sky-400 text-[9px] font-bold" onClick={() => gameId && GameClient.federationToggleMode(gameId)}>취소</Button>
                        <Button size="sm" className="flex-1 bg-sky-600 hover:bg-sky-500 text-white text-[9px] font-bold" onClick={() => gameId && GameClient.federationComplete(gameId)}>완료</Button>
                        <Button size="sm" variant="ghost" className="h-8 w-8 px-0 text-zinc-500 hover:text-white" onClick={() => setIsSidebarOpen(false)} title="상태창 닫기">
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Button size="sm" className="flex-1 bg-sky-600/80 hover:bg-sky-500 text-white text-[9px] font-bold" onClick={() => gameId && GameClient.federationToggleMode(gameId)}>연방 구현</Button>
                      <Button size="sm" variant="ghost" className="h-8 w-8 px-0 text-zinc-500 hover:text-white" onClick={() => setIsSidebarOpen(false)} title="상태창 닫기">
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  )}
                </div>
              )}


              {/* 플레이어 영역: 콘텐츠 높이만 사용(flex-none으로 줄어들지 않음), 빈 공간 없음 */}
              <div className="space-y-2 md:space-y-4 flex-none overflow-visible">
                <div className="flex items-center justify-between py-1">
                  <h3 className="font-semibold flex items-center gap-2 text-zinc-400 text-[10px] md:text-xs uppercase tracking-widest">
                    <Users className="w-3.5 h-3.5 md:w-4 md:h-4" />
                    Players
                  </h3>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 px-0 text-zinc-500 hover:text-white hover:bg-white/5 md:hidden"
                    onClick={() => setIsSidebarOpen(false)}
                    title="상태창 닫기"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                  {!(isMyTurn && game?.currentPhase === 'main' && !game.hasDoneMainAction && !game.pendingFederationReward) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 px-0 text-zinc-500 hover:text-white hover:bg-white/5 hidden md:flex"
                      onClick={() => setIsSidebarOpen(false)}
                      title="상태창 닫기"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
                <div className="space-y-1.5 md:space-y-2">
              {([...(game.turnOrder ?? Object.keys(game.players))].sort((a, b) => {
                const pa = game.players[a];
                const pb = game.players[b];
                if (pa?.hasPassed && !pb?.hasPassed) return 1;
                if (!pa?.hasPassed && pb?.hasPassed) return -1;
                return 0;
              })).map((id) => {
                const p = game.players[id] as PlayerState | undefined;
                if (!p) return null;
                const fedEntries = getFederationEntries(p);
                const faction = p.faction ? FACTIONS.find((f) => f.id === p.faction) : null;
                const isBot = game.botPlayerIds?.includes(id);
                const isYou = id === playerId && !isBot;
                const isCurrentTurn = game.turnOrder?.[game.currentPlayerIndex] === id;
                const expanded = expandedPlayerId === id;
                const counts = getStructureCountsForPlayer(game, id);
                const inc = getNextRoundIncomePreview(id, game, { excludeBonusTiles: true });
                const hasPassed = p.hasPassed;

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
                            } else {
                              GameClient.useSpecialAction(gameId, actionId);
                            }
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
                            {/* Score and Name Row */}
                            <div className="flex items-center justify-between gap-1 md:gap-2 min-w-0 mb-1 md:mb-1.5">
                              <span className="w-6 md:w-8 text-right text-sm md:text-base font-bold text-white flex-shrink-0">{p.score}</span>
                              <div className="flex items-center gap-1 md:gap-1.5 min-w-0 flex-1 ml-1">
                                <div className="w-2 h-2 md:w-2.5 md:h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: faction?.color ?? '#666' }} />
                                <span className="truncate font-medium text-xs md:text-sm text-zinc-200">
                                  {faction ? `${faction.name} (${p.name})` : p.name}
                                </span>
                                {/* Toggles */}
                                {isYou && <span className="text-[8px] md:text-[10px] text-primary flex-shrink-0">(나)</span>}
                                {isCurrentTurn && !hasPassed && (
                                  <span className="flex items-center gap-1 flex-shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shadow-[0_0_6px_rgba(251,191,36,0.8)]" />
                                  </span>
                                )}
                                {hasPassed && (
                                  <span className="text-[9px] font-bold text-zinc-500 border border-zinc-700 rounded px-1 ml-auto">PASSED</span>
                                )}
                              </div>
                            </div>

                            {/* Buildings */}
                            <div className="flex justify-between items-baseline mb-0.5 md:mb-1 text-[10px] md:text-xs text-zinc-500 font-mono tracking-tighter md:tracking-normal w-full">
                              M<span className="text-amber-300/90">{counts.mineCount}</span>/{BUILDING_LIMITS.mine}
                              <span className="mx-0.5 md:mx-1">TS</span><span className="text-yellow-400/90">{counts.tsCount}</span>/{BUILDING_LIMITS.trading_station}
                              <span className="mx-0.5 md:mx-1">Lab</span><span className="text-blue-400/90">{counts.labCount}</span>/{BUILDING_LIMITS.research_lab}
                              <span className="mx-0.5 md:mx-1">PI</span><span className="text-purple-400/90">{counts.piCount}</span>/{BUILDING_LIMITS.planetary_institute}
                              <span className="mx-0.5 md:mx-1">A</span><span className="text-indigo-400/90">{counts.academyLeft}+{counts.academyRight}</span>/{BUILDING_LIMITS.academy}
                            </div>

                            {/* Resources & Power / Gaiaformers */}
                            <div className="flex flex-row gap-2 mt-1 border-t border-white/10 pt-1.5">
                              {/* Left: 2x2 Resource Grid (O C / K Q) */}
                              <div className="grid grid-cols-2 gap-x-2 gap-y-1 w-1/2">
                                {/* O: Ore */}
                                <div className="flex items-baseline">
                                  <span className="text-zinc-300 mr-1 text-xs md:text-sm font-bold">O</span>
                                  <span style={{ color: '#f5f5f0' }} className="font-black text-sm md:text-base">{p.ore ?? 0}</span>
                                  {inc.ore > 0 && <span className="text-[9px] md:text-[10px] text-zinc-400 font-medium ml-1">({`+${inc.ore}`})</span>}
                                </div>
                                {/* C: Credits */}
                                <div className="flex items-baseline justify-end">
                                  <span className="text-yellow-400 mr-1 text-xs md:text-sm font-bold">C</span>
                                  <span style={{ color: '#FFE74C' }} className="font-black text-sm md:text-base">{p.credits ?? 0}</span>
                                  {inc.credits > 0 && <span className="text-[9px] md:text-[10px] text-zinc-400 font-medium ml-1">({`+${inc.credits}`})</span>}
                                </div>
                                {/* K: Knowledge */}
                                <div className="flex items-baseline">
                                  <span className="text-blue-400 mr-1 text-xs md:text-sm font-bold">K</span>
                                  <span style={{ color: '#2E5EAA' }} className="font-black text-sm md:text-base">{p.knowledge ?? 0}</span>
                                  {inc.knowledge > 0 && <span className="text-[9px] md:text-[10px] text-zinc-400 font-medium ml-1">({`+${inc.knowledge}`})</span>}
                                </div>
                                {/* Q: QIC */}
                                <div className="flex items-baseline justify-end">
                                  <span className="text-green-400 mr-1 text-xs md:text-sm font-bold">Q</span>
                                  <span style={{ color: '#38B000' }} className="font-black text-sm md:text-base">{p.qic ?? 0}</span>
                                  {inc.qic > 0 && <span className="text-[9px] md:text-[10px] text-zinc-400 font-medium ml-1">({`+${inc.qic}`})</span>}
                                </div>
                              </div>

                              {/* Right: Gaiaformer & Power */}
                              <div className="flex flex-col gap-1 w-1/2 justify-center pl-2 border-l border-white/10">
                                {/* Gaiaformers Row & Power Income */}
                                <div className="flex justify-between items-center w-full" title="가이아포머 (불 켜진 점: 사용 가능, X: 소행성 파괴, 어두운 점: 맵 배치)">
                                  <div className="flex gap-1.5 items-center">
                                    {(() => {
                                      const gpLevel = p.research?.gaiaProject ?? 0;
                                      const totalGF = gpLevel >= 4 ? 3 : gpLevel >= 3 ? 2 : gpLevel >= 1 ? 1 : 0;
                                      const availableGF = p.gaiaformers ?? 0;
                                      const destroyedGF = p.destroyedGaiaformers ?? 0;
                                      const onMapGF = Math.max(0, totalGF - availableGF - destroyedGF);

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
                                      // 3. On Map (Purple)
                                      for (let i = 0; i < onMapGF; i++) {
                                        dots.push(<div key={`m-${i}`} className="w-2.5 h-2.5 rounded-full bg-purple-500 shadow-[0_0_3px_rgba(168,85,247,0.4)] transition-colors" />);
                                      }

                                      return dots.slice(0, totalGF);
                                    })()}
                                  </div>

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
                                    <span className="text-emerald-400 font-black text-sm md:text-base leading-none">{p.gaiaformerPower ?? 0}</span>
                                    <div className="w-[1px] h-4 bg-white/20 shrink-0" />
                                    <div className="flex gap-2.5 items-center justify-between w-full">
                                      <span className="flex items-center gap-0.5">
                                        <span className="text-blue-400 font-black text-sm md:text-base leading-none">{p.power1 ?? 0}</span>
                                        {p.faction === 'taklons' && (p as any).brainStoneBowl === 1 && !(p as any).brainStoneInGaia && (
                                          <span className="text-[10px] leading-none">🧠</span>
                                        )}
                                      </span>
                                      <span className="flex items-center gap-0.5">
                                        <span className="text-cyan-400 font-black text-sm md:text-base leading-none">{p.power2 ?? 0}</span>
                                        {p.faction === 'taklons' && (p as any).brainStoneBowl === 2 && !(p as any).brainStoneInGaia && (
                                          <span className="text-[10px] leading-none">🧠</span>
                                        )}
                                      </span>
                                      <span className="flex items-center gap-0.5">
                                        <span className="text-amber-400 font-black text-sm md:text-base leading-none">{p.power3 ?? 0}</span>
                                        {p.faction === 'taklons' && (p as any).brainStoneBowl === 3 && !(p as any).brainStoneInGaia && (
                                          <span className="text-[10px] leading-none">🧠</span>
                                        )}
                                      </span>
                                      {p.faction === 'taklons' && (p as any).brainStoneInGaia && (
                                        <span className="text-emerald-400 text-[10px] font-bold ml-1" title="브레인스톤: 가이아 구역">🧠G</span>
                                      )}
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
                              return (
                                <img
                                  src={`/image/BoostTile_${bonusIndex + 1}.jpg`}
                                  alt={ALL_BONUS_TILES[bonusIndex].label}
                                  className="w-10 h-auto object-contain drop-shadow-[0_0_3px_rgba(251,191,36,0.5)] rounded"
                                  title={`현재 패스 타일: ${ALL_BONUS_TILES[bonusIndex].label}`}
                                />
                              );
                            })()}
                          </div>
                        </div>
                      </PopoverTrigger>
                      {expandedPlayerId === id && (
                        <PopoverContent side="left" align="start" className="w-72 bg-zinc-950/95 backdrop-blur border border-white/20 rounded-xl p-3 shadow-[0_0_30px_rgba(0,0,0,0.8)] z-50 text-[10px]">
                          {fedEntries.length > 0 && (
                            <div>
                              <span className="text-muted-foreground font-medium">연방 </span>
                              <span className="flex flex-wrap gap-x-1.5 gap-y-0.5 mt-0.5">
                                {fedEntries.map((f, i) => {
                                  const reward = FEDERATION_REWARDS.find((r) => r.id === f.rewardId) || SPACESHIP_FEDERATION_REWARDS.find((r) => r.id === f.rewardId);
                                  const label = reward?.label ?? f.rewardId;

                                  // Determine image index
                                  let imgIdx = -1;
                                  const regIdx = FEDERATION_REWARDS.findIndex(r => r.id === f.rewardId);
                                  if (regIdx !== -1) {
                                    imgIdx = regIdx + 1;
                                  } else {
                                    const shipIdx = SPACESHIP_FEDERATION_REWARDS.findIndex(r => r.id === f.rewardId);
                                    if (shipIdx !== -1) imgIdx = shipIdx + 7;
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
                                          className={`h-[22px] w-auto object-contain border border-white/10 rounded transition-all ${f.isGreen ? 'brightness-110 saturate-[1.1]' : 'grayscale opacity-40 brightness-50'}`}
                                          alt={label}
                                        />
                                      ) : (
                                        <Badge variant="outline" className={`text-[8px] px-1 py-0 ${f.isGreen ? 'bg-primary/20 border-primary/30 text-primary' : 'bg-zinc-800 border-zinc-700 text-zinc-500'}`}>
                                          {label}
                                        </Badge>
                                      )}
                                      {f.isGreen && (
                                        <div className="absolute -top-1 -right-1 w-2 h-2 bg-green-500 rounded-full border border-black shadow-sm" />
                                      )}
                                    </div>
                                  );
                                })}
                              </span>
                            </div>
                          )}
                          {(p.techTiles?.length ?? 0) > 0 && (
                            <div>
                              <span className="text-muted-foreground font-medium">기술 타일 </span>
                              <div className="flex flex-wrap gap-1.5 mt-1">
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
                                        className={`w-10 h-auto object-contain rounded border border-white/10 transition-all ${covered ? 'grayscale opacity-40 brightness-50' : 'hover:scale-110 shadow-sm shadow-black'}`}
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
                            <div>
                              <span className="text-muted-foreground font-medium">인공물 </span>
                              <div className="flex flex-wrap gap-1 mt-0.5">
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
                          {p.bonusTile && (() => {
                            const bonus = ALL_BONUS_TILES.find(t => t.id === p.bonusTile);
                            if (!bonus?.specialAction) return null;
                            const actionNames: Record<string, string> = {
                              'terraform_step': '1테라',
                              'gaia_project': '가이아',
                              'range_3': '+3거리'
                            };
                            const actionLabel = actionNames[bonus.specialAction] || bonus.specialAction;
                            const isUsed = p.usedBonusAction;
                            const canUse = isYou && isCurrentTurn && !game.hasDoneMainAction;
                            return (
                              <div className="mb-1">
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
                            );
                          })()}

                          {/* Unified Special Actions Status */}
                          <div className="mt-1 pb-1 space-y-1">
                            <span className="text-muted-foreground font-medium block h-4">스페셜 액션</span>
                            <div className="flex flex-wrap gap-1">
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
                                      (p as any).usedSpecialActions?.includes('tinkeroid-special') ?? false, canDoMain, 'tinkeroid-special', `팅커:${p.tinkeroidRoundSpecialId.replace('tinkeroid-', '')}`,
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
                                  if (canDoMain && (p.gaiaformers ?? 0) > 0) {
                                    actionNodes.push(
                                      <button
                                        key="bal_tak-to-qic-btn"
                                        onClick={(e) => { e.stopPropagation(); if (gameId) GameClient.useBalTakGaiaformerToQic(gameId); }}
                                        className="px-1 py-0.5 rounded-[3px] text-[9px] border bg-emerald-500/20 hover:bg-emerald-500/40 text-emerald-300 border-emerald-500/30 font-bold cursor-pointer active:scale-95 transition-all shadow-sm"
                                      >
                                        포머→QIC 수동변환
                                      </button>
                                    );
                                  }
                                }

                                return actionNodes;
                              })()}
                            </div>
                          </div>
                        </PopoverContent>
                      )}
                    </div>
                  </Popover>
                );
              })}
              </div>
            </div>

            <div className="mt-2 md:mt-4 pt-2 md:pt-4 border-t shrink-0 hidden md:block">
              <Badge variant="outline" className="w-full justify-center">
                Round {game.roundNumber}
              </Badge>
            </div>

            {/* Game Log - 고정 높이로 레이아웃 밀림 방지, 내부만 스크롤 */}
            <div className="mt-2 md:mt-4 pt-2 md:pt-4 border-t flex-none flex flex-col h-[200px] md:h-[240px] hidden md:flex">
              <h3 className="font-semibold mb-2 md:mb-3 flex items-center gap-2 text-xs md:text-sm shrink-0">
                <Clock className="w-3 h-3 md:w-4 md:h-4" />
                Game Log
              </h3>
              <div className="flex-1 min-h-0 overflow-y-auto w-full custom-scrollbar">
                {(!game.gameLog || game.gameLog.length === 0) ? (
                  <div className="text-center text-muted-foreground text-xs py-8">
                    No actions yet
                  </div>
                ) : (
                  <GameLog
                    game={game}
                    hideHeader
                    className="w-full"
                    maxHeight="100%"
                    onEntryMouseEnter={(tileId) => setHighlightedTileId(tileId)}
                    onEntryMouseLeave={() => setHighlightedTileId(null)}
                  />
                )}
              </div>
            </div>

            {/* Debug Panel - reduced flex to give more space to log */}
            <div className="mt-4 md:mt-8 pt-4 md:pt-6 border-t-2 border-white/5 flex-none overflow-y-auto max-h-[20vh] md:max-h-[30vh] hidden md:block">
              <DebugPanel game={game} playerId={playerId} />
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
              onUndoFreeAction={() => {
                if (gameId) GameClient.undoFreeAction(gameId);
              }}
            />
          </div>
        </div>
      )}
    </div>

      <AnimatePresence>
        {(pendingAction || (game && game.hasDoneMainAction && game.turnOrder[game.currentPlayerIndex] === playerId && game.currentPhase === 'main' && !game.botPlayerIds?.includes(playerId) && (!game.pendingTFMarsGaiaProject || game.pendingTFMarsGaiaProject.playerId !== playerId) && (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId))) && (
          <motion.div
            initial={{ y: -50, x: '-50%', opacity: 0 }}
            animate={{ y: 0, x: '-50%', opacity: 1 }}
            exit={{ y: -50, x: '-50%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-20 left-1/2 z-[130] flex items-center gap-4 p-2 px-4 bg-zinc-900/95 backdrop-blur-xl border border-yellow-500/50 rounded-full shadow-[0_0_30px_rgba(234,179,8,0.2)] max-w-[95vw]"
          >
            {/* Title & Costs (Left Side) */}
            <div className="flex items-center gap-3 border-r border-white/10 pr-4">
              <div className="flex flex-col shrink-0 mr-2">
                <h3 className="text-yellow-500 font-black uppercase tracking-tighter text-[9px] leading-none">
                  {pendingAction ? 'Confirm Action' : 'Turn Management'}
                </h3>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {pendingAction ? (
                  <div className="flex items-center gap-3">
                    {(cost as any)?.ore && (
                      <div className="flex items-center gap-1.5">
                        <span className={`text-base font-black leading-none ${(cost as any).needsExtraTerraforming ? 'text-red-500' : 'text-orange-500'}`}>{(cost as any).ore}</span>
                        <span className="text-[8px] uppercase text-zinc-500 font-bold tracking-tighter">Ore</span>
                        {(cost as any).terraformSteps && (cost as any).terraformSteps > 0 && (
                          <span className="text-[8px] text-zinc-400">({(cost as any).terraformSteps}st)</span>
                        )}
                      </div>
                    )}
                    {(cost as any)?.credits && (cost as any).credits > 0 && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-base font-black text-yellow-500 leading-none">{(cost as any).credits}</span>
                        <span className="text-[8px] uppercase text-zinc-500 font-bold tracking-tighter">Cr</span>
                      </div>
                    )}
                    {(cost as any)?.gaiaformers && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-base font-black text-cyan-500 leading-none">{(cost as any).gaiaformers}</span>
                        <span className="text-[8px] uppercase text-zinc-500 font-bold tracking-tighter">Gf</span>
                      </div>
                    )}
                    {(cost as any)?.knowledge && (cost as any).knowledge > 0 && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-base font-black text-blue-500 leading-none">{(cost as any).knowledge}</span>
                        <span className="text-[8px] uppercase text-zinc-500 font-bold tracking-tighter">Kn</span>
                      </div>
                    )}
                    {(cost as any)?.qic && (cost as any).qic > 0 && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-base font-black text-green-500 leading-none">{(cost as any).qic}</span>
                        <span className="text-[8px] uppercase text-zinc-500 font-bold tracking-tighter">QIC</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest">
                    {game.pendingShipTechMine && game.pendingShipTechMine.playerId === playerId ? 'Pending Mine Construction' : 'Main Action Done'}
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
              {game && game.hasDoneMainAction && game.turnOrder[game.currentPlayerIndex] === playerId && game.currentPhase === 'main' && (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId) && (!game.players[playerId]?.pendingTerraformSteps || game.players[playerId].pendingTerraformSteps === 0) && (
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
              const newPos = { x: researchPos.x + info.offset.x, y: researchPos.y + info.offset.y };
              setResearchPos(newPos);
              if (gameId) localStorage.setItem(`research-pos-${gameId}`, JSON.stringify(newPos));
            }}
            className="fixed z-[110] border border-white/20 bg-zinc-950/90 backdrop-blur-md rounded-xl shadow-2xl overflow-hidden flex flex-col pointer-events-auto left-0 top-0"
            style={{ width: researchMiniWidth, maxHeight: '90vh' }}
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
            <div className="flex-1 px-2 py-2 overflow-y-auto overflow-x-hidden touch-pan-y" style={{ WebkitOverflowScrolling: 'touch' }}>
              <div
                className="origin-top-left"
                style={{ width: 340, transform: `scale(${researchMiniWidth / 340})` }}
              >
                <ResearchBoard
                  game={game}
                  playerId={playerId}
                  isMini={true}
                onUsePowerAction={(actionId) => GameClient.usePowerAction(gameId!, actionId)}
                onUseHadschHallasPIAction={(actionId) => GameClient.useHadschHallasPIAction(gameId!, actionId)}
                onUseBalTakGaiaformerToQic={() => GameClient.useBalTakGaiaformerToQic(gameId!)}
                onGainTechTile={(tileId) => GameClient.gainTechTile(gameId!, tileId)}
                onUseTechAction={(tileId) => GameClient.useTechAction(gameId!, tileId)}
                onAdvanceTech={(trackId) => {
                  if (game.hasDoneMainAction) return;
                  setAdvanceTechDialog({ open: true, trackId });
                }}
                onSelectTechTile={(techTileId, trackId) => {
                  // 미니 R패널에서 선택한 경우: 자동 R창 열고닫기 하지 않도록 플래그 ON
                  if (techTileId === 'ship-tech-2tf-mine') setShipTech2TfMineFromMini(true);
                  GameClient.selectTechTile(gameId!, techTileId, trackId);
                }}
                onSelectAdvancedTechTile={(advId, trackId) => GameClient.selectAdvancedTechTile(gameId!, advId, trackId)}
                onConfirmAdvancedTechCover={(coverId) => GameClient.confirmAdvancedTechCover(gameId!, coverId)}
                onTakeTwilightArtifact={(artId) => GameClient.takeTwilightArtifact(gameId!, artId)}
                onUseAcademyQic={() => GameClient.useSpecialAction(gameId!, 'academy-qic')}
                onEndTurn={() => GameClient.endTurn(gameId!)}
                onResetTurn={() => GameClient.resetTurn(gameId!)}
                onUseShipAction={(shipId, idx, target) => GameClient.useShipAction(gameId!, shipId, idx, target)}
                />
              </div>
            </div>
            <div
              className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize shrink-0 hover:bg-blue-500/30 active:bg-blue-500/50 border-r border-white/10 rounded-r-xl transition-colors"
              title="드래그하여 너비 조절"
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startResize('research', e.clientX, researchMiniWidth); }}
            />
          </motion.div>
        )}

        {isBonusPinned && (
          <motion.div
            key="bonus-mini"
            drag
            dragControls={bonusDragControls}
            dragListener={false}
            dragMomentum={false}
            initial={bonusPos}
            animate={bonusPos}
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.1 } }}
            onDragEnd={(_, info) => {
              const newPos = { x: bonusPos.x + info.offset.x, y: bonusPos.y + info.offset.y };
              setBonusPos(newPos);
              if (gameId) localStorage.setItem(`bonus-pos-${gameId}`, JSON.stringify(newPos));
            }}
            className="fixed z-[110] border border-white/20 bg-zinc-950/90 backdrop-blur-md rounded-xl shadow-2xl overflow-hidden flex flex-col pointer-events-auto left-0 top-0"
            style={{ width: bonusMiniWidth, maxHeight: '90vh' }}
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
            <div className="flex-1 px-2 py-1 overflow-y-auto overflow-x-hidden touch-pan-y" style={{ WebkitOverflowScrolling: 'touch' }}>
              <div
                className="origin-top-left flex flex-col gap-4"
                style={{ width: 340, transform: `scale(${bonusMiniWidth / 340})` }}
              >
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
                  onSelectBonusTile={isMyTurn ? ((id) => {
                    if (game.roundNumber === 6) {
                      setConfirmPassWithTileId('dummy');
                    } else {
                      setConfirmPassWithTileId(id);
                    }
                  }) : undefined}
                  onUseBonusAction={() => GameClient.useBonusAction(gameId!)}
                />
              </div>
            </div>
            <div
              className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize shrink-0 hover:bg-amber-500/30 active:bg-amber-500/50 border-r border-white/10 rounded-r-xl transition-colors"
              title="드래그하여 너비 조절"
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); startResize('bonus', e.clientX, bonusMiniWidth); }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <GameEndScoreModal />
    </div>
  );
}
