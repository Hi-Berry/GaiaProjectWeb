/**
 * 실제 개발서버에 소켓으로 붙어 봇 자기대국을 돌리며 '음성 안내가 실제로 무엇을 읽는지' 확인한다.
 * 오프라인 덤프(dumpVoiceRound)는 저장 로그에 turnMark가 없어 턴 경계를 근사할 수밖에 없다 →
 * 여기서는 서버가 주는 turnMark를 그대로 받아 Game.tsx와 같은 판정을 돌린다(진짜 end-to-end).
 *
 * 사용: 1) PORT=5101 npx tsx server/index.ts   2) npx tsx script/liveVoiceCheck.ts
 */
import { io } from 'socket.io-client';
import { actionParts, ENABLER_LABELS, isFollowupInfo, whoLabel } from '../client/src/lib/speech';

const URL = process.env.URL ?? 'http://localhost:5101';
const MCTS_MS = Number(process.env.MCTS_MS ?? 60);
const LIMIT = Number(process.env.LIMIT ?? 120);   // 안내 몇 건 보고 끝낼지

const socket = io(URL, { transports: ['websocket'] });
let mark = 0, seen = 0, said = 0, marksChanged = 0, noMark = 0;
const announced: Record<string, number> = {};
const lastVoiceAt: Record<string, number> = {};
const lines: string[] = [];
const prevMark: Record<string, number> = {};

socket.on('connect', () => {
	const start = () => socket.emit('create_game', { playerName: 'VoiceCheck' }, (res: any) => {
		if (!res?.gameId) { console.error('create_game 실패'); process.exit(1); }
		socket.emit('auto_setup_test', { gameId: res.gameId, selfPlay: true });
	});
	socket.emit('admin_set_mcts_time_ms', { timeMs: MCTS_MS }, () => {
		socket.emit('admin_set_bot_delay_ms', { delayMs: 0 }, () => start());
	});
});

socket.on('game_updated', (game: any) => {
	if (!game?.players || !Array.isArray(game.gameLog)) return;
	for (const [pid, m] of Object.entries(game.turnMark ?? {})) {
		if (prevMark[pid] !== m) { if (prevMark[pid] !== undefined) marksChanged++; prevMark[pid] = m as number; }
	}
	for (const e of game.gameLog.slice(mark)) {
		const parts = actionParts(e.action ?? '', e.details ?? '', e.tileId);
		if (!parts || !e.playerId) continue;
		seen++;
		const isTech = isFollowupInfo(e.action ?? '');
		const isEnabler = parts.length === 1 && ENABLER_LABELS.has(parts[0]);
		const tm = game.turnMark?.[e.playerId];
		if (tm === undefined) noMark++;
		const win = tm ?? -1;
		const same = announced[e.playerId] === win;
		const ts = e.timestamp ?? 0;
		const longGap = tm === undefined && ts - (lastVoiceAt[e.playerId] ?? 0) >= 3000;
		if (same && !longGap && !isTech) { lines.push(`   무음(턴1회)  ${e.action}`); continue; }
		if (!isEnabler) announced[e.playerId] = win;
		lastVoiceAt[e.playerId] = ts;
		const p = game.players[e.playerId] || {};
		const who = isTech && same ? '' : (whoLabel(p.faction, p.name) ?? '');
		said++;
		lines.push(`🔊 ${[who, ...parts].filter(Boolean).join(' ').padEnd(30)} ${e.action}${e.details ? ` [${String(e.details).slice(0, 26)}]` : ''}`);
	}
	mark = game.gameLog.length;
	if (said >= LIMIT || game.currentPhase === 'gameEnd') {
		console.log(lines.slice(0, 60).join('\n'));
		console.log(`\n안내 대상 로그 ${seen}건 · 읽음 ${said} · turnMark 없는 건 ${noMark} · 턴 표시 변경 관측 ${marksChanged}회`);
		socket.close();
		process.exit(noMark === 0 && marksChanged > 0 ? 0 : 1);
	}
});
/** 시간이 다 돼도 그때까지 모인 결과를 낸다 — 예전엔 '시간 초과'만 찍고 끝나 판정을 못 했다.
 *  프로덕션 번들은 봇 속도 조절이 토큰 없이 막혀 있어 한 판이 느리다(정상 동작). */
function report(reason: string): never {
	console.log(lines.slice(0, 60).join('\n'));
	console.log('');
	console.log(`[${reason}] 안내 대상 로그 ${seen}건 · 읽음 ${said} · turnMark 없는 건 ${noMark} · 턴 표시 변경 관측 ${marksChanged}회`);
	const ok = seen > 0 && noMark === 0 && marksChanged > 0;
	console.log(ok ? 'OK: 모든 안내가 서버 턴 표시로 판정됐다' : '실패: turnMark 누락 또는 턴 표시 변경 없음');
	process.exit(ok ? 0 : 1);
}
setTimeout(() => report('시간 상한'), Number(process.env.TIMEOUT_MS ?? 240000));
