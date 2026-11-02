'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, makeLevel, startLevel, step } = require('./harness');

function reachGrandFinal(W, level) {
  let guard = 0;
  while (!level.grandFinal && guard < 300) {
    if (!step(W, level, 'p1')) break;
    guard += 1;
  }
  assert.ok(level.grandFinal, '应进入总决赛');
  return level.grandFinal;
}

function prepare() {
  const app = createApp({ seed: 7 });
  const { level } = makeLevel(app.W, 8);
  startLevel(app.W, level);
  const gf = reachGrandFinal(app.W, level);
  return { ...app, level, gf };
}

test('总决赛 BO3 2:0：先赢两局夺冠，结束原因为 normal', () => {
  const { W, level, gf } = prepare();
  assert.equal(W.recordGrandFinalWin(level, 1).type, 'gfPoint');
  assert.equal(gf.completed, false);

  const evt = W.recordGrandFinalWin(level, 1);
  assert.equal(evt.type, 'gfComplete');
  assert.equal(gf.completed, true);
  assert.equal(gf.endReason, 'normal');
  assert.equal(gf.winnerId, gf.p1);
  assert.equal(gf.runnerUpId, gf.p2);
  assert.equal(gf.wins1, 2);
  assert.equal(gf.wins2, 0);
  assert.equal(level.finished, true);
  assert.equal(W.recordGrandFinalWin(level, 1), null, '结束后不能再录局分');
});

test('总决赛 BO3 2:1：比分正确且只在 2 胜时结束', () => {
  const { W, level, gf } = prepare();
  W.recordGrandFinalWin(level, 1);
  W.recordGrandFinalWin(level, 2);
  assert.equal(gf.completed, false, '1:1 时不能提前结束');

  const evt = W.recordGrandFinalWin(level, 1);
  assert.equal(evt.type, 'gfComplete');
  assert.equal(gf.wins1, 2);
  assert.equal(gf.wins2, 1);
  assert.equal(gf.winnerId, gf.p1);
  assert.equal(gf.endReason, 'normal');
});

for (const side of ['p1', 'p2']) {
  const label = side === 'p1' ? '胜者组决赛选手' : '败者组决赛选手';

  test(`总决赛中${label}退赛：另一人直接夺冠，退赛者获亚军`, () => {
    const { W, level, gf } = prepare();
    const withdrawnId = gf[side];
    const otherId = side === 'p1' ? gf.p2 : gf.p1;

    assert.equal(W.withdrawPlayer(level, withdrawnId), true);

    assert.equal(gf.completed, true);
    assert.equal(gf.endReason, 'withdrawal');
    assert.equal(gf.winnerId, otherId);
    assert.equal(gf.runnerUpId, withdrawnId);
    assert.equal(level.finished, true);
    // 退赛判定不伪造 BO3 局分
    assert.equal(gf.wins1, 0);
    assert.equal(gf.wins2, 0);

    // 旧按钮 / 旧录分接口全部失效
    assert.equal(W.recordGrandFinalWin(level, 1), null);
    assert.equal(W.recordGrandFinalWin(level, 2), null);
    assert.equal(W.undoGrandFinalPoint(level), null);

    // 实时排名：冠军是未退赛者，亚军是退赛者
    const rows = W.getRankingView(level);
    assert.equal(rows[0].playerId, otherId);
    assert.equal(rows[1].playerId, withdrawnId);
    assert.equal(W.isWithdrawn(level, level.players[withdrawnId]), true);

    // 赛情不再把退赛者显示为当前总决赛参赛者
    const model = W.buildSituation(level);
    assert.equal(model.current, null);
    assert.equal(model.grandFinal.completed, true);
    assert.equal(model.grandFinal.winnerId, otherId);
    const layout = W.buildSituationLayout(level);
    assert.equal(layout.gf.status, 'done');
  });
}

test('退赛后刷新：冠军、亚军和结束状态保持不变', () => {
  const { W, storage, level, gf } = prepare();
  const withdrawnId = gf.p1;
  const otherId = gf.p2;
  W.withdrawPlayer(level, withdrawnId);
  W.saveState();

  const second = createApp({ storage });
  const loaded = second.W.loadState();
  const l2 = loaded.tournaments[0].levels[0];

  assert.equal(l2.finished, true);
  assert.equal(l2.grandFinal.completed, true);
  assert.equal(l2.grandFinal.endReason, 'withdrawal');
  assert.equal(l2.grandFinal.winnerId, otherId);
  assert.equal(l2.grandFinal.runnerUpId, withdrawnId);

  const rows = second.W.getRankingView(l2);
  assert.equal(rows[0].playerId, otherId);
  assert.equal(rows[1].playerId, withdrawnId);

  const model = second.W.buildSituation(l2);
  assert.equal(model.current, null);
  assert.equal(model.grandFinal.completed, true);
});

test('退赛后全局撤回：恢复未完成总决赛，并可正常打完 BO3', () => {
  const { W, level, gf } = prepare();
  const withdrawnId = gf.p1;
  const beforeLosses = level.players[withdrawnId].losses;

  W.withdrawPlayer(level, withdrawnId);
  assert.equal(level.finished, true);

  assert.equal(W.undoLast(level, 'global'), '已撤销最近一场比赛');
  assert.equal(level.finished, false);
  assert.equal(level.grandFinal.completed, false);
  assert.equal(level.players[withdrawnId].losses, beforeLosses);
  assert.equal(W.alivePlayers(level).length, 2);

  // 撤回到正常总决赛后，原 BO3 规则恢复
  W.recordGrandFinalWin(level, 2);
  const evt = W.recordGrandFinalWin(level, 2);
  assert.equal(evt.type, 'gfComplete');
  assert.equal(level.grandFinal.winnerId, gf.p2);
  assert.equal(level.grandFinal.endReason, 'normal');
  assert.equal(level.finished, true);
});

test('双方决赛选手都无法继续：保留未决状态，不猜测冠军', () => {
  const { W, level, gf } = prepare();
  for (const id of [gf.p1, gf.p2]) {
    const p = level.players[id];
    p.losses = 2;
    W.markEliminated(level, p);
  }

  W.finalizeIfDone(level);
  assert.equal(level.finished, false);
  assert.equal(gf.needsManual, true);
  assert.equal(W.recordGrandFinalWin(level, 1), null);

  const rows = W.getRankingView(level);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].name, null);
  const model = W.buildSituation(level);
  assert.equal(model.current, null);
});
