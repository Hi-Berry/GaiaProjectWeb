import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Users } from 'lucide-react';
import type { GameState, ResearchTrack } from '@/lib/gameClient';
import { FACTIONS, RESEARCH_TRACKS, ALL_TECH_TILES, ARTIFACTS, getNextRoundIncomePreview, canSpendTaklonsPower, HOME_PLANETS, PlanetType } from '@shared/gameConfig';
import { PlayerBonusTile } from './BonusTiles';

const PLANET_COLORS: Record<string, string> = {
  terra: '#2E5EAA',      // Blue
  oxide: '#E85D04',      // Red/Orange
  volcanic: '#FFB703',   // Orange
  titanium: '#808080',   // Gray
  ice: '#E0FAFA',        // Light Blue/White
  desert: '#FFE74C',     // Yellow
  swamp: '#38B000',      // Green
};

const ColoredPlanetList = ({ planets }: { planets: string[] }) => {
  if (!planets || planets.length === 0) return <span>None</span>;
  return (
    <>
      {planets.map((p, i) => (
        <span key={p}>
          <span style={{ color: PLANET_COLORS[p] || '#ffffff' }} className="font-semibold drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]">
            {p}
          </span>
          {i < planets.length - 1 ? ', ' : ''}
        </span>
      ))}
    </>
  );
};





interface PlayerPanelProps {
  game: GameState;
  playerId: string | null;
  isCurrentTurn: boolean;
  onEndTurn: () => void;
  onAdvanceTech: (trackId: ResearchTrack) => void;
  onConvertResource: (type: string, useBrain?: boolean) => void;
  onBurnPower: (moveBrainToBowl3?: boolean) => void;
  onExit: () => void;
  onUseBonusAction?: () => void;
  onUseAcademyQic?: () => void;
  onUseGleens2Nav?: () => void;
  onUseBalTakGaiaformerToQic?: () => void;
}


function ResourceBar({ label, value, max, color, next }: { label: string; value: number; max: number; color: string; next?: number }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs font-medium">
        <span>{label}</span>
        <span>
          {value}
          {next != null && next > 0 && <span className="opacity-60 font-medium ml-1">({`+${next}`})</span>}
        </span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden border border-white/5">
        <div
          className="h-full transition-all duration-300 shadow-[0_0_8px_rgba(0,0,0,0.5)]"
          style={{
            width: `${Math.min((value / max) * 100, 100)}%`,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  );
}

const TRACK_DESCRIPTIONS: Record<string, string[]> = {
  terraforming: ["3 Ore/Step", "2 Ore/Step (+2O)", "2 Ore/Step", "1 Ore/Step", "1 Ore/Step (+2O)", "L5: One-time reward"],
  navigation: ["Range 1", "Range 1 (+1 QIC)", "Range 2", "Range 2 (+1 QIC)", "Range 3", "L5: Lost Fleet"],
  artificialIntelligence: ["0 QIC", "1 QIC", "2 QIC", "4 QIC", "6 QIC", "10 QIC (Total)"],
  gaiaProject: ["0 Gain", "Move 1 to Gaia", "Move 2 to Gaia", "Move 3 to Gaia", "Gain 4VP", "L5: 4VP + Gaia"],
  economy: ["None", "2C 1P", "1O 2C 2P", "1O 3C 3P", "2O 4C 4P", "L5: One-time reward"],
  science: ["None", "1K", "2K", "3K", "4K", "L5: One-time reward"],
};

function PowerCycle({ power1, power2, power3, gaiaformerPower, gaiaformers, pendingGaiaformerCount, balTakLocked, brainStoneBowl, brainStoneInGaia, factionId, onBurnPower, canBurn }: {
  power1: number; power2: number; power3: number;
  gaiaformerPower?: number; gaiaformers?: number; pendingGaiaformerCount?: number;
  balTakLocked?: number;
  /** 타클론 브레인 스톤: 1|2|3 = 해당 그릇, 없으면 가이아 등 */
  brainStoneBowl?: 1 | 2 | 3;
  brainStoneInGaia?: boolean;
  factionId?: string;
  onBurnPower: (moveBrainToBowl3?: boolean) => void; canBurn: boolean
}) {
  const label = (bowl: 1 | 2 | 3, count: number) => (brainStoneBowl === bowl && !brainStoneInGaia ? `${count} (B)` : String(count));
  const taklonsBurnChoice = brainStoneBowl === 2 && !brainStoneInGaia && power2 >= 2;
  const canBurnTwoRegular = taklonsBurnChoice && power2 >= 3;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-center gap-4">
        <div className="text-center relative">
          <div className="w-12 h-12 rounded-full border-2 border-green-500/70 flex items-center justify-center bg-green-600/70 shadow-[0_0_15px_rgba(34,197,94,0.4)]">
            <span className="text-lg font-bold text-green-100">{(gaiaformerPower ?? 0)}</span>
          </div>
          <span className="text-[10px] uppercase tracking-tighter text-green-300/90 mt-1 block">Gaiaformer</span>
        </div>
        <div className="h-[2px] w-4 bg-green-500/40" />
        <div className="text-center relative">
          <div className="w-12 h-12 rounded-full border-2 border-purple-500/50 flex items-center justify-center bg-purple-500/20 shadow-[0_0_15px_rgba(168,85,247,0.2)]">
            <span className="text-lg font-bold text-purple-100">{label(1, power1)}</span>
          </div>
          <span className="text-[10px] uppercase tracking-tighter text-muted-foreground mt-1 block">Bowl I</span>
        </div>
        <div className="h-[2px] w-4 bg-purple-500/30" />
        <div className="text-center relative">
          <div className="w-12 h-12 rounded-full border-2 border-purple-400/50 flex items-center justify-center bg-purple-400/20 shadow-[0_0_15px_rgba(192,132,252,0.2)]">
            <span className="text-lg font-bold text-purple-100">{label(2, power2)}</span>
          </div>
          <span className="text-[10px] uppercase tracking-tighter text-muted-foreground mt-1 block">Bowl II</span>
        </div>
        <div className="h-[2px] w-4 bg-purple-500/30" />
        <div className="text-center relative">
          <div className="w-12 h-12 rounded-full border-2 border-purple-300/50 flex items-center justify-center bg-purple-300/20 shadow-[0_0_15px_rgba(216,180,254,0.2)]">
            <span className="text-lg font-bold text-purple-100">{label(3, power3)}</span>
          </div>
          <span className="text-[10px] uppercase tracking-tighter text-muted-foreground mt-1 block">Bowl III</span>
        </div>
      </div>
      {brainStoneInGaia && (
        <div className="text-[10px] text-amber-400/90 text-center">B (가이아, 다음 라운드 복귀)</div>
      )}
      {factionId === 'itars' && gaiaformerPower !== undefined && gaiaformerPower > 0 && (
        <div className="text-[10px] text-cyan-400/90 text-center">아이타: {gaiaformerPower} 토큰 → 다음 라운드 1그릇 복귀</div>
      )}
      <div className="text-center space-y-1">
        {gaiaformers !== undefined && gaiaformers > 0 ? (
          <div className="text-xs text-green-400 font-semibold bg-green-500/10 px-3 py-1.5 rounded-lg border border-green-500/30">
            <span className="text-green-300">가이아 포머: </span>
            <span className="text-green-100 font-bold text-sm">{gaiaformers}개</span>
            {balTakLocked !== undefined && balTakLocked > 0 && (
              <div className="text-[10px] text-amber-400/90 mt-1">
                사용 가능: {gaiaformers - balTakLocked} · 잠김: {balTakLocked}개 (다음 라운드 복귀)
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            가이아 포머: 0개
          </div>
        )}
        {pendingGaiaformerCount !== undefined && pendingGaiaformerCount > 0 && (
          <div className="text-[10px] text-green-300/90 bg-green-500/5 px-2 py-1 rounded border border-green-500/20">
            보드 설치: {pendingGaiaformerCount}개
          </div>
        )}
      </div>
      {taklonsBurnChoice && canBurn ? (
        <div className="flex flex-col gap-1.5">
          {canBurnTwoRegular && (
            <Button
              size="sm"
              variant="outline"
              className="w-full h-7 text-[10px] uppercase py-0 border-purple-500/30 hover:bg-purple-500/10"
              onClick={() => onBurnPower(false)}
            >
              2P 태우기 (일반 2개 → III)
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="w-full h-7 text-[10px] uppercase py-0 border-amber-500/40 hover:bg-amber-500/10 bg-amber-500/5"
            onClick={() => onBurnPower(true)}
          >
            2P 태우기 (B+1 → III)
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="w-full h-7 text-[10px] uppercase py-0 border-purple-500/30 hover:bg-purple-500/10"
          disabled={!canBurn}
          onClick={() => onBurnPower()}
        >
          {factionId === 'itars' ? '2P 태우기 (1→다음 라운드 1그릇)' : 'Burn 2 Power (II ➔ III)'}
        </Button>
      )}
    </div>
  );
}


export function PlayerPanel({
  game, playerId, isCurrentTurn, onEndTurn,
  onAdvanceTech, onConvertResource, onBurnPower, onExit, onUseBonusAction, onUseAcademyQic, onUseGleens2Nav,
  onUseBalTakGaiaformerToQic
}: PlayerPanelProps) {
  const currentPlayer = playerId ? game.players[playerId] : null;
  const faction = currentPlayer?.faction ? FACTIONS.find(f => f.id === currentPlayer.faction) : null;
  const academyRightCount = playerId ? game.map?.filter((t: { ownerId: string | null; structure: string | null; academyType?: string }) => t.ownerId === playerId && t.structure === 'academy' && t.academyType === 'right').length ?? 0 : 0;
  const hasNevlasPI = currentPlayer?.faction === 'nevlas' && playerId && game?.map?.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute');
  const canUseAcademyQic = academyRightCount >= 1 && !currentPlayer?.usedSpecialActions?.includes('academy-qic');
  const canUseGleens2Nav = currentPlayer?.faction === 'gleens' && !currentPlayer?.usedSpecialActions?.includes('gleens-2nav') && !game.hasDoneMainAction;

  /**
   * @deprecated This component is legacy and its functionality has been moved to the right sidebar.
   * Do not restore without consulting UI redesign plans.
   */
  return null;
}

