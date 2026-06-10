// 내 차례가 되면 브라우저 데스크톱 알림을 띄우는 헬퍼 (크롬/엣지 Notification API).
// 탭을 백그라운드에 두고 다른 작업을 할 때 "당신 차례입니다"를 알려준다.

const PREF_KEY = 'gaia_notify_on_turn';
const TITLE_KEY = 'gaia_notify_title';
const BODY_KEY = 'gaia_notify_body';

const DEFAULT_TITLE = '가이아 프로젝트 — 당신 차례';
const DEFAULT_BODY = '행동할 차례입니다.';

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** 커스텀 알림 제목 (비어 있으면 기본 게임 문구 사용). 스텔스용으로 무난한 문구 지정 가능. */
export function getNotifyTitle(): string {
  try {
    return localStorage.getItem(TITLE_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setNotifyTitle(s: string): void {
  try {
    localStorage.setItem(TITLE_KEY, s);
  } catch {
    /* */
  }
}
export function getNotifyBody(): string {
  try {
    return localStorage.getItem(BODY_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setNotifyBody(s: string): void {
  try {
    localStorage.setItem(BODY_KEY, s);
  } catch {
    /* */
  }
}

/** 실제로 띄울 제목/내용 계산: 커스텀 제목이 있으면 커스텀(제목+내용)으로 완전히 대체, 없으면 fallback. */
function resolveMessage(fallbackTitle: string, fallbackBody: string): { title: string; body: string } {
  const ct = getNotifyTitle().trim();
  if (ct) return { title: ct, body: getNotifyBody() };
  return { title: fallbackTitle || DEFAULT_TITLE, body: fallbackBody ?? DEFAULT_BODY };
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
  const msg = resolveMessage(title, body);
  showNotification(msg.title, msg.body, 'gaia-turn');
}

/** 설정 화면의 "테스트" 버튼용 — pref/가시성 무시하고 현재 문구로 즉시 한 번 띄운다. */
export function fireTestNotification(): boolean {
  if (!notificationsSupported() || Notification.permission !== 'granted') return false;
  const msg = resolveMessage(DEFAULT_TITLE, DEFAULT_BODY);
  return showNotification(msg.title, msg.body, 'gaia-turn-test');
}

function showNotification(title: string, body: string, tag: string): boolean {
  try {
    const n = new Notification(title, {
      body,
      tag,
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
    return true;
  } catch {
    return false;
  }
}
