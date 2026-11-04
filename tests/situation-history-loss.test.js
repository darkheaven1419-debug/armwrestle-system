'use strict';

/*
 * 定向回归：历史比赛卡片按“该场比赛发生时的累计负场”判定淘汰，
 * 而不是用选手最终 losses/eliminated 反推；总决赛结束后显示实际名次。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, makeLevel, startLevel, step, runToEnd } = require('./harness');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function matchNodes(layout) {
  return [...layout.wNodes.flat(), ...layout.lNodes.flat()];
}

function seatFor(layout, matchId, playerId) {
  const node = matchNodes(layout).find((n) => n.matchId === matchId);
  if (!node) return null;
  return [node.p1, node.p2].find((s) => s && s.id === playerId) || null;
}

function playUntil(W, level, predicate, maxSteps) {
  const limit = maxSteps || 500;
  for (let i = 0; i < limit; i += 1) {
    if (predicate(level)) return true;
    if (!step(W, level, 'p1')) return predicate(level);
  }
  return predicate(level);
}

function lossHistoryOf(level, playerId) {
  return (level.history || []).filter((h) => h.loserId === playerId);
}

function displaySnapshot(W, level) {
  const layout = W.buildSituationLayout(level);
  const seats = [];
  for (const node of matchNodes(layout)) {
    for (const seat of [node.p1, node.p2]) {
      if (!seat) continue;
      seats.push(`${node.matchId}:${seat.id}:${seat.result}:${seat.eliminatedHere ? 'out' : 'in'}`);
    }
  }
  const gf = [layout.gf.p1, layout.gf.p2].filter(Boolean)
    .map((seat) => `${seat.id}:${seat.placementShort}:${seat.eliminatedHere ? 'out' : 'in'}`);
  return plain({
    seats: seats.sort(),
    entries: layout.entries.map((e) => `${e.id}:${e.statusLabel}`).sort(),
    gf: gf.sort(),
  });
}

test('第一次失利：历史卡片显示「负」，不显示「淘汰」', () => {
  const { W } = createApp({ seed: 21 });
  const { level } = makeLevel(W, 4);
  startLevel(W, level);

  assert.ok(playUntil(W, level, (l) => Object.values(l.players)
    .some((p) => p.losses === 1 && !p.eliminatedAt)));
  const player = Object.values(level.players).find((p) => p.losses === 1 && !p.eliminatedAt);
  const losses = lossHistoryOf(level, player.id);
  assert.equal(losses.length, 1, '此刻应只有一场失利');

  const seat = seatFor(W.buildSituationLayout(level), losses[0].id, player.id);
  assert.ok(seat, '第一次失利的座位应保留在位置图中');
  assert.equal(seat.result, 'loss');
  assert.equal(seat.eliminatedHere, false, '第一次失利不能被标记为淘汰');
});

test('第二次失利：只有那一场显示「淘汰」，第一次仍是「负」', () => {
  const { W } = createApp({ seed: 22 });
  const { level } = makeLevel(W, 6);
  startLevel(W, level);

  assert.ok(playUntil(W, level, (l) => Object.values(l.players).some((p) => p.losses >= 2)));
  const player = Object.values(level.players).find((p) => p.losses >= 2);
  const losses = lossHistoryOf(level, player.id);
  assert.equal(losses.length, 2, '正常淘汰应来自两场真实失利');

  const layout = W.buildSituationLayout(level);
  const first = seatFor(layout, losses[0].id, player.id);
  const second = seatFor(layout, losses[1].id, player.id);
  assert.ok(first && second);
  assert.equal(first.result, 'loss');
  assert.equal(first.eliminatedHere, false, '第一次失利仍显示负');
  assert.equal(second.result, 'loss');
  assert.equal(second.eliminatedHere, true, '第二次失利才显示淘汰');
});

test('比赛结束后，第一次失利的卡片仍然显示「负」', () => {
  const { W } = createApp({ seed: 23 });
  const { level } = makeLevel(W, 8);
  startLevel(W, level);
  runToEnd(W, level, { pick: 'p1' });
  assert.equal(level.finished, true);

  const layout = W.buildSituationLayout(level);
  let checked = 0;
  for (const p of Object.values(level.players)) {
    const losses = lossHistoryOf(level, p.id);
    if (losses.length < 2) continue;
    const first = seatFor(layout, losses[0].id, p.id);
    const second = seatFor(layout, losses[1].id, p.id);
    assert.ok(first && second, `${p.name} 的两场失利都应保留在位置图中`);
    assert.equal(first.eliminatedHere, false, `${p.name} 第一次失利不应显示淘汰`);
    assert.equal(second.eliminatedHere, true, `${p.name} 第二次失利才显示淘汰`);
    checked += 1;
  }
  assert.ok(checked >= 3, '应有足够多的两负选手用于验证');
});

test('总决赛正常结束：胜者显示冠军，总决赛座位不再按普通淘汰展示', () => {
  const { W } = createApp({ seed: 24 });
  const { level } = makeLevel(W, 8);
  startLevel(W, level);
  runToEnd(W, level, { pick: 'p1' });

  const gf = level.grandFinal;
  assert.equal(gf.completed, true);
  const layout = W.buildSituationLayout(level);

  const winnerEntry = layout.entries.find((e) => e.id === gf.winnerId);
  assert.match(winnerEntry.statusLabel, /冠军/);

  const winnerSeat = [layout.gf.p1, layout.gf.p2].filter(Boolean)
    .find((s) => s.id === gf.winnerId);
  assert.equal(winnerSeat.placementShort, '冠军');
  assert.equal(winnerSeat.result, 'win');
});

test('总决赛败者显示现有排名算法确认的最终名次（当前正式赛制为亚军）', () => {
  const { W } = createApp({ seed: 25 });
  const { level } = makeLevel(W, 8);
  startLevel(W, level);
  runToEnd(W, level, { pick: 'p1' });

  const gf = level.grandFinal;
  const layout = W.buildSituationLayout(level);
  const loserEntry = layout.entries.find((e) => e.id === gf.runnerUpId);
  const loserSeat = [layout.gf.p1, layout.gf.p2].filter(Boolean)
    .find((s) => s.id === gf.runnerUpId);

  // 现有正式赛制：总决赛败者 = 第 2 名（亚军），与淘汰顺序/Excel 规则一致。
  // 这里只做展示，不改写排名算法；若将来赛制改变，此断言会先失败提醒。
  assert.equal(level.players[gf.runnerUpId].placement, 2);
  assert.match(loserEntry.statusLabel, /亚军/);
  assert.equal(loserSeat.placementShort, '亚军');
  assert.equal(loserSeat.result, 'loss');
  assert.equal(loserSeat.eliminatedHere, false, '总决赛败者不按普通淘汰展示');
});

test('刷新页面后，「负 / 淘汰」与总决赛名次显示不变', () => {
  const { W, storage } = createApp({ seed: 26 });
  const { level } = makeLevel(W, 8);
  startLevel(W, level);
  runToEnd(W, level, { pick: 'p1' });

  const before = displaySnapshot(W, level);
  W.saveState();

  const reloaded = createApp({ storage });
  reloaded.W.state = reloaded.W.loadState();
  const restored = reloaded.W.state.tournaments[0].levels[0];
  const after = displaySnapshot(reloaded.W, restored);

  assert.deepEqual(after, before);
});

test('撤回比赛后，历史负场与淘汰状态正确恢复', () => {
  const { W } = createApp({ seed: 27 });
  const { level } = makeLevel(W, 6);
  startLevel(W, level);
  assert.ok(playUntil(W, level, (l) => Object.values(l.players).some((p) => p.losses >= 2)));

  const player = Object.values(level.players).find((p) => p.losses >= 2);
  const secondLoss = lossHistoryOf(level, player.id)[1];
  assert.ok(secondLoss);

  assert.ok(W.undoLast(level, 'global'));
  W.fillTables(level);

  assert.equal(level.players[player.id].losses, 1, '撤销后回到 1 负');
  assert.equal(level.players[player.id].eliminatedAt, null, '撤销后不再淘汰');
  assert.equal(level.history.some((h) => h.id === secondLoss.id), false);

  const layout = W.buildSituationLayout(level);
  const remaining = lossHistoryOf(level, player.id);
  assert.equal(remaining.length, 1);
  const seat = seatFor(layout, remaining[0].id, player.id);
  assert.ok(seat);
  assert.equal(seat.eliminatedHere, false, '撤销后剩余失利仍显示负');
});

test('退回赛前设置后，赛情不残留旧的胜负状态', () => {
  const { W } = createApp({ seed: 28 });
  const { level } = makeLevel(W, 6);
  startLevel(W, level);
  assert.ok(playUntil(W, level, (l) => l.history.length >= 3));

  assert.equal(W.resetLevelToSetup(level), true);
  const layout = W.buildSituationLayout(level);

  assert.equal(level.history.length, 0);
  assert.deepEqual(plain(layout.entries.map((e) => e.statusLabel)), new Array(6).fill('赛前'));
  assert.equal(matchNodes(layout).every((n) => !n.p1 && !n.p2), true, '不应残留旧的胜负座位');
  assert.equal(layout.gf.status, 'empty');
});
