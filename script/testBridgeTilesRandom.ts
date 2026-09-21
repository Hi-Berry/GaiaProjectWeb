/**
 * 회귀: 외각 브리지 타일(섹터 11~18) 면·위치·제자리회전 랜덤(2026-09-19).
 *  - 발자국 불변: 8자리 × 3칸 좌표 집합이 매 생성 동일(고정 회전 유지) · 좌표 충돌 없음 · 총 24칸
 *  - 섹터 11~18이 각 1회 등장, 자리 배정·면·spin이 게임마다 달라짐
 *  - 각 타일의 행성 멀티셋 = 그 면 레이아웃과 일치(spin은 순환 재배치만)
 *  - spinBridgePlanets: spin 0 항등, 1·2는 순환(3회 적용 시 원복), 서로 다른 배치
 * 사용: npx tsx script/testBridgeTilesRandom.ts
 */
import * as fs from 'fs';
import { generateMap, spinBridgePlanets } from '../shared/gameConfig';
const out = (s: string) => fs.writeSync(1, s + '\n');
let fail = 0;
const chk = (n: string, c: boolean) => { out(`  ${c ? 'OK  ' : '실패'} ${n}`); if (!c) fail++; };

const LAYOUTS: Record<string, string[]> = {
	'11B': ['proto', 'space', 'asteroid'], '11O': ['space', 'space', 'asteroid'], '12B': ['transdim', 'space', 'proto'], '12O': ['asteroid', 'space', 'space'],
	'13B': ['transdim', 'asteroid', 'space'], '13O': ['space', 'asteroid', 'space'], '14B': ['proto', 'asteroid', 'space'], '14O': ['space', 'asteroid', 'space'],
	'15B': ['proto', 'space', 'space'], '15O': ['proto', 'asteroid', 'space'], '16B': ['space', 'proto', 'space'], '16O': ['asteroid', 'asteroid', 'space'],
	'17B': ['transdim', 'space', 'space'], '17O': ['space', 'space', 'asteroid'], '18B': ['proto', 'space', 'space'], '18O': ['space', 'space', 'asteroid'],
};
const footprints = new Set<string>(); const orders = new Set<string>(); const sides = new Set<string>(); const spins = new Set<string>();
let allOk = true, multisetOk = true, collisionOk = true;
for (let g = 0; g < 60; g++) {
	const map = generateMap();
	const bridge = map.filter(t => t.sector >= 11 && t.sector <= 18);
	if (bridge.length !== 24) allOk = false;
	const keys = map.map(t => `${t.q},${t.r}`); if (new Set(keys).size !== keys.length) collisionOk = false;
	footprints.add(bridge.map(t => `${t.q},${t.r}`).sort().join('|'));
	const bySector: Record<number, typeof bridge> = {};
	for (const t of bridge) (bySector[t.sector] ||= []).push(t);
	if (Object.keys(bySector).length !== 8) allOk = false;
	// 자리 배정 순서(bridge-i- 접두의 i → sector)
	orders.add(bridge.filter(t => t.id.endsWith('-0')).sort((a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1])).map(t => t.sector).join(','));
	sides.add(Object.values(bySector).map(ts => ts[0].side).join('')); spins.add(Object.values(bySector).map(ts => ts[0].spin).join(''));
	for (const [sec, ts] of Object.entries(bySector)) {
		const side = ts[0].side!; const want = [...LAYOUTS[`${sec}${side}`]].sort().join(','); const got = ts.map(t => t.type).sort().join(',');
		if (want !== got) { multisetOk = false; out(`    sector ${sec}${side}: want ${want} got ${got}`); }
		if (!ts.every(t => t.side === side && t.spin === ts[0].spin && t.rotation === ts[0].rotation)) allOk = false;
	}
}
chk('브리지 24칸·섹터 8종·좌석당 side/spin/rotation 일관', allOk);
chk('좌표 충돌 없음', collisionOk);
chk('발자국(24칸 좌표 집합) 매 생성 동일', footprints.size === 1);
chk('자리 배정이 게임마다 달라짐(60판 중 ≥20 조합)', orders.size >= 20);
chk('면 조합 달라짐(≥20)', sides.size >= 20);
chk('spin 조합 달라짐(≥20)', spins.size >= 20);
chk('행성 멀티셋 = 면 레이아웃', multisetOk);
// spin 순환성
const coords = [{ q: 0, r: -1 }, { q: -1, r: 0 }, { q: 0, r: 0 }]; const pl = ['A', 'B', 'C'];
const s0 = spinBridgePlanets(coords, pl, 0), s1 = spinBridgePlanets(coords, pl, 1), s2 = spinBridgePlanets(coords, pl, 2);
chk('spin0 항등', s0.join('') === 'ABC');
chk('spin1·2는 순환(각 슬롯에 서로 다른 행성, 전부 채움)', new Set(s1).size === 3 && new Set(s2).size === 3 && s1.join('') !== 'ABC' && s2.join('') !== 'ABC' && s1.join('') !== s2.join(''));
chk('spin1 두 번 = spin2', spinBridgePlanets(coords, s1, 1).join('') === s2.join(''));
out(`  예: spin1 ${s1.join('')} spin2 ${s2.join('')} | 60판 자리조합 ${orders.size} 면조합 ${sides.size} spin조합 ${spins.size}`);
out(fail === 0 ? '\n전부 통과' : `\n실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
