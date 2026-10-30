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
		: shouldForceLandscapeMobile()
		? `width=${LANDSCAPE_MOBILE_VIEWPORT_WIDTH}${noZoom}`
		: `width=device-width, initial-scale=1.0${noZoom}`);
}

/**
 * [사용자 2026-10-31] 넓은 가로 폰(가로 폭 768px 이상 — 요즘 아이폰·갤럭시 대부분)은 md: 기준을 넘어 PC 화면이
 * 나왔고 모바일로 돌아갈 방법이 없었다. PC 모드의 반대 방향: 옵션을 켜면 가로일 때만 viewport 폭을 760으로
 * 선언해 모바일(v2 가로) 레이아웃을 쓰게 한다. 세로로 돌리면 원래(device-width)로 돌아간다.
 */
export const LANDSCAPE_MOBILE_KEY = 'landscape-mobile'; // 'on' | 'off'(기본)
/** md(768) 바로 아래 — 모바일 레이아웃이면서 최대한 덜 축소되는 폭 */
export const LANDSCAPE_MOBILE_VIEWPORT_WIDTH = 760;

export function isLandscapeMobileOn(): boolean {
	try { return localStorage.getItem(LANDSCAPE_MOBILE_KEY) === 'on'; } catch { return false; }
}

/** 이 옵션을 보여줄 기기인지 — 일반 폰(터치 + 짧은 변 540 미만)이고, 가로로 돌리면 768 이상이 되는 경우.
 *  screen 값은 viewport meta와 무관하고, iOS는 회전해도 바뀌지 않으므로 긴 변/짧은 변으로 본다. */
export function canOfferLandscapeMobile(): boolean {
	if (typeof window === 'undefined') return false;
	if (isLandscapeMobileOn()) return true; // 켜져 있으면 끌 수 있게 항상 노출
	const touch = (navigator.maxTouchPoints ?? 0) > 0;
	if (!touch) return false;
	const w = window.screen?.width ?? window.innerWidth;
	const h = window.screen?.height ?? window.innerHeight;
	return Math.min(w, h) < 540 && Math.max(w, h) >= 768;
}

/** 지금 viewport 폭을 760으로 줄여야 하는가 — 옵션 ON + 가로 + 기기 긴 변이 768 이상.
 *  가로 판정은 orientation 미디어쿼리: viewport 폭을 바꿔도 화면비는 그대로라 판정이 뒤집히지 않는다. */
function shouldForceLandscapeMobile(): boolean {
	if (!isLandscapeMobileOn()) return false;
	const w = window.screen?.width ?? window.innerWidth;
	const h = window.screen?.height ?? window.innerHeight;
	if (Math.max(w, h) < 768) return false; // 원래도 모바일 화면
	return window.matchMedia?.('(orientation: landscape)').matches ?? false;
}

export function setLandscapeMobile(on: boolean): void {
	try { localStorage.setItem(LANDSCAPE_MOBILE_KEY, on ? 'on' : 'off'); } catch { /* 저장 실패해도 이번 세션엔 적용 */ }
	applyViewportMeta();
	if (typeof window !== 'undefined') requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

/** 앱 시작 시 1회 — 회전할 때마다 viewport meta를 다시 맞춘다(가로 폰 모바일 옵션은 방향에 따라 폭이 바뀜).
 *  resize가 아니라 orientation 미디어쿼리 변화만 듣는다: meta 교체가 resize를 일으켜도 되먹임 루프가 안 생긴다. */
export function installViewportOrientationListener(): void {
	if (typeof window === 'undefined' || !window.matchMedia) return;
	const mql = window.matchMedia('(orientation: landscape)');
	const onChange = () => {
		applyViewportMeta();
		// matchMedia change가 안 오는 브라우저 대비(setPcViewMode와 같은 이유) — 레이아웃 재판정 강제
		requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
	};
	mql.addEventListener?.('change', onChange);
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

/**
 * [사용자 2026-08-26, 폴드8 울트라] 정사각형에 가까운 화면은 세로(하단 분할)/가로(좌우 도킹) 어느 쪽으로도
 * 볼 수 있게 사용자가 고른다. 'auto'(기본)면 기존 규칙(높이>너비 → 세로) 그대로.
 */
export const SQUARE_LAYOUT_KEY = 'square-layout'; // 'auto' | 'split'(하단 분할) | 'dock'(좌우 도킹)
export type SquareLayout = 'auto' | 'split' | 'dock';

export function getSquareLayout(): SquareLayout {
	try {
		const v = localStorage.getItem(SQUARE_LAYOUT_KEY);
		return v === 'split' || v === 'dock' ? v : 'auto';
	} catch { return 'auto'; }
}

export function setSquareLayout(v: SquareLayout): void {
	try { localStorage.setItem(SQUARE_LAYOUT_KEY, v); } catch { /* 저장 실패해도 이번 세션엔 적용 */ }
	if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('square-layout-change', { detail: v }));
}

/** 정사각형에 '가까운' 화면인지 — 짧은 변이 긴 변의 90% 이상. 이때만 레이아웃 선택지가 의미 있다. */
export function isNearSquare(w: number, h: number): boolean {
	if (w <= 0 || h <= 0) return false;
	return Math.min(w, h) / Math.max(w, h) >= 0.9;
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

/**
 * [사용자 2026-10-31] 모바일 모드 v2 — "모바일이 여전히 다 작다". 하단/측면을 좌우로 쪼개 308px 디자인을
 * 0.5배대로 줄이던 v1 대신, 패널 하나를 화면 폭 전체(세로) 또는 45%(가로)로 쓰고 탭(플레이어/기술/우주선/
 * 라운드/로그)으로 전환한다. 플레이어 탭은 큰 글씨 요약 줄 + 고른 사람의 기존 카드. 기본 켜짐, 끄면 v1.
 */
export const MOBILE_V2_KEY = 'mobile-ui-v2'; // 'on'(기본) | 'off'

export function isMobileV2(): boolean {
	try { return localStorage.getItem(MOBILE_V2_KEY) !== 'off'; } catch { return true; }
}

export function setMobileV2(on: boolean): void {
	try { localStorage.setItem(MOBILE_V2_KEY, on ? 'on' : 'off'); } catch { /* 저장 실패해도 이번 세션엔 적용 */ }
	if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('mobile-v2-change', { detail: on }));
}
