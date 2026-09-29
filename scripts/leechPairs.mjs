/**
 * 파워 리치(leech) 준 사람 -> 받은 사람 쌍 분석 (사람 4명 게임).
 *
 * 로그: 'Received Power' 액션 안에 수락("↳ Received Power +2P (-1VP)"), 직접 거절("↳ Declined Power"),
 * 자동 거절("(auto: bowls full)", "(auto: passed)")이 받은 사람 기준으로 남는다. 준 사람(건설자)은 안 남으므로
 * 건설 이벤트를 재생해 각 건설 시점에 반경 2 안에 건물이 있던 상대(서버 findNearbyPlayersForPower: 상대별 최고 파워값)를
 * 구하고, 결과 행을 가장 최근의 '자격 있는' 건설 이벤트에 매칭한다.
 *
 * 두 가지 선택을 분리한다.
 *  A) 준 사람의 배치: 지은 건물이 각 상대에게 열어 준 파워 비중(기준 1/3). 특정 사람 곁을 피하거나 붙는 경향.
 *  B) 받는 사람의 수락: 자동 거절을 뺀 '선택 가능한 제안'에서 수락 확률. 받는 사람 x 제안 파워(1/2/3+)로 기대치를
 *     만들고, 특정 준 사람에게서만 기대보다 적게/많이 받는지 본다.
 *
 * 사용: node scripts/leechPairs.mjs [--min=8]
 */
import fs from 'fs';
import { getDistance } from '../shared/gameConfig.ts';

const DIR = 'data/human-games';
const MIN = Number((process.argv.find(a => a.startsWith('--min=')) || '--min=8').split('=')[1]);
const isBot = n => /^AI Bot/i.test((n || '').trim());
const VAL = { mine: 1, trading_station: 2, research_lab: 2, academy: 3, planetary_institute: 3 };
const MINE_EVENT = new Set(['Built Mine', 'Built Mine on Asteroid', 'Built Mine on Proto', 'Eclipse: Built mine on asteroid', 'Ship Tech: 2TF+Mine']);
const UP_EVENT = {
	'Upgraded to Trading Station': 'trading_station',
	'Upgraded to Research Lab': 'research_lab',
	'Upgraded to Academy': 'academy',
	'Upgraded to Academy (Bescods/매안)': 'academy',
	'Upgraded to Planetary Institute': 'planetary_institute',
	'Upgraded to Planetary Institute (Bescods/매안)': 'planetary_institute',
	'Rebellion: Mine → TS': 'trading_station',
	'Twilight: TS → Research Lab': 'research_lab',
};

const games = [];
const recs = []; // 결과 행 (매칭된 것만)
let outcomes = 0, unattributed = 0, evCount = 0;
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.json'))) {
	let g; try { g = JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8')); } catch { continue; }
	const ps = g.players || {};
	const pids = Object.keys(ps);
	if (pids.length !== 4 || pids.some(id => isBot(ps[id].name))) continue;
	const tiles = new Map((g.map || []).map(t => [t.id, t]));
	const struct = new Map();
	const para = new Map();
	const events = [];
	const pot = {};
	const log = g.fullGameLog || g.gameLog || [];
	const gi = { f, pids, ps, pot };

	const offersFor = (src, tid) => {
		const t = tiles.get(tid); if (!t) return null;
		const offers = new Map();
		const bump = (owner, v) => { if (!owner || owner === src || v <= 0) return; if (!offers.has(owner) || offers.get(owner) < v) offers.set(owner, v); };
		for (const [id, s] of struct) { const o = tiles.get(id); if (o && getDistance(t, o) <= 2) bump(s.owner, VAL[s.structure] ?? 0); }
		for (const [id, owner] of para) { const o = tiles.get(id); if (o && getDistance(t, o) <= 2) bump(owner, 1); }
		return offers;
	};
	const fire = (src, tid, round) => {
		const offers = offersFor(src, tid);
		if (!offers) return;
		events.push({ src, offers, round });
		evCount++;
		for (const [o, v] of offers) { const c = ((pot[src] ||= {})[o] ||= { n: 0, power: 0 }); c.n++; c.power += v; }
	};

	for (const e of log) {
		const a = e.action || '', pid = e.playerId, tid = e.tileId;
		if (a === 'Placed Starting Mine' && tid) struct.set(tid, { owner: pid, structure: 'mine' });
		else if (a === 'Placed Starting Planetary Institute' && tid) struct.set(tid, { owner: pid, structure: 'planetary_institute' });
		else if (MINE_EVENT.has(a) && tid) { struct.set(tid, { owner: pid, structure: 'mine' }); fire(pid, tid, e.round); }
		else if (UP_EVENT[a] && tid) { struct.set(tid, { owner: pid, structure: UP_EVENT[a] }); fire(pid, tid, e.round); }
		else if (a === 'Built Parasitic Mine' && tid) { para.set(tid, pid); fire(pid, tid, e.round); }
		else if (a === 'Received Power') {
			const d = e.details || '';
			let kind = null, amt = 0, vp = 0;
			let m;
			if ((m = /Received Power \+(\d+)P(?:\s*\(-(\d+)VP\))?/.exec(d))) { kind = 'acc'; amt = +m[1]; vp = +(m[2] || 0); }
			else if (/Declined Power \(auto: bowls full\)/.test(d)) kind = 'autoFull';
			else if (/Declined Power \(auto: passed\)/.test(d)) kind = 'autoPass';
			else if (/Declined Power/.test(d)) kind = 'decline';
			if (!kind) continue;
			outcomes++;
			let ev = null;
			for (let k = events.length - 1, n = 0; k >= 0 && n < 12; k--, n++) {
				if (events[k].src !== pid && events[k].offers.has(pid)) { ev = events[k]; break; }
			}
			if (!ev) { unattributed++; continue; }
			recs.push({ g: gi, src: ev.src, rec: pid, kind, amt, vp, maxP: Math.min(3, ev.offers.get(pid)), round: e.round });
		}
	}
	games.push(gi);
}

const name = (g, id) => g.ps[id].name;
const fac = (g, id) => g.ps[id].faction;
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
console.log(`4인 사람 게임 ${games.length}판 | 건설 이벤트(재생) ${evCount} | 결과 행 ${outcomes} 중 출처 매칭 ${recs.length} (${(100 * recs.length / outcomes).toFixed(1)}%), 미매칭 ${unattributed}`);
const cnt = k => recs.filter(r => r.kind === k).length;
console.log(`결과 분포: 수락 ${cnt('acc')} / 직접거절 ${cnt('decline')} / 자동거절(그릇가득) ${cnt('autoFull')} / 자동거절(패스) ${cnt('autoPass')}`);
const dec = recs.filter(r => r.kind === 'acc' || r.kind === 'decline');
console.log(`선택 가능한 제안 ${dec.length}건 중 수락률 ${(100 * dec.filter(r => r.kind === 'acc').length / dec.length).toFixed(1)}%`);
const paid = dec.filter(r => r.kind === 'acc' && r.vp > 0);
console.log(`수락 ${dec.filter(r => r.kind === 'acc').length}건 중 VP 지불 ${paid.length}건 (${(100 * paid.length / dec.filter(r => r.kind === 'acc').length).toFixed(0)}%)`);

// ===== A) 준 사람의 배치 몫 =====
function placementRows(keyG, keyO) {
	const rows = [];
	for (const g of games) for (const G of g.pids) {
		const tot = g.pids.filter(o => o !== G).reduce((s, o) => s + (g.pot[G]?.[o]?.power ?? 0), 0);
		if (tot <= 0) continue;
		for (const O of g.pids) if (O !== G) rows.push({ kg: keyG(g, G), ko: keyO(g, O), share: (g.pot[G]?.[O]?.power ?? 0) / tot });
	}
	return rows;
}
function placementTable(title, rows, minN, topK) {
	const s = sd(rows.map(r => r.share));
	const by = new Map();
	for (const r of rows) { const k = `${r.kg} -> ${r.ko}`; (by.get(k) || by.set(k, []).get(k)).push(r.share); }
	const out = [...by].filter(([, v]) => v.length >= minN).map(([k, v]) => ({ k, n: v.length, share: mean(v), z: (mean(v) - 1 / 3) / (s / Math.sqrt(v.length)) })).sort((a, b) => a.z - b.z);
	console.log(`\n== A) ${title}: 준 사람이 상대에게 열어 준 파워 비중 (쌍 ${out.length}개, 기준 33.3%, sd=${s.toFixed(3)})`);
	const f = r => `${r.k.padEnd(24)} n=${String(r.n).padStart(3)} 몫 ${(100 * r.share).toFixed(0).padStart(3)}%  z=${r.z.toFixed(2)}`;
	console.log('-- 피하는 쪽'); out.slice(0, topK).forEach(r => console.log(f(r)));
	console.log('-- 붙는 쪽'); out.slice(-topK).reverse().forEach(r => console.log(f(r)));
	console.log(`|z|>=2: ${out.filter(r => Math.abs(r.z) >= 2).length}개 (무작위 기대 ${(out.length * 0.0455).toFixed(1)}개), |z|>=3: ${out.filter(r => Math.abs(r.z) >= 3).length}개 (기대 ${(out.length * 0.0027).toFixed(1)}개)`);
}
placementTable('사람 쌍', placementRows((g, id) => name(g, id), (g, id) => name(g, id)), MIN, 8);
placementTable('종족 쌍', placementRows((g, id) => fac(g, id), (g, id) => fac(g, id)), 12, 8);

// ===== B) 받는 사람의 수락 =====
// 기대치: 받는 사람(이름) x 제안 파워(1/2/3+)별 수락률. 자동 거절은 제외.
// 라운드가 수락률을 크게 좌우(R1 96% -> R6 65%)하므로 라운드 구간(R1-4 / R5 / R6)도 층화한다.
const rb = r => (r.round >= 6 ? 6 : r.round === 5 ? 5 : 1);
const key0 = r => `${name(r.g, r.rec)}|${r.maxP}|${rb(r)}`;
const base = new Map();
for (const r of dec) { const b = base.get(key0(r)) || base.set(key0(r), { a: 0, n: 0 }).get(key0(r)); b.n++; if (r.kind === 'acc') b.a++; }
function pairDecision(title, keyG, keyR, minN, topK) {
	const by = new Map();
	for (const r of dec) {
		const b = base.get(key0(r)); const p = b.a / b.n;
		const k = `${keyG(r)} -> ${keyR(r)}`;
		const x = by.get(k) || by.set(k, { n: 0, a: 0, e: 0, v: 0 }).get(k);
		x.n++; if (r.kind === 'acc') x.a++; x.e += p; x.v += p * (1 - p);
	}
	const out = [...by].filter(([, x]) => x.n >= minN && x.v > 0).map(([k, x]) => ({ k, n: x.n, a: x.a, e: x.e, z: (x.a - x.e) / Math.sqrt(x.v) })).sort((a, b) => a.z - b.z);
	console.log(`\n== B) ${title}: 받는 사람의 수락 (자동거절 제외, 그 사람의 평소 수락률·제안 파워로 보정, 쌍 ${out.length}개)`);
	const f = r => `${r.k.padEnd(24)} 제안 ${String(r.n).padStart(3)}건  수락 ${String(r.a).padStart(3)} (기대 ${r.e.toFixed(1)})  z=${r.z.toFixed(2)}`;
	console.log('-- 특히 거절한 쪽 (기대보다 덜 받음)'); out.slice(0, topK).forEach(r => console.log(f(r)));
	console.log('-- 특히 받아 준 쪽 (기대보다 더 받음)'); out.slice(-topK).reverse().forEach(r => console.log(f(r)));
	console.log(`|z|>=2: ${out.filter(r => Math.abs(r.z) >= 2).length}개 (기대 ${(out.length * 0.0455).toFixed(1)}개), |z|>=3: ${out.filter(r => Math.abs(r.z) >= 3).length}개 (기대 ${(out.length * 0.0027).toFixed(1)}개)`);
}
pairDecision('사람 쌍 (준 사람 -> 받은 사람)', r => name(r.g, r.src), r => name(r.g, r.rec), 15, 8);

// 재현성: 게임을 시간순 절반으로 나눠 앞/뒤 각각에서 같은 방향인지 (진짜 성향이면 둘 다 같은 부호여야 함)
{
	const sortedF = [...new Set(games.map(g => g.f))].sort();
	const half = new Set(sortedF.slice(0, Math.floor(sortedF.length / 2)));
	const calc = (sel) => {
		const by = new Map();
		for (const r of dec.filter(sel)) {
			const b = base.get(key0(r)); const p = b.a / b.n;
			const k = `${name(r.g, r.src)} -> ${name(r.g, r.rec)}`;
			const x = by.get(k) || by.set(k, { n: 0, a: 0, e: 0, v: 0 }).get(k);
			x.n++; if (r.kind === 'acc') x.a++; x.e += p; x.v += p * (1 - p);
		}
		return by;
	};
	const A1 = calc(r => half.has(r.g.f)), A2 = calc(r => !half.has(r.g.f));
	const z = x => (x && x.v > 0 ? (x.a - x.e) / Math.sqrt(x.v) : 0);
	const all = [];
	for (const [k, x] of calc(() => true)) if (x.n >= 15) all.push({ k, tot: z(x), z1: z(A1.get(k)), z2: z(A2.get(k)), n1: A1.get(k)?.n ?? 0, n2: A2.get(k)?.n ?? 0 });
	const same = all.filter(r => Math.sign(r.z1) === Math.sign(r.z2) && Math.abs(r.tot) >= 2);
	const strong = all.filter(r => Math.abs(r.tot) >= 2);
	console.log(`\n== B 재현성 검사: |z|>=2 쌍 ${strong.length}개 중 앞절반·뒷절반 부호가 같은 것 ${same.length}개 (무작위면 약 절반)`);
	all.sort((a, b) => a.tot - b.tot);
	for (const r of [...all.slice(0, 6), ...all.slice(-6)]) console.log(`${r.k.padEnd(22)} 전체 z=${r.tot.toFixed(2).padStart(6)} | 앞 z=${r.z1.toFixed(2).padStart(6)} (n=${r.n1}) | 뒤 z=${r.z2.toFixed(2).padStart(6)} (n=${r.n2})`);
}

// 받는 사람별 기본 성향
{
	const by = new Map();
	for (const r of recs) { const k = name(r.g, r.rec); const x = by.get(k) || by.set(k, { acc: 0, dec: 0, full: 0, pass: 0 }).get(k); if (r.kind === 'acc') x.acc++; else if (r.kind === 'decline') x.dec++; else if (r.kind === 'autoFull') x.full++; else x.pass++; }
	console.log('\n== 받는 사람별 성향 (제안 60건 이상): 수락 / 직접거절 / 그릇가득 / 패스후');
	[...by].filter(([, x]) => x.acc + x.dec + x.full + x.pass >= 60).map(([k, x]) => ({ k, ...x, rate: x.acc / (x.acc + x.dec || 1) }))
		.sort((a, b) => a.rate - b.rate)
		.forEach(r => console.log(r.k.padEnd(12), `수락 ${String(r.acc).padStart(4)} 직접거절 ${String(r.dec).padStart(4)} 그릇가득 ${String(r.full).padStart(4)} 패스후 ${String(r.pass).padStart(3)}  선택수락률 ${(100 * r.rate).toFixed(0)}%`));
}
// 종족별: 받는 종족 수락률, 종족 쌍
{
	const by = new Map();
	for (const r of dec) { const k = fac(r.g, r.rec); const x = by.get(k) || by.set(k, { a: 0, n: 0 }).get(k); x.n++; if (r.kind === 'acc') x.a++; }
	console.log('\n== 받는 종족별 선택 수락률');
	[...by].map(([k, x]) => ({ k, ...x })).sort((a, b) => a.a / a.n - b.a / b.n).forEach(r => console.log(r.k.padEnd(14), `n=${String(r.n).padStart(4)} ${(100 * r.a / r.n).toFixed(0)}%`));
}
// 라운드별
{
	console.log('\n== 라운드별 선택 수락률');
	for (let rd = 1; rd <= 6; rd++) { const x = dec.filter(r => r.round === rd); if (x.length) console.log(`R${rd} n=${x.length} 수락 ${(100 * x.filter(r => r.kind === 'acc').length / x.length).toFixed(0)}%`); }
}
