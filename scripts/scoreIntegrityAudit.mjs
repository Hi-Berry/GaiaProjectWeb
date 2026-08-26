#!/usr/bin/env node
/**
 * 사람 게임 로그에서 점수/자원 이상 징후를 찾는다.
 * 사용: node scripts/scoreIntegrityAudit.mjs
 */
import fs from 'fs';
import path from 'path';

const dir = 'data/human-games';
const EXCLUDE = new Set(['2026-07-15_fi1njhdj.json']);
const TRACKS = ['terraforming', 'navigation', 'artificialIntelligence', 'gaiaProject', 'economy', 'science'];
const END_BONUS = { 3: 4, 4: 8, 5: 12 };

const sum = (arr) => (arr || []).reduce((s, x) => s + (typeof x === 'number' ? x : (x?.vp ?? 0)), 0);
const pct = (xs, p) => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const i = Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)));
	return s[i];
};
const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !EXCLUDE.has(f));

const winners = [];
const seats = [];
const winnersAug = [];
const seatsAug = [];
const catAvgs = {
	round: [], bonus: [], tech: [], finalM: [], research: [], leftover: [],
	powerPaid: [], ships: [], other: [], bid: [], proto: [], shipEnter: [], fed: [],
};
const mismatches = []; // |score - reconstructed| > 1
const researchMissing = []; // expected research VP vs recorded
const leftoverVsExpected = [];
const freeBuildFlags = [];
const scoreJumpFlags = [];
const resourceGainOnSpend = []; // spend action but resource went up
const noCostBuild = [];
const gamesMeta = { scanned: 0, finished4pHuman: 0, skippedBot: 0, skippedUnfinished: 0, parseFail: 0 };

function reconstruct(p) {
	const b = p.scoreBreakdown;
	if (!b) return null;
	const round = sum(b.roundMissions);
	const bonus = sum(b.bonusTilePass);
	const tech = sum(b.techTiles);
	const jq = sum(b.spaceships);
	const otherAll = sum(b.other);
	const remaining = b.remainingResources ?? 0;
	const raw = 10 + round + bonus + tech + (b.finalMissions ?? 0) + (b.researchTracks ?? 0)
		+ remaining - (b.powerReceived ?? 0) + jq + otherAll;
	return { raw, round, bonus, tech, jq, otherAll, remaining, finalM: b.finalMissions ?? 0, research: b.researchTracks ?? 0, power: b.powerReceived ?? 0 };
}

function expectedResearch(p) {
	let v = 0;
	for (const t of TRACKS) {
		const lv = p.research?.[t] ?? 0;
		if (lv >= 5) v += 12;
		else if (lv >= 4) v += 8;
		else if (lv >= 3) v += 4;
	}
	return v;
}

function isFinished(g, log) {
	if (log.some((e) => e.action === 'Game Finished' || e.action === 'Final Mission')) return true;
	const ps = Object.values(g.players || {});
	return ps.some((p) => (p.scoreBreakdown?.finalMissions ?? 0) > 0 || (p.scoreBreakdown?.researchTracks ?? 0) > 0);
}

function isSpendAction(action) {
	return /Build|Upgrade|Advance|Research|Gaiaformer|Federation|Pass|Power Action|QIC|Convert|Mine|Academy|Institute|Trading|Lab/i.test(action);
}

for (const f of files) {
	let g;
	try { g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
	catch { gamesMeta.parseFail++; continue; }
	gamesMeta.scanned++;
	const bots = g.botPlayerIds || [];
	const names = Object.values(g.players || {}).map((p) => p.name || '');
	if (bots.length || names.some((n) => /^AI Bot/i.test(n) || n.startsWith('bot-'))) { gamesMeta.skippedBot++; continue; }
	const n = Object.keys(g.players || {}).length;
	if (n !== 4) continue;
	const log = g.fullGameLog || g.gameLog || [];
	if (!isFinished(g, log)) { gamesMeta.skippedUnfinished++; continue; }
	gamesMeta.finished4pHuman++;

	const plist = Object.entries(g.players).map(([id, p]) => ({ id, ...p }));
	const scores = plist.map((p) => p.score ?? 0);
	const win = Math.max(...scores);
	winners.push(win);
	if (f.slice(0, 10) >= '2026-08-01') winnersAug.push(win);
	for (const p of plist) {
		seats.push(p.score ?? 0);
		if (f.slice(0, 10) >= '2026-08-01') seatsAug.push(p.score ?? 0);
		const rec = reconstruct(p);
		if (rec) {
			catAvgs.round.push(rec.round);
			catAvgs.bonus.push(rec.bonus);
			catAvgs.tech.push(rec.tech);
			catAvgs.finalM.push(rec.finalM);
			catAvgs.research.push(rec.research);
			catAvgs.leftover.push(rec.remaining);
			catAvgs.powerPaid.push(rec.power);
			catAvgs.ships.push(rec.jq);
			catAvgs.other.push(rec.otherAll);
			const bid = sum((p.scoreBreakdown?.other || []).filter((o) => /비딩/.test(o.source || '')));
			const proto = sum((p.scoreBreakdown?.other || []).filter((o) => /Proto/.test(o.source || '')));
			const shipEnter = sum((p.scoreBreakdown?.other || []).filter((o) => /우주선 입장/.test(o.source || '')));
			const fed = sum((p.scoreBreakdown?.other || []).filter((o) => /연방/.test(o.source || '')));
			catAvgs.bid.push(bid);
			catAvgs.proto.push(proto);
			catAvgs.shipEnter.push(shipEnter);
			catAvgs.fed.push(fed);
			const adjust = (p.score ?? 0) - rec.raw;
			if (Math.abs(adjust) > 0.6) {
				mismatches.push({ file: f, name: p.name, faction: p.faction, score: p.score, raw: rec.raw, adjust: Math.round(adjust * 10) / 10 });
			}
		}
		const expR = expectedResearch(p);
		const gotR = p.scoreBreakdown?.researchTracks ?? 0;
		if (expR > 0 && gotR === 0) {
			researchMissing.push({ file: f, name: p.name, faction: p.faction, expected: expR, got: gotR, score: p.score, research: p.research });
		} else if (Math.abs(expR - gotR) > 0.6 && gotR !== 0) {
			researchMissing.push({ file: f, name: p.name, faction: p.faction, expected: expR, got: gotR, score: p.score, research: p.research, note: 'mismatch' });
		}
	}

	// 저널: 같은 플레이어 연속 after 스냅샷으로 액션 단위 델타
	const journal = g.actionJournal || [];
	const byP = {};
	for (const e of journal) {
		if (!e?.playerId || !e.playerAfter?.resources) continue;
		(byP[e.playerId] ||= []).push(e);
	}
	for (const pid of Object.keys(byP)) {
		const arr = byP[pid];
		for (let i = 0; i < arr.length; i++) {
			const e = arr[i];
			const prev = i === 0 ? e.playerBefore : arr[i - 1].playerAfter;
			const after = e.playerAfter;
			if (!prev?.resources || !after?.resources) continue;
			const d = {
				ore: (after.resources.ore ?? 0) - (prev.resources.ore ?? 0),
				credits: (after.resources.credits ?? 0) - (prev.resources.credits ?? 0),
				knowledge: (after.resources.knowledge ?? 0) - (prev.resources.knowledge ?? 0),
				qic: (after.resources.qic ?? 0) - (prev.resources.qic ?? 0),
				score: (after.score ?? 0) - (prev.score ?? 0),
			};
			const act = e.action || '';
			const det = e.details || '';

			// 건설인데 광물·크레딧·QIC가 하나도 안 줄고, 로그에 유료 비용이 적힌 경우
			if (/Build Mine|Built Mine|Upgrade|Upgraded/i.test(act)) {
				const claimsOre = /(\d+)\s*Ore/i.exec(det);
				const claimsC = /(\d+)\s*Credit/i.exec(det);
				const claimedO = claimsOre ? Number(claimsOre[1]) : null;
				const claimedC = claimsC ? Number(claimsC[1]) : null;
				const spentNothing = d.ore >= 0 && d.credits >= 0 && d.qic >= 0;
				const claimsPaid = (claimedO != null && claimedO > 0) || (claimedC != null && claimedC > 0);
				const freeHint = /무료|free|0 Ore|0 Credit|Use 1 Gaiaformer|asteroid/i.test(det);
				if (spentNothing && claimsPaid && !freeHint) {
					noCostBuild.push({ file: f, name: e.playerName, act, det: det.slice(0, 80), d, round: e.round });
				}
			}

			// 4K 연구인데 지식이 안 줄고 오름
			if (/Advance Tech|Research/i.test(act) && !/Ship Tech|Advanced Tech: Advanced|track tile|보상/i.test(act + det)) {
				if (d.knowledge >= 0 && /4\s*K|4 Knowledge|지식 4/i.test(det + act)) {
					resourceGainOnSpend.push({ file: f, name: e.playerName, act, det: det.slice(0, 80), d, kind: 'tech-no-k' });
				}
			}

			// 한 액션에서 점수가 +25 이상이면 (미션 제외) 의심
			if (d.score >= 25 && !/Final Mission|Pass|Selected Bonus|Game Finished/i.test(act)) {
				scoreJumpFlags.push({ file: f, name: e.playerName, act, det: det.slice(0, 100), d: d.score, round: e.round });
			}

			// 건설/업글 중 자원이 늘어남 (수입이 아닌 턴)
			if (/Build Mine|Upgrade Structure|Place Gaiaformer/i.test(act) && (d.ore > 2 || d.credits > 6 || d.knowledge > 2)) {
				resourceGainOnSpend.push({ file: f, name: e.playerName, act, det: det.slice(0, 80), d, kind: 'gain-on-build' });
			}
		}
	}
}

function dist(xs) {
	return {
		n: xs.length,
		avg: Math.round(avg(xs) * 10) / 10,
		p10: pct(xs, 0.1),
		p25: pct(xs, 0.25),
		p50: pct(xs, 0.5),
		p75: pct(xs, 0.75),
		p90: pct(xs, 0.9),
		max: xs.length ? Math.max(...xs) : null,
		min: xs.length ? Math.min(...xs) : null,
	};
}

const buckets = [0, 80, 100, 120, 140, 160, 180, 200, 220, 250, 400];
const winnerHist = [];
for (let i = 0; i < buckets.length - 1; i++) {
	const lo = buckets[i], hi = buckets[i + 1];
	winnerHist.push({ range: `${lo}–${hi - 1}`, n: winners.filter((s) => s >= lo && s < hi).length });
}

const out = {
	gamesMeta,
	winner: dist(winners),
	seat: dist(seats),
	winnerAug: dist(winnersAug),
	seatAug: dist(seatsAug),
	winnerHist,
	categoryAvgPerSeat: Object.fromEntries(Object.entries(catAvgs).map(([k, v]) => [k, Math.round(avg(v) * 10) / 10])),
	mismatchCount: mismatches.length,
	mismatches: mismatches.slice(0, 15),
	researchMissingCount: researchMissing.length,
	researchMissing: researchMissing.slice(0, 12),
	noCostBuildCount: noCostBuild.length,
	noCostBuild: noCostBuild.slice(0, 12),
	scoreJumpCount: scoreJumpFlags.length,
	scoreJumps: scoreJumpFlags.slice(0, 12),
	resourceGainCount: resourceGainOnSpend.length,
	resourceGains: resourceGainOnSpend.slice(0, 12),
};
console.log(JSON.stringify(out, null, 2));
