/**
 * 4인 전원 사람 게임에서 '우주선 액션 12종'을 라운드별로 누가 많이 쓰는지.
 * (analyzeRebellionUsage.mjs를 4척 전체로 일반화한 것 — 리벨리온만 보려면 --ship rebellion)
 *
 * % 정의(사용자): 자신이 참가한 게임 중에 자신이 그 라운드에 실행한 비율.
 *   분모 = 그 사람이 참가한 4인 사람게임 수 (탑승 여부와 무관)
 *   분자 = 그 중 해당 라운드에 그 액션을 1회 이상 실행한 게임 수
 *
 * 자료: actionJournal (리셋·롤백 시 함께 잘려 되돌린 액션이 남지 않음).
 *   fullGameLog는 append 전용이라 되돌린 액션이 그대로 남으므로 쓰지 않는다.
 *
 * 액션 슬롯은 라운드마다 초기화되고(gameState.ts:8601) 각 슬롯은 라운드당 1명만 쓸 수 있다
 * → 한 액션의 4인 합산은 100%를 넘을 수 없다(검증에 사용).
 *
 * 사용: node scripts/analyzeShipActions.mjs [--min N] [--ship KEY] [--only KEY] [--summary]
 *   --min N     최소 참가 게임 수(기본 5)
 *   --ship KEY  twilight | rebellion | tfmars | eclipse (해당 배만)
 *   --only KEY  개별 액션 키 하나만 (예: rebellion-3)
 *   --summary   12종 '한번이라도' 요약표만
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'human-games');
const ROUNDS = [1, 2, 3, 4, 5, 6];

/** 우주선별 액션 3종. ids = 그 액션 실행으로 남는 로그(초기화 로그 기준).
 *  트왈라잇 1번은 초기화 로그가 없고(pendingTwilightFederation만 세팅) 보상 확정 시점에 두 갈래로 남는다
 *  → 둘을 한 액션으로 합쳐 센다. 'Rebellion: Gained Tech Tile'·'Eclipse: Research'·
 *  'Eclipse: Built mine on asteroid'은 각각 짝이 되는 해소 로그라 세지 않는다(이중 계상 방지). */
const SHIPS = [
	{
		key: 'twilight', name: '트왈라잇', enter: /Twilight|트왈/i, actions: [
			{ key: 'twilight-1', label: '3정큐 → 연방 보상', ids: ['Twilight: Federation benefit', 'Twilight: Spaceship Fed'] },
			{ key: 'twilight-2', label: '2광 3파워 → 교역소→연구소', ids: ['Twilight: TS → Research Lab'] },
			{ key: 'twilight-3', label: '1지식 → +3 사거리', ids: ['Twilight: +3 Range'] },
		]
	},
	{
		key: 'rebellion', name: '리벨리온', enter: /Rebel/i, actions: [
			{ key: 'rebellion-1', label: '2지식 → 1정큐 2크레딧', ids: ['Rebellion: 2K → 1Q 2C'] },
			{ key: 'rebellion-2', label: '3정큐 → 기술타일', ids: ['Rebellion: Gain tech tile'] },
			{ key: 'rebellion-3', label: '1광 3파워 → 광산→교역소', ids: ['Rebellion: Mine → TS'] },
		]
	},
	{
		key: 'tfmars', name: 'TF 마스', enter: /TF Mars|마스/i, actions: [
			{ key: 'tfmars-1', label: '기술타일 수 +2 VP', ids: ['TF Mars: Tech tiles + 2 VP'] },
			{ key: 'tfmars-2', label: '2파워 → 가이아포머 배치', ids: ['TF Mars: Gaia Project'] },
			{ key: 'tfmars-3', label: '3크레딧 → 1 테라포밍', ids: ['TF Mars: 3C → 1 Terraform'] },
		]
	},
	{
		key: 'eclipse', name: '이클립스', enter: /Eclipse|이클/i, actions: [
			{ key: 'eclipse-1', label: '2정큐 → 행성유형+2 VP', ids: ['Eclipse: Planet types + 2 VP'] },
			// [검증 2026-08-11] 이클립스 2·3번은 '지불 후 선택' 대기형이라 취소가 가능한데, 취소는 gameLog만 자르고
			//   actionJournal은 안 건드린다(removeLastGameLogEntry :2251) → 개시 로그를 세면 취소분까지 잡혀
			//   한 라운드 2명으로 집계됐다(eclipse-2 4건, eclipse-3 1건). 완료 시에만 남는 로그로 센다.
			{ key: 'eclipse-2', label: '2지식 3파워 → 연구', ids: ['Eclipse: Research'] },
			{ key: 'eclipse-3', label: '6크레딧 → 소행성 광산', ids: ['Eclipse: Built mine on asteroid'] },
		]
	},
];

const args = process.argv.slice(2);
const MIN = Number(args[args.indexOf('--min') + 1]) || 5;
const SHIP = args.includes('--ship') ? args[args.indexOf('--ship') + 1] : null;
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const summaryOnly = args.includes('--summary');

/** 같은 사람이 쓰는 다른 이름 — 표시 이름으로 합친다(한 게임에 동시 등장하면 동일인이 아니므로 합치면 안 됨) */
/** 같은 사람이 쓰는 다른 이름 (사용자 확인). 넣기 전에 '두 이름이 한 게임에 동시 등장하지 않는지'를 반드시 검사한다
 *  — 동시 등장하면 서로 다른 사람이고, 합치면 한 게임에 같은 사람이 2명이 되어 집계가 깨진다.
 */
const ALIAS = {
	'암가': '타클론안함',
	'암컷가마우지': '타클론안함',
	'김지선': '타클론안함',
	'222': '하이',
	'chrome': '하이',
};
const canon = (name) => ALIAS[name] || name;

/** [사용자 2026-08-11] 4인처럼 보이지만 실제로는 두 사람이 계정 2개씩 쓴 판 — 사람 단위 통계에서 제외.
 *  2026-07-15_fi1njhdj: chrome·Hi = 하이 / 산타·디애박 = 디애박. */
const EXCLUDE_GAMES = new Set(['2026-07-15_fi1njhdj.json']);

function isAllHuman4(g) {
	const keys = Object.keys(g.players || {});
	if (keys.length !== 4) return false;
	return !keys.some((k) => k.startsWith('bot-') || /^AI Bot/.test(g.players[k].name || ''));
}

const ALL_ACTIONS = SHIPS.flatMap((s) => s.actions.map((a) => ({ ...a, ship: s })));
const byId = new Map();          // 로그명 → 액션키
const cancelOf = new Map();      // 취소 로그명 → 액션키
for (const a of ALL_ACTIONS) {
	for (const id of a.ids) byId.set(id, a.key);
	if (a.cancel) cancelOf.set(a.cancel, a.key);
}

/** name → { games, enter:{shipKey:n}, act:{actionKey:{r:n, any:n}} } */
const stat = new Map();
const get = (name) => {
	if (!stat.has(name)) stat.set(name, { games: 0, enter: {}, act: {} });
	return stat.get(name);
};
const slot = (s, k) => (s.act[k] ??= { any: 0 });

let gameCount = 0;
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
	let g;
	try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	if (EXCLUDE_GAMES.has(f)) continue;
	if (!isAllHuman4(g)) continue;
	const log = (g.actionJournal && g.actionJournal.length) ? g.actionJournal : (g.gameLog || []);
	if (!log.length) continue;
	gameCount++;

	const nameOf = {};
	for (const pid of Object.keys(g.players)) nameOf[pid] = canon(g.players[pid].name);
	for (const pid of Object.keys(nameOf)) get(nameOf[pid]).games++;

	const didRound = new Set();  // `${name}|${actionKey}|${round}`
	const didAny = new Set();    // `${name}|${actionKey}`
	const entered = new Set();   // `${name}|${shipKey}`
	const canceled = new Set();  // `${name}|${actionKey}|${round}` — 취소된 건 실행에서 뺀다
	for (const e of log) {
		const name = canon(e.playerName || nameOf[e.playerId] || '');
		if (!name) continue;
		const r = Number(e.round);
		const cKey = cancelOf.get(e.action);
		if (cKey) { canceled.add(`${name}|${cKey}|${r}`); continue; }
		const aKey = byId.get(e.action);
		if (aKey) {
			if (ROUNDS.includes(r)) didRound.add(`${name}|${aKey}|${r}`);
			didAny.add(`${name}|${aKey}`);
		} else if (e.action === 'Entered Ship') {
			for (const s of SHIPS) if (s.enter.test(e.details || '')) entered.add(`${name}|${s.key}`);
		}
	}
	canceled.forEach((k) => didRound.delete(k));
	didRound.forEach((k) => {
		const [name, aKey, r] = k.split('|');
		const sl = slot(get(name), aKey);
		sl[r] = (sl[r] || 0) + 1;
	});
	didAny.forEach((k) => {
		const [name, aKey] = k.split('|');
		// 그 액션을 한 라운드도 남기지 못한 경우(전부 취소) 제외
		const sl = slot(get(name), aKey);
		if (ROUNDS.some((r) => sl[r])) sl.any++;
	});
	entered.forEach((k) => {
		const [name, sKey] = k.split('|');
		const s = get(name);
		s.enter[sKey] = (s.enter[sKey] || 0) + 1;
	});
}

const players = Array.from(stat.entries()).filter(([, s]) => s.games >= MIN);
const pct = (n, d) => (d ? (100 * n / d).toFixed(0) + '%' : '-');

console.log(`4인 전원 사람 게임 ${gameCount}판 · 참가 ${MIN}판 이상인 사람만`);

if (summaryOnly) {
	console.log('');
	console.log('[요약] 액션별 "한번이라도" 비율');
	const head = ['플레이어'.padEnd(12), '참가'.padStart(4), ...ALL_ACTIONS.map((a) => a.key.padStart(12))];
	console.log(head.join(' '));
	for (const [name, s] of players.sort((a, b) => b[1].games - a[1].games)) {
		console.log([name.padEnd(12), String(s.games).padStart(4),
			...ALL_ACTIONS.map((a) => pct(s.act[a.key]?.any || 0, s.games).padStart(12))].join(' '));
	}
	process.exit(0);
}

for (const ship of SHIPS) {
	if (SHIP && ship.key !== SHIP) continue;
	if (ONLY && !ship.actions.some((a) => a.key === ONLY)) continue;
	for (const a of ship.actions) {
		if (ONLY && a.key !== ONLY) continue;
		const rows = players
			.map(([name, s]) => ({ name, s, sl: s.act[a.key] ?? { any: 0 } }))
			.sort((x, y) => (y.sl.any / y.s.games) - (x.sl.any / x.s.games));
		console.log('');
		console.log(`■ ${ship.name} — ${a.label}  [${a.key}]`);
		const head = ['플레이어'.padEnd(12), '참가'.padStart(4), ...ROUNDS.map((r) => `R${r}`.padStart(5)), '한번이라도'.padStart(9), '탑승'.padStart(6)];
		console.log(head.join(' '));
		console.log('-'.repeat(head.join(' ').length));
		for (const { name, s, sl } of rows) {
			console.log([name.padEnd(12), String(s.games).padStart(4),
				...ROUNDS.map((r) => pct(sl[r] || 0, s.games).padStart(5)),
				pct(sl.any, s.games).padStart(9),
				pct(s.enter[ship.key] || 0, s.games).padStart(6)].join(' '));
		}
		const tg = rows.reduce((t, x) => t + x.s.games, 0);
		console.log('   라운드별 평균: ' + ROUNDS.map((r) => `R${r} ${pct(rows.reduce((t, x) => t + (x.sl[r] || 0), 0), tg)}`).join(' · '));
	}
}
