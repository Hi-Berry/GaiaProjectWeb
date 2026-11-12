/**
 * 종료 화면 '사용 시간' — 파워 받기 창은 받은 사람마다 창이 뜬 시점부터 따로 센다.
 *
 * 사용자 요청(2026-11-12): "각자 창 뜬 시점부터 따로 카운트되어야 할 것 같아. 합은 실제 게임 시간보다 길어질 수도 있겠네."
 *
 * 시각을 직접 정한 판(초 단위):
 *   0 시작 · 10 가 건설 · 12 가 턴 종료 → 나·다에게 창 · 20 다 응답 · 42 나 응답 · 50 라 행동
 *   기대: 가 12(10 + 창 뜨기 전 2) · 다 8 · 나 30 · 라 8(나 응답 뒤부터) → 합 58 > 실제 50
 *   (예전 방식이면 나는 22만 잡혔다 — 다가 먼저 누른 8초를 빼앗김)
 *
 * 사용: npx tsx script/testPowerWaitTime.ts
 */
import { recordFullGameLog, notePowerWait, computePlayerTimeMs } from '../server/humanGameLogger';

let now = 0;
const BASE = 1_700_000_000_000;
Date.now = () => BASE + now * 1000;
const players: any = { a: { name: '가' }, b: { name: '나' }, c: { name: '다' }, d: { name: '라' } };
const game: any = { id: `pw_${Math.random().toString(36).slice(2)}`, players, botPlayerIds: [], roundNumber: 1, currentPhase: 'main' };

now = 10; recordFullGameLog(game, 'a', 'Build Mine', '', 't1');
const shownAt = BASE + 12 * 1000; // 가 턴 종료 → 창 공개
now = 20; recordFullGameLog(game, 'c', 'Received Power', '↳ Received Power +1P 다'); notePowerWait(game, 'c', 'a', shownAt);
now = 42; recordFullGameLog(game, 'b', 'Received Power', '↳ Declined Power 나'); notePowerWait(game, 'b', 'a', shownAt);
now = 50; recordFullGameLog(game, 'd', 'Upgrade', '', 't2');

const t = computePlayerTimeMs(game, BASE);
const sec = (id: string) => t[id] / 1000;
const want: Record<string, number> = { a: 12, b: 30, c: 8, d: 8 };
let bad = 0;
for (const id of Object.keys(want)) {
	const ok = sec(id) === want[id];
	if (!ok) bad++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${players[id].name} ${sec(id)}초 (기대 ${want[id]})`);
}
const sum = Object.values(t).reduce((x, y) => x + y, 0) / 1000;
console.log(`${sum === 58 ? 'PASS' : 'FAIL'}  합 ${sum}초 — 실제 게임 50초보다 길다`); if (sum !== 58) bad++;
console.log(bad === 0 ? '\n전부 통과' : `\n${bad}건 실패`);
process.exit(bad === 0 ? 0 : 1);
