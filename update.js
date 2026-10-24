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
  var waitingCheckInFlight = false;

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
    if (reloading) return Promise.resolve(true);
    reloading = true;
    location.reload();
    return Promise.resolve(true);
  }

  function showUpdateBanner(version, apply) {
    if (version && !isNewer(version)) return;
    if (version && version === dismissedVersion) return;

    var existing = document.getElementById('updateBanner');
    if (existing) {
      /*
       * Service Worker 在提示已经显示后完成了激活：把旧按钮的回调换成
       * 直接刷新，避免它继续等待一个已经不存在的 waiting worker。
       */
      existing.__apply = apply;
      var existingText = existing.querySelector('span');
      var existingBtn = existing.querySelector('button.primary');
      if (version && existingText && (!existingBtn || !existingBtn.disabled)) {
        existingText.textContent = '有新版本可用（' + version + '）';
      }
      return;
    }

    var bar = document.createElement('div');
    bar.id = 'updateBanner';
    bar.className = 'update-banner';
    bar.setAttribute('role', 'status');
    bar.__apply = apply;

    var text = document.createElement('span');
    text.textContent = '有新版本可用' + (version ? '（' + version + '）' : '');

    var updateBtn = document.createElement('button');
    updateBtn.className = 'btn small primary';
    updateBtn.textContent = '立即更新';
    updateBtn.addEventListener('click', function () {
      updateBtn.disabled = true;
      text.textContent = '正在更新，请稍候…';
      Promise.resolve()
        .then(function () { return bar.__apply ? bar.__apply() : apply(); })
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

  /* 当前 controller 是否已经运行更新版本；是则直接刷新 */
  function reloadIfControllerNewer() {
    return ask(navigator.serviceWorker.controller, { type: 'GET_VERSION' }, VERSION_TIMEOUT_MS)
      .then(function (info) {
        if (info && info.type === 'VERSION' && info.version && isNewer(info.version)) {
          return reloadNow();
        }
        return false;
      });
  }

  /* 已有 waiting worker：请求它跳过等待，并在控制权交接后刷新 */
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

      /*
       * waiting 可能在用户点击前已被激活（自动 skipWaiting、其他标签页关闭等）。
       * 不能直接报失败：先核对 controller 是否已经是新版本，是则直接刷新。
       */
      if (!reg.waiting) {
        reloadIfControllerNewer().then(finish);
        return;
      }

      try {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      } catch (e) {
        reloadIfControllerNewer().then(finish);
        return;
      }

      timer = setTimeout(function () {
        // controllerchange 可能已经错过：以 controller 实际版本为准
        reloadIfControllerNewer().then(finish);
      }, ACTIVATE_TIMEOUT_MS);
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

  function applyWaitingUpdate(reg) {
    var target = reg.waiting || navigator.serviceWorker.controller;
    return ask(target, { type: 'APPLY_UPDATE' }, ASK_TIMEOUT_MS).then(function (reply) {
      if (reply && reply.type === 'APPLIED') {
        if (reply.version && !isNewer(reply.version)) return false;
        return activateWaiting(reg);
      }
      // 旧版 Worker 不支持 APPLY_UPDATE，或 waiting 已被替换
      return reloadIfControllerNewer();
    });
  }

  function checkWaiting(reg) {
    if (!reg || !reg.waiting || waitingCheckInFlight) return;
    waitingCheckInFlight = true;
    var worker = reg.waiting;
    var applyWaiting = function () { return applyWaitingUpdate(reg); };
    var applyReload = function () { return activateWaiting(reg); };

    // 先让 waiting worker 重新向服务器确认版本：它可能是在更早的版本上安装的
    ask(worker, { type: 'CHECK_UPDATE' }, ASK_TIMEOUT_MS).then(function (reply) {
      waitingCheckInFlight = false;
      if (reply && reply.type === 'UPDATE_READY') {
        showUpdateBanner(reply.version, applyWaiting);
        return;
      }
      if (reply && (reply.type === 'UPDATE_NONE' || reply.type === 'VERSION')
        && reply.version && isNewer(reply.version)) {
        showUpdateBanner(reply.version, applyReload);
        return;
      }
      // 旧版 waiting worker 不支持 CHECK_UPDATE 或无法确认：退回读取版本号
      ask(worker, { type: 'GET_VERSION' }, VERSION_TIMEOUT_MS).then(function (info) {
        var version = info && info.type === 'VERSION' ? info.version : null;
        if (version && isNewer(version)) {
          showUpdateBanner(version, applyReload);
          return;
        }
        // waiting worker 可能已被回收重启（内存版本丢失），从缓存名兜底识别
        findNewerCachedVersion(function (cachedVersion) {
          if (cachedVersion) showUpdateBanner(cachedVersion, applyReload);
        });
      });
    });
  }

  /* 新版本已被 SW 下载好：确认切换后刷新 */
  function applyServedUpdate() {
    return ask(navigator.serviceWorker.controller, { type: 'APPLY_UPDATE' }, ASK_TIMEOUT_MS)
      .then(function (reply) {
        if (reply && reply.type === 'APPLIED') {
          if (!reply.version || isNewer(reply.version)) return reloadNow();
          // Worker 已经是页面版本，没有可应用的更新
          return false;
        }
        // 旧版 Worker 未实现 APPLY_UPDATE，或新 Worker 已在点击前激活
        return reloadIfControllerNewer();
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

    // 新 SW 激活后主动通知页面：旧页面（例如迁移前的缓存代码）也能提示刷新
    navigator.serviceWorker.addEventListener('message', function (event) {
      var data = event.data || {};
      if (data.type !== 'SW_ACTIVATED' || !data.version) return;
      if (isNewer(data.version)) showUpdateBanner(data.version, reloadNow);
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
