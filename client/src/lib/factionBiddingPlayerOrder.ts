import type { GameState } from '@/lib/gameClient';

/**
 * 종족 비딩 UI용 플레이어 나열 순서 = "턴 순서판"처럼 슬롯(1..N)에 맞춰 배치.
 * - 종족·턴 확정자(봇 포함): 자기 selectedTurnOrder 슬롯에 고정 배치
 * - 미확정(아직 입찰 중): 남은 빈 슬롯을 auctionBaseOrder(없으면 turnOrder) 순으로 채움
 *
 * 기존엔 '확정자 먼저, 미확정 나중'이라 봇이 3·4턴인데도 목록 1·2번에 떠서
 * 턴 위치와 표시 위치가 어긋났음(사용자 관찰). 이제 표시 순서가 곧 턴 슬롯 순서다.
 */
export function playerIdsForFactionBiddingUi(
  game: GameState,
  fb: NonNullable<GameState['factionBidding']>
): string[] {
  const ids = game.turnOrder.filter((id) => game.players[id]);
  const n = ids.length;
  const baseOrder = fb.auctionBaseOrder.length > 0 ? fb.auctionBaseOrder : ids;

  const slots: (string | null)[] = new Array(n).fill(null);
  const waiting: string[] = [];

  for (const id of ids) {
    const ord = game.players[id]?.selectedTurnOrder;
    const confirmed = !!game.players[id]?.faction;
    if (confirmed && typeof ord === 'number' && ord >= 1 && ord <= n && slots[ord - 1] == null) {
      slots[ord - 1] = id;
    } else {
      waiting.push(id);
    }
  }

  waiting.sort((a, b) => {
    const ia = baseOrder.indexOf(a);
    const ib = baseOrder.indexOf(b);
    return (ia === -1 ? 9999 : ia) - (ib === -1 ? 9999 : ib);
  });

  // 남은 빈 슬롯을 입찰 순서대로 채움
  let w = 0;
  for (let i = 0; i < n && w < waiting.length; i++) {
    if (slots[i] == null) slots[i] = waiting[w++];
  }
  // 혹시 모를 잔여(슬롯보다 미확정이 많을 일은 없지만 방어)
  while (w < waiting.length) slots.push(waiting[w++]);

  return slots.filter((x): x is string => !!x);
}
