import { it, expect, vi, afterEach } from 'vitest';
import { createLookupService, memoryLookupStorage } from '../src/agent/lookup/service.js';
import { createTodayNewsTool } from '../src/agent/todayNews.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { createLookupDelivery } from '../src/agent/lookupDelivery.js';
import { runAgent } from '../src/agent/agent.js';
import { mergeConfig } from '../server/serverMode.mjs';
import { newsLookupNote } from '../src/agent/newsIntent.js';
import { reusesPreSearch } from '../src/agent/preSearch.js';
import { lookupIntent } from '../src/agent/lookup/intent.js';
const now = Date.parse('2026-10-31T08:00:00Z');
const row = (category, i) => `<li><div class="dd_lm">[${category}]</div><div class="dd_bt"><a href="https://www.chinanews.com.cn/ty/2026/10-31/${category}${i}.shtml">虚构${category}报道：公共服务与训练设施第${i}项开放</a></div><div class="dd_time">10-31 09:30</div></li>`;
function fixture() {
  const get = vi.fn(async url => {
    if (url.includes('chinanews.com.cn')) return new Response(['国际', '体育', '财经', '科技', '国内'].flatMap(c => Array.from({ length: 6 }, (_, i) => row(c, i))).join(''));
    if (url === 'https://news.zhibo8.com/zuqiu/') return new Response(Array.from({ length: 5 }, (_, i) => `<a href="https://news.zhibo8.com/zuqiu/2026-10-31/news${i}.htm">虚构球场报道：训练设施开放预约第${i}项</a>`).join(''));
    if (url.includes('news.zhibo8.com')) return new Response('<h1>虚构足球报道：公共训练场开放预约</h1><span ms-controller="title_controller">2026-10-30 20:00:00</span><div id="signals"><p>虚构训练新闻正文，面向公众提供预约，不是比分。</p></div>');
    return new Response('', { status: 403 });
  });
  const service = createLookupService({ storage: memoryLookupStorage(), get, now: () => now });
  const tool = createTodayNewsTool({ lookup: service.options('cn'), fetchImpl: get, now: () => now });
  return { get, service, tool };
}
afterEach(() => vi.restoreAllMocks());
it('最近新闻说明不冲突；相同默认参数复用预查，改时间范围不能误用上一份', () => {
  expect(newsLookupNote('最近新闻')).toContain('最近24小时筛选');
  expect(newsLookupNote('今日新闻')).toContain('当天筛选');
  expect(lookupIntent('今日新闻，不要写时间').kind).toBe('news');
  expect(lookupIntent('体育资讯，别写比分')).toMatchObject({ kind: 'sports_news', params: { includeScores: false } });
  const found = { tool: 'get_today_news', args: { limit: 12, categories: ['体育'], date_mode: 'recent24h' } };
  expect(reusesPreSearch({ name: 'get_today_news', args: { categories: ['体育'] } }, found)).toBe(true);
  expect(reusesPreSearch({ name: 'get_today_news', args: {} }, found)).toBe(true);
  expect(reusesPreSearch({ name: 'get_today_news', args: { categories: ['体育'], date_mode: 'today' } }, found)).toBe(false);
});
it('真实新闻工具走已实测国内源，体育与国际均至少5条；冷启动仅一海外探测且总读取≤8', async () => {
  const { get, tool, service } = fixture();
  const budget = createRetrievalBudget('体育资讯');
  const sports = JSON.parse(await tool.run({}, { requestText: '体育资讯', retrieval: budget }));
  expect(sports.queryKind).toBe('sports_news');
  expect(sports.items.length).toBeGreaterThanOrEqual(5);
  expect(sports.items.some(i => i.source === '直播吧新闻' && i.verified === 'page')).toBe(true);
  expect(sports.items.every(i => i.category === '体育')).toBe(true);
  expect(get.mock.calls.filter(([u]) => !u.includes('chinanews.com.cn') && !u.includes('zhibo8.com'))).toHaveLength(1);
  expect(get.mock.calls.some(([u]) => u.includes('sina'))).toBe(false);
  expect(budget.resources.read).toBeLessThanOrEqual(8);
  const delivery = createLookupDelivery('体育资讯', () => now);
  delivery.record({ name: 'get_today_news', ok: true, output: JSON.stringify(sports) });
  expect(delivery.text()).toContain('2026-10-30');
  const daily = JSON.parse(await tool.run({ categories: ['体育'], date_mode: 'recent24h' }, { requestText: '今天体育资讯' }));
  expect(daily.range.mode).toBe('today');
  expect(daily.items.every(i => i.publishedAt.startsWith('2026-10-31'))).toBe(true);
  const world = JSON.parse(await tool.run({ categories: ['国际'] }, { requestText: '国际新闻' }));
  expect(world.items.length).toBeGreaterThanOrEqual(5);
  expect(world.items.every(i => i.category === '国际')).toBe(true);
  expect((await service.health.get('cn_cns_sports')).samples.length).toBeGreaterThan(0);
});
it('原runAgent先取国内新闻再一轮答复；历史比分不污染体育，抱怨和各三条续问口径保留', async () => {
  const { get, tool } = fixture();
  const scores = vi.fn();
  const adapter = { stream: vi.fn(async input => {
    expect(input.messages.at(-1).content).toContain('系统已先查get_today_news');
    expect(input.messages.at(-1).content).toContain('虚构体育报道');
    expect(input.tools.some(t => t.name === 'get_sports_scores')).toBe(false);
    return { text: '', toolCalls: [], stop: 'end_turn' };
  }) };
  const value = await runAgent({ adapter, model: 'fixture', context: { dynamic: '' }, history: [{ role: 'user', content: '足彩赛程' }], userText: '体育资讯', tools: [tool, { name: 'get_sports_scores', input_schema: { type: 'object', properties: {} }, run: scores }], quiet: true, emit() {}, now: () => now });
  expect(value.text).toContain('中新网体育'); expect(scores).not.toHaveBeenCalled();
  expect(adapter.stream).toHaveBeenCalledTimes(1);
  get.mockClear();
  await runAgent({ adapter: { stream: async () => ({ text: '先说明进度。', toolCalls: [], stop: 'end_turn' }) }, model: 'fixture', context: { dynamic: '' }, history: [], userText: '体育资讯怎么这么慢', tools: [tool], quiet: true, emit() {} });
  expect(get).not.toHaveBeenCalled();
  const followup = { stream: vi.fn(async input => {
    expect(input.messages.at(-1).content).toContain('虚构体育报道');
    return { text: '', toolCalls: [], stop: 'end_turn' };
  }) };
  const next = await runAgent({ adapter: followup, model: 'fixture', context: { dynamic: '' }, history: [{ role: 'user', content: '体育资讯' }], userText: '各三条', tools: [tool], quiet: true, emit() {}, now: () => now });
  expect(next.text).toContain('虚构体育报道');
});
it('来源健康本机/服务器/评测分别注入，配置只允许三种地区，不覆盖密钥或原设置', async () => {
  const a = fixture().service, b = fixture().service;
  for (let i = 0; i < 3; i++) await a.health.record('cn_cns_sports', { state: 'failed' });
  expect((await a.health.get('cn_cns_sports')).cooling).toBe(true);
  expect((await b.health.get('cn_cns_sports')).samples).toEqual([]);
  expect(mergeConfig({ keys: { qwen: 'secret' }, lookupRegion: 'auto' }, { lookupRegion: 'cn' })).toMatchObject({ lookupRegion: 'cn', keys: { qwen: 'secret' } });
  expect(() => mergeConfig({}, { lookupRegion: 'https://invalid.example' })).toThrow('查询地区');
});
it('主动检查才读取网络，状态查看不联网；仅固定注册来源，一次检查不自动启用新浪', async () => {
  const { service, get } = fixture();
  const before = await service.status('cn');
  expect(get).not.toHaveBeenCalled();
  expect(before.sources.find(s => s.id === 'cn_sina_sports').validation).toBe('not_selected');
  const after = await service.probe('cn');
  expect(get.mock.calls.length).toBe(before.sources.length);
  expect(after.sources.find(s => s.id === 'cn_sina_sports').validation).toBe('not_selected');
  const ctrl = new AbortController(); ctrl.abort(new Error('停止'));
  get.mockClear();
  await expect(service.probe('cn', { signal: ctrl.signal })).rejects.toThrow('停止');
  expect(get).not.toHaveBeenCalled();
});
