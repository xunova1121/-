import { it, expect, vi, afterEach } from 'vitest';
import { recoverLookup } from '../src/agent/lookup/recovery.js';
import { createLastGood, lastGoodKey } from '../src/agent/lookup/lastGood.js';
import { createLookupService, memoryLookupStorage } from '../src/agent/lookup/service.js';
import { connectLookupTools } from '../src/agent/lookup/operations.js';
import { lookupClosingNote } from '../src/agent/lookup/answer.js';
import { createLookupDelivery } from '../src/agent/lookupDelivery.js';
import { selectLookupSources } from '../src/agent/lookup/sources.js';
import { createLookupClock, createRetrievalBudget, LOOKUP_TOTALS } from '../src/agent/lookup/clock.js';
import { runAgent } from '../src/agent/agent.js';
const at = Date.parse('2026-10-31T10:00:00+08:00');
const weather = '地点：南京\n实况（2026-10-31 10:00）：晴，18°C\n今天（2026-10-31）：晴，11～22°C\n来源：和风天气\n本次数据链接：https://www.qweather.com/weather/nanjing.html';
const cases = [
  ['weather', 'get_weather', { place: '南京' }, '南京今天天气', weather],
  ['sports_live', 'get_sports_scores', { sport: 'football', period: 'all' }, '今天足球赛程', '今天赛程：虚构甲队 vs 虚构乙队；来源：https://zhibo8.com/fixture'],
  ['news', 'get_today_news', { categories: ['国内'] }, '今日新闻', JSON.stringify({ kind: 'today_news', date: '2026-10-31', items: [{ title: '虚构新闻', summary: '公共服务平台启用', publishedAt: '2026-10-31T09:00:00+08:00', url: 'https://news.example/a' }] })],
  ['sports_news', 'get_today_news', { categories: ['体育'] }, '体育资讯', JSON.stringify({ kind: 'today_news', date: '2026-10-31', items: [{ title: '虚构球队训练新闻', summary: '球队恢复训练', publishedAt: '2026-10-31T09:00:00+08:00', url: 'https://news.example/sport' }] })],
  ['market', 'get_stock_kline', { code: '600519', adjustment: 'none' }, '600519收盘价', JSON.stringify({ symbol: 'sh600519', sourceUrl: 'https://market.example/kline', latestClose: 100, previousClose: 99, priceDate: '2026-10-30', adjustment: 'none' })],
  ['general', 'web_search', { query: '虚构公共政策' }, '虚构公共政策是什么', JSON.stringify([{ title: '官方说明', snippet: '真实摘要', url: 'https://public.example/a' }])]
];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function setup(row, execute, extra = {}) {
  const [kind, name, args, text] = row;
  return [ { kind, lookup: true, params: { dateMode: 'today' } }, { name, args, timeoutMs: 5000 },
    { text, execute, getTool: tool => ({ name: tool }), nowFn: () => at, ...extra } ];
}
it.each(cases)('%s专用源失败后程序自动搜索并读原文，不交原始错误码', async (...row) => {
  const execute = vi.fn(async calls => calls.map(call => call.name === 'fetch_url' ? { ok: true, output: '实际取得的网页正文，来源保留。' } : call.name === 'web_search' && (row[1] !== 'web_search' || call.args.query.endsWith('官方资料')) ? { ok: true, output: JSON.stringify([{ title: row[3] + ' 新闻公开来源', snippet: '已取得摘要', url: 'https://public.example/article' }]) } : { ok: false, failure: { status: 503 } }));
  const result = await recoverLookup(...setup(row, execute));
  expect(result.recovery.state).toBe('recovered'); expect(result.recovery.note).toContain('已改用');
  expect(result.output).toContain('实际取得的网页正文');
  expect(result.recovery.note).not.toMatch(/HTTP|503|get_weather|web_search/);
  expect(execute.mock.calls.some(([c]) => c[0].name === 'fetch_url')).toBe(true);
});
it.each(cases)('%s全部现查失败只交一句原因和下一步，不列候选链接', async (...row) => {
  const execute = vi.fn(async () => [{ ok: false, failure: { name: 'TimeoutError' } }]);
  const result = await recoverLookup(...setup(row, execute));
  expect(result.recovery.state).toBe('failed'); expect(result.output).toContain('稍后再试');
  expect(result.output).not.toMatch(/get_|web_search|HTTP|Timeout|再查一会儿|https?:|\n/);
  expect(execute.mock.calls.length).toBeLessThanOrEqual(4);
});
it.each(cases.filter(c => c[0] !== 'general'))('%s先现查，全部失败才读独立缓存并注明原时间；过期不用', async (...row) => {
  let time = at; const storage = memoryLookupStorage(); const cache = createLastGood({ storage, now: () => time });
  const args = setup(row, async () => [{ ok: true, output: row[4] }], { lastGood: cache, nowFn: () => time });
  await recoverLookup(...args);
  const execute = vi.fn(async () => [{ ok: false, failure: { status: 404 } }]); args[2].execute = execute;
  time += 60_000; const found = await recoverLookup(...args);
  expect(execute).toHaveBeenCalled(); expect(found.recovery.state).toBe('cached'); expect(found.recovery.note).toContain('10:00:00');
  expect(found.recovery.note).toMatch(/不是本次实时更新|并非实时比分/);
  time += row[0] === 'weather' ? 3 * 3600_000 : row[0] === 'sports_live' ? 10 * 60_000 : 86400_000;
  expect((await recoverLookup(...args)).recovery.state).toBe('failed');
});
it('一般问题不缓存；个人问题/坐标/凭据与不同地点口径不能共用缓存', () => {
  const general = setup(cases[5], vi.fn()); expect(lastGoodKey(...general.slice(0, 2))).toBeNull();
  const [intent, plan] = setup(cases[0], vi.fn());
  expect(lastGoodKey(intent, plan, '我的住址天气')).toBeNull();
  expect(lastGoodKey(intent, { ...plan, args: { place: 'https://secret.example/key' } })).toBeNull();
  expect(lastGoodKey(intent, plan)).not.toBe(lastGoodKey(intent, { ...plan, args: { place: '上海' } }));
});
it.each([cases[0], cases[4]])('%s缺信息直接追问，不搜、不读缓存', async (...row) => {
  const cache = { get: vi.fn(), put: vi.fn() };
  const execute = vi.fn(async () => [{ ok: false, failure: { name: 'ValidationError' } }]);
  const found = await recoverLookup(...setup(row, execute, { lastGood: cache }));
  expect(found.recovery.state).toBe('input'); expect(found.output).toMatch(/城市或区县|证券代码/);
  expect(execute).toHaveBeenCalledTimes(1); expect(cache.get).not.toHaveBeenCalled();
});
it('评测独立内存不读写生产缓存；重建生产服务仍能读取自己的缓存', async () => {
  const storage = memoryLookupStorage(); const prod = createLookupService({ storage, now: () => at });
  const args = setup(cases[0], async () => [{ ok: true, output: weather }], { lastGood: prod.lastGood });
  await recoverLookup(...args); const key = lastGoodKey(args[0], args[1], args[2].text);
  const isolated = createLookupService({ storage: memoryLookupStorage(), now: () => at });
  expect(await isolated.lastGood.get(key, 'weather')).toBeNull();
  expect(await createLookupService({ storage, now: () => at }).lastGood.get(key, 'weather')).not.toBeNull();
});
it('用户停止立即中止阶梯，迟到结果不入缓存；同一硬钟不给新方法另开期限', async () => {
  vi.useFakeTimers(); vi.setSystemTime(at); const ctrl = new AbortController(); const cache = { get: vi.fn(), put: vi.fn() };
  const clock = createLookupClock({ totalMs: 1000, phased: true });
  const execute = vi.fn(async () => new Promise(() => {}));
  const pending = recoverLookup(...setup(cases[0], execute, { signal: ctrl.signal, clock, lastGood: cache }));
  const assertion = expect(pending).rejects.toThrow('用户停止');
  ctrl.abort(new Error('用户停止')); await assertion; expect(cache.put).not.toHaveBeenCalled();
  expect(execute.mock.calls.length).toBeLessThanOrEqual(1);
});
it('来源按近期成功率/耗时排序，鉴权显示在设置健康数据，冷却仍生效', async () => {
  const service = createLookupService({ storage: memoryLookupStorage(), now: () => at });
  await service.health.record('slow', { state: 'failed', code: 'LOOKUP_AUTH', elapsedMs: 5000 });
  await service.health.record('fast', { state: 'ok', elapsedMs: 100 });
  const sources = ['slow', 'fast'].map((id, i) => ({ id, region: 'cn', validation: 'existing', priority: i + 1 }));
  const selected = await selectLookupSources({ sources, region: 'cn', health: service.health });
  expect(selected.sources[0].id).toBe('fast');
  expect(await service.health.get('slow')).toMatchObject({ successRate: 0, averageMs: 5000, authorizationIssue: true });
});
it('自救说明只去掉重复网络尾注，关键校验失败继续显示且审查不改', () => {
  const recovery = { state: 'cached' };
  const note = lookupClosingNote({ answer: '现查没成功，这是10:00数据。', quickStop: true, recovery,
    warnings: ['尚未取得可核查的联网资料，不能当作查询成功。', '关键数值校验失败，请人工复核。'] });
  expect(note).toContain('关键数值校验失败'); expect(note).not.toMatch(/再查一会儿|尚未取得可核查/);
  const delivery = createLookupDelivery('南京今天天气', () => at);
  delivery.record({ name: 'get_weather', ok: true, output: weather, lookupRecovery: { state: 'cached', note: '这是10:00查到的，不是实时更新。', output: weather } });
  expect(delivery.delivery().complete).toBe(false); expect(delivery.text()).toContain('10:00');
});
it.each(cases)('%s连接实际工具包装器后，首选失败由程序自救而非再请求模型', async (...row) => {
  const service = createLookupService({ storage: memoryLookupStorage(), now: () => at });
  let count = 0;
  const primary = { name: row[1], run: async () => { count++; throw Object.assign(new Error('不可泄露的原始报错'), { status: 401 }); } };
  const search = { name: 'web_search', run: async () => JSON.stringify([{ title: row[3] + ' 公共结果', snippet: '可用摘要', url: 'https://public.example/a' }]) };
  const tools = connectLookupTools(row[1] === 'web_search' ? [{ ...primary, run: async () => { if (++count === 1) throw Object.assign(Error('原始报错'), { status: 401 }); return search.run(); } }] : [primary, search], service.options('cn'));
  const output = await tools[0].run(row[2], { requestText: row[3] });
  expect(output.lookupRecovery.state).toBe('recovered'); expect(output.text).toContain('公共结果'); expect(output.text).not.toContain('原始报错');
});
it.each([cases[3], cases[4], ['general', 'web_search', { query: '新电影什么时候上映' }, '新电影什么时候上映', JSON.stringify([{ title: '虚构电影发布信息', snippet: '只用于测试的上映资料', url: 'https://public.example/movie' }])]])('%s真实agent取数后首字9秒正常，20秒无首字仍有可读兜底', async (...row) => {
  vi.useFakeTimers(); vi.setSystemTime(at);
  const input = { userText: row[3], tools: [{ name: row[1], input_schema: { type: 'object', properties: { categories: { items: { enum: ['体育'] } }, date_mode: {} } }, run: async () => row[4] }], model: 'fixture', history: [], context: { dynamic: '' }, quiet: true, emit() {} };
  const adapter = { stream: vi.fn(async options => { await new Promise(r => setTimeout(r, 9000)); options.onText('根据实际取得的来源，资料内容如下：https://public.example/a'); return { text: '', toolCalls: [], stop: 'end_turn' }; }) };
  const normal = runAgent({ ...input, adapter }); await vi.advanceTimersByTimeAsync(9001);
  expect((await normal).text).toContain('根据实际取得的来源');
  const blocked = runAgent({ ...input, adapter: { stream: async () => new Promise(() => {}) } });
  await vi.advanceTimersByTimeAsync(20000); const answer = await blocked;
  expect(answer.text).toMatch(/来源|收盘|虚构/); expect(answer.text).not.toMatch(/先给你本轮实际取得的数据|"latestClose"/);
});
it('恢复后的搜索结果不把JSON直接贴给用户，保留搜索摘要与真实正文证据', async () => {
  const execute = async calls => calls.map(call => call.name === 'web_search' ? { ok: true, output: JSON.stringify([{ title: '南京天气虚构标题', snippet: '实际摘要', url: 'https://public.example/a' }]) } : call.name === 'fetch_url' ? { ok: true, output: '实际读取正文' } : { ok: false, failure: { status: 404 } });
  const found = await recoverLookup(...setup(cases[0], execute));
  expect(found.output).toContain('实际摘要'); expect(found.output).toContain('实际读取正文'); expect(found.output).not.toContain('"snippet"');
});
it('鉴权失败不重试同一个密钥，并把健康标记保留下来', async () => {
  const service = createLookupService({ storage: memoryLookupStorage(), now: () => at });
  const run = vi.fn(async () => { throw Object.assign(Error('HTTP 401 secret'), { status: 401 }); });
  const tools = connectLookupTools([{ name: 'get_weather', run }, { name: 'web_search', run: async () => '[{"title":"南京天气有效结果","snippet":"实际内容","url":"https://public.example/a"}]' }], service.options('cn'));
  const value = await tools[0].run({ place: '南京' }, { requestText: '南京天气' });
  expect(run).toHaveBeenCalledTimes(1); expect(value.text).toContain('授权或额度'); expect(value.text).not.toContain('secret');
  expect(await service.health.get('query_weather')).toMatchObject({ authorizationIssue: true });
});
it('偶发503同源短重试一次；鉴权不重试，且同源全部失败仍有明确边界', async () => {
  const { shortSourceRetry } = await import('../src/agent/lookup/weatherProvider.js');
  const run = vi.fn().mockRejectedValueOnce(Object.assign(Error('temporary'), { status: 503 })).mockResolvedValueOnce('ok');
  expect(await shortSourceRetry(run)).toBe('ok'); expect(run).toHaveBeenCalledTimes(2);
  const auth = vi.fn(async () => { throw Object.assign(Error('auth'), { status: 401 }); });
  await expect(shortSourceRetry(auth)).rejects.toMatchObject({ status: 401 }); expect(auth).toHaveBeenCalledTimes(1);
});
it('缓存容量有上限；过期记录淘汰，已缓存结果不会被重新标成刚取得', async () => {
  let time = at; const storage = memoryLookupStorage(); const cache = createLastGood({ storage, now: () => time });
  for (let i = 0; i < 30; i++) await cache.put('weather:' + i, 'weather', { tool: 'get_weather', args: { place: '虚构城市' }, output: weather });
  expect((await storage.get('lookup.last-good.v1')).rows).toHaveLength(24);
  const row = await cache.get('weather:29', 'weather'); time += 1000;
  await cache.put('weather:29', 'weather', { ...row.found, recovery: { state: 'cached' } });
  expect((await cache.get('weather:29', 'weather')).at).toBe(at);
});
it('白名单JSON失败不能绕过信任域校验，也不能让来源文本覆盖用户要求', async () => {
  const execute = vi.fn(async calls => calls.map(c => c.name === 'fetch_json' ? { ok: false, failure: { code: 'PUBLIC_JSON_BLOCKED', kind: 'input' } } : { ok: false, failure: { status: 404 } }));
  const args = setup(cases[5], execute); args[2].text = '读取 https://untrusted.example/data.json';
  const found = await recoverLookup(...args);
  expect(found.recovery.state).toBe('failed');
  expect(execute.mock.calls.filter(([c]) => c[0].name === 'fetch_json')).toHaveLength(1);
  expect(found.output).not.toContain('PUBLIC_JSON_BLOCKED');
});
it('统一runner对搜索后备仍标索引证据，不把天气工具名当作天气API已成功', async () => {
  const { runLookup } = await import('../src/agent/lookup/runner.js');
  const service = createLookupService({ storage: memoryLookupStorage(), now: () => at });
  const tools = connectLookupTools([{ name: 'get_weather', run: async () => { throw Object.assign(Error('fail'), { status: 404 }); } }, { name: 'web_search', run: async () => '[{"title":"南京天气报道","snippet":"索引摘要","url":"https://public.example/a"}]' }], service.options('cn'));
  const intent = { kind: 'weather', lookup: true, params: { city: '南京' } };
  const value = await runLookup(intent, { text: '南京天气', getTool: n => tools.find(t => t.name === n), execute: async calls => Promise.all(calls.map(async c => { const result = await tools.find(t => t.name === c.name).run(c.args, { requestText: '南京天气' }); return { ok: true, output: result.text, lookupRecovery: result.lookupRecovery }; })) });
  expect(value.tool).toBe('web_search'); expect(value.items.every(row => row.verified === 'index')).toBe(true);
});
it('普通失败兜底不泄露原始工具名/错误码；完整免费天气保留切换说明', async () => {
  const delivery = createLookupDelivery('南京天气', () => at);
  delivery.record({ name: 'get_weather', ok: false, output: '错误：HTTP 503 private-detail' });
  expect(delivery.text()).not.toMatch(/get_weather|HTTP|503|private-detail/);
  const { weatherFallback } = await import('../src/agent/lookup/fallback.js');
  expect(weatherFallback('和风天气暂时不可用，已改用Open-Meteo。\n' + weather, '南京天气', at).text).toContain('已改用Open-Meteo');
});
it('新闻重试不能抢走其他来源/正文的8读额度，失败源不抹掉成功源', async () => {
  const { runLookup } = await import('../src/agent/lookup/runner.js');
  const sources = Array.from({ length: 5 }, (_, i) => ({ id: 'source' + i, label: '测试源' + i, region: 'cn', kind: 'news', validation: 'existing', priority: i, url: 'https://public.example/' + i,
    parse: () => ({ items: [{ title: '虚构新闻', category: '国内', publishedAt: '2026-10-31T09:00:00+08:00', url: 'https://public.example/article' }] }) }));
  let reads = 0; const get = vi.fn(async url => new Response('', { status: url.endsWith('/4') ? 200 : 503 }));
  const value = await runLookup({ kind: 'news', params: { categories: ['国内'] } }, { now: at, sources, region: 'cn', get, retrieval: { consume: () => { if (++reads > 8) throw Error('越界'); }, resources: { read: 0 } } });
  expect(value.items).toHaveLength(1); expect(reads).toBeLessThanOrEqual(8); expect(value.failures).toHaveLength(4);
});
it('真实大小的新闻回执压成有界短缓存而不是全部丢掉，仍注明只保留部分', async () => {
  const storage = memoryLookupStorage(); const cache = createLastGood({ storage, now: () => at });
  const output = JSON.stringify({ kind: 'today_news', date: '2026-10-31', items: Array.from({ length: 12 }, (_, i) => ({ title: '虚构报道' + i, summary: '新闻正文'.repeat(300), url: 'https://public.example/' + i, publishedAt: '2026-10-31T09:00:00+08:00' })), sources: [{ details: 'diagnostics'.repeat(1000) }] });
  await cache.put('news:国内', 'news', { tool: 'get_today_news', args: {}, output });
  const row = await cache.get('news:国内', 'news');
  expect(row.items.length).toBeGreaterThan(0); expect(row.found.output).toContain('不能当作原始完整列表');
  expect(new TextEncoder().encode(JSON.stringify({ items: row.items, found: row.found })).length).toBeLessThanOrEqual(8000);
});
it('赛程自救拒绝客服/百科错题，不能把HTTP200和有链接当作查到比分', async () => {
  const args = setup(cases[1], async calls => calls.map(call => call.name === 'web_search' ? { ok: true, output: '[{"title":"大疆客服电话24小时","snippet":"售后服务","url":"https://public.example/support"}]' } : { ok: false, failure: { status: 404 } }));
  const found = await recoverLookup(...args);
  expect(found.recovery.state).toBe('failed'); expect(found.output).not.toMatch(/大疆|https:/);
});

it('和风GeoAPI的HTTP200鉴权JSON不能被当作城市不存在', async () => {
  const { lookupQWeatherCity } = await import('../src/core/qweather.js');
  for (const code of ['401', '402', '403', '429']) await expect(lookupQWeatherCity({ key: 'fixture', host: 'weather.example.com', query: '南京', fetchImpl: async () => new Response(JSON.stringify({ code })) })).rejects.toMatchObject({ status: Number(code), code: 'QWEATHER_AUTH' });
  expect(await lookupQWeatherCity({ key: 'fixture', host: 'weather.example.com', query: '不存在的城市', fetchImpl: async () => new Response('{"code":"404"}') })).toEqual([]);
});
