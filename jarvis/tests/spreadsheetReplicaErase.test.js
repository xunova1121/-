/** 2026-11-17 复审：照图还原Excel时，哪类内容要清空按分句语义判断，说保留的不能被清空 */
import { it, expect } from 'vitest';
import { attendanceReplica, FRAME_REQUEST } from './fixtures/table-replica.js';
import { normalizeTableReplica, eraseRoles } from '../src/agent/spreadsheetReplica.js';

const roles = request => [...eraseRoles(request)].sort();

it.each([
  ['照图做成Excel，不要改姓名', []],
  ['转成Excel，姓名保留，不要删除', []],
  ['转成Excel，去掉水印，姓名照抄', []],
  ['转成Excel，签到的勾不要动', []],
  ['按照片还原Excel，姓名原样', []],
  ['按照片还原Excel', []]
])('说保留的不清空：%s', (request, expected) => {
  expect(roles(request)).toEqual(expected);
});

it.each([
  ['按照片还原Excel，只把姓名留空', ['name']],
  ['照图做Excel，名字不要了', ['name']],
  ['把手写的内容清空，勾保留', ['handwriting']],
  ['只留框架，但姓名保留', ['entry', 'handwriting', 'mark']],
  [FRAME_REQUEST, ['entry', 'handwriting', 'mark', 'name']]
])('明确要清空的照常清空：%s', (request, expected) => {
  expect(roles(request)).toEqual(expected);
});

it('实际还原：“不要改姓名”时姓名原文保留', () => {
  const original = attendanceReplica().cells.filter(c => c.role === 'name' && c.text.trim()).map(c => c.text);
  const kept = normalizeTableReplica(attendanceReplica(), '照图做成Excel，不要改姓名').cells.filter(c => c.role === 'name' && c.text.trim()).map(c => c.text);
  expect(original.length).toBeGreaterThan(0);
  expect(kept).toEqual(original);
  const blank = normalizeTableReplica(attendanceReplica(), FRAME_REQUEST).cells.filter(c => c.role === 'name');
  expect(blank.every(c => !c.text.trim())).toBe(true);
});
