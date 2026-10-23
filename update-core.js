/* update-core.js — 版本号解析与比较（页面、Service Worker 与 Node 测试共用） */
(function (global) {
  'use strict';

  var VERSION_RE = /APP_VERSION\s*=\s*['"]([0-9A-Za-z._-]+)['"]/;

  /* 从 version.js 的源码文本里取出 APP_VERSION，不执行脚本 */
  function parseVersionScript(text) {
    var m = VERSION_RE.exec(String(text || ''));
    return m ? m[1] : null;
  }

  /* 规范格式：YYYY.MM.DD-N；按日期再按修订号做数值比较 */
  function splitVersion(value) {
    var m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-(\d+)$/.exec(String(value || ''));
    if (!m) return null;
    return {
      date: Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]),
      rev: Number(m[4]),
    };
  }

  function compareVersions(a, b) {
    var pa = splitVersion(a);
    var pb = splitVersion(b);
    if (pa && pb) {
      if (pa.date !== pb.date) return pa.date < pb.date ? -1 : 1;
      if (pa.rev !== pb.rev) return pa.rev < pb.rev ? -1 : 1;
      return 0;
    }
    // 规范格式优先于不规范格式，避免“无法解析”被当成更新
    if (pa && !pb) return 1;
    if (!pa && pb) return -1;
    var sa = String(a || '');
    var sb = String(b || '');
    if (sa === sb) return 0;
    return sa < sb ? -1 : 1;
  }

  function shouldUpdate(current, remote) {
    if (!remote) return false;
    if (!current) return true;
    return compareVersions(remote, current) > 0;
  }

  var api = {
    parseVersionScript: parseVersionScript,
    compareVersions: compareVersions,
    shouldUpdate: shouldUpdate,
  };

  global.WACAA_UPDATE_CORE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
