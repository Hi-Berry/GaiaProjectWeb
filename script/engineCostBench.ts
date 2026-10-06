/**
 * [0단계 타당성 2026-10-05] 현 서버 엔진의 '탐색용 시뮬레이터' 비용 측정.
 *  질문: 새 탐색 봇(PUCT+가치망)을 서버 엔진(performAction) 위에서 돌리면 한 수 400ms에 몇 번의 전이/롤아웃이 가능한가.
 *  측정 항목(라운드 시작 스냅샷 logs/cf-snapshots/*.json에서):
 *   - 상태 JSON 크기, cloneGameStateForSimulation 1회 비용
 *   - getCandidateMoves 1회 비용(후보 수)
 *   - performAction 1회 비용(preActions 포함 한 '수')
 *   - 저가 정책(후보 중 무작위)으로 게임 끝까지 굴린 롤아웃 1회 비용·수 개수
 *  사용: PORT=5131 npx tsx script/engineCostBench.ts [스냅샷 수(기본 8)]
 */
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { BotLogic, BotAction } from '../server/ai/bot';
import { StateCloner } from '../server/ai/stateCloner';
import { ServerGameState, scoreTerminalStateForRollout } from '../server/gameState';
import { applyRolloutIncome } from '../server/ai/rolloutIncome';

const out = (s: string) => fs.writeSync(1, s + '\n');
const dummyIo = { to: () => ({ emit: () => { /* noop */ } }) } as any;
const dir = path.join(process.cwd(), 'logs', 'cf-snapshots');
const N = Number(process.argv[2] ?? 8);
const REAL = process.argv.includes('--real'); // 패스·라운드 전환도 서버 코드(executePassRound)로 — 헤드리스 구동 가능성 점검
const stuck: Record<string, number> = {}; let realRounds = 0, realEnds = 0;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().slice(0, N);

function normalize(raw: ServerGameState): ServerGameState {
	const s = StateCloner.cloneGameStateForSimulation(raw);
	(s as any).simulation = true;
	for (const pid of s.turnOrder ?? Object.keys(s.players)) { if (s.players[pid]) { s.players[pid].hasPassed = false; applyRolloutIncome(s, pid); } }
	s.currentPlayerIndex = 0; s.hasDoneMainAction = false;
	return s;
}

const T = { clone: [] as number[], cands: [] as number[], candN: [] as number[], act: [] as number[], rollout: [] as number[], rolloutMoves: [] as number[], bytes: [] as number[], actFail: 0 };
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

async function rollout(s0: ServerGameState): Promise<void> {
	const s = StateCloner.cloneGameStateForSimulation(s0); (s as any).simulation = true;
	const order: string[] = s.turnOrder ?? Object.keys(s.players);
	const t0 = performance.now(); let moves = 0, steps = 0;
	while (steps++ < 1500) {
		if ((s as any).currentPhase === 'gameEnd' || (s.roundNumber ?? 1) > 6) break;
		if (order.every(pid => s.players[pid]?.hasPassed)) {
			if ((s.roundNumber ?? 1) >= 6) break;
			s.roundNumber = (s.roundNumber ?? 1) + 1;
			for (const pid of order) { s.players[pid].hasPassed = false; applyRolloutIncome(s, pid); }
			s.currentPlayerIndex = 0; s.hasDoneMainAction = false; continue;
		}
		const cur = order[s.currentPlayerIndex ?? 0];
		if (!cur || s.players[cur]?.hasPassed) { s.currentPlayerIndex = ((s.currentPlayerIndex ?? 0) + 1) % order.length; continue; }
		const tc = performance.now();
		const cands = BotLogic.getCandidateMoves(s, cur).filter(c => c.type !== 'end_turn');
		T.cands.push(performance.now() - tc); T.candN.push(cands.length);
		const nonPass = cands.filter(c => c.type !== 'pass_round');
		// 무작위 정책: 패스는 비-패스 후보가 없거나 10% 확률일 때만(게임이 진행되도록)
		const a = (nonPass.length && rnd() > 0.1) ? nonPass[Math.floor(rnd() * nonPass.length)] : null;
		if (REAL) {
			const before = s.roundNumber;
			const pend = Object.keys(s).filter(k => /^pending|queued/.test(k) && (s as any)[k] != null && !(Array.isArray((s as any)[k]) && !(s as any)[k].length));
			const pick = a ?? cands.find(c => c.type === 'pass_round') ?? null;
			if (!pick) { const k = `R${s.roundNumber} phase=${(s as any).currentPhase} cur=${cur === order[s.currentPlayerIndex ?? 0]} cands=0 pend=${pend.join('|')}`; stuck[k] = (stuck[k] || 0) + 1; break; }
			let ok2 = true;
			try { ok2 = await BotLogic.performAction(dummyIo, s, pick as any, cur); } catch (e) { ok2 = false; }
			moves++;
			if (!ok2) { const k = `fail ${pick.type} R${s.roundNumber} phase=${(s as any).currentPhase} pend=${pend.join('|')}`; stuck[k] = (stuck[k] || 0) + 1; break; }
			if (s.roundNumber !== before) realRounds++;
			if ((s as any).currentPhase === 'gameEnd') { realEnds++; break; }
			if (pick.type !== 'pass_round' && s.hasDoneMainAction) { s.currentPlayerIndex = ((s.currentPlayerIndex ?? 0) + 1) % order.length; s.hasDoneMainAction = false; }
			continue;
		}
		if (!a) { s.players[cur].hasPassed = true; s.currentPlayerIndex = ((s.currentPlayerIndex ?? 0) + 1) % order.length; s.hasDoneMainAction = false; continue; }
		const ta = performance.now(); let ok = true;
		try {
			for (const pre of (a.preActions ?? [])) { if (!await BotLogic.performAction(dummyIo, s, pre, cur)) { ok = false; break; } }
			if (ok) ok = await BotLogic.performAction(dummyIo, s, { type: a.type, params: a.params } as any, cur);
		} catch { ok = false; }
		T.act.push(performance.now() - ta); moves++;
		if (!ok) { T.actFail++; s.players[cur].hasPassed = true; s.currentPlayerIndex = ((s.currentPlayerIndex ?? 0) + 1) % order.length; s.hasDoneMainAction = false; continue; }
		if (s.hasDoneMainAction) { s.currentPlayerIndex = ((s.currentPlayerIndex ?? 0) + 1) % order.length; s.hasDoneMainAction = false; }
	}
	scoreTerminalStateForRollout(s);
	T.rollout.push(performance.now() - t0); T.rolloutMoves.push(moves);
}

(async () => {
	for (const f of files) {
		const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
		const s = normalize(raw);
		T.bytes.push(JSON.stringify(s).length);
		for (let i = 0; i < 20; i++) { const t = performance.now(); StateCloner.cloneGameStateForSimulation(s); T.clone.push(performance.now() - t); }
		for (let i = 0; i < 3; i++) await rollout(s);
		out(`${f}: R${raw.roundNumber} rollouts=${T.rollout.length}`);
	}
	const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
	const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
	out(`\n스냅샷 ${files.length}개 · 롤아웃 ${T.rollout.length}회`);
	out(`상태 JSON 크기      평균 ${(avg(T.bytes) / 1024).toFixed(0)} KB`);
	out(`clone 1회           평균 ${avg(T.clone).toFixed(2)} ms · 중앙 ${med(T.clone).toFixed(2)} ms`);
	out(`getCandidateMoves   평균 ${avg(T.cands).toFixed(2)} ms · 중앙 ${med(T.cands).toFixed(2)} ms · 후보 평균 ${avg(T.candN).toFixed(1)}개`);
	out(`performAction(한 수) 평균 ${avg(T.act).toFixed(2)} ms · 중앙 ${med(T.act).toFixed(2)} ms · 실패 ${T.actFail}/${T.act.length}`);
	out(`롤아웃(R→종료)      평균 ${avg(T.rollout).toFixed(0)} ms · 수 ${avg(T.rolloutMoves).toFixed(0)}개 → 수당 ${(avg(T.rollout) / Math.max(1, avg(T.rolloutMoves))).toFixed(2)} ms`);
	if (REAL) { out(`\n[--real] 라운드 전환 ${realRounds}회 · 게임 종료 도달 ${realEnds}/${T.rollout.length}`); for (const [k, v] of Object.entries(stuck).sort((a, b) => b[1] - a[1])) out(`  막힘 ${v}× ${k}`); }
	process.exit(0);
})();
