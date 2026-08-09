import { useEffect, useState } from 'react';
import { getSocket } from './gameClient';

/** [배포 반영 2026-08-09, 사용자] "사람들이 Ctrl+F5를 안 해서 옛 클라로 계속 플레이한다"
 *
 *  index.html은 이미 no-cache라 '새로고침만 하면' 최신이 된다(2026-07-27). 남은 문제는
 *  **아예 새로고침을 안 하는 것** — 탭을 몇 시간씩 열어두면 배포가 영원히 반영되지 않는다.
 *
 *  탐지: 빌드마다 vite가 심는 __BUILD_ID__(번들 안) vs 서버가 dist/public/build-id.txt에서 읽은 값.
 *    - 소켓 접속/재접속 때 서버가 'server_build'로 알려준다. 배포 = 서버 재시작 = 전원 재접속이라
 *      추가 폴링 없이도 거의 항상 이 경로로 잡힌다.
 *    - 소켓이 오래 끊겨 있던 경우를 위해 탭이 다시 보일 때 /api/version도 한 번 확인(가벼운 보험).
 *  서버 buildId가 null(dev)이면 항상 비활성.
 */
export function useAppUpdate(): { updateReady: boolean; reload: () => void } {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    const myBuild = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '';
    const check = (serverBuild: unknown) => {
      if (typeof serverBuild !== 'string' || !serverBuild || !myBuild) return;
      if (serverBuild !== myBuild) setUpdateReady(true);
    };

    const socket = getSocket();
    const onBuild = (p: { buildId?: string | null }) => check(p?.buildId);
    socket.on('server_build', onBuild);

    // 탭 복귀 시 보험 확인 — 소켓이 끊겨 있어 'server_build'를 못 받은 경우를 커버
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      fetch('/api/version', { cache: 'no-store' })
        .then(r => r.json())
        .then(d => check(d?.buildId))
        .catch(() => { });
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      socket.off('server_build', onBuild);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // 새 버전을 감지한 뒤 탭이 백그라운드로 가면(= 보고 있지 않으면) 알아서 새로고침.
  // 플레이 중 화면을 강제로 갈아끼우지 않으면서, 다시 돌아왔을 땐 최신인 상태를 만든다.
  useEffect(() => {
    if (!updateReady) return;
    const onHidden = () => {
      if (document.visibilityState === 'hidden') window.location.reload();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [updateReady]);

  return { updateReady, reload: () => window.location.reload() };
}
