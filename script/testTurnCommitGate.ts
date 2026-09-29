/* 로그 감추기·보드 고정·액션 음성이 쓰는 '확정 시점' 규칙 회귀 테스트.
   셋이 각자 계산하다 어긋나서, 턴 종료 후 파워 수령 대기 구간에 보드만 먼저 열리고
   로그는 닫혀 있던 적이 있다(사용자 제보 2026-09-25). 이제 getCommitSeq 하나만 본다. */
import { getCommitSeq } from '@/lib/turnCommit';

type Case = { name: string; game: any; want: number | null };
const marks = { a: 10, b: 25, c: 17 };
const cases: Case[] = [
	{ name: 'main 단계: 마지막으로 시작된 턴의 seq', game: { currentPhase: 'main', turnMark: marks }, want: 25 },
	{ name: 'main 아님(수익 단계) → 감출 것 없음', game: { currentPhase: 'income', turnMark: marks }, want: null },
	{ name: 'turnMark 없음(옛 서버·초기) → 감출 것 없음', game: { currentPhase: 'main' }, want: null },
	{ name: 'turnMark 비어 있음 → 감출 것 없음', game: { currentPhase: 'main', turnMark: {} }, want: null },
	{ name: '턴 종료 후 파워 수령 대기 → 전부 공개', game: { currentPhase: 'main', turnMark: marks, pendingTurnEndPlayerId: 'b' }, want: null },
	{ name: 'game 없음', game: null, want: null },
	{ name: 'game undefined', game: undefined, want: null },
];

let bad = 0;
for (const c of cases) {
	const got = getCommitSeq(c.game);
	const ok = got === c.want;
	if (!ok) bad++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name} — got ${got}, want ${c.want}`);
}
console.log(bad === 0 ? `\n${cases.length}건 전부 통과` : `\n${bad}건 실패`);
process.exit(bad === 0 ? 0 : 1);
