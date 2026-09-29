/**
 * 봇 실행 실패/강제 스킵 비율을 날짜 구간별로 비교 (failRepick 수정 전후 검증용).
 * 사용: node scripts/failRateCheck.mjs
 *   logs/game_*.log 를 수정시각 기준으로 구간에 나눠 집계한다.
 */
import fs from 'fs';

const D = 'logs';
const bucket = (t) => {
	const k = t.toISOString().slice(5, 10);
	if (k === '09-08') return 'A 09-08(수정 전)';
	if (k === '09-09') return 'M 09-09(수정 당일)';
	if (k >= '09-10' && k <= '09-17') return 'B 09-10~17(수정 후)';
	return null;
};
const S = {}, typ = {}, why = {};
for (const f of fs.readdirSync(D).filter(f => /^game_.*\.log$/.test(f))) {
	const p = `${D}/${f}`;
	const b = bucket(fs.statSync(p).mtime);
	if (!b) continue;
	const s = fs.readFileSync(p, 'utf8');
	const lines = s.split('\n');
	const x = (S[b] ||= { g: 0, lines: 0, fail: 0, skip: 0, repick: 0, pend: 0, withFail: 0, passLines: 0 });
	const T = (typ[b] ||= {}), W = (why[b] ||= {});
	x.g++; x.lines += lines.length;
	let fe = 0;
	for (const l of lines) {
		let m;
		if ((m = /failed to execute (\w+)/.exec(l))) { x.fail++; fe++; T[m[1]] = (T[m[1]] || 0) + 1; }
		if (/\[FAILREPICK\]/.test(l)) x.repick++;
		if (/\[PENDBLOCK\]/.test(l)) x.pend++;
		if (/forceSkip|안전스킵|watchdog/i.test(l)) {
			x.skip++;
			const mm = /(bot stall watchdog: [^"',)]{0,40}|wall-clock watchdog[^"',)]{0,12}|action \w+ \+ pass failed|no-action pass failed|force[^"',)]{0,40})/i.exec(l);
			const w = mm ? mm[1] : l.slice(0, 80);
			W[w] = (W[w] || 0) + 1;
		}
	}
	if (fe > 0) x.withFail++;
}
for (const b of Object.keys(S).sort()) {
	const x = S[b];
	console.log(`${b} 로그 ${x.g} | 평균 ${(x.lines / x.g).toFixed(0)}줄 | 실패 ${x.fail}건 (게임당 ${(x.fail / x.g).toFixed(2)}, 1000줄당 ${(1000 * x.fail / x.lines).toFixed(2)}) 실패있는 게임 ${(100 * x.withFail / x.g).toFixed(0)}% | 스킵/워치독 ${x.skip}줄 (1000줄당 ${(1000 * x.skip / x.lines).toFixed(2)}) | FAILREPICK ${x.repick} PENDBLOCK ${x.pend}`);
	console.log('  실패 유형', Object.entries(typ[b]).sort((a, c) => c[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(' '));
	console.log('  스킵 사유', Object.entries(why[b]).sort((a, c) => c[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(' | '));
}
