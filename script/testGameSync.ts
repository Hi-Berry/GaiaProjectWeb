import { createGameDelta } from '../server/gameState';
import { applyGameStateDelta, buildClientGameState } from '../shared/gameSync';

let failures = 0;
function check(name: string, condition: boolean): void {
  console.log(`${condition ? 'OK  ' : 'FAIL'} ${name}`);
  if (!condition) failures++;
}

const logs = Array.from({ length: 55 }, (_, i) => ({ action: `log-${i}` }));
const source = {
  id: 'sync-test',
  currentPhase: 'main',
  optional: 'remove-me',
  gameLog: logs,
  freeActionUndoStack: ['large snapshot 1', 'large snapshot 2'],
  map: [
    { id: 'a', structure: null },
    { id: 'b', structure: null },
  ],
  players: {
    p1: { credits: 10, ore: 2 },
    p2: { credits: 7, ore: 1 },
  },
};

const base = buildClientGameState(source, true);
check('broadcast 로그는 최근 40개만 유지', (base.gameLog as unknown[]).length === 40);
check('로그 절대 위치 메타데이터 생성', base.gameLogStart === 15 && base.gameLogLen === 55);
check(
  'undo 본문은 개수만 유지해 경량화',
  JSON.stringify(base.freeActionUndoStack) === JSON.stringify(['', '']),
);

const nextSource = JSON.parse(JSON.stringify(source));
delete nextSource.optional;
nextSource.currentPhase = 'income';
nextSource.map[1].structure = 'mine';
nextSource.players.p1.credits = 4;
delete nextSource.players.p2;
nextSource.players.p3 = { credits: 5, ore: 3 };
nextSource.gameLog.push({ action: 'log-55' });
nextSource.freeActionUndoStack.push('large snapshot 3');

const expected = buildClientGameState(nextSource, true);
const delta = createGameDelta(base, expected);
const reconstructed = applyGameStateDelta(base, delta);

check('최상위 변경·삭제 복원', reconstructed.currentPhase === 'income' && !('optional' in reconstructed));
check(
  '맵 한 칸 변경 복원',
  (reconstructed.map as Array<{ structure: string | null }>)[1].structure === 'mine',
);
check(
  '플레이어 변경·퇴장·입장 복원',
  (reconstructed.players as Record<string, unknown>).p2 === undefined
    && (reconstructed.players as Record<string, unknown>).p3 !== undefined,
);
check('전체 델타 적용 결과가 원본과 일치', JSON.stringify(reconstructed) === JSON.stringify(expected));

const resizedSource = JSON.parse(JSON.stringify(nextSource));
resizedSource.map.push({ id: 'c', structure: null });
const resized = buildClientGameState(resizedSource, true);
const resizeDelta = createGameDelta(expected, resized);
check(
  '맵 길이 변경은 전체 맵 교체',
  resizeDelta.map?.replace?.length === 3
    && JSON.stringify(applyGameStateDelta(expected, resizeDelta)) === JSON.stringify(resized),
);

if (failures) {
  console.error(`\n${failures}개 동기화 테스트 실패`);
  process.exit(1);
}
console.log('\nOK: 델타 생성·적용 및 전송 상태 경량화 검증 완료');
process.exit(0);
