import type { GaiaGameState as GameState } from '@shared/gameConfig';

/**
 * [사용자 2026-09-25] "상태창에서 자원이 먼저 없어지고 나중에 로그에 연구소 지은 게 뜬다"
 *
 * 로그 감추기(GameLog)·보드 고정(Game.tsx viewGame)·액션 음성이 각자 기준을 계산하다가 어긋났다.
 * 이제 셋 다 이 함수 하나만 본다.
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
 *
 * [사용자 2026-09-29] "상대 로그가 보였다가 갑자기 안 보이다가 다음 사람이 액션하면 같이 보인다"
 *   기준이 뒤로 내려가는 구간이 있었다. 서버는 다음 사람 턴이 시작될 때 turnMark 를 올리는데
 *   (captureTurnStartWithPrev), 수입 선택이 걸려 있으면 그 갱신을 건너뛴다(gameState.ts 의
 *   `if (game.pendingIncomeOrder) return`). 그래서 '파워 수령 대기(전부 공개) → 대기 해소
 *   → 아직 옛 turnMark' 순서로 흐르면 방금 보여 준 줄이 도로 감춰졌다가, 다음 사람이 움직여
 *   turnMark 가 올라가면 다시 나타났다.
 *   → 한 번 공개한 줄은 다시 감추지 않는다. 게임별로 '이미 공개한 최대 seq'를 들고 그 아래로는
 *     절대 내려가지 않는다. 서버 어느 경로에서 갱신이 늦든 화면은 흔들리지 않는다.
 *     롤백으로 로그가 실제로 뒤로 가면(최대 seq 자체가 줄면) 워터마크도 같이 내린다.
 */

/** 게임별 '이미 공개한 최대 로그 seq'. 되돌아가지 않게 붙잡아 두는 값. */
const revealed = new Map<string, number>();

/**
 * 살아 있는(롤백으로 취소되지 않은) 로그 줄의 최대 seq.
 * [사용자 2026-10-01] "1번에 짓고 롤백하고 2번에 지어도 1번에 광산이 있다. 새로고침하면 2번에 있다."
 *   롤백된 행동은 지우지 않고 rolledBack 표시로 로그에 남긴다(빨간 줄). 그 줄들까지 세면 롤백 뒤에도 최대 seq 가
 *   줄지 않아, 아래 워터마크가 '롤백이 일어났다'를 알아채지 못하고 롤백 전 높은 값에 그대로 붙어 있었다.
 *   그러면 화면 고정(viewGame)이 롤백 전 보드를 계속 붙잡고, 로그도 새 진행 중 액션을 남에게 일찍 보여 준다.
 *   서버는 롤백 때 seq 카운터도 되감아 새 행동이 같은 번호를 다시 쓴다 — 취소된 줄은 반드시 빼고 센다.
 */
export function liveMaxLogSeq(game: GameState): number | null {
	const logs = game.gameLog ?? [];
	let m: number | null = null;
	for (const e of logs) {
		if ((e as { rolledBack?: boolean }).rolledBack) continue;
		const s = (e as { seq?: number }).seq;
		if (typeof s === 'number' && (m === null || s > m)) m = s;
	}
	return m;
}

/**
 * [사용자 2026-10-03] "아이타 의회 처리할 때 일부는 수익 받은 활성 상태, 일부는 지난 라운드 패스 상태+옛 자원으로 보인다."
 * 서버는 라운드가 넘어가 수익을 주고 팅커로이드·아이타·테란 선택을 기다리는 동안에도 단계를 'main' 으로 두고,
 * 새 라운드 첫 턴의 turnMark 는 그 선택이 다 끝난 뒤에야 찍는다. 그래서 이 대기를 '지난 라운드 마지막 턴이
 * 아직 진행 중'으로 잘못 봐 남의 카드를 그 턴 시작 시점(패스 상태·옛 자원)에 붙잡고, 수익 로그도 감췄다.
 * 이 구간은 누군가의 되돌릴 수 있는 행동이 아니라 라운드 시작 처리다 → 감출 것 없음(전부 실시간).
 */
export function isRoundStartPending(game: GameState): boolean {
	const g = game as GameState & Record<string, any>;
	return !!(g.pendingIncomeOrder
		|| g.pendingTinkeroidSpecialChoice
		|| g.pendingItarsGaiaformerExchange
		|| g.pendingTerranCouncilBenefit
		|| (g.terranCouncilQueue?.length ?? 0) > 0
		|| (g.terranCouncilQueueAfterItars?.length ?? 0) > 0
		|| g.pendingTechTileSelection?.structureType === 'itars_pi_exchange');
}

export function getCommitSeq(game: GameState | null | undefined): number | null {
	if (!game) return null;

	const marks = Object.values((game.turnMark ?? {}) as Record<string, number>);
	const raw = (game.currentPhase !== 'main' || game.pendingTurnEndPlayerId || !marks.length || isRoundStartPending(game))
		? null
		: Math.max(...marks);

	const id = (game as { id?: string }).id;
	if (!id) return raw; // 게임 id를 모르면 붙잡아 둘 곳이 없다 — 원래 값 그대로

	const top = liveMaxLogSeq(game);
	let wm = revealed.get(id) ?? -1;
	// 롤백으로 로그가 실제로 뒤로 갔으면 워터마크도 내린다(안 내리면 새 턴의 진행 중 액션이 노출된다)
	if (top !== null && wm > top) wm = top;

	if (raw === null) {
		// 전부 공개되는 구간 — 지금까지의 줄은 '공개됨'으로 확정해 둔다
		if (top !== null) wm = Math.max(wm, top);
	} else {
		wm = Math.max(wm, raw);
	}

	if (revealed.size > 8 && !revealed.has(id)) revealed.clear(); // 오래된 게임 id 정리
	revealed.set(id, wm);
	return raw === null ? null : wm;
}

/** 테스트용 — 게임별 워터마크를 지운다 */
export function resetCommitSeqMemo(): void {
	revealed.clear();
}

/**
 * 화면 표시용 상태 고르기(Game.tsx viewGame) — 남의 턴 진행 중엔 그 턴 시작 시점으로 고정한다.
 * 컴포넌트마다 하나씩(useRef) 만들어 렌더마다 view() 를 부른다.
 */
export function createViewFreeze() {
	let lastSeq: number | null | undefined;
	let lastTop: number | null = null;
	let committed: GameState | null = null;
	return {
		view<T extends GameState>(game: T, myPlayerId: string | null | undefined): T {
			const seq = getCommitSeq(game);
			// 롤백(또는 턴 리셋)으로 살아 있는 로그의 끝이 뒤로 갔다 = 그 시점 상태로 통째로 바뀌었다.
			// 확정 시점 값이 우연히 같게 나와도 붙잡고 있던 옛 보드를 반드시 버린다.
			const top = liveMaxLogSeq(game);
			const rewound = top !== null && lastTop !== null && top < lastTop;
			lastTop = top;
			// 라운드가 바뀌었으면 붙잡고 있던 건 무조건 지난 라운드 화면이다 — 안전장치로 버린다
			const newRound = !!committed && committed.roundNumber !== game.roundNumber;
			if (seq === null || seq !== lastSeq || rewound || newRound || !committed) { lastSeq = seq; committed = game; }
			const myTurn = !!myPlayerId && game.turnOrder?.[game.currentPlayerIndex] === myPlayerId;
			return (!myTurn && seq !== null && committed) ? committed as T : game;
		},
	};
}
