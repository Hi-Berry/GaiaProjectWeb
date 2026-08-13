/**
 * 채택분 `r1RebelBoardFirst`(기본 ON, 2026-08-03 커밋 fb83f89)가 실게임에서 실제로 먹히는지 판정한다.
 *
 * DECISIONS.md가 채택 시 남긴 검증 지표 3개를 배포 전/후로 갈라 비교한다:
 *   ① R1 리벨리온 탑승률  (기준: 봇 24.0% vs 사람 59.8%)  ← 이 플래그가 직접 건드리는 값
 *   ② R1 총 로그행동      (기준: 봇 11.1 vs 사람 18.5)
 *   ③ 기술타일 장수(완주) (기준: 봇 3.89 vs 사람 9.35)
 *
 * ①은 플래그의 메커니즘 자체라 표본이 적어도 먼저 움직인다. ②③은 하류라 더 많은 판이 필요하다.
 * self-play로는 ①을 검증할 수 없다 — DECISIONS.md: "self-play가 contention 미재현"(실전 Nav+1 0.09 vs sp 0.40).
 * 반드시 사람이 낀 실게임이어야 한다.
 *
 * 사용: node scripts/verifyR1RebelAdoption.mjs [--deploy YYYY-MM-DD]
 *   --deploy  배포일(그 날짜 이후 게임을 '후'로 본다). 기본 2026-08-04.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'human-games');
const args = process.argv.slice(2);
const DEPLOY = args.includes('--deploy') ? args[args.indexOf('--deploy') + 1] : '2026-08-04';

/** DECISIONS.md에 기록된 채택 시점 기준선 */
const BASE = { board: 24.0, humanBoard: 59.8, acts: 11.1, humanActs: 18.5, tiles: 3.89, humanTiles: 9.35 };

function collect(from, to) {
	const s = {
		games: 0,
		boardSeats: 0, boardHit: 0, hBoardSeats: 0, hBoardHit: 0,   // ① 탑승
		actSeats: 0, actSum: 0, hActSeats: 0, hActSum: 0,           // ② R1 총행동
		tileSeats: 0, tileSum: 0, hTileSeats: 0, hTileSum: 0,       // ③ 기술타일(완주)
	};
	for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
		const d = f.slice(0, 10);
		if (d < from || d > to) continue;
		let g;
		try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
		const keys = Object.keys(g.players || {});
		const bots = new Set((g.botPlayerIds ?? []).concat(keys.filter((k) => k.startsWith('bot-') || /^AI Bot/.test(g.players[k].name || ''))));
		if (!bots.size) continue;              // 봇이 없으면 이 판정과 무관
		s.games++;
		const log = g.fullGameLog ?? [];

		// ① 리벨리온이 있는 판에서만 탑승률을 센다
		const hasRebel = (g.map ?? []).some((t) => t.type === 'ship_rebellion');
		const boardedR1 = new Set();
		const r1Acts = {};
		for (const e of log) {
			if (Number(e.round) !== 1) continue;
			r1Acts[e.playerId] = (r1Acts[e.playerId] || 0) + 1;
			if (e.action === 'Entered Ship' && /Rebel/i.test(e.details || '')) boardedR1.add(e.playerId);
		}
		for (const k of keys) {
			const isBot = bots.has(k);
			if (hasRebel) {
				if (isBot) { s.boardSeats++; if (boardedR1.has(k)) s.boardHit++; }
				else { s.hBoardSeats++; if (boardedR1.has(k)) s.hBoardHit++; }
			}
			if (isBot) { s.actSeats++; s.actSum += r1Acts[k] || 0; }
			else { s.hActSeats++; s.hActSum += r1Acts[k] || 0; }
			if ((g.roundNumber ?? 0) >= 6) {
				const n = (g.players[k].techTiles ?? []).length;
				if (isBot) { s.tileSeats++; s.tileSum += n; } else { s.hTileSeats++; s.hTileSum += n; }
			}
		}
	}
	return s;
}

const before = collect('2000-01-01', DEPLOY);
const after = collect(DEPLOY, '2999-12-31');
const rate = (a, b) => (b ? 100 * a / b : 0);
const avg = (a, b) => (b ? a / b : 0);
const f1 = (n) => n.toFixed(1);
const f2 = (n) => n.toFixed(2);

console.log(`배포 기준일 ${DEPLOY} — 봇이 낀 게임: 이전 ${before.games}판 / 이후 ${after.games}판`);
console.log('');
console.log('지표                      기록기준   배포전    배포후    사람(배포후)');
console.log('-'.repeat(68));
console.log(`① R1 리벨 탑승률          ${f1(BASE.board)}%    ${f1(rate(before.boardHit, before.boardSeats))}%    ${f1(rate(after.boardHit, after.boardSeats))}%     ${f1(rate(after.hBoardHit, after.hBoardSeats))}%`);
console.log(`② R1 총 로그행동          ${f1(BASE.acts)}     ${f2(avg(before.actSum, before.actSeats))}     ${f2(avg(after.actSum, after.actSeats))}      ${f2(avg(after.hActSum, after.hActSeats))}`);
console.log(`③ 기술타일(완주)          ${f2(BASE.tiles)}     ${f2(avg(before.tileSum, before.tileSeats))}     ${f2(avg(after.tileSum, after.tileSeats))}      ${f2(avg(after.hTileSum, after.hTileSeats))}`);
console.log('');
console.log(`표본(배포 후): 탑승 ${after.boardSeats}석 · R1행동 ${after.actSeats}석 · 기술타일 ${after.tileSeats}석`);

// 판정 가능 여부 — ①은 비율이라 이항으로 필요표본을 가늠한다.
// 24% → 45%를 95% 신뢰로 구분하려면 대략 40석. 그 아래면 '아직 모름'이라고 분명히 말한다.
const NEED = 40;
console.log('');
if (after.boardSeats < NEED) {
	console.log(`▶ 판정 불가 — 탑승률을 가르려면 봇 좌석 약 ${NEED}석이 필요한데 지금 ${after.boardSeats}석.`);
	console.log(`  봇 2명이 낀 4인 게임 기준 약 ${Math.ceil((NEED - after.boardSeats) / 2)}판 더 필요합니다.`);
} else {
	const b = rate(after.boardHit, after.boardSeats);
	const moved = b - rate(before.boardHit, before.boardSeats);
	console.log(`▶ ① 탑승률 ${moved >= 0 ? '+' : ''}${f1(moved)}%p 변화 (${f1(rate(before.boardHit, before.boardSeats))}% → ${f1(b)}%).`);
	console.log(`  메커니즘이 먹혔다면 크게 올라야 한다(플래그가 리벨 입장에 +160). 안 올랐으면 배포 여부부터 확인.`);
}
