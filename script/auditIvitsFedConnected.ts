/**
 * 감사: 하이브(Ivits)의 연방 칸(playerFederationHexes)이 하나로 이어져 있는가.
 * 룰: 첫 연방은 아무 데나, 2번째부터는 기존 연방에 붙여 키워야 한다 → 끝난 게임의 연방 칸은 한 덩어리여야 한다.
 * 이음 판정은 서버 computeIvitsFederationConnected와 같은 '통로': 연방 칸 + 내 건물·기생광산·우주정거장.
 *
 * 사용: npx tsx script/auditIvitsFedConnected.ts [게임 JSON 폴더=data/human-games]
 */
import fs from 'fs';
import path from 'path';
import { getNeighbors } from '../shared/gameConfig';

const dir = process.argv[2] ?? 'data/human-games';
let checked = 0;
const split: string[] = [];
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
	let g: any;
	try { g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
	if (!Array.isArray(g.map)) continue;
	const byId = new Map<string, any>(g.map.map((t: any) => [t.id, t]));
	for (const [pid, p] of Object.entries<any>(g.players ?? {})) {
		if (p.faction !== 'ivits') continue;
		const fed: string[] = g.playerFederationHexes?.[pid] ?? [];
		const declared = (p.federations ?? []).filter((e: any) => !String(e?.rewardId ?? e).startsWith('ship-fed') || true).length;
		if (fed.length === 0 || declared < 2) continue;
		checked++;
		const fedSet = new Set(fed);
		const passable = (t: any) => fedSet.has(t.id)
			|| (t.ownerId === pid && t.structure && t.structure !== 'ship')
			|| t.parasiticMine?.ownerId === pid || t.spaceStation?.ownerId === pid;
		// 연방 칸들을 통로로만 이은 덩어리 수
		const seen = new Set<string>(); let parts = 0;
		for (const id of fed) {
			if (seen.has(id) || !byId.has(id)) continue;
			parts++;
			const q = [id]; seen.add(id);
			while (q.length) {
				const cur = byId.get(q.shift()!)!;
				for (const n of getNeighbors(g.map, cur)) if (!seen.has(n.id) && fedSet.has(n.id)) { seen.add(n.id); q.push(n.id); }
			}
		}
		// 내 건물을 통로로 써도 이어지지 않는가(연방 밖 건물로 잇는 것까지 허용한 느슨한 판정)
		const seen2 = new Set<string>([fed[0]]); const q2 = [fed[0]];
		while (q2.length) {
			const cur = byId.get(q2.shift()!); if (!cur) continue;
			for (const n of getNeighbors(g.map, cur)) if (!seen2.has(n.id) && passable(n)) { seen2.add(n.id); q2.push(n.id); }
		}
		const looseSplit = fed.some(id => byId.has(id) && !seen2.has(id));
		if (parts > 1) {
			const isBot = (g.botPlayerIds ?? []).includes(pid) || /^AI Bot/.test(p.name ?? '');
			split.push(`${f} ${isBot ? '봇' : '사람'} ${p.name} 연방${declared}개 → 연방 칸 ${parts}덩어리${looseSplit ? ' (건물로도 안 이어짐)' : ' (연방 밖 건물로는 이어짐)'}`);
		}
	}
}
console.log(`하이브 연방 2개 이상: ${checked}명, 연방 칸이 여러 덩어리: ${split.length}명`);
for (const s of split) console.log('  ' + s);
