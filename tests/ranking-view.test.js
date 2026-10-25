'use strict';

/*
 * 「实时名次」视图回归测试。
 * 名次本身仍由 state.js 的 computePlacements 决定；这里只验证
 * 展示层拿到的完整名次表：名次名称、未决出状态、部分确定、完赛与撤回。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, makeLevel, startLevel, step, runToEnd } = require('./harness');

function eliminatedCount(level) {
  return Object.values(level.players).filter((p) => p.eliminatedAt).length;
}

function assertPlaces(view, total) {
  assert.deepEqual(Array.from(view, (r) => r.place), Array.from({ length: total }, (_, i) => i + 1));
  assert.equal(view[0].label, '🥇 冠军');
  assert.equal(view[1].label, '🥈 亚军');
  assert.equal(view[2].label, '🥉 季军');
  assert.equal(view[3].label, '第四名');
}

test('名次名称：冠军/亚军/季军与中文序数覆盖 4、9、17 人', () => {
  const { W } = createApp();
  assert.equal(W.rankingLabel(1), '🥇 冠军');
  assert.equal(W.rankingLabel(2), '🥈 亚军');
  assert.equal(W.rankingLabel(3), '🥉 季军');
  assert.equal(W.rankingLabel(4), '第四名');
  assert.equal(W.rankingLabel(9), '第九名');
  assert.equal(W.rankingLabel(10), '第十名');
  assert.equal(W.rankingLabel(11), '第十一名');
  assert.equal(W.rankingLabel(17), '第十七名');
  assert.equal(W.rankingLabel(20), '第二十名');
  assert.equal(W.rankingLabel(101), '第一百零一名');
  assert.equal(W.rankingLabel(110), '第一百一十名');
  assert.equal(W.rankingLabel(512), '第五百一十二名');
  assert.equal(W.rankingLabel(1000), '第一千名');
  assert.equal(W.rankingLabel(1001), '第一千零一名');
  assert.equal(W.rankingLabel(1010), '第一千零一十名');
  assert.equal(W.rankingLabel(1100), '第一千一百名');
  assert.equal(W.rankingLabel(1111), '第一千一百一十一名');
  assert.equal(W.rankingLabel(10000), '第10000名');
  assert.equal(W.rankingLabel('4'), '第四名');
  for (const invalid of [0, -1, 1.5, NaN, null, undefined, 'abc']) {
    assert.equal(W.rankingLabel(invalid), '未决出');
  }
});

test('比赛刚开始：所有名次位置都已列出，且全部显示未决出', () => {
  const { W } = createApp({ seed: 3 });
  const { level } = makeLevel(W, 9);
  startLevel(W, level);

  const view = W.getRankingView(level);
  assertPlaces(view, 9);
  assert.equal(view.length, 9);
  assert.ok(view.every((row) => row.status === 'pending'));
  assert.ok(view.every((row) => row.playerId === null && row.name === null));
  assert.equal(view[8].label, '第九名');
});

test('比赛进行中：只显示已淘汰选手的最终名次，存活选手仍为未决出', () => {
  const { W } = createApp({ seed: 7 });
  const { level } = makeLevel(W, 9);
  startLevel(W, level);

  let guard = 0;
  while (eliminatedCount(level) < 3 && !level.finished && guard < 300) {
    step(W, level, 'p1');
    guard += 1;
  }
  assert.ok(eliminatedCount(level) >= 3, '应至少产生 3 名淘汰者');
  assert.equal(level.finished, false);

  const view = W.getRankingView(level);
  const decided = view.filter((row) => row.status === 'decided');
  const pending = view.filter((row) => row.status === 'pending');
  assert.equal(decided.length, eliminatedCount(level));
  assert.ok(pending.length > 0);

  const aliveIds = new Set(W.alivePlayers(level).map((p) => p.id));
  for (const row of decided) {
    const p = level.players[row.playerId];
    assert.ok(p && p.eliminatedAt, `${row.name} 应是已确定名次`);
    assert.equal(p.placement, row.place);
    assert.equal(row.name, p.name);
    assert.equal(row.label, W.rankingLabel(row.place));
    assert.equal(aliveIds.has(p.id), false, '存活选手不能出现在已确定名次中');
  }
  for (const row of pending) {
    assert.equal(row.playerId, null);
    assert.equal(row.name, null);
    assert.equal(row.status, 'pending');
  }
  // 已确定的只能是本轮已经淘汰的底部名次，不能把存活者的临时顺序写进来
  assert.ok(decided.every((row) => row.place >= 9 - eliminatedCount(level) + 1));
});

test('比赛结束：9 人完整显示 1..9，冠军/亚军与总决赛结果一致', () => {
  const { W } = createApp({ seed: 11 });
  const { level } = makeLevel(W, 9);
  startLevel(W, level);
  runToEnd(W, level);

  assert.equal(level.finished, true);
  const view = W.getRankingView(level);
  assertPlaces(view, 9);
  assert.equal(view[8].label, '第九名');
  assert.ok(view.every((row) => row.status === 'decided'));
  assert.equal(new Set(view.map((row) => row.playerId)).size, 9);
  assert.equal(view[0].name, level.players[level.grandFinal.winnerId].name);
  assert.equal(view[1].name, level.players[level.grandFinal.runnerUpId].name);
});

test('4 人与 17 人（三桌）都能列出并最终填满完整名次', () => {
  for (const [count, maxTables, lastLabel] of [[4, 1, '第四名'], [17, 3, '第十七名']]) {
    const { W } = createApp({ seed: 13 + count });
    const { level } = makeLevel(W, count, { maxTables });
    startLevel(W, level);
    if (count === 17) assert.equal(level.tables.length, 3);

    const startView = W.getRankingView(level);
    assert.equal(startView.length, count);
    assert.equal(startView[count - 1].label, lastLabel);

    runToEnd(W, level);
    const finalView = W.getRankingView(level);
    assert.equal(finalView.length, count);
    assert.ok(finalView.every((row) => row.status === 'decided'));
    assert.equal(new Set(finalView.map((row) => row.playerId)).size, count);
  }
});

test('退赛选手：名次确定并标记退赛，撤回后恢复未决出', () => {
  const { W } = createApp({ seed: 23 });
  const { level } = makeLevel(W, 9);
  startLevel(W, level);

  const target = Object.values(level.players).find((p) => p.name);
  W.withdrawPlayer(level, target.id);

  const view = W.getRankingView(level);
  const row = view.find((entry) => entry.playerId === target.id);
  assert.ok(row, '退赛选手应出现在已确定名次中');
  assert.equal(row.status, 'decided');
  assert.equal(row.place, 9);
  assert.equal(row.withdrawn, true);
  assert.equal(view.filter((entry) => entry.status === 'decided').length, 1);
  assert.ok(view.slice(0, 8).every((entry) => entry.status === 'pending'));

  const msg = W.undoLast(level, 'global');
  assert.ok(msg);
  const after = W.getRankingView(level);
  assert.ok(after.every((entry) => entry.status === 'pending'));
});

test('撤回一场淘汰赛：该选手的名次恢复为未决出，较早名次不变', () => {
  const { W } = createApp({ seed: 19 });
  const { level } = makeLevel(W, 9);
  startLevel(W, level);

  let guard = 0;
  while (eliminatedCount(level) < 3 && !level.finished && guard < 300) {
    step(W, level, 'p1');
    guard += 1;
  }
  const before = W.getRankingView(level);
  const decidedBefore = before.filter((row) => row.status === 'decided');
  assert.equal(decidedBefore.length, 3);
  // 最近被淘汰的人拿到当前已确定名次里最小的名次号
  const reverted = decidedBefore[0];

  const msg = W.undoLast(level, 'global');
  assert.ok(msg);
  const after = W.getRankingView(level);

  assert.equal(after.filter((row) => row.status === 'decided').length, 2);
  assert.equal(after[reverted.place - 1].status, 'pending');
  assert.equal(after[reverted.place - 1].name, null);
  assert.deepEqual(
    Array.from(after, (row) => row.playerId).slice(reverted.place),
    Array.from(before, (row) => row.playerId).slice(reverted.place)
  );
});

test('撤回总决赛结果：冠军/亚军恢复未决出，其余已确定名次保持不变', () => {
  const { W } = createApp({ seed: 17 });
  const { level } = makeLevel(W, 9);
  startLevel(W, level);
  runToEnd(W, level);
  assert.equal(level.finished, true);

  const before = W.getRankingView(level);
  assert.ok(before.every((row) => row.status === 'decided'));

  const msg = W.undoLast(level, 'global');
  assert.ok(msg);
  const after = W.getRankingView(level);

  assert.equal(level.finished, false);
  assert.equal(after[0].status, 'pending');
  assert.equal(after[1].status, 'pending');
  assert.deepEqual(Array.from(after, (row) => row.playerId).slice(2), Array.from(before, (row) => row.playerId).slice(2));
  assert.deepEqual(Array.from(after, (row) => row.place).slice(2), [3, 4, 5, 6, 7, 8, 9]);
});
