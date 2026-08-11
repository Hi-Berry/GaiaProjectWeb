/**
 * 게임당 '총 획득 자원'을 플레이어별로 집계한다.
 *
 * 출처: 저장 로그의 actionJournal — 항목마다 행동 직전/직후 전체 자원 스냅샷(playerBefore/playerAfter)이
 *   4명 모두에 대해 남아 있다. 플레이어별로 그 스냅샷을 시간순으로 이어붙이고 '양(+)의 변화량만' 더하면
 *   총 획득량이 된다. 인접한 두 스냅샷 사이에는 그 사람의 행동뿐 아니라 수입·파워 누출(leech)·가이아 복귀도
 *   들어가므로 소비를 뺀 순증이 아니라 '들어온 총량'이 잡힌다.
 *
 * 파워는 개수가 아니라 '충전 단계'로 센다: level = power2 + 2*power3.
 *   1그릇→2그릇, 2그릇→3그릇 각각 +1. 번(2그릇 2개 → 3그릇 1개)은 0으로 중립, 소비(3→1)는 -2.
 *
 * 한계
 *  - 첫 스냅샷 이전(시작 자원)과 마지막 스냅샷 이후(최종 수입·정산)는 못 센다.
 *  - 가이아 영역 토큰·브레인 스톤은 resources에 없어 이동 시 감소로만 보인다.
 *  - actionJournal이 없는 옛 로그는 건너뛴다.
 *
 * 사용: node scripts/analyzeResourceIncome.mjs [--faction] [--games]
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'human-games');
const RES = ['credits', 'ore', 'knowledge', 'qic'];
const powerLevel = (r) => (r.power2 || 0) + 2 * (r.power3 || 0);

const args = process.argv.slice(2);
const showFaction = args.includes('--faction');
const showGames = args.includes('--games');

/** 4인 전원 사람 게임만 (봇이 섞이면 자원 흐름 성격이 달라짐) */
function isAllHuman4(g) {
	const keys = Object.keys(g.players || {});
	if (keys.length !== 4) return false;
	return !keys.some((k) => k.startsWith('bot-') || /^AI Bot/.test(g.players[k].name || ''));
}

function analyze(game) {
	const seq = {};
	for (const e of game.actionJournal || []) {
		if (!e.playerId) continue;
		(seq[e.playerId] ||= []);
		if (e.playerBefore?.resources) seq[e.playerId].push(e.playerBefore.resources);
		if (e.playerAfter?.resources) seq[e.playerId].push(e.playerAfter.resources);
	}
	const out = {};
	for (const pid of Object.keys(game.players)) {
		const s = seq[pid] || [];
		const g = { credits: 0, ore: 0, knowledge: 0, qic: 0, charge: 0 };
		for (let i = 1; i < s.length; i++) {
			for (const r of RES) {
				const d = (s[i][r] || 0) - (s[i - 1][r] || 0);
				if (d > 0) g[r] += d;
			}
			const dc = powerLevel(s[i]) - powerLevel(s[i - 1]);
			if (dc > 0) g.charge += dc;
		}
		const p = game.players[pid];
		out[pid] = { name: p.name, faction: p.faction, rank: p.rank, score: p.score, snaps: s.length, ...g };
	}
	return out;
}

const rows = [];
const perGame = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
	let g;
	try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	if (!isAllHuman4(g)) continue;
	if (!(g.actionJournal || []).length) continue;
	const per = analyze(g);
	perGame.push({ file: f, per });
	for (const pid of Object.keys(per)) rows.push(per[pid]);
}

const mean = (list, k) => (list.length ? list.reduce((s, x) => s + x[k], 0) / list.length : 0);
const fmt = (list) => `C${mean(list, 'credits').toFixed(1)} O${mean(list, 'ore').toFixed(1)} K${mean(list, 'knowledge').toFixed(1)} Q${mean(list, 'qic').toFixed(1)} PW${mean(list, 'charge').toFixed(1)}`;

console.log(`4인 전원 사람 게임 ${perGame.length}판 · 플레이어-게임 표본 ${rows.length}건`);
console.log(`게임당 평균 획득: ${fmt(rows)}`);
console.log('');
console.log('등수별');
for (const r of [1, 2, 3, 4]) {
	const s = rows.filter((x) => x.rank === r);
	console.log(`  ${r}위 (n=${s.length})  ${fmt(s)}  | 평균점수 ${mean(s, 'score').toFixed(1)}`);
}

if (showFaction) {
	console.log('');
	console.log('종족별 (표본 5건 이상)');
	const byFac = {};
	for (const x of rows) (byFac[x.faction] ||= []).push(x);
	Object.entries(byFac)
		.filter(([, s]) => s.length >= 5)
		.sort((a, b) => mean(b[1], 'score') - mean(a[1], 'score'))
		.forEach(([fac, s]) => {
			console.log(`  ${fac.padEnd(14)} n=${String(s.length).padStart(3)}  ${fmt(s)}  | 평균점수 ${mean(s, 'score').toFixed(1)}`);
		});
}

if (showGames) {
	console.log('');
	console.log('게임별');
	for (const { file, per } of perGame) {
		console.log(`  ${file}`);
		Object.values(per)
			.sort((a, b) => a.rank - b.rank)
			.forEach((x) => console.log(`    ${String(x.rank)}위 ${x.name.padEnd(10)} ${x.faction.padEnd(14)} C${String(x.credits).padStart(4)} O${String(x.ore).padStart(4)} K${String(x.knowledge).padStart(3)} Q${String(x.qic).padStart(3)} PW${String(x.charge).padStart(4)} | ${x.score}점`));
	}
}
