/**
 * 한 액션(= 같은 사람의 연속 로그 구간)에서 음성 안내가 2회 이상 나오는 조합을 실제 로그에서 센다.
 * 사용자 질문(2026-08-20): "한 액션에 2개 이상 나오는 사운드 같은 게 있을까?"
 *
 * 실행: npx tsx script/checkVoiceDoubles.ts
 */
import fs from 'fs';
import path from 'path';
import { actionParts, ENABLER_LABELS, isFollowupInfo } from '../client/src/lib/speech';

const DIR = path.join(process.cwd(), 'data', 'human-games');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).slice(-60);

const combos: Record<string, number> = {};
let turns = 0, multi = 0, enablerFirst = 0, rescued = 0;

for (const f of files) {
	let g: any;
	try { g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
	const log: any[] = g.fullGameLog || g.gameLog || [];
	// 같은 사람의 연속 구간을 한 '턴'으로 본다(중간에 낀 남의 누수 로그는 무시)
	let cur: string | null = null;
	let labels: string[] = [];
	let announced = false;      // 클라이언트의 '턴 1회' 표시와 같은 뜻
	let firstWasEnabler = false;
	const flush = () => {
		if (labels.length) {
			turns++;
			if (labels.length >= 2) {
				multi++;
				const k = labels.join(' + ');
				combos[k] = (combos[k] || 0) + 1;
			}
			if (firstWasEnabler) {
				enablerFirst++;
				// 준비 동작이 첫 로그였던 턴 — 예전 규칙이라면 뒤 액션이 무음이었다
				if (labels.length >= 2) rescued++;
			}
		}
		labels = [];
		announced = false;
		firstWasEnabler = false;
	};
	for (const e of log) {
		const pid = e.playerId;
		const parts = actionParts(e.action ?? '', e.details ?? '', e.tileId);
		const label = parts ? parts.join(' ') : null;
		if (!pid) continue;
		if (pid !== cur) {
			// 남의 '안내 대상' 로그가 나오면 구간 전환 (누수·수신처럼 무음 로그는 무시)
			if (label) { flush(); cur = pid; }
			else continue;
		}
		if (!label || !parts) continue;
		// 클라이언트와 같은 규칙: 턴 1회 + 기술타일 예외 + 준비 동작은 1회를 안 쓴다
		const isTech = isFollowupInfo(e.action ?? '');
		const isEnabler = parts.length === 1 && ENABLER_LABELS.has(parts[0]);
		if (announced && !isTech) continue;
		if (!labels.length && isEnabler) firstWasEnabler = true;
		if (!isEnabler) announced = true;
		labels.push(label);
	}
	flush();
}

const rows = Object.entries(combos).sort((a, b) => b[1] - a[1]);
console.log(`최근 ${files.length}판 · 안내가 나가는 구간 ${turns}개 중 2회 이상 = ${multi}개 (${(100 * multi / Math.max(1, turns)).toFixed(1)}%)\n`);
console.log(`준비 동작(사거리)으로 시작한 턴 ${enablerFirst}개 · 그중 뒤 액션까지 읽게 된 것 ${rescued}개`);
console.log('');
console.log('조합                                            횟수');
for (const [k, v] of rows.slice(0, 25)) console.log(`${k.slice(0, 46).padEnd(48)}${String(v).padStart(5)}`);
if (rows.length > 25) console.log(`… 그 밖 ${rows.length - 25}종`);
