'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/* 固定种子，保证测试可复现 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    clear() { map.clear(); },
    key(index) { return Array.from(map.keys())[index] ?? null; },
    get length() { return map.size; },
    _map: map,
  };
}

/*
 * 在 node:vm 中按浏览器顺序加载 utils/state/bracket。
 * 只伪造这三个文件实际用到的浏览器 API，不加载 ui/app。
 */
function createApp(options) {
  const opts = options || {};
  const storage = opts.storage || createStorage();
  const location = {
    search: opts.search || '',
    pathname: '/',
    href: 'http://localhost/',
  };
  const history = { replaceState() {} };

  const sandbox = {
    console,
    localStorage: storage,
    location,
    history,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  let rng = mulberry32(opts.seed == null ? 12345 : opts.seed);
  const math = Object.create(Math);
  math.random = () => rng();
  sandbox.Math = math;

  const context = vm.createContext(sandbox);
  for (const file of ['utils.js', 'state.js', 'bracket.js']) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }

  return {
    W: sandbox.window.WACAA,
    storage,
    context,
    sandbox,
    setSeed(seed) { rng = mulberry32(seed); },
  };
}

function playerNames(count) {
  return Array.from({ length: count }, (_, i) => `选手${String(i + 1).padStart(2, '0')}`);
}

function makeLevel(W, count, options) {
  const opts = options || {};
  const tournament = W.createTournament(opts.tournamentName || '测试赛事');
  W.state.tournaments.push(tournament);
  const level = W.createLevel({
    name: opts.name || '测试级别',
    maxTables: opts.maxTables || 1,
  });
  tournament.levels.push(level);
  const names = playerNames(count);
  W.batchAddPlayers(level, names.join('\n'));
  return { tournament, level, names };
}

function startLevel(W, level) {
  W.startLevel(level);
  W.generateMatchesIfNeeded(level);
  W.fillTables(level);
}

/* 结算一场：优先结算桌上比赛；没有桌上比赛时处理总决赛，否则补生成。 */
function step(W, level, pick) {
  let table = level.tables.find((t) => t.match);
  if (!table) {
    W.generateMatchesIfNeeded(level);
    W.fillTables(level);
    table = level.tables.find((t) => t.match);
  }

  if (table) {
    const match = table.match;
    const winnerId = pick === 'p2' ? match.p2 : match.p1;
    const events = W.resolveMatch(level, table.tableNo, winnerId);
    W.generateMatchesIfNeeded(level);
    W.fillTables(level);
    W.finalizeIfDone(level);
    return { type: 'match', tableNo: table.tableNo, match, winnerId, events };
  }

  if (level.grandFinal && !level.grandFinal.completed) {
    const evt = W.recordGrandFinalWin(level, pick === 'p2' ? 2 : 1);
    W.finalizeIfDone(level);
    return { type: 'grandFinal', evt };
  }

  W.finalizeIfDone(level);
  return null;
}

function runToEnd(W, level, options) {
  const opts = options || {};
  const maxSteps = opts.maxSteps || 10000;
  const pick = opts.pick || 'p1';
  let steps = 0;
  while (!level.finished && steps < maxSteps) {
    const result = step(W, level, pick);
    if (!result) break;
    steps += 1;
  }
  return steps;
}

function placementsOf(level) {
  return Object.values(level.players)
    .map((p) => ({ id: p.id, name: p.name, placement: p.placement }))
    .sort((a, b) => (a.placement ?? Infinity) - (b.placement ?? Infinity));
}

module.exports = {
  createApp,
  createStorage,
  makeLevel,
  startLevel,
  step,
  runToEnd,
  placementsOf,
  playerNames,
  mulberry32,
};
