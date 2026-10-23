/* update.js — Service Worker 注册、版本检测、更新提示与版本显示 */
(function () {
  'use strict';

  var CORE = window.WACAA_UPDATE_CORE;
  var currentVersion = window.APP_VERSION || '';
  var registration = null;
  var userRequestedUpdate = false;
  var reloading = false;
  var dismissedVersion = null;
  var lastCheckAt = 0;
  var checkInFlight = false;

  var MIN_CHECK_GAP_MS = 60 * 1000;
  var CHECK_INTERVAL_MS = 10 * 60 * 1000;
  var ASK_TIMEOUT_MS = 20000;
  var VERSION_TIMEOUT_MS = 5000;
  var ACTIVATE_TIMEOUT_MS = 15000;

  function isNewer(version) {
    if (!version) return true;
    if (!currentVersion) return true;
    if (CORE && typeof CORE.shouldUpdate === 'function') return CORE.shouldUpdate(currentVersion, version);
    return version !== currentVersion;
  }

  function setVersionLabel() {
    var label = document.getElementById('appVersion');
    if (label && currentVersion) label.textContent = ' · 版本 ' + currentVersion;
  }

  /* 与 Service Worker 通信；超时或旧版 SW 不支持时返回 null */
  function ask(worker, message, timeoutMs) {
    return new Promise(function (resolve) {
      if (!worker) { resolve(null); return; }
      var channel = new MessageChannel();
      var done = false;
      var timer = setTimeout(function () { finish(null); }, timeoutMs || ASK_TIMEOUT_MS);

      function finish(payload) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        channel.port1.onmessage = null;
        try { channel.port1.close(); } catch (e) { /* 忽略 */ }
        resolve(payload);
      }

      channel.port1.onmessage = function (event) { finish(event.data || null); };
      try {
        worker.postMessage(message, [channel.port2]);
      } catch (e) {
        finish(null);
      }
    });
  }

  function reloadNow() {
    reloading = true;
    location.reload();
    return Promise.resolve(true);
  }

  function showUpdateBanner(version, apply) {
    if (version && !isNewer(version)) return;
    if (version && version === dismissedVersion) return;
    if (document.getElementById('updateBanner')) return;

    var bar = document.createElement('div');
    bar.id = 'updateBanner';
    bar.className = 'update-banner';
    bar.setAttribute('role', 'status');

    var text = document.createElement('span');
    text.textContent = '有新版本可用' + (version ? '（' + version + '）' : '');

    var updateBtn = document.createElement('button');
    updateBtn.className = 'btn small primary';
    updateBtn.textContent = '立即更新';
    updateBtn.addEventListener('click', function () {
      updateBtn.disabled = true;
      text.textContent = '正在更新，请稍候…';
      Promise.resolve()
        .then(apply)
        .then(function (ok) {
          if (ok) return;
          text.textContent = '更新失败，请刷新页面重试';
          updateBtn.disabled = false;
        })
        .catch(function () {
          text.textContent = '更新失败，请刷新页面重试';
          updateBtn.disabled = false;
        });
    });

    var laterBtn = document.createElement('button');
    laterBtn.className = 'btn small ghost';
    laterBtn.textContent = '稍后';
    laterBtn.addEventListener('click', function () {
      dismissedVersion = version || null;
      bar.remove();
    });

    bar.appendChild(text);
    bar.appendChild(updateBtn);
    bar.appendChild(laterBtn);
    document.body.appendChild(bar);
  }

  /* 已有 waiting worker：直接跳过等待并刷新 */
  function activateWaiting(reg) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = null;

      function finish(ok) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
        if (!ok) userRequestedUpdate = false;
        resolve(ok);
      }

      function onControllerChange() { finish(true); }

      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
      userRequestedUpdate = true;
      try {
        if (!reg.waiting) { finish(false); return; }
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      } catch (e) {
        finish(false);
        return;
      }
      timer = setTimeout(function () { finish(false); }, ACTIVATE_TIMEOUT_MS);
    });
  }

  function findNewerCachedVersion(callback) {
    if (!window.caches || typeof caches.keys !== 'function') { callback(null); return; }
    caches.keys().then(function (keys) {
      var best = null;
      keys.forEach(function (name) {
        if (name.indexOf('wacaa-pwa-') !== 0) return;
        var version = name.slice('wacaa-pwa-'.length);
        if (!version || !isNewer(version)) return;
        if (!best || (CORE && CORE.compareVersions(version, best) > 0)) best = version;
      });
      callback(best);
    }).catch(function () { callback(null); });
  }

  function checkWaiting(reg) {
    if (!reg || !reg.waiting) return;
    ask(reg.waiting, { type: 'GET_VERSION' }, VERSION_TIMEOUT_MS).then(function (reply) {
      var version = reply && reply.type === 'VERSION' ? reply.version : null;
      var apply = function () { return activateWaiting(reg); };
      if (version && isNewer(version)) {
        showUpdateBanner(version, apply);
        return;
      }
      // waiting worker 可能被浏览器回收重启（内存版本丢失），从缓存名兜底识别新版本
      findNewerCachedVersion(function (cachedVersion) {
        if (cachedVersion) showUpdateBanner(cachedVersion, apply);
      });
    });
  }

  /* 新版本已被 SW 下载好：确认切换后刷新 */
  function applyServedUpdate() {
    return ask(navigator.serviceWorker.controller, { type: 'APPLY_UPDATE' }, ASK_TIMEOUT_MS)
      .then(function (reply) {
        if (reply && reply.type === 'APPLIED') return reloadNow();
        return false;
      });
  }

  /* 主动询问当前 SW：是否有新版本，或 SW 已换新但页面仍是旧代码 */
  function checkActive(reg) {
    if (!reg || !navigator.serviceWorker.controller) return;
    if (reg.waiting) { checkWaiting(reg); return; }
    if (checkInFlight) return;

    var nowTs = Date.now();
    if (nowTs - lastCheckAt < MIN_CHECK_GAP_MS) return;

    checkInFlight = true;
    lastCheckAt = nowTs;
    ask(navigator.serviceWorker.controller, { type: 'CHECK_UPDATE' }, ASK_TIMEOUT_MS)
      .then(function (reply) {
        checkInFlight = false;
        if (!reply || !reply.version) return;
        if (reply.type === 'UPDATE_READY') {
          showUpdateBanner(reply.version, applyServedUpdate);
        } else if (reply.type === 'UPDATE_NONE' || reply.type === 'VERSION') {
          // SW 已经是新版本，但本页面仍在跑旧代码（例如被自动激活）
          showUpdateBanner(reply.version, reloadNow);
        }
      }, function () { checkInFlight = false; });
  }

  function onVisible() {
    if (document.visibilityState !== 'visible') return;
    checkActive(registration);
  }

  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!userRequestedUpdate || reloading) return;
      reloading = true;
      location.reload();
    });
  }

  window.addEventListener('load', function () {
    setVersionLabel();
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('./sw.js').then(function (reg) {
      registration = reg;

      if (reg.waiting && reg.active) checkWaiting(reg);

      reg.addEventListener('updatefound', function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function () {
          if (sw.state !== 'installed') return;
          // 等一个微任务，让 waiting 状态稳定后再询问版本
          setTimeout(function () {
            if (reg.waiting && reg.active) checkWaiting(reg);
          }, 150);
        });
      });

      // 页面加载后主动检查一次：即使没有 updatefound 事件也不会错过新版本
      setTimeout(function () { checkActive(reg); }, 800);
    }).catch(function () {});

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    setInterval(function () { checkActive(registration); }, CHECK_INTERVAL_MS);
  });
})();
