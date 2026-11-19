/* [사용자 2026-11-19] 폰 웹 푸시용 서비스 워커.
 * 게임 화면이 닫혀 있어도 서버가 보낸 푸시를 받아 알림을 띄우고, 알림을 누르면 그 게임으로 연다.
 * 오프라인 캐시는 하지 않는다(게임은 실시간 서버가 필요하고, 캐시는 옛 번들 문제만 만든다). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || '가이아 프로젝트';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || 'gaia-turn',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = new URL(url, self.location.origin).href;
    for (const c of all) {
      if (c.url === target && 'focus' in c) return c.focus();
    }
    for (const c of all) {
      if ('navigate' in c && 'focus' in c) {
        try { await c.navigate(target); } catch { /* 다른 출처 등 */ }
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
