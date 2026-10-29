/** 30 题评测：每次模型调用的明细（用途、型号、耗时、Token），重写规则、后台调用单独计数；不记内容 */
import { describe, it, expect } from 'vitest';
import { createTaskTiming } from '../shared/taskTiming.js';
import { createAccumulator, tokenUsage } from '../src/llm/openai.js';
import { callPurpose, rewriteRule } from '../src/agent/agent.js';

describe('Token 用量', () => {
  it('OpenAI / DeepSeek 两种写法都认；没给就是 null，不当成 0', () => {
    expect(tokenUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } })).toEqual({ input: 100, output: 20, cached: 60 });
    expect(tokenUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 80 })).toEqual({ input: 100, output: 20, cached: 80 });
    expect(tokenUsage({})).toBeNull();
    const acc = createAccumulator();
    acc.push({ choices: [{ delta: { content: '好' } }] });
    expect(acc.result().usage).toBeUndefined();
    acc.push({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } });
    expect(acc.result().usage).toEqual({ input: 9, output: 3, cached: null });
  });
});

describe('调用用途和重写规则', () => {
  it('按对话最后一条判断用途', () => {
    expect(callPurpose([{ role: 'user', content: '你好' }])).toBe('answer');
    expect(callPurpose([{ role: 'tool', content: 'x' }])).toBe('after_tools');
    expect(callPurpose([{ role: 'user', content: '（系统交付检查，仅修正…' }])).toBe('rewrite');
    expect(callPurpose([{ role: 'user', content: '（以下是系统自动核对，不是用户说的话' }])).toBe('finish_check');
    expect(callPurpose([], true)).toBe('closing');
  });
  it('核对问题归到规则名', () => {
    expect(rewriteRule('回答说做到了，但读回文件对不上')).toBe('style_claim');
    expect(rewriteRule('“请医生评估 / 以医生为准”这类提醒出现了3次')).toBe('care_deferral');
    expect(rewriteRule('莫名的问题')).toBe('other');
  });
});

describe('调用明细', () => {
  it('主循环、辅助、看图、后台记忆、备用模型各自成行；重写按规则计数；Token 有缺就合计为 null', () => {
    let t = 0;
    const timing = createTaskTiming(0, () => t);
    timing.start();
    t = 10; timing.event({ type: 'diagnostic', phase: 'model_start', model: 'sol', purpose: 'answer', inputChars: 5 });
    t = 30; timing.event({ type: 'diagnostic', phase: 'model_end', resultKind: 'tools', usage: { input: 100, output: 10, cached: 50 } });
    t = 31; timing.event({ type: 'diagnostic', phase: 'helper_start', id: 'h1-vision', purpose: 'vision', model: 'qwen-vl', inputChars: 3 });
    t = 41; timing.event({ type: 'diagnostic', phase: 'helper_end', id: 'h1-vision', ok: true, usage: { input: 40, output: 5, cached: null } });
    t = 42; timing.event({ type: 'diagnostic', phase: 'background_start', id: 'h1-memory', purpose: 'memory', model: 'sol' });
    t = 43; timing.event({ type: 'diagnostic', phase: 'background_end', id: 'h1-memory', ok: false });
    t = 50; timing.event({ type: 'diagnostic', phase: 'model_start', model: 'sol', purpose: 'after_tools', inputChars: 5 });
    t = 60; timing.event({ type: 'diagnostic', phase: 'hedge_start', model: 'backup' });
    t = 70; timing.event({ type: 'diagnostic', phase: 'model_end', resultKind: 'answer', usage: { input: 120, output: 30 } });
    timing.event({ type: 'diagnostic', phase: 'answer_rewrite', rules: ['care_deferral'] });
    const s = timing.snapshot();
    expect(s.callDetailVersion).toBe(1);
    expect(s.modelCalls).toBe(2);
    expect(s.helperModelCalls).toBe(1);
    expect(s.backgroundModelCalls).toBe(1);
    expect(s.rewrites).toEqual({ care_deferral: 1 });
    expect(s.calls.map((c) => [c.kind, c.purpose, c.model, c.ms])).toEqual([
      ['main', 'answer', 'sol', 20], ['helper', 'vision', 'qwen-vl', 10], ['background', 'memory', 'sol', 1], ['main', 'after_tools', 'sol', 20], ['hedge', 'hedge', 'backup', 10]
    ]);
    expect(s.calls[2].result).toBe('error');
    expect(s.tokens).toBeNull(); // 后台和备用那次没拿到用量
    expect(s.tokenSamples).toBe(3);
  });
  it('全都有用量时才给合计', () => {
    const timing = createTaskTiming(0, () => 1);
    timing.event({ type: 'diagnostic', phase: 'model_start', model: 'm' });
    timing.event({ type: 'diagnostic', phase: 'model_end', usage: { input: 10, output: 2, cached: 4 } });
    expect(timing.snapshot().tokens).toEqual({ input: 10, output: 2, cached: 4 });
  });
});

describe('从接口拿 Token 用量（真实请求格式）', () => {
  it('Responses：完成事件里的 usage 记下来', async () => {
    const { vi } = await import('vitest');
    const { createAdapter } = await import('../src/llm/config.js');
    vi.stubGlobal('fetch', async () => new Response([
      { type: 'response.output_text.delta', delta: '好' },
      { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 120, output_tokens: 8, input_tokens_details: { cached_tokens: 100 } } } }
    ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
    try {
      const { adapter, model } = createAdapter({ provider: 'relay-multi', models: { 'relay-multi': 'gpt-6-luna' }, keys: { 'relay-multi': 'sk-t' }, baseURLs: { 'relay-multi': 'https://relay.example/v1' } });
      const r = await adapter.stream({ model, system: ['s'], messages: [{ role: 'user', content: 'hi' }], tools: [], onText: () => {} });
      expect(r.usage).toEqual({ input: 120, output: 8, cached: 100 });
    } finally { vi.unstubAllGlobals(); }
  });
  it('Chat Completions：请求带 stream_options；中转站不认就去掉重发，不误伤思考强度', async () => {
    const { vi } = await import('vitest');
    const { createAdapter } = await import('../src/llm/config.js');
    const bodies = [];
    vi.stubGlobal('fetch', async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.stream_options) return new Response('{"error":{"message":"Unrecognized request argument supplied: stream_options"}}', { status: 400 });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    try {
      const { adapter, model } = createAdapter({ provider: 'deepseek', models: { deepseek: 'deepseek-chat' }, keys: { deepseek: 'sk-t' } });
      const r = await adapter.stream({ model, effort: 'low', system: ['s'], messages: [{ role: 'user', content: 'hi' }], tools: [], onText: () => {} });
      expect(r.text).toBe('好');
      expect(bodies[0].stream_options).toEqual({ include_usage: true });
      expect(bodies[1].stream_options).toBeUndefined();
      expect(bodies[1].reasoning_effort).toBe('low');
    } finally { vi.unstubAllGlobals(); }
  });
});
