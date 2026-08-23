import { useState, useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type ComponentProps, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useDragControls } from 'framer-motion';
import { useParams, useLocation } from 'wouter';
import { GameClient, getSocket, getStoredPlayerId, getStoredSpectatorId, storePlayerId, type GameState, type PlayerState } from '@/lib/gameClient';
import { playerIdsForFactionBiddingUi } from '@/lib/factionBiddingPlayerOrder';
import { useIsMobile } from '@/hooks/use-mobile';

import { ResearchBoard } from '@/components/ResearchBoard';
import { RoundBoard } from '@/components/RoundBoard';
import { GameBoard } from '@/components/GameBoard';
import { BonusTiles } from '@/components/BonusTiles';
import { BonusSelectionModal } from '@/components/BonusSelectionModal';
import { FreeActionsDialog } from '@/components/FreeActionsDialog';
import { ChatPanel } from '@/components/ChatPanel';

import { PlayerPanel } from '@/components/PlayerPanel';
import { GameLog } from '@/components/GameLog';
import { FactionSelect } from '@/components/FactionSelect';
import { FactionBiddingPanel } from '@/components/FactionBiddingPanel';
import { GameLobby } from '@/components/GameLobby';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { playMyTurnSound, playOtherTurnSound, playPowerReceiveSound, playPowerDecisionSound, playEndSound, playPassWarnSound } from '@/lib/audio';
import { actionParts, clearVoiceQueue, ENABLER_LABELS, enqueueParts, isFollowupInfo, isVoiceOn, primeSpeech, whoLabel } from '@/lib/speech';
import { ArrowLeft, Users, Gift, Clock, User, ChevronDown, ChevronUp, Gamepad2, FlaskConical, Layers, Trophy, Star, Flag, Shield, Ship, Mountain, Menu, X, Eye, ChevronRight, Info, Maximize, RefreshCw } from 'lucide-react';
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

import { FACTIONS, RESEARCH_TRACKS, ALL_TECH_TILES, SHIP_TECH_TILES, ALL_ADVANCED_TECH_TILES, ALL_BONUS_TILES, FEDERATION_REWARDS, SPACESHIP_FEDERATION_REWARDS, GLEENS_FEDERATION_REWARD, BUILDING_LIMITS, PLANET_COLORS, HOME_PLANETS, getTerraformSteps, getTerraformStepsForFaction, getGaiaBaseQic, getTerraformCost, getRange, getEffectiveBaseRange, getDistance, hasNearbyPlayersForTradingDiscount, getFederationEntries, isTechTileCovered, ARTIFACTS, getNextRoundIncomePreview, findOptimalIncomeOrder, simulateIncomeOrder, ROUND_MISSION_POOL, FINAL_MISSION_LABELS, getFinalMissionValue, getFinalMissionVp, canSpendTaklonsPower, planTaklonsPowerBurns, countSpendableTokens, doomedBowl3Tokens, isBrainCashableBeforeTokenCost, computePassScorePreview, getMaxPowerGain } from '@shared/gameConfig';
import type { StructureType, ResearchTrack, PlanetType } from '@shared/gameConfig';
import { applyGameStateDelta, buildClientGameState, type GameDeltaMessage, type GameSyncMessage } from '@shared/gameSync';

/** 팅커로이드 라운드 Special 액션 ID → 라벨 (1–3R: 테라1스텝·1QIC·4파워 / 4–6R: 3K·2QIC·테라3스텝)
 *  [사용자 2026-08-09] 예전 '1 TF + 광산 건설' 표기는 오해 — 실제로는 테라포밍 단계만 주고 광산은 직접 짓는다(보너스 타일 테라 액션과 동일). */
const TINKEROID_SPECIAL_LABELS: Record<string, string> = {
  'tinkeroid-1tf-mine': 'Terraform 1 Step',
  'tinkeroid-1qic': '1 QIC',
  'tinkeroid-4power': '4 Power',
  'tinkeroid-3k': '3 Knowledge',
  'tinkeroid-2qic': '2 QIC',
  'tinkeroid-3tf-mine': 'Terraform 3 Steps',
};
/** 칩(스트립)용 짧은 표기 — 다른 종족 칩(스자:2 Step 등)과 'Step' 용어 통일 */
const TINKEROID_SPECIAL_SHORT: Record<string, string> = {
  'tinkeroid-1tf-mine': '1 Step',
  'tinkeroid-1qic': '1 QIC',
  'tinkeroid-4power': '4 Power',
  'tinkeroid-3k': '3 Knowledge',
  'tinkeroid-2qic': '2 QIC',
  'tinkeroid-3tf-mine': '3 Step',
};
/** [용어 2026-08-09 사용자] 액션형 기술타일 칩 표기 — 접두는 'Act', 내용은 줄임말 대신 전체 표기 */
const TECH_ACT_FULL: Record<string, string> = {
  'tech-act-4p': '4 Power',
  'adv-act-3k': '3 Knowledge',
  'adv-act-3o': '3 Ore',
  'adv-act-1q-5c': '1 QIC + 5 Credits',
};
/** 위 표에 없으면 타일 라벨의 'ACT: ' 접두만 떼서 사용(신규 타일 대비) */
const techActLabel = (id: string, label: string) => TECH_ACT_FULL[id] ?? label.replace(/^ACT:\s*/, '');

/** 팅커로이드 특수 ID → 이미지 (client/public/tinker/tile_0N.png). 인덱스 1~6 = 1tf-mine,1qic,4power,3k,2qic,3tf-mine */
const TINKEROID_SPECIAL_IMAGES: Record<string, string> = {
  'tinkeroid-1tf-mine': '/tinker/tile_01.png',
  'tinkeroid-1qic': '/tinker/tile_02.png',
  'tinkeroid-4power': '/tinker/tile_03.png',
  'tinkeroid-3k': '/tinker/tile_04.png',
  'tinkeroid-2qic': '/tinker/tile_05.png',
  'tinkeroid-3tf-mine': '/tinker/tile_06.png',
};

/**
 * 결과 화면 '점수 구성'의 기타(other) 항목 라벨 — 서버 source 문자열은 저장된 게임 JSON·분석 스크립트가
 * 참조하므로 건드리지 않고 표시 시점에만 한글화한다(사용자 2026-08-03: "칼럼 왼쪽 탭에 영어 잔여").
 */
const SCORE_SOURCE_LABELS: Record<string, string> = {
  'Gaia Project track reward': '가이아 트랙 보상',
  'Economy track reward': '경제 트랙 보상',
  'Proto Planet': '원시 행성 건설',
  'Gleens Gaia Bonus': '글린 가이아 보너스',
  'Artifact: Gaia x 3': '인공물: 가이아 ×3',
  'Artifact: Science x 3': '인공물: 과학 ×3',
  'Artifact: Tracks >= 3': '인공물: 트랙 3단계 이상',
  'Artifact: Planet types': '인공물: 행성 종류',
  'Artifact: 7 VP + Asteroid': '인공물: 7VP + 소행성',
  'Artifact: 7 VP + Proto': '인공물: 7VP + 원시',
  'Artifact: Bridge VP': '인공물: 외각 VP',
};

/** 연방으로 합칠 소스인지 — 연방 보상 계열 + 테라포밍 5 보상(규칙상 연방 토큰 지급이라 별도 줄이면 헷갈림, 사용자 요청) */
const isFederationScoreSource = (source: string): boolean =>
  source.toLowerCase().includes('federation') || source.includes('연방') || source === 'Terraforming 5 Reward';

/** 레거시 폴백(addScore에서 분류 실패 시 `Uncategorized: <category>`)의 내부 키 → 한글 */
const SCORE_CATEGORY_LABELS: Record<string, string> = {
  roundMissions: '라운드 미션', bonusTilePass: '보너스 타일(패스)', techTiles: '기술 타일',
  finalMissions: '최종 미션', researchTracks: '연구 트랙', remainingResources: '잔여 자원',
  powerReceived: '파워 수령', spaceships: '우주선', other: '기타',
};

/** other 항목 표시 라벨(연방 계열은 '연방'으로 합산) */
const scoreSourceLabel = (source: string): string => {
  if (isFederationScoreSource(source)) return '연방';
  if (SCORE_SOURCE_LABELS[source]) return SCORE_SOURCE_LABELS[source];
  const uncategorized = source.match(/^Uncategorized:\s*(.*)$/);
  if (uncategorized) {
    const key = uncategorized[1].trim();
    return `미분류: ${SCORE_CATEGORY_LABELS[key] ?? key}`;
  }
  return source;
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

/** 라운드당 1회용 특수 액션 하나의 상태 (상태창 상세에서 실행하는 것들) */
type SpecialActionKind = 'tech' | 'bonus' | 'academy' | 'faction';
/** [2026-08-09 사용자] 칩에서 종족 이름을 빼는 대신, 종족 고유 능력은 색으로 구분한다(kind='faction'). */
type SpecialActionState = { key: string; label: string; short: string; used: boolean; actionId: string; kind: SpecialActionKind };

/**
 * 한 플레이어의 '라운드 1회용 특수 액션' 목록과 사용 여부.
 * [2026-08-07 사용자] 남의 액션이 남았는지(예: 고급타일 3O·1Q+5C, 아카데미 QIC) 보려고 상태창을
 *   계속 열었다 닫았다 하는 게 번거롭다 → 패널에 칩으로 상시 표시하려고, 패스 경고에 있던
 *   동일 열거 로직을 여기로 모아 양쪽이 같은 목록을 쓰게 한다.
 * 고급 타일에 덮인 기술 타일은 액션을 못 쓰므로 목록에서 제외한다.
 */
function getSpecialActionsForPlayer(game: GameState, pid: string): SpecialActionState[] {
  const p = game.players?.[pid];
  if (!p) return [];
  const out: SpecialActionState[] = [];
  const used = p.usedSpecialActions ?? [];
  const hasPI = game.map?.some(t => t.ownerId === pid && t.structure === 'planetary_institute') ?? false;

  // 1) 기술 타일 액션 (ACT: 4P / 3K / 3O / 1Q+5C)
  (p.techTiles ?? []).forEach(tid => {
    const tile = ALL_TECH_TILES.find(t => t.id === tid) ?? ALL_ADVANCED_TECH_TILES.find(t => t.id === tid);
    if (!tile?.specialAction) return;
    if ((p.coveredTechTiles ?? []).includes(tid)) return;
    out.push({
      key: `tech:${tid}`,
      actionId: tid,
      label: `Act: ${techActLabel(tid, tile.label)}`,
      // [용어 정리 2026-08-09 사용자] 칩은 폭이 좁은데 타일 라벨이 'ACT: 4P'라 '기술:ACT: 4P'로 중복 표기됐다 → 접두 제거
      short: `Act: ${techActLabel(tid, tile.label)}`,
      kind: 'tech' as const,
      used: (p.usedTechActions ?? []).includes(tid),
    });
  });

  // 2) 보너스 타일 특수 액션
  const bonus = p.bonusTile ? ALL_BONUS_TILES.find(t => t.id === p.bonusTile) : null;
  if (bonus?.specialAction) {
    const names: Record<string, string> = { terraform_step: '1 Step', gaia_project: 'Gaia', range_3: '+3 Range' };
    const actionLabel = names[bonus.specialAction] ?? bonus.specialAction;
    out.push({
      key: 'bonus',
      actionId: 'bonusAction',
      label: `Bonus Tile: ${actionLabel}`,
      short: `Bonus Tile: ${actionLabel}`, // [2026-08-09 사용자] '보너스 Special:' 중복 표기 정리
      kind: 'bonus' as const,
      used: !!p.usedBonusAction,
    });
  }

  // 3) 오른쪽 아카데미: 1QIC (발타크는 4C)
  if (game.map?.some(t => t.ownerId === pid && t.structure === 'academy' && t.academyType === 'right')) {
    const isBal = p.faction === 'bal_tak';
    out.push({
      key: 'academy-qic',
      actionId: 'academy-qic',
      label: isBal ? 'Academy: 4 Credits' : 'Academy: 1 QIC',
      short: isBal ? 'Academy: 4 Credits' : 'Academy: 1 QIC',
      kind: 'academy' as const,
      used: used.includes('academy-qic'),
    });
  }

  // 4) 종족 스페셜 (의회 필요한 것은 의회 보유 시에만)
  if (p.faction === 'bescods') out.push({ key: 'bescods', actionId: 'bescods-advance-lowest', label: '매안: Lowest Track +1', short: '매안:Lowest Track +1', kind: 'faction', used: used.includes('bescods-advance-lowest') });
  if (p.faction === 'ivits') out.push({ key: 'ivits', actionId: 'ivits-space-station', label: '하이브: Space Station', short: '하이브:Space Station', kind: 'faction', used: !!p.usedIvitsSpaceStationThisRound });
  if (p.faction === 'moweyip' && hasPI) out.push({ key: 'moweyip', actionId: 'moweyip-place-ring', label: '모웨이드: Ring', short: '모웨이드:Ring', kind: 'faction', used: used.includes('moweyip-place-ring') });
  if (p.faction === 'ambas' && hasPI) out.push({ key: 'ambas', actionId: 'ambas-swap-pi-mine', label: '엠바스: Swap PI-Mine', short: '엠바스:Swap PI-Mine', kind: 'faction', used: used.includes('ambas-swap-pi-mine') });
  if (p.faction === 'firaks' && hasPI) out.push({ key: 'firaks', actionId: 'firaks-downgrade', label: '파이락: Downgrade', short: '파이락:Downgrade', kind: 'faction', used: used.includes('firaks-downgrade') });
  if (p.faction === 'gleens') out.push({ key: 'gleens', actionId: 'gleens-2nav', label: '글린: +2 Nav', short: '글린:+2 Nav', kind: 'faction', used: used.includes('gleens-2nav') });
  if (p.faction === 'space_giants') out.push({ key: 'space_giants', actionId: 'space_giants-2tf', label: '스자: 2 Step', short: '스자:2 Step', kind: 'faction', used: used.includes('space_giants-2tf') });
  if (p.faction === 'tinkeroids' && p.tinkeroidRoundSpecialId) {
    // [사용자 2026-08-09] 예전엔 ID 접두어만 떼서 '1tf-mine'처럼 원시 문자열이 노출됐다 → 한글 라벨 사용.
    //   [용어 통일 2026-08-09] 칩=‘N Step’(폭 좁음), 버튼·로그=‘Terraform N Step(s)’.
    const full = TINKEROID_SPECIAL_LABELS[p.tinkeroidRoundSpecialId] ?? p.tinkeroidRoundSpecialId;
    const nmShort = TINKEROID_SPECIAL_SHORT[p.tinkeroidRoundSpecialId] ?? full;
    out.push({ key: 'tinkeroids', actionId: p.tinkeroidRoundSpecialId, label: `팅커: ${full}`, short: `팅커:${nmShort}`, kind: 'faction', used: used.includes('tinkeroid-special') });
  }
  return out;
}

export default function Game() {
  const params = useParams<{ matchID: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const gameId = params.matchID;
  // [다른 기기로 이어하기] ?as=<playerId> — 좌석 소유권이 localStorage 귀속이라 기기 이동이 불가하던 것을,
  // 링크에 playerId를 실어 처음 여는 기기의 localStorage에 심는 방식으로 해결(도움말의 '이어하기 링크 복사'와 한 쌍).
  // 주소창에서는 즉시 제거(북마크/공유 시 재노출 방지).
  if (gameId && typeof window !== 'undefined') {
    const asId = new URLSearchParams(window.location.search).get('as');
    if (asId) {
      storePlayerId(gameId, asId);
      window.history.replaceState(null, '', window.location.pathname);
    }
  }
  const [game, setGame] = useState<GameState | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(gameId ? getStoredPlayerId(gameId) : null);
  const [isSpectator, setIsSpectator] = useState(false);
  const [specBadgeOpen, setSpecBadgeOpen] = useState(false); // [사용자] 모바일 관전 배지: 기본 접힘(눈동자만), 탭하면 펼침
  // [다른 기기 이어하기] 방 한정 이름/비번으로 좌석 복귀 폼 상태
  const [rejoinName, setRejoinName] = useState(() => localStorage.getItem('gaia-playerName') || '');
  const [rejoinPw, setRejoinPw] = useState('');
  const [rejoinMsg, setRejoinMsg] = useState('');
  const handleAccountRejoin = async () => {
    if (!gameId || !rejoinName.trim() || !rejoinPw) { setRejoinMsg('이름과 비밀번호를 입력하세요.'); return; }
    try {
      const res = await GameClient.accountRejoin(gameId, rejoinName.trim(), rejoinPw);
      storePlayerId(gameId, res.playerId);
      localStorage.setItem('gaia-playerName', rejoinName.trim());
      window.location.reload(); // 저장된 playerId로 정상 재접속 부트
    } catch (e: any) {
      setRejoinMsg(e?.message || '이어하기에 실패했습니다.');
    }
  };
  const handleDownloadSnapshot = async () => {
    if (!gameId) return;
    try {
      const { payload } = await GameClient.exportGameSnapshot(gameId);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `snapshot_r${payload?.roundNumber ?? 0}_${gameId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: '로그 저장됨', description: `라운드 ${payload?.roundNumber ?? 0} 스냅샷 (진행 중)` });
    } catch (e: any) {
      toast({ title: '로그 저장 실패', description: e?.message || '스냅샷을 받지 못했습니다.', variant: 'destructive' });
    }
  };
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
  // [사용자] FA 모드 기본 ON. 선택은 localStorage에 기억(끄면 유지), 미설정이면 ON.
  const [freeActionMode, setFreeActionMode] = useState(() => {
    try { const v = localStorage.getItem('fa-mode'); return v === null ? true : v === 'on'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('fa-mode', freeActionMode ? 'on' : 'off'); } catch { /* noop */ }
  }, [freeActionMode]);
  /** 네뷸라 의회: 직전 O 클릭(2P→1O)을 다음 클릭에서 3P→2O / 2P→1O+1C로 승격하기 위한 체인 추적 */
  const nevlasOreChainRef = useRef<{ expectP3: number; expectOre: number } | null>(null);
  /** 파워/우주선 액션: 3그릇 부족분을 2그릇 태우기(1소모+1이동)로 충당할지 확인 다이얼로그 */
  const [confirmBurnAction, setConfirmBurnAction] = useState<
    // brainBurnFirst: 타클론 전용 — 첫 번째 태우기가 '2그릇 브레인 → 3그릇'이라 일반토큰을 1개만 쓴다
    | { kind: 'power'; actionId: string; burns: number; brainBurnFirst?: boolean; closeResearchOverlay?: boolean }
    | { kind: 'ship'; shipTileId: string; actionIndex: number; targetTileId?: string; burns: number; brainBurnFirst?: boolean; label: string; fromOverlay?: boolean }
    | null
  >(null);
  /** [사용자 2026-08-13] 발타크 전용 — QIC 액션인데 QIC가 모자랄 때 '포머 → QIC' 변환 확인.
   *  타클론 파워 태우기(confirmBurnAction)와 같은 형태. 포머는 이번 라운드 잠기므로 반드시 확인을 받는다. */
  const [confirmQicConvert, setConfirmQicConvert] = useState<
    | { kind: 'power'; actionId: string; converts: number; closeResearchOverlay?: boolean }
    | { kind: 'ship'; shipTileId: string; actionIndex: number; targetTileId?: string; converts: number; label: string; fromOverlay?: boolean }
    | null
  >(null);
  /** [사용자 2026-08-13] 연방 위성 / 인공물처럼 '토큰 개수'로 내는 비용이 모자랄 때
   *  부족분만큼 1O→1토큰(표준 프리액션)으로 메울지 확인. 타클론 태우기·발타크 포머와 같은 형태. */
  const [confirmOreToToken, setConfirmOreToToken] = useState<
    | { kind: 'federation'; converts: number; need: number; force?: boolean }
    | { kind: 'artifact'; artifactId: string; converts: number; need: number; label: string }
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
  /** 아이타 4토큰 교환 타일 확정 전 확인창 (수익 단계라 되돌리기가 없어 클릭 즉시 커밋되던 것 — 확인 한 단계 추가) */
  const [itarsTileConfirm, setItarsTileConfirm] = useState<{ techTileId: string; trackId?: string; fromMini?: boolean } | null>(null);
  /** 보너스 타일 선택 단계에서 패널 접기/펼치기 (맵 보면서 선택 가능) */
  const [isBonusSelectionPanelExpanded, setIsBonusSelectionPanelExpanded] = useState(true);
  /** L 키: 게임 로그 오버레이 (평소에는 UI 없음) */
  const [isLogPanelOpen, setIsLogPanelOpen] = useState(false);
  // 모바일 로그: 라운드/플레이어 필터 툴바 표시 여부. 기본 꺼짐(상시 노출이 불편, 사용자) — 로그 탭 옆 + 버튼으로 토글.
  const [logFilterOpen, setLogFilterOpen] = useState(false);
  /** 모바일 Info 오버레이: 3페이지(0=기술타일, 1=우주선, 2=라운드/보너스) 스와이프 */
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [infoPage, setInfoPage] = useState(0);
  /** Info 오버레이 레이아웃: 'horizontal'(드래그 페이지) | 'vertical'(3창 합쳐 세로 스크롤). "?" 다이얼로그에서 변경, localStorage+커스텀이벤트로 동기화 */
  const [infoLayout, setInfoLayout] = useState<'horizontal' | 'vertical'>(() => (typeof localStorage !== 'undefined' && localStorage.getItem('info-overlay-layout') === 'vertical' ? 'vertical' : 'horizontal'));
  useEffect(() => {
    const onChange = (e: Event) => setInfoLayout((e as CustomEvent).detail === 'vertical' ? 'vertical' : 'horizontal');
    window.addEventListener('info-overlay-layout-change', onChange);
    return () => window.removeEventListener('info-overlay-layout-change', onChange);
  }, []);
  /** 맵 우측 세로 컨트롤(상태창 토글·배율·줌·리셋 등) 표시 여부. Menu 버튼으로 토글. 모바일·데스크톱 공통, 기본 숨김(사용자: 항상 떠있는 게 보기 안 좋음). localStorage 기억 */
  const [isMapControlsOpen, setIsMapControlsOpen] = useState(() => {
    try { return localStorage.getItem('map-controls-open') === 'on'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('map-controls-open', isMapControlsOpen ? 'on' : 'off'); } catch { /* noop */ }
  }, [isMapControlsOpen]);
  /** 플레이어 상세(클릭 시) 팝오버 배율.
   *  [사용자 2026-08-05] 기본값 ×1 → ×1.5. 저장된 값이 있으면 그 선택을 존중하므로,
   *  배율 버튼(×1→×1.5→×2)을 한 번이라도 눌러본 기기는 저장값이 그대로 유지된다
   *  (그 기기에서 기본값을 다시 타려면 localStorage의 'player-detail-scale'을 지우면 된다). */
  const [playerDetailScale, setPlayerDetailScale] = useState<1 | 1.5 | 2>(() => {
    const saved = localStorage.getItem('player-detail-scale');
    const v = saved != null ? parseFloat(saved) : 1.5;
    return v === 2 ? 2 : v === 1 ? 1 : 1.5;
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
  // [2026-07-14 사용자] 로그 배율: 프리셋(×100/150/200 버튼) → 볼륨바식 슬라이더(100%~300% 연속 조절)
  const LOG_SCALE_MIN = 1, LOG_SCALE_MAX = 3;
  const [logTextScale, setLogTextScale] = useState<number>(() => {
    const saved = localStorage.getItem('game-log-text-scale');
    const n = saved ? parseFloat(saved) : 1;
    return Number.isFinite(n) ? Math.min(LOG_SCALE_MAX, Math.max(LOG_SCALE_MIN, n)) : 1;
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
  // [2026-07-14 사용자] 플레이어 색 로컬 오버라이드 — 색이 겹칠 때 보드의 건물·위성·잊혀진 행성 색만 바꿔 봄
  // (로그/텍스트 등은 원래 종족색 유지). 기기 로컬 저장, '기본값'으로 언제든 복귀.
  const [playerColorOverrides, setPlayerColorOverrides] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(`player-color-overrides-${params.matchID}`) || '{}'); } catch { return {}; }
  });
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  // [사용자 2026-08-03] 색 피커를 카드 안에서 그리면 ①패스한 사람 카드의 딤(grayscale/opacity 필터)을 그대로 물려받아
  //   흐릿하게 보이고(자식은 조상 필터를 되돌릴 수 없음) ②바깥 클릭으로 닫히지 않았다. → 버튼 좌표를 잡아 body로
  //   포털 렌더 + 투명 백드롭으로 바깥 클릭 닫기(상태창 상세와 동일 UX).
  const [colorPickerPos, setColorPickerPos] = useState<{ left: number; top: number } | null>(null);
  const OVERRIDE_COLORS = [
    '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
    '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
    '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#b91c1c',
    '#ffffff', '#d4d4d8', '#78716c', '#facc15', '#4ade80', '#93c5fd',
  ];
  const setPlayerColor = (pid: string, color: string | null) => {
    setPlayerColorOverrides(prev => {
      const next = { ...prev };
      if (color) next[pid] = color; else delete next[pid];
      try { localStorage.setItem(`player-color-overrides-${params.matchID}`, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    setColorPickerFor(null);
    setColorPickerPos(null);
  };
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

  // 모바일에선 상태창이 화면 절반을 먹어 맵이 안 보임(사용자 관찰). 데스크탑은 그대로 두고
  // 모바일(<768px)에서만 뷰포트 비율(≤45%)로 상태창 너비를 제한. winW를 reactive로 추적.
  const isMobileViewport = useIsMobile();
  const [winW, setWinW] = useState<number>(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));
  const [winH, setWinH] = useState<number>(() => (typeof window !== 'undefined' ? window.innerHeight : 800));
  useEffect(() => {
    const onResize = () => { setWinW(window.innerWidth); setWinH(window.innerHeight); };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('orientationchange', onResize); };
  }, []);
  // 화면 방향: 세로(portrait, 높이>너비) ↔ 가로(landscape). 레이아웃 결정에 사용(정보창 내용 표시방식과는 별개).
  const isPortrait = winH > winW;
  const effectiveSidebarWidth = isMobileViewport
    ? Math.min(sidebarWidth, Math.max(75, Math.round(winW * 0.22)))
    : sidebarWidth;
  // 모바일: 내용을 디자인폭(308px)으로 렌더 후 zoom으로 축소 → 영역과 함께 글자도 줄어 안 겹침.
  const MOBILE_PANEL_DESIGN_WIDTH = 308;
  const mobilePanelZoom = isMobileViewport ? effectiveSidebarWidth / MOBILE_PANEL_DESIGN_WIDTH : 1;
  // 모바일 Info 오버레이: 화면 왼쪽에 상태창의 1.2배 폭으로(뷰포트 초과 방지 클램프). zoom은 그 폭에 맞춤.
  const infoOverlayWidth = isMobileViewport ? Math.min(Math.round(effectiveSidebarWidth * 1.2), Math.round(winW * 0.9)) : effectiveSidebarWidth;
  const infoOverlayZoom = isMobileViewport ? infoOverlayWidth / MOBILE_PANEL_DESIGN_WIDTH : 1;
  // 세로(portrait) 모바일에선 정보창을 상시 표시 — i 버튼 토글 없이 항상 하단-좌측에 둠(사용자 요청). 가로(landscape)에선 i 버튼으로 토글.
  const portraitMobile = isMobileViewport && isPortrait;
  const infoEffectivelyOpen = isInfoOpen || portraitMobile;
  // 하단 분할: 세로 화면(portrait)일 때 상단 절반은 맵, 하단 절반을 정보창(좌)/상태창(우)으로 나눔. 정보창이 상시라 portrait면 항상 분할.
  // (가로 화면이면 정보창 풀하이트 좌측 + 상태창 우측.) 레이아웃은 화면 방향에 좌우되고, 정보창 내용 표시방식(스와이프/스크롤)은 infoLayout이 따로 결정.
  // 분할 비율은 반반이 아니라 정보창:상태창 = 1.2:1(정보창이 더 큼).
  const splitActive = portraitMobile;
  // [2026-07-27 사용자] 헤더탭 더블터치 → 해당 패널 전체화면(맵까지 덮음), 다시 더블터치 → 원복
  const [mobileZoomPanel, setMobileZoomPanel] = useState<null | 'info' | 'status'>(null);
  const splitInfoWidth = splitActive ? (mobileZoomPanel === 'info' ? winW : mobileZoomPanel === 'status' ? 0 : Math.round(winW * 1.2 / 2.2)) : 0;
  const splitStatusWidth = splitActive ? winW - splitInfoWidth : 0;
  const splitInfoZoom = splitActive ? splitInfoWidth / MOBILE_PANEL_DESIGN_WIDTH : 1;
  const splitStatusZoom = splitActive ? splitStatusWidth / MOBILE_PANEL_DESIGN_WIDTH : 1;
  // [사용자 2026-08-10] 상태창/로그 탭바(=제목줄)는 zoom 밖의 고정요소라 22px로 고정이었다. 최대화하면
  //   패널 내용은 zoom이 0.7 → 1.3배로 커지는데 탭바만 그대로라 상대적으로 납작해 보이고, 22px는 탭 타깃으로
  //   너무 작아 '되돌리려고 다시 더블터치'가 어려웠다 → 최대화 중에는 탭바를 키운다.
  //   또 최대화 시 top:0이라 노치/브라우저 UI에 물리므로 safe-area만큼 내리고, 패널 padding도 같이 맞춘다.
  const mobileTabBarH = mobileZoomPanel === 'status' ? 34 : 22;
  const mobileTabBarTop = mobileZoomPanel === 'status' ? 'env(safe-area-inset-top, 0px)' : (splitActive ? '50%' : 0);
  const mobilePanelPadTop = mobileZoomPanel === 'status'
    ? `calc(env(safe-area-inset-top, 0px) + ${mobileTabBarH}px)`
    : `${mobileTabBarH}px`;
  // 최대화(h-100dvh)는 홈 인디케이터 영역까지 덮어 마지막 줄이 가려진다 → 하단 safe-area만큼 비워 준다.
  const mobilePanelPadBottom = mobileZoomPanel === 'status' ? 'env(safe-area-inset-bottom, 0px)' : '0px';
  // Info 오버레이 실제 폭/zoom: 분할 모드면 분할 폭, 아니면 좌측 풀하이트 오버레이 폭
  const infoEffectiveWidth = splitActive ? splitInfoWidth : infoOverlayWidth;
  const infoEffectiveZoom = splitActive ? splitInfoZoom : infoOverlayZoom;

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
  // 맵 보기(줌·위치) 복원 — gameId가 준비되면 한 번만.
  // [사용자 2026-08-20] "접속할 때마다 맵 크기를 새로 맞춰야 한다" — 저장은 되고 있었지만 키가
  //   판별(game-zoom-<gameId>)이라 **새 방을 만들면 저장값이 없어** 매번 기본값으로 시작했다.
  //   → 판별 값이 없으면 '마지막으로 쓴 값'(map-view-last)을 이어받는다. 판별 값이 우선.
  useEffect(() => {
    if (!gameId || isZoomInitialized) return;
    const num = (v: string | null) => {
      const n = v == null ? NaN : parseFloat(v);
      return Number.isFinite(n) && n >= 0.2 && n <= 3 ? n : null;   // 손상된 값 방어(줌 한계 내)
    };
    const pt = (v: string | null) => {
      try {
        const o = v ? JSON.parse(v) : null;
        return o && Number.isFinite(o.x) && Number.isFinite(o.y) ? { x: o.x, y: o.y } : null;
      } catch { return null; }
    };
    const z = num(localStorage.getItem(`game-zoom-${gameId}`)) ?? num(localStorage.getItem('map-zoom-last'));
    const pan = pt(localStorage.getItem(`game-pan-${gameId}`)) ?? pt(localStorage.getItem('map-pan-last'));
    if (z != null) setMapZoom(z);
    if (pan) setMapPan(pan);
    setIsZoomInitialized(true);
  }, [gameId, isZoomInitialized]);

  // 저장 — 판별 키와 '마지막 값' 키를 함께 쓴다(다음 새 방이 이어받게)
  useEffect(() => {
    if (gameId && isZoomInitialized) {
      localStorage.setItem(`game-zoom-${gameId}`, mapZoom.toString());
      localStorage.setItem(`game-pan-${gameId}`, JSON.stringify(mapPan));
      localStorage.setItem('map-zoom-last', mapZoom.toString());
      localStorage.setItem('map-pan-last', JSON.stringify(mapPan));
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
  /** 음성 안내용 턴 경계 — 이 인덱스 이후 로그가 '방금 끝난 턴'이다. */
  const voiceLogMarkRef = useRef(0);
  /** 음성 안내 '한 턴에 한 번' 판정용.
   *  actionWindow: hasDoneMainAction이 false로 돌아올 때마다(=새 턴 시작) 1 증가.
   *  announcedWindow: 사람별로 마지막에 안내한 window — 같은 window면 후속 로그를 읽지 않는다.
   *  lastVoiceAt: 업데이트가 뭉쳐 와서 window 전환을 못 본 경우의 보조 판정(3초 이상 벌어지면 새 액션). */
  const actionWindowRef = useRef(0);
  /** 화면을 벗어났다 돌아온 직후인가 — 다음 로그 처리 때 밀린 분량을 읽지 않고 건너뛴다 */
  const voiceSkipBacklogRef = useRef(false);
  const announcedWindowRef = useRef<Record<string, number>>({});
  const lastVoiceAtRef = useRef<Record<string, number>>({});

  /** [사용자 2026-08-20] 패스 확인창의 '안 쓴 특수 액션' 경고에 효과음.
   *  경고 문구는 렌더 안에서 계산되지만 소리는 창이 '열릴 때 한 번'만 나야 하므로 여기서 따로 판정한다.
   *  (렌더 중 재생하면 리렌더마다 울린다.) */
  const passWarnCount = (confirmPassWithTileId && game && playerId)
    ? getSpecialActionsForPlayer(game, playerId).filter(a => !a.used).length
    : 0;
  // [사용자 2026-08-20] 한 번만 울리면 놓친다 → 창이 열려 있는 동안 계속 반복. 닫으면(=cleanup) 즉시 멈춘다.
  //   간격 1.8초 = 소리 길이(약 0.6초) + 여백. 언마운트·경고 해소 시에도 clearInterval로 정리된다.
  useEffect(() => {
    if (!confirmPassWithTileId || passWarnCount <= 0) return;
    playPassWarnSound();
    const id = setInterval(playPassWarnSound, 1800);
    return () => clearInterval(id);
  }, [confirmPassWithTileId, passWarnCount]);

  /** 타클론 파워 수신 선택. Brain First = 충전 시 브레인을 먼저 올릴지.
   *  PI 1st = 의회 토큰을 충전 '전에' 추가할지(켜면 그 토큰도 이번 충전으로 올라가고, 그만큼 받는 파워·VP가 늘 수 있음). */
  const [powerOfferBrainFirst, setPowerOfferBrainFirst] = useState(true);
  const [powerOfferPiAddFirst, setPowerOfferPiAddFirst] = useState(false);
  /** 한 컴퓨터 4인플: 방장 브라우저인지 (턴 바뀔 때 조작 플레이어 자동 전환용) */
  const isHostSessionRef = useRef(
    gameId ? localStorage.getItem(`is-host-${gameId}`) === 'true' : false
  );
  // [대역폭 2026-07-26] 서버가 game_updated엔 gameLog 꼬리(40개)+인덱스만 보냄 → 여기서 병합·보관.
  // 전체 로그는 입장/재접속 콜백(full 페이로드)이 시드 — 늦게 들어와도/재접해도 처음부터 다 보임.
  const gameLogArchiveRef = useRef<{ gameId: string | null; log: NonNullable<GameState['gameLog']> }>({ gameId: null, log: [] });
  const gameWireRef = useRef<{ gameId: string; revision: number; game: Record<string, unknown> } | null>(null);
  const mergeGameLog = useCallback((g: any) => {
    if (!g || !Array.isArray(g.gameLog)) return;
    const arch = gameLogArchiveRef.current;
    if (arch.gameId !== g.id) { arch.gameId = g.id; arch.log = []; } // 다른 게임으로 이동 시 리셋
    if (typeof g.gameLogStart === 'number') {
      if (arch.log.length >= g.gameLogStart) {
        arch.log = [...arch.log.slice(0, g.gameLogStart), ...g.gameLog];
      } else {
        arch.log = [...arch.log, ...g.gameLog]; // 갭(이론상 재접속 full fetch가 선행) — 꼬리라도 반영
      }
      g.gameLog = arch.log;
    } else {
      arch.log = g.gameLog; // full 페이로드(입장/재접속/get_game) → 아카이브 시드
    }
  }, []);
  const [isResearchPinned, setIsResearchPinned] = useState(
    gameId ? localStorage.getItem(`is-research-pinned-${gameId}`) === 'true' : false
  );
  const [isBonusPinned, setIsBonusPinned] = useState(
    gameId ? localStorage.getItem(`is-bonus-pinned-${gameId}`) === 'true' : false
  );

  /** [사용자 2026-08-20] 단일 미니뷰 — 연구·우주선·Tactical을 창 하나의 3탭으로. 미니뷰가 화면을 많이
   *  가린다는 의견에서 나왔다. PC 전용(폰은 이미 하단 분할 구조). 켜면 미니보드 버튼도 1개만 남는다. */
  const [singleMini, setSingleMini] = useState<boolean>(() => {
    try { return localStorage.getItem('single-mini-view') === 'on'; } catch { return false; }
  });
  useEffect(() => {
    const onChange = (e: Event) => setSingleMini(!!(e as CustomEvent).detail);
    window.addEventListener('single-mini-view-change', onChange);
    return () => window.removeEventListener('single-mini-view-change', onChange);
  }, []);
  /** 단일 미니뷰 탭: 0=연구 1=우주선 2=Tactical */
  const [singleMiniPage, setSingleMiniPage] = useState<number>(() => {
    const n = Number((() => { try { return localStorage.getItem('single-mini-page'); } catch { return null; } })());
    return n === 1 || n === 2 ? n : 0;
  });
  /** [사용자 2026-08-20] 탭 이동은 순환 — Tactical에서 → 누르면 Research로, Research에서 ←면 Tactical로.
   *  끝에서 막히면 한 방향으로 되돌아가야 해서 3탭에서는 순환이 손이 덜 간다. */
  const gotoMiniPage = (n: number) => {
    const v = ((n % 3) + 3) % 3;
    setSingleMiniPage(v);
    try { localStorage.setItem('single-mini-page', String(v)); } catch { /* noop */ }
  };

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
  /** [사용자 2026-08-20] 미니뷰 위치·크기도 판별 키로만 저장돼 새 방마다 기본값이었다.
   *  맵 보기와 같은 방식으로 '마지막 값'을 함께 저장해 이어받는다(판별 값이 우선). */
  const loadView = (perGame: string, last: string): string | null => {
    try { return (gameId ? localStorage.getItem(perGame) : null) ?? localStorage.getItem(last); } catch { return null; }
  };
  const saveView = (perGame: string, last: string, v: string): void => {
    try { if (gameId) localStorage.setItem(perGame, v); localStorage.setItem(last, v); } catch { /* noop */ }
  };

  const [researchPos, setResearchPos] = useState(() => {
    const saved = loadView(`research-pos-${gameId}`, 'research-pos-last');
    const initial = saved ? JSON.parse(saved) : { x: 20, y: 90 };
    return clampMiniPos(initial);
  });
  const [bonusPos, setBonusPos] = useState(() => {
    const saved = loadView(`bonus-pos-${gameId}`, 'bonus-pos-last');
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
    const saved = loadView(`research-mini-width-${gameId}`, 'research-mini-width-last');
    const n = saved ? parseInt(saved, 10) : 340;
    return Math.min(MAX_MINI_WIDTH, Math.max(MIN_MINI_WIDTH, isNaN(n) ? 340 : n));
  });
  const [researchMiniHeight, setResearchMiniHeight] = useState(() => {
    const saved = loadView(`research-mini-height-${gameId}`, 'research-mini-height-last');
    const n = saved ? parseInt(saved, 10) : 650;
    return isNaN(n) ? 650 : n;
  });

  const [bonusMiniWidth, setBonusMiniWidth] = useState(() => {
    const saved = loadView(`bonus-mini-width-${gameId}`, 'bonus-mini-width-last');
    const n = saved ? parseInt(saved, 10) : 340;
    return Math.min(MAX_MINI_WIDTH, Math.max(MIN_MINI_WIDTH, isNaN(n) ? 340 : n));
  });
  const [bonusMiniHeight, setBonusMiniHeight] = useState(() => {
    const saved = loadView(`bonus-mini-height-${gameId}`, 'bonus-mini-height-last');
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
  // 결과창 탭 상태 — GameEndScoreModal이 일반 함수라(인라인 컴포넌트 재마운트 버그 회피) 부모에 둔다
  const [scoreTab, setScoreTab] = useState<string>('__overview__');
  const [isAdminModeOpen, setIsAdminModeOpen] = useState(false);
  // 관리자 해금(Ctrl+Alt+A) 여부 — 진행 중 로그 스냅샷 다운로드 등 관리자 전용 UI 노출 게이트
  const [isAdmin, setIsAdmin] = useState(false);
  // 모바일 전체모드(브라우저 fullscreen) 상태 — 전체모드 아닐 때만 좌상단 진입 버튼 노출
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFsChange);
    onFsChange();
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  const enterFullscreen = () => {
    const el = document.documentElement as any;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitEnterFullscreen;
    if (req) { try { req.call(el); } catch { /* noop */ } }
  };

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
    const lastW = panel === 'research' ? 'research-mini-width-last' : 'bonus-mini-width-last';
    const lastH = panel === 'research' ? 'research-mini-height-last' : 'bonus-mini-height-last';

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
        saveView(keyW, lastW, String(w));
      }
      if (axis === 'y' || axis === 'both') {
        const h = Math.min(maxH, Math.max(MIN_H, startHeight + dy));
        lastResizeHeightRef.current = h;
        setHeight(h);
        saveView(keyH, lastH, String(h));
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (gameId) {
        if (axis === 'x' || axis === 'both') saveView(keyW, lastW, String(lastResizeWidthRef.current));
        if (axis === 'y' || axis === 'both') saveView(keyH, lastH, String(lastResizeHeightRef.current));
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
  const lastBidderRef = useRef<string | null>(null);
  const lastWasMyBidRef = useRef(false);
  const lastMyOfferCountRef = useRef(0);
  const lastPowerStateRef = useRef({ p1: 0, p2: 0, p3: 0, bs: 0 });
  // 결과창은 게임당 정확히 1회만 자동으로 연다. (gameId 단위로 기록)
  // [버그수정] 기존엔 'phase 전이(prevPhase!=gameEnd → gameEnd)'로 감지했는데, 서버가 끝난 게임을
  // ~주기적으로 재방출(또는 재연결로 game 재수신)하면서 phase가 잠깐 다른 값→gameEnd로 흔들리면
  // 전이로 오인해 결과창이 10초마다 다시 뜨는 현상이 있었음. 'gameId당 1회'로 바꿔 재방출/재연결/흔들림에 불변.
  // 닫은 뒤 다시 보려면 결과화면의 '점수 보기' 버튼(아래)으로 수동 오픈.
  const autoShownEndForGameRef = useRef<string | null>(null);
  useEffect(() => {
    if (game?.currentPhase === 'gameEnd' && gameId && autoShownEndForGameRef.current !== gameId) {
      autoShownEndForGameRef.current = gameId;
      setShowGameEndScore(true);
      // [종료 효과음] 내가 1등이면 축하 팡파레, 그 외엔 부드러운 마무리음(~3초). gameId당 1회만(재방출/재연결에 중복 재생 방지).
      try {
        const players = Object.entries(game.players || {});
        const maxScore = Math.max(...players.map(([, p]: [string, any]) => p?.score ?? 0));
        const myScore = (game.players as any)?.[playerId ?? '']?.score ?? 0;
        const isWinner = players.length > 0 && myScore === maxScore && maxScore > 0; // 동점도 1등으로 축하
        playEndSound(isWinner);
      } catch { /* noop */ }
    }
  }, [game?.currentPhase, gameId, playerId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setIsAdmin(true);
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

    // [깜박임 2026-08-23 사용자 제보: S25, 사람 4명 게임 "가만히 있어도 화면이 깜박거린다"]
    //   액션 1회에 서버 상태 패킷이 ~25개 온다(실측: 게임당 3,973개). 예전엔 패킷마다 setGame을 불러
    //   거대한 트리를 그대로 다시 그렸다 → 폰에서는 메인 스레드가 계속 막히고 타일·이미지가 다시 그려지며
    //   깜박임으로 보인다. 남이 액션하는 동안엔 내가 가만히 있어도 계속 들어오므로 상시 증상이 된다.
    //   → UI 반영을 프레임당 1회로 합친다(가장 최근 상태만 반영). 로그 아카이브·갭 검사·낙관 카운터는
    //     패킷마다 그대로 돌아 정확도는 변하지 않는다.
    let pendingUi: GameState | null = null;
    let uiRaf: number | null = null;
    let uiCommitted = false;
    const commitUi = (g: GameState) => { setGame(g); };
    const flushUi = () => {
      uiRaf = null;
      const g = pendingUi;
      pendingUi = null;
      if (g) commitUi(g);
    };
    const scheduleUi = (g: GameState) => {
      // 첫 상태는 지연 없이 반영 — 한 프레임이라도 빈 화면이 보이지 않게(로딩 해제와 경합 방지).
      if (!uiCommitted) { uiCommitted = true; commitUi(g); return; }
      pendingUi = g;
      if (uiRaf == null) uiRaf = requestAnimationFrame(flushUi);
    };

    const applyAuthoritativeGame = (updatedGame: GameState) => {
      if (updatedGame.id !== gameId) return;
      if (updatedGame.hostId === playerId) isHostSessionRef.current = true;
      // 낙관적 프리액션보다 뒤처진 권위 패킷만 UI에서 건너뛴다.
      // wire 기준점/revision은 이벤트 핸들러에서 먼저 전진하므로 다음 델타 적용에는 영향이 없다.
      const isSelfTurn = updatedGame.turnOrder?.[updatedGame.currentPlayerIndex] === playerId;
      const serverFreeCount = (updatedGame as { freeActionUndoStack?: unknown[] }).freeActionUndoStack?.length ?? 0;
      const bursting = Date.now() - GameClient.lastOptimisticFreeActionAt() < 2000;
      if (isSelfTurn && !updatedGame.hasDoneMainAction && bursting && serverFreeCount > 0 && serverFreeCount < GameClient.getLastAppliedServerFreeCount()) {
        return;
      }
      GameClient.syncOptimisticFreeCount(serverFreeCount);
      if (serverFreeCount === 0 || !isSelfTurn || updatedGame.hasDoneMainAction) GameClient.resetAppliedServerFreeCount();
      else GameClient.noteAppliedServerFreeCount(serverFreeCount);
      mergeGameLog(updatedGame);
      scheduleUi(updatedGame);
      // 다이얼로그 정리는 코얼레싱하지 않고 패킷마다 판정한다 — 한 프레임에 '내 액션 완료 → 턴 넘어감'이
      // 같이 들어오면 마지막 패킷은 내 턴이 아니라서 정리가 누락되고 확인창이 남는다.
      // 이미 닫힌 상태로 다시 닫는 건 React가 같은 값에서 bail-out하므로 리렌더 비용이 없다.
      const isCurrentPlayer = updatedGame.turnOrder[updatedGame.currentPlayerIndex] === playerId;
      if (isCurrentPlayer && updatedGame.hasDoneMainAction) {
        setPendingAction(null);
        setAdvanceTechDialog((prev) => (prev.open ? { open: false, trackId: null } : prev));
        setPendingTwilightTSUpgrade(null);
        setPendingRebellionMineToTS(null);
      }
    };

    let syncInFlight: Promise<void> | null = null;
    const installFullSync = (response: { game: GameState; revision: number }) => {
      const current = gameWireRef.current;
      if (current?.gameId === gameId && current.revision > response.revision) return;
      const fullGame = response.game;
      gameWireRef.current = {
        gameId,
        revision: response.revision,
        game: buildClientGameState(fullGame, true),
      };
      applyAuthoritativeGame(fullGame);
    };
    const requestFullSync = () => {
      if (syncInFlight) return syncInFlight;
      syncInFlight = GameClient.syncGame(gameId)
        .then(installFullSync)
        .finally(() => { syncInFlight = null; });
      return syncInFlight;
    };
    const hasGameLogGap = (wireGame: Record<string, unknown>) => {
      const start = wireGame.gameLogStart;
      const archive = gameLogArchiveRef.current;
      return typeof start === 'number'
        && archive.gameId === gameId
        && archive.log.length < start;
    };

    const fetchGame = async () => {
      try {
        const storedPlayerId = getStoredPlayerId(gameId);
        const storedSpectatorId = getStoredSpectatorId(gameId);

        if (storedPlayerId) {
          try {
            await GameClient.rejoinGame(gameId, storedPlayerId);
            await requestFullSync();
            setLoading(false);
            return;
          } catch {
          }
        }

        if (storedSpectatorId) {
          try {
            await GameClient.rejoinGame(gameId, storedSpectatorId);
            await requestFullSync();
            setPlayerId(null);
            setIsSpectator(true);
            setLoading(false);
            return;
          } catch {
            // 서버 재시작 등으로 관전자 재접속 실패 시 get_game으로 불러와도 관전자 UI 유지
          }
        }

        // 직접 URL로 연 공개 조회도 동일한 전체 스냅샷 형식을 사용한다.
        // 방에 참가하지 않은 소켓은 델타 방에 들어가지 않으므로 기존처럼 실시간 구독은 하지 않는다.
        await GameClient.getGame(gameId);
        await requestFullSync();
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

    // [모바일 실시간 갱신 2026-08-05, 사용자: "폰에서 종종 새로고침해야 한다"]
    // 원인: 폰이 백그라운드(앱 전환·화면 잠금)로 가면 JS 타이머가 멈춰 socket.io의 하트비트
    //   (pingInterval 25s / pingTimeout 20s)가 돌지 못한다. 그 사이 OS/통신사 NAT이 소켓을 조용히 끊으면
    //   복귀 후에도 socket.connected가 true라 'connect' 이벤트가 안 떠서 fetchGame이 실행되지 않고,
    //   서버 방에서도 빠진 상태라 game_updated가 안 온다 → 최대 ~45초간 화면이 멈춘 것처럼 보이고
    //   수동 새로고침(=재마운트로 fetchGame)만이 즉시 복구였다. connectionStateRecovery도 꺼져 있어
    //   끊긴 사이 놓친 이벤트는 재전송되지 않으므로, 복구는 '상태를 다시 받는' 것뿐이다.
    // 대응: 화면에 돌아온 순간 직접 재동기화한다(= 새로고침과 같은 효과, 화면 깜빡임 없음).
    let lastResync = 0;
    const resyncNow = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastResync < 1000) return; // 앱 전환 연타 시 중복 요청 방지
      lastResync = now;
      if (!socket.connected) {
        socket.connect(); // 끊긴 게 확실하면 즉시 재연결 — 'connect'에서 fetchGame이 돌며 방에 다시 들어간다
        return;
      }
      // 연결된 것처럼 보여도 실제로는 죽은 '좀비 소켓'일 수 있다 → 응답이 없으면 강제로 끊고 다시 붙인다.
      const probe = setTimeout(() => { socket.disconnect(); socket.connect(); }, 3000);
      fetchGame().finally(() => clearTimeout(probe));
    };
    document.addEventListener('visibilitychange', resyncNow);
    window.addEventListener('focus', resyncNow);    // iOS에서 visibilitychange가 안 오는 경우 대비
    window.addEventListener('pageshow', resyncNow); // 뒤로가기 캐시(bfcache)로 복귀할 때

    // 구버전 서버/초기 capability 협상 전에는 전체 상태 이벤트도 계속 받을 수 있다.
    const unsubGame = GameClient.onGameUpdated((updatedGame) => applyAuthoritativeGame(updatedGame));

    const unsubDelta = GameClient.onGameDelta((message: GameDeltaMessage) => {
      if (message.gameId !== gameId) return;
      const wire = gameWireRef.current;
      // 중복/지연 도착한 패킷은 이미 반영된 상태이므로 재동기화 없이 버린다.
      if (wire?.gameId === gameId && message.revision <= wire.revision) return;
      if (!wire || wire.gameId !== gameId || wire.revision !== message.baseRevision) {
        void requestFullSync().catch(() => { socket.disconnect(); socket.connect(); });
        return;
      }
      try {
        const nextWire = applyGameStateDelta(wire.game, message.delta);
        gameWireRef.current = { gameId, revision: message.revision, game: nextWire };
        if (hasGameLogGap(nextWire)) {
          void requestFullSync().catch(() => { socket.disconnect(); socket.connect(); });
          return;
        }
        // mergeGameLog가 gameLog를 전체 아카이브로 교체하므로 wire 기준점과 별도 객체를 사용한다.
        const uiGame = JSON.parse(JSON.stringify(nextWire)) as GameState;
        applyAuthoritativeGame(uiGame);
      } catch {
        void requestFullSync().catch(() => { socket.disconnect(); socket.connect(); });
      }
    });

    const unsubSync = GameClient.onGameSync((message: GameSyncMessage) => {
      if (message.gameId !== gameId) return;
      const current = gameWireRef.current;
      if (current?.gameId === gameId && message.revision <= current.revision) return;
      gameWireRef.current = { gameId, revision: message.revision, game: message.game };
      if (hasGameLogGap(message.game)) {
        void requestFullSync().catch(() => { socket.disconnect(); socket.connect(); });
        return;
      }
      const uiGame = JSON.parse(JSON.stringify(message.game)) as GameState;
      applyAuthoritativeGame(uiGame);
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
      if (uiRaf != null) cancelAnimationFrame(uiRaf);
      socket.off('connect', fetchGame);
      document.removeEventListener('visibilitychange', resyncNow);
      window.removeEventListener('focus', resyncNow);
      window.removeEventListener('pageshow', resyncNow);
      unsubGame();
      unsubDelta();
      unsubSync();
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
      // [사용자 2026-08-20] 단일 미니뷰가 열려 있을 때 ←/→ 로 탭 이동. 창이 없을 때는 아무 일도 안 한다
      //   (맵·다른 UI가 화살표를 쓰지 않아 충돌 없음). 수정키 조합은 브라우저 기능이라 건드리지 않는다.
      if (singleMini && isResearchPinned && !e.altKey && !e.ctrlKey && !e.metaKey
        && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        gotoMiniPage(singleMiniPage + (e.key === 'ArrowRight' ? 1 : -1));
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
  }, [isResearchOpen, isBonusTilesOpen, isResearchPinned, isBonusPinned, gameId, singleMini, singleMiniPage]);

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

  // [사용자 2026-08-20] 음성 안내는 첫 사용자 제스처 뒤에만 재생이 허용된다(모바일 자동재생 정책).
  //   접속 직후 몇 턴이 조용하다가 갑자기 나오는 일을 막으려고 첫 탭에서 한 번 잠금을 푼다.
  useEffect(() => {
    const unlock = () => primeSpeech();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  /* [사용자 2026-08-21] 폰에서 나갔다 돌아오면 밀린 안내가 줄줄이 나온다.
     백그라운드에선 JS가 멈추고, 복귀하면 그동안의 로그가 한 번에 도착해 전부 안내됐다.
     → 벗어나는 순간 대기열·재생을 비우고, 복귀 후 첫 로그 처리는 밀린 분량을 통째로 건너뛴다.
     (그 사이의 판세는 화면·로그창으로 보면 된다 — 음성은 라이브 전용) */
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        clearVoiceQueue();
        voiceSkipBacklogRef.current = true;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // [사용자 2026-08-20] 액션 음성 안내 — 로그의 메인 액션을 읽되, [2026-08-21] '턴이 넘어가
  //   되돌릴 수 없게 된 줄'만 읽는다(아래 commitSeq). 진행 중인 턴의 줄은 보류 — 액션 직후 읽으면
  //   Undo(reset_turn)로 지워진 액션이 이미 읽힌 뒤가 된다(사용자 관찰).
  //   프리액션·결과성 로그는 actionParts가 null이라 무음이고, 연속 안내는 speech.ts의 큐가 순서대로 처리한다.
  useEffect(() => {
    const log = game?.gameLog ?? [];
    // 턴이 새로 시작되면(메인 액션 미수행 상태) 다음 안내를 허용한다.
    if (game && !game.hasDoneMainAction) actionWindowRef.current += 1;
    // 첫 진입(또는 재접속)에는 과거 로그를 읽지 않는다 — 마크만 현재 위치로 맞춘다.
    if (voiceLogMarkRef.current === 0 && log.length) { voiceLogMarkRef.current = log.length; return; }
    if (!isVoiceOn() || !game) { voiceLogMarkRef.current = log.length; return; }
    // 백그라운드 중 도착분은 읽지 않는다(마크만 현재로). 플래그는 여기서 소모하지 않는다 —
    // 폰은 숨김 초반에 JS가 잠깐 살아 있어, 여기서 소모하면 정작 복귀 배치가 읽혀 버린다.
    if (document.hidden) {
      voiceLogMarkRef.current = log.length;
      return;
    }
    // 복귀 후 첫 처리 — 밀린 분량을 통째로 건너뛴다
    if (voiceSkipBacklogRef.current) {
      voiceSkipBacklogRef.current = false;
      voiceLogMarkRef.current = log.length;
      return;
    }
    const from = Math.min(voiceLogMarkRef.current, log.length);   // 롤백으로 줄어도 안전
    /* [사용자 2026-08-21] '되돌리기 전에 소리부터 나던' 문제.
       파워 액션으로 테라포밍 1을 얻고 Undo(reset_turn)하면 서버가 그 턴의 로그 줄을 지운다.
       그런데 안내는 줄이 붙는 즉시 나가서, 결국 하지 않은 액션이 이미 읽힌 뒤였다.
       → 되돌릴 수 없게 된 줄만 읽는다. turnMark(각자의 턴 시작 로그 seq) 중 가장 큰 값이
       '마지막으로 시작된 턴'이므로, 그보다 앞선 seq는 이미 끝난 턴이라 되돌릴 수 없다.
       진행 중인 턴의 줄은 보류했다가 턴이 넘어간 뒤 읽는다(처음 요청대로 '액션 완료 시점').
       게임이 끝나면 더 기다릴 것이 없으므로 남은 줄을 전부 읽는다. */
    const marks = Object.values((game.turnMark ?? {}) as Record<string, number>);
    const ended = game.currentPhase === 'gameEnd';
    const commitSeq = ended || !marks.length ? null : Math.max(...marks);
    let done = from;
    /** 이 패스에서 아직 본 액션을 못 만난 준비 동작 — 만나면 한 문장으로 합친다 */
    let pendingEnabler: { playerId: string; win: number; parts: string[] } | null = null;
    for (const raw of log.slice(from)) {
      const e = raw as { playerId?: string; action?: string; details?: string; timestamp?: number; tileId?: string; seq?: number };
      // 아직 되돌릴 수 있는 줄(진행 중인 턴) → 여기서 멈춘다. 다음 상태 갱신 때 다시 본다.
      // 경계: 서버 reset_turn은 seq > 턴시작표시 인 줄만 지운다(gameState.ts의 트림 조건) →
      // seq == 표시 인 줄은 직전 턴 소속이라 이미 안전하다. >= 로 하면 이 줄이 영영 안 읽힌다(실측 off-by-one).
      if (commitSeq !== null && typeof e.seq === 'number' && e.seq > commitSeq) break;
      done++;
      const parts = actionParts(e.action ?? '', e.details ?? '', e.tileId);
      if (!parts || !e.playerId) continue;
      /* [사용자 2026-08-20] 기술 타일 획득·연방 보상은 '무엇을 얻었나'가 정보라 따로 읽는다.
         이건 대개 연구소 건설·연방 형성의 후속 로그라 아래 한 턴 1회 규칙에 걸려 무음이 된다 →
         이것만 예외로 통과시킨다. 대신 같은 턴이면 호칭을 빼 "발타크 …"가 두 번 나오지 않게. */
      const isTechGain = isFollowupInfo(e.action ?? '');
      /* [사용자 2026-08-20] 한 턴에 한 번, 그 턴의 '첫' 액션만 읽는다.
         "파워 액션 → 광산 건설"처럼 수단과 결과가 각각 로그로 남아 두 번 울렸다(실측 17%).

         턴 판정은 서버가 주는 turnMark(그 사람의 턴 시작 로그 seq)를 쓴다. 예전엔
         hasDoneMainAction이 false로 돌아가는 '순간'을 세었는데, 서버에서 그걸 세우는 곳이 9군데로
         흩어져 있고 React가 한 틱의 소켓 이벤트를 묶으면 그 순간을 못 보고 지나쳐 다음 액션이 무음이 됐다.
         그 구멍을 3초 규칙으로 막았더니 이번엔 같은 턴이 두 번 읽혔다(실측: 수단→결과 쌍의 52%).
         turnMark는 '순간'이 아니라 상태에 실려 오는 값이라 놓칠 수가 없다 → 시간 추정을 걷어냈다.
         turnMark가 없는 옛 서버·관전 경로에서는 예전 방식(window + 3초)으로 되돌아간다. */
      const ts = e.timestamp ?? Date.now();
      const mark = game.turnMark?.[e.playerId];
      const win = mark ?? actionWindowRef.current;
      const sameWindow = announcedWindowRef.current[e.playerId] === win;
      const longGap = mark === undefined && ts - (lastVoiceAtRef.current[e.playerId] ?? 0) >= 3000;
      if (sameWindow && !longGap && !isTechGain) continue;   // 같은 턴의 후속 로그 → 무음
      const skipWho = isTechGain && sameWindow;
      /* [사용자 2026-08-21] 준비 동작→본 액션은 이어지는 콤보라 따로 두 번 읽지 않고 한 문장으로 —
         "파이락, 트왈라잇 사거리, 광산 건설". 준비 동작은 바로 읽지 않고 들고 있다가 같은 턴의
         본 액션 앞에 붙인다. 턴은 통째로 커밋되므로 둘은 같은 패스에서 만난다(예외는 루프 끝에서 단독 방출). */
      const isEnabler = parts.length === 1 && ENABLER_LABELS.has(parts[0]);
      const p = game.players?.[e.playerId];
      if (isEnabler) {
        if (pendingEnabler && (pendingEnabler.playerId !== e.playerId || pendingEnabler.win !== win)) {
          enqueueParts(pendingEnabler.parts);           // 다른 턴의 준비 동작이 남아 있으면 단독 방출
        }
        if (pendingEnabler && pendingEnabler.playerId === e.playerId && pendingEnabler.win === win) {
          pendingEnabler.parts.push(...parts);          // 한 턴에 준비 동작 둘(사거리 중첩 등)
        } else {
          pendingEnabler = { playerId: e.playerId, win, parts: [whoLabel(p?.faction ?? undefined, p?.name ?? undefined) ?? '', ...parts] };
        }
        lastVoiceAtRef.current[e.playerId] = ts;
        continue;
      }
      announcedWindowRef.current[e.playerId] = win;
      lastVoiceAtRef.current[e.playerId] = ts;
      let prefix: string[] = [];
      if (pendingEnabler) {
        if (pendingEnabler.playerId === e.playerId && pendingEnabler.win === win) prefix = pendingEnabler.parts;
        else enqueueParts(pendingEnabler.parts);
        pendingEnabler = null;
      }
      const who = prefix.length ? '' : (skipWho ? '' : (whoLabel(p?.faction ?? undefined, p?.name ?? undefined) ?? ''));
      enqueueParts([...prefix, who, ...parts]);
    }
    if (pendingEnabler) enqueueParts(pendingEnabler.parts);   // 본 액션 없이 턴이 끝난 준비 동작
    voiceLogMarkRef.current = done;
  }, [game?.gameLog?.length, game?.hasDoneMainAction, game]);

  // Turn behavior notification sounds
  useEffect(() => {
    if (!game || !game.turnOrder || game.currentPlayerIndex === undefined) return;
    if (isSpectator) return; // [사용자 2026-08-01] 관전자에게 턴 알림음(내턴/상대턴) 울리던 버그 — 파워 리마인더처럼 차단

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

    // 4. Special cases: Faction bidding (별도 상태 — turnOrder로 안 돌아감)
    //    입찰 차례(currentBidderId) 또는 낙찰 후 종족 픽 차례(pickPlayerId)가 내게 오면 알림.
    const fb = game.factionBidding;
    const bidderId = fb ? (fb.phase === 'pick' ? fb.pickPlayerId : fb.currentBidderId) : null;
    const isMyBid = !!bidderId && bidderId === playerId;
    if (bidderId !== lastBidderRef.current || isMyBid !== lastWasMyBidRef.current) {
      if (isMyBid && !lastWasMyBidRef.current) {
        playMyTurnSound();
      } else if (!isMyBid && bidderId && bidderId !== lastBidderRef.current) {
        playOtherTurnSound();
      }
      lastBidderRef.current = bidderId || null;
      lastWasMyBidRef.current = isMyBid;
    }
  }, [game?.currentPlayerIndex, game?.turnOrder, game?.pendingBonusSelection, game?.pendingTechTileSelection?.playerId, game?.factionBidding?.currentBidderId, game?.factionBidding?.pickPlayerId, game?.factionBidding?.phase, playerId, isSpectator]);

  // Power Receive sound notification
  useEffect(() => {
    if (!game || !playerId) return;
    if (isSpectator) return; // 관전자는 좌석 파워 변화 소리도 제외
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
    if (myPendingOffers.length === 0) {
      lastMyOfferCountRef.current = 0;
      return;
    }

    // 새 파워 제안(누수)이 도착하면 즉시 1회 알림 — "내 차례" 신호. (이후엔 5초마다 리마인드)
    if (myPendingOffers.length > lastMyOfferCountRef.current) {
      const el = document.activeElement;
      const isTyping = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (!isTyping) playPowerDecisionSound();
    }
    lastMyOfferCountRef.current = myPendingOffers.length;

    const interval = window.setInterval(() => {
      // 입력 중에는 방해하지 않기
      const el = document.activeElement;
      const isTyping = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (isTyping) return;
      playPowerDecisionSound();
    }, 5000);

    // 첫 알림은 5초 뒤(즉시 울리면 너무 시끄러움)
    const t = window.setTimeout(() => {
      const el = document.activeElement;
      const isTyping = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (!isTyping) playPowerDecisionSound();
    }, 5000);

    return () => {
      window.clearTimeout(t);
      window.clearInterval(interval);
    };
  }, [game?.pendingPowerOffers, playerId, isSpectator]);

  const selectTechTileWithLevel5Confirm = (techTileId: string, trackId?: string, options?: { fromMini?: boolean; confirmed?: boolean }) => {
    if (!gameId || !game || !playerId) return;

    // [사용자 요청] 아이타 4토큰 교환 타일은 수익 단계라 되돌리기가 없어 클릭 즉시 확정됨 → 확인창 한 단계 추가.
    // (탑승 안 한 우주선 타일 등 사전 차단은 확인 후 실제 커밋 시 그대로 적용되므로 여기선 확인만.)
    if (!options?.confirmed && game.pendingTechTileSelection?.structureType === 'itars_pi_exchange') {
      setItarsTileConfirm({ techTileId, trackId, fromMini: options?.fromMini });
      return;
    }

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

  // [사용자] FA 모드 종족 특수 프리액션 버튼 — 내 상태창 카드 '바깥 왼쪽'(데스크톱)에 fixed로 띄우려고
  //  카드 DOM 위치를 추적한다. 훅은 반드시 조기 return 위에서 호출(로딩 중에도 동일 개수 유지).
  // [2026-08-07 사용자] 같은 '카드 바깥 왼쪽' 자리에 남의 카드도 스트립을 띄운다
  //   (내 카드=프리액션 버튼, 남의 카드=남은 특수 액션) → 카드 위치를 플레이어별로 추적.
  // [2026-08-07 사용자] 스트립(내 카드=프리액션 버튼 / 남의 카드=남은 특수 액션)은 카드 '바깥 왼쪽'에 붙는다.
  //   예전엔 position:fixed + JS 좌표 추적이었는데, 상태창 목록이 컴포지터 스크롤이라 메인 스레드가 읽는
  //   좌표가 항상 한 프레임 뒤처져 스크롤할 때 스트립이 밀려 보였다(rAF로 매 프레임 갱신해도 동일).
  //   → 스크롤 영역 '안'에 두고 카드의 자식으로 절대배치한다. 카드와 같은 레이어라 원리적으로 밀리지 않고,
  //     목록 밖으로 나가면 컨테이너 overflow에 잘려 자동으로 사라진다.
  //   [2026-08-07 사용자] 카드 안(스크롤 영역)으로 넣어 보니 목록 왼쪽 여백만큼 상태창이 좁아져 기각.
  //   → 상태창 폭을 그대로 두려고 fixed 방식으로 되돌린다. 컴포지터 스크롤에서 한 프레임 밀리는 건
  //     이 방식의 한계(기존 프리액션 버튼도 동일). 매 프레임 갱신으로 최대한 줄이고,
  //     카드가 목록 밖으로 나가면 스트립도 숨긴다.
  // [2026-08-07 사용자] 정신 사나울 수 있어 '?' 안내창(데스크톱 설정)에서 끌 수 있게. 기본 ON.
  const [showSpecialStrips, setShowSpecialStrips] = useState<boolean>(() => {
    try { return localStorage.getItem('special-action-strip') !== 'off'; } catch { return true; }
  });
  useEffect(() => {
    const onChange = (e: Event) => setShowSpecialStrips(!!(e as CustomEvent).detail);
    window.addEventListener('special-action-strip-change', onChange);
    return () => window.removeEventListener('special-action-strip-change', onChange);
  }, []);
  /** [사용자 2026-08-21] 스트립이 메뉴를 가릴 때 잠깐 끄는 세션용 스위치(맵의 '특수 ON/OFF' 버튼).
   *  설정(localStorage)은 그대로 두므로 새로고침하면 다시 표시된다. */
  const [stripQuickOff, setStripQuickOff] = useState(false);

  // 좌하단 액션 버튼 묶음(Free Actions / Tactical / Research / 특수 액션) 표시 여부.
  //   [2026-08-18 사용자] **기본 표시**로 되돌림 (2026-08-14에 기본 숨김이었다 — 존재를 모르는 사람이 더 문제).
  //   '?' 안내창에서 끌 수 있고, 껐던 사람은 'off'가 남아 있어 그대로 숨겨진다.
  const [showLeftActionButtons, setShowLeftActionButtons] = useState<boolean>(() => {
    try { return localStorage.getItem('left-action-buttons') !== 'off'; } catch { return true; }
  });
  useEffect(() => {
    const onChange = (e: Event) => setShowLeftActionButtons(!!(e as CustomEvent).detail);
    window.addEventListener('left-action-buttons-change', onChange);
    return () => window.removeEventListener('left-action-buttons-change', onChange);
  }, []);
  const trackCardStrips = !isMobileViewport && isSidebarOpen;
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const stripRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const playerListScrollRef = useRef<HTMLDivElement | null>(null);
  const applyStripPos = useRef<() => void>(() => { });
  applyStripPos.current = () => {
    const cont = playerListScrollRef.current;
    const cr = cont ? cont.getBoundingClientRect() : null;
    // 레이아웃 스래싱을 피하려고 '전부 읽고 → 전부 쓴다'
    const reads: Array<{ strip: HTMLDivElement; r: DOMRect | null }> = [];
    for (const [pid, strip] of Object.entries(stripRefs.current)) {
      if (!strip) continue;
      const card = cardRefs.current[pid];
      reads.push({ strip, r: card ? card.getBoundingClientRect() : null });
    }
    for (const { strip, r } of reads) {
      // 카드가 목록 밖으로 스크롤돼 나갔거나 목록 자체가 안 보이면 스트립도 숨긴다
      // (예전엔 스트립만 남아 로그 옆에 떠 있었음 — 사용자 관찰)
      const offList = !r || r.height <= 0 || r.left <= 0
        || (cr ? (cr.width <= 0 || r.bottom <= cr.top + 2 || r.top >= cr.bottom - 2) : false);
      if (offList) { strip.style.visibility = 'hidden'; continue; }
      strip.style.top = `${r!.top}px`;
      strip.style.left = `${r!.left}px`;
      strip.style.height = `${r!.height}px`;
      strip.style.visibility = 'visible';
    }
  };
  useLayoutEffect(() => { applyStripPos.current(); });
  useEffect(() => {
    if (!trackCardStrips) return;
    let raf = 0;
    const tick = () => { applyStripPos.current(); raf = window.requestAnimationFrame(tick); };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [trackCardStrips]);

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

  /** 토큰 비용(연방 위성·인공물)이 모자랄 때 1O→1토큰으로 메울 수 있는지 판정.
   *  @returns 부족분(=변환 횟수). 0이면 그냥 진행, null이면 광물로도 불가능 → 안내만. */
  const oreToTokenShortfall = (need: number): number | null => {
    const p = currentPlayer;
    if (!p) return null;
    const have = countSpendableTokens(p);
    if (have >= need) return 0;
    const shortfall = need - have;
    return (p.ore ?? 0) >= shortfall ? shortfall : null;
  };

  /** [사용자 리뷰 2026-08-13] '소멸 확정 3그릇 토큰 → 크레딧' 회수는 **서버**가 지불 직전에 한다
   *  (gameState.ts cashDoomedBowl3Tokens). 클라에서 프리액션을 여러 번 emit하던 방식은
   *  ①본 액션이 거절되면 회수만 남고 ②'광물→토큰 후 상태'를 낙관적으로 추측해야 했다.
   *  여기서는 확인창에 보여줄 예상 크레딧만 계산한다(실제 반영은 서버). */
  const creditsPerBowl3Token = (currentPlayer?.faction === 'nevlas'
    && game.map?.some(t => t.ownerId === playerId && t.structure === 'planetary_institute')) ? 2 : 1;

  /** 서버가 지불 직전에 회수할 크레딧 수를 미리 계산한다 (서버 cashDoomedBowl3Tokens와 동일 산식).
   *  ★ 광물→토큰 변환이 없는 경로에서만 쓴다 — 그 경우 클라 상태가 서버의 지불 시점 상태와 같아
   *  예측이 정확하다. 변환이 끼는 경로는 확인창이 이미 안내하므로 토스트가 필요 없다. */
  const predictBowl3Cash = (need: number): number => {
    if (!currentPlayer) return 0;
    return doomedBowl3Tokens(currentPlayer, need) * creditsPerBowl3Token
      + (isBrainCashableBeforeTokenCost(currentPlayer, need) ? 3 : 0);
  };

  /** 연방 완료 공용 핸들러: 위성 토큰이 모자라면 1O→1토큰 변환 확인 후 진행 */
  const handleFederationComplete = (force = false) => {
    if (!gameId || !currentPlayer) return;
    const fm = game.federationMode;
    // 하이브는 위성 대신 QIC로 잇는다(1O→1토큰과 무관) → 기존대로 서버 검증에 맡김
    if (fm && fm.playerId === playerId && currentPlayer.faction !== 'ivits') {
      const need = fm.selectedHexIds?.length ?? 0;
      const converts = oreToTokenShortfall(need);
      if (converts === null) {
        toast({ title: '파워 토큰 부족', description: `위성 ${need}개가 필요한데 토큰도 광물도 부족합니다.`, variant: 'destructive' });
        return;
      }
      // [사용자 지적 2026-08-13] 자원을 건드리기 전에 '불필요 위성' 경고부터 통과시킨다.
      //   예전 순서(변환 → 서버 호출 → 경고 → Cancel)는 취소해도 광물이 이미 바뀐 뒤였다.
      //   서버가 federationPreview.redundant로 같은 계산을 미리 내려주므로 여기서 먼저 물어볼 수 있다.
      //   경고에서 OK를 누르면 force=true로 다시 들어와 이 분기를 건너뛰고 변환 단계로 넘어간다.
      const redundant = game.federationPreview?.redundant ?? 0;
      if (!force && redundant > 0) { setFederationRedundantWarning({ count: redundant }); return; }
      if (converts > 0) { setConfirmOreToToken({ kind: 'federation', converts, need, force }); return; }
      // 서버가 조용히 회수하므로(게임 로그에만 남음) 여기서 이유를 알려준다
      const cash = predictBowl3Cash(need);
      if (cash > 0) toast({ title: '3그릇 토큰 회수', description: `위성으로 사라질 3그릇을 크레딧 ${cash}개로 먼저 회수합니다.` });
    }
    GameClient.federationComplete(gameId, force);
  };

  /** 인공물 획득 공용 핸들러: 6토큰이 모자라면 1O→1토큰 변환 확인 후 진행 */
  const handleTakeTwilightArtifact = (artifactId: string) => {
    if (!gameId || !currentPlayer) return;
    // [사용자 리뷰 2026-08-13] 자원을 건드리기 전에 서버 전제조건을 먼저 확인한다.
    //   변환과 본 액션은 원자적이지 않아서, 본 액션이 거절되면 변환만 남는다. 서버가
    //   take_twilight_artifact에서 조용히 return하는 조건들(내 턴/메인 단계/메인액션 미수행/
    //   트왈라이트 탑승/슬롯 존재)을 여기서 미리 걸러 그 창을 닫는다.
    if (game.currentPhase !== 'main' || game.turnOrder?.[game.currentPlayerIndex] !== playerId) return;
    if (game.hasDoneMainAction) {
      toast({ title: '이미 메인 액션을 했습니다', description: '인공물 획득은 메인 액션이라 이번 턴에는 할 수 없습니다.', variant: 'destructive' });
      return;
    }
    const twilightTile = game.map?.find(t => t.type === 'ship_twilight');
    if (!twilightTile || !(currentPlayer.spaceshipsEntered ?? []).includes(twilightTile.id)) {
      toast({ title: '트왈라이트 미탑승', description: '인공물은 트왈라이트에 탑승한 뒤에 가져올 수 있습니다.', variant: 'destructive' });
      return;
    }
    if (!(game.twilightArtifactSlots ?? []).includes(artifactId)) return;
    const ART_TOKEN_COST = 6; // 서버 take_twilight_artifact의 spendPowerTokens(player, 6)와 동일
    const converts = oreToTokenShortfall(ART_TOKEN_COST);
    if (converts === null) {
      toast({ title: '파워 토큰 부족', description: `인공물은 토큰 ${ART_TOKEN_COST}개가 필요한데 토큰도 광물도 부족합니다.`, variant: 'destructive' });
      return;
    }
    if (converts > 0) {
      const label = ARTIFACTS.find(a => a.id === artifactId)?.label ?? artifactId;
      setConfirmOreToToken({ kind: 'artifact', artifactId, converts, need: ART_TOKEN_COST, label });
      return;
    }
    const cash = predictBowl3Cash(ART_TOKEN_COST);
    if (cash > 0) toast({ title: '3그릇 토큰 회수', description: `인공물로 사라질 3그릇을 크레딧 ${cash}개로 먼저 회수합니다.` });
    GameClient.takeTwilightArtifact(gameId, artifactId);
  };

  /** 지금 실제로 쓸 수 있는 가이아포머 수 = 개인판 보유분 − 발타크가 이번 라운드 QIC로 써서 잠근 분.
   *  서버 getEffectiveGaiaformers와 동일 정의. 맵에 배치된 포머는 gaiaformers에 안 들어 있어 자연히 제외된다.
   *  [사용자 리뷰 2026-08-13] GameBoard의 소행성 판정은 잠금을 빼는데 Game.tsx 건설 확인은 안 빼서
   *    두 경로가 어긋나 있었다(포머를 다 QIC로 바꾼 뒤 소행성을 누르면 클라 통과 → 서버 거절). 여기로 통일. */
  const availableGaiaformers = (p: typeof currentPlayer): number => {
    if (!p) return 0;
    const locked = p.faction === 'bal_tak' ? ((p as { balTakGaiaformersUsedForQic?: number }).balTakGaiaformersUsedForQic ?? 0) : 0;
    return Math.max(0, (p.gaiaformers ?? 0) - locked);
  };
  /** 발타크가 지금 QIC로 바꿀 수 있는 포머 수 (다른 종족은 이 능력 자체가 없어 0). */
  const balTakSpareGaiaformers = (p: typeof currentPlayer): number =>
    (p && p.faction === 'bal_tak') ? availableGaiaformers(p) : 0;

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
          // [사용자 2026-08-13] 타클론도 자동 태우기 지원. 브레인이 3그릇인데 모자란 경우(일반 번)와
          //   브레인이 2그릇이라 태우면 3그릇으로 올라가는 경우 둘 다 planTaklonsPowerBurns가 계산한다.
          if (!canSpendTaklonsPower(cur, 3, action.cost as number)) {
            const plan = planTaklonsPowerBurns(cur, action.cost as number);
            if (!plan) {
              toast({ title: '파워 부족', description: '3그릇(브레인 스톤 포함)이 부족하고, 2그릇 태우기로도 충당할 수 없습니다.', variant: 'destructive' });
              return;
            }
            setConfirmBurnAction({ kind: 'power', actionId, burns: plan.burns, brainBurnFirst: plan.brainBurnFirst, closeResearchOverlay: options?.closeResearchOverlay });
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
        // [사용자 2026-08-13] 발타크는 남은 포머를 QIC로 바꿔 메울 수 있다 — 타클론 태우기와 같은 확인 흐름.
        const converts = (action.cost as number) - (cur.qic ?? 0);
        if (balTakSpareGaiaformers(cur) >= converts) {
          setConfirmQicConvert({ kind: 'power', actionId, converts, closeResearchOverlay: options?.closeResearchOverlay });
          return;
        }
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
      if (cost.qic && (cur.qic ?? 0) < cost.qic) {
        // [사용자 2026-08-13] 발타크: 부족분만큼 포머를 QIC로 변환할 수 있으면 확인창(보드 QIC 액션과 동일)
        const converts = cost.qic - (cur.qic ?? 0);
        if (balTakSpareGaiaformers(cur) >= converts) {
          const label = SHIP_TOAST_LABELS[shipTile.type]?.[actionIndex - 1] ?? `${SHIP_TOAST_NAMES[shipTile.type]} 액션 ${actionIndex}`;
          setConfirmQicConvert({ kind: 'ship', shipTileId, actionIndex, targetTileId, converts, label, fromOverlay: options?.fromOverlay });
          return;
        }
        toast({ title: 'QIC 부족', description: `${cost.qic} QIC가 필요합니다.`, variant: 'destructive' }); return;
      }
      if (cost.ore && (cur.ore ?? 0) < cost.ore) { toast({ title: '광물 부족', description: `${cost.ore} 광물이 필요합니다.`, variant: 'destructive' }); return; }
      if (cost.knowledge && (cur.knowledge ?? 0) < cost.knowledge) { toast({ title: '지식 부족', description: `${cost.knowledge} 지식이 필요합니다.`, variant: 'destructive' }); return; }
      if (cost.credits && (cur.credits ?? 0) < cost.credits) { toast({ title: '크레딧 부족', description: `${cost.credits} 크레딧이 필요합니다.`, variant: 'destructive' }); return; }
      // [사용자 2026-08-13] 타클론도 보드 파워 액션과 동일하게 자동 태우기 확인창을 띄운다.
      //   (서버는 canSpendTaklonsPower로 막고 조용히 무시하므로 이전엔 안내조차 없었다.)
      if (cost.power && cur.faction === 'taklons' && !canSpendTaklonsPower(cur, 3, cost.power)) {
        const plan = planTaklonsPowerBurns(cur, cost.power);
        if (!plan) {
          toast({ title: '파워 부족', description: '3그릇(브레인 스톤 포함)이 부족하고, 2그릇 태우기로도 충당할 수 없습니다.', variant: 'destructive' });
          return;
        }
        const label = SHIP_TOAST_LABELS[shipTile.type]?.[actionIndex - 1] ?? `${SHIP_TOAST_NAMES[shipTile.type]} 액션 ${actionIndex}`;
        setConfirmBurnAction({ kind: 'ship', shipTileId, actionIndex, targetTileId, burns: plan.burns, brainBurnFirst: plan.brainBurnFirst, label, fromOverlay: options?.fromOverlay });
        return;
      }
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
  // 프리액션 우클릭: K 우클릭 → 1K→1C, Q 우클릭 → 1Q→1O (표준 프리액션). 좌클릭(파워변환)과 별개.
  const handleFreeActionRightClick = (kind: 'ore' | 'knowledge' | 'qic') => {
    if (!gameId || !currentPlayer || !playerId) return;
    const p = currentPlayer;
    let type: string;
    let delta: Record<string, number>;
    if (kind === 'knowledge') {
      if ((p.knowledge ?? 0) < 1) { toast({ title: '지식 부족', description: '변환할 K가 1 이상 필요합니다.', variant: 'destructive' }); return; }
      type = '1knowledge-to-1credit'; delta = { knowledge: -1, credits: 1 };
    } else if (kind === 'qic') {
      if ((p.qic ?? 0) < 1) { toast({ title: 'QIC 부족', description: '변환할 Q가 1 이상 필요합니다.', variant: 'destructive' }); return; }
      type = '1qic-to-1ore'; delta = { qic: -1, ore: 1 };
    } else {
      if ((p.ore ?? 0) < 1) { toast({ title: '광물 부족', description: '변환할 O가 1 이상 필요합니다.', variant: 'destructive' }); return; }
      type = '1ore-to-1credit'; delta = { ore: -1, credits: 1 };
    }
    // 낙관적 UI (단순 자원 교환, 종족 무관)
    setGame(prev => {
      if (!prev) return prev;
      const pl = prev.players[playerId]; if (!pl) return prev;
      const np: Record<string, unknown> = { ...pl };
      for (const k in delta) np[k] = Math.max(0, (Number(np[k]) || 0) + delta[k]);
      return { ...prev, players: { ...prev.players, [playerId]: np } } as typeof prev;
    });
    GameClient.convertResource(gameId, type);
  };

  const handleFreeActionClick = (kind: 'ore' | 'knowledge' | 'qic' | 'credit' | 'bowl1' | 'bowl2' | 'bowl3' | 'baltak-gf') => {
    if (!gameId || !currentPlayer) return;
    const p = currentPlayer;
    const isTak = p.faction === 'taklons';
    const hasNevPI = p.faction === 'nevlas' && (game.map?.some(t => t.ownerId === playerId && t.structure === 'planetary_institute') ?? false);
    nevlasOreChainRef.current = null; // [2026-07-31] 네뷸라 O 체인 폐지(O=3P→2O 직접)

    const needPower = (cost: number) => {
      // [사용자] 타클론 상태창 자원변환은 '일반 파워토큰' 기준으로만 활성화(브레인 조합은 왼쪽 스트립 전용).
      const ok = hasNevPI ? (p.power3 ?? 0) >= Math.ceil(cost / 2) : (p.power3 ?? 0) >= cost;
      if (!ok) toast({ title: '파워 부족', description: '3그릇 일반 파워토큰이 부족합니다. (브레인은 왼쪽 🧠 버튼)', variant: 'destructive' });
      return ok;
    };

    // 낙관적 UI: 변환 결과를 로컬에 즉시 반영(클릭 대기 제거), 서버 game_updated가 권위값으로 덮어씀.
    // 타클론은 브레인스톤 그릇 이동이 복잡해 낙관 생략(서버 대기). 그릇 변동 없는 단순 자원만.
    const applyOptimistic = (delta: Record<string, number>) => {
      if (isTak) return;
      setGame(prev => {
        if (!prev || !playerId) return prev;
        const pl = prev.players[playerId]; if (!pl) return prev;
        const np: Record<string, unknown> = { ...pl };
        for (const k in delta) np[k] = Math.max(0, (Number(np[k]) || 0) + delta[k]);
        return { ...prev, players: { ...prev.players, [playerId]: np } } as typeof prev;
      });
    };

    switch (kind) {
      case 'ore':
        // [사용자] 네뷸라 의회: O = 3P→2O 직접(기존 2P→1O 체인 폐지). 2P→1O1C는 왼쪽 스트립 버튼.
        if (hasNevPI) {
          if ((p.power3 ?? 0) < 3) { toast({ title: '파워 부족', description: '3그릇 파워가 3개 필요합니다 (3P→2O).', variant: 'destructive' }); return; }
          GameClient.convertResource(gameId, '3power-to-2ore');
          return;
        }
        if (!needPower(3)) return;
        // [사용자] 타클론: O 클릭은 일반토큰 우선(useBrain=false) — 브레인을 광석에 낭비 않게(3P→1O는 브레인 써도 이득 없음).
        //   브레인만 있고 일반토큰 부족하면 서버가 자동으로 브레인 폴백. 브레인을 굳이 쓰려면 🧠1B→1O 버튼 사용.
        applyOptimistic({ power3: -3, power1: 3, ore: 1 }); GameClient.convertResource(gameId, '3power-to-1ore', isTak ? false : undefined);
        return;
      case 'credit':
        // [2026-07-31] 네뷸라 2P→1O1C 체인 폐지 → 왼쪽 스트립 버튼으로. C는 일반 1P→(의회2)C.
        // [사용자] 상태창 C는 일반토큰 전용 — 브레인(1B→3C)은 왼쪽 스트립 버튼으로. (기존 브레인 우선 라우팅 제거)
        //   1power-to-1credit 서버 로직은 타클론이면 일반토큰 우선(있을 때), 없으면 자동 브레인 폴백.
        if (!needPower(1)) return;
        applyOptimistic(hasNevPI ? { power3: -1, power1: 1, credits: 2 } : { power3: -1, power1: 1, credits: 1 }); GameClient.convertResource(gameId, '1power-to-1credit');
        return;
      case 'knowledge':
        if (!needPower(4)) return;
        applyOptimistic(hasNevPI ? { power3: -2, power1: 2, knowledge: 1 } : { power3: -4, power1: 4, knowledge: 1 }); GameClient.convertResource(gameId, '4power-to-1knowledge', isTak ? false : undefined);
        return;
      case 'qic':
        if (p.faction === 'gleens' && !(game.map?.some(t => t.ownerId === playerId && t.structure === 'academy' && t.academyType === 'right'))) {
          toast({ title: '사용 불가', description: '글린은 오른쪽 아카데미가 있어야 QIC 변환이 가능합니다.', variant: 'destructive' });
          return;
        }
        if (!needPower(4)) return;
        applyOptimistic(hasNevPI ? { power3: -2, power1: 2, qic: 1 } : { power3: -4, power1: 4, qic: 1 }); GameClient.convertResource(gameId, '4power-to-1qic', isTak ? false : undefined);
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

  // [사용자] FA 모드 종족 특수 프리액션을 내 상태창 카드 '바깥 왼쪽'(데스크톱)에 세로 버튼으로 띄운다.
  //  (훅 자체는 조기 return 위에서 호출 — 아래는 game이 확정된 뒤라 non-hook 계산만 한다.)
  const youFaActs: { label: string; disabled: boolean; run: () => void }[] = (() => {
    const me = playerId ? (game.players[playerId] as PlayerState | undefined) : undefined;
    if (!me || !gameId) return [];
    const acts: { label: string; disabled: boolean; run: () => void }[] = [];
    const hasPI = (pid: string) => !!game.map?.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === pid && t.structure === 'planetary_institute');
    if (me.faction === 'taklons' && (me as any).brainStoneBowl === 3 && !(me as any).brainStoneInGaia) {
      acts.push({ label: '🧠1B→3C', disabled: false, run: () => GameClient.convertResource(gameId, '1brain-to-3credit') });
      // 브레인(3파워)을 3P→1O에 사용(useBrain=true로 일반토큰 대신 브레인 소비 강제)
      acts.push({ label: '🧠1B→1O', disabled: false, run: () => GameClient.convertResource(gameId, '3power-to-1ore', true) });
      // K/Q는 4파워 = 브레인(3) + 일반토큰 1 → 일반 파워토큰이 1개 이상 있을 때만
      const reg3 = me.power3 ?? 0;
      acts.push({ label: '🧠1B+1P→1K', disabled: reg3 < 1, run: () => GameClient.convertResource(gameId, '4power-to-1knowledge', true) });
      acts.push({ label: '🧠1B+1P→1Q', disabled: reg3 < 1, run: () => GameClient.convertResource(gameId, '4power-to-1qic', true) });
    }
    // [버그수정 2026-07-31 사용자] 네뷸라 1P→가이어+1K는 PI 불필요(기본 능력) — 서버·FreeActionsDialog와 동일하게 faction만 체크.
    if (me.faction === 'nevlas') {
      acts.push({ label: '1P→가이어+1K', disabled: (me.power3 ?? 0) < 1, run: () => GameClient.convertResource(gameId, '1power-to-1k-gaiaformer') });
      // 네뷸라 의회(PI) 전용 변환 — 서버가 hasNevlasPI 요구. (기본 O/K/Q/C는 상태창에서 PI 할인가로 처리)
      if (hasPI(playerId!)) {
        acts.push({ label: '2P→1O1C', disabled: (me.power3 ?? 0) < 2, run: () => GameClient.convertResource(gameId, '2power-to-1ore-1credit') });
      }
    }
    if (me.faction === 'bal_tak') {
      const avail = (me.gaiaformers ?? 0) - ((me as any).balTakGaiaformersUsedForQic ?? 0);
      acts.push({ label: '포머→1Q', disabled: avail < 1, run: () => GameClient.useBalTakGaiaformerToQic(gameId) });
    }
    if (me.faction === 'hadsch_hallas' && hasPI(playerId!))
      for (const a of (((me as any).hadschHallasPIActions ?? []) as { id: string; costCredits: number; label: string }[]))
        acts.push({ label: a.label, disabled: (me.credits ?? 0) < a.costCredits, run: () => GameClient.useHadschHallasPIAction(gameId, a.id) });
    return acts;
  })();
  // 프리액션 Undo 스택 깊이(서버 브로드캐스트). Undo/Undo All 버튼 활성/비활성 판단용.
  const faUndoDepth = ((game as unknown as { freeActionUndoStack?: unknown[] }).freeActionUndoStack?.length) ?? 0;
  // [사용자] 불가능한 버튼은 아예 숨김(불투명하게 자리 차지 방지) — 지금 실제로 누를 수 있는 것만 표시.
  const faVisibleActs = isCurrentTurn ? youFaActs.filter(a => !a.disabled) : [];
  const faShowUndo = isCurrentTurn && faUndoDepth > 0;
  // FA 모드 + 표시할 게 있을 때만 스트립을 띄운다(빈 스트립 미표시).
  const showYouFaStrip = freeActionMode && !isMobileViewport && isSidebarOpen && (faVisibleActs.length > 0 || faShowUndo);

  const pendingTurnEndPlayerId = game.pendingTurnEndPlayerId;
  const pendingTurnEndPlayerName = pendingTurnEndPlayerId ? (game.players[pendingTurnEndPlayerId]?.name ?? pendingTurnEndPlayerId) : null;
  // [의회 대기 2026-07-26, 사용자] 아이타/테란 의회 능력(가이아 단계 선택)이 진행 중이면 다른 플레이어는 대기 —
  // 서버가 메인 액션을 막고(councilPendingActive), 여기선 파워 수락 대기와 같은 안내 배너를 띄운다.
  // [버그수정 2026-08-03 사용자] 아이타 교환은 '4토큰 → 타일 선택 → (남으면) 다시 4토큰'의 반복인데, 타일 고르는
  //   구간엔 pendingItarsGaiaformerExchange가 null이라 안내 배너가 깜빡이며 사라졌다. 서버 가드(councilPendingActive)는
  //   이미 그 구간(pendingTechTileSelection[itars_pi_exchange])을 막고 있으므로 배너도 같은 조건으로 맞춰 끝까지 유지.
  const itarsTechPick = (game as any).pendingTechTileSelection?.structureType === 'itars_pi_exchange'
    ? { playerId: (game as any).pendingTechTileSelection.playerId } : null;
  const councilPendingRaw = (game as any).pendingItarsGaiaformerExchange || itarsTechPick
    || (game as any).pendingTerranCouncilBenefit || (game as any).pendingTinkeroidSpecialChoice;
  const councilPendingInfo = councilPendingRaw && councilPendingRaw.playerId !== playerId
    ? {
      name: game.players[councilPendingRaw.playerId]?.name ?? '플레이어',
      kind: ((game as any).pendingItarsGaiaformerExchange || itarsTechPick) ? '아이타' : (game as any).pendingTerranCouncilBenefit ? '테란' : '팅커로이드',
      what: ((game as any).pendingItarsGaiaformerExchange || itarsTechPick || (game as any).pendingTerranCouncilBenefit) ? '의회 능력 처리 중' : '특수 타일 선택 중',
    }
    : null;
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

  // [수입 대기 표시, 사용자] 수입 단계에서 수익/파워 선택이 남은 플레이어들 — 현재 선택 중(pendingIncomeOrder)
  //   + 아직 순서 안 온 대기자(pendingIncomeItems 남음)를 턴 순서로. 의회/파워 대기 배너와 동일 취지.
  const incomeWaiters = (() => {
    const cur = game.pendingIncomeOrder?.playerId;
    const ids: string[] = [];
    if (cur) ids.push(cur);
    for (const wid of game.turnOrder ?? []) {
      if (wid === cur) continue;
      if ((((game.players[wid] as any)?.pendingIncomeItems?.length) ?? 0) > 0) ids.push(wid);
    }
    return ids.map((wid) => ({ id: wid, name: game.players[wid]?.name ?? wid, current: wid === cur }));
  })();

  if (game.currentPhase === 'lobby') {
    return (
      <>
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
          mergeGameLog(res.game); setGame(res.game);
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
      {/* 로비에서도 채팅 가능 — 서버 send_chat은 phase 제약 없음(대기 중 소통) */}
      <ChatPanel gameId={gameId!} game={game} canChat={true} selfId={playerId} />
      </>
    );
  }

  // [사용자 2026-08-01 "결과창이 1초 뒤 닫혔다 다시 열려"] 인라인 컴포넌트(<GameEndScoreModal />)는 부모 리렌더마다
  // 타입이 새로 생겨 React가 다이얼로그를 재마운트 → 종료 직후 서버 후처리 emit 한 번에 닫힘/재열림 깜빡임.
  // 일반 함수 호출({GameEndScoreModal()})로 바꿔 컴포넌트 경계를 제거 (scoreTab state는 부모로 승격).
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
            <Tabs value={scoreTab} onValueChange={setScoreTab} className="flex-1 flex flex-col min-h-0">
              <TabsList className="bg-zinc-900/50 p-1 rounded-xl border border-white/5 self-start mb-6">
                <TabsTrigger
                  value="__overview__"
                  className="data-[state=active]:bg-zinc-800 data-[state=active]:text-white font-bold py-2 px-6 rounded-lg transition-all"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base">📊</span>
                    <span className="text-sm">전체 요약</span>
                  </div>
                </TabsTrigger>
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

              {/* [사용자] 전체 요약 탭: 누가 어디서 점수 얻었는지 한눈에 보는 표. 이름 클릭 → 해당 상세 탭. */}
              <TabsContent value="__overview__" className="flex-1 overflow-auto pr-2 custom-scrollbar">
                {(() => {
                  // [사용자] 'other'를 소스별로 라벨링해 "기타" 뭉치를 없앤다: 우주선 입장(−)·연방 보상·인공물·비딩·트랙보상 등
                  //   각각 실제 소스명 행으로. b.spaceships(우주선 액션 +VP)는 '정큐액션' 행으로 분리(입장 비용과 별개).
                  // 연방 계열 판정·한글 라벨은 상세 카드와 동일 헬퍼 공유(테라포밍 5 보상도 연방으로 합산)
                  const bucketOf = (s: string) => {
                    if (isFederationScoreSource(s)) return '연방 보상';
                    if (s.includes('비딩')) return '비딩';
                    if (s.includes('우주선 입장')) return '우주선 입장';
                    if (s.startsWith('Artifact') || s.startsWith('인공물')) return '인공물';
                    return scoreSourceLabel(s) || '미분류';
                  };
                  const cols = playersWithScores.map(({ pid, player, faction }) => {
                    const b = player!.scoreBreakdown!;
                    const round = b.roundMissions.reduce((s, m) => s + m.vp, 0);
                    const bonus = b.bonusTilePass.reduce((s, m) => s + m.vp, 0);
                    const tech = b.techTiles.reduce((s, t) => s + t.vp, 0);
                    const jq = b.spaceships.reduce((s, x) => s + x.vp, 0);   // 정큐액션 = 우주선 액션에서 얻은 +VP
                    const remaining = b.remainingResources ?? 0;
                    const buckets: Record<string, number> = {};
                    for (const o of b.other) { const k = bucketOf(o.source ?? ''); buckets[k] = (buckets[k] ?? 0) + o.vp; }
                    const otherAll = b.other.reduce((s, o) => s + o.vp, 0);
                    const raw = 10 + round + bonus + tech + b.finalMissions + b.researchTracks + remaining - b.powerReceived + jq + otherAll;
                    const adjust = (player!.score ?? 0) - raw;
                    const base: Record<string, number> = {
                      '시작 보너스': 10, '라운드 미션': round, '보너스 타일(패스)': bonus, '기술 타일': tech,
                      '최종 미션': b.finalMissions, '연구 트랙': b.researchTracks, '잔여 자원': remaining,
                      '파워 수령': -b.powerReceived, '정큐액션': jq,
                    };
                    return { pid, player, faction, color: faction?.color ?? '#888', base, buckets, adjust, total: player!.score ?? 0 };
                  });
                  const coreRows = ['시작 보너스', '라운드 미션', '보너스 타일(패스)', '기술 타일', '최종 미션', '연구 트랙', '잔여 자원', '파워 수령', '정큐액션'];
                  const preferred = ['우주선 입장', '연방 보상', '인공물', '비딩'];
                  const seen = new Set<string>();
                  cols.forEach(c => Object.keys(c.buckets).forEach(k => { if (Math.abs(c.buckets[k]) > 1e-9) seen.add(k); }));
                  const bucketRows = [...preferred.filter(k => seen.has(k)), ...Array.from(seen).filter(k => !preferred.includes(k)).sort()];
                  const allRows = [...coreRows, ...bucketRows];
                  const negLabels = new Set(['파워 수령', '우주선 입장', '비딩']);
                  const anyAdjust = cols.some(c => Math.abs(c.adjust) > 1e-9);
                  const valOf = (c: { base: Record<string, number>; buckets: Record<string, number> }, label: string) => (label in c.base ? c.base[label] : (c.buckets[label] ?? 0));
                  const cell = (v: number) => (
                    <span className={`tabular-nums font-bold ${Math.abs(v) < 1e-9 ? 'text-zinc-600' : v < 0 ? 'text-red-300' : 'text-zinc-100'}`}>{v < 0 ? `−${Math.abs(v)}` : v}</span>
                  );
                  return (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr className="border-b border-white/10">
                            <th className="text-left py-2 pr-3 text-[10px] uppercase tracking-widest text-zinc-500 font-black">항목</th>
                            {cols.map((c, i) => (
                              <th key={c.pid} className="py-2 px-3 min-w-[7rem]">
                                <button onClick={() => setScoreTab(c.pid)} className="w-full flex flex-col items-center gap-0.5 group" title={`${c.player!.name} 상세 보기`}>
                                  <div className="flex items-center gap-1.5">
                                    {i === 0 && <span className="text-amber-400">👑</span>}
                                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />
                                    <span className="font-bold text-white group-hover:underline">{c.player!.name}</span>
                                  </div>
                                  <span className="text-[9px] uppercase tracking-wider text-zinc-500">{c.faction?.name}</span>
                                </button>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {allRows.map(label => (
                            <tr key={label} className="border-b border-white/5 even:bg-white/[0.035] hover:bg-white/[0.07]">
                              <td className="py-1.5 pr-3 text-zinc-400 font-medium whitespace-nowrap">{negLabels.has(label) ? `${label}(−)` : label}</td>
                              {cols.map(c => (
                                <td key={c.pid} className="py-1.5 px-3 text-center">{cell(valOf(c, label))}</td>
                              ))}
                            </tr>
                          ))}
                          {anyAdjust && (
                            <tr className="border-b border-white/5">
                              <td className="py-1.5 pr-3 text-zinc-500 font-medium italic whitespace-nowrap">보정</td>
                              {cols.map(c => (<td key={c.pid} className="py-1.5 px-3 text-center">{cell(c.adjust)}</td>))}
                            </tr>
                          )}
                          <tr className="border-t-2 border-amber-500/40">
                            <td className="py-2 pr-3 text-amber-300 font-black uppercase tracking-widest text-[11px] whitespace-nowrap">총점</td>
                            {cols.map(c => (
                              <td key={c.pid} className="py-2 px-3 text-center">
                                <span className="text-2xl font-black tabular-nums text-white">{c.total}</span>
                              </td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                      <p className="mt-4 text-center text-[11px] text-zinc-500">플레이어 이름을 클릭하면 상세 내역 탭으로 이동합니다.</p>
                    </div>
                  );
                })()}
              </TabsContent>

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
                                <span className="text-zinc-500 font-bold uppercase tracking-widest text-[10px]">총점</span>
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
                          <h4 className="text-[10px] font-black text-zinc-500 uppercase tracking-[0.2em] px-1">점수 구성</h4>
                          {/* 짝수 줄 배경 교차(zebra) — 항목이 많아 같은 색이면 행 구분이 안 됨(사용자 요청).
                              조건부 렌더 행이 섞여 있어 인덱스 계산 대신 nth-child로 처리, 마지막 '구성 합계' 행은 제외. */}
                          <div className="bg-zinc-900/20 rounded-xl border border-white/5 divide-y divide-white/5 [&>*:nth-child(even):not(:last-child)]:bg-white/[0.035]">
                            <div className="p-3 flex justify-between items-center group hover:bg-white/[0.07] transition-colors">
                              <span className="text-xs font-bold text-zinc-400">시작 보너스</span>
                              <span className="text-sm font-black text-amber-500/80">+10 VP</span>
                            </div>
                            {roundMissionsSum !== 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.07] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">라운드 미션</span>
                                <span className="text-sm font-black text-amber-400/90">+{roundMissionsSum} VP</span>
                              </div>
                            )}
                            {bonusTilePassSum !== 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.07] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">보너스 타일(패스)</span>
                                <span className="text-sm font-black text-yellow-400/90">+{bonusTilePassSum} VP</span>
                              </div>
                            )}
                            {techTilesSum !== 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.07] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">기술 타일</span>
                                <span className="text-sm font-black text-purple-400/90">+{techTilesSum} VP</span>
                              </div>
                            )}
                            {b.finalMissions > 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.07] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">최종 미션</span>
                                <span className="text-sm font-black text-blue-400/90">+{b.finalMissions} VP</span>
                              </div>
                            )}
                            {b.researchTracks > 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.07] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">연구 트랙</span>
                                <span className="text-sm font-black text-cyan-400">+{b.researchTracks} VP</span>
                              </div>
                            )}
                            {remainingResourcesVp > 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.07] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">남은 자원 (O+C+Q+K) 3당 1 VP</span>
                                <span className="text-sm font-black text-emerald-400/90">+{remainingResourcesVp} VP</span>
                              </div>
                            )}
                            {b.powerReceived > 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.07] transition-colors">
                                <span className="text-xs font-bold text-red-400/80">파워 수령(−)</span>
                                <span className="text-sm font-black text-red-500">−{b.powerReceived} VP</span>
                              </div>
                            )}
                            {spaceshipsSum !== 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.07] transition-colors">
                                <span className="text-xs font-bold text-zinc-400">정큐액션(우주선)</span>
                                <span className="text-sm font-black text-cyan-400/90">+{spaceshipsSum} VP</span>
                              </div>
                            )}
                            {(() => {
                              const grouped = b.other.reduce((acc, curr) => {
                                // 연방 계열("Federation"·"연방"·테라포밍 5 보상)은 한 줄('연방' 총합)로 묶고, 나머지도 한글 라벨로 표시
                                const sourceName = scoreSourceLabel(curr.source);

                                const existing = acc.find(item => item.source === sourceName);
                                if (existing) existing.vp += curr.vp;
                                else acc.push({ source: sourceName, vp: curr.vp });
                                return acc;
                              }, [] as { source: string; vp: number }[]);

                              return grouped.map((item, i) => (
                                <div key={i} className="p-3 flex justify-between items-center group hover:bg-white/[0.07] transition-colors">
                                  <span className="text-xs font-bold text-zinc-400">{item.source}</span>
                                  <span className="text-sm font-black text-zinc-100">{item.vp >= 0 ? '+' : ''}{item.vp} VP</span>
                                </div>
                              ));
                            })()}
                            {legacyScoreAdjustment !== 0 && (
                              <div className="p-3 flex justify-between items-center group hover:bg-white/[0.07] transition-colors">
                                <span className="text-xs font-bold text-amber-400/90">미분류/레거시 보정</span>
                                <span className="text-sm font-black text-amber-300">{legacyScoreAdjustment >= 0 ? '+' : ''}{legacyScoreAdjustment} VP</span>
                              </div>
                            )}
                            <div className="p-3 flex justify-between items-center border-t border-white/10 bg-white/[0.02]">
                              <span className="text-xs font-black text-zinc-300 uppercase tracking-wider">구성 합계</span>
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
                            <h4 className="text-xs font-black text-white uppercase tracking-widest">라운드별 획득</h4>
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
                              <h4 className="text-xs font-black text-white uppercase tracking-widest">보너스 타일</h4>
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
                              <h4 className="text-xs font-black text-white uppercase tracking-widest">최종 미션 상세</h4>
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
                                      {ranking.map((r) => {
                                        const isMe = r.rid === pid;
                                        return (
                                          <div key={r.rid} className={`flex items-center gap-2 px-2 py-0.5 rounded ${isMe ? 'bg-blue-500/10 ring-1 ring-blue-400/60' : ''}`}>
                                            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                                            <span className={`text-xs truncate flex-1 min-w-0 ${isMe ? 'font-black text-white' : 'font-bold text-zinc-300'}`}>{r.name}</span>
                                            <span className="text-sm font-black text-white tabular-nums shrink-0 w-7 text-right" title="미션 달성 수치">{r.value}</span>
                                            {/* VP 칸은 0점이어도 항상 자리를 차지해 미션 수치 열이 안 밀리게 */}
                                            <span className="text-sm font-black tabular-nums shrink-0 text-blue-400 w-8 text-right">{r.vp > 0 ? `+${r.vp}` : ''}</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            <div className="mt-2 text-right">
                              <span className="text-[10px] font-bold text-zinc-500 mr-2 uppercase">소계:</span>
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
                              <h4 className="text-xs font-black text-white uppercase tracking-widest">기술 타일 목록</h4>
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
                                <div className="col-span-4 h-16 flex items-center justify-center text-[10px] text-zinc-600 italic">획득한 기술 타일이 없습니다.</div>
                              )}
                            </div>
                          </section>

                          {/* Federations — Tactical Overview 비슷한 컴팩트 크기(64×64) */}
                          <section>
                            <div className="flex items-center gap-2 mb-4">
                              <Shield className="w-4 h-4 text-emerald-500" />
                              <h4 className="text-xs font-black text-white uppercase tracking-widest">형성한 연방</h4>
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
                                <div className="h-16 flex items-center justify-center text-[10px] text-zinc-600 italic">형성한 연방이 없습니다.</div>
                              )}
                            </div>
                          </section>

                          {/* 인공물 (트왈라잇): 이미지 + 점수 표시 */}
                          {(player!.artifacts?.length ?? 0) > 0 && (
                            <section>
                              <div className="flex items-center gap-2 mb-4">
                                <span className="text-amber-400 font-black text-xs uppercase tracking-widest">인공물</span>
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
                                <h4 className="text-xs font-black text-white uppercase tracking-widest">정큐액션(우주선)</h4>
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
                                <h4 className="text-xs font-black text-white uppercase tracking-widest">과학 업적</h4>
                              </div>
                              <Card className="bg-gradient-to-br from-cyan-900/20 to-blue-900/20 border-cyan-800/30 overflow-hidden shadow-lg shadow-cyan-950/20">
                                <div className="p-4 flex items-center gap-4">
                                  <div className="w-12 h-12 bg-black/40 rounded-lg flex items-center justify-center p-1 border border-cyan-400/20">
                                    <img src="/map/ts_111.png" alt="Proto Planet" className="w-full h-full object-contain" />
                                  </div>
                                  <div>
                                    <div className="text-[10px] font-black text-cyan-300 tracking-widest uppercase">프로토 행성 개척</div>
                                    <div className="text-sm font-black text-white">+6 VP <span className="text-[10px] font-bold text-zinc-500">(테라포밍 3단계)</span></div>
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

  /** 모바일 Info 오버레이용: 기술/우주선 섹션을 핀 미니뷰와 동일 핸들러로 재사용(section만 다름). 호출은 game 가드 내부에서만 → game! 안전 */
  const renderInfoResearch = (section: 'tech' | 'ships' | 'all') => (
    <ResearchBoard
      game={game!}
      playerId={playerId}
      isMini={true}
      section={section}
      onUsePowerAction={(actionId) => handleUsePowerAction(actionId)}
      onUseHadschHallasPIAction={(actionId) => GameClient.useHadschHallasPIAction(gameId!, actionId)}
      onUseBalTakGaiaformerToQic={() => GameClient.useBalTakGaiaformerToQic(gameId!)}
      onGainTechTile={(tileId) => GameClient.gainTechTile(gameId!, tileId)}
      onUseTechAction={(tileId) => {
        if (!isMyTurn || game!.currentPhase !== 'main') {
          toast({ title: '사용 불가', description: '내 턴 메인 단계에서만 사용할 수 있습니다.', variant: 'destructive' });
          return;
        }
        if (game!.hasDoneMainAction) {
          toast({ title: '사용 불가', description: '이미 메인 액션을 사용했습니다.', variant: 'destructive' });
          return;
        }
        GameClient.useTechAction(gameId!, tileId);
      }}
      onAdvanceTech={(trackId) => handleResearchAdvanceTech(trackId)}
      onSelectTechTile={(techTileId, trackId) => {
        selectTechTileWithLevel5Confirm(techTileId, trackId, { fromMini: true });
      }}
      onSelectAdvancedTechTile={(advId, trackId) => GameClient.selectAdvancedTechTile(gameId!, advId, trackId)}
      onConfirmAdvancedTechCover={(coverId) => GameClient.confirmAdvancedTechCover(gameId!, coverId)}
      onTakeTwilightArtifact={(artId) => handleTakeTwilightArtifact(artId)}
      onUseAcademyQic={() => GameClient.useSpecialAction(gameId!, 'academy-qic')}
      onEndTurn={() => GameClient.endTurn(gameId!)}
      onResetTurn={() => GameClient.resetTurn(gameId!)}
      onUseShipAction={(shipTileId, actionIndex, targetTileId) => handleUseShipAction(shipTileId, actionIndex, targetTileId)}
    />
  );

  /** 모바일 Info 오버레이 P3(라운드·보너스) — 가로/세로 모드 공용 */
  const renderInfoRoundBonus = () => (
    <div className="flex flex-col gap-4">
      <RoundBoard game={game!} playerId={playerId} isMini={true} />
      <div className="h-[1px] bg-white/10 w-full" />
      <BonusTiles
        game={game!}
        playerId={playerId}
        isMini={true}
        onSelectBonusTile={isMyTurnBonusSelection ? ((id) => GameClient.selectBonusTile(gameId!, id)) : isMyTurn ? ((id) => {
          if (game!.roundNumber === 6) {
            setConfirmPassWithTileId('dummy');
          } else {
            setConfirmPassWithTileId(id);
          }
        }) : undefined}
        onUseBonusAction={() => GameClient.useBonusAction(gameId!)}
      />
    </div>
  );

  return (
    // h-screen(100vh)은 모바일에서 실제 가시 높이보다 커서 하단 버튼이 밀리고 페이지가 스크롤됨 → 100dvh로 고정
    <div className="flex h-[100dvh] overflow-hidden bg-background font-sans text-foreground relative">
      {/* 관전자 표시: 전체 상단을 덮지 않도록 작은 플로팅 배지로만 표시.
          모바일은 좌하단이 채팅(입력창·접힌 버튼) 자리라 겹침(사용자 보고: 세로 모드에서 채팅 못 침) → 좌상단으로. */}
      {isSpectator && typeof document !== 'undefined' && createPortal(
        <>
          {/* 데스크톱: 좌하단 접이식 관전 배지 — [사용자] 작은 모니터에서 상시 배너가 미니뷰(좌상단)를 덮어 거슬림 →
              기본은 작은 눈동자만, 클릭하면 펼쳐서 관전 중/나가기 표시. */}
          <div className="hidden md:flex fixed left-3 bottom-44 z-[120] items-center">
            {specBadgeOpen ? (
              <div className="rounded-full border border-amber-300/40 bg-zinc-950/90 pl-3 pr-1.5 py-1.5 text-amber-200 text-xs font-bold flex items-center gap-2 shadow-lg backdrop-blur-md">
                <button type="button" onClick={() => setSpecBadgeOpen(false)} className="flex items-center gap-2" title="접기">
                  <Eye className="w-3.5 h-3.5 shrink-0" />
                  <span>관전 중</span>
                </button>
                {isAdmin && (
                  <Button variant="outline" size="sm" className="h-6 rounded-full border-amber-300/30 bg-amber-300/10 px-2 text-[10px] font-bold text-amber-100 hover:bg-amber-300/20 hover:text-white" onClick={() => void handleDownloadSnapshot()} title="[관리자] 진행 중 게임의 분석용 로그(JSON)를 지금 상태 그대로 내려받기">로그 저장</Button>
                )}
                <Button variant="outline" size="sm" className="h-6 rounded-full border-amber-300/30 bg-amber-300/10 px-2 text-[10px] font-bold text-amber-100 hover:bg-amber-300/20 hover:text-white" onClick={() => { if (gameId) localStorage.removeItem(`gaia-${gameId}-spectatorId`); setLocation('/'); }}>나가기</Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSpecBadgeOpen(true)}
                aria-label="관전 중"
                title="관전 중 — 클릭하면 나가기 표시"
                className="h-9 w-9 rounded-full border border-amber-300/40 bg-zinc-950/90 text-amber-200 shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur flex items-center justify-center hover:bg-zinc-900 transition-colors"
              >
                <Eye className="w-5 h-5" />
              </button>
            )}
          </div>
          {/* [사용자] 모바일: 접이식 관전 배지 — 접힘=눈동자만(전체화면 버튼 오른쪽). 탭하면 우측으로 펼쳐 관전중+나가기. 눈동자/글자 탭하면 다시 접힘. */}
          <div
            className="md:hidden fixed z-[120] flex items-center"
            style={{
              top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)',
              left: isFullscreen ? 'calc(env(safe-area-inset-left, 0px) + 0.75rem)' : 'calc(env(safe-area-inset-left, 0px) + 3.5rem)',
            }}
          >
            {specBadgeOpen ? (
              <div className="rounded-full border border-amber-300/40 bg-zinc-950/90 pl-2.5 pr-1.5 py-1 text-amber-200 text-xs font-bold flex items-center gap-1.5 shadow-lg backdrop-blur-md">
                <button type="button" onClick={() => setSpecBadgeOpen(false)} className="flex items-center gap-1.5" title="접기">
                  <Eye className="w-3.5 h-3.5 shrink-0" />
                  <span>관전 중</span>
                </button>
                {isAdmin && (
                  <Button variant="outline" size="sm" className="h-6 rounded-full border-amber-300/30 bg-amber-300/10 px-2 text-[10px] font-bold text-amber-100 hover:bg-amber-300/20 hover:text-white" onClick={() => void handleDownloadSnapshot()} title="[관리자] 로그 저장">로그 저장</Button>
                )}
                <Button variant="outline" size="sm" className="h-6 rounded-full border-amber-300/30 bg-amber-300/10 px-2 text-[10px] font-bold text-amber-100 hover:bg-amber-300/20 hover:text-white" onClick={() => { if (gameId) localStorage.removeItem(`gaia-${gameId}-spectatorId`); setLocation('/'); }}>나가기</Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSpecBadgeOpen(true)}
                aria-label="관전 중"
                title="관전 중 — 탭하면 나가기 표시"
                className="h-9 w-9 rounded-full border border-amber-300/40 bg-zinc-950/90 text-amber-200 shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur flex items-center justify-center active:scale-95 transition-transform"
              >
                <Eye className="w-5 h-5" />
              </button>
            )}
          </div>
        </>,
        document.body
      )}

      {/* [다른 기기 이어하기] 좌석도 관전 ID도 없는 기기에서 게임을 열면, 방 한정 이름/비번으로 내 좌석 복귀 */}
      {!playerId && !isSpectator && !loading && game && String(game.currentPhase) !== 'lobby' && typeof document !== 'undefined' && createPortal(
        <div className="fixed left-1/2 top-16 z-[130] w-[min(92vw,20rem)] -translate-x-1/2 rounded-xl border border-emerald-400/30 bg-zinc-950/95 p-3 shadow-2xl backdrop-blur-md">
          <div className="mb-1 text-xs font-black text-emerald-300">내 자리로 이어하기</div>
          <div className="mb-2 text-[10px] leading-snug text-zinc-500">참가할 때 쓴 이름과 (이 방 한정) 비밀번호를 입력하세요. 비밀번호를 안 걸었다면 원래 기기에서만 조작할 수 있습니다.</div>
          <input value={rejoinName} onChange={(e) => setRejoinName(e.target.value)} placeholder="이름"
            className="mb-1.5 w-full rounded border border-white/10 bg-zinc-900/70 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none" />
          <input type="password" value={rejoinPw} onChange={(e) => setRejoinPw(e.target.value)} placeholder="비밀번호"
            onKeyDown={(e) => { if (e.key === 'Enter') void handleAccountRejoin(); }}
            className="mb-2 w-full rounded border border-white/10 bg-zinc-900/70 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none" />
          {rejoinMsg && <div className="mb-2 text-[10px] text-red-400">{rejoinMsg}</div>}
          <div className="flex gap-2">
            <button type="button" onClick={() => void handleAccountRejoin()}
              className="flex-1 rounded border border-emerald-400/40 bg-emerald-500/20 px-2 py-1.5 text-xs font-bold text-emerald-200 hover:bg-emerald-500/30">이어하기</button>
            <button type="button" onClick={() => setLocation('/')}
              className="rounded border border-white/10 bg-zinc-800/60 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700/60">로비로</button>
          </div>
        </div>,
        document.body
      )}

      {/* 의회/수입/파워 대기 배너 — 사이드바 '밖'의 형제 오버레이.
          [사용자 2026-08-01] 배너를 툴바 flow에서 빼 미니뷰 토글 버튼이 밀렸다 되돌아오던 레이아웃 점프 제거.
          [사용자 2026-08-10] 예전엔 배너가 떠 있는 동안 사이드바 '전체'를 z-135로 올려 미니뷰(z-110)를 넘겼는데,
            좌하단 버튼들도 같은 컨테이너라 함께 딸려 올라가 미니뷰 위로 튀어나왔다 → 배너만 올린다. */}
      {(councilPendingInfo || incomeWaiters.length > 0 || (pendingTurnEndPlayerName && pendingPowerWaiters.length > 0)) && (
      <div className="absolute left-0 top-0 w-64 md:w-80 z-[135] hidden md:block p-2 pointer-events-none">
          <div className="rounded-xl bg-zinc-950/90 backdrop-blur-md p-1.5 space-y-2 shadow-2xl pointer-events-auto">
          {councilPendingInfo && (
            <div className="bg-cyan-500/20 border border-cyan-400/40 text-cyan-100 rounded-lg px-3 py-2 text-xs md:text-sm">
              <div className="flex items-start gap-2">
                <Clock className="w-4 h-4 shrink-0 text-cyan-300 mt-0.5 animate-pulse" />
                <p className="leading-snug">
                  <strong>{councilPendingInfo.name}</strong> — {councilPendingInfo.kind} {councilPendingInfo.what}
                  <span className="block text-[10px] text-cyan-200/75 font-medium mt-0.5">
                    선택이 끝나면 라운드 첫 액션이 가능합니다
                  </span>
                </p>
              </div>
            </div>
          )}
          {incomeWaiters.length > 0 && (
            <div className="bg-sky-500/20 border border-sky-400/40 text-sky-100 rounded-lg px-3 py-2 text-xs md:text-sm">
              <div className="flex items-start gap-2">
                <Clock className="w-4 h-4 shrink-0 text-sky-300 mt-0.5 animate-pulse" />
                <p className="leading-snug">
                  수입 단계 · 수익/파워 선택 대기 중
                  <span className="block text-[10px] text-sky-200/75 font-medium mt-0.5">
                    아래 플레이어가 모두 완료하면 라운드 액션이 시작됩니다
                  </span>
                </p>
              </div>
              <ul className="mt-2 space-y-1 border-l-2 border-sky-400/35 pl-2.5">
                {incomeWaiters.map((w) => (
                  <li key={w.id} className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${w.current ? 'bg-sky-300 animate-pulse' : 'bg-sky-500/50'}`} />
                    <span className="font-bold text-sky-50 truncate">{w.name}</span>
                    {w.current && <span className="text-[10px] text-sky-300/80 shrink-0">선택 중</span>}
                    {w.id === playerId && (
                      <Badge variant="outline" className="h-4 px-1 text-[9px] border-sky-400/50 text-sky-200 shrink-0">나</Badge>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
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
          </div>
      </div>
      )}

      {/* Sidebar Overlay (Left) — 모바일에선 숨김(미니뷰 토글·방장 전환 UI 제거), 대신 우하단 Info 버튼으로 3페이지 오버레이 사용 */}
      {/* z는 항상 50 — 배너 때문에 올리지 않는다(위 주석 참고). 미니뷰(z-110)가 좌하단 버튼을 계속 덮어야 정상. */}
      <div className="absolute left-0 top-0 bottom-0 w-64 md:w-80 transition-all duration-300 hidden md:flex flex-col z-[50] pointer-events-none *:pointer-events-auto">
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
                  // 단일 미니뷰 모드에서는 이 버튼 하나가 그 창을 켜고 끈다(보너스 창은 쓰지 않는다).
                  const newVal = singleMini ? !isResearchPinned : !(isResearchPinned && isBonusPinned);
                  setIsResearchPinned(newVal);
                  if (!singleMini) setIsBonusPinned(newVal);
                  if (gameId) {
                    localStorage.setItem(`is-research-pinned-${gameId}`, String(newVal));
                    if (!singleMini) localStorage.setItem(`is-bonus-pinned-${gameId}`, String(newVal));
                  }
                }}
                title={singleMini ? '미니뷰 켜기/끄기 (연구·우주선·Tactical 3탭)' : '모든 미니보드 켜기/끄기 (Toggle All Mini Boards)'}
              >
                <Layers className="w-4 h-4" />
              </Button>
              <Button
                variant={isResearchPinned ? 'default' : 'outline'}
                size="icon"
                className={`h-9 w-9 shrink-0 ${singleMini ? 'hidden' : ''} ${isResearchPinned ? 'bg-blue-600 hover:bg-blue-500' : ''}`}
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
                className={`h-9 w-9 shrink-0 ${singleMini ? 'hidden' : ''} ${isBonusPinned ? 'bg-amber-600 hover:bg-amber-500' : ''}`}
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

        {/* 왼쪽 하단 액션 버튼 토글 — '?' 설정으로 켤 때만(기본 숨김, 사용자 2026-08-14) */}
        {showLeftActionButtons && (
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

        )}

        {showLeftActionButtons && (
        <div data-tour="left-actions" className={`p-2 md:p-4 md:mt-0 space-y-2 pointer-events-none *:pointer-events-auto bg-black/80 md:bg-transparent backdrop-blur-sm md:backdrop-blur-none ${isLeftPanelOpen ? 'block' : 'hidden md:block'} w-full max-w-full rounded-tr-lg relative z-[100]`}>
          {(() => {
            // [사용자 2026-08-01] 수입/파워 수락 대기 중엔 서버가 프리액션을 거부(mainActionBlockedByPending)하므로 버튼도 숨김
            const freeActionBlocked = ((game?.pendingPowerOffers?.length ?? 0) > 0)
              || Boolean(game?.pendingTurnEndPlayerId)
              || Boolean(game?.pendingIncomeOrder)
              || Boolean((game as any)?.pendingRollback);
            const canUseFreeActions = isCurrentTurn && game?.currentPhase === 'main' && !freeActionBlocked;
            // [사용자] 못 쓸 땐 불투명(opacity-30) 대신 아예 숨김.
            if (!canUseFreeActions) return null;
            return (
              <Button
                variant={isFreeActionsOpen ? 'default' : 'outline'}
                className="w-full justify-start md:justify-between gap-2 font-black uppercase tracking-widest text-[10px] h-10 shadow-lg transition-all active:scale-95 border-purple-500/40 text-purple-300 hover:bg-purple-500/20"
                onClick={() => setIsFreeActionsOpen(!isFreeActionsOpen)}
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
        )}
        </div>
      </div>

      <main className="flex-1 flex flex-col overflow-hidden bg-zinc-900/20 relative">
        <div className="flex-1 min-h-0">
          <GameBoard
            specialStripQuick={showSpecialStrips ? { on: !stripQuickOff, toggle: () => setStripQuickOff(v => !v) } : undefined}
            game={game}
            playerId={playerId}
            colorOverrides={playerColorOverrides}
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
            onFederationComplete={() => handleFederationComplete(false)}
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
            onTakeTwilightArtifact={(artifactId) => handleTakeTwilightArtifact(artifactId)}
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
                // [버그수정 2026-08-05 사용자: "칸 클릭하고 비용 0 0까지 뜨는데 건설이 안 됨"]
                //   우주선 연방 보상(무한거리 무료광산)은 연방 형성=메인 액션 '후'에 배치하므로 hasDoneMainAction이
                //   항상 true다. 그런데 이 예외 목록에 pendingSpaceshipFedMine이 빠져 있어 클릭이 조용히 무시됐다
                //   (서버는 이 건설을 받아줄 준비가 돼 있었음 — 클라 게이트만 막던 문제).
                (!game.pendingSpaceshipFedMine || game.pendingSpaceshipFedMine.playerId !== playerId) &&
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

              // 란티다 기생광산: 이미 정착된 땅에 기생 → 소행성이어도 가이아포머 불필요(서버도 동일).
              const isLantidaParasitic = player.faction === 'lantids' &&
                tile.structure != null && tile.ownerId !== playerId && tile.ownerId != null && !tile.parasiticMine;

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
              // [버그수정 2026-08-09 사용자] 우주선 연방 보상 '무한거리 무료광산'(ship-fed-mine-free)도 거리 체크 면제 —
              //   서버엔 이 건설에 거리 체크가 아예 없는데(전용 분기) 클라 게이트가 'too far away'로 막고 있었다.
              //   같은 함수의 hasDoneMainAction 게이트엔 이미 예외가 있었으나 사거리 게이트에만 누락됐다.
              const isFedFreeMineBuild = game.pendingSpaceshipFedMine?.playerId === playerId;
              if (!isPendingGaiaBuild && !isFedFreeMineBuild && minDist > maxPossibleRange) {
                toast({
                  title: 'Cannot Build',
                  description: `Planet is too far away. Distance: ${minDist}, Max range with ${player.qic} QIC: ${maxPossibleRange}`,
                  variant: 'destructive',
                });
                return;
              }

              const potentialCost = getActionCost({ type: 'buildMine', tileId });
              if (!potentialCost) return;

              // 소행성은 가이아 포머 체크만 필요 — 단 기생광산은 포머 불필요(이미 정착된 땅에 기생)
              if (tile.type === 'asteroid' && !isLantidaParasitic) {
                if (availableGaiaformers(player) <= 0) {
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
                // [버그수정 2026-08-09] 무한거리 무료광산은 서버가 '낼 수 있으면 청구, 못 내면 면제'로 항상 건설을 받아준다(데드락 방지 규칙).
                //   클라가 '자원 부족'으로 막으면 그 규칙이 무력화되므로 예외 처리.
                if (!isFedFreeMineBuild && (player.ore < (potentialCost.ore ?? 0) || player.credits < (potentialCost.credits ?? 0) || player.qic < (potentialCost.qic ?? 0))) {
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
              // 모바일: 확인 토스트가 End Turn 버튼을 가려 진행을 느리게 함 → PC에서만 표시(사용자 요청)
              if (!isMobileViewport) toast({ title: 'Twilight 액션', description: '2: 2O+3P → TS→Lab', variant: 'default' });
            }}
            onRebellionMineToTS={(tileId) => {
              if (!gameId || !pendingRebellionMineToTS) return;
              GameClient.useShipAction(gameId, pendingRebellionMineToTS, 2, tileId);
              setPendingRebellionMineToTS(null);
              if (!isMobileViewport) toast({ title: 'Rebellion 액션', description: '2: 1O+3P → M→TS', variant: 'default' });
            }}
            isSidebarOpen={isSidebarOpen}
            sidebarWidth={isSidebarOpen ? effectiveSidebarWidth : 0}
            onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
            playerDetailScale={playerDetailScale}
            onTogglePlayerDetailScale={() => {
              setPlayerDetailScale((prev) => {
                const next: 1 | 1.5 | 2 = prev === 1 ? 1.5 : prev === 1.5 ? 2 : 1;
                localStorage.setItem('player-detail-scale', String(next));
                return next;
              });
            }}
            mobileControlsOpen={isMapControlsOpen}
            onToggleMobileControls={() => setIsMapControlsOpen((prev) => !prev)}
            onOpenAdmin={() => { setIsAdmin(true); setIsAdminModeOpen(true); }}
            isMobileViewport={isMobileViewport}
            mobilePanelWidth={effectiveSidebarWidth}
            mapBottomInset={splitActive && mobileZoomPanel !== 'status' && mobileZoomPanel !== 'info' ? Math.round(winH * 0.5) : 0}
          />
        </div>

        {/* Dashboards Area: 제거 (라운드 보드를 오버레이로 이동함). 관전자에게는 보너스 선택 패널 비표시 */}
        {/* 좌석 없는 뷰어(이어하기 실패로 열람만 하는 기기 등)에게도 비표시 — playerId가 이 게임의 좌석일 때만(사용자 관찰: 이어하기 실패인데 보너스 선택창) */}
        <AnimatePresence>
          {isBonusSelectionPhase && !isSpectator && !!playerId && !!game.players[playerId] && (
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              // 보너스 선택 중엔 선택이 우선이라 모바일에서도 패널을 풀폭으로(상태창을 피해 좌측 2열로 좁던 것 → 폭 전부 사용, 사용자 관찰)
              className="absolute bottom-0 left-0 right-0 border-t border-white/10 bg-zinc-950/95 backdrop-blur flex flex-col shrink-0 shadow-[0_-8px_32px_rgba(0,0,0,0.5)] z-[130]"
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
                <div className="px-3 sm:px-6 pb-6 pt-2 max-h-[45vh] overflow-y-auto border-t border-white/5 custom-scrollbar bg-black/20 w-full min-w-0">
                  {/* 이 패널은 하단 풀폭 바라 사이드바용 zoom-fill이 불필요(오히려 폭 초과로 짤림, 사용자 관찰).
                      BonusTiles 그리드(auto-fill minmax 5.25rem)가 폭을 그대로 꽉 채우고 넘치면 다음 줄로 감. */}
                  <div className="w-full">
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
                  {/* 모바일엔 키보드가 없어 단축키 안내가 무의미 — md+ 에서만 표시 (사용자 요청, R창과 동일) */}
                  <Badge className="hidden md:inline-flex bg-primary/20 text-primary border-primary/20">Hotkey: E</Badge>
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

        {/* [롤백 투표] 대상자에겐 동의 다이얼로그, 그 외엔 대기 배너 */}
        {game.pendingRollback && (() => {
          const pr = game.pendingRollback!;
          const iAmRequired = !!playerId && pr.required.includes(playerId);
          const iApproved = !!playerId && pr.approvals.includes(playerId);
          const need = pr.required.length, got = pr.approvals.length;
          // [사용자 2026-08-12] '2/3'만 보여선 누가 안 눌렀는지 알 수 없어 기다리기만 했다 → 사람별로 표기.
          //   pr.required = 동의가 필요한 사람(요청자 제외), pr.approvals = 이미 동의한 사람.
          const roster = pr.required.map((pid) => {
            const p = game.players?.[pid];
            return {
              pid,
              name: p?.name ?? pid,
              color: playerColorOverrides?.[pid] ?? FACTIONS.find((f) => f.id === p?.faction)?.color ?? '#a1a1aa',
              ok: pr.approvals.includes(pid),
            };
          });
          const RosterList = () => (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {roster.map((r) => (
                <span key={r.pid} className={`flex items-center gap-1.5 text-[11px] ${r.ok ? 'text-emerald-300' : 'text-zinc-500'}`}>
                  <span className="w-2 h-2 rounded-full shrink-0 border border-black/40" style={{ background: r.color, opacity: r.ok ? 1 : 0.45 }} />
                  <span className={r.ok ? 'font-bold' : ''}>{r.name}</span>
                  <span aria-hidden="true">{r.ok ? '✓' : '…'}</span>
                  <span className="sr-only">{r.ok ? '동의함' : '대기 중'}</span>
                </span>
              ))}
            </div>
          );
          if (iAmRequired && !iApproved) {
            // [버그 2026-08-17 사용자 제보 "폰에서 롤백창 버튼이 반응 없다"] 내용 높이가 화면보다 커지면
            //   items-center 때문에 위아래로 동시에 넘쳐 '버튼이 화면 밖'으로 나가고, 오버레이에 스크롤이 없어
            //   손이 닿지 않았다. 되돌릴 행동이 많거나(최근 8개까지 표기) 가로 모드일 때만 터져서 간헐적으로 보였다.
            //   → 창 높이를 가시영역으로 제한하고, 본문만 스크롤시키고 버튼 줄은 항상 아래에 고정한다.
            return (
              <div className="fixed inset-0 z-[300] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
                <div className="w-full max-w-md max-h-[calc(100dvh-2rem)] flex flex-col rounded-2xl border border-amber-500/40 bg-zinc-950 shadow-2xl">
                  <div className="min-h-0 flex-1 overflow-y-auto p-5 pb-3 space-y-3">
                  <div className="text-amber-300 font-black text-lg">↩ 롤백 요청</div>
                  <p className="text-sm text-zinc-200 leading-relaxed">
                    <span className="font-bold text-white">{pr.requesterName}</span>님이 <span className="font-bold text-amber-200">{pr.label}</span>(으)로 되돌리자고 요청했습니다.
                    <br />약 <span className="font-black text-amber-300">{pr.turnsBack}턴 전</span> · 행동 <span className="font-black text-red-300">{pr.undoneCount}개</span> 되돌림. 전원 동의 필요.
                  </p>
                  {pr.undoneActions?.length > 0 && (
                    <div className="rounded-lg border border-white/10 bg-black/30 p-2 max-h-40 overflow-y-auto text-[11px] leading-relaxed">
                      <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold mb-1">되돌릴 내용{pr.undoneCount > pr.undoneActions.length ? ` (최근 ${pr.undoneActions.length}개)` : ''}</div>
                      {pr.undoneActions.map((a, i) => (<div key={i} className="text-zinc-300">• {a}</div>))}
                    </div>
                  )}
                  <div className="rounded-lg border border-white/10 bg-black/30 p-2 space-y-1">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">현재 동의 {got}/{need}</div>
                    <RosterList />
                  </div>
                  </div>
                  {/* 버튼 줄은 스크롤 영역 밖 — 내용이 아무리 길어도 항상 화면 안에 남는다 */}
                  <div className="flex gap-2 shrink-0 border-t border-white/10 p-5 pt-3">
                    {/* [사용자 2026-08-17] 실패가 조용히 묻히면 '버튼이 안 눌린다'로 보인다 → 사유를 토스트로 노출.
                        playerId도 같이 보내 소켓 좌석 매핑이 비어 있어도 처리되게 한다. */}
                    <Button variant="outline" className="flex-1 border-red-500/40 text-red-300 hover:bg-red-950/40" onClick={() => gameId && GameClient.respondRollback(gameId, false, playerId).catch((e) => toast({ title: '롤백 거절 실패', description: e?.message || '', variant: 'destructive' }))}>거절</Button>
                    <Button className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold" onClick={() => gameId && GameClient.respondRollback(gameId, true, playerId).catch((e) => toast({ title: '롤백 동의 실패', description: e?.message || '', variant: 'destructive' }))}>동의</Button>
                  </div>
                </div>
              </div>
            );
          }
          return (
            <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[300] max-w-[92vw] rounded-2xl border border-amber-500/40 bg-zinc-900/95 px-4 py-2 text-xs text-amber-200 shadow-lg backdrop-blur">
              <div>↩ 롤백 대기 중: <span className="font-bold">{pr.label}</span> (약 {pr.turnsBack}턴 전, 행동 {pr.undoneCount}개) · 동의 {got}/{need}</div>
              {/* 누구를 기다리는지 보이게 — 내가 이미 동의했거나 대상이 아니어도 진행 상황은 알아야 한다 */}
              <div className="mt-1"><RosterList /></div>
            </div>
          );
        })()}

        {/* Research Board Overlay */}
        {isResearchOpen && (
          <div className="fixed inset-0 z-[200] bg-black/90 backdrop-blur-xl flex flex-col items-center justify-center p-6 animate-in fade-in zoom-in duration-300">
            <div className="w-full max-w-7xl h-full flex flex-col gap-4">
              <div className="flex justify-between items-center bg-zinc-900/50 p-4 rounded-2xl border border-white/5 shadow-2xl">
                <div className="flex items-center gap-4">
                  <h2 className="text-xl font-black uppercase tracking-widest text-white">Research & Technology</h2>
                  {/* 모바일엔 키보드가 없어 단축키 안내가 무의미 — md+ 에서만 표시 (사용자 요청) */}
                  <Badge className="hidden md:inline-flex bg-primary/20 text-primary border-primary/20">Hotkey: R</Badge>
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
                {(() => {
                  const boardProps: Omit<ComponentProps<typeof ResearchBoard>, 'isMini' | 'section'> = {
                    game,
                    playerId,
                    onUsePowerAction: (actionId) => handleUsePowerAction(actionId, { closeResearchOverlay: true }),
                    onUseHadschHallasPIAction: (actionId) => {
                      if (game.hasDoneMainAction) return;
                      GameClient.useHadschHallasPIAction(gameId!, actionId);
                    },
                    // 프리액션: 메인 액션 후에도 사용 가능
                    onUseBalTakGaiaformerToQic: () => { GameClient.useBalTakGaiaformerToQic(gameId!); },
                    onGainTechTile: (tileId) => GameClient.gainTechTile(gameId!, tileId),
                    onUseTechAction: (tileId) => {
                      if (!isMyTurn || game.currentPhase !== 'main') {
                        toast({ title: '사용 불가', description: '내 턴 메인 단계에서만 사용할 수 있습니다.', variant: 'destructive' });
                        return;
                      }
                      if (game.hasDoneMainAction) {
                        toast({ title: '사용 불가', description: '이미 메인 액션을 사용했습니다.', variant: 'destructive' });
                        return;
                      }
                      GameClient.useTechAction(gameId!, tileId);
                    },
                    onAdvanceTech: (trackId) => handleResearchAdvanceTech(trackId, { closeResearchOverlay: true }),
                    // 오버레이 R창에서 선택한 경우: 자동 닫기/열기 동작하도록 플래그 OFF
                    onSelectTechTile: (techTileId, trackId) => { selectTechTileWithLevel5Confirm(techTileId, trackId, { fromMini: false }); },
                    onSelectAdvancedTechTile: (advancedTileId, trackId) => { if (gameId) GameClient.selectAdvancedTechTile(gameId, advancedTileId, trackId); },
                    onConfirmAdvancedTechCover: (coverTileId) => { if (gameId) GameClient.confirmAdvancedTechCover(gameId, coverTileId); },
                    onTakeTwilightArtifact: (artifactId) => handleTakeTwilightArtifact(artifactId),
                    onUseAcademyQic: () => {
                      if (game.hasDoneMainAction) return;
                      if (gameId) GameClient.useSpecialAction(gameId, 'academy-qic');
                    },
                    onEndTurn: () => { if (gameId) GameClient.endTurn(gameId); setIsResearchOpen(false); },
                    onResetTurn: () => { if (gameId) GameClient.resetTurn(gameId); },
                    onUseShipAction: (shipTileId, actionIndex, targetTileId) => handleUseShipAction(shipTileId, actionIndex, targetTileId, { fromOverlay: true }),
                  };
                  // [모바일, 사용자 관찰] 풀 보드는 6열 고정이라 좁은 화면에서 트랙 잘림·타일 크기 불일치·
                  // 인공물 넘침이 계속됨("미니뷰에서는 잘 보임") → 오버레이도 모바일에선 미니뷰를 화면폭에
                  // 맞춰 스케일해 렌더(고정 미니 패널의 MiniScaledContent와 동일 방식).
                  return isMobileViewport ? (
                    <MiniScaledContent panelWidth={Math.min(window.innerWidth - 56, 520)}>
                      {/* showPendingSelections: 미니 렌더지만 오버레이 목적상 '타일/트랙을 선택하세요' 안내 블록 필요(사용자 관찰) */}
                      <ResearchBoard {...boardProps} isMini={true} section="all" showPendingSelections={true} />
                    </MiniScaledContent>
                  ) : (
                    <ResearchBoard {...boardProps} />
                  );
                })()}
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
            // [2026-07-27 사용자] 이 경로가 경고 다이얼로그(미사용 4P타일 등)를 우회하고 바로 패스하던 문제 —
            // 다른 패스 경로처럼 확인 다이얼로그를 거치게 통일 (확인 버튼이 passRound 호출)
            setConfirmPassWithTileId(tileId);
          }}
        />

        {/* Pass Confirmation Dialog (When selecting bonus tile from overlay) */}
        {(() => {
          const currentPlayer = playerId ? game.players[playerId] : null;
          const currentBonusTile = currentPlayer?.bonusTile ? ALL_BONUS_TILES.find(t => t.id === currentPlayer.bonusTile) : null;
          const selectedBonusTile = confirmPassWithTileId && confirmPassWithTileId !== 'dummy' ? ALL_BONUS_TILES.find(t => t.id === confirmPassWithTileId) : null;

          // [2026-08-06] 패스 점수 미리보기는 서버 정산과 같은 shared 함수로 계산한다.
          //   예전엔 여기서 따로 세느라(가이아포머 이중계산·브릿지 섹터 기생광산 누락·행성유형 규칙 차이 등)
          //   미리보기와 로그가 반복적으로 어긋났다. 계산 규칙을 바꿔야 하면 shared/gameConfig.ts만 고칠 것.
          const passPreview = playerId && currentPlayer ? computePassScorePreview(game, playerId) : null;
          const passBonusVp = passPreview?.bonusVp ?? 0;
          const advPassItems: { tile: (typeof ALL_ADVANCED_TECH_TILES)[number]; vp: number }[] =
            (passPreview?.advTiles ?? [])
              .map(item => {
                const tile = ALL_ADVANCED_TECH_TILES.find(t => t.id === item.tileId);
                return tile ? { tile, vp: item.vp } : null;
              })
              .filter((x): x is { tile: (typeof ALL_ADVANCED_TECH_TILES)[number]; vp: number } => x != null);

          // 패스 전 경고: 이번 라운드에 아직 안 쓴 1회용 특수 액션(4pw 기술타일·아카데미 QIC·의회 액션·종족 스페셜 등) 검출.
          // 라운드 전환 시 서버에서 usedTechActions/usedSpecialActions/usedBonusAction/PI액션이 리셋되므로, 패스하면 이번 라운드분은 영구히 날아간다.
          // [2026-08-07] 목록 열거는 getSpecialActionsForPlayer 하나로 통일 — 패널 칩과 같은 기준.
          const unusedAbilities: string[] = (playerId && currentPlayer)
            ? getSpecialActionsForPlayer(game, playerId).filter(a => !a.used).map(a => a.label)
            : [];

          return (
            <AlertDialog open={!!confirmPassWithTileId} onOpenChange={(open) => !open && setConfirmPassWithTileId(null)}>
              <AlertDialogContent className="bg-zinc-950 border-white/10 text-zinc-100 max-w-lg max-h-[90vh] overflow-y-auto">
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

                {/* [사용자 2026-08-05] 경고를 버튼 '바로 위'로 옮기고 버튼과 함께 sticky 고정 — 예전엔 다이얼로그 상단이라
                    내용이 길어 스크롤되면 경고가 밀려 보이지 않은 채 패스할 수 있었다.
                    경고가 1개라도 있으면 Ok 버튼 색도 경고색(앰버)으로 바꿔 한 번 더 알린다. */}
                <div className="sticky bottom-0 -mx-6 -mb-6 px-6 pb-6 pt-3 bg-zinc-950/95 backdrop-blur border-t border-white/10 space-y-3">
                  {unusedAbilities.length > 0 && (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 animate-warn-blink motion-reduce:animate-none">
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
                  <AlertDialogFooter>
                  <AlertDialogCancel className="bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    className={unusedAbilities.length > 0
                      ? "bg-amber-500 hover:bg-amber-500/90 text-black font-bold"
                      : "bg-primary hover:bg-primary/90 text-black font-bold"}
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
                </div>
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
                    className="h-auto py-1 px-1.5 bg-zinc-800 border-amber-500/40 text-amber-200 hover:bg-amber-500/20 flex flex-col items-center gap-0.5"
                    onClick={() => gameId && GameClient.tinkeroidChooseSpecial(gameId, actionId)}
                    title={labelOf(actionId)}
                  >
                    {TINKEROID_SPECIAL_IMAGES[actionId] && (
                      <img src={TINKEROID_SPECIAL_IMAGES[actionId]} alt={labelOf(actionId)} className="w-12 h-12 object-contain rounded" />
                    )}
                    <span className="text-[10px] leading-none">{labelOf(actionId)}</span>
                  </Button>
                ))}
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-amber-400 hover:text-white shrink-0" onClick={() => setTinkeroidSpecialCollapsed(false)}>펼치기</Button>
              </div>
            );
          }

          return (
            <AlertDialog open={true} onOpenChange={() => { }}>
              <AlertDialogContent className="bg-zinc-900 border-amber-500/40 max-w-md">
                <AlertDialogHeader>
                  <div className="flex items-center justify-between gap-2">
                    <AlertDialogTitle className="text-amber-300 font-black whitespace-nowrap text-base shrink-0">팅커로이드: 라운드 Special 선택</AlertDialogTitle>
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
                      className="w-full justify-start bg-zinc-800 border-amber-500/40 text-amber-200 hover:bg-amber-500/20 h-auto py-2 gap-3"
                      onClick={() => gameId && GameClient.tinkeroidChooseSpecial(gameId, actionId)}
                    >
                      {TINKEROID_SPECIAL_IMAGES[actionId] && (
                        <img src={TINKEROID_SPECIAL_IMAGES[actionId]} alt={labelOf(actionId)} className="w-12 h-12 object-contain rounded shrink-0" />
                      )}
                      <span>{labelOf(actionId)}</span>
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
                // [버그수정 2026-08-09 사용자] 한 턴에 파워를 두 번 받는 경우(예: 연구소 → 2TF+무료광산) 두 번째 오퍼의
                //   amount/vpCost는 '생성 시점' 값이라 첫 충전이 반영되지 않은 숫자가 창에 떴다. 서버는 수락 시점에
                //   현재 충전여력·점수로 재계산해 실제로는 더 적게/무료로 받는다 → 표시도 같은 식으로 맞춘다.
                const capNowUi = getMaxPowerGain(currentPlayer as PlayerState);
                const shownAmount = Math.min(offer.amount, capNowUi, (currentPlayer?.score ?? 0) + 1);
                const shownVpCost = Math.max(0, shownAmount - 1);
                const vpTooLow = shownVpCost > (currentPlayer?.score || 0);

                return (
                  <motion.div
                    key={offer.id}
                    initial={{ y: -50, x: '-50%', opacity: 0 }}
                    animate={{ y: 0, x: '-50%', opacity: 1 }}
                    exit={{ y: -50, x: '-50%', opacity: 0 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                    /* [사용자 2026-08-19] z-[65]였을 때 폰 전체화면 패널(z-110·113)이나 보드 오버레이(z-190·200) 뒤에
                       가려 제안이 온 줄 모르고 다른 사람들이 대기하던 문제. 이 창은 남의 턴까지 멈추는 차단 UI라
                       항상 맨 위여야 한다 → 둘러보기(z-400) 아래, 나머지 전부 위인 z-[210]. */
                    className="fixed top-24 left-1/2 z-[210] flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 p-2 px-3 md:px-4 bg-zinc-900/95 backdrop-blur-xl border border-blue-500/50 rounded-2xl md:rounded-full shadow-[0_0_30px_rgba(59,130,246,0.2)] max-w-[95vw]"
                    style={isMobileViewport ? ({ zoom: 0.82 } as CSSProperties) : undefined}
                  >
                    <div className="flex items-center gap-3 md:border-r md:border-white/10 md:pr-4">
                      <div className="flex flex-col shrink-0 mr-2">
                        <h3 className="text-blue-400 font-black uppercase tracking-tighter text-[9px] leading-none">
                          Power Offer
                        </h3>
                        <span className="text-[10px] text-zinc-400 font-bold">from {sourcePlayer?.name}</span>
                      </div>

                      <div className="flex items-center gap-4 shrink-0">
                        <div className="flex flex-col items-center">
                          <span className="text-lg font-black text-blue-400 leading-none">+{shownAmount}</span>
                          <span className="text-[8px] uppercase text-zinc-500 font-bold tracking-tighter">Power</span>
                        </div>
                        {/* 타클론 의회: 수락 시 토큰 +1(그릇1) — 풀파워(+0 Power)여도 수락 가치가 있음을 표시 */}
                        {currentPlayer?.faction === 'taklons' && game.map.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute') && (
                          <div className="flex flex-col items-center">
                            <span className="text-lg font-black text-amber-400 leading-none">+1</span>
                            <span className="text-[8px] uppercase text-zinc-500 font-bold tracking-tighter">Token (PI)</span>
                          </div>
                        )}
                        <div className="flex flex-col items-center">
                          <span className={`text-lg font-black leading-none ${vpTooLow ? 'text-red-500' : 'text-zinc-300'}`}>{shownVpCost}</span>
                          <span className="text-[8px] uppercase text-zinc-500 font-bold tracking-tighter">VP Cost</span>
                        </div>
                      </div>
                    </div>

                    {currentPlayer?.faction === 'taklons' && (() => {
                      // [2026-08-07 사용자] 풀파워(충전 여력 0)면 '파워 먼저'는 받을 게 없어 의미가 없다
                      //   (충전이 0이면 의회 토큰도 안 생긴다) -> 그때는 '토큰 먼저'로 잠그고 그것만 묻는다.
                      const hasTakPI = !!game?.map?.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute');
                      const atFullPower = getMaxPowerGain(currentPlayer as PlayerState) === 0;
                      const lockPiFirst = hasTakPI && atFullPower;
                      return (
                      <div className="flex items-center gap-2 md:border-r md:border-white/10 md:pr-4">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={lockPiFirst}
                          className={`h-7 px-2 text-[9px] font-bold uppercase transition-colors ${lockPiFirst ? 'opacity-40 cursor-not-allowed text-zinc-600' : powerOfferBrainFirst ? 'text-amber-400 bg-amber-400/10' : 'text-zinc-500'}`}
                          onClick={() => { if (lockPiFirst) return; setPowerOfferBrainFirst(prev => !prev); }}
                          title="브레인 스톤 우선 수령 토글 (충전 시 브레인을 먼저 올릴지)"
                        >
                          Brain First
                        </Button>
                        {game?.map && game.map.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className={`h-7 px-2 text-[9px] font-bold uppercase transition-colors ${(lockPiFirst || powerOfferPiAddFirst) ? 'text-amber-400 bg-amber-400/10' : 'text-zinc-500'}${lockPiFirst ? ' cursor-default' : ''}`}
                            onClick={() => { if (lockPiFirst) return; setPowerOfferPiAddFirst(prev => !prev); }}
                            title={lockPiFirst
                              ? "풀파워라 '파워 먼저'로는 받을 게 없습니다 — 토큰을 먼저 추가해야 그 토큰을 올릴 수 있어 이 순서로 고정됩니다"
                              : "의회 토큰을 충전 '전에' 추가 (켜면 그 토큰도 이번 충전으로 올라간다)"}
                          >
                            PI 1st
                          </Button>
                        )}
                      </div>
                      );
                    })()}

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
                          if (gameId) GameClient.respondPowerOffer(gameId, offer.id, true, currentPlayer?.faction === 'taklons' ? powerOfferBrainFirst : undefined, currentPlayer?.faction === 'taklons' ? (powerOfferPiAddFirst || (getMaxPowerGain(currentPlayer as PlayerState) === 0 && !!game?.map?.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute'))) : undefined);
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
                    handleFederationComplete(true);
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
          const { burns, brainBurnFirst } = confirmBurnAction;
          const label = confirmBurnAction.kind === 'power'
            ? (game.powerActions?.find(a => a.id === confirmBurnAction.actionId)?.label ?? confirmBurnAction.actionId)
            : confirmBurnAction.label;
          // 타클론 브레인 번(첫 회)은 2그릇 일반토큰을 1개만 쓴다 — 나머지 번은 2개씩
          const bowl2Used = brainBurnFirst ? 1 + (burns - 1) * 2 : burns * 2;
          return (
            <AlertDialog open={true} onOpenChange={(open) => !open && setConfirmBurnAction(null)}>
              <AlertDialogContent className="bg-zinc-950 border-white/10 text-zinc-100 max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white font-black uppercase tracking-wider">
                    파워를 태우고 액션할까요?
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-300">
                    3그릇 파워가 부족합니다. 2그릇 태우기 <strong className="text-purple-300">{burns}회</strong>
                    (2그릇 토큰 <strong className="text-purple-300">{bowl2Used}개</strong> 사용)로
                    바로 <strong className="text-white">{label}</strong> 액션을 실행할 수 있습니다.
                    {brainBurnFirst && (
                      <span className="block mt-1 text-amber-300">
                        첫 태우기로 2그릇의 브레인 스톤이 3그릇으로 이동합니다(일반 토큰 1개만 소모).
                      </span>
                    )}
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

        {/* 토큰 비용(연방 위성 / 인공물) 부족 → 광물을 토큰으로 바꿔서 바로 진행할지 확인 */}
        {confirmOreToToken && gameId && (() => {
          const { converts, need } = confirmOreToToken;
          const what = confirmOreToToken.kind === 'federation'
            ? `연방 (위성 ${need}개)`
            : `인공물 ${confirmOreToToken.label} (토큰 ${need}개)`;
          const toBowl3 = currentPlayer?.faction === 'xenos'; // 제노스는 1O→토큰이 3그릇으로 (서버 규칙)
          return (
            <AlertDialog open={true} onOpenChange={(open) => !open && setConfirmOreToToken(null)}>
              <AlertDialogContent className="bg-zinc-950 border-white/10 text-zinc-100 max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white font-black uppercase tracking-wider">
                    광물을 토큰으로 바꿀까요?
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-300">
                    <strong className="text-white">{what}</strong>에 파워 토큰이 부족합니다.
                    광물 <strong className="text-orange-300">{converts}개</strong>를 토큰으로 바꾸면
                    (1O → 1 토큰{toBowl3 ? ', 제노스는 3그릇' : ', 1그릇'}) 바로 진행할 수 있습니다.
                    {(() => {
                      // 변환 후 총 토큰 = 필요 수 → 3그릇 일반 토큰은 전부 소멸 확정. 그 전에 크레딧으로 긁는다.
                      const cash = (currentPlayer?.power3 ?? 0) + (toBowl3 ? converts : 0);
                      // 변환 후 상태 기준으로 브레인까지 긁는지 판단(3크레딧 추가)
                      const afterP = currentPlayer ? { ...currentPlayer, [toBowl3 ? 'power3' : 'power1']:
                        ((toBowl3 ? currentPlayer.power3 : currentPlayer.power1) ?? 0) + converts } as typeof currentPlayer : null;
                      const brainC = (afterP && isBrainCashableBeforeTokenCost(afterP, need)) ? 3 : 0;
                      return (cash > 0 || brainC > 0) ? (
                        <span className="block mt-1 text-emerald-300">
                          어차피 사라질 3그릇 토큰{cash > 0 ? ` ${cash}개` : ''}{brainC > 0 ? '과 브레인 스톤' : ''}은 소멸 직전에
                          1P → C로 바꿔 <strong>크레딧 {cash * creditsPerBowl3Token + brainC}개</strong>를 먼저 챙깁니다
                          (전부 1그릇으로 내려가 그대로 비용에 쓰입니다).
                        </span>
                      ) : null;
                    })()}
                    <span className="block mt-1 text-amber-300">
                      이 토큰은 위성·인공물로 나가면 게임에서 완전히 제거됩니다(그릇으로 안 돌아옴).
                    </span>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-orange-600 hover:bg-orange-500 text-white font-bold"
                    onClick={() => {
                      for (let i = 0; i < converts; i++) GameClient.convertResource(gameId, '1ore-to-1token');
                      if (confirmOreToToken.kind === 'federation') GameClient.federationComplete(gameId, confirmOreToToken.force ?? false);
                      else GameClient.takeTwilightArtifact(gameId, confirmOreToToken.artifactId);
                      setConfirmOreToToken(null);
                    }}
                  >
                    OK (변환하고 진행)
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          );
        })()}

        {/* [발타크] QIC 부족 → 포머를 QIC로 바꿔서 바로 실행할지 확인 */}
        {confirmQicConvert && gameId && (() => {
          const { converts } = confirmQicConvert;
          const label = confirmQicConvert.kind === 'power'
            ? (game.powerActions?.find(a => a.id === confirmQicConvert.actionId)?.label ?? confirmQicConvert.actionId)
            : confirmQicConvert.label;
          const spare = balTakSpareGaiaformers(currentPlayer);
          return (
            <AlertDialog open={true} onOpenChange={(open) => !open && setConfirmQicConvert(null)}>
              <AlertDialogContent className="bg-zinc-950 border-white/10 text-zinc-100 max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white font-black uppercase tracking-wider">
                    가이아포머를 QIC로 바꿀까요?
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-300">
                    QIC가 부족합니다. 가이아포머 <strong className="text-cyan-300">{converts}개</strong>를 QIC로 바꾸면
                    바로 <strong className="text-white">{label}</strong> 액션을 실행할 수 있습니다.
                    <span className="block mt-1 text-amber-300">
                      쓴 포머는 이번 라운드 동안 잠깁니다(가이아 프로젝트·소행성 광산에 못 씀). 변환 후 남는 포머 {spare - converts}개.
                    </span>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-cyan-600 hover:bg-cyan-500 text-white font-bold"
                    onClick={() => {
                      for (let i = 0; i < converts; i++) GameClient.useBalTakGaiaformerToQic(gameId);
                      if (confirmQicConvert.kind === 'power') {
                        if (confirmQicConvert.closeResearchOverlay) setIsResearchOpen(false);
                        GameClient.usePowerAction(gameId, confirmQicConvert.actionId);
                      } else {
                        proceedShipAction(confirmQicConvert.shipTileId, confirmQicConvert.actionIndex, confirmQicConvert.targetTileId, { fromOverlay: confirmQicConvert.fromOverlay });
                      }
                      setConfirmQicConvert(null);
                    }}
                  >
                    OK (변환하고 실행)
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
                        <div className="flex flex-col items-center gap-1">
                          {imgUrl ? (
                            <img src={imgUrl} alt={reward.label} className="h-[46px] w-auto object-contain" />
                          ) : null}
                          {/* 이미지 오인 클릭 방지: 항상 라벨 병기 (사용자 관찰: 고른 것과 다른 보상이 들어왔다는 혼동) */}
                          <span className="font-bold text-[10px]">{reward.label}</span>
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
                        <div className="flex flex-col items-center gap-1">
                          {imgUrl ? (
                            <img src={imgUrl} alt={reward.label} className="h-[46px] w-auto object-contain" />
                          ) : null}
                          {/* 이미지 오인 클릭 방지: 항상 라벨 병기 + 우주선 표시 */}
                          <span className="font-bold text-[10px] text-cyan-300">🚀 {reward.label}</span>
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

        {/* 아이타 4토큰 교환: 타일 확정 전 확인창 (수익 단계라 되돌리기 없음 → 오클릭 방지) */}
        {itarsTileConfirm && gameId && (() => {
          const t = ALL_TECH_TILES.find(x => x.id === itarsTileConfirm.techTileId)
            || SHIP_TECH_TILES.find(x => x.id === itarsTileConfirm.techTileId);
          const label = t?.label || itarsTileConfirm.techTileId;
          const desc = (t as { description?: string } | undefined)?.description;
          return (
            <AlertDialog open={true} onOpenChange={() => { }}>
              <AlertDialogContent className="bg-zinc-900 border-zinc-700 max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-white font-black uppercase tracking-wider">기술 타일 확정</AlertDialogTitle>
                  <AlertDialogDescription className="text-zinc-300">
                    <span className="font-bold text-amber-300">{label}</span> 타일을 가져올까요? (4토큰 소모)
                    {desc ? <span className="block mt-1 text-[11px] text-zinc-400">{desc}</span> : null}
                    <span className="block mt-2 text-[11px] text-zinc-500">수익 단계라 확정 후에는 되돌릴 수 없습니다.</span>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <Button
                    variant="outline"
                    className="border-zinc-600 text-zinc-300 hover:bg-zinc-800"
                    onClick={() => setItarsTileConfirm(null)}
                  >
                    취소
                  </Button>
                  <Button
                    className="bg-amber-600 hover:bg-amber-500 text-white font-bold"
                    onClick={() => {
                      const pick = itarsTileConfirm;
                      setItarsTileConfirm(null);
                      selectTechTileWithLevel5Confirm(pick.techTileId, pick.trackId, { fromMini: pick.fromMini, confirmed: true });
                    }}
                  >
                    확정
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
                    <span className="text-zinc-400 text-sm">1 <span className="font-bold text-green-400">QIC</span> (4)</span>
                    <div className="flex items-center gap-1">
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, qic: Math.max(0, c.qic - 1) }))}>−</Button>
                      <span className="w-6 text-center text-white font-mono">{terranCouncilChoice.qic}</span>
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, qic: c.qic + 1 }))}>+</Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zinc-400 text-sm">1 <span className="font-bold text-blue-400">K</span> (4)</span>
                    <div className="flex items-center gap-1">
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, knowledge: Math.max(0, c.knowledge - 1) }))}>−</Button>
                      <span className="w-6 text-center text-white font-mono">{terranCouncilChoice.knowledge}</span>
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, knowledge: c.knowledge + 1 }))}>+</Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zinc-400 text-sm">1 <span className="font-bold text-zinc-100">O</span> (3)</span>
                    <div className="flex items-center gap-1">
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, ore: Math.max(0, c.ore - 1) }))}>−</Button>
                      <span className="w-6 text-center text-white font-mono">{terranCouncilChoice.ore}</span>
                      <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setTerranCouncilChoice(c => ({ ...c, ore: c.ore + 1 }))}>+</Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zinc-400 text-sm">1 <span className="font-bold text-yellow-400">C</span> (1)</span>
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
            {/* [사용자 2026-08-02] 삽/거리 보너스 배너처럼 '되돌리기'도 제공 — 액션포기(스킵)는 메인 액션+2P/보너스
                액션을 소모하지만, 취소는 턴 시작으로 복원해 지불한 비용·액션 사용까지 되돌린다 */}
            <Button variant="outline" size="sm" className="bg-zinc-800 border-zinc-600 text-zinc-300 hover:bg-zinc-700 whitespace-nowrap shrink-0" onClick={() => { GameClient.resetTurn(gameId); setPendingAction(null); }}>
              취소 (Undo)
            </Button>
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
          <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-zinc-900/95 border border-orange-500/50 text-orange-400 text-sm font-medium shadow-lg flex items-center gap-2">
            Ship Tech (2TF+Mine): 맵에서 <span className="font-bold text-orange-300">행성을 클릭</span>하여 광산 건설
            {/* [탈출구 2026-08-05] 지을 곳이 없을 때 포기 — 아이타 교환 중이면 액션 단계가 이걸 기다리므로 탈출구 필수 */}
            <Button variant="ghost" size="sm" className="text-orange-300 hover:text-white shrink-0" onClick={() => gameId && GameClient.skipShipTechMine(gameId)}>배치 포기</Button>
          </div>
        )}
        {/* 우주선 연방 보상(무한거리 무료광산): 안내가 전혀 없어 '클릭해도 무반응'으로 보이던 문제(사용자 관찰) + 지을 곳 없을 때(광산 8개 한도 등) 포기 탈출구 */}
        {game.pendingSpaceshipFedMine && game.pendingSpaceshipFedMine.playerId === playerId && (
          <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-zinc-900/95 border border-sky-500/50 text-sky-300 text-sm font-medium shadow-lg flex items-center gap-2">
            {/* [정리 2026-08-05 사용자: 텍스트 과다] 긴 설명(무한거리·소행성 제외·비용 청구 규칙)은 배치 때마다 읽을 필요가 없어
                한 줄로 축약하고, 상세 규칙은 hover(title)로 옮김 */}
            <span title="무한거리 · 소행성 제외 · 테라포밍/가이아 비용만 청구(못 내면 면제)">
              연방 보상: <span className="font-bold text-sky-200">빈 행성 클릭</span>해 무료 광산 배치
            </span>
            <Button variant="ghost" size="sm" className="text-sky-400 hover:text-white shrink-0" onClick={() => gameId && GameClient.skipSpaceshipFedMine(gameId)}>배치 포기</Button>
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
              <div className="fixed top-14 bottom-auto md:top-auto md:bottom-20 left-1/2 -translate-x-1/2 z-[125] px-4 py-3 rounded-lg bg-orange-950/90 border border-orange-500/50 text-orange-200 text-sm font-bold shadow-2xl flex items-center gap-4 animate-in slide-in-from-bottom-5">
                <span>테라포밍 액션 사용 중 ({currentPlayer.pendingTerraformSteps}단계 남음)</span>
                <Button variant="outline" size="sm" className="bg-zinc-800 border-zinc-600 text-zinc-300 hover:bg-zinc-700 whitespace-nowrap shrink-0 h-7" onClick={() => { GameClient.resetTurn(gameId!); setPendingAction(null); }}>취소 (Undo)</Button>
              </div>
            )}
            {(currentPlayer.rangeBonusActive || currentPlayer.tempRangeBonus) && (
              <div className="fixed top-14 bottom-auto md:top-auto md:bottom-20 left-1/2 -translate-x-1/2 z-[125] px-4 py-3 rounded-lg bg-purple-950/90 border border-purple-500/50 text-purple-200 text-sm font-bold shadow-2xl flex items-center gap-4 animate-in slide-in-from-bottom-5">
                <span>+3 거리 보너스 적용 중</span>
                <Button variant="outline" size="sm" className="bg-zinc-800 border-zinc-600 text-zinc-300 hover:bg-zinc-700 whitespace-nowrap shrink-0 h-7" onClick={() => { GameClient.resetTurn(gameId!); setPendingAction(null); }}>취소 (Undo)</Button>
              </div>
            )}
            {currentPlayer.gleensNavBonusActive && (
              <div className="fixed top-14 bottom-auto md:top-auto md:bottom-20 left-1/2 -translate-x-1/2 z-[125] px-4 py-3 rounded-lg bg-green-950/90 border border-green-500/50 text-green-200 text-sm font-bold shadow-2xl flex items-center gap-4 animate-in slide-in-from-bottom-5">
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
                {/* 모바일: AlertDialogFooter 기본값(flex-col-reverse)이 Undo를 풀폭으로 늘리고 Finish만 작게 만들던 문제(사용자 관찰)
                    — flex-row로 고정해 모바일에서도 좌 Undo / 우 Finish 가로 배치. */}
                <AlertDialogFooter className="flex-row items-center justify-between sm:justify-between gap-2">
                  {pending.appliedItems && pending.appliedItems.length > 0 && (
                    <Button
                      variant="outline"
                      className="shrink-0 bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20"
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
                        className="bg-green-600 hover:bg-green-500 text-white font-bold px-6"
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

      {/* 카드 '바깥 왼쪽' 스트립 — 플레이어당 하나.
          · 내 카드: FA 모드일 때 종족 특수 프리액션 버튼(+Undo) — 누를 수 있음
          · 모든 카드(내 것 포함): 아직 안 쓴 특수 액션(고급타일 3O·1Q+5C, 아카데미 QIC, 보너스 타일, 종족 스페셜)
            [2026-08-07 사용자] 처음엔 남의 카드에만 띄웠는데, 정작 본인 것(예: 파이락 다운그레이드)이
            안 보여 헷갈린다는 지적 → 내 카드에도 같이 띄운다. 표시 전용이며 실행은 상태창 상세에서.
          좌표는 applyStripPos가 DOM에 직접 쓴다(리렌더를 거치면 스크롤에 더 크게 밀림). */}
      {trackCardStrips && game?.players && Object.keys(game.players).map(pid => {
        const isMe = pid === playerId;
        const showFa = isMe && showYouFaStrip;
        // [사용자 2026-08-07] 패스한 사람은 이번 라운드에 특수 액션을 쓸 수 없으므로 스트립을 띄우지 않는다.
        const passedThisRound = !!game.players[pid]?.hasPassed;
        const acts = (showSpecialStrips && !stripQuickOff && !passedThisRound) ? getSpecialActionsForPlayer(game, pid).filter(a => !a.used) : [];
        if (!showFa && acts.length === 0) return null;
        return (
          <div
            key={pid}
            ref={(el) => { stripRefs.current[pid] = el; }}
            style={{ position: 'fixed', visibility: 'hidden' }}
            className={`${isMe ? 'z-[85]' : 'z-[84]'} flex flex-col justify-center gap-1 pr-1 -translate-x-full pointer-events-none`}
          >
            {showFa && faVisibleActs.map((a, i) => (
              <button
                key={`fa-${i}`}
                type="button"
                onClick={() => { if (!isCurrentTurn || !gameId) return; a.run(); }}
                title="종족 특수 프리액션 (FA)"
                className="pointer-events-auto text-[10px] font-bold px-1.5 py-1 rounded border border-amber-400/60 bg-zinc-900/90 text-amber-200 hover:bg-amber-500/30 leading-none whitespace-nowrap shadow-lg backdrop-blur"
              >
                {a.label}
              </button>
            ))}
            {/* [사용자 2026-08-14] "발타크 스페셜을 2~3번 누르고 싶은데 한 번 누르면 그 자리에 Undo가 생겨
                버튼 위치가 바뀐다" — 스트립은 카드 높이에 고정(applyStripPos)인데 내용물이 justify-center라,
                Undo 2개가 나타나면 **중앙 정렬이 다시 계산돼** 위쪽 버튼들이 밀렸다.
                → Undo 자리를 처음부터 비워둔다(항상 렌더, 쓸 수 없을 땐 invisible). 기하가 변하지 않아
                  같은 버튼을 연속으로 누를 수 있다. */}
            {showFa && faVisibleActs.length > 0 && <div className="pointer-events-none h-px bg-white/15" />}
            {/* Undo 2개는 한 줄로 — 예약 높이를 1줄로 줄여 특수 액션이 많은 종족에서도 카드 높이를 덜 먹는다 */}
            {showFa && (
              <div className={`flex gap-1 ${faShowUndo ? '' : 'invisible pointer-events-none'}`}>
                <button
                  type="button"
                  aria-hidden={!faShowUndo}
                  tabIndex={faShowUndo ? 0 : -1}
                  onClick={() => { if (!gameId || !faShowUndo) return; GameClient.undoFreeAction(gameId, 1); }}
                  title="프리액션 한 단계 되돌리기"
                  className="pointer-events-auto flex-1 text-[10px] font-bold px-1.5 py-1 rounded border border-sky-400/60 bg-zinc-900/90 text-sky-200 hover:bg-sky-500/30 leading-none whitespace-nowrap shadow-lg backdrop-blur"
                >
                  ↩1
                </button>
                <button
                  type="button"
                  aria-hidden={!faShowUndo}
                  tabIndex={faShowUndo ? 0 : -1}
                  onClick={() => { if (!gameId || !faShowUndo) return; GameClient.undoFreeAction(gameId, faUndoDepth); }}
                  title="이 턴의 프리액션 전부 되돌리기"
                  className="pointer-events-auto flex-1 text-[10px] font-bold px-1.5 py-1 rounded border border-rose-400/60 bg-zinc-900/90 text-rose-200 hover:bg-rose-500/30 leading-none whitespace-nowrap shadow-lg backdrop-blur"
                >
                  ↩All
                </button>
              </div>
            )}
            {showFa && acts.length > 0 && <div className="pointer-events-none h-px bg-white/15" />}
            {acts.map(a => {
              // [2026-08-07 사용자] 내 카드 칩은 눌러서 바로 실행. 남의 것은 표시 전용이라 색을 분리한다
              //   (내 것 = 초록 계열 '실행 가능' / 남의 것 = 시안 '정보'). 실행 분기는 상태창 상세와 동일.
              const canUseNow = isMe && isCurrentTurn && !game.hasDoneMainAction;
              if (!isMe) {
                return (
                  <span
                    key={a.key}
                    title={`${game.players[pid]?.name}: ${a.label} — 아직 사용 가능`}
                    className="pointer-events-auto text-[10px] font-bold px-1.5 py-1 rounded border border-cyan-400/50 bg-zinc-900/90 text-cyan-200 leading-none whitespace-nowrap shadow-lg backdrop-blur"
                  >
                    {a.short}
                  </span>
                );
              }
              return (
                <button
                  key={a.key}
                  type="button"
                  // [2026-08-07 사용자] 지금 못 쓴다고 회색으로 바꾸지 않는다 —
                  //   턴이 도는 동안 회색이면 '이미 썼다'로 오해된다. 색은 그대로 두고 눌러도 반응만 없게.
                  title={`${a.kind === 'faction' ? '종족 고유 능력 · ' : ''}${a.label}${canUseNow ? ' — 눌러서 사용' : ' — 아직 안 썼습니다 (내 차례에 메인 액션으로 사용)'}`}
                  onClick={() => {
                    if (!canUseNow || !gameId) return;
                    const id = a.actionId;
                    if (id === 'bonusAction') GameClient.useBonusAction(gameId);
                    else if (id === 'ivits-space-station') setIvitsSpaceStationMode(true);
                    else if (id === 'bescods-advance-lowest') setBescodsAdvanceLowestOpen(true);
                    else if (id === 'ambas-swap-pi-mine') setAmbasSwapPiMineMode(true);
                    else if (id === 'moweyip-place-ring') setMoweyipPlaceRingMode(true);
                    else if (id === 'firaks-downgrade') setFiraksDowngradeMode(true);
                    else if (id === 'tech-act-4p' || id === 'adv-act-3k' || id === 'adv-act-3o' || id === 'adv-act-1q-5c') GameClient.useTechAction(gameId, id);
                    else GameClient.useSpecialAction(gameId, id);
                  }}
                  // [2026-08-09 사용자] 종족 고유 능력은 색/기호 대신 '종족 이름' 접두로 구분한다
                  //   (색은 거의 모든 색조가 이미 종족색이라 혼동, ★ 기호는 두 렌더 경로에서 불일치했음).
                  className={`pointer-events-auto text-[10px] font-bold px-1.5 py-1 rounded border border-emerald-400/60 bg-zinc-900/90 text-emerald-200 leading-none whitespace-nowrap shadow-lg backdrop-blur ${canUseNow ? 'hover:bg-emerald-500/30 cursor-pointer' : 'cursor-default'}`}
                >
                  {a.short}
                </button>
              );
            })}
          </div>
        );
      })}

      {/* Right Sidebar — 분할 모드(세로 Info)에선 하단-우측 사분면(top-1/2 ~ bottom-0) */}
      <div
        className={`
        z-[80]
        transition-[transform,opacity] duration-300 ease-in-out
        border-l border-border bg-card/95 backdrop-blur-sm lg:bg-card flex flex-col shadow-2xl lg:shadow-none
        ${splitActive
          ? `fixed right-0 left-auto ${mobileZoomPanel === 'status' ? 'top-0 h-[100dvh] bottom-auto' : 'top-1/2 bottom-0'} ${mobileZoomPanel === 'info' ? 'hidden' : ''} translate-x-0 opacity-100 border-t`
          : `${isSidebarOpen ? 'translate-x-0 opacity-100 md:relative fixed' : 'w-0 translate-x-full lg:translate-x-0 lg:w-0 opacity-0 overflow-hidden pointer-events-none fixed'} right-0 top-0 bottom-0 max-w-[85vw] md:max-w-none relative`
        }
      `}
        style={{
          // pt는 탭바 높이(최대화 시 safe-area 포함)를 따라간다 — 예전엔 pt-[22px] 고정이라 탭바를 키우면 겹쳤다
          ...(splitActive ? { width: splitStatusWidth } : (isSidebarOpen ? { width: effectiveSidebarWidth } : {})),
          ...(isMobileViewport ? { paddingTop: mobilePanelPadTop, paddingBottom: mobilePanelPadBottom } : {}),
        }}
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
        {(isSidebarOpen || splitActive) && (
          <div
            className="flex flex-col h-full w-full md:min-w-[308px] overflow-hidden"
            style={splitActive
              ? ({ width: MOBILE_PANEL_DESIGN_WIDTH, height: `${100 / splitStatusZoom}%`, zoom: splitStatusZoom } as CSSProperties)
              : isMobileViewport ? ({ width: MOBILE_PANEL_DESIGN_WIDTH, height: `${100 / mobilePanelZoom}%`, zoom: mobilePanelZoom } as CSSProperties) : undefined}
          >
            <div ref={playerListScrollRef} className="flex-1 min-h-0 flex flex-col gap-4 p-4 overflow-y-auto custom-scrollbar">
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
                    // 둘 다 패스했으면 '패스한 순서'(passingOrder = 다음 라운드 선후공)대로 표시 — 기존엔 turnOrder
                    // 순서를 유지해 패스한 사람들이 제멋대로 보였음(사용자 관찰). 패스 1번째 → 2번째 순.
                    if (pa?.hasPassed && pb?.hasPassed) {
                      const po = game.passingOrder ?? [];
                      const ia = po.indexOf(a), ib = po.indexOf(b);
                      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
                    }
                    return 0; // 둘 다 플레이 중 → turnOrder 순서 유지
                  })
              ).map((id, cardIdx) => {
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
                  const hasBig = (p.techTiles?.includes('tech-big-4str') && !p.coveredTechTiles?.includes('tech-big-4str')) ?? false;
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
                      ref={(el) => { cardRefs.current[id] = el; }}
                      onMouseEnter={() => setHoveredPlayerId(id)}
                      onMouseLeave={() => setHoveredPlayerId(null)}
                      className={`rounded-lg border text-sm overflow-visible relative transition-all duration-300
                    ${isCurrentTurn && !hasPassed
                          ? 'border-amber-400/80 bg-amber-500/10 shadow-[0_0_12px_rgba(251,191,36,0.3)]'
                          : isYou
                            ? 'bg-primary/15 border-primary/50'
                            : 'bg-muted/50 border-border'
                        }`}
                    >
                      <PopoverTrigger asChild>
                        <div
                          role="button"
                          tabIndex={0}
                          onClickCapture={(e) => {
                            // 모바일: 상세 팝오버 위치를 직접 계산. 세로=클릭한 행 Y, 가로=상태창 왼쪽에 자연스럽게 붙임.
                            //   폭(288px×zoom)만큼 왼쪽에 두되, 화면 밖으로 나가면 8px로만 클램프(불필요하게 끝까지 안 보냄).
                            if (isMobileViewport) {
                              const rect = e.currentTarget.getBoundingClientRect();
                              const top = Math.min(Math.max(8, rect.top), window.innerHeight - 120);
                              const zoom = playerDetailScale * (splitActive ? splitStatusZoom : mobilePanelZoom);
                              const popW = 288 * zoom; // w-72(288px) × zoom (padding 포함=border-box)
                              const left = Math.max(8, rect.left - popW - 4); // 상태창 왼쪽에 4px 간격, 넘치면 8px 클램프
                              document.documentElement.style.setProperty('--gp-detail-top', `${Math.round(top)}px`);
                              document.documentElement.style.setProperty('--gp-detail-left', `${Math.round(left)}px`);
                              // [사용자] 아래쪽 카드(3·4번째) 클릭 시 팝오버가 화면 아래로 잘려 액션 선택 불가 →
                              // 렌더 후 실제 높이를 재서 전체가 화면 안에 들어오도록 top을 위로 재클램프
                              requestAnimationFrame(() => requestAnimationFrame(() => {
                                const el = document.querySelector('[data-radix-popper-content-wrapper] > .gp-detail-mobile');
                                if (!el) return;
                                const h = el.getBoundingClientRect().height;
                                const fitTop = Math.max(8, Math.min(top, window.innerHeight - h - 8));
                                document.documentElement.style.setProperty('--gp-detail-top', `${Math.round(fitTop)}px`);
                              }));
                            }
                          }}
                          className={`w-full text-left flex items-stretch min-w-0 hover:bg-white/5 transition-colors focus:outline-none rounded-lg group ${hasPassed ? 'cursor-default' : ''}`}
                        >
                          {/* FA 모드 종족 특수 프리액션 버튼은 데스크톱 전용 — 카드 '바깥 왼쪽' fixed 스트립(youFaActs). 모바일은 자리가 없어 미사용(사용자) */}
                          {/* Left: Main info, Buildings, Resources */}
                          <div className="flex-1 flex flex-col p-1.5 md:p-2.5 pr-1 md:pr-2 min-w-0">
                            {/* Score / Name / Bid Row — [2026-07-26 사용자] 패스 딤은 이름줄·보너스타일만, 건물/자원/파워/포머는 안 가림 */}
                            <div className="flex items-center gap-2 min-w-0 mb-1 md:mb-1.5">
                              {/* [사용자] 패스 딤은 점수+이름에만 — PASSED 배지는 dim 밖(아래 ml-auto)이라 밝게 보임 */}
                              <div className={`flex items-center gap-2 min-w-0 flex-1 ${hasPassed ? 'grayscale opacity-60 brightness-[0.7]' : ''}`}>
                              <span className="w-5 md:w-7 text-left text-sm md:text-base font-bold text-white flex-shrink-0 tabular-nums leading-none">
                                {p.score}
                              </span>

                              <div className="flex items-center gap-1 md:gap-1.5 min-w-0 flex-1">
                                {/* [2026-07-14 사용자] 색 동그라미 클릭 → 보드(건물·위성·잊혀진 행성) 색 오버라이드 선택 */}
                                <div className="relative flex-shrink-0">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (colorPickerFor === id) { setColorPickerFor(null); setColorPickerPos(null); return; }
                                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                      const W = 160, H = 96; // w-40 + 대략 높이
                                      setColorPickerPos({
                                        left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)),
                                        top: r.bottom + 6 + H > window.innerHeight ? Math.max(8, r.top - H - 6) : r.bottom + 6,
                                      });
                                      setColorPickerFor(id);
                                    }}
                                    className={`w-2 h-2 md:w-2.5 md:h-2.5 rounded-full block hover:scale-150 transition-transform ${playerColorOverrides[id] ? 'ring-1 ring-white/70' : ''}`}
                                    style={{ backgroundColor: playerColorOverrides[id] ?? faction?.color ?? '#666' }}
                                    title="클릭: 보드 표시 색 변경 (건물·위성·잊혀진 행성)"
                                  />
                                  {colorPickerFor === id && colorPickerPos && typeof document !== 'undefined' && createPortal(
                                    <>
                                      {/* 바깥 클릭 닫기 (상태창 상세와 동일 UX) */}
                                      <div className="fixed inset-0 z-[190]" onClick={() => { setColorPickerFor(null); setColorPickerPos(null); }} />
                                      <div
                                        className="fixed z-[200] p-2 rounded-lg bg-zinc-900 border border-white/20 shadow-xl w-40"
                                        style={{ left: colorPickerPos.left, top: colorPickerPos.top }}
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <div className="text-[10px] text-zinc-400 mb-1.5">보드 표시 색 (나에게만 적용)</div>
                                        <div className="grid grid-cols-6 gap-1 mb-1.5">
                                          {OVERRIDE_COLORS.map((c) => (
                                            <button
                                              key={c}
                                              type="button"
                                              onClick={() => { setPlayerColor(id, c); setColorPickerFor(null); setColorPickerPos(null); }}
                                              className={`w-4 h-4 rounded-full border ${playerColorOverrides[id] === c ? 'border-white ring-1 ring-white' : 'border-white/20 hover:border-white/60'}`}
                                              style={{ backgroundColor: c }}
                                            />
                                          ))}
                                        </div>
                                        <button
                                          type="button"
                                          onClick={() => { setPlayerColor(id, null); setColorPickerFor(null); setColorPickerPos(null); }}
                                          className="w-full py-1 rounded text-[10px] font-bold bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 flex items-center justify-center gap-1.5"
                                        >
                                          <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: faction?.color ?? '#666' }} />
                                          기본값으로
                                        </button>
                                      </div>
                                    </>,
                                    document.body
                                  )}
                                </div>
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
                                  <span className="text-[9px] font-black text-amber-300 border border-amber-500/50 bg-amber-500/10 rounded px-1.5 py-0.5 tracking-wide">PASSED</span>
                                )}
                              </div>
                            </div>

                            {/* Buildings — [2026-08-07 사용자] 갯수가 잘 안 보이고 '없음/다 지음'이 인지가 안 된다는 의견.
                                기존엔 라벨·갯수·한도가 전부 같은 크기·비슷한 톤이라 PI0/1과 PI1/1이 시각적으로 구분이 안 됐다.
                                → 칸(칩)으로 나누고 '상태'로만 색을 준다(건물 종류별 색은 쓰지 않음, 사용자 지시):
                                  없음=점선·흐림 / 여유=옅은 배경 / 다 지음=꽉 찬 배경+어두운 글자.
                                갯수는 굵고 크게, /한도는 작고 흐리게. */}
                            <div data-tour={isYou ? 'buildings' : undefined} className="flex justify-between items-stretch gap-0.5 md:gap-1 mb-0.5 md:mb-1 font-mono w-full">
                              {([
                                { key: 'M', label: 'M', have: counts.physicalMineCount, max: BUILDING_LIMITS.mine, text: `${counts.physicalMineCount}` },
                                { key: 'TS', label: 'TS', have: counts.tsCount, max: BUILDING_LIMITS.trading_station, text: `${counts.tsCount}` },
                                { key: 'Lab', label: 'Lab', have: counts.labCount, max: BUILDING_LIMITS.research_lab, text: `${counts.labCount}` },
                                { key: 'PI', label: 'PI', have: counts.piCount, max: BUILDING_LIMITS.planetary_institute, text: `${counts.piCount}` },
                                { key: 'A', label: 'A', have: counts.academyLeft + counts.academyRight, max: BUILDING_LIMITS.academy, text: `${counts.academyLeft}+${counts.academyRight}` },
                              ] as const).map(b => {
                                const none = b.have === 0;
                                const full = b.have >= b.max;
                                // [2026-08-07 사용자] 초록은 관례상 '가능/진행'이라 다 지었는데 더 지을 수 있어 보였다.
                                //   빗금은 글자를 가려서 기각 → 색으로만 구분. 다 지음 = 붉은 계열(막힘/한도 도달).
                                const box = full
                                  ? 'border-rose-400/50 bg-rose-500/60'
                                  : none
                                    ? 'border-dashed border-white/15 bg-transparent'
                                    : 'border-white/10 bg-white/5';
                                const labelCls = full ? 'text-rose-100/70' : none ? 'text-zinc-600' : 'text-zinc-400';
                                const numCls = full ? 'text-rose-50' : none ? 'text-zinc-600' : 'text-zinc-100';
                                const maxCls = full ? 'text-rose-100/60' : none ? 'text-zinc-700' : 'text-zinc-500';
                                return (
                                  <span
                                    key={b.key}
                                    className={`flex-1 min-w-0 flex items-baseline justify-center gap-[1px] whitespace-nowrap rounded border px-0.5 py-[2px] leading-none tabular-nums ${box}`}
                                    title={`${b.label} ${b.have}/${b.max}${full ? ' — 더 지을 수 없음' : none ? ' — 아직 없음' : ''}`}
                                  >
                                    <span className={`text-[7px] md:text-[8px] ${labelCls}`}>{b.label}</span>
                                    <span className={`text-[11px] md:text-[13px] font-black ${numCls}`}>{b.text}</span>
                                    <span className={`text-[7px] md:text-[8px] ${maxCls}`}>/{b.max}</span>
                                  </span>
                                );
                              })}
                            </div>

                            {/* Resources & Power / Gaiaformers */}
                            <div className="flex flex-row gap-2 mt-1 border-t border-white/10 pt-1.5">
                              {/* Left: 2x2 Resource Grid (O C / K Q) — 프리액션 모드 시 가능한 변환만 클릭 박스 표시 */}
                              {(() => {
                                const faActive = isYou && freeActionMode;
                                const faIsTak = p.faction === 'taklons';
                                const faNevPI = p.faction === 'nevlas' && (game.map?.some(t => t.ownerId === id && t.structure === 'planetary_institute') ?? false);
                                // [사용자] 타클론도 상태창 활성화는 '일반 파워토큰' 기준(브레인 미포함). 브레인 조합은 왼쪽 스트립.
                                const faCanPow = (cost: number) =>
                                  faNevPI ? (p.power3 ?? 0) >= Math.ceil(cost / 2) : (p.power3 ?? 0) >= cost;
                                const faCan: Record<'ore' | 'knowledge' | 'qic' | 'credit', boolean> = {
                                  // [사용자] 네뷸라 의회 O = 3P→2O(파워3 필요)라 faCanPow(할인가 2) 대신 파워3 기준.
                                  ore: (p.power3 ?? 0) >= 3,
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
                                // 우클릭: K→1C / Q→1O (좌클릭 파워변환과 별개, faCan과 무관하게 자원만 있으면 가능)
                                const faRight = (kind: 'ore' | 'knowledge' | 'qic') =>
                                  faActive ? (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); handleFreeActionRightClick(kind); } : undefined;
                                return (
                              <div className="grid grid-cols-2 gap-x-2 gap-y-1 w-1/2 tabular-nums">
                                {/* O: Ore */}
                                <div className={`flex items-center justify-start${faCellCls('ore')}${faActive && !faCan.ore ? ' cursor-pointer' : ''}`} onClick={faClick('ore')} onContextMenu={faRight('ore')} title={faActive ? '프리액션: 좌클릭 3P→1O (네뷸라 의회: 3P→2O) · 우클릭 1O→1C' : undefined}>
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
                                <div className={`flex items-center justify-start${faCellCls('knowledge')}${faActive && !faCan.knowledge ? ' cursor-pointer' : ''}`} onClick={faClick('knowledge')} onContextMenu={faRight('knowledge')} title={faActive ? '프리액션: 좌클릭 4P→1K · 우클릭 1K→1C' : undefined}>
                                  <span className="text-blue-400 w-[10px] md:w-3 text-xs md:text-sm font-bold shrink-0 text-center">K</span>
                                  <span style={{ color: '#2E5EAA' }} className="font-black text-sm md:text-base ml-0.5 shrink-0 leading-none">{p.knowledge ?? 0}</span>
                                  {inc.knowledge > 0 && (
                                    <span className="text-[10px] md:text-xs text-zinc-400 font-medium ml-0.5 shrink-0 leading-none">(+{inc.knowledge})</span>
                                  )}
                                </div>
                                {/* Q: QIC */}
                                <div className={`flex items-center justify-start${faCellCls('qic')}${faActive && !faCan.qic ? ' cursor-pointer' : ''}`} onClick={faClick('qic')} onContextMenu={faRight('qic')} title={faActive ? '프리액션: 좌클릭 4P→1Q · 우클릭 1Q→1O' : undefined}>
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
                                <div data-tour={isYou ? 'gaiaformers' : undefined} className="flex justify-between items-center w-full min-h-[14px]" title="가이아포머 (불 켜진 점: 사용 가능, X: 소행성 파괴, 어두운 점: 맵 배치)">
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
                                    {/* [사용자] 포머 표시 우측에 미사용(초록) 연방 개수 칩 하나 — "FED N". 5단계/고급기술에 아직 안 쓴 연방 수. 없으면 미표시. */}
                                    {(() => {
                                      const green = getFederationEntries(p as PlayerState).filter((f) => f.isGreen).length;
                                      if (green === 0) return null;
                                      return (
                                        <span className="text-[8px] font-black leading-none px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 tracking-tight" title={`미사용 연방 ${green}개 (5단계·고급기술에 사용 가능)`}>FED {green}</span>
                                      );
                                    })()}
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
                                        const isTakBrain = p.faction === 'taklons' && !(p as any).brainStoneInGaia;
                                        const brainIn1 = isTakBrain && (p as any).brainStoneBowl === 1;
                                        const brainIn2 = isTakBrain && (p as any).brainStoneBowl === 2;
                                        const brainIn3 = isTakBrain && (p as any).brainStoneBowl === 3;
                                        // [사용자] 브레인 스톤 든 그릇 표시. FA ON의 '초록 링(테두리)'과 헷갈리지 않게 링 대신 '자홍 채움(fill)' 사용.
                                        const brainHi = ' rounded bg-fuchsia-600/45 px-1 -mx-0.5';
                                        // 제노스는 1O→토큰이 3그릇으로 가므로 1그릇 대신 3그릇에 클릭 박스
                                        const canBowl1 = isYou && freeActionMode && p.faction !== 'xenos' && (p.ore ?? 0) >= 1;
                                        const canBowl2 = isYou && freeActionMode && (p.power2 ?? 0) >= (brainIn2 ? 1 : 2);
                                        const canBowl3 = isYou && freeActionMode && p.faction === 'xenos' && (p.ore ?? 0) >= 1;
                                        return (
                                          <>
                                      <span
                                        className={`flex items-center gap-0.5${canBowl1 ? faBoxCls : ''}${brainIn1 ? brainHi : ''}`}
                                        onClick={canBowl1 ? (e) => { e.stopPropagation(); e.preventDefault(); handleFreeActionClick('bowl1'); } : undefined}
                                        title={canBowl1 ? '프리액션: 1O → 토큰 1개 (1그릇)' : undefined}
                                      >
                                        <span className="text-blue-400 font-black text-sm md:text-base leading-none">{p.power1 ?? 0}</span>
                                        {p.faction === 'taklons' && (p as any).brainStoneBowl === 1 && !(p as any).brainStoneInGaia && (
                                          <span className="text-[10px] leading-none">🧠</span>
                                        )}
                                      </span>
                                      <span
                                        className={`flex items-center gap-0.5${canBowl2 ? faBoxCls : ''}${brainIn2 ? brainHi : ''}`}
                                        onClick={canBowl2 ? (e) => { e.stopPropagation(); e.preventDefault(); handleFreeActionClick('bowl2'); } : undefined}
                                        title={canBowl2 ? '프리액션: 태우기 (2그릇 1개 소모 + 1개 3그릇 이동)' : undefined}
                                      >
                                        <span className="text-cyan-400 font-black text-sm md:text-base leading-none">{p.power2 ?? 0}</span>
                                        {p.faction === 'taklons' && (p as any).brainStoneBowl === 2 && !(p as any).brainStoneInGaia && (
                                          <span className="text-[10px] leading-none">🧠</span>
                                        )}
                                      </span>
                                      <span
                                        className={`flex items-center gap-0.5${canBowl3 ? faBoxCls : ''}${brainIn3 ? brainHi : ''}`}
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
                          <div className={`flex flex-col items-center justify-center p-2 border-l border-white/5 bg-black/10 shrink-0 w-[52px] ${hasPassed ? 'grayscale opacity-60 brightness-[0.7]' : ''}`}>
                            {p.bonusTile && (() => {
                              const bonusIndex = ALL_BONUS_TILES.findIndex(t => t.id === p.bonusTile);
                              if (bonusIndex === -1) return null;
                              const tile = ALL_BONUS_TILES[bonusIndex];
                              const bonusUsed = !!p.usedBonusAction;
                              // 내 턴, 메인 액션 전, 스페셜 액션이 있는 보너스 타일이면 클릭으로 바로 액션 실행 (상태창 안 열고)
                              const canUseBonus = isYou && isCurrentTurn && !game.hasDoneMainAction && !!tile.specialAction && !bonusUsed;
                              const actionNames: Record<string, string> = { terraform_step: '1 Step', gaia_project: 'Gaia', range_3: '+3 Range' };
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
                          /* 모바일: 확대(zoom) 시 Radix가 zoom을 모르고 좌측(side=left)에 위치를 잡아 화면 왼쪽으로 짤림.
                             → !important로 위치를 강제(좌측 8px 고정·transform 제거·상단 고정). zoom은 좌상단서 자라므로
                             오른쪽으로만 넘침(상태창 가려도 됨=사용자 요청). 세로 스크롤 허용. */
                          collisionPadding={8}
                          className={`w-72 bg-zinc-950/95 backdrop-blur border border-white/20 rounded-xl p-3 shadow-[0_0_30px_rgba(0,0,0,0.8)] z-[140] text-[10px] space-y-2 overflow-y-auto ${isMobileViewport ? 'gp-detail-mobile' : ''}`}
                          /* [사용자] 화면보다 길어지던 문제: max-height는 zoom을 곱한 '실제 렌더 높이' 기준으로 화면 안에 들어오게 나눠서 제한 */
                          style={(() => {
                            const z = isMobileViewport ? playerDetailScale * (splitActive ? splitStatusZoom : mobilePanelZoom) : playerDetailScale;
                            return { zoom: z, maxHeight: `calc((100vh - 16px) / ${z})` };
                          })()}
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
                                <div className="w-full text-[9px] text-white font-bold leading-none flex flex-wrap gap-x-1.5 gap-y-0.5">
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
                                          className={`relative inline-flex items-center justify-center rounded-full border transition-all ${isOwned ? 'w-4 h-4 border-white/70 bg-black/40 opacity-100 shadow-[0_0_6px_rgba(255,255,255,0.15)]' : 'w-3.5 h-3.5 border-white/20 bg-black/20 opacity-100'}`}
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

                                  // [사용자] 스페셜 액션 있는 기술타일은 이미지 클릭으로도 바로 사용(스페셜 버튼과 동일 동작).
                                  const hasSpecial = !!tile.specialAction;
                                  const techActionUsed = p.usedTechActions?.includes(tileId) ?? false;
                                  const canUseTechAction = hasSpecial && isYou && isCurrentTurn && !game.hasDoneMainAction && !techActionUsed && !covered;
                                  return (
                                    <div
                                      key={tileId}
                                      className={`relative group ${canUseTechAction ? 'cursor-pointer' : 'cursor-help'}`}
                                      title={canUseTechAction
                                        ? `클릭해서 사용: ${tile.label} — ${tile.description}`
                                        : `${tile.label}: ${tile.description}${covered ? ' (덮힘)' : ''}${hasSpecial && techActionUsed ? ' (이번 라운드 사용됨)' : ''}`}
                                      onClick={canUseTechAction ? (e) => {
                                        e.stopPropagation();
                                        if (!gameId) return;
                                        if (tileId === 'tech-act-4p' || tileId === 'adv-act-3k' || tileId === 'adv-act-3o' || tileId === 'adv-act-1q-5c') {
                                          GameClient.useTechAction(gameId, tileId);
                                        } else {
                                          GameClient.useSpecialAction(gameId, tileId);
                                        }
                                        setExpandedPlayerId(null);
                                      } : undefined}
                                    >
                                      <img
                                        src={tile.image}
                                        alt={tile.label}
                                        className={`w-10 h-auto object-contain rounded border transition-all ${covered ? 'grayscale opacity-60 brightness-75 border-white/10' : canUseTechAction ? 'border-amber-400/70 ring-1 ring-amber-400/50 hover:scale-110 shadow-[0_0_8px_rgba(251,191,36,0.45)]' : 'border-white/10 hover:scale-110 shadow-sm shadow-black'}`}
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
                              'terraform_step': '1 Step',
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
                                      isUsed, canDoMain, tid, `Act: ${techActLabel(tid, tile.label)}`,
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
                                      (p as any).usedSpecialActions?.includes('space_giants-2tf') ?? false, canDoMain, 'space_giants-2tf', '스자:2 Step',
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

                                // [2026-07-08 사용자] 발타크 '포머→QIC:N회' 정보배지 제거 — 스페셜 *액션* 영역에 정보-전용 배지가
                                //   섞여 '포머→가이아 2회'처럼 액션/중복으로 오인(사용자 관찰). 포머 수는 상태 패널에 이미 표시.
                                //   (변환은 프리액션 다이얼로그에만 둠 — 앞서 ResearchBoard 버튼 제거와 동일 취지.)

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
                  {/* [2026-07-14 사용자] 로그 배율 슬라이더(볼륨바식): 100%~300% 연속 조절 */}
                  <div className="flex items-center gap-1.5 px-1" title="로그 배율 (100%~300%)">
                    <input
                      type="range"
                      min={LOG_SCALE_MIN}
                      max={LOG_SCALE_MAX}
                      step={0.05}
                      value={logTextScale}
                      onChange={(e) => {
                        const v = Math.min(LOG_SCALE_MAX, Math.max(LOG_SCALE_MIN, parseFloat(e.target.value) || 1));
                        setLogTextScale(v);
                        localStorage.setItem('game-log-text-scale', String(v));
                      }}
                      className="w-20 h-1.5 cursor-pointer accent-blue-500"
                    />
                    <span className="text-[10px] font-black text-zinc-300 tabular-nums w-9 text-right">
                      {Math.round(logTextScale * 100)}%
                    </span>
                  </div>
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
                    canRollback={!!(playerId && game.players?.[playerId]) && ['main','startingMines','bonusSelection'].includes(String(game.currentPhase))}
                    onRollbackToSeq={(seq, label) => { if (!gameId) return; if (!window.confirm(`[${label ?? '이 지점'}] 이 로그가 속한 턴의 시작으로 되돌립니다.\n그 이후 행동은 모두 사라지고 그 턴부터 다시 진행됩니다.\n다른 플레이어 전원이 동의해야 실행됩니다. 요청할까요?`)) return; GameClient.requestRollback(gameId, seq).catch((e) => toast({ title: '롤백 요청 실패', description: e?.message || '', variant: 'destructive' })); }}
                    onEntryMouseEnter={(tileId) => setHighlightedTileId(tileId)}
                    onEntryMouseLeave={() => setHighlightedTileId(null)}
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

      {/* [대기 배너] 모바일 — 데스크톱은 좌측 사이드바 오버레이(hidden md:flex라 모바일 미노출).
          [사용자 2026-08-01] 의회만 있고 수입/파워 수락 대기가 모바일에 아예 안 뜨던 것 → 3종 모두 스택 표시 */}
      {game && isMobileViewport && (councilPendingInfo || incomeWaiters.length > 0 || (pendingTurnEndPlayerName && pendingPowerWaiters.length > 0)) && (
        <div
          className="md:hidden fixed inset-x-3 z-[116] space-y-1.5"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 3.25rem)' }}
        >
          {councilPendingInfo && (
            <div className="bg-cyan-950/95 border border-cyan-400/40 text-cyan-100 rounded-lg px-3 py-2 text-xs shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur">
              <strong>{councilPendingInfo.name}</strong> — {councilPendingInfo.kind} {councilPendingInfo.what} · 선택이 끝나면 라운드가 시작됩니다
            </div>
          )}
          {incomeWaiters.length > 0 && (
            <div className="bg-sky-950/95 border border-sky-400/40 text-sky-100 rounded-lg px-3 py-2 text-xs shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur">
              수입 단계 · 대기: {incomeWaiters.map((w) => w.current ? `${w.name}(선택 중)` : w.name).join(', ')}
            </div>
          )}
          {pendingTurnEndPlayerName && pendingPowerWaiters.length > 0 && (
            <div className="bg-amber-950/95 border border-amber-400/40 text-amber-100 rounded-lg px-3 py-2 text-xs shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur">
              <strong>{pendingTurnEndPlayerName}</strong> 턴 · 파워 수락 대기: {pendingPowerWaiters.map((w) => w.offerCount > 1 ? `${w.name}(${w.offerCount}건)` : w.name).join(', ')}
            </div>
          )}
        </div>
      )}
      {/* [2026-07-27 사용자] 패널 확대 중 복귀 버튼 — 헤더(최상단)는 손이 안 닿아 우하단에 축소 버튼 */}
      {game && isMobileViewport && splitActive && mobileZoomPanel && (
        <button
          type="button"
          aria-label="패널 축소"
          title="원래 크기로"
          onClick={() => setMobileZoomPanel(null)}
          className="md:hidden fixed z-[130] h-11 w-11 rounded-full border border-white/25 bg-zinc-900/90 text-zinc-100 text-lg shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur flex items-center justify-center active:scale-95 transition-transform"
          style={{
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)',
            right: 'calc(env(safe-area-inset-right, 0px) + 0.75rem)',
          }}
        >
          ⤡
        </button>
      )}
      {/* 모바일 전체모드 진입 버튼 — 좌상단, 전체모드 아닐 때만(사용자 요청). 전체모드는 시스템 UI를 접어 세로 공간 확보. */}
      {game && isMobileViewport && !isFullscreen && (
        <button
          type="button"
          aria-label="전체 화면"
          title="전체 화면으로 보기"
          onClick={enterFullscreen}
          className="md:hidden fixed left-3 top-3 z-[116] h-9 w-9 rounded-full border border-white/15 bg-zinc-900/90 text-zinc-200 shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur flex items-center justify-center active:scale-95 transition-transform"
          style={{
            top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)',
            left: 'calc(env(safe-area-inset-left, 0px) + 0.75rem)',
          }}
        >
          <Maximize className="w-5 h-5" />
        </button>
      )}

      {/* [버그 2026-08-10, 사용자 "모바일 종료 이후 점수 보기 버튼 안 보이네"]
          '최종 점수 보기' 버튼은 좌측 사이드바 안에만 있는데 그 사이드바가 hidden md:flex라 모바일에선 통째로 안 보였다.
          결과창은 종료 시 1회 자동으로 뜨지만 한 번 닫으면 모바일에선 다시 열 방법이 없었음 → 하단 중앙에 전용 버튼.
          이 시점엔 프리액션 버튼(같은 하단 영역)이 phase!=='main'이라 사라져 있어 겹치지 않는다. */}
      {game && isMobileViewport && game.currentPhase === 'gameEnd' && !showGameEndScore && (
        <button
          type="button"
          aria-label="최종 점수 보기"
          onClick={() => setShowGameEndScore(true)}
          className="md:hidden fixed left-1/2 -translate-x-1/2 z-[116] flex items-center gap-1.5 rounded-full border border-amber-300/50 bg-amber-600/95 px-4 py-2.5 text-xs font-black text-white shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur active:scale-95 transition-transform"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}
        >
          <Trophy className="w-4 h-4" />
          최종 점수
        </button>
      )}

      {/* 모바일 프리액션 버튼 — 내 턴(본게임)에만 노출. 좌하단 채팅 옆(메뉴 자리)에 아이콘만·원형(채팅/메뉴와 동일 크기).
          모바일엔 'f' 단축키가 없어 진입 수단이 없던 것 보완(사용자). 누르면 프리액션 다이얼로그(자원/파워 변환). */}
      {game && isMobileViewport && !isSpectator && isMyTurn && game.currentPhase === 'main' && (
        <button
          type="button"
          aria-label="프리액션"
          title="프리액션 (자원·파워 변환)"
          onClick={() => setIsFreeActionsOpen(true)}
          className="md:hidden fixed bottom-3 z-[116] h-12 w-12 rounded-full border border-emerald-400/50 bg-emerald-600/90 text-white shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur flex items-center justify-center active:scale-95 transition-transform"
          style={{
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)',
            left: 'calc(env(safe-area-inset-left, 0px) + 0.75rem + 3.5rem)',
          }}
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      )}

      {/* 모바일 전용 — Info(좌하단, 보드 3페이지 오버레이) + 로그(우하단, 상태창↔로그). 서로 배타적(하나 열면 다른 건 닫힘).
          세로(portrait)에선 정보창이 상시 표시라 i 버튼 숨김(토글 불필요). 데스크톱은 좌측 미니뷰/도킹 로그 사용(md:hidden). */}
      {game && !portraitMobile && (
        <button
          type="button"
          aria-label={isInfoOpen ? 'Info 닫기' : '보드 정보 열기'}
          title={isInfoOpen ? '닫기' : '보드 정보 (기술/우주선/라운드)'}
          onClick={() => { setIsInfoOpen((prev) => !prev); setIsLogPanelOpen(false); }}
          className="md:hidden fixed left-3 bottom-3 z-[115] h-12 w-12 rounded-full border border-white/15 bg-zinc-900/90 text-emerald-300 shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur flex items-center justify-center active:scale-95 transition-transform"
          style={{
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)',
            left: 'calc(env(safe-area-inset-left, 0px) + 0.75rem)',
          }}
        >
          {isInfoOpen ? <X className="w-5 h-5" /> : <Info className="w-5 h-5" />}
        </button>
      )}
      {/* 모바일 로그 버튼 삭제(사용자 요청) → 우측 패널 상단의 상태창/로그 탭으로 전환. Menu 버튼도 GameBoard 상단으로 이동됨.
          좌측 info(기술/우주선/라운드)처럼 우측을 상태창/로그로 전환. 패널 상단에 고정 탭(분할=50%, 가로=0). */}
      {isMobileViewport && (isSidebarOpen || splitActive) && game && game.currentPhase !== 'factionBidding' && (
        <div
          className={`md:hidden fixed right-0 z-[113] flex ${mobileZoomPanel === 'status' ? 'text-[11px]' : 'text-[9px]'} font-black uppercase tracking-wide overflow-hidden rounded-bl-lg border-l border-b border-white/10 ${mobileZoomPanel === 'info' ? 'hidden' : ''}`}
          style={{ top: mobileTabBarTop, height: mobileTabBarH, width: splitActive ? splitStatusWidth : effectiveSidebarWidth }}
          data-tour="mobile-tabs"
          onDoubleClick={() => splitActive && setMobileZoomPanel(p => p === 'status' ? null : 'status')}
          title="더블터치: 전체화면 전환"
        >
          <button
            type="button"
            onClick={() => { setIsLogPanelOpen(false); setIsInfoOpen(false); }}
            className={`flex-1 h-full flex items-center justify-center ${!isLogPanelOpen ? 'bg-blue-500/25 text-blue-100' : 'bg-zinc-900/95 text-zinc-500'}`}
          >
            상태창
          </button>
          <button
            type="button"
            onClick={() => { setIsLogPanelOpen(true); setIsInfoOpen(false); }}
            className={`flex-1 h-full flex items-center justify-center border-l border-white/10 ${isLogPanelOpen ? 'bg-blue-500/25 text-blue-100' : 'bg-zinc-900/95 text-zinc-500'}`}
          >
            로그
          </button>
          {/* 로그 필터(라운드/플레이어) 토글 — 로그 탭일 때만. 기본 꺼짐(상시 노출 불편, 사용자). +로 켜고 끔 */}
          {isLogPanelOpen && (
            <button
              type="button"
              aria-label="로그 필터 켜기/끄기"
              title="라운드·플레이어 필터 켜기/끄기"
              onClick={() => setLogFilterOpen((v) => !v)}
              className={`shrink-0 ${mobileZoomPanel === 'status' ? 'w-9' : 'w-7'} h-full flex items-center justify-center border-l border-white/10 leading-none ${logFilterOpen ? 'bg-blue-500/40 text-white' : 'bg-zinc-900/95 text-zinc-400'}`}
            >
              {logFilterOpen ? '−' : '+'}
            </button>
          )}
        </div>
      )}

      {/* 모바일: 로그 버튼 누르면 상태창 자리에 로그 오버레이. 세로(분할)에선 상태창과 동일한 하단-우측 사분면, 가로에선 우측 풀하이트. */}
      {isMobileViewport && isLogPanelOpen && game && (
        <div
          className={`md:hidden fixed z-[110] flex flex-col bg-card/95 backdrop-blur-sm overflow-hidden ${splitActive ? `right-0 ${mobileZoomPanel === 'status' ? 'top-0 h-[100dvh] bottom-auto' : 'top-1/2 bottom-0'} ${mobileZoomPanel === 'info' ? 'hidden' : ''} border-t border-l border-border` : 'top-0 bottom-0 right-0 border-l border-border'}`}
          style={{ width: splitActive ? splitStatusWidth : effectiveSidebarWidth, paddingTop: mobilePanelPadTop, paddingBottom: mobilePanelPadBottom }}
        >
          <div
            className="flex flex-col h-full overflow-hidden"
            style={splitActive
              ? ({ width: MOBILE_PANEL_DESIGN_WIDTH, height: `${100 / splitStatusZoom}%`, zoom: splitStatusZoom } as CSSProperties)
              : ({ width: MOBILE_PANEL_DESIGN_WIDTH, height: `${100 / mobilePanelZoom}%`, zoom: mobilePanelZoom } as CSSProperties)}
          >
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 pt-2 pb-3" onWheel={(e) => e.stopPropagation()}>
              {(!game.gameLog || game.gameLog.length === 0) ? (
                <div className="text-center text-muted-foreground text-xs py-8">No actions yet</div>
              ) : (
                <GameLog
                  game={game}
                  hideHeader
                  showToolbar={logFilterOpen}
                  className="w-full"
                  maxHeight="none"
                  textScale={logTextScale}
                  canRollback={!!(playerId && game.players?.[playerId]) && ['main','startingMines','bonusSelection'].includes(String(game.currentPhase))}
                  onRollbackToSeq={(seq) => { if (!gameId) return; if (!window.confirm('이 지점(턴 시작)으로 롤백을 요청할까요?\n다른 플레이어 전원이 동의해야 실행됩니다.')) return; GameClient.requestRollback(gameId, seq).catch((e) => toast({ title: '롤백 요청 실패', description: e?.message || '', variant: 'destructive' })); }}
                  onEntryMouseEnter={(tileId) => setHighlightedTileId(tileId)}
                  onEntryMouseLeave={() => setHighlightedTileId(null)}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* 모바일 Info 오버레이 — 화면 왼쪽, 상태창 1.2배 폭. 가로 모드: 3페이지 드래그/점. 세로 모드: 3창 합쳐 스크롤. ("?" 다이얼로그에서 전환)
          세로(portrait)에선 상시 표시(infoEffectivelyOpen), 가로(landscape)에선 i 버튼 토글. */}
      {isMobileViewport && infoEffectivelyOpen && game && (
        <div
          className={`md:hidden fixed z-[110] flex flex-col bg-card/95 backdrop-blur-sm overflow-hidden ${splitActive ? `left-0 ${mobileZoomPanel === 'info' ? 'top-0 h-[100dvh] bottom-auto' : 'top-1/2 bottom-0'} ${mobileZoomPanel === 'status' ? 'hidden' : ''} border-t border-r border-border` : 'top-0 bottom-0 left-0 border-r border-border'}`}
          style={{ width: infoEffectiveWidth }}
        >
          {/* 헤더 + (가로 모드일 때만) 페이지 인디케이터 */}
          <div className="shrink-0 flex items-center justify-between px-2 py-1 border-b border-white/10 bg-black/30" onDoubleClick={() => splitActive && setMobileZoomPanel(p => p === 'info' ? null : 'info')} title="더블터치: 전체화면 전환">
            <span className="text-[10px] font-black uppercase tracking-wider text-emerald-300 truncate">
              {infoLayout === 'vertical' ? '기술 · 우주선 · 라운드' : (infoPage === 0 ? '기술 타일' : infoPage === 1 ? '우주선 · 파워' : '라운드 · 보너스')}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              {infoLayout === 'horizontal' && (
                <div className="flex items-center gap-1 shrink-0">
                  {[0, 1, 2].map((i) => (
                    <button
                      key={i}
                      type="button"
                      aria-label={`페이지 ${i + 1}`}
                      onClick={() => setInfoPage(i)}
                      className={`h-1.5 rounded-full transition-all ${infoPage === i ? 'w-4 bg-emerald-300' : 'w-1.5 bg-white/25'}`}
                    />
                  ))}
                </div>
              )}
              {/* [사용자 2026-08-19] 전체화면 토글 — 헤더 더블터치도 되지만 얇은 줄이라 못 찾는다는 의견.
                  우측 상태창은 큼직한 탭바가 그 역할을 해서 발견됐고, 여기는 버튼을 따로 둔다. */}
              {splitActive && (
                <button
                  type="button"
                  aria-label={mobileZoomPanel === 'info' ? '원래 크기로' : '전체화면으로'}
                  title={mobileZoomPanel === 'info' ? '원래 크기로 (헤더 더블터치도 가능)' : '전체화면으로 (헤더 더블터치도 가능)'}
                  onClick={() => setMobileZoomPanel((v) => (v === 'info' ? null : 'info'))}
                  className="shrink-0 rounded border border-emerald-300/30 bg-emerald-400/10 px-1.5 py-px text-[11px] leading-none text-emerald-200 active:scale-95 transition-transform"
                >
                  {mobileZoomPanel === 'info' ? '⤡' : '⤢'}
                </button>
              )}
            </div>
          </div>
          {infoLayout === 'vertical' ? (
            /* 세로 모드: 기술+우주선+파워(section='all') → 라운드·보너스 한 흐름으로 위아래 스크롤 */
            <div
              className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain custom-scrollbar"
              onWheel={(e) => e.stopPropagation()}
            >
              <div
                className="flex flex-col gap-4 px-2 pt-2 pb-2"
                style={{ width: MOBILE_PANEL_DESIGN_WIDTH, zoom: infoEffectiveZoom } as CSSProperties}
              >
                {renderInfoResearch('all')}
                <div className="h-[1px] bg-white/10 w-full" />
                {renderInfoRoundBonus()}
              </div>
              {/* zoom 밖 스페이서: 마지막 내용이 좌하단 버튼(높이 48px+여백)에 가리지 않게 버튼만큼 더 스크롤되도록 */}
              <div style={{ height: 'calc(env(safe-area-inset-bottom, 0px) + 5rem)' }} />
            </div>
          ) : (
            /* 가로 모드: 좌우 드래그 페이지 */
            <div className="flex-1 min-h-0 overflow-hidden">
              <motion.div
                key={infoPage}
                className="h-full w-full overflow-y-auto overflow-x-hidden overscroll-contain custom-scrollbar"
                drag="x"
                dragDirectionLock
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.15}
                onDragEnd={(_, info) => {
                  if (info.offset.x < -55 && infoPage < 2) setInfoPage(infoPage + 1);
                  else if (info.offset.x > 55 && infoPage > 0) setInfoPage(infoPage - 1);
                }}
                onWheel={(e) => e.stopPropagation()}
              >
                <div
                  className="flex flex-col overflow-hidden px-2 pt-2 pb-3"
                  style={{ width: MOBILE_PANEL_DESIGN_WIDTH, height: `${100 / infoEffectiveZoom}%`, zoom: infoEffectiveZoom } as CSSProperties}
                >
                  {infoPage === 0 && renderInfoResearch('tech')}
                  {infoPage === 1 && renderInfoResearch('ships')}
                  {infoPage === 2 && renderInfoRoundBonus()}
                </div>
              </motion.div>
            </div>
          )}
        </div>
      )}

      <AnimatePresence>
        {(pendingAction || (game && game.hasDoneMainAction && game.turnOrder[game.currentPlayerIndex] === playerId && game.currentPhase === 'main' && !game.pendingTurnEndPlayerId && !game.botPlayerIds?.includes(playerId) && (!game.pendingTFMarsGaiaProject || game.pendingTFMarsGaiaProject.playerId !== playerId) && (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId) && (!game.pendingSpaceshipFedMine || game.pendingSpaceshipFedMine.playerId !== playerId) && (!game.pendingLostPlanet || game.pendingLostPlanet.playerId !== playerId))) && (
          <motion.div
            initial={{ y: -50, x: '-50%', opacity: 0 }}
            animate={{ y: 0, x: '-50%', opacity: 1 }}
            exit={{ y: -50, x: '-50%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-20 z-[130] flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 p-2 px-3 md:px-4 bg-zinc-900/95 backdrop-blur-xl border border-yellow-500/50 rounded-2xl md:rounded-full shadow-[0_0_30px_rgba(234,179,8,0.2)] max-w-[95vw]"
            style={{
              left: isSidebarOpen ? `calc((100% - ${effectiveSidebarWidth}px) / 2)` : '50%',
              ...(isMobileViewport ? { zoom: 0.82 } : {}),
            }}
          >
            {/* Title & Costs (Left Side) */}
            <div className="flex items-center gap-3 md:border-r md:border-white/10 md:pr-4">
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

              {/* Reset/End Turn (Integrated inside bar)
                  [잠금 버그 수정 2026-07-20] 삽 대기(pendingTerraformSteps>0) 조건이 버튼을 아예 숨겨서,
                  삽을 들었는데 지을 곳이 없으면(광석 0 등) 탈출 불가 40분 잠금(실서버 로그 rohrigdp).
                  서버 end_turn은 삽 대기를 허용하므로 버튼을 항상 노출하고, 삽이 남았으면 확인만 받는다. */}
              {game && game.hasDoneMainAction && game.turnOrder[game.currentPlayerIndex] === playerId && game.currentPhase === 'main' && !game.pendingTurnEndPlayerId && (!game.pendingShipTechMine || game.pendingShipTechMine.playerId !== playerId) && (!game.pendingSpaceshipFedMine || game.pendingSpaceshipFedMine.playerId !== playerId) && (!game.pendingLostPlanet || game.pendingLostPlanet.playerId !== playerId) && (
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
                        const pendSteps = game.players[playerId!]?.pendingTerraformSteps ?? 0;
                        if (pendSteps > 0 && !window.confirm(`테라포밍 ${pendSteps}단계가 남아 있습니다. 사용하지 않고 턴을 종료할까요?`)) return;
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
              saveView(`research-pos-${gameId}`, 'research-pos-last', JSON.stringify(newPos));
            }}
            className="fixed z-[110] border border-white/20 bg-zinc-950/90 backdrop-blur-md rounded-xl shadow-2xl overflow-hidden flex flex-col pointer-events-auto left-0 top-0"
            style={{ width: researchMiniWidth, height: researchMiniHeight, maxHeight: '95vh' }}
          >
            <div
              className="bg-blue-900/40 px-3 py-2 flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing border-b border-white/10"
              onPointerDown={(e) => researchDragControls.start(e)}
            >
              {singleMini ? (
                /* [사용자 2026-08-20] 단일 미니뷰 헤더 — 모바일 세로 오버레이와 같은 3탭 구성.
                   PC라 스와이프가 없으니 좌우 버튼을 둔다. 탭 자체도 눌러서 바로 이동. */
                <div className="flex items-center gap-1 min-w-0" onPointerDown={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    aria-label="이전 탭"
                    onClick={() => gotoMiniPage(singleMiniPage - 1)}
                    className="h-5 w-5 shrink-0 rounded text-blue-200 hover:bg-white/10"
                  >
                    ◀
                  </button>
                  {['Research', 'Ships', 'Tactical'].map((label, i) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => gotoMiniPage(i)}
                      className={`rounded px-1.5 py-0.5 text-[10px] font-black uppercase tracking-tight transition-colors ${singleMiniPage === i ? 'bg-blue-500/30 text-white' : 'text-blue-200/60 hover:text-blue-100'}`}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-label="다음 탭"
                    onClick={() => gotoMiniPage(singleMiniPage + 1)}
                    className="h-5 w-5 shrink-0 rounded text-blue-200 hover:bg-white/10"
                  >
                    ▶
                  </button>
                </div>
              ) : (
              <span className="text-[11px] font-black uppercase text-blue-200 flex items-center gap-2 select-none">
                <FlaskConical className="w-3.5 h-3.5" /> Research Board
              </span>
              )}
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
                {singleMini ? (
                  /* 모바일 오버레이와 같은 렌더러를 재사용 — 규칙·핸들러가 갈라지지 않게. */
                  singleMiniPage === 0 ? renderInfoResearch('tech')
                    : singleMiniPage === 1 ? renderInfoResearch('ships')
                      : renderInfoRoundBonus()
                ) : (
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
                onTakeTwilightArtifact={(artId) => handleTakeTwilightArtifact(artId)}
                onUseAcademyQic={() => GameClient.useSpecialAction(gameId!, 'academy-qic')}
                onEndTurn={() => GameClient.endTurn(gameId!)}
                onResetTurn={() => GameClient.resetTurn(gameId!)}
                onUseShipAction={(shipTileId, actionIndex, targetTileId) => handleUseShipAction(shipTileId, actionIndex, targetTileId)}
                />
                )}
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
              saveView(`bonus-pos-${gameId}`, 'bonus-pos-last', JSON.stringify(newPos));
            }}
            // 닫아도 언마운트하지 않고 display:none으로만 숨김 → RoundBoard 이미지 DOM 유지(재오픈 즉시 표시)
            className={`fixed z-[110] border border-white/20 bg-zinc-950/90 backdrop-blur-md rounded-xl shadow-2xl overflow-hidden flex flex-col pointer-events-auto left-0 top-0 ${isBonusPinned && !singleMini ? '' : 'hidden'}`}
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
      {GameEndScoreModal()}

      {/* 인게임 채팅 — 하단 좌측, 최상위 레이어. 참가자/관전자만 노출 */}
      {/* 관전자 selfId = 관전 ID: 서버 echo의 senderId와 일치해야 낙관적 메시지가 교체됨(불일치 시 채팅이 2번씩 보임 — 사용자 관찰) */}
      {game && gameId && (isSpectator || (!!playerId && !!game.players[playerId])) && (
        <ChatPanel gameId={gameId} game={game} canChat={true} selfId={playerId ?? (isSpectator ? getStoredSpectatorId(gameId) : null)} infoButtonHidden={portraitMobile} />
      )}
    </div>
  );
}
