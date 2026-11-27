import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bjDate, daysBetween, gestationalAge } from '../src/date.js';

test('北京时间：UTC 16:30 已经是北京第二天', () => {
  assert.equal(bjDate(Date.UTC(2026, 9, 28, 16, 30)), '2026-10-29');
});

test('相差天数', () => {
  assert.equal(daysBetween('2026-04-23', '2026-10-27'), 187);
});

test('孕周：2026-04-23 到 2026-10-27 是 26 周 5 天', () => {
  assert.deepEqual(gestationalAge('2026-04-23', '2026-10-27'), { weeks: 26, days: 5 });
});
