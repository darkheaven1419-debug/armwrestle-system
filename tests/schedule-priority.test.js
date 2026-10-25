'use strict';

/*
 * 双败赛制调度优先级回归测试。
 * 核心规则：每次给空桌分配比赛时，只要队列里存在双方都空闲的胜者组比赛，
 * 就必须先安排胜者组；败者组只能在当前没有可开赛胜者组时上场。
 *
 * 这些测试从真实的首轮发牌开始推进完整 9 人赛事，不预先构造排好的队列。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApp,
  makeLevel,
  startLevel,
} = require('./harness');

/* 包住 W.fillTables：记录每次实际分配，并在分配后校验优先级不变式。 */
function attachRecorder(W) {
  const records = [];
  const original = W.fillTables;
  W.fillTables = function recordedFillTables(level) {
    const beforeIds = level.tables.map((t) => (t.match ? t.match.id : null));
    const pendingBefore = level.pendingMatches.map((m) => ({ ...m }));
    original(level);

    const assigned = [];
    level.tables.forEach((t, i) => {
      if (t.match && beforeIds[i] !== t.match.id) {
        assigned.push({
          tableNo: t.tableNo,
          id: t.match.id,
          bracket: t.match.bracket,
          p1: t.match.p1,
          p2: t.match.p2,
        });
      }
    });

    const inUse = new Set();
    for (const t of level.tables) {
      if (!t.match) continue;
      inUse.add(t.match.p1);
      inUse.add(t.match.p2);
    }
    const violations = [];
    for (const a of assigned) {
      if (a.bracket === 'W') continue;
      const playableW = level.pendingMatches.find(
        (m) => m.bracket === 'W' && !inUse.has(m.p1) && !inUse.has(m.p2),
      );
      if (playableW) {
        violations.push({
          assignedL: a.id,
          tableNo: a.tableNo,
          skippedW: playableW.id,
          skippedWPlayers: [playableW.p1, playableW.p2],
        });
      }
    }
    records.push({ pendingBefore, assigned, violations });
    return undefined;
  };
  return records;
}

function names(level, ids) {
  return ids.map((id) => level.players[id]?.name || id);
}

/*
 * 按真实界面顺序推进：生成 -> 填桌 -> 结算一场。
 * 返回本场记录；无事可做时返回 null（总决赛单独处理）。
 */
function advance(W, level, schedule, options) {
  const opts = options || {};
  W.generateMatchesIfNeeded(level);
  W.fillTables(level);
  const table = level.tables.find((t) => t.match);
  if (!table) {
    if (level.grandFinal && !level.grandFinal.completed) {
      const gf = level.grandFinal;
      const which = opts.gfPickP2 ? 2 : 1;
      const evt = W.recordGrandFinalWin(level, which);
      W.finalizeIfDone(level);
      schedule.push({
        type: 'grandFinal',
        game: (gf.wins1 || 0) + (gf.wins2 || 0),
        bracket: 'GF',
        p1: names(level, [gf.p1])[0],
        p2: names(level, [gf.p2])[0],
        winner: names(level, [which === 1 ? gf.p1 : gf.p2])[0],
        evt: evt && evt.type,
        losses1: level.players[gf.p1]?.losses ?? null,
        losses2: level.players[gf.p2]?.losses ?? null,
      });
      return { type: 'grandFinal' };
    }
    W.finalizeIfDone(level);
    return null;
  }

  const match = table.match;
  const pickP2 = opts.alternate && schedule.length % 2 === 1;
  const winnerId = pickP2 ? match.p2 : match.p1;
  const loserId = winnerId === match.p1 ? match.p2 : match.p1;
  const entry = {
    type: 'match',
    tableNo: table.tableNo,
    bracket: match.bracket,
    matchId: match.id,
    players: names(level, [match.p1, match.p2]),
    winner: names(level, [winnerId])[0],
    loser: names(level, [loserId])[0],
  };
  W.resolveMatch(level, table.tableNo, winnerId);
  W.finalizeIfDone(level);
  const loser = level.players[loserId];
  entry.loserLossesAfter = loser ? loser.losses : null;
  entry.loserEliminated = !!(loser && (loser.losses >= 2 || loser.eliminatedAt));
  schedule.push(entry);
  return entry;
}

function runTournament(W, level, options) {
  const schedule = [];
  let guard = 0;
  while (!level.finished && guard < 500) {
    guard += 1;
    const result = advance(W, level, schedule, options);
    if (!result) break;
  }
  return schedule;
}

function assertNoPriorityViolations(records) {
  const all = [];
  for (const r of records) all.push(...r.violations);
  assert.deepEqual(all, [], `败者组抢在可开赛胜者组之前上场：\n${JSON.stringify(all, null, 2)}`);
}

function assertNoDuplicatePlayersOnTables(level) {
  const seen = new Set();
  for (const t of level.tables) {
    if (!t.match) continue;
    for (const id of [t.match.p1, t.match.p2]) {
      assert.equal(seen.has(id), false, `选手 ${id} 同时出现在多张桌子上`);
      seen.add(id);
    }
  }
}

function assertCompletePlacements(W, level, expectedCount) {
  W.computePlacements(level);
  const placements = Object.values(level.players).map((p) => p.placement).sort((a, b) => a - b);
  assert.deepEqual(placements, Array.from({ length: expectedCount }, (_, i) => i + 1));
}

for (const maxTables of [1, 3]) {
  test(`9 人双败完整模拟（${maxTables} 桌）：败者组不会抢在可开赛胜者组之前`, () => {
    const { W } = createApp({ seed: 20261025 });
    const { level } = makeLevel(W, 9, { maxTables });
    const records = attachRecorder(W);

    startLevel(W, level);
    // 首轮：9 人 -> 4 场胜者组 + 1 个轮空，不应生成败者组假比赛
    const firstRound = [
      ...level.pendingMatches.map((m) => m.bracket),
      ...level.tables.filter((t) => t.match).map((t) => t.match.bracket),
    ];
    assert.equal(firstRound.length, 4);
    assert.deepEqual(new Set(firstRound), new Set(['W']));
    assert.equal(level.grandFinal, null);

    const schedule = runTournament(W, level, { alternate: true });

    assertNoPriorityViolations(records);
    assert.equal(level.finished, true);
    assertCompletePlacements(W, level, 9);

    // 记录里必须同时出现胜者组、败者组和总决赛，证明赛事真实推进完整
    const brackets = new Set(schedule.map((s) => s.bracket));
    assert.ok(brackets.has('W'));
    assert.ok(brackets.has('L'));
    assert.ok(brackets.has('GF'));

    // 单桌时“胜者组优先”意味着整个胜者组阶段先完成，再接败者组
    if (maxTables === 1) {
      const bracketOrder = schedule.map((s) => s.bracket);
      const lastW = bracketOrder.lastIndexOf('W');
      const firstL = bracketOrder.indexOf('L');
      assert.ok(lastW < firstL, `单桌顺序应为全部胜者组先于败者组：${bracketOrder.join(',')}`);
    }

    // 最后一场正赛结束后每桌仍不应有重复选手
    assertNoDuplicatePlayersOnTables(level);

    // 总决赛 BO3 不会产生额外负场误记
    const gf = level.grandFinal;
    assert.equal(gf.completed, true);
    assert.ok(gf.wins1 === 2 || gf.wins2 === 2);
  });
}

test('9 人赛事中每场实际分配都带真实阶段元信息，且同组内保持队列顺序', () => {
  const { W } = createApp({ seed: 99 });
  const { level } = makeLevel(W, 9, { maxTables: 1 });
  const records = attachRecorder(W);
  startLevel(W, level);
  runTournament(W, level, {});

  for (const r of records) {
    const beforeW = Array.from(r.pendingBefore, (m) => m).filter((m) => m.bracket === 'W').map((m) => m.id);
    const assignedW = r.assigned.filter((m) => m.bracket === 'W').map((m) => m.id);
    if (!assignedW.length) continue;
    // 同一阶段被分配到桌子的 W 比赛，必须按它们在队列中的原有先后顺序取用
    const expected = beforeW.filter((id) => assignedW.includes(id));
    assert.deepEqual(assignedW, expected);
  }
});

test('只有被占用的胜者组时，允许败者组上桌，避免空桌死等', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 6, { maxTables: 2 });
  startLevel(W, level);

  const ids = Object.keys(level.players);
  const running = level.tables.find((t) => t.match).match;
  const busyId = running.p1;
  const free = ids.filter((id) => id !== running.p1 && id !== running.p2);
  assert.ok(free.length >= 3);

  level.tables = [
    { tableNo: 1, match: running, undo: [] },
    { tableNo: 2, match: null, undo: [] },
  ];
  level.pendingMatches = [
    { id: 'blocked-W', createdAt: 1, bracket: 'W', p1: busyId, p2: free[0], tableNo: null },
    { id: 'ready-L', createdAt: 2, bracket: 'L', p1: free[1], p2: free[2], tableNo: null },
  ];

  W.fillTables(level);
  const table2 = level.tables.find((t) => t.tableNo === 2);
  assert.equal(table2.match.id, 'ready-L', '胜者组被占用时不应让桌子空着');
  assert.equal(level.pendingMatches.some((m) => m.id === 'blocked-W'), true, '被占用的胜者组仍留在队列');
});

test('队列中有可开赛的胜者组时，即使它排在败者组之后也必须先上场', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 6, { maxTables: 1 });
  startLevel(W, level);

  const ids = Object.keys(level.players);
  level.tables = [{ tableNo: 1, match: null, undo: [] }];
  level.pendingMatches = [
    { id: 'first-L', createdAt: 1, bracket: 'L', p1: ids[0], p2: ids[1], tableNo: null },
    { id: 'second-W', createdAt: 2, bracket: 'W', p1: ids[2], p2: ids[3], tableNo: null },
  ];

  const view = W.getMatchupView(level);
  assert.equal(view.next.matchId, 'second-W', '看板的下一组也必须遵守引擎优先级');

  W.fillTables(level);
  assert.equal(level.tables[0].match.id, 'second-W');
  assert.deepEqual(level.pendingMatches.map((m) => m.id), ['first-L']);
});

test('空队列、无效对阵和已淘汰残留不会造成异常或死锁', () => {
  const { W } = createApp();
  const { level } = makeLevel(W, 4);
  startLevel(W, level);

  level.pendingMatches = [];
  level.tables = [{ tableNo: 1, match: null, undo: [] }];
  assert.equal(W.selectNextPendingIndex(level, new Set()), -1);
  W.fillTables(level);
  assert.equal(level.tables[0].match, null);

  level.pendingMatches = [
    { id: 'bad-same', createdAt: 1, bracket: 'W', p1: 'x', p2: 'x', tableNo: null },
    { id: 'bad-empty', createdAt: 2, bracket: 'L', p1: null, p2: 'y', tableNo: null },
  ];
  assert.equal(W.selectNextPendingIndex(level, new Set()), -1);
  W.fillTables(level);
  assert.equal(level.tables[0].match, null);
});

test('名次与淘汰先后一致：越早淘汰名次越靠后', () => {
  const { W } = createApp({ seed: 7 });
  const { level } = makeLevel(W, 9);
  startLevel(W, level);
  runTournament(W, level, {});

  W.computePlacements(level);
  const eliminated = Object.values(level.players)
    .filter((p) => p.eliminatedAt)
    .sort((a, b) => a.eliminatedSeq - b.eliminatedSeq);
  assert.ok(eliminated.length >= 8);
  assert.deepEqual(eliminated.map((p) => p.eliminatedSeq), eliminated.map((_, i) => i + 1));

  for (let i = 1; i < eliminated.length; i++) {
    const earlier = eliminated[i - 1];
    const later = eliminated[i];
    // 淘汰序号唯一，因此名次必须严格递减（数字越大名次越靠后）
    assert.ok(earlier.placement > later.placement,
      `更早淘汰的 ${earlier.name}（#${earlier.placement}）不应排在 ${later.name}（#${later.placement}）之前`);
  }

  const champ = Object.values(level.players).find((p) => p.placement === 1);
  assert.ok(champ);
  assert.equal(champ.eliminatedAt, null);
});

test('同一毫秒内连续淘汰时名次仍由淘汰序号决定', () => {
  const { W } = createApp({ seed: 13 });
  const { level } = makeLevel(W, 9);
  startLevel(W, level);
  runTournament(W, level, {});

  const eliminated = Object.values(level.players)
    .filter((p) => p.eliminatedAt)
    .sort((a, b) => a.eliminatedSeq - b.eliminatedSeq);
  assert.ok(eliminated.length >= 8);

  // 模拟快速连续结算：把所有淘汰时间压成同一个毫秒
  const sameStamp = 1700000000000;
  for (const p of eliminated) p.eliminatedAt = sameStamp;

  W.computePlacements(level);
  for (let i = 1; i < eliminated.length; i++) {
    const earlier = eliminated[i - 1];
    const later = eliminated[i];
    assert.ok(earlier.placement > later.placement,
      `同一毫秒淘汰时，先淘汰的 ${earlier.name}（#${earlier.placement}）应排在后淘汰的 ${later.name}（#${later.placement}）之后`);
  }

  const champion = Object.values(level.players).find((p) => p.placement === 1);
  assert.ok(champion);
  assert.equal(champion.eliminatedAt, null);
});

test('补充对阵与撤回不会因优先级改动而丢失比赛或破坏负场', () => {
  const { W } = createApp({ seed: 11 });
  const { level } = makeLevel(W, 9);
  startLevel(W, level);

  // 推进到第二轮，制造 W/L 混合队列
  for (let i = 0; i < 5; i++) advance(W, level, []);
  const beforeHistory = level.history.length;
  const beforeLosses = Object.values(level.players).reduce((sum, p) => sum + p.losses, 0);

  assert.ok(level.history.length > 0);
  const msg = W.undoLast(level, 'global');
  assert.ok(msg);
  assert.equal(level.history.length, beforeHistory - 1);
  const afterLosses = Object.values(level.players).reduce((sum, p) => sum + p.losses, 0);
  assert.ok(afterLosses < beforeLosses);

  // 撤回后继续推进仍然可以正常完赛
  runTournament(W, level, {});
  assert.equal(level.finished, true);
  assertCompletePlacements(W, level, 9);
});
