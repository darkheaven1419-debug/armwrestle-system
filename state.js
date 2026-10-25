/* state.js — 状态管理与自动备份 */
(() => {
  'use strict';
  const W = window.WACAA || {};
  const { uid, now, clampInt, getPinyin, safeJsonParse, deepClone, normalizeNameKey, truncateName, shuffle } = W;

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

  /* 备份里不存撤销栈（方案 A）：撤销栈在快照中占绝大部分体积，而备份只用于恢复赛事数据 */
  function stateForBackup() {
    const copy = deepClone(W.state);
    for (const t of copy.tournaments || []) {
      for (const l of t.levels || []) l.undoStack = [];
    }
    return copy;
  }

  W.backupState = function backupState() {
    const snapshot = stateForBackup();
    try {
      const backups = loadBackups();
      backups.unshift(snapshot);
      if (backups.length > MAX_BACKUPS) backups.length = MAX_BACKUPS;
      localStorage.setItem(BACKUP_KEY, JSON.stringify(backups));
    } catch (e) {
      // 空间不足时退化为只保留最近 1 份，绝不让异常冒到调用方
      try {
        localStorage.setItem(BACKUP_KEY, JSON.stringify([snapshot]));
        if (W.toast) W.toast('存储空间紧张：自动备份已只保留最近 1 份');
      } catch (e2) {
        if (W.toast) W.toast('自动备份失败：存储空间不足，请立即导出数据');
      }
    }
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
      // 添加选手后自动打乱种子顺序（默认开启，可随时关闭）
      autoShuffle: opts.autoShuffle === undefined ? true : !!opts.autoShuffle,
      started: false, finished: false, players: {}, playerOrder: [],
      pendingMatches: [], tables: [], history: [], undoStack: [],
      banners: { top8Shown: false, top3Shown: false, gfShown: false }, grandFinal: null,
    };
  };

  W.createPlayer = function createPlayer(name) {
    const clean = truncateName(name, 30);
    return { id: uid(), name: clean, pinyin: getPinyin(clean), losses: 0, eliminatedAt: null, eliminatedSeq: null, placement: null, bracket: 'W' };
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

  /* 已记录在历史里的负场数；退赛会直接补到 2 负但不产生历史记录 */
  W.recordedLosses = function recordedLosses(level, playerId) {
    return level.history.filter((h) => h.loserId === playerId).length;
  };

  /* 是否是“退赛”而不是正常输满两场（总决赛负者也会被补到 2 负，不算退赛） */
  W.isWithdrawn = function isWithdrawn(level, p) {
    if (!p || !p.eliminatedAt) return false;
    const gf = level.grandFinal;
    if (gf && (p.id === gf.p1 || p.id === gf.p2)) return false;
    return W.recordedLosses(level, p.id) < p.losses;
  };

  // N5: 允许在比赛开始后移除选手（因伤退赛等）；退赛可被“全局撤回”撤销
  W.withdrawPlayer = function withdrawPlayer(level, playerId) {
    const p = level.players[playerId];
    if (!p || p.losses >= 2) return false;
    if (W.pushUndoSnapshot) W.pushUndoSnapshot(level, 'global');
    p.losses = 2;
    W.markEliminated(level, p);
    // 清理该选手在队列和桌子上的所有比赛
    const alive = new Set(W.alivePlayers(level).map((x) => x.id));
    level.pendingMatches = level.pendingMatches.filter((m) => alive.has(m.p1) && alive.has(m.p2));
    for (const t of level.tables) {
      if (!t.match) continue;
      if (!alive.has(t.match.p1) || !alive.has(t.match.p2)) t.match = null;
    }
    return true;
  };

  /*
   * 记录淘汰顺序。名次以淘汰序号为准，而不是毫秒时间戳：
   * 快速连续结算（或自动化测试）时，多人可能拿到同一个 Date.now()，
   * 只按时间排序会让同毫秒淘汰者的名次变成未定义顺序。序号在级别内单调递增。
   */
  W.markEliminated = function markEliminated(level, p) {
    if (!p) return;
    if (!p.eliminatedAt) p.eliminatedAt = now();
    if (typeof p.eliminatedSeq === 'number' && Number.isFinite(p.eliminatedSeq)) return;
    let maxSeq = 0;
    for (const x of Object.values(level.players || {})) {
      const s = x && x.eliminatedSeq;
      if (typeof s === 'number' && Number.isFinite(s) && s > maxSeq) maxSeq = s;
    }
    p.eliminatedSeq = maxSeq + 1;
  };

  /* ---- 排名计算 ---- */
  W.computePlacements = function computePlacements(level) {
    const ps = Object.values(level.players);
    const total = ps.length;
    for (const p of ps) p.placement = null;
    const seqOf = (p) => (typeof p.eliminatedSeq === 'number' && Number.isFinite(p.eliminatedSeq) ? p.eliminatedSeq : null);
    const eliminated = ps.filter((p) => p.eliminatedAt).sort((a, b) => {
      const sa = seqOf(a), sb = seqOf(b);
      if (sa != null && sb != null) return sa - sb;
      // 只有旧数据才会缺序号（加载时会补齐），时间戳兜底保持原行为
      if (sa != null) return -1;
      if (sb != null) return 1;
      return a.eliminatedAt - b.eliminatedAt;
    });
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

  /* ---- 导入校验与归一化 ---- */
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
  const MAX_TOURNAMENTS = 100;
  const MAX_LEVELS_PER_TOURNAMENT = 100;
  const MAX_PLAYERS_PER_LEVEL = 512;
  const MAX_UNDO_SNAPSHOTS = 60;

  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const numOr = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const boolOr = (x, d) => (typeof x === 'boolean' ? x : d);
  const isSafeId = (x) => typeof x === 'string' && ID_RE.test(x) && !RESERVED_IDS.has(x);

  function normalizeTournament(raw, warnings) {
    if (!isObj(raw)) { warnings.push('丢弃了一场损坏的比赛'); return null; }
    const rawLevels = Array.isArray(raw.levels) ? raw.levels : [];
    if (!Array.isArray(raw.levels)) warnings.push('有一场比赛的级别列表缺失，已按空处理');
    const levels = [];
    for (const rl of rawLevels.slice(0, MAX_LEVELS_PER_TOURNAMENT)) {
      const l = normalizeLevel(rl, warnings);
      if (l) levels.push(l);
    }
    if (rawLevels.length > MAX_LEVELS_PER_TOURNAMENT) warnings.push(`级别数超过上限（${MAX_LEVELS_PER_TOURNAMENT}），多余的已舍弃`);
    return {
      id: isSafeId(raw.id) ? raw.id : uid(),
      name: truncateName(String(raw.name || '未命名比赛'), 50) || '未命名比赛',
      createdAt: numOr(raw.createdAt, now()),
      levels,
    };
  }

  function normalizePlayer(id, raw, warnings) {
    const name = truncateName(String(raw.name || '').trim(), 30);
    if (!name) warnings.push('有一名选手缺少姓名，已命名为“未命名”');
    const bracket = raw.bracket === 'L' ? 'L' : 'W';
    return {
      id,
      name: name || '未命名',
      pinyin: typeof raw.pinyin === 'string' ? raw.pinyin : getPinyin(name || '未命名'),
      losses: clampInt(numOr(raw.losses, 0), 0, 2),
      eliminatedAt: numOr(raw.eliminatedAt, null),
      eliminatedSeq: typeof raw.eliminatedSeq === 'number' && Number.isFinite(raw.eliminatedSeq) ? raw.eliminatedSeq : null,
      placement: typeof raw.placement === 'number' && Number.isFinite(raw.placement) ? raw.placement : null,
      bracket,
    };
  }

  function normalizeMatch(raw, players) {
    if (!isObj(raw)) return null;
    if (!players[raw.p1] || !players[raw.p2] || raw.p1 === raw.p2) return null;
    const bracket = raw.bracket === 'L' ? 'L' : 'W';
    return {
      id: isSafeId(raw.id) ? raw.id : uid(),
      createdAt: numOr(raw.createdAt, now()),
      bracket,
      p1: raw.p1,
      p2: raw.p2,
      tableNo: typeof raw.tableNo === 'number' ? raw.tableNo : null,
    };
  }

  function normalizeLevel(raw, warnings) {
    if (!isObj(raw)) { warnings.push('丢弃了一个损坏的级别'); return null; }
    const level = W.createLevel({ name: raw.name, maxTables: raw.maxTables });
    level.id = isSafeId(raw.id) ? raw.id : uid();
    level.createdAt = numOr(raw.createdAt, now());
    level.started = boolOr(raw.started, false);
    level.finished = boolOr(raw.finished, false);
    // 旧版导出没有 autoShuffle 字段：保持“默认开启”的既有行为
    level.autoShuffle = boolOr(raw.autoShuffle, true);
    level.banners = {
      top8Shown: !!raw.banners?.top8Shown,
      top3Shown: !!raw.banners?.top3Shown,
      gfShown: !!raw.banners?.gfShown,
    };

    const players = {};
    let skippedPlayers = 0;
    const rawPlayers = isObj(raw.players) ? raw.players : {};
    for (const [id, p] of Object.entries(rawPlayers)) {
      if (!isSafeId(id) || !isObj(p)) { skippedPlayers++; continue; }
      if (Object.keys(players).length >= MAX_PLAYERS_PER_LEVEL) { skippedPlayers++; continue; }
      players[id] = normalizePlayer(id, p, warnings);
    }
    if (skippedPlayers) warnings.push(`「${level.name}」有 ${skippedPlayers} 名选手数据无效，已跳过`);
    level.players = players;

    /*
     * 旧版导出没有淘汰序号：按原有的淘汰时间顺序补齐。
     * 这样同一毫秒内淘汰的选手也保持升级前的排列，之后的名次不再随机。
     */
    let maxSeq = 0;
    for (const p of Object.values(players)) {
      if (typeof p.eliminatedSeq === 'number' && p.eliminatedSeq > maxSeq) maxSeq = p.eliminatedSeq;
    }
    const missingSeq = Object.values(players)
      .filter((p) => p.eliminatedAt && typeof p.eliminatedSeq !== 'number')
      .sort((a, b) => a.eliminatedAt - b.eliminatedAt);
    for (const p of missingSeq) p.eliminatedSeq = ++maxSeq;

    const order = [];
    const seen = new Set();
    for (const id of Array.isArray(raw.playerOrder) ? raw.playerOrder : []) {
      if (players[id] && !seen.has(id)) { seen.add(id); order.push(id); }
    }
    for (const id of Object.keys(players)) if (!seen.has(id)) order.push(id);
    level.playerOrder = order;

    const rawTables = Array.isArray(raw.tables) ? raw.tables.slice(0, 3) : [];
    let badTableMatches = 0;
    level.tables = rawTables.map((rt, i) => {
      const match = normalizeMatch(rt?.match, players);
      if (rt?.match && !match) badTableMatches++;
      return {
        tableNo: i + 1,
        match,
        undo: Array.isArray(rt?.undo) ? rt.undo.filter((u) => isObj(u)) : [],
      };
    });
    if (badTableMatches) warnings.push(`「${level.name}」有 ${badTableMatches} 桌对阵无效，已清空`);

    const rawPending = Array.isArray(raw.pendingMatches) ? raw.pendingMatches : [];
    level.pendingMatches = rawPending.map((m) => normalizeMatch(m, players)).filter(Boolean);
    if (level.pendingMatches.length !== rawPending.length) {
      warnings.push(`「${level.name}」有 ${rawPending.length - level.pendingMatches.length} 场待赛对阵无效，已移除`);
    }

    level.history = (Array.isArray(raw.history) ? raw.history : [])
      .filter((h) => isObj(h) && players[h.p1] && players[h.p2] && players[h.winnerId] && players[h.loserId])
      .map((h) => ({
        id: isSafeId(h.id) ? h.id : uid(),
        at: numOr(h.at, now()),
        tableNo: numOr(h.tableNo, null),
        bracket: h.bracket === 'L' ? 'L' : 'W',
        p1: h.p1, p2: h.p2, winnerId: h.winnerId, loserId: h.loserId,
      }));

    level.undoStack = (Array.isArray(raw.undoStack) ? raw.undoStack : [])
      .filter(isObj)
      .filter((u) => isObj(u.snapshot) && isObj(u.snapshot.players)
        && Array.isArray(u.snapshot.tables) && Array.isArray(u.snapshot.history))
      .slice(-MAX_UNDO_SNAPSHOTS)
      .map((u) => ({
        id: isSafeId(u.id) ? u.id : uid(),
        at: numOr(u.at, now()),
        scope: typeof u.scope === 'string' ? u.scope : 'global',
        snapshot: u.snapshot,
      }));

    level.grandFinal = normalizeGrandFinal(raw.grandFinal, players, warnings);
    return level;
  }

  function normalizeGrandFinal(raw, players, warnings) {
    if (raw == null) return null;
    if (!isObj(raw) || !players[raw.p1] || !players[raw.p2] || raw.p1 === raw.p2) {
      warnings.push('有一场总决赛数据无效，已清除');
      return null;
    }
    const winnerId = raw.winnerId === raw.p1 || raw.winnerId === raw.p2 ? raw.winnerId : null;
    return {
      p1: raw.p1,
      p2: raw.p2,
      wins1: clampInt(numOr(raw.wins1, 0), 0, 2),
      wins2: clampInt(numOr(raw.wins2, 0), 0, 2),
      completed: !!raw.completed && !!winnerId,
      winnerId,
      runnerUpId: raw.runnerUpId === raw.p1 || raw.runnerUpId === raw.p2 ? raw.runnerUpId : null,
    };
  }

  function normalizeUi(rawUi) {
    const name = rawUi?.route?.name;
    const allowed = new Set(['home', 'tournament', 'level', 'multilevel']);
    if (!allowed.has(name)) return { route: { name: 'home' } };
    return {
      route: {
        name,
        tournamentId: typeof rawUi.route.tournamentId === 'string' ? rawUi.route.tournamentId : undefined,
        levelId: typeof rawUi.route.levelId === 'string' ? rawUi.route.levelId : undefined,
        levelIds: Array.isArray(rawUi.route.levelIds) ? rawUi.route.levelIds.filter((x) => typeof x === 'string') : undefined,
      },
    };
  }

  /* 校验并归一化外部 JSON；返回 { state, warnings } 或 { error } */
  W.normalizeState = function normalizeState(data) {
    if (!isObj(data)) return { error: 'JSON 内容不是对象' };
    if (data.version !== 1) return { error: 'JSON 版本不正确（应为 1）' };
    if (!Array.isArray(data.tournaments)) return { error: '数据格式错误：缺少 tournaments 数组' };
    if (data.tournaments.length > MAX_TOURNAMENTS) return { error: `比赛数量超过上限（${MAX_TOURNAMENTS}）` };

    const warnings = [];
    const tournaments = [];
    for (const t of data.tournaments) {
      const normalized = normalizeTournament(t, warnings);
      if (normalized) tournaments.push(normalized);
    }
    if (data.tournaments.length > 0 && tournaments.length === 0) return { error: '没有可导入的比赛数据' };

    return { state: { version: 1, tournaments, ui: normalizeUi(data.ui) }, warnings };
  };

  // N6: 兼容旧调用方：仅返回错误信息
  W.validateImportData = function validateImportData(data) {
    return W.normalizeState(data).error || null;
  };

  /* ---- 选手操作 ---- */
  // C6 + M6: 修复重复检测，合并为单次 pass
  W.batchAddPlayers = function batchAddPlayers(level, text) {
    const raw = String(text || '');
    const parts = raw.split(/[\n,，]+/g).map((s) => s.trim()).filter(Boolean);
    const existingNames = new Map(); // normalized key -> count (0 = from existing players)
    const dupes = [];

    // 预加载已有选手：计数为 1，表示这个名字已被占用
    for (const p of Object.values(level.players)) {
      existingNames.set(normalizeNameKey(p.name), 1);
    }

    let added = 0;
    for (const name of parts) {
      const baseKey = normalizeNameKey(name);
      const count = existingNames.get(baseKey) || 0;

      let resolvedName;
      if (count === 0) {
        // 该姓名首次出现在本次输入中
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

  /* 只打乱尚未开赛的参赛顺序；比赛开始后一律拒绝，避免影响已排定对阵 */
  W.shufflePlayerOrder = function shufflePlayerOrder(level) {
    if (!level || level.started) return false;
    level.playerOrder = shuffle(level.playerOrder.slice());
    return true;
  };

  /*
   * 批量添加选手；整批添加成功后，若未关闭 autoShuffle，只打乱一次。
   * 返回 { added, dupes, shuffled }，方便 UI 给出准确反馈。
   */
  W.addPlayers = function addPlayers(level, text) {
    if (!level || level.started) return { added: 0, dupes: [], shuffled: false };
    const result = W.batchAddPlayers(level, text);
    let shuffled = false;
    if (result.added > 0 && level.autoShuffle !== false) {
      shuffled = W.shufflePlayerOrder(level);
    }
    return { added: result.added, dupes: result.dupes, shuffled };
  };

  /*
   * 独立设置某级别的桌数上限（1~3）。
   * - 未开始：只改上限，下次开始比赛按新上限建桌。
   * - 已开始：安全调整桌子数量，多余桌上的比赛退回候场队列，不会清空、
   *   判负或改写任何已完成记录；已结束的级别只记录设置。
   */
  W.setTableLimit = function setTableLimit(level, value) {
    if (!level) return null;
    const prev = clampInt(level.maxTables ?? 1, 1, 3);
    const limit = clampInt(value, 1, 3);
    level.maxTables = limit;
    if (level.started && !level.finished && W.adjustTablesToAutoCount) {
      W.adjustTablesToAutoCount(level, []);
      W.fillTables(level);
    }
    return { prev, limit };
  };

  W.deletePlayer = function deletePlayer(level, playerId) {
    if (level.started) return;
    delete level.players[playerId];
    level.playerOrder = level.playerOrder.filter((id) => id !== playerId);
  };

  window.WACAA = W;
})();
