import { describe, expect, it, vi } from 'vitest';
import { createCompanyLookup } from '../src/app/companyLookup.js';
import { createServerClient } from '../src/core/serverClient.js';

const args = { company: '测试企业', section: 'basic', source: 'public' };
const setup = (extra = {}) => {
  const app = { session: {}, server: null, llmConfig: { qibookAccessKey: 'local-only-fixture' }, ...extra };
  const query = vi.fn(async () => ({ state: 'empty', items: [] }));
  const options = { scope: () => 'user-a', query, searchFetch: () => null, nativeTransport: () => null };
  return { app, query, options };
};
describe('企业直查的运行位置与身份隔离', () => {
  it('云端只发送三项查询要求，不向服务器复制本机密钥或降级到本机', async () => {
    const server = { companyQuery: vi.fn(async () => ({ source: '公开资料' })) };
    const { app, query, options } = setup({ server });
    const signal = new AbortController().signal;
    await expect(createCompanyLookup(app, options)(args, signal)).resolves.toEqual({ source: '公开资料' });
    expect(server.companyQuery).toHaveBeenCalledTimes(1);
    expect(server.companyQuery).toHaveBeenCalledWith(args, signal);
    expect(query).not.toHaveBeenCalled();
    expect(JSON.stringify(server.companyQuery.mock.calls)).not.toContain('local-only-fixture');
  });
  it('查询前取消不发请求', async () => {
    const server = { companyQuery: vi.fn() };
    const { app, options } = setup({ server });
    const controller = new AbortController(); controller.abort();
    await expect(createCompanyLookup(app, options)(args, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(server.companyQuery).not.toHaveBeenCalled();
  });
  it.each(['session', 'server', 'identity'])('%s变化后不交付旧位置的查询结果', async field => {
    let resolve, identity = 'user-a';
    const { app, options } = setup({ server: { companyQuery: () => new Promise(r => { resolve = r; }) } });
    options.scope = () => identity;
    const pending = createCompanyLookup(app, options)(args);
    if (field === 'identity') identity = 'user-b'; else app[field] = {};
    resolve({ rows: [{ 企业名称: '不应交付给新会话' }] });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'COMPANY_SCOPE_CHANGED' });
  });
  it('旧服务器404提示更新，不偷偷使用本机密钥重试', async () => {
    const { app, query, options } = setup({ server: { companyQuery: async () => { throw Object.assign(new Error('missing'), { status: 404 }); } } });
    await expect(createCompanyLookup(app, options)(args)).rejects.toMatchObject({ code: 'COMPANY_UPDATE_REQUIRED' });
    expect(query).not.toHaveBeenCalled();
  });
  it('本机公开资料使用本机配置和既有传输，未拼接聊天请求', async () => {
    const get = vi.fn(), search = vi.fn();
    const { app, query, options } = setup({ fetchViaGateway: () => get });
    options.searchFetch = () => search;
    await createCompanyLookup(app, options)(args);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(app.llmConfig, args, { get, openaiSearchFetch: search, signal: undefined });
  });
  it('企百科凭据不能进入会丢请求头的通用网页代理', async () => {
    const { app, query, options } = setup({ gateway: { origin: 'http://localhost:8787' } });
    await expect(createCompanyLookup(app, options)({ ...args, source: 'qibook' })).rejects.toMatchObject({ code: 'COMPANY_GATEWAY_UNSUPPORTED' });
    expect(query).not.toHaveBeenCalled();
  });
  it('安卓可用原生传输时，企百科使用原生请求而非网页代理', async () => {
    const native = vi.fn(), generic = vi.fn();
    const { app, query, options } = setup({ gateway: {}, fetchViaGateway: () => generic });
    options.nativeTransport = () => native;
    await createCompanyLookup(app, options)({ ...args, source: 'qibook' });
    expect(query.mock.calls[0][2].get).toBe(native);
    expect(generic).not.toHaveBeenCalled();
  });
  it('服务器客户端一次POST企业查询，网络失败不重复收费请求', async () => {
    const get = vi.fn(async () => { throw new TypeError('network unavailable'); });
    const client = createServerClient({ base: 'https://cloud.example.com', token: 'a'.repeat(43), fetchImpl: get });
    await expect(client.companyQuery(args)).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe('https://cloud.example.com/api/server/company-query');
    expect(get.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify(args) });
  });
});
