'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, createStorage, makeLevel } = require('./harness');

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
