import { afterEach, expect, it, vi } from 'vitest';
import { runAgent } from '../src/agent/agent.js';
import { createLookupDelivery } from '../src/agent/lookupDelivery.js';
import { createLookupClock, LOOKUP_TARGETS, LOOKUP_TOTALS, modelWindow } from '../src/agent/lookup/clock.js';
import { createTaskTiming } from '../shared/taskTiming.js';

const now = Date.parse('2026-10-31T10:00:00+08:00');
const weather = '地点：南京江宁区\n实况（2026-10-31 10:00）：晴，18°C（体感 18°C）\n今天（2026-10-31）：晴，11～22°C\n来源：和风天气（qweather.com）\n本次数据链接（引用来源时给这个，不要只给首页）：https://www.qweather.com/weather/nanjing.html';
const result = text => ({ text, toolCalls: [], stop: 'end_turn' });
const tool = (name, output) => ({ name, input_schema: { type: 'object', properties: {} }, run: async () => output });
const input = { userText: '南京江宁区今天天气', model: 'fixture', history: [], context: { dynamic: '' }, tools: [tool('get_weather', weather)], now: () => now, emit() {} };
afterEach(() => { vi.useRealTimers(); });

it('目标只作统计，天气/比分/行情硬期限能容纳取数和常见首字等待', () => {
  expect(LOOKUP_TARGETS).toEqual({ weather: 5000, sports_live: 10000, news: 20000, sports_news: 20000, market: 15000, general: 45000 });
  expect(LOOKUP_TOTALS).toEqual({ weather: 40000, sports_live: 40000, news: 45000, sports_news: 45000, market: 35000, general: 60000 });
});

it('真实调度天气首字9秒、17秒写完，交正常回答且不误报部分完成', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const events = [];
  const adapter = { stream: vi.fn(async options => {
    await new Promise(resolve => setTimeout(resolve, 9000));
    options.onText('南京江宁区今天晴，11～22°C。');
    await new Promise(resolve => setTimeout(resolve, 4000));
    options.onText('实况18°C。');
    await new Promise(resolve => setTimeout(resolve, 4000));
    options.onText('来源：和风天气 https://www.qweather.com/weather/nanjing.html');
    return result('');
  }) };
  const pending = runAgent({ ...input, adapter, emit: e => events.push(e) });
  await vi.advanceTimersByTimeAsync(17001);
  const value = await pending;
  expect(value.text).toContain('南京江宁区今天晴');
  expect(value.text).not.toMatch(/部分完成|先给你本轮实际取得的数据|再查一会儿/);
  expect(value.review.outcome).not.toBe('partial');
  expect(adapter.stream).toHaveBeenCalledTimes(1);
  expect(events.some(e => e.phase === 'lookup_budget' && e.targetMs === 5000 && e.hardLimitMs === 40000)).toBe(true);
});

it('天气模型20秒仍不出字：15秒后整理完整天气兜底，取消迟到回写', async () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  let callback, modelSignal; const events = [];
  const adapter = { stream: vi.fn(options => { callback = options.onText; modelSignal = options.signal; return new Promise(() => {}); }) };
  const pending = runAgent({ ...input, adapter, emit: e => events.push(e) });
  await vi.advanceTimersByTimeAsync(20000);
  const value = await pending;
  expect(value.text).toContain('南京江宁区，今天晴，11～22°C');
  expect(value.text).toContain('和风天气'); expect(value.text).toContain('2026-10-31 10:00');
  expect(value.text).not.toMatch(/部分完成|先给你本轮实际取得的数据|再查一会儿/);
  expect(value.review.outcome).not.toBe('partial'); expect(modelSignal.aborted).toBe(true);
  const before = events.length; callback('迟到文字'); expect(events).toHaveLength(before);
  expect(adapter.stream).toHaveBeenCalledTimes(1);
});

it.each(['sports_live', 'news'])('%s模型9秒首字不会被取数期限截断，连续文字保留宽限', async kind => {
  vi.useFakeTimers();
  const clock = createLookupClock({ totalMs: LOOKUP_TOTALS[kind], phased: true });
  await vi.advanceTimersByTimeAsync(kind === 'news' ? 29000 : 8000);
  const controller = new AbortController(); const window = modelWindow(clock, false, controller);
  const pending = window.race(async () => {
    await new Promise(resolve => setTimeout(resolve, 9000)); window.output(); clock.wrote();
    for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 4000)); clock.wrote(); }
    return '正常回答';
  });
  await vi.advanceTimersByTimeAsync(25000);
  expect(await pending).toBe('正常回答'); expect(controller.signal.aborted).toBe(false); window.dispose();
});

it.each(['sports_live', 'news'])('%s无首字请求15秒有界退出，不能无限等待', async kind => {
  vi.useFakeTimers();
  const clock = createLookupClock({ totalMs: LOOKUP_TOTALS[kind], phased: true });
  const controller = new AbortController(); const window = modelWindow(clock, false, controller);
  const pending = expect(window.race(new Promise(() => {}))).rejects.toMatchObject({ code: 'LOOKUP_ANSWER_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(15000); await pending; expect(controller.signal.aborted).toBe(true); window.dispose();
});

it('缺来源、过期天气、多日要求和特殊需求不能用简单天气冒充完整交付', () => {
  for (const [request, data] of [
    ['南京今天天气', weather.replace('来源：和风天气（qweather.com）', '')],
    ['南京今天天气', weather.replaceAll('2026-10-31', '2026-10-30')],
    ['南京未来七天天气', weather], ['南京空气质量', weather], ['南京明天天气', weather]
  ]) {
    const delivery = createLookupDelivery(request, () => now);
    delivery.record({ name: 'get_weather', ok: true, output: data });
    expect(delivery.delivery().complete).toBe(false);
  }
});

it('速度统计未完成时不判达标，完成超目标不等于任务失败', () => {
  let t = 0; const timing = createTaskTiming(0, () => t); timing.start();
  timing.event({ type: 'diagnostic', phase: 'lookup_budget', kind: 'weather', targetMs: 5000, hardLimitMs: 30000 });
  t = 9000; timing.event({ type: 'text', delta: '南京晴' });
  expect(timing.snapshot().lookup.targetMet).toBeNull();
  t = 17000; expect(timing.finish()).toMatchObject({ firstTextMs: 9000, lookup: { targetMs: 5000, elapsedMs: 17000, targetMet: false, hardLimitMs: 30000 } });
});

it.each([
  ['足彩赛程', 'get_sports_scores', '足球赛程（北京时间）\n示例联赛：甲队 1-0 乙队，进行中。\n来源：https://example.com/scores', '示例联赛甲队1-0乙队，进行中。来源：https://example.com/scores'],
  ['今日新闻', 'get_today_news', JSON.stringify({ kind: 'today_news', date: '2026-10-31', items: [{ title: '示例城市开放新公共图书馆', summary: '新公共图书馆今日开放。', url: 'https://example.com/news', source: '测试媒体', publishedAt: '2026-10-31T09:00:00+08:00' }] }), '2026年10月31日，示例城市开放新公共图书馆。来源：https://example.com/news']
])('%s真实调度：9秒首字交模型回答，20秒无首字交已有可读内容', async (userText, name, output, answer) => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const fixture = { ...input, userText, tools: [tool(name, output)] };
  const normal = runAgent({ ...fixture, adapter: { stream: async options => { await new Promise(resolve => setTimeout(resolve, 9000)); options.onText(answer); return result(''); } } });
  await vi.advanceTimersByTimeAsync(9001);
  expect((await normal).text).toContain(answer);
  const events = []; let late;
  const stalled = runAgent({ ...fixture, emit: e => events.push(e), adapter: { stream: options => { late = options.onText; return new Promise(() => {}); } } });
  await vi.advanceTimersByTimeAsync(20000);
  const fallback = await stalled;
  expect(fallback.text).toContain(name === 'get_sports_scores' ? '甲队' : '图书馆');
  expect(fallback.text).toContain('https://example.com/');
  expect(fallback.text).not.toMatch(/先给你本轮实际取得的数据|"items"|"kind"/);
  const count = events.length; late('迟到'); expect(events).toHaveLength(count);
});

it('完整天气兜底也不能吞掉关键计算/来源校验失败', async () => {
  const { withLookupDeadline } = await import('../src/agent/lookup/turn.js');
  vi.useFakeTimers();
  const pending = withLookupDeadline({ userText: '南京天气' }, async ({ lookupControl }) => {
    lookupControl.delivery = () => ({ text: '南京今天晴，11～22°C。', complete: true });
    lookupControl.review = () => ({ request: '南京天气', calculation: 'failed', retrievalReceipts: 1 });
    return new Promise(() => {});
  }, { profiles: true });
  await vi.advanceTimersByTimeAsync(40000);
  const answer = await pending;
  expect(answer.review.outcome).toBe('partial'); expect(answer.text).toContain('关键数值校验失败');
});

it('新闻正文因审查缓冲但仍连续输出，也保留30秒宽限且不无限续期', async () => {
  vi.useFakeTimers();
  const clock = createLookupClock({ totalMs: 45000, phased: true });
  const controller = new AbortController(); const frame = modelWindow(clock, false, controller);
  const pending = expect(frame.race(new Promise(() => {}))).rejects.toMatchObject({ code: 'LOOKUP_ANSWER_TIMEOUT' });
  for (let i = 0; i < 14; i++) { frame.output(); await vi.advanceTimersByTimeAsync(5000); expect(controller.signal.aborted).toBe(false); }
  frame.output(); await vi.advanceTimersByTimeAsync(5001);
  await pending; expect(controller.signal.aborted).toBe(true); frame.dispose();
});

it('天气准备1秒、取数6秒、模型首字9秒：不再被4秒预取或5秒取数窗口截断', async () => {
  const { withLookupDeadline } = await import('../src/agent/lookup/turn.js');
  const { runLookup } = await import('../src/agent/lookup/runner.js');
  const { lookupIntent } = await import('../src/agent/lookup/intent.js');
  const { createRetrievalBudget } = await import('../src/agent/lookup/clock.js');
  const { runLookupOperation } = await import('../src/agent/lookup/operations.js');
  vi.useFakeTimers(); vi.setSystemTime(now);
  const events = [];
  const pending = withLookupDeadline({ userText: input.userText, emit: e => events.push(e) }, async options => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const retrieval = createRetrievalBudget(input.userText, { clock: options.lookupControl });
    const found = await runLookup(lookupIntent(input.userText), { text: input.userText, getTool: () => tool('get_weather', weather), signal: options.signal, clock: options.lookupControl,
      execute: async (_, signal) => {
        retrieval.begin();
        const output = await runLookupOperation({ name: 'get_weather', run: async () => { await new Promise(resolve => setTimeout(resolve, 6000)); return weather; } }, {}, { retrieval, signal });
        return [{ ok: true, output }];
      } });
    expect(found.output).toBe(weather);
    const frame = modelWindow(options.lookupControl, false, new AbortController());
    try {
      return await frame.race(async () => { await new Promise(resolve => setTimeout(resolve, 9000)); frame.output(); return result('南京今天晴，11～22°C。'); });
    } finally { frame.dispose(); }
  }, { profiles: true });
  await vi.advanceTimersByTimeAsync(16001);
  expect((await pending).text).toBe('南京今天晴，11～22°C。');
});
