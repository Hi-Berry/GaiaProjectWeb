/**
 * 종료 화면 '사용 시간' — 턴 종료 클릭·비딩 입찰/패스 경계 회귀 테스트.
 *
 * 사용자 제보(2026-11-18, 2wj2ca76): "하이 발타크 30분 넘게 쓴 게 맞나? 그렇게 오래 쓴 기억이 없다"
 *   ① 종족 비딩: un 선택 → 하이 선택 사이 경매(네 명 입찰) 3분 36초가 전부 낙찰자 하이 몫이 됐다.
 *   ② 턴 종료 클릭은 기록에 없어서, 앞사람이 행동 뒤 턴 종료를 누르기까지가 다음 사람 몫이 됐다.
 *
 * 사용: npx tsx script/testPlayerTimeMarks.ts
 */
import { computePlayerTimeMs, noteTimeMark, type TimeMark } from '../server/humanGameLogger';

let bad = 0;
const check = (ok: boolean, msg: string) => { if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const S = 1000;
const T0 = 1_800_000_000_000; // 기준 시각(0이면 서버가 '시작 시각 없음'으로 본다)

function game(log: { t: number; p: string; a: string }[], id?: string): any {
	return {
		id,
		players: { A: { name: 'A' }, B: { name: 'B' }, C: { name: 'C' } },
		gameLog: log.map((e) => ({ timestamp: e.t, playerId: e.p, action: e.a })),
	};
}

// ① 비딩: 시작 0초 → A 입찰 10초 → B 입찰 40초 → C 패스 45초 → A 패스 50초 → B 낙찰 후 종족 선택 70초
{
	const g = game([{ t: T0 + 70 * S, p: 'B', a: 'Selected Faction' }]);
	const marks: TimeMark[] = [
		{ timestamp: T0 + 10 * S, playerId: 'A', kind: 'bid' },
		{ timestamp: T0 + 40 * S, playerId: 'B', kind: 'bid' },
		{ timestamp: T0 + 45 * S, playerId: 'C', kind: 'bid' },
		{ timestamp: T0 + 50 * S, playerId: 'A', kind: 'bid' },
	];
	const before = computePlayerTimeMs(g, T0, []);
	check(before.B === 70 * S && before.A === 0, `① 표시 없으면(예전) 경매 전체가 낙찰자 몫: B ${before.B / S}초`);
	const t = computePlayerTimeMs(g, T0, marks);
	check(t.A === 15 * S && t.B === 50 * S && t.C === 5 * S, `① 입찰한 사람마다 나눔: A ${t.A / S} · B ${t.B / S} · C ${t.C / S}초 (기대 15·50·5)`);
}

// ② 턴 종료: A 행동 100초 → A 턴 종료 160초 → B 행동 170초
{
	const g = game([{ t: 100 * S, p: 'A', a: 'Built Mine' }, { t: 170 * S, p: 'B', a: 'Built Mine' }]);
	const before = computePlayerTimeMs(g, 100 * S, []);
	check(before.B === 70 * S, `② 표시 없으면(예전) A가 턴 종료를 늦게 누른 60초가 B 몫: B ${before.B / S}초`);
	const t = computePlayerTimeMs(g, 100 * S, [{ timestamp: 160 * S, playerId: 'A', kind: 'turn_end' }]);
	check(t.A === 60 * S && t.B === 10 * S, `② 턴 종료까지는 A, 그 뒤만 B: A ${t.A / S} · B ${t.B / S}초 (기대 60·10)`);
}

// ③ noteTimeMark → 서버 저장소 → computePlayerTimeMs (실제 경로)
{
	const now = Date.now();
	const g = game([{ t: now - 5 * S, p: 'A', a: 'Built Mine' }, { t: now + 60 * S, p: 'B', a: 'Built Mine' }], 'test-time-marks');
	noteTimeMark(g, 'A', 'turn_end'); // 지금 시각
	const t = computePlayerTimeMs(g, now - 5 * S);
	check(Math.abs(t.A - 5 * S) < 200 && Math.abs(t.B - 60 * S) < 200, `③ 저장된 턴 종료 표시를 경계로 사용: A ${(t.A / S).toFixed(1)} · B ${(t.B / S).toFixed(1)}초`);
	const sim = { ...game([], 'test-time-marks-sim'), simulation: true };
	noteTimeMark(sim, 'A', 'turn_end');
	check(Object.values(computePlayerTimeMs(sim, 0)).every((v) => v === 0), '③ 시뮬레이션 판은 기록 안 함');
}

console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
process.exit(bad === 0 ? 0 : 1);
