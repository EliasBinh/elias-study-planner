// Minimal Service Worker for PWA installation & Background Timer Notifications
const CACHE_NAME = 'elias-pwa-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through fetch with network first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Timer Notification Handlers for Mobile Phone & PC
self.addEventListener('message', (event) => {
  if (event.data?.type === 'UPDATE_TIMER_NOTIFICATION') {
    const { title, timeStr, todayStr } = event.data;
    self.registration.showNotification(title, {
      body: `⏱ Thời gian: ${timeStr} • Tổng hôm nay: ${todayStr}`,
      icon: '/stewie.png',
      badge: '/stewie.ico',
      tag: 'elias-ypt-timer',
      renotify: false,
      silent: true,
      requireInteraction: true
    }).catch(e => console.warn('[SW] Notification error:', e));
  } else if (event.data?.type === 'CLEAR_TIMER_NOTIFICATION') {
    self.registration.getNotifications({ tag: 'elias-ypt-timer' }).then(notifs => {
      notifs.forEach(n => n.close());
    });
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
