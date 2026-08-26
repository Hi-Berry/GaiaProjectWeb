/**
 * [사용자 2026-08-11] 폴드/태블릿처럼 '모바일로 잡히지만 화면은 넉넉한' 기기에서 PC 레이아웃을 쓰기 위한 설정.
 *
 * 레이아웃 분기는 Tailwind `md:`(=min-width:768px) 미디어쿼리라 JS 상태로는 못 바꾼다. 그래서 viewport meta의
 * width를 1280으로 바꿔 브라우저가 보고하는 CSS 폭 자체를 넓힌다(브라우저의 '데스크톱 사이트로 보기'와 같은 방식)
 * → md: 이상 클래스가 전부 켜지고 상태창 아래 로그 도크가 그대로 나온다.
 *
 * viewport meta는 화면 줌(page-pinch-zoom) 설정도 함께 쓰므로, 두 설정을 여기서 한 번에 조합해 쓴다.
 * 각자 meta를 덮어쓰면 나중에 바꾼 쪽이 상대 설정을 지운다.
 */

export const VIEW_MODE_KEY = 'view-mode';       // 'pc' | 'auto'(기본)
export const PINCH_ZOOM_KEY = 'page-pinch-zoom'; // 'on' | 'off'(기본)

/** PC 모드 강제 여부 */
export function isPcViewMode(): boolean {
	try { return localStorage.getItem(VIEW_MODE_KEY) === 'pc'; } catch { return false; }
}

/** PC 모드로 볼 때 가정하는 CSS 폭 — md(768)를 충분히 넘기면서 PC 레이아웃이 좁아 보이지 않는 값 */
export const PC_MODE_VIEWPORT_WIDTH = 1280;

/** 두 설정(PC 모드 · 화면 줌)을 합쳐 viewport meta에 반영. 설정 변경 직후와 앱 시작 시 호출. */
export function applyViewportMeta(): void {
	if (typeof document === 'undefined') return;
	const meta = document.querySelector('meta[name="viewport"]');
	if (!meta) return;
	let pinch = false;
	try { pinch = localStorage.getItem(PINCH_ZOOM_KEY) === 'on'; } catch { /* 접근 불가 시 기본값 */ }
	// 줌 OFF면 maximum-scale=1로 브라우저 핀치줌을 막는다(맵 자체 줌을 쓰기 위함 — 기존 동작).
	const noZoom = pinch ? '' : ', maximum-scale=1';
	meta.setAttribute('content', isPcViewMode()
		? `width=${PC_MODE_VIEWPORT_WIDTH}${noZoom}`
		: `width=device-width, initial-scale=1.0${noZoom}`);
}

/**
 * PC 모드 선택지를 보여줄 기기인지 — '터치 기기인데 화면이 넉넉한' 경우(폴드 펼침·태블릿).
 * 판정에 innerWidth를 쓰면 안 된다: PC 모드를 켜는 순간 1280이 되어 조건이 뒤집히고,
 * 되돌릴 방법이 화면에서 사라진다. viewport meta와 무관한 기기 화면 크기(screen)를 쓴다.
 */
export function canOfferPcViewMode(): boolean {
	if (typeof window === 'undefined') return false;
	if (isPcViewMode()) return true; // 이미 켜져 있으면 되돌릴 수 있게 항상 노출
	const touch = (navigator.maxTouchPoints ?? 0) > 0;
	if (!touch) return false;        // 데스크톱은 이미 PC 레이아웃이라 선택지 불필요
	const w = window.screen?.width ?? window.innerWidth;
	const h = window.screen?.height ?? window.innerHeight;
	// 짧은 변 기준 — 폴드 펼침/태블릿은 넘고 일반 폰은 못 넘는 선
	return Math.min(w, h) >= 540;
}

/** PC 모드 켜기/끄기 (viewport 반영까지) */
export function setPcViewMode(on: boolean): void {
	try { localStorage.setItem(VIEW_MODE_KEY, on ? 'pc' : 'auto'); } catch { /* 저장 실패해도 이번 세션엔 적용 */ }
	applyViewportMeta();
	// [사용자 2026-08-26, 폴드] viewport meta 교체 후 CSS 폭이 바뀌었는데 matchMedia change가 안 오는
	// 브라우저가 있어 useIsMobile 등이 옛 판정을 유지했다(모바일 전환 후 PC 미니뷰 잔존) → 강제 재판정.
	if (typeof window !== 'undefined') {
		requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
	}
}
