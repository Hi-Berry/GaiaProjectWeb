/**
 * [ai2 2026-10-05] 새 AI 1좌석 vs 기존 봇(MCTS) 3좌석 대결 — 헤드리스.
 *  짝 비교: 같은 R1 시작 상태·같은 좌석을 기존 봇이 뒀을 때(data/ai2/selfplay의 전원-봇 대국, 시작당 4판 평균)의
 *  (그 좌석 점수 − 상대 평균)과 새 AI가 뒀을 때의 같은 값을 비교 → Δ = 새 AI − 기존 봇.
 *  사용: PORT=5151 npx tsx script/ai2Match.ts --mode greedy|search --shard 0 --shards 6 --mcts 200 --model data/ai2/model_v0.pt
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { MCTS } from '../server/ai/mcts';
import { prepareHeadless, runToEnd, botFullPolicy, Policy } from '../server/ai2/headlessDriver';
import { NetClient } from '../server/ai2/netClient';
import { greedyPolicy, searchPolicy, newSearchStats } from '../server/ai2/ai2Policy';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const mode = opt('--mode', 'greedy'), shard = Number(opt('--shard', '0')), shards = Number(opt('--shards', '1'));
MCTS.setBotOnlyCap(Number(opt('--mcts', '200')));
const out = (s: string) => fs.writeSync(1, s + '\n');

// 기준선: 전원-봇 대국에서 (시작, 좌석 pid)별 (점수 − 상대 평균) 평균
const base = new Map<string, number[]>();
for (const fn of fs.readdirSync('data/ai2/selfplay').filter(f => f.endsWith('.jsonl.gz'))) {
	for (const line of zlib.gunzipSync(fs.readFileSync(path.join('data/ai2/selfplay', fn))).toString().split('\n')) {
		if (!line.includes('"final"')) continue;
		const o = JSON.parse(line); if (!o.ended) continue;
		const start = o.g.split('#')[0];
		for (const [pid, sc] of Object.entries<number>(o.scores)) {
			const others = Object.entries<number>(o.scores).filter(([k]) => k !== pid).map(([, v]) => v);
			const k = `${start}|${pid}`; (base.get(k) ?? base.set(k, []).get(k)!).push(sc - others.reduce((a, b) => a + b, 0) / others.length);
		}
	}
}

(async () => {
	const net = new NetClient(opt('--model', 'data/ai2/model_v0.pt'));
	const st = newSearchStats();
	const ai2 = mode === 'search' ? searchPolicy(net, st, { k: Number(opt('--k', '5')), conf: Number(opt('--conf', '0.7')) }) : greedyPolicy(net, st);
	const dir = path.join(process.cwd(), 'logs', 'round-start');
	const files = fs.readdirSync(dir).filter(f => f.endsWith('_r1.json')).sort().filter((_, i) => i % shards === shard);
	const t0 = Date.now();
	for (const [gi, f] of files.entries()) {
		const start = f.replace('_r1.json', '');
		const snap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
		const g = prepareHeadless(snap);
		const seat = g.turnOrder[(gi + shard + Number(opt('--seatOffset', '0'))) % g.turnOrder.length]; // 좌석 회전(--seatOffset으로 같은 시작의 다른 좌석)
		const seats = new Set([seat]);
		const policy: Policy = async (game, d) => (seats.has(d.playerId) ? ai2(game, d) : botFullPolicy(game, d));
		const r = await runToEnd(g, policy, { botParity: true, ai2Seats: seats });
		const sc = r.scores as Record<string, number>;
		const others = Object.entries(sc).filter(([k]) => k !== seat).map(([, v]) => v);
		const margin = sc[seat] - others.reduce((a, b) => a + b, 0) / others.length;
		const b = base.get(`${start}|${seat}`) ?? [];
		const bm = b.length ? b.reduce((x, y) => x + y, 0) / b.length : NaN;
		const rank = 1 + others.filter(v => v > sc[seat]).length;
		out(JSON.stringify({ result: true, mode, start, seat, ended: r.ended, stuck: r.stuck, ai2: sc[seat], others, margin, baseMargin: bm, delta: margin - bm, rank, faction: (g.players[seat] as any).faction }));
		out(`[${mode} s${shard}] ${start} ${(g.players[seat] as any).faction} ai2=${sc[seat]} 상대=${others.join('/')} margin ${margin.toFixed(1)} vs 봇기준 ${bm.toFixed(1)} → Δ ${(margin - bm).toFixed(1)} · 순위 ${rank} · ${((Date.now() - t0) / 1000).toFixed(0)}s · 탐색 ${st.searched}/${st.decisions} 바꿈 ${st.changedFromTop}`);
	}
	net.close();
	process.exit(0);
})();
