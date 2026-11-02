'use strict';

/*
 * 「下一组」看板与实际排桌一致性回归测试。
 *
 * 背景：自动缩桌（存活人数跨过 16/8 阈值）时，被撤下的比赛曾被 unshift 到
 * 候场队列队首，空出来的桌子于是先打这场“被撤回”的比赛，而看板显示的是
 * 原队列里的下一场。修复后缩桌只 push 到队尾，且看板与 fillTables 共用
 * 同一个 pickNextPending 选择结果。
 *
 * 这些测试以合成选手从真实首轮发牌开始逐步推进，在每一步比较：
 * - 看板显示的「下一组」是否就是结算后实际上桌的那一场；
 * - 同一选手不会同时出现在两张桌上/两场未完成比赛里；
 * - 未满足波次闸门的败者组比赛不会被提前安排。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp, makeLevel } = require('./harness');

function nameOf(level, id) {
  return level.players[id]?.name || id;
}

function liveMatches(level) {
  return [
    ...level.pendingMatches,
    ...level.tables.filter((t) => t.match).map((t) => t.match),
  ];
}

function assertNoDoubleBooking(level, label) {
  const seen = new Set();
  for (const m of liveMatches(level)) {
    if (!m || !m.p1 || !m.p2 || m.p1 === m.p2) continue;
    for (const id of [m.p1, m.p2]) {
      assert.equal(seen.has(id), false,
        `${label}：选手 ${nameOf(level, id)} 同时出现在两场未完成比赛里`);
      seen.add(id);
    }
  }
}

function assertNoEarlyLoserMatch(W, level, label) {
  for (const t of level.tables) {
    if (!t.match || t.match.bracket !== 'L') continue;
    assert.equal(W.isLoserStageReady(level, t.match), true,
      `${label}：败者组 ${nameOf(level, t.match.p1)} vs ${nameOf(level, t.match.p2)} 未满足波次闸门就被安排上桌`);
  }
}

function start(W, level) {
  W.startLevel(level);
  W.generateMatchesIfNeeded(level);
  W.fillTables(level);
  W.finalizeIfDone(level);
}

/*
 * 推进一场并返回「结算前看板显示的下一组」与「结算后实际的桌上比赛」。
 * 返回 null 表示赛事已结束或没有可结算的比赛。
 */
function advanceOne(W, level) {
  const view = W.getMatchupView(level);
  const tables = level.tables.filter((t) => t.match);
  if (!tables.length) {
    if (level.grandFinal && !level.grandFinal.completed) {
      W.recordGrandFinalWin(level, 1);
      W.finalizeIfDone(level);
      return { type: 'grandFinal' };
    }
    return null;
  }

  const table = tables[0];
  const beforeTableIds = new Set(level.tables.filter((t) => t.match).map((t) => t.match.id));
  const beforeTableCount = level.tables.length;
  const beforePending = level.pendingMatches.length;
  W.resolveMatch(level, table.tableNo, table.match.p1);
  W.finalizeIfDone(level);
  W.generateMatchesIfNeeded(level);
  W.fillTables(level);
  W.finalizeIfDone(level);

  const landed = level.tables
    .filter((t) => t.match && !beforeTableIds.has(t.match.id))
    .map((t) => t.match);
  return {
    type: 'match',
    view,
    resolvedNo: table.tableNo,
    landed,
    beforeTableCount,
    beforePending,
    afterTableCount: level.tables.length,
  };
}

/* ---------- 问题一：显示 == 实际 ---------- */

for (const count of [6, 17]) {
  for (const maxTables of [1, 2, 3]) {
    for (const seed of [1, 2, 3, 7, 11, 2026]) {
      test(`${count} 人 / 最多 ${maxTables} 桌 / 种子 ${seed}：每一步看板下一组都等于实际上桌`, () => {
        const { W } = createApp({ seed });
        const { level } = makeLevel(W, count, { maxTables });
        start(W, level);

        let guard = 0;
        while (!level.finished && guard < 500) {
          guard += 1;
          const label = `${count}人 seed=${seed} 第${guard}步`;
          assertNoDoubleBooking(level, label);
          assertNoEarlyLoserMatch(W, level, label);

          const step = advanceOne(W, level);
          if (!step) break;
          if (step.type !== 'match') continue;

          const { view, landed } = step;
          if (view.next && view.nextStatus === 'ready') {
            assert.ok(
              landed.some((m) => m.id === view.next.matchId),
              `${label}：看板显示下一组 ${nameOf(level, view.next.p1)} vs ${nameOf(level, view.next.p2)}`
              + `（${view.next.matchId}），实际新上桌的是 `
              + `${landed.map((m) => `${nameOf(level, m.p1)} vs ${nameOf(level, m.p2)}（${m.id}）`).join('、') || '无'}`,
            );

            // 有双方都空闲的可安排比赛时，不允许空桌晾着它
            const emptyTable = level.tables.some((t) => !t.match);
            const stillPending = level.pendingMatches.some((m) => m.id === view.next.matchId);
            assert.equal(emptyTable && stillPending, false,
              `${label}：看板显示 ready，但空桌存在且该场仍在候场队列`);
          }

          assertNoDoubleBooking(level, label + '（结算后）');
          assertNoEarlyLoserMatch(W, level, label + '（结算后）');
        }

        assert.equal(level.finished, true, `${count} 人 / ${maxTables} 桌 / seed ${seed} 应自然结束`);
      });
    }
  }
}

test('缩桌回归：被撤下的比赛回到队尾，绝不抢看板已显示的下一组', () => {
  const { W } = createApp({ seed: 1 });
  const { level } = makeLevel(W, 11, { maxTables: 2 });
  start(W, level);

  let shrinkEvents = 0;
  let shrinkWithQueue = 0;
  let guard = 0;
  while (!level.finished && guard < 500) {
    guard += 1;
    const step = advanceOne(W, level);
    if (!step) break;
    if (step.type !== 'match') continue;
    if (step.afterTableCount >= step.beforeTableCount) continue;

    shrinkEvents += 1;
    if (step.beforePending > 0) {
      shrinkWithQueue += 1;
      assert.equal(step.view.nextStatus, 'ready',
        `缩桌前队列非空，看板应能给出下一组；实际状态 ${step.view.nextStatus}`);
      assert.ok(step.landed.length > 0, '缩桌后释放出的桌子应立刻补上比赛');
      assert.ok(step.view.next, '缩桌前看板应有 next');
      assert.equal(step.landed[0].id, step.view.next.matchId,
        `缩桌时看板显示 ${step.view.next.matchId}，实际先上的是 ${step.landed[0].id}`);
    }
  }

  assert.ok(shrinkEvents > 0, '该场景应发生自动缩桌，否则回归测试失去意义');
  assert.ok(shrinkWithQueue > 0, '该场景应在候场队列非空时缩桌，才能覆盖插队缺陷');
  assert.equal(level.finished, true);
});
