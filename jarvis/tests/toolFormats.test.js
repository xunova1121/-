import { it, expect } from 'vitest';
import { normalizeArgs } from '../src/agent/tools.js';
import { createStockKlineTool, stockSymbol } from '../src/agent/stockKline.js';
import { getSportsScores } from '../src/agent/sportsScores.js';
import { taskContract } from '../src/agent/taskContract.js';
const now = Date.parse('2026-11-03T15:50:00+08:00');
it('schema已声明的数字/枚举/JSON允许模型常见写法，不改路径正文和URL', () => {
  const tool = { input_schema: { properties: { count: { type: 'integer' }, value: { type: 'number' }, on: { type: 'boolean' }, data: { type: 'object' }, items: { type: 'array' }, mode: { type: 'string', enum: ['today', 'all'] }, path: { type: 'string' }, content: { type: 'string' } } } };
  const args = { count: '１２', value: '1,234.5', on: 'true', data: '{"days":1}', items: '[1,2]', mode: ' TODAY ', path: '中文/ 文件.md', content: '  [1,2]  ' };
  expect(normalizeArgs(tool, args)).toEqual({ count: 12, value: 1234.5, on: true, data: { days: 1 }, items: [1, 2], mode: 'today', path: '中文/ 文件.md', content: '  [1,2]  ' });
  expect(normalizeArgs(tool, { count: '1.5', value: '12abc', data: 'not-json' })).toEqual({ count: '1.5', value: '12abc', data: 'not-json' });
});
it('股票名字错误给正确工具路径，日K日期输入归一后请求，但上游原始数据校验仍严格', async () => {
  expect(() => stockSymbol('茅台')).toThrow('get_market_quote');
  const urls = [];
  const tool = createStockKlineTool({ now: () => now, fetchImpl: async url => { urls.push(url); return new Response('{"data":{}}'); } });
  await expect(tool.run({ code: '600519', start: '2026/11/1', end: '今天' })).rejects.toThrow();
  expect(urls.length).toBeGreaterThan(0);
  expect(decodeURIComponent(urls[0])).toContain('2026-11-01,2026-11-03');
  await expect(tool.run({ code: '600519', start: '2026/2/30' })).rejects.toThrow('真实存在');
});
it('赛程接受中文日期，非法日期仍在联网前拒绝', async () => {
  let reads = 0;
  const get = async () => { reads++; return new Response('{"data":[]}'); };
  await getSportsScores({ date: '11月3日' }, { get, now }).catch(() => {});
  expect(reads).toBeGreaterThan(0);
  reads = 0;
  await expect(getSportsScores({ date: '2026/2/30' }, { get, now })).rejects.toThrow('日期无效');
  expect(reads).toBe(0);
});
it('新增验收问题进入数值核验，纯新闻天气不误触发', () => {
  for (const text of ['23小时后是几点', '90分钟后几点', '距离春节还有几天', '下周五是几号', '纽约现在几点', '今天到12月31日有几个工作日', '100斤是多少公斤', '贷款100万30年利率3.1%月供多少']) expect(taskContract(text).calculation, text).toBe(true);
  for (const text of ['今天纽约天气', '今天财经新闻', '下周五天气', '春节新闻']) expect(taskContract(text).calculation, text).toBe(false);
});
