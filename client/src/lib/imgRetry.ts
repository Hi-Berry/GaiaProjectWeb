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
 *
 * [사용자 제보 2026-10-04] "게임 시작하면 외곽 맵 구역이나 건물 이미지가 깨진 채 시간 지나도 복구 안 되고,
 *   새로고침해도 또 깨져 있다."
 *   남은 구멍은 '멈춘 요청'이었다. 응답이 오다 말고 멈추면 브라우저는 error도 load도 보내지 않는다 →
 *   위 재시도는 시작조차 안 된다(로컬 재현: 응답 없는 서버에 건 이미지가 25초 동안 아무 이벤트 없음).
 *   → 멈춤 감시: 화면에 붙은 이미지가 일정 시간 안에 끝나지 않으면 캐시버스터로 다시 받는다.
 *     느린 회선에서 큰 이미지를 끊어 버리지 않도록 기다리는 시간은 10초→20초→40초→60초로 늘린다.
 *   loading="lazy" 이미지는 화면 밖이면 원래 안 받으므로 제외한다.
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

/** 멈춤 감시: 이 시간 안에 load/error 둘 다 없으면 멈춘 것으로 보고 다시 받는다(재시작 횟수별, 마지막 값 반복). */
const STALL_MS = [10000, 20000, 40000, 60000];
const SCAN_MS = 2000;

/** SVG <image>는 complete 속성이 없어서, load/error 가 온 주소를 직접 적어 둔다. */
const settledSrc = new WeakMap<RetryableImage, string>();
/** 요소별로 '이 주소를 언제부터 기다렸나' */
const watching = new WeakMap<RetryableImage, { base: string; src: string; since: number; stalls: number }>();
let stallRestarts = 0;
let lastScanAt = 0;
let pendingCount = 0;
const settleWaiters: Array<{ selector?: string; fire: () => void }> = [];

/** 이 요소가 지금 주소로 받기를 끝냈는지(성공이든 실패든 — 실패는 위 재시도가 맡는다) */
function isSettled(el: RetryableImage, src: string): boolean {
	if (el instanceof HTMLImageElement) return el.complete;
	return settledSrc.get(el) === src;
}

function scanForStalls(): void {
	const now = Date.now();
	// 숨은 탭은 타이머가 늦게 돌아 '멈춤'으로 오판한다 → 받는 중인 수만 세고 다시 받기는 하지 않는다.
	// 탭이 잠들어 있었거나 타이머가 크게 밀렸다면, 기다린 시간을 지금부터 다시 센다.
	const hidden = document.hidden;
	const resumed = hidden || (lastScanAt > 0 && now - lastScanAt > SCAN_MS * 3);
	lastScanAt = now;
	let pending = 0;
	document.querySelectorAll('img, image').forEach((node) => {
		if (!(node instanceof HTMLImageElement) && !(node instanceof SVGImageElement)) return;
		const el = node as RetryableImage;
		if (el instanceof HTMLImageElement && el.loading === 'lazy') return;
		const src = readSrc(el);
		if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
		const base = src.split('?')[0];
		let w = watching.get(el);
		if (!w || w.base !== base) { w = { base, src, since: now, stalls: 0 }; watching.set(el, w); }
		else if (w.src !== src) { w.src = src; w.since = now; } // 재시도로 주소가 바뀌면 새로 센다
		if (isSettled(el, src)) return;
		pending += 1;
		if (broken.has(el)) return; // 실패한 것은 위 재시도가 맡고 있다
		if (resumed) { w.since = now; return; }
		const limit = STALL_MS[Math.min(w.stalls, STALL_MS.length - 1)];
		if (now - w.since < limit) return;
		w.stalls += 1;
		stallRestarts += 1;
		const next = `${base}?r=${now}`;
		w.src = next; w.since = now;
		writeSrc(el, next);
	});
	pendingCount = pending;
	if (pending > 0) return;
	// 기다릴 대상(예: 맵 구역 이미지)이 아직 화면에 안 붙었으면 '다 받았다'고 보지 않는다
	for (let i = settleWaiters.length - 1; i >= 0; i--) {
		const w = settleWaiters[i];
		if (w.selector && !document.querySelector(w.selector)) continue;
		settleWaiters.splice(i, 1);
		w.fire();
	}
}

/** 이미지 하나가 끝날 때마다 곧바로 한 번 훑는다 — 2초 주기(숨은 탭에선 브라우저가 1분까지 늦춘다)를 기다리지 않고
 *  '마지막 한 장이 끝난 순간'을 잡아 미리 받기를 바로 시작하게 한다. 연달아 끝나면 한 번으로 묶는다. */
let quickScanTimer: number | null = null;
function queueQuickScan(): void {
	if (settleWaiters.length === 0 || quickScanTimer !== null) return;
	quickScanTimer = window.setTimeout(() => { quickScanTimer = null; scanForStalls(); }, 100);
}

/**
 * 지금 화면에 붙은 이미지가 모두 받기를 끝낼 때까지(또는 timeoutMs) 기다린다.
 * 당장 안 보이는 이미지를 미리 받는 일은 이 뒤로 미뤄, 화면에 보일 맵·건물 이미지가 먼저 오게 한다.
 * selector 를 주면 그 요소가 화면에 생긴 뒤에만 끝난 것으로 본다(렌더가 늦게 붙는 맵을 기다리려고).
 */
export function whenVisibleImagesSettled(timeoutMs: number, selector?: string): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		const finish = () => { if (!done) { done = true; resolve(); } };
		settleWaiters.push({ selector, fire: finish });
		window.setTimeout(finish, timeoutMs);
		// 첫 스캔은 바로 한 번 — 이미 다 받아 둔 상태면 기다리지 않는다
		window.setTimeout(scanForStalls, 0);
	});
}

export function installImgRetry(): void {
	if (typeof window === 'undefined') return;

	// 이미지의 error/load는 버블링하지 않는다 → 캡처 단계에서 잡는다.
	// [버그수정 2026-10-04] 수신기는 window 가 아니라 document 에 단다. DOM 규칙상 요소의 load 이벤트는
	//   Document 에서 멈추고 Window 까지 가지 않는다(실측: window 캡처 0회, document 캡처 2회).
	//   예전엔 window 에 달려 있어 load 를 한 번도 못 받았다 → 재시도로 살아난 이미지가 깨진 목록에서
	//   빠지지 않아 20초마다 계속 새로 받고 있었다.
	document.addEventListener('error', (e) => {
		const t = e.target;
		if (!(t instanceof HTMLImageElement) && !(t instanceof SVGImageElement)) return;
		const el = t as RetryableImage;
		const src = readSrc(el);
		settledSrc.set(el, src);
		queueQuickScan();
		if (!src || src.startsWith('data:')) return;
		const base = src.split('?')[0];
		const rec = broken.get(el);
		if (rec) { rec.base = base; } else { broken.set(el, { tries: 0, base, timer: null }); }
		schedule(el);
		startSweep();
	}, true);

	document.addEventListener('load', (e) => {
		const t = e.target;
		if (!(t instanceof HTMLImageElement) && !(t instanceof SVGImageElement)) return;
		settledSrc.set(t as RetryableImage, readSrc(t as RetryableImage));
		queueQuickScan();
		const rec = broken.get(t as RetryableImage);
		if (!rec) return;
		if (rec.timer !== null) clearTimeout(rec.timer);
		broken.delete(t as RetryableImage);
		stopSweepIfIdle();
	}, true);

	document.addEventListener('visibilitychange', () => { if (!document.hidden) retryAllNow(); });
	window.addEventListener('online', retryAllNow);

	// 멈춤 감시 — 요소 수백 개를 2초마다 훑는 정도라 비용은 1ms 안팎
	window.setInterval(scanForStalls, SCAN_MS);

	// 진단용: 사용자 화면에서 개발자 도구로 __gaiaImg.pending() 등을 바로 볼 수 있게
	(window as unknown as { __gaiaImg?: unknown }).__gaiaImg = {
		pending: pendingImageSrcs, broken: brokenImageSrcs, stats: stallStats,
	};
}

/** 테스트·디버그용 — 멈춤으로 보고 다시 받은 횟수, 마지막 스캔 때 아직 받는 중이던 이미지 수 */
export function stallStats(): { restarts: number; pending: number } {
	return { restarts: stallRestarts, pending: pendingCount };
}

/** 테스트·디버그용 — 지금 화면에 붙어 있고 아직 받기가 안 끝난 이미지 주소들 */
export function pendingImageSrcs(): string[] {
	const out: string[] = [];
	document.querySelectorAll('img, image').forEach((node) => {
		if (!(node instanceof HTMLImageElement) && !(node instanceof SVGImageElement)) return;
		const el = node as RetryableImage;
		if (el instanceof HTMLImageElement && el.loading === 'lazy') return;
		const src = readSrc(el);
		if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
		if (!isSettled(el, src)) out.push(src);
	});
	return out;
}

/** 테스트·디버그용 — 지금 깨진 채인 이미지 주소들 */
export function brokenImageSrcs(): string[] {
	return Array.from(broken.values()).map(r => r.base);
}
