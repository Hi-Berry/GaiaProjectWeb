/**
 * 전용 연구 랭커 — 사람의 '어느 트랙을 올릴까' 선택을 학습한다.
 *
 * 왜 연구 전용인가(2026-08-13 진단):
 *   실게임(07-12 이후 완주판, 봇 171석 / 사람 97석)에서 트랙 배분이 볼륨과 무관하게 갈린다.
 *     economy+navigation 비중 — 봇 55% vs 사람 27%
 *     gaia+terra+AI 비중     — 봇 38% vs 사람 62%
 *   총 레벨(12.0 vs 19.1)은 기술타일 하류라 순환 논증이지만, *비중*은 순수 선호 신호다.
 *   DECISIONS.md가 남긴 다음 레버 "(a) 전용 per-타입 랭커 확대(업글·연구·파워)"의 연구 판.
 *   통합 랭커의 그룹내 연구 top-1은 49%로 배치 전용 랭커(60%)에 못 미친다.
 *
 * 방법론(DECISIONS의 두 교훈을 그대로 적용):
 *   ① 오프라인 게이트는 *소비 경로가 읽는 양*을 재야 한다 → 지표는 **연구 후보들 사이의 top-1**
 *      (bot.ts는 그룹 내부 순서만 바꿔 쓰게 될 것이므로 전체 top-1은 무의미).
 *   ② 고정 에폭 비교는 기준선을 과학습시켜 이기는 가짜 이득을 만든다 → **에폭 체크포인트별로
 *      각자 최고점**을 보고, K-폴드 쌍대차 ± SE로 판정한다.
 *
 * 사용: node scripts/trainResearchRanker.mjs [--folds 5] [--out server/ai/researchRanker.json]
 */
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'data', 'human-games');
const args = process.argv.slice(2);
const argOf = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const FOLDS = Number(argOf('--folds', 5));
const OUT = argOf('--out', 'server/ai/researchRanker.json');
const CKPTS = [40, 80, 120, 180, 260];

const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
const HOME_PLANETS = ['terra', 'volcanic', 'oxide', 'desert', 'swamp', 'titanium', 'ice'];
const getRange = (n) => (n >= 5 ? 4 : n >= 4 ? 3 : n >= 2 ? 2 : 1);
const dist = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;

/** shared/gameConfig.ts에서 종족→홈행성을 그대로 읽는다(하드코딩 드리프트 방지). */
function loadHomePlanets() {
	const src = fs.readFileSync(path.join(process.cwd(), 'shared', 'gameConfig.ts'), 'utf8');
	const m = {};
	for (const [, id, home] of src.matchAll(/id:\s*'([a-z_]+)',\s*name:\s*'[^']*',\s*homePlanet:\s*'([a-z]+)'/g)) m[id] = home;
	return m;
}
const HOME = loadHomePlanets();

/** 종족 기준 목표 행성까지의 삽 수(shared/gameConfig의 getTerraformStepsForFaction 축약: 확장 3종족 예외 포함). */
function steps(faction, to) {
	if (to === 'asteroid') return 0;
	if (to === 'proto') return 3;
	if (faction === 'darkanians') return HOME_PLANETS.includes(to) ? 1 : 0;
	if (faction === 'space_giants') return HOME_PLANETS.includes(to) ? 2 : 0;
	const from = HOME[faction] || 'terra';
	if (from === to) return 0;
	const a = HOME_PLANETS.indexOf(from), b = HOME_PLANETS.indexOf(to);
	if (a < 0 || b < 0) return 0;
	const d = Math.abs(a - b);
	return Math.min(d, 7 - d);
}

const FEAT = 46;
const OWNED_ACT = /^Built Mine|^Placed Starting|^Upgraded to|Rebellion: Mine|Twilight: TS|^Advanced TS built/;

/** 결정 1건의 후보별 피처 행렬을 만든다. */
function featurize(cand, ctx) {
	const f = new Array(FEAT).fill(0);
	const t = cand.trackId;
	const ti = TRACKS.indexOf(t);
	if (ti < 0) return null;
	const L = ctx.research[t] ?? 0;
	f[ti] = 1;
	f[6] = L / 5;
	if (L <= 4) f[7 + L] = 1;
	f[12] = ctx.round / 6;
	f[13] = ctx.round <= 2 ? 1 : 0;
	f[14] = ctx.round >= 5 ? 1 : 0;
	f[15] = Math.min(ctx.res.ore ?? 0, 20) / 10;
	f[16] = Math.min(ctx.res.credits ?? 0, 40) / 20;
	f[17] = Math.min(ctx.res.knowledge ?? 0, 20) / 10;
	f[18] = Math.min(ctx.res.qic ?? 0, 10) / 5;
	f[19] = Math.min(ctx.power, 24) / 12;
	f[20] = Math.min(ctx.structures, 24) / 12;
	f[21] = ctx.hasFed && L === 4 ? 1 : 0;
	f[22] = (L - ctx.meanLevel) / 3;
	f[23] = Math.min(ctx.tiles, 20) / 10;
	f[24 + ti] = f[13];
	f[30 + ti] = L === 0 ? 1 : 0;
	f[40 + ti] = L >= 3 ? 1 : 0;
	// 트랙별 '기회' 피처 — 지금 이 트랙을 올리면 실제로 열리는 대상 수 (타입별 피처 추가 레버)
	if (t === 'terraforming') f[36] = Math.min(ctx.oppTerra, 16) / 8;
	else if (t === 'navigation') f[37] = Math.min(ctx.oppNav, 10) / 5;
	else if (t === 'gaiaProject') f[38] = Math.min(ctx.oppGaia, 10) / 5;
	return f;
}

/** 게임 하나에서 학습 결정들을 뽑는다. */
function decisionsOf(g) {
	if (!g.map || !g.actionJournal) return [];
	const geo = new Map();
	for (const t of g.map) if (t.q != null) geo.set(t.id, t);
	const planets = [...geo.values()].filter(t => t.type && t.type !== 'space' && t.type !== 'deep_space' && t.type !== 'lost_fleet_ship');
	const log = (g.gameLog ?? []).filter(e => e.tileId).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
	const out = [];
	for (const e of g.actionJournal) {
		if (e.action !== 'Advanced Research' || !Array.isArray(e.candidates) || !e.playerBefore) continue;
		const rc = e.candidates.filter(c => c.type === 'advance_research' && TRACKS.includes(c.trackId));
		if (rc.length < 2) continue;
		const det = (e.details || '').toLowerCase().replace(/\s/g, '');
		const y = rc.findIndex(c => det.includes(c.trackId.toLowerCase()));
		if (y < 0) continue;

		// 이 시점의 맵 상태를 로그로 재구성 (내 건물 / 이미 쓰인 트랜스딤)
		const ts = e.timestamp ?? Infinity;
		const mine = [], taken = new Set();
		for (const Lg of log) {
			if ((Lg.timestamp ?? 0) >= ts) break;
			const tile = geo.get(Lg.tileId);
			if (!tile) continue;
			if (OWNED_ACT.test(Lg.action || '')) {
				if (Lg.playerId === e.playerId) mine.push(tile);
				taken.add(Lg.tileId);
			} else if (/^Placed Gaiaformer/.test(Lg.action || '')) taken.add(Lg.tileId);
		}

		const research = e.playerBefore.research || {};
		const res = e.playerBefore.resources || {};
		const faction = e.playerBefore.faction || e.faction || '';
		const nav = research.navigation ?? 0;
		const rng = getRange(nav);
		const near = (tile, r) => mine.some(p => dist(p, tile) <= r);
		let oppTerra = 0, oppNav = 0, oppGaia = 0;
		if (mine.length) {
			for (const tile of planets) {
				if (taken.has(tile.id)) continue;
				if (tile.type === 'transdim') { if (near(tile, rng + 2)) oppGaia++; continue; }
				const s = steps(faction, tile.type);
				if (s >= 1 && s <= 3 && near(tile, rng)) oppTerra++;
				if (near(tile, getRange(nav + 1)) && !near(tile, rng)) oppNav++;
			}
		}
		const levels = TRACKS.map(t => research[t] ?? 0);
		const ctx = {
			research, res, round: Number(e.round) || 1,
			power: (res.power1 ?? 0) + (res.power2 ?? 0) + (res.power3 ?? 0),
			structures: mine.length,
			hasFed: (e.playerBefore.federations ?? []).length > 0,
			meanLevel: levels.reduce((a, b) => a + b, 0) / 6,
			tiles: (e.playerBefore.techTiles ?? []).length,
			oppTerra, oppNav, oppGaia,
		};
		const X = rc.map(c => featurize(c, ctx));
		if (X.some(x => !x)) continue;
		out.push({ X, y, n: rc.length });
	}
	return out;
}

// ---- 데이터 적재 (게임 단위로 묶어 폴드 누출 방지) ----
const games = [], dates = [];
for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.json')).sort()) {
	let g;
	try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	const d = decisionsOf(g);
	if (d.length) { games.push(d); dates.push(f.slice(0, 10)); }
}
const total = games.reduce((a, d) => a + d.length, 0);
const candSum = games.reduce((a, d) => a + d.reduce((x, e) => x + e.n, 0), 0);
console.log(`게임 ${games.length}판 · 결정 ${total}건 · 평균 후보 ${(candSum / total).toFixed(1)}개`);
if (total < 500) { console.log('표본 부족 — 중단'); process.exit(1); }

// ---- 학습(리스트와이즈 softmax CE) ----
function train(trainSet, epochs, lr = 0.05, l2 = 1e-4) {
	const w = new Array(FEAT).fill(0);
	const order = trainSet.map((_, i) => i);
	let seed = 12345;
	const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	const snaps = {};
	for (let ep = 1; ep <= epochs; ep++) {
		for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
		for (const idx of order) {
			const { X, y } = trainSet[idx];
			const s = X.map(x => { let v = 0; for (let k = 0; k < FEAT; k++) v += w[k] * x[k]; return v; });
			const mx = Math.max(...s);
			const ex = s.map(v => Math.exp(v - mx));
			const Z = ex.reduce((a, b) => a + b, 0);
			for (let c = 0; c < X.length; c++) {
				const p = ex[c] / Z;
				const g = p - (c === y ? 1 : 0);
				const x = X[c];
				for (let k = 0; k < FEAT; k++) if (x[k]) w[k] -= lr * g * x[k];
			}
			for (let k = 0; k < FEAT; k++) w[k] -= lr * l2 * w[k];
		}
		if (CKPTS.includes(ep)) snaps[ep] = w.slice();
	}
	return snaps;
}

const top1 = (set, w) => {
	let hit = 0;
	for (const { X, y } of set) {
		let best = -Infinity, bi = 0;
		for (let c = 0; c < X.length; c++) {
			let v = 0;
			for (let k = 0; k < FEAT; k++) v += w[k] * X[c][k];
			if (v > best) { best = v; bi = c; }
		}
		if (bi === y) hit++;
	}
	return 100 * hit / set.length;
};
const baseBot = (set) => 100 * set.filter(d => d.y === 0).length / set.length;
const baseRand = (set) => 100 * set.reduce((a, d) => a + 1 / d.n, 0) / set.length;

// ---- K-폴드 쌍대차 ----
const perFold = { rand: [], bot: [] };
for (const ep of CKPTS) perFold[ep] = [];
for (let k = 0; k < FOLDS; k++) {
	const val = [], tr = [];
	games.forEach((d, i) => (i % FOLDS === k ? val : tr).push(...d));
	const snaps = train(tr, Math.max(...CKPTS));
	perFold.rand.push(baseRand(val));
	perFold.bot.push(baseBot(val));
	for (const ep of CKPTS) perFold[ep].push(top1(val, snaps[ep]));
	process.stdout.write(`  fold ${k + 1}/${FOLDS} (val ${val.length}건) 완료\n`);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const se = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1) / a.length); };
const pairedSE = (a, b) => se(a.map((v, i) => v - b[i]));

console.log(`\n그룹내 top-1 (연구 후보들 사이에서 사람 픽 1등 — bot.ts가 실제로 읽게 될 해상도)`);
console.log(`  무작위          ${mean(perFold.rand).toFixed(2)}%`);
console.log(`  봇 현재 순서    ${mean(perFold.bot).toFixed(2)}%   (기준선)`);
let best = null;
for (const ep of CKPTS) {
	const m = mean(perFold[ep]);
	const d = m - mean(perFold.bot);
	const s = pairedSE(perFold[ep], perFold.bot);
	console.log(`  랭커 @${String(ep).padStart(3)}ep  ${m.toFixed(2)}%   vs 봇 ${d >= 0 ? '+' : ''}${d.toFixed(2)}%p ± ${s.toFixed(2)}  (${(d / s).toFixed(1)}σ)`);
	if (!best || m > best.m) best = { ep, m, d, s };
}
console.log(`\n최고점: @${best.ep}ep ${best.m.toFixed(2)}% (봇 대비 ${best.d >= 0 ? '+' : ''}${best.d.toFixed(2)}%p ± ${best.s.toFixed(2)})`);
console.log(`게이트(+2%p & >2×SE): ${best.d >= 2 && best.d > 2 * best.s ? '통과 — 봇 통합 진행 가능' : '미달 — 통합하지 않음'}`);

// ---- 시간 분할 검증 ----
// K-폴드는 게임 단위 누출은 막지만 '옛 메타에만 맞는 랭커'는 못 거른다. 실제 배포는 언제나
// 과거로 학습해 미래에 쓰는 형태이므로, 마지막 25%(최신 게임)를 한 번도 안 본 검증셋으로 따로 본다.
{
	const cut = Math.floor(games.length * 0.75);
	const trG = games.slice(0, cut), vaG = games.slice(cut);
	const tr = trG.flat(), va = vaG.flat();
	if (va.length >= 200) {
		const snaps = train(tr, Math.max(...CKPTS));
		const bBot = baseBot(va), bRand = baseRand(va);
		let bestT = null;
		for (const ep of CKPTS) { const m = top1(va, snaps[ep]); if (!bestT || m > bestT.m) bestT = { ep, m }; }
		console.log(`\n시간 분할 (학습 ${trG.length}판 ~${dates[cut - 1]} → 검증 ${vaG.length}판 ${dates[cut]}~, ${va.length}건)`);
		console.log(`  무작위 ${bRand.toFixed(2)}%  ·  봇 현재 순서 ${bBot.toFixed(2)}%  ·  랭커 @${bestT.ep}ep ${bestT.m.toFixed(2)}%  (봇 대비 ${(bestT.m - bBot >= 0 ? '+' : '')}${(bestT.m - bBot).toFixed(2)}%p)`);
	}
}

// 전체 데이터로 최종 학습 후 저장(게이트 통과 여부와 무관하게 산출물은 남긴다)
const all = games.flat();
const finalSnaps = train(all, best.ep);
fs.writeFileSync(OUT, JSON.stringify({
	version: 1, featDim: FEAT, tracks: TRACKS, epochs: best.ep,
	valTop1: Number(best.m.toFixed(2)), botBaseline: Number(mean(perFold.bot).toFixed(2)),
	w: finalSnaps[best.ep].map(v => Number(v.toFixed(6))),
}, null, 1));
console.log(`저장: ${OUT}`);
