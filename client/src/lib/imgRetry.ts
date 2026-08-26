/**
 * [사용자 제보 2026-08-26] 플레이 중 간혹 이미지가 '흰 종이(깨진 이미지)'로 뜨고 새로고침해야 돌아오는 문제.
 * 원인: 배포로 서버가 재시작되는 수십 초(또는 모바일 네트워크 순단)에 이미지 요청이 실패하면,
 * 브라우저 <img>는 스스로 재시도하지 않아 깨진 채 남는다(게임 상태는 소켓이 재접속으로 회복하는 것과 대조).
 *
 * 해결: 문서 전역에서 <img> 로드 실패를 잡아(캡처 단계 — img error는 버블링 안 됨) 지수 백오프로
 * 최대 3회 재시도한다. 캐시버스터 쿼리로 실패 응답 캐시를 우회한다.
 */
export function installImgRetry(): void {
	if (typeof window === 'undefined') return;
	window.addEventListener('error', (e) => {
		const t = e.target;
		if (!(t instanceof HTMLImageElement)) return;
		if (!t.src || t.src.startsWith('data:')) return;
		const n = Number(t.dataset.retryCount ?? 0);
		if (n >= 3) return;
		t.dataset.retryCount = String(n + 1);
		const base = t.src.split('?')[0];
		const delay = 1500 * Math.pow(2, n); // 1.5s → 3s → 6s (배포 재시작 창을 넘길 때까지)
		setTimeout(() => {
			// 그 사이 src가 바뀌었으면(리렌더로 다른 이미지) 건드리지 않는다
			if (t.isConnected && t.src.split('?')[0] === base) t.src = `${base}?r=${Date.now()}`;
		}, delay);
	}, true);
}
