/**
 * [사용자 2026-08-26] 과거 게임에서 "수입을 최적으로 안 받은" 경우가 실제로 있는지 —
 * 라운드 수입 결과(저널 playerBefore/After의 파워 그릇)를 최적 순서 시뮬레이션과 대조한다.
 *
 * 방법:
 *  - B = 지난 라운드 마지막 저널 엔트리의 playerAfter(수입 직전 상태 근사)
 *  - A = 이번 라운드 첫 저널 엔트리의 playerBefore(수입 직후 상태 근사)
 *  - 수입량은 건설 로그로 재구성한 그 시점 건물 + 저널의 연구/타일/보너스로 getNextRoundIncomePreview 계산
 *  - 검증 게이트: 광물/지식/크레딧/QIC가 B+수입=A로 정확히 맞아야만 채점 (모델 오차 차단)
 *  - 판정: W(그릇2 + 2×그릇3) 기준, 실제 A가 최적 시뮬레이션보다 낮으면 '손해'
 *
 * 한계(모두 놓침 방향으로만 작용, 가짜 양성 없음):
 *  - 리치(파워 수신)는 로그에 없음 — 리치는 W를 올리기만 하므로 실제>최적이 되면 '판정 불가'로 스킵
 *  - 타클론(브레인)/이타르/테란(의회 토큰)은 제외, 토큰 수 불일치(포머 복귀 등)도 스킵
 *
 * 실행: npx tsx script/auditIncomeOptimality.ts
 */
import fs from 'fs';
import path from 'path';
import {
	getNextRoundIncomePreview, simulateIncomeOrder, findOptimalIncomeOrder,
	type IncomeOrderItem,
} from '../shared/gameConfig';

const DIR = 'data/human-games';
const EXCLUDE_GAMES = new Set(['2026-07-15_fi1njhdj.json']);
const ALIAS: Record<string, string> = {
	'암가': '타클론안함', '암컷가마우지': '타클론안함', '김지선': '타클론안함',
	'222': '하이', 'chrome': '하이', '산타': '디애박', '소통맨': '지수홍', '보노보노': 'mks', 'GUHO': '구오',
	'Hi': '하이', 'HI': '하이', '군성`': '군성', '시리티드': '시리', 'Happygaia': '행복가이아',
};
const canon = (n: string) => ALIAS[n] ?? n;
const SKIP_FACTIONS = new Set(['taklons', 'itars', 'terran']); // 브레인/가이아구역 토큰/의회 복귀가 그릇에 안 보임

const W = (p: { power2?: number; power3?: number }) => (p.power2 ?? 0) + 2 * (p.power3 ?? 0);
const TOTAL = (p: { power1?: number; power2?: number; power3?: number }) => (p.power1 ?? 0) + (p.power2 ?? 0) + (p.power3 ?? 0);

type Flag = { game: string; round: number; player: string; loss: number; items: string };
const flags: Flag[] = [];
const byUser: Record<string, { checked: number; flagged: number; loss: number }> = {};
let games = 0, cases = 0, verified = 0, skippedGate = 0, skippedLeech = 0, noChoice = 0;
const dist: Record<string, number> = {}; // W(실제)-W(최적) 분포 — 리치 개입 규모 파악용

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
	if (EXCLUDE_GAMES.has(f)) continue;
	let g: any; try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	const ids = Object.keys(g.players ?? {});
	if (ids.length !== 4) continue;
	if (ids.some((id) => (g.botPlayerIds ?? []).includes(id) || /^AI Bot/.test(g.players[id]?.name ?? ''))) continue;
	const journal: any[] = g.actionJournal ?? [];
	if (journal.length < 20) continue;
	games++;

	for (const pid of ids) {
		const p = g.players[pid];
		if (!p?.faction || SKIP_FACTIONS.has(p.faction)) continue;
		const mine = journal.filter((e) => e.playerId === pid && e.playerBefore && e.playerAfter);
		for (let r = 2; r <= 6; r++) {
			const lastPrev = [...mine].reverse().find((e) => e.round === r - 1 && e.phase === 'main');
			const firstCur = mine.find((e) => e.round === r && e.phase === 'main');
			if (!lastPrev || !firstCur) continue;
			cases++;

			const B = lastPrev.playerAfter.resources ?? {};
			const A = firstCur.playerBefore.resources ?? {};
			// 그 시점 건물 재구성: 이 플레이어의 건설/업그레이드 저널(lastPrev까지)만 필요
			const upTo = journal.indexOf(lastPrev);
			const tiles: Record<string, { ownerId: string; structure: string | null; academyType?: string; parasiticMine?: { ownerId: string } }> = {};
			for (const e of journal.slice(0, upTo + 1)) {
				if (e.playerId !== pid || !e.tileId) continue;
				const a = e.action as string;
				if (a === 'Placed Starting Mine' || a === 'Built Mine' || a === 'Built Mine on Proto'
					|| a === 'Built Mine on Asteroid' || a === 'Eclipse: Built mine on asteroid' || a === 'Lost Planet (Nav 5)') {
					tiles[e.tileId] = { ownerId: pid, structure: 'mine' };
				} else if (a === 'Built Parasitic Mine') {
					tiles[e.tileId] = { ownerId: '', structure: null, parasiticMine: { ownerId: pid } };
				} else if (a === 'Upgraded to Trading Station' || a === 'Rebellion: Mine → TS' || a === 'Firaks: Downgrade') {
					tiles[e.tileId] = { ownerId: pid, structure: 'trading_station' };
				} else if (a === 'Upgraded to Research Lab' || a === 'Twilight: TS → Research Lab') {
					tiles[e.tileId] = { ownerId: pid, structure: 'research_lab' };
				} else if (a === 'Upgraded to Planetary Institute') {
					tiles[e.tileId] = { ownerId: pid, structure: 'planetary_institute' };
				} else if (a.startsWith('Upgraded to Academy')) {
					tiles[e.tileId] = { ownerId: pid, structure: 'academy', academyType: /수익/.test(e.details ?? '') ? 'left' : 'right' };
				}
			}
			const after = lastPrev.playerAfter;
			const pseudoPlayer: any = {
				faction: p.faction,
				research: after.research ?? {},
				techTiles: after.techTiles ?? [],
				coveredTechTiles: [],
				bonusTile: after.bonusTile ?? null, // 패스 때 고른 새 타일 = 이번 라운드 수입
			};
			const pseudoGame: any = { players: { [pid]: pseudoPlayer }, map: Object.values(tiles), roundNumber: r };
			let preview: ReturnType<typeof getNextRoundIncomePreview>;
			try { preview = getNextRoundIncomePreview(pid, pseudoGame); } catch { skippedGate++; continue; }

			// 검증 게이트: 자원 4종이 정확히 맞아야 파워 판정 신뢰 (자원 상한 클램프 반영)
			const cap = (v: number, m: number) => Math.min(m, v);
			const ok = cap((B.ore ?? 0) + preview.ore, 15) === (A.ore ?? 0)
				&& cap((B.knowledge ?? 0) + preview.knowledge, 15) === (A.knowledge ?? 0)
				&& cap((B.credits ?? 0) + preview.credits, 30) === (A.credits ?? 0)
				&& (B.qic ?? 0) + preview.qic === (A.qic ?? 0);
			if (!ok) { skippedGate++; continue; }
			// 토큰 수 일치(포머 복귀·인공물 3그릇 직행 등 모델 밖 요소 차단)
			if (TOTAL(B) + preview.powerTokens !== TOTAL(A)) { skippedGate++; continue; }

			const items: IncomeOrderItem[] = [];
			if (preview.powerTokens > 0) items.push({ type: 'tokens', amount: preview.powerTokens, id: 't' });
			if (preview.powerCharge > 0) items.push({ type: 'power', amount: preview.powerCharge, id: 'p' });
			if (items.length < 2) { noChoice++; continue; } // 순서 선택 자체가 없음

			verified++;
			const base: any = { faction: p.faction, power1: B.power1 ?? 0, power2: B.power2 ?? 0, power3: B.power3 ?? 0 };
			const opt = simulateIncomeOrder(base, findOptimalIncomeOrder(base, items));
			const wA = W(A), wOpt = W(opt);
			{
				const d = wA - wOpt;
				const k = d < 0 ? String(d) : d === 0 ? '0' : d <= 2 ? '+1~2' : d <= 4 ? '+3~4' : d <= 8 ? '+5~8' : '+9~';
				dist[k] = (dist[k] || 0) + 1;
			}
			const name = canon(p.name);
			const u = byUser[name] ??= { checked: 0, flagged: 0, loss: 0 };
			u.checked++;
			if (wA < wOpt) {
				u.flagged++; u.loss += wOpt - wA;
				flags.push({ game: f.replace('.json', ''), round: r, player: name, loss: wOpt - wA, items: `토큰${preview.powerTokens}+충전${preview.powerCharge}` });
			} else if (wA > wOpt) {
				skippedLeech++; u.checked--; verified--; // 리치가 낀 창 — 판정 불가(정보 없음)
			}
		}
	}
}

console.log(`전원 사람 4인 ${games}판 · 라운드 경계 사례 ${cases}건`);
console.log(`검증 통과(순서 선택 존재) ${verified}건 · 게이트 탈락 ${skippedGate} · 선택 불필요 ${noChoice} · 리치 개입 추정 ${skippedLeech}`);
console.log('W(실제)-W(최적) 분포:', JSON.stringify(dist));
console.log();
console.log(`■ 최적보다 나쁘게 받은 사례: ${flags.length}건`);
for (const fl of flags.sort((a, b) => b.loss - a.loss).slice(0, 20)) {
	console.log(`  ${fl.game} R${fl.round} ${fl.player} — 손해 W ${fl.loss} (${fl.items})`);
}
console.log();
console.log('유저'.padEnd(14) + '검증사례'.padStart(8) + '손해건'.padStart(7) + '누적손해W'.padStart(9));
for (const [nm, u] of Object.entries(byUser).filter(([, u]) => u.checked >= 3).sort((a, b) => b[1].flagged - a[1].flagged)) {
	console.log(nm.padEnd(14) + String(u.checked).padStart(8) + String(u.flagged).padStart(7) + String(u.loss).padStart(9));
}
