import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Users } from 'lucide-react';
import type { GameState, ResearchTrack } from '@/lib/gameClient';
import { FACTIONS, RESEARCH_TRACKS, ALL_TECH_TILES, ARTIFACTS, getNextRoundIncomePreview, canSpendTaklonsPower, HOME_PLANETS } from '@shared/gameConfig';
import { PlayerBonusTile } from './BonusTiles';





interface PlayerPanelProps {
  game: GameState;
  playerId: string | null;
  isCurrentTurn: boolean;
  onEndTurn: () => void;
  onPass: () => void;
  onAdvanceTech: (trackId: ResearchTrack) => void;
  onConvertResource: (type: string, useBrain?: boolean) => void;
  onBurnPower: (moveBrainToBowl3?: boolean) => void;
  onExit: () => void;
  onUseBonusAction?: () => void;
  onUseAcademyQic?: () => void;
  onUseGleens2Nav?: () => void;
}


function ResourceBar({ label, value, max, color, next }: { label: string; value: number; max: number; color: string; next?: number }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs font-medium">
        <span>{label}</span>
        <span>
          {value}
          {next != null && next > 0 && <span className="text-muted-foreground font-normal ml-1">(+{next})</span>}
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

function PowerCycle({ power1, power2, power3, gaiaformerPower, gaiaformers, pendingGaiaformerCount, balTakLocked, brainStoneBowl, brainStoneInGaia, itarsPendingBowl1Tokens, onBurnPower, canBurn }: {
  power1: number; power2: number; power3: number;
  gaiaformerPower?: number; gaiaformers?: number; pendingGaiaformerCount?: number;
  balTakLocked?: number;
  /** 타클론 브레인 스톤: 1|2|3 = 해당 그릇, 없으면 가이아 등 */
  brainStoneBowl?: 1 | 2 | 3;
  brainStoneInGaia?: boolean;
  /** 아이타: 2그릇 태울 때 보관한 토큰 수 (다음 라운드 1그릇 복귀) */
  itarsPendingBowl1Tokens?: number;
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
      {itarsPendingBowl1Tokens !== undefined && itarsPendingBowl1Tokens > 0 && (
        <div className="text-[10px] text-cyan-400/90 text-center">아이타: {itarsPendingBowl1Tokens} 토큰 → 다음 라운드 1그릇 복귀</div>
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
          {itarsPendingBowl1Tokens !== undefined ? '2P 태우기 (1→다음 라운드 1그릇)' : 'Burn 2 Power (II ➔ III)'}
        </Button>
      )}
    </div>
  );
}

function TurnSequence({ game }: { game: GameState }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground">Turn Order</h4>
        <Badge variant="outline" className="text-[8px] border-zinc-800 text-zinc-500">ROUND {game.roundNumber}</Badge>
      </div>
      <div className="flex flex-col gap-1.5">
        {game.turnOrder.map((id, index) => {
          const p = game.players[id];
          if (!p) return null;
          const isCurrent = index === game.currentPlayerIndex;
          const hasPassed = p.hasPassed;
          const faction = p.faction ? FACTIONS.find(f => f.id === p.faction) : null;

          return (
            <div
              key={id}
              className={`flex items-center gap-2.5 p-2 rounded-lg transition-all duration-300 ${isCurrent
                ? 'bg-primary/10 border border-primary/30 shadow-[0_0_15px_rgba(var(--primary),0.05)]'
                : 'bg-zinc-900/20 border border-white/5'
                } ${hasPassed ? 'opacity-30 grayscale-[0.8]' : ''}`}
            >
              <div className={`text-[9px] font-black w-3 text-center ${isCurrent ? 'text-primary' : 'text-zinc-600'}`}>
                {index + 1}
              </div>
              <div
                className={`w-2 h-2 rounded-full shadow-sm ${isCurrent ? 'animate-pulse' : ''}`}
                style={{ backgroundColor: faction?.color || '#444' }}
              />
              <div className={`text-[11px] font-bold flex-1 truncate ${isCurrent ? 'text-white' : 'text-zinc-400'}`}>
                {faction ? `${faction.name} (${p.name})` : p.name}
              </div>
              {isCurrent && !hasPassed && (
                <div className="flex gap-1">
                  <span className="text-[7px] uppercase font-black text-primary tracking-widest">Active</span>
                </div>
              )}
              {hasPassed && (
                <span className="text-[7px] uppercase font-black text-zinc-600 tracking-widest">Passed</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PlayerPanel({
  game, playerId, isCurrentTurn, onEndTurn, onPass,
  onAdvanceTech, onConvertResource, onBurnPower, onExit, onUseBonusAction, onUseAcademyQic, onUseGleens2Nav
}: PlayerPanelProps) {
  const currentPlayer = playerId ? game.players[playerId] : null;
  const faction = currentPlayer?.faction ? FACTIONS.find(f => f.id === currentPlayer.faction) : null;
  const academyRightCount = playerId ? game.map?.filter((t: { ownerId: string | null; structure: string | null; academyType?: string }) => t.ownerId === playerId && t.structure === 'academy' && t.academyType === 'right').length ?? 0 : 0;
  const hasNevlasPI = currentPlayer?.faction === 'nevlas' && playerId && game?.map?.some((t: { ownerId: string | null; structure: string | null }) => t.ownerId === playerId && t.structure === 'planetary_institute');
  const canUseAcademyQic = academyRightCount >= 1 && !currentPlayer?.usedSpecialActions?.includes('academy-qic');
  const canUseGleens2Nav = currentPlayer?.faction === 'gleens' && !currentPlayer?.usedSpecialActions?.includes('gleens-2nav') && !game.hasDoneMainAction;

  if (!currentPlayer) {
    return (
      <Card className="h-full bg-black/40 border-0 flex items-center justify-center">
        <p className="text-muted-foreground animate-pulse text-sm">Initializing player profile...</p>
      </Card>
    );
  }

  return (
    <Card className="h-full overflow-y-auto border-0 rounded-none bg-[#0a0a0b] text-zinc-100 custom-scrollbar shadow-inner">
      <CardHeader className="pb-4 pt-6 px-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg font-black tracking-tighter text-white flex items-center gap-2">
              {faction && <div className="w-2.5 h-2.5 rounded-full shadow-[0_0_8px_rgba(34,197,94,0.5)]" style={{ backgroundColor: faction.color }} />}
              {faction ? `${faction.name} (${currentPlayer.name})` : currentPlayer.name}
            </CardTitle>
          </div>
          <div className="text-right">
            <div className="text-2xl font-black text-white leading-tight">{currentPlayer.score}</div>
            <div className="text-[8px] uppercase tracking-widest text-zinc-500 font-bold">Victory Points</div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 overflow-y-auto px-5 py-6 space-y-8 scrollbar-hide">
        {/* Turn Sequence */}
        <TurnSequence game={game} />

        {/* 확장 4종족: 테라포밍 요약 (1/2/3단계 땅 표기) */}
        {currentPlayer?.faction === 'moweyip' && (game as { moweyipThreeStepPlanets?: string[] }).moweyipThreeStepPlanets && (
          <div className="space-y-1.5 p-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5">
            <h4 className="text-[9px] uppercase font-black tracking-wider text-amber-400/90">테라포밍 (모웨이드)</h4>
            <div className="text-[9px] text-zinc-300">
              <span className="text-green-400 font-medium">1 TF:</span>{' '}
              {HOME_PLANETS.filter((p: string) => !(game as { moweyipThreeStepPlanets?: string[] }).moweyipThreeStepPlanets!.includes(p)).join(', ')}
            </div>
            <div className="text-[9px] text-zinc-300">
              <span className="text-amber-400 font-medium">3 TF:</span>{' '}
              {(game as { moweyipThreeStepPlanets?: string[] }).moweyipThreeStepPlanets!.join(', ')}
            </div>
          </div>
        )}
        {currentPlayer?.faction === 'tinkeroids' && (game as { tinkeroidsThreeStepPlanets?: string[] }).tinkeroidsThreeStepPlanets && (
          <div className="space-y-1.5 p-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5">
            <h4 className="text-[9px] uppercase font-black tracking-wider text-amber-400/90">테라포밍 (팅커로이드)</h4>
            <div className="text-[9px] text-zinc-300">
              <span className="text-green-400 font-medium">1 TF:</span>{' '}
              {HOME_PLANETS.filter((p: string) => !(game as { tinkeroidsThreeStepPlanets?: string[] }).tinkeroidsThreeStepPlanets!.includes(p)).join(', ')}
            </div>
            <div className="text-[9px] text-zinc-300">
              <span className="text-amber-400 font-medium">3 TF:</span>{' '}
              {(game as { tinkeroidsThreeStepPlanets?: string[] }).tinkeroidsThreeStepPlanets!.join(', ')}
            </div>
          </div>
        )}
        {currentPlayer?.faction === 'darkanians' && (
          <div className="space-y-1 p-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5">
            <h4 className="text-[9px] uppercase font-black tracking-wider text-amber-400/90">테라포밍 (다카니안)</h4>
            <p className="text-[9px] text-zinc-300">7색상 모두 <span className="text-green-400 font-medium">1 TF</span></p>
          </div>
        )}
        {currentPlayer?.faction === 'space_giants' && (
          <div className="space-y-1 p-2.5 rounded-lg border border-amber-500/20 bg-amber-500/5">
            <h4 className="text-[9px] uppercase font-black tracking-wider text-amber-400/90">테라포밍 (스페이스 자이언트)</h4>
            <p className="text-[9px] text-zinc-300">7색상 모두 <span className="text-amber-400 font-medium">2 TF</span></p>
          </div>
        )}

        {/* Resources */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground">Resources</h4>
          </div>
          <div className="grid grid-cols-1 gap-3">
            {(() => {
              const incomeNext = playerId && game ? getNextRoundIncomePreview(playerId, game) : null;
              return (
                <>
                  <ResourceBar label="Ore" value={currentPlayer.ore} max={15} color="#E85D04" next={incomeNext?.ore} />
                  <ResourceBar label="Knowledge" value={currentPlayer.knowledge} max={15} color="#2E5EAA" next={incomeNext?.knowledge} />
                  <ResourceBar label="Credits" value={currentPlayer.credits} max={30} color="#FFE74C" next={incomeNext?.credits} />
                  <ResourceBar label="Q.I.C" value={currentPlayer.qic} max={10} color="#38B000" next={incomeNext?.qic} />
                  {incomeNext && incomeNext.power > 0 && (
                    <div className="text-[10px] text-muted-foreground">
                      다음 라운드 파워: +{incomeNext.power}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>

        {/* Free Actions */}
        <div className="space-y-3 bg-zinc-900/30 p-3 rounded-xl border border-white/5">
          <h4 className="text-[9px] uppercase font-black tracking-[0.2em] text-muted-foreground text-center">Trade Conversions</h4>
          <div className="grid grid-cols-2 gap-2">
            {currentPlayer?.faction === 'taklons' ? (
              <>
                <Button variant="outline" size="sm" className="h-8 text-[9px] bg-zinc-900/50 hover:bg-zinc-800" disabled={!isCurrentTurn || (currentPlayer.power3 ?? 0) < 3} onClick={() => onConvertResource('3power-to-1ore', false)}>3P ➔ 1O</Button>
                {canSpendTaklonsPower(currentPlayer as Parameters<typeof canSpendTaklonsPower>[0], 3, 3) && (currentPlayer as { brainStoneBowl?: number }).brainStoneBowl === 3 && !(currentPlayer as { brainStoneInGaia?: boolean }).brainStoneInGaia && (currentPlayer.power3 ?? 0) >= 1 && (
                  <Button variant="outline" size="sm" className="h-8 text-[9px] bg-amber-900/50 hover:bg-amber-800 border-amber-500/40" disabled={!isCurrentTurn} onClick={() => onConvertResource('3power-to-1ore', true)}>3P ➔ 1O (B)</Button>
                )}
              </>
            ) : (
              <Button variant="outline" size="sm" className="h-8 text-[9px] bg-zinc-900/50 hover:bg-zinc-800" disabled={!isCurrentTurn || (currentPlayer.power3 ?? 0) < (hasNevlasPI ? 2 : 3)} onClick={() => onConvertResource('3power-to-1ore')}>{hasNevlasPI ? '2P ➔ 1O' : '3P ➔ 1O'}</Button>
            )}
            {!(currentPlayer?.faction === 'gleens' && academyRightCount < 1) && (
              currentPlayer?.faction === 'taklons' ? (
                <>
                  <Button variant="outline" size="sm" className="h-8 text-[9px] bg-zinc-900/50 hover:bg-zinc-800" disabled={!isCurrentTurn || (currentPlayer.power3 ?? 0) < 4} onClick={() => onConvertResource('4power-to-1qic', false)}>4P ➔ 1Q</Button>
                  {canSpendTaklonsPower(currentPlayer as Parameters<typeof canSpendTaklonsPower>[0], 3, 4) && (currentPlayer as { brainStoneBowl?: number }).brainStoneBowl === 3 && !(currentPlayer as { brainStoneInGaia?: boolean }).brainStoneInGaia && (currentPlayer.power3 ?? 0) >= 2 && (
                    <Button variant="outline" size="sm" className="h-8 text-[9px] bg-amber-900/50 hover:bg-amber-800 border-amber-500/40" disabled={!isCurrentTurn} onClick={() => onConvertResource('4power-to-1qic', true)}>4P ➔ 1Q (B)</Button>
                  )}
                </>
              ) : (
                <Button variant="outline" size="sm" className="h-8 text-[9px] bg-zinc-900/50 hover:bg-zinc-800" disabled={!isCurrentTurn || (currentPlayer.power3 ?? 0) < (hasNevlasPI ? 2 : 4)} onClick={() => onConvertResource('4power-to-1qic')}>{hasNevlasPI ? '2P ➔ 1Q' : '4P ➔ 1Q'}</Button>
              )
            )}
            {currentPlayer?.faction === 'taklons' ? (
              <Button variant="outline" size="sm" className="h-8 text-[9px] bg-zinc-900/50 hover:bg-zinc-800" disabled={!isCurrentTurn || !canSpendTaklonsPower(currentPlayer as Parameters<typeof canSpendTaklonsPower>[0], 3, 1)} onClick={() => onConvertResource('1power-to-1credit', false)}>1P ➔ 1C</Button>
            ) : (
              <Button variant="outline" size="sm" className="h-8 text-[9px] bg-zinc-900/50 hover:bg-zinc-800" disabled={!isCurrentTurn || (currentPlayer.power3 ?? 0) < 1} onClick={() => onConvertResource('1power-to-1credit')}>{hasNevlasPI ? '1P ➔ 2C' : '1P ➔ 1C'}</Button>
            )}
            {hasNevlasPI && (
              <>
                <Button variant="outline" size="sm" className="h-8 text-[9px] bg-cyan-900/40 hover:bg-cyan-800/50 border-cyan-500/40" disabled={!isCurrentTurn || (currentPlayer.power3 ?? 0) < 3} onClick={() => onConvertResource('3power-to-2ore')}>3P ➔ 2O</Button>
                <Button variant="outline" size="sm" className="h-8 text-[9px] bg-cyan-900/40 hover:bg-cyan-800/50 border-cyan-500/40" disabled={!isCurrentTurn || (currentPlayer.power3 ?? 0) < 2} onClick={() => onConvertResource('2power-to-1ore-1credit')}>2P ➔ 1O1C</Button>
              </>
            )}
            {currentPlayer?.faction === 'nevlas' && (
              <Button variant="outline" size="sm" className="h-8 text-[9px] bg-cyan-900/40 hover:bg-cyan-800/50 border-cyan-500/40" disabled={!isCurrentTurn || (currentPlayer.power3 ?? 0) < (hasNevlasPI ? 2 : 1)} onClick={() => onConvertResource('1power-to-1k-gaiaformer')}>{hasNevlasPI ? '2P ➔ 가이어+1K' : '1P ➔ 가이어+1K'}</Button>
            )}
            <Button
              variant="outline" size="sm" className="h-8 text-[9px] bg-zinc-900/50 hover:bg-zinc-800"
              disabled={!isCurrentTurn || currentPlayer.knowledge < 1}
              onClick={() => onConvertResource('1knowledge-to-1credit')}
            >
              1K ➔ 1C
            </Button>
            <Button
              variant="outline" size="sm" className="h-8 text-[9px] bg-zinc-900/50 hover:bg-zinc-800"
              disabled={!isCurrentTurn || (currentPlayer.qic ?? 0) < 1}
              onClick={() => onConvertResource('1qic-to-1ore')}
            >
              1Q ➔ 1O
            </Button>
            <Button
              variant="outline" size="sm" className="h-8 text-[9px] bg-zinc-900/50 hover:bg-zinc-800"
              disabled={!isCurrentTurn || (currentPlayer.ore ?? 0) < 1}
              onClick={() => onConvertResource('1ore-to-1credit')}
            >
              1O ➔ 1C
            </Button>
            <Button
              variant="outline" size="sm" className="h-8 text-[9px] bg-zinc-900/50 hover:bg-zinc-800"
              disabled={!isCurrentTurn || (currentPlayer.ore ?? 0) < 1}
              onClick={() => onConvertResource('1ore-to-1token')}
            >
              1O ➔ 1 Token
            </Button>
            {currentPlayer?.faction === 'taklons' ? (
              <>
                <Button variant="outline" size="sm" className="h-8 text-[9px] bg-zinc-900/50 hover:bg-zinc-800" disabled={!isCurrentTurn || (currentPlayer.power3 ?? 0) < 4} onClick={() => onConvertResource('4power-to-1knowledge', false)}>4P ➔ 1K</Button>
                {canSpendTaklonsPower(currentPlayer as Parameters<typeof canSpendTaklonsPower>[0], 3, 4) && (currentPlayer as { brainStoneBowl?: number }).brainStoneBowl === 3 && !(currentPlayer as { brainStoneInGaia?: boolean }).brainStoneInGaia && (currentPlayer.power3 ?? 0) >= 2 && (
                  <Button variant="outline" size="sm" className="h-8 text-[9px] bg-amber-900/50 hover:bg-amber-800 border-amber-500/40" disabled={!isCurrentTurn} onClick={() => onConvertResource('4power-to-1knowledge', true)}>4P ➔ 1K (B)</Button>
                )}
              </>
            ) : (
              <Button variant="outline" size="sm" className="h-8 text-[9px] bg-zinc-900/50 hover:bg-zinc-800" disabled={!isCurrentTurn || (currentPlayer.power3 ?? 0) < (hasNevlasPI ? 2 : 4)} onClick={() => onConvertResource('4power-to-1knowledge')}>{hasNevlasPI ? '2P ➔ 1K' : '4P ➔ 1K'}</Button>
            )}
          </div>
        </div>

        {/* Power Cycle */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground">Power Systems</h4>
          </div>
          <PowerCycle
            power1={currentPlayer.power1 ?? 0}
            power2={currentPlayer.power2 ?? 0}
            power3={currentPlayer.power3 ?? 0}
            gaiaformerPower={currentPlayer.gaiaformerPower}
            gaiaformers={currentPlayer.gaiaformers}
            pendingGaiaformerCount={currentPlayer.pendingGaiaformerTiles?.length ?? 0}
            balTakLocked={currentPlayer.faction === 'bal_tak' ? (currentPlayer.balTakGaiaformersUsedForQic ?? 0) : undefined}
            brainStoneBowl={currentPlayer.faction === 'taklons' ? (currentPlayer as { brainStoneBowl?: 1 | 2 | 3 }).brainStoneBowl : undefined}
            brainStoneInGaia={currentPlayer.faction === 'taklons' ? (currentPlayer as { brainStoneInGaia?: boolean }).brainStoneInGaia : undefined}
            itarsPendingBowl1Tokens={currentPlayer.faction === 'itars' ? (currentPlayer as { itarsPendingBowl1Tokens?: number }).itarsPendingBowl1Tokens : undefined}
            onBurnPower={onBurnPower}
            canBurn={isCurrentTurn && (currentPlayer.power2 ?? 0) >= 2}
          />
        </div>

        {/* Bonus Tile (more important — above Research Institute) */}
        {currentPlayer.bonusTile && (
          <PlayerBonusTile
            game={game}
            playerId={playerId}
            onUseBonusAction={isCurrentTurn ? onUseBonusAction : undefined}
          />
        )}

        {/* Artifacts (Twilight) */}
        {currentPlayer.artifacts && currentPlayer.artifacts.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground">Artifacts</h4>
            <div className="flex flex-wrap gap-1.5">
              {currentPlayer.artifacts.map((aid) => {
                const art = ARTIFACTS.find(a => a.id === aid);
                return art ? (
                  <div
                    key={aid}
                    className="px-2 py-1 bg-purple-900/40 border border-purple-500/30 rounded text-[9px] font-bold text-purple-300 uppercase flex items-center gap-1 group relative cursor-help"
                    title={art.description}
                  >
                    {art.label}
                  </div>
                ) : null;
              })}
            </div>
          </div>
        )}

        {/* Technology Tiles (above Research Institute) */}
        {currentPlayer.techTiles?.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground">Technology Tiles</h4>
            <div className="flex flex-wrap gap-2">
              {currentPlayer.techTiles.map(tileId => {
                const tile = ALL_TECH_TILES.find(t => t.id === tileId);
                return (
                  <div
                    key={tileId}
                    className="px-2 py-1 bg-zinc-900 border border-yellow-500/20 rounded text-[9px] font-bold text-yellow-500 uppercase flex items-center gap-1 group relative cursor-help"
                  >
                    {tile?.label || tileId}
                    {/* Tooltip on hover */}
                    <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block z-50 w-32 p-1.5 bg-zinc-950 border border-yellow-500/20 rounded shadow-2xl text-[8px] text-zinc-300 normal-case font-medium">
                      {tile?.description}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Research Institute (below Bonus, Artifacts, Technology Tiles) */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground">Research Institute</h4>
          </div>
          <div className="space-y-1">
            {RESEARCH_TRACKS.map((track) => {
              const currentLvl = currentPlayer.research?.[track.id as ResearchTrack] ?? 0;
              let desc = TRACK_DESCRIPTIONS[track.id as ResearchTrack][currentLvl] || "";

              if (track.id === 'economy' && game.economyVariant) {
                if (game.economyVariant === 'vp') {
                  const vpDesc = ["None", "1C 1P", "1O 2C 2P", "1O 3C 1VP", "2O 4C 1VP", "L5: 3O 6C 6P"];
                  desc = vpDesc[currentLvl] || "";
                } else {
                  const powerDesc = ["None", "1C 1P", "1O 2C 2P", "1O 2C 3P", "2O 2C 2P", "L5: 3O 6C 6P"];
                  desc = powerDesc[currentLvl] || "";
                }
              }

              return (
                <div key={track.id} className="group flex flex-col p-2 rounded-lg hover:bg-zinc-900/50 border border-transparent hover:border-white/5 transition-all">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: track.color }} />
                      <span className="text-[11px] font-medium text-zinc-300">{track.name}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex gap-0.5">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <div
                            key={i}
                            className={`w-1.5 h-3 rounded-[1px] ${i < currentLvl
                              ? 'bg-zinc-200 shadow-[0_0_5px_rgba(255,255,255,0.3)]'
                              : 'bg-zinc-800'
                              }`}
                          />
                        ))}
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 hover:bg-primary/20 hover:text-primary disabled:opacity-30"
                        disabled={!isCurrentTurn || game.hasDoneMainAction || currentPlayer.knowledge < 4 || currentLvl >= 5}
                        onClick={() => onAdvanceTech(track.id as ResearchTrack)}
                      >
                        <span className="text-xs">+</span>
                      </Button>
                    </div>
                  </div>
                  <div className="pl-[18px] mt-0.5">
                    <span className="text-[8px] text-zinc-500 font-medium uppercase tracking-tighter">
                      {desc}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 글린 기본 특수 액션: 라운드당 1회 +2 Nav (다음 행동에 적용) */}
        {playerId && canUseGleens2Nav && onUseGleens2Nav && (
          <div className="space-y-2">
            <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-sky-400/90">Gleens — Special (1/round)</h4>
            <Button
              variant="outline"
              size="sm"
              className="w-full border-sky-500/30 bg-sky-950/30 hover:bg-sky-900/40 text-sky-200"
              onClick={onUseGleens2Nav}
            >
              +2 Nav (next action)
            </Button>
          </div>
        )}

        {/* Academy (Right) — Special: 1 QIC / 발타크 4C (Technology Tiles 위에서 사용) */}
        {playerId && canUseAcademyQic && onUseAcademyQic && (
          <div className="space-y-2">
            <h4 className="text-[10px] uppercase font-black tracking-[0.2em] text-cyan-400/90">Academy (Right) — Special</h4>
            <Button
              variant="outline"
              size="sm"
              disabled={game.hasDoneMainAction}
              className="w-full border-cyan-500/30 bg-cyan-950/30 hover:bg-cyan-900/40 text-cyan-200"
              onClick={onUseAcademyQic}
            >
              {currentPlayer?.faction === 'bal_tak' ? '4 C' : '1 QIC'}
            </Button>
          </div>
        )}

        {/* Turn Actions */}
        <div className="space-y-3 pt-4 border-t border-white/5">
          {!isCurrentTurn && (
            <p className="text-center text-[9px] text-zinc-500 font-bold uppercase tracking-wider animate-pulse">
              Waiting for other players...
            </p>
          )}
          {isCurrentTurn && !game.hasDoneMainAction && (
            <p className="text-center text-[9px] text-yellow-500 font-bold uppercase tracking-wider">
              Your Turn: Perform a Main Action
            </p>
          )}
          {isCurrentTurn && game.hasDoneMainAction && (
            <p className="text-center text-[9px] text-green-500 font-bold uppercase tracking-wider">
              Main Action Done: You can end your turn
            </p>
          )}
        </div>

        {/* Exit Game */}
        <div className="pt-4 border-t border-white/5">
          <Button
            variant="ghost"
            className="w-full text-zinc-500 hover:text-red-400 hover:bg-red-950/20 text-[10px] uppercase font-bold tracking-widest gap-2"
            onClick={onExit}
          >
            Leave Galaxy
          </Button>
        </div>
      </CardContent>

    </Card>
  );
}

