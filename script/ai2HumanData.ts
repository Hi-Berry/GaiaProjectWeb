/**
 * [ai2 사람 데이터 2026-10-11] data/human-states(사람 턴 시작 전체 상태) + data/human-games(actionJournal = 실제로 둔 수)
 * → 정책·가치 학습 행(ai2GenData와 같은 형식).
 *
 *  상태 줄(playerId, ts) 마다: 그 시각 이후 그 사람의 첫 '메인 액션' 저널 항목을 라벨로(다음 턴 시작 전까지).
 *  라벨을 합법 수 생성기 선택지(generateMoves)에 맞춘다 — 못 맞추면 y = -1(집계만).
 *  프리액션은 라벨로 쓰지 않는다(턴 시작 상태 → 그 턴의 메인 의도). 게임 끝: 좌석별 최종 점수 + 이름(실력 가중용).
 *  사용: PORT=5191 npx tsx script/ai2HumanData.ts --out data/ai2/human
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { BotAction } from '../server/ai/bot';
import { prepareHeadless } from '../server/ai2/headlessDriver';
import { generateMoves, generatePendingOptions, moveKey, tryApply } from '../server/ai2/moveGen';
import { encodeState, encodeMove } from '../server/ai2/encoder';
import { ALL_BONUS_TILES } from '@shared/gameConfig';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const outDir = opt('--out', 'data/ai2/human');
const sparse = (a: ArrayLike<number>) => { const i: number[] = [], v: number[] = []; for (let k = 0; k < a.length; k++) if (a[k] !== 0) { i.push(k); v.push(Math.round(a[k] * 1000) / 1000); } return [i, v]; };

const POWER: [RegExp, string][] = [[/^\+3 Knowledge/, 'gain-3-knowledge'], [/^\+2 Terraform steps/, 'gain-2-steps'], [/^\+2 Ore/, 'gain-2-ore'],
	[/^\+7 Credits/, 'gain-7-credits'], [/^\+2 Knowledge/, 'gain-2-knowledge'], [/^\+1 Terraform step/, 'gain-1-step'], [/^\+2 Power tokens/, 'gain-2-tokens']];
const SHIP: [RegExp, string, number][] = [
	[/^Twilight: (Federation benefit|Spaceship Fed)/, 'ship_twilight', 1], [/^Twilight: TS → Research Lab/, 'ship_twilight', 2], [/^Twilight: \+3 Range/, 'ship_twilight', 3],
	[/^Rebellion: Gain tech tile/, 'ship_rebellion', 1], [/^Rebellion: Mine → TS/, 'ship_rebellion', 2], [/^Rebellion: 2K → 1Q 2C/, 'ship_rebellion', 3],
	[/^TF Mars: Tech tiles \+ 2 VP/, 'ship_tf_mars', 1], [/^TF Mars: Gaia Project/, 'ship_tf_mars', 2], [/^TF Mars: 3C → 1 Terraform/, 'ship_tf_mars', 3],
	[/^Eclipse: Planet types \+ 2 VP/, 'ship_eclipse', 1], [/^Eclipse: 2K\+3P → Research/, 'ship_eclipse', 2], [/^Eclipse: 6C → Build mine on asteroid/, 'ship_eclipse', 3]];

/** 저널 항목 → 선택지 판별 함수(메인 액션만). null = 메인 액션 아님(프리액션·후속 선택·패시브). */
function matcher(e: any, game: any): { kind: string; pred: (m: BotAction) => boolean } | null {
	const a = String(e.action ?? ''), d = String(e.details ?? ''), tid = e.tileId;
	const p = (m: BotAction) => m.params as any;
	if (/^Built (Parasitic )?Mine|^Placed Mine|^Built Mine on (Asteroid|Proto)/.test(a) && !/^Eclipse/.test(a)) return { kind: 'build_mine', pred: m => m.type === 'build_mine' && p(m).tileId === tid };
	if (/^Advanced Research/.test(a)) { const tr = (/^(\w+) to level/i.exec(d) ?? [])[1]; return tr ? { kind: 'advance_research', pred: m => m.type === 'advance_research' && String(p(m).trackId).toLowerCase() === tr.toLowerCase() } : null; }
	if (/^Upgraded to Trading/.test(a)) return { kind: 'upgrade:TS', pred: m => m.type === 'upgrade_structure' && p(m).target === 'trading_station' && p(m).tileId === tid };
	if (/^Upgraded to Research Lab/.test(a)) return { kind: 'upgrade:Lab', pred: m => m.type === 'upgrade_structure' && p(m).target === 'research_lab' && p(m).tileId === tid };
	if (/^Upgraded to Planetary/.test(a)) return { kind: 'upgrade:PI', pred: m => m.type === 'upgrade_structure' && p(m).target === 'planetary_institute' && p(m).tileId === tid };
	if (/^Upgraded to Academy/.test(a)) { const side = /QIC/.test(d) ? 'academy_right' : 'academy_left'; return { kind: 'upgrade:Acad', pred: m => m.type === 'upgrade_structure' && p(m).target === side && p(m).tileId === tid }; }
	if (/^Selected Bonus/.test(a) && e.phase === 'main') { const b = ALL_BONUS_TILES.find(x => x.label === d); return { kind: 'pass', pred: m => m.type === 'pass_round' && (!b || !p(m).bonusTileId || p(m).bonusTileId === b.id) }; }
	if (/^Power Action/.test(a)) { const hit = POWER.find(([re]) => re.test(d)); return hit ? { kind: 'power', pred: m => m.type === 'use_power_action' && p(m).actionId === hit[1] && !p(m).useBrain } : null; }
	if (/^Federation$/.test(a)) { // 위성 조합까지는 맞추지 않음(보상이 같은 첫 후보). 보상 = 바로 뒤 'Federation Reward' 줄
		const rid = e._rewardId as string | undefined;
		return { kind: 'federation', pred: m => m.type === 'form_federation' && (!rid || p(m).rewardId === rid) };
	}
	if (/^Used Tech Action/.test(a)) return { kind: 'tech_action', pred: m => m.type === 'use_tech_action' && p(m).tileId === tid };
	if (/^Entered Ship/.test(a)) return { kind: 'enter_ship', pred: m => m.type === 'enter_spaceship' && p(m).tileId === tid };
	if (/^Academy \(/.test(a)) return { kind: 'academy_qic', pred: m => m.type === 'use_special_action' && p(m).actionId === 'academy-qic' };
	if (/^Placed Gaiaformer/.test(a)) return { kind: 'gaiaformer', pred: m => m.type === 'place_gaiaformer' && p(m).tileId === tid };
	if (/^Bonus Action/.test(a)) return { kind: 'bonus_action', pred: m => m.type === 'use_bonus_action' };
	if (/^Firaks: Downgrade/.test(a)) return { kind: 'firaks', pred: m => m.type === 'firaks_downgrade' && p(m).tileId === tid };
	const ship = SHIP.find(([re]) => re.test(a));
	if (ship) {
		const st = game.map.find((t: any) => t.type === ship[1]);
		return { kind: `ship:${ship[1]}:${ship[2]}`, pred: m => m.type === 'use_ship_action' && p(m).shipTileId === st?.id && p(m).actionIndex === ship[2] && (ship[2] !== 2 || !(ship[1] === 'ship_twilight' || ship[1] === 'ship_rebellion') || p(m).targetTileId === tid) };
	}
	if (/^(Gleens|Space Giants|Tinkeroid|Bescods|매안).*Special/i.test(a)) return { kind: 'special', pred: m => m.type === 'use_special_action' || m.type === 'bescods_advance_lowest' };
	return null;
}

// [2026-10-22 사용자: 프리 액션도 배우게] 사람 기록의 프리 액션 줄 → 낱개 수 판별 함수 목록(순서대로).
//   'Free Actions'는 연속 변환이 한 줄로 합쳐진다("1P → 1C ×3, 1O → 1 Token"). 변환 문구는 서버 executeConvertResource와 1:1.
const CONV: [RegExp, string, boolean?][] = [
	[/^1P → [12]C$/, '1power-to-1credit'], [/^1B → 3C$/, '1brain-to-3credit', true], [/^1P → Gaiaformer \+ 1K$/, '1power-to-1k-gaiaformer'],
	[/^[23]P → 1O$/, '3power-to-1ore'], [/^1B → 1O$/, '3power-to-1ore', true], [/^3P → 2O$/, '3power-to-2ore'], [/^2P → 1O$/, '3power-to-1ore'],
	[/^[24]P → 1Q$/, '4power-to-1qic'], [/^1B\+1P → 1Q$/, '4power-to-1qic', true], [/^[24]P → 1K$/, '4power-to-1knowledge'], [/^1B\+1P → 1K$/, '4power-to-1knowledge', true],
	[/^1K → 1C$/, '1knowledge-to-1credit'], [/^1Q → 1O$/, '1qic-to-1ore'], [/^1O → 1C$/, '1ore-to-1credit'], [/^1O → 1 Token( to Bowl III)?$/, '1ore-to-1token'],
];
const HH: [RegExp, string][] = [[/3C\s*→\s*1O/, 'hh-3c-1o'], [/4C\s*→\s*1Q/, 'hh-4c-1qic'], [/4C\s*→\s*1K/, 'hh-4c-1k']];
type Pred = (m: BotAction) => boolean;
/** 프리 액션 저널 항목 1개 → 낱개 수 판별 함수들(못 알아보면 null = 연결 중단) */
function freePreds(e: any): Pred[] | null {
	const a = String(e.action ?? ''), d = String(e.details ?? '');
	const p = (m: BotAction) => m.params as any;
	if (a === 'Power Burn' || /^Burn 2 Power/.test(a) || a === 'Taklons: Burn (B+T)') return [m => m.type === 'burn_power'];
	if (/^Bal T'aks: 1 Gaiaformer/.test(a)) return [m => m.type === 'bal_tak_gaiaformer_to_qic'];
	if (a === 'Hadsch Hallas PI') { const h = HH.find(([re]) => re.test(d)); return h ? [m => m.type === 'use_hadsch_hallas_pi_action' && p(m).actionId === h[1]] : null; }
	if (a !== 'Free Actions') return null;
	const out: Pred[] = [];
	// '2P → 1O, 1C'(변환 1개)가 쉼표로 쪼개지지 않게 먼저 합친다
	for (const raw of d.replace(/2P → 1O, 1C/g, '2P→1O1C').split(/,\s*/)) {
		const mm = /^(.*?)(?: ×(\d+))?$/.exec(raw.trim()); if (!mm) return null;
		const txt = mm[1].trim(), n = Number(mm[2] ?? 1);
		let pred: Pred | null = null;
		if (txt === '2P→1O1C') pred = m => m.type === 'convert_resource' && p(m).type === '2power-to-1ore-1credit';
		else if (/^Bowl II -> III$/.test(txt) || /^Brain\(2\)/.test(txt)) pred = m => m.type === 'burn_power';
		else { const c = CONV.find(([re]) => re.test(txt)); if (c) { const [, t, brain] = c; pred = m => m.type === 'convert_resource' && p(m).type === t && (brain === undefined || !!p(m).useBrain === brain || t === '1brain-to-3credit'); } }
		if (!pred) return null;
		for (let i = 0; i < n; i++) out.push(pred);
	}
	return out;
}
const FREE_ACTION = (e: any) => /^(Free Actions|Power Burn|Burn 2 Power|Taklons: Burn \(B\+T\)|Bal T'aks: 1 Gaiaformer|Hadsch Hallas PI)/.test(String(e.action ?? ''));

const LV = /(\w+) → Lv\.(\d)/;
/** 메인 액션 뒤 보류 선택(기술 타일 등)의 사람 선택 판별. 쓴 저널 항목은 used에 넣어 다시 쓰지 않는다. */
function pendingMatcher(key: string, entries: any[], used: Set<any>): { e: any; pred: (m: BotAction) => boolean } | null {
	const find = (re: RegExp, f: (e: any) => boolean = () => true, reuse = false) => entries.find(e => (reuse || !used.has(e)) && re.test(String(e.action ?? '')) && f(e));
	const p = (m: BotAction) => m.params as any;
	const lvOf = (e: any) => LV.exec(String(e.details ?? '')) ?? [];
	if (key === 'techTile') {
		const e = find(/Tech Tile$|^Ship Tech: (?!Advanced track)/, x => typeof x.tileId === 'string' && /^(tech-|ship-tech-|adv-)/.test(x.tileId));
		if (!e) return null;
		if (e.tileId.startsWith('adv-')) return { e, pred: m => m.type === 'select_advanced_tech_tile' && p(m).advancedTileId === e.tileId };
		const [, tr, lv] = lvOf(e);
		if (e.tileId.startsWith('ship-tech-') || !tr) return { e, pred: m => m.type === 'select_tech_tile' && p(m).techTileId === e.tileId };
		return { e, pred: m => m.type === 'select_tech_tile' && p(m).techTileId === e.tileId && p(m).trackId === tr && !!p(m).advanceToLevel5 === (Number(lv) === 5) };
	}
	if (key === 'advTechCover') { const e = find(/^Advanced Tech Tile$/, undefined, true); /* 고급 타일 고르기와 같은 줄 */ const c = e && (/Covered (\S+)/.exec(String(e.details ?? '')) ?? [])[1]; return e && c ? { e, pred: m => p(m).coverTileId === c } : null; }
	if (key === 'shipTechTrack' || key === 'advTechTrack') { const e = find(key === 'shipTechTrack' ? /^Ship Tech: Advanced track/ : /^Advanced Tech: Advanced track/); const tr = e && lvOf(e)[1]; return tr ? { e, pred: m => p(m).trackId === tr } : null; }
	if (key === 'eclipseResearch') { const e = find(/^Eclipse: Research$/); const tr = e && lvOf(e)[1]; return tr ? { e, pred: m => p(m).trackId === tr } : null; }
	if (key === 'twilightFed') { const e = find(/^(Twilight|Artifact): (Federation benefit|Spaceship Fed)/, x => !!x.tileId && x.tileId !== 'art-fed-once', true); /* 메인 액션 줄 자체가 보상을 담는다 */ return e ? { e, pred: m => p(m).rewardId === e.tileId } : null; }
	if (key === 'lostPlanet') { const e = find(/^Lost Planet/); return e ? { e, pred: m => p(m).tileId === e.tileId } : null; }
	if (key === 'eclipseAsteroid') { const e = find(/^Eclipse: Built mine on asteroid/); return e ? { e, pred: m => p(m).tileId === e.tileId } : null; }
	if (key === 'tfMarsGaia') { const e = find(/^Placed Gaiaformer/); return e ? { e, pred: m => m.type === 'place_gaiaformer' && p(m).tileId === e.tileId } : null; }
	if (key === 'pendingMine') { const e = find(/^Built (Mine|Mine on Asteroid)$/); return e ? { e, pred: m => m.type === 'build_mine' && p(m).tileId === e.tileId } : null; }
	return null;
}

(async () => {
	fs.mkdirSync(outDir, { recursive: true });
	const outPath = path.join(outDir, `human_${Date.now()}.jsonl.gz`);
	const gz = zlib.createGzip({ level: 6 }); const ws = fs.createWriteStream(outPath); gz.pipe(ws);
	const write = (o: any) => gz.write(JSON.stringify(o) + '\n');
	const hg = new Map(fs.readdirSync('data/human-games').map(f => [f.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace('.json', ''), f]));
	const st = { games: 0, noJournal: 0, states: 0, labeled: 0, inOptions: 0, pending: 0, free: 0, byKind: {} as Record<string, [number, number]>, noMain: 0 };
	for (const f of fs.readdirSync('data/human-states').sort()) {
		const gid = f.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace('.jsonl', '');
		const hf = hg.get(gid);
		if (!hf) { st.noJournal++; continue; }
		const hgame = JSON.parse(fs.readFileSync(path.join('data/human-games', hf), 'utf8'));
		const journalAll = ((hgame.actionJournal ?? []) as any[]).filter(e => e.phase === 'main').sort((a, b) => a.timestamp - b.timestamp);
		const journal = journalAll;
		const lines = fs.readFileSync(path.join('data/human-states', f), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(o => o.phase === 'main');
		st.games++;
		for (let i = 0; i < lines.length; i++) {
			const o = lines[i]; const nextTs = lines.slice(i + 1).find(x => x.playerId === o.playerId)?.ts ?? Infinity;
			const raw = JSON.parse(zlib.gunzipSync(Buffer.from(o.gz, 'base64')).toString());
			const g = prepareHeadless(raw);
			if (g.turnOrder[g.currentPlayerIndex] !== o.playerId || g.hasDoneMainAction) continue; // 턴 시작이 아닌 캡처(대기 상태 등)
			st.states++;
			const entries = journal.filter(e => e.playerId === o.playerId && e.timestamp >= o.ts && e.timestamp < nextTs);
			let mt: ReturnType<typeof matcher> = null; let mainE: any = null;
			for (const e of entries) {
				if (/^Federation$/.test(String(e.action))) e._rewardId = entries.find(x => x.timestamp >= e.timestamp && x.action === 'Federation Reward')?.tileId;
				mt = matcher(e, g); if (mt) { mainE = e; break; }
			}
			if (!mt) { st.noMain++; continue; }
			let po = generatePendingOptions(g, o.playerId);
			let gm: any = g; // 메인 액션을 라벨할 상태(--free면 사람 프리 액션을 차례로 적용한 뒤)
			if (args.includes('--free') && !po?.options.length) {
				const pre = journalAll.filter(x => x.playerId === o.playerId && x.timestamp >= o.ts && x.timestamp < mainE.timestamp && FREE_ACTION(x));
				const preds: Pred[] = []; let okAll = true;
				for (const x of pre) { const ps = freePreds(x); if (!ps) { okAll = false; break; } preds.push(...ps); }
				const fk = (st.byKind['free'] ??= [0, 0]);
				let s1: any = g;
				for (const pr of (okAll ? preds : [])) {
					fk[1]++;
					const opts = generateMoves(s1, o.playerId); const yi = opts.findIndex(pr);
					if (yi < 0) { s1 = null; break; }
					const nx = await tryApply(s1, o.playerId, opts[yi]); if (!nx) { s1 = null; break; }
					fk[0]++; st.free++;
					const ef = encodeState(s1, o.playerId); const sx = s1;
					write({ g: gid, p: o.playerId, r: s1.roundNumber, y: yi, kind: 'free', name: hgame.players?.[o.playerId]?.name,
						flat: sparse(ef.flat), grid: sparse(ef.grid), moves: opts.map(m => { const em = encodeMove(sx, o.playerId, m); return { f: sparse(em.flat), c: em.cell, k: moveKey(m) }; }) });
					s1 = nx;
				}
				if (!okAll) fk[1]++;
				if (s1 && s1 !== g) { gm = s1; po = null; }
			}
			const options = po?.options.length ? po.options : generateMoves(gm, o.playerId);
			const y = options.findIndex(mt.pred);
			const k = (st.byKind[mt.kind] ??= [0, 0]); k[1]++; st.labeled++;
			if (y >= 0) { k[0]++; st.inOptions++; } else continue;
			const e = encodeState(gm, o.playerId);
			write({ g: gid, p: o.playerId, r: gm.roundNumber, y, kind: 'human', name: hgame.players?.[o.playerId]?.name,
				flat: sparse(e.flat), grid: sparse(e.grid), moves: options.map(m => { const em = encodeMove(gm, o.playerId, m); return { f: sparse(em.flat), c: em.cell, k: moveKey(m) }; }) });
			// 메인 액션 뒤 보류 선택(기술 타일·연방 보상 재수령·트랙 전진 등): 수를 적용한 상태에서 사람 선택을 라벨로
			if (po?.options.length || args.includes('--mainOnly')) continue; // 이미 보류 상태였던 캡처 / 메인 액션만
			let s2 = await tryApply(gm, o.playerId, options[y]);
			const used = new Set<any>([mainE]); const after = entries.filter(x => x.timestamp >= mainE.timestamp);
			for (let depth = 0; s2 && depth < 4; depth++) {
				const pp = generatePendingOptions(s2, o.playerId);
				if (!pp || !pp.options.length) break;
				const pk = (st.byKind[`p:${pp.key}`] ??= [0, 0]); pk[1]++;
				const pm = pendingMatcher(pp.key, after, used);
				const y2 = pm ? pp.options.findIndex(pm.pred) : -1;
				if (y2 < 0) { if (process.env.DBG && pp.key === 'techTile') fs.writeSync(1, `[miss] ${pm ? `${pm.e.action}|${pm.e.tileId}|${pm.e.details}` : 'no entry: ' + after.slice(0, 4).map(x => x.action).join(',')} :: ${pp.options.slice(0, 6).map(moveKey).join(' ; ')}\n`); break; }
				pk[0]++; used.add(pm!.e); st.pending++;
				const e2 = encodeState(s2, o.playerId); const sx = s2;
				write({ g: gid, p: o.playerId, r: s2.roundNumber, y: y2, kind: pp.key, name: hgame.players?.[o.playerId]?.name,
					flat: sparse(e2.flat), grid: sparse(e2.grid), moves: pp.options.map(m => { const em = encodeMove(sx, o.playerId, m); return { f: sparse(em.flat), c: em.cell, k: moveKey(m) }; }) });
				s2 = await tryApply(s2, o.playerId, pp.options[y2]);
			}
		}
		const scores = Object.fromEntries(Object.entries<any>(hgame.players ?? {}).map(([id, p]) => [id, p.score ?? 0]));
		write({ final: true, g: gid, ended: true, scores, names: Object.fromEntries(Object.entries<any>(hgame.players ?? {}).map(([id, p]) => [id, p.name])), bots: hgame.botPlayerIds ?? [] });
		fs.writeSync(1, `${f}: 누적 상태 ${st.states} · 라벨 ${st.labeled} · 선택지 포함 ${st.inOptions}\n`);
	}
	gz.end(); await new Promise(r => ws.on('finish', r));
	fs.writeSync(1, `\n게임 ${st.games} (행동 기록 없음 ${st.noJournal}) · 턴 시작 상태 ${st.states} · 메인 액션 라벨 ${st.labeled} (못 찾음 ${st.noMain}) · 생성기 선택지에 있음 ${st.inOptions} (${(100 * st.inOptions / Math.max(1, st.labeled)).toFixed(1)}%) · 보류 선택 라벨 ${st.pending} · 프리 액션 라벨 ${st.free}\n`);
	for (const [k, [ok, n]] of Object.entries(st.byKind).sort((a, b) => b[1][1] - a[1][1])) fs.writeSync(1, `  ${k.padEnd(26)} ${ok}/${n} (${(100 * ok / n).toFixed(0)}%)\n`);
	fs.writeSync(1, `→ ${outPath}\n`);
	process.exit(0);
})();
