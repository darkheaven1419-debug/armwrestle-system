'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, createStorage, makeLevel, startLevel, step, runToEnd } = require('./harness');

const KEY = 'wacaa_armwrestle_v1';
const BACKUP = 'wacaa_armwrestle_backup';

test('clearAllData 同时删除主数据与自动备份', () => {
  const { W, storage } = createApp();
  makeLevel(W, 8);
  W.saveState();
  W.backupState();
  assert.ok(storage.getItem(KEY));
  assert.ok(storage.getItem(BACKUP));

  assert.equal(W.clearAllData(), true);
  assert.equal(storage.getItem(KEY), null);
  assert.equal(storage.getItem(BACKUP), null);
});

test('?reset=1 清空后不会从备份复活', () => {
  const storage = createStorage();
  const first = createApp({ storage });
  makeLevel(first.W, 8);
  first.W.saveState();
  first.W.backupState();

  const reset = createApp({ storage, search: '?reset=1' });
  const loaded = reset.W.loadState();

  assert.equal(loaded.tournaments.length, 0);
  assert.equal(storage.getItem(KEY), null);
  assert.equal(storage.getItem(BACKUP), null);
});

test('自动备份不保存撤销栈，也不影响主数据里的撤销栈', () => {
  const { W, storage } = createApp();
  const { level } = makeLevel(W, 8);
  startLevel(W, level);
  step(W, level);
  assert.ok(level.undoStack.length > 0);

  W.backupState();

  const backups = JSON.parse(storage.getItem(BACKUP));
  assert.equal(backups.length, 1);
  assert.equal(backups[0].tournaments[0].levels[0].undoStack.length, 0);
  assert.ok(level.undoStack.length > 0);
});

test('导入校验：版本错误与空内容给出中文错误', () => {
  const { W } = createApp();
  assert.equal(W.normalizeState(null).error, 'JSON 内容不是对象');
  assert.equal(W.normalizeState({ version: 2, tournaments: [] }).error, 'JSON 版本不正确（应为 1）');
  assert.equal(W.normalizeState({ version: 1 }).error, '数据格式错误：缺少 tournaments 数组');
});

test('导入校验：旧版导出缺可选字段也能导入，并修复顺序', () => {
  const { W } = createApp();
  const data = {
    version: 1,
    tournaments: [{
      name: '旧赛事',
      levels: [{
        name: '旧级别',
        players: {
          p1: { name: '甲' }, p2: { name: '乙' },
        },
        playerOrder: ['p2', 'p1', '不存在'],
      }],
    }],
  };
  const result = W.normalizeState(data);
  assert.equal(result.error, undefined);
  const level = result.state.tournaments[0].levels[0];
  assert.equal(level.players.p1.name, '甲');
  assert.equal(level.id.length > 0, true);
  assert.deepEqual([...level.playerOrder], ['p2', 'p1']);
  assert.equal(level.grandFinal, null);
  assert.equal(level.pendingMatches.length, 0);
  assert.equal(level.banners.top8Shown, false);
});

test('导入校验：丢弃指向不存在选手的对阵与总决赛，不污染原型', () => {
  const { W } = createApp();
  const data = {
    version: 1,
    tournaments: [{
      levels: [{
        players: { p1: { name: '甲' }, p2: { name: '乙' } },
        pendingMatches: [
          { p1: 'p1', p2: 'p2', bracket: 'W' },
          { p1: 'p1', p2: 'ghost', bracket: 'W' },
          { p1: 'p1', p2: 'p1', bracket: 'W' },
        ],
        tables: [{ match: { p1: 'ghost', p2: 'p2' } }, { match: { p1: 'p1', p2: 'p2', bracket: 'L' } }],
        grandFinal: { p1: 'p1', p2: 'ghost', wins1: 1, completed: true, winnerId: 'p1' },
      }],
    }],
  };
  const result = W.normalizeState(data);
  const level = result.state.tournaments[0].levels[0];
  assert.equal(level.pendingMatches.length, 1);
  assert.equal(level.tables.length, 2);
  assert.equal(level.tables[0].match, null);
  assert.equal(level.tables[1].match.bracket, 'L');
  assert.equal(level.grandFinal, null);
  assert.ok(result.warnings.length >= 2);
  assert.equal(Object.values(level.players).length, 2);

  const polluted = JSON.parse('{"version":1,"tournaments":[{"levels":[{"players":{"p1":{"name":"甲"},"__proto__":{"name":"坏"}}}]}]}');
  const safe = W.normalizeState(polluted);
  assert.equal(Object.keys(safe.state.tournaments[0].levels[0].players).length, 1);
});

test('导入校验：当前导出能原样往返', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 16);
  startLevel(W, level);
  step(W, level);

  const result = W.normalizeState(JSON.parse(JSON.stringify(W.state)));
  assert.equal(result.error, undefined);
  const l2 = result.state.tournaments[0].levels[0];
  assert.equal(l2.name, level.name);
  assert.equal(Object.keys(l2.players).length, 16);
  assert.equal(l2.history.length, 1);
  assert.equal(l2.undoStack.length, level.undoStack.length);
  assert.ok(l2.tables.some((t) => t.match));
});

test('批量添加：与已有选手同名会加后缀，不再产生重名', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 2);
  const result = W.batchAddPlayers(level, '选手01\n张三\n张三');
  const names = Object.values(level.players).map((p) => p.name);

  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('选手01(2)'));
  assert.ok(names.includes('张三'));
  assert.ok(names.includes('张三(2)'));
  assert.deepEqual([...result.dupes], ['选手01', '张三']);
});

test('退赛识别：退赛为真，正常淘汰与总决赛负者为假', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 8);
  startLevel(W, level);
  const table = level.tables.find((t) => t.match);
  const withdrawnId = table.match.p1;
  W.withdrawPlayer(level, withdrawnId);
  assert.equal(W.isWithdrawn(level, level.players[withdrawnId]), true);

  runToEnd(W, level);
  for (const p of Object.values(level.players)) {
    if (p.id === withdrawnId) continue;
    assert.equal(W.isWithdrawn(level, p), false, `${p.name} 不应显示退赛`);
  }
  const runnerUp = level.players[level.grandFinal.runnerUpId];
  assert.equal(runnerUp.losses, 2);
  assert.equal(W.isWithdrawn(level, runnerUp), false);
});

test('主数据损坏时仍能从备份恢复', () => {
  const storage = createStorage();
  const first = createApp({ storage });
  makeLevel(first.W, 8);
  first.W.saveState();
  first.W.backupState();

  storage.setItem(KEY, '{ 不是合法 JSON');
  const second = createApp({ storage });
  const loaded = second.W.loadState();

  assert.equal(loaded.tournaments.length, 1);
  assert.equal(Object.keys(loaded.tournaments[0].levels[0].players).length, 8);
});
