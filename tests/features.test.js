'use strict';

/*
 * 第四阶段功能回归：级别独立桌数上限、录入后自动打乱。
 * 全部使用合成数据，不接触真实 localStorage。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApp,
  createStorage,
  makeLevel,
  startLevel,
  runToEnd,
  playerNames,
} = require('./harness');

function idsOf(level) {
  return Object.keys(level.players);
}

function assertPermutation(level, expectedIds) {
  assert.equal(level.playerOrder.length, expectedIds.length);
  assert.equal(new Set(level.playerOrder).size, expectedIds.length, 'playerOrder 不应出现重复');
  assert.deepEqual(
    Array.from(level.playerOrder).slice().sort(),
    Array.from(expectedIds).slice().sort(),
    'playerOrder 必须包含且只包含全部选手',
  );
}

/* ---------------- 自动打乱 ---------------- */

test('新建级别默认开启自动打乱', () => {
  const { W } = createApp();
  const level = W.createLevel({ name: '默认级别' });
  assert.equal(level.autoShuffle, true);
});

test('批量添加 9 人后只打乱一次，9 人全部保留且顺序是一个完整排列', () => {
  const { W } = createApp({ seed: 4321 });
  const level = W.createLevel({ name: '自动打乱' });

  let calls = 0;
  const original = W.shufflePlayerOrder;
  W.shufflePlayerOrder = function counted(levelArg) {
    calls += 1;
    return original(levelArg);
  };

  const names = playerNames(9);
  const result = W.addPlayers(level, names.join('\n'));
  W.shufflePlayerOrder = original;

  assert.equal(result.added, 9);
  assert.deepEqual(Array.from(result.dupes), []);
  assert.equal(result.shuffled, true);
  assert.equal(calls, 1, '整批添加只应触发一次打乱');
  assert.equal(idsOf(level).length, 9);
  assertPermutation(level, idsOf(level));
  const namesInOrder = Array.from(level.playerOrder, (id) => level.players[id].name).sort();
  assert.deepEqual(namesInOrder, names.slice().sort(), '不应遗漏或重复任何姓名');
});

test('关闭自动打乱后按录入顺序保存，手动打乱仍可用', () => {
  const { W } = createApp({ seed: 88 });
  const level = W.createLevel({ name: '手动模式' });
  level.autoShuffle = false;

  W.addPlayers(level, '甲\n乙\n丙');
  const before = Array.from(level.playerOrder);
  assert.deepEqual(Array.from(before, (id) => level.players[id].name), ['甲', '乙', '丙']);

  const again = W.addPlayers(level, '丁');
  assert.equal(again.shuffled, false);
  assert.equal(Array.from(level.playerOrder, (id) => level.players[id].name).join(','), '甲,乙,丙,丁');

  // 现有手动打乱入口（UI 的“随机抽签”调用同一函数）
  assert.equal(W.shufflePlayerOrder(level), true);
  assertPermutation(level, idsOf(level));
});

test('比赛开始后添加与打乱都被拒绝，既有对阵保持不变', () => {
  const { W } = createApp({ seed: 5 });
  const { level } = makeLevel(W, 9);
  startLevel(W, level);
  const orderBefore = Array.from(level.playerOrder);
  const pendingBefore = Array.from(level.pendingMatches, (m) => m.id);

  const result = W.addPlayers(level, '新人');
  assert.equal(result.added, 0);
  assert.equal(result.shuffled, false);
  assert.equal(W.shufflePlayerOrder(level), false);
  assert.deepEqual(Array.from(level.playerOrder), orderBefore);
  assert.deepEqual(Array.from(level.pendingMatches, (m) => m.id), pendingBefore);
});

test('自动打乱开关与桌数上限都能持久化，导入旧数据时默认开启', () => {
  const storage = createStorage();
  const first = createApp({ storage });
  const t = first.W.createTournament('持久化');
  first.W.state.tournaments.push(t);
  const a = first.W.createLevel({ name: 'A', maxTables: 1 });
  const b = first.W.createLevel({ name: 'B', maxTables: 3 });
  t.levels.push(a, b);
  first.W.addPlayers(a, playerNames(4).join('\n'));
  a.autoShuffle = false;
  first.W.saveState();

  const second = createApp({ storage });
  const loaded = second.W.loadState();
  const [la, lb] = loaded.tournaments[0].levels;
  assert.equal(la.autoShuffle, false);
  assert.equal(lb.autoShuffle, true);
  assert.equal(la.maxTables, 1);
  assert.equal(lb.maxTables, 3);
  assert.equal(la.playerOrder.length, 4);

  // 旧版导出没有 autoShuffle 字段
  const oldData = {
    version: 1,
    tournaments: [{
      id: 't1', name: '旧赛事', levels: [{
        id: 'l1', name: '旧级别', maxTables: 2, players: {}, playerOrder: [],
      }],
    }],
    ui: { route: { name: 'home' } },
  };
  const normalized = second.W.normalizeState(oldData);
  assert.equal(normalized.error, undefined);
  assert.equal(normalized.state.tournaments[0].levels[0].autoShuffle, true);
});

/* ---------------- 级别独立桌数 ---------------- */

test('未开始级别可直接设置桌数，且不要求改名称、不影响其他级别', () => {
  const { W } = createApp();
  const t = W.createTournament('桌数测试');
  W.state.tournaments.push(t);
  const a = W.createLevel({ name: '级别 A', maxTables: 1 });
  const b = W.createLevel({ name: '级别 B', maxTables: 1 });
  t.levels.push(a, b);

  assert.deepEqual({ ...W.setTableLimit(a, 3) }, { prev: 1, limit: 3 });
  W.setTableLimit(b, 2);

  assert.equal(a.name, '级别 A');
  assert.equal(b.name, '级别 B');
  assert.equal(a.maxTables, 3);
  assert.equal(b.maxTables, 2);
  assert.equal(a.tables.length, 0, '未开始级别不应凭空建桌');
  assert.equal(b.tables.length, 0);
});

test('桌数输入校验：非数字/越界被限制在 1~3', () => {
  const { W } = createApp();
  const level = W.createLevel({ name: '校验' });
  assert.equal(W.setTableLimit(level, 0).limit, 1);
  assert.equal(W.setTableLimit(level, 99).limit, 3);
  assert.equal(W.setTableLimit(level, '2').limit, 2);
  assert.equal(W.setTableLimit(level, 'abc').limit, 1);
  assert.equal(level.maxTables, 1);
});

test('已开始级别缩减桌数：进行中的比赛安全退回队列，不丢失、不判负、不改历史', () => {
  const { W } = createApp({ seed: 21 });
  const { level } = makeLevel(W, 20, { maxTables: 3 });
  startLevel(W, level);

  assert.equal(level.tables.length, 3);
  const runningOnTable1 = level.tables[0].match.id;
  const totalScheduled = level.tables.filter((t) => t.match).length + level.pendingMatches.length;
  const historyBefore = level.history.length;
  const lossesBefore = Object.values(level.players).map((p) => p.losses).join(',');
  const pendingIdsBefore = level.pendingMatches.map((m) => m.id);

  W.setTableLimit(level, 1);

  assert.equal(level.maxTables, 1);
  assert.equal(level.tables.length, 1);
  assert.equal(level.tables[0].match.id, runningOnTable1, '原 1 号桌比赛不应被移动或清空');
  assert.equal(level.history.length, historyBefore);
  assert.equal(Object.values(level.players).map((p) => p.losses).join(','), lossesBefore);

  const afterScheduled = level.tables.filter((t) => t.match).length + level.pendingMatches.length;
  assert.equal(afterScheduled, totalScheduled, '被收回的比赛必须完整保留在队列中');
  const pendingIdsAfter = level.pendingMatches.map((m) => m.id);
  for (const id of pendingIdsBefore) assert.ok(pendingIdsAfter.includes(id));

  // 再恢复 3 桌：比赛重新上桌，且同一选手不会同时出现在两张桌子
  W.setTableLimit(level, 3);
  assert.equal(level.tables.length, 3);
  const seen = new Set();
  for (const t of level.tables) {
    if (!t.match) continue;
    for (const id of [t.match.p1, t.match.p2]) {
      assert.equal(seen.has(id), false, '同一选手不能同时出现在多张桌子');
      seen.add(id);
    }
  }
  assert.equal(level.tables.filter((t) => t.match).length + level.pendingMatches.length, totalScheduled);
});

test('两个级别可以设置不同桌数，跨级别隔离且各自独立推进', () => {
  const { W } = createApp({ seed: 31 });
  const t = W.createTournament('并行');
  W.state.tournaments.push(t);
  const a = W.createLevel({ name: 'A', maxTables: 3 });
  const b = W.createLevel({ name: 'B', maxTables: 3 });
  t.levels.push(a, b);
  W.addPlayers(a, playerNames(20).join('\n'));
  W.addPlayers(b, playerNames(20).join('\n'));
  startLevel(W, a);
  startLevel(W, b);

  W.setTableLimit(a, 1);
  assert.equal(a.tables.length, 1);
  assert.equal(b.tables.length, 3, '修改 A 不能影响 B');

  // 跨级别：同一批选手姓名也可以分别参赛，比赛不会串场
  const aIds = new Set(idsOf(a));
  for (const table of b.tables) {
    if (!table.match) continue;
    assert.ok(!aIds.has(table.match.p1));
    assert.ok(!aIds.has(table.match.p2));
  }
});

test('已结束级别设置桌数只记录设置，不重建已完成状态', () => {
  const { W } = createApp({ seed: 41 });
  const { level } = makeLevel(W, 8);
  startLevel(W, level);
  runToEnd(W, level);
  assert.equal(level.finished, true);
  const historyLength = level.history.length;
  const placements = Object.values(level.players).map((p) => p.placement).join(',');

  W.setTableLimit(level, 3);
  assert.equal(level.maxTables, 3);
  assert.equal(level.history.length, historyLength);
  assert.equal(Object.values(level.players).map((p) => p.placement).join(','), placements);
  assert.equal(level.finished, true);
});
