'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, createStorage, makeLevel, startLevel, step } = require('./harness');

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
