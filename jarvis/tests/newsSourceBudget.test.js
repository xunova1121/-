import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readLookupSource } from '../src/agent/lookup/readSource.js';
import { DOMESTIC_NEWS_CANDIDATES } from '../src/agent/lookup/sourceCatalog.js';

const now = Date.parse('2026-11-08T12:00:00+08:00');
const source = DOMESTIC_NEWS_CANDIDATES.find(s => s.id === 'cn_zhibo_sports');
const url = 'https://news.zhibo8.com/zuqiu/2026-11-08/fixture.htm';
const title = '虚构体育：公共训练场地开放预约';
const index = `<a href="${url}">${title}</a>`;
const article = `<h1>${title}</h1><span ms-controller="title_controller">2026-11-08 11:00:00 {{info|html}}</span><div id="signals" class="content"><p>训练场地增加公众预约场次。</p></div>`;
const delay = (ms, value) => new Promise(resolve => setTimeout(() => resolve(new Response(value)), ms));
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('直播吧列表4秒、正文3秒在声明8秒预算内完成，不被旧3秒/5秒截断', async () => {
  const get = vi.fn(url => url === source.url ? delay(4000, index) : delay(3000, article));
  const consume = vi.fn();
  const pending = readLookupSource(source, { get, now, retrieval: { consume } });
  await vi.advanceTimersByTimeAsync(7000);
  const result = await pending;
  expect(result).toMatchObject({ state: 'ok', requests: 2, elapsedMs: 7000 });
  expect(result.items[0]).toMatchObject({ title, verified: 'page', publishedAt: '2026-11-08T11:00:00+08:00' });
  expect(consume.mock.calls).toEqual([['read'], ['read']]);
});

it('连同正文读取受同一期限约束，不接受迟到原文或无限等待body', async () => {
  const parseArticle = vi.fn(source.parseArticle);
  const get = vi.fn(async url => url === source.url ? new Response(index) : new Response(new ReadableStream({ start() {} })));
  const pending = readLookupSource({ ...source, parseArticle }, { get, now });
  await vi.advanceTimersByTimeAsync(8000);
  const result = await pending;
  expect(result.items).toEqual([]); expect(parseArticle).not.toHaveBeenCalled();
  expect(result.elapsedMs).toBeLessThanOrEqual(8000); expect(get.mock.calls.length).toBeLessThanOrEqual(3);
});

it('不合作的迟到索引在超时后不得继续拉正文', async () => {
  const get = vi.fn(() => delay(10000, index));
  const pending = readLookupSource(source, { get, now });
  await vi.advanceTimersByTimeAsync(8000);
  expect((await pending).items).toEqual([]);
  const count = get.mock.calls.length;
  await vi.advanceTimersByTimeAsync(12000);
  expect(get).toHaveBeenCalledTimes(count);
  expect(get.mock.calls.every(([url]) => url === source.url)).toBe(true);
});

it('本轮较短预算优先，不因来源声明8秒延长', async () => {
  const get = vi.fn(() => new Promise(() => {}));
  const pending = readLookupSource(source, { get, now, retrieval: { remaining: 2000, consume() {} } });
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toMatchObject({ state: 'failed', elapsedMs: 2000, requests: 1 });
});

it('503超过预算的Retry-After不截短；403不重试；读取额度不超支', async () => {
  for (const status of [403, 503]) {
    const get = vi.fn(async () => new Response('', { status, headers: { 'Retry-After': '120' } }));
    expect(await readLookupSource(source, { get, now })).toMatchObject({ state: 'failed', status, requests: 1 });
    expect(get).toHaveBeenCalledTimes(1);
  }
  const get = vi.fn(async () => new Response('', { status: 503 }));
  expect(await readLookupSource(source, { get, now, requestLimit: 1 })).toMatchObject({ state: 'failed', status: 503, requests: 1 });
});

it('取消和读取预算错误继续向上传递，不当作无新闻', async () => {
  const controller = new AbortController();
  const get = vi.fn(() => delay(4000, index));
  const pending = readLookupSource(source, { get, now, signal: controller.signal }).catch(e => e);
  await vi.advanceTimersByTimeAsync(100); controller.abort();
  expect((await pending).name).toBe('AbortError');
  await vi.advanceTimersByTimeAsync(9000); expect(get).toHaveBeenCalledTimes(1);
  const budget = Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' });
  await expect(readLookupSource(source, { get, now, retrieval: { consume() { throw budget; } } })).rejects.toBe(budget);
});
