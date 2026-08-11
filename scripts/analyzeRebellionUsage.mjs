/**
 * 4인 전원 사람 게임에서 '리벨리온 우주선 액션'을 라운드별로 누가 많이 쓰는지.
 *
 * % 정의(사용자): 자신이 참가한 게임 중에 자신이 그 라운드에 실행한 비율.
 *   분모 = 그 사람이 참가한 4인 사람게임 수 (리벨리온에 탑승했는지와 무관 — '기회를 잡았는지'까지 포함한 지표)
 *   분자 = 그 중 해당 라운드에 리벨리온 액션을 1회 이상 실행한 게임 수
 *
 * 리벨리온 액션 3종 (각각 게임당 1회, 먼저 쓴 사람이 차지):
 *   Rebellion: 2K → 1Q 2C  /  Rebellion: Gain tech tile  /  Rebellion: Mine → TS
 * 주의: 'Rebellion: Gained Tech Tile'은 'Gain tech tile'의 해소 로그다(짝) → 세면 이중 계상.
 *   'Entered Ship'(탑승)은 액션 실행이 아니므로 별도 집계.
 *
 * 사용: node scripts/analyzeRebellionUsage.mjs [--min N] [--enter]
 *   --min N  최소 참가 게임 수(기본 5)   --enter  탑승률도 같이 출력
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'human-games');
const ROUNDS = [1, 2, 3, 4, 5, 6];
const ACTIONS = new Set(['Rebellion: 2K → 1Q 2C', 'Rebellion: Gain tech tile', 'Rebellion: Mine → TS']);

const args = process.argv.slice(2);
const MIN = Number(args[args.indexOf('--min') + 1]) || 5;
const showEnter = args.includes('--enter');

/** [사용자 2026-08-11] 같은 사람이 쓰는 다른 이름 — 표시 이름으로 합친다.
 *  두 이름이 한 게임에 동시에 나오면 동일인이 아니므로 합치면 안 된다(암가·타클론안함은 0판 확인). */
const ALIAS = { '암가': '타클론안함' };
const canon = (name) => ALIAS[name] || name;

function isAllHuman4(g) {
	const keys = Object.keys(g.players || {});
	if (keys.length !== 4) return false;
	return !keys.some((k) => k.startsWith('bot-') || /^AI Bot/.test(g.players[k].name || ''));
}

/** name → { games, byRound: {r: 갯수}, total, entered } */
const stat = new Map();
const get = (name) => {
	if (!stat.has(name)) stat.set(name, { games: 0, byRound: {}, total: 0, entered: 0 });
	return stat.get(name);
};

let gameCount = 0;
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
	let g;
	try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	if (!isAllHuman4(g)) continue;
	const log = g.fullGameLog || [];
	if (!log.length) continue;
	gameCount++;

	const nameOf = {};
	for (const pid of Object.keys(g.players)) nameOf[pid] = canon(g.players[pid].name);
	for (const pid of Object.keys(nameOf)) get(nameOf[pid]).games++;

	// 이 게임에서 (사람, 라운드) 조합으로 실행 여부 · 탑승 여부
	const didRound = new Set();   // `${name}|${round}`
	const didAny = new Set();     // name
	const entered = new Set();    // name
	for (const e of log) {
		const name = canon(e.playerName || nameOf[e.playerId] || '');
		if (!name) continue;
		if (ACTIONS.has(e.action)) {
			const r = Number(e.round);
			if (ROUNDS.includes(r)) didRound.add(`${name}|${r}`);
			didAny.add(name);
		} else if (e.action === 'Entered Ship' && /Rebel/i.test(e.details || '')) {
			entered.add(name);
		}
	}
	didRound.forEach((k) => {
		const [name, r] = k.split('|');
		const s = get(name);
		s.byRound[r] = (s.byRound[r] || 0) + 1;
	});
	didAny.forEach((n) => { get(n).total++; });
	entered.forEach((n) => { get(n).entered++; });
}

const rows = Array.from(stat.entries())
	.filter(([, s]) => s.games >= MIN)
	.sort((a, b) => (b[1].total / b[1].games) - (a[1].total / a[1].games));

const pct = (n, d) => (d ? (100 * n / d).toFixed(0) + '%' : '-');

console.log(`4인 전원 사람 게임 ${gameCount}판 · 참가 ${MIN}판 이상인 사람만`);
console.log('');
const head = ['플레이어'.padEnd(12), '참가'.padStart(4), ...ROUNDS.map((r) => `R${r}`.padStart(5)), '한판이라도'.padStart(9)];
if (showEnter) head.push('탑승'.padStart(6));
console.log(head.join(' '));
console.log('-'.repeat(head.join(' ').length));
for (const [name, s] of rows) {
	const line = [name.padEnd(12), String(s.games).padStart(4),
		...ROUNDS.map((r) => pct(s.byRound[r] || 0, s.games).padStart(5)),
		pct(s.total, s.games).padStart(9)];
	if (showEnter) line.push(pct(s.entered, s.games).padStart(6));
	console.log(line.join(' '));
}

// 라운드별 전체 평균 — 어느 라운드에 몰리는지
console.log('');
const allGames = rows.reduce((t, [, s]) => t + s.games, 0);
const line = ROUNDS.map((r) => {
	const n = rows.reduce((t, [, s]) => t + (s.byRound[r] || 0), 0);
	return `R${r} ${pct(n, allGames)}`;
});
console.log('라운드별 평균: ' + line.join(' · '));
