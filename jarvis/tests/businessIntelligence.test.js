import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { businessDate, businessSource, businessWindow, businessSnippet, companyMatches, noticeMatches, noticeType, uniqueNotices } from '../src/agent/businessSources.js';
import { parseTenderListing, parseGgzyListing, parseTenderNotice } from '../src/agent/tenderNotices.js';
import { createBusinessTools } from '../src/agent/businessIntelligence.js';
import { createTools } from '../src/agent/tools.js';
import { BUSINESS_AGENT } from '../src/agent/businessAgent.js';
import { ALL_BUILTIN_AGENTS, BUILTIN_AGENTS, PROFILE_STORE_KEY, createAgentRegistry, validateProfile } from '../src/agent/agentProfiles.js';
import { taskToolCore } from '../src/agent/taskToolProfile.js';
import { qibookConfig, qibookSelected } from '../src/core/qibook.js';
import { queryQibookCompany } from '../src/agent/qibookCompany.js';
import { maskConfig, mergeConfig } from '../server/serverMode.mjs';
import { htmlToText } from '../src/agent/docs.js';

const now = () => Date.parse('2026-11-11T12:00:00+08:00');
const url = 'https://www.ccgp.gov.cn/cggg/dfgg/gkzb/202611/t20261111_123.htm';
const listing = (title = '南京智慧农业采购项目招标公告', date = '2026-11-11', path = url) => `<ul><li><a href="${path}">${title}</a><br>发布时间：<span>${date} 08:00:00</span> 地域：<span>江苏</span> 采购人：<span>南京采购单位</span></li></ul>`;
const body = (date = '2026年11月11日', title = '南京智慧农业采购项目招标公告') => `${title}\n发布时间：${date} 08:00\n项目名称：南京智慧农业采购项目\n项目编号：NJ-2026-001\n预算金额：100万元（人民币）\n最高限价：95万元（人民币）\n提交投标文件截止时间：2026年11月20日 09点30分（北京时间）\n采购需求：建设监测系统和配套应用。\n申请人的资格要求：须满足政府采购法规定条件，报名要求详见采购文件。\n更正内容：后续公告需在原站核实。`;
const fixture = file => readFileSync(new URL('./fixtures/' + file, import.meta.url), 'utf8');
const mockEvidence = () => ({ put: vi.fn(async (_, value) => value.sources.map((row, i) => `e${i}`)) });
const engine = rows => ({ search: vi.fn(async () => rows) });
const tool = (ctx = {}, search = engine([]), name = 'search_tenders') => createBusinessTools({ now, fetchViaGateway: vi.fn(async () => new Response(listing())), businessEvidence: mockEvidence(), ...ctx }, search).find(t => t.name === name);
const exec = () => ({ sessionId: 'session-a', retrieval: { consume: vi.fn(), registerQuery: vi.fn(), remaining: 60000 } });

describe('企业公告日期、类型和来源', () => {
  it.each(['2026-11-3', '2026/11/3', '2026年11月3日'])('兼容日期 %s', date => expect(businessDate(date)).toBe('2026-11-03'));
  it.each(['2026-02-30', '2026-13-01', '2026-00-01', '11月3日'])('不猜非法或不完整日期 %s', date => expect(businessDate(date)).toBe(''));
  it('按北京时间跨日，拒绝逆序和未来范围', () => {
    expect(businessWindow({ period: 'today' }, Date.parse('2026-11-10T17:00:00Z'))).toEqual({ from: '2026-11-11', to: '2026-11-11', timezone: 'Asia/Shanghai' });
    expect(businessWindow({}, now()).from).toBe('2026-11-05');
    expect(() => businessWindow({ from: '2026-11-10', to: '2026-11-09' }, now())).toThrow();
    expect(() => businessWindow({ to: '2026-11-12' }, now())).toThrow();
  });
  it.each([['中标结果更正公告', 'correction'], ['采购废标公告', 'terminated'], ['中标候选人公示', 'award'], ['采购意向公告', 'intention'], ['公开招标公告', 'tender']])('识别 %s', (title, type) => expect(noticeType(title)).toBe(type));
  it('只信任实际域名，保留不同包件和更正', () => {
    expect(businessSource('https://ccgp.gov.cn.evil.test/a')).toBeNull();
    expect(businessSource('https://user:password@www.ccgp.gov.cn/a')).toBeNull();
    expect(businessSource('https://ggzy.jiangsu.gov.cn/a').kind).toBe('government');
    expect(uniqueNotices([{ url }, { url: url + '#x' }, { url: url + '?lot=2' }, { url: url.replace('123', '124') }])).toHaveLength(3);
  });
  it('真实政府采购HTML能提取20条列表和独立预算/最高限价', () => {
    const rows = parseTenderListing(fixture('business-ccgp-list-20261111.html'));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({ publishedAt: '2026-11-11', type: 'correction', evidence: 'official_listing' });
    const row = parseTenderNotice(htmlToText(fixture('business-ccgp-notice-20261111.html')), { url, title: '高性能工作站采购项目招标公告', now: now() });
    expect(row).toMatchObject({ projectNumber: '0722-26FE8015SZF-0', publishedAt: '2026-11-11', type: 'tender' });
    expect(row.budgetText).toContain('45.770000');
    expect(row.ceilingText).toContain('45.000000');
    expect(row.deadlineText).toBe('2026年12月02日 09点30分（北京时间）');
    expect(row.excerpt.length).toBeLessThanOrEqual(1800);
  });
  it('过期、中标和未知截止不能冒充正在招标', () => {
    expect(parseTenderNotice(body(), { url, title: '中标公告', now: now() }).status).toBe('closed');
    expect(parseTenderNotice(body().replace('2026年11月20日 09点30分', '2026年11月11日 09点30分'), { url, now: now() }).status).toBe('closed');
    expect(parseTenderNotice(body().replace('提交投标文件截止时间', '领取招标文件截止时间'), { url, now: now() }).deadlineText).toBeNull();
  });
});

describe('公告真实工具入口', () => {
  it('搜索故障不挡住官方列表；每次请求之前扣预算', async () => {
    const execution = exec();
    const read = vi.fn(async () => { expect(execution.retrieval.consume).toHaveBeenCalledWith('read'); return new Response(listing()); });
    const search = { search: vi.fn(async () => { throw Object.assign(new Error('offline'), { code: 'ETIMEDOUT' }); }) };
    const value = JSON.parse(await tool({ fetchViaGateway: read }, search).run({ query: '智慧农业', region: '江苏', period: 'today' }, execution));
    expect(value.state).toBe('ok');
    expect(value.items).toHaveLength(1);
    expect(value.warnings).toHaveLength(2);
    expect(value.items[0]).toMatchObject({ type: 'tender', publishedAt: '2026-11-11', status: 'needs_verification' });
  });
  it('列表故障仍走搜索、读取原文，不读/清空全局健康记录', async () => {
    const health = { get: vi.fn(), record: vi.fn() };
    const value = JSON.parse(await tool({ lookup: { health }, fetchViaGateway: vi.fn(async () => new Response('', { status: 503 })), businessReadPage: vi.fn(async () => body()) }, engine([{ title: '南京智慧农业采购项目招标公告', url, snippet: '江苏 南京智慧农业' }])).run({ query: '智慧农业', period: 'today' }, exec()));
    expect(value.items[0]).toMatchObject({ evidence: 'original_page', projectNumber: 'NJ-2026-001' });
    expect(health.get).not.toHaveBeenCalled();
    expect(health.record).not.toHaveBeenCalled();
  });
  it('旧闻、未来日期、不同地区及中标公告按条件过滤', async () => {
    const html = listing() + listing('智慧农业中标公告') + listing('智慧农业招标公告', '2025-11-11', url + '?old=1') + listing('智慧农业招标公告', '2026-11-12', url + '?future=1');
    const run = tool({ fetchViaGateway: async () => new Response(html) }).run;
    const result = JSON.parse(await run({ period: 'today', notice_type: 'tender', region: '江苏' }, exec()));
    expect(result.items).toHaveLength(1);
    expect(JSON.parse(await run({ region: '北京' }, exec())).items).toEqual([]);
  });
  it('搜索摘要标今天但正文是去年，不能进入最新结果', async () => {
    const result = JSON.parse(await tool({ fetchViaGateway: async () => new Response(''), businessReadPage: async () => body('2025年11月11日') }, engine([{ title: '南京智慧农业采购项目招标公告', url, snippet: '江苏 智慧农业', publishedAt: '2026-11-11' }])).run({ query: '智慧农业', period: 'today' }, exec()));
    expect(result.items).toEqual([]);
  });
  it('无日期只有截止日时单列线索，不把截止日期或URL日期当发布日', async () => {
    const result = JSON.parse(await tool({ fetchViaGateway: async () => new Response(''), businessReadPage: async () => body().replace(/发布时间[^\n]*\n/, '') }, engine([{ title: '南京智慧农业采购项目招标公告', url, snippet: '江苏 智慧农业，投标截止2026-11-20' }])).run({}, exec()));
    expect(result.items).toEqual([]);
    expect(result.leads).toHaveLength(1);
    expect(result.state).toBe('unverified');
  });
  it('网络与空结果分开，来源失败码不带服务商原始错误或密钥', async () => {
    const fail = async () => { throw Object.assign(new Error('secret-do-not-echo'), { code: 'ETIMEDOUT' }); };
    const value = await tool({ fetchViaGateway: fail }, { search: fail }).run({}, exec());
    expect(JSON.parse(value).state).toBe('unavailable');
    expect(value).not.toContain('secret-do-not-echo');
    expect(JSON.parse(await tool({ fetchViaGateway: async () => new Response('') }).run({}, exec())).state).toBe('empty');
  });
  it('提前停止和零预算均不发网络请求', async () => {
    const fetch = vi.fn(); const search = engine([]); const t = tool({ fetchViaGateway: fetch }, search);
    const controller = new AbortController(); controller.abort();
    await expect(t.run({}, { ...exec(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const execution = exec(); execution.retrieval.consume = () => { throw Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' }); };
    await expect(t.run({}, execution)).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
    expect(fetch).not.toHaveBeenCalled(); expect(search.search).not.toHaveBeenCalled();
  });
  it('网页正文独立存储，不用短回执覆盖已经存下的原文', async () => {
    const saved = mockEvidence();
    const value = JSON.parse(await tool({ businessEvidence: saved, fetchViaGateway: async () => new Response(''), businessReadPage: async () => body() }, engine([{ title: '南京智慧农业采购项目招标公告', url, snippet: '南京 江苏 智慧农业' }])).run({}, exec()));
    expect(value.items[0].evidenceId).toBe('e0');
    expect(saved.put.mock.calls.flatMap(call => call[1].sources).filter(row => row.url === url)).toHaveLength(1);
    expect(saved.put.mock.calls[0][0]).toBe('session-a');
    expect(saved.put.mock.calls[0][1].sources[0].text).toContain('资格要求');
  });
  it('拒绝非官方URL和没有公告正文的验证页', async () => {
    const read = vi.fn(async () => '请完成验证码');
    const t = tool({ businessReadPage: read }, null, 'read_tender_notice');
    await expect(t.run({ url: 'http://127.0.0.1/private' }, exec())).rejects.toMatchObject({ code: 'TENDER_SOURCE' });
    expect(read).not.toHaveBeenCalled();
    await expect(t.run({ url }, exec())).rejects.toMatchObject({ code: 'TENDER_NO_BODY' });
  });
});

describe('可选企百科与新智能体目录', () => {
  const config = { key: 'fixture-qibook-secret', baseUrl: 'https://skill.qibook.com' };
  it('只取指定模块、限制数量，不回传密钥或未请求的全量数据', async () => {
    const get = vi.fn(async (_url, init) => {
      expect(init).toMatchObject({ redirect: 'error', headers: { access_key: config.key } });
      return Response.json({ code: 200, data: { ENT_INFO: { BASIC: { ENTNAME: '测试企业', CREDITCODE: 'fixture-code' }, SHAREHOLDER: Array.from({ length: 30 }, () => ({ SHANAME: '甲企业', FUNDEDRATIO: '20%', SECRET: 'should-not-return' })), PERSON: [{ PERNAME: '不应混入' }] } } });
    });
    const result = await queryQibookCompany('测试企业', 'shareholders', { config, get });
    expect(result.rows).toHaveLength(10); expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/fixture-qibook-secret|should-not-return|不应混入/);
  });
  it('鉴权失败不冒充公司不存在', async () => {
    await expect(queryQibookCompany('测试企业', 'basic', { config, get: async () => new Response('', { status: 401 }) })).rejects.toMatchObject({ code: 'QIBOOK_HTTP', status: 401 });
    await expect(queryQibookCompany('测试企业', 'basic', { config, get: async () => Response.json({ code: 403, msg: config.key }) })).rejects.toMatchObject({ code: 'QIBOOK_REJECTED' });
  });
  it('默认公开检索不调用企百科；明确选择后失败可返回公开线索', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 401 }));
    const t = tool({ qibookAccessKey: config.key, qibookBaseUrl: config.baseUrl, fetchViaGateway: fetch }, engine([{ title: '测试企业2026年报告', url: 'https://www.cninfo.com.cn/new/a', snippet: '测试企业 股东相关资料' }]), 'lookup_company');
    expect(JSON.parse(await t.run({ company: '测试企业' }, exec())).items).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    await expect(t.run({ company: '测试企业', source: 'qibook' }, exec())).rejects.toMatchObject({ code: 'QIBOOK_NOT_SELECTED' });
    const value = JSON.parse(await t.run({ company: '测试企业', source: 'qibook' }, { ...exec(), requestText: '用企百科查询测试企业' }));
    expect(value.items).toHaveLength(1); expect(value.warnings[0]).toMatchObject({ source: '企百科', code: 'QIBOOK_HTTP', status: 401 });
  });
  it('密钥掩码/留空保留，拒绝HTTP和带凭据的地址，不从环境取旧Key', () => {
    const old = { qibookAccessKey: config.key, qibookBaseUrl: config.baseUrl };
    const masked = maskConfig(old); expect(masked.qibookAccessKey).toBe('••••cret');
    expect(JSON.stringify(masked)).not.toContain(config.key);
    expect(mergeConfig(old, { qibookAccessKey: '' }).qibookAccessKey).toBe(config.key);
    expect(mergeConfig(old, masked).qibookAccessKey).toBe(config.key);
    expect(() => mergeConfig(old, { qibookBaseUrl: 'http://bad.test' })).toThrow();
    expect(() => qibookConfig({ ...old, qibookBaseUrl: 'https://name:secret@bad.test' })).toThrow();
  });
  it('原40/80题基线保持；新目录实际包含第9项，全部工具已实现', async () => {
    expect(BUILTIN_AGENTS).toHaveLength(8); expect(ALL_BUILTIN_AGENTS).toHaveLength(9);
    expect(validateProfile(BUSINESS_AGENT)).toEqual(BUSINESS_AGENT);
    const names = createTools({ fetchViaGateway: vi.fn() }).map(t => t.name);
    for (const name of BUSINESS_AGENT.tools) expect(names, name).toContain(name);
    const registry = createAgentRegistry({ get: async () => null });
    expect((await registry.listAgents({ query: '招投标' })).map(row => row.id)).toContain('business-intelligence');
    await expect(async () => registry.removeAgent(BUSINESS_AGENT.id)).rejects.toMatchObject({ status: 409 });
    expect(taskToolCore({}, '查询招标公告').has('search_tenders')).toBe(true);
    expect(taskToolCore({}, '你好').has('search_tenders')).toBe(false);
  });
});

describe('真实联网发现的问题与升级保护', () => {
  it('提到企百科或明确不用时不算选用收费来源，表单和明确使用指令才算', () => {
    for (const text of ['企百科是什么', '企百科收费吗', '别用企百科，查公开来源', '不要用企百科（用户选择：企业资料 企百科（需配置，可能计费））']) expect(qibookSelected(text)).toBe(false);
    for (const text of ['用企百科查测试企业股东', '查股东\n\n（用户选择：地区 江苏；企业资料 企百科（需配置，可能计费））']) expect(qibookSelected(text)).toBe(true);
  });
  it('公共资源平台真实列表24项，日期来自页面、截断标题有标记、地区和公告阶段分开', () => {
    const html = fixture('business-ggzy-list-20261111.html');
    const rows = parseGgzyListing(html);
    expect(rows).toHaveLength(24);
    expect(rows[0]).toMatchObject({ publishedAt: '2026-11-11', region: '湖北', type: 'tender', titleTruncated: true });
    expect(rows.find(row => row.title.includes('施甸县'))).toMatchObject({ region: '云南', type: 'tender', titleTruncated: false });
    expect(rows.filter(row => row.type === 'award')).toHaveLength(12);
    expect(parseGgzyListing(html.replaceAll('<span>2026-11-11</span>', '<span>日期未知</span>'))).toEqual([]);
  });
  it('采购网403不阻断公共资源平台，保留失败源和可用结果', async () => {
    const get = vi.fn(async u => u.includes('ccgp') ? new Response('', { status: 403 }) : new Response(fixture('business-ggzy-list-20261111.html')));
    const result = JSON.parse(await tool({ fetchViaGateway: get }, null).run({ period: 'today', region: '云南', notice_type: 'tender' }, exec()));
    expect(result.state).toBe('ok');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every(row => row.source === '全国公共资源交易平台' && row.type === 'tender')).toBe(true);
    expect(result.warnings).toEqual([{ source: '中国政府采购网最新列表', code: 'TENDER_LIST_HTTP', status: 403 }]);
  });
  it('部分来源失败加空结果必须标partial，不能冒充确定没有项目', async () => {
    let count = 0;
    const search = { search: async () => { if (count++ === 0) throw Object.assign(new Error('offline'), { code: 'ETIMEDOUT' }); return []; } };
    const value = JSON.parse(await tool({ fetchViaGateway: async () => new Response('') }, search).run({}, exec()));
    expect(value.state).toBe('partial'); expect(value.items).toEqual([]);
  });
  it('企业资料排除汇款和第三方工程，去掉搜索摘要里的JSON布局碎片', () => {
    expect(noticeMatches({ title: '天津设备采购合同公告', snippet: '智慧农业设备，供应商位于江苏' }, { query: '智慧农业', region: '江苏' })).toBe(false);
    expect(noticeMatches({ title: '智慧农业设备采购公告', snippet: '项目所在地：江苏南京；供应商全国' }, { query: '智慧农业', region: '江苏' })).toBe(true);
    expect(businessSnippet('企业简介"}],"clamp":2}],"isPc":true')).toBe('企业简介');
    for (const title of ['责令退回培训补贴决定书', '连云港电梯工程项目', '某借款人失信公告']) {
      expect(companyMatches({ title, snippet: '统一社会信用代码:9132xxx；汇款到江苏银行，公司地址xxx' }, '江苏银行', 'basic')).toBe(false);
    }
    expect(companyMatches({ title: '江苏银行2026年度报告', snippet: '基本信息、股东' }, '江苏银行', 'shareholders')).toBe(true);
    expect(companyMatches({ title: '江苏银行装修招标公告', snippet: '采购人统一社会信用代码' }, '江苏银行', 'shareholders')).toBe(false);
  });
  it('升级前同ID个人智能体保留可读可编辑，不能接管其历史对话', async () => {
    const personal = { ...structuredClone(BUILTIN_AGENTS[0]), id: BUSINESS_AGENT.id, source: 'user', name: '我原有的企业助手' };
    let record = { id: PROFILE_STORE_KEY, version: 1, items: [personal] };
    const registry = createAgentRegistry({ get: async () => structuredClone(record), put: async row => { record = structuredClone(row); } });
    expect(await registry.getAgent(personal.id)).toEqual(personal);
    expect((await registry.listAgents()).filter(row => row.id === personal.id)).toEqual([personal]);
    await registry.updateAgent(personal.id, { ...personal, name: '我自己的名称' });
    expect((await registry.getAgent(personal.id)).name).toBe('我自己的名称');
    await registry.removeAgent(personal.id);
    expect(await registry.getAgent(personal.id)).toEqual(BUSINESS_AGENT);
  });
});

it('公共资源聚合入口必须继续读取同公告公开正文，导航页不能计为原文', async () => {
  const entry = 'https://www.ggzy.gov.cn/information/deal/html/a/420000/0101/20261111/004267fa09abe7d64bd29989c05e192ae8d7.html';
  const bodyUrl = entry.replace('/html/a/', '/html/b/');
  const reader = vi.fn(async address => {
    expect(address).toBe(bodyUrl);
    return htmlToText(fixture('business-ggzy-body-20261111.html'));
  });
  const t = tool({ fetchViaGateway: async () => new Response(fixture('business-ggzy-entry-20261111.html')), businessReadPage: reader }, null, 'read_tender_notice');
  const result = JSON.parse(await t.run({ url: entry }, exec()));
  expect(result).toMatchObject({ title: '老泵站河区域面源及溢流污染控制(调蓄池+配套管网)EPC总承包（第一标段）', bodyUrl, publishedAt: '2026-11-11', evidence: 'original_page', budgetText: null, deadlineText: null });
  expect(result.excerpt).toContain('资格');
  expect(result.excerpt).toContain('招标');
  expect(reader).toHaveBeenCalledTimes(1);
  for (const html of [fixture('business-ggzy-entry-20261111.html').replaceAll('/html/b/', '/html/other/'), '<html>暂无数据</html>']) {
    await expect(tool({ fetchViaGateway: async () => new Response(html), businessReadPage: reader }, null, 'read_tender_notice').run({ url: entry }, exec())).rejects.toMatchObject({ code: 'TENDER_NO_BODY' });
  }
});
it('只有项目编号和网站导航不能称为公告正文，紧邻来源不并入项目编号', async () => {
  const navigation = '项目编号：ABC信息来源：某交易平台\n' + '首页 交易公开 工程建设 网站地图 '.repeat(12);
  await expect(tool({ businessReadPage: async () => navigation }, null, 'read_tender_notice').run({ url }, exec())).rejects.toMatchObject({ code: 'TENDER_NO_BODY' });
  expect(parseTenderNotice(navigation, { url }).projectNumber).toBe('ABC');
});
