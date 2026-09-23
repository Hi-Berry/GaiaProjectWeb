/**
 * [사용자 제보 2026-08-26] 플레이 중 간혹 이미지가 '흰 종이(깨진 이미지)'로 뜨고 새로고침해야 돌아오는 문제.
 * 원인: 배포로 서버가 재시작되는 수십 초(또는 모바일 네트워크 순단)에 이미지 요청이 실패하면,
 * 브라우저는 스스로 재시도하지 않아 깨진 채 남는다(게임 상태는 소켓이 재접속으로 회복하는 것과 대조).
 *
 * 해결: 문서 전역에서 이미지 로드 실패를 잡아(캡처 단계 — 이미지 error는 버블링 안 됨) 지수 백오프로
 * 최대 3회 재시도한다. 캐시버스터 쿼리로 실패 응답 캐시를 우회한다.
 *
 * [사용자 제보 2026-09-23 후속] "접속할 때 일부 구역이 로딩 안 되는 게 아직 재발한다."
 *   원인: 맵 구역 배경·건물·지형 패턴은 HTML <img>가 아니라 **SVG <image>**로 그린다(GameBoard/HexMap 24곳).
 *   기존 가드 `t instanceof HTMLImageElement`가 이것들을 통째로 걸러내, 정작 첫 접속에 수십 장이 한꺼번에
 *   요청되는 맵 이미지만 재시도 대상 밖이었다. SVGImageElement도 함께 처리한다(속성이 src가 아니라 href).
 */
type RetryableImage = HTMLImageElement | SVGImageElement;

/** HTML은 src, SVG는 href(구버전 xlink:href) — 현재 주소를 읽는다. */
function readSrc(el: RetryableImage): string {
	if (el instanceof HTMLImageElement) return el.src;
	return el.href?.baseVal ?? el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '';
}

function writeSrc(el: RetryableImage, value: string): void {
	if (el instanceof HTMLImageElement) el.src = value;
	else el.setAttribute('href', value);
}

export function installImgRetry(): void {
	if (typeof window === 'undefined') return;
	window.addEventListener('error', (e) => {
		const t = e.target;
		if (!(t instanceof HTMLImageElement) && !(t instanceof SVGImageElement)) return;
		const el = t as RetryableImage;
		const src = readSrc(el);
		if (!src || src.startsWith('data:')) return;
		const n = Number(el.dataset.retryCount ?? 0);
		if (n >= 3) return;
		el.dataset.retryCount = String(n + 1);
		const base = src.split('?')[0];
		const delay = 1500 * Math.pow(2, n); // 1.5s → 3s → 6s (배포 재시작 창을 넘길 때까지)
		setTimeout(() => {
			// 그 사이 주소가 바뀌었으면(리렌더로 다른 이미지) 건드리지 않는다
			if (el.isConnected && readSrc(el).split('?')[0] === base) writeSrc(el, `${base}?r=${Date.now()}`);
		}, delay);
	}, true);
}
