import { expect, it, vi } from 'vitest';
import { weatherPlace, lookupPlan } from '../src/agent/lookup/plan.js';
import { lookupIntent } from '../src/agent/lookup/intent.js';
import { getWeather } from '../src/agent/weather.js';
import { createLookupDelivery } from '../src/agent/lookupDelivery.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { dialoguePolicy } from '../src/agent/dialoguePolicy.js';
import { toolFailureScope } from '../src/agent/toolFailureScope.js';
import { runAgent } from '../src/agent/agent.js';

it.each(['帮我查查天气', '请再帮我查查明天天气', '再试试天气', '请问今天天气', '这里的天气'])('口语 %s 没有明确城市就不启动预取', text => {
  expect(weatherPlace(text)).toBeNull();
  expect(lookupPlan(lookupIntent(text), { text, getTool: () => ({}) })).toBeNull();
});
it.each(['帮我查查南京明天天气', '请再查一下南京的天气', '明天南京天气'])('口语 %s 保留用户明确城市', text => {
  expect(weatherPlace(text)).toBe('南京');
});
it('模型手动调用也不能将查查送去地理编码；明确海外城市仍允许', async () => {
  const get = vi.fn();
  await expect(getWeather('查查', { get })).rejects.toMatchObject({ code: 'WEATHER_LOCATION_REQUIRED' });
  expect(get).not.toHaveBeenCalled();
  expect(weatherPlace('秘鲁查查波亚斯天气')).toBe('秘鲁查查波亚斯');
  expect(weatherPlace('查干湖天气')).toBe('查干湖');
  expect(weatherPlace('继续')).toBeNull();
});
it('天气追问只继承紧邻用户明确的城市，不继承助手猜测或跨新话题找旧地点', () => {
  const history = [{ role: 'user', content: '南京今天天气' }, { role: 'assistant', content: '地点：南京' }];
  const text = '明天呢？';
  expect(lookupPlan(lookupIntent(text, { history }), { text, getTool: () => ({}) })?.args.place).toBe('南京');
  expect(lookupIntent('再查下天气', { history }).params.city).toBe('南京');
  expect(lookupIntent('杭州天气', { history }).params.city).toBeUndefined();
  expect(weatherPlace('杭州天气')).toBe('杭州');
  expect(weatherPlace('杭州天气', { city: '南京' })).toBe('杭州');
  expect(lookupIntent(text, { history: [{ role: 'user', content: '帮我查查天气' }, { role: 'assistant', content: '按南京查了' }] }).params.city).toBeUndefined();
  expect(lookupIntent(text, { history: [...history, { role: 'user', content: '比较API价格' }] }).params.city).toBeUndefined();
});

const quote = '报价：USD/人民币6.6654\n来源：ExchangeRate-API https://open.er-api.com/v6/latest/USD';
it('比较价格取得辅助汇率时，正常回执、JSON和恢复回执都不能抢占最终回答', () => {
  const delivery = createLookupDelivery('对比官方便宜多少');
  delivery.record({ name: 'get_market_quote', ok: true, output: quote });
  delivery.record({ name: 'fetch_json', ok: true, output: JSON.stringify({ kind: 'public_json', url: 'https://open.er-api.com/v6/latest/USD', data: { CNY: 6.6654 } }) });
  delivery.record({ name: 'get_market_quote', ok: true, output: quote, lookupRecovery: { state: 'recovered', tool: 'web_search', output: quote } });
  expect(delivery.hasResults).toBe(false);
  expect(delivery.text()).toBe('');
  delivery.record({ name: 'web_search', ok: true, output: JSON.stringify([{ title: '美元汇率', url: 'https://example.com/fx', snippet: 'USD/人民币6.6654' }]) });
  expect(delivery.delivery()).toMatchObject({ complete: false });
  expect(delivery.text()).toContain('价格比较尚未完成');
  expect(delivery.text()).not.toContain('6.6654');
  const actual = createLookupDelivery('美元汇率');
  actual.record({ name: 'get_market_quote', ok: true, output: quote });
  expect(actual.text()).toContain('6.6654');
  const news = createLookupDelivery('体育资讯');
  news.record({ name: 'get_sports_scores', ok: true, output: '比赛比分2比1' });
  expect(news.hasResults).toBe(false);
});
it('价格问题要核对原目标，缺少价目时允许明确缺项，不能只答汇率', () => {
  const review = createExecutionReview('对比官方便宜多少');
  expect(review.guardsAnswer()).toBe(true);
  expect(review.checkAnswer(quote).join()).toContain('价格比较');
  expect(review.checkAnswer('尚未核实两边同一模型的输入、输出和缓存单价，无法判断便宜多少；请补充价目或允许查询。')).toEqual([]);
  expect(dialoguePolicy('对比官方便宜多少')).toContain('同一缓存命中比例');
});
it('真实调度收到辅助汇率后，拒绝离题草稿并要求一次有针对性的重写', async () => {
  let calls = 0;
  const corrected = '暂时不能确认比官方便宜多少：还缺官方和OpenRouter同一模型的输入、缓存、输出单价；需要按相同用量比较。';
  const adapter = { stream: async options => {
    calls++;
    if (calls === 1) return { text: '', toolCalls: [{ id: 'fx', name: 'get_market_quote', args: { target: 'USD' } }], stop: 'tool_use' };
    const text = calls === 2 ? quote : corrected;
    options.onText(text);
    return { text, toolCalls: [], stop: 'end_turn' };
  } };
  const result = await runAgent({ userText: '对比官方便宜多少', history: [], context: { dynamic: '' }, model: 'fixture', adapter, emit() {}, tools: [{ name: 'get_market_quote', input_schema: { type: 'object', properties: { target: { type: 'string' } } }, run: async () => quote }] });
  expect(result.text).toContain('缺官方和OpenRouter');
  expect(result.text).not.toContain('6.6654');
  expect(calls).toBe(3);
});
it('白名单和冷却解释严格限定当前工具，不由公共JSON失败推断天气整体不可用', () => {
  expect(toolFailureScope('fetch_json', { code: 'PUBLIC_JSON_BLOCKED' })).toContain('尚未据此验证该接口能否连通');
  expect(toolFailureScope('fetch_json', { code: 'LOOKUP_SOURCE_COOLING' })).toContain('不是域名白名单拒绝');
  expect(toolFailureScope('get_weather', { code: 'TimeoutError' })).toBe('');
  expect(toolFailureScope('fetch_url', { code: 'PUBLIC_JSON_BLOCKED' })).toBe('');
});
