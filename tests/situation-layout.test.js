'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApp,
  makeLevel,
  startLevel,
  step,
  runToEnd,
} = require('./harness');

function layoutOf(count, options) {
  const app = createApp(options);
  const { level } = makeLevel(app.W, count);
  return { W: app.W, level, layout: app.W.buildSituationLayout(level) };
}

function allNodes(layout) {
  return [...layout.wNodes.flat(), ...layout.lNodes.flat(), layout.gf];
}

function seats(layout) {
  return allNodes(layout).flatMap((node) => [node.p1, node.p2]).filter(Boolean);
}

test('3–20 人都生成位置图模板，人数即入场条目数', () => {
  for (let n = 3; n <= 20; n += 1) {
    const { W, level, layout } = layoutOf(n);
    assert.equal(layout.supported, true, `${n} 人应支持`);
    assert.equal(layout.n, n);
    assert.equal(layout.entries.length, n);
    assert.equal(layout.rank.rows.length, n);
    assert.equal(layout.rank.total, n);
    assert.equal(layout.wNodes.length, layout.template.wStages.length);
    assert.equal(layout.lNodes.length, layout.template.lStages.length);
    assert.ok(layout.width > 0 && layout.height > 0);
    assert.ok(layout.width / layout.height < 10, `${n} 人不应被排成单列`);
    assert.equal(layout.gf.status, 'empty');
    assert.equal(layout.entries.filter((e) => e.no != null).length, 0, '未开赛不应固定编号');
    assert.equal(W.buildSituationLayout(level).n, n, '布局可重复读取');
  }
});

test('不同人数使用不同阶段结构，而不是固定列数', () => {
  const four = layoutOf(4).layout;
  const eight = layoutOf(8).layout;
  const twenty = layoutOf(20).layout;

  assert.notDeepEqual(
    four.wNodes.map((nodes) => nodes.length),
    eight.wNodes.map((nodes) => nodes.length),
  );
  assert.notDeepEqual(
    eight.lNodes.map((nodes) => nodes.length),
    twenty.lNodes.map((nodes) => nodes.length),
  );
  assert.equal(four.wNodes.length, four.template.wStages.length);
  assert.equal(twenty.wNodes.length, twenty.template.wStages.length);
  assert.equal(twenty.wNodes[0].length, twenty.template.wStages[0].matches);
  assert.equal(twenty.lNodes[0].length, twenty.template.lStages[0].matches);
});

test('主图不再为排名栏预留宽度，左侧名单约占整图两成', () => {
  for (const n of [3, 8, 11, 20]) {
    const { layout } = layoutOf(n);
    assert.equal(layout.rank.hidden, true);
    assert.equal(layout.rank.rows.length, n, '排名数据仍保留');
    assert.equal(layout.width, layout.gf.x + layout.gf.w + layout.pad, '宽度止于总决赛');
    assert.ok(layout.entryW / layout.width >= 0.19, `${n} 人左侧栏应占约两成`);
    assert.ok(layout.rosterH >= layout.wLaneH, '名单应贯穿整图高度');
  }
});

test('少于 3 人或超过 20 人只返回明确提示，不生成位置图', () => {
  for (const n of [2, 21]) {
    const { layout } = layoutOf(n);
    assert.equal(layout.supported, false);
    assert.equal(layout.n, n);
    assert.equal(layout.message, '当前赛情功能仅支持3～20名选手');
    assert.equal(layout.entries, undefined);
    assert.equal(layout.wNodes, undefined);
    assert.equal(layout.rank, undefined);
  }
});

test('开赛后当前比赛只标在真实桌上，其他比赛不能伪装成当前', () => {
  const app = createApp();
  const { level } = makeLevel(app.W, 8);
  startLevel(app.W, level);
  const layout = app.W.buildSituationLayout(level);

  assert.equal(layout.entries.length, 8);
  assert.deepEqual([...layout.entries.map((e) => e.no)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(layout.current && layout.current.matchId, '应识别当前比赛');
  assert.equal(layout.currentIds.length, 2);

  const currentNodes = allNodes(layout).filter((node) => node.current);
  assert.equal(currentNodes.length, 1, '当前比赛只应高亮一个位置');
  assert.equal(currentNodes[0].matchId, layout.current.matchId);
  const currentSeats = seats(layout).filter((seat) => seat.current);
  assert.equal(currentSeats.length, 2);
  assert.deepEqual(
    currentSeats.map((seat) => seat.id).sort(),
    Array.from(layout.currentIds).sort(),
  );
});

test('晋级/落败连线只来自真实发生的比赛，且不重复造线', () => {
  const app = createApp();
  const { level } = makeLevel(app.W, 8);
  startLevel(app.W, level);
  for (let i = 0; i < 14 && !level.finished; i += 1) {
    if (!step(app.W, level, 'p1')) break;
  }
  const layout = app.W.buildSituationLayout(level);
  const real = layout.edges.filter((edge) => edge.kind !== 'flow');
  const advance = real.filter((edge) => edge.kind === 'advance');
  const drop = real.filter((edge) => edge.kind === 'drop');

  assert.ok(level.history.length >= 8, '应先产生足够历史');
  assert.ok(advance.length > 0, '应出现胜者晋级线');
  assert.ok(drop.length > 0, '应出现落败进败者组线');
  assert.ok(real.length <= level.history.length * 2, '每条历史最多产生两条位置线');
  for (const edge of real) {
    assert.ok(['advance', 'drop'].includes(edge.kind));
    assert.match(edge.d, /^M-?\d/);
    assert.ok(Number.isFinite(edge.x1) && Number.isFinite(edge.y1));
    assert.ok(Number.isFinite(edge.x2) && Number.isFinite(edge.y2));
  }
  const decidedRanks = layout.rank.rows.filter((row) => row.status === 'decided');
  assert.ok(decidedRanks.length > 0, '淘汰后应逐步出现最终名次');
  assert.ok(decidedRanks.every((row) => row.name !== '未决出'));
});

test('完赛后总决赛、冠军排名和淘汰标记保持一致', () => {
  const app = createApp();
  const { level } = makeLevel(app.W, 8);
  startLevel(app.W, level);
  runToEnd(app.W, level, { pick: 'p1' });
  const layout = app.W.buildSituationLayout(level);

  assert.equal(level.finished, true);
  assert.equal(layout.gf.completed, true);
  assert.equal(layout.rank.rows.length, 8);
  assert.equal(layout.rank.rows[0].label, '🥇 冠军');
  assert.equal(layout.rank.rows[0].status, 'decided');
  assert.equal(layout.rank.rows[0].name, level.players[level.grandFinal.winnerId].name);
  assert.equal(layout.rank.rows[1].name, level.players[level.grandFinal.runnerUpId].name);
  assert.ok(layout.rank.rows.every((row) => row.status === 'decided'));
  assert.equal(
    layout.entries.find((entry) => entry.id === level.grandFinal.winnerId).statusLabel,
    '🥇 冠军',
  );
  assert.equal(
    layout.entries.find((entry) => entry.id === level.grandFinal.runnerUpId).statusLabel,
    '🥈 亚军',
  );
  assert.ok(seats(layout).some((seat) => seat.eliminated));
  assert.ok(Number.isFinite(layout.gf.wins1) && Number.isFinite(layout.gf.wins2));
});

test('位置图是只读模型，不修改比赛数据', () => {
  const app = createApp();
  const { level } = makeLevel(app.W, 8);
  startLevel(app.W, level);
  step(app.W, level, 'p1');
  const before = JSON.stringify(level);
  app.W.buildSituationLayout(level);
  const after = JSON.stringify(level);
  assert.equal(after, before);
});
