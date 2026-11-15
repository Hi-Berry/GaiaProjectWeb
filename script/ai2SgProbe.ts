/** [2026-11-15] 우주 거인 +2 테라포밍 스텝 특수 액션 뒤 실전 경로 점검: 새 AI가 결정 가능한지, 기존 봇이 무엇을 두는지 */
import * as fs from 'fs';
import { prepareHeadless, step, newStats, botFastPolicy } from '../server/ai2/headlessDriver';
import { tryApply, generateMoves } from '../server/ai2/moveGen';
import { BotLogic } from '../server/ai/bot';
import { ai2LiveDecide } from '../server/ai2/live';
(async () => {
	const files = fs.readdirSync('logs/round-start').filter(f => /_r[2-4]\.json$/.test(f));
	let tested = 0, botPass = 0, botMine = 0, botOther = 0, ai2Null = 0, ai2Mine = 0, ai2Other = 0;
	for (const f of files) {
		const raw = fs.readFileSync('logs/round-start/' + f, 'utf8'); if (!raw.includes('"space_giants"')) continue;
		const g = prepareHeadless(JSON.parse(raw));
		const sg = g.turnOrder.find(id => g.players[id].faction === 'space_giants'); if (!sg) continue;
		if ((g.players[sg] as any).usedSpecialActions?.includes('space_giants-2tf')) continue;
		const st = newStats(); let ok = false;
		for (let i = 0; i < 400; i++) {
			if (g.currentPhase === 'main' && g.turnOrder[g.currentPlayerIndex] === sg && !g.hasDoneMainAction) { ok = true; break; }
			const r = await step(g, botFastPolicy, st, { botParity: true }); if (r.done) break;
		}
		if (!ok) continue;
		const a = await tryApply(g, sg, { type: 'use_special_action', params: { actionId: 'space_giants-2tf' } } as any); if (!a) continue;
		tested++;
		const bot = await BotLogic.getNextMove(a, sg, true);
		if (!bot || bot.type === 'pass_round') botPass++; else if (bot.type === 'build_mine') botMine++; else botOther++;
		const r = await ai2LiveDecide(a, sg);
		if (!r.action) ai2Null++; else if (r.action.type === 'build_mine') ai2Mine++; else ai2Other++;
		const p: any = a.players[sg];
		if (tested <= 12) console.log(f, `O${p.ore} C${p.credits} P${p.power1}/${p.power2}/${p.power3} steps${p.pendingTerraformSteps}`, '봇:', bot?.type ?? 'null', '| 새AI:', r.action?.type ?? `null(${r.reason})`, `· 후보 mine ${generateMoves(a, sg).filter(m => m.type === 'build_mine').length}`);
		if (tested >= 25) break;
	}
	console.log(`검사 ${tested} · 기존 봇: 광산 ${botMine} 패스/null ${botPass} 기타 ${botOther} · 새 AI: 광산 ${ai2Mine} null ${ai2Null} 기타 ${ai2Other}`);
	process.exit(0);
})();
