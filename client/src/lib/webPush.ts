// [사용자 2026-11-19] "폰으로 딴거 하고 있을 때 내 폰 위에 알람" — 웹 푸시(PWA) 클라이언트.
//
// 기존 turnNotify.ts는 열린 탭이 직접 알림을 띄워서, 폰에서 다른 앱을 쓰거나 화면이 꺼지면 오지 않았다.
// 여기서는 서비스 워커(/sw.js)로 푸시 구독을 만들어 서버에 등록하고, 서버(server/push.ts)가 차례가 오면 보낸다.
// 아이폰은 iOS 16.4+ 에서 '홈 화면에 추가'로 설치한 앱으로 열었을 때만 푸시가 된다.

import { getSocket } from '@/lib/gameClient';
import { getNotifyBody, getNotifyTitle } from '@/lib/turnNotify';

const PUSH_KEY = 'gaia_push_on';

export function pushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
    && window.isSecureContext;
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function getPushPref(): boolean {
  try { return localStorage.getItem(PUSH_KEY) === '1'; } catch { return false; }
}
function setPushPref(on: boolean) {
  try { localStorage.setItem(PUSH_KEY, on ? '1' : '0'); } catch { /* */ }
}

/** 푸시가 켜져 있고 권한도 있으면 true — 이때는 탭 알림(turnNotify)을 생략해 같은 알림이 두 번 뜨지 않게 한다 */
export function isPushActive(): boolean {
  return pushSupported() && getPushPref() && Notification.permission === 'granted';
}

let swReg: Promise<ServiceWorkerRegistration | null> | null = null;
/** 앱 시작 시 1회 — 서비스 워커가 있어야 '홈 화면에 설치'가 가능하고 푸시도 받는다 */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (swReg) return swReg;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) {
    swReg = Promise.resolve(null);
    return swReg;
  }
  swReg = navigator.serviceWorker.register('/sw.js').catch(() => null);
  return swReg;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function emitAck<T>(event: string, payload: unknown, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('서버 응답이 없습니다.')), timeoutMs);
    getSocket().emit(event, payload, (r: T) => { clearTimeout(t); resolve(r); });
  });
}

async function getOrCreateSubscription(): Promise<PushSubscription> {
  const reg = await registerServiceWorker();
  if (!reg) throw new Error('서비스 워커를 등록하지 못했습니다.');
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const { key } = await emitAck<{ key: string | null }>('push_public_key', {});
  if (!key) throw new Error('서버에서 폰 알림이 꺼져 있습니다.');
  const appKey = urlBase64ToUint8Array(key);
  if (existing) {
    // 서버 키가 바뀌었으면(키 재생성) 옛 구독은 쓸 수 없다 → 새로 만든다
    const cur = existing.options?.applicationServerKey;
    const same = cur && new Uint8Array(cur).toString() === appKey.toString();
    if (same) return existing;
    await existing.unsubscribe().catch(() => {});
  }
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
}

/** 이 게임·이 좌석으로 서버에 구독 등록(이미 있으면 갱신 — 알림 문구 변경도 이걸로 반영) */
export async function syncPushForGame(gameId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const sub = await getOrCreateSubscription();
    return await emitAck<{ ok: boolean; error?: string }>('push_subscribe', {
      gameId,
      subscription: sub.toJSON(),
      title: getNotifyTitle(),
      body: getNotifyBody(),
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 권한 요청 → 구독 → 등록. 토글 클릭(사용자 제스처) 안에서 호출해야 한다. */
export async function enablePush(gameId: string): Promise<{ ok: boolean; error?: string }> {
  if (!pushSupported()) return { ok: false, error: '이 브라우저는 폰 알림(웹 푸시)을 지원하지 않습니다.' };
  let p = Notification.permission;
  if (p === 'default') p = await Notification.requestPermission();
  if (p !== 'granted') return { ok: false, error: p === 'denied' ? '알림이 차단되어 있습니다 — 브라우저/폰 설정에서 이 사이트 알림을 허용해 주세요.' : '알림 권한이 허용되지 않았습니다.' };
  const r = await syncPushForGame(gameId);
  if (r.ok) setPushPref(true);
  return r;
}

export async function disablePush(): Promise<void> {
  setPushPref(false);
  try {
    const reg = await registerServiceWorker();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      getSocket().emit('push_unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe().catch(() => {});
    }
  } catch { /* */ }
}

export async function sendTestPush(gameId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const reg = await registerServiceWorker();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return { ok: false, error: '이 기기의 구독이 없습니다. 알림을 껐다 켜 주세요.' };
    return await emitAck<{ ok: boolean; error?: string }>('push_test', { gameId, endpoint: sub.endpoint });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 게임 화면에서 호출 — 푸시가 켜져 있으면
 *  ① 좌석 재접속(서버 재시작·새 소켓) 후에도 구독이 이어지게 다시 등록하고
 *  ② '지금 화면을 보고 있는지'(보이고 + 포커스)를 서버에 알려, 보고 있을 땐 폰 알림이 안 오게 한다.
 * 반환값은 정리 함수.
 */
export function installPushPresence(gameId: string): () => void {
  if (!isPushActive()) return () => {};
  const socket = getSocket();
  const report = () => {
    const active = document.visibilityState === 'visible' && document.hasFocus();
    socket.emit('push_presence', { gameId, active });
  };
  const onConnect = () => {
    // 좌석 재합류(rejoin_game)가 끝난 뒤에야 서버가 이 소켓의 플레이어를 안다 → 약간 늦게 보낸다
    setTimeout(() => { void syncPushForGame(gameId); report(); }, 1500);
  };
  onConnect();
  socket.on('connect', onConnect);
  document.addEventListener('visibilitychange', report);
  window.addEventListener('focus', report);
  window.addEventListener('blur', report);
  window.addEventListener('pagehide', report);
  const iv = setInterval(report, 30_000);
  return () => {
    socket.off('connect', onConnect);
    document.removeEventListener('visibilitychange', report);
    window.removeEventListener('focus', report);
    window.removeEventListener('blur', report);
    window.removeEventListener('pagehide', report);
    clearInterval(iv);
  };
}
