import React from 'react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { GameState } from '@/lib/gameClient';
import { canSpendTaklonsPower, canSpendTaklonsPowerWithoutBrain } from '@shared/gameConfig';

interface FreeActionsDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    game: GameState;
    playerId: string | null;
    isCurrentTurn: boolean;
    onConvertResource: (type: string, useBrain?: boolean) => void;
    onBurnPower: (useBrain?: boolean) => void;
    onUseBalTakGaiaformerToQic?: () => void;
    onUndoFreeAction?: (steps?: number) => void;
    onUseHadschHallasPIAction?: (actionId: string) => void;
}

export function FreeActionsDialog({
    open,
    onOpenChange,
    game,
    playerId,
    isCurrentTurn,
    onConvertResource,
    onBurnPower,
    onUseBalTakGaiaformerToQic,
    onUndoFreeAction,
    onUseHadschHallasPIAction,
}: FreeActionsDialogProps) {
    const currentPlayer = playerId ? game.players[playerId] : null;
    if (!currentPlayer) return null;
    const freeActionUndoCount = game.freeActionUndoStack?.length ?? (game.freeActionUndoState ? 1 : 0);

    const hasNevlasPI =
        currentPlayer.faction === 'nevlas' &&
        game.map?.some(
            (t) => t.ownerId === playerId && t.structure === 'planetary_institute'
        );
    const isXenos = currentPlayer.faction === 'xenos';
    // 하드쉬 할라스 의회(PI): 크레딧 → 자원 무제한 프리액션 (4C→1QIC, 4C→1K, 3C→1O). 기존엔 R창에만 떠서 안 보였음 → 프리액션에도 노출.
    const hadschPIActions: { id: string; costCredits: number; label: string }[] =
        currentPlayer.faction === 'hadsch_hallas'
            && game.map?.some((t) => t.ownerId === playerId && t.structure === 'planetary_institute')
            ? (((currentPlayer as any).hadschHallasPIActions ?? []) as { id: string; costCredits: number; label: string }[])
            : [];
    const academyRightCount =
        game.map?.filter(
            (t) =>
                t.ownerId === playerId &&
                t.structure === 'academy' &&
                t.academyType === 'right'
        ).length ?? 0;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md bg-[#0a0a0b] text-zinc-100 border-zinc-800 p-0 overflow-hidden shadow-2xl">
                <DialogHeader className="p-4 border-b border-white/5 bg-zinc-900/50">
                    <div className="flex justify-between items-center w-full pr-4">
                        <DialogTitle className="text-lg font-black tracking-widest text-zinc-100 uppercase">
                            Free Actions
                        </DialogTitle>
                        <div className="flex gap-2 items-center">
                            {onUndoFreeAction && freeActionUndoCount > 0 && (
                                <>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => onUndoFreeAction(1)}
                                        className="bg-red-950/40 hover:bg-red-900/60 text-red-400 border-red-500/30 h-7 text-xs uppercase font-bold"
                                    >
                                        Undo
                                    </Button>
                                    {freeActionUndoCount > 1 && (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => onUndoFreeAction(freeActionUndoCount)}
                                            className="bg-red-950/40 hover:bg-red-900/60 text-red-400 border-red-500/30 h-7 text-xs uppercase font-bold"
                                        >
                                            Undo All
                                        </Button>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </DialogHeader>

                <ScrollArea className="max-h-[70vh] p-4">
                    <div className="space-y-4">
                        {/* Current Resources Summary */}
                        <div className="grid grid-cols-4 gap-2 border border-white/10 rounded-lg p-2 bg-zinc-900/40">
                            <div className="text-center">
                                <div className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">Ore</div>
                                <div className="text-sm font-black text-zinc-100">{currentPlayer.ore}</div>
                            </div>
                            <div className="text-center">
                                <div className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">Knowledge</div>
                                <div className="text-sm font-black text-blue-400">{currentPlayer.knowledge}</div>
                            </div>
                            <div className="text-center">
                                <div className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">Credit</div>
                                <div className="text-sm font-black text-yellow-400">{currentPlayer.credits}</div>
                            </div>
                            <div className="text-center">
                                <div className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">QIC</div>
                                <div className="text-sm font-black text-green-400">{currentPlayer.qic}</div>
                            </div>
                            <div className="text-center">
                                <div className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">Power 1</div>
                                <div className="text-sm font-black text-purple-400">{currentPlayer.power1}</div>
                            </div>
                            <div className="text-center">
                                <div className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">Power 2</div>
                                <div className="text-sm font-black text-purple-300">{currentPlayer.power2}</div>
                            </div>
                            <div className="text-center">
                                <div className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">Power 3</div>
                                <div className="text-sm font-black text-purple-200">{currentPlayer.power3}</div>
                            </div>
                            {currentPlayer.faction === 'taklons' && (
                                <div className="text-center flex flex-col items-center justify-center">
                                    <div className="text-[8px] text-zinc-400 font-bold uppercase tracking-wider leading-tight text-center">Brain</div>
                                    <div className="text-xs font-black text-amber-400">
                                        {(currentPlayer as any).brainStoneInGaia ? 'Gaia' : `Bowl ${(currentPlayer as any).brainStoneBowl}`}
                                    </div>
                                </div>
                            )}
                        </div>

                        <h4 className="text-xs uppercase font-black tracking-[0.2em] text-muted-foreground text-center">
                            Power Actions
                        </h4>
                        <div className="space-y-2">
                            <div className="grid grid-cols-2 gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-10 text-[11px] bg-purple-900/20 hover:bg-purple-900/40 border-purple-500/30 text-purple-200"
                                    disabled={
                                        !isCurrentTurn ||
                                        (currentPlayer.faction === 'taklons' &&
                                        (currentPlayer as any).brainStoneBowl === 2 &&
                                        !(currentPlayer as any).brainStoneInGaia
                                            ? (currentPlayer.power2 ?? 0) < 1
                                            : (currentPlayer.power2 ?? 0) < 2)
                                    }
                                    onClick={() => onBurnPower(false)}
                                    title="Bowl 2: 2 power -> Bowl 3 (Taklons: Brain+T -> Brain)"
                                >
                                    Power Burn (2➔1)
                                </Button>
                            </div>
                            <p className="text-[10px] text-zinc-500 text-center leading-tight">
                                {currentPlayer.faction === 'itars'
                                    ? "Itars: Bowl 2에서 2개를 제거하여 1개는 Bowl 3로, 1개는 가이아 구역으로 보냅니다."
                                    : currentPlayer.faction === 'taklons' &&
                                      (currentPlayer as any).brainStoneBowl === 2 &&
                                      !(currentPlayer as any).brainStoneInGaia
                                        ? "Taklons: Brain(2) + Bowl2 일반토큰 1개 제거 → Brain이 Bowl3로 이동"
                                        : "Bowl 2에서 2개를 제거하여 1개는 Bowl 3로 보냅니다 (토큰 1개 영구 손실)."}
                            </p>
                        </div>

                        <h4 className="text-xs uppercase font-black tracking-[0.2em] text-muted-foreground text-center mt-4">
                            Trade Conversions
                        </h4>
                        <div className="grid grid-cols-2 gap-2">
                            {currentPlayer?.faction === 'taklons' ? (
                                <>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-10 text-[11px] bg-amber-900/30 hover:bg-amber-800/40 border-amber-500/40 text-amber-200"
                                        disabled={
                                            !isCurrentTurn ||
                                            (currentPlayer as any).brainStoneInGaia ||
                                            (currentPlayer as any).brainStoneBowl !== 3
                                        }
                                        onClick={() => onConvertResource('1brain-to-3credit')}
                                        title="Taklons: Brain Stone (Bowl III) → +3 Credits (Brain → Bowl I)"
                                    >
                                        1B ➔ 3 Credit
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-10 text-[11px] bg-zinc-900/50 hover:bg-zinc-800"
                                        disabled={
                                            !isCurrentTurn ||
                                            !canSpendTaklonsPower(currentPlayer as Parameters<typeof canSpendTaklonsPower>[0], 3, 3)
                                        }
                                        onClick={() => onConvertResource('3power-to-1ore')}
                                    >
                                        3 Power ➔ 1 Ore
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-10 text-[11px] bg-zinc-900/50 hover:bg-zinc-800"
                                    disabled={
                                        !isCurrentTurn ||
                                        (currentPlayer.power3 ?? 0) < (hasNevlasPI ? 2 : 3)
                                    }
                                    onClick={() => onConvertResource('3power-to-1ore')}
                                >
                                    {hasNevlasPI ? '2 Power ➔ 1 Ore' : '3 Power ➔ 1 Ore'}
                                </Button>
                            )}
                            {!(
                                currentPlayer?.faction === 'gleens' && academyRightCount < 1
                            ) &&
                                (currentPlayer?.faction === 'taklons' ? (
                                    <>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-10 text-[11px] bg-zinc-900/50 hover:bg-zinc-800"
                                            disabled={
                                                !isCurrentTurn ||
                                                !canSpendTaklonsPower(currentPlayer as Parameters<typeof canSpendTaklonsPower>[0], 3, 4)
                                            }
                                            onClick={() => onConvertResource('4power-to-1qic')}
                                        >
                                            4 Power ➔ 1 QIC
                                        </Button>
                                    </>
                                ) : (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-10 text-[11px] bg-zinc-900/50 hover:bg-zinc-800"
                                        disabled={
                                            !isCurrentTurn ||
                                            (currentPlayer.power3 ?? 0) < (hasNevlasPI ? 2 : 4)
                                        }
                                        onClick={() => onConvertResource('4power-to-1qic')}
                                    >
                                        {hasNevlasPI ? '2 Power ➔ 1 QIC' : '4 Power ➔ 1 QIC'}
                                    </Button>
                                ))}
                            {currentPlayer?.faction === 'taklons' ? (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-10 text-[11px] bg-zinc-900/50 hover:bg-zinc-800"
                                    disabled={
                                        !isCurrentTurn ||
                                        !canSpendTaklonsPowerWithoutBrain(
                                            currentPlayer as Parameters<typeof canSpendTaklonsPowerWithoutBrain>[0],
                                            3,
                                            1
                                        )
                                    }
                                    onClick={() => onConvertResource('1power-to-1credit', false)}
                                >
                                    1 Power ➔ 1 Credit
                                </Button>
                            ) : (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-10 text-[11px] bg-zinc-900/50 hover:bg-zinc-800"
                                    disabled={!isCurrentTurn || (currentPlayer.power3 ?? 0) < 1}
                                    onClick={() => onConvertResource('1power-to-1credit')}
                                >
                                    {hasNevlasPI ? '1 Power ➔ 2 Credit' : '1 Power ➔ 1 Credit'}
                                </Button>
                            )}
                            {hasNevlasPI && (
                                <>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-10 text-[11px] bg-cyan-900/40 hover:bg-cyan-800/50 border-cyan-500/40"
                                        disabled={!isCurrentTurn || (currentPlayer.power3 ?? 0) < 3}
                                        onClick={() => onConvertResource('3power-to-2ore')}
                                    >
                                        3 Power ➔ 2 Ore
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-10 text-[11px] bg-cyan-900/40 hover:bg-cyan-800/50 border-cyan-500/40"
                                        disabled={!isCurrentTurn || (currentPlayer.power3 ?? 0) < 2}
                                        onClick={() => onConvertResource('2power-to-1ore-1credit')}
                                    >
                                        2 Power ➔ 1 Ore 1 Credit
                                    </Button>
                                </>
                            )}
                            {currentPlayer?.faction === 'nevlas' && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-10 text-[11px] bg-cyan-900/40 hover:bg-cyan-800/50 border-cyan-500/40"
                                    disabled={
                                        !isCurrentTurn ||
                                        (currentPlayer.power3 ?? 0) < 1
                                    }
                                    onClick={() => onConvertResource('1power-to-1k-gaiaformer')}
                                >
                                    1P ➔ 가이어+1K
                                </Button>
                            )}
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-10 text-[11px] bg-zinc-900/50 hover:bg-zinc-800"
                                disabled={!isCurrentTurn || currentPlayer.knowledge < 1}
                                onClick={() => onConvertResource('1knowledge-to-1credit')}
                            >
                                1 Know ➔ 1 Credit
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-10 text-[11px] bg-zinc-900/50 hover:bg-zinc-800"
                                disabled={!isCurrentTurn || (currentPlayer.qic ?? 0) < 1}
                                onClick={() => onConvertResource('1qic-to-1ore')}
                            >
                                1 QIC ➔ 1 Ore
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-10 text-[11px] bg-zinc-900/50 hover:bg-zinc-800"
                                disabled={!isCurrentTurn || (currentPlayer.ore ?? 0) < 1}
                                onClick={() => onConvertResource('1ore-to-1credit')}
                            >
                                1 Ore ➔ 1 Credit
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-10 text-[11px] bg-zinc-900/50 hover:bg-zinc-800"
                                disabled={!isCurrentTurn || (currentPlayer.ore ?? 0) < 1}
                                onClick={() => onConvertResource('1ore-to-1token')}
                            >
                                {isXenos ? '1 Ore ➔ 1 Token to Bowl III' : '1 Ore ➔ 1 Token'}
                            </Button>
                            {hadschPIActions.length > 0 && onUseHadschHallasPIAction && hadschPIActions.map((a) => (
                                <Button
                                    key={a.id}
                                    variant="outline"
                                    size="sm"
                                    className="h-10 text-[11px] bg-amber-950/40 hover:bg-amber-900/50 border-amber-500/30 text-amber-200"
                                    disabled={!isCurrentTurn || (currentPlayer.credits ?? 0) < a.costCredits}
                                    onClick={() => onUseHadschHallasPIAction(a.id)}
                                    title="하드쉬 할라스 의회: 크레딧으로 자원 교환 (무제한 프리액션)"
                                >
                                    {a.label}
                                </Button>
                            ))}
                            {currentPlayer?.faction === 'taklons' ? (
                                <>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-10 text-[11px] bg-zinc-900/50 hover:bg-zinc-800"
                                        disabled={
                                            !isCurrentTurn ||
                                            !canSpendTaklonsPower(currentPlayer as Parameters<typeof canSpendTaklonsPower>[0], 3, 4)
                                        }
                                        onClick={() =>
                                            onConvertResource('4power-to-1knowledge')
                                        }
                                    >
                                        4 Power ➔ 1 Know
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-10 text-[11px] bg-zinc-900/50 hover:bg-zinc-800"
                                    disabled={
                                        !isCurrentTurn ||
                                        (currentPlayer.power3 ?? 0) < (hasNevlasPI ? 2 : 4)
                                    }
                                    onClick={() => onConvertResource('4power-to-1knowledge')}
                                >
                                    {hasNevlasPI ? '2 Power ➔ 1 Know' : '4 Power ➔ 1 Know'}
                                </Button>
                            )}
                            {currentPlayer?.faction === 'bal_tak' &&
                                onUseBalTakGaiaformerToQic &&
                                (() => {
                                    const locked =
                                        (currentPlayer as any).balTakGaiaformersUsedForQic ?? 0;
                                    const effectiveFormers = Math.max(
                                        0,
                                        (currentPlayer.gaiaformers ?? 0) - locked
                                    );
                                    return (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-10 text-[11px] bg-amber-950/40 hover:bg-amber-900/50 border-amber-500/40 text-amber-200"
                                            disabled={!isCurrentTurn || effectiveFormers < 1}
                                            onClick={() => onUseBalTakGaiaformerToQic()}
                                            title={
                                                locked > 0
                                                    ? `포머 ${locked}개 잠김 (다음 라운드 복귀)`
                                                    : undefined
                                            }
                                        >
                                            1 포머 → 1 QIC{locked > 0 ? ` (잠김: ${locked})` : ''}
                                        </Button>
                                    );
                                })()}
                        </div>
                    </div>
                </ScrollArea>
            </DialogContent>
        </Dialog>
    );
}
