'use strict';

/*
 * 定向回归：跨级别选手冲突避免。
 * 只验证调度模型（utils/state/bracket），不加载 UI。
 * 覆盖：占用表、合法替代、等待原因、结算/撤回后的重算、预留唯一性、
 * 总决赛占用与释放、单级别详情页路径、独立赛事隔离、同名不合并、旧冲突不自动取消。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('./harness');

let matchSeq = 0;

function newTournament(W, name) {
  const t = W.createTournament(name || '多级别赛事');
  W.state.tournaments.push(t);
  return t;
}

function addLevel(W, t, name, names) {
  const level = W.createLevel({ name, maxTables: 1 });
  t.levels.push(level);
  W.batchAddPlayers(level, names.join('\n'));
  return level;
}

function idOf(level, name) {
  const p = Object.values(level.players).find((x) => x.name === name);
  assert.ok(p, `找不到选手 ${name}`);
  return p.id;
}

/* 直接用受控状态构造：不随机抽签，确保测试可复现 */
function begin(level) {
  level.started = true;
  level.finished = false;
  level.tables = [{ tableNo: 1, match: null, undo: [] }];
  level.pendingMatches = [];
  level.history = [];
  level.undoStack = [];
}

function addPending(level, a, b, bracket) {
  const m = {
    id: `pm${++matchSeq}`, createdAt: 0, bracket: bracket || 'W', round: 1,
    p1: idOf(level, a), p2: idOf(level, b), tableNo: null,
  };
  level.pendingMatches.push(m);
  return m;
}

function seat(level, a, b) {
  const m = {
    id: `sm${++matchSeq}`, createdAt: 0, bracket: 'W', round: 1,
    p1: idOf(level, a), p2: idOf(level, b), tableNo: 1,
  };
  level.tables[0].match = m;
  return m;
}

function tableNames(level) {
  const m = level.tables[0] && level.tables[0].match;
  return m ? [level.players[m.p1].name, level.players[m.p2].name].sort() : [];
}

function allTableNames(levels) {
  const out = [];
  for (const lv of levels) {
    for (const t of lv.tables) {
      if (!t.match) continue;
      out.push(lv.players[t.match.p1].name, lv.players[t.match.p2].name);
    }
  }
  return out;
}

test('身份键：全角/空格/大小写归一，不同名字永不合并', () => {
  const { W } = createApp();
  assert.equal(W.identityKey('张 三'), W.identityKey(' 张三 '));
  assert.equal(W.identityKey('张　三'), W.identityKey('张三'), '全角空格也应去掉');
  assert.equal(W.identityKey('Ｍｉｋｅ'), W.identityKey('mike'));
  assert.notEqual(W.identityKey('张三'), W.identityKey('李四'));
  assert.notEqual(W.identityKey('张三'), W.identityKey('张 三丰'));
});

test('A 级正在比赛时，B 级优先安排不冲突的合法对阵', () => {
  const { W } = createApp({ seed: 31 });
  const t = newTournament(W);
  const A = addLevel(W, t, '男子轻量级', ['张三', '李四', '王五', '赵六']);
  const B = addLevel(W, t, '男子重量级', ['张三', '孙七', '周八', '吴九']);
  begin(A); begin(B);
  seat(A, '张三', '李四');
  addPending(A, '王五', '赵六');
  addPending(B, '张三', '孙七'); // 冲突场次
  addPending(B, '周八', '吴九'); // 合法替代

  const views = W.planMultiLevel([A, B]);

  assert.deepEqual(tableNames(B), ['周八', '吴九'].sort(), 'B 应优先排上不冲突的比赛');
  assert.equal(views.get(B.id).next.waiting, true);
  assert.equal(views.get(B.id).next.crossBlocked[0].name, '张三');
  assert.equal(views.get(B.id).next.crossBlocked[0].levelName, '男子轻量级');
});

test('B 级没有其他合法对阵时等待，并给出明确原因', () => {
  const { W } = createApp({ seed: 32 });
  const t = newTournament(W);
  const A = addLevel(W, t, '男子轻量级', ['张三', '李四']);
  const B = addLevel(W, t, '男子重量级', ['张三', '孙七']);
  begin(A); begin(B);
  seat(A, '张三', '李四');
  addPending(B, '张三', '孙七');

  const views = W.planMultiLevel([A, B]);
  const view = views.get(B.id);

  assert.deepEqual(tableNames(B), [], '冲突场次不能上桌');
  assert.equal(view.nextStatus, 'waiting');
  assert.equal(view.next.waiting, true);
  assert.equal(view.next.crossBlocked.length, 1);
  const blocked = view.next.crossBlocked[0];
  assert.equal(blocked.playerId, idOf(B, '张三'));
  assert.equal(blocked.name, '张三');
  assert.equal(blocked.levelName, '男子轻量级');
});

test('A 结算后重新计算，B 能正确安排', () => {
  const { W } = createApp({ seed: 33 });
  const t = newTournament(W);
  const A = addLevel(W, t, '男子轻量级', ['张三', '李四']);
  const B = addLevel(W, t, '男子重量级', ['张三', '孙七']);
  begin(A); begin(B);
  seat(A, '张三', '李四');
  addPending(B, '张三', '孙七');

  W.planMultiLevel([A, B]);
  assert.deepEqual(tableNames(B), [], '结算前 B 应等待');

  W.resolveMatch(A, 1, idOf(A, '张三'));
  W.planMultiLevel([A, B]);

  assert.deepEqual(tableNames(B), ['张三', '孙七'].sort(), 'A 结算后 B 应排上');
});

test('A 撤回后占用状态重新推导，且绝不自动取消已有比赛', () => {
  const { W } = createApp({ seed: 34 });
  const t = newTournament(W);
  const A = addLevel(W, t, '男子轻量级', ['张三', '李四']);
  const B = addLevel(W, t, '男子重量级', ['张三', '孙七']);
  begin(A); begin(B);
  seat(A, '张三', '李四');
  addPending(B, '张三', '孙七');

  W.planMultiLevel([A, B]);
  W.resolveMatch(A, 1, idOf(A, '张三'));
  W.planMultiLevel([A, B]);
  assert.deepEqual(tableNames(B), ['张三', '孙七'].sort(), 'B 已排上');

  // 撤回 A：快照把 A 的桌子恢复为 张三 vs 李四，占用表必须随之更新
  assert.ok(W.undoLast(A, 'global'));
  const views = W.planMultiLevel([A, B]);

  assert.deepEqual(tableNames(A), ['张三', '李四'].sort(), '撤回后 A 的桌子恢复');
  assert.deepEqual(tableNames(B), ['张三', '孙七'].sort(), '不得因冲突自动取消 B 的比赛');
  const conflicts = W.crossLevelConflicts([A, B]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].name, '张三');
  assert.deepEqual(Array.from(conflicts[0].levelIds).sort(), [A.id, B.id].sort());
  assert.ok(views.get(A.id) && views.get(B.id), '计划仍可正常返回');
});

test('两个级别同时预览同一选手时，只允许一个级别预留', () => {
  const { W } = createApp({ seed: 35 });
  const t = newTournament(W);
  const A = addLevel(W, t, 'A 级', ['甲', '乙', '张三', '丙']);
  const B = addLevel(W, t, 'B 级', ['丁', '戊', '张三', '己']);
  begin(A); begin(B);
  seat(A, '甲', '乙');
  seat(B, '丁', '戊');
  addPending(A, '张三', '丙');
  addPending(B, '张三', '己');

  const views = W.planMultiLevel([A, B]);

  const zhangId = idOf(A, '张三');
  const readyWithZhang = [views.get(A.id), views.get(B.id)]
    .filter((v) => v.next && !v.next.waiting && (v.next.p1 === zhangId || v.next.p2 === zhangId));
  assert.equal(readyWithZhang.length, 1, '同一选手最多被一个级别预告');

  const AView = views.get(A.id);
  const BView = views.get(B.id);
  assert.equal(AView.next.waiting, false, 'levelIds 顺序在前者获得预留');
  assert.equal(BView.next.waiting, true);
  assert.equal(BView.next.crossBlocked[0].levelName, 'A 级');
});

test('三个级别（人数不同）同时进行时不会把同一人排到两张桌子', () => {
  const { W } = createApp({ seed: 36 });
  const t = newTournament(W);
  const A = addLevel(W, t, 'A 级', ['张三', '李四', '王五', '赵六']);
  const B = addLevel(W, t, 'B 级', ['张三', 'a', 'b', 'c', 'd', 'e']);
  const C = addLevel(W, t, 'C 级', ['张三', 'x', 'y', 'z', 'w']);
  begin(A); begin(B); begin(C);
  seat(A, '张三', '李四');
  addPending(A, '王五', '赵六');
  addPending(B, '张三', 'a');
  addPending(B, 'b', 'c');
  addPending(C, '张三', 'x');
  addPending(C, 'y', 'z');

  W.planMultiLevel([A, B, C]);
  const names = allTableNames([A, B, C]);
  assert.equal(new Set(names).size, names.length, '同一姓名不能同时出现在两张桌子');
  assert.equal(tableNames(A).includes('张三'), true);
  assert.equal(tableNames(B).includes('张三'), false);
  assert.equal(tableNames(C).includes('张三'), false);
});

test('总决赛也会占用选手，结束后自动释放', () => {
  const { W } = createApp({ seed: 37 });
  const t = newTournament(W);
  const A = addLevel(W, t, 'A 级', ['张三', '李四']);
  const B = addLevel(W, t, 'B 级', ['张三', '孙七']);
  begin(A); begin(B);
  A.grandFinal = { p1: idOf(A, '张三'), p2: idOf(A, '李四'), wins1: 0, wins2: 0, completed: false };
  addPending(B, '张三', '孙七');

  W.planMultiLevel([A, B]);
  assert.deepEqual(tableNames(B), [], '总决赛占用时 B 应等待');
  assert.equal(W.getMatchupView(B, W.crossLevelBusyMap([A])).next.crossBlocked[0].name, '张三');

  A.grandFinal.completed = true;
  A.finished = true;
  W.planMultiLevel([A, B]);
  assert.deepEqual(tableNames(B), ['张三', '孙七'].sort(), '总决赛结束后释放占用');
});

test('单级别详情页路径（fillTables + 同赛事其他级别占用表）同样受限', () => {
  const { W } = createApp({ seed: 38 });
  const t = newTournament(W);
  const A = addLevel(W, t, 'A 级', ['张三', '孙七']); // 详情页
  const B = addLevel(W, t, 'B 级', ['张三', '李四']); // 仍在进行
  begin(A); begin(B);
  seat(B, '张三', '李四');
  addPending(A, '张三', '孙七');

  const blocked = W.crossLevelBusyMap(t.levels.filter((l) => l.id !== A.id));
  W.fillTables(A, blocked);

  assert.deepEqual(tableNames(A), [], '详情页不能绕过跨级别检查');
  const view = W.getMatchupView(A, blocked);
  assert.equal(view.next.waiting, true);
  assert.equal(view.next.crossBlocked[0].levelName, 'B 级');
});

test('真正独立的单级别赛事完全不受影响', () => {
  const { W } = createApp({ seed: 39 });
  const t1 = newTournament(W, '赛事一');
  const t2 = newTournament(W, '赛事二');
  const solo = addLevel(W, t1, '独立级别', ['张三', '李四']);
  const other = addLevel(W, t2, '另一个赛事级别', ['张三', '孙七']);
  begin(solo); begin(other);
  seat(other, '张三', '孙七');
  addPending(solo, '张三', '李四');

  const blocked = W.crossLevelBusyMap(t1.levels.filter((l) => l.id !== solo.id));
  assert.equal(blocked.size, 0, '不同赛事之间不产生占用');
  W.fillTables(solo, blocked);
  assert.deepEqual(tableNames(solo), ['张三', '李四'].sort(), '独立赛事照常排桌');

  // 不传占用表时行为与改动前一致
  const solo2 = addLevel(W, t1, '独立级别二', ['张三', '李四']);
  begin(solo2);
  addPending(solo2, '张三', '李四');
  W.fillTables(solo2);
  assert.deepEqual(tableNames(solo2), ['张三', '李四'].sort());
});

test('不同赛事之间不会发生姓名冲突，也不会互相锁定', () => {
  const { W } = createApp({ seed: 40 });
  const t1 = newTournament(W, '赛事一');
  const t2 = newTournament(W, '赛事二');
  const A = addLevel(W, t1, 'A 级', ['张三', '李四']);
  const B = addLevel(W, t2, 'B 级', ['张三', '孙七']);
  begin(A); begin(B);
  seat(A, '张三', '李四');
  addPending(B, '张三', '孙七');

  // 调用方只传同一赛事内的级别：B 只看自己赛事，不会被 A 锁住
  W.planMultiLevel([B]);
  assert.deepEqual(tableNames(B), ['张三', '孙七'].sort());
  assert.equal(W.crossLevelConflicts(t1.levels).length, 0);
  assert.equal(W.crossLevelConflicts(t2.levels).length, 0, '不同赛事不构成冲突');
});

test('同名不同人：只产生等待，不合并 playerId 与成绩', () => {
  const { W } = createApp({ seed: 41 });
  const t = newTournament(W);
  const A = addLevel(W, t, 'A 级', ['张三', '李四']);
  const B = addLevel(W, t, 'B 级', ['张三', '孙七']);
  begin(A); begin(B);
  seat(A, '张三', '李四');
  addPending(B, '张三', '孙七');

  const idA = idOf(A, '张三');
  const idB = idOf(B, '张三');
  assert.notEqual(idA, idB, '两个级别里的同名选手是不同 playerId');

  W.planMultiLevel([A, B]);

  assert.deepEqual(tableNames(B), [], '第一版限制：同名会被当成同一人而等待');
  assert.equal(A.players[idA].name, '张三');
  assert.equal(B.players[idB].name, '张三');
  assert.equal(A.players[idA].losses, 0);
  assert.equal(B.players[idB].losses, 0);
  assert.notEqual(A.players[idA], B.players[idB], '绝不能共享同一个选手对象');
});

test('旧数据已有冲突：不取消、不判胜负、不删记录，只提示并阻止新冲突', () => {
  const { W } = createApp({ seed: 42 });
  const t = newTournament(W);
  const A = addLevel(W, t, 'A 级', ['张三', '李四', '王五', '赵六']);
  const B = addLevel(W, t, 'B 级', ['张三', '孙七', '周八', '吴九']);
  begin(A); begin(B);
  const aMatch = seat(A, '张三', '李四');
  const bMatch = seat(B, '张三', '孙七');
  addPending(A, '王五', '赵六');
  addPending(B, '周八', '吴九');

  const before = JSON.stringify({ A: A.tables, B: B.tables, aHistory: A.history, bHistory: B.history });
  const conflicts = W.crossLevelConflicts([A, B]);
  const views = W.planMultiLevel([A, B]);

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].name, '张三');
  assert.equal(A.tables[0].match.id, aMatch.id, '不得自动取消 A 的比赛');
  assert.equal(B.tables[0].match.id, bMatch.id, '不得自动取消 B 的比赛');
  assert.equal(A.history.length, 0);
  assert.equal(B.history.length, 0);
  const after = JSON.stringify({ A: A.tables, B: B.tables, aHistory: A.history, bHistory: B.history });
  assert.equal(after, before, '计划只能读取，不能改动已有比赛');
  assert.ok(views.get(A.id) && views.get(B.id));
});

test('下一组预览与实际排桌一致：空闲级别不会出现“显示可上场却排不上”', () => {
  const { W } = createApp({ seed: 43 });
  const t = newTournament(W);
  const A = addLevel(W, t, 'A 级', ['张三', '李四', '王五', '赵六']);
  const B = addLevel(W, t, 'B 级', ['张三', '孙七', '周八', '吴九']);
  const C = addLevel(W, t, 'C 级', ['甲', '乙', '丙', '丁']);
  begin(A); begin(B); begin(C);
  seat(A, '张三', '李四');
  addPending(A, '王五', '赵六');
  addPending(B, '张三', '孙七');
  addPending(B, '周八', '吴九');
  addPending(C, '甲', '乙');

  const views = W.planMultiLevel([A, B, C]);

  for (const lv of [A, B, C]) {
    const view = views.get(lv.id);
    const busy = !!(lv.tables[0] && lv.tables[0].match);
    if (view.nextStatus === 'ready' && !busy) {
      assert.fail(`${lv.name} 空闲却显示可上场：${JSON.stringify(view.next)}`);
    }
    if (view.next && !view.next.waiting && busy) {
      // 忙碌级别预告的下一组，其双方此刻都不能在任何桌上
      const names = [lv.players[view.next.p1].name, lv.players[view.next.p2].name];
      const onTables = allTableNames([A, B, C]);
      for (const n of names) assert.equal(onTables.includes(n), false, `${n} 已在别的桌上却被预告`);
    }
  }
  assert.deepEqual(tableNames(B), ['周八', '吴九'].sort());
});
