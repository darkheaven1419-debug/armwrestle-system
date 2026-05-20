/* utils.js — 工具函数 */
(() => {
  'use strict';
  const W = window.WACAA || {};

  W.uid = () => Math.random().toString(16).slice(2) + Date.now().toString(16);
  W.now = () => Date.now();
  W.deepClone = (x) => JSON.parse(JSON.stringify(x));
  W.safeJsonParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  W.clampInt = (x, a, b) => {
    const n = Number.parseInt(String(x), 10);
    return Number.isNaN(n) ? a : Math.max(a, Math.min(b, n));
  };

  W.shuffle = function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  W.el = function el(tag, attrs, children) {
    attrs = attrs || {}; children = children || [];
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null) e.setAttribute(k, String(v));
    }
    for (const c of children) {
      if (c === null || c === undefined) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  };

  W.escapeHtml = function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
  };

  W.normalizeNameKey = (name) => (name || '').trim().toLowerCase();

  W.getPinyin = function getPinyin(name) {
    const n = (name ?? '').trim();
    if (!n) return '';
    if (!window.pinyinPro?.pinyin) return '';
    return window.pinyinPro.pinyin(n, { toneType: 'symbol', type: 'array' }).join(' ');
  };

  window.WACAA = W;
})();
