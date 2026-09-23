/**
 * [진단] 사람이 만든 연방(fedHexes 기록, 2026-08-31~) 시점의 보드를 리플레이로 복원해 봇 FederationPlanner를 돌린다.
 *  질문: 사람은 만들었는데 플래너는 왜 후보 0개였나 — powerShort / 탐색 null / 5건물 스킵 / 봇 예비토큰 가드 중 어디서 막히나.
 *  사용: PORT=5131 npx tsx script/fedReplayProbe.ts [--since 2026-08-31] [--verbose]
 */
import * as fs from 'fs';
import * as path from 'path';
import { FederationPlanner } from '../server/ai/federationPlanner';
import { BotLogic } from '../server/ai/bot';
import { getFederationRequiredPower, getFederationBuildingPower } from '../server/gameState';
import { createInitialPlayerState, FEDERATION_REWARDS } from '../shared/gameConfig';
const out = (s: string) => fs.writeSync(1, s + '\n');
const args = process.argv.slice(2);
const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : '2026-08-31';
const verbose = args.includes('--verbose');
const dir = path.join(process.cwd(), 'data', 'human-games');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f >= since).sort();

type Row = { game: string; name: string; faction: string; round: number; humanSats: number; humanPower: number; found: number; minTok: number | null; reserveBlocked: boolean | null; diag: any; reason: string };
const rows: Row[] = [];
for (const f of files) {
	let d: any; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
	if (d.roundNumber !== 6 || !d.map) continue;
	const bots = new Set<string>(d.botPlayerIds || []);
	const log = [...(d.fullGameLog || [])].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
	const glog = [...(d.gameLog || [])];
	const journal = [...(d.actionJournal || [])];
	// 리플레이 상태
	const map: any[] = d.map.map((t: any) => ({ ...t, ownerId: null, structure: null, parasiticMine: undefined, spaceStation: undefined, hasGaiaformer: false }));
	const byId = new Map<string, any>(map.map(t => [t.id, t]));
	const fedHexesOf: Record<string, string[]> = {}; const satellites: Record<string, string[]> = {}; const fedCount: Record<string, number> = {};
	for (const ev of log) {
		const pid = ev.playerId, a = ev.action || '', tid = ev.tileId, r = ev.round || 0;
		if (a === 'Federation' && Array.isArray(ev.fedHexes) && pid && !bots.has(pid)) {
			// ── 이 시점에서 플래너 진단 ──
			const g: any = {
				id: d.gameId, map, players: {}, roundNumber: r, playerFederationHexes: { ...fedHexesOf }, satellites: { ...satellites },
				spaceships: {}, availableBonusTiles: [], gameLog: [], botPlayerIds: [],
				// 보상 풀이 없으면 finalizeFederation이 null을 돌려 전부 searchNull로 보임 — 기하 진단이 목적이라 풀은 넉넉히 채운다
				federationPool: Object.fromEntries(FEDERATION_REWARDS.map((r: any) => [r.id, 3])),
			};
			for (const [qid, qp] of Object.entries<any>(d.players)) { const ps: any = createInitialPlayerState(qp.name); ps.faction = qp.faction; g.players[qid] = ps; }
			const me: any = g.players[pid];
			const snap = glog.find(e => e.playerId === pid && e.action === 'Federation' && e.timestamp === ev.timestamp);
			const base = snap?.base;
			const je = journal.find(e => e.playerId === pid && e.action === 'Federation' && e.timestamp === ev.timestamp) || journal.find(e => e.playerId === pid && Math.abs((e.timestamp || 0) - ev.timestamp) < 1500 && e.playerBefore);
			const pb = je?.playerBefore;
			if (!base) { continue; } // 자원 스냅 없으면 판정 불가
			Object.assign(me, { power1: base.p1 ?? 0, power2: base.p2 ?? 0, power3: base.p3 ?? 0, qic: base.q ?? 0, ore: base.o ?? 0, credits: base.c ?? 0, knowledge: base.k ?? 0 });
			if (pb) { me.techTiles = pb.techTiles ?? []; me.research = pb.research ?? me.research; me.federations = pb.federations ?? []; }
			else { me.federations = Array.from({ length: fedCount[pid] || 0 }, () => ({ rewardId: 'fed-7vp-2o', isGreen: true })); }
			const humanSats = Number((/(\d+) satellites/.exec(ev.details || '') || [])[1] ?? 0);
			const humanPower = Number((/(\d+) power/.exec(ev.details || '') || [])[1] ?? 0);
			let found = 0, minTok: number | null = null, reason = '';
			let diag: any = null;
			try {
				const res = FederationPlanner.getFederationActions(g, pid, 0, 5);
				diag = FederationPlanner.lastDiag;
				found = res.length; if (res.length) minTok = Math.min(...res.map(x => x.spentTokens));
			} catch (e) { reason = 'error:' + String(e).slice(0, 60); }
			let reserveBlocked: boolean | null = null;
			if (found) { reserveBlocked = !(BotLogic as any).canSpendPowerTokensForStrategicAction(g, me, minTok); }
			if (!reason) {
				if (found && reserveBlocked) reason = 'found→reserveBlocked';
				else if (found) reason = 'found';
				else if (diag?.powerShort) reason = 'powerShort';
				else if (diag && diag.structures === 0) reason = 'noStructures';
				else if (diag && diag.max5Skipped > 0 && diag.results === 0) reason = 'max5Skipped';
				else if (diag && diag.nulls === diag.starts) reason = 'searchNull';
				else reason = 'other';
			}
			rows.push({ game: f.slice(0, 19), name: d.players[pid]?.name, faction: d.players[pid]?.faction, round: r, humanSats, humanPower, found, minTok, reserveBlocked, diag, reason });
			if (verbose && reason !== 'found') out(`  ${f.slice(0, 19)} R${r} ${d.players[pid]?.name}(${d.players[pid]?.faction}) 사람: 위성${humanSats}·${humanPower}p | ${reason} | diag ${JSON.stringify(diag)} | tokens p1/p2/p3=${me.power1}/${me.power2}/${me.power3} q=${me.qic}`);
		}
		// ── 이벤트 반영 ──
		const t = tid ? byId.get(tid) : undefined;
		if (t) {
			if (a === 'Built Mine' || a === 'Built Mine on Asteroid' || a === 'Built Mine on Proto' || a === 'Placed Starting Mine') { t.ownerId = pid; t.structure = 'mine'; }
			else if (a === 'Placed Starting Planetary Institute') { t.ownerId = pid; t.structure = 'planetary_institute'; }
			else if (a.startsWith('Lost Planet')) { t.ownerId = pid; t.structure = 'lost_planet_mine'; t.type = 'lost_planet'; }
			else if (a.startsWith('Upgraded to Trading Station') || a === 'Rebellion: Mine → TS') { t.ownerId = pid; t.structure = 'trading_station'; }
			else if (a.startsWith('Upgraded to Research Lab') || a === 'Twilight: TS → Research Lab') { t.ownerId = pid; t.structure = 'research_lab'; }
			else if (a.startsWith('Upgraded to Planetary')) { t.ownerId = pid; t.structure = 'planetary_institute'; }
			else if (a.startsWith('Upgraded to Academy')) { t.ownerId = pid; t.structure = 'academy'; }
			else if (a === 'Built Parasitic Mine') { t.parasiticMine = { ownerId: pid }; }
			else if (a.startsWith('Ivits: Space Station')) { t.spaceStation = { ownerId: pid }; }
		}
		if (a === 'Federation' && Array.isArray(ev.fedHexes) && pid) {
			fedHexesOf[pid] = [...(fedHexesOf[pid] || []), ...ev.fedHexes];
			for (const h of ev.fedHexes) { const ht = byId.get(h); if (ht && !(ht.ownerId === pid && ht.structure) && !(ht.parasiticMine?.ownerId === pid) && !(ht.spaceStation?.ownerId === pid)) satellites[h] = [...(satellites[h] || []), pid]; }
			fedCount[pid] = (fedCount[pid] || 0) + 1;
		}
	}
}
const n = rows.length;
const cnt = (pred: (r: Row) => boolean) => rows.filter(pred).length;
out(`\n사람 연방(fedHexes 기록) ${n}건 (${since}~, 사람 좌석만)`);
const reasons = new Map<string, number>(); rows.forEach(r => reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1));
for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) out(`  ${k.padEnd(22)} ${v.toString().padStart(5)}  (${(100 * v / n).toFixed(0)}%)`);
out('\n라운드별 (플래너 후보 있음 / 예비가드 통과 / 전체):');
for (let r = 1; r <= 6; r++) { const rr = rows.filter(x => x.round === r); if (!rr.length) continue; out(`  R${r}: 후보 ${cnt(x => x.round === r && x.found > 0)} / 가드통과 ${cnt(x => x.round === r && x.reason === 'found')} / ${rr.length}`); }
out('\n사람 위성 수별:');
for (const s of [0, 1, 2, 3, 4, 5]) { const rr = rows.filter(x => (s < 5 ? x.humanSats === s : x.humanSats >= 5)); if (!rr.length) continue; out(`  위성 ${s < 5 ? s : '5+'}: 후보있음 ${rr.filter(x => x.found > 0).length}/${rr.length}  가드통과 ${rr.filter(x => x.reason === 'found').length}`); }
const fr = rows.filter(x => x.found > 0 && x.minTok != null);
if (fr.length) out(`\n플래너 최소 위성 vs 사람 위성 (후보 있던 ${fr.length}건): 플래너 평균 ${(fr.reduce((s, x) => s + (x.minTok || 0), 0) / fr.length).toFixed(2)} / 사람 평균 ${(fr.reduce((s, x) => s + x.humanSats, 0) / fr.length).toFixed(2)}`);
// 예비 임계별 통과율: 사용 후 잔여 토큰 = 총토큰 − 플래너 최소 위성수 (이비츠는 QIC 지불이라 제외)
out('\n[예비 가드 감도] 후보 있던 연방(비이비츠) — 잔여 토큰 ≥ 임계 비율, 라운드별:');
for (let r = 1; r <= 6; r++) {
	const rr = rows.filter(x => x.round === r && x.found > 0 && x.minTok != null && x.faction !== 'ivits');
	if (!rr.length) continue;
	const rem = rr.map(x => x.diag.tokens - (x.minTok || 0));
	const pass = (th: number) => rem.filter(v => v >= th).length;
	out(`  R${r} n=${rr.length}: 잔여 중앙값 ${[...rem].sort((a, b) => a - b)[Math.floor(rem.length / 2)]} | ≥0 ${pass(0)} · ≥1 ${pass(1)} · ≥2 ${pass(2)} · ≥3 ${pass(3)} · ≥4 ${pass(4)}  (현재 예비: R1-2=4, R3-4=3→relax 1, R5=1, R6=0)`);
}
const byF = new Map<string, { n: number; found: number }>(); rows.forEach(r => { const e = byF.get(r.faction) || { n: 0, found: 0 }; e.n++; if (r.reason === 'found') e.found++; byF.set(r.faction, e); });
out('\n종족별 가드통과율(낮은 순):'); [...byF.entries()].filter(([, e]) => e.n >= 8).sort((a, b) => a[1].found / a[1].n - b[1].found / b[1].n).slice(0, 8).forEach(([f, e]) => out(`  ${f.padEnd(14)} ${e.found}/${e.n} (${(100 * e.found / e.n).toFixed(0)}%)`));
process.exit(0);
