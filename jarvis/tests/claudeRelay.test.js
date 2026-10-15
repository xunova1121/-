import { describe, it, expect } from 'vitest';
import { createAnthropicAdapter } from '../src/llm/anthropic.js';
import { createAdapter, providerById } from '../src/llm/config.js';
import { keyedProviders } from '../src/llm/router.js';

/** 假客户端：rejectIf 返回 true 的请求报 400；否则回一句话 */
function fakeClient(rejectIf) {
  const seen = [];
  return {
    seen,
    beta: { messages: { stream(params) {
      seen.push(params);
      if (rejectIf(params)) throw Object.assign(new Error('bad request'), { status: 400 });
      const events = [{ type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } }];
      return {
        async *[Symbol.asyncIterator]() { yield* events; },
        finalMessage: async () => ({ content: [{ type: 'text', text: '好' }], stop_reason: 'end_turn' })
      };
    } } }
  };
}
const req = { model: 'claude-sonnet-5-5', system: ['s', ''], messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', description: 'd', input_schema: { type: 'object', properties: {} } }] };

describe('Claude 中转（Anthropic 原生格式）', () => {
  it('中转站不认新参数：去掉后重试，联网搜索保留', async () => {
    const c = fakeClient((p) => Boolean(p.output_config));
    const a = createAnthropicAdapter({ client: c, webSearch: true, compat: true });
    const r = await a.stream(req);
    expect(r.text).toBe('好');
    expect(c.seen).toHaveLength(2);
    expect(c.seen[1].output_config).toBeUndefined();
    expect(c.seen[1].tools.some((t) => t.name === 'web_search')).toBe(true);
    expect(a.webSearchOn).toBe(true);
    await a.stream(req); // 记住能用的档位，不再先试一次
    expect(c.seen).toHaveLength(3);
  });
  it('联网搜索也不支持：最后才去掉', async () => {
    const c = fakeClient((p) => p.tools.some((t) => t.name === 'web_search'));
    const a = createAnthropicAdapter({ client: c, webSearch: true, compat: true });
    expect((await a.stream(req)).text).toBe('好');
    expect(c.seen).toHaveLength(3);
    expect(a.webSearchOn).toBe(false);
  });
  it('官方接口不降级（报错照常抛出）', async () => {
    const a = createAnthropicAdapter({ client: fakeClient(() => true), webSearch: true });
    await expect(a.stream(req)).rejects.toThrow('bad request');
  });
  it('设置：地址按服务商分开存；没填地址时提示', () => {
    expect(providerById('claude-relay')).toMatchObject({ kind: 'anthropic', custom: true });
    const cfg = { provider: 'claude-relay', keys: { 'claude-relay': 'sk-teamo-x' }, baseURLs: { custom: 'https://other/v1' }, models: {} };
    expect(createAdapter(cfg).problem).toMatch(/接口地址/);
    const ok = createAdapter({ ...cfg, baseURLs: { ...cfg.baseURLs, 'claude-relay': 'https://api.teamorouter.com/v1/' } });
    expect(ok.problem).toBeUndefined();
    expect(ok.adapter.kind).toBe('anthropic');
    expect(keyedProviders({ ...cfg, provider: 'custom', baseURLs: { ...cfg.baseURLs, 'claude-relay': 'https://api.teamorouter.com' } })).toContain('claude-relay');
  });
});
