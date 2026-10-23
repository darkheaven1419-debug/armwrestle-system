/* state.js — 状态管理与自动备份 */
(() => {
  'use strict';
  const W = window.WACAA || {};
  const { uid, now, clampInt, getPinyin, safeJsonParse, deepClone, normalizeNameKey, truncateName } = W;

  const STORAGE_KEY = 'wacaa_armwrestle_v1';
  const BACKUP_KEY = 'wacaa_armwrestle_backup';
  const MAX_BACKUPS = 3;
  // M4: 导出供 UI 层使用
  W.STORAGE_KEY = STORAGE_KEY;
  W.BACKUP_KEY = BACKUP_KEY;

  W.state = { version: 1, tournaments: [], ui: { route: { name: 'home' } } };

  /* 真正清空：主数据与自动备份一起删，否则下次启动会从备份“复活” */
  W.clearAllData = function clearAllData() {
    let ok = true;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { ok = false; }
    try { localStorage.removeItem(BACKUP_KEY); } catch (e) { ok = false; }
    return ok;
  };

  /* ---- 初始化 ---- */
  W.loadState = function loadState() {
    const reset = new URLSearchParams(location.search).get('reset');
    if (reset === '1') {
      W.clearAllData();
      history.replaceState(null, '', location.pathname);
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? safeJsonParse(raw) : null;
    if (parsed && parsed.version === 1 && parsed.tournaments && parsed.ui) return parsed;
    const backups = loadBackups();
    if (backups.length > 0) return backups[0];
    return { version: 1, tournaments: [], ui: { route: { name: 'home' } } };
  };

  // M9: 安全保存，quota 满了给提示
  W.saveState = function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(W.state));
    } catch (e) {
      if (W.toast) W.toast('保存失败：存储空间已满，请导出数据后清理旧数据');
    }
  };

  function loadBackups() {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? safeJsonParse(raw) || [] : [];
  }

  W.backupState = function backupState() {
    const backups = loadBackups();
    backups.unshift(deepClone(W.state));
    if (backups.length > MAX_BACKUPS) backups.length = MAX_BACKUPS;
    localStorage.setItem(BACKUP_KEY, JSON.stringify(backups));
  };

  /* ---- 工厂函数 ---- */
  W.createTournament = function createTournament(name) {
    return { id: uid(), name: truncateName(name || '新建比赛', 50) || '新建比赛', createdAt: now(), levels: [] };
  };

  W.createLevel = function createLevel(opts) {
    opts = opts || {};
    return {
      id: uid(), name: truncateName(opts.name || '未命名级别', 40) || '未命名级别',
      createdAt: now(), maxTables: clampInt(opts.maxTables ?? 1, 1, 3),
      started: false, finished: false, players: {}, playerOrder: [],
      pendingMatches: [], tables: [], history: [], undoStack: [],
      banners: { top8Shown: false, top3Shown: false, gfShown: false }, grandFinal: null,
    };
  };

  W.createPlayer = function createPlayer(name) {
    const clean = truncateName(name, 30);
    return { id: uid(), name: clean, pinyin: getPinyin(clean), losses: 0, eliminatedAt: null, placement: null, bracket: 'W' };
  };

  /* ---- 查询辅助 ---- */
  // M8: 同时检查 eliminatedAt
  W.alivePlayers = (level) => Object.values(level.players).filter((p) => p.losses < 2 && !p.eliminatedAt);
  W.bracketPlayers = (level, bracket) => W.alivePlayers(level).filter((p) => p.bracket === bracket);

  W.computeTableCount = function computeTableCount(level) {
    const alive = W.alivePlayers(level).length;
    let want = 1;
    if (alive <= 8) want = 1; else if (alive <= 16) want = 2; else want = 3;
    return Math.min(level.maxTables, want);
  };

  W.getLevel = function getLevel(tournamentId, levelId) {
    const tournament = W.state.tournaments.find((x) => x.id === tournamentId);
    const level = tournament?.levels.find((l) => l.id === levelId);
    return { tournament, level };
  };

  // N5: 允许在比赛开始后移除选手（因伤退赛等）
  W.withdrawPlayer = function withdrawPlayer(level, playerId) {
    const p = level.players[playerId];
    if (!p || p.losses >= 2) return false;
    p.losses = 2;
    p.eliminatedAt = now();
    // 清理该选手在队列和桌子上的所有比赛
    const alive = new Set(W.alivePlayers(level).map((x) => x.id));
    level.pendingMatches = level.pendingMatches.filter((m) => alive.has(m.p1) && alive.has(m.p2));
    for (const t of level.tables) {
      if (!t.match) continue;
      if (!alive.has(t.match.p1) || !alive.has(t.match.p2)) t.match = null;
    }
    return true;
  };

  /* ---- 排名计算 ---- */
  W.computePlacements = function computePlacements(level) {
    const ps = Object.values(level.players);
    const total = ps.length;
    for (const p of ps) p.placement = null;
    const eliminated = ps.filter((p) => p.eliminatedAt).sort((a, b) => a.eliminatedAt - b.eliminatedAt);
    eliminated.forEach((p, idx) => { p.placement = total - idx; });
    if (level.finished) {
      if (level.grandFinal?.completed && level.grandFinal.winnerId) {
        const champ = level.players[level.grandFinal.winnerId];
        if (champ) champ.placement = 1;
      } else {
        const alive = ps.filter((p) => !p.eliminatedAt);
        if (alive.length === 1) alive[0].placement = 1;
      }
    }
  };

  // N6: 导入结构验证
  W.validateImportData = function validateImportData(data) {
    if (!data || data.version !== 1) return 'JSON 版本不正确';
    if (!Array.isArray(data.tournaments)) return '数据格式错误：缺少 tournaments 数组';
    if (!data.ui || typeof data.ui !== 'object') return '数据格式错误：缺少 UI 状态';
    return null; // null = 通过验证
  };

  /* ---- 选手操作 ---- */
  // C6 + M6: 修复重复检测，合并为单次 pass
  W.batchAddPlayers = function batchAddPlayers(level, text) {
    const raw = String(text || '');
    const parts = raw.split(/[\n,，]+/g).map((s) => s.trim()).filter(Boolean);
    const existingNames = new Map(); // normalized key -> count (0 = from existing players)
    const dupes = [];

    // 预加载已有选手
    for (const p of Object.values(level.players)) {
      existingNames.set(normalizeNameKey(p.name), 0);
    }

    let added = 0;
    for (const name of parts) {
      const baseKey = normalizeNameKey(name);
      const count = existingNames.get(baseKey) || 0;

      let resolvedName;
      if (count === 0) {
        // 首次出现（可能已有同名选手，也可能没有）
        resolvedName = name;
        existingNames.set(baseKey, 1);
      } else {
        // 有重复，加后缀
        let suffix = count + 1;
        let testKey = `${baseKey}(${suffix})`;
        while (existingNames.has(testKey)) { suffix++; testKey = `${baseKey}(${suffix})`; }
        resolvedName = `${name}(${suffix})`;
        existingNames.set(baseKey, suffix);
        dupes.push(name);
      }

      const p = W.createPlayer(resolvedName);
      level.players[p.id] = p;
      level.playerOrder.push(p.id);
      added++;
    }
    return { added, dupes };
  };

  W.deletePlayer = function deletePlayer(level, playerId) {
    if (level.started) return;
    delete level.players[playerId];
    level.playerOrder = level.playerOrder.filter((id) => id !== playerId);
  };

  window.WACAA = W;
})();
