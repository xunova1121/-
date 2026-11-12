import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { createFileStore } from '../server/fileStore.mjs';
import { createMarketQuoteTool } from '../src/agent/marketQuote.js';
import { createStockKlineTool } from '../src/agent/stockKline.js';
import { useBackend } from '../src/agent/store.js';
import * as sessions from '../src/agent/sessions.js';
import { DEFAULT_CONFIG } from '../src/llm/config.js';

// 虚构行情，只替换上游响应；真实工具负责解析、校验和发卡片回执。
const quoteText = (symbol, price = '1500', company = '虚构行情甲') => {
  const fields = Array(50).fill('');
  Object.assign(fields, { 1: company, 2: symbol.slice(2), 3: price, 4: price, 5: price, 30: '20261111150000', 31: '0', 32: '0', 33: price, 34: price });
  return `v_${symbol}="${fields.join('~')}";`;
};
const bars = [
  ['2026-11-09', '1490', '1500', '1505', '1488', '101'],
  ['2026-11-10', '1500', '1496', '1508', '1492', '112'],
  ['2026-11-11', '1496', '1512', '1515', '1495', '123'],
];
const responseFor = url => String(url).includes('fqkline')
  ? Response.json({ data: { sh600519: { day: bars } } })
  : new Response(quoteText(String(url).match(/q=([^&]+)/)?.[1] || 'sh600519'));
const until = async fn => {
  const deadline = Date.now() + 8000;
  while (!(await fn())) {
    if (Date.now() > deadline) throw Error('任务未按时结束');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
let data;
const runners = [];
beforeEach(() => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-market-task-'));
  useBackend(createFileStore(data));
});
afterEach(async () => {
  for (const runner of runners) for (const task of runner.list()) runner.stop(task.id);
  await Promise.all(runners.splice(0).map(runner => runner.settled()));
  useBackend(null);
  fs.rmSync(data, { recursive: true, force: true });
});
function runnerWith(fetchImpl = async url => responseFor(url), options = {}) {
  const runner = createTaskRunner({
    getConfig: async () => ({ ...DEFAULT_CONFIG, provider: 'mock' }),
    makeTools: ctx => {
      const context = { ...ctx, fetchImpl, fetchViaGateway: fetchImpl };
      return [createMarketQuoteTool(context), createStockKlineTool(context)];
    },
    makeAdapter: () => ({ model: 'market-test', adapter: { stream: async ({ onText }) => {
      const text = '行情已整理，价格以来源时间为准。';
      onText?.(text);
      return { text, toolCalls: [], stop: 'end_turn' };
    } } }),
    ...options,
  });
  runners.push(runner);
  return runner;
}
const finish = (runner, task) => until(() => ['done', 'error', 'stopped'].includes(runner.get(task.id).status));

it('真实报价工具的成功回执经 typed event 保存到原回答，文件存储重开仍保留数值和来源', async () => {
  const runner = runnerWith();
  const task = await runner.start({ text: '600519实时行情' });
  await finish(runner, task);
  expect(runner.get(task.id).status).toBe('done');
  const events = runner.events(task.id).filter(event => event.type === 'market_quote');
  expect(events).toHaveLength(1);
  expect(events[0].value).toMatchObject({ version: 1, kind: 'quote', quotes: [{ symbol: 'sh600519', price: 1500, unit: '元', time: '2026-11-11 15:00:00', source: { name: '腾讯行情' } }] });
  expect(events[0].value.quotes[0].source.url).toContain('https://qt.gtimg.cn/');
  await runner.settled();
  useBackend(createFileStore(data));
  const stored = await sessions.get(task.sessionId);
  expect(stored.messages.at(-1).markets).toEqual([events[0].value]);
  expect(Buffer.byteLength(JSON.stringify(stored.messages.at(-1).markets))).toBeLessThanOrEqual(16384);
  expect(stored.messages[0].markets).toBeUndefined();
});

it('日K卡只保存成功工具实际返回的三日收盘价，不从模型文字生成趋势', async () => {
  const runner = runnerWith();
  const task = await runner.start({ text: '600519 收盘价' });
  await finish(runner, task);
  expect(runner.get(task.id).status).toBe('done');
  const event = runner.events(task.id).find(item => item.type === 'market_quote');
  expect(event.value).toMatchObject({ version: 1, kind: 'kline', symbol: 'sh600519', source: { name: '腾讯行情' } });
  expect(event.value.bars).toEqual(bars.map(([date, , close]) => ({ date, close: Number(close) })));
  expect((await sessions.get(task.sessionId)).messages.at(-1).markets).toEqual([event.value]);
});

it('两个并行任务倒序完成仍各自保存自己的报价，不随当前会话串卡', async () => {
  const pending = new Map();
  const runner = runnerWith(url => new Promise(resolve => pending.set(String(url).match(/q=([^&]+)/)?.[1], resolve)), { maxRunning: 2 });
  const first = await runner.start({ text: '600519实时行情' });
  const second = await runner.start({ text: '000001实时行情' });
  await until(() => pending.has('sh600519') && pending.has('sz000001'));
  pending.get('sz000001')(new Response(quoteText('sz000001', '12.5', '虚构行情乙')));
  await finish(runner, second);
  expect(runner.get(first.id).status).toBe('running');
  pending.get('sh600519')(new Response(quoteText('sh600519', '1500', '虚构行情甲')));
  await finish(runner, first);
  for (const [task, symbol, price] of [[first, 'sh600519', 1500], [second, 'sz000001', 12.5]]) {
    const card = (await sessions.get(task.sessionId)).messages.at(-1).markets[0];
    expect(card.quotes).toHaveLength(1);
    expect(card.quotes[0]).toMatchObject({ symbol, price });
    expect(runner.events(task.id).filter(event => event.type === 'market_quote').map(event => event.value.quotes[0].symbol)).toEqual([symbol]);
  }
});

it('用户停止后即使上游忽略取消并迟到返回，也不发卡片或污染后续会话', async () => {
  let release;
  const runner = runnerWith(() => new Promise(resolve => { release = resolve; }));
  const task = await runner.start({ text: '600519实时行情' });
  await until(() => Boolean(release));
  runner.stop(task.id);
  release(new Response(quoteText('sh600519')));
  await finish(runner, task);
  await runner.settled();
  expect(runner.get(task.id).status).toBe('stopped');
  expect(runner.events(task.id).filter(event => event.type === 'market_quote')).toEqual([]);
  expect((await sessions.get(task.sessionId)).messages.every(message => !message.markets?.length)).toBe(true);
  const next = await runner.start({ text: '你好' });
  await finish(runner, next);
  expect((await sessions.get(next.sessionId)).messages.every(message => !message.markets?.length)).toBe(true);
});

it('模型自称返回行情 JSON 不能制造真实行情卡', async () => {
  const fake = JSON.stringify({ version: 1, kind: 'quote', quotes: [{ price: 9999, symbol: 'sh600519' }] });
  const runner = runnerWith(async () => { throw Error('本轮不应联网'); }, {
    makeAdapter: () => ({ model: 'market-test', adapter: { stream: async ({ onText }) => { onText(fake); return { text: fake, toolCalls: [], stop: 'end_turn' }; } } }),
  });
  const task = await runner.start({ text: '你好' });
  await finish(runner, task);
  expect(runner.events(task.id).some(event => event.type === 'market_quote')).toBe(false);
  expect((await sessions.get(task.sessionId)).messages.at(-1).markets?.length || 0).toBe(0);
});

it('持久化行情卡不进入下一轮真实模型 messages，历史卡片仍保留', async () => {
  const inputs = [];
  const runner = runnerWith(undefined, {
    makeAdapter: () => ({ model: 'market-test', adapter: { stream: async ({ messages, onText }) => {
      inputs.push(structuredClone(messages));
      const text = '已整理行情。';
      onText?.(text);
      return { text, toolCalls: [], stop: 'end_turn' };
    } } }),
  });
  const first = await runner.start({ text: '600519实时行情' });
  await finish(runner, first);
  const original = (await sessions.get(first.sessionId)).messages.at(-1).markets;
  expect(original).toHaveLength(1);
  inputs.length = 0;
  const next = await runner.start({ sessionId: first.sessionId, text: '你好' });
  await finish(runner, next);
  expect(inputs.length).toBeGreaterThan(0);
  for (const messages of inputs) {
    expect(messages.every(message => !Object.hasOwn(message, 'markets'))).toBe(true);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('"markets"');
    expect(serialized).not.toContain('quote:sh600519');
    expect(serialized).not.toContain('"source":{"name":"腾讯行情"');
  }
  expect((await sessions.get(first.sessionId)).messages[1].markets).toEqual(original);
});
