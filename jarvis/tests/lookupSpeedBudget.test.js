import { it, expect, vi } from 'vitest';
import { createPublicReadCache, publicPageTtl } from '../src/agent/publicReadCache.js';
import { createLookupRuntime } from '../src/agent/lookupRuntime.js';
import { createPageReader } from '../src/agent/pageReader.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { createFetchPageRun } from '../src/agent/fetchPageTool.js';
import { pageReadBatch } from '../src/agent/pageReadReceipt.js';
import { staggeredSearch } from '../src/agent/webSearch.js';
import { guardedSearchRoute } from '../src/agent/searchPolicy.js';
import { projectLookupMessages } from '../src/agent/requestContext.js';
import { createTurnArchive } from '../src/agent/turnContext.js';
import { createTaskTiming } from '../shared/taskTiming.js';
import { measureModelInput, measureModelTokens } from '../shared/modelMetrics.js';
import { createLookupAnswerModel } from '../src/agent/lookupModels.js';
import { runAgent } from '../src/agent/agent.js';

const urls = [1, 2, 3].map(index => `https://page${index}.example.com/article`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = text => ({ text, toolCalls: [], stop: 'end_turn' });

it('有真实预留账本的3页按2并发在12秒结束，全部来源与原顺序保持', async () => {
  vi.useFakeTimers();
  try {
    let active = 0, maxActive = 0;
    const read = vi.fn(async url => { active++; maxActive = Math.max(maxActive, active); await wait(6000); active--; return `${url} 实际正文农业数据。`.repeat(8); });
    read.publicOnly = true;
    const retrieval = createRetrievalBudget('查询公司'); retrieval.begin();
    const pending = createFetchPageRun({}, read)({ urls: [...urls] }, { retrieval });
    await vi.advanceTimersByTimeAsync(6001);
    expect(read).toHaveBeenCalledTimes(3);
    expect(retrieval.resources.read).toBe(3);
    await vi.advanceTimersByTimeAsync(6000);
    expect(pageReadBatch(await pending).map(page => page.url)).toEqual(urls);
    expect(maxActive).toBe(2);
  } finally { vi.useRealTimers(); }
});

it('预算不足时不作部分预扣，退回逐页且不发超额页面', async () => {
  const budget = createRetrievalBudget('查询公司'); budget.begin();
  for (let i = 0; i < 9; i++) budget.consume('read');
  expect(budget.reserve('read', 3)).toBeNull();
  expect(budget.resources.read).toBe(9);
  const read = vi.fn(async () => '已读正文'); read.publicOnly = true;
  await expect(createFetchPageRun({}, read)({ urls: [...urls] }, { retrieval: budget })).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
  expect(read).toHaveBeenCalledTimes(1);
});

it('停止或评测额度终止后不启动已排队的第三页，也不漏退未用预留', async () => {
  for (const code of ['EVAL_QUOTA', 'RETRIEVAL_BUDGET']) {
    const budget = createRetrievalBudget('查询公司'); budget.begin();
    const read = vi.fn(async url => {
      if (url === urls[0]) throw Object.assign(new Error('终止'), { code });
      await wait(10); return '实际已读正文';
    }); read.publicOnly = true;
    await expect(createFetchPageRun({}, read)({ urls: [...urls] }, { retrieval: budget })).rejects.toMatchObject({ code });
    await wait(20);
    expect(read.mock.calls.map(([url]) => url)).toEqual(urls.slice(0, 2));
    expect(budget.resources.read).toBe(2);
  }
});

it('未知/付费代读路径保留串行，不借新的并发预算发收费备用请求', async () => {
  let active = 0, maxActive = 0;
  const read = async () => { active++; maxActive = Math.max(maxActive, active); await wait(2); active--; return '实际正文'; };
  const budget = createRetrievalBudget('查询公司'); budget.begin();
  await createFetchPageRun({}, read)({ urls: [...urls] }, { retrieval: budget });
  expect(maxActive).toBe(1); expect(budget.resources.read).toBe(3);
});

it('同一公网请求只读一次，一个订阅者取消不影响其他订阅者', async () => {
  const cache = createPublicReadCache();
  let finish, underlyingSignal;
  const load = vi.fn(signal => { underlyingSignal = signal; return new Promise(resolve => { finish = resolve; }); });
  const a = new AbortController(), b = new AbortController();
  const first = cache.read(urls[0], load, { signal: a.signal });
  const stopped = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const second = cache.read(urls[0], load, { signal: b.signal });
  await Promise.resolve(); a.abort(); await stopped;
  expect(underlyingSignal.aborted).toBe(false);
  finish('共同实际正文'); expect(await second).toBe('共同实际正文');
  expect(await cache.read(urls[0], load)).toBe('共同实际正文');
  expect(load).toHaveBeenCalledTimes(1);
});

it('全员取消会终止底层请求，迟到结果不入缓存，新请求可正常读取', async () => {
  const cache = createPublicReadCache();
  let finish, activeSignal;
  const load = vi.fn(signal => { activeSignal = signal; return new Promise(resolve => { finish = resolve; }); });
  const controller = new AbortController();
  const pending = cache.read(urls[0], load, { signal: controller.signal });
  const stopped = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve(); controller.abort(); await stopped;
  expect(activeSignal.aborted).toBe(true); finish('旧结果'); await wait(0);
  expect(await cache.read(urls[0], async () => '新结果')).toBe('新结果');
});

it('TTL按源类型并从取数起点计算，敏感地址零缓存，超限正文不保留', async () => {
  expect(publicPageTtl('https://source.example/live')).toBe(15000);
  expect(publicPageTtl('https://source.example/')).toBe(60000);
  expect(publicPageTtl(urls[0])).toBe(900000);
  for (const address of ['http://127.0.0.1/a', 'https://x:y@source.example/a', 'https://source.example/a?token=secret']) expect(publicPageTtl(address)).toBe(0);
  let at = 0;
  const cache = createPublicReadCache({ now: () => at, maxChars: 5, maxRows: 2 });
  const load = vi.fn(async () => '12345');
  await cache.read(urls[0], load, { ttlMs: 10 }); at = 11;
  await cache.read(urls[0], load, { ttlMs: 10 }); expect(load).toHaveBeenCalledTimes(2);
  const big = vi.fn(async () => '123456');
  await cache.read(urls[1], big); await cache.read(urls[1], big); expect(big).toHaveBeenCalledTimes(2);
});

it('共用正文请求的一轮取消后，其他轮重试只消耗自己的预算', async () => {
  vi.useFakeTimers();
  try {
    let fail;
    const get = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockImplementation(async () => new Response('实际原文。'.repeat(100), { headers: { 'content-type': 'text/plain' } }));
    const publicReadCache = createPublicReadCache(), options = { publicReadCache, fetchImpl: get };
    const first = createPageReader(options), second = createPageReader(options);
    const controller = new AbortController(), aBudget = vi.fn(), bBudget = vi.fn();
    const pending = first(urls[0], { signal: controller.signal, consume: aBudget });
    const stopped = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const remaining = second(urls[0], { consume: bBudget });
    await vi.advanceTimersByTimeAsync(1); controller.abort(); await stopped;
    fail(Object.assign(new Error('临时故障'), { status: 503 }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await remaining).toContain('实际原文'); expect(get).toHaveBeenCalledTimes(2);
    expect(aBudget).not.toHaveBeenCalled(); expect(bBudget).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it('账号、连接与任一配置改变都隔离缓存，评测可独立创建实例', async () => {
  const runtime = createLookupRuntime(), cfg = { keys: { custom: 'fixture' }, searchRegion: 'cn' };
  const owner = await runtime('owner', cfg);
  expect(await runtime('owner', structuredClone(cfg))).toBe(owner);
  expect(await runtime('member', cfg)).not.toBe(owner);
  expect(await runtime('owner', { ...cfg, searchRegion: 'global' })).not.toBe(owner);
  expect(await runtime('owner', { ...cfg, keys: { custom: 'changed' } })).not.toBe(owner);
  expect(await createLookupRuntime()('owner', cfg)).not.toBe(owner);
});

it('慢搜索最多2路在途，仍等筛选后的可信命中并取消剩余请求', async () => {
  vi.useFakeTimers();
  try {
    let active = 0, maxActive = 0;
    const engines = Array.from({ length: 5 }, (_, index) => ({ name: `源${index}`, search: async (_query, _n, { signal }) => {
      active++; maxActive = Math.max(maxActive, active);
      await wait(3000); active--;
      if (signal.aborted) throw signal.reason;
      return index === 4 ? [{ title: '目标来源', url: 'https://source.example/verified', snippet: '目标公司业务' }] : [];
    } }));
    const pending = staggeredSearch(engines, '目标公司业务', 1, {}, null, 500);
    await vi.advanceTimersByTimeAsync(10000);
    expect((await pending)[0].url).toBe('https://source.example/verified');
    expect(maxActive).toBe(2);
  } finally { vi.useRealTimers(); }
});

it('来源耗时只保留8个数字，换查询复用并保持500至2500毫秒错峰边界', async () => {
  let at = 0;
  const profiles = new Map(), engine = { name: '测试来源', search: async () => { at += 800; return []; } };
  const guarded = guardedSearchRoute(engine, 'same', () => at, profiles);
  expect(guarded.staggerMs).toBe(1200);
  for (let i = 0; i < 12; i++) await guarded.search('内容不保存', 1);
  expect(guarded.staggerMs).toBe(640); expect(profiles.get('same')).toHaveLength(8);
  expect(guardedSearchRoute(engine, 'same', () => at, profiles).staggerMs).toBe(640);
});

it('查询副本裁历史而不拆工具配对，长原文可按编号取回，当前补充和原历史不变', async () => {
  const history = Array.from({ length: 9 }, (_, index) => [
    { role: 'user', content: `第${index}轮` },
    { role: 'assistant', content: '', toolCalls: [{ id: `c${index}`, name: 'fetch_url', args: { url: urls[0] } }] },
    { role: 'tool', toolCallId: `c${index}`, name: 'fetch_url', content: '中文原始数据'.repeat(1000) },
    { role: 'assistant', content: `第${index}轮回答` }
  ]).flat();
  const messages = [...history, { role: 'user', content: '当前查询，必须使用更正后的600万元' }], before = structuredClone(messages);
  const archive = createTurnArchive();
  const projected = projectLookupMessages(messages, { historyLength: history.length, archive, enabled: true });
  expect(messages).toEqual(before); expect(projected.droppedMessages).toBeGreaterThan(0);
  expect(projected.messages.at(-1).content).toContain('600万元');
  const tools = projected.messages.filter(message => message.role === 'tool');
  for (const message of tools) {
    expect(projected.messages.some(prior => prior.toolCalls?.some(call => call.id === message.toolCallId))).toBe(true);
    expect(message.content.length).toBeLessThan(2000);
    const id = /本轮原文编号 (t\d+)/.exec(message.content)[1];
    const read = JSON.parse(await archive.tool.run({ result_id: id }));
    expect(read.text).toBe('中文原始数据'.repeat(1000));
  }
  expect(measureModelInput({ messages: projected.messages }).inputTextChars).toBeLessThan(measureModelInput({ messages }).inputTextChars / 2);
});

it('未提交的搜索预告不计有效答案；用量未知仍是null，估算不当作计费量', () => {
  let at = 0; const timing = createTaskTiming(0, () => at); timing.start();
  timing.event({ type: 'diagnostic', phase: 'model_start', ...measureModelInput({ system: '规则', messages: [{ role: 'tool', content: '结果' }] }), ...measureModelTokens({ system: '规则', messages: [{ role: 'tool', content: '结果' }] }) });
  at = 10; timing.event({ type: 'text', delta: '正在搜索' });
  at = 20; timing.event({ type: 'tool_start', id: 'one', name: 'web_search' });
  at = 30; timing.event({ type: 'tool_end', id: 'one', name: 'web_search', ok: true });
  at = 40; timing.event({ type: 'diagnostic', phase: 'lookup_evidence_ready', useful: true });
  expect(timing.snapshot().meaningfulAnswerMs).toBeNull();
  at = 50; timing.event({ type: 'text', delta: '有效内容和来源' });
  at = 70; timing.event({ type: 'diagnostic', phase: 'answer_committed' });
  const row = timing.finish();
  expect(row.firstTextMs).toBe(10); expect(row.meaningfulAnswerMs).toBe(50); expect(row.evidenceReadyMs).toBe(40);
  expect(row.estimatedInputTokens.toolResults).toBe(2); expect(row.tokens).toBeNull();
});

it('长网页优先带目标相关的原文中段，跨次投影复用编号，不能将摘录称为全文', async () => {
  const archive = createTurnArchive();
  const text = '网页栏目\n' + '无关栏目。'.repeat(1200) + '\n示例企业有限公司主营农业服务，公开预算600万元，日期2026-11-13。\n' + '其他导航。'.repeat(1200);
  const messages = [{ role: 'tool', name: 'fetch_url', toolCallId: 'same', content: text }];
  const options = { enabled: true, archive, query: '查询示例企业有限公司简介' };
  const first = projectLookupMessages(messages, options).messages[0].content;
  expect(first).toContain('主营农业服务，公开预算600万元');
  expect(first).toContain('需回读');
  const id = /本轮原文编号 (t\d+)/.exec(first)[1];
  expect(projectLookupMessages(messages, options).messages[0].content).toContain(`本轮原文编号 ${id}`);
  const part = JSON.parse(await archive.tool.run({ result_id: id, offset: 5800, max_chars: 2000 }));
  expect(part.text).toContain('示例企业有限公司');
});

it('只有明确日常分工才选轻量模型；固定模型保持原样', () => {
  const cfg = { provider: 'custom', models: { custom: 'main' } }, make = vi.fn(() => ({ adapter: {}, model: 'fast' }));
  expect(createLookupAnswerModel(cfg, make)).toBeNull(); expect(make).not.toHaveBeenCalled();
  const configured = { ...cfg, routing: { enabled: true, provider: 'custom', routes: { chat: 'fast' } } };
  expect(createLookupAnswerModel(configured, make).model).toBe('fast');
  expect(createLookupAnswerModel({ ...configured, pinModel: true }, make)).toBeNull();
  const defaultSelected = { ...cfg, abilities: { chat: { main: { provider: 'custom', model: 'main' } } } };
  expect(createLookupAnswerModel(defaultSelected, value => ({ adapter: {}, model: value.models.custom })).model).toBe('main');
});

it('结构化天气直接预取后只做一次最终回答，不增加推理审稿轮次，实际来源保留', async () => {
  const main = { stream: vi.fn(async () => result('不应调用')) }, fast = { stream: vi.fn(async () => result('南京今天晴，适合出行。来源：https://weather.example.com/nanjing')) };
  const getWeather = vi.fn(async () => '南京今天晴，20℃；来源：https://weather.example.com/nanjing；更新时间2026-11-13 10:00');
  const events = [];
  const answer = await runAgent({ adapter: main, model: 'main', lookupAnswerModel: { adapter: fast, model: 'fast' }, context: { dynamic: '' }, history: [], userText: '南京今天天气', quiet: true, emit: event => events.push(event), tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: { place: { type: 'string' } } }, run: getWeather }] });
  expect(getWeather).toHaveBeenCalledOnce(); expect(main.stream).not.toHaveBeenCalled(); expect(fast.stream).toHaveBeenCalledOnce();
  expect(answer.text).toContain('https://weather.example.com/nanjing'); expect(events.some(event => event.phase === 'answer_committed')).toBe(true);
});

it('已配日常回答模型时，普通搜索直接整理一次，省去草稿再整篇转写；未配保留原路线', async () => {
  const answerText = '线上可以提交申请，具体服务见 https://example.com/guide；当前仅取得搜索线索，尚未读原文。';
  for (const quick of [false, true]) {
    let planned = false;
    const reason = { stream: vi.fn(async () => {
      if (!planned) { planned = true; return { text: '', toolCalls: [{ id: 's', name: 'web_search', args: { query: '服务指南' } }], stop: 'tool_use' }; }
      return result(answerText);
    }) };
    const main = { stream: vi.fn(async () => result('候选草稿，应交由取舍后再展示')) };
    const fast = { stream: vi.fn(async () => result(answerText)) };
    const outcome = await runAgent({ adapter: main, model: 'main', lookupModel: { adapter: reason, model: 'reason' }, lookupAnswerModel: quick ? { adapter: fast, model: 'fast' } : null, context: { dynamic: '' }, history: [], userText: '查询服务指南', quiet: true, emit() {}, tools: [{ name: 'web_search', input_schema: { type: 'object', properties: { query: { type: 'string' } } }, run: async () => '- 服务指南\nhttps://example.com/guide\n可在线提交申请' }] });
    expect(outcome.text).toContain(answerText);
    expect(outcome.text).not.toContain('候选草稿');
    expect(reason.stream.mock.calls.length + main.stream.mock.calls.length + fast.stream.mock.calls.length).toBe(quick ? 2 : 3);
    expect(fast.stream).toHaveBeenCalledTimes(quick ? 1 : 0);
  }
});
