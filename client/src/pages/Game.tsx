import { useState, useEffect, useRef } from 'react';
import { useParams, useLocation } from 'wouter';
import { GameClient, getSocket, getStoredPlayerId, storePlayerId, type GameState, type PlayerState } from '@/lib/gameClient';

import { ResearchBoard } from '@/components/ResearchBoard';
import { RoundBoard } from '@/components/RoundBoard';
import { GameBoard } from '@/components/GameBoard';
import { BonusTiles } from '@/components/BonusTiles';
import { BonusSelectionModal } from '@/components/BonusSelectionModal';

import { PlayerPanel } from '@/components/PlayerPanel';
import { FactionSelect } from '@/components/FactionSelect';
import { GameLobby } from '@/components/GameLobby';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Users, Gift, Clock, User, ChevronDown, ChevronUp, Gamepad2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DebugPanel } from '@/components/DebugPanel';
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

import { FACTIONS, RESEARCH_TRACKS, ALL_TECH_TILES, ALL_ADVANCED_TECH_TILES, ALL_BONUS_TILES, FEDERATION_REWARDS, SPACESHIP_FEDERATION_REWARDS, BUILDING_LIMITS, getTerraformSteps, getTerraformStepsForFaction, getTerraformCost, getRange, getEffectiveBaseRange, getDistance, hasNearbyPlayersForTradingDiscount, getFederationEntries, isTechTileCovered, ARTIFACTS } from '@shared/gameConfig';
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
  | { type: 'useSpecialAction', actionId: string };

export default function Game() {
  const params = useParams<{ matchID: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const gameId = params.matchID;
  const [game, setGame] = useState<GameState | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(gameId ? getStoredPlayerId(gameId) : null);
  const [pendingAction, setPendingAction] = useState<PotentialAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isResearchOpen, setIsResearchOpen] = useState(false);
  const [isBonusTilesOpen, setIsBonusTilesOpen] = useState(false);
  const [showPassBonusModal, setShowPassBonusModal] = useState(false);
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
  const isHostSessionRef = useRef(false);
  const [showGameEndScore, setShowGameEndScore] = useState(false);

  useEffect(() => {
    if (game?.currentPhase === 'gameEnd') {
      setShowGameEndScore(true);
    }
  }, [game?.currentPhase]);

  const handleConfirm = () => {
    if (!pendingAction || !gameId) return;

    switch (pendingAction.type) {
      case 'buildMine': GameClient.buildMine(gameId, pendingAction.tileId, pendingAction.useGaiaformer); break;
      case 'upgrade': GameClient.upgradeStructure(gameId, pendingAction.tileId, pendingAction.target); break;
      case 'advanceTech': GameClient.advanceTech(gameId, pendingAction.trackId); break;
      case 'usePowerAction': GameClient.usePowerAction(gameId, pendingAction.actionId); break;
      case 'useTechAction': GameClient.useTechAction(gameId, pendingAction.tileId); break;
      case 'useSpecialAction': GameClient.useSpecialAction(gameId, pendingAction.actionId); break;
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

        if (storedPlayerId) {
          try {
            const { game: gameData } = await GameClient.rejoinGame(gameId, storedPlayerId);
            setGame(gameData);
            setLoading(false);
            return;
          } catch {
          }
        }

        const { game: gameData } = await GameClient.getGame(gameId);
        setGame(gameData);
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
    if (game && playerId && game.hostId === playerId) isHostSessionRef.current = true;
  }, [game?.hostId, playerId]);

  // 한 컴퓨터 4인플: game 상태가 바뀔 때마다 조작 플레이어 자동 전환. UI는 즉시 전환하고, 서버 rejoin은 백그라운드로만 호출(응답으로 setGame 하지 않음).
  useEffect(() => {
    if (!gameId || !game || game.currentPhase === 'lobby' || !isHostSessionRef.current) return;
    const turnOrder = game.turnOrder ?? [];
    const isFactionPhase = game.currentPhase === 'startingMines' || game.currentPhase === 'factionSelect';
    const someoneWithoutFaction = isFactionPhase && turnOrder.some((pid) => !game.players[pid]?.faction);
    let targetPlayerId: string | null = null;
    if (someoneWithoutFaction) {
      const cur = game.players[playerId ?? ''];
      if (cur?.faction) {
        const nextNoFaction = turnOrder.find((pid) => !game.players[pid]?.faction);
        if (nextNoFaction && nextNoFaction !== playerId) targetPlayerId = nextNoFaction;
      }
      if (!targetPlayerId) return;
    } else {
      const currentTurnPlayer = turnOrder[game.currentPlayerIndex];
      if (!currentTurnPlayer || currentTurnPlayer === playerId) return;
      targetPlayerId = currentTurnPlayer;
    }
    if (!targetPlayerId) return;
    setPlayerId(targetPlayerId);
    storePlayerId(gameId, targetPlayerId);
    GameClient.switchPlayer(gameId, targetPlayerId).catch(() => { });
  }, [gameId, game?.turnOrder, game?.currentPlayerIndex, game?.currentPhase, game?.players, playerId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

      if (e.key.toLowerCase() === 'r') {
        setIsResearchOpen(prev => !prev);
        setIsBonusTilesOpen(false);
      }
      if (e.key.toLowerCase() === 'b') {
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
  }, [isResearchOpen, isBonusTilesOpen]);

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
    if (game.pendingTechTileSelection?.playerId === playerId) {
      setIsResearchOpen(true);
    }
  }, [game?.pendingTechTileSelection?.playerId, playerId]);

  // 테란 의회 다이얼로그가 열릴 때 선택 초기화
  useEffect(() => {
    if (game?.pendingTerranCouncilBenefit?.playerId === playerId) {
      setTerranCouncilChoice({ qic: 0, knowledge: 0, ore: 0, credits: 0 });
    }
  }, [game?.pendingTerranCouncilBenefit?.playerId, playerId]);

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
        onStartGame={() => GameClient.startGame(gameId!)}
        onLeave={() => {
          GameClient.leaveGame(gameId!);
          setLocation('/');
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
      />
    );
  }

  const GameEndScoreModal = () => {
    if (game.currentPhase !== 'gameEnd') return null;

    const getTechTileLabel = (tileId: string) => {
      const t = ALL_TECH_TILES.find(x => x.id === tileId) || ALL_ADVANCED_TECH_TILES.find(x => x.id === tileId);
      return t?.label ?? tileId;
    };
    const sortedPlayerIds = game.turnOrder.length ? [...game.turnOrder] : Object.keys(game.players);
    const playersWithScores = sortedPlayerIds
      .map(pid => ({ pid, player: game.players[pid], faction: FACTIONS.find(f => f.id === game.players[pid]?.faction) }))
      .filter(x => x.player)
      .sort((a, b) => (b.player!.score ?? 0) - (a.player!.score ?? 0));

    return (
      <AlertDialog open={showGameEndScore} onOpenChange={setShowGameEndScore}>
        <AlertDialogContent className="bg-zinc-950 border-zinc-700 max-w-4xl max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <div className="flex items-center justify-between">
              <AlertDialogTitle className="text-2xl font-black uppercase tracking-widest text-amber-400">게임 종료 — 최종 점수</AlertDialogTitle>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setShowGameEndScore(false)} className="border-zinc-600 text-zinc-300">닫기 (맵 보기)</Button>
                <Button variant="destructive" onClick={() => setLocation('/')}>로비로 나가기</Button>
              </div>
            </div>
          </AlertDialogHeader>
          <div className="space-y-4 py-4">
            {playersWithScores.map(({ pid, player, faction }, idx) => {
              const b = player!.scoreBreakdown;
              const color = faction?.color ?? '#888';
              return (
                <div key={pid} className="rounded-xl border border-white/10 bg-zinc-900/60 overflow-hidden">
                  <div className="px-4 py-3 flex items-center justify-between border-b border-white/10" style={{ borderLeftWidth: 4, borderLeftColor: color }}>
                    <div className="flex items-center gap-3">
                      <span className="text-lg font-bold" style={{ color }}>{player!.name}</span>
                      {faction && <span className="text-sm text-zinc-400">{faction.name}</span>}
                    </div>
                    <div className="text-2xl font-black tabular-nums text-white">{player!.score ?? 0} VP</div>
                  </div>
                  <div className="p-4 text-sm space-y-3">
                    <div>
                      <div className="text-zinc-500 font-semibold mb-1">시작</div>
                      <div>10 VP</div>
                    </div>
                    {!b ? (
                      <p className="text-zinc-500">점수 내역 없음</p>
                    ) : (
                      <>
                        {b.roundMissions.length > 0 && (
                          <div>
                            <div className="text-zinc-500 font-semibold mb-1">라운드 미션</div>
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                              {b.roundMissions.map(({ round, vp }) => (
                                <span key={round}>R{round}: +{vp}</span>
                              ))}
                              <span className="text-zinc-400">= +{b.roundMissions.reduce((s, x) => s + x.vp, 0)}</span>
                            </div>
                          </div>
                        )}
                        {b.bonusTilePass.length > 0 && (
                          <div>
                            <div className="text-zinc-500 font-semibold mb-1">보너스 타일 패스</div>
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                              {b.bonusTilePass.map(({ round, vp }) => (
                                <span key={round}>R{round}: +{vp}</span>
                              ))}
                              <span className="text-zinc-400">= +{b.bonusTilePass.reduce((s, x) => s + x.vp, 0)}</span>
                            </div>
                          </div>
                        )}
                        {b.techTiles.length > 0 && (
                          <div>
                            <div className="text-zinc-500 font-semibold mb-1">기술 타일</div>
                            <ul className="list-disc list-inside space-y-0.5">
                              {b.techTiles.map(({ tileId, vp }, i) => (
                                <li key={i}>{getTechTileLabel(tileId)}: +{vp}</li>
                              ))}
                              <li className="text-zinc-400">= +{b.techTiles.reduce((s, x) => s + x.vp, 0)}</li>
                            </ul>
                          </div>
                        )}
                        {b.finalMissions > 0 && (
                          <div>
                            <div className="text-zinc-500 font-semibold mb-1">최종 미션</div>
                            <div>+{b.finalMissions}</div>
                          </div>
                        )}
                        {b.powerReceived > 0 && (
                          <div>
                            <div className="text-zinc-500 font-semibold mb-1">파워 수신 (지불)</div>
                            <div className="text-red-400">−{b.powerReceived}</div>
                          </div>
                        )}
                        {b.spaceships.length > 0 && (
                          <div>
                            <div className="text-zinc-500 font-semibold mb-1">우주선 보상</div>
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                              {b.spaceships.map(({ shipTileId, vp }, i) => (
                                <span key={i}>{shipTileId || '우주선'}: +{vp}</span>
                              ))}
                              <span className="text-zinc-400">= +{b.spaceships.reduce((s, x) => s + x.vp, 0)}</span>
                            </div>
                          </div>
                        )}
                        {b.researchTracks > 0 && (
                          <div>
                            <div className="text-zinc-500 font-semibold mb-1">연구 트랙 종료 보너스 (3→4, 4→8, 5→12점)</div>
                            <div>+{b.researchTracks}</div>
                          </div>
                        )}
                        {b.other.length > 0 && (
                          <div>
                            <div className="text-zinc-500 font-semibold mb-1">기타</div>
                            <ul className="list-disc list-inside space-y-0.5">
                              {b.other.map(({ source, vp }, i) => (
                                <li key={i}>{source}: {vp >= 0 ? '+' : ''}{vp}</li>
                              ))}
                              <li className="text-zinc-400">= {b.other.reduce((s, x) => s + x.vp, 0) >= 0 ? '+' : ''}{b.other.reduce((s, x) => s + x.vp, 0)}</li>
                            </ul>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
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
        const terraformingLevel = player.research.terraforming || 0;
        let terraformSteps = 0;
        let needsExtraTerraforming = false;

        if (tile.type === 'gaia') {
          qicCost += 1;
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

  const isHost = game && playerId === game.hostId;

  return (
    <div className="flex h-screen overflow-hidden bg-background font-sans text-foreground">
      {/* Sidebar */}
      <div className="w-80 border-r border-border bg-card flex flex-col shadow-2xl z-20">
        {/* 방장 전용: 한 컴퓨터 4인플 시 조작 플레이어 전환 */}
        {isHost && game && game.turnOrder.length > 1 && (
          <div className="p-2 border-b border-border">
            <label className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
              <Gamepad2 className="w-3.5 h-3.5" />
              조작할 플레이어
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
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="플레이어 선택" />
              </SelectTrigger>
              <SelectContent>
                {game.turnOrder.map((id) => {
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
        <PlayerPanel
          game={game}
          playerId={playerId}
          isCurrentTurn={isCurrentTurn}
          onEndTurn={() => GameClient.endTurn(gameId!)}
          onAdvanceTech={(trackId) => {
            if (game.hasDoneMainAction) return;
            setIsResearchOpen(false);
            setPendingAction({ type: 'advanceTech', trackId });
          }}
          onConvertResource={(type, useBrain) => GameClient.convertResource(gameId!, type, useBrain)}
          onBurnPower={(moveBrainToBowl3) => GameClient.burnPower(gameId!, moveBrainToBowl3)}
          onExit={() => {
            GameClient.leaveGame(gameId!);
            setLocation('/');
          }}
          onPass={() => setShowPassBonusModal(true)}
          onUseBonusAction={() => {
            // 테라포밍 액션인 경우 Research Board 닫기
            const player = game.players[playerId!];
            const bonusTile = game.availableBonusTiles.find(t => t.id === player.bonusTile) ||
              (player.bonusTile ? ALL_BONUS_TILES.find(t => t.id === player.bonusTile) : null);
            if (bonusTile?.specialAction === 'terraform_step') {
              setIsResearchOpen(false);
            }
            GameClient.useBonusAction(gameId!);
          }}
          onUseAcademyQic={() => {
            if (game.hasDoneMainAction) return;
            if (gameId) GameClient.useSpecialAction(gameId, 'academy-qic');
          }}
          onUseGleens2Nav={() => {
            if (game.hasDoneMainAction) return;
            if (gameId) GameClient.useSpecialAction(gameId, 'gleens-2nav');
          }}
          onUseBalTakGaiaformerToQic={() => {
            if (gameId) GameClient.useBalTakGaiaformerToQic(gameId);
          }}
        />
        {/* Game End: Show Score Button */}
        {game.currentPhase === 'gameEnd' && (
          <div className="p-4 border-t border-border mt-auto">
            <Button
              className="w-full bg-amber-600 hover:bg-amber-500 text-white font-bold"
              onClick={() => setShowGameEndScore(true)}
            >
              🏆 최종 점수 보기 (Final Score)
            </Button>
          </div>
        )}
        <div className="p-4 border-t border-border mt-auto space-y-2">
          <Button
            variant={isBonusTilesOpen ? 'default' : 'outline'}
            className="w-full justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95"
            onClick={() => {
              setIsBonusTilesOpen(!isBonusTilesOpen);
              setIsResearchOpen(false);
            }}
          >
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="h-5 w-5 p-0 flex items-center justify-center bg-black/50 border-white/20 text-[8px]">B</Badge>
              Bonus Tiles
            </div>
            {isBonusTilesOpen ? 'Close' : 'Open'}
          </Button>
          <Button
            variant={isResearchOpen ? 'default' : 'outline'}
            className="w-full justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95"
            onClick={() => {
              setIsResearchOpen(!isResearchOpen);
              setIsBonusTilesOpen(false);
            }}
          >
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="h-5 w-5 p-0 flex items-center justify-center bg-black/50 border-white/20 text-[8px]">R</Badge>
              Research Board
            </div>
            {isResearchOpen ? 'Close' : 'Open'}
          </Button>
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
          {/* 파이락(Firaks) 전용: Downgrade (Special) — 의회 보유 시 연구소→교역소 + 트랙 1칸, 라운드당 1회 */}
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
          {/* 모웨이드(Moweyip) 전용: 링 놓기 (Special) — 의회 보유 시 본인 건물 하나에 링 배치 (+2 파워 수신/연방), 라운드당 1회 */}
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
              onClick={() => gameId && GameClient.useSpecialAction(gameId, 'space_giants-2tf')}
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
              onClick={() => gameId && currentPlayer?.tinkeroidRoundSpecialId && GameClient.useSpecialAction(gameId, currentPlayer.tinkeroidRoundSpecialId)}
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

      <main className="flex-1 flex flex-col overflow-auto bg-zinc-900/20">
        <div className="flex-1 min-h-[600px]">
          <GameBoard
            game={game}
            playerId={playerId}
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
            onBuildMine={(tileId, useGaiaformer) => {
              if (game.hasDoneMainAction) return;
              const tile = game.map.find(t => t.id === tileId);
              if (!tile || !playerId) return;

              const player = game.players[playerId];
              const faction = FACTIONS.find(f => f.id === player.faction);
              if (!faction) return;

              // Check distance and reachability (+3 거리 보너스 반영)
              const baseRange = getEffectiveBaseRange(player);
              const playerStructures = game.map.filter(t => t.ownerId === playerId && (t.structure !== null && t.structure !== 'ship'));
              if (playerStructures.length === 0) return;

              const minDist = Math.min(...playerStructures.map(t => getDistance(t, tile)));

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
              setPendingAction({ type: 'usePowerAction', actionId });
            }}
            onEndTurn={() => GameClient.endTurn(gameId!)}
            onPass={() => setShowPassBonusModal(true)}
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
          />
        </div>

        {/* Dashboards Area: 보너스 타일 선택 단계면 접었다 펼칠 수 있는 패널, 아니면 라운드 보드 */}
        {isBonusSelectionPhase ? (
          <div className="border-t border-white/10 bg-zinc-950/95 backdrop-blur flex flex-col shrink-0 shadow-[0_-4px_24px_rgba(0,0,0,0.4)]">
            <button
              type="button"
              onClick={() => setIsBonusSelectionPanelExpanded((v) => !v)}
              className="flex items-center justify-between gap-4 w-full px-4 py-3 hover:bg-white/5 transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <Gift className="w-5 h-5 text-primary shrink-0" />
                <span className="font-black uppercase tracking-widest text-white">
                  Bonus Tile Selection
                </span>
                {isMyTurnBonusSelection ? (
                  <span className="text-xs text-zinc-400">Select your bonus tile</span>
                ) : (
                  <span className="text-xs text-amber-400/90 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                    Waiting for {waitingPlayerBonus?.name ?? 'other player'}...
                  </span>
                )}
              </div>
              <span className="text-zinc-400 shrink-0">
                {isBonusSelectionPanelExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
              </span>
            </button>
            {isBonusSelectionPanelExpanded && (
              <div className="px-4 pb-4 pt-1 max-h-[50vh] overflow-y-auto border-t border-white/5">
                <BonusTiles
                  game={game}
                  playerId={playerId}
                  isSelectionMode={isMyTurnBonusSelection}
                  onSelectBonusTile={(tileId) => GameClient.selectBonusTile(gameId!, tileId)}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 bg-black/40 border-t border-white/5 space-y-4">
            <div className="max-w-6xl mx-auto">
              <RoundBoard
                game={game}
                playerId={playerId}
                onPass={() => setShowPassBonusModal(true)}
                onEndGame={() => GameClient.passRound(gameId!, undefined)}
              />
            </div>
          </div>
        )}

        {/* Bonus Tiles Overlay */}
        {isBonusTilesOpen && (
          <div className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-xl flex flex-col items-center justify-center p-6 animate-in fade-in zoom-in duration-300">
            <div className="w-full max-w-5xl h-full flex flex-col gap-4">
              <div className="flex justify-between items-center bg-zinc-900/50 p-4 rounded-2xl border border-white/5 shadow-2xl">
                <div className="flex items-center gap-4">
                  <Gift className="w-5 h-5 text-primary" />
                  <h2 className="text-xl font-black uppercase tracking-widest text-white">Bonus Tiles</h2>
                  <Badge className="bg-primary/20 text-primary border-primary/20">Hotkey: B</Badge>
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
              <div className="flex-1 overflow-y-auto rounded-2xl shadow-inner bg-black/20 p-2 custom-scrollbar">
                <BonusTiles
                  game={game}
                  playerId={playerId}
                  onUseBonusAction={() => {
                    // 테라포밍 액션인 경우 Research Board 닫기
                    const player = game.players[playerId!];
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
          <div className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-xl flex flex-col items-center justify-center p-6 animate-in fade-in zoom-in duration-300">
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
                    setPendingAction({ type: 'useTechAction', tileId });
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
                  onSelectTechTile={(techTileId, trackId) => { if (gameId) GameClient.selectTechTile(gameId, techTileId, trackId); }}
                  onSelectAdvancedTechTile={(advancedTileId, trackId) => { if (gameId) GameClient.selectAdvancedTechTile(gameId, advancedTileId, trackId); }}
                  onConfirmAdvancedTechCover={(coverTileId) => { if (gameId) GameClient.confirmAdvancedTechCover(gameId, coverTileId); }}
                  onTakeTwilightArtifact={(artifactId) => { if (gameId) GameClient.takeTwilightArtifact(gameId, artifactId); }}
                  onUseAcademyQic={() => {
                    if (game.hasDoneMainAction) return;
                    if (gameId) GameClient.useSpecialAction(gameId, 'academy-qic');
                  }}
                  onEndTurn={() => { if (gameId) GameClient.endTurn(gameId); setIsResearchOpen(false); }}
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

        {/* Pass 시 보너스 타일 선택 모달 (0라운드 초기 선택은 하단 패널만 사용, X/Cancel 없음) */}
        <BonusSelectionModal
          open={(showPassBonusModal || isPendingBonusSelection) && game.currentPhase !== 'bonusSelection'}
          onClose={() => {
            if (!isPendingBonusSelection) {
              setShowPassBonusModal(false);
            }
            // pendingBonusSelection이 있으면 취소 불가 (필수 선택)
          }}
          game={game}
          playerId={playerId}
          mode="pass"
          onSelectBonusTile={(tileId) => {
            GameClient.passRound(gameId!, tileId);
            setShowPassBonusModal(false);
          }}
        />

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

        {/* Power Offer Dialog */}
        {game.pendingPowerOffers && game.pendingPowerOffers.length > 0 && (
          <>
            {game.pendingPowerOffers
              .filter(offer => {
                if (offer.responded) return false;
                const isTargetMe = offer.targetPlayerId === playerId;
                const viewingBot = playerId && game.botPlayerIds?.includes(playerId);
                const targetHuman = !game.botPlayerIds?.includes(offer.targetPlayerId);
                return isTargetMe || (viewingBot && targetHuman);
              })
              .map(offer => {
                const sourcePlayer = game.players[offer.sourcePlayerId];
                return (
                  <AlertDialog key={offer.id} open={true} onOpenChange={() => { }}>
                    <AlertDialogContent className="bg-zinc-900 border-zinc-700 w-[360px] min-w-[360px] min-h-[320px] flex flex-col">
                      <AlertDialogHeader>
                        <AlertDialogTitle className="text-white font-black uppercase tracking-wider">
                          파워 수신
                        </AlertDialogTitle>
                        <AlertDialogDescription className="text-zinc-300">
                          {sourcePlayer?.name}의 건물로부터 파워를 받을 수 있습니다.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <div className="space-y-4 py-4 flex-1 min-h-0">
                        <div className="bg-blue-500/10 border-2 border-blue-500/30 rounded-lg p-4">
                          <div className="text-4xl font-black text-blue-400 text-center mb-2">
                            +{offer.amount} Power
                          </div>
                          <div className="text-center text-zinc-400 text-sm">
                            비용: {offer.vpCost} VP
                          </div>
                          {currentPlayer && (
                            <div className="text-center text-zinc-500 text-xs mt-2">
                              현재 파워: {currentPlayer.power1}/{currentPlayer.power2}/{currentPlayer.power3}
                              {currentPlayer.faction === 'taklons' && (currentPlayer as PlayerState).brainStoneInGaia && (
                                <span className="ml-1 text-amber-400">· B(가이아)</span>
                              )}
                            </div>
                          )}
                        </div>
                        {currentPlayer?.faction === 'taklons' && (
                          <div className="space-y-3 border border-amber-500/30 rounded-lg p-3 bg-amber-500/5">
                            <div className="text-[10px] font-bold text-amber-300 uppercase tracking-wider">타클론 선택</div>
                            <div className="flex gap-2">
                              <Button size="sm" variant={powerOfferBrainFirst ? 'default' : 'outline'} className="flex-1 text-xs bg-amber-600 hover:bg-amber-500" onClick={() => setPowerOfferBrainFirst(true)}>브레인 스톤 우선</Button>
                              <Button size="sm" variant={!powerOfferBrainFirst ? 'default' : 'outline'} className="flex-1 text-xs border-amber-500/50" onClick={() => setPowerOfferBrainFirst(false)}>다른 파워 우선</Button>
                            </div>
                            {game?.map && (currentPlayer as PlayerState) && game.map.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute') && (
                              <div className="flex gap-2 pt-1 border-t border-amber-500/20">
                                <Button size="sm" variant={powerOfferPiAddFirst ? 'default' : 'outline'} className="flex-1 text-xs bg-amber-600/80 hover:bg-amber-500/80" onClick={() => setPowerOfferPiAddFirst(true)}>1그릇 추가 후 수령</Button>
                                <Button size="sm" variant={!powerOfferPiAddFirst ? 'default' : 'outline'} className="flex-1 text-xs border-amber-500/50" onClick={() => setPowerOfferPiAddFirst(false)}>수령 후 1그릇 추가</Button>
                              </div>
                            )}
                          </div>
                        )}
                        {offer.vpCost > (currentPlayer?.score || 0) ? (
                          <div className="text-red-400 text-xs text-center min-h-[2rem]">
                            ⚠ VP가 부족합니다. 최대 {(currentPlayer?.score || 0) + 1}파워만 받을 수 있습니다.
                          </div>
                        ) : (
                          <div className="min-h-[2rem]" aria-hidden />
                        )}
                      </div>
                      <AlertDialogFooter className="flex gap-2 flex-shrink-0">
                        <Button
                          variant="outline"
                          className="flex-1 bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20"
                          onClick={() => {
                            if (gameId) GameClient.respondPowerOffer(gameId, offer.id, false);
                          }}
                        >
                          거부
                        </Button>
                        <Button
                          className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold"
                          onClick={() => {
                            if (gameId) GameClient.respondPowerOffer(gameId, offer.id, true, currentPlayer?.faction === 'taklons' ? powerOfferBrainFirst : undefined, (currentPlayer as PlayerState)?.faction === 'taklons' && game?.map?.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute') ? powerOfferPiAddFirst : undefined);
                          }}
                        >
                          수락
                        </Button>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                );
              })}
          </>
        )}

        {/* Twilight 액션1: 보유 연방 중 하나 선택해서 해택 재수령 */}
        {game.pendingTwilightFederation && game.pendingTwilightFederation.playerId === playerId && gameId && (() => {
          const myFedIds = getFederationEntries(currentPlayer as PlayerState).map((f) => f.rewardId);
          const myRewards = myFedIds.map((id) => FEDERATION_REWARDS.find((r) => r.id === id)).filter(Boolean);
          return (
            <AlertDialog open={true} onOpenChange={() => { }}>
              <AlertDialogContent className="bg-zinc-900 border-zinc-700 max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white font-black uppercase tracking-wider">Twilight: 연방 해택 재수령</AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-300">보유한 연방 중 받을 보상을 하나 선택하세요 (3Q 지불됨).</AlertDialogDescription>
                </AlertDialogHeader>
                <div className="grid grid-cols-2 gap-2 py-4">
                  {myRewards.length === 0 ? (
                    <p className="col-span-2 text-zinc-500 text-sm">보유한 연방이 없습니다.</p>
                  ) : (
                    myRewards.map((reward) => (
                      reward && (
                        <Button
                          key={reward.id}
                          variant="outline"
                          className="bg-zinc-800 border-zinc-600"
                          onClick={() => GameClient.confirmTwilightFederation(gameId, reward.id)}
                        >
                          {reward.label}
                        </Button>
                      )
                    ))
                  )}
                </div>
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
                    return (
                      <Button
                        key={reward.id}
                        variant="outline"
                        className="bg-zinc-800 border-zinc-600"
                        onClick={() => GameClient.federationSelectReward(gameId, reward.id)}
                      >
                        {reward.label} <span className="text-zinc-500 text-[10px] ml-1">({remaining}개 남음)</span>
                      </Button>
                    );
                  })}
                  {shipRewardsAvailable.map(({ shipType, reward }) => reward && (
                    <Button
                      key={`${shipType}-${reward.id}`}
                      variant="outline"
                      className="bg-cyan-950/50 border-cyan-500/50"
                      onClick={() => GameClient.federationSelectReward(gameId, reward.id)}
                    >
                      🚀 {reward.label}
                    </Button>
                  ))}
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
          <AlertDialog open={true} onOpenChange={() => { }}>
            <AlertDialogContent className="bg-zinc-900 border-zinc-700 max-w-md">
              <AlertDialogHeader>
                <AlertDialogTitle className="text-white font-black uppercase tracking-wider">
                  {game.pendingTFMarsGaiaProject.shipTileId === 'bonus-gaia' ? 'Bonus: 가이아 프로젝트' : 'TF Mars: 가이아 프로젝트'}
                </AlertDialogTitle>
                <AlertDialogDescription className="text-zinc-300">
                  포밍 보너스 타일과 동일한 액션: 보라색(Transdim) 행성에 가이아포머를 배치하세요. 맵에서 배치할 타일을 선택하거나, 불가능하면 건너뛰기를 누르세요.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="flex justify-end pt-2">
                <Button variant="outline" className="bg-zinc-800 border-zinc-600" onClick={() => GameClient.skipTFMarsGaiaProject(gameId)}>
                  건너뛰기
                </Button>
              </div>
            </AlertDialogContent>
          </AlertDialog>
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

        {/* Income Selection Dialog - 수익 단계에서 맨 앞에 표시 (z-[100]) */}
        {(() => {
          const pending = game.pendingIncomeOrder;
          if (!pending) return null;
          const isTargetMe = pending.playerId === playerId;
          const viewingBot = playerId && game.botPlayerIds?.includes(playerId);
          const targetHuman = !game.botPlayerIds?.includes(pending.playerId);
          if (!(isTargetMe || (viewingBot && targetHuman))) return null;

          const actualPlayer = game.players[pending.playerId];
          if (!actualPlayer) return null;

          return (
            <AlertDialog open={true} onOpenChange={() => { }}>
              <AlertDialogContent className="bg-zinc-900 border-zinc-700 max-w-2xl z-[100]">
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
                        let p1 = actualPlayer.power1 ?? 0, p2 = actualPlayer.power2 ?? 0, p3 = actualPlayer.power3 ?? 0;
                        pending.incomeItems.forEach((item) => {
                          if (item.type === 'power') {
                            let rem = item.amount;
                            const from1 = Math.min(rem, p1);
                            p1 -= from1; p2 += from1; rem -= from1;
                            const from2 = Math.min(rem, p2);
                            p2 -= from2; p3 += from2;
                          } else {
                            p1 += item.amount;
                          }
                        });
                        return (
                          <p className="text-[10px] text-zinc-500">
                            자동 받기 시 결과: 1/2/3그릇 → <span className="font-mono text-zinc-300 font-bold">{p1} / {p2} / {p3}</span>
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
          <div className="absolute top-20 right-4 z-50 w-96 max-h-[80vh] overflow-y-auto bg-zinc-900/95 border border-zinc-700 rounded-xl p-4 shadow-2xl">
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

      <div className="w-64 border-l border-border bg-card p-4 flex flex-col overflow-y-auto">
        {/* Confirmation Overlay - Fixed in sidebar */}
        {pendingAction && (
          <div className="mb-4 p-4 bg-black/90 border border-yellow-500/50 rounded-xl shadow-[0_0_20px_rgba(234,179,8,0.2)] space-y-3">
            <h3 className="text-yellow-500 font-black uppercase tracking-wider text-xs text-center">Confirm Action</h3>
            <div className="flex flex-wrap justify-center gap-3">
              {cost?.ore && (
                <div className="text-center">
                  <div className={`text-lg font-black ${cost.needsExtraTerraforming ? 'text-red-500' : 'text-orange-500'}`}>
                    {cost.ore}
                  </div>
                  <div className="text-[9px] uppercase text-zinc-500 font-bold">Ore</div>
                  {cost.terraformSteps && cost.terraformSteps > 0 && (
                    <div className="text-[8px] text-zinc-400 mt-1">
                      {cost.terraformSteps} step{cost.terraformSteps > 1 ? 's' : ''} @ {getTerraformCost(cost.terraformingLevel || 0)}/step
                      {cost.terraformDiscount && cost.terraformDiscount > 0 && (
                        <span className="text-green-400 ml-1">
                          (-{cost.terraformDiscount} free)
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
              {cost?.credits && cost.credits > 0 && <div className="text-center"><div className="text-lg font-black text-yellow-500">{cost.credits}</div><div className="text-[9px] uppercase text-zinc-500 font-bold">Credits</div></div>}
              {cost?.gaiaformers && <div className="text-center"><div className="text-lg font-black text-cyan-500">{cost.gaiaformers}</div><div className="text-[9px] uppercase text-zinc-500 font-bold">Gaiaformer</div></div>}
              {cost?.knowledge && <div className="text-center"><div className="text-lg font-black text-blue-500">{cost.knowledge}</div><div className="text-[9px] uppercase text-zinc-500 font-bold">Knowledge</div></div>}
              {cost?.qic && <div className="text-center"><div className="text-lg font-black text-green-500">{cost.qic}</div><div className="text-[9px] uppercase text-zinc-500 font-bold">QIC</div></div>}
            </div>
            {cost?.needsExtraTerraforming && (
              <div className="text-[9px] text-red-400 text-center font-bold bg-red-500/10 p-2 rounded border border-red-500/30">
                ⚠️ Terraforming Level {cost.terraformingLevel} - Extra terraforming required!
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="flex-1 border-white/10 hover:bg-white/5 text-[9px] font-bold" onClick={() => setPendingAction(null)}>Undo</Button>
              <Button size="sm" className="flex-1 bg-yellow-500 text-black hover:bg-yellow-400 text-[9px] font-bold" onClick={handleConfirm}>Confirm</Button>
            </div>
            {/* Reset 및 End Turn 버튼을 확인 영역에 추가 (보너스 선택 단계 제외) */}
            {game.hasDoneMainAction && game.turnOrder[game.currentPlayerIndex] === playerId && game.currentPhase === 'main' && game.pendingTFMarsGaiaProject?.playerId !== playerId && (
              <div className="flex gap-2 mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1 border-red-500/50 hover:bg-red-500/20 text-red-400 text-[9px] font-bold"
                  onClick={() => {
                    GameClient.resetTurn(gameId!);
                    setPendingAction(null);
                  }}
                >
                  Reset
                </Button>
                <Button
                  size="sm"
                  className="flex-1 bg-green-600 hover:bg-green-500 text-white text-[9px] font-bold"
                  onClick={() => gameId && GameClient.endTurn(gameId)}
                >
                  End Turn
                </Button>
              </div>
            )}
          </div>
        )}

        {/* 연방 구현: 모드 진입/취소 및 완료 */}
        {game && game.currentPhase === 'main' && game.turnOrder[game.currentPlayerIndex] === playerId && !game.hasDoneMainAction && !game.pendingFederationReward && (
          <div className="mb-4 p-3 bg-black/80 border border-sky-500/40 rounded-xl">
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
                </div>
              </div>
            ) : (
              <Button size="sm" className="w-full bg-sky-600/80 hover:bg-sky-500 text-white text-[9px] font-bold" onClick={() => gameId && GameClient.federationToggleMode(gameId)}>연방 구현</Button>
            )}
          </div>
        )}

        {/* 가이아 포머 설치 등 pendingAction 없이도 End Turn 가능하도록 (보너스 선택 단계 제외) */}
        {!pendingAction && game && game.hasDoneMainAction && game.turnOrder[game.currentPlayerIndex] === playerId && game.currentPhase === 'main' && game.pendingTFMarsGaiaProject?.playerId !== playerId && (
          <div className="mb-4 p-4 bg-black/90 border border-green-500/50 rounded-xl shadow-[0_0_20px_rgba(34,197,94,0.2)]">
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="flex-1 border-red-500/50 hover:bg-red-500/20 text-red-400 text-[9px] font-bold"
                onClick={() => {
                  GameClient.resetTurn(gameId!);
                }}
              >
                Reset
              </Button>
              <Button
                size="sm"
                className="flex-1 bg-green-600 hover:bg-green-500 text-white text-[9px] font-bold"
                onClick={() => gameId && GameClient.endTurn(gameId)}
              >
                End Turn
              </Button>
            </div>
          </div>
        )}

        <h3 className="font-semibold mb-4 flex items-center gap-2">
          <Users className="w-4 h-4" />
          Players
        </h3>
        <div className="space-y-2">
          {(game.turnOrder ?? Object.keys(game.players)).map((id) => {
            const p = game.players[id] as PlayerState | undefined;
            if (!p) return null;
            const fedEntries = getFederationEntries(p);
            const faction = p.faction ? FACTIONS.find((f) => f.id === p.faction) : null;
            const isYou = id === playerId;
            const isCurrentTurn = game.turnOrder?.[game.currentPlayerIndex] === id;
            const expanded = expandedPlayerId === id;
            const counts = getStructureCountsForPlayer(game, id);
            return (
              <div
                key={id}
                className={`rounded-lg border text-sm overflow-hidden ${isYou ? 'bg-primary/15 border-primary/50' : 'bg-muted/50 border-border'}`}
              >
                <button
                  type="button"
                  className="w-full text-left p-2.5 flex items-center justify-between gap-2 min-w-0 hover:bg-white/5 transition-colors"
                  onClick={() => setExpandedPlayerId((prev) => (prev === id ? null : id))}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: faction?.color ?? '#666' }} />
                    <span className="truncate font-medium">{faction ? `${faction.name} (${p.name})` : p.name}</span>
                    {isYou && <span className="text-[10px] text-primary flex-shrink-0">(나)</span>}
                    {isCurrentTurn && !p.hasPassed && (
                      <span className="text-[9px] bg-primary/30 text-primary px-1.5 py-0.5 rounded flex-shrink-0">턴</span>
                    )}
                  </div>
                  <span className="text-base font-bold text-white flex-shrink-0">{p.score}</span>
                  <span className="text-muted-foreground flex-shrink-0">{expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</span>
                </button>
                <div className="px-2.5 pb-2 text-[10px] text-zinc-400 font-mono">
                  M<span className="text-amber-300/90">{counts.mineCount}</span>/{BUILDING_LIMITS.mine}
                  <span className="mx-1">TS</span><span className="text-yellow-400/90">{counts.tsCount}</span>/{BUILDING_LIMITS.trading_station}
                  <span className="mx-1">Lab</span><span className="text-blue-400/90">{counts.labCount}</span>/{BUILDING_LIMITS.research_lab}
                  <span className="mx-1">PI</span><span className="text-purple-400/90">{counts.piCount}</span>/{BUILDING_LIMITS.planetary_institute}
                  <span className="mx-1">A</span><span className="text-indigo-400/90">{counts.academyLeft}+{counts.academyRight}</span>/{BUILDING_LIMITS.academy}
                </div>
                <div className="px-2.5 pb-2 grid grid-cols-4 gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                  <span>O <span className="text-amber-400 font-medium">{p.ore ?? 0}</span></span>
                  <span>K <span className="text-blue-400 font-medium">{p.knowledge ?? 0}</span></span>
                  <span>C <span className="text-yellow-500 font-medium">{p.credits ?? 0}</span></span>
                  <span>Q <span className="text-green-400 font-medium">{p.qic ?? 0}</span></span>
                  <span className="col-span-4">
                    포머 <span className="text-teal-300 font-medium">{p.gaiaformers ?? 0}</span>
                    <span className="mx-1">G:<span className="text-emerald-400">{p.gaiaformerPower ?? 0}</span></span>
                    I:<span className="text-blue-400">{p.power1 ?? 0}</span> II:<span className="text-cyan-400">{p.power2 ?? 0}</span> III:<span className="text-amber-400">{p.power3 ?? 0}</span>
                  </span>
                </div>
                {expanded && (
                  <div className="px-2.5 pb-3 pt-1 border-t border-white/5 space-y-2 text-[10px]">
                    {p.faction && (
                      <div>
                        <span className="text-muted-foreground">종족 </span>
                        <Badge variant="outline" className="text-[9px] py-0">{p.faction}</Badge>
                      </div>
                    )}
                    {fedEntries.length > 0 && (
                      <div>
                        <span className="text-muted-foreground font-medium">연방 </span>
                        <span className="flex flex-wrap gap-x-1.5 gap-y-0.5 mt-0.5">
                          {fedEntries.map((f, i) => {
                            const label = FEDERATION_REWARDS.find((r) => r.id === f.rewardId)?.label ?? SPACESHIP_FEDERATION_REWARDS.find((r) => r.id === f.rewardId)?.label ?? f.rewardId;
                            return (
                              <span
                                key={`${f.rewardId}-${i}`}
                                className={f.isGreen ? 'text-green-500 font-medium' : 'text-red-400'}
                                title={f.isGreen ? '초록: 미사용' : '빨강: 사용됨'}
                              >
                                {label}{f.isGreen ? ' ●' : ' ○'}
                              </span>
                            );
                          })}
                        </span>
                      </div>
                    )}
                    {(p.techTiles?.length ?? 0) > 0 && (
                      <div>
                        <span className="text-muted-foreground font-medium">기술 타일 </span>
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {(p.techTiles ?? []).map((tileId) => {
                            const tile = ALL_TECH_TILES.find((t) => t.id === tileId) ?? ALL_ADVANCED_TECH_TILES.find((t) => t.id === tileId);
                            const covered = isTechTileCovered(p, tileId);
                            const isAdv = tileId.startsWith('adv-');
                            return (
                              <span
                                key={tileId}
                                className={`px-1.5 py-0.5 rounded ${covered ? 'bg-zinc-700/60 text-zinc-500 line-through' : isAdv ? 'bg-cyan-900/50 text-cyan-300 border border-cyan-500/30' : 'bg-yellow-900/30 text-yellow-200/90 border border-yellow-500/20'}`}
                                title={tile?.description}
                              >
                                {tile?.label ?? tileId}{covered ? ' (덮힘)' : ''}
                              </span>
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
                            return art ? (
                              <span key={aid} className="px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-200 text-[9px]" title={art.description}>{art.label}</span>
                            ) : null;
                          })}
                        </div>
                      </div>
                    )}
                    {p.bonusTile && (() => {
                      const bonus = ALL_BONUS_TILES.find((t) => t.id === p.bonusTile);
                      return bonus ? (
                        <div>
                          <span className="text-muted-foreground">보너스 </span>
                          <span className="text-amber-200/90 font-medium">{bonus.label}</span>
                          {bonus.specialAction && (
                            <span className="text-zinc-500 ml-1">
                              스페셜 <span className={p.usedBonusAction ? 'text-red-400/90' : 'text-green-400/90'}>{p.usedBonusAction ? '사용함' : '미사용'}</span>
                            </span>
                          )}
                        </div>
                      ) : null;
                    })()}
                    {p.faction === 'ivits' && (
                      <div>
                        <span className="text-muted-foreground">우주정거장 </span>
                        <span className={p.usedIvitsSpaceStationThisRound ? 'text-red-400/90' : 'text-green-400/90'}>
                          {p.usedIvitsSpaceStationThisRound ? '사용함' : '미사용'}
                        </span>
                      </div>
                    )}
                    {p.faction === 'moweyip' && game.map?.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === id && t.structure === 'planetary_institute') && (
                      <div>
                        <span className="text-muted-foreground">링 놓기 (Special) </span>
                        <span className={(p as any).usedSpecialActions?.includes('moweyip-place-ring') ? 'text-red-400/90' : 'text-green-400/90'}>
                          {(p as any).usedSpecialActions?.includes('moweyip-place-ring') ? '사용함' : '미사용'}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4 pt-4 border-t">
          <Badge variant="outline" className="w-full justify-center">
            Round {game.roundNumber}
          </Badge>
        </div>

        {/* Game Log */}
        <div className="mt-4 pt-4 border-t">
          <h3 className="font-semibold mb-3 flex items-center gap-2 text-sm">
            <Clock className="w-4 h-4" />
            Game Log
          </h3>
          <ScrollArea className="h-[300px]">
            <div className="space-y-2 pr-2">
              {(!game.gameLog || game.gameLog.length === 0) ? (
                <div className="text-center text-muted-foreground text-xs py-8">
                  No actions yet
                </div>
              ) : (
                game.gameLog.map((log, index) => {
                  const formatTime = (timestamp: number) => {
                    const date = new Date(timestamp);
                    return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  };
                  return (
                    <div
                      key={index}
                      className={`flex items-start gap-2 p-2 rounded-lg border text-xs transition-colors ${log.tileId
                        ? 'bg-muted/50 border-border hover:bg-muted hover:border-primary/50 cursor-pointer'
                        : 'bg-muted/30 border-border'
                        }`}
                      onMouseEnter={() => log.tileId && setHighlightedTileId(log.tileId)}
                      onMouseLeave={() => setHighlightedTileId(null)}
                    >
                      <div className="flex-shrink-0 text-[10px] text-muted-foreground font-mono mt-0.5">
                        {formatTime(log.timestamp)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <User className="w-3 h-3 text-primary flex-shrink-0" />
                          <span className="text-[11px] font-semibold truncate">
                            {log.playerName}
                          </span>
                        </div>
                        <div className="text-[11px] text-foreground">
                          <span className="font-semibold text-primary">{log.action}</span>
                          {log.details && (
                            <span className="text-muted-foreground ml-2">{log.details}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Debug Panel - now inside sidebar */}
        <div className="mt-4 pt-4 border-t flex-1 overflow-y-auto">
          <DebugPanel game={game} playerId={playerId} />
        </div>
      </div>
    </div>
  );
}
