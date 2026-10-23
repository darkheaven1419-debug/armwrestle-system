/* sw.js — PWA 离线缓存 + 主动版本检测与更新 */
/* global self, caches, fetch, Response, console, importScripts */
importScripts('./update-core.js');

const CORE = self.WACAA_UPDATE_CORE;
const CACHE_PREFIX = 'wacaa-pwa-';
const META_CACHE = 'wacaa-meta';
const META_URL = './__wacaa_meta__';
const META_PENDING_URL = './__wacaa_pending__';
const NAV_TIMEOUT_MS = 4000;

/*
 * 首次安装且网络拿不到 version.js 时的兜底版本。
 * 正常安装一律以服务器上的 version.js 为准；只有改动 sw.js 时才需要同步这个值。
 */
const FALLBACK_VERSION = '2026.10.23-3';

const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './version.js',
  './update-core.js',
  './vendor/pinyin-pro.js',
  './utils.js',
  './state.js',
  './bracket.js',
  './ui.js',
  './app.js',
  './update.js',
];

/*
 * currentVersion：本 Worker 当前实际提供的文件版本（决定读写哪个缓存）。
 * pendingVersion：已完整下载、等待页面确认切换的版本。
 * 两个值都不依赖 sw.js 的字节变化，因此只改 version.js 也能推出新版本。
 */
let currentVersion = null;
let readyPromise = null;
let pendingVersion = null;

function cacheNameFor(version) {
  return CACHE_PREFIX + version;
}

async function readMetaVersion() {
  try {
    const cache = await caches.open(META_CACHE);
    const res = await cache.match(META_URL);
    if (!res) return null;
    const data = await res.json();
    return data && typeof data.version === 'string' ? data.version : null;
  } catch (e) {
    return null;
  }
}

async function writeMetaVersion(version) {
  try {
    const cache = await caches.open(META_CACHE);
    await cache.put(META_URL, new Response(JSON.stringify({ version }), {
      headers: { 'Content-Type': 'application/json' },
    }));
  } catch (e) {
    console.warn('[SW] 写入版本元数据失败', e);
  }
}

/*
 * 安装完成后把待激活版本写入磁盘：waiting worker 可能被浏览器回收，
 * 重启后激活时必须仍然知道该切到哪个缓存。
 */
async function writePendingVersion(version) {
  try {
    const cache = await caches.open(META_CACHE);
    await cache.put(META_PENDING_URL, new Response(JSON.stringify({ version }), {
      headers: { 'Content-Type': 'application/json' },
    }));
  } catch (e) {
    console.warn('[SW] 写入待激活版本失败', e);
  }
}

async function readPendingVersion() {
  try {
    const cache = await caches.open(META_CACHE);
    const res = await cache.match(META_PENDING_URL);
    if (!res) return null;
    const data = await res.json();
    return data && typeof data.version === 'string' ? data.version : null;
  } catch (e) {
    return null;
  }
}

async function clearPendingVersion() {
  try {
    const cache = await caches.open(META_CACHE);
    await cache.delete(META_PENDING_URL);
  } catch (e) { /* 忽略 */ }
}

async function cacheHasShell(version) {
  try {
    const name = cacheNameFor(version);
    if (typeof caches.has === 'function' && !(await caches.has(name))) return false;
    const cache = await caches.open(name);
    return !!(await cache.match('./index.html'));
  } catch (e) {
    return false;
  }
}

/* 浏览器重启后 Worker 会重新执行，此时从元数据恢复“当前该用哪个缓存” */
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      if (!currentVersion) {
        currentVersion = (await readMetaVersion()) || FALLBACK_VERSION;
      }
      return currentVersion;
    })();
  }
  return readyPromise;
}

/* 直接从网络读取已发布的版本号，用于判断有没有新版本 */
async function fetchPublishedVersion() {
  try {
    const res = await fetch('./version.js', { cache: 'reload' });
    if (!res || !res.ok) return null;
    return CORE.parseVersionScript(await res.text());
  } catch (e) {
    return null;
  }
}

/* 严格预缓存：任一文件失败就抛错，安装失败则保留旧版本，避免半成品缓存 */
async function precacheInto(version) {
  const cache = await caches.open(cacheNameFor(version));
  await Promise.all(PRECACHE_URLS.map(async (url) => {
    const res = await fetch(url, { cache: 'reload' });
    if (!res || !res.ok) throw new Error(url + ' ' + (res ? res.status : 'no response'));
    await cache.put(url, res.clone());
  }));
}

async function deleteOtherCaches(keepVersion) {
  const keep = cacheNameFor(keepVersion);
  try {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith(CACHE_PREFIX) && k !== keep)
      .map((k) => caches.delete(k)));
  } catch (e) {
    console.warn('[SW] 清理旧缓存失败', e);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await ensureReady();
    // 安装时以服务器上的 version.js 为准（包括首次安装和 sw.js 变更后的重装）
    const published = await fetchPublishedVersion();
    if (published) currentVersion = published;
    await precacheInto(currentVersion);
    await writePendingVersion(currentVersion);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await ensureReady();
    // waiting worker 可能已被浏览器回收并重启，优先采用安装时落盘的待激活版本
    const pending = await readPendingVersion();
    if (pending && await cacheHasShell(pending)) currentVersion = pending;
    await writeMetaVersion(currentVersion);
    await clearPendingVersion();
    await deleteOtherCaches(currentVersion);
    await self.clients.claim();
  })());
});

/* 检查服务器上是否发布了比当前缓存更新的版本 */
async function checkForUpdate() {
  await ensureReady();
  const published = await fetchPublishedVersion();
  if (!published) return { type: 'UPDATE_UNKNOWN', version: currentVersion };
  if (!CORE.shouldUpdate(currentVersion, published)) {
    return { type: 'UPDATE_NONE', version: currentVersion };
  }
  if (pendingVersion !== published) {
    try {
      await precacheInto(published);
    } catch (e) {
      console.warn('[SW] 下载新版本失败，继续使用旧版本', e);
      return { type: 'UPDATE_FAILED', version: published };
    }
    pendingVersion = published;
  }
  return { type: 'UPDATE_READY', version: published };
}

/* 页面确认后把“当前缓存”切到新版本，页面随即刷新 */
async function applyUpdate() {
  await ensureReady();
  if (!pendingVersion) return { type: 'APPLY_FAILED', version: currentVersion };
  const next = pendingVersion;
  pendingVersion = null;
  currentVersion = next;
  await writeMetaVersion(next);
  await deleteOtherCaches(next);
  return { type: 'APPLIED', version: next };
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  const reply = (payload) => { if (port) port.postMessage(payload); };

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  const task = (async () => {
    if (data.type === 'GET_VERSION') {
      await ensureReady();
      return { type: 'VERSION', version: currentVersion };
    }
    if (data.type === 'CHECK_UPDATE') return checkForUpdate();
    if (data.type === 'APPLY_UPDATE') return applyUpdate();
    return null;
  })().then((payload) => { if (payload) reply(payload); });

  if (event.waitUntil) event.waitUntil(task);
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

async function openCurrentCache() {
  await ensureReady();
  return caches.open(cacheNameFor(currentVersion));
}

/* 页面导航：网络优先，超时或失败回退到缓存，保证断网也能开 */
async function networkFirstNavigation(request) {
  const cache = await openCurrentCache();
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
  const cache = await openCurrentCache();
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
