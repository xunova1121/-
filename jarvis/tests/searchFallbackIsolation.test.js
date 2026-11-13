import { afterEach, expect, it, vi } from 'vitest';
import { createTools } from '../src/agent/tools.js';
import { createSearch } from '../src/agent/webSearch.js';
import { createLookupHealth, LOOKUP_COOLDOWN_MS } from '../src/agent/lookup/health.js';
import { createLookupService, memoryLookupStorage } from '../src/agent/lookup/service.js';
import { providerLookupFailure } from '../src/agent/lookup/healthPolicy.js';
import { readLookupSource } from '../src/agent/lookup/readSource.js';
import { connectLookupTools } from '../src/agent/lookup/operations.js';
import { lookupIntent } from '../src/agent/lookup/intent.js';
import { lookupPlan } from '../src/agent/lookup/plan.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { guardedSearchRoute, searchBackoff, searchRetryAfter } from '../src/agent/searchPolicy.js';
import { QIANFAN_ENDPOINT } from '../src/agent/qianfanSearch.js';

const now = Date.parse('2026-11-03T17:52:00+08:00');
const ds = 'https://api.deepseek.com/v1/tools/search';
const json = value => new Response(JSON.stringify(value));
const rows = Array.from({ length: 3 }, (_, i) => ({ title: `日本新闻报道${i}`, url: `https://www.chinanews.com.cn/world/fixture${i}`, summary: '日本公共服务新闻，合成回归数据。', date: '2026-11-03 15:00:00' }));
const options = { qianfanSearchKey: 'fake-qianfan-only', deepseekSearchEnabled: true, deepseekSearchKey: 'fake-deepseek-only', searchRegion: 'cn' };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup(get) {
  const storage = memoryLookupStorage();
  const health = createLookupHealth({ storage, now: () => now });
  for (const id of ['query_search', 'cn_cns']) for (let i = 0; i < 3; i++) await health.record(id, { state: 'failed', code: 'TimeoutError' });
  const raw = createTools({ ...options, fetchViaGateway: get });
  const news = { name: 'get_today_news', run: vi.fn(async () => JSON.stringify({ kind: 'today_news', items: [] })) };
  const tools = connectLookupTools([news, raw.find(t => t.name === 'web_search')], { health, now: () => now });
  return { health, news, tools, getTool: name => tools.find(t => t.name === name) };
}

it.each(['今天新闻', '再试试今天新闻', '再试一次今日新闻', '重新查今天新闻', '请再试试今天新闻', '再试一下今天新闻'])('%s保留概览意图，不把重试措辞当作国家/对象', text => {
  const intent = lookupIntent(text);
  expect(intent).toMatchObject({ kind: 'news', params: { dateMode: 'today' } });
  expect(intent.params.subject).toBeUndefined();
  expect(lookupPlan(intent, { text, getTool: name => ({ name }) }).name).toBe('get_today_news');
});

it.each(['日本新闻', '再试试日本新闻', '重新查日本新闻'])('%s仍精准搜索日本，不回到国内新闻汇总', text => {
  const intent = lookupIntent(text);
  expect(intent.params.subject).toBe('日本');
  expect(lookupPlan(intent, { text, getTool: name => ({ name }) }).name).toBe('web_search');
});

it.each(['今天新闻', '再试试今天新闻', '日本新闻'])('%s：旧搜索/新闻冷却不拦API；千帆空结果后实际请求DeepSeek', async text => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  const calls = [], progress = [];
  const get = vi.fn(async url => {
    calls.push(url);
    if (url === QIANFAN_ENDPOINT) return json({ references: [] });
    if (url === ds) return json({ results: rows });
    throw new Error('不应发起无关请求');
  });
  const app = await setup(get);
  expect((await app.health.get('query_search')).cooling).toBe(true);
  const intent = lookupIntent(text), plan = lookupPlan(intent, { text, getTool: app.getTool });
  const retrieval = createRetrievalBudget(text); retrieval.intent = intent;
  const result = await app.getTool(plan.name).run(plan.args, { requestText: text, retrieval, progress: line => progress.push(line) });
  expect(typeof result === 'string' ? result : result.text).toContain('日本新闻报道');
  expect(calls).toEqual([QIANFAN_ENDPOINT, ds]);
  expect(app.news.run).toHaveBeenCalledTimes(text === '日本新闻' ? 0 : 1);
  expect(progress.join('\n')).toContain('百度搜索返回0条结果');
  expect(progress.join('\n')).toContain('DeepSeek搜索返回3条结果');
  // 保留旧记录用于诊断，没有靠删除健康记录“修好”测试。
  const samples = (await app.health.get('query_search')).samples;
  expect(samples.slice(0, 3).every(sample => sample.code === 'TimeoutError')).toBe(true);
  expect(samples.at(-1).state).toBe('ok');
});

it('千帆先返回旧闻：筛选后为空必须继续DeepSeek，不能抢先结束整链', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  const get = vi.fn(async url => url === QIANFAN_ENDPOINT
    ? json({ references: [{ title: '旧新闻报道', url: 'https://www.chinanews.com.cn/old', date: '2025-11-03', content: '旧闻' }] })
    : json({ results: rows }));
  const hits = await createSearch({ ...options, fetchViaGateway: get }).search('今日新闻', 6, { requestText: '今天新闻' });
  expect(hits.map(h => h.title)).toEqual(rows.map(h => h.title));
  expect(get.mock.calls.map(c => c[0])).toEqual([QIANFAN_ENDPOINT, ds]);
});

it('千帆失败后DeepSeek只有一条有效结果也及时返回，不必等免费来源凑够三条', async () => {
  const get = vi.fn(async url => {
    if (url === QIANFAN_ENDPOINT) return new Response('', { status: 503 });
    if (url === ds) return json({ results: rows.slice(0, 1) });
    throw new Error('不应继续探测其他源');
  });
  expect(await createSearch({ ...options, fetchViaGateway: get }).search('日本新闻')).toHaveLength(1);
  expect(get.mock.calls.map(c => c[0])).toEqual([QIANFAN_ENDPOINT, ds]);
});

it('日本新闻备用在第9秒返回仍成功，5/8秒外层不能提前截断', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const get = vi.fn(async url => {
    if (url === QIANFAN_ENDPOINT) { await new Promise(r => setTimeout(r, 7500)); return new Response('', { status: 503 }); }
    if (url === ds) { await new Promise(r => setTimeout(r, 6500)); return json({ results: rows }); }
    return new Response('<html></html>');
  });
  const app = await setup(get), retrieval = createRetrievalBudget('日本新闻');
  retrieval.begin();
  const pending = app.getTool('web_search').run({ query: '日本新闻' }, { requestText: '日本新闻', retrieval });
  const checked = expect(pending).resolves.toContain('日本新闻报道');
  await vi.advanceTimersByTimeAsync(9000); await checked;
  expect(get.mock.calls.filter(c => c[0] === ds)).toHaveLength(1);
});

it('总预算只有1秒时仍立即收住，20秒备用窗口不能延长整轮期限', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const get = vi.fn(() => new Promise(() => {}));
  const app = await setup(get), retrieval = createRetrievalBudget('日本新闻', { timeBudgetMs: 1000 });
  retrieval.begin();
  const pending = app.getTool('web_search').run({ query: '日本新闻' }, { requestText: '日本新闻', retrieval });
  const checked = expect(pending).rejects.toMatchObject({ code: 'LOOKUP_RECOVERY_EXHAUSTED' });
  await vi.advanceTimersByTimeAsync(1001); await checked;
  expect(get.mock.calls.map(c => c[0])).toEqual([QIANFAN_ENDPOINT]);
});

it('单引擎故障只短退避；同轮换词不重撞，新轮到期可恢复，空结果不退避', async () => {
  let time = now;
  const run = vi.fn().mockRejectedValueOnce(Object.assign(new Error('offline'), { kind: 'network' })).mockResolvedValue([]);
  const route = guardedSearchRoute({ name: 'fixture', search: run }, 'fixture', () => time);
  const context = {};
  await expect(route.search('a', 6, { routeContext: context })).rejects.toThrow('offline');
  time += 30001;
  await expect(route.search('b', 6, { routeContext: context })).rejects.toMatchObject({ skipped: true });
  await expect(route.search('c', 6, { routeContext: {} })).resolves.toEqual([]);
  await expect(route.search('d', 6, { routeContext: {} })).resolves.toEqual([]);
  expect(run).toHaveBeenCalledTimes(3);
  expect(searchBackoff({ status: 429, retryAfterMs: 600000 })).toBe(600000);
  expect(searchRetryAfter(new Response('', { headers: { 'Retry-After': '600' } }), now)).toBe(600000);
  expect(searchRetryAfter(new Response('', { headers: { 'Retry-After': new Date(now + 600000).toUTCString() } }), now)).toBe(600000);
});

it('取消不污染来源状态；再次查询仍可访问，进度不回显上游敏感正文', async () => {
  const ctrl = new AbortController();
  const route = guardedSearchRoute({ name: 'fixture', search: vi.fn(async () => { ctrl.abort(); throw new Error('private'); }) }, 'fixture');
  await expect(route.search('a', 1, { signal: ctrl.signal })).rejects.toThrow('private');
  const progress = [];
  const get = async url => url === QIANFAN_ENDPOINT ? new Response('SECRET_RAW_BODY', { status: 401 }) : json({ results: rows });
  const result = await createSearch({ ...options, fetchViaGateway: get }).search('日本新闻', 6, { progress: s => progress.push(s) });
  expect(result).toHaveLength(3);
  expect(progress.join('\n')).toContain('HTTP 401');
  expect(progress.join('\n')).not.toMatch(/SECRET_RAW_BODY|fake-qianfan-only|fake-deepseek-only/);
});

it('新闻查询真正被未迁移的入口拦截时，回执准确写公开搜索而不是新闻来源', async () => {
  const health = { get: async () => ({ cooling: true, cooldownUntil: now + LOOKUP_COOLDOWN_MS }) };
  const [tool] = connectLookupTools([{ name: 'web_search', run: vi.fn() }], { health });
  await expect(tool.run({ query: '日本新闻' }, { requestText: '日本新闻' })).rejects.toThrow(/公开搜索冷却至北京时间/);
});

it.each(['NO_SEARCH_RESULTS', 'IRRELEVANT_SEARCH_RESULTS', 'LOOKUP_PARSE', 'UNKNOWN_ERROR'])('存量%s误判立即失效，诊断样本保留', async code => {
  const storage = memoryLookupStorage();
  await storage.put({ id: 'lookup.health.query_search', cooldownUntil: now + LOOKUP_COOLDOWN_MS,
    samples: Array.from({ length: 3 }, () => ({ at: now, code, state: 'failed', connected: false, elapsedMs: 10 })) });
  const health = createLookupHealth({ storage, now: () => now });
  expect(await health.get('query_search')).toMatchObject({ cooling: false, cooldownUntil: 0 });
  expect((await health.get('query_search')).samples).toHaveLength(3);
});

it('只把明确超时/DNS/拒绝连接/5xx以及指定授权限流状态视作提供者故障', () => {
  for (const error of [{ code: 'ENOTFOUND' }, { code: 'ECONNREFUSED' }, { name: 'TimeoutError' }, { status: 503 }, { status: 401 }, { status: 403 }, { status: 429 }]) expect(providerLookupFailure(error)).toBe(true);
  for (const error of [{ code: 'NO_SEARCH_RESULTS' }, { code: 'LOOKUP_PARSE' }, { code: 'IRRELEVANT_SEARCH_RESULTS' }, { code: 'REPEATED_SEARCH' }, { status: 404 }, { status: 400 }, { status: 422 }, { kind: 'parse' }]) expect(providerLookupFailure(error)).toBe(false);
});

it('新闻列表HTTP200但解析失败、HTTP404都不能让来源冷却', async () => {
  const health = createLookupHealth({ storage: memoryLookupStorage() });
  const source = { id: 'fixture_news', label: '合成新闻', url: 'https://example.com/news', parse() { throw new Error('schema'); } };
  for (const status of [200, 404]) {
    for (let i = 0; i < 3; i++) {
      const result = await readLookupSource(source, { get: async () => new Response('<html></html>', { status }) });
      expect(result.providerFailure).toBe(false);
      await health.record(source.id, result);
    }
    expect((await health.get(source.id)).cooling).toBe(false);
  }
});

it('全部真实聚合工具不受旧入口冷却阻断，健康接口也不再显示整体停用', async () => {
  const service = createLookupService({ storage: memoryLookupStorage(), now: () => now });
  for (const id of ['query_search', 'query_quote', 'query_weather', 'query_sports', 'query_market']) for (let i = 0; i < 3; i++) await service.health.record(id, { state: 'failed', code: 'TimeoutError' });
  const tools = createTools({ ...options, lookup: service.options('cn'), fetchViaGateway: async () => json({}) });
  for (const name of ['web_search', 'get_weather', 'get_sports_scores', 'get_stock_kline', 'get_market_quote']) expect(tools.find(t => t.name === name)?.sourceHealthManaged).toBe(true);
  const snapshot = await service.status('cn');
  for (const row of snapshot.operations.filter(row => row.id.startsWith('query_') && !['query_page', 'query_json'].includes(row.id))) expect(row).toMatchObject({ cooling: false, cooldownUntil: 0, historicalCooldownUntil: now + LOOKUP_COOLDOWN_MS });
});
