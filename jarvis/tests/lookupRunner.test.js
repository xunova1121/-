import { it, expect, vi, afterEach } from 'vitest';
import { runLookup } from '../src/agent/lookup/runner.js';
import { runNewsLookup } from '../src/agent/lookup/news.js';
const now = Date.parse('2026-10-31T08:00:00Z');
const item = (id, values = {}) => ({ title: '虚构新闻：公共服务平台上线预约', url: `https://fixture.example/${id}`, publishedAt: '2026-10-31T09:00:00+08:00', category: '国际', ...values });
const source = (id, parse, extra = {}) => ({ id, label: id, kind: 'news', priority: 1, region: 'global', validation: 'fixture', url: `https://fixture.example/${id}`, parse, ...extra });
const intent = { kind: 'news', params: { categories: ['国际'] } };
afterEach(() => vi.useRealTimers());
it('慢源受8秒期限约束，其他来源的内容和明确403原因保留，健康记录按真实结果记', async () => {
  vi.useFakeTimers();
  const health = { get: async () => ({}), record: vi.fn() };
  const sources = [source('slow', () => ({ items: [] })), source('ok', () => ({ items: [item('a')] })), source('forbidden', () => ({ items: [] }))];
  const get = vi.fn(async (url, { signal }) => {
    if (url.endsWith('slow')) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    return new Response('', { status: url.endsWith('forbidden') ? 403 : 200 });
  });
  const result = runLookup(intent, { region: 'global', sources, now, get, health });
  await vi.advanceTimersByTimeAsync(8000);
  const value = await result;
  expect(value.items).toHaveLength(1);
  expect(value.failures).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining('403') }), expect.objectContaining({ reason: expect.stringContaining('超时') })]));
  expect(health.record).toHaveBeenCalledTimes(3);
});
it('列表与正文合计不超8读，多源轮流取，正文失败不抹掉已取新闻；只删跟踪参数去重', async () => {
  const direct = source('direct', () => ({ items: [item('same?utm_source=a'), item('same?utm_source=b'), item('history', { publishedAt: '2026-10-30T09:00:00+08:00' }), item('future', { publishedAt: '2026-11-01T09:00:00+08:00' })] }));
  const detailed = id => source(id, () => ({ items: [], candidates: Array.from({ length: 12 }, (_, i) => item(`${id}${i}`)) }), { parseArticle: (body, entry, candidate) => [{ ...candidate, verified: 'page' }] });
  const consume = vi.fn();
  const get = vi.fn(async url => new Response('', { status: url.endsWith('detail11') ? 403 : 200 }));
  const value = await runLookup(intent, { now, region: 'global', sources: [direct, detailed('detail1'), detailed('detail2')], get, retrieval: { consume } });
  expect(get).toHaveBeenCalledTimes(8);
  expect(consume).toHaveBeenCalledTimes(8);
  expect(value.items.map(i => i.url)).toEqual(expect.arrayContaining(['https://fixture.example/same?utm_source=a', 'https://fixture.example/detail10', 'https://fixture.example/detail20']));
  expect(value.items.some(i => /history|future|utm_source=b/.test(i.url))).toBe(false);
  expect(value.failures).toEqual([expect.objectContaining({ source: 'detail1', reason: expect.stringContaining('403') })]);
  expect(value.items.every(i => ['index', 'page', 'api'].includes(i.verified))).toBe(true);
});
it('用户停止/预算不能记为来源故障，不再发正文请求；本步不代替其他类别或历史查询', async () => {
  const sources = [source('first', () => ({ items: [item('a')] }))];
  const get = vi.fn(); const record = vi.fn();
  const budget = Object.assign(new Error('预算用完'), { code: 'RETRIEVAL_BUDGET' });
  await expect(runLookup(intent, { now, sources, region: 'global', get, health: { get: async () => ({}), record }, retrieval: { consume: () => { throw budget; } } })).rejects.toBe(budget);
  expect(get).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
  const ctrl = new AbortController(); ctrl.abort(new Error('用户停止'));
  await expect(runLookup(intent, { sources, signal: ctrl.signal })).rejects.toThrow('用户停止');
  await expect(runLookup({ kind: 'sports_live' })).rejects.toMatchObject({ code: 'LOOKUP_KIND_PENDING' });
  await expect(runLookup({ kind: 'news', params: { dateMode: 'specified' } })).rejects.toMatchObject({ code: 'LOOKUP_DATE_PENDING' });
});
it('本轮已有读取要扣除，不额外新开8次额度，避免并发后撞额度丢掉已有内容', async () => {
  const sources = Array.from({ length: 5 }, (_, i) => source(`fixture${i}`, () => ({ items: [item(`story${i}`)] })));
  const get = vi.fn(async () => new Response(''));
  const value = await runLookup(intent, { region: 'global', sources, now, get, retrieval: { resources: { read: 6 }, consume() {} } });
  expect(get).toHaveBeenCalledTimes(2);
  expect(value.items).toHaveLength(2);
  get.mockClear();
  await expect(runLookup(intent, { region: 'global', sources, now, get, retrieval: { resources: { read: 8 } } })).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
  expect(get).not.toHaveBeenCalled();
});
it('兼容新闻回执kind/date/coverage，体育不变比分；国内未验来源禁止HTTP请求', async () => {
  const get = vi.fn();
  const pending = JSON.parse(await runNewsLookup({ lookup: { region: 'cn' }, now: () => now, fetchImpl: get }, { categories: ['体育'] }, { requestText: '体育资讯' }));
  expect(pending).toMatchObject({ kind: 'today_news', queryKind: 'sports_news', date: '2026-10-31', items: [] });
  expect(get).not.toHaveBeenCalled();
  expect(pending.skipped.some(s => /国内网络尚未实测/.test(s.reason))).toBe(true);
  const fixture = source('domestic_fixture', () => ({ items: [item('sport', { category: '体育' })] }), { region: 'cn', kind: 'sports_news' });
  const value = JSON.parse(await runNewsLookup({ lookup: { region: 'cn', sources: [fixture] }, now: () => now, fetchImpl: async () => new Response('fixture') }, { categories: ['体育'] }, { requestText: '体育资讯' }));
  expect(value.items[0]).toMatchObject({ kind: 'sports_news', category: '体育', verified: 'index' });
  expect(value.coverage.crossChecked).toBe(false);
  expect(value.range.mode).toBe('recent24h');
});
