import type { GaiaGameState as GameState } from '@shared/gameConfig';

/**
 * [사용자 2026-09-25] "상태창에서 자원이 먼저 없어지고 나중에 로그에 연구소 지은 게 뜬다"
 *
 * 로그 감추기(GameLog)와 보드·상태창 고정(Game.tsx viewGame)이 각자 기준을 계산하다가 어긋났다.
 * 이제 둘 다 이 함수 하나만 본다.
 *
 * 반환값
 *   null   — 지금은 감출 것이 없다. 로그도 보드도 실시간.
 *   숫자 N — 로그 seq가 N보다 큰 줄은 아직 되돌릴 수 있는 '진행 중'이라 남에게 감추고,
 *            보드·상태창도 그 시점으로 고정한다.
 *
 * turnMark 는 각자 턴이 시작된 로그 seq다. 그 최댓값 = 지금 턴의 시작점이므로
 * 그보다 큰 줄이 곧 '이번 턴에 방금 한 것들'이다.
 *
 * 턴 종료를 눌러 파워 수령 대기(pendingTurnEndPlayerId)에 들어갔으면 null 을 준다.
 * 그 시점부터는 서버가 리셋을 막아(gameState.ts 'reset' 핸들러) 되돌릴 수 없고,
 * 리치 제안을 받은 사람은 무엇 때문에 제안이 왔는지 보드와 로그 양쪽에서 봐야 한다.
 */
export function getCommitSeq(game: GameState | null | undefined): number | null {
	if (!game || game.currentPhase !== 'main') return null;
	if (game.pendingTurnEndPlayerId) return null;
	const marks = Object.values((game.turnMark ?? {}) as Record<string, number>);
	if (!marks.length) return null;
	return Math.max(...marks);
}
