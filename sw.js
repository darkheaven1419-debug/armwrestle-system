/* Service Worker: PWA 离线缓存 + 版本化更新 */
/* global self, caches, fetch, Response, APP_VERSION */

importScripts('./version.js');

const CACHE_PREFIX = 'wacaa-pwa-';
const CACHE_NAME = CACHE_PREFIX + APP_VERSION;
const NAV_TIMEOUT_MS = 4000;
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './version.js',
  './vendor/pinyin-pro.js',
  './utils.js',
  './state.js',
  './bracket.js',
  './ui.js',
  './app.js',
  './update.js',
];

/* 用 cache: 'reload' 绕过 HTTP 缓存，保证安装时拿到的是服务器上的最新文件 */
async function precache() {
  const cache = await caches.open(CACHE_NAME);
  const results = await Promise.allSettled(PRECACHE_URLS.map(async (url) => {
    const res = await fetch(url, { cache: 'reload' });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    await cache.put(url, res);
    return url;
  }));
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? PRECACHE_URLS[i] : null))
    .filter(Boolean);
  if (failed.length) {
    console.warn('[SW] 预缓存失败：', failed.join('、'));
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

/* 页面点“立即更新”后跳过等待，由页面在 controllerchange 时刷新 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

/* 页面导航：网络优先，超时或失败回退到缓存，保证断网也能开 */
async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await Promise.race([fetch(request), timeout(NAV_TIMEOUT_MS)]);
    if (res && res.ok) {
      cache.put('./index.html', res.clone()).catch(() => {});
      return res;
    }
    throw new Error(`HTTP ${res ? res.status : 'unknown'}`);
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const shell = await cache.match('./index.html');
    if (shell) return shell;
    return new Response('离线且没有可用缓存', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/* 静态资源：先用缓存，后台静默更新 */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);

  if (cached) return cached;
  const fresh = await network;
  if (fresh) return fresh;
  return new Response('离线且没有可用缓存', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(req));
    return;
  }

  event.respondWith(staleWhileRevalidate(req));
});
