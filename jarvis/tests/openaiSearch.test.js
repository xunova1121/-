import { describe, it, expect, vi } from 'vitest';
import { createOpenaiSearch, openaiSearchOptions, openaiSearchEndpoint, openaiSearchHits, validateOpenaiSearchConfig, testOpenaiSearch } from '../src/agent/openaiSearch.js';
import { createSearch, staggeredSearch } from '../src/agent/webSearch.js';
import { formatSearchHit } from '../src/agent/qianfanSearch.js';

const cfg = { openaiSearchEnabled: true, openaiSearchBaseURL: 'https://search.example.com/v1', openaiSearchKey: 'fake-secret-for-search', openaiSearchModel: 'search-enabled-model', openaiSearchProtocol: 'responses' };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const result = (url = 'https://www.jiangsu.gov.cn/about') => ({
  output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url, title: '江苏省供销合作总社' }] } },
    { type: 'message', content: [{ type: 'output_text', text: '模型回答不能冒充原文', annotations: [{ type: 'url_citation', url, title: '江苏省供销合作总社' }] }] }
  ]
});

describe('独立OpenAI兼容搜索接口', () => {
  it('默认关闭，搜索Key与聊天模型完全独立且不复用掩码', () => {
    expect(createOpenaiSearch()).toBeNull();
    expect(openaiSearchOptions({ keys: { openai: 'chat-secret', custom: 'relay-secret' } })).toMatchObject({ openaiSearchEnabled: false, openaiSearchKey: '' });
    expect(openaiSearchOptions({ ...cfg, openaiSearchKey: '••••cret' }).openaiSearchKey).toBe('');
  });

  it.each([
    ['https://search.example.com', 'responses', 'https://search.example.com/v1/responses'],
    ['https://search.example.com/v1/', 'responses', 'https://search.example.com/v1/responses'],
    ['https://search.example.com/v1/responses/', 'responses', 'https://search.example.com/v1/responses'],
    ['https://search.example.com/custom/v2', 'chat-completions', 'https://search.example.com/custom/v2/chat/completions'],
    ['https://search.example.com/v1/chat/completions', 'chat-completions', 'https://search.example.com/v1/chat/completions']
  ])('地址%s只追加一次端点', (address, protocol, expected) => {
    expect(openaiSearchEndpoint(address, protocol)).toBe(expected);
  });

  it.each(['http://search.example.com/v1', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://10.0.0.1/v1', 'https://name.internal/v1', 'https://user:pass@search.example.com/v1', 'https://search.example.com/v1?key=secret', 'https://search.example.com/v1#fragment'])('不发送搜索Key到无效地址%s', async address => {
    const get = vi.fn();
    await expect(createOpenaiSearch({ ...cfg, openaiSearchBaseURL: address, fetchImpl: get }).search('公司简介')).rejects.toMatchObject({ code: 'OPENAI_SEARCH_ADDRESS' });
    expect(get).not.toHaveBeenCalled();
  });

  it('协议端点冲突拒绝保存，规范化配置只返回搜索字段', () => {
    expect(() => openaiSearchEndpoint('https://search.example.com/v1/chat/completions', 'responses')).toThrow(/协议/);
    expect(() => validateOpenaiSearchConfig({ openaiSearchEnabled: 'yes' })).toThrow();
    expect(() => validateOpenaiSearchConfig({ openaiSearchProtocol: 'random' })).toThrow();
    expect(() => validateOpenaiSearchConfig({ openaiSearchKey: 'line\nbreak' })).toThrow();
    expect(validateOpenaiSearchConfig({ openaiSearchEnabled: false, openaiSearchBaseURL: '', openaiSearchKey: '', keys: { openai: 'not-returned' } })).toEqual({ openaiSearchEnabled: false, openaiSearchBaseURL: '', openaiSearchKey: '' });
    expect(validateOpenaiSearchConfig({ openaiSearchModel: '  my-model  ' })).toEqual({ openaiSearchModel: 'my-model' });
  });

  it.each(['__proto__', 'constructor', 'toString'])('不接受对象继承属性%s作为协议', protocol => {
    expect(() => openaiSearchEndpoint(cfg.openaiSearchBaseURL, protocol)).toThrow(/协议/);
    expect(() => validateOpenaiSearchConfig({ openaiSearchProtocol: protocol })).toThrow(/协议/);
  });

  it('Responses强制联网、最多一次搜索、不保存会话，只接受结构化引文', async () => {
    const get = vi.fn(async (url, init) => {
      expect(url).toBe('https://search.example.com/v1/responses');
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer fake-secret-for-search' } });
      expect(JSON.parse(init.body)).toMatchObject({ model: cfg.openaiSearchModel, store: false, stream: false, max_tool_calls: 1, tool_choice: { type: 'web_search' }, include: ['web_search_call.action.sources'] });
      expect(JSON.parse(init.body).input).toContain('最近一周');
      return json(result());
    });
    const rows = await createOpenaiSearch({ ...cfg, fetchImpl: get }).search('江苏省供销合作总社', 6, { freshness: 'week' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: '江苏省供销合作总社', source: 'openai-compatible', evidenceType: 'provider_citation', snippet: '' });
    expect(JSON.stringify(rows)).not.toContain('模型回答');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('独立搜索传输优先，避免通用网页代理把POST降成GET', async () => {
    const openaiSearchFetch = vi.fn(async () => json(result()));
    const fetchViaGateway = vi.fn();
    await createOpenaiSearch({ ...cfg, openaiSearchFetch, fetchViaGateway }).search('公司简介');
    expect(openaiSearchFetch).toHaveBeenCalledTimes(1);
    expect(fetchViaGateway).not.toHaveBeenCalled();
  });

  it('Chat Completions发送联网参数，解析嵌套url_citation及上游search_results', async () => {
    const get = vi.fn(async (url, init) => {
      expect(url).toBe('https://search.example.com/v1/chat/completions');
      expect(JSON.parse(init.body)).toMatchObject({ web_search_options: { search_context_size: 'low' }, stream: false });
      return json({
        choices: [{ message: { content: '正文中的https://invented.example.com不作为来源', annotations: [{ type: 'url_citation', url_citation: { url: 'https://news.example.com/cited', title: '真实引用' } }] } }],
        search_results: [{ url: 'https://company.example.com/about', title: '公司官网', snippet: '来源摘要', published_date: '2026-11-12' }]
      });
    });
    const rows = await createOpenaiSearch({ ...cfg, openaiSearchProtocol: 'chat-completions', fetchImpl: get }).search('公司简介');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ snippet: '来源摘要', evidenceType: 'search_result', publishedAt: '2026-11-12' });
    expect(JSON.stringify(rows)).not.toContain('invented.example.com');
  });

  it('先收到只有URL的工具来源时，随后引文仍补上企业标题', () => {
    const data = result();
    delete data.output[0].action.sources[0].title;
    expect(openaiSearchHits(data, 1)[0].title).toBe('江苏省供销合作总社');
  });

  it('有效结构化引文索引可补有限关联摘要，但明确不是已读原文', () => {
    const data = result();
    const text = '江苏省供销合作总社机构简介与主营业务。[1]';
    const part = data.output[1].content[0];
    part.text = text;
    Object.assign(part.annotations[0], { start_index: text.indexOf('[1]'), end_index: text.length });
    expect(openaiSearchHits(data)[0]).toMatchObject({ snippet: text, summaryEvidence: 'provider_cited_summary', originalRead: false, evidenceType: 'provider_citation' });
    part.annotations[0].end_index = text.length + 1;
    expect(openaiSearchHits(data)[0].snippet).toBe('');
  });

  it('Chat Completions嵌套引文同样只提取有效索引所指段落', () => {
    const content = '无关段落，不应关联到来源。\n企业名称的公司简介与主营业务。[1]';
    const data = { choices: [{ message: { content, annotations: [{ type: 'url_citation', url_citation: { url: 'https://company.example.com/about', title: '企业名称', start_index: content.indexOf('[1]'), end_index: content.length } }] } }] };
    expect(openaiSearchHits(data)[0]).toMatchObject({ snippet: '企业名称的公司简介与主营业务。[1]', originalRead: false });
  });

  it('交给主模型的文本保留引文摘要与未读原文标记', () => {
    const base = { title: '公司简介', url: 'https://company.example.com/', source: 'openai-compatible', evidenceType: 'provider_citation' };
    expect(formatSearchHit({ ...base, snippet: '模型引用摘要', summaryEvidence: 'provider_cited_summary', originalRead: false })).toContain('自定义联网搜索模型带引文摘要，未读原文');
    expect(formatSearchHit(base)).toContain('来源链接，待打开原文核实');
    expect(formatSearchHit({ ...base, evidenceType: 'search_result', snippet: '上游搜索摘要' })).toContain('自定义联网搜索摘要，未读原文');
  });

  it('普通聊天即使正文自报JSON来源，也明确报告缺少联网来源', async () => {
    const get = vi.fn(async () => json({ choices: [{ message: { content: JSON.stringify({ results: [{ title: '编造', url: 'https://invented.example.com/' }] }) } }] }));
    await expect(createOpenaiSearch({ ...cfg, fetchImpl: get }).search('公司简介')).rejects.toMatchObject({ code: 'OPENAI_SEARCH_NO_SOURCES' });
  });

  it('来源URL过滤内网、凭据、Key及乱码，摘要和返回数量有界', () => {
    const rows = openaiSearchHits({ search_results: [
      { url: 'http://127.0.0.1/a' }, { url: 'https://u:p@example.com/a' }, { url: 'https://example.com/a?token=fake-secret-for-search' },
      { url: 'https://example.com/%E0%A4%A' }, { url: 'javascript:alert(1)' },
      { url: 'https://example.com/ok', title: 'fake-secret-for-search', snippet: '内容'.repeat(1000) },
      { url: 'https://example.com/ok2', title: '第二条' }
    ] }, 1, cfg.openaiSearchKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url: 'https://example.com/ok', title: '[已隐藏]' });
    expect(rows[0].snippet).toHaveLength(800);
  });

  it.each([400, 401, 402, 403, 404, 429, 500])('HTTP %s只保留状态，不回显上游敏感正文且不重试', async status => {
    const get = vi.fn(async () => new Response('fake-secret-for-search upstream secret', { status }));
    const pending = createOpenaiSearch({ ...cfg, fetchImpl: get }).search('新闻');
    await expect(pending).rejects.toMatchObject({ status, kind: 'api' });
    await pending.catch(error => expect(error.message).not.toContain('secret'));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('断网不重复付费请求，停止或预算到期不吞掉', async () => {
    const get = vi.fn(async () => { throw new TypeError('fake-secret-for-search'); });
    await expect(createOpenaiSearch({ ...cfg, fetchImpl: get }).search('新闻')).rejects.toMatchObject({ code: 'OPENAI_SEARCH_NETWORK', kind: 'network' });
    expect(get).toHaveBeenCalledTimes(1);
    const ctrl = new AbortController();
    const pending = createOpenaiSearch({ ...cfg, fetchImpl: () => new Promise(() => {}) }).search('新闻', 3, { signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const budget = Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' });
    await expect(createOpenaiSearch({ ...cfg, fetchImpl: async () => { throw budget; } }).search('新闻')).rejects.toBe(budget);
  });

  it.each(['EVAL_QUOTA', 'EVAL_EXPIRED'])('%s原样透传，不伪装网络失败或继续搜索', async code => {
    const error = Object.assign(new Error('评测授权限制'), { code, status: 429 });
    const openaiSearchFetch = vi.fn(async () => { throw error; });
    await expect(createOpenaiSearch({ ...cfg, openaiSearchFetch }).search('新闻')).rejects.toBe(error);
    const next = { name: '备用', search: vi.fn(async () => [{ title: '不应读取', url: 'https://example.com/' }]) };
    await expect(staggeredSearch([{ name: '首选', search: async () => { throw error; } }, next], '资料')).rejects.toBe(error);
    expect(next.search).not.toHaveBeenCalled();
  });

  it('已有部分命中时预算耗尽仍停止，不能用结果掩盖或调用后续来源', async () => {
    const error = Object.assign(new Error('预算停止'), { code: 'RETRIEVAL_BUDGET' });
    const third = { name: '第三源', search: vi.fn() };
    const partial = { name: '部分结果', search: async () => [{ title: '一条线索', url: 'https://example.com/' }] };
    const failed = { name: '预算', search: async () => { throw error; } };
    await expect(staggeredSearch([partial, failed, third], '资料', 6)).rejects.toBe(error);
    expect(third.search).not.toHaveBeenCalled();
  });

  it('北京时间凌晨不将今天写成昨天', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T17:00:00Z'));
    try {
      let body;
      await createOpenaiSearch({ ...cfg, fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return json(result()); } }).search('今天新闻');
      expect(body.input).toContain('今天是2026-11-12');
    } finally { vi.useRealTimers(); }
  });

  it('正文超2MiB及非JSON失败，HTTP200错误对象不冒充空结果', async () => {
    await expect(createOpenaiSearch({ ...cfg, fetchImpl: async () => new Response('{}', { headers: { 'Content-Length': 3 * 1024 * 1024 } }) }).search('新闻')).rejects.toMatchObject({ code: 'WEB_BODY_LIMIT' });
    await expect(createOpenaiSearch({ ...cfg, fetchImpl: async () => new Response('<html>bad</html>') }).search('新闻')).rejects.toMatchObject({ code: 'OPENAI_SEARCH_FORMAT' });
    await expect(createOpenaiSearch({ ...cfg, fetchImpl: async () => json({ error: { message: 'secret' } }) }).search('新闻')).rejects.toMatchObject({ code: 'OPENAI_SEARCH_FAILED' });
  });

  it('DNS指向内网保留受控拒绝，超限响应取消正文下载', async () => {
    await expect(createOpenaiSearch({ ...cfg, fetchImpl: async () => { throw Object.assign(new Error('不回显fake-secret-for-search'), { code: 'PRIVATE_NETWORK_BLOCKED' }); } }).search('新闻')).rejects.toMatchObject({ code: 'PRIVATE_NETWORK_BLOCKED', kind: 'api', status: 403 });
    const oversized = new Response('{}', { headers: { 'Content-Length': 3 * 1024 * 1024 } });
    const cancel = vi.spyOn(oversized.body, 'cancel');
    await expect(createOpenaiSearch({ ...cfg, fetchImpl: async () => oversized }).search('新闻')).rejects.toMatchObject({ code: 'WEB_BODY_LIMIT' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('网关提前超时保留超时分类且不泄露原始错误', async () => {
    const get = vi.fn(async () => { throw Object.assign(new Error('fake-secret-for-search'), { name: 'TimeoutError' }); });
    const pending = createOpenaiSearch({ ...cfg, fetchImpl: get }).search('新闻');
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError', kind: 'timeout' });
    await pending.catch(error => expect(error.message).not.toContain('secret'));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('测试入口只测已保存的搜索引擎一次，不用其他来源掩盖失败', async () => {
    const get = vi.fn(async () => json(result()));
    expect(await testOpenaiSearch(cfg, { fetchImpl: get })).toMatchObject({ kind: 'search', requests: 1, count: 1 });
    expect(get).toHaveBeenCalledTimes(1);
    await expect(testOpenaiSearch({ ...cfg, openaiSearchEnabled: false })).rejects.toMatchObject({ code: 'OPENAI_SEARCH_DISABLED' });
  });

  it('显式启用后优先该引擎，失败仍可使用DeepSeek，不暂停整个搜索入口', async () => {
    const get = vi.fn(async url => String(url).includes('search.example.com') ? new Response('', { status: 401 }) : json({ results: [{ title: '机构简介', url: 'https://www.jiangsu.gov.cn/about', summary: '摘要' }] }));
    const search = createSearch({ ...cfg, deepseekSearchEnabled: true, deepseekSearchKey: 'fake-deepseek', fetchViaGateway: get });
    expect((await search.search('机构简介'))[0].source).toBe('deepseek');
    expect(get.mock.calls.map(([url]) => url)).toEqual(['https://search.example.com/v1/responses', 'https://api.deepseek.com/v1/tools/search']);
    expect((await search.search('公司简介'))[0].source).toBe('deepseek');
    expect(get.mock.calls.filter(([url]) => String(url).includes('search.example.com'))).toHaveLength(1);
  });

  it('企业任务过滤后为空，首选源也不能阻断其他引擎且不记连接故障', async () => {
    const first = { name: '首选', search: vi.fn(async () => [{ title: '无关网站', url: 'https://unrelated.example.com/' }]) };
    const second = { name: '备用', search: vi.fn(async () => [{ title: '企业官网', url: 'https://company.example.com/' }]) };
    const acceptHit = hit => hit.url.includes('company.example.com');
    const rows = await staggeredSearch([first, second], '公司简介', 1, { acceptHit }, [first], 1000);
    expect(rows).toEqual([{ title: '企业官网', url: 'https://company.example.com/' }]);
    expect(second.search).toHaveBeenCalledTimes(1);
    await staggeredSearch([first, second], '公司简介', 1, { acceptHit }, [first], 1000);
    expect(first.search).toHaveBeenCalledTimes(2);
  });
});
