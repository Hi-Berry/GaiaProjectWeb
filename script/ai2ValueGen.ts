/**
 * [ai2 가치망 강화 2026-10-07] 가치 학습용 대량 대국 — 기존 봇 빠른 경로(판당 ~1초) + ε 무작위 수로 판마다 다르게.
 *  결정 일부(--every N마다 1개)의 상태만 기록(가치 전용 행: vo=1, 정책 학습엔 안 씀). 게임 끝에 좌석별 최종 점수.
 *  자가대국(판당 ~4분)으로는 판 수가 모자라 가치 목표(최종 점수 차)의 노이즈를 이길 수 없어서 판 수로 보완.
 *  검증 시작 상태(--exclude)는 제외.
 *  사용: PORT=5181 npx tsx script/ai2ValueGen.ts --shard 0 --shards 6 --minutes 180 --eps 0.15 --every 5 --out data/ai2/valuegen
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { BotLogic } from '../server/ai/bot';
import { prepareHeadless, runToEnd, botFastPolicy, Policy } from '../server/ai2/headlessDriver';
import { encodeState } from '../server/ai2/encoder';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const shard = Number(opt('--shard', '0')), shards = Number(opt('--shards', '1'));
const minutes = Number(opt('--minutes', '60')), eps = Number(opt('--eps', '0.15')), every = Number(opt('--every', '5'));
const outDir = opt('--out', 'data/ai2/valuegen');
const sparse = (a: ArrayLike<number>) => { const i: number[] = [], v: number[] = []; for (let k = 0; k < a.length; k++) if (a[k] !== 0) { i.push(k); v.push(Math.round(a[k] * 1000) / 1000); } return [i, v]; };

(async () => {
	fs.mkdirSync(outDir, { recursive: true });
	const outPath = path.join(outDir, `shard${shard}_${Date.now()}.jsonl.gz`);
	const gz = zlib.createGzip({ level: 6 }); const ws = fs.createWriteStream(outPath); gz.pipe(ws); // 종료 전 'finish'까지 기다려야 gzip 꼬리가 안 잘린다
	const write = (o: any) => gz.write(JSON.stringify(o) + '\n');
	const dir = path.join(process.cwd(), 'logs', 'round-start');
	const excl = opt('--exclude', 'data/ai2/model_v1.val_starts.json');
	const val = new Set<string>(fs.existsSync(excl) ? JSON.parse(fs.readFileSync(excl, 'utf8')) : []);
	const files = fs.readdirSync(dir).filter(f => f.endsWith('_r1.json') && !val.has(f.replace('_r1.json', ''))).sort();
	let s = (shard * 7919 + 1) >>> 0; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const t0 = Date.now(); let games = 0, rows = 0;
	for (let k = shard; (Date.now() - t0) / 60000 < minutes; k += shards) {
		const f = files[k % files.length];
		const gameId = `${f.replace('_r1.json', '')}#vg${shard}_${games}`;
		const pol: Policy = async (game, d) => {
			if (d.kind === 'main' && game.currentPhase === 'main' && rnd() < 1 / every) {
				const e = encodeState(game, d.playerId);
				write({ g: gameId, p: d.playerId, r: game.roundNumber, y: 0, vo: 1, flat: sparse(e.flat), grid: sparse(e.grid), moves: [{ f: [[], []], c: -1, k: '-' }] });
				rows++;
			}
			if (d.kind === 'main' && game.currentPhase === 'main' && rnd() < eps) {
				const cands = BotLogic.getCandidateMoves(game, d.playerId).filter(c => c.type !== 'end_turn' && c.type !== 'pass_round');
				if (cands.length) return cands[Math.floor(rnd() * cands.length)];
			}
			return botFastPolicy(game, d);
		};
		const g = prepareHeadless(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
		const r = await runToEnd(g, pol, { botParity: true });
		write({ final: true, g: gameId, ended: r.ended, scores: r.scores });
		games++;
		if (games % 25 === 0) fs.writeSync(1, `[vg s${shard}] 게임 ${games} · 행 ${rows} · ${((Date.now() - t0) / 60000).toFixed(0)}분\n`);
	}
	gz.end(); await new Promise(r => ws.on('finish', r));
	fs.writeSync(1, `[vg s${shard}] 완료 게임 ${games} · 행 ${rows} → ${outPath}\n`);
	process.exit(0);
})();
