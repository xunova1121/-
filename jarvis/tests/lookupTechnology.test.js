import { it, expect } from 'vitest';
import { parseCnsRolling } from '../src/agent/lookup/domesticNews.js';
import { DOMESTIC_NEWS_CANDIDATES } from '../src/agent/lookup/sourceCatalog.js';
import { createLookupService, memoryLookupStorage } from '../src/agent/lookup/service.js';
import { createTodayNewsTool } from '../src/agent/todayNews.js';
import { selectLiveLookupCases } from '../evals/lookup-live-queries.mjs';
const source = DOMESTIC_NEWS_CANDIDATES.find(row => row.id === 'cn_cns');
const now = Date.parse('2026-10-31T10:00:00+08:00');
const entry = (column, title, id, date = '10-31 08:00') => `<li><div class="dd_lm">[${column}]</div><a href="https://www.chinanews.com.cn/gn/2026/10-31/${id}.shtml">${title}</a><div class="dd_time">${date}</div></li>`;
const title = '虚构新闻：科研机构发布卫星算力服务平台';
const html = entry('时政', title, 'science') + entry('财经', '虚构新闻：本地集成电路产业新增公共实验平台', 'chip') + entry('湾区', '虚构新闻：多家科研机构开放共享实验设备', 'research')
  + entry('社会', '虚构新闻：社区公共服务持续创新升级', 'generic') + entry('体育', '虚构新闻：量子杯足球联赛开放公众报名', 'sport') + entry('文娱', '虚构新闻：太空主题电影举办主创见面会', 'movie');
it('国内复查可只选科技，其他案例不记为通过；未知编号不触发整批重跑', () => {
  expect(selectLiveLookupCases('tech')).toEqual([['tech', '科技资讯', 'news']]);
  expect(selectLiveLookupCases()).toHaveLength(15);
  expect(() => selectLiveLookupCases('unknown')).toThrow('未发起网络请求');
});
it('科技主题不受原站时政/财经/地区栏目名限制；保留原标题、原栏目和来源，不扩写内容', () => {
  const rows = parseCnsRolling(html, source, { now, params: { categories: ['科技'] } }).items;
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ title, publisherColumn: '[时政]', category: '科技', categoryBasis: 'title_topic', summary: '', verified: 'index', verification: 'index_only' });
  expect(rows[0].url).toBe('https://www.chinanews.com.cn/gn/2026/10-31/science.shtml');
  expect(rows.every(row => row.publishedAt === '2026-10-31T08:00:00+08:00')).toBe(true);
  expect(rows.some(row => /generic|sport|movie/.test(row.url))).toBe(false);
});
it('主题匹配不能放行无发布时间、旧闻、未来或外域；综合/财经/体育查询不被重分类', () => {
  for (const bad of [entry('时政', title, 'x', ''), entry('时政', title, 'x', '10-30 23:00'), entry('时政', title, 'x', '10-31 11:00'), entry('时政', title, 'x').replace('www.chinanews.com.cn', 'outside.example')]) {
    expect(parseCnsRolling(bad, source, { now, params: { categories: ['科技'] } }).items).toEqual([]);
  }
  const all = parseCnsRolling(html, source, { now }).items;
  expect(all.find(row => row.title === title)).toMatchObject({ category: '国内' });
  expect(all.some(row => row.categoryBasis === 'title_topic')).toBe(false);
  const native = parseCnsRolling(entry('科技', title, 'native'), source, { now, params: { categories: ['科技'] } }).items;
  expect(native[0].category).toBe('科技');
  expect(native[0].categoryBasis).toBeUndefined();
});
it('生产新闻入口在海外不可连通时，也能交付已实测国内源的科技主题条目且读取不超8次', async () => {
  const get = async url => new Response(url.includes('www.chinanews.com.cn') ? html : '', { status: url.includes('www.chinanews.com.cn') ? 200 : 403 });
  const service = createLookupService({ storage: memoryLookupStorage(), get, now: () => now });
  const tool = createTodayNewsTool({ lookup: service.options('cn'), now: () => now, fetchImpl: get });
  const value = JSON.parse(await tool.run({}, { requestText: '科技资讯' }));
  expect(value.items).toHaveLength(3);
  expect(value.items.every(row => row.category === '科技' && row.source === '中新网')).toBe(true);
  expect(value.note).toContain('publisherColumn');
  expect(value.sources.reduce((count, row) => count + row.requests, 0)).toBeLessThanOrEqual(8);
});
