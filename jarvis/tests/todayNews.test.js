import { it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { NEWS_SOURCES, parseNewsSource } from '../src/agent/newsSources.js';
import { createTodayNewsTool } from '../src/agent/todayNews.js';
import { todayNewsIntent, lookupComplaint } from '../src/agent/newsIntent.js';
import { createLookupDelivery } from '../src/agent/lookupDelivery.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { scheduledPrompt } from '../src/agent/scheduledRun.js';
const now = Date.parse('2026-10-30T14:00:00Z');
const fixtures = Object.fromEntries(NEWS_SOURCES.map(s => [s.id, fs.readFileSync(new URL('./fixtures/news/' + s.id + '.html', import.meta.url), 'utf8')]));
afterEach(() => vi.useRealTimers());
it('三种真实版式的虚构样例提取具体内容/栏目/日期；旧闻、未来时间、脚本内容不放行', () => {
  const cnfin = parseNewsSource(fixtures.cnfin, NEWS_SOURCES[0], now);
  expect(cnfin).toHaveLength(1); expect(cnfin[0].summary).toContain('三项便民服务');
  expect(parseNewsSource(fixtures.cnr, NEWS_SOURCES[1], now)[0].title).not.toContain('具体时间');
  expect(parseNewsSource(fixtures.cns, NEWS_SOURCES[2], now).map(i => i.category)).toEqual(['国际', '财经']);
  expect(parseNewsSource(fixtures.cnfin.replace('09:15:00', '23:59:00'), NEWS_SOURCES[0], now)).toEqual([]);
  expect(parseNewsSource(fixtures.cnfin, NEWS_SOURCES[0], Date.parse('2026-10-30T16:00:00Z'))).toEqual([]);
  expect(parseNewsSource('<script>' + fixtures.cnfin + '</script>', NEWS_SOURCES[0], now)).toEqual([]);
});
it('实际工具并发3路、逐请求先扣预算；一源卡住8秒后返回其他源内容', async () => {
  vi.useFakeTimers(); const starts = [], consume = vi.fn();
  const get = vi.fn(async (url, { signal }) => {
    expect(consume.mock.calls.length).toBeGreaterThan(starts.length); starts.push(url);
    if (url === NEWS_SOURCES[1].url) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    return new Response(fixtures[NEWS_SOURCES.find(s => s.url === url).id]);
  });
  const pending = createTodayNewsTool({ fetchImpl: get, now: () => now }).run({}, { retrieval: { consume } });
  await vi.advanceTimersByTimeAsync(1); expect(starts).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(8000); const result = JSON.parse(await pending);
  expect(result.items.length).toBe(3); expect(result.sources[1].error).toContain('超时');
  expect(result.items.every(i => i.verification === 'index_only')).toBe(true);
});
it('全部失败仍明确给每个来源的原因；不捏造任何新闻', async () => {
  const result = JSON.parse(await createTodayNewsTool({ fetchImpl: async () => new Response('', { status: 403 }), now: () => now }).run());
  expect(result.items).toEqual([]); expect(result.sources.every(s => /403/.test(s.error))).toBe(true);
  const delivery = createLookupDelivery('今日新闻', () => now);
  delivery.record({ name: 'get_today_news', ok: true, output: JSON.stringify(result) });
  expect(delivery.text()).toContain('新华财经'); expect(delivery.text()).toContain('403');
});
it('用户停止及预算用完继续上抛，不伪装成来源失败', async () => {
  const ctrl = new AbortController(); ctrl.abort(Object.assign(new Error('已停止'), { name: 'AbortError' }));
  const get = vi.fn(); await expect(createTodayNewsTool({ fetchImpl: get }).run({}, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(get).not.toHaveBeenCalled();
  const error = Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' });
  await expect(createTodayNewsTool({ fetchImpl: get }).run({}, { retrieval: { consume: () => { throw error; } } })).rejects.toBe(error);
});
it('新闻简报/定时任务识别；抱怨、历史日期不能变成今日检索', () => {
  for (const s of ['今日新闻', '今天重点新闻', '每日重点新闻', '新闻简报', scheduledPrompt({ title: '每日重点新闻', prompt: '今日新闻，打开原文核实' }, '2026/10/30 09:00')]) expect(todayNewsIntent(s), s).toBe(true);
  for (const s of ['发个新闻那么慢', '你在干嘛', '谁让你这么做的', '昨天新闻', '2025年10月30日新闻']) expect(todayNewsIntent(s), s).toBe(false);
  for (const s of ['发个新闻那么慢', '新闻怎么这么慢', '你在干嘛', '谁让你这么做的']) expect(lookupComplaint(s), s).toBe(true);
  for (const s of ['再查今天新闻', '查一下为什么网络慢', '你在干嘛，顺便查今天新闻']) expect(lookupComplaint(s), s).toBe(false);
});
it('新闻预算8次读取，新一轮预算独立；普通读10/搜12仍共用45秒，严格不变', () => {
  const first = createRetrievalBudget('今日新闻'); for (let i=0;i<8;i++) first.consume('read'); expect(() => first.consume('read')).toThrow('8次');
  const next = createRetrievalBudget('今日新闻'); expect(() => next.consume('read')).not.toThrow();
  const ordinary = createRetrievalBudget('查询资料'); for(let i=0;i<10;i++) ordinary.consume('read'); expect(() => ordinary.consume('read')).toThrow('10次');
  const search = createRetrievalBudget('查询资料'); for(let i=0;i<12;i++) search.consume('search'); expect(() => search.consume('search')).toThrow('12次');
  const strict = createRetrievalBudget('逐项核验'); for(let i=0;i<16;i++) strict.consume('read'); expect(() => strict.consume('read')).toThrow('16次');
});
it('今日条目保留具体摘要和时间，未知日期搜索摘要不混入，负面约束仍有效', () => {
  const delivery = createLookupDelivery('今日新闻', () => now);
  delivery.record({ name:'get_today_news', ok:true, output:JSON.stringify({kind:'today_news',date:'2026-10-30',items:parseNewsSource(fixtures.cnfin,NEWS_SOURCES[0],now)}) });
  expect(delivery.substitute('没有可靠结果')).toContain('三项便民服务'); expect(delivery.text()).toContain('待核实');
  const unknown = createLookupDelivery('今日新闻', () => now); unknown.record({name:'web_search',ok:true,output:'- 旧闻候选\nhttps://example.com/old\n旧内容'}); expect(unknown.text()).toBe('');
  const noTime = createLookupDelivery('今日新闻，不要时间', () => now); noTime.record({name:'get_today_news',ok:true,output:JSON.stringify({kind:'today_news',date:'2026-10-30',items:parseNewsSource(fixtures.cnfin,NEWS_SOURCES[0],now)})}); expect(noTime.text()).toBe('');
});
it('栏目轮流保留，体育娱乐不能误标国内，科技按来源明确栏目识别',async()=>{
  const chunk=(label,path,title)=>`<li><div class="dd_lm">[${label}]</div><div class="dd_bt"><a href="${path}/2026/10-30/test.shtml">${title}</a></div><div class="dd_time">10-30 09:30</div></li>`;
  const list=parseNewsSource(chunk('科技','/business','虚构科技：公共实验平台开放预约')+chunk('体育','/ty','虚构体育：校园联赛开始进行报名'),NEWS_SOURCES[2],now);
  expect(list.map(i=>i.category)).toEqual(['科技','其他']);
});
it('明确原文核实保留逐项3分钟/16读，技术开发/取消新闻不误发请求',async()=>{
  const {isQuickLookup}=await import('../src/agent/lookupDeadline.js');
  const text='今日新闻，原文核实';expect(isQuickLookup(text)).toBe(false);let tick=0;const b=createRetrievalBudget(text,{now:()=>tick});b.begin();for(let i=0;i<16;i++)b.consume('read');tick=179999;expect(b.reason).toBe('');tick++;expect(b.reason).toContain('时间预算');
  for(const text of ['修复今日新闻功能','开发今日新闻工具','不要今日新闻','取消查今日新闻','今日新闻怎么这么慢'])expect(todayNewsIntent(text),text).toBe(false);
});
