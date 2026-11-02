'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApp,
  makeLevel,
  startLevel,
  step,
  runToEnd,
  playerNames,
} = require('./harness');

const TEMPLATE_ROUNDS = {
  3: 3, 4: 4, 5: 5, 6: 6, 7: 6, 8: 6,
  9: 7, 10: 7, 11: 7, 12: 7, 13: 7, 14: 7,
  15: 8, 16: 8, 17: 8, 18: 8, 19: 8, 20: 8,
};

const W_CAPS = {
  3: [3, 2],
  4: [4, 2],
  5: [5, 3, 2],
  6: [6, 3, 2],
  7: [7, 4, 2],
  8: [8, 4, 2],
  9: [9, 5, 3, 2],
  12: [12, 6, 3, 2],
  16: [16, 8, 4, 2],
  20: [20, 10, 5, 3, 2],
};

const L_CAPS = {
  3: [1, 2],
  4: [2, 2],
  5: [2, 2, 2],
  6: [3, 3, 3, 2],
  7: [3, 4, 3, 2],
  8: [4, 4, 3, 2],
  9: [4, 4, 3, 3, 2],
  12: [6, 6, 4, 3, 2],
  16: [8, 8, 6, 4, 2],
  20: [10, 10, 7, 5, 4, 2],
};

function allCards(model) {
  return [
    ...model.wStages.flatMap((s) => s.slots),
    ...model.lStages.flatMap((s) => s.slots),
  ].filter(Boolean);
}

function cardsOf(model, playerId) {
  return allCards(model).filter((c) => c.id === playerId);
}

function isActiveCard(card) {
  return !!(card && (card.current || card.result === 'live' || card.result === 'waiting'));
}

/* 当前/待赛位置优先；没有活动位置时取最后发生的历史位置。 */
function cardOf(model, playerId) {
  const cards = cardsOf(model, playerId);
  if (!cards.length) return null;
  const active = cards.filter(isActiveCard);
  return active.length ? active[active.length - 1] : cards[cards.length - 1];
}

function positions(model) {
  const ids = [...new Set(allCards(model).map((c) => c.id))];
  const map = new Map();
  for (const id of ids) {
    const card = cardOf(model, id);
    if (card) map.set(id, `${card.bracket}${card.stage}:${card.no}`);
  }
  return map;
}

function tableMatches(level) {
  return level.tables.filter((t) => t.match).map((t) => t.match);
}

/* vm 沙箱里的数组/对象原型与宿主机不同，深比较前统一转成宿主机结构。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function allFirstRoundMatches(level) {
  return [
    ...level.pendingMatches,
    ...tableMatches(level),
  ].filter((m) => m.bracket === 'W' && m.round === 1);
}

for (const n of [3, 4, 5, 6, 7, 8, 9, 12, 16, 20]) {
  test(`${n} 人模板：轮次、胜者组与败者组阶段容量正确`, () => {
    const { W } = createApp();
    const tpl = W.situationTemplate(n);

    assert.equal(tpl.n, n);
    assert.equal(tpl.supported, true);
    assert.equal(tpl.templateRounds, TEMPLATE_ROUNDS[n]);
    assert.deepEqual(plain(tpl.wStages.map((s) => s.capacity)), W_CAPS[n]);
    assert.deepEqual(plain(tpl.lStages.map((s) => s.capacity)), L_CAPS[n]);
    assert.equal(tpl.stageColumns, Math.max(tpl.wStages.length, tpl.lStages.length));
  });
}

test('3–20 人之外的模板被明确标记为不支持', () => {
  const { W } = createApp();
  for (const n of [0, 1, 2, 21, 50]) {
    assert.equal(W.situationTemplate(n).supported, false);
  }
});

test('抽签编号固定为 1..N，重复打开赛情与刷新读取都不会重新随机', () => {
  const { W, storage } = createApp({ seed: 2026 });
  const { level } = makeLevel(W, 7);
  startLevel(W, level);

  const firstDraw = level.drawOrder.slice();
  assert.equal(firstDraw.length, 7);
  assert.equal(new Set(firstDraw).size, 7);
  assert.deepEqual(new Set(firstDraw), new Set(Object.keys(level.players)));

  const rows1 = W.buildSituation(level).draw;
  const rows2 = W.buildSituation(level).draw;
  assert.deepEqual(plain(rows1.map((r) => r.no)), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(plain(rows1), plain(rows2));
  assert.deepEqual(plain(level.drawOrder), plain(firstDraw));

  W.saveState();
  const reloaded = createApp({ storage });
  reloaded.W.state = reloaded.W.loadState();
  const level2 = reloaded.W.state.tournaments[0].levels[0];
  assert.deepEqual(plain(level2.drawOrder), plain(firstDraw));
  assert.deepEqual(plain(reloaded.W.buildSituation(level2).draw.map((r) => r.no)), [1, 2, 3, 4, 5, 6, 7]);
});

test('导入归一化保留抽签编号与轮空记录', () => {
  const { W } = createApp({ seed: 9 });
  const { level } = makeLevel(W, 5);
  startLevel(W, level);
  const raw = JSON.parse(JSON.stringify(W.state));
  const result = W.normalizeState(raw);

  assert.equal(result.error, undefined);
  const restored = result.state.tournaments[0].levels[0];
  assert.deepEqual(plain(restored.drawOrder), plain(level.drawOrder));
  assert.deepEqual(plain(restored.byes), plain(level.byes));
});

for (const n of [3, 5, 7, 9]) {
  test(`${n} 人奇数：首轮轮空不生成比赛，编号最后一位直接进入胜者组下一轮`, () => {
    const { W } = createApp({ seed: 100 + n });
    const { level } = makeLevel(W, n);
    startLevel(W, level);

    const first = allFirstRoundMatches(level);
    assert.equal(first.length, (n - 1) / 2);
    const wByes = level.byes.filter((b) => b.bracket === 'W' && b.round === 1);
    assert.equal(wByes.length, 1);
    const byeId = wByes[0].playerId;

    for (const m of first) {
      assert.notEqual(m.p1, byeId);
      assert.notEqual(m.p2, byeId);
      assert.notEqual(m.p1, m.p2);
    }
    assert.equal(level.players[byeId].losses, 0);

    const model = W.buildSituation(level);
    const w1 = model.wStages[0].slots.filter(Boolean);
    const w2 = model.wStages[1].slots.filter(Boolean);
    assert.equal(w1.length, n - 1);
    assert.equal(w1.some((c) => c.id === byeId), false);
    const byeCard = w2.find((c) => c.id === byeId);
    assert.ok(byeCard);
    assert.equal(byeCard.bye !== null, true);
    assert.equal(byeCard.losses, 0);
    assert.equal(model.draw.find((r) => r.playerId === byeId).no, n);  });
}

for (const n of [4, 6, 8]) {
  test(`${n} 人偶数：首轮全部为真实对阵，没有轮空`, () => {
    const { W } = createApp({ seed: 200 + n });
    const { level } = makeLevel(W, n);
    startLevel(W, level);

    const first = allFirstRoundMatches(level);
    assert.equal(first.length, n / 2);
    assert.equal(level.byes.filter((b) => b.bracket === 'W' && b.round === 1).length, 0);
    const model = W.buildSituation(level);
    assert.equal(model.wStages[0].slots.filter(Boolean).length, n);
  });
}

test('胜者组胜者留在胜者组，首负进入败者组且负场为 1', () => {
  const { W } = createApp({ seed: 42 });
  const { level } = makeLevel(W, 4);
  startLevel(W, level);

  const table = level.tables.find((t) => t.match);
  const match = table.match;
  const winnerId = match.p1;
  const loserId = match.p2;
  W.resolveMatch(level, table.tableNo, winnerId);
  W.generateMatchesIfNeeded(level);
  W.fillTables(level);

  const model = W.buildSituation(level);
  const winner = cardOf(model, winnerId);
  const loser = cardOf(model, loserId);
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(winner.bracket, 'W');
  assert.equal(winner.stage, 2);
  assert.equal(winner.losses, 0);
  assert.equal(loser.bracket, 'L');
  assert.equal(loser.stage, 1);
  assert.equal(loser.losses, 1);
});

test('第二场失利后选手从所有位置图槽位移入淘汰区', () => {
  const { W } = createApp({ seed: 7 });
  const { level } = makeLevel(W, 4);
  startLevel(W, level);

  let eliminatedId = null;
  let guard = 0;
  while (!level.finished && guard < 100) {
    const result = step(W, level, 'p1');
    guard += 1;
    if (!result) break;
    const found = Object.values(level.players).find((p) => p.losses >= 2);
    if (found) { eliminatedId = found.id; break; }
  }

  assert.ok(eliminatedId);
  const model = W.buildSituation(level);
  const latest = cardOf(model, eliminatedId);
  assert.ok(latest);
  assert.equal(latest.eliminatedHere, true);
  assert.equal(latest.result, 'loss');
  assert.equal(
    allCards(model).some((c) => c.id === eliminatedId && isActiveCard(c)),
    false,
    '已淘汰选手不应继续占据当前/待赛位置',
  );
  assert.equal(model.eliminated.some((r) => r.id === eliminatedId), true);
});

test('当前比赛框只取本级别正在进行的一场，两名选手与桌上对阵一致', () => {
  const { W } = createApp({ seed: 11 });
  const { level } = makeLevel(W, 6, { maxTables: 2 });
  startLevel(W, level);

  const model = W.buildSituation(level);
  assert.ok(model.current);
  assert.equal(model.current.source, 'table');
  const live = tableMatches(level)[0];
  assert.deepEqual(
    new Set([model.current.p1.id, model.current.p2.id]),
    new Set([live.p1, live.p2]),
  );
  assert.equal(model.current.extraLive, tableMatches(level).length - 1);

  const currentCards = allCards(model).filter((c) => c.current);
  assert.equal(currentCards.length, 2);
  assert.deepEqual(new Set(currentCards.map((c) => c.id)), new Set([live.p1, live.p2]));
});

test('一场比赛结算后当前比赛框切换到新对阵，旧对阵不再标记为当前', () => {
  const { W } = createApp({ seed: 13 });
  const { level } = makeLevel(W, 4);
  startLevel(W, level);

  const before = W.buildSituation(level).current;
  assert.ok(before);
  step(W, level, 'p1');
  const after = W.buildSituation(level).current;
  assert.ok(after);
  assert.notDeepEqual(
    new Set([before.p1.id, before.p2.id]),
    new Set([after.p1.id, after.p2.id]),
  );
  const marked = allCards(W.buildSituation(level)).filter((c) => c.current).map((c) => c.id);
  assert.deepEqual(new Set(marked), new Set([after.p1.id, after.p2.id]));
});

test('未开始不显示当前比赛框；结束后也不显示进行中的当前比赛框', () => {
  const { W } = createApp({ seed: 17 });
  const { level } = makeLevel(W, 4);

  assert.equal(W.buildSituation(level).current, null);
  startLevel(W, level);
  runToEnd(W, level);
  assert.equal(level.finished, true);
  assert.equal(W.buildSituation(level).current, null);
});

test('撤销上一场比赛恢复位置、当前比赛框、抽签编号与轮空记录', () => {
  const { W } = createApp({ seed: 19 });
  const { level } = makeLevel(W, 5);
  startLevel(W, level);

  const before = W.buildSituation(level);
  const beforeCurrent = before.current;
  const beforePositions = positions(before);
  const beforeDraw = plain(level.drawOrder);
  const beforeByes = plain(level.byes);

  step(W, level, 'p1');
  assert.notDeepEqual(positions(W.buildSituation(level)), beforePositions);
  assert.ok(W.undoLast(level, 'global'));
  W.fillTables(level);

  const restored = W.buildSituation(level);
  assert.deepEqual(positions(restored), beforePositions);
  assert.deepEqual(
    new Set([restored.current.p1.id, restored.current.p2.id]),
    new Set([beforeCurrent.p1.id, beforeCurrent.p2.id]),
  );
  assert.deepEqual(plain(level.drawOrder), beforeDraw);
  assert.deepEqual(plain(level.byes), beforeByes);
});

test('退回赛前清除抽签与轮空，保留报名顺序；再次开始重新抽签', () => {
  const { W } = createApp({ seed: 23 });
  const { level } = makeLevel(W, 5);
  startLevel(W, level);
  step(W, level, 'p1');

  const order = plain(level.playerOrder);
  const oldDraw = plain(level.drawOrder);
  assert.ok(oldDraw.length === 5);

  assert.equal(W.resetLevelToSetup(level), true);
  assert.equal(level.started, false);
  assert.deepEqual(plain(level.drawOrder), []);
  assert.deepEqual(plain(level.byes), []);
  assert.deepEqual(plain(level.playerOrder), order);

  const model = W.buildSituation(level);
  assert.equal(model.started, false);
  assert.equal(model.current, null);
  assert.equal(allCards(model).length, 0);
  assert.deepEqual(plain(model.draw.map((r) => r.no)), [null, null, null, null, null]);

  startLevel(W, level);
  assert.equal(level.drawOrder.length, 5);
  assert.deepEqual([...new Set(level.drawOrder)].sort(), [...new Set(order)].sort());
});

test('三个级别各自独立抽签、编号、当前比赛与位置，不互相污染', () => {
  const { W } = createApp({ seed: 31 });
  const tournament = W.createTournament('多级别赛');
  W.state.tournaments.push(tournament);

  const levels = [4, 5, 6].map((count, index) => {
    const level = W.createLevel({ name: `级别${index + 1}`, maxTables: 1 });
    tournament.levels.push(level);
    W.batchAddPlayers(level, playerNames(count).map((n) => `L${index + 1}-${n}`).join('\n'));
    startLevel(W, level);
    return level;
  });

  const snapshots = levels.map((l) => W.buildSituation(l));
  const draws = levels.map((l) => plain(l.drawOrder));
  assert.notDeepEqual(draws[0], draws[1]);

  step(W, levels[0], 'p1');
  const afterA = W.buildSituation(levels[0]);
  const afterB = W.buildSituation(levels[1]);
  const afterC = W.buildSituation(levels[2]);

  assert.notDeepEqual(positions(afterA), positions(snapshots[0]));
  assert.deepEqual(positions(afterB), positions(snapshots[1]));
  assert.deepEqual(positions(afterC), positions(snapshots[2]));
  assert.deepEqual(plain(levels[1].drawOrder), draws[1]);
  assert.deepEqual(plain(levels[2].drawOrder), draws[2]);
  assert.deepEqual(
    new Set([afterB.current.p1.id, afterB.current.p2.id]),
    new Set([snapshots[1].current.p1.id, snapshots[1].current.p2.id]),
  );

  for (const l of levels) {
    const names = new Set(Object.values(l.players).map((p) => p.name));
    assert.equal(names.size, Object.keys(l.players).length);
    assert.equal([...names].every((n) => n.startsWith(l.name.replace('级别', 'L'))), true);
  }
});

test('总决赛两名选手进入总决赛区域，BO3 比分与最终名次沿用既有记录', () => {
  const { W } = createApp({ seed: 77 });
  const { level } = makeLevel(W, 4);
  startLevel(W, level);

  let guard = 0;
  while (!(level.grandFinal && !level.grandFinal.completed) && guard < 100) {
    if (!step(W, level, 'p1')) break;
    guard += 1;
  }
  assert.ok(level.grandFinal && !level.grandFinal.completed);
  const gf = level.grandFinal;
  const model = W.buildSituation(level);
  assert.ok(model.current);
  assert.equal(model.current.source, 'grandFinal');
  assert.deepEqual(
    new Set([model.current.p1.id, model.current.p2.id]),
    new Set([gf.p1, gf.p2]),
  );
  assert.equal(model.grandFinal.completed, false);
  assert.equal(model.grandFinal.wins1, 0);
  assert.equal(model.grandFinal.wins2, 0);

  const activeIds = allCards(model).filter(isActiveCard).map((c) => c.id);
  assert.equal(activeIds.includes(gf.p1), false, '总决赛选手不应再占据胜/败者组当前位置');
  assert.equal(activeIds.includes(gf.p2), false, '总决赛选手不应再占据胜/败者组当前位置');
  for (const id of [gf.p1, gf.p2]) {
    assert.ok(level.players[id].losses < 2, '总决赛选手不应已有 2 负');
    const markedOut = allCards(model).some((c) => c.id === id && c.eliminatedHere);
    assert.equal(markedOut, false, '总决赛选手的历史负场不应被标记为已淘汰');
  }

  W.recordGrandFinalWin(level, 1);
  W.finalizeIfDone(level);
  const mid = W.buildSituation(level);
  assert.equal(mid.current.source, 'grandFinal');
  assert.equal(mid.current.wins1, 1);
  assert.equal(mid.current.wins2, 0);

  W.recordGrandFinalWin(level, 1);
  W.finalizeIfDone(level);
  const done = W.buildSituation(level);
  assert.equal(done.grandFinal.completed, true);
  assert.equal(done.current, null);
  assert.equal(done.rankings.length, 4);
  assert.equal(done.rankings.every((r) => r.status === 'decided'), true);
  assert.equal(level.players[gf.p1].placement, 1);
  assert.equal(level.players[gf.p2].placement, 2);
});

for (let n = 3; n <= 20; n += 1) {
  test(`${n} 人完整赛程：位置图不重复、不丢人，最终名次全部由既有排名算出`, () => {
    const { W } = createApp({ seed: 500 + n });
    const { level } = makeLevel(W, n);
    startLevel(W, level);
    runToEnd(W, level);

    const model = W.buildSituation(level);
    for (const [lane, stages] of [['W', model.wStages], ['L', model.lStages]]) {
      for (const stage of stages) {
        const ids = stage.slots.filter(Boolean).map((c) => c.id);
        assert.equal(
          new Set(ids).size,
          ids.length,
          `${lane}${stage.stage} 同一阶段不应重复占位`,
        );
      }
    }
    const seen = new Set([
      ...allCards(model).map((c) => c.id),
      ...model.eliminated.map((r) => r.id),
      ...(model.grandFinal ? [model.grandFinal.p1, model.grandFinal.p2] : []),
    ]);
    assert.deepEqual(
      plain([...seen].sort()),
      plain(Object.keys(level.players).sort()),
      '位置图/淘汰区/总决赛不应丢人',
    );
    assert.equal(model.rankings.length, n);
    assert.equal(model.rankings.every((r) => r.status === 'decided'), true);
    assert.deepEqual(
      plain(model.rankings.map((r) => r.place)),
      Array.from({ length: n }, (_, i) => i + 1),
    );
    assert.equal(model.current, null);
  });
}
