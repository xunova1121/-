import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSearchTest } from '../server/searchTest.mjs';
const response = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const options = { deepseekSearchEnabled: true, deepseekSearchKey: 'fake-test-key' };

describe('服务器搜索测试边界', () => {
  it('只使用服务器保存的Key，不采用请求体中的Key或地址', async () => {
    const fetchViaGateway = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.deepseek.com/v1/tools/search');
      expect(init.headers.Authorization).toBe('Bearer server-only-key');
      return response({ results: [] });
    });
    const json = vi.fn();
    const handle = createSearchTest({
      getConfig: () => ({ deepseekSearchEnabled: true, deepseekSearchKey: 'server-only-key' }),
      readJson: async () => ({ kind: 'search', key: 'phone-key', url: 'https://other.invalid' }),
      json,
      fetchViaGateway
    });
    await handle({}, new EventEmitter());
    expect(json.mock.calls[0][1]).toBe(200);
    expect(JSON.stringify(json.mock.calls)).not.toContain('server-only-key');
    expect(fetchViaGateway).toHaveBeenCalledTimes(1);
  });

  it('上游401映射为502，不能触发手机清除未央登录', async () => {
    const json = vi.fn();
    const handle = createSearchTest({
      getConfig: () => options,
      readJson: async () => ({ kind: 'fetch' }),
      json,
      fetchViaGateway: async () => new Response('', { status: 401 })
    });
    await handle({}, new EventEmitter());
    expect(json.mock.calls[0][1]).toBe(502);
    expect(json.mock.calls[0][2]).toMatchObject({ upstreamStatus: 401, kind: 'api' });
  });
});
