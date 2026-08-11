/**
 * [사용자 2026-08-11] 실제 네트워크 사용량 계측.
 *
 * 기존 EMIT_BYTES 계측은 'JSON 페이로드를 따로 압축해 본 근사치'라 실제 회선 바이트와 다르다.
 * 여기서는 TCP 소켓의 bytesRead/bytesWritten을 그대로 읽는다 — socket.io 프레이밍,
 * permessage-deflate 압축(gameState.ts:3027, threshold 1024), HTTP 정적파일까지 전부 포함된 진짜 송수신량.
 *
 * 비용은 사실상 0이다. 연결마다 close 때 숫자 두 개를 더하고, 조회 시 살아 있는 소켓만 한 번 훑는다.
 * 별도 버퍼·복사가 없어 메모리도 늘지 않는다(과거 OOM 이력을 고려해 일부러 이 방식을 골랐다).
 *
 * 한계: 프로세스 전체 합계다. Render처럼 TLS를 앞단 프록시가 끊으면 여기 숫자는 평문 기준이라
 *   청구되는 값과 완전히 같지는 않다(암호화 오버헤드 제외). 추세·비교용으로는 충분하다.
 */
import type { Server as HttpServer } from 'http';
import type { Socket } from 'net';

let closedIn = 0;
let closedOut = 0;
let totalConns = 0;
const live = new Set<Socket>();

export function attachNetStats(httpServer: HttpServer): void {
	httpServer.on('connection', (sock: Socket) => {
		live.add(sock);
		totalConns++;
		sock.once('close', () => {
			closedIn += sock.bytesRead;
			closedOut += sock.bytesWritten;
			live.delete(sock);
		});
	});
}

export function getNetStats(): { inBytes: number; outBytes: number; liveConns: number; totalConns: number } {
	let inBytes = closedIn;
	let outBytes = closedOut;
	// forEach — 이 tsconfig(target ES5)에선 Set의 for..of가 downlevelIteration 없이 안 된다
	live.forEach((s) => { inBytes += s.bytesRead; outBytes += s.bytesWritten; });
	return { inBytes, outBytes, liveConns: live.size, totalConns };
}

export const mb = (n: number) => (n / 1048576).toFixed(2);
