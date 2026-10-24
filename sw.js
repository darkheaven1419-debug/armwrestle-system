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
const FALLBACK_VERSION = '2026.10.23-10';

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

async function cacheIsComplete(version) {
  try {
    const name = cacheNameFor(version);
    if (typeof caches.has === 'function' && !(await caches.has(name))) return false;
    const cache = await caches.open(name);
    const found = await Promise.all(PRECACHE_URLS.map((url) => cache.match(url)));
    return found.every(Boolean);
  } catch (e) {
    return false;
  }
}

/* Worker 被浏览器回收后，从磁盘上找已完整下载、比当前更新的缓存 */
async function findDownloadedVersion() {
  try {
    const keys = await caches.keys();
    let best = null;
    for (const name of keys) {
      if (name.indexOf(CACHE_PREFIX) !== 0) continue;
      const version = name.slice(CACHE_PREFIX.length);
      if (!version || !CORE.shouldUpdate(currentVersion, version)) continue;
      if (best && CORE.compareVersions(version, best) <= 0) continue;
      if (await cacheIsComplete(version)) best = version;
    }
    return best;
  } catch (e) {
    return null;
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

/* 严格预缓存：任一文件失败就抛错并删除半成品缓存，旧版本保持可用 */
async function precacheInto(version) {
  const name = cacheNameFor(version);
  const cache = await caches.open(name);
  try {
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      const res = await fetch(url, { cache: 'reload' });
      if (!res || !res.ok) throw new Error(url + ' ' + (res ? res.status : 'no response'));
      await cache.put(url, res.clone());
    }));
  } catch (e) {
    await caches.delete(name);
    throw e;
  }
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
    const previous = await readMetaVersion();
    // 安装时以服务器上的 version.js 为准（包括首次安装和 sw.js 变更后的重装）
    const published = await fetchPublishedVersion();
    if (published) currentVersion = published;
    await precacheInto(currentVersion);
    await writePendingVersion(currentVersion);
    /*
     * 有页面正在使用时，版本升级必须让新 Worker 留在 waiting：
     * 页面上的「立即更新」会发送 SKIP_WAITING 再激活。若这里直接 skipWaiting，
     * 新 Worker 可能在用户点击前自动接管，旧页面手里的 waiting 引用失效，
     * 点击更新反而报“更新失败”。
     * 没有页面打开，或只是同版本更换 SW 字节时，仍然立即激活。
     *
     * 安装中的 Worker 还没有控制任何页面，matchAll 必须带 includeUncontrolled，
     * 否则只会返回空数组，条件跳过等待永远不会生效（已用真实浏览器验证）。
     */
    const windows = self.clients && typeof self.clients.matchAll === 'function'
      ? await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      : [];
    const versionBump = previous && currentVersion && CORE.shouldUpdate(previous, currentVersion);
    if (!windows.length || !versionBump) self.skipWaiting();
  })());
});

/*
 * 旧页面兼容：新 Worker 激活后，仍停留在旧代码的页面手里拿着的 waiting 引用已经
 * 失效。此时旧代码的「立即更新」连消息都发不出去（ask(null) 直接判定失败），
 * 消息层无法挽救，只能在激活后立刻把这些页面导航到新版本。
 *
 * 窗口必须极短：从激活到导航只做一次 matchAll，不留任何等待。否则用户在这段时间
 * 内点击旧按钮，会先看到「更新失败」再被刷新，属于误报。
 *
 * 不能 await navigate()：它要等到新页面提交才 resolve，而提交需要本次激活结束后
 * 由本 Worker 处理导航请求的 fetch 事件。放在 activate 的 waitUntil 里 await 会
 * 互相等待，页面永久卡在加载中（已用真实浏览器复现）。
 *
 * 触发本次激活的页面不需要导航：它已经收到 controllerchange 并自行刷新。
 */
let activationRequesterId = null;

function navigateStaleClients() {
  Promise.resolve()
    .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
    .then((windows) => {
      for (const client of windows) {
        if (activationRequesterId && client.id === activationRequesterId) continue;
        try {
          const nav = client.navigate(client.url);
          if (nav && typeof nav.catch === 'function') nav.catch(() => {});
        } catch (e) { /* 页面可能已关闭 */ }
      }
    })
    .catch(() => {});
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await ensureReady();
    // 激活前的版本：用来判断这次是不是真正的版本升级
    const previous = await readMetaVersion();
    // waiting worker 可能已被浏览器回收并重启，优先采用安装时落盘的待激活版本
    const pending = await readPendingVersion();
    if (pending && await cacheIsComplete(pending)) currentVersion = pending;
    await writeMetaVersion(currentVersion);
    await clearPendingVersion();
    await deleteOtherCaches(currentVersion);
    await self.clients.claim();

    // 通知已打开的页面：SW 已切换，旧页面代码可以提示刷新
    try {
      const windows = await self.clients.matchAll({ type: 'window' });
      windows.forEach((client) => {
        client.postMessage({ type: 'SW_ACTIVATED', version: currentVersion });
      });
    } catch (e) { /* 忽略 */ }

    // 版本升级激活后，把仍停留在旧代码的页面导航到新版本（不阻塞激活）
    if (previous && currentVersion && CORE.shouldUpdate(previous, currentVersion)) {
      navigateStaleClients();
    }
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
    if (!(await cacheIsComplete(published))) {
      try {
        await precacheInto(published);
      } catch (e) {
        console.warn('[SW] 下载新版本失败，继续使用旧版本', e);
        return { type: 'UPDATE_FAILED', version: published };
      }
    }
    pendingVersion = published;
  }
  return { type: 'UPDATE_READY', version: published };
}

/* 页面确认后把“当前缓存”切到新版本，页面随即刷新 */
async function applyUpdate() {
  await ensureReady();
  const next = pendingVersion || await findDownloadedVersion();
  if (!next) {
    /*
     * 没有比当前 Worker 更新的缓存，说明这个 Worker 自己已经是目标版本。
     * 典型场景：新 Worker 已自动激活，旧页面仍拿着更新前的按钮回调。
     * 只要当前缓存完整，就明确报告 APPLIED，让页面刷新到已激活的新版本；
     * 旧版页面的 APPLY_UPDATE 处理也能因此正常完成升级。
     */
    if (currentVersion && await cacheIsComplete(currentVersion)) {
      await writeMetaVersion(currentVersion);
      await deleteOtherCaches(currentVersion);
      return { type: 'APPLIED', version: currentVersion };
    }
    return { type: 'APPLY_FAILED', version: currentVersion };
  }
  pendingVersion = null;
  currentVersion = next;
  await writeMetaVersion(next);
  // 等待中的 Worker 之后被激活时，激活逻辑要靠这条记录切到新缓存
  await writePendingVersion(next);
  await deleteOtherCaches(next);
  return { type: 'APPLIED', version: next };
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  const reply = (payload) => { if (port) port.postMessage(payload); };

  if (data.type === 'SKIP_WAITING') {
    // 记住是谁触发的激活：这个页面会自己刷新，不需要再被导航一次
    const source = event.source;
    if (source && source.id) activationRequesterId = source.id;
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

/* 页面导航：网络优先，失败回退到当前版本缓存；不把网络 HTML 写回当前缓存 */
async function networkFirstNavigation(request) {
  try {
    const res = await Promise.race([fetch(request), timeout(NAV_TIMEOUT_MS)]);
    if (res && res.ok) return res;
    throw new Error(`HTTP ${res ? res.status : 'unknown'}`);
  } catch {
    const cache = await openCurrentCache();
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

/*
 * 静态资源：只读当前版本缓存。
 * 不能把网络响应写回当前缓存：服务器发布新版后，旧缓存会被悄悄混入新版本的
 * version.js，页面于是显示新版本号、却在运行旧代码，更新提示永远不触发。
 * 新版本统一由 precacheInto 下载到独立缓存，激活后再切换。
 */
async function cacheFirstStatic(request) {
  const cache = await openCurrentCache();
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    return new Response('离线且没有可用缓存', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
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

  event.respondWith(cacheFirstStatic(req));
});
