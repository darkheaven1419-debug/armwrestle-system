/* Service Worker: PWA offline cache */
/* global self */

const CACHE_NAME = 'wacaa-pwa-v1';
const PRECACHE_URLS = [
  './',
  './index.html',
 './index.html'，
  './manifest.webmanifest',
  './icons/icon.svg',
  // 本地内置拼音库（离线可用）
  './vendor/pinyin-pro.js',
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
      await Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const res = await fetch(req);
        // 尝试缓存静态资源与外链（外链通常为 opaque，也可以缓存）
        const url = new URL(req.url);
        const shouldCache = url.origin === self.location.origin;
        if (shouldCache) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch {
        // 离线兜底：尽量回退到首页（单页应用）
        const fallback = await caches.match('./index.html');
        return fallback || new Response('offline', { status: 503 });
      }
    })()
  );
});

