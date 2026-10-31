import { describe, it, expect, vi } from 'vitest';
import { createDeepseekSearch, deepseekSearchOptions, testDeepseekSearch } from '../src/agent/deepseekSearch.js';
import { createSearch } from '../src/agent/webSearch.js';
import { createPageReader } from '../src/agent/pageReader.js';
import { maskConfig, mergeConfig } from '../server/serverMode.mjs';
import { publicFetch } from '../server/taskRunner.mjs';

const response = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const options = { deepseekSearchEnabled: true, deepseekSearchKey: 'fake-test-key' };

describe('DeepSeek官方Search/Fetch', () => {
  it('默认关闭，不自动启用收费服务或借用中转Key', () => {
    expect(createDeepseekSearch()).toBeNull();
    expect(deepseekSearchOptions({ keys: { custom: 'relay-key' } }).deepseekSearchKey).toBe('');
    expect(deepseekSearchOptions({ keys: { deepseek: 'official-key' } })).toMatchObject({ deepseekSearchEnabled: false, deepseekSearchKey: 'official-key' });
    expect(deepseekSearchOptions({ keys: { deepseek: 'relay-key' }, baseURLs: { deepseek: 'https://relay.invalid/v1' } }).deepseekSearchKey).toBe('');
    expect(deepseekSearchOptions({ deepseekSearchKey: 'separate', keys: { deepseek: 'official' } }).deepseekSearchKey).toBe('separate');
    expect(deepseekSearchOptions({ deepseekSearchKey: '••••cret', keys: { deepseek: '••••key' } }).deepseekSearchKey).toBe('');
  });

  it('按照官方协议发送请求、保留来源日期与服务商评分，不索要或缓存网页正文', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.deepseek.com/v1/tools/search');
      expect(init.headers.Authorization).toBe('Bearer fake-test-key');
      expect(init.redirect).toBe('error');
      expect(JSON.parse(init.body)).toEqual({ query: '江苏省供销合作总社', count: 6, need_content: false });
      return response({
        results: [
          {
            title: '机构概况',
            url: 'https://www.jiangsu.gov.cn/about',
            summary: '官网摘要',
            content: '不应带入索引的正文',
            date: '2026-10-21T00:00:00Z',
            authority: 4,
            rerank_score: 2.5
          },
          { title: '内网不能成为来源', url: 'http://127.0.0.1/admin', summary: '错误来源' }
        ]
      });
    });
    const rows = await createDeepseekSearch({ ...options, fetchImpl }).search('江苏省供销合作总社');
    expect(rows).toEqual([
      {
        title: '机构概况',
        url: 'https://www.jiangsu.gov.cn/about',
        snippet: '官网摘要',
        source: 'deepseek',
        publishedAt: '2026-10-21T00:00:00Z',
        authority: 4,
        rerankScore: 2.5
      }
    ]);
    expect(JSON.stringify(rows)).not.toContain('不应带入');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('时间筛选采用官方after语法；超过128字符不会静默改写查询或发请求', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(JSON.parse(init.body).query).toMatch(/今天新闻 after:\d{4}-\d{2}-\d{2}$/);
      return response({ results: [] });
    });
    const client = createDeepseekSearch({ ...options, fetchImpl });
    await client.search('今天新闻', 6, { freshness: 'day' });
    await expect(client.search('字'.repeat(129))).rejects.toMatchObject({ code: 'DEEPSEEK_QUERY_LIMIT' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 402, 429, 504])('HTTP %s保留类型、隐藏上游正文和密钥，不误判所有错误为额度不足', async (status) => {
    const fetchImpl = vi.fn(async () => new Response('fake-test-key及上游敏感正文', { status }));
    const result = createDeepseekSearch({ ...options, fetchImpl }).search('新闻');
    await expect(result).rejects.toMatchObject({ status, kind: 'api' });
    await result.catch((error) => {
      expect(error.message).not.toContain('fake-test-key');
      expect(error.message.includes('余额不足')).toBe(status === 402);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('网络失败只重试一次，并在重试发出前扣额度；预算错误不被吞掉', async () => {
    const sequence = [];
    const fetchImpl = vi.fn(async () => {
      sequence.push('request');
      if (fetchImpl.mock.calls.length === 1) throw new TypeError('网络断开，secret不能回显');
      return response({ results: [] });
    });
    await createDeepseekSearch({ ...options, fetchImpl }).search('新闻', 6, { consume: (kind) => sequence.push(kind) });
    expect(sequence).toEqual(['request', 'search', 'request']);
    const budget = Object.assign(new Error('测试预算'), { code: 'RETRIEVAL_BUDGET' });
    const blocked = vi.fn(async () => {
      throw new TypeError('offline');
    });
    await expect(
      createDeepseekSearch({ ...options, fetchImpl: blocked }).search('新闻', 6, {
        consume: () => {
          throw budget;
        }
      })
    ).rejects.toBe(budget);
    expect(blocked).toHaveBeenCalledTimes(1);
  });

  it('用户停止可立即结束卡住请求，不再重试', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const pending = createDeepseekSearch({ ...options, fetchImpl }).search('新闻', 6, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('成功结果优先返回，不探测地区、不重复查免费搜索', async () => {
    const get = vi.fn(async (url) => {
      expect(String(url)).toBe('https://api.deepseek.com/v1/tools/search');
      return response({ results: [{ title: '报道', url: 'https://www.gov.cn/1', summary: '摘要' }] });
    });
    const rows = await createSearch({ ...options, fetchViaGateway: get }).search('新闻', 3);
    expect(rows).toHaveLength(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('官方服务失败自动退回免费搜索，同词切源不重复扣逻辑额度', async () => {
    const get = vi.fn(async (url) => {
      if (String(url).includes('/v1/tools/search')) return new Response('', { status: 401 });
      if (String(url).includes('format=rss'))
        return new Response(
          '<rss><channel><item><title>原始报道</title><link>https://www.gov.cn/news/1</link><description>新闻正文线索</description></item></channel></rss>'
        );
      return new Response('<html></html>');
    });
    const consume = vi.fn();
    const rows = await createSearch({ ...options, fetchViaGateway: get, searchRegion: 'cn' }).search('今日新闻', 1, { consume });
    expect(rows[0].url).toBe('https://www.gov.cn/news/1');
    expect(consume).not.toHaveBeenCalled();
  });

  it('Fetch使用官方字段，返回可读正文并复用有界缓存，不再直抓', async () => {
    const get = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.deepseek.com/v1/tools/fetch');
      expect(JSON.parse(init.body)).toEqual({ url: 'https://www.gov.cn/example' });
      return response({ title: '正文标题', content: '正文内容' });
    });
    const reader = createPageReader({ ...options, fetchViaGateway: get });
    expect(await reader('https://www.gov.cn/example')).toContain('正文内容');
    expect(await reader('https://www.gov.cn/example')).toContain('正文标题');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('Fetch失败退回直接读取；备用请求发出前扣读预算', async () => {
    const sequence = [];
    const get = vi.fn(async (url) => {
      if (String(url).includes('/v1/tools/fetch')) {
        sequence.push('official');
        return new Response('', { status: 404 });
      }
      sequence.push('direct');
      return new Response('<html><body><p>原网站正文已经读取。</p></body></html>', { headers: { 'Content-Type': 'text/html' } });
    });
    const reader = createPageReader({ ...options, fetchViaGateway: get });
    expect(await reader('https://www.gov.cn/example', { consume: (kind) => sequence.push(kind) })).toContain('原网站正文');
    expect(sequence).toEqual(['official', 'read', 'direct']);
  });

  it.each(['http://127.0.0.1/a', 'http://10.0.0.1/a', 'https://user:password@example.com/a'])('私有或含凭据网址%s不发送到任何公共代读服务', async (url) => {
    const get = vi.fn();
    await expect(createPageReader({ ...options, tavilyKey: 'fake-tavily', fetchViaGateway: get })(url)).rejects.toMatchObject({
      code: 'PRIVATE_NETWORK_BLOCKED'
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('响应大于2MB或格式不符合协议时明确失败', async () => {
    const huge = vi.fn(async () => new Response('{}', { headers: { 'Content-Length': String(3 * 1024 * 1024) } }));
    await expect(createDeepseekSearch({ ...options, fetchImpl: huge }).search('新闻')).rejects.toMatchObject({ code: 'WEB_BODY_LIMIT' });
    await expect(createDeepseekSearch({ ...options, fetchImpl: async () => response({ unexpected: [] }) }).search('新闻')).rejects.toMatchObject({
      code: 'DEEPSEEK_SEARCH_FORMAT'
    });
    await expect(createDeepseekSearch({ ...options, fetchImpl: async () => response({ content: '' }) }).read('https://www.gov.cn/')).rejects.toMatchObject({
      code: 'DEEPSEEK_FETCH_EMPTY'
    });
  });

  it('独立Key在服务器返回值中掩码，掩码或空值保存不会破坏原Key', () => {
    const cfg = { ...options, keys: { deepseek: 'official-test-key' } };
    expect(JSON.stringify(maskConfig(cfg))).not.toContain('fake-test-key');
    expect(maskConfig(cfg).deepseekSearchKey).toBe('••••-key');
    expect(mergeConfig(cfg, { deepseekSearchKey: '••••-key', deepseekSearchEnabled: false })).toMatchObject({
      deepseekSearchKey: 'fake-test-key',
      deepseekSearchEnabled: false
    });
    expect(mergeConfig(cfg, { deepseekSearchKey: '' }).deepseekSearchKey).toBe('fake-test-key');
  });

  it('固定公开测试只返回计数和耗时；关闭或测试类型错误时不发请求', async () => {
    const get = vi.fn(async () => response({ results: [] }));
    expect(await testDeepseekSearch({ ...options }, 'search', { fetchImpl: get })).toMatchObject({ kind: 'search', count: 0, requests: 1 });
    await expect(testDeepseekSearch({}, 'fetch', { fetchImpl: get })).rejects.toMatchObject({ code: 'DEEPSEEK_SEARCH_DISABLED' });
    await expect(testDeepseekSearch(options, 'unknown', { fetchImpl: get })).rejects.toMatchObject({ code: 'INVALID_SEARCH_TEST' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('固定官方API请求禁止跟随重定向，不把Authorization转发到其他主机', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 307, headers: { location: 'https://other.example/' } }));
    await expect(
      publicFetch(
        'https://api.deepseek.com/v1/tools/search',
        { redirect: 'error', headers: { Authorization: 'Bearer fake-test-key' } },
        fetchImpl,
        async () => [{ address: '8.8.8.8' }]
      )
    ).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// 用户 2026-10-29：读网页时 DeepSeek Fetch 连续 500，额度很快扣光，还报“search 调用已达到预算”
describe('服务商出错熔断与预算报错写清楚', () => {
  it('DeepSeek Fetch 返回 500 后，3 分钟内同一读取器直接走直连，不再先撞坏接口，也不另扣读预算', async () => {
    const sequence = [];
    const get = vi.fn(async (url) => {
      if (String(url).includes('/v1/tools/fetch')) {
        sequence.push('official');
        return new Response('', { status: 500 });
      }
      sequence.push('direct');
      return new Response('<html><body><p>原网站正文已经读取。</p></body></html>', { headers: { 'Content-Type': 'text/html' } });
    });
    const reader = createPageReader({ ...options, fetchViaGateway: get });
    await reader('https://www.gov.cn/a', { consume: (kind) => sequence.push(kind) });
    expect(sequence).toEqual(['official', 'read', 'direct']);
    sequence.length = 0;
    expect(await reader('https://www.gov.cn/b', { consume: (kind) => sequence.push(kind) })).toContain('原网站正文');
    expect(sequence).toEqual(['direct']);
  });

  it('404 这类请求本身的问题不熔断，下次照常先试 DeepSeek', async () => {
    const hits = [];
    const get = vi.fn(async (url) => {
      hits.push(String(url).includes('/v1/tools/fetch') ? 'official' : 'direct');
      return String(url).includes('/v1/tools/fetch') ? new Response('', { status: 404 }) : new Response('<html><body><p>正文内容已经读取到了。</p></body></html>', { headers: { 'Content-Type': 'text/html' } });
    });
    const reader = createPageReader({ ...options, fetchViaGateway: get });
    await reader('https://www.gov.cn/c');
    await reader('https://www.gov.cn/d');
    expect(hits.filter((h) => h === 'official')).toHaveLength(2);
  });

  it('整轮联网收尾后：报错写清是哪一类先用完、这次哪一步没执行', async () => {
    const { createRetrievalBudget } = await import('../src/agent/retrievalBudget.js');
    const budget = createRetrievalBudget('今天有什么新闻');
    budget.begin();
    for (let i = 0; i < 12; i++) budget.consume('search');
    expect(() => budget.consume('search')).toThrow('普通查询的搜索（search）预算已用完（12次）');
    expect(() => budget.consume('read')).toThrow('普通查询的搜索（search）预算已用完（12次），这次读网页没有执行');
  });
});
