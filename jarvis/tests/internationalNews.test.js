import { it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { NEWS_SOURCES } from '../src/agent/newsSources.js';
import { internationalNewsFeeds } from '../src/agent/newsFeeds.js';
import { parseNewsRss, verifiedReutersReprint, newsCoverage } from '../src/agent/newsRss.js';
import { createTodayNewsTool } from '../src/agent/todayNews.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';
import { runAgent } from '../src/agent/agent.js';
const now = Date.parse('2026-10-30T14:00:00Z');
const fixture = id => fs.readFileSync(new URL('./fixtures/news/' + id, import.meta.url), 'utf8');
const bbc = internationalNewsFeeds()[0], reuters = internationalNewsFeeds()[1];
const article = (url, author = 'Reuters', date = '2026-10-30T09:00:00+08:00') => `<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'NewsArticle', mainEntityOfPage: url, datePublished: date }] })}</script><div class="source__block"><div class="source source--with-label">Source: ${author}/fs</div></div>`;
function transport({ failBbc = false, slowArticle = false } = {}) {
  return vi.fn(async (url, init = {}) => {
    const domestic = NEWS_SOURCES.find(s => s.url === url);
    if (domestic) return new Response(fixture(domestic.id + '.html'));
    if (url.includes('feeds.bbci.co.uk')) return new Response(failBbc ? '' : fixture('bbc.xml'), { status: failBbc ? 403 : 200 });
    if (url.includes('/api/v1/rss-outbound-feed')) return new Response(fixture('reuters-cna.xml'));
    if (url.includes('/world/fixture-')) {
      if (slowArticle) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
      return new Response(article(url, url.endsWith('3') ? 'Reuters' : 'AFP'));
    }
    if (url.includes('theguardian.com')) return new Response(fixture('bbc.xml').replaceAll('www.bbc.com', 'www.theguardian.com'));
    if (url.includes('aljazeera.com')) return new Response(fixture('bbc.xml').replaceAll('www.bbc.com', 'www.aljazeera.com'));
    throw Error('没有定义的测试上游');
  });
}
afterEach(() => vi.useRealTimers());
it('官方RSS按真实时区转北京时间，拒绝缺日期/缺时区/旧闻/未来/非来源域名和DTD', () => {
  const xml = fixture('bbc.xml');
  expect(parseNewsRss(xml, bbc, now)[0]).toMatchObject({ source: 'BBC', publishedAt: '2026-10-30T09:00:00+08:00', verification: 'index_only' });
  expect(parseNewsRss(xml.replace('Fri, 30 Oct 2026 01:00:00 GMT', 'Thu, 29 Oct 2026 18:00:00 GMT'), bbc, now)[0].publishedAt).toBe('2026-10-30T02:00:00+08:00');
  for (const stamp of ['', '2026-10-30 09:00:00', 'Thu, 29 Oct 2026 01:00:00 GMT', 'Fri, 30 Oct 2026 23:00:00 GMT']) expect(parseNewsRss(xml.replace('Fri, 30 Oct 2026 01:00:00 GMT', stamp), bbc, now)).toEqual([]);
  expect(parseNewsRss(xml.replace('www.bbc.com', '127.0.0.1'), bbc, now)).toEqual([]);
  expect(parseNewsRss('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + xml, bbc, now)).toEqual([]);
});
it('路透只认实际转载页来源栏及匹配URL/当日元数据，照片或提及Reuters不冒充署名', () => {
  const item = parseNewsRss(fixture('reuters-cna.xml'), reuters, now)[0];
  expect(verifiedReutersReprint(article(item.url), item, now)).toMatchObject({ sourceFamily: 'reuters', publisher: 'CNA', attributionVerified: true, timeBasis: 'CNA转载页发布时间' });
  expect(verifiedReutersReprint(article(item.url, 'AFP') + '<img alt="Reuters"><p>Reuters said</p>', item, now)).toBeNull();
  expect(verifiedReutersReprint(article(item.url, 'AFP') + '<script>const fake="<div class=\'source source--with-label\'>Source: Reuters/fs</div>";</script>', item, now)).toBeNull();
  expect(verifiedReutersReprint(article('https://www.channelnewsasia.com/world/other'), item, now)).toBeNull();
  expect(verifiedReutersReprint(article(item.url, 'Reuters', '2026-10-29T09:00:00+08:00'), item, now)).toBeNull();
});
it('实际默认工具并发原国内+B​​BC+真实路透转载核对，最多8读且不同稿源不会被称为已交叉核实', async () => {
  const get = transport(); const retrieval = createRetrievalBudget('今日新闻');
  const result = JSON.parse(await createTodayNewsTool({ fetchImpl: get, now: () => now }).run({}, { retrieval }));
  expect(get).toHaveBeenCalledTimes(8); expect(retrieval.resources.read).toBe(8);
  expect(result.items.some(i => i.source === 'BBC')).toBe(true);
  expect(result.items.filter(i => i.sourceFamily === 'reuters')).toHaveLength(1);
  expect(result.items.some(i => i.url.endsWith('fixture-1'))).toBe(false);
  expect(result.coverage.crossChecked).toBe(false); expect(result.coverage.titleMatchCandidates.length).toBeGreaterThan(0);
});
it('国际专题含BBC/卫报/半岛/路透，指定媒体按实际来源过滤，不用国内新闻填国际', async () => {
  const get = transport(); const tool = createTodayNewsTool({ fetchImpl: get, now: () => now });
  const result = JSON.parse(await tool.run({ categories: ['国际'] }, { retrieval: createRetrievalBudget('今日国际新闻') }));
  expect(result.sources.map(s => s.source)).toEqual(['BBC', '路透（CNA转载）', '卫报', '半岛电视台']);
  expect(result.items.every(i => i.category === '国际')).toBe(true); expect(get).toHaveBeenCalledTimes(7);
  get.mockClear(); const only = JSON.parse(await tool.run({ publishers: ['路透'] }));
  expect(only.items).toHaveLength(1); expect(get).toHaveBeenCalledTimes(4);
});
it('单一国际来源失败保留其他报道，不把AFP/自采改成路透凑数', async () => {
  const result = JSON.parse(await createTodayNewsTool({ fetchImpl: transport({ failBbc: true }), now: () => now }).run());
  expect(result.items.some(i => i.sourceFamily === 'reuters')).toBe(true);
  expect(result.sources.find(s => s.source === 'BBC').error).toContain('403');
});
it('转载核对计入单源8秒总期限，不能每篇再串行等8秒，其他来源仍交付', async () => {
  vi.useFakeTimers(); const get = transport({ slowArticle: true });
  const promise = createTodayNewsTool({ fetchImpl: get, now: () => now }).run();
  await vi.advanceTimersByTimeAsync(8001); const value = JSON.parse(await promise);
  expect(value.items.length).toBeGreaterThan(0); expect(value.sources.find(s => s.source.startsWith('路透')).error).toContain('超时'); expect(get).toHaveBeenCalledTimes(8);
});
it('同一机构的转载不会变成多家独立验证，标题相同仅列待复核候选', () => {
  const items = [{ title: 'A sufficiently specific fictional transport headline', publisher: 'CNA', sourceFamily: 'reuters' }, { title: 'A sufficiently specific fictional transport headline', publisher: '另一个转载站', sourceFamily: 'reuters' }];
  const value = newsCoverage(items); expect(value.originFamilies).toEqual(['reuters']); expect(value.publishers).toHaveLength(2); expect(value.crossChecked).toBe(false); expect(value.titleMatchCandidates).toEqual([[0, 1]]);
});
it('先筛新闻频道再核对路透署名，评论混入队列不能挤掉实际路透稿', async () => {
  const base = transport(); const get = vi.fn(async (url, init) => {
    if (url.includes('/api/v1/rss-outbound-feed')) return new Response(fixture('reuters-cna.xml').replace('<item>', '<item><title>虚构评论：公共服务观察的长期变化</title><link>https://www.channelnewsasia.com/commentary/fiction</link><description>评论。</description><pubDate>Fri, 30 Oct 2026 01:00:00 GMT</pubDate></item><item>'));
    return base(url, init);
  });
  const value = JSON.parse(await createTodayNewsTool({ fetchImpl: get, now: () => now }).run());
  expect(value.items.some(i => i.sourceFamily === 'reuters')).toBe(true);
  expect(get.mock.calls.some(([url]) => url.includes('/commentary/'))).toBe(false); expect(get).toHaveBeenCalledTimes(8);
});
it('逐条原文核实默认8条以留出原有读取预算，用户明确数量仍保留候选数量', async () => {
  for (const [userText, limit] of [['今日新闻，逐条打开原文核实', 8], ['今日新闻12条，逐条打开原文核实', 12]]) {
    const run = vi.fn(async () => JSON.stringify({ kind: 'today_news', date: '2026-10-30', items: [], sources: [] }));
    await runAgent({ adapter: { stream: async () => ({ text: '本轮未取得可核实的报道。', toolCalls: [], stop: 'end_turn' }) }, model: 'fixture', context: { dynamic: '' }, history: [], userText, maxSteps: 1, maxTotalSteps: 1, now: () => now, quiet: true, emit() {}, tools: [{ name: 'get_today_news', input_schema: { type: 'object', properties: { limit: { type: 'integer' } } }, run }] });
    expect(run.mock.calls[0][0]).toMatchObject({ limit });
  }
});
