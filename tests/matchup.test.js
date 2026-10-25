'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApp,
  makeLevel,
  startLevel,
  runToEnd,
} = require('./harness');

function nameOf(level, id) {
  return level.players[id]?.name || null;
}

function pairNames(level, item) {
  return [nameOf(level, item.p1), nameOf(level, item.p2)];
}

function viewMatchIds(view) {
  return [
    ...view.current.map((m) => m.matchId),
    ...(view.next ? [view.next.matchId] : []),
  ].filter(Boolean);
}

function shownPlayerIds(view) {
  return [
    ...view.current.flatMap((m) => [m.p1, m.p2]),
    ...(view.next ? [view.next.p1, view.next.p2] : []),
  ];
}

test('当前对阵和下一组上场都来自真实桌子/队列，姓名可对上', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 8);
  startLevel(W, level);

  const view = W.getMatchupView(level);
  const tableMatch = level.tables.find((t) => t.match).match;

  assert.equal(view.current.length, 1);
  assert.equal(view.current[0].source, 'table');
  assert.equal(view.current[0].matchId, tableMatch.id);
  assert.deepEqual(pairNames(level, view.current[0]).sort(), [nameOf(level, tableMatch.p1), nameOf(level, tableMatch.p2)].sort());

  assert.ok(view.next);
  assert.equal(view.next.matchId, level.pendingMatches[0].id);
  assert.deepEqual(pairNames(level, view.next).sort(), [nameOf(level, level.pendingMatches[0].p1), nameOf(level, level.pendingMatches[0].p2)].sort());

  const overlap = [view.next.p1, view.next.p2].filter((id) => id === view.current[0].p1 || id === view.current[0].p2);
  assert.deepEqual(overlap, []);
});

test('结算一场后，原来的下一组进入当前对阵，新的下一组自动前移', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 8);
  startLevel(W, level);

  const before = W.getMatchupView(level);
  const nextId = before.next.matchId;
  const table = level.tables.find((t) => t.match);
  W.resolveMatch(level, table.tableNo, table.match.p1);
  W.generateMatchesIfNeeded(level);
  W.fillTables(level);
  W.finalizeIfDone(level);

  const after = W.getMatchupView(level);
  assert.equal(after.current[0].matchId, nextId);
  assert.ok(after.next);
  assert.notEqual(after.next.matchId, nextId);
  assert.equal(after.next.matchId, level.pendingMatches[0].id);
});

test('胜者组/败者组标签与真实波次一致：W1 → W2 → L1', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 4);
  startLevel(W, level);

  // 先打完两场胜者组首轮；按波次规则，下一波仍是 W2，而不是 L1
  for (let i = 0; i < 2; i++) {
    const table = level.tables.find((t) => t.match);
    assert.ok(table, `第 ${i + 1} 场应能分配到桌子`);
    assert.equal(table.match.bracket, 'W');
    assert.equal(table.match.round, 1);
    W.resolveMatch(level, table.tableNo, table.match.p1);
    W.generateMatchesIfNeeded(level);
    W.fillTables(level);
    W.finalizeIfDone(level);
  }

  let view = W.getMatchupView(level);
  assert.equal(view.current[0].bracket, 'W');
  assert.equal(level.tables.find((t) => t.match).match.round, 2, 'W1 完成后进入 W2');

  // 结算 W2 后，败者组 L1 才上场
  const table = level.tables.find((t) => t.match);
  W.resolveMatch(level, table.tableNo, table.match.p1);
  W.generateMatchesIfNeeded(level);
  W.fillTables(level);
  W.finalizeIfDone(level);
  view = W.getMatchupView(level);
  assert.equal(view.current[0].bracket, 'L');
  assert.equal(level.tables.find((t) => t.match).match.stage, 1);
});

test('轮空选手不会出现在当前或下一组', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 9);
  startLevel(W, level);

  const used = new Set();
  for (const m of [...level.pendingMatches, ...level.tables.filter((t) => t.match).map((t) => t.match)]) {
    used.add(m.p1);
    used.add(m.p2);
  }
  const byeId = level.playerOrder.find((id) => !used.has(id));
  assert.ok(byeId, '9 人首轮应有一名轮空');

  const view = W.getMatchupView(level);
  const shownIds = shownPlayerIds(view);
  assert.ok(shownIds.length >= 2);
  for (const id of shownIds) {
    assert.ok(level.players[id], `展示的选手 ${id} 必须存在`);
    assert.ok(used.has(id), `展示的选手 ${id} 必须来自真实桌子或队列`);
    assert.notEqual(id, byeId, '轮空选手不应出现在看板上');
  }
});

test('已淘汰选手残留的待赛记录不会出现在当前或下一组', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 6);
  startLevel(W, level);

  const dirty = level.pendingMatches[0];
  const eliminated = level.players[dirty.p1];
  eliminated.losses = 2;
  eliminated.eliminatedAt = 123;

  const view = W.getMatchupView(level);
  const shownIds = shownPlayerIds(view);
  for (const id of shownIds) {
    const p = level.players[id];
    assert.ok(p, `展示的选手 ${id} 必须存在`);
    assert.ok(p.losses < 2 && !p.eliminatedAt, `已淘汰选手 ${id} 不应出现在看板上`);
  }
  assert.notEqual(view.next?.matchId, dirty.id, '残留记录不应被当成下一组');
});

test('总决赛选手退赛后不再显示为当前对阵', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 2);
  startLevel(W, level);

  const ids = Object.keys(level.players);
  level.tables = [];
  level.pendingMatches = [];
  level.grandFinal = {
    p1: ids[0], p2: ids[1], wins1: 1, wins2: 0,
    completed: false, winnerId: null, runnerUpId: null,
  };
  level.players[ids[0]].losses = 2;
  level.players[ids[0]].eliminatedAt = 123;

  const view = W.getMatchupView(level);
  assert.equal(Array.from(view.current).length, 0);
  assert.equal(view.next, null);
  assert.equal(view.nextStatus, 'none');
});

test('当前比赛尚未产生下一场时，明确返回待定状态而不是猜名字', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 4);
  startLevel(W, level);

  // 合成“桌上有比赛、队列暂时为空”的时刻
  level.pendingMatches = [];
  const view = W.getMatchupView(level);

  assert.equal(view.current.length, 1);
  assert.equal(view.next, null);
  assert.equal(view.nextStatus, 'pendingAfterCurrent');
});

test('队列里被当前桌占用的比赛不会冒充下一组，优先返回可上场的一组', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 6);
  startLevel(W, level);

  const table = level.tables.find((t) => t.match);
  const currentIds = [table.match.p1, table.match.p2];
  const blockedId = currentIds[0];
  const otherIds = Object.keys(level.players).filter((id) => !currentIds.includes(id));
  level.pendingMatches = [
    { id: 'blocked', createdAt: 1, bracket: 'W', p1: blockedId, p2: otherIds[0], tableNo: null },
    { id: 'ready', createdAt: 2, bracket: 'W', p1: otherIds[1], p2: otherIds[2], tableNo: null },
  ];

  const view = W.getMatchupView(level);
  assert.equal(view.next.matchId, 'ready');
  assert.equal(view.nextStatus, 'ready');

  level.pendingMatches = [level.pendingMatches[0]];
  const waiting = W.getMatchupView(level);
  assert.equal(waiting.next.matchId, 'blocked');
  assert.equal(waiting.nextStatus, 'waiting');
  assert.equal(waiting.next.waiting, true);
});

test('总决赛进行中显示总决赛对阵，不显示旧队列的下一组', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 2);
  startLevel(W, level);

  const ids = Object.keys(level.players);
  level.tables = [];
  level.pendingMatches = [
    { id: 'stale', createdAt: 1, bracket: 'W', p1: ids[0], p2: ids[1], tableNo: null },
  ];
  level.grandFinal = {
    p1: ids[0], p2: ids[1], wins1: 1, wins2: 0,
    completed: false, winnerId: null, runnerUpId: null,
  };
  level.finished = false;

  const view = W.getMatchupView(level);
  assert.equal(view.current.length, 1);
  assert.equal(view.current[0].source, 'grandFinal');
  assert.equal(view.current[0].bracket, 'GF');
  assert.equal(view.current[0].wins1, 1);
  assert.deepEqual(pairNames(level, view.current[0]).sort(), [nameOf(level, level.grandFinal.p1), nameOf(level, level.grandFinal.p2)].sort());
  assert.equal(view.next, null);
  assert.equal(view.nextStatus, 'grandFinal');
});

test('比赛结束后不残留任何当前/下一组姓名', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 8);
  startLevel(W, level);
  runToEnd(W, level);

  assert.equal(level.finished, true);
  const view = W.getMatchupView(level);
  assert.equal(view.current.length, 0);
  assert.equal(view.next, null);
  assert.equal(view.nextStatus, 'finished');
  assert.deepEqual(viewMatchIds(view), []);
});

test('多桌并行时列出全部当前桌，下一组仍按队列顺序', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 20, { maxTables: 3 });
  startLevel(W, level);

  const view = W.getMatchupView(level);
  assert.equal(level.tables.length, 3);
  assert.equal(view.current.length, 3);
  assert.deepEqual(Array.from(view.current, (m) => m.tableNo), [1, 2, 3]);
  const seen = new Set();
  for (const m of view.current) {
    assert.equal(seen.has(m.p1), false);
    assert.equal(seen.has(m.p2), false);
    seen.add(m.p1); seen.add(m.p2);
  }
  assert.ok(view.next);
  assert.equal(view.next.matchId, level.pendingMatches[0].id);
});
