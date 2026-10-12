/**
 * [ai2 1단계 데이터 A 2026-10-05] 기존 봇(MCTS 포함) 자가대국을 헤드리스 구동기로 돌려 정책·가치 학습 데이터를 만든다.
 *
 * 각 메인 결정(4좌석 전부)마다: 관점 플레이어 기준 상태 인코딩 + 합법 수 생성기 선택지 인코딩 + 봇이 고른 수의 위치(y).
 *   - 봇의 수는 preActions(변환 등)를 묶어 내므로, 생성기 공간(프리액션 = 개별 수)에 맞춰 '프리액션 → … → 메인'의
 *     연속 결정으로 풀어서 각각 기록한다(복제본에 하나씩 적용하며 그 시점 상태로).
 *   - 봇의 수가 생성기 선택지에 없으면(커버리지 구멍) y = -1로 남기고 집계.
 * 게임이 끝나면 final 줄(좌석별 최종 점수)을 쓴다 — 가치 목표는 학습 시 (내 점수 − 상대 평균) 등으로 계산.
 *
 * 저장(JSONL.gz, 한 줄 = 한 결정): 희소 표현 — flat/grid/수 특징은 0이 대부분이라 [인덱스들, 값들].
 * 사용: PORT=5141 npx tsx script/ai2GenData.ts --shard 0 --shards 6 --mcts 200 --out data/ai2/selfplay
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { performance } from 'perf_hooks';
import { BotAction } from '../server/ai/bot';
import { MCTS } from '../server/ai/mcts';
import { prepareHeadless, runToEnd, botFullPolicy, Policy } from '../server/ai2/headlessDriver';
import { generateMoves, generatePendingOptions, moveKey, tryApply } from '../server/ai2/moveGen';
import { encodeState, encodeMove } from '../server/ai2/encoder';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const shard = Number(opt('--shard', '0')), shards = Number(opt('--shards', '1'));
const mctsMs = Number(opt('--mcts', '200'));
const outDir = opt('--out', 'data/ai2/selfplay');
const reps = Number(opt('--reps', '1'));
const startDir = path.join(process.cwd(), 'logs', 'round-start');
MCTS.setBotOnlyCap(mctsMs);

const sparse = (a: ArrayLike<number>) => { const i: number[] = [], v: number[] = []; for (let k = 0; k < a.length; k++) if (a[k] !== 0) { i.push(k); v.push(Math.round(a[k] * 1000) / 1000); } return [i, v]; };

const files = fs.readdirSync(startDir).filter(f => f.endsWith('_r1.json')).sort().filter((_, i) => i % shards === shard);
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `shard${shard}_${Date.now()}.jsonl.gz`);
const gz = zlib.createGzip({ level: 6 });
const ws = fs.createWriteStream(outPath); gz.pipe(ws); // 종료 전 'finish'까지 기다려야 gzip 꼬리가 안 잘린다
const write = (o: any) => gz.write(JSON.stringify(o) + '\n');

const stat = { decisions: 0, matched: 0, unmatched: {} as Record<string, number>, games: 0, ended: 0 };

/** 한 결정 기록: 상태·선택지·정답 위치 */
function record(game: any, pid: string, gameId: string, label: BotAction) {
	// 보류 선택(메인 뒤 테라포밍 스텝 광산 등)이면 그 선택지, 아니면 일반 턴 선택지
	const po = generatePendingOptions(game, pid);
	const options = po?.options.length ? po.options : generateMoves(game, pid);
	const key = moveKey(label);
	const y = options.findIndex(m => moveKey(m) === key);
	stat.decisions++;
	if (y >= 0) stat.matched++; else stat.unmatched[label.type] = (stat.unmatched[label.type] ?? 0) + 1;
	if (y < 0 && label.type === 'build_mine' && process.env.AI2_DEBUG) {
		const pl: any = game.players[pid]; const t: any = game.map.find((x: any) => x.id === (label.params as any).tileId);
		const anchors = game.map.filter((x: any) => x.ownerId === pid && x.structure);
		const dist = Math.min(...anchors.map((a: any) => (Math.abs(a.q - t.q) + Math.abs(a.q + a.r - t.q - t.r) + Math.abs(a.r - t.r)) / 2));
		fs.writeSync(1, `  [miss] ${t.id} type=${t.type} owner=${t.ownerId} struct=${t.structure} gf=${t.hasGaiaformer}/${t.gaiaformerOwnerId} dist=${dist} nav=${pl.research?.navigation} navBonus=${pl.navigationBonus} temp=${pl.tempRangeBonus}/${pl.rangeBonusActive} steps=${pl.pendingTerraformSteps} free=${pl.nextMineFreeFromShipTech}/${pl.spaceshipFed3TfMineFree} fac=${pl.faction} pre=${(label as any).preActions?.length ?? 0}\n`);
	}
	const e = encodeState(game, pid);
	write({
		g: gameId, p: pid, r: game.roundNumber, y, kind: po?.options.length ? po.key : 'main', ...(y < 0 ? { lk: key, res: { o: game.players[pid].ore, c: game.players[pid].credits, q: game.players[pid].qic, p3: game.players[pid].power3, k: game.players[pid].knowledge } } : {}),
		flat: sparse(e.flat), grid: sparse(e.grid),
		moves: options.map(m => { const em = encodeMove(game, pid, m); return { f: sparse(em.flat), c: em.cell, k: moveKey(m) }; }),
	});
}

function recordingPolicy(gameId: string): Policy {
	return async (game, d) => {
		const a = await botFullPolicy(game, d);
		if (!a || d.kind !== 'main' || game.currentPhase !== 'main') return a;
		// preActions를 생성기 공간의 연속 결정으로 풀어 기록(복제본에 순서대로 적용)
		let s: any = game;
		for (const pre of (a.preActions ?? [])) {
			record(s, d.playerId, gameId, pre);
			const next = await tryApply(s, d.playerId, pre);
			if (!next) return a; // 서버가 거부 — 이후 기록 중단(구동기가 원래 수를 처리)
			s = next;
		}
		record(s, d.playerId, gameId, { type: a.type, params: a.params } as BotAction);
		return a;
	};
}

(async () => {
	const t0 = performance.now();
	for (const f of files) {
		const snap = JSON.parse(fs.readFileSync(path.join(startDir, f), 'utf8'));
		for (let r = 0; r < reps; r++) {
			const gameId = `${f.replace('_r1.json', '')}#${r}`;
			const g = prepareHeadless(snap);
			const res = await runToEnd(g, recordingPolicy(gameId), { botParity: true });
			stat.games++; if (res.ended) stat.ended++;
			write({ final: true, g: gameId, ended: res.ended, scores: res.scores, order: g.turnOrder, factions: Object.fromEntries(g.turnOrder.map(id => [id, (g.players[id] as any).faction])) });
			fs.writeSync(1, `[shard ${shard}] ${gameId} ${res.ended ? 'END' : 'STUCK ' + res.stuck} scores=${Object.values(res.scores).join('/')} · 누적 결정 ${stat.decisions} 일치 ${(100 * stat.matched / Math.max(1, stat.decisions)).toFixed(1)}% · ${((performance.now() - t0) / 1000).toFixed(0)}s\n`);
		}
	}
	gz.end();
	await new Promise(r => ws.on('finish', r));
	fs.writeSync(1, `[shard ${shard}] 완료: 게임 ${stat.ended}/${stat.games} · 결정 ${stat.decisions} · 일치 ${(100 * stat.matched / Math.max(1, stat.decisions)).toFixed(1)}% · 불일치 ${JSON.stringify(stat.unmatched)} → ${outPath}\n`);
	process.exit(0);
})();
