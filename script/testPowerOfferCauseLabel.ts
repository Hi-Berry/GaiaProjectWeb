/**
 * 파워 수령 제안 창 첫 줄("○○ 님이 연구소 건설")을 실제 게임 로그로 만들 수 있는지 검사한다.
 *
 * 사용자 제보(2026-09-26): "상대방 로그는 뜨지도 않고 파워 받는 창이 뜬다.
 *   건설 로그가 뜨고 파워 수락 여부는 그 밑에 뜨면 안 되나?"
 *   → 창이 원인을 직접 싣도록 고쳤다. 그 조회는 오퍼의 tileId 로 같은 칸·같은 사람의
 *     마지막 로그 줄을 찾고, actionLabel 로 한국어 문구를 만든다.
 *
 * 따라서 깨질 수 있는 지점은 둘뿐이다.
 *   ① 건설 로그에 tileId 가 없으면 → 칸으로 못 찾는다
 *   ② actionLabel 이 그 액션을 모르면 → 문구가 비어 줄이 안 뜬다
 * 저장된 실제 게임 로그 전수로 둘 다 확인한다.
 *
 * 사용: npx tsx script/testPowerOfferCauseLabel.ts
 */
import { readdirSync, readFileSync } from 'fs';
import { actionLabel } from '@/lib/speech';

/** 파워 누출(leech)을 일으키는 건설 계열 액션 — 서버가 이때 오퍼를 만든다 */
const BUILD_RE = /^Built Mine|^Built Parasitic Mine|^Upgraded to|^Rebellion: Mine|^Twilight: TS|^Eclipse: Built mine/i;

const files = readdirSync('logs').filter(f => f.endsWith('_final_state.json'));
if (!files.length) { console.log('logs/ 에 게임 기록이 없다 — 건너뛴다'); process.exit(0); }

let games = 0, builds = 0, noTile = 0, noLabel = 0;
const missing = new Set<string>();
for (const f of files) {
	let g: any;
	try { g = JSON.parse(readFileSync('logs/' + f, 'utf8')); } catch { continue; }
	// 옛 기록은 gameLog 가, 새 기록은 fullGameLog 가 길다 — 긴 쪽을 쓴다
	const gl = g.gameLog ?? [], fl = g.fullGameLog ?? [];
	const logs = fl.length > gl.length ? fl : gl;
	if (!logs.length) continue;
	games++;
	for (const e of logs) {
		if (!BUILD_RE.test(e.action ?? '')) continue;
		builds++;
		if (!e.tileId) noTile++;
		if (!actionLabel(e.action ?? '', e.details ?? '')) { noLabel++; missing.add((e.action ?? '').slice(0, 40)); }
	}
}

console.log(`게임 ${games}판 · 건설 로그 ${builds}줄`);
console.log(`${noTile === 0 ? 'PASS' : 'FAIL'}  전부 tileId 를 갖는다 (없는 줄 ${noTile})`);
console.log(`${noLabel === 0 ? 'PASS' : 'FAIL'}  전부 한국어 문구가 나온다 (안 나오는 줄 ${noLabel})`);
if (missing.size) console.log('  문구 없는 액션:', [...missing].join(' | '));
process.exit(noTile === 0 && noLabel === 0 ? 0 : 1);
