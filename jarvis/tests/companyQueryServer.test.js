import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';
import { runCompanyLookup, validateCompanyQuery } from '../src/agent/companyQuery.js';

const company = '江苏天合云商股份有限公司';
const password = 'company-query-fixture-password';
const owner = tokenFor(password);
const config = {
  provider: 'mock', keys: { deepseek: 'chat-only-never-used', custom: 'chat-key-never-used' }, searchRegion: 'cn',
  openaiSearchEnabled: true, openaiSearchBaseURL: 'https://search.company.example/v1', openaiSearchKey: 'server-search-only', openaiSearchModel: 'search-model',
  qibookAccessKey: 'server-qibook-only', qibookBaseUrl: 'https://skill.qibook.com'
};
let dir, mode, server, base, memberA, memberB;
let block = false, blocked = 0, cancelled = 0;
const get = vi.fn(async (address, init = {}) => {
  const url = new URL(address);
  if (url.hostname === 'skill.qibook.com') {
    expect(init.headers.access_key).toBe(config.qibookAccessKey);
    if (block && url.searchParams.get('entmark') === '阻塞企业') {
      blocked++;
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => { cancelled++; reject(init.signal.reason); }, { once: true }));
    }
    return Response.json({ code: 200, data: { ENT_INFO: { BASIC: { ENTNAME: url.searchParams.get('entmark'), CREDITCODE: 'fixture-credit-code', OPSCOPE: '供应链服务' }, SHAREHOLDER: [{ SHANAME: '资料中的股东', FUNDEDRATIO: '20%' }] } } });
  }
  expect(url.href).toBe('https://search.company.example/v1/responses');
  expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer server-search-only' } });
  const body = JSON.parse(init.body);
  expect(body.model).toBe('search-model');
  return Response.json({ search_results: [{ title: `${company}公司简介`, url: 'https://www.jiangsu.gov.cn/company', snippet: `${company}主营供应链服务。` }] });
});
const api = (token, route = '/api/server/company-query', method = 'POST', body = { company, section: 'basic', source: 'public' }, extra = {}) => fetch(base + route, {
  method, ...extra, headers: { ...(token && { Authorization: 'Bearer ' + token }), ...(body !== undefined && { 'Content-Type': 'application/json' }), ...extra.headers },
  ...(body !== undefined && !['GET', 'HEAD', 'OPTIONS'].includes(method) && { body: typeof body === 'string' ? body : JSON.stringify(body) })
});
const result = async (...args) => { const response = await api(...args); expect(response.status).toBe(200); return response.json(); };
const until = async test => {
  const started = Date.now();
  while (!test()) { if (Date.now() - started > 2000) throw new Error('等待测试状态超时'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-query-http-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  mode = createServerMode({ dataDir: dir, password, searchFetch: get });
  await mode.ready;
  server = createServer({ serverMode: mode });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
  for (const label of ['企业查询甲', '企业查询乙']) {
    const member = await result(owner, '/api/server/users', 'POST', { name: label });
    const login = await result('', '/api/server/login', 'POST', { password: member.accessCode });
    if (!memberA) memberA = login.token; else memberB = login.token;
  }
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await mode?.runner.settled();
  useBackend(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('企业表单直查HTTP路由', () => {
  it('owner与member可直接查公开资料，不启动聊天任务、不存会话或证据', async () => {
    const before = mode.runner.list().length;
    for (const token of [owner, memberA]) {
      const data = await result(token);
      expect(data).toMatchObject({ company, state: 'unverified', dataRetrieved: true, source: '公开资料' });
      expect(data.items[0]).toMatchObject({ evidence: 'search_summary' });
      expect(data.items[0]).not.toHaveProperty('evidenceId');
      expect(JSON.stringify(data)).not.toMatch(/server-search-only|server-qibook-only|chat-only|chat-key|openaiSearchKey|config/);
      expect(await result(token, '/api/sessions', 'GET', undefined)).toEqual([]);
    }
    expect(mode.runner.list()).toHaveLength(before);
  });

  it('只有明确选择企百科才请求收费资料，保留非实时和非最终实控人说明', async () => {
    get.mockClear();
    const data = await result(memberA, undefined, 'POST', { company, section: 'shareholders', source: 'qibook' });
    expect(data).toMatchObject({ source: '企百科', section: 'shareholders', dataRetrieved: true });
    expect(data.rows).toEqual([{ 股东名称: '资料中的股东', 出资比例: '20%' }]);
    expect(data.note).toMatch(/不能保证实时/);
    expect(data.note).toMatch(/不等于最终实际控制人/);
    expect(get).toHaveBeenCalledTimes(1);
    expect(new URL(get.mock.calls[0][0]).hostname).toBe('skill.qibook.com');
    get.mockClear();
    await result(owner);
    expect(get.mock.calls.every(([url]) => new URL(url).hostname !== 'skill.qibook.com')).toBe(true);
  });

  it('匿名401，评测令牌403，不通过独立入口绕过任务评测额度', async () => {
    get.mockClear();
    expect((await api('')).status).toBe(401);
    const evaluation = await result(owner, '/api/server/security/evaluations', 'POST', { name: '企业直查边界', days: 1, dailyLimit: 1 });
    expect((await api(evaluation.token)).status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['key', 'url', 'owner', 'userId', 'sessionId', 'evaluationId'])('拒绝请求体越权字段%s，不能改变来源、密钥或证据归属', async field => {
    get.mockClear();
    const response = await api(memberA, undefined, 'POST', { company, section: 'basic', source: 'public', [field]: 'must-not-use' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'COMPANY_QUERY_INPUT' });
    expect(get).not.toHaveBeenCalled();
  });

  it('非法名称、类型、来源及JSON都返回受控400，过大请求413', async () => {
    get.mockClear();
    for (const body of [{ company: '' }, { company: '长'.repeat(101) }, { company, section: 'news' }, { company, source: 'custom' }, '{invalid']) {
      const response = await api(owner, undefined, 'POST', body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'COMPANY_QUERY_INPUT' });
    }
    expect((await api(owner, undefined, 'POST', { company: '长'.repeat(5000) })).status).toBe(413);
    expect((await api(owner, undefined, 'GET', undefined)).status).toBe(405);
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['null', 'http://localhost', 'https://localhost', 'capacitor://localhost'])('Windows/Android来源%s的预检和POST延用服务器跨域许可', async origin => {
    const preflight = await api('', undefined, 'OPTIONS', undefined, { headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    const response = await api(memberA, undefined, 'POST', { company, source: 'public', section: 'basic' }, { headers: { Origin: origin } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('每个用户最多两个并发、用户间独立；断开请求取消上游并释放名额', async () => {
    block = true;
    blocked = 0; cancelled = 0;
    const controllers = [new AbortController(), new AbortController()];
    const pending = controllers.map(controller => api(memberA, undefined, 'POST', { company: '阻塞企业', section: 'basic', source: 'qibook' }, { signal: controller.signal }).catch(error => error));
    try {
      await until(() => blocked === 2);
      const busy = await api(memberA);
      expect(busy.status).toBe(429);
      expect(await busy.json()).toMatchObject({ code: 'COMPANY_QUERY_BUSY' });
      expect((await api(memberB, undefined, 'POST', { company, section: 'basic', source: 'qibook' })).status).toBe(200);
      controllers[0].abort();
      await until(() => cancelled >= 1);
      expect((await api(memberA, undefined, 'POST', { company, section: 'basic', source: 'qibook' })).status).toBe(200);
    } finally {
      controllers.forEach(controller => controller.abort());
      await Promise.all(pending);
      await until(() => cancelled === 2);
      block = false;
    }
  });

  it('撤销成员授权会取消其在途企业查询，不能继续消费服务商接口', async () => {
    const member = await result(owner, '/api/server/users', 'POST', { name: '可撤销企业查询' });
    const login = await result('', '/api/server/login', 'POST', { password: member.accessCode });
    block = true; blocked = 0; cancelled = 0;
    const pending = api(login.token, undefined, 'POST', { company: '阻塞企业', source: 'qibook' });
    try {
      await until(() => blocked === 1);
      await result(owner, '/api/server/users/' + member.id, 'PATCH', { action: 'disable' });
      const response = await pending;
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'COMPANY_QUERY_REVOKED' });
      expect(cancelled).toBe(1);
    } finally { block = false; }
  });
});

describe('企业直查纯逻辑边界', () => {
  it('不借用聊天Key、不保存证据；上游回显已知凭据也脱敏', async () => {
    const transport = vi.fn(async (_url, init) => {
      expect(init.headers.access_key).toBe(config.qibookAccessKey);
      return Response.json({ code: 200, data: { ENT_INFO: { BASIC: { ENTNAME: company, OPSCOPE: '上游异常回显：' + config.qibookAccessKey } } } });
    });
    const data = await runCompanyLookup(config, { company, source: 'qibook' }, { get: transport });
    expect(JSON.stringify(data)).not.toContain(config.qibookAccessKey);
    expect(JSON.stringify(data)).toContain('[已隐藏]');
    expect(data).not.toHaveProperty('sessionId');
  });

  it('只填DeepSeek聊天Key不会自动借它发搜索请求', async () => {
    const transport = vi.fn(async () => new Response('<html><body>暂无结果</body></html>'));
    const pending = runCompanyLookup({ searchRegion: 'cn', keys: { deepseek: 'chat-only-never-used' }, deepseekSearchEnabled: true }, { company }, { get: transport });
    await pending.catch(error => { expect(error.code).toBe('RETRIEVAL_BUDGET'); });
    expect(transport.mock.calls.every(([url]) => !String(url).includes('api.deepseek.com'))).toBe(true);
    expect(JSON.stringify(transport.mock.calls)).not.toContain('chat-only-never-used');
  });

  it('免费与收费来源轮换也受12次实际请求上限约束', async () => {
    const transport = vi.fn(async () => Response.json({ search_results: [], results: [], data: {} }));
    const all = { ...config, deepseekSearchEnabled: true, deepseekSearchKey: 'separate-search', bochaKey: 'separate-bocha', tavilyKey: 'separate-tavily', qianfanSearchKey: 'separate-qianfan' };
    await expect(runCompanyLookup(all, { company }, { get: transport })).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
    expect(transport.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it.each(['RETRIEVAL_BUDGET', 'EVAL_QUOTA', 'EVAL_EXPIRED'])('控制信号%s不变成空资料也不继续兜底', async code => {
    const error = Object.assign(new Error('受控上限'), { code });
    const transport = vi.fn(async () => { throw error; });
    await expect(runCompanyLookup(config, { company, source: 'qibook' }, { get: transport })).rejects.toBe(error);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('期限到达会取消真实在途请求并抛预算错误', async () => {
    let aborted = false;
    const transport = vi.fn(async (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); }, { once: true })));
    await expect(runCompanyLookup(config, { company, source: 'qibook' }, { get: transport, timeBudgetMs: 20 })).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
    expect(aborted).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('验证默认公开来源，控制字符及原型字段均不能通过', () => {
    expect(validateCompanyQuery({ company: '  测试企业  ' })).toEqual({ company: '测试企业', section: 'basic', source: 'public' });
    for (const args of [null, [], { company: '企业\n额外指令' }, JSON.parse('{"company":"企业","__proto__":{}}')]) expect(() => validateCompanyQuery(args)).toThrow();
  });
});
