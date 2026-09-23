/**
 * [진단] 봇 자가대국 final_state 로그를 리플레이해 R1-2 동안 각 봇 좌석의 매 행동 직후 보드에서 FederationPlanner를 돌린다.
 *  질문: 사람은 첫 연방을 R2까지 53%가 만드는데 봇은 11% — 7파워 군집이 없어서(powerShort)인지, 있는데 예비 토큰 가드가 막는지,
 *  아니면 후보가 있고 가드도 통과하는데 점수/MCTS가 안 고르는지.
 *  사용: PORT=5132 npx tsx script/botEarlyFedProbe.ts [--label champion|challenger|all] [--rounds 1,2] <final_state.json ...>
 */
import * as fs from 'fs';
import { FederationPlanner } from '../server/ai/federationPlanner';
import { BotLogic } from '../server/ai/bot';
import { createInitialPlayerState, FEDERATION_REWARDS } from '../shared/gameConfig';
const out = (s: string) => fs.writeSync(1, s + '\n');
const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const label = opt('--label', 'champion');
const rounds = opt('--rounds', '1,2').split(',').map(Number);
const minFeds = Number(opt('--minfeds', '0')); // N>0: 연방 N개 이상 보유 상태의 좌석만(다음 연방 기회 진단)
const files = args.filter(a => a.endsWith('.json'));
const MAIN = new Set(['Built Mine', 'Built Mine on Asteroid', 'Built Mine on Proto', 'Built Parasitic Mine', 'Upgraded to Trading Station', 'Upgraded to Research Lab', 'Upgraded to Planetary Institute', 'Upgraded to Academy', 'Power Action', 'Advanced Research', 'Entered Ship', 'Federation', 'Used Tech Action', 'Ivits: Space Station (Bot)', 'Lost Planet (Nav 5)']);

type Seat = { game: string; faction: string; round: number; probes: number; found: number; pass: number; powerShort: number; other: number; minTok: number | null; fedThisRound: boolean; raw: number; gates: Record<string, number> };
const seats: Seat[] = [];
for (const f of files) {
	let d: any; try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
	if (!d.map || !d.gameLog) continue;
	const log = [...d.gameLog].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
	const targets = new Set(Object.entries<any>(d.players).filter(([, p]) => label === 'all' || p.h2hLabel === label).map(([id]) => id));
	const map: any[] = d.map.map((t: any) => ({ ...t, ownerId: null, structure: null, parasiticMine: undefined, spaceStation: undefined, hasGaiaformer: false }));
	const byId = new Map<string, any>(map.map(t => [t.id, t]));
	const fedHexesOf: Record<string, string[]> = {}; const satellites: Record<string, string[]> = {}; const fedCount: Record<string, number> = {};
	const cur: Record<string, Seat> = {};
	const key = (pid: string, r: number) => pid + '#' + r;
	for (const ev of log) {
		const pid = ev.playerId, a = ev.action || '', tid = ev.tileId, r = ev.round || 0;
		// 이벤트 반영
		const t = tid ? byId.get(tid) : undefined;
		if (t && pid) {
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
		if (a === 'Federation' && pid) {
			if (Array.isArray(ev.fedHexes)) {
				fedHexesOf[pid] = [...(fedHexesOf[pid] || []), ...ev.fedHexes];
				for (const h of ev.fedHexes) { const ht = byId.get(h); if (ht && !(ht.ownerId === pid && ht.structure) && !(ht.parasiticMine?.ownerId === pid) && !(ht.spaceStation?.ownerId === pid)) satellites[h] = [...(satellites[h] || []), pid]; }
			}
			fedCount[pid] = (fedCount[pid] || 0) + 1;
			if (targets.has(pid) && cur[key(pid, r)]) cur[key(pid, r)].fedThisRound = true;
		}
		if (!pid || !targets.has(pid) || !rounds.includes(r) || !MAIN.has(a) || (fedCount[pid] || 0) !== minFeds) continue;
		const snap = ev.snap || ev.base; if (!snap) continue;
		const s = cur[key(pid, r)] ||= { game: f.slice(-25, -17), faction: d.players[pid].faction, round: r, probes: 0, found: 0, pass: 0, powerShort: 0, other: 0, minTok: null, fedThisRound: false, raw: 0, gates: {} };
		const g: any = { id: d.gameId, map, players: {}, roundNumber: r, playerFederationHexes: { ...fedHexesOf }, satellites: { ...satellites }, spaceships: {}, availableBonusTiles: [], gameLog: [], botPlayerIds: [], federationPool: Object.fromEntries(FEDERATION_REWARDS.map((x: any) => [x.id, 3])) };
		for (const [qid, qp] of Object.entries<any>(d.players)) { const ps: any = createInitialPlayerState(qp.name); ps.faction = qp.faction; g.players[qid] = ps; }
		const me: any = g.players[pid];
		Object.assign(me, { power1: snap.p1 ?? 0, power2: snap.p2 ?? 0, power3: snap.p3 ?? 0, qic: snap.q ?? 0, ore: snap.o ?? 0, credits: snap.c ?? 0, knowledge: snap.k ?? 0 });
		s.probes++;
		const W: Record<string, number> = { mine: 1, trading_station: 2, research_lab: 2, planetary_institute: 3, academy: 3, lost_planet_mine: 1 };
		s.raw = Math.max(s.raw, map.reduce((acc, x) => acc + (x.ownerId === pid && x.structure ? (W[x.structure] || 0) : 0) + (x.spaceStation?.ownerId === pid ? 1 : 0), 0));
		try {
			const res = FederationPlanner.getFederationActions(g, pid, 0, 5);
			const diag: any = FederationPlanner.lastDiag;
			if (res.length) {
				s.found++; const mt = Math.min(...res.map(x => x.spentTokens)); s.minTok = s.minTok == null ? mt : Math.min(s.minTok, mt);
				if ((BotLogic as any).canSpendPowerTokensForStrategicAction(g, me, mt)) s.pass++;
				const tot = (me.power1 || 0) + (me.power2 || 0) + (me.power3 || 0); const surplus = tot - mt; const isIv = me.faction === 'ivits';
				const G: Record<string, boolean> = {
					cur: (mt <= 2 || surplus >= 8) && (BotLogic as any).canSpendPowerTokensForStrategicAction(g, me, mt),
					relaxOnly: (mt <= 2 || surplus >= 8) && (surplus >= 1 || isIv),
					sat3_s1: mt <= 3 && (surplus >= 1 || isIv), sat4_s1: mt <= 4 && (surplus >= 1 || isIv), sat4_s2: mt <= 4 && (surplus >= 2 || isIv), sat5_s1: mt <= 5 && (surplus >= 1 || isIv), sat6_s0: mt <= 6 && (surplus >= 0 || isIv),
				};
				for (const [k, v] of Object.entries(G)) if (v) s.gates[k] = (s.gates[k] || 0) + 1;
			} else if (diag?.powerShort) s.powerShort++; else s.other++;
		} catch { s.other++; }
	}
	seats.push(...Object.values(cur));
}
for (const r of rounds) {
	const rr = seats.filter(s => s.round === r);
	const n = rr.length; if (!n) continue;
	const anyFound = rr.filter(s => s.found > 0), anyPass = rr.filter(s => s.pass > 0), fed = rr.filter(s => s.fedThisRound);
	out(`R${r}: 좌석(연방 ${minFeds}개 상태) ${n} | 어느 시점이든 플래너 후보 있음 ${anyFound.length} (${(100 * anyFound.length / n).toFixed(0)}%) | 후보+예비가드 통과 ${anyPass.length} (${(100 * anyPass.length / n).toFixed(0)}%) | 실제 이 라운드 연방 ${fed.length}`);
	const raw7 = rr.filter(s => s.raw >= 7);
	out(`   건물 원파워 합 ≥7 좌석 ${raw7.length} — 그중 후보 있음 ${raw7.filter(s => s.found > 0).length}, 가드통과 ${raw7.filter(s => s.pass > 0).length}, 실제연방 ${raw7.filter(s => s.fedThisRound).length}`);
	const mt = anyFound.map(s => s.minTok!); const dist: Record<number, number> = {}; mt.forEach(v => dist[v] = (dist[v] || 0) + 1);
	out(`   후보 있던 좌석의 최소 위성 분포 ${JSON.stringify(dist)}`);
	const gk = ['cur', 'relaxOnly', 'sat3_s1', 'sat4_s1', 'sat4_s2', 'sat5_s1', 'sat6_s0'];
	out(`   게이트별 통과 좌석(어느 시점이든): ${gk.map(k => `${k}=${rr.filter(s => (s.gates[k] || 0) > 0).length}`).join(' ')}`);
	const passNoFed = anyPass.filter(s => !s.fedThisRound);
	out(`   가드 통과했는데 연방 안 만든 좌석 ${passNoFed.length}: ${passNoFed.slice(0, 12).map(s => `${s.game}/${s.faction}(sat${s.minTok},pass${s.pass}/${s.probes})`).join(' ')}`);
	const byF: Record<string, [number, number]> = {}; rr.forEach(s => { const e = byF[s.faction] ||= [0, 0]; e[0]++; if (s.found > 0) e[1]++; });
	out(`   종족별 후보있음/좌석: ${Object.entries(byF).sort((a, b) => a[1][1] / a[1][0] - b[1][1] / b[1][0]).map(([f, e]) => `${f} ${e[1]}/${e[0]}`).join(', ')}`);
}
process.exit(0);
