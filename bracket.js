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

  /* 场上是否还有某个组别的比赛（用于整轮/整阶段推进） */
  function hasTableMatchForBracket(level, bracket) {
    return level.tables.some((t) => t.match && t.match.bracket === bracket);
  }

  function pendingOf(level) {
    return Array.isArray(level.pendingMatches) ? level.pendingMatches : [];
  }

  function matchesOnTables(level) {
    const out = [];
    for (const t of level.tables || []) if (t && t.match) out.push(t.match);
    return out;
  }

  function allLiveMatches(level) {
    return pendingOf(level).concat(matchesOnTables(level));
  }

  /*
   * 选手的败者组进度：
   * - 从 W 第 r 轮落入败者组时，dropRound=r，lStage=r-1；
   * - 赢下 L 第 s 阶段后，lStage=s；
   * - 因此“下一阶段”= 存活败者组选手中最小的 lStage + 1。
   */
  function playerLoserStage(level, id) {
    const p = level.players && level.players[id];
    if (!p) return 0;
    if (typeof p.lStage === 'number' && Number.isFinite(p.lStage)) {
      return Math.max(0, Math.floor(p.lStage));
    }
    const drop = p.dropRound;
    return Math.max(0, (typeof drop === 'number' && Number.isFinite(drop) ? drop : 1) - 1);
  }

  function loserStageOf(level, m) {
    if (typeof m.stage === 'number' && Number.isFinite(m.stage)) {
      return Math.max(1, Math.floor(m.stage));
    }
    const a = playerLoserStage(level, m.p1);
    const b = playerLoserStage(level, m.p2);
    return Math.max(1, Math.min(a, b) + 1);
  }

  W.minLoserStage = function minLoserStage(level) {
    const stages = W.bracketPlayers(level, 'L').map((p) => playerLoserStage(level, p.id));
    return stages.length ? Math.min(...stages) : 0;
  };

  /*
   * 波次闸门：L 第 s 阶段必须同时满足
   * 1) 前一个 L 阶段（s-1）已经完成；
   * 2) 对应波次的 W 比赛全部完成——S1 等 W2，S2 等 W3，依此类推；
   * 3) 如果 W 组还有出线资格，W 第 s+1 轮必须已经生成并完成。
   * “完成”包括候场队列和所有桌子，不能只看某一方是否空闲。
   * W 被淘汰到只剩 1 人时不存在下一轮 W，条件 3 自动成立。
   */
  W.isLoserStageReady = function isLoserStageReady(level, m) {
    if (!m || m.bracket !== 'L') return true;
    const stage = loserStageOf(level, m);
    if (!Number.isFinite(stage) || stage < 1) return false;
    if (W.minLoserStage(level) !== stage - 1) return false;
    const wAlive = W.bracketPlayers(level, 'W').length;
    if (wAlive >= 2 && (level.wRound || 0) < stage + 1) return false;
    const barrier = stage + 1;
    const blocks = (x) => !!x && x.bracket === 'W'
      && (typeof x.round !== 'number' || !Number.isFinite(x.round) || x.round <= barrier);
    if (pendingOf(level).some(blocks)) return false;
    return !matchesOnTables(level).some(blocks);
  };

  /* 当前是否有败者组波次正在进行（桌上有 L，或队列里有已就绪的 L）。 */
  function hasActiveLoserWave(level) {
    if (matchesOnTables(level).some((m) => m.bracket === 'L')) return true;
    return pendingOf(level).some((m) => m && m.bracket === 'L' && W.isLoserStageReady(level, m));
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
    /*
     * 展示与引擎共用同一波次顺序：
     * - 败者组波次进行中，只展示已就绪的 L，不再展示下一波 W；
     * - 否则先展示 W，再展示已就绪的 L。
     * 未就绪的 L 永远不会成为“下一组”。
     */
    const loserWave = hasActiveLoserWave(level);
    const ordered = [];
    if (!loserWave) ordered.push(...pending.filter((m) => m && m.bracket === 'W'));
    ordered.push(...pending.filter((m) => m && m.bracket === 'L' && W.isLoserStageReady(level, m)));
    let blocked = null;
    for (const m of ordered) {
      if (!m || !m.p1 || !m.p2 || m.p1 === m.p2) continue;
      if (!isAlive(m.p1) || !isAlive(m.p2)) continue;
      const candidate = {
        source: 'pending', tableNo: null, bracket: m.bracket,
        round: m.round ?? null, stage: m.stage ?? null,
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
    if (W.alivePlayers(level).length <= 1) { W.finalizeIfDone(level); return events; }
    if (trySetupGrandFinal(level, events)) return events;

    scheduleWaves(level, events);
    trySetupGrandFinal(level, events);
    return events;
  };

  function trySetupGrandFinal(level, events) {
    if (level.grandFinal) return true;
    const wAlive = W.bracketPlayers(level, 'W');
    const lAlive = W.bracketPlayers(level, 'L');
    if (wAlive.length !== 1 || lAlive.length !== 1) return false;
    W.setupGrandFinal(level, wAlive[0].id, lAlive[0].id);
    events.push({ type: 'grandFinal', wId: wAlive[0].id, lId: lAlive[0].id });
    return true;
  }

  /*
   * 波次调度（唯一实现）：
   *   W1 -> W2 -> L1 -> W3 -> L2 -> W4 -> L3 -> ...
   * 每个时刻只允许一个组别的比赛处于“候场/桌上”。
   * - 当前波次的 W 未全部完成：不生成、也不允许 L 上桌；
   * - 当前波次的 L 未全部完成：不生成下一轮 W；
   * - W 只剩 1 人后，L 继续按阶段推进到只剩 1 人，再进总决赛。
   * 这样 S1 必须在 W2 全部结束后才开始；S2 必须在 W3 全部结束后才开始。
   */
  function scheduleWaves(level, events) {
    for (let guard = 0; guard < 200; guard += 1) {
      cleanupPendingMatches(level);
      if (level.finished) return;
      if (trySetupGrandFinal(level, events)) return;

      const live = allLiveMatches(level);
      // 任一 W 比赛未完成，当前 W 波次就不能结束
      if (live.some((m) => m.bracket === 'W')) return;
      // L 波次进行中（桌上有 L，或队列里有已就绪的 L）
      if (matchesOnTables(level).some((m) => m.bracket === 'L')) return;
      if (pendingOf(level).some((m) => m.bracket === 'L' && W.isLoserStageReady(level, m))) return;

      const wAlive = W.bracketPlayers(level, 'W').length;
      const lAlive = W.bracketPlayers(level, 'L').length;
      if (wAlive + lAlive <= 1) return;

      const wr = Math.max(0, level.wRound || 0);
      const minL = W.minLoserStage(level);
      let action;
      if (wr <= 1) {
        // 开局先完成 W1、W2，然后才进入 L1
        action = wAlive >= 2 ? createWinnerPairings(level) : createLoserStagePairings(level, minL + 1);
      } else if (minL < wr - 1) {
        // 当前 W 波次已完成，但对应的 L 阶段尚未完成：先打 L
        action = createLoserStagePairings(level, minL + 1);
      } else if (wAlive >= 2) {
        // L 阶段已完成，进入下一轮 W
        action = createWinnerPairings(level);
      } else {
        // W 已无下一轮，L 继续收尾
        action = createLoserStagePairings(level, minL + 1);
      }

      if (!action) return;
      if (action.created > 0) {
        events.push({ type: 'matchesGenerated', bracket: action.bracket, count: action.created });
      }
      if (action.byeName) events.push({ type: 'bye', name: action.byeName });
      // 只有轮空推进、没有生成比赛时，继续循环；否则下一轮循环会因
      // “有比赛未完成”而自然停下。
      if (action.created === 0 && action.advanced === 0) return;
    }
  }

  function createWinnerPairings(level) {
    const used = W.participantsInUse(level);
    const candidates = W.bracketPlayers(level, 'W').map((p) => p.id).filter((id) => !used.has(id));
    if (candidates.length < 2) return { created: 0, byeName: null, advanced: 0, bracket: 'W' };
    const pool = shuffle(candidates);
    let byeName = null;
    if (pool.length % 2 === 1) {
      const byeIdx = Math.floor(Math.random() * pool.length);
      const byeId = pool.splice(byeIdx, 1)[0];
      byeName = level.players[byeId]?.name || null;
    }
    const round = Math.max(1, level.wRound || 0) + 1;
    level.wRound = round;
    let created = 0;
    for (let i = 0; i < pool.length; i += 2) {
      const p1 = pool[i], p2 = pool[i + 1];
      if (!p1 || !p2) continue;
      level.pendingMatches.push({
        id: uid(), createdAt: now(), bracket: 'W', round, p1, p2, tableNo: null,
      });
      created += 1;
    }
    return { created, byeName, advanced: 0, bracket: 'W' };
  }

  /*
   * 只生成当前 L 阶段：lStage === stage-1 的选手（上一阶段胜者 + 本轮
   * 刚从 W 落下来的选手）。人数为奇数时，一人轮空并直接推进到下一阶段。
   */
  function createLoserStagePairings(level, stage) {
    const used = W.participantsInUse(level);
    const candidates = W.bracketPlayers(level, 'L')
      .filter((p) => {
        const drop = p.dropRound;
        return playerLoserStage(level, p.id) === stage - 1
          && (drop == null || drop <= stage)
          && !used.has(p.id);
      })
      .map((p) => p.id);
    if (candidates.length === 0) {
      return { created: 0, byeName: null, advanced: 0, bracket: 'L', stage };
    }
    const pool = shuffle(candidates);
    let byeName = null;
    let advanced = 0;
    if (pool.length % 2 === 1) {
      const byeIdx = Math.floor(Math.random() * pool.length);
      const byeId = pool.splice(byeIdx, 1)[0];
      const p = level.players[byeId];
      if (p) {
        p.lStage = stage;
        byeName = p.name;
        advanced = 1;
      }
    }
    let created = 0;
    for (let i = 0; i < pool.length; i += 2) {
      const p1 = pool[i], p2 = pool[i + 1];
      if (!p1 || !p2) continue;
      level.pendingMatches.push({
        id: uid(), createdAt: now(), bracket: 'L', stage, p1, p2, tableNo: null,
      });
      created += 1;
    }
    return { created, byeName, advanced, bracket: 'L', stage };
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

  /*
   * 下一场可上场对阵的选择规则（与 generateMatchesIfNeeded 共用波次顺序）：
   * - 只考虑双方未被任何桌子占用的比赛；
   * - 败者组波次进行中时，只安排已就绪的 L，绝不插入下一波 W；
   * - 否则先安排 W，再安排已就绪的 L；
   * - 同一优先级内保持 pendingMatches 原顺序，不重排数组、不重写历史。
   * 返回索引，-1 表示当前没有可上场的比赛。
   *
   * 闸门未满足的 L 永远不进入兜底；W 也不会在 L 波次中途抢占空桌。
   * 两种组别因此不会同时出现在桌上，S1 也就不可能与 W2 并行。
   */
  W.selectNextPendingIndex = function selectNextPendingIndex(level, inUse) {
    const pending = Array.isArray(level.pendingMatches) ? level.pendingMatches : [];
    const used = inUse || new Set();
    const allowWinner = !hasActiveLoserWave(level);
    let fallback = -1;
    for (let i = 0; i < pending.length; i++) {
      const m = pending[i];
      if (!m || !m.p1 || !m.p2 || m.p1 === m.p2) continue;
      if (used.has(m.p1) || used.has(m.p2)) continue;
      if (m.bracket === 'W') {
        if (allowWinner) return i;
        continue;
      }
      // 只用阶段已满足的败者组兜底，绝不提前开打
      if (fallback === -1 && W.isLoserStageReady(level, m)) fallback = i;
    }
    return fallback;
  };

  W.fillTables = function fillTables(level) {
    for (const t of level.tables) {
      if (t.match) continue;
      const inUse = new Set();
      for (const tt of level.tables) { if (tt.match) { inUse.add(tt.match.p1); inUse.add(tt.match.p2); } }
      const idx = W.selectNextPendingIndex(level, inUse);
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
        wRound: level.wRound,
      }),
    });
    if (level.undoStack.length > 60) level.undoStack.shift();
  };

  function restoreSnapshot(level, snap) {
    level.players = snap.players; level.pendingMatches = snap.pendingMatches;
    level.tables = snap.tables; level.history = snap.history;
    level.finished = snap.finished; level.grandFinal = snap.grandFinal; level.banners = snap.banners;
    if (typeof snap.wRound === 'number') level.wRound = snap.wRound;
    // 旧快照没有 lStage 时从 dropRound 恢复，避免撤销后阶段闸门失去依据
    for (const p of Object.values(level.players || {})) {
      if (!Number.isFinite(p.lStage)) {
        p.lStage = Math.max(0, (p.dropRound || 1) - 1);
      }
    }
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
    level.history.push({
      id: uid(), at: now(), tableNo, bracket: match.bracket,
      p1: match.p1, p2: match.p2, winnerId, loserId,
      round: match.bracket === 'W' && Number.isFinite(match.round) ? match.round : null,
      stage: match.bracket === 'L' ? loserStageOf(level, match) : null,
    });
    if (match.bracket === 'W') {
      // 落入败者组：dropRound=r 表示下一场 L 属于第 r 阶段（W1 负者进 L1，
      // W2 负者进 L2），lStage 记录已经完成的阶段数。
      const round = Number.isFinite(match.round) ? match.round : (level.wRound || 1);
      l.dropRound = round;
      l.lStage = Math.max(0, round - 1);
      l.losses += 1;
      if (l.losses >= 2) W.eliminate(level, l.id); else l.bracket = 'L';
    }
    else if (match.bracket === 'L') {
      const stage = loserStageOf(level, match);
      w.lStage = Math.max(w.lStage || 0, stage);
      l.lStage = Math.max(l.lStage || 0, stage);
      l.losses += 1;
      if (l.losses >= 2) W.eliminate(level, l.id);
    }
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
    // 由 state 统一打上淘汰序号：同一毫秒内连续淘汰时名次仍然确定
    W.markEliminated(level, p);
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
    // 首轮固定为 W 第 1 轮；后续每批胜者组比赛轮次递增
    level.wRound = 1;
    // M3: banner 变量名统一
    level.banners = { top8Shown: false, top3Shown: false, gfShown: false };
    level.pendingMatches = []; level.history = []; level.undoStack = []; level.grandFinal = null;
    for (const p of Object.values(level.players)) {
      p.losses = 0; p.eliminatedAt = null; p.eliminatedSeq = null; p.dropRound = null;
      p.lStage = 0; p.placement = null; p.bracket = 'W';
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
      level.pendingMatches.push({ id: uid(), createdAt: now(), bracket: 'W', round: 1, p1: firstRound[i], p2: firstRound[i + 1], tableNo: null });
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
