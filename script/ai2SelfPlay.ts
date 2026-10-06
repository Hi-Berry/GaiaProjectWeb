/**
 * [ai2 자기 강화 2026-10-06] 새 AI(PUCT)가 4좌석 모두 두는 자가대국 → 정책·가치 학습 데이터.
 *  결정마다: 상태·선택지 인코딩 + 정책 목표 pi = 루트 방문 비율(희소) + y = 고른 수. 게임 끝: 좌석별 최종 점수.
 *  다양성: R ≤ --sampleRound 는 방문 비율로 표본 추출, 이후 최다 방문.
 *  사용: PORT=5171 npx tsx script/ai2SelfPlay.ts --model data/ai2/model_v1.pt --shard 0 --shards 6 --sims 48 [--games N | --minutes M] --out data/ai2/selfplay_it1
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { prepareHeadless, runToEnd, Policy } from '../server/ai2/headlessDriver';
import { NetClient } from '../server/ai2/netClient';
import { puctPolicy, newPuctStats } from '../server/ai2/puct';
import { encodeState, encodeMove } from '../server/ai2/encoder';
import { moveKey } from '../server/ai2/moveGen';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const shard = Number(opt('--shard', '0')), shards = Number(opt('--shards', '1')), maxGames = Number(opt('--games', '1000000'));
const outDir = opt('--out', 'data/ai2/selfplay_it1');
const sparse = (a: ArrayLike<number>) => { const i: number[] = [], v: number[] = []; for (let k = 0; k < a.length; k++) if (a[k] !== 0) { i.push(k); v.push(Math.round(a[k] * 1000) / 1000); } return [i, v]; };

(async () => {
	fs.mkdirSync(outDir, { recursive: true });
	const outPath = path.join(outDir, `shard${shard}_${Date.now()}.jsonl.gz`);
	const gz = zlib.createGzip({ level: 6 }); gz.pipe(fs.createWriteStream(outPath));
	const write = (o: any) => gz.write(JSON.stringify(o) + '\n');
	const net = new NetClient(opt('--model', 'data/ai2/model_v1.pt'));
	const dir = path.join(process.cwd(), 'logs', 'round-start');
	// 학습 검증용으로 떼어 둔 시작 상태는 제외(대결 기준선 보존)
	const valStarts = new Set<string>(fs.existsSync(opt('--exclude', 'data/ai2/model_v1.val_starts.json')) ? JSON.parse(fs.readFileSync(opt('--exclude', 'data/ai2/model_v1.val_starts.json'), 'utf8')) : []);
	const files = fs.readdirSync(dir).filter(f => f.endsWith('_r1.json') && !valStarts.has(f.replace('_r1.json', ''))).sort();
	const t0 = Date.now(); let games = 0, decisions = 0;
	const minutes = Number(opt('--minutes', '0')); // >0이면 시간 예산(분)이 다 되면 다음 판을 시작하지 않음
	for (let k = shard; games < maxGames && (!minutes || (Date.now() - t0) / 60000 < minutes); k += shards) {
		const f = files[k % files.length];
		const gameId = `${f.replace('_r1.json', '')}#sp${shard}_${games}`;
		const st = newPuctStats();
		const curGame = gameId;
		const ai2: Policy = puctPolicy(net, st, {
			sims: Number(opt('--sims', '48')), sampleUntilRound: Number(opt('--sampleRound', '2')), seed: shard * 100003 + games + 1,
			onSearch: ({ game, seat, moves, visits, pick }) => {
				const tot = visits.reduce((a, b) => a + b, 0) || 1;
				const e = encodeState(game, seat);
				const piI: number[] = [], piV: number[] = [];
				visits.forEach((n, i) => { if (n > 0) { piI.push(i); piV.push(Math.round((n / tot) * 1000) / 1000); } });
				write({ g: curGame, p: seat, r: game.roundNumber, y: pick, pi: [piI, piV], kind: 'main', flat: sparse(e.flat), grid: sparse(e.grid),
					moves: moves.map(m => { const em = encodeMove(game, seat, m); return { f: sparse(em.flat), c: em.cell, k: moveKey(m) }; }) });
				decisions++;
			},
		});
		const g = prepareHeadless(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
		const seats = new Set(g.turnOrder);
		const r = await runToEnd(g, ai2, { botParity: true, ai2Seats: seats });
		write({ final: true, g: curGame, ended: r.ended, scores: r.scores, order: g.turnOrder, factions: Object.fromEntries(g.turnOrder.map(id => [id, (g.players[id] as any).faction])) });
		games++;
		fs.writeSync(1, `[sp s${shard}] ${curGame} ${r.ended ? 'END' : 'STUCK ' + r.stuck} scores=${Object.values(r.scores).join('/')} · 결정 ${decisions} · ${((Date.now() - t0) / 60000).toFixed(1)}분\n`);
	}
	gz.end(); await new Promise(r => setTimeout(r, 500)); net.close();
	fs.writeSync(1, `[sp s${shard}] 완료 게임 ${games} · 결정 ${decisions} → ${outPath}\n`);
	process.exit(0);
})();
