/* 로그 감추기·보드 고정·액션 음성이 쓰는 '확정 시점' 규칙 회귀 테스트.
   셋이 각자 계산하다 어긋나서, 턴 종료 후 파워 수령 대기 구간에 보드만 먼저 열리고
   로그는 닫혀 있던 적이 있다(사용자 제보 2026-09-25). 이제 getCommitSeq 하나만 본다.
   또 기준이 뒤로 내려가 이미 보여 준 줄이 도로 감춰지던 적이 있다(사용자 제보 2026-09-29). */
import { getCommitSeq, resetCommitSeqMemo, liveMaxLogSeq, createViewFreeze } from '@/lib/turnCommit';

let bad = 0;
const check = (ok: boolean, name: string, got: unknown, want: unknown) => {
	if (!ok) bad++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — got ${got}, want ${want}`);
};

/** 로그 줄 만들기 — seq 만 쓰인다 */
const logs = (upTo: number) => Array.from({ length: upTo + 1 }, (_, i) => ({ seq: i }));

// ── 1) 기본 규칙 ──
{
	const marks = { a: 10, b: 25, c: 17 };
	const cases: Array<[string, any, number | null]> = [
		['main 단계: 마지막으로 시작된 턴의 seq', { id: 'g1', currentPhase: 'main', turnMark: marks, gameLog: logs(30) }, 25],
		['main 아님(수익 단계) → 감출 것 없음', { id: 'g2', currentPhase: 'income', turnMark: marks, gameLog: logs(30) }, null],
		['turnMark 없음(옛 서버·초기) → 감출 것 없음', { id: 'g3', currentPhase: 'main', gameLog: logs(30) }, null],
		['turnMark 비어 있음 → 감출 것 없음', { id: 'g4', currentPhase: 'main', turnMark: {}, gameLog: logs(30) }, null],
		['턴 종료 후 파워 수령 대기 → 전부 공개', { id: 'g5', currentPhase: 'main', turnMark: marks, pendingTurnEndPlayerId: 'b', gameLog: logs(30) }, null],
		['game 없음', null, null],
		['game undefined', undefined, null],
	];
	for (const [name, game, want] of cases) {
		resetCommitSeqMemo();
		const got = getCommitSeq(game);
		check(got === want, name, got, want);
	}
}

// ── 2) 사용자가 본 깜박임 재현: 공개했다가 되감기면 안 된다 ──
{
	resetCommitSeqMemo();
	const id = 'flicker';
	// ① B의 턴(turnMark=100). B가 seq 101에 연구소를 짓는다 → 남에게는 감춰진다
	const step1 = { id, currentPhase: 'main', turnMark: { a: 90, b: 100 }, gameLog: logs(101) };
	check(getCommitSeq(step1) === 100, '① B 턴 진행 중 — 101은 감춰진다', getCommitSeq(step1), 100);

	// ② B가 턴 종료 → 파워 수령 대기 → 전부 공개(101이 보인다)
	const step2 = { ...step1, pendingTurnEndPlayerId: 'b' };
	check(getCommitSeq(step2) === null, '② 파워 수령 대기 — 전부 공개', getCommitSeq(step2), null);

	// ③ 대기가 풀렸는데 수입 선택 때문에 서버가 turnMark 를 아직 안 올린 순간.
	//    예전엔 여기서 100으로 되돌아가 101이 도로 감춰졌다(= 사용자가 본 '갑자기 안 보임').
	const step3 = { id, currentPhase: 'main', turnMark: { a: 90, b: 100 }, gameLog: logs(101) };
	check(getCommitSeq(step3) === 101, '③ 되감기 금지 — 한 번 공개한 101은 계속 보인다', getCommitSeq(step3), 101);

	// ④ 다음 사람 턴이 시작돼 turnMark 가 올라가면 그 위로만 감춘다
	const step4 = { id, currentPhase: 'main', turnMark: { a: 102, b: 100 }, gameLog: logs(105) };
	check(getCommitSeq(step4) === 102, '④ 다음 턴 시작 — 102 위만 감춘다', getCommitSeq(step4), 102);
}

// ── 3) 롤백으로 로그가 실제로 줄면 워터마크도 내려가야 한다 ──
{
	resetCommitSeqMemo();
	const id = 'rollback';
	getCommitSeq({ id, currentPhase: 'main', turnMark: { a: 50 }, pendingTurnEndPlayerId: 'a', gameLog: logs(60) } as any); // 60까지 공개
	// 롤백 — 로그가 40까지로 줄고 새 턴이 seq 40에서 시작
	const after = { id, currentPhase: 'main', turnMark: { a: 40 }, gameLog: logs(40) };
	const got = getCommitSeq(after as any);
	check(got === 40, '롤백 후 — 워터마크가 40으로 내려간다', got, 40);
}

// ── 4) [사용자 2026-10-01] 실제 롤백 모양: 취소된 줄은 지워지지 않고 rolledBack 으로 높은 seq 그대로 남는다 ──
//   예전엔 그 줄까지 세어 최대 seq 가 안 줄었고, 워터마크가 롤백 전 값(60)에 붙어 있었다
//   → 화면이 롤백 전 보드를 계속 보여 줬다("1번에 짓고 롤백하고 2번에 지어도 1번에 광산이 있다").
{
	resetCommitSeqMemo();
	const id = 'rollback-marked';
	getCommitSeq({ id, currentPhase: 'main', turnMark: { a: 50 }, pendingTurnEndPlayerId: 'a', gameLog: logs(60) } as any); // 60까지 공개
	const kept = logs(40);
	const cancelled = Array.from({ length: 20 }, (_, i) => ({ seq: 41 + i, rolledBack: true }));
	const after = { id, currentPhase: 'main', turnMark: { a: 40 }, gameLog: [...kept, ...cancelled] };
	const got = getCommitSeq(after as any);
	check(got === 40, '롤백 후(취소 줄이 남아 있어도) — 워터마크가 40으로 내려간다', got, 40);
	check(liveMaxLogSeq(after as any) === 40, '살아 있는 최대 seq 는 취소 줄을 뺀 40', liveMaxLogSeq(after as any), 40);

	// 화면 고정기: 롤백 전 확정 보드를 버리고 롤백된 상태를 잡아야 한다
	resetCommitSeqMemo();
	const vf = createViewFreeze();
	const before = { id: 'vf', currentPhase: 'main', turnOrder: ['a', 'b'], currentPlayerIndex: 1, turnMark: { a: 50, b: 61 }, gameLog: logs(61), tag: 'before' };
	vf.view(before as any, 'a');
	const rolled = { id: 'vf', currentPhase: 'main', turnOrder: ['a', 'b'], currentPlayerIndex: 0, turnMark: { a: 40, b: 30 }, gameLog: [...kept, ...cancelled], tag: 'rolled' };
	vf.view(rolled as any, 'b'); // 롤백 직후(알파 차례) — 베타 화면
	const nextTurn = { ...rolled, currentPlayerIndex: 1, turnMark: { a: 40, b: 43 }, gameLog: [...logs(43), ...cancelled.filter(c => c.seq > 43)], tag: 'next' };
	const shown = vf.view(nextTurn as any, 'a') as any; // 베타 차례 시작 — 알파 화면은 이 시점으로 고정
	check(shown.tag === 'next', '화면 고정기 — 롤백 뒤 새 턴 시작 상태를 잡는다(롤백 전 보드를 붙잡지 않음)', shown.tag, 'next');
}

// ── 5) [사용자 2026-10-03] 라운드 시작 처리(아이타·테란·팅커·수익 선택) 대기 중엔 남의 카드를 붙잡지 않는다 ──
{
	const P = (passed: boolean, credits: number) => ({ hasPassed: passed, credits });
	const base = (extra: any) => ({ id: 'rs', currentPhase: 'main', turnOrder: ['A', 'B', 'C', 'D'], ...extra });
	const lastTurn = base({ roundNumber: 1, currentPlayerIndex: 3, turnMark: { A: 40, B: 44, C: 47, D: 50 }, gameLog: logs(50),
		players: { A: P(true, 5), B: P(true, 6), C: P(true, 7), D: P(false, 8) } });
	for (const [name, pending] of [
		['아이타 의회', { pendingItarsGaiaformerExchange: { playerId: 'C', tokensRemaining: 4 } }],
		['테란 의회', { pendingTerranCouncilBenefit: { playerId: 'C', tokenCount: 2 } }],
		['팅커로이드 특수 선택', { pendingTinkeroidSpecialChoice: { playerId: 'C' } }],
		['수익 순서 선택', { pendingIncomeOrder: { playerId: 'C', incomeItems: [], appliedItems: [] } }],
	] as Array<[string, any]>) {
		resetCommitSeqMemo();
		const vf = createViewFreeze();
		vf.view(lastTurn as any, 'B');
		const wait = base({ roundNumber: 2, currentPlayerIndex: 0, turnMark: lastTurn.turnMark, gameLog: logs(58), ...pending,
			players: { A: P(false, 15), B: P(false, 16), C: P(false, 17), D: P(false, 18) } });
		const shown = vf.view(wait as any, 'B') as any;
		const ok = ['A', 'C', 'D'].every((id) => shown.players[id].hasPassed === false && shown.players[id].credits === (wait as any).players[id].credits);
		check(ok && getCommitSeq(wait as any) === null, `${name} 대기 중 — 남의 카드도 수익 받은 실제 상태(감출 것 없음)`, ok ? '실시간' : JSON.stringify(shown.players), '실시간');
	}
	// 안전장치: 대기 표시가 없어도 라운드가 바뀌면 지난 라운드 화면을 버린다
	resetCommitSeqMemo();
	const vf2 = createViewFreeze();
	vf2.view(lastTurn as any, 'B');
	const nextRound = base({ roundNumber: 2, currentPlayerIndex: 0, turnMark: lastTurn.turnMark, gameLog: logs(58),
		players: { A: P(false, 15), B: P(false, 16), C: P(false, 17), D: P(false, 18) } });
	const shown2 = vf2.view(nextRound as any, 'B') as any;
	check(shown2.roundNumber === 2 && shown2.players.A.credits === 15, '라운드가 바뀌면 붙잡던 지난 라운드 화면을 버린다', shown2.roundNumber, 2);
}

console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
process.exit(bad === 0 ? 0 : 1);
