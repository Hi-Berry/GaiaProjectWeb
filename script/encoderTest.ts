/**
 * [ai2 0단계 2026-10-05] 인코더(server/ai2/encoder.ts) 검증 — ai2 좌석 4개 무작위 대국 중 매 결정에서 상태·선택지 인코딩.
 *  게이트: 차원 일정 · NaN 0 · 값 범위 · 결정당 시간 · 재인코딩 동일(결정성) · 서로 다른 선택지의 수 특징이 구별되는가.
 *  사용: PORT=5131 npx tsx script/encoderTest.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { prepareHeadless, runToEnd, markAi2Seats, Policy } from '../server/ai2/headlessDriver';
import { tryApply, moveKey } from '../server/ai2/moveGen';
import { encodeState, encodeMove, encoderDims } from '../server/ai2/encoder';

const out = (s: string) => fs.writeSync(1, s + '\n');
const dir = path.join(process.cwd(), 'logs', 'round-start');
const files = fs.readdirSync(dir).filter(f => f.endsWith('_r1.json')).sort();
const st = { n: 0, flatLens: new Set<number>(), gridLens: new Set<number>(), moveLens: new Set<number>(), nan: 0, maxAbs: 0, maxAt: '', ms: [] as number[],
	nondet: 0, dupMoveFeat: 0, moves: 0, cellNeg: 0, tileMoves: 0 };

function policy(seed: number): Policy {
	let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	return async (game, d) => {
		if (!d.options) return null;
		const t0 = performance.now();
		const e = encodeState(game, d.playerId);
		const ms = d.options.map(m => encodeMove(game, d.playerId, m));
		st.ms.push(performance.now() - t0); st.n++;
		st.flatLens.add(e.flat.length); st.gridLens.add(e.grid.length);
		for (const v of e.flat) { if (!Number.isFinite(v)) st.nan++; if (Math.abs(v) > st.maxAbs) { st.maxAbs = Math.abs(v); } }
		for (const v of e.grid) if (!Number.isFinite(v)) st.nan++;
		// 결정성
		const e2 = encodeState(game, d.playerId);
		if (e2.flat.join(',') !== e.flat.join(',')) st.nondet++;
		// 선택지 특징 구별: 키가 다른데 (특징+cell)이 같으면 정책이 구분 못 함
		const seen = new Map<string, string>();
		d.options.forEach((m, i) => {
			st.moves++; st.moveLens.add(ms[i].flat.length);
			const tileId = (m.params as any)?.tileId ?? (m.params as any)?.targetTileId;
			if (tileId) { st.tileMoves++; if (ms[i].cell < 0) st.cellNeg++; }
			const f = ms[i].flat.join(',') + '#' + ms[i].cell;
			const k = moveKey(m);
			if (seen.has(f) && seen.get(f) !== k) st.dupMoveFeat++;
			seen.set(f, k);
		});
		if (d.kind !== 'main') return d.options[Math.floor(rnd() * d.options.length)];
		const order = d.options.map(m => [rnd(), m] as const).sort((a, b) => a[0] - b[0]).map(x => x[1])
			.sort((a, b) => (a.type === 'pass_round' ? 1 : 0) - (b.type === 'pass_round' ? 1 : 0));
		for (const m of order) if (await tryApply(game, d.playerId, m)) return m;
		return null;
	};
}

(async () => {
	let dims: any = null;
	for (const f of files) {
		const g = prepareHeadless(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
		dims ??= encoderDims(g, g.turnOrder[0]);
		const seats = new Set(g.turnOrder); markAi2Seats(g, seats);
		const r = await runToEnd(g, policy(11), { ai2Seats: seats });
		out(`${f}: ${r.ended ? 'END' : 'STUCK ' + r.stuck}`);
	}
	const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
	out(`\n차원: ${JSON.stringify(dims)} (격자 원소 ${dims.grid[0] * dims.grid[1] * dims.grid[2]})`);
	out(`결정 ${st.n}개 · flat 길이 ${[...st.flatLens]} · grid 길이 ${[...st.gridLens]} · move 길이 ${[...st.moveLens]}`);
	out(`NaN ${st.nan} · flat 최대 |값| ${st.maxAbs.toFixed(2)} · 비결정 ${st.nondet}`);
	out(`인코딩 시간(상태+선택지 전부) 평균 ${avg(st.ms).toFixed(2)}ms`);
	out(`선택지 ${st.moves}개 · 특징이 같은데 다른 수 ${st.dupMoveFeat}개 · 타일 수 중 격자 밖 ${st.cellNeg}/${st.tileMoves}`);
	process.exit(0);
})();
