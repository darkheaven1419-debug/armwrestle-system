'use strict';

/* 存储压测：模拟正式比赛的 3 个级别同时进行并打完，报告 localStorage 实际占用。
 * 口径：浏览器配额按字符（UTF-16 码元）计，Chrome 单个源约 5M 字符。
 * 用法：node tests/storage.bench.js */

const { createApp, startLevel, runToEnd, playerNames } = require('./harness');

const CHROME_QUOTA_CHARS = 5242875; // 本机 Edge（Chromium）实测：单源约 5,242,875 个字符，中英文口径相同
const TARGET_CHARS = 3 * 1024 * 1024;

function buildCompetition(size, levelCount) {
  const { W, storage } = createApp({ seed: 20261031 });
  const tournament = W.createTournament(`压测-${levelCount}级×${size}人`);
  W.state.tournaments.push(tournament);

  for (let i = 0; i < levelCount; i++) {
    const level = W.createLevel({ name: `级别${i + 1}`, maxTables: 1 });
    tournament.levels.push(level);
    W.batchAddPlayers(level, playerNames(size).join('\n'));
    startLevel(W, level);
    runToEnd(W, level);
  }
  return { W, storage, tournament };
}

function mb(chars) {
  return (chars / 1024 / 1024).toFixed(2) + ' MB';
}

function report(label, size, levelCount) {
  const { W, storage } = buildCompetition(size, levelCount);
  const levels = W.state.tournaments[0].levels;
  const allFinished = levels.every((l) => l.finished);

  // 主数据（含撤销栈，这是实际写入的形态）
  W.saveState();
  const main = storage.getItem(W.STORAGE_KEY) || '';
  const mainNoUndo = JSON.stringify((() => {
    const copy = JSON.parse(main);
    for (const t of copy.tournaments) for (const l of t.levels) l.undoStack = [];
    return copy;
  })());

  // 备份（方案 A 已生效：不含撤销栈）
  for (let i = 0; i < 3; i++) W.backupState();
  const backup = storage.getItem(W.BACKUP_KEY) || '';
  const totalChars = main.length + backup.length;
  const totalNoUndo = mainNoUndo.length + backup.length;

  console.log(`\n===== ${label}：${levelCount} 个级别 × ${size} 人 =====`);
  console.log(`全部打完：${allFinished ? '是' : '否'}`);
  console.log(`撤销层数：${levels.map((l) => l.undoStack.length).join(' / ')}（上限 60）`);
  console.log(`历史场次：${levels.map((l) => l.history.length).join(' / ')}`);
  console.log(`主数据（含撤销栈）：${main.length.toLocaleString()} 字符（${mb(main.length)}）`);
  console.log(`主数据（不含撤销栈）：${mainNoUndo.length.toLocaleString()} 字符（${mb(mainNoUndo.length)}）`);
  console.log(`备份(3 份，方案 A)：${backup.length.toLocaleString()} 字符（${mb(backup.length)}）`);
  console.log(`合计：${totalChars.toLocaleString()} 字符（${mb(totalChars)}，约 ${(totalChars / CHROME_QUOTA_CHARS * 100).toFixed(1)}% 配额）`);

  return { totalChars, totalNoUndo };
}

const r32 = report('正式比赛规模', 32, 3);
const r64 = report('加倍容量', 64, 3);

console.log('\n===== 结论 =====');
console.log(`3 级 × 32 人合计 ${r32.totalChars.toLocaleString()} 字符（${mb(r32.totalChars)}），${r32.totalChars > TARGET_CHARS ? '超过' : '低于'} 3MB 阈值。`);
if (r32.totalChars > TARGET_CHARS && r32.totalNoUndo > TARGET_CHARS) {
  console.log('即使主数据也不含撤销栈仍超阈值；按约定不再缩减更多功能（不做方案 C）。');
}
console.log(`3 级 × 64 人合计 ${r64.totalChars.toLocaleString()} 字符（${mb(r64.totalChars)}），仅作容量参考。`);
