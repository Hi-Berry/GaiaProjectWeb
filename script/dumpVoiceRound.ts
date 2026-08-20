/**
 * 실제 게임 로그 한 라운드를 '음성이 무엇을 읽는가'로 풀어 본다 — 이상한 문구를 눈으로 찾기 위한 도구.
 * 클라이언트(Game.tsx)의 판정 규칙을 그대로 옮겼다: 턴 1회 + 기술타일 예외 + 준비 동작은 1회를 안 쓴다.
 *   턴 경계는 오프라인이라 hasDoneMainAction을 볼 수 없어 '같은 사람의 연속 구간'으로 근사하고,
 *   클라이언트에 있는 3초 규칙(같은 사람의 안내가 3초 이상 벌어지면 새 행동으로 본다)도 같이 적용한다.
 *   그래서 같은 사람이 연속으로 턴을 가져가는 구간도 실제처럼 각각 읽힌다.
 *
 * 실행: npx tsx script/dumpVoiceRound.ts [--game 파일명] [--round N]
 */
import fs from 'fs';
import path from 'path';
import { actionParts, ENABLER_LABELS, isFollowupInfo, whoLabel } from '../client/src/lib/speech';

const arg = (k: string) => {
	const i = process.argv.indexOf(k);
	return i > 0 ? process.argv[i + 1] : undefined;
};
const DIR = path.join(process.cwd(), 'data', 'human-games');
const file = arg('--game') ?? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).slice(-1)[0];
const round = Number(arg('--round') ?? 2);

const g: any = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
const log: any[] = (g.fullGameLog || g.gameLog || []).filter((e: any) => e.round === round);
const players: Record<string, any> = g.players || {};

console.log(`${file} · 라운드 ${round} · 로그 ${log.length}줄`);
console.log(Object.values(players).map((p: any) => `${p.name}(${p.faction})`).join(' · '));
console.log('');

let cur: string | null = null;
let announced = false;
let lastAt = 0;
let turnNo = 0;
for (const e of log) {
	const parts = actionParts(e.action ?? '', e.details ?? '', e.tileId);
	const p = players[e.playerId] || {};
	// 구간(턴) 전환 — 읽을 게 있는 로그의 주인이 바뀌면 새 턴
	if (parts && e.playerId !== cur) { cur = e.playerId; announced = false; lastAt = 0; turnNo++; console.log(`── 턴 ${turnNo} · ${p.name} ──`); }
	const raw = `${e.action}${e.details ? ` [${e.details}]` : ''}`;
	if (!parts) { console.log(`   ${'—— 무음 ——'.padEnd(34)} ${raw}`); continue; }

	const isTech = isFollowupInfo(e.action ?? '');
	const isEnabler = parts.length === 1 && ENABLER_LABELS.has(parts[0]);
	const ts = e.timestamp ?? 0;
	const longGap = ts - lastAt >= 3000;   // 클라이언트와 동일 — 3초 이상이면 다른 행동으로 본다
	if (announced && !longGap && !isTech) { console.log(`   ${'—— 무음(턴 1회) ——'.padEnd(34)} ${raw}`); continue; }
	const gapNote = announced && longGap && !isTech ? '  ← 3초 규칙으로 추가 안내' : '';
	const skipWho = isTech && announced;
	if (!isEnabler) announced = true;
	lastAt = ts;
	const who = skipWho ? '' : (whoLabel(p.faction, p.name) ?? '');
	const said = [who, ...parts].filter(Boolean).join(' ');
	console.log(`🔊 ${said.padEnd(34)} ${raw}${gapNote}`);
}
