'use strict';

/*
 * 多级别固定 1 桌 / 单级别保留桌数设置回归测试。
 *
 * 约束：
 * - 多级别开赛只约束本次实际桌数，不修改 level.maxTables；
 * - 单级别开赛仍按 maxTables 与存活人数自动取桌；
 * - 从多级别切回单级别时，generateMatchesIfNeeded 按原 maxTables 恢复桌数；
 * - 调整桌数不能丢失或重复待赛对阵。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, makeLevel } = require('./harness');

function totalMatches(level) {
  return level.pendingMatches.length + level.tables.filter((t) => t.match).length;
}

test('多级别开赛固定 1 桌，且保留 maxTables 原值', () => {
  const { W } = createApp({ seed: 1001 });
  const { level } = makeLevel(W, 18, { maxTables: 3 });

  W.startLevel(level, { maxTables: 1 });

  assert.equal(level.maxTables, 3, 'maxTables 不应被本次开赛改写');
  assert.equal(level.tables.length, 1, '多级别开赛应只有 1 张实际桌子');
  assert.equal(level.tables[0].tableNo, 1);
  assert.ok(level.tables[0].match, '唯一桌子应安排首轮比赛');
});

test('单级别开赛仍按 maxTables 建桌', () => {
  const { W } = createApp({ seed: 1002 });
  const { level } = makeLevel(W, 18, { maxTables: 3 });

  W.startLevel(level);

  assert.equal(level.maxTables, 3);
  assert.equal(level.tables.length, 3, '单级别 18 人、上限 3 时应开 3 桌');
});

test('多级别切回单级别后恢复原桌数，且不丢对阵', () => {
  const { W } = createApp({ seed: 1003 });
  const { level } = makeLevel(W, 18, { maxTables: 3 });
  W.startLevel(level, { maxTables: 1 });
  const before = totalMatches(level);
  assert.equal(level.tables.length, 1);

  // 模拟离开多级别控制台后进入单级别页面：
  // renderLevel 会调用 generateMatchesIfNeeded -> adjustTablesToAutoCount。
  W.generateMatchesIfNeeded(level);
  W.fillTables(level);

  assert.equal(level.maxTables, 3, '单级别设置应保持不变');
  assert.equal(level.tables.length, 3, '切回单级别后应恢复 3 桌');
  assert.equal(totalMatches(level), before, '扩桌不能重复或丢失待赛对阵');
});

test('从已开赛的 3 桌进入多级别，收回桌子不丢比赛', () => {
  const { W } = createApp({ seed: 1005 });
  const { level } = makeLevel(W, 18, { maxTables: 3 });
  W.startLevel(level);
  W.fillTables(level);
  const before = totalMatches(level);
  assert.equal(level.tables.length, 3);

  // 多级别控制台顺序：生成 -> 强制收回 1 桌 -> 补桌。
  W.generateMatchesIfNeeded(level);
  W.safelyReduceTables(level, 1);
  W.fillTables(level);

  assert.equal(level.maxTables, 3);
  assert.equal(level.tables.length, 1, '多级别中只剩 1 张实际桌子');
  assert.equal(totalMatches(level), before, '收回桌子的比赛应回到候场队列');
});

test('computeTableCount 的 cap 只影响单次计算，不污染设置', () => {
  const { W } = createApp({ seed: 1004 });
  const { level } = makeLevel(W, 18, { maxTables: 3 });
  W.startLevel(level);

  assert.equal(W.computeTableCount(level), 3);
  assert.equal(W.computeTableCount(level, 1), 1);
  assert.equal(W.computeTableCount(level, 2), 2);
  assert.equal(level.maxTables, 3);
});
