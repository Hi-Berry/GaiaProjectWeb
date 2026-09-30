/* 로그 감추기·보드 고정·액션 음성이 쓰는 '확정 시점' 규칙 회귀 테스트.
   셋이 각자 계산하다 어긋나서, 턴 종료 후 파워 수령 대기 구간에 보드만 먼저 열리고
   로그는 닫혀 있던 적이 있다(사용자 제보 2026-09-25). 이제 getCommitSeq 하나만 본다.
   또 기준이 뒤로 내려가 이미 보여 준 줄이 도로 감춰지던 적이 있다(사용자 제보 2026-09-29). */
import { getCommitSeq, resetCommitSeqMemo } from '@/lib/turnCommit';

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

console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
process.exit(bad === 0 ? 0 : 1);
