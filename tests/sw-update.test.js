'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const CORE_SRC = fs.readFileSync(path.join(ROOT, 'update-core.js'), 'utf8');

class FakeResponse {
  constructor(body, init) {
    this.body = body == null ? '' : String(body);
    this.status = init && init.status ? init.status : 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = (init && init.headers) || {};
  }

  clone() {
    return new FakeResponse(this.body, { status: this.status, headers: this.headers });
  }

  text() { return Promise.resolve(this.body); }
  json() { return Promise.resolve(JSON.parse(this.body)); }
}

function createCacheStorage(stores) {
  const keyOf = (req) => (typeof req === 'string' ? req : String(req && req.url ? req.url : req));
  return {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async put(req, res) { store.set(keyOf(req), res); },
        async match(req) { return store.get(keyOf(req)); },
        async delete(req) { return store.delete(keyOf(req)); },
      };
    },
    async keys() { return Array.from(stores.keys()); },
    async has(name) { return stores.has(name); },
    async delete(name) { return stores.delete(name); },
  };
}

function createServer(version) {
  const server = {
    version,
    offline: false,
    missing: new Set(),
    async fetch(url) {
      if (server.offline) throw new Error('offline');
      const key = String(url);
      if (server.missing.has(key)) return new FakeResponse('missing', { status: 404 });
      if (key === './version.js') return new FakeResponse(`var APP_VERSION = '${server.version}';`);
      return new FakeResponse('asset:' + key);
    },
  };
  return server;
}

function createWorker(stores, server) {
  const listeners = new Map();
  const sandbox = {};
  const context = vm.createContext(sandbox);

  sandbox.self = sandbox;
  sandbox.caches = createCacheStorage(stores);
  sandbox.fetch = (url) => server.fetch(url);
  sandbox.Response = FakeResponse;
  sandbox.console = { warn() {}, log() {} };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.skipWaiting = () => { sandbox.__skipWaiting = true; };
  sandbox.clients = {
    claim: () => { sandbox.__claimed = true; return Promise.resolve(); },
    matchAll: () => Promise.resolve(sandbox.__windows || []),
  };
  sandbox.location = { origin: 'http://localhost:8000', href: 'http://localhost:8000/sw.js' };
  sandbox.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  sandbox.importScripts = () => { vm.runInContext(CORE_SRC, context); };

  vm.runInContext(SW_SRC, context, { filename: 'sw.js' });

  async function fire(type) {
    const waits = [];
    const event = { waitUntil(p) { waits.push(p); } };
    (listeners.get(type) || []).forEach((fn) => fn(event));
    await Promise.all(waits);
  }

  function send(data) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('message timeout')), 3000);
      const port = { postMessage(payload) { clearTimeout(timer); resolve(payload); } };
      const waits = [];
      const event = { data, ports: [port], waitUntil(p) { waits.push(p); } };
      (listeners.get('message') || []).forEach((fn) => fn(event));
      Promise.all(waits).catch(() => {});
    });
  }

  return {
    install: () => fire('install'),
    activate: () => fire('activate'),
    send,
    sandbox,
  };
}

test('安装后按服务器上的 version.js 建缓存，并报告版本', async () => {
  const stores = new Map();
  const server = createServer('2026.10.23-3');
  const sw = createWorker(stores, server);

  await sw.install();
  assert.equal(stores.has('wacaa-pwa-2026.10.23-3'), true);

  const reply = await sw.send({ type: 'GET_VERSION' });
  assert.equal(reply.type, 'VERSION');
  assert.equal(reply.version, '2026.10.23-3');
});

test('只改 version.js（sw.js 不变）也能发现并下载新版本', async () => {
  const stores = new Map();
  const server = createServer('2026.10.23-3');
  const sw = createWorker(stores, server);
  await sw.install();

  // 模拟发布方只修改了 version.js，sw.js 没有变化
  server.version = '2026.10.23-4';
  const ready = await sw.send({ type: 'CHECK_UPDATE' });

  assert.equal(ready.type, 'UPDATE_READY');
  assert.equal(ready.version, '2026.10.23-4');
  assert.equal(stores.has('wacaa-pwa-2026.10.23-4'), true);

  // 新缓存必须完整，才允许切换
  const newCache = stores.get('wacaa-pwa-2026.10.23-4');
  for (const url of ['./', './index.html', './ui.js', './version.js', './update-core.js']) {
    assert.equal(newCache.has(url), true, `${url} 应已缓存`);
  }
  assert.equal(newCache.get('./version.js').body.includes('2026.10.23-4'), true);
});

test('确认更新后切换缓存、清理旧缓存并持久化版本', async () => {
  const stores = new Map();
  const server = createServer('2026.10.23-3');
  const sw = createWorker(stores, server);
  await sw.install();
  await sw.activate();
  assert.equal(stores.has('wacaa-meta'), true);

  server.version = '2026.10.23-4';
  await sw.send({ type: 'CHECK_UPDATE' });
  const applied = await sw.send({ type: 'APPLY_UPDATE' });

  assert.equal(applied.type, 'APPLIED');
  assert.equal(applied.version, '2026.10.23-4');
  assert.equal(stores.has('wacaa-pwa-2026.10.23-3'), false);
  assert.equal(stores.has('wacaa-pwa-2026.10.23-4'), true);

  const meta = await stores.get('wacaa-meta').get('./__wacaa_meta__').json();
  assert.equal(meta.version, '2026.10.23-4');
});

test('浏览器重启后（新 Worker 实例）仍从元数据恢复当前版本', async () => {
  const stores = new Map();
  const server = createServer('2026.10.23-3');
  const first = createWorker(stores, server);
  await first.install();
  await first.activate();

  server.version = '2026.10.23-4';
  await first.send({ type: 'CHECK_UPDATE' });
  await first.send({ type: 'APPLY_UPDATE' });

  // 新实例的兜底版本仍是 -3，但应从 wacaa-meta 读到 -4
  const second = createWorker(stores, createServer('2026.10.23-1'));
  const reply = await second.send({ type: 'GET_VERSION' });
  assert.equal(reply.version, '2026.10.23-4');
});

test('新版本下载失败时不切换，旧缓存保持可用', async () => {
  const stores = new Map();
  const server = createServer('2026.10.23-3');
  const sw = createWorker(stores, server);
  await sw.install();
  await sw.activate();

  server.version = '2026.10.23-5';
  server.missing.add('./ui.js');
  const failed = await sw.send({ type: 'CHECK_UPDATE' });

  assert.equal(failed.type, 'UPDATE_FAILED');
  const current = await sw.send({ type: 'GET_VERSION' });
  assert.equal(current.version, '2026.10.23-3');
  assert.equal(stores.has('wacaa-pwa-2026.10.23-3'), true);

  const apply = await sw.send({ type: 'APPLY_UPDATE' });
  assert.equal(apply.type, 'APPLY_FAILED');
  assert.equal(stores.has('wacaa-pwa-2026.10.23-3'), true);
});

test('服务器版本比本地旧时不提示更新', async () => {
  const stores = new Map();
  const server = createServer('2026.10.23-4');
  const sw = createWorker(stores, server);
  await sw.install();
  await sw.activate();

  server.version = '2026.10.23-2';
  const reply = await sw.send({ type: 'CHECK_UPDATE' });
  assert.equal(reply.type, 'UPDATE_NONE');
  assert.equal(reply.version, '2026.10.23-4');
});

test('waiting worker 被浏览器回收后激活，仍切到已下载的新版本', async () => {
  const stores = new Map();
  const server = createServer('2026.10.23-3');
  const active = createWorker(stores, server);
  await active.install();
  await active.activate();

  // 发布 -4，新 Worker 安装并进入 waiting（此时写入待激活版本）
  server.version = '2026.10.23-4';
  const waiting = createWorker(stores, server);
  await waiting.install();

  // 模拟浏览器回收 waiting worker 后重启：新实例内存里只有旧版本
  const restarted = createWorker(stores, server);
  await restarted.activate();

  const version = await restarted.send({ type: 'GET_VERSION' });
  assert.equal(version.version, '2026.10.23-4');
  assert.equal(stores.has('wacaa-pwa-2026.10.23-4'), true);
  assert.equal(stores.has('wacaa-pwa-2026.10.23-3'), false);

  const meta = await stores.get('wacaa-meta').get('./__wacaa_meta__').json();
  assert.equal(meta.version, '2026.10.23-4');
  assert.equal(stores.get('wacaa-meta').has('./__wacaa_pending__'), false);
});

test('安装完整后跳过等待，避免一直停在 waiting', async () => {
  const stores = new Map();
  const server = createServer('2026.10.23-3');
  const sw = createWorker(stores, server);
  await sw.install();
  assert.equal(sw.sandbox.__skipWaiting, true);
});

test('waiting worker 安装后服务器又发布新版，可重新检查并切换', async () => {
  const stores = new Map();
  const server = createServer('2026.10.23-3');
  const active = createWorker(stores, server);
  await active.install();
  await active.activate();

  // 新 Worker 在服务器仍是 -3 时安装并进入 waiting
  const waiting = createWorker(stores, server);
  await waiting.install();

  // 之后只改 version.js 为 -4：waiting worker 必须能重新下载
  server.version = '2026.10.23-4';
  const ready = await waiting.send({ type: 'CHECK_UPDATE' });
  assert.equal(ready.type, 'UPDATE_READY');
  assert.equal(ready.version, '2026.10.23-4');
  assert.equal(stores.has('wacaa-pwa-2026.10.23-4'), true);

  const applied = await waiting.send({ type: 'APPLY_UPDATE' });
  assert.equal(applied.type, 'APPLIED');
  const pending = await stores.get('wacaa-meta').get('./__wacaa_pending__').json();
  assert.equal(pending.version, '2026.10.23-4');

  // 跳过等待后激活，应保持 -4 并清理旧缓存
  await waiting.activate();
  const version = await waiting.send({ type: 'GET_VERSION' });
  assert.equal(version.version, '2026.10.23-4');
  assert.equal(stores.has('wacaa-pwa-2026.10.23-4'), true);
  assert.equal(stores.has('wacaa-pwa-2026.10.23-3'), false);
});

test('新版本下载失败时清理不完整缓存，不破坏旧版本', async () => {
  const stores = new Map();
  const server = createServer('2026.10.23-3');
  const sw = createWorker(stores, server);
  await sw.install();
  await sw.activate();

  server.version = '2026.10.23-5';
  server.missing.add('./ui.js');
  await assert.rejects(sw.install());
  assert.equal(stores.has('wacaa-pwa-2026.10.23-5'), false);
  assert.equal(stores.has('wacaa-pwa-2026.10.23-3'), true);
});

test('激活后通知已打开页面（迁移时可提示刷新）', async () => {
  const stores = new Map();
  const server = createServer('2026.10.23-3');
  const sw = createWorker(stores, server);
  const posted = [];
  sw.sandbox.__windows = [{ postMessage(message) { posted.push(message); } }];
  await sw.install();
  await sw.activate();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'SW_ACTIVATED');
  assert.equal(posted[0].version, '2026.10.23-3');
});

test('Worker 重启后仍能应用已下载好的更新', async () => {
  const stores = new Map();
  const server = createServer('2026.10.23-3');
  const sw = createWorker(stores, server);
  await sw.install();
  await sw.activate();

  server.version = '2026.10.23-4';
  await sw.send({ type: 'CHECK_UPDATE' });

  // 浏览器回收 Worker：新实例内存中没有 pendingVersion
  const restarted = createWorker(stores, server);
  const applied = await restarted.send({ type: 'APPLY_UPDATE' });
  assert.equal(applied.type, 'APPLIED');
  assert.equal(applied.version, '2026.10.23-4');
  assert.equal(stores.has('wacaa-pwa-2026.10.23-4'), true);
  assert.equal(stores.has('wacaa-pwa-2026.10.23-3'), false);
});

test('离线时检查更新不会崩溃，也不影响当前版本', async () => {
  const stores = new Map();
  const server = createServer('2026.10.23-3');
  const sw = createWorker(stores, server);
  await sw.install();
  await sw.activate();

  server.offline = true;
  const reply = await sw.send({ type: 'CHECK_UPDATE' });
  assert.equal(reply.type, 'UPDATE_UNKNOWN');
  assert.equal(reply.version, '2026.10.23-3');

  const version = await sw.send({ type: 'GET_VERSION' });
  assert.equal(version.version, '2026.10.23-3');
});
