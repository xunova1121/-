import { describe, expect, it, vi } from 'vitest';
import { createBusinessTools } from '../src/agent/businessIntelligence.js';
import { companyProfileHit } from '../src/agent/companyProfileSources.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
import { staggeredSearch } from '../src/agent/webSearch.js';
import { openaiSearchHits } from '../src/agent/openaiSearch.js';
import { createRetrievalBudget } from '../src/agent/retrievalBudget.js';

const company = '江苏天合云商股份有限公司';
const profile = (changes = {}) => ({ title: `${company}公司简介`, url: 'https://company.example/about', snippet: `${company}主营供应链数字化服务。`, ...changes });
const execution = () => ({ sessionId: 'profile-test', retrieval: { remaining: 60000, consume: vi.fn(), registerQuery: vi.fn() } });
const fixture = (search) => {
  const evidence = { put: vi.fn(async (_, value) => value.sources.map((row, index) => `profile-${index}`)) };
  const lookup = createBusinessTools({ businessEvidence: evidence, now: () => 1794470400000 }, { search }).find(row => row.name === 'lookup_company');
  return { lookup, evidence };
};

describe('企业基本简介的有界全网补充', () => {
  it.each(['官网', '母公司', '媒体'])('%s线索不必位于政府或交易所域名，但不冒充登记事实', (source) => {
    const hit = companyProfileHit(profile({ title: `${source}介绍：${company}`, url: `https://${source === '官网' ? 'company' : source === '母公司' ? 'group' : 'news'}.example/about` }), company);
    expect(hit).toMatchObject({ evidence: 'search_summary', claimScope: 'company_profile', registrationVerified: false });
    expect(hit.source).toMatch(/\.example$/);
    expect(hit).not.toHaveProperty('creditCode');
  });

  it('官方为空后只补搜一次、仍计预算，结果存为未读原文的证据', async () => {
    const search = vi.fn(async query => query.includes('site:') ? [] : [profile()]);
    const { lookup, evidence } = fixture(search);
    const context = execution();
    const result = JSON.parse(await lookup.run({ company }, context));
    expect(search).toHaveBeenCalledTimes(3);
    expect(search.mock.calls[2][0]).toBe(`${company} 公司简介 主营业务`);
    expect(context.retrieval.consume.mock.calls).toEqual([['search'], ['search'], ['search']]);
    expect(result).toMatchObject({ state: 'unverified', dataRetrieved: true, section: 'basic' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ evidence: 'search_summary', evidenceId: 'profile-0', registrationVerified: false });
    expect(evidence.put.mock.calls[0][1].sources[0]).toMatchObject({ original: false });
    expect(result.note).toContain('fetch_url读取链接原文');
  });

  it('后过滤为空仍进入全网补充，不把无关官方资料当作成功', async () => {
    const unrelated = { title: '另一家企业年度报告', url: 'https://www.cninfo.com.cn/report', snippet: '另一家企业基本信息' };
    const search = vi.fn(async query => query.includes('site:') ? [unrelated] : [profile()]);
    const result = JSON.parse(await fixture(search).lookup.run({ company }, execution()));
    expect(result.items.map(row => row.url)).toEqual([profile().url]);
    for (const [, , options] of search.mock.calls.slice(0, 2)) expect(options.acceptHit(unrelated)).toBe(false);
  });

  it('有官方企业资料不额外全网补搜', async () => {
    const search = vi.fn(async () => [profile({ url: 'https://www.cninfo.com.cn/report' })]);
    const result = JSON.parse(await fixture(search).lookup.run({ company }, execution()));
    expect(search).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ state: 'unverified', dataRetrieved: true });
    expect(result.items).toHaveLength(1);
  });

  it.each(['shareholders', 'executives', 'investments', 'news'])('%s仍限原有来源，不用简介线索拼股权或工商', async section => {
    const search = vi.fn(async () => [profile()]);
    const result = JSON.parse(await fixture(search).lookup.run({ company, section }, execution()));
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls.every(([query]) => query.includes('site:'))).toBe(true);
    expect(result).toMatchObject({ state: 'empty', dataRetrieved: false, items: [] });
  });

  it('源失败不阻断简介补搜，保留错误码，不泄露上游错误正文', async () => {
    const search = vi.fn(async query => {
      if (query.includes('site:')) throw Object.assign(new Error('private upstream body'), { code: 'ETIMEDOUT', kind: 'timeout' });
      return [profile()];
    });
    const output = await fixture(search).lookup.run({ company }, execution());
    const result = JSON.parse(output);
    expect(result).toMatchObject({ state: 'unverified', dataRetrieved: true });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every(row => row.code === 'ETIMEDOUT')).toBe(true);
    expect(output).not.toContain('private upstream body');
  });

  it.each(['empty', 'partial', 'unavailable'])('%s空资料回执明确未取数，交付检查也不认作资料成功', async state => {
    const search = vi.fn(async query => {
      if (state === 'unavailable' || state === 'partial' && query.includes('site:gov.cn')) throw Object.assign(new Error('offline'), { code: 'ETIMEDOUT' });
      return [];
    });
    const output = await fixture(search).lookup.run({ company }, execution());
    expect(JSON.parse(output)).toMatchObject({ state, dataRetrieved: false, items: [] });
    const review = createExecutionReview(`查询${company}资料，附来源`);
    review.record({ name: 'lookup_company', args: { company }, ok: true, output });
    expect(review.report().retrievalReceipts).toBe(0);
  });

  it.each(['AbortError', 'RETRIEVAL_BUDGET'])('控制信号%s透传，不转空资料或继续全网请求', async code => {
    const search = vi.fn(async () => { throw Object.assign(new Error('stopped'), { code, ...(code === 'AbortError' && { name: 'AbortError' }) }); });
    await expect(fixture(search).lookup.run({ company }, execution())).rejects.toMatchObject({ code });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls.every(([query]) => query.includes('site:'))).toBe(true);
  });

  it('聚合器在企业筛选为空时继续下一引擎，直到找到相关简介', async () => {
    const first = { name: '首选', search: vi.fn(async () => [profile({ title: '另一家企业简介', snippet: '另一家企业主营制造' })]) };
    const second = { name: '备用', search: vi.fn(async query => query.includes('site:') ? [] : [profile()]) };
    const search = (query, count, opts) => staggeredSearch([first, second], query, count, opts, [first], 5);
    const result = JSON.parse(await fixture(search).lookup.run({ company }, execution()));
    expect(result.items.map(row => row.url)).toEqual([profile().url]);
    expect(second.search).toHaveBeenCalledTimes(3);
  });
});

describe('企业简介线索的主体和地址边界', () => {
  it.each(['http://127.0.0.1/private', 'https://service.local/about', 'https://app.internal/about', 'https://name:password@company.example/about', 'file:///company'])('拒绝非公网/含凭据地址%s', url => {
    expect(companyProfileHit(profile({ url }), company)).toBeNull();
  });
  it.each([
    { title: '某采购项目中标公告', snippet: `${company}公司简介与投标材料` },
    { title: '借款诉讼判决', snippet: `${company}经营范围与汇款账户` },
    { title: '集团介绍', snippet: `汇款给${company}，主营业务不详` },
    { title: '集团介绍', snippet: `${company}。另一家公司主营化工` },
    { title: '天合云商公司简介', snippet: '同名企业主营医疗' }
  ])('不接受旁及、付款或同名企业：$title', row => {
    expect(companyProfileHit(profile(row), company)).toBeNull();
  });
});

describe('企业简介与结构化联网引文、真实预算联动', () => {
  it('仅有URL和完整公司标题的真实引文保留为待读线索，不冒充简介取数成功', async () => {
    const citations = openaiSearchHits({ output: [
      { type: 'web_search_call', status: 'completed', action: { sources: [{ url: profile().url }] } },
      { type: 'message', content: [{ type: 'output_text', text: '无关联摘要', annotations: [{ type: 'url_citation', url: profile().url, title: company }] }] }
    ] });
    const search = vi.fn(async query => query.includes('site:') ? [] : citations);
    const output = await fixture(search).lookup.run({ company }, execution());
    const result = JSON.parse(output);
    expect(result).toMatchObject({ state: 'unverified', dataRetrieved: false, items: [] });
    expect(result.leads).toEqual([{ title: company, url: profile().url, evidence: 'unverified', reason: expect.stringContaining('fetch_url') }]);
    const review = createExecutionReview(`查${company}资料`);
    review.record({ name: 'lookup_company', ok: true, output });
    expect(review.report().retrievalReceipts).toBe(0);
  });

  it('缺少结构化引文标记的空标题线索不能假称来源已查到', () => {
    expect(companyProfileHit({ ...profile(), title: company, snippet: '' }, company)).toBeNull();
    expect(companyProfileHit({ ...profile(), title: '天合云商', snippet: '', evidenceType: 'provider_citation' }, company)).toBeNull();
  });

  it('引文关联摘要能作为简介线索，仍明确未读原文、未核实工商', () => {
    const text = `${company}主营供应链数字化服务。[来源]`;
    const [row] = openaiSearchHits({ output: [
      { type: 'web_search_call', status: 'completed', action: { sources: [{ url: profile().url }] } },
      { type: 'message', content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', url: profile().url, title: company, start_index: text.indexOf('[来源]'), end_index: text.length }] }] }
    ] });
    const hit = companyProfileHit(row, company);
    expect(hit).toMatchObject({ evidence: 'search_summary', summaryEvidence: 'provider_cited_summary', originalRead: false, registrationVerified: false });
    expect(hit.snippet).toContain('主营供应链数字化服务');
  });

  it('真正搜索次数用完时，第三次补搜在发请求前阻断并透传预算错误', async () => {
    const retrieval = createRetrievalBudget(`${company}简介`);
    retrieval.begin();
    for (let index = 0; index < 10; index++) retrieval.consume('search');
    const search = vi.fn(async () => []);
    await expect(fixture(search).lookup.run({ company }, { retrieval })).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
    expect(search).toHaveBeenCalledTimes(2);
    expect(retrieval.resources.search).toBe(12);
  });

  it('显式时间预算到期不为简介补搜另开时钟', async () => {
    let tick = 0;
    const retrieval = createRetrievalBudget(`${company}简介`, { now: () => tick, timeBudgetMs: 50 });
    retrieval.begin();
    const search = vi.fn(async query => { if (query.includes('cninfo')) tick = 50; return []; });
    await expect(fixture(search).lookup.run({ company }, { retrieval })).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
    expect(search).toHaveBeenCalledTimes(2);
    expect(retrieval.resources.search).toBe(2);
  });

  it.each(['EVAL_QUOTA', 'EVAL_EXPIRED'])('%s不变成无资料、也不继续简介补搜', async code => {
    const error = Object.assign(new Error('受控上限'), { code });
    const search = vi.fn(async () => { throw error; });
    await expect(fixture(search).lookup.run({ company }, execution())).rejects.toBe(error);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it.each(['EVAL_QUOTA', 'EVAL_EXPIRED'])('企百科收费查询的%s原样透传，不降级为公开补搜', async code => {
    const error = Object.assign(new Error('受控评测上限'), { code });
    const search = vi.fn(async () => []);
    const get = vi.fn(async () => { throw error; });
    const lookup = createBusinessTools({ qibookAccessKey: 'fixture-only', qibookBaseUrl: 'https://skill.qibook.com', fetchViaGateway: get }, { search }).find(row => row.name === 'lookup_company');
    await expect(lookup.run({ company, source: 'qibook' }, { ...execution(), requestText: `用企百科查${company}` })).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
  });
});
