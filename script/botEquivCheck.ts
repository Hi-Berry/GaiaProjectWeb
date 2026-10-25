/**
 * [성능 리팩터 검증 2026-10-25] 기존 봇 판단이 바뀌지 않았는지: 여러 국면에서 각 좌석의 후보 목록(getCandidateMoves)과
 * 빠른 경로 선택(getNextMove 시뮬)을 JSON으로 저장·비교. Math.random 타이브레이크를 고정 시드로 막는다.
 *  사용: npx tsx script/botEquivCheck.ts save <파일> | compare <파일>
 */
import * as fs from 'fs';
import { BotLogic } from '../server/ai/bot';
import { prepareHeadless } from '../server/ai2/headlessDriver';
let seed = 12345; Math.random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
(async () => {
	const [mode, file] = process.argv.slice(2);
	const files = fs.readdirSync('logs/round-start').filter(f => f.endsWith('.json')).sort().filter((_, i) => i % 4 === 0).slice(0, 300);
	const out: Record<string, string> = {};
	const t0 = Date.now();
	for (const f of files) {
		const g = prepareHeadless(JSON.parse(fs.readFileSync('logs/round-start/' + f, 'utf8')));
		const pid = g.turnOrder[g.currentPlayerIndex];
		seed = 12345;
		const cands = BotLogic.getCandidateMoves(g, pid).map(c => JSON.stringify(c)).join('\n');
		seed = 12345;
		const pick = JSON.stringify(await BotLogic.getNextMove(prepareHeadless(g), pid, true));
		out[f] = cands + '\n#PICK ' + pick;
	}
	const ms = Date.now() - t0;
	if (mode === 'save') { fs.writeFileSync(file, JSON.stringify(out)); console.log(`저장 ${Object.keys(out).length}국면 · ${ms}ms`); }
	else { const ref = JSON.parse(fs.readFileSync(file, 'utf8')); let diff = 0; const ex: string[] = []; for (const k of Object.keys(ref)) if (ref[k] !== out[k]) { diff++; if (ex.length < 3) ex.push(k); } console.log(`비교 ${Object.keys(ref).length}국면 · 다름 ${diff} ${ex.join(',')} · ${ms}ms`); }
	process.exit(0);
})();
