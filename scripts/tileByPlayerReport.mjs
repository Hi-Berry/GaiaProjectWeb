/**
 * 특정 기술 타일을 '사람별로 얼마나 자주 먹고, 먹었을 때 얼마나 이기는가'.
 *
 * 사용자 질문(2026-08-19): 큰큰이 타일(tech-big-4str — 의회·아카데미를 연방 파워 4로 세어주는 일반 기술타일)의
 * 사람별 획득 빈도와 승률.
 *
 * 대상: 4인 전원 사람 · 6라운드 완주 판(AI Bot 낀 판 제외). 계정 통합 적용.
 * 주의: 같은 사람이 그 타일을 먹은 판/안 먹은 판을 비교하는 within-person 대조라 실력 차는 상쇄되지만,
 *       '먹을 수 있는 상황'(연구 진행·타일 잔존) 자체가 이미 잘 풀린 판일 수 있어 인과는 아니다.
 *
 * 사용: node scripts/tileByPlayerReport.mjs [--tile tech-big-4str] [--min 4]
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'human-games');
const argv = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const TILE = argv('--tile', 'tech-big-4str');
// --tiles a,b,c : 여러 타일을 한 표로 (사람 × 타일 매트릭스). 우주선 기술타일 3종 비교용.
const TILES = argv('--tiles', '') ? argv('--tiles', '').split(',').map((x) => x.trim()).filter(Boolean) : null;
const MIN_GAMES = Number(argv('--min', 4));

const ALIAS = { '암가': '타클론안함', '암컷가마우지': '타클론안함', '김지선': '타클론안함', '222': '하이', 'chrome': '하이', '산타': '디애박', '소통맨': '지수홍', '보노보노': 'mks', 'GUHO': '구오' };
const canon = (n) => ALIAS[n] || n;
const EXCLUDE_GAMES = new Set(['2026-07-15_fi1njhdj.json']);
const isBot = (g, pid) => (g.botPlayerIds ?? []).includes(pid) || /^AI Bot/.test(g.players?.[pid]?.name ?? '');

const P = {};
const seat = (n) => (P[n] ??= { games: 0, wins: 0, scoreSum: 0, rankSum: 0, took: 0, tookWins: 0, tookScore: 0, tookRank: 0, tookRounds: [], per: {} });
const perTile = (s, t) => (s.per[t] ??= { took: 0, wins: 0, score: 0, rank: 0, rounds: [] });
let games = 0, gamesWithTile = 0;

/** 타일 획득 라운드.
 *  요약 gameLog의 'Gained Tech Tile'은 details에 트랙·즉시효과만 남기고 타일 ID가 없다 →
 *  타일 ID가 필드로 들어 있는 fullGameLog를 먼저 본다(구버전 로그엔 없어 gameLog 폴백). */
function takeRound(g, pid, tile = TILE) {
	for (const log of [g.fullGameLog, g.gameLog]) {
		if (!Array.isArray(log)) continue;
		let cur = null;
		for (const e of log) {
			if (typeof e.round === 'number') cur = e.round;
			if (e.playerId !== pid) continue;
			if (e.tileId === tile) return e.round ?? cur;
			if ((e.details ?? '').includes(tile)) return e.round ?? cur;
		}
	}
	return null;
}

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
	if (EXCLUDE_GAMES.has(f)) continue;
	let g;
	try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	if ((g.roundNumber ?? 0) < 6) continue;
	const ids = Object.keys(g.players ?? {});
	if (ids.length !== 4 || ids.some((k) => isBot(g, k))) continue;
	games++;
	let hit = false;

	for (const pid of ids) {
		const p = g.players[pid];
		const s = seat(canon(p.name ?? pid));
		const rk = p.rank ?? 4, sc = p.score ?? 0;
		s.games++; s.rankSum += rk; s.scoreSum += sc;
		if (rk === 1) s.wins++;
		if (TILES) {
			for (const t of TILES) {
				if (!(p.techTiles ?? []).includes(t)) continue;
				hit = true;
				const q = perTile(s, t);
				q.took++; q.rank += rk; q.score += sc;
				if (rk === 1) q.wins++;
				const rr = takeRound(g, pid, t);
				if (rr) q.rounds.push(rr);
			}
			continue;
		}
		if (!(p.techTiles ?? []).includes(TILE)) continue;
		hit = true;
		s.took++; s.tookRank += rk; s.tookScore += sc;
		if (rk === 1) s.tookWins++;
		const r = takeRound(g, pid);
		if (r) s.tookRounds.push(r);
	}
	if (hit) gamesWithTile++;
}

if (TILES) {
	const list = Object.entries(P).filter(([, s]) => s.games >= MIN_GAMES)
		.sort((a, b) => b[1].games - a[1].games);
	const f1 = (v) => (v == null ? '  -' : v.toFixed(1));
	const LBL = { 'ship-tech-1o3k': '1O+3K', 'ship-tech-2tf-mine': '2TF+광산', 'ship-tech-nav+1': 'Nav+1' };
	console.log(`4인 전원 사람 · 완주 ${games}판 · 최소 ${MIN_GAMES}판 이상 · 계정 통합`);
	console.log(`타일: ${TILES.map((t) => `${LBL[t] ?? t}(${t})`).join(' · ')}\n`);
	console.log('이름           판수  전체승률 |' + TILES.map((t) => ` ${(LBL[t] ?? t).padEnd(9)}획득 획득률  승률  평균R |`).join(''));
	console.log('-'.repeat(46 + TILES.length * 34));
	for (const [nm, s] of list) {
		let line = `${nm.slice(0, 12).padEnd(13)}${String(s.games).padStart(4)} ${f1(100 * s.wins / s.games).padStart(7)}% |`;
		for (const t of TILES) {
			const q = s.per[t] ?? { took: 0, wins: 0, rounds: [] };
			const wr = q.took ? (100 * q.wins) / q.took : null;
			const ar = q.rounds.length ? q.rounds.reduce((a, b) => a + b, 0) / q.rounds.length : null;
			line += `${String(q.took).padStart(13)} ${f1(100 * q.took / s.games).padStart(5)}% ${f1(wr).padStart(5)}% ${f1(ar).padStart(5)} |`;
		}
		console.log(line);
	}
	// 합계
	// 합계는 표에 실린 사람들(MIN_GAMES 이상)로만 — 표와 요약의 모집단을 일치시킨다
	const tot = list.map(([, s]) => s).reduce((a, s) => {
		a.games += s.games; a.wins += s.wins;
		for (const t of TILES) {
			const q = s.per[t]; if (!q) continue;
			const d = (a.per[t] ??= { took: 0, wins: 0, score: 0, rank: 0, rounds: [] });
			d.took += q.took; d.wins += q.wins; d.score += q.score; d.rank += q.rank; d.rounds.push(...q.rounds);
		}
		return a;
	}, { games: 0, wins: 0, per: {} });
	console.log('-'.repeat(46 + TILES.length * 34));
	let line = `${'합계'.padEnd(13)}${String(tot.games).padStart(4)} ${f1(100 * tot.wins / tot.games).padStart(7)}% |`;
	for (const t of TILES) {
		const q = tot.per[t] ?? { took: 0, wins: 0, rounds: [] };
		const ar = q.rounds.length ? q.rounds.reduce((a, b) => a + b, 0) / q.rounds.length : null;
		line += `${String(q.took).padStart(13)} ${f1(100 * q.took / tot.games).padStart(5)}% ${f1(q.took ? 100 * q.wins / q.took : null).padStart(5)}% ${f1(ar).padStart(5)} |`;
	}
	console.log(line);

	console.log('\n타일별 요약 (획득 좌석 기준)');
	console.log('타일            획득  획득률  승률   평균순위  평균점수  평균 획득R  라운드 분포');
	for (const t of TILES) {
		const q = tot.per[t] ?? { took: 0, wins: 0, score: 0, rank: 0, rounds: [] };
		const rd = {};
		for (const r of q.rounds) rd[r] = (rd[r] || 0) + 1;
		console.log(
			`${(LBL[t] ?? t).padEnd(15)}${String(q.took).padStart(4)} ${f1(100 * q.took / tot.games).padStart(6)}% ` +
			`${f1(q.took ? 100 * q.wins / q.took : null).padStart(5)}% ${(q.took ? (q.rank / q.took).toFixed(2) : '-').padStart(9)} ` +
			`${(q.took ? (q.score / q.took).toFixed(1) : '-').padStart(9)} ${f1(q.rounds.length ? q.rounds.reduce((a, b) => a + b, 0) / q.rounds.length : null).padStart(11)}  ` +
			Object.keys(rd).sort().map((k) => `R${k} ${rd[k]}`).join(' · ')
		);
	}
	const base = (100 * tot.wins) / tot.games;
	console.log(`\n기준선: 사람 좌석 전체 승률 ${base.toFixed(1)}% (4인 게임이라 무작위면 25%)`);
	process.exit(0);
}

const rows = Object.entries(P)
	.filter(([, s]) => s.games >= MIN_GAMES)
	.map(([nm, s]) => {
		const notN = s.games - s.took;
		return {
			nm, n: s.games, took: s.took,
			takePct: (100 * s.took) / s.games,
			win: (100 * s.wins) / s.games,
			winTook: s.took ? (100 * s.tookWins) / s.took : null,
			winNot: notN ? (100 * (s.wins - s.tookWins)) / notN : null,
			rankTook: s.took ? s.tookRank / s.took : null,
			rankNot: notN ? (s.rankSum - s.tookRank) / notN : null,
			scoreTook: s.took ? s.tookScore / s.took : null,
			scoreNot: notN ? (s.scoreSum - s.tookScore) / notN : null,
			avgRound: s.tookRounds.length ? s.tookRounds.reduce((a, b) => a + b, 0) / s.tookRounds.length : null,
		};
	})
	.sort((a, b) => b.takePct - a.takePct);

const f1 = (v) => (v == null ? '   -' : v.toFixed(1));
const f2 = (v) => (v == null ? '   -' : v.toFixed(2));

console.log(`[${TILE}] 4인 전원 사람 · 완주 ${games}판 중 이 타일이 나간 판 ${gamesWithTile}판 (${(100 * gamesWithTile / games).toFixed(0)}%)`);
console.log(`최소 ${MIN_GAMES}판 이상 참가자 · 계정 통합\n`);
console.log('이름           판수  획득  획득률 | 승률   먹었을때 안먹었을때 | 평균순위 먹음/안먹음 | 평균점수 먹음/안먹음 | 평균획득R');
console.log('-'.repeat(118));
for (const r of rows) {
	console.log(
		`${r.nm.slice(0, 12).padEnd(13)}${String(r.n).padStart(4)} ${String(r.took).padStart(5)} ${f1(r.takePct).padStart(6)}% |` +
		`${f1(r.win).padStart(6)}% ${f1(r.winTook).padStart(8)}% ${f1(r.winNot).padStart(10)}% |` +
		`${f2(r.rankTook).padStart(9)} / ${f2(r.rankNot).padStart(4)} |` +
		`${f1(r.scoreTook).padStart(9)} / ${f1(r.scoreNot).padStart(5)} |${f1(r.avgRound).padStart(9)}`
	);
}

// 합계 (사람 구분 없이)
const T = Object.values(P).reduce((a, s) => ({
	games: a.games + s.games, wins: a.wins + s.wins, took: a.took + s.took, tookWins: a.tookWins + s.tookWins,
	tookScore: a.tookScore + s.tookScore, scoreSum: a.scoreSum + s.scoreSum,
	tookRank: a.tookRank + s.tookRank, rankSum: a.rankSum + s.rankSum,
	rounds: a.rounds.concat(s.tookRounds),
}), { games: 0, wins: 0, took: 0, tookWins: 0, tookScore: 0, scoreSum: 0, tookRank: 0, rankSum: 0, rounds: [] });
const notN = T.games - T.took;
console.log('-'.repeat(118));
console.log(
	`${'합계'.padEnd(13)}${String(T.games).padStart(4)} ${String(T.took).padStart(5)} ${f1(100 * T.took / T.games).padStart(6)}% |` +
	`${f1(100 * T.wins / T.games).padStart(6)}% ${f1(100 * T.tookWins / T.took).padStart(8)}% ${f1(100 * (T.wins - T.tookWins) / notN).padStart(10)}% |` +
	`${f2(T.tookRank / T.took).padStart(9)} / ${f2((T.rankSum - T.tookRank) / notN).padStart(4)} |` +
	`${f1(T.tookScore / T.took).padStart(9)} / ${f1((T.scoreSum - T.tookScore) / notN).padStart(5)} |` +
	`${f1(T.rounds.length ? T.rounds.reduce((a, b) => a + b, 0) / T.rounds.length : null).padStart(9)}`
);

const rd = {};
for (const r of T.rounds) rd[r] = (rd[r] || 0) + 1;
console.log(`\n획득 라운드 분포(로그에서 잡힌 ${T.rounds.length}건 / 전체 ${T.took}건): ` +
	Object.keys(rd).sort().map((k) => `R${k} ${rd[k]}`).join(' · '));
