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
	const content = isPcViewMode()
		? `width=${PC_MODE_VIEWPORT_WIDTH}${noZoom}`
		: shouldForceLandscapeMobile()
		? landscapeMobileViewportContent(pinch)
		: `width=device-width, initial-scale=1.0${noZoom}`;
	// 같은 값이면 건드리지 않는다 — resize마다 다시 부르므로 불필요한 재배치/되먹임 방지
	if (meta.getAttribute('content') !== content) meta.setAttribute('content', content);
}

/** 지금 실제로 보이는 창 폭(배율 1 기준 CSS px). viewport meta·핀치 배율과 무관한 값이어야 한다.
 *  visualViewport.width × scale = 화면에 보이는 폭(배율을 곱해 되돌림). 없으면 기기 화면 긴 변. */
function visibleWindowWidth(): number {
	const vv = window.visualViewport;
	if (vv && vv.width > 0 && vv.scale > 0) return Math.round(vv.width * vv.scale);
	return Math.max(window.screen?.width ?? 0, window.screen?.height ?? 0) || window.innerWidth;
}

/**
 * [버그 2026-10-31 사용자 S22 울트라 "모바일 화면으로 해도 PC 화면으로 나온다"] width=760에 maximum-scale=1을 같이 주면,
 * 760폭을 915px 화면에 채우려면 1.2배 확대가 필요한데 최대 배율 1에 막혀 브라우저가 폭을 915로 되돌린다(PC 모드는
 * 축소 방향이라 문제없었음). → 배율(긴 변/760)을 직접 계산해 initial-scale로 주고, 핀치줌 OFF면 maximum-scale도 같은 값으로 막는다.
 */
/* [버그 2026-10-31 사용자 "가로에서 전체화면 하면 PC 화면이 된다"] 배율을 기기 화면 긴 변으로 계산했더니, 전체화면에서
 * 주소창·내비게이션 바가 사라져 보이는 폭이 그보다 넓어지면 브라우저가 폭을 760÷배율 이상(768 초과)으로 잡아 PC 레이아웃이
 * 됐다. → 지금 보이는 창 폭으로 계산하고, 전체화면 전환·resize 때마다 다시 맞춘다(installViewportOrientationListener). */
function landscapeMobileViewportContent(pinch: boolean): string {
	// 0.01 단위로 내림 — 1px 오차로 값이 흔들려 meta가 계속 바뀌는 것을 막고, 내림이라 폭은 760~767(md 미만)에 머문다
	const scale = Math.floor((visibleWindowWidth() / LANDSCAPE_MOBILE_VIEWPORT_WIDTH) * 100) / 100;
	// [사용자 2026-10-31 "자동회전으로 가로 되는 순간 오른쪽이 잘린다"] initial-scale을 직접 주면 회전 직후 아직 옛 폭으로 계산된
	// 값이 크게 들어가 760 화면이 창보다 넓게 확대돼 오른쪽이 잘렸다. → initial-scale은 빼서 브라우저가 760 폭을 창에 맞춰
	// 넣게 하고(잘림 없음), 계산값은 '이 이상 확대 금지' 상한으로만 쓴다. 상한이 작게 잡혀도 resize 때 다시 맞춘다.
	return `width=${LANDSCAPE_MOBILE_VIEWPORT_WIDTH}${pinch ? '' : `, maximum-scale=${scale}`}`;
}

/**
 * [사용자 2026-10-31] 넓은 가로 폰(가로 폭 768px 이상 — 요즘 아이폰·갤럭시 대부분)은 md: 기준을 넘어 PC 화면이
 * 나왔고 모바일로 돌아갈 방법이 없었다. PC 모드의 반대 방향: 옵션을 켜면 가로일 때만 viewport 폭을 760으로
 * 선언해 모바일(v2 가로) 레이아웃을 쓰게 한다. 세로로 돌리면 원래(device-width)로 돌아간다.
 */
export const LANDSCAPE_MOBILE_KEY = 'landscape-mobile'; // 'on'(기본) | 'off'  — [사용자 2026-10-31] 기본을 모바일 화면으로
/** md(768) 바로 아래 — 모바일 레이아웃이면서 최대한 덜 축소되는 폭 */
export const LANDSCAPE_MOBILE_VIEWPORT_WIDTH = 760;

export function isLandscapeMobileOn(): boolean {
	try { return localStorage.getItem(LANDSCAPE_MOBILE_KEY) !== 'off'; } catch { return true; }
}

/** 가로로 돌리면 768을 넘는 일반 폰인지 — 터치 + 짧은 변 540 미만(폴드 펼침·태블릿 제외) + 긴 변 768 이상.
 *  screen 값은 viewport meta와 무관하고, iOS는 회전해도 바뀌지 않으므로 긴 변/짧은 변으로 본다.
 *  기본값이 ON이라 이 판정이 데스크톱·태블릿을 확실히 걸러야 한다. */
function isWideLandscapePhone(): boolean {
	if (typeof window === 'undefined') return false;
	if ((navigator.maxTouchPoints ?? 0) <= 0) return false;
	const w = window.screen?.width ?? window.innerWidth;
	const h = window.screen?.height ?? window.innerHeight;
	return Math.min(w, h) < 540 && Math.max(w, h) >= 768;
}

/** 이 옵션을 보여줄 기기인지 — 가로로 돌리면 768을 넘는 일반 폰만 */
export function canOfferLandscapeMobile(): boolean {
	return isWideLandscapePhone();
}

/** 지금 viewport 폭을 760으로 줄여야 하는가 — 옵션 ON + 가로 + 기기 긴 변이 768 이상.
 *  가로 판정은 orientation 미디어쿼리: viewport 폭을 바꿔도 화면비는 그대로라 판정이 뒤집히지 않는다. */
function shouldForceLandscapeMobile(): boolean {
	if (!isLandscapeMobileOn() || !isWideLandscapePhone()) return false;
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
		// 회전 애니메이션 도중엔 창 폭이 아직 옛 값일 수 있다 — 회전이 끝난 뒤 한 번 더 맞춘다
		setTimeout(refit, 300);
		setTimeout(refit, 800);
	};
	mql.addEventListener?.('change', onChange);
	// 전체화면 진입/해제·주소창 접힘처럼 방향은 그대로인데 보이는 폭이 바뀌는 경우 — 가로 모바일일 때만 배율을 다시 맞춘다.
	// 보이는 폭(visibleWindowWidth)은 meta를 바꿔도 그대로라 같은 문자열이 나와 되먹임이 생기지 않는다.
	const refit = () => {
		if (!shouldForceLandscapeMobile()) return;
		const meta = document.querySelector('meta[name="viewport"]');
		const before = meta?.getAttribute('content');
		applyViewportMeta();
		if (meta?.getAttribute('content') !== before) requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
	};
	window.addEventListener('resize', refit);
	document.addEventListener('fullscreenchange', refit);
	document.addEventListener('webkitfullscreenchange', refit);
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
