/**
 * [2026-11-22 룰 점검] 코드끼리 어긋나던 버그 수정 회귀 테스트:
 *  ① 포머 없는 차원변형 행성 일반 광산 → 거부
 *  ② 매안(봇) 가장 낮은 트랙 +1: 4→5는 초록 연방 토큰 필요·소모
 *  ③ 봇 기술 타일 폴백: 즉시 보상(7VP) 지급, 의회 없는 발타크는 항법 불가
 *  ④ 봇 '3+행성 종류' 인공물: 잊혀진 행성 포함
 *  ⑤ 봇 연방: 이어진 건물 전체를 연방으로 기록
 * 실행: npx tsx script/testRuleAudit20261122.ts [final_state.json]
 */
import fs from 'fs';
import path from 'path';
import { executeBuildMine, executeBotBescodsAdvanceLowestTrack, executeBotSelectTechTile, executeTakeTwilightArtifact, executeBotFederation, ServerGameState } from '../server/gameState';

const io = { to: () => ({ emit: () => {} }), emit: () => {} } as any;
const file = process.argv[2] || 'logs/game_wb2qzftj_final_state.json';
const base: ServerGameState = JSON.parse(fs.readFileSync(file, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(base)) as ServerGameState;
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); ok ? pass++ : fail++; };
const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'] as const;

function setup(g: ServerGameState, faction: string) {
	const pid = g.turnOrder[0];
	g.currentPhase = 'main' as any; g.currentPlayerIndex = 0; g.hasDoneMainAction = false;
	(g as any).pendingPowerOffers = []; (g as any).pendingIncomeOrder = null;
	g.pendingSpaceshipFedMine = null; g.pendingTechTileSelection = null;
	const p = g.players[pid];
	p.faction = faction as any; p.ore = 10; p.credits = 20; p.qic = 5; p.knowledge = 5; p.pendingTerraformSteps = 0;
	p.usedSpecialActions = []; p.federations = []; p.pendingGaiaformerTiles = [];
	return pid;
}

// ①
{
	const g = clone(); const pid = setup(g, 'terran');
	const td = g.map.find(t => t.type === 'transdim' && !t.structure && !t.hasGaiaformer)!;
	(g.players[pid].research as any).navigation = 5; g.players[pid].qic = 20;
	const ok = executeBuildMine(io, g, pid, td.id);
	check('① bare transdim standard mine → rejected', !ok && td.structure === null, `ok=${ok}`);
}
// ②
{
	const g = clone(); const pid = setup(g, 'bescods'); const p = g.players[pid];
	for (const t of TRACKS) (p.research as any)[t] = 4;
	for (const id of Object.keys(g.players)) if (id !== pid) for (const t of TRACKS) (g.players[id].research as any)[t] = Math.min((g.players[id].research as any)[t] ?? 0, 4);
	const noTok = executeBotBescodsAdvanceLowestTrack(io, g, pid);
	check('② bescods 4→5 without green token → refused', !noTok && TRACKS.every(t => (p.research as any)[t] === 4), `ok=${noTok}`);
	p.federations = [{ rewardId: 'fed-7vp-6c', isGreen: true } as any];
	const withTok = executeBotBescodsAdvanceLowestTrack(io, g, pid);
	const lv5 = TRACKS.filter(t => (p.research as any)[t] === 5).length;
	check('② with green token → Lv5 and token flipped', withTok && lv5 === 1 && !(p.federations[0] as any).isGreen, `ok=${withTok} lv5=${lv5} fed=${JSON.stringify(p.federations)}`);
}
// ③
{
	const g = clone(); const pid = setup(g, 'terran'); const p = g.players[pid];
	for (const t of TRACKS) (p.research as any)[t] = 1;
	p.techTiles = [];
	(g as any).techTilesByTrack = { economy: [{ id: 'tech-imm-7vp' }] };
	g.techTilesPool = [] as any;
	g.pendingTechTileSelection = { playerId: pid, tileId: '', structureType: 'research_lab' } as any;
	const vp0 = p.score ?? 0;
	const ok = executeBotSelectTechTile(io, g, pid);
	check('③ fallback tech tile pays immediate 7VP', ok && p.techTiles.includes('tech-imm-7vp') && (p.score ?? 0) - vp0 >= 7, `ok=${ok} vp+${(p.score ?? 0) - vp0}`);

	const g2 = clone(); const pid2 = setup(g2, 'bal_tak'); const p2 = g2.players[pid2];
	for (const t of TRACKS) (p2.research as any)[t] = 4; (p2.research as any).navigation = 1;
	for (const m of g2.map) if (m.ownerId === pid2 && m.structure === 'planetary_institute') m.structure = 'mine';
	p2.techTiles = [];
	(g2 as any).techTilesByTrack = { navigation: [{ id: 'tech-imm-7vp' }] };
	g2.techTilesPool = [] as any;
	g2.pendingTechTileSelection = { playerId: pid2, tileId: '', structureType: 'research_lab' } as any;
	executeBotSelectTechTile(io, g2, pid2);
	check('③ bal tak without PI cannot advance navigation via fallback', (p2.research as any).navigation === 1, `nav=${(p2.research as any).navigation}`);
}
// ④
{
	const g = clone(); const pid = setup(g, 'terran'); const p = g.players[pid];
	const tw = g.map.find(t => t.type === 'ship_twilight');
	if (!tw) console.log('SKIP ④ (no twilight ship)');
	else {
		p.spaceshipsEntered = [tw.id]; p.power1 = 0; p.power2 = 0; p.power3 = 6; p.artifacts = [];
		(g as any).twilightArtifactSlots = ['art-vp-planet-types'];
		const space = g.map.find(t => t.type === 'space' && !t.structure)!;
		space.structure = 'lost_planet_mine' as any; space.ownerId = pid;
		const types = new Set(g.map.filter(t => t.ownerId === pid && t.structure && t.structure !== 'ship' && t.type !== 'space' && t.type !== 'deep_space').map(t => t.type));
		const vp0 = p.score ?? 0;
		const ok = executeTakeTwilightArtifact(io, g, pid, 'art-vp-planet-types');
		const gained = (p.score ?? 0) - vp0;
		check('④ bot planet-types artifact counts the lost planet', ok && gained === 3 + types.size + 1, `ok=${ok} +${gained} (planets ${types.size}, expect ${3 + types.size + 1})`);
	}
}
// ⑤
{
	const g = clone(); const pid = setup(g, 'terran');
	g.playerFederationHexes = { ...(g.playerFederationHexes ?? {}), [pid]: [] };
	for (const t of g.map) if (t.ownerId === pid) { t.ownerId = null as any; t.structure = null; }
	const ok = (t: any) => t && !['space', 'deep_space', 'transdim', 'lost_fleet_ship', 'ship_rebellion', 'ship_twilight', 'ship_tf_mars', 'ship_eclipse'].includes(t.type);
	const byQR = new Map(g.map.map(t => [`${t.q},${t.r}`, t]));
	const nb = (t: any) => [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]].map(([dq, dr]) => byQR.get(`${t.q + dq},${t.r + dr}`)).filter(ok);
	let chain: any[] | null = null;
	for (const a of g.map.filter(ok)) { for (const b of nb(a)) for (const c of nb(b)) { if (c === a) continue; for (const d of nb(c)) { if (d === a || d === b) continue; chain = [a, b, c, d]; break; } if (chain) break; } if (chain) break; }
	if (!chain) console.log('SKIP ⑤ (no 4-chain)');
	else {
		const kinds = ['planetary_institute', 'research_lab', 'trading_station', 'mine'];
		chain.forEach((t, i) => { t.ownerId = pid; t.structure = kinds[i]; t.parasiticMine = undefined; });
		(g as any).federationPool = { ...(g as any).federationPool, 'fed-7vp-6c': 3 };
		const res = executeBotFederation(io, g, pid, [], chain.slice(0, 3).map(t => t.id), 'fed-7vp-6c', 0);
		const rec = new Set(g.playerFederationHexes?.[pid] ?? []);
		check('⑤ bot federation records whole connected cluster (incl. the extra mine)', res && rec.has(chain[3].id), `ok=${res} recorded=${[...rec].length}`);
	}
}
console.log(`\n${pass} passed, ${fail} failed (${path.basename(file)})`);
process.exit(fail ? 1 : 0);
