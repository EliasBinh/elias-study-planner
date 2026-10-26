// Minimal Service Worker for PWA installation
const CACHE_NAME = 'elias-pwa-v6';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Close all notifications on device permanently
      self.registration.getNotifications().then(notifs => {
        notifs.forEach(n => n.close());
      }).catch(() => {})
    ])
  );
});

self.addEventListener('fetch', (event) => {
  // Pass-through fetch with network first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
