import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { GameState } from '@/lib/gameClient';
import { FACTIONS } from '@shared/gameConfig';
import { GameClient } from '@/lib/gameClient';
import { ChevronDown, ChevronUp } from 'lucide-react';

type Props = {
  game: GameState;
  gameId: string;
  playerId: string | null;
};

export function FactionBiddingPanel({ game, gameId, playerId }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [draftBid, setDraftBid] = useState<number | null>(null);

  const fb = game.factionBidding;
  const shouldRender = !!fb && game.currentPhase === 'factionBidding';

  // NOTE: Hooks must be called in the same order every render.
  // So we compute safe defaults when fb is null and only early-return after hooks.
  const minRaise = fb ? (fb.currentHighBid === 0 ? 1 : fb.currentHighBid + 1) : 1;
  const isPick = fb?.phase === 'pick';
  const isMyPick = !!fb && isPick && fb.pickPlayerId === playerId;
  const isMyBidTurn = fb?.phase === 'bidding' && fb.currentBidderId === playerId;

  const effectiveDraftBid = useMemo(() => {
    if (!isMyBidTurn) return null;
    const base = draftBid ?? minRaise;
    return Math.max(minRaise, base);
  }, [draftBid, isMyBidTurn, minRaise]);

  useEffect(() => {
    if (!isMyBidTurn) {
      setDraftBid(null);
      return;
    }
    setDraftBid((prev) => {
      if (prev == null) return minRaise;
      if (prev < minRaise) return minRaise;
      return prev;
    });
  }, [isMyBidTurn, minRaise]);

  if (!shouldRender) return null;

  const takenTurnOrders = new Set(
    Object.entries(game.players)
      .filter(([id]) => id !== playerId)
      .map(([, p]) => (p as { selectedTurnOrder?: number }).selectedTurnOrder)
      .filter((x): x is number => typeof x === 'number')
  );
  const n = Object.keys(game.players).length;
  const availOrders = Array.from({ length: n }, (_, i) => i + 1).filter((o) => !takenTurnOrders.has(o));

  const needsAttention =
    (fb.phase === 'bidding' && isMyBidTurn) || (fb.phase === 'pick' && isMyPick);

  if (collapsed) {
    return (
      <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[60] w-[min(96vw,520px)] pointer-events-none flex justify-center">
        <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 px-3 py-1.5 rounded-full bg-zinc-950/95 border border-amber-500/50 shadow-xl shadow-black/40">
          <span className="text-xs font-orbitron font-bold text-amber-200">종족 비딩</span>
          {fb.phase === 'bidding' && (
            <span className="text-[11px] text-zinc-400">
              최고 {fb.currentHighBid} · 차례{' '}
              <span className="text-zinc-200">
                {fb.currentBidderId ? game.players[fb.currentBidderId]?.name : '—'}
              </span>
            </span>
          )}
          {fb.phase === 'pick' && fb.pickPlayerId && (
            <span className="text-[11px] text-emerald-400/90">
              낙찰: {game.players[fb.pickPlayerId]?.name}
            </span>
          )}
          {needsAttention && (
            <Badge className="bg-amber-600 hover:bg-amber-600 text-[10px] px-1.5 py-0">내 차례</Badge>
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 text-[11px] gap-1 px-2"
            onClick={() => setCollapsed(false)}
          >
            <ChevronDown className="w-3.5 h-3.5" />
            펼치기
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[60] w-[min(96vw,520px)] max-h-[85vh] overflow-y-auto bg-zinc-950/95 border border-amber-500/40 rounded-xl p-4 shadow-2xl">
      <div className="relative mb-2 pr-1">
        <h2 className="text-lg font-orbitron font-bold text-amber-200 text-center">종족 비딩</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="absolute right-0 top-1/2 -translate-y-1/2 h-8 text-zinc-400 hover:text-amber-200 hover:bg-amber-950/50 gap-1"
          onClick={() => setCollapsed(true)}
          title="접기 (맵 보기)"
        >
          <ChevronUp className="w-4 h-4" />
          <span className="text-[11px]">접기</span>
        </Button>
      </div>

      <div className="mb-3 rounded-lg border border-zinc-700 bg-zinc-900/80 p-2">
        <p className="text-[10px] uppercase text-zinc-500 mb-1">이번에 고를 수 있는 종족</p>
        <div className="flex flex-wrap gap-2 justify-center">
          {fb.remainingFactionIds.map((fid) => {
            const f = FACTIONS.find((x) => x.id === fid);
            return (
              <Badge
                key={fid}
                className="text-xs font-bold border"
                style={{ borderColor: f?.color ?? '#666', color: f?.color ?? '#fff' }}
              >
                {f?.name ?? fid}
              </Badge>
            );
          })}
        </div>
      </div>

      {fb.phase === 'bidding' && (
        <div className="text-center text-sm text-zinc-300 mb-3 space-y-1">
          <p>
            현재 최고가: <span className="text-amber-400 font-bold">{fb.currentHighBid}</span>
            {fb.leaderId && game.players[fb.leaderId] && (
              <span className="text-zinc-500"> ({game.players[fb.leaderId].name})</span>
            )}
          </p>
          <p>
            차례:{' '}
            <span className="text-white font-semibold">
              {fb.currentBidderId ? game.players[fb.currentBidderId]?.name : '—'}
            </span>
          </p>
        </div>
      )}

      {fb.phase === 'bidding' && isMyBidTurn && (
        <div className="mb-3 space-y-2">
          <div className="flex items-center justify-center gap-2">
            <span className="text-xs text-zinc-400">입찰</span>
            <span className="text-sm font-bold text-amber-300 tabular-nums">{effectiveDraftBid ?? minRaise}</span>
          </div>

          <div className="flex flex-wrap gap-1.5 justify-center">
            {[-10, -5, -1].map((d) => (
              <Button
                key={d}
                size="sm"
                variant="outline"
                className="h-8 px-2 text-xs tabular-nums"
                disabled={effectiveDraftBid == null || (effectiveDraftBid + d) < minRaise}
                onClick={() => setDraftBid((prev) => (prev ?? minRaise) + d)}
                title="되돌리기"
              >
                {d}
              </Button>
            ))}
            {[1, 5, 10].map((d) => (
              <Button
                key={d}
                size="sm"
                variant="secondary"
                className="h-8 px-2 text-xs tabular-nums"
                disabled={effectiveDraftBid == null}
                onClick={() => setDraftBid((prev) => (prev ?? minRaise) + d)}
                title="더 올리기"
              >
                +{d}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2 justify-center">
            <Button
              className="bg-amber-600 hover:bg-amber-500"
              disabled={effectiveDraftBid == null || effectiveDraftBid < minRaise}
              onClick={() => effectiveDraftBid != null && GameClient.factionBidRaise(gameId, effectiveDraftBid)}
            >
              입찰
            </Button>
            <Button
              variant="outline"
              onClick={() => GameClient.factionBidPass(gameId)}
              title="이번 경매에서 빠집니다"
            >
              Pass
            </Button>
          </div>
        </div>
      )}

      {isPick && isMyPick && (
        <div className="space-y-3">
          <p className="text-center text-sm text-emerald-300">
            낙찰! 낙찰가 {fb.pendingWinningBid} VP — 종족과 턴 순서를 고르세요.
          </p>
          <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
            {fb.remainingFactionIds.flatMap((fid) => {
              const f = FACTIONS.find((x) => x.id === fid);
              return availOrders.map((ord) => (
                <Button
                  key={`${fid}-${ord}`}
                  size="sm"
                  variant="secondary"
                  className="text-xs justify-between"
                  onClick={() => GameClient.factionBidPick(gameId, fid, ord)}
                >
                  <span>{f?.name ?? fid}</span>
                  <span className="text-zinc-400">턴 {ord}</span>
                </Button>
              ));
            })}
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-zinc-800 pt-2">
        <p className="text-zinc-500 uppercase text-[9px] tracking-wider mb-1.5">플레이어</p>
        <div className="space-y-1">
          {game.turnOrder.map((id) => {
            const p = game.players[id];
            if (!p) return null;
            const bid = p.factionBidVp ?? 0;
            const isBot = game.botPlayerIds?.includes(id);
            const hasF = !!p.faction;
            let label = '';
            if (hasF) label = `${bid}VP`;
            else if (isBot) label = 'AI';
            else if (fb.phase === 'bidding' && fb.inAuction.includes(id)) label = '입찰중';
            else if (fb.phase === 'bidding') label = '탈락';
            else if (fb.phase === 'pick' && fb.pickPlayerId === id) label = '선택';
            else label = '대기';
            return (
              <div key={id} className="flex items-center justify-between gap-2 min-h-[28px]">
                <span className="truncate text-[11px] text-zinc-200 min-w-0 flex-1">
                  {p.name}
                  {isBot && <span className="text-zinc-500"> · BOT</span>}
                </span>
                <span
                  className="shrink-0 inline-flex min-w-[3.25rem] items-center justify-center rounded border border-zinc-600/70 bg-zinc-900/80 px-2 py-1 text-[10px] leading-none text-zinc-400 tabular-nums text-center shadow-sm"
                  title={label}
                >
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
