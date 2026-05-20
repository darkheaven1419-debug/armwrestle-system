/* state.js — 状态管理与自动备份 */
(() => {
  'use strict';
  const W = window.WACAA || {};
  const { uid, now, clampInt, getPinyin, safeJsonParse, deepClone, normalizeNameKey } = W;

  const STORAGE_KEY = 'wacaa_armwrestle_v1';
  const BACKUP_KEY = 'wacaa_armwrestle_backup';
  const MAX_BACKUPS = 3;

  W.state = { version: 1, tournaments: [], ui: { route: { name: 'home' } } };

  /* ---- 初始化 ---- */
  W.loadState = function loadState() {
    const reset = new URLSearchParams(location.search).get('reset');
    if (reset === '1') {
      localStorage.removeItem(STORAGE_KEY);
      history.replaceState(null, '', location.pathname);
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? safeJsonParse(raw) : null;
    if (parsed && parsed.version === 1) return parsed;
    const backups = loadBackups();
    if (backups.length > 0) return backups[0];
    return { version: 1, tournaments: [], ui: { route: { name: 'home' } } };
  };

  W.saveState = function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(W.state));
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
    return { id: uid(), name: (name || '新建比赛').trim() || '新建比赛', createdAt: now(), levels: [] };
  };

  W.createLevel = function createLevel(opts) {
    opts = opts || {};
    return {
      id: uid(), name: (opts.name || '未命名级别').trim() || '未命名级别',
      createdAt: now(), maxTables: clampInt(opts.maxTables ?? 1, 1, 3),
      started: false, finished: false, players: {}, playerOrder: [],
      pendingMatches: [], tables: [], history: [], undoStack: [],
      banners: { top8Shown: false, top4Shown: false, gfShown: false }, grandFinal: null,
    };
  };

  W.createPlayer = function createPlayer(name) {
    const clean = (name || '').trim();
    return { id: uid(), name: clean, pinyin: getPinyin(clean), losses: 0, eliminatedAt: null, placement: null, bracket: 'W' };
  };

  /* ---- 查询辅助 ---- */
  W.alivePlayers = (level) => Object.values(level.players).filter((p) => p.losses < 2);
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

  /* ---- 选手操作 ---- */
  W.batchAddPlayers = function batchAddPlayers(level, text) {
    const raw = String(text || '');
    const parts = raw.split(/[\n,，]+/g).map((s) => s.trim()).filter(Boolean);
    const existingKeys = new Set(Object.values(level.players).map((p) => normalizeNameKey(p.name)));
    const seenBatch = new Map();
    const dupes = [];
    let added = 0;

    for (const name of parts) {
      const baseKey = normalizeNameKey(name);
      let resolvedName = name;
      if (existingKeys.has(baseKey)) {
        let suffix = 2;
        while (existingKeys.has(`${baseKey}(${suffix})`)) suffix++;
        resolvedName = `${name}(${suffix})`;
        existingKeys.add(normalizeNameKey(resolvedName));
      } else { existingKeys.add(baseKey); }
      const batchCount = seenBatch.get(baseKey) || 0;
      if (batchCount > 0) {
        let suffix = batchCount + 1;
        while (existingKeys.has(`${baseKey}(${suffix})`)) suffix++;
        resolvedName = `${name}(${suffix})`;
        existingKeys.add(normalizeNameKey(resolvedName));
      }
      seenBatch.set(baseKey, batchCount + 1);
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
