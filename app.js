/* app.js — 入口：初始化、修复旧数据、自动备份、渲染 */

'use strict';
const W = window.WACAA || {};

/* ---- 初始化 ---- */
(function init() {
  const s = W.loadState();
  W.state = s;

  // 修复旧数据
  for (const t of W.state.tournaments) {
    t.levels ||= [];
    for (const l of t.levels) {
      l.players ||= {};
      l.playerOrder ||= [];
      l.pendingMatches ||= [];
      l.tables ||= [];
      l.history ||= [];
      l.undoStack ||= [];
      l.banners ||= { top8Shown: false, top3Shown: false, gfShown: false };
      if (l.maxTables == null) l.maxTables = 3;
    }
  }
})();

W.render();

/* ---- 自动备份（每 5 分钟）---- */
window.setInterval(W.backupState, 5 * 60 * 1000);

/* ---- 退出时保存 ---- */
window.addEventListener('beforeunload', () => {
  W.saveState();
  W.backupState();
});
