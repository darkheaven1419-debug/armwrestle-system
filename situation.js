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
      if (players[id] && !seen.has(id)) { seen.add(id); out.push(id); }
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
    const p = level.players?.[playerId];
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
        const p = level.players?.[id];
        return p ? { id, name: p.name, no: numbers.get(id) || null, losses: p.losses, positionLabel: label } : null;
      };
      const p1 = one(m.p1), p2 = one(m.p2);
      if (!p1 || !p2) return null;
      return {
        source: 'table', tableNo: t.tableNo, bracket: m.bracket,
        round: m.bracket === 'W' ? (m.round || 1) : null,
        stage: m.bracket === 'L' ? (m.stage || 1) : null,
        label, extraLive: tables.length - 1, p1, p2,
      };
    }
    const gf = level.grandFinal;
    if (gf && !gf.completed) {
      const one = (id) => {
        const p = level.players?.[id];
        return p ? { id, name: p.name, no: numbers.get(id) || null, losses: p.losses, positionLabel: '总决赛' } : null;
      };
      const p1 = one(gf.p1), p2 = one(gf.p2);
      if (!p1 || !p2) return null;
      return {
        source: 'grandFinal', tableNo: null, bracket: 'GF',
        round: null, stage: null, label: '总决赛 · BO3',
        wins1: gf.wins1 || 0, wins2: gf.wins2 || 0, extraLive: 0, p1, p2,
      };
    }
    return null;
  }

  function drawRows(level, ids, numbers, currentIds, gfIds, placedLabels) {
    const rows = [];
    for (const id of ids) {
      const p = level.players?.[id];
      if (!p) continue;
      let status = 'winner';
      let label = level.started ? '胜者组' : '赛前';
      if (gfIds.has(id)) {
        status = level.grandFinal?.completed ? 'finished' : 'grandFinal';
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
      .filter((b) => level.players?.[b.playerId])
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
      const p = safeLevel.players?.[playerId];
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
        const p = safeLevel.players?.[loserId];
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
        const p = safeLevel.players?.[id];
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
        name1: safeLevel.players?.[gf.p1]?.name || '',
        name2: safeLevel.players?.[gf.p2]?.name || '',
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

  window.WACAA = W;
})();
