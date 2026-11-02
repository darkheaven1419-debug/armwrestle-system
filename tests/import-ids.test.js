'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { createApp, makeLevel, startLevel, step } = require('./harness');

const DANGEROUS = ['__proto__', 'constructor', 'prototype'];

function protoKeys(app) {
  return Object.getOwnPropertyNames(vm.runInContext('Object.prototype', app.context)).sort();
}

function rawLevel(bad) {
  return {
    name: '污染测试',
    started: true,
    players: { p1: { name: '甲' }, p2: { name: '乙' } },
    playerOrder: [bad, 'p1', 'p2'],
    drawOrder: ['p1', bad, 'p2'],
    byes: [bad],
    pendingMatches: [
      { p1: bad, p2: 'p1', bracket: 'W' },
      { p1: 'p2', p2: bad, bracket: 'W' },
    ],
    tables: [{ match: { p1: bad, p2: 'p1' } }, { match: null }],
    history: [
      { p1: 'p1', p2: 'p2', winnerId: bad, loserId: 'p2' },
      { p1: 'p1', p2: 'p2', winnerId: 'p1', loserId: bad },
    ],
    grandFinal: {
      p1: bad, p2: 'p1', wins1: 1, wins2: 0,
      completed: true, winnerId: bad, runnerUpId: 'p1',
    },
  };
}

function importLevel(W, bad) {
  return W.normalizeState({
    version: 1,
    tournaments: [{ name: '污染赛事', levels: [rawLevel(bad)] }],
  }).state.tournaments[0].levels[0];
}

for (const bad of DANGEROUS) {
  test(`危险 ID「${bad}」不会生成幽灵对局、决赛或历史`, () => {
    const app = createApp();
    const { W } = app;
    const before = protoKeys(app);

    const level = importLevel(W, bad);

    assert.equal(level.pendingMatches.length, 0);
    assert.equal(level.tables[0].match, null);
    assert.equal(level.history.length, 0);
    assert.equal(level.grandFinal, null);
    assert.deepEqual([...level.playerOrder], ['p1', 'p2']);
    assert.deepEqual([...level.drawOrder], ['p1', 'p2']);
    assert.equal(level.byes.length, 0);
    assert.equal(Object.keys(level.players).length, 2);

    // 名次计算和赛情渲染都不能异常或写脏 Object.prototype
    assert.doesNotThrow(() => W.getRankingView(level));
    assert.doesNotThrow(() => W.buildSituation(level));
    assert.deepEqual(protoKeys(app), before);
  });
}

test('危险 ID 作为总决赛 winnerId：决赛保留但标记未完成', () => {
  const app = createApp();
  const { W } = app;
  const before = protoKeys(app);
  const data = {
    version: 1,
    tournaments: [{
      levels: [{
        players: { p1: { name: '甲' }, p2: { name: '乙' } },
        grandFinal: {
          p1: 'p1', p2: 'p2', wins1: 2, wins2: 0,
          completed: true, winnerId: '__proto__', runnerUpId: 'p2',
        },
      }],
    }],
  };

  const level = W.normalizeState(data).state.tournaments[0].levels[0];

  assert.ok(level.grandFinal, '双方选手有效时总决赛本身保留');
  assert.equal(level.grandFinal.completed, false);
  assert.equal(level.grandFinal.winnerId, null);
  assert.equal(level.grandFinal.runnerUpId, 'p2');
  assert.equal(level.grandFinal.wins1, 2);
  assert.equal(level.finished, false);

  assert.doesNotThrow(() => W.getRankingView(level));
  assert.deepEqual(protoKeys(app), before);
  assert.equal(vm.runInContext('Object.prototype.placement === undefined', app.context), true);
});

test('players 映射中的危险自有键全部被丢弃', () => {
  const app = createApp();
  const { W } = app;
  const before = protoKeys(app);
  const polluted = JSON.parse(
    '{"version":1,"tournaments":[{"levels":[{"players":{'
    + '"p1":{"name":"甲"},"__proto__":{"name":"坏"},'
    + '"constructor":{"name":"坏"},"prototype":{"name":"坏"}}}]}]}'
  );

  const level = W.normalizeState(polluted).state.tournaments[0].levels[0];

  assert.equal(Object.keys(level.players).length, 1);
  assert.equal(level.players.p1.name, '甲');
  assert.deepEqual(protoKeys(app), before);
});

test('正常随机 ID、正常对阵与排名不受影响', () => {
  const app = createApp({ seed: 11 });
  const { W } = app;
  const { level } = makeLevel(W, 8);
  startLevel(W, level);
  step(W, level);

  for (const id of Object.keys(level.players)) {
    assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(DANGEROUS.includes(id), false);
  }

  const result = W.normalizeState(JSON.parse(JSON.stringify(W.state)));
  assert.equal(result.error, undefined);
  const l2 = result.state.tournaments[0].levels[0];
  assert.equal(Object.keys(l2.players).length, 8);
  assert.equal(l2.history.length, 1);
  assert.equal(l2.history[0].winnerId, level.history[0].winnerId);
  assert.ok(l2.pendingMatches.length > 0);

  const rows = W.getRankingView(l2);
  assert.equal(rows.length, 8);
  assert.equal(rows[0].status, 'pending');
});
