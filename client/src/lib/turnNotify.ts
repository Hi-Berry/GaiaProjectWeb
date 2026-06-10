// 내 차례가 되면 브라우저 데스크톱 알림을 띄우는 헬퍼 (크롬/엣지 Notification API).
// 탭을 백그라운드에 두고 다른 작업을 할 때 "당신 차례입니다"를 알려준다.

const PREF_KEY = 'gaia_notify_on_turn';

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getNotifyPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === '1';
  } catch {
    return false;
  }
}

export function setNotifyPref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? '1' : '0');
  } catch {
    /* 저장 실패 무시 */
  }
}

export function getNotifyPermission(): NotificationPermission | 'unsupported' {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission;
}

/** 사용자 제스처(토글 클릭) 안에서 호출. 권한 요청 결과를 반환. */
export async function requestNotifyPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
      return Notification.permission;
    }
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * 내 차례 알림. 설정이 켜져 있고, 권한이 허용되고, 탭이 백그라운드(보고 있지 않을 때)일 때만 띄운다.
 * 보고 있을 땐 알림이 불필요하므로 생략.
 */
export function fireTurnNotification(title: string, body: string): void {
  if (!getNotifyPref()) return;
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  // 탭을 활성 상태로 보고 있으면 알림 불필요
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
  try {
    const n = new Notification(title, {
      body,
      tag: 'gaia-turn',
      renotify: true,
      icon: '/favicon.ico',
    } as NotificationOptions);
    n.onclick = () => {
      try {
        window.focus();
        n.close();
      } catch {
        /* */
      }
    };
  } catch {
    /* 알림 생성 실패 무시 */
  }
}
