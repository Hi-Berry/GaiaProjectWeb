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
const allRounds = process.argv.includes('--all');   // 한 판 전체를 라운드 표시와 함께
const asJson = process.argv.includes('--json');    // 검토용 HTML을 만들 때 쓰는 기계 판독 출력
const out: any[] = [];
const emit = (o: any) => { if (asJson) out.push(o); };
const say = (t: string) => { if (!asJson) console.log(t); };

const g: any = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
const rawLog: any[] = g.fullGameLog || g.gameLog || [];
const log: any[] = allRounds ? rawLog : rawLog.filter((e: any) => e.round === round);
const players: Record<string, any> = g.players || {};

say(`${file} · ${allRounds ? '전체' : `라운드 ${round}`} · 로그 ${log.length}줄`);
say(Object.values(players).map((p: any) => `${p.name}(${p.faction})`).join(' · '));
say('');

let cur: string | null = null;
let announced = false;
let pendingParts: string[] = [];   // 아직 본 액션을 못 만난 준비 동작(콤보 합류 대기)
let lastAt = 0;
let turnNo = 0;
let curRound: number | undefined;
for (const e of log) {
	if (allRounds && e.round !== curRound) { curRound = e.round; say(`
══════ 라운드 ${curRound} ══════`); }
	const parts = actionParts(e.action ?? '', e.details ?? '', e.tileId);
	const p = players[e.playerId] || {};
	// 구간(턴) 전환 — 읽을 게 있는 로그의 주인이 바뀌면 새 턴
	if (parts && e.playerId !== cur) {
		if (pendingParts.length) { say(`🔊 ${pendingParts.join(' ')}`); emit({ round: curRound, turn: turnNo, player: cur, said: pendingParts.join(' '), action: '(준비 동작 단독)', details: '' }); pendingParts = []; }
		cur = e.playerId; announced = false; lastAt = 0; turnNo++; say(`── 턴 ${turnNo} · ${p.name} ──`);
	}
	const raw = `${e.action}${e.details ? ` [${e.details}]` : ''}`;
	if (!parts) { say(`   ${'—— 무음 ——'.padEnd(34)} ${raw}`); emit({ round: e.round, turn: turnNo, player: p.name, faction: p.faction, said: null, why: '규칙 없음', action: e.action, details: e.details ?? '' }); continue; }

	const isTech = isFollowupInfo(e.action ?? '');
	const isEnabler = parts.length === 1 && ENABLER_LABELS.has(parts[0]);
	const ts = e.timestamp ?? 0;
	const longGap = ts - lastAt >= 3000;   // 클라이언트와 동일 — 3초 이상이면 다른 행동으로 본다
	if (announced && !longGap && !isTech) { say(`   ${'—— 무음(턴 1회) ——'.padEnd(34)} ${raw}`); emit({ round: e.round, turn: turnNo, player: p.name, faction: p.faction, said: null, why: '턴 1회', action: e.action, details: e.details ?? '' }); continue; }
	const gapNote = announced && longGap && !isTech ? '  ← 3초 규칙으로 추가 안내' : '';
	const skipWho = isTech && announced;
	// 준비 동작은 바로 읽지 않고 본 액션과 한 문장으로 합친다(클라이언트와 동일)
	if (isEnabler) {
		if (!pendingParts.length) pendingParts.push(whoLabel(p.faction, p.name) ?? '');
		pendingParts.push(...parts);
		lastAt = ts;
		continue;
	}
	announced = true;
	lastAt = ts;
	const who = pendingParts.length ? '' : (skipWho ? '' : (whoLabel(p.faction, p.name) ?? ''));
	const said = [...pendingParts, who, ...parts].filter(Boolean).join(' ');
	pendingParts = [];
	say(`🔊 ${said.padEnd(34)} ${raw}${gapNote}`);
	emit({ round: e.round, turn: turnNo, player: p.name, faction: p.faction, said, parts: [who, ...parts].filter(Boolean), gap: !!gapNote, action: e.action, details: e.details ?? '' });
}
if (asJson) console.log(JSON.stringify({ file, players: Object.values(players).map((p: any) => ({ name: p.name, faction: p.faction })), rows: out }));
