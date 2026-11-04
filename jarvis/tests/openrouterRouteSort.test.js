/** 用户 2026-11-04：OpenRouter 同一模型有十几家线路，首字 0.3～3 秒不等。请求带 provider.sort，默认延迟优先，可选出字速度优先、价格优先。 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAdapter, routeSortOf, isOpenRouterLine } from '../src/llm/config.js';
import { copyModelSettings, removeProvider } from '../src/llm/modelLibrary.js';

const sse = (text) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const orCfg = (extra = {}) => ({ provider: 'openrouter', models: { openrouter: 'deepseek/deepseek-v4.1-flash-1017' }, keys: { openrouter: 'sk-or-v1-test' }, baseURLs: {}, ...extra });
const run = async (cfg, fetchImpl) => {
  const bodies = [];
  vi.stubGlobal('fetch', async (url, init) => { const body = JSON.parse(init.body); bodies.push({ url: String(url), body }); return fetchImpl(body); });
  const { adapter, model } = createAdapter(cfg);
  const r = await adapter.stream({ model, system: ['s'], messages: [{ role: 'user', content: '你好' }], tools: [], onText: () => {} });
  return { r, bodies };
};
afterEach(() => vi.unstubAllGlobals());

describe('OpenRouter 线路选择', () => {
  it('默认延迟优先：请求体带 provider.sort = latency', async () => {
    const { r, bodies } = await run(orCfg(), () => sse('好'));
    expect(r.text).toBe('好');
    expect(bodies[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(bodies[0].body.provider).toEqual({ sort: 'latency' });
  });
  it('选了出字速度优先 / 价格优先就照选的发；非法值退回默认', async () => {
    expect((await run(orCfg({ routeSorts: { openrouter: 'throughput' } }), () => sse('好'))).bodies[0].body.provider).toEqual({ sort: 'throughput' });
    expect((await run(orCfg({ routeSorts: { openrouter: 'price' } }), () => sse('好'))).bodies[0].body.provider).toEqual({ sort: 'price' });
    expect(routeSortOf(orCfg({ routeSorts: { openrouter: 'fastest!!' } }), 'openrouter')).toBe('latency');
  });
  it('不是 OpenRouter 的服务商不带 provider 字段；指向 openrouter.ai 的自定义线路也生效', async () => {
    const deepseek = { provider: 'deepseek', models: { deepseek: 'deepseek-chat' }, keys: { deepseek: 'sk-d' }, baseURLs: {}, routeSorts: { deepseek: 'latency' } };
    expect((await run(deepseek, () => sse('好'))).bodies[0].body.provider).toBeUndefined();
    const custom = (url) => ({ provider: 'custom', models: { custom: 'deepseek/deepseek-chat' }, keys: { custom: 'k' }, baseURLs: { custom: url } });
    expect(isOpenRouterLine(custom('https://openrouter.ai/api/v1'), 'custom')).toBe(true);
    expect(isOpenRouterLine(custom('https://openrouter.ai.evil.example/v1'), 'custom')).toBe(false);
    expect(isOpenRouterLine(custom('https://relay.example/v1'), 'custom')).toBe(false);
    expect((await run(custom('https://relay.example/v1'), () => sse('好'))).bodies[0].body.provider).toBeUndefined();
  });
  it('线路不认 provider 参数：去掉再发一次，之后同一型号不再带', async () => {
    const cfg = orCfg({ models: { openrouter: 'route-sort-reject-model' } });
    const reject = (body) => (body.provider ? new Response('{"error":{"message":"Unrecognized request argument: provider"}}', { status: 400 }) : sse('好'));
    const first = await run(cfg, reject);
    expect(first.r.text).toBe('好');
    expect(first.bodies.map((b) => b.body.provider)).toEqual([{ sort: 'latency' }, undefined]);
    const second = await run(cfg, reject);
    expect(second.bodies.map((b) => b.body.provider)).toEqual([undefined]);
  });
  it('与 provider 参数无关的 400 不重试、不去掉线路选择', async () => {
    const cfg = orCfg({ models: { openrouter: 'route-sort-other-400' } });
    await expect(run(cfg, () => new Response('{"error":{"message":"Provider returned error: context length exceeded"}}', { status: 400 }))).rejects.toMatchObject({ status: 400 });
  });
  it('复制到服务器、删服务商时带上/清掉线路选择', () => {
    expect(copyModelSettings(orCfg({ routeSorts: { openrouter: 'price' } })).routeSorts).toEqual({ openrouter: 'price' });
    const cfg = { ...orCfg({ routeSorts: { openrouter: 'price' } }), provider: 'deepseek', models: { deepseek: 'deepseek-chat', openrouter: 'x' } };
    expect(removeProvider(cfg, 'openrouter').routeSorts).toEqual({});
  });
  it('服务器保存：只改一家不清别家；只接受三档固定值', async () => {
    const { mergeConfig } = await import('../server/serverMode.mjs');
    expect(mergeConfig({ keys: {}, routeSorts: { openrouter: 'price' } }, { routeSorts: { custom: 'latency' } }).routeSorts).toEqual({ openrouter: 'price', custom: 'latency' });
    expect(() => mergeConfig({ keys: {} }, { routeSorts: { openrouter: 'nitro; rm -rf' } })).toThrow('OpenRouter 线路选择');
  });
});
