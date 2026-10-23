/* bracket.js — 纯赛程逻辑，不直接操作 UI */
(() => {
  'use strict';
  const W = window.WACAA || {};
  const { uid, now, deepClone, shuffle } = W;

  /* ---- 参与者占用追踪 ---- */
  W.participantsInUse = function participantsInUse(level) {
    const used = new Set();
    for (const t of level.tables) {
      if (t?.match?.p1) used.add(t.match.p1);
      if (t?.match?.p2) used.add(t.match.p2);
    }
    for (const m of level.pendingMatches) { if (m.p1) used.add(m.p1); if (m.p2) used.add(m.p2); }
    return used;
  };

  function hasPendingForBracket(level, bracket) {
    return level.pendingMatches.some((m) => m.bracket === bracket);
  }

  /*
   * 只读对阵视图（不修改 level）：
   * - 当前对阵：所有正在桌上的比赛；若总决赛未完成，也计入当前对阵。
   * - 下一组上场：按 pendingMatches 现有队列顺序，取第一条双方都存活、
   *   且没有被其他桌子占用的比赛。若队列里的比赛都在等当前桌结束，
   *   返回队首那场并标记 waiting。
   * 轮空不会进入 pendingMatches，因此不会被误当作下一组。
   */
  W.getMatchupView = function getMatchupView(level) {
    const view = { current: [], next: null, nextStatus: 'none' };
    if (!level || !level.started) { view.nextStatus = 'notStarted'; return view; }
    if (level.finished) { view.nextStatus = 'finished'; return view; }

    const players = level.players || {};
    const isAlive = (id) => {
      const p = players[id];
      return !!p && p.losses < 2 && !p.eliminatedAt;
    };
    const inUse = new Set();
    const tables = Array.isArray(level.tables) ? level.tables : [];
    for (const t of tables) {
      const m = t?.match;
      if (!m) continue;
      if (m.p1) inUse.add(m.p1);
      if (m.p2) inUse.add(m.p2);
      if (isAlive(m.p1) && isAlive(m.p2)) {
        view.current.push({
          source: 'table', tableNo: t.tableNo, bracket: m.bracket,
          p1: m.p1, p2: m.p2, matchId: m.id || null, waiting: false,
        });
      }
    }

    const gf = level.grandFinal;
    const gfPending = !!gf && !gf.completed && isAlive(gf.p1) && isAlive(gf.p2);
    if (gfPending) {
      view.current.push({
        source: 'grandFinal', tableNo: null, bracket: 'GF',
        p1: gf.p1, p2: gf.p2, matchId: null, waiting: false,
        wins1: gf.wins1 || 0, wins2: gf.wins2 || 0,
      });
      inUse.add(gf.p1);
      inUse.add(gf.p2);
    }

    // 总决赛期间不再从旧队列取“下一组”，避免显示已经不存在的赛程。
    if (gfPending) { view.nextStatus = 'grandFinal'; return view; }

    const pending = Array.isArray(level.pendingMatches) ? level.pendingMatches : [];
    let blocked = null;
    for (const m of pending) {
      if (!m || !m.p1 || !m.p2 || m.p1 === m.p2) continue;
      if (!isAlive(m.p1) || !isAlive(m.p2)) continue;
      const candidate = {
        source: 'pending', tableNo: null, bracket: m.bracket,
        p1: m.p1, p2: m.p2, matchId: m.id || null, waiting: false,
      };
      if (inUse.has(m.p1) || inUse.has(m.p2)) {
        if (!blocked) blocked = Object.assign({}, candidate, { waiting: true });
        continue;
      }
      view.next = candidate;
      view.nextStatus = 'ready';
      return view;
    }

    if (blocked) {
      view.next = blocked;
      view.nextStatus = 'waiting';
    } else if (view.current.length) {
      view.nextStatus = 'pendingAfterCurrent';
    } else {
      view.nextStatus = 'none';
    }
    return view;
  };

  /* ---- 对阵生成 ---- */
  W.generateMatchesIfNeeded = function generateMatchesIfNeeded(level) {
    const events = [];
    if (!level.started || level.finished) return events;

    // C5: 先清理僵尸对阵（选手已淘汰但对阵还在）
    cleanupPendingMatches(level);

    W.adjustTablesToAutoCount(level, events);
    if (level.grandFinal && !level.grandFinal.completed) return events;
    const alive = W.alivePlayers(level);
    if (alive.length <= 1) { W.finalizeIfDone(level); return events; }
    const wAlive = W.bracketPlayers(level, 'W');
    const lAlive = W.bracketPlayers(level, 'L');
    if (wAlive.length === 1 && lAlive.length === 1 && !level.grandFinal) {
      W.setupGrandFinal(level, wAlive[0].id, lAlive[0].id);
      events.push({ type: 'grandFinal', wId: wAlive[0].id, lId: lAlive[0].id });
      return events;
    }
    if (!hasPendingForBracket(level, 'W')) {
      const result = createBracketPairings(level, 'W');
      if (result.created > 0) events.push({ type: 'matchesGenerated', bracket: 'W', count: result.created });
      // M1: 轮空通知
      if (result.byeName) events.push({ type: 'bye', name: result.byeName });
    }
    if (!hasPendingForBracket(level, 'L')) {
      const result = createBracketPairings(level, 'L');
      if (result.created > 0) events.push({ type: 'matchesGenerated', bracket: 'L', count: result.created });
      if (result.byeName) events.push({ type: 'bye', name: result.byeName });
    }
    return events;
  };

  function createBracketPairings(level, bracket) {
    const used = W.participantsInUse(level);
    const candidates = W.bracketPlayers(level, bracket).map((p) => p.id).filter((id) => !used.has(id));
    let byeName = null;
    if (candidates.length < 2) return { created: 0, byeName: null };
    const pool = shuffle(candidates);
    if (pool.length % 2 === 1) {
      const byeIdx = Math.floor(Math.random() * pool.length);
      const byeId = pool.splice(byeIdx, 1)[0];
      byeName = level.players[byeId]?.name || null;
    }
    let created = 0;
    for (let i = 0; i < pool.length; i += 2) {
      const p1 = pool[i], p2 = pool[i + 1];
      if (!p1 || !p2) continue;
      level.pendingMatches.push({ id: uid(), createdAt: now(), bracket, p1, p2, tableNo: null });
      created++;
    }
    return { created, byeName };
  }

  W.adjustTablesToAutoCount = function adjustTablesToAutoCount(level, eventsOut) {
    const want = W.computeTableCount(level);
    const cur = level.tables.length;
    if (cur === want) return;
    if (cur > want) {
      for (let i = want; i < cur; i++) {
        const t = level.tables[i];
        if (t?.match) { t.match.tableNo = null; level.pendingMatches.unshift(t.match); }
      }
      level.tables = level.tables.slice(0, want);
      if (eventsOut) eventsOut.push({ type: 'tableAdjusted', count: want });
      return;
    }
    for (let i = cur; i < want; i++) {
      level.tables.push({ tableNo: i + 1, match: null, undo: [] });
    }
    if (eventsOut) eventsOut.push({ type: 'tableAdjusted', count: want });
  };

  W.fillTables = function fillTables(level) {
    for (const t of level.tables) {
      if (t.match) continue;
      const inUse = new Set();
      for (const tt of level.tables) { if (tt.match) { inUse.add(tt.match.p1); inUse.add(tt.match.p2); } }
      const idx = level.pendingMatches.findIndex((m) => !inUse.has(m.p1) && !inUse.has(m.p2));
      if (idx === -1) continue;
      const m = level.pendingMatches.splice(idx, 1)[0];
      m.tableNo = t.tableNo; t.match = m;
    }
  };

  /* ---- 快照 / 撤销 ---- */
  W.pushUndoSnapshot = function pushUndoSnapshot(level, scope) {
    level.undoStack.push({
      id: uid(), at: now(), scope,
      snapshot: deepClone({
        players: level.players, pendingMatches: level.pendingMatches,
        tables: level.tables, history: level.history,
        finished: level.finished, grandFinal: level.grandFinal, banners: level.banners,
      }),
    });
    if (level.undoStack.length > 60) level.undoStack.shift();
  };

  function restoreSnapshot(level, snap) {
    level.players = snap.players; level.pendingMatches = snap.pendingMatches;
    level.tables = snap.tables; level.history = snap.history;
    level.finished = snap.finished; level.grandFinal = snap.grandFinal; level.banners = snap.banners;
  }

  W.undoLast = function undoLast(level, scope) {
    for (let i = level.undoStack.length - 1; i >= 0; i--) {
      const u = level.undoStack[i];
      if (u.scope !== scope) continue;
      level.undoStack.splice(i, 1);
      restoreSnapshot(level, u.snapshot);
      return scope === 'global' ? '已撤销最近一场比赛' : '已撤销本桌最近一场比赛';
    }
    return null;
  };

  /* ---- 比赛结算 ---- */
  W.resolveMatch = function resolveMatch(level, tableNo, winnerId) {
    const events = [];
    const table = level.tables.find((t) => t.tableNo === tableNo);
    if (!table?.match) return events;
    const match = table.match;
    const loserId = match.p1 === winnerId ? match.p2 : match.p1;
    const w = level.players[winnerId], l = level.players[loserId];
    if (!w || !l) return events;
    W.pushUndoSnapshot(level, `table:${tableNo}`);
    W.pushUndoSnapshot(level, 'global');
    level.history.push({ id: uid(), at: now(), tableNo, bracket: match.bracket, p1: match.p1, p2: match.p2, winnerId, loserId });
    if (match.bracket === 'W') { l.losses += 1; if (l.losses >= 2) W.eliminate(level, l.id); else l.bracket = 'L'; }
    else if (match.bracket === 'L') { l.losses += 1; if (l.losses >= 2) W.eliminate(level, l.id); }
    cleanupPendingMatches(level);
    table.match = null;
    const stageEvt = maybeStageEvent(level);
    if (stageEvt) events.push(stageEvt);
    events.push({ type: 'matchResolved' });
    return events;
  };

  function cleanupPendingMatches(level) {
    const alive = new Set(W.alivePlayers(level).map((p) => p.id));
    level.pendingMatches = level.pendingMatches.filter((m) => alive.has(m.p1) && alive.has(m.p2));
    for (const t of level.tables) { if (!t.match) continue; if (!alive.has(t.match.p1) || !alive.has(t.match.p2)) t.match = null; }
  }

  W.eliminate = function eliminate(level, playerId) {
    const p = level.players[playerId];
    if (!p || p.eliminatedAt) return;
    p.eliminatedAt = now();
  };

  // M2: 也处理 0 存活的情况
  W.finalizeIfDone = function finalizeIfDone(level) {
    if (level.grandFinal?.completed) { level.finished = true; return; }
    const alive = W.alivePlayers(level).length;
    if (alive <= 1 && level.started) { level.finished = true; }
  };

  function maybeStageEvent(level) {
    const alive = W.alivePlayers(level).length;
    if (!level.banners.top8Shown && alive <= 8) { level.banners.top8Shown = true; return { type: 'stage', stage: 'top8' }; }
    // M3: 变量名修正
    if (!level.banners.top3Shown && alive <= 3) { level.banners.top3Shown = true; return { type: 'stage', stage: 'top3' }; }
    return null;
  }

  /* ---- 总决赛 ---- */
  W.setupGrandFinal = function setupGrandFinal(level, wId, lId) {
    level.banners.gfShown = true;
    level.grandFinal = { p1: wId, p2: lId, wins1: 0, wins2: 0, completed: false, winnerId: null, runnerUpId: null };
  };

  W.recordGrandFinalWin = function recordGrandFinalWin(level, which) {
    const gf = level.grandFinal;
    if (!gf || gf.completed) return null;
    W.pushUndoSnapshot(level, 'global');
    if (which === 1) gf.wins1 += 1; else gf.wins2 += 1;
    if (gf.wins1 >= 2) { finishGrandFinal(level, gf.p1, gf.p2); return { type: 'gfComplete', winnerId: gf.p1, runnerUpId: gf.p2 }; }
    if (gf.wins2 >= 2) { finishGrandFinal(level, gf.p2, gf.p1); return { type: 'gfComplete', winnerId: gf.p2, runnerUpId: gf.p1 }; }
    return { type: 'gfPoint' };
  };

  // N3: 总决赛撤回上一局
  W.undoGrandFinalPoint = function undoGrandFinalPoint(level) {
    const gf = level.grandFinal;
    if (!gf || gf.completed) return null;
    // 找到最近一次 grandFinal 相关的快照
    for (let i = level.undoStack.length - 1; i >= 0; i--) {
      const u = level.undoStack[i];
      if (u.scope === 'global') {
        // 查快照中 grandFinal 的分数：如果比当前少，就恢复
        const snap = u.snapshot;
        if (snap.grandFinal && !snap.grandFinal.completed) {
          const oldWins1 = snap.grandFinal.wins1 || 0;
          const oldWins2 = snap.grandFinal.wins2 || 0;
          if (oldWins1 < gf.wins1 || oldWins2 < gf.wins2) {
            level.undoStack.splice(i, 1);
            restoreSnapshot(level, snap);
            return '已撤销总决赛上一局';
          }
        }
      }
    }
    return null;
  };

  function finishGrandFinal(level, winnerId, runnerUpId) {
    level.grandFinal.completed = true; level.grandFinal.winnerId = winnerId; level.grandFinal.runnerUpId = runnerUpId;
    const r = level.players[runnerUpId];
    if (r) { r.losses = 2; W.eliminate(level, r.id); }
    level.finished = true;
  }

  /* ---- 开始比赛 ---- */
  W.startLevel = function startLevel(level) {
    const events = [];
    if (Object.keys(level.players).length < 2) return events;
    level.started = true; level.finished = false;
    // M3: banner 变量名统一
    level.banners = { top8Shown: false, top3Shown: false, gfShown: false };
    level.pendingMatches = []; level.history = []; level.undoStack = []; level.grandFinal = null;
    for (const p of Object.values(level.players)) {
      p.losses = 0; p.eliminatedAt = null; p.placement = null; p.bracket = 'W';
      if (!p.pinyin) p.pinyin = W.getPinyin(p.name);
    }
    const want = W.computeTableCount(level);
    level.tables = [];
    for (let i = 0; i < want; i++) level.tables.push({ tableNo: i + 1, match: null, undo: [] });
    const seeds = level.playerOrder.slice();
    const pool = seeds.length ? seeds : Object.keys(level.players);
    const firstRound = pool.slice();
    if (firstRound.length % 2 === 1) {
      const byeIdx = Math.floor(Math.random() * firstRound.length);
      const byeId = firstRound.splice(byeIdx, 1)[0];
      const p = level.players[byeId];
      if (p) events.push({ type: 'bye', name: p.name });
    }
    for (let i = 0; i < firstRound.length; i += 2) {
      level.pendingMatches.push({ id: uid(), createdAt: now(), bracket: 'W', p1: firstRound[i], p2: firstRound[i + 1], tableNo: null });
    }
    W.fillTables(level);
    events.push({ type: 'started' });
    return events;
  };

  // C1 helper: 安全的桌子缩减——把比赛收回到 pendingMatches
  W.safelyReduceTables = function safelyReduceTables(level, targetCount) {
    const cur = level.tables.length;
    if (cur <= targetCount) return;
    for (let i = targetCount; i < cur; i++) {
      const t = level.tables[i];
      if (t?.match) { t.match.tableNo = null; level.pendingMatches.unshift(t.match); }
    }
    level.tables = level.tables.slice(0, targetCount);
  };

  window.WACAA = W;
})();
