/**
 * turnMark가 정말 클라이언트로 가는지 확인 — turnStartState는 대역폭 때문에 non-enumerable로
 * 전송에서 빠지는데, 음성 안내는 이 숫자에 의존하므로 같이 빠지면 조용히 옛 방식으로 되돌아간다.
 * 실행: npx tsx script/testTurnMarkTransport.ts
 */
import { buildClientGameState } from '../shared/gameSync';

const game: any = { id: 'g1', gameLog: [], turnMark: { p1: 12, p2: 30 } };
// 서버가 무거운 필드를 숨기는 것과 같은 처리
for (const k of ['turnStartState', 'prevTurnStartState', 'humanActionJournal', 'fullGameLog']) {
	game[k] = { big: 'x'.repeat(1000) };
	Object.defineProperty(game, k, { value: game[k], writable: true, configurable: true, enumerable: false });
}
const out = buildClientGameState(game, true);
const okMark = JSON.stringify(out.turnMark) === JSON.stringify({ p1: 12, p2: 30 });
const okHidden = out.turnStartState === undefined;
const bytes = Buffer.byteLength(JSON.stringify(out.turnMark ?? null));
console.log(`turnMark 전달 ${okMark ? 'OK' : '실패'} · 무거운 스냅샷 제외 ${okHidden ? 'OK' : '실패'} · turnMark 크기 ${bytes}B`);
process.exit(okMark && okHidden ? 0 : 1);
