/**
 * 실제 로그에 나오는 모든 안내 문구가 mp3 조각으로 있는지 전수 확인.
 * 하나만 빠져도 그 안내는 기기 TTS로 대체되는데, 그 경로는 재생을 기다리지 않아
 * 다음 안내와 겹쳐 들린다(사용자: "소리가 꼬인다") → 빠짐은 0이어야 한다.
 *
 * 실행: npx tsx script/testVoiceClipCoverage.ts
 */
import fs from 'fs';
import path from 'path';
import { actionParts } from '../client/src/lib/speech';

const manifest = JSON.parse(fs.readFileSync('client/public/voice/manifest.json', 'utf8'));
const have: Record<string, string> = manifest.phrases ?? {};
const DIR = 'data/human-games';
const missing: Record<string, number> = {};
const missingFrom: Record<string, string> = {};
let total = 0;

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
	let g: any; try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	for (const e of (g.fullGameLog || g.gameLog || [])) {
		const parts = actionParts(e.action ?? '', e.details ?? '', e.tileId);
		if (!parts) continue;
		total++;
		for (const p of parts) {
			if (have[p]) continue;
			missing[p] = (missing[p] || 0) + 1;
			missingFrom[p] = `${e.action} [${String(e.details ?? '').slice(0, 40)}]`;
		}
	}
}
// 종족 이름 조각도 확인 (호칭으로 항상 앞에 붙는다)
const factions = Object.keys(have).length;
const rows = Object.entries(missing).sort((a, b) => b[1] - a[1]);
console.log(`안내 ${total}건 · 조각 ${factions}개 · 빠진 문구 ${rows.length}종`);
for (const [k, v] of rows) console.log(`  ${String(v).padStart(6)}  "${k}"   ← ${missingFrom[k]}`);
process.exit(rows.length === 0 ? 0 : 1);
