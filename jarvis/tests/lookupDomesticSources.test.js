import { it, expect, vi } from 'vitest';
import { DOMESTIC_NEWS_CANDIDATES } from '../src/agent/lookup/sourceCatalog.js';
import { parseCnsRolling, parseZhiboNewsIndex, parseZhiboNewsArticle, parseSinaSports } from '../src/agent/lookup/domesticNews.js';
import { readLookupSource } from '../src/agent/lookup/readSource.js';
const now = Date.parse('2026-10-31T01:00:00+08:00');
const cns = DOMESTIC_NEWS_CANDIDATES.find(s => s.id === 'cn_cns_sports');
const zhibo = DOMESTIC_NEWS_CANDIDATES.find(s => s.id === 'cn_zhibo_sports');
const sina = DOMESTIC_NEWS_CANDIDATES.find(s => s.id === 'cn_sina_sports');
const row = (column, clock) => `<li><div class="dd_lm">[${column}]</div><a href="https://www.chinanews.com.cn/ty/2026/10-30/fiction.shtml">虚构体育：公共训练场地开放预约</a><div class="dd_time">10-30 ${clock}</div></li>`;
const candidate = { title: '虚构体育：公共训练场地开放预约', url: 'https://news.zhibo8.com/zuqiu/2026-10-30/fiction.htm' };
const article = `<h1>${candidate.title}</h1><span ms-controller="title_controller">2026-10-30 23:46:34 {{info|html}}</span><div id="signals" class="content"><p>训练场地增加公众预约场次。</p></div>`;
it('新增国内候选默认待国内实测，不能把开发环境成功当验收', () => {
  expect(DOMESTIC_NEWS_CANDIDATES.every(s => s.validation === 'pending_cn')).toBe(true);
});
it('中新体育必须有真实栏目和明确发布时间；近期可含昨晚，但今日不可偷换', () => {
  expect(parseCnsRolling(row('体育', '23:30'), cns, { now, params: { dateMode: 'recent24h' } }).items[0]).toMatchObject({ category: '体育', publishedAt: '2026-10-30T23:30:00+08:00' });
  expect(parseCnsRolling(row('体育', '23:30'), cns, { now, params: { dateMode: 'today' } }).items).toEqual([]);
  expect(parseCnsRolling(row('娱乐', '23:30'), cns, { now, params: { dateMode: 'recent24h' } }).items).toEqual([]);
  expect(parseCnsRolling(row('体育', '23:30').replace('10-30 23:30', ''), cns, { now, params: { dateMode: 'recent24h' } }).items).toEqual([]);
});
it('直播吧列表日期仅作候选，正文缺明确时间不给条目，未来时间和外域不放行', () => {
  const index = parseZhiboNewsIndex(`<a href="${candidate.url}">${candidate.title}</a>`, zhibo);
  expect(index.items).toEqual([]); expect(index.candidates).toEqual([candidate]);
  expect(parseZhiboNewsArticle(article, zhibo, candidate, { now, params: { dateMode: 'recent24h' } })[0]).toMatchObject({ verified: 'page', publishedAt: '2026-10-30T23:46:34+08:00' });
  expect(parseZhiboNewsArticle(article.replace('2026-10-30 23:46:34', ''), zhibo, candidate, { now })).toEqual([]);
  expect(parseZhiboNewsArticle(article.replace('2026-10-30 23:46:34', '2026-02-30 23:46:34'), zhibo, candidate, { now: Date.parse('2026-03-03T01:00:00+08:00'), params: { dateMode: 'recent24h' } })).toEqual([]);
  expect(parseZhiboNewsArticle(article.replace('<p>训练场地增加公众预约场次。</p>', ''), zhibo, candidate, { now, params: { dateMode: 'recent24h' } })).toEqual([]);
  expect(parseZhiboNewsArticle(article.replace('2026-10-30 23:46:34', '2026-10-31 23:46:34'), zhibo, candidate, { now })).toEqual([]);
  expect(parseZhiboNewsIndex(`<a href="https://127.0.0.1/zuqiu/2026-10-30/fiction.htm">${candidate.title}</a>`, zhibo).candidates).toEqual([]);
});
it('新浪使用首次ctime，彩票与赔率不当体育资讯，mtime更新不把旧稿变新稿', () => {
  const make = data => ({ result: { status: { code: 0 }, data } });
  const base = { title: '虚构体育：青少年训练活动开始报名', url: 'https://sports.sina.com.cn/golf/2026-10-30/fiction.shtml', ctime: String((now - 3600000) / 1000), mtime: String(now / 1000) };
  expect(parseSinaSports(make([base]), sina, { now, params: { dateMode: 'recent24h' } }).items).toHaveLength(1);
  for (const bad of [{ ...base, ctime: String((now - 48 * 3600000) / 1000) }, { ...base, title: '虚构胜负彩欧洲投注比例调查' }, { ...base, url: 'https://sports.sina.com.cn/l/2026-10-30/fiction.shtml' }]) expect(parseSinaSports(make([bad]), sina, { now, params: { dateMode: 'recent24h' } }).items).toEqual([]);
});
it('同一个来源的列表和正文计真实读次数，失败有明确回执，停止和预算不伪装为空', async () => {
  const consume = vi.fn();const get = vi.fn(async (url) => new Response(url === zhibo.url ? `<a href="${candidate.url}">${candidate.title}</a>` : article));
  const result = await readLookupSource(zhibo, { get, now, params: { dateMode: 'recent24h' }, retrieval: { consume } });
  expect(result.items).toHaveLength(1); expect(result.requests).toBe(2); expect(consume).toHaveBeenCalledTimes(2);
  const failed = await readLookupSource(cns, { get: async () => new Response('', { status: 403 }), now });expect(failed).toMatchObject({ state: 'failed', code: 'LOOKUP_HTTP' });expect(failed.reason).toContain('403');
  const stop = new AbortController();stop.abort(Object.assign(new Error('停止'), { name: 'AbortError' }));
  await expect(readLookupSource(cns, { get, signal: stop.signal })).rejects.toMatchObject({ name: 'AbortError' });
  await expect(readLookupSource(cns, { get, retrieval: { consume: () => { throw Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' }); } } })).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
});
