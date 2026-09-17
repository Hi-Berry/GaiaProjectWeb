/**
 * Game.tsx applyAuthoritativeGame의 프리액션 stale-스킵 판정을 GameClient 상태로 재현.
 * 사용자 제보(2026-09-17): 0/4/1에서 번 후 Undo Undo → 화면이 0/2/2에서 멈춤. 서버는 정상(script/testBurnUndo.ts 3시나리오 통과),
 * 원인은 클라가 둘째 undo 응답(카운트 하강)을 stale로 버린 것. 재현 조건: 프리액션 3개(변환1+번2) + 응답 전 빠른 undo 2회.
 * 사용: npx tsx script/testUndoSkipLogic.ts
 */
import { GameClient } from '../client/src/lib/gameClient';

function apply(serverFreeCount: number, isSelfTurn = true, hasDone = false): 'skip' | 'apply' {
	const bursting = true;
	const undoPending = GameClient.pendingUndoCount() > 0;
	const baseline = GameClient.getLastAppliedServerFreeCount();
	if (isSelfTurn && !hasDone && bursting && !undoPending && serverFreeCount > 0 && serverFreeCount < baseline) return 'skip';
	GameClient.syncOptimisticFreeCount(serverFreeCount);
	if (serverFreeCount === 0 || !isSelfTurn || hasDone) GameClient.resetAppliedServerFreeCount();
	else if (undoPending && serverFreeCount <= baseline) GameClient.ackUndoApplied(serverFreeCount);
	else GameClient.noteAppliedServerFreeCount(serverFreeCount);
	return 'apply';
}
const out: string[] = []; let ok = true;
const expect = (label: string, got: string, want: string) => { out.push(`${label}: ${got} ${got === want ? '' : `(기대 ${want}) FAIL`}`); if (got !== want) ok = false; };

// 1) 변환 1 + 번 2 → 서버 스택 1,2,3 응답 순차 적용
for (const n of [1, 2, 3]) expect(`프리액션 응답 ${n}`, apply(n), 'apply');
// 2) 응답 전 undo 2회 클릭(소켓은 미연결 상태로 emit만 버퍼링됨)
GameClient.undoFreeAction('test-game', 1); GameClient.undoFreeAction('test-game', 1);
expect('undo 대기 수', String(GameClient.pendingUndoCount()), '2');
expect('undo 응답 1 (스택 2)', apply(2), 'apply');
expect('undo 응답 2 (스택 1) ← 예전 버그는 여기서 skip', apply(1), 'apply');
expect('undo 대기 소진', String(GameClient.pendingUndoCount()), '0');
expect('기준선 = 서버값 1', String(GameClient.getLastAppliedServerFreeCount()), '1');
// 3) 러버밴딩 보호는 유지: undo 없이 늦게 온 옛 패킷(스택 2 < 기준선 3)은 여전히 skip
apply(2); apply(3);
expect('undo 없는 stale 패킷(2<3)', apply(2), 'skip');
// 4) 턴 넘어가면 리셋
apply(0);
expect('턴 종료 후 기준선', String(GameClient.getLastAppliedServerFreeCount()), '0');
console.log(out.join('\n')); console.log(ok ? '전부 통과' : '실패 있음'); process.exit(ok ? 0 : 1);
