'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseVersionScript,
  compareVersions,
  shouldUpdate,
} = require('../update-core.js');

test('从 version.js 源码文本解析版本号，不执行脚本', () => {
  assert.equal(parseVersionScript("var APP_VERSION = '2026.10.23-3';"), '2026.10.23-3');
  assert.equal(parseVersionScript('var APP_VERSION = "2026.10.24-1";'), '2026.10.24-1');
  assert.equal(parseVersionScript('var OTHER = 1;'), null);
  assert.equal(parseVersionScript(''), null);
  assert.equal(parseVersionScript(null), null);
});

test('版本比较：修订号按数值比较，日期优先', () => {
  assert.equal(compareVersions('2026.10.23-3', '2026.10.23-3'), 0);
  assert.equal(compareVersions('2026.10.23-10', '2026.10.23-2'), 1);
  assert.equal(compareVersions('2026.10.23-2', '2026.10.23-10'), -1);
  assert.equal(compareVersions('2026.10.24-1', '2026.10.23-99'), 1);
  assert.equal(compareVersions('2026.09.30-1', '2026.10.01-1'), -1);
});

test('版本比较：规范格式优先于无法解析的格式', () => {
  assert.equal(compareVersions('2026.10.23-2', '乱七八糟'), 1);
  assert.equal(compareVersions('乱七八糟', '2026.10.23-2'), -1);
  assert.equal(compareVersions('旧版本', '旧版本'), 0);
});

test('shouldUpdate 只在远端确实更新时返回 true', () => {
  assert.equal(shouldUpdate('2026.10.23-3', '2026.10.23-4'), true);
  assert.equal(shouldUpdate('2026.10.23-3', '2026.10.23-3'), false);
  assert.equal(shouldUpdate('2026.10.23-3', '2026.10.23-2'), false);
  assert.equal(shouldUpdate('2026.10.23-3', null), false);
  assert.equal(shouldUpdate(null, '2026.10.23-1'), true);
});
