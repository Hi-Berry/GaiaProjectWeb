import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { GameState } from '@/lib/gameClient';
import { FACTIONS, PLANET_COLORS } from '@shared/gameConfig';
import { GameClient } from '@/lib/gameClient';
import { racePortraitSrc } from '@/lib/racePortrait';
import { playerIdsForFactionBiddingUi } from '@/lib/factionBiddingPlayerOrder';

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

/**
 * 종족 비딩 패널 — 우측 사이드바(상태창+로그) 영역을 통째로 덮는 오버레이.
 * 비딩 중엔 상태창을 볼 필요가 없고, 가운데를 비워 맵/미니뷰를 보며 비딩할 수 있게 함(사용자 요청).
 * 접기 기능은 제거(상시 표시).
 */
export function FactionBiddingPanel({ game, gameId, playerId }: Props) {
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

  // [3삽 표기 2026-07-27 사용자] 모웨이드/팅커로이드 3삽(테라포밍 확장) 행성을 비딩 창에 표기 — 로그창은 비딩 중 안 보이므로.
  //   3삽 = 다른 종족들의 홈행성. 봇은 비딩 시작 시 배정돼 알 수 있어, '이 종족을 잡으면 3삽이 뭔지' 판단에 도움.
  const expansionInfo = useMemo(() => {
    const players = Object.values(game.players);
    // [2026-07-27 사용자] 비딩 풀은 시작 시 확정 → 배정된 사람만 보지 말고 풀(배정+잔여) 기준으로 처음부터
    // 완성된 3삽 목록 표시 (기존: 비딩 하나 끝날 때마다 목록이 자라 보임)
    const assignedFacs = players.map(p => p.faction).filter((f): f is string => !!f);
    const poolFacs = fb?.remainingFactionIds ?? [];
    const gameFacs = Array.from(new Set([...assignedFacs, ...poolFacs]));
    const poolComplete = gameFacs.length >= players.length;
    const out: { key: string; label: string; planets: string[]; note: string }[] = [];
    for (const fac of ['moweyip', 'tinkeroids'] as const) {
      if (!gameFacs.includes(fac)) continue; // 게임에 없는 확장 종족은 표시 안 함
      const homes = Array.from(new Set(
        gameFacs.filter(f => f !== 'moweyip' && f !== 'tinkeroids')
          .map(f => FACTIONS.find(x => x.id === f)?.homePlanet)
          .filter((h): h is NonNullable<ReturnType<typeof Object>> & string => !!h)
      ));
      const label = fac === 'moweyip' ? '모웨이드' : '팅커로이드';
      const note = !poolComplete ? '(종족 풀 확정 후)' : homes.length > 3 ? '(이 중 3개 랜덤)' : homes.length < 3 ? '(+랜덤 보충)' : '';
      out.push({ key: fac, label, planets: homes, note });
    }
    return out;
  }, [game.players, fb]);

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

  return (
    <div className="absolute inset-0 z-[140] flex flex-col bg-zinc-950 border-l border-amber-500/40">
      {/* 헤더(고정) */}
      <div className="shrink-0 px-4 py-3 border-b border-amber-500/30 bg-zinc-950/80">
        <div className="flex items-center justify-center gap-2">
          <h2 className="text-base font-orbitron font-bold text-amber-200 text-center">종족 비딩</h2>
          {needsAttention && (
            <Badge className="bg-amber-600 hover:bg-amber-600 text-[10px] px-1.5 py-0">내 차례</Badge>
          )}
        </div>
        {fb.phase === 'bidding' && (
          <p className="mt-1 text-center text-[11px] text-zinc-400">
            최고가 <span className="text-amber-400 font-bold tabular-nums">{fb.currentHighBid}</span>
            {fb.leaderId && game.players[fb.leaderId] && (
              <span className="text-zinc-500"> ({game.players[fb.leaderId].name})</span>
            )}
            <span className="mx-1 text-zinc-700">·</span>
            차례{' '}
            <span className="text-white font-semibold">
              {fb.currentBidderId ? game.players[fb.currentBidderId]?.name : '—'}
            </span>
          </p>
        )}
        {fb.phase === 'pick' && fb.pickPlayerId && (
          <p className="mt-1 text-center text-[11px] text-emerald-400/90">
            낙찰: {game.players[fb.pickPlayerId]?.name} ({fb.pendingWinningBid} VP)
          </p>
        )}
      </div>

      {/* 모웨/팅커 확장 3삽 표기 — 비딩 판단용. 두 확장종족 공존 시 고정+A/B(추첨), 아니면 종족별 3삽. */}
      {(() => {
        const col = (pl: string) => (PLANET_COLORS as Record<string, string>)[pl];
        const td = (game as unknown as { expansionTwoFactionDraw?: { fixed: string[]; drawA: string[]; drawB: string[] } | null }).expansionTwoFactionDraw;
        if (td) {
          return (
            <div className="shrink-0 px-4 py-2 border-b border-amber-500/20 bg-zinc-900/60 text-[11px] space-y-0.5">
              <div className="flex flex-wrap items-center gap-1 leading-snug">
                <span className="text-zinc-400 font-semibold">확장 공용 3삽(모웨·팅커):</span>
                {td.fixed.map((p, i) => <span key={i} className="font-black" style={{ color: col(p) }}>{p}</span>)}
              </div>
              <div className="flex flex-wrap items-center gap-1 leading-snug">
                <span className="text-amber-300 font-bold">A:</span>
                {td.drawA.map((p, i) => <span key={`a${i}`} className="font-black" style={{ color: col(p) }}>{p}</span>)}
                <span className="mx-1 text-zinc-700">·</span>
                <span className="text-amber-300 font-bold">B:</span>
                {td.drawB.map((p, i) => <span key={`b${i}`} className="font-black" style={{ color: col(p) }}>{p}</span>)}
                <span className="text-zinc-500">(턴 빠른 확장종족=A, 느린=B)</span>
              </div>
            </div>
          );
        }
        if (expansionInfo.length === 0) return null;
        return (
          <div className="shrink-0 px-4 py-2 border-b border-amber-500/20 bg-zinc-900/60 text-[11px] space-y-0.5">
            {expansionInfo.map(e => (
              <div key={e.key} className="flex flex-wrap items-center gap-1 leading-snug">
                <span className="text-zinc-400 font-semibold">{e.label} 3삽:</span>
                {e.planets.length === 0
                  ? <span className="text-zinc-500">—</span>
                  : e.planets.map((p, i) => (
                      <span key={i} className="font-black" style={{ color: col(p) }}>{p}</span>
                    ))}
                {e.note && <span className="text-zinc-500">{e.note}</span>}
              </div>
            ))}
          </div>
        );
      })()}

      {/* 본문(스크롤) */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 space-y-3">
        {isPick && isMyPick && (
          <p className="text-center text-sm text-emerald-300">
            낙찰! 낙찰가 {fb.pendingWinningBid} VP — 아래 종족을 누른 뒤 턴 순서를 고르세요.
          </p>
        )}

        <div className="rounded-lg border border-zinc-700 bg-zinc-900/80 p-2">
          <p className="text-[10px] uppercase text-zinc-500 mb-2">이번에 고를 수 있는 종족</p>
          <div className="grid grid-cols-2 gap-2">
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
          <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 p-2">
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
          <div className="rounded-lg border border-zinc-700 bg-zinc-900/60 p-2 space-y-2">
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

        {fb.phase === 'bidding' && isMyBidTurn && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-950/20 p-2 space-y-2">
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

        {/* 플레이어 = 턴 순서판(1..N 슬롯 순). 확정자(봇 포함)는 종족색·종족명·턴번호로 표시 */}
        <div className="border-t border-zinc-800 pt-2">
          <p className="text-zinc-500 uppercase text-[9px] tracking-wider mb-1.5">플레이어 (턴 순서)</p>
          <div className="space-y-1">
            {panelPlayerOrder.map((id, idx) => {
              const p = game.players[id];
              if (!p) return null;
              const bid = p.factionBidVp ?? 0;
              const isBot = game.botPlayerIds?.includes(id);
              const hasF = !!p.faction;
              const fac = hasF ? FACTIONS.find((x) => x.id === p.faction) : undefined;
              const facColor = fac?.color ?? '#71717a';
              const slotNo = hasF && p.selectedTurnOrder != null ? p.selectedTurnOrder : idx + 1;
              const lastAuctionBid = p.factionAuctionLastBid;

              let label = '';
              let titleExtra = '';
              if (hasF) label = `${bid}VP`;
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

              const isCurrentBidder = fb.phase === 'bidding' && fb.currentBidderId === id;

              return (
                <div
                  key={id}
                  className={`flex items-center gap-2 min-h-[30px] rounded px-1.5 py-1 border ${
                    isCurrentBidder ? 'border-amber-500/50 bg-amber-950/25' : 'border-transparent'
                  }`}
                  style={hasF ? { borderLeft: `3px solid ${facColor}` } : undefined}
                >
                  {/* 턴 슬롯 번호 */}
                  <span
                    className="shrink-0 inline-flex w-5 h-5 items-center justify-center rounded text-[10px] font-bold tabular-nums"
                    style={{ backgroundColor: hasF ? facColor : '#3f3f46', color: hasF ? '#000' : '#a1a1aa' }}
                    title={`턴 ${slotNo}`}
                  >
                    {slotNo}
                  </span>

                  <span className="flex-1 min-w-0 leading-tight">
                    <span className="block truncate text-[11px] text-zinc-100">
                      {p.name}
                      {isBot && <span className="text-zinc-500"> · BOT</span>}
                    </span>
                    {hasF && (
                      <span className="block truncate text-[10px] font-semibold" style={{ color: facColor }}>
                        {fac?.name ?? p.faction}
                      </span>
                    )}
                  </span>

                  <span
                    className="shrink-0 inline-flex min-w-[3.25rem] max-w-[7rem] items-center justify-center rounded border border-zinc-600/70 bg-zinc-900/80 px-1.5 py-1 text-[10px] leading-tight text-zinc-300 tabular-nums text-center shadow-sm"
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
    </div>
  );
}
