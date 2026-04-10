import type { GameState } from '@/lib/gameClient';

/**
 * 종족 비딩 UI용 플레이어 나열 순서:
 * - 종족·턴 확정자: selectedTurnOrder 오름차순
 * - 미확정: auctionBaseOrder(없으면 turnOrder) 순
 */
export function playerIdsForFactionBiddingUi(
  game: GameState,
  fb: NonNullable<GameState['factionBidding']>
): string[] {
  const ids = game.turnOrder.filter((id) => game.players[id]);
  const baseOrder = fb.auctionBaseOrder.length > 0 ? fb.auctionBaseOrder : ids;

  const picked: string[] = [];
  const waiting: string[] = [];
  for (const id of ids) {
    if (game.players[id]?.faction) picked.push(id);
    else waiting.push(id);
  }

  picked.sort((a, b) => {
    const oa = game.players[a]?.selectedTurnOrder ?? 999;
    const ob = game.players[b]?.selectedTurnOrder ?? 999;
    return oa - ob;
  });

  waiting.sort((a, b) => {
    const ia = baseOrder.indexOf(a);
    const ib = baseOrder.indexOf(b);
    return (ia === -1 ? 9999 : ia) - (ib === -1 ? 9999 : ib);
  });

  return [...picked, ...waiting];
}
