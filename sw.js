// Minimal Service Worker for PWA installation
const CACHE_NAME = 'elias-pwa-v1';

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
