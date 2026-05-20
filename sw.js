/* Service Worker: PWA offline cache */
/* global self */

const CACHE_NAME = 'wacaa-pwa-v3-' + Date.now();
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './vendor/pinyin-pro.js',
  './utils.js',
  './state.js',
  './bracket.js',
  './ui.js',
  './app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_URLS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // 清除所有旧版本缓存
      await Promise.all(keys
        .filter((k) => k.startsWith('wacaa-pwa-') && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        const url = new URL(req.url);
        if (url.origin === self.location.origin) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch {
        const fallback = await caches.match('./index.html');
        return fallback || new Response('offline', { status: 503 });
      }
    })()
  );
});
