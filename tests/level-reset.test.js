'use strict';

/*
 * 「退回赛前设置」回归测试。
 *
 * 约束：
 * - 只重置当前级别：保留选手名单、报名顺序（playerOrder）、级别名称/桌数/自动打乱开关；
 * - 清除对阵、结果、历史、撤销栈、进度、名次与总决赛；
 * - 未开始的级别调用时返回 false，且不改变任何数据；
 * - 重置后名单仍可编辑，可重新开始并生成对阵；
 * - 保存后重新加载（模拟刷新）仍是赛前状态；
 * - 多级别时重置一个级别不影响其他级别。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, createStorage, makeLevel, runToEnd } = require('./harness');

function playerNames(level) {
  return Object.values(level.players).map((p) => p.name);
}

function liveMatches(level) {
  return [
    ...level.pendingMatches,
    ...level.tables.filter((t) => t.match).map((t) => t.match),
  ];
}

function startAndPlay(W, level, matches) {
  W.startLevel(level);
  W.generateMatchesIfNeeded(level);
  W.fillTables(level);
  for (let i = 0; i < matches; i += 1) {
    const table = level.tables.find((t) => t.match);
    if (!table) break;
    W.resolveMatch(level, table.tableNo, table.match.p1);
    W.generateMatchesIfNeeded(level);
    W.fillTables(level);
    W.finalizeIfDone(level);
  }
}

test('未开始的级别调用重置返回 false，且不改变任何数据', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 6);
  const before = JSON.stringify(level);

  assert.equal(W.resetLevelToSetup(level), false);
  assert.equal(JSON.stringify(level), before, '赛前状态调用重置不得改动任何字段');
});

test('确认重置后：清除进度与结果，保留运动员名单、报名顺序和级别设置', () => {
  const { W } = createApp({ seed: 20261102 });
  const { level, names } = makeLevel(W, 6, { maxTables: 2 });
  const beforeOrder = level.playerOrder.slice();
  const beforeIds = Object.keys(level.players).sort();
  const beforeNames = names.slice().sort();
  const beforeSettings = {
    id: level.id,
    name: level.name,
    createdAt: level.createdAt,
    maxTables: level.maxTables,
    autoShuffle: level.autoShuffle,
  };

  startAndPlay(W, level, 3);
  assert.equal(level.started, true);
  assert.ok(level.history.length > 0, '重置前应已录入比赛结果');
  assert.ok(
    Object.values(level.players).some((p) => p.losses > 0 || p.lStage > 0 || p.bracket === 'L'),
    '重置前应已产生胜负状态',
  );

  assert.equal(W.resetLevelToSetup(level), true);

  // 名单与报名顺序
  assert.deepEqual(Object.keys(level.players).sort(), beforeIds, '选手名单必须完整保留');
  assert.deepEqual(playerNames(level).sort(), beforeNames, '选手姓名必须完整保留');
  assert.deepEqual(level.playerOrder, beforeOrder, '必须保留原始报名顺序，不能从对阵反推');

  // 类别设置
  assert.deepEqual({
    id: level.id,
    name: level.name,
    createdAt: level.createdAt,
    maxTables: level.maxTables,
    autoShuffle: level.autoShuffle,
  }, beforeSettings, '级别标识、名称、桌数与自动打乱设置必须保留');

  // 比赛进度与结果
  assert.equal(level.started, false);
  assert.equal(level.finished, false);
  assert.equal(level.wRound, 0);
  assert.equal(level.pendingMatches.length, 0);
  assert.equal(level.tables.length, 0);
  assert.equal(level.history.length, 0);
  assert.equal(level.undoStack.length, 0);
  assert.equal(level.grandFinal, null);
  assert.equal(level.banners.top8Shown, false);
  assert.equal(level.banners.top3Shown, false);
  assert.equal(level.banners.gfShown, false);
  assert.equal(liveMatches(level).length, 0, '不得残留任何已生成的对阵');

  // 每名选手的胜负/名次/阵营
  for (const p of Object.values(level.players)) {
    assert.equal(p.losses, 0, `${p.name} 的负场未清零`);
    assert.equal(p.eliminatedAt, null);
    assert.equal(p.eliminatedSeq, null);
    assert.equal(p.dropRound, null);
    assert.equal(p.lStage, 0);
    assert.equal(p.placement, null, `${p.name} 的名次未清除`);
    assert.equal(p.bracket, 'W');
  }
});

test('重置后可以补充漏掉的选手，并重新开始生成新对阵', () => {
  const { W } = createApp({ seed: 7 });
  const { level } = makeLevel(W, 6, { maxTables: 1 });
  const beforeOrder = level.playerOrder.slice();
  startAndPlay(W, level, 2);
  assert.equal(W.resetLevelToSetup(level), true);

  // 补充一名选手：仍未开始，编辑能力必须恢复
  const result = W.addPlayers(level, '补录选手');
  assert.equal(result.added, 1, '重置后应能继续添加选手');
  assert.equal(Object.keys(level.players).length, 7);

  // 删除该名补录选手：原有选手一个不少
  // （addPlayers 在未开始时默认会打乱报名顺序，这是既有规则；这里只验证名单完整）
  const added = Object.values(level.players).find((p) => p.name === '补录选手');
  W.deletePlayer(level, added.id);
  assert.equal(Object.keys(level.players).length, 6);
  assert.deepEqual(Array.from(level.playerOrder).sort(), Array.from(beforeOrder).sort(),
    '删除补录选手后原始选手名单不变');

  // 重新开始：按现有规则生成对阵
  W.startLevel(level);
  W.generateMatchesIfNeeded(level);
  W.fillTables(level);
  assert.equal(level.started, true);
  assert.equal(level.history.length, 0, '重新开始后不得残留旧结果');
  assert.equal(liveMatches(level).length, 3, '6 人首轮应生成 3 场');
  assert.ok(level.tables.some((t) => t.match), '开始后应立即安排比赛上桌');
});

test('已结束的级别也能退回赛前设置并重新开始', () => {
  const { W } = createApp({ seed: 91 });
  const { level } = makeLevel(W, 4);
  W.startLevel(level);
  runToEnd(W, level);
  assert.equal(level.finished, true);
  assert.equal(level.started, true, '已结束级别仍保留 started=true，重置入口应可见');

  assert.equal(W.resetLevelToSetup(level), true);
  assert.equal(level.finished, false);
  assert.equal(level.started, false);
  assert.equal(level.history.length, 0);

  W.startLevel(level);
  assert.equal(level.started, true);
  assert.equal(liveMatches(level).length, 2, '4 人可重新生成 2 场首轮对阵');
});

test('保存后重新加载（模拟刷新）仍是赛前设置状态', () => {
  const storage = createStorage();
  const app = createApp({ storage, seed: 33 });
  const { tournament, level } = makeLevel(app.W, 6);

  startAndPlay(app.W, level, 2);
  assert.equal(app.W.resetLevelToSetup(level), true);
  app.W.saveState();

  const reloaded = createApp({ storage });
  reloaded.W.state = reloaded.W.loadState();
  const t = reloaded.W.state.tournaments.find((x) => x.id === tournament.id);
  assert.ok(t, '刷新后赛事仍应存在');
  const l = t.levels.find((x) => x.id === level.id);
  assert.ok(l, '刷新后级别仍应存在');
  assert.equal(l.started, false, '刷新后必须保持赛前状态，不能从旧数据复活比赛');
  assert.equal(l.finished, false);
  assert.equal(l.history.length, 0);
  assert.equal(l.pendingMatches.length, 0);
  assert.equal(l.tables.length, 0);
  assert.equal(Object.keys(l.players).length, 6, '刷新后名单仍完整');
  assert.deepEqual(Array.from(l.playerOrder), Array.from(level.playerOrder), '刷新后报名顺序不变');
});

test('多级别隔离：重置一个级别不影响其他级别', () => {
  const { W } = createApp({ seed: 555 });
  const tournament = W.createTournament('多级别赛事');
  W.state.tournaments.push(tournament);

  const a = W.createLevel({ name: '级别A', maxTables: 1 });
  const b = W.createLevel({ name: '级别B', maxTables: 1 });
  tournament.levels.push(a, b);
  W.batchAddPlayers(a, ['A1', 'A2', 'A3', 'A4'].join('\n'));
  W.batchAddPlayers(b, ['B1', 'B2', 'B3', 'B4'].join('\n'));

  startAndPlay(W, a, 2);
  startAndPlay(W, b, 2);
  assert.ok(a.history.length > 0 && b.history.length > 0);

  const snapshotOf = (l) => JSON.stringify({
    started: l.started,
    finished: l.finished,
    players: l.players,
    playerOrder: l.playerOrder,
    history: l.history,
    pendingMatches: l.pendingMatches,
    tables: l.tables,
    grandFinal: l.grandFinal,
    wRound: l.wRound,
  });
  const bSnapshot = snapshotOf(b);

  assert.equal(W.resetLevelToSetup(a), true);

  assert.equal(a.started, false);
  assert.equal(a.history.length, 0);
  assert.deepEqual(liveMatches(a), []);
  assert.equal(snapshotOf(b), bSnapshot, '重置级别A不得改动级别B的任何数据');
});
