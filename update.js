/* update.js — Service Worker 注册、更新提示与版本显示 */
(function () {
  'use strict';

  var hadController = !!navigator.serviceWorker?.controller;
  var userRequestedUpdate = false;
  var reloading = false;

  function setVersionLabel() {
    var label = document.getElementById('appVersion');
    if (label && window.APP_VERSION) label.textContent = ' · 版本 ' + window.APP_VERSION;
  }

  function showUpdateBanner(reg) {
    if (document.getElementById('updateBanner')) return;

    var bar = document.createElement('div');
    bar.id = 'updateBanner';
    bar.className = 'update-banner';
    bar.setAttribute('role', 'status');

    var text = document.createElement('span');
    text.textContent = '有新版本可用' + (window.APP_VERSION ? '（' + window.APP_VERSION + '）' : '');

    var updateBtn = document.createElement('button');
    updateBtn.className = 'btn small primary';
    updateBtn.textContent = '立即更新';
    updateBtn.addEventListener('click', function () {
      updateBtn.disabled = true;
      text.textContent = '正在更新，请稍候…';
      if (reg.waiting) {
        userRequestedUpdate = true;
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      } else {
        location.reload();
      }
    });

    var laterBtn = document.createElement('button');
    laterBtn.className = 'btn small ghost';
    laterBtn.textContent = '稍后';
    laterBtn.addEventListener('click', function () { bar.remove(); });

    bar.appendChild(text);
    bar.appendChild(updateBtn);
    bar.appendChild(laterBtn);
    document.body.appendChild(bar);
  }

  navigator.serviceWorker?.addEventListener('controllerchange', function () {
    if (!userRequestedUpdate || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener('load', function () {
    setVersionLabel();
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('./sw.js').then(function (reg) {
      if (reg.waiting && hadController) showUpdateBanner(reg);

      reg.addEventListener('updatefound', function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function () {
          if (sw.state === 'installed' && hadController) showUpdateBanner(reg);
        });
      });
    }).catch(function () {});
  });
})();
