/** 服务档位：TeamoRouter 的快速档是 model: gpt-5.6-luna + service_tier: "fast"（不是 gpt-5.6-luna-fast 这个型号名），Responses 和 Chat Completions 都支持 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAdapter, serviceTierOf, protocolFor } from '../src/llm/config.js';
import { copyModelSettings } from '../src/llm/modelLibrary.js';

const sse = (text) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const cfg = (extra = {}) => ({ provider: 'relay-multi', models: { 'relay-multi': 'gpt-5.6-luna' }, keys: { 'relay-multi': 'sk-t' }, baseURLs: { 'relay-multi': 'https://api.teamorouter.com/v1' }, ...extra });
afterEach(() => vi.unstubAllGlobals());

describe('服务档位', () => {
  // TeamoRouter 说明里 /v1/responses 和 /v1/chat/completions 都支持 service_tier: "fast"：GPT 照旧走 Responses（保留自带联网搜索）
  const responsesSse = (text, tier) => new Response([
    { type: 'response.created', response: { service_tier: tier } },
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { service_tier: tier, output: [] } }
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  it('填了 fast：GPT 走 Responses，请求里带 service_tier: "fast"，读回实际档位', async () => {
    const seen = [];
    vi.stubGlobal('fetch', async (url, init) => { seen.push({ url: String(url), body: JSON.parse(init.body) }); return responsesSse('你好', 'fast'); });
    const { adapter, model } = createAdapter(cfg({ serviceTiers: { 'relay-multi': 'fast' } }));
    const r = await adapter.stream({ model, system: ['s'], messages: [{ role: 'user', content: 'Hello' }], tools: [], onText: () => {} });
    expect(r.text).toBe('你好');
    expect(seen[0].url).toBe('https://api.teamorouter.com/v1/responses');
    expect(seen[0].body).toMatchObject({ model: 'gpt-5.6-luna', service_tier: 'fast' });
    expect(r.tier).toEqual({ asked: 'fast', sent: true, served: 'fast' });
  });
  it('Responses 不认 service_tier：去掉再发一次，标成没发出去', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return body.service_tier ? new Response('{"error":{"message":"Unsupported parameter: service_tier"}}', { status: 400 }) : responsesSse('好', 'default');
    });
    const { adapter, model } = createAdapter(cfg({ serviceTiers: { 'relay-multi': 'fast' } }));
    const r = await adapter.stream({ model, system: ['s'], messages: [{ role: 'user', content: 'hi' }], tools: [], onText: () => {} });
    expect(bodies.map((b) => b.service_tier)).toEqual(['fast', undefined]);
    expect(r.tier).toMatchObject({ asked: 'fast', sent: false });
  });
  it('没填：和以前一样（GPT 走 Responses，不带 service_tier）', () => {
    expect(serviceTierOf(cfg(), 'relay-multi')).toBe('');
    expect(protocolFor('gpt-5.6-luna')).toBe('responses');
    expect(createAdapter(cfg()).adapter.kind).toBe('openai-responses');
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

describe('快速档有没有生效：回答底下看得到', () => {
  const sseTier = (text, tier) => new Response(`data: ${JSON.stringify({ service_tier: tier, choices: [{ delta: { content: text } }] })}\n\ndata: {"service_tier":"${tier}","choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  const run = async (fetchImpl) => {
    vi.stubGlobal('fetch', fetchImpl);
    const { adapter, model } = createAdapter({ provider: 'custom', models: { custom: `tier-${Math.random()}` }, keys: { custom: 'k' }, baseURLs: { custom: 'https://relay.example/v1' }, serviceTiers: { custom: 'fast' } });
    return adapter.stream({ model, system: ['s'], messages: [{ role: 'user', content: 'hi' }], tools: [], onText: () => {} });
  };
  it('服务商回报按 fast 处理：生效', async () => {
    expect((await run(async () => sseTier('好', 'fast'))).tier).toEqual({ asked: 'fast', sent: true, served: 'fast' });
  });
  it('服务商回报按 default 处理：没生效（看得出来）', async () => {
    expect((await run(async () => sseTier('好', 'default'))).tier).toEqual({ asked: 'fast', sent: true, served: 'default' });
  });
  it('服务商不认参数、去掉后才成功：标成没发出去', async () => {
    const r = await run(async (url, init) => (JSON.parse(init.body).service_tier ? new Response('{"error":{"message":"unknown parameter service_tier"}}', { status: 400 }) : sseTier('好', 'default')));
    expect(r.tier).toMatchObject({ asked: 'fast', sent: false });
  });
  it('没填档位：结果里不带 tier', async () => {
    vi.stubGlobal('fetch', async () => sseTier('好', 'default'));
    const { adapter, model } = createAdapter({ provider: 'custom', models: { custom: 'no-tier' }, keys: { custom: 'k' }, baseURLs: { custom: 'https://relay.example/v1' } });
    expect((await adapter.stream({ model, system: ['s'], messages: [{ role: 'user', content: 'hi' }], tools: [], onText: () => {} })).tier).toBeUndefined();
  });
});

describe('智能体把档位结果告诉界面', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  it('模型回报了档位：发出 tier 事件（服务器模式也会转给手机）', async () => {
    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
    const agent = await import('../src/agent/agent.js');
    const events = [];
    const adapter = { async stream({ onText }) { onText('好'); return { text: '好', toolCalls: [], stop: 'end_turn', tier: { asked: 'fast', sent: true, served: 'default' } }; } };
    await agent.runAgent({ adapter, model: 'gpt-5.6-luna', history: [], userText: '你好', tools: [], context: { dynamic: '' }, emit: (e) => events.push(e), quiet: true });
    expect(events.find((e) => e.type === 'tier')).toMatchObject({ asked: 'fast', sent: true, served: 'default' });
    delete globalThis.indexedDB;
  });
});
