/** 服务档位：TeamoRouter 的快速档是 model: gpt-5.6-luna + service_tier: "fast"（不是 gpt-5.6-luna-fast 这个型号名） */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAdapter, serviceTierOf, protocolFor } from '../src/llm/config.js';
import { copyModelSettings } from '../src/llm/modelLibrary.js';

const sse = (text) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const cfg = (extra = {}) => ({ provider: 'relay-multi', models: { 'relay-multi': 'gpt-5.6-luna' }, keys: { 'relay-multi': 'sk-t' }, baseURLs: { 'relay-multi': 'https://api.teamorouter.com/v1' }, ...extra });
afterEach(() => vi.unstubAllGlobals());

describe('服务档位', () => {
  it('填了 fast：GPT 走 Chat Completions，请求里带 service_tier: "fast"', async () => {
    const seen = [];
    vi.stubGlobal('fetch', async (url, init) => { seen.push({ url: String(url), body: JSON.parse(init.body) }); return sse('你好'); });
    const { adapter, model } = createAdapter(cfg({ serviceTiers: { 'relay-multi': 'fast' } }));
    const r = await adapter.stream({ model, system: ['s'], messages: [{ role: 'user', content: 'Hello' }], tools: [], onText: () => {} });
    expect(r.text).toBe('你好');
    expect(seen[0].url).toBe('https://api.teamorouter.com/v1/chat/completions');
    expect(seen[0].body).toMatchObject({ model: 'gpt-5.6-luna', service_tier: 'fast' });
  });
  it('没填：和以前一样（GPT 走 Responses，不带 service_tier）', () => {
    expect(serviceTierOf(cfg(), 'relay-multi')).toBe('');
    expect(protocolFor('gpt-5.6-luna')).toBe('responses');
    expect(createAdapter(cfg()).adapter.kind).not.toBe('openai');
  });
  it('服务商不认 service_tier：自动去掉再发一次', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return body.service_tier ? new Response('{"error":{"message":"Unrecognized request argument: service_tier"}}', { status: 400 }) : sse('好');
    });
    const { adapter, model } = createAdapter({ provider: 'custom', models: { custom: 'tier-test-model' }, keys: { custom: 'k' }, baseURLs: { custom: 'https://relay.example/v1' }, serviceTiers: { custom: 'fast' } });
    const r = await adapter.stream({ model, system: ['s'], messages: [{ role: 'user', content: 'hi' }], tools: [], onText: () => {} });
    expect(r.text).toBe('好');
    expect(bodies.map((b) => b.service_tier)).toEqual(['fast', undefined]);
  });
  it('复制到服务器时带上服务档位', () => {
    expect(copyModelSettings(cfg({ serviceTiers: { 'relay-multi': 'fast' } })).serviceTiers).toEqual({ 'relay-multi': 'fast' });
  });
  it('服务器保存配置时，只改一家的档位不会把别家的清掉', async () => {
    const { mergeConfig } = await import('../server/serverMode.mjs');
    expect(mergeConfig({ keys: {}, serviceTiers: { a: 'fast' } }, { serviceTiers: { b: 'flex' } }).serviceTiers).toEqual({ a: 'fast', b: 'flex' });
  });
});
