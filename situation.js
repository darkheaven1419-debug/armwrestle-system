/* situation.js — 赛情位置图（只读展示，不参与配对/调度） */
(() => {
  'use strict';
  const W = window.WACAA || {};

  /*
   * Excel 模板的轮次列数（3-20 人表，来自 3-20人双败淘汰赛表格.xls）。
   * 这里只用它展示“当前人数对应的模板轮次”；真正的选手位置按
   * 引擎实际阶段展开，绝不根据模板反推对阵。
   */
  const TEMPLATE_ROUNDS = {
    3: 3, 4: 4, 5: 5, 6: 6, 7: 6, 8: 6,
    9: 7, 10: 7, 11: 7, 12: 7, 13: 7, 14: 7,
    15: 8, 16: 8, 17: 8, 18: 8, 19: 8, 20: 8,
  };

  function stageShape(capacity) {
    const cap = Math.max(0, Math.floor(capacity));
    return {
      capacity: cap,
      matches: Math.floor(cap / 2),
      byes: cap % 2,
      survivors: Math.ceil(cap / 2),
    };
  }

  /* 胜者组第 r 轮有 capacity 名选手；胜者进入下一轮，轮空不产生负者。 */
  function winnerStages(playerCount) {
    const out = [];
    let cap = Math.max(0, Math.floor(playerCount));
    while (cap > 1) {
      const shape = stageShape(cap);
      out.push({ stage: out.length + 1, ...shape });
      cap = shape.survivors;
    }
    return out;
  }

  /*
   * 败者组第 s 阶段：上一阶段幸存者 + 胜者组第 s 轮负者。
   * 人数为奇数时保留一个轮空位；轮空者直接进入下一阶段。
   */
  function loserStages(wStages) {
    const out = [];
    let survivors = 0;
    for (const ws of wStages) {
      const participants = survivors + Math.floor(ws.capacity / 2);
      if (participants <= 0) continue;
      const shape = stageShape(participants);
      out.push({ stage: out.length + 1, ...shape });
      survivors = shape.survivors;
    }
    while (survivors > 1) {
      const shape = stageShape(survivors);
      out.push({ stage: out.length + 1, ...shape });
      survivors = shape.survivors;
    }
    return out;
  }

  W.situationTemplate = function situationTemplate(playerCount) {
    const n = Number.isFinite(playerCount) ? Math.max(0, Math.floor(playerCount)) : 0;
    const wStages = winnerStages(n);
    const lStages = loserStages(wStages);
    return {
      n,
      supported: n >= 3 && n <= 20,
      templateRounds: TEMPLATE_ROUNDS[n] || null,
      wStages,
      lStages,
      stageColumns: Math.max(wStages.length, lStages.length),
    };
  };

  function drawOrderOf(level) {
    const players = level.players || {};
    const out = [];
    const seen = new Set();
    const add = (id) => {
      if (W.hasOwn(players, id) && !seen.has(id)) { seen.add(id); out.push(id); }
    };
    for (const id of Array.isArray(level.drawOrder) ? level.drawOrder : []) add(id);
    for (const id of Array.isArray(level.playerOrder) ? level.playerOrder : []) add(id);
    for (const id of Object.keys(players)) add(id);
    return out;
  }

  function numberMap(level) {
    const map = new Map();
    for (const id of drawOrderOf(level)) map.set(id, map.size + 1);
    return map;
  }

  function safeStage(value, max) {
    const limit = Math.max(1, max || 1);
    const n = Number.isFinite(value) ? Math.floor(value) : 1;
    return Math.max(1, Math.min(limit, n));
  }

  function liveMatchIndex(level) {
    const map = new Map();
    const remember = (m) => {
      if (!m) return;
      for (const id of [m.p1, m.p2]) if (id && !map.has(id)) map.set(id, m);
    };
    for (const t of level.tables || []) remember(t?.match);
    for (const m of level.pendingMatches || []) remember(m);
    return map;
  }

  function playerPosition(level, tpl, playerId, live) {
    const p = W.hasOwn(level.players, playerId) ? level.players[playerId] : null;
    if (!p) return null;
    if (p.bracket === 'L') {
      const match = live.get(playerId);
      const stage = match && match.bracket === 'L' && Number.isFinite(match.stage)
        ? match.stage
        : (Number.isFinite(p.lStage) ? p.lStage + 1 : Math.max(1, p.dropRound || 1));
      return { lane: 'L', stage: safeStage(stage, tpl.lStages.length) };
    }
    const match = live.get(playerId);
    let stage;
    if (match && match.bracket === 'W' && Number.isFinite(match.round)) {
      stage = match.round;
    } else {
      const wins = (level.history || []).filter((h) => h.bracket === 'W' && h.winnerId === playerId).length;
      const byes = (level.byes || []).filter((b) => b.bracket === 'W' && b.playerId === playerId).length;
      stage = wins + byes + 1;
    }
    return { lane: 'W', stage: safeStage(stage, tpl.wStages.length) };
  }

  function latestBye(level, playerId) {
    const list = (level.byes || []).filter((b) => b.playerId === playerId);
    return list.length ? list[list.length - 1] : null;
  }

  function byeApplies(lane, stage, bye) {
    if (!bye) return false;
    if (lane === 'W') return bye.bracket === 'W' && Number.isFinite(bye.round) && bye.round === stage - 1;
    return bye.bracket === 'L' && Number.isFinite(bye.stage) && bye.stage === stage - 1;
  }

  function positionLabel(lane, stage) {
    return lane === 'L' ? `败者组第${stage}阶段` : `胜者组第${stage}轮`;
  }

  function makeColumns(defs) {
    return defs.map((d) => ({
      ...d,
      slots: new Array(Math.max(0, d.capacity)).fill(null),
    }));
  }

  function addToColumn(column, card) {
    const idx = column.slots.findIndex((x) => x === null);
    if (idx >= 0) column.slots[idx] = card;
    else column.slots.push(card);
  }

  function cardFor(level, p, no, pos, opts) {
    const options = opts || {};
    const bye = options.allowBye === false ? null : latestBye(level, p.id);
    const showBye = byeApplies(pos.lane, pos.stage, bye);
    return {
      id: p.id,
      name: p.name,
      no,
      losses: p.losses,
      bracket: pos.lane,
      stage: pos.stage,
      positionLabel: positionLabel(pos.lane, pos.stage),
      current: !!options.current,
      result: options.result || null,
      eliminated: !!(p.eliminatedAt || p.losses >= 2),
      eliminatedHere: false,
      bye: showBye ? { bracket: bye.bracket, round: bye.round, stage: bye.stage } : null,
    };
  }

  function currentMatch(level, numbers) {
    if (!level.started || level.finished) return null;
    const tables = (level.tables || []).filter((t) => t?.match).sort((a, b) => a.tableNo - b.tableNo);
    if (tables.length) {
      const t = tables[0];
      const m = t.match;
      const label = m.bracket === 'L'
        ? `败者组第${m.stage || 1}阶段`
        : `胜者组第${m.round || 1}轮`;
      const one = (id) => {
        const p = W.hasOwn(level.players, id) ? level.players[id] : null;
        return p ? { id, name: p.name, no: numbers.get(id) || null, losses: p.losses, positionLabel: label } : null;
      };
      const p1 = one(m.p1), p2 = one(m.p2);
      if (!p1 || !p2) return null;
      return {
        source: 'table', matchId: m.id, tableNo: t.tableNo, bracket: m.bracket,
        round: m.bracket === 'W' ? (m.round || 1) : null,
        stage: m.bracket === 'L' ? (m.stage || 1) : null,
        label, extraLive: tables.length - 1, p1, p2,
      };
    }
    const gf = level.grandFinal;
    if (gf && !gf.completed) {
      const one = (id) => {
        const p = W.hasOwn(level.players, id) ? level.players[id] : null;
        // 已退赛/淘汰的决赛选手不能再显示为“当前总决赛参赛者”。
        if (!p || p.losses >= 2 || p.eliminatedAt) return null;
        return { id, name: p.name, no: numbers.get(id) || null, losses: p.losses, positionLabel: '总决赛' };
      };
      const p1 = one(gf.p1), p2 = one(gf.p2);
      if (!p1 || !p2) return null;
      return {
        source: 'grandFinal', matchId: null, tableNo: null, bracket: 'GF',
        round: null, stage: null, label: '总决赛 · BO3',
        wins1: gf.wins1 || 0, wins2: gf.wins2 || 0, extraLive: 0, p1, p2,
      };
    }
    return null;
  }

  function drawRows(level, ids, numbers, currentIds, gfIds, placedLabels) {
    const rows = [];
    for (const id of ids) {
      const p = W.hasOwn(level.players, id) ? level.players[id] : null;
      if (!p) continue;
      let status = 'winner';
      let label = level.started ? '胜者组' : '赛前';
      const gf = level.grandFinal;
      const gfStillPlaying = !p.eliminatedAt && p.losses < 2;
      if (gfIds.has(id) && (gf?.completed || gfStillPlaying)) {
        status = gf?.completed ? 'finished' : 'grandFinal';
        label = '总决赛';
      } else if (p.eliminatedAt || p.losses >= 2) {
        status = 'eliminated';
        label = Number.isInteger(p.placement) ? W.rankingLabel(p.placement) : '已淘汰';
      } else if (currentIds.has(id)) {
        status = 'current';
        label = '当前比赛';
      } else if (p.bracket === 'L') {
        status = 'loser';
        label = '败者组';
      }
      if (placedLabels.has(id)) label = placedLabels.get(id);
      rows.push({
        no: level.started ? (numbers.get(id) || null) : null,
        playerId: id,
        name: p.name,
        status,
        label,
        losses: p.losses,
      });
    }
    return rows;
  }

  function eliminatedRows(level, numbers, excludeIds) {
    return Object.values(level.players || {})
      .filter((p) => (p.eliminatedAt || p.losses >= 2) && !(excludeIds && excludeIds.has(p.id)))
      .sort((a, b) => {
        const pa = Number.isInteger(a.placement) ? a.placement : Infinity;
        const pb = Number.isInteger(b.placement) ? b.placement : Infinity;
        if (pa !== pb) return pa - pb;
        return (a.eliminatedSeq || 0) - (b.eliminatedSeq || 0);
      })
      .map((p) => ({
        id: p.id,
        name: p.name,
        no: numbers.get(p.id) || null,
        losses: p.losses,
        placement: Number.isInteger(p.placement) ? p.placement : null,
        label: Number.isInteger(p.placement) ? W.rankingLabel(p.placement) : '已淘汰',
      }));
  }

  function byeRows(level, numbers) {
    return (level.byes || [])
      .filter((b) => W.hasOwn(level.players, b.playerId))
      .map((b) => ({
        playerId: b.playerId,
        name: level.players[b.playerId].name,
        no: numbers.get(b.playerId) || null,
        bracket: b.bracket,
        round: b.round,
        stage: b.stage,
        label: b.bracket === 'L'
          ? `败者组第${b.stage || 1}阶段轮空晋级`
          : `胜者组第${b.round || 1}轮轮空晋级`,
        advanceLabel: b.bracket === 'L'
          ? `进入败者组第${(b.stage || 1) + 1}阶段`
          : `进入胜者组第${(b.round || 1) + 1}轮`,
        at: b.at,
      }))
      .sort((a, b) => (a.at || 0) - (b.at || 0));
  }

  /*
   * 只读视图模型：
   * - draw：固定编号 1..N 与选手；
   * - wStages/lStages：每阶段的位置槽位，空槽由界面显示「待定」；
   * - current：当前级别唯一一场进行中比赛（按桌号取第一场）；
   * - eliminated / rankings / byes：淘汰、最终排名与轮空记录。
   * 不生成或猜测任何对阵；名次沿用既有 getRankingView 计算（会刷新
   * placement，与排名页一致），不修改比赛记录、抽签或轮空。
   */
  W.buildSituation = function buildSituation(level) {
    const safeLevel = level || { players: {} };
    const tpl = W.situationTemplate(Object.keys(safeLevel.players || {}).length);
    const numbers = numberMap(safeLevel);
    const ids = drawOrderOf(safeLevel);
    const live = liveMatchIndex(safeLevel);
    const gf = safeLevel.grandFinal;
    const gfIds = new Set(gf ? [gf.p1, gf.p2] : []);
    const current = currentMatch(safeLevel, numbers);
    const currentIds = new Set(current ? [current.p1.id, current.p2.id] : []);
    // 先按既有规则计算名次，后面的淘汰区才能直接沿用确定好的 placement。
    const rankings = W.getRankingView(safeLevel);
    const wStages = makeColumns(tpl.wStages);
    const lStages = makeColumns(tpl.lStages);
    const placedLabels = new Map();
    const placedStageKeys = new Set();

    function placeCard(lane, stage, playerId, result, options) {
      const cols = lane === 'W' ? wStages : lStages;
      const col = cols[stage - 1];
      const p = W.hasOwn(safeLevel.players, playerId) ? safeLevel.players[playerId] : null;
      if (!col || !p) return null;
      const key = `${lane}:${stage}:${playerId}`;
      if (placedStageKeys.has(key)) return null;
      placedStageKeys.add(key);
      const card = cardFor(safeLevel, p, numbers.get(playerId) || null, { lane, stage }, {
        ...(options || {}),
        result,
      });
      addToColumn(col, card);
      return card;
    }

    function stageOfMatch(match) {
      if (match.bracket === 'W' && Number.isFinite(match.round)) return match.round;
      if (match.bracket === 'L' && Number.isFinite(match.stage)) return match.stage;
      return null;
    }

    if (safeLevel.started) {
      /*
       * 已结束的比赛保留在当时发生的阶段里，作为“已确定的位置”；
       * 选手继续前进时，新位置由下面的待赛/当前比赛或当前位置补齐。
       * 这样旧轮次不会因为选手晋级而变回“待定”。
       */
      const lastLossCards = new Map();
      for (const h of safeLevel.history || []) {
        if (h.bracket !== 'W' && h.bracket !== 'L') continue;
        const stage = h.bracket === 'W' ? h.round : h.stage;
        if (!Number.isFinite(stage) || stage < 1) continue;
        const c1 = placeCard(h.bracket, stage, h.p1, h.p1 === h.winnerId ? 'win' : 'loss', { allowBye: false });
        const c2 = placeCard(h.bracket, stage, h.p2, h.p2 === h.winnerId ? 'win' : 'loss', { allowBye: false });
        const loserCard = h.p1 === h.loserId ? c1 : c2;
        if (loserCard) lastLossCards.set(h.loserId, loserCard);
      }
      for (const [loserId, card] of lastLossCards) {
        const p = W.hasOwn(safeLevel.players, loserId) ? safeLevel.players[loserId] : null;
        if (p && (p.eliminatedAt || p.losses >= 2)) card.eliminatedHere = true;
      }

      // 已生成但尚未结束的比赛：桌上为进行中，候场为待赛。
      const activeMatches = [];
      for (const t of safeLevel.tables || []) {
        if (t?.match) activeMatches.push({ match: t.match, live: true });
      }
      for (const m of safeLevel.pendingMatches || []) {
        activeMatches.push({ match: m, live: false });
      }
      for (const item of activeMatches) {
        const m = item.match;
        const stage = stageOfMatch(m);
        if (stage == null) continue;
        placeCard(m.bracket, stage, m.p1, item.live ? 'live' : 'waiting', {
          allowBye: false,
          current: item.live && currentIds.has(m.p1),
        });
        placeCard(m.bracket, stage, m.p2, item.live ? 'live' : 'waiting', {
          allowBye: false,
          current: item.live && currentIds.has(m.p2),
        });
      }

      // 没有正在/待赛对阵的存活选手（例如轮空晋级、等待下一阶段）补当前位置。
      const ordered = ids.slice().sort((a, b) => (numbers.get(a) || 0) - (numbers.get(b) || 0));
      for (const id of ordered) {
        const p = W.hasOwn(safeLevel.players, id) ? safeLevel.players[id] : null;
        if (!p) continue;
        if (p.eliminatedAt || p.losses >= 2 || gfIds.has(id)) continue;
        const pos = playerPosition(safeLevel, tpl, id, live);
        if (!pos) continue;
        placedLabels.set(id, positionLabel(pos.lane, pos.stage));
        placeCard(pos.lane, pos.stage, id, 'waiting', { allowBye: true });
      }
    }

    return {
      n: tpl.n,
      template: tpl,
      started: !!safeLevel.started,
      finished: !!safeLevel.finished,
      wStages,
      lStages,
      draw: drawRows(safeLevel, ids, numbers, currentIds, gfIds, placedLabels),
      current,
      byes: byeRows(safeLevel, numbers),
      eliminated: eliminatedRows(safeLevel, numbers, gfIds),
      grandFinal: gf ? {
        p1: gf.p1, p2: gf.p2,
        name1: (W.hasOwn(safeLevel.players, gf.p1) ? safeLevel.players[gf.p1].name : '') || '',
        name2: (W.hasOwn(safeLevel.players, gf.p2) ? safeLevel.players[gf.p2].name : '') || '',
        no1: numbers.get(gf.p1) || null,
        no2: numbers.get(gf.p2) || null,
        wins1: gf.wins1 || 0,
        wins2: gf.wins2 || 0,
        completed: !!gf.completed,
        winnerId: gf.winnerId || null,
        runnerUpId: gf.runnerUpId || null,
        label: gf.completed ? '总决赛已结束' : '总决赛 · BO3 三局两胜',
      } : null,
      rankings,
    };
  };

  /* ==================== 横向位置图布局（只读，不参与配对） ==================== */
  const SX = Object.freeze({
    pad: 18,
    entryGap: 34,
    matchW: 184,
    colGap: 30,
    laneGap: 36,
    top: 52,
    minScale: 0.6,
    maxScale: 1.8,
    // 默认适应屏幕，但不为了塞进屏幕把姓名缩到不可读。
    fitFloor: 0.7,
  });

  function sxColX(col, entryX) {
    return entryX + SX.entryGap + (col - 1) * (SX.matchW + SX.colGap);
  }

  function sxMatchStage(m) {
    if (!m) return null;
    if (m.bracket === 'W') return Number.isFinite(m.round) ? Math.max(1, Math.floor(m.round)) : null;
    if (m.bracket === 'L') return Number.isFinite(m.stage) ? Math.max(1, Math.floor(m.stage)) : null;
    return null;
  }

  function sxCollectMatches(level) {
    const map = new Map();
    const add = (m, status, tableNo) => {
      if (!m || !m.id || map.has(m.id)) return;
      const stage = sxMatchStage(m);
      if (!stage) return;
      map.set(m.id, {
        id: m.id,
        bracket: m.bracket,
        stage,
        p1: m.p1,
        p2: m.p2,
        status,
        tableNo: tableNo != null ? tableNo : (m.tableNo != null ? m.tableNo : null),
        winnerId: m.winnerId || null,
        loserId: m.loserId || null,
      });
    };
    for (const h of level.history || []) add(h, 'done', h.tableNo);
    for (const t of level.tables || []) if (t && t.match) add(t.match, 'live', t.tableNo);
    for (const m of level.pendingMatches || []) add(m, 'waiting', m.tableNo);
    return Array.from(map.values());
  }

  function sxResultOf(match, playerId) {
    if (!match) return null;
    if (match.status === 'done') return match.winnerId === playerId ? 'win' : (match.loserId === playerId ? 'loss' : null);
    if (match.status === 'live') return 'live';
    return 'waiting';
  }

  function sxEdgePath(x1, y1, x2, y2) {
    const dy = Math.abs(y2 - y1);
    if (dy < 1) return `M${x1},${y1} H${x2}`;
    const midX = x1 + Math.max(14, Math.min(70, (x2 - x1) * 0.5));
    return `M${x1},${y1} H${midX} V${y2} H${x2}`;
  }

  /*
   * 位置图模型：
   * - 每个引擎阶段一列，胜者组在上、败者组在下；
   * - 阶段内的位置按实际对阵顺序排列，空位显示「待定」；
   * - 连线只连接真实发生过的晋级/落败流转；没有发生的对阵绝不补线；
   * - 模板轮次只用于顶部说明，不反向生成对阵。
   */
  W.buildSituationLayout = function buildSituationLayout(level) {
    const safeLevel = level || { players: {} };
    const tpl = W.situationTemplate(Object.keys(safeLevel.players || {}).length);
    if (!tpl.supported) {
      return {
        supported: false,
        n: tpl.n,
        template: tpl,
        message: '当前赛情功能仅支持3～20名选手',
      };
    }

    const n = tpl.n;
    const numbers = numberMap(safeLevel);
    const entriesIds = drawOrderOf(safeLevel);
    const current = currentMatch(safeLevel, numbers);
    const currentIds = new Set(current ? [current.p1.id, current.p2.id] : []);
    const rankings = W.getRankingView(safeLevel) || [];
    const rankById = new Map(rankings.map((r) => [r.playerId, r]));
    const gf = safeLevel.grandFinal;
    const gfIds = new Set(gf ? [gf.p1, gf.p2] : []);

    // 小人数时放大行距和卡片，让位置图真正铺满屏幕，而不是缩在左上角。
    const rowSteps = { 3: 190, 4: 165, 5: 190, 6: 170, 7: 140, 8: 120, 9: 130, 10: 118, 11: 100, 12: 88, 13: 88, 14: 80, 15: 74 };
    const rowStep = n >= 18 ? 62 : n >= 16 ? 64 : (rowSteps[n] || 78);
    const matchH = Math.min(104, Math.max(54, rowStep - 12));
    const seatH = matchH / 2;
    const wRows = Math.max(1, tpl.wStages[0] ? tpl.wStages[0].matches : 0);
    const lRows = Math.max(1, ...tpl.lStages.map((s) => s.matches));
    const wLaneTop = SX.top;
    const wLaneH = wRows * rowStep;
    const lLaneTop = wLaneTop + wLaneH + SX.laneGap;
    const lLaneH = lRows * rowStep;
    const laneBottom = lLaneTop + lLaneH;
    const entryX = SX.pad;
    const wCount = tpl.wStages.length;
    const lCount = tpl.lStages.length;
    const gfCol = Math.max(wCount, lCount + 1) + 1;
    const gfW = SX.matchW + 22;
    // 左侧名单按整张图宽度约 22% 分配，同时限制上限，避免吞掉比赛位置图。
    const colSpan = (gfCol - 1) * (SX.matchW + SX.colGap) + gfW + SX.pad;
    const entryW = Math.max(300, Math.min(520, Math.round((SX.entryGap + SX.pad * 2 + colSpan) * 0.28)));
    const entryRight = entryX + entryW;
    const firstColX = sxColX(1, entryRight);
    const gfX = sxColX(gfCol, entryRight);
    const width = gfX + gfW + SX.pad;
    const height = laneBottom + SX.pad;

    const matches = sxCollectMatches(safeLevel);
    const byStage = new Map();
    for (const m of matches) {
      const key = `${m.bracket}:${m.stage}`;
      if (!byStage.has(key)) byStage.set(key, []);
      byStage.get(key).push(m);
    }
    const sortKey = (m) => {
      const a = numbers.get(m.p1) || 999;
      const b = numbers.get(m.p2) || 999;
      return Math.min(a, b) * 1000 + Math.max(a, b);
    };
    for (const list of byStage.values()) list.sort((a, b) => sortKey(a) - sortKey(b));

    function makeSeat(playerId, result, matchId, lane, stage) {
      if (!playerId) return null;
      const p = W.hasOwn(safeLevel.players, playerId) ? safeLevel.players[playerId] : null;
      if (!p) return null;
      const rank = rankById.get(playerId);
      const isCurrent = !!current && (
        (current.source === 'grandFinal' && currentIds.has(playerId)) ||
        (current.matchId && matchId === current.matchId && currentIds.has(playerId))
      );
      const placementLabel = rank && rank.status === 'decided'
        ? rank.label
        : (Number.isInteger(p.placement) ? W.rankingLabel(p.placement) : '');
      return {
        id: playerId,
        no: numbers.get(playerId) || null,
        name: p.name,
        losses: Number.isFinite(p.losses) ? p.losses : 0,
        bracket: lane,
        stage,
        result,
        current: isCurrent,
        eliminated: !!(p.eliminatedAt || p.losses >= 2),
        placement: Number.isInteger(p.placement) ? p.placement : null,
        placementLabel: placementLabel || '',
        x: 0, y: 0, w: 0, h: 0, cy: 0,
      };
    }

    function buildLane(lane, defs, laneTop, laneH) {
      return defs.map((st) => {
        const list = byStage.get(`${lane}:${st.stage}`) || [];
        const count = Math.max(st.matches, list.length, 1);
        const col = lane === 'W' ? st.stage : st.stage + 1;
        const x = sxColX(col, entryRight);
        const nodes = [];
        for (let i = 0; i < count; i += 1) {
          const m = list[i] || null;
          const cy = laneTop + laneH * ((i + 0.5) / count);
          const node = {
            kind: 'match',
            lane,
            stage: st.stage,
            col,
            x,
            y: cy - matchH / 2,
            w: SX.matchW,
            h: matchH,
            seatH,
            matchId: m ? m.id : null,
            status: m ? m.status : 'empty',
            tableNo: m ? m.tableNo : null,
            current: !!(current && current.matchId && m && current.matchId === m.id),
            p1: null,
            p2: null,
          };
          const one = (slot, id) => {
            const seat = makeSeat(id, sxResultOf(m, id), m ? m.id : null, lane, st.stage);
            if (!seat) return null;
            seat.x = node.x;
            seat.y = node.y + slot * seatH;
            seat.w = node.w;
            seat.h = seatH;
            seat.cy = seat.y + seatH / 2;
            return seat;
          };
          node.p1 = one(0, m ? m.p1 : null);
          node.p2 = one(1, m ? m.p2 : null);
          nodes.push(node);
        }
        return nodes;
      });
    }

    const wNodes = buildLane('W', tpl.wStages, wLaneTop, wLaneH);
    const lNodes = buildLane('L', tpl.lStages, lLaneTop, lLaneH);
    const allSeats = [];
    for (const stageNodes of wNodes.concat(lNodes)) {
      for (const node of stageNodes) {
        if (node.p1) allSeats.push(node.p1);
        if (node.p2) allSeats.push(node.p2);
      }
    }

    const wFinal = wNodes.length ? wNodes[wNodes.length - 1][0] : null;
    const lFinal = lNodes.length ? lNodes[lNodes.length - 1][0] : null;
    const wFinalCy = wFinal ? wFinal.y + wFinal.h / 2 : null;
    const lFinalCy = lFinal ? lFinal.y + lFinal.h / 2 : null;
    const gfH = matchH + 24;
    const gfCy = wFinalCy != null && lFinalCy != null
      ? (wFinalCy + lFinalCy) / 2
      : (wLaneTop + laneBottom) / 2;
    const gfY = Math.max(wLaneTop, Math.min(laneBottom - gfH, gfCy - gfH / 2));
    const gfSeats = [];
    if (gf) {
      const one = (slot, id) => {
        if (!id) return null;
        const p = W.hasOwn(safeLevel.players, id) ? safeLevel.players[id] : null;
        if (!p) return null;
        const out = p.eliminatedAt || p.losses >= 2;
        const result = gf.completed
          ? (gf.winnerId === id ? 'win' : 'loss')
          : (out ? 'loss' : 'live');
        const seat = makeSeat(id, result, null, 'GF', 1);
        if (!seat) return null;
        seat.x = gfX;
        seat.y = gfY + 24 + slot * seatH;
        seat.w = gfW;
        seat.h = seatH;
        seat.cy = seat.y + seatH / 2;
        return seat;
      };
      gfSeats.push(one(0, gf.p1), one(1, gf.p2));
    }
    for (const seat of gfSeats) if (seat) allSeats.push(seat);

    const gfNode = {
      kind: 'grandFinal',
      x: gfX,
      y: gfY,
      w: gfW,
      h: gfH,
      seatH,
      status: gf ? ((gf.completed || gf.needsManual || safeLevel.finished) ? 'done' : 'live') : 'empty',
      current: !!(current && current.source === 'grandFinal'),
      completed: !!(gf && gf.completed),
      label: gf ? '总决赛 · BO3' : '总决赛',
      wins1: gf ? (gf.wins1 || 0) : 0,
      wins2: gf ? (gf.wins2 || 0) : 0,
      p1: gfSeats[0] || null,
      p2: gfSeats[1] || null,
    };

    // 划线只基于真实出现过的位置：胜者继续 → 实线；落入败者组 → 虚线。
    const byPlayer = new Map();
    for (const seat of allSeats) {
      if (!byPlayer.has(seat.id)) byPlayer.set(seat.id, []);
      byPlayer.get(seat.id).push(seat);
    }
    const orderOf = (seat) => {
      if (seat.bracket === 'GF') return 1000;
      if (seat.bracket === 'W') return seat.stage * 2;
      return 500 + seat.stage * 2;
    };
    const edges = [];
    for (const list of byPlayer.values()) {
      list.sort((a, b) => orderOf(a) - orderOf(b));
      for (let i = 0; i < list.length - 1; i += 1) {
        const from = list[i];
        const to = list[i + 1];
        if (from.result === 'win') {
          edges.push({
            kind: 'advance',
            x1: from.x + from.w,
            y1: from.cy,
            x2: to.x,
            y2: to.cy,
            d: sxEdgePath(from.x + from.w, from.cy, to.x, to.cy),
          });
        } else if (from.result === 'loss' && to.bracket === 'L') {
          edges.push({
            kind: 'drop',
            x1: from.x + from.w,
            y1: from.cy,
            x2: to.x,
            y2: to.cy,
            d: sxEdgePath(from.x + from.w, from.cy, to.x, to.cy),
          });
        }
      }
    }

    const headers = [];
    const byesFor = (lane, stage) => (safeLevel.byes || [])
      .filter((b) => b && b.bracket === lane && (lane === 'W' ? b.round === stage : b.stage === stage))
      .map((b) => {
        const p = W.hasOwn(safeLevel.players, b.playerId) ? safeLevel.players[b.playerId] : null;
        return {
          playerId: b.playerId,
          no: numbers.get(b.playerId) || null,
          name: p ? p.name : '未知选手',
        };
      });
    for (const st of tpl.wStages) {
      headers.push({
        lane: 'W', stage: st.stage,
        x: firstColX + (st.stage - 1) * (SX.matchW + SX.colGap),
        y: wLaneTop - 32,
        w: SX.matchW,
        label: `胜者组第${st.stage}轮`,
        byes: byesFor('W', st.stage),
      });
    }
    for (const st of tpl.lStages) {
      headers.push({
        lane: 'L', stage: st.stage,
        x: firstColX + st.stage * (SX.matchW + SX.colGap),
        y: lLaneTop - 32,
        w: SX.matchW,
        label: `败者组第${st.stage}阶段`,
        byes: byesFor('L', st.stage),
      });
    }

    const lastWCol = wCount;
    const lastLCol = lCount + 1;
    edges.push({
      kind: 'flow',
      x1: firstColX,
      y1: wLaneTop + wLaneH + 20,
      x2: sxColX(lastWCol, entryRight) + SX.matchW,
      y2: wLaneTop + wLaneH + 20,
      d: sxEdgePath(firstColX, wLaneTop + wLaneH + 20, sxColX(lastWCol, entryRight) + SX.matchW, wLaneTop + wLaneH + 20),
    });
    edges.push({
      kind: 'flow',
      x1: firstColX,
      y1: laneBottom + 14,
      x2: sxColX(lastLCol, entryRight) + SX.matchW,
      y2: laneBottom + 14,
      d: sxEdgePath(firstColX, laneBottom + 14, sxColX(lastLCol, entryRight) + SX.matchW, laneBottom + 14),
    });

    // 名单贯穿整张图的高度，优先给姓名和状态留出足够行高。
    const rosterTop = wLaneTop;
    const rosterH = laneBottom - wLaneTop;
    const entryPitch = Math.max(30, rosterH / Math.max(1, n));
    const entryH = Math.min(72, Math.max(28, entryPitch - 2));
    const entryStart = rosterTop + Math.max(0, (entryPitch - entryH) / 2);
    const entries = entriesIds.map((id, i) => {
      const p = W.hasOwn(safeLevel.players, id) ? safeLevel.players[id] : null;
      if (!p) return null;
      const rank = rankById.get(id);
      let statusLabel = '赛前';
      if (gfIds.has(id)) {
        statusLabel = gf && (gf.completed || gf.needsManual)
          ? (gf.needsManual ? '总决赛未决' : '总决赛结束')
          : '总决赛';
      } else if (p.eliminatedAt || p.losses >= 2) statusLabel = rank && rank.status === 'decided' ? `${rank.label} · 淘汰` : '已淘汰';
      else if (currentIds.has(id)) statusLabel = '当前比赛';
      else if (safeLevel.started) statusLabel = p.bracket === 'L' ? '败者组' : '胜者组';
      return {
        id,
        no: safeLevel.started ? (numbers.get(id) || null) : null,
        name: p.name,
        losses: Number.isFinite(p.losses) ? p.losses : 0,
        statusLabel,
        current: currentIds.has(id),
        eliminated: !!(p.eliminatedAt || p.losses >= 2),
        x: entryX,
        y: entryStart + i * entryPitch,
        w: entryW,
        h: entryH,
      };
    });

    const rankRows = rankings.map((r) => ({
      place: r.place,
      label: r.label,
      name: r.status === 'decided' ? r.name : '未决出',
      status: r.status,
      losses: r.losses,
    }));

    return {
      supported: true,
      n,
      template: tpl,
      width,
      height,
      top: wLaneTop,
      wLaneTop,
      wLaneH,
      lLaneTop,
      lLaneH,
      laneBottom,
      entryX,
      entryW,
      rosterTop,
      rosterH,
      pad: SX.pad,
      matchW: SX.matchW,
      seatH,
      colX: (c) => sxColX(c, entryRight),
      wNodes,
      lNodes,
      gf: gfNode,
      headers,
      entries,
      edges,
      // 排名数据继续保留，主图不再为独立排名栏预留空间。
      rank: {
        hidden: true,
        rows: rankRows,
        total: n,
      },
      current,
      currentIds: Array.from(currentIds),
      rankings,
      minScale: SX.minScale,
      maxScale: SX.maxScale,
      fitFloor: SX.fitFloor,
    };
  };

  window.WACAA = W;
})();
