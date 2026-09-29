/**
 * [사용자 제보 2026-08-26] 플레이 중 간혹 이미지가 '흰 종이(깨진 이미지)'로 뜨고 새로고침해야 돌아오는 문제.
 * 원인: 배포로 서버가 재시작되는 수십 초(또는 모바일 네트워크 순단)에 이미지 요청이 실패하면,
 * 브라우저는 스스로 재시도하지 않아 깨진 채 남는다(게임 상태는 소켓이 재접속으로 회복하는 것과 대조).
 *
 * [사용자 제보 2026-09-23] "접속할 때 일부 구역이 로딩 안 되는 게 아직 재발한다."
 *   맵 구역 배경·건물·지형 패턴은 HTML <img>가 아니라 **SVG <image>**로 그린다(GameBoard/HexMap 24곳).
 *   가드가 HTMLImageElement만 보고 있어 정작 첫 접속에 수십 장이 몰리는 맵 이미지가 대상 밖이었다.
 *   → SVGImageElement도 함께 처리한다(속성이 src가 아니라 href).
 *
 * [사용자 제보 2026-09-27] "지금도 외곽맵 하나 로딩 안 되어서 계속 깨진 이미지로 보이고 있네."
 *   남은 구멍은 '포기'였다. 1.5s→3s→6s 세 번을 쓰고 나면 그 이미지는 그 세션 내내 영영 깨진 채였다.
 *   서버 재시작이 10초보다 길거나 그 순간 네트워크가 더 오래 끊기면 그대로 끝이다.
 *   → ①백오프를 늘리고 ②포기하지 않는다: 아직 깨진 이미지가 하나라도 있으면 20초마다 계속 다시 시도한다.
 *     ③탭으로 돌아왔을 때·네트워크가 돌아왔을 때는 기다리지 않고 즉시 한 번 더 시도한다.
 *   비용은 '깨진 그 몇 장'뿐이다 — 성공하면 목록에서 빠지므로 정상일 땐 타이머 자체가 돌지 않는다.
 */
type RetryableImage = HTMLImageElement | SVGImageElement;

/** 백오프(ms). 이 뒤로는 마지막 값으로 계속 반복한다 — 서버가 돌아오면 그때 살아난다. */
const BACKOFF = [1500, 3000, 6000, 12000, 20000];
const SWEEP_MS = 20000;

/** 아직 깨진 채로 화면에 붙어 있는 이미지들. 로드에 성공하면 즉시 빠진다. */
const broken = new Map<RetryableImage, { tries: number; base: string; timer: number | null }>();
let sweepTimer: number | null = null;

/** HTML은 src, SVG는 href(구버전 xlink:href) — 현재 주소를 읽는다. */
function readSrc(el: RetryableImage): string {
	if (el instanceof HTMLImageElement) return el.src;
	return el.href?.baseVal ?? el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '';
}

function writeSrc(el: RetryableImage, value: string): void {
	if (el instanceof HTMLImageElement) el.src = value;
	else el.setAttribute('href', value);
}

/** 캐시버스터를 새로 달아 다시 받아온다. 실패한 응답이 캐시에 남아 있어도 우회한다. */
function poke(el: RetryableImage): void {
	const rec = broken.get(el);
	if (!rec) return;
	rec.timer = null;
	// 그 사이 사라졌거나(리렌더) 다른 그림으로 바뀌었으면 더 볼 일 없다
	if (!el.isConnected || readSrc(el).split('?')[0] !== rec.base) { broken.delete(el); stopSweepIfIdle(); return; }
	rec.tries += 1;
	writeSrc(el, `${rec.base}?r=${Date.now()}`);
}

function schedule(el: RetryableImage): void {
	const rec = broken.get(el);
	if (!rec || rec.timer !== null) return;
	const delay = BACKOFF[Math.min(rec.tries, BACKOFF.length - 1)];
	rec.timer = window.setTimeout(() => poke(el), delay);
}

/** 기다리지 않고 지금 전부 다시 시도한다(탭 복귀·네트워크 복귀·주기 스윕). */
function retryAllNow(): void {
	// 순회 중 poke 가 목록에서 빼기도 하므로 스냅샷을 뜬다
	for (const [el, rec] of Array.from(broken.entries())) {
		if (rec.timer !== null) { clearTimeout(rec.timer); rec.timer = null; }
		poke(el);
	}
	stopSweepIfIdle();
}

function startSweep(): void {
	if (sweepTimer !== null) return;
	sweepTimer = window.setInterval(retryAllNow, SWEEP_MS);
}

function stopSweepIfIdle(): void {
	if (broken.size === 0 && sweepTimer !== null) { clearInterval(sweepTimer); sweepTimer = null; }
}

export function installImgRetry(): void {
	if (typeof window === 'undefined') return;

	// 이미지의 error/load는 버블링하지 않는다 → 캡처 단계에서 잡는다
	window.addEventListener('error', (e) => {
		const t = e.target;
		if (!(t instanceof HTMLImageElement) && !(t instanceof SVGImageElement)) return;
		const el = t as RetryableImage;
		const src = readSrc(el);
		if (!src || src.startsWith('data:')) return;
		const base = src.split('?')[0];
		const rec = broken.get(el);
		if (rec) { rec.base = base; } else { broken.set(el, { tries: 0, base, timer: null }); }
		schedule(el);
		startSweep();
	}, true);

	window.addEventListener('load', (e) => {
		const t = e.target;
		if (!(t instanceof HTMLImageElement) && !(t instanceof SVGImageElement)) return;
		const rec = broken.get(t as RetryableImage);
		if (!rec) return;
		if (rec.timer !== null) clearTimeout(rec.timer);
		broken.delete(t as RetryableImage);
		stopSweepIfIdle();
	}, true);

	document.addEventListener('visibilitychange', () => { if (!document.hidden) retryAllNow(); });
	window.addEventListener('online', retryAllNow);
}

/** 테스트·디버그용 — 지금 깨진 채인 이미지 주소들 */
export function brokenImageSrcs(): string[] {
	return Array.from(broken.values()).map(r => r.base);
}
