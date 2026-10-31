import { afterEach, expect, it, vi } from 'vitest';
import { lookupIntent } from '../src/agent/lookup/intent.js';
import { runLookup } from '../src/agent/lookup/runner.js';
import { createLookupClock, createRetrievalBudget, LOOKUP_TOTALS } from '../src/agent/lookup/clock.js';
import { withLookupDeadline } from '../src/agent/lookupDeadline.js';
import { createLookupQueue, runLookupOperation } from '../src/agent/lookup/operations.js';
import { lookupClosingNote, lookupAnswerNote } from '../src/agent/lookup/answer.js';
import { MORE_TIME_ASK } from '../src/agent/lookup/messages.js';
import { createSportsScoresTool } from '../src/agent/sportsScores.js';
import { clearZhibo8Cache, ZHIBO8_URL } from '../src/agent/sportsZhibo8.js';
import { weatherPlace } from '../src/agent/lookup/plan.js';
import { reusesPreSearch } from '../src/agent/preSearch.js';
import { runAgent } from '../src/agent/agent.js';
import { readLookupPreferences } from '../src/agent/lookup/preferences.js';
import { lookupSourceRegistry } from '../src/agent/lookup/sources.js';
import { sportsWindow, inSportsWindow } from '../src/agent/sportsWindow.js';
import { createLookupService, memoryLookupStorage } from '../src/agent/lookup/service.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); clearZhibo8Cache(); });
const schema = { type: 'object', properties: {} };
const now = Date.parse('2026-10-31T23:50:00+08:00');
const execute = vi.fn(async calls => calls.map(c => ({ ok: true, output: `真实回执 ${c.name}` })));
const getTool = name => ({ name, input_schema: { properties: { categories: { items: { enum: ['体育'] } }, date_mode: {} } } });

it('新闻/天气/赛程/股票/汇率在同一个runner选择原工具，不猜证券代码或天气定位', async () => {
  execute.mockClear();
  for (const [text, tool, args] of [
    ['南京江宁区今天天气', 'get_weather', { place: '南京江宁区' }],
    ['集团年天气', 'get_weather', { place: '南京' }],
    ['今天足球赛程', 'get_sports_scores', { sport: 'football', period: 'forward_live', window_minutes: 120 }],
    ['600519收盘价', 'get_stock_kline', { code: '600519', adjustment: 'none' }],
    ['茅台今天股价', 'web_search', { query: '茅台今天股价' }],
    ['美元兑人民币汇率', 'web_search', { query: '美元兑人民币汇率' }],
    ['体育资讯', 'get_today_news', { categories: ['体育'], date_mode: 'recent24h' }]
  ]) {
    const result = await runLookup(lookupIntent(text), { text, execute, getTool, now });
    expect(result.tool).toBe(tool); expect(result.args).toMatchObject(args);
  }
  for (const text of ['今天天气', '你在干嘛', '发个新闻那么慢', '帮我写一份天气报告']) {
    const before = execute.mock.calls.length;
    expect(await runLookup(lookupIntent(text), { text, execute, getTool, now })).toBeNull();
    expect(execute.mock.calls.length).toBe(before);
  }
  expect(weatherPlace('南京天气')).toBe('南京'); expect(weatherPlace('我这天气')).toBeNull();
});

it('生产总时钟包含上下文等待，检索与模型读取同一资源账本，工具调用不会重置时间', () => {
  let t = 0; const clock = createLookupClock({ totalMs: LOOKUP_TOTALS.news, phased: true, now: () => t });
  const budget = createRetrievalBudget('今日新闻', { clock });
  t = 9000; expect(budget.remaining).toBe(30000); budget.begin(); budget.consume('read');
  expect(createRetrievalBudget('今日新闻', { clock })).toBe(budget);
  t = 39000; expect(budget.remaining).toBe(0); expect(budget.begin()).toBe(false);
  expect(() => budget.consume('search')).toThrow('这次搜索没有执行');
  expect(clock.remaining()).toBe(6000); expect(budget.resources.read).toBe(1);
});

it('生产天气/赛程硬期限各40秒，不自动悄悄延长180秒；普通旧API仍有原门禁', async () => {
  vi.useFakeTimers();
  for (const [text, totalMs] of [['南京天气', 40000], ['今天足球赛程', 40000]]) {
    const call = vi.fn(async () => new Promise(() => {}));
    const pending = withLookupDeadline({ userText: text }, call, { profiles: true });
    await vi.advanceTimersByTimeAsync(totalMs);
    expect(await pending).toMatchObject({ review: { outcome: 'partial' } });
    expect((await pending).text).toContain('未能在时限内'); expect(call).toHaveBeenCalledTimes(1);
  }
  const run = vi.fn(async () => ({ needsMoreTime: true }));
  await withLookupDeadline({ userText: '今日新闻' }, run, { profiles: true });
  expect(run).toHaveBeenCalledTimes(1);
});

it('总期限到点时保留真实数据回执，晚到模型的文字不再写回', async () => {
  vi.useFakeTimers(); const events = []; let forwarded;
  const pending = withLookupDeadline({ userText: '南京天气', emit: event => events.push(event) }, async options => {
    forwarded = options; options.lookupControl.fallback = () => '地点：南京江宁；来源：和风天气；实况18°C。';
    return new Promise(() => {});
  }, { profiles: true });
  await vi.advanceTimersByTimeAsync(40000); const result = await pending;
  expect(result.text).toContain('实况18°C'); expect(result.text).toContain(MORE_TIME_ASK);
  const before = events.length; forwarded.emit({ type: 'text', delta: '迟到的未核实文字' }); expect(events).toHaveLength(before);
});

it('预查超时会取消忽略signal的提供者，回执不冒充成功；再查新轮的时钟不沿用旧起点', async () => {
  vi.useFakeTimers(); let signal;
  const work = runLookup(lookupIntent('南京天气'), { text: '南京天气', getTool, execute: async (_, s) => { signal = s; return new Promise(() => {}); } });
  await vi.advanceTimersByTimeAsync(40000); expect((await work).recovery.state).toBe('failed'); expect(signal.aborted).toBe(true);
  const first = createLookupClock({ totalMs: 5000 }); await vi.advanceTimersByTimeAsync(5000);
  const second = createLookupClock({ totalMs: 5000 }); expect(first.remaining()).toBe(0); expect(second.remaining()).toBe(5000);
});

it('原足球工具和卡片同窗：默认当前起两小时，跨午夜保留边界，窗口外/完场不混入', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const row = (id, offset, state = '1') => { const at = new Date(now + offset * 60000 + 8 * 3600000).toISOString(); return { id, type: 'football', leagueid: '1', sdate: at.slice(0, 10), time: at.slice(11, 16), state, home_team: id, visit_team: '客队', home_score: '1', visit_score: '0' }; };
  const list = [row('早于窗口', -1, '1'), row('进行中', 0, '2'), row('次日边界', 120), row('超出', 121), row('完场', 10, '3'), row('过期进行中', -121, '2'), row('未来进行中', 10, '2')];
  const onScores = vi.fn(), get = vi.fn(async () => ({ ok: true, json: async () => ({ list }) }));
  const text = await createSportsScoresTool({ fetchImpl: get, onSportsScores: onScores }).run({}, { requestText: '足彩赛程' });
  expect(get.mock.calls[0][0]).toBe(ZHIBO8_URL);
  expect(text).toContain('次日边界'); expect(text).toContain('进行中');
  for (const bad of ['早于窗口', '超出', '完场', '过期进行中', '未来进行中']) expect(text).not.toContain(bad);
  expect(onScores.mock.calls[0][0].events.map(row => row.home)).toEqual(['进行中', '次日边界']);
  expect(onScores.mock.calls[0][0].query.period).toBe('forward_live');
});

it('源只有分钟精度，当前分钟不因秒数被裁掉，过去的未赛和两小时外仍排除', () => {
  const window = sportsWindow({ period: 'forward_live' }, now + 38000);
  expect(inSportsWindow(now, 'in', window)).toBe(true); expect(inSportsWindow(now, 'pre', window)).toBe(true);
  expect(inSportsWindow(now - 60000, 'pre', window)).toBe(false);
  expect(inSportsWindow(now - 60000, 'in', sportsWindow({ period: 'upcoming' }, now))).toBe(false);
  expect(inSportsWindow(now + 121 * 60000, 'pre', window)).toBe(false);
});

it('进行中按活动覆盖当前时刻判断，跨午夜中场不丢；陈旧in、未来in及完场仍排除', () => {
  const window = sportsWindow({ period: 'forward_live' }, now);
  expect(inSportsWindow(now - 60 * 60000, 'in', window)).toBe(true);
  expect(inSportsWindow(now - 120 * 60000, '2', window)).toBe(true);
  expect(inSportsWindow(now - 121 * 60000, 'in', window)).toBe(false);
  expect(inSportsWindow(now + 60000, 'in', window)).toBe(false);
  expect(inSportsWindow(now - 60000, 'post', window)).toBe(false);
});

it('通用查询操作最多四项并发，失败入健康记录；输入/用户停止不误判来源故障', async () => {
  let active = 0, peak = 0; const release = [];
  const queue = createLookupQueue(4), record = vi.fn(), health = { get: async () => ({}), record };
  const tool = { name: 'web_search', run: async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => release.push(resolve)); active--; return '结果'; } };
  const all = Array.from({ length: 7 }, () => runLookupOperation(tool, {}, {}, { queue, health }));
  for (let i = 0; i < 7; i++) { await vi.waitFor(() => expect(release.length).toBeGreaterThan(0)); release.shift()(); }
  await Promise.all(all); expect(peak).toBe(4); expect(record).toHaveBeenCalledTimes(7);
  record.mockClear();
  await expect(runLookupOperation({ name: 'get_weather', run: async () => { throw Object.assign(Error('缺地点'), { name: 'ValidationError' }); } }, {}, {}, { health })).rejects.toThrow('缺地点');
  expect(record).not.toHaveBeenCalled();
  const ctrl = new AbortController(); ctrl.abort(Error('用户停止'));
  const run = vi.fn(); await expect(runLookupOperation({ name: 'web_search', run }, {}, { signal: ctrl.signal }, { health })).rejects.toThrow('用户停止'); expect(run).not.toHaveBeenCalled();
});

it('明确的长文档和逐项核验保留原工具期限，不叠普通查询8秒和整项查询冷却', async () => {
  const health = { get: vi.fn(async () => ({ cooling: true })), record: vi.fn() };
  const execution = { retrieval: { extensive: true } }; const run = vi.fn(async (_, options) => options);
  expect(await runLookupOperation({ name: 'fetch_url', run }, { url: 'https://example.com/doc' }, execution, { health })).toBe(execution);
  expect(health.get).not.toHaveBeenCalled(); expect(run).toHaveBeenCalledTimes(1);
});

it('回答只有一份查询说明和最多一处收尾，关键校验失败仍保留，重复提示不追加', () => {
  const note = lookupAnswerNote(lookupIntent('体育资讯'), '体育资讯');
  expect(note).toContain('不能用赛程表'); expect(note.match(/查几个方面/g)).toHaveLength(1);
  const followup = lookupIntent('各三条', { history: [{ role: 'user', content: '最近体育资讯' }] });
  expect(lookupAnswerNote(followup, '各三条')).toContain('最近24小时筛选');
  const warning = '关键数值校验失败，请人工复核。';
  const tail = lookupClosingNote({ answer: '已取得部分资料。', quickStop: true, warnings: [warning, warning] });
  expect(tail.match(/关键数值校验失败/g)).toHaveLength(1); expect(tail).toContain(MORE_TIME_ASK);
  expect(lookupClosingNote({ answer: tail, quickStop: true, warnings: [warning] })).toBe('');
  expect(reusesPreSearch({ name: 'get_weather', args: { place: '南京', days: 3 } }, { tool: 'get_weather', args: { place: '南京' } })).toBe(true);
});

it('查询口径逐条持久化，重建服务仍按同一窗口；已保存的用户口径不被默认值覆盖', async () => {
  const data = new Map(); const storage = { get: async id => data.get(id), put: async row => data.set(row.id, row) };
  const preferences = await readLookupPreferences(storage);
  expect(lookupIntent('今天足球赛程', { preferences }).params.window_minutes).toBe(120);
  const row = [...data.values()][0]; row.preferences = [{ ...row.preferences[0], params: { ...row.preferences[0].params, window_minutes: 60 } }];
  expect(lookupIntent('今天足球赛程', { preferences: await readLookupPreferences(storage) }).params.window_minutes).toBe(60);
  expect(lookupIntent('全天足球赛程', { preferences: await readLookupPreferences(storage) }).params.period).toBe('all');
});

it('公开查询条目不把抓取时间冒充新闻发布时间，行情仍保留同来源同复权接口', async () => {
  const result = await runLookup(lookupIntent('600519收盘价'), { text: '600519收盘价', getTool,
    execute: async () => [{ ok: true, output: JSON.stringify({ symbol: 'sh600519', source: '测试行情接口', sourceUrl: 'https://example.com/stock', fetchedAt: '2026-10-31T10:00:00Z', latestClose: 100, previousClose: 99, priceDate: '2026-10-30', previousPriceDate: '2026-10-29', adjustment: 'none' }) }] });
  expect(result.items[0]).toMatchObject({ publishedAt: null, latestClose: 100, previousClose: 99, priceDate: '2026-10-30', adjustment: 'none', verified: 'api' });
});

it('来源注册按kind分开，天气/比分/行情/普通检索不会误选新闻RSS；完整日K调用不复用三条截断预取', () => {
  for (const kind of ['weather', 'sports_live', 'market', 'general']) {
    const sources = lookupSourceRegistry({ kind }); expect(sources.length).toBeGreaterThan(0);
    expect(sources.every(source => source.kinds.includes(kind) && source.tools.length && typeof source.needsKey === 'boolean')).toBe(true);
  }
  expect(reusesPreSearch({ name: 'get_stock_kline', args: { code: '600519' } }, { tool: 'get_stock_kline', args: { code: '600519', limit: 3 } })).toBe(false);
});

it('统一地区设置也作用于真实通用搜索，国内模式英文问题不再先连海外搜索源', async () => {
  const { createTools } = await import('../src/agent/tools.js');
  const get = vi.fn(async () => new Response('<rss><channel>' + Array.from({ length: 6 }, (_, i) => `<item><title>官方价格${i}</title><link>https://example.com/price/${i}</link><description>实际索引摘要</description></item>`).join('') + '</channel></rss>'));
  const service = createLookupService({ storage: memoryLookupStorage() });
  const tool = createTools({ lookup: service.options('cn'), searchRegion: 'global', fetchViaGateway: get }).find(tool => tool.name === 'web_search');
  const output = await tool.run({ query: 'GPT model pricing official' }, { requestText: 'GPT model pricing official' });
  expect(output).toContain('https://example.com/price/0'); expect(new URL(get.mock.calls[0][0]).hostname).toBe('cn.bing.com');
});

it('实际agent在首次模型前查天气/股票，无地点不盲查，原始用户的负约束仍在提示里', async () => {
  for (const [text, tool] of [['南京今天天气', 'get_weather'], ['600519收盘价，不要时间', 'get_stock_kline']]) {
    const run = vi.fn(async () => '已经实际取得数据'), calls = [];
    const adapter = { stream: async input => { calls.push(input); expect(run).toHaveBeenCalledTimes(1); return { text: '已取得查询结果。', toolCalls: [], stop: 'end_turn' }; } };
    await runAgent({ adapter, model: 'fixture', userText: text, history: [], context: { dynamic: '' }, tools: [{ name: tool, input_schema: schema, run }], quiet: true, emit() {} });
    expect(calls[0].messages[0].content).toContain(text);
  }
});
