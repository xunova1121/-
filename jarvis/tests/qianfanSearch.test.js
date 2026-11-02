import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQianfanSearch, qianfanRequest, qianfanPublishedAt, datedSearchHits, formatSearchHit, testQianfanSearch, QIANFAN_ENDPOINT } from '../src/agent/qianfanSearch.js';
import { createSearch } from '../src/agent/webSearch.js';
import { createPageReader } from '../src/agent/pageReader.js';
import { screenSearchHits } from '../src/agent/retrievalQuality.js';
import { mergeSearchHits } from '../src/agent/officialSources.js';
import { maskConfig, mergeConfig } from '../server/serverMode.mjs';

// 官方公开结构：ai.baidu.com/ai-doc/AppBuilder/pmaxd1hvy；全为合成内容，不是真实API回执。
const fixture = { references: [{ id: 1, type: 'web', title: '合成新闻标题', url: 'https://www.chinanews.com.cn/test.html?utm_source=fixture', content: '官方字段content中的合成摘要 &amp; 内容。', date: '2026-11-01 12:00:00', website: '中新网' }], request_id: 'synthetic-only' };
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const now = Date.UTC(2026, 10, 1, 5);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('百度千帆搜索官方协议与日期', () => {
  it('缺Key或掩码不启用；消息/网页/top_k/edition按官方结构，today不用不存在的day枚举', () => {
    expect(createQianfanSearch()).toBeNull();
    expect(createQianfanSearch({ qianfanSearchKey: '••••mask' })).toBeNull();
    const request = qianfanRequest('今天中超比分 直播吧', { now });
    expect(request).toMatchObject({ messages: [{ role: 'user', content: '今天中超比分 直播吧' }], search_source: 'baidu_search_v2', edition: 'standard', resource_type_filter: [{ type: 'web', top_k: 10 }], search_filter: { range: { page_time: { gte: '2026-11-01', lt: '2026-11-02' } }, match: { site: expect.arrayContaining(['zhibo8.com']) } } });
    expect(request.search_recency_filter).toBeUndefined();
    expect(request.block_websites).toContain('espn.com');
    expect(qianfanRequest('体育资讯', { now }).search_recency_filter).toBe('week');
    expect(qianfanRequest('函数是什么', { now }).search_filter).toBeUndefined();
    expect(qianfanRequest('新华网报道', { now, topK: 3, edition: 'lite' })).toMatchObject({ edition: 'lite', resource_type_filter: [{ type: 'web', top_k: 5 }], search_filter: { match: { site: ['news.cn', 'xinhuanet.com'] } } });
    expect(qianfanRequest('site:gov.cn 资料', { topK: 40 }).resource_type_filter[0].top_k).toBe(20);
    expect(qianfanRequest('中超比分', { now, requestText: '今天直播吧上的中超比分' }).search_filter).toMatchObject({ range: { page_time: { gte: '2026-11-01', lt: '2026-11-02' } }, match: { site: expect.arrayContaining(['zhibo8.com']) } });
  });
  it('北京时间跨日、明确日期、时区换算；未知和非法日期不填今天', () => {
    expect(qianfanRequest('今天新闻', { now: Date.UTC(2026, 9, 31, 17) }).search_filter.range.page_time.gte).toBe('2026-11-01');
    expect(qianfanRequest('2026年11月1日中超比分', { now: now + 86400000 }).search_filter.range.page_time.gte).toBe('2026-11-01');
    expect(qianfanPublishedAt('2026-10-31T17:00:00Z')).toBe('2026-11-01T01:00:00+08:00');
    expect(qianfanPublishedAt('2026-11-01 12:00:00')).toBe('2026-11-01T12:00:00+08:00');
    expect(qianfanPublishedAt('2026-11-01')).toBe('2026-11-01');
    for (const value of ['', '昨天', '2026-02-30', 'not a date']) expect(qianfanPublishedAt(value)).toBeNull();
  });
  it('只访问固定端点，解析references.content/date、去重清理，不泄漏Key或内部链接', async () => {
    const get = vi.fn(async (url, options) => {
      expect(url).toBe(QIANFAN_ENDPOINT);
      expect(options.headers.Authorization).toBe('Bearer FAKE_QIANFAN_FIXTURE_ONLY');
      expect(options.redirect).toBe('error');
      return json({ references: [...fixture.references, { ...fixture.references[0], url: 'https://www.chinanews.com.cn/test.html?utm_source=other' }, { title: '内部', type: 'web', url: 'http://127.0.0.1/settings' }, { title: '已停用来源', type: 'web', url: 'https://www.espn.com/football/news' }, { title: '不应回显', url: 'https://example.com/?key=FAKE_QIANFAN_FIXTURE_ONLY' }] });
    });
    const service = createQianfanSearch({ qianfanSearchKey: 'FAKE_QIANFAN_FIXTURE_ONLY', fetchViaGateway: get, now: () => now });
    const rows = await service.search('新闻资料');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: '合成新闻标题', url: 'https://www.chinanews.com.cn/test.html', snippet: '官方字段content中的合成摘要 & 内容。', publishedAt: '2026-11-01T12:00:00+08:00', source: 'qianfan' });
    expect(JSON.stringify(rows)).not.toContain('FAKE_QIANFAN_FIXTURE_ONLY');
    expect(get).toHaveBeenCalledTimes(1);
    const receipt = formatSearchHit(rows[0], { requestText: '今天新闻' });
    expect(receipt).toContain('百度搜索摘要，未读原文');
    expect(formatSearchHit({ title: '未知', url: 'https://example.com', source: 'qianfan' }, { requestText: '今天中超比分' })).toContain('不能作为指定日期的事实');
  });
  it('11月1日真实问题类型：去年/上月比分、台风延期旧微博、标题8月10日均不冒充当日；未知日期只作线索', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const hits = [
      { title: '去年的比分', publishedAt: '2025-11-01 10:00:00' },
      { title: '上月另一轮赛果', publishedAt: '2026-10-01 12:00:00' },
      { title: '台风比赛延期旧微博', publishedAt: '2026-08-10 12:00:00' },
      { title: '2026年8月10日比分', publishedAt: '2026-11-01 12:00:00' },
      { title: '当日赛况', publishedAt: '2026-11-01 12:00:00' },
      { title: '无日期线索', publishedAt: null }
    ];
    expect(datedSearchHits(hits, '今天中超比分', { now }).map(row => row.title)).toEqual(['当日赛况', '无日期线索']);
    expect(screenSearchHits(hits, '今天中超比分').hits.map(row => row.title)).toEqual(['当日赛况', '无日期线索']);
    expect(datedSearchHits(hits, '今日新闻', { now }).at(-1)).toMatchObject({ dateStatus: 'unknown', publishedAt: null });
  });
  it('沿用来源注册表，官方/主流媒体排在聚合与微博前', () => {
    const hits = ['https://weibo.com/test', 'https://www.chinanews.com.cn/test', 'https://www.thecfa.cn/test', 'https://www.bbc.com/news/test'].map(url => ({ title: '合成同题结果', url }));
    expect(mergeSearchHits(hits).map(row => row.url)).toEqual([hits[2].url, hits[1].url, hits[3].url, hits[0].url]);
  });
  it('401受控说明不含上游回显；3分钟冷却后才重试，取消不进入冷却', async () => {
    let clock = now;
    const get = vi.fn(async () => new Response('upstream echoes FAKE_PRIVATE_KEY', { status: 401 }));
    const service = createQianfanSearch({ qianfanSearchKey: 'FAKE_PRIVATE_KEY', fetchImpl: get, now: () => clock });
    await expect(service.search('资料')).rejects.toMatchObject({ status: 401, message: expect.stringContaining('Key无效') });
    await expect(service.search('资料')).rejects.toMatchObject({ skipped: true });
    expect(get).toHaveBeenCalledTimes(1);
    clock += 180000;
    await expect(service.search('资料')).rejects.not.toHaveProperty('message', expect.stringContaining('FAKE_PRIVATE_KEY'));
    expect(get).toHaveBeenCalledTimes(2);
    const ctrl = new AbortController(); ctrl.abort();
    const cancelled = createQianfanSearch({ qianfanSearchKey: 'fake', fetchImpl: get });
    await expect(cancelled.search('资料', 6, { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('中文先千帆，失败自动走DeepSeek；英文原DeepSeek先行，千帆在其后', async () => {
    const calls = [];
    const get = async url => {
      calls.push(url);
      if (url === QIANFAN_ENDPOINT) return new Response('private diagnostic', { status: 503 });
      if (url.endsWith('/tools/search')) return json({ results: [{ title: '后备结果', url: 'https://example.com', summary: '合成' }] });
      throw new Error('不应请求其他来源');
    };
    const options = { qianfanSearchKey: 'fake-qianfan', deepseekSearchEnabled: true, deepseekSearchKey: 'fake-deepseek', fetchViaGateway: get, searchRegion: 'cn' };
    expect((await createSearch(options).search('中国资料'))[0].title).toBe('后备结果');
    expect(calls.slice(0, 2)).toEqual([QIANFAN_ENDPOINT, 'https://api.deepseek.com/v1/tools/search']);
    calls.length = 0;
    await createSearch({ ...options, searchRegion: 'global' }).search('Node documentation');
    expect(calls[0]).toBe('https://api.deepseek.com/v1/tools/search');
  });
  it('测试真实请求，不用缓存填0条以外的结果，配置掩码与保留规则正确', async () => {
    const get = vi.fn(async () => json({ references: [] }));
    const cfg = { qianfanSearchKey: 'FAKE_SEARCH_1234' };
    expect(maskConfig(cfg).qianfanSearchKey).toBe('••••1234');
    expect(mergeConfig(cfg, { qianfanSearchKey: '••••1234' }).qianfanSearchKey).toBe(cfg.qianfanSearchKey);
    expect(mergeConfig(cfg, { qianfanSearchKey: '' }).qianfanSearchKey).toBe(cfg.qianfanSearchKey);
    expect(() => mergeConfig(cfg, { qianfanSearchTopK: 21 })).toThrow(/5至20/);
    expect(await testQianfanSearch(cfg, { fetchViaGateway: get })).toMatchObject({ provider: 'qianfan', count: 0, sample: [], requests: 1 });
    expect(get).toHaveBeenCalledTimes(1);
  });
});

it('DeepSeek Fetch在第6秒返回正文时成功，不在2.5秒退回直读', async () => {
  vi.useFakeTimers();
  const get = vi.fn(async url => {
    expect(url).toBe('https://api.deepseek.com/v1/tools/fetch');
    await new Promise(resolve => setTimeout(resolve, 6000));
    return json({ content: '真实正文的合成替身。'.repeat(80) });
  });
  const read = createPageReader({ deepseekSearchEnabled: true, deepseekSearchKey: 'fake-key', fetchViaGateway: get });
  const pending = read('https://example.com/news');
  await vi.advanceTimersByTimeAsync(6000);
  expect(await pending).toContain('真实正文的合成替身');
  expect(get).toHaveBeenCalledTimes(1);
});
