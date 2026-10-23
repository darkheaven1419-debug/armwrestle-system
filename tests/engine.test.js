'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApp,
  createStorage,
  makeLevel,
  startLevel,
  step,
  runToEnd,
} = require('./harness');

function finishedPlacements(level) {
  return Object.values(level.players)
    .map((p) => p.placement)
    .sort((a, b) => a - b);
}

function assertPlacementsComplete(level) {
  const total = Object.keys(level.players).length;
  assert.deepEqual(finishedPlacements(level), Array.from({ length: total }, (_, i) => i + 1));
}

for (const size of [8, 16, 32]) {
  test(`${size} 人双败淘汰可以完整打完，名次 1..${size} 全部决出`, () => {
    const { W } = createApp();
    const { level } = makeLevel(W, size);
    startLevel(W, level);
    const steps = runToEnd(W, level);

    assert.equal(level.finished, true);
    assert.ok(steps > 0 && steps < 10000);
    W.computePlacements(level);
    assertPlacementsComplete(level);
    assert.equal(Object.values(level.players).filter((p) => p.placement === 1).length, 1);
    assert.equal(level.history.length > 0, true);
  });
}

test('轮空不会生成对阵，9 人首轮只有 4 场', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 9);
  startLevel(W, level);

  const matches = [
    ...level.pendingMatches,
    ...level.tables.filter((t) => t.match).map((t) => t.match),
  ];
  assert.equal(matches.length, 4);

  const seen = new Set();
  for (const m of matches) {
    assert.equal(seen.has(m.p1), false);
    assert.equal(seen.has(m.p2), false);
    seen.add(m.p1);
    seen.add(m.p2);
    assert.notEqual(m.p1, m.p2);
  }

  runToEnd(W, level);
  assert.equal(level.finished, true);
  W.computePlacements(level);
  assertPlacementsComplete(level);
});

test('撤销一场比赛后，负场、历史和对阵恢复到结算前', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 8);
  startLevel(W, level);

  const table = level.tables.find((t) => t.match);
  assert.ok(table);
  const matchId = table.match.id;
  const before = W.deepClone({
    players: level.players,
    pendingMatches: level.pendingMatches,
    tables: level.tables,
    history: level.history,
  });

  step(W, level);
  assert.equal(level.history.length, 1);

  const message = W.undoLast(level, 'global');
  assert.ok(message);
  assert.equal(level.history.length, 0);
  assert.deepEqual(level.players, before.players);
  assert.deepEqual(level.pendingMatches, before.pendingMatches);
  assert.deepEqual(level.tables, before.tables);
  assert.equal(level.tables.find((t) => t.tableNo === table.tableNo).match.id, matchId);
});

test('总决赛 BO3：先赢两局夺冠，单局可撤销', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 4);
  startLevel(W, level);

  let guard = 0;
  while (!level.grandFinal && guard < 100) {
    if (!step(W, level)) break;
    guard += 1;
  }
  assert.ok(level.grandFinal, '应进入总决赛');
  assert.equal(level.grandFinal.wins1, 0);
  assert.equal(level.grandFinal.wins2, 0);

  W.recordGrandFinalWin(level, 1);
  assert.equal(level.grandFinal.wins1, 1);
  assert.equal(level.grandFinal.completed, false);

  const undoMessage = W.undoGrandFinalPoint(level);
  assert.ok(undoMessage);
  assert.equal(level.grandFinal.wins1, 0);

  W.recordGrandFinalWin(level, 1);
  const result = W.recordGrandFinalWin(level, 1);
  assert.equal(result.type, 'gfComplete');
  assert.equal(level.grandFinal.completed, true);
  assert.equal(level.grandFinal.winnerId, level.grandFinal.p1);
  assert.equal(level.finished, true);

  W.computePlacements(level);
  assert.equal(level.players[level.grandFinal.winnerId].placement, 1);
});

test('退赛会清理该选手的待赛和桌上比赛，并标记淘汰', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 8);
  startLevel(W, level);

  const table = level.tables.find((t) => t.match);
  const playerId = table.match.p1;
  assert.equal(W.withdrawPlayer(level, playerId), true);

  const player = level.players[playerId];
  assert.equal(player.losses, 2);
  assert.ok(player.eliminatedAt);
  assert.equal(W.alivePlayers(level).some((p) => p.id === playerId), false);
  assert.equal(level.pendingMatches.some((m) => m.p1 === playerId || m.p2 === playerId), false);
  assert.equal(level.tables.some((t) => t.match && (t.match.p1 === playerId || t.match.p2 === playerId)), false);

  runToEnd(W, level);
  assert.equal(level.finished, true);
});

test('退赛可被全局撤回恢复到退赛前', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 8);
  startLevel(W, level);

  const table = level.tables.find((t) => t.match);
  const playerId = table.match.p1;
  const before = W.deepClone({
    players: level.players,
    pendingMatches: level.pendingMatches,
    tables: level.tables,
  });

  assert.equal(W.withdrawPlayer(level, playerId), true);
  assert.equal(W.undoLast(level, 'global'), '已撤销最近一场比赛');

  assert.deepEqual(level.players, before.players);
  assert.deepEqual(level.pendingMatches, before.pendingMatches);
  assert.deepEqual(level.tables, before.tables);
  assert.equal(W.alivePlayers(level).some((p) => p.id === playerId), true);
});

test('saveState / loadState 往返不丢赛事数据', () => {
  const storage = createStorage();
  const first = createApp({ storage });
  const { level } = makeLevel(first.W, 8);
  startLevel(first.W, level);
  first.W.saveState();

  const second = createApp({ storage });
  const loaded = second.W.loadState();
  assert.equal(loaded.tournaments.length, 1);
  assert.equal(loaded.tournaments[0].levels.length, 1);
  assert.equal(Object.keys(loaded.tournaments[0].levels[0].players).length, 8);
});
