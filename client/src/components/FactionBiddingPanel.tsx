import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { GameState } from '@/lib/gameClient';
import { FACTIONS } from '@shared/gameConfig';
import { GameClient } from '@/lib/gameClient';
import { racePortraitSrc } from '@/lib/racePortrait';
import { playerIdsForFactionBiddingUi } from '@/lib/factionBiddingPlayerOrder';
import { ChevronDown, ChevronUp } from 'lucide-react';

/** 종족 카드: 2열 그리드용, 이미지 비율 유지(contain), 박스는 이미지에 맞춤(불필요한 세로 여백 최소화) */
function RaceCardFrame({
  src,
  name,
  color,
}: {
  src: string | null;
  name: string;
  color?: string;
}) {
  return (
    <div className="w-full bg-zinc-900 flex items-center justify-center py-0.5 px-0.5">
      {src ? (
        <img
          src={src}
          alt={name}
          className="max-w-full w-auto h-auto object-contain max-h-[6.25rem] sm:max-h-[7rem]"
          loading="lazy"
        />
      ) : (
        <div
          className="min-h-[4rem] flex items-center justify-center text-center text-[11px] font-bold text-zinc-400 px-2 py-2 leading-snug"
          style={{ color: color ?? undefined }}
        >
          {name}
        </div>
      )}
    </div>
  );
}

type Props = {
  game: GameState;
  gameId: string;
  playerId: string | null;
};

export function FactionBiddingPanel({ game, gameId, playerId }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [draftBid, setDraftBid] = useState<number | null>(null);
  const [pickFactionId, setPickFactionId] = useState<string | null>(null);

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

  const remainingKey = fb?.remainingFactionIds.join(',') ?? '';

  useEffect(() => {
    if (!isMyPick) {
      setPickFactionId(null);
      return;
    }
    const ids = remainingKey ? remainingKey.split(',') : [];
    setPickFactionId((cur) => (cur && ids.includes(cur) ? cur : null));
  }, [isMyPick, remainingKey]);

  if (!shouldRender) return null;

  const takenTurnOrders = new Set(
    Object.entries(game.players)
      .filter(([id]) => id !== playerId)
      .map(([, p]) => (p as { selectedTurnOrder?: number }).selectedTurnOrder)
      .filter((x): x is number => typeof x === 'number')
  );
  const n = Object.keys(game.players).length;
  const availOrders = Array.from({ length: n }, (_, i) => i + 1).filter((o) => !takenTurnOrders.has(o));

  // 표시용: 아직 아무도 안 고른(미할당) 턴 순서 (모든 플레이어 기준)
  const allTakenTurnOrders = new Set(
    Object.values(game.players)
      .map((p) => (p as { selectedTurnOrder?: number }).selectedTurnOrder)
      .filter((x): x is number => typeof x === 'number')
  );
  const remainingTurnOrders = Array.from({ length: n }, (_, i) => i + 1).filter((o) => !allTakenTurnOrders.has(o));

  const needsAttention =
    (fb.phase === 'bidding' && isMyBidTurn) || (fb.phase === 'pick' && isMyPick);

  const panelPlayerOrder = playerIdsForFactionBiddingUi(game, fb);

  if (collapsed) {
    return (
      <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[130] w-[min(96vw,520px)] pointer-events-none flex justify-center">
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
    <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[130] w-[min(96vw,520px)] max-h-[85vh] overflow-y-auto bg-zinc-950/95 border border-amber-500/40 rounded-xl p-4 shadow-2xl">
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

      {isPick && isMyPick && (
        <p className="text-center text-sm text-emerald-300 mb-3">
          낙찰! 낙찰가 {fb.pendingWinningBid} VP — 아래 종족을 누른 뒤 턴 순서를 고르세요.
        </p>
      )}

      <div className="mb-3 rounded-lg border border-zinc-700 bg-zinc-900/80 p-2">
        <p className="text-[10px] uppercase text-zinc-500 mb-2">이번에 고를 수 있는 종족</p>
        <div className="grid grid-cols-2 gap-2 sm:gap-3">
          {fb.remainingFactionIds.map((fid) => {
            const f = FACTIONS.find((x) => x.id === fid);
            const src = racePortraitSrc(fid);
            const name = f?.name ?? fid;
            if (isPick && isMyPick) {
              const selected = pickFactionId === fid;
              return (
                <button
                  key={fid}
                  type="button"
                  className={`rounded-lg border-2 overflow-hidden text-left transition-all hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 min-w-0 ${
                    selected ? 'border-amber-400 ring-1 ring-amber-400/40' : 'border-zinc-700'
                  }`}
                  onClick={() => {
                    if (availOrders.length === 1) {
                      GameClient.factionBidPick(gameId, fid, availOrders[0]!);
                      return;
                    }
                    setPickFactionId(fid);
                  }}
                  aria-label={`${name} 선택`}
                  title={availOrders.length === 1 ? `${name} — 즉시 선택` : name}
                >
                  <RaceCardFrame src={src} name={name} color={f?.color} />
                </button>
              );
            }
            return (
              <div
                key={fid}
                className="rounded-lg border border-zinc-700 bg-zinc-950/60 overflow-hidden shadow-sm min-w-0"
                title={name}
              >
                <RaceCardFrame src={src} name={name} color={f?.color} />
              </div>
            );
          })}
        </div>
      </div>

      {remainingTurnOrders.length > 0 && (
        <div className="mb-3 rounded-lg border border-zinc-700 bg-zinc-900/60 p-2">
          <p className="text-[10px] uppercase text-zinc-500 mb-1.5">아직 안 고른 턴 순서</p>
          <div className="flex flex-wrap gap-1.5">
            {remainingTurnOrders.map((ord) => (
              <span
                key={ord}
                className="inline-flex min-w-[2.75rem] items-center justify-center rounded border border-amber-500/40 bg-amber-950/30 px-2 py-1 text-xs font-mono tabular-nums text-amber-200"
              >
                턴 {ord}
              </span>
            ))}
          </div>
        </div>
      )}

      {isPick && isMyPick && pickFactionId && availOrders.length > 1 && (
        <div className="mb-3 rounded-lg border border-zinc-700 bg-zinc-900/60 p-2 space-y-2">
          <p className="text-[10px] uppercase text-zinc-500 text-center">내 턴 순서 고르기</p>
          <div className="flex flex-wrap gap-2 justify-center">
            {availOrders.map((ord) => (
              <Button
                key={ord}
                size="sm"
                variant="secondary"
                className="min-w-[4.5rem] text-xs"
                onClick={() => GameClient.factionBidPick(gameId, pickFactionId, ord)}
              >
                턴 {ord}
              </Button>
            ))}
          </div>
        </div>
      )}

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

      <div className="mt-4 border-t border-zinc-800 pt-2">
        <p className="text-zinc-500 uppercase text-[9px] tracking-wider mb-1.5">플레이어</p>
        <p className="text-[9px] text-zinc-600 mb-1.5 leading-snug">
          확정: 턴 순 · 진행 중: 입찰 순서
        </p>
        <div className="space-y-1">
          {panelPlayerOrder.map((id) => {
            const p = game.players[id];
            if (!p) return null;
            const bid = p.factionBidVp ?? 0;
            const isBot = game.botPlayerIds?.includes(id);
            const hasF = !!p.faction;
            const lastAuctionBid = p.factionAuctionLastBid;
            let label = '';
            let titleExtra = '';
            if (hasF) label = `${bid}VP`;
            else if (isBot) label = 'AI';
            else if (fb.phase === 'bidding' && fb.inAuction.includes(id)) {
              if (lastAuctionBid != null && lastAuctionBid > 0) {
                label = `입찰중 ${lastAuctionBid}`;
                titleExtra = `마지막 입찰 ${lastAuctionBid}VP`;
              } else {
                label = '입찰중';
                titleExtra = '아직 입찰 전';
              }
            } else if (fb.phase === 'bidding') label = '패스';
            else if (fb.phase === 'pick' && fb.pickPlayerId === id) label = '선택';
            else label = '대기';
            return (
              <div key={id} className="flex items-center justify-between gap-2 min-h-[28px]">
                <span className="truncate text-[11px] text-zinc-200 min-w-0 flex-1">
                  {hasF && p.selectedTurnOrder != null && (
                    <span className="text-zinc-500 font-mono tabular-nums mr-1">[{p.selectedTurnOrder}]</span>
                  )}
                  {p.name}
                  {isBot && <span className="text-zinc-500"> · BOT</span>}
                </span>
                <span
                  className="shrink-0 inline-flex min-w-[3.25rem] max-w-[7rem] items-center justify-center rounded border border-zinc-600/70 bg-zinc-900/80 px-1.5 py-1 text-[10px] leading-tight text-zinc-400 tabular-nums text-center shadow-sm"
                  title={titleExtra || label}
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
