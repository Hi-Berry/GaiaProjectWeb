/**
 * [봇 강화 사이클 2026-08-26] Built Mine 후보 갭 2,429건 해부 — 사람이 지은 광산이 봇 후보에 없던 이유 분류.
 *
 * 분류 우선순위:
 *  A. capped40      — 캡처가 후보를 40개로 자름(humanCandidateHook slice(0,40)) → 생성 갭이 아니라 캡처 아티팩트일 수 있음
 *  B. noMineCands   — 후보에 build_mine이 아예 0개 (전역 게이트: 자원/한도/상태)
 *  C. needQic       — 기본 사거리 밖이지만 QIC로 닿음 (봇의 QIC 억제/예산 필터 의심)
 *  D. inRangeMissing— 사거리 안 + 다른 광산 후보는 있는데 이 타일만 없음 (타일 필터 = 진짜 갭)
 *  E. outOfRange    — QIC 합쳐도 사거리 밖으로 계산됨 (사람은 지었으니 거리보너스/우주정거장 등 모델 밖 요소)
 *
 * 실행: npx tsx script/mineGapProbe.ts
 */
import fs from 'fs';
import { getRange, getTerraformStepsForFaction, getTerraformCost } from '../shared/gameConfig';

const dir = 'data/human-games';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const NONPLANET = new Set(['space', 'deep_space', 'transdim', 'lost_fleet_ship']);
const dist = (a: any, b: any) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;

function applyEvent(owner: any, struct: any, e: any) {
	const tid = e.tileId; if (!tid) return; const a = e.action || '';
	if (/Placed Starting Mine|Built Mine|Placed Mine/i.test(a)) { owner[tid] = e.playerId; struct[tid] = 'mine'; }
	else if (/Upgraded to Trading/i.test(a)) { owner[tid] = e.playerId; struct[tid] = 'trading_station'; }
	else if (/Upgraded to Research Lab/i.test(a)) { owner[tid] = e.playerId; struct[tid] = 'research_lab'; }
	else if (/Academy/i.test(a)) { owner[tid] = e.playerId; struct[tid] = 'academy'; }
	else if (/Planetary Institute/i.test(a)) { owner[tid] = e.playerId; struct[tid] = 'planetary_institute'; }
}

const cls: Record<string, number> = {};
/** 순위 품질 대조: 사람 선택 광산의 테라포밍 스텝 분포 — 후보에 있던 경우(matched) vs D(사거리 안 누락) */
const stepsDist: Record<string, Record<string, number>> = { matched: {}, D: {} };
const roundDist: Record<string, Record<number, number>> = { matched: {}, D: {} };
/** matched일 때 광산 후보 내 순위(0=봇 1순위) */
const rankDist: Record<number, number> = {};
const clsByRound: Record<string, Record<number, number>> = {};
const clsByType: Record<string, Record<string, number>> = {};
const needQicDetail: Record<string, number> = {}; // QIC 몇 개가 필요했나
const inRangeSamples: string[] = [];
let totalMissing = 0, mineMissing = 0;

for (const f of files) {
	let g: any; try { g = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')); } catch { continue; }
	if (!Array.isArray(g.map) || !g.map.length) continue;
	const geom = new Map<string, any>();
	for (const t of g.map) if (t.q != null) geom.set(t.id, { q: t.q, r: t.r, type: t.type, id: t.id });
	const fl = [...(g.fullGameLog || [])].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
	const journal = (g.actionJournal || []).filter((e: any) => e.timestamp != null).sort((a: any, b: any) => a.timestamp - b.timestamp);
	const owner: any = {}, struct: any = {}; let fi = 0;
	for (const e of journal) {
		while (fi < fl.length && (fl[fi].timestamp || 0) < e.timestamp) { applyEvent(owner, struct, fl[fi]); fi++; }
		if (!e.candidates || e.candidates.length < 2) continue;
		if (!/^Built Mine|^Placed Mine/i.test(e.action || '')) continue;
		const idx = e.candidates.findIndex((c: any) => c.type === 'build_mine' && c.tileId === e.tileId);
		if (idx >= 0) {
			// 매칭: 스텝 분포 + 광산 후보 내 순위(후보 배열은 봇 점수순 유지)
			const tileM = geom.get(e.tileId);
			if (tileM) {
				let st = -1; try { st = getTerraformStepsForFaction(g as any, (e.playerBefore?.faction ?? e.faction), tileM.type); } catch { /* */ }
				const key = tileM.type === 'gaia' ? 'gaia' : tileM.type === 'asteroid' ? 'ast' : String(st);
				stepsDist.matched[key] = (stepsDist.matched[key] || 0) + 1;
				roundDist.matched[e.round ?? 0] = (roundDist.matched[e.round ?? 0] || 0) + 1;
				const mineIds = e.candidates.filter((c: any) => c.type === 'build_mine').map((c: any) => c.tileId);
				const rank = mineIds.indexOf(e.tileId);
				if (rank >= 0) rankDist[rank] = (rankDist[rank] || 0) + 1;
			}
			continue;
		}
		totalMissing++;
		if (!/^Built Mine$|^Built Mine on/i.test(e.action || '')) continue;
		mineMissing++;

		const n = e.candidates.length;
		const mineCands = e.candidates.filter((c: any) => c.type === 'build_mine').length;
		const tile = geom.get(e.tileId);
		const pb = e.playerBefore || {}; const res = pb.resources || {};
		const myTiles = [...geom.values()].filter((t: any) => owner[t.id] === e.playerId && struct[t.id]);
		const nav = pb.research?.navigation ?? 0;
		const range = getRange(nav);
		const minD = myTiles.length && tile ? Math.min(...myTiles.map((m: any) => dist(m, tile))) : 99;
		const qic = res.qic ?? 0;

		let c: string;
		if (n >= 40) c = 'A.capped40(캡처 아티팩트 의심)';
		else if (mineCands === 0) c = 'B.광산후보 전무(전역 게이트)';
		else if (minD > range && minD <= range + 2 * qic) {
			c = 'C.QIC 거리 필요(억제 의심)';
			const q = Math.ceil((minD - range) / 2);
			needQicDetail[String(q)] = (needQicDetail[String(q)] || 0) + 1;
		}
		else if (minD <= range) {
			c = 'D.사거리 안인데 누락(타일 필터=진짜 갭)';
			if (tile) {
				let st = -1; try { st = getTerraformStepsForFaction(g as any, pb.faction ?? e.faction, tile.type); } catch { /* */ }
				const key = tile.type === 'gaia' ? 'gaia' : tile.type === 'asteroid' ? 'ast' : String(st);
				stepsDist.D[key] = (stepsDist.D[key] || 0) + 1;
				roundDist.D[e.round ?? 0] = (roundDist.D[e.round ?? 0] || 0) + 1;
			}
			if (inRangeSamples.length < 12 && tile) {
				let steps = -1;
				try { steps = getTerraformStepsForFaction(g as any, pb.faction ?? e.faction, tile.type); } catch { /* */ }
				inRangeSamples.push(`${f.slice(0, 10)} R${e.round} ${e.playerName} ${tile.type} d=${minD} steps=${steps} O=${res.ore} Q=${qic} 광산후보=${mineCands} n=${n}`);
			}
		}
		else c = 'E.모델상 사거리 밖(거리보너스 등 미반영)';

		cls[c] = (cls[c] || 0) + 1;
		(clsByRound[c] ??= {})[e.round ?? 0] = ((clsByRound[c] ??= {})[e.round ?? 0] || 0) + 1;
		if (tile) (clsByType[c] ??= {})[tile.type] = ((clsByType[c] ??= {})[tile.type] || 0) + 1;
	}
}

console.log(`Built Mine 누락 ${mineMissing}건 분류:`);
for (const [k, v] of Object.entries(cls).sort((a, b) => b[1] - a[1])) {
	const rounds = Object.entries(clsByRound[k] || {}).sort().map(([r, n]) => `R${r}:${n}`).join(' ');
	console.log(`  ${k.padEnd(34)} ${String(v).padStart(5)}  (${rounds})`);
}
console.log(`\nC(QIC 필요) 상세 — 필요 QIC 수: ${JSON.stringify(needQicDetail)}`);
console.log(`\nD(진짜 갭) 행성 유형: ${JSON.stringify(clsByType['D.사거리 안인데 누락(타일 필터=진짜 갭)'] || {})}`);
console.log(`A(캡처컷) 행성 유형: ${JSON.stringify(clsByType['A.capped40(캡처 아티팩트 의심)'] || {})}`);
console.log(`\nD 샘플:`);
for (const s of inRangeSamples) console.log('  ' + s);

const pct = (o: Record<string, number>) => {
	const t = Object.values(o).reduce((s, n) => s + n, 0);
	return Object.entries(o).sort().map(([k, n]) => `${k}:${(100 * n / t).toFixed(0)}%`).join(' ') + ` (n=${t})`;
};
console.log(`\n■ 사람 선택 광산의 테라포밍 스텝 분포 (gaia/ast 별도)`);
console.log(`  후보에 있었음: ${pct(stepsDist.matched)}`);
console.log(`  D(누락):      ${pct(stepsDist.D)}`);
console.log(`■ 라운드 분포 — matched: ${pct(roundDist.matched as any)} | D: ${pct(roundDist.D as any)}`);
console.log(`■ matched일 때 봇 광산후보 내 순위(0=1위): ${JSON.stringify(rankDist)}`);
