'use strict';

/*
 * 双败赛制“阶段波次”回归测试。
 *
 * 目标顺序（9 人）：W1 → W2 → L1 → W3 → L2 → W4 → L3 → L4 → L5 → 总决赛。
 * 规则不是“有可开赛的 W 就优先”，而是：
 * - 当前 W 波次全部结束前，不得开 L；
 * - 当前 L 阶段全部结束前，不得生成下一轮 W；
 * - 相同波次可以在多张桌子上并行，但不能跨波次并行。
 *
 * 所有完整模拟都从真实的首轮发牌开始，不预先构造排好的队列。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, makeLevel, startLevel } = require('./harness');

function names(level, ids) {
  return ids.map((id) => level.players[id]?.name || id);
}

function liveMatches(level) {
  return [
    ...level.pendingMatches,
    ...level.tables.filter((t) => t.match).map((t) => t.match),
  ];
}

function liveByBracket(level, bracket) {
  return liveMatches(level).filter((m) => m && m.bracket === bracket);
}

function keyOf(bracket, round, stage) {
  return bracket === 'W' ? `W:${round}` : `L:${stage}`;
}

/* 包住引擎入口，记录每次真实分配、结算和不变式检查。 */
function attachRecorder(W) {
  const events = [];
  const originalGenerate = W.generateMatchesIfNeeded;
  const originalFill = W.fillTables;
  const originalResolve = W.resolveMatch;

  W.generateMatchesIfNeeded = function recordedGenerate(level) {
    const result = originalGenerate(level);
    for (const evt of result || []) {
      events.push({
        type: 'engine',
        event: evt.type,
        bracket: evt.bracket || null,
        count: evt.count || 0,
        name: evt.name || null,
      });
    }
    const w = liveByBracket(level, 'W');
    const l = liveByBracket(level, 'L');
    if (w.length && l.length) {
      events.push({
        type: 'violation',
        kind: 'overlapAfterGenerate',
        w: w.map((m) => ({ id: m.id, round: m.round })),
        l: l.map((m) => ({ id: m.id, stage: m.stage })),
      });
    }
    return result;
  };

  W.fillTables = function recordedFill(level) {
    const view = W.getMatchupView(level);
    const beforeTableIds = new Set(level.tables.filter((t) => t.match).map((t) => t.match.id));
    const beforeLive = liveMatches(level).map((m) => ({
      id: m.id, bracket: m.bracket, round: m.round, stage: m.stage, p1: m.p1, p2: m.p2,
    }));
    originalFill(level);

    const assigned = [];
    for (const t of level.tables) {
      if (!t.match || beforeTableIds.has(t.match.id)) continue;
      const m = t.match;
      assigned.push({
        id: m.id, tableNo: t.tableNo, bracket: m.bracket,
        round: m.round ?? null, stage: m.stage ?? null, p1: m.p1, p2: m.p2,
      });
      events.push({
        type: 'start',
        id: m.id,
        tableNo: t.tableNo,
        bracket: m.bracket,
        round: m.round ?? null,
        stage: m.stage ?? null,
        p1: m.p1,
        p2: m.p2,
        p1Name: names(level, [m.p1])[0],
        p2Name: names(level, [m.p2])[0],
        p1Drop: level.players[m.p1]?.dropRound ?? null,
        p2Drop: level.players[m.p2]?.dropRound ?? null,
        p1LStage: level.players[m.p1]?.lStage ?? null,
        p2LStage: level.players[m.p2]?.lStage ?? null,
      });
    }
    events.push({
      type: 'fill',
      assigned: assigned.map((a) => ({ ...a })),
      viewNext: view.next ? view.next.matchId : null,
      viewStatus: view.nextStatus,
    });

    if (assigned.length && view.nextStatus === 'ready' && view.next
      && assigned[0].id !== view.next.matchId) {
      events.push({
        type: 'violation',
        kind: 'nextViewMismatch',
        engineNext: assigned[0].id,
        viewNext: view.next.matchId,
      });
    }

    // 任何时刻都不允许 W 与 L 同时处于“候场/桌上”
    const w = liveByBracket(level, 'W');
    const l = liveByBracket(level, 'L');
    if (w.length && l.length) {
      events.push({
        type: 'violation',
        kind: 'overlapAfterFill',
        w: w.map((m) => ({ id: m.id, round: m.round })),
        l: l.map((m) => ({ id: m.id, stage: m.stage })),
      });
    }

    // 同一选手不能同时出现在两场未完成比赛里
    const seen = new Set();
    for (const m of liveMatches(level)) {
      for (const id of [m.p1, m.p2]) {
        if (!id) continue;
        if (seen.has(id)) {
          events.push({ type: 'violation', kind: 'doubleBooked', playerId: id });
        }
        seen.add(id);
      }
    }

    // L 开打时，对应波次的 W 必须已经全部完成
    for (const a of assigned) {
      if (a.bracket !== 'L' || !Number.isFinite(a.stage)) continue;
      const blockers = beforeLive.filter((m) => m.bracket === 'W'
        && (typeof m.round !== 'number' || !Number.isFinite(m.round) || m.round <= a.stage + 1));
      if (blockers.length) {
        events.push({
          type: 'violation',
          kind: 'earlyLoserMatch',
          matchId: a.id,
          stage: a.stage,
          tableNo: a.tableNo,
          blockers,
        });
      }
    }

    return undefined;
  };

  W.resolveMatch = function recordedResolve(level, tableNo, winnerId) {
    const table = level.tables.find((t) => t.tableNo === tableNo);
    const match = table && table.match;
    const result = originalResolve(level, tableNo, winnerId);
    if (match) {
      const loserId = match.p1 === winnerId ? match.p2 : match.p1;
      events.push({
        type: 'resolve',
        id: match.id,
        tableNo,
        bracket: match.bracket,
        round: match.round ?? null,
        stage: match.stage ?? null,
        p1: match.p1,
        p2: match.p2,
        winnerId,
        loserId,
      });
    }
    return result;
  };

  return {
    events,
    restore() {
      W.generateMatchesIfNeeded = originalGenerate;
      W.fillTables = originalFill;
      W.resolveMatch = originalResolve;
    },
  };
}

/* 按真实界面顺序推进：生成 -> 填桌 -> 结算一场。 */
function advance(W, level, schedule, options) {
  const opts = options || {};
  W.generateMatchesIfNeeded(level);
  W.fillTables(level);
  const table = level.tables.find((t) => t.match);
  if (!table) {
    if (level.grandFinal && !level.grandFinal.completed) {
      const gf = level.grandFinal;
      const which = opts.gfPickP2 ? 2 : 1;
      const evt = W.recordGrandFinalWin(level, which);
      W.finalizeIfDone(level);
      schedule.push({
        type: 'grandFinal',
        bracket: 'GF',
        game: (gf.wins1 || 0) + (gf.wins2 || 0),
        p1: names(level, [gf.p1])[0],
        p2: names(level, [gf.p2])[0],
        winner: names(level, [which === 1 ? gf.p1 : gf.p2])[0],
        evt: evt && evt.type,
        losses1: level.players[gf.p1]?.losses ?? null,
        losses2: level.players[gf.p2]?.losses ?? null,
      });
      return { type: 'grandFinal' };
    }
    W.finalizeIfDone(level);
    return null;
  }

  const match = table.match;
  const pickP2 = opts.alternate && schedule.length % 2 === 1;
  const winnerId = pickP2 ? match.p2 : match.p1;
  const loserId = winnerId === match.p1 ? match.p2 : match.p1;
  const entry = {
    type: 'match',
    tableNo: table.tableNo,
    bracket: match.bracket,
    matchId: match.id,
    round: match.round ?? null,
    stage: match.stage ?? null,
    players: names(level, [match.p1, match.p2]),
    winner: names(level, [winnerId])[0],
    loser: names(level, [loserId])[0],
  };
  W.resolveMatch(level, table.tableNo, winnerId);
  W.finalizeIfDone(level);
  const loser = level.players[loserId];
  entry.loserLossesAfter = loser ? loser.losses : null;
  entry.loserEliminated = !!(loser && (loser.losses >= 2 || loser.eliminatedAt));
  schedule.push(entry);
  return entry;
}

function runTournament(W, level, options) {
  const schedule = [];
  let guard = 0;
  while (!level.finished && guard < 1000) {
    guard += 1;
    const result = advance(W, level, schedule, options);
    if (!result) break;
  }
  return schedule;
}

function assertCompletePlacements(W, level, count) {
  W.computePlacements(level);
  const placements = Object.values(level.players).map((p) => p.placement).sort((a, b) => a - b);
  assert.deepEqual(placements, Array.from({ length: count }, (_, i) => i + 1));
}

function firstStartIndex(events, key) {
  return events.findIndex((e) => e.type === 'start' && keyOf(e.bracket, e.round, e.stage) === key);
}

function lastResolveIndex(events, key) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.type === 'resolve' && keyOf(e.bracket, e.round, e.stage) === key) return i;
  }
  return -1;
}

/*
 * 严格波次断言：
 * - W1 完成后才 W2；W2 完成后才 L1；
 * - 每个 L 阶段完成后才进入下一轮 W（W3 等 L1，W4 等 L2）；
 * - 每个 L 阶段完成后才进入下一 L 阶段。
 */
function assertWaveOrder(events, maxW, maxL) {
  for (let r = 1; r <= maxW; r += 1) {
    assert.ok(firstStartIndex(events, `W:${r}`) >= 0, `缺少 W${r} 的实际开赛记录`);
    assert.ok(lastResolveIndex(events, `W:${r}`) >= 0, `缺少 W${r} 的结算记录`);
  }
  for (let s = 1; s <= maxL; s += 1) {
    assert.ok(firstStartIndex(events, `L:${s}`) >= 0, `缺少 L${s} 的实际开赛记录`);
    assert.ok(lastResolveIndex(events, `L:${s}`) >= 0, `缺少 L${s} 的结算记录`);
  }

  for (let r = 2; r <= maxW; r += 1) {
    assert.ok(
      firstStartIndex(events, `W:${r}`) > lastResolveIndex(events, `W:${r - 1}`),
      `W${r} 不得早于 W${r - 1} 结算完成`,
    );
  }

  for (let s = 1; s <= maxL; s += 1) {
    if (s >= 2) {
      assert.ok(
        firstStartIndex(events, `L:${s}`) > lastResolveIndex(events, `L:${s - 1}`),
        `L${s} 不得早于 L${s - 1} 结算完成`,
      );
    }
    if (s + 1 <= maxW) {
      assert.ok(
        firstStartIndex(events, `L:${s}`) > lastResolveIndex(events, `W:${s + 1}`),
        `L${s} 不得早于 W${s + 1} 结算完成（W${s + 1} 是它的对应波次）`,
      );
    }
    if (s + 2 <= maxW) {
      assert.ok(
        firstStartIndex(events, `W:${s + 2}`) > lastResolveIndex(events, `L:${s}`),
        `W${s + 2} 不得早于 L${s} 结算完成`,
      );
    }
  }
}

function assertNoViolations(recorder) {
  const violations = recorder.events.filter((e) => e.type === 'violation');
  assert.deepEqual(violations, [], `波次/占用违规：\n${JSON.stringify(violations, null, 2)}`);
}

function hasParallelFill(events, bracket) {
  return events.some((e) => e.type === 'fill'
    && e.assigned.filter((a) => a.bracket === bracket).length >= 2
    && new Set(e.assigned.filter((a) => a.bracket === bracket).map((a) => a.tableNo)).size >= 2);
}

function maxTableUsed(events) {
  return Math.max(0, ...events.filter((e) => e.type === 'start').map((e) => e.tableNo || 0));
}

function byeCount(events) {
  return events.filter((e) => e.type === 'engine' && e.event === 'bye').length;
}

function assertFullResult(W, level, recorder, maxW, maxL, count) {
  assertNoViolations(recorder);
  assert.equal(level.finished, true, '赛事必须自然结束，不能因波次闸门死锁');
  assertCompletePlacements(W, level, count);
  assertWaveOrder(recorder.events, maxW, maxL);
  assert.ok(recorder.events.some((e) => e.type === 'start' && e.bracket === 'W'));
  assert.ok(recorder.events.some((e) => e.type === 'start' && e.bracket === 'L'));
  assert.equal(level.grandFinal?.completed, true);
  assert.ok(level.grandFinal.wins1 === 2 || level.grandFinal.wins2 === 2);
}

for (const maxTables of [1, 3]) {
  test(`9 人完整模拟（桌数上限 ${maxTables}）：严格 W1→W2→L1→W3→L2→W4→L3...`, () => {
    const { W } = createApp({ seed: 20261025 });
    const { level } = makeLevel(W, 9, { maxTables });
    const recorder = attachRecorder(W);
    startLevel(W, level);

    const firstRound = liveMatches(level);
    assert.equal(firstRound.length, 4);
    assert.deepEqual(new Set(firstRound.map((m) => m.bracket)), new Set(['W']));
    assert.equal(level.grandFinal, null);
    // 9 人存活时引擎自动桌数为 2；maxTables=3 只是上限
    assert.equal(level.tables.length, Math.min(maxTables, 2));

    runTournament(W, level, { alternate: true });
    assertFullResult(W, level, recorder, 4, 5, 9);

    assert.ok(byeCount(recorder.events) >= 1, '9 人首轮必须记录轮空');
    if (maxTables === 1) {
      assert.equal(maxTableUsed(recorder.events), 1);
    } else {
      assert.equal(maxTableUsed(recorder.events), 2);
      assert.ok(hasParallelFill(recorder.events, 'W') || hasParallelFill(recorder.events, 'L'),
        '两桌配置下同波次应至少有一次并行开赛');
    }
    recorder.restore();
  });
}

test('16 人两桌：同波次可并行，但 L1 不会与 W2 重叠', () => {
  const { W } = createApp({ seed: 1601 });
  const { level } = makeLevel(W, 16, { maxTables: 3 });
  const recorder = attachRecorder(W);
  startLevel(W, level);

  // 16 人存活时自动桌数为 2；maxTables=3 只是上限
  assert.equal(level.tables.length, 2);
  runTournament(W, level, { alternate: true });
  assertFullResult(W, level, recorder, 4, 5, 16);
  assert.equal(maxTableUsed(recorder.events), 2);
  assert.ok(hasParallelFill(recorder.events, 'L'), 'L1 应有多桌并行，而不是被闸门串行化');
  recorder.restore();
});

test('17 人三桌：真实三桌并发下仍严格按波次推进', () => {
  const { W } = createApp({ seed: 1701 });
  const { level } = makeLevel(W, 17, { maxTables: 3 });
  const recorder = attachRecorder(W);
  startLevel(W, level);

  assert.equal(level.tables.length, 3);
  runTournament(W, level, { alternate: true });
  assertFullResult(W, level, recorder, 4, 5, 17);
  assert.equal(maxTableUsed(recorder.events), 3);
  assert.ok(hasParallelFill(recorder.events, 'L'));
  assert.ok(byeCount(recorder.events) >= 1);
  recorder.restore();
});

test('W2 仍在桌上时，S1 即使双方空闲也不能占用空桌', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 8, { maxTables: 2 });
  startLevel(W, level);

  const ids = Object.keys(level.players);
  ids.forEach((id, i) => {
    const p = level.players[id];
    p.losses = i < 4 ? 0 : 1;
    p.bracket = i < 4 ? 'W' : 'L';
    p.dropRound = i < 4 ? null : 1;
    p.lStage = 0;
    p.eliminatedAt = null;
    p.eliminatedSeq = null;
  });
  level.wRound = 2;
  level.finished = false;
  level.grandFinal = null;
  level.tables = [
    {
      tableNo: 1,
      undo: [],
      match: {
        id: 'w2-running', createdAt: 1, bracket: 'W', round: 2,
        p1: ids[0], p2: ids[1], tableNo: 1,
      },
    },
    { tableNo: 2, match: null, undo: [] },
  ];
  level.pendingMatches = [
    { id: 's1-ready', createdAt: 2, bracket: 'L', stage: 1, p1: ids[4], p2: ids[5], tableNo: null },
  ];

  const s1 = level.pendingMatches[0];
  assert.equal(W.isLoserStageReady(level, s1), false, 'W2 未完成时 S1 不具备开赛资格');
  assert.equal(W.getMatchupView(level).nextStatus, 'pendingAfterCurrent');
  W.fillTables(level);
  assert.equal(level.tables[1].match, null, '空桌不能绕过 W2 波次闸门');

  // W2 结算后，S1 才能上场
  level.tables[0].match = null;
  assert.equal(W.isLoserStageReady(level, s1), true);
  W.fillTables(level);
  assert.ok(level.tables.some((t) => t.match && t.match.bracket === 'L'));
});

test('S1 未全部完成时，W3 必须等待；S1 完成后 W3 才能生成', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 9, { maxTables: 2 });
  startLevel(W, level);

  const ids = Object.keys(level.players);
  ids.forEach((id, i) => {
    const p = level.players[id];
    p.bracket = i < 2 ? 'W' : 'L';
    p.losses = i < 2 ? 0 : 1;
    p.dropRound = i < 2 ? null : 1;
    // ids[6..8] 已经完成 L1，只用于保持 9 人存活、避免桌数被自动缩减
    p.lStage = i < 6 ? 0 : 1;
    p.eliminatedAt = null;
    p.eliminatedSeq = null;
  });
  level.wRound = 2;
  level.finished = false;
  level.grandFinal = null;
  level.tables = [
    { tableNo: 1, match: null, undo: [] },
    { tableNo: 2, match: null, undo: [] },
  ];
  level.pendingMatches = [
    { id: 's1-a', createdAt: 1, bracket: 'L', stage: 1, p1: ids[2], p2: ids[3], tableNo: null },
    { id: 's1-b', createdAt: 2, bracket: 'L', stage: 1, p1: ids[4], p2: ids[5], tableNo: null },
  ];

  W.generateMatchesIfNeeded(level);
  assert.equal(level.wRound, 2, 'S1 尚未开打，不得生成 W3');
  assert.equal(level.pendingMatches.some((m) => m.bracket === 'W'), false);

  W.fillTables(level);
  const lTables = level.tables.filter((t) => t.match);
  assert.equal(lTables.length, 2);
  assert.ok(lTables.every((t) => t.match.bracket === 'L' && t.match.stage === 1));

  // 只结算一场时，W3 仍必须等待。存活数降到 8 后桌数会缩为 1，
  // 第二场 L 被安全退回队列，再重新填桌结算。
  W.resolveMatch(level, lTables[0].tableNo, lTables[0].match.p1);
  W.generateMatchesIfNeeded(level);
  assert.equal(level.wRound, 2);
  assert.equal(level.pendingMatches.some((m) => m.bracket === 'W'), false);
  assert.ok(level.pendingMatches.some((m) => m.bracket === 'L' && m.stage === 1));

  W.fillTables(level);
  const remaining = level.tables.find((t) => t.match);
  assert.ok(remaining && remaining.match.bracket === 'L');
  W.resolveMatch(level, remaining.tableNo, remaining.match.p1);

  // 两场 S1 都完成后，才生成 W3
  W.generateMatchesIfNeeded(level);
  assert.equal(level.wRound, 3);
  assert.ok(level.pendingMatches.some((m) => m.bracket === 'W' && m.round === 3));
});

test('下一组视图与引擎实际分配一致：W2 完成后先显示 L1', () => {
  const { W } = createApp({ seed: 33 });
  const { level } = makeLevel(W, 9, { maxTables: 1 });
  startLevel(W, level);

  // 打完 W1（4 场）与 W2（2 场），最后一场只生成、不填桌
  for (let i = 0; i < 6; i += 1) {
    const table = level.tables.find((t) => t.match);
    assert.ok(table, `第 ${i + 1} 场应有比赛`);
    W.resolveMatch(level, table.tableNo, table.match.p1);
    W.generateMatchesIfNeeded(level);
    if (i < 5) W.fillTables(level);
  }

  const view = W.getMatchupView(level);
  assert.equal(view.nextStatus, 'ready');
  assert.equal(view.next.bracket, 'L');
  assert.equal(view.next.stage, 1);
  W.fillTables(level);
  const table = level.tables.find((t) => t.match);
  assert.equal(table.match.id, view.next.matchId);
  assert.equal(table.match.bracket, 'L');
});

test('轮空、退赛与撤回不会造成假比赛、双占或波次死锁', () => {
  const { W } = createApp({ seed: 91 });
  const { level } = makeLevel(W, 9, { maxTables: 2 });
  startLevel(W, level);

  // 推进到有 W/L 混合历史后退赛一名当前仍在参赛的选手
  for (let i = 0; i < 6; i += 1) advance(W, level, []);
  const active = Object.values(level.players).find((p) => p.losses < 2 && !p.eliminatedAt);
  assert.ok(active);
  assert.equal(W.withdrawPlayer(level, active.id), true);
  W.generateMatchesIfNeeded(level);
  W.fillTables(level);

  // 撤回最近一场，再从真实状态继续打完
  const msg = W.undoLast(level, 'global');
  assert.ok(msg);
  runTournament(W, level, {});

  assert.equal(level.finished, true);
  assertCompletePlacements(W, level, 9);
  const all = liveMatches(level);
  const seen = new Set();
  for (const m of all) {
    for (const id of [m.p1, m.p2]) {
      assert.equal(seen.has(id), false, `选手 ${id} 同时出现在两场未完成比赛`);
      seen.add(id);
    }
  }
});

test('名次与淘汰先后一致：越早淘汰名次越靠后', () => {
  const { W } = createApp({ seed: 7 });
  const { level } = makeLevel(W, 9);
  startLevel(W, level);
  runTournament(W, level, {});

  W.computePlacements(level);
  const eliminated = Object.values(level.players)
    .filter((p) => p.eliminatedAt)
    .sort((a, b) => a.eliminatedSeq - b.eliminatedSeq);
  assert.ok(eliminated.length >= 8);
  assert.deepEqual(eliminated.map((p) => p.eliminatedSeq), eliminated.map((_, i) => i + 1));

  for (let i = 1; i < eliminated.length; i += 1) {
    const earlier = eliminated[i - 1];
    const later = eliminated[i];
    assert.ok(earlier.placement > later.placement,
      `更早淘汰的 ${earlier.name}（#${earlier.placement}）不应排在 ${later.name}（#${later.placement}）之前`);
  }

  const champ = Object.values(level.players).find((p) => p.placement === 1);
  assert.ok(champ);
  assert.equal(champ.eliminatedAt, null);
});

test('空队列、无效对阵和已淘汰残留不会造成异常或死锁', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 4);
  startLevel(W, level);

  level.pendingMatches = [];
  level.tables = [{ tableNo: 1, match: null, undo: [] }];
  assert.equal(W.selectNextPendingIndex(level, new Set()), -1);
  W.fillTables(level);
  assert.equal(level.tables[0].match, null);

  level.pendingMatches = [
    { id: 'bad-same', createdAt: 1, bracket: 'W', p1: 'x', p2: 'x', tableNo: null },
    { id: 'bad-empty', createdAt: 2, bracket: 'L', p1: null, p2: 'y', tableNo: null },
  ];
  assert.equal(W.selectNextPendingIndex(level, new Set()), -1);
  W.fillTables(level);
  assert.equal(level.tables[0].match, null);
});
