// Service Worker for PWA installation & scheduled task reminder notifications
const CACHE_NAME = 'elias-pwa-v7';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (event.action === 'start-task' && event.notification.data?.taskId) {
            client.postMessage({ type: 'START_TASK_FROM_NOTIF', taskId: event.notification.data.taskId });
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('fetch', (event) => {
  // Pass-through fetch with network first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
