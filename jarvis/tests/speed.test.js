import { describe, it, expect, afterEach, vi } from 'vitest';
import { createOpenAIAdapter } from '../src/llm/openai.js';
import { createEmbedder } from '../src/llm/embeddings.js';

const sse = (text) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('提速', () => {
  it('日常对话带 reasoning_effort=low；模型不认时自动去掉重试并记住', async () => {
    const bodies = [];
    globalThis.fetch = async (_u, init) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      if (b.model === 'old-model' && b.reasoning_effort) return new Response('{"error":{"message":"Unsupported parameter: \'reasoning_effort\'"}}', { status: 400 });
      return sse('好');
    };
    const a = createOpenAIAdapter({ baseURL: 'http://x/v1', apiKey: 'k' });
    let out = '';
    await a.stream({ model: 'gpt-6.1', effort: 'low', system: ['s', ''], messages: [{ role: 'user', content: 'hi' }], tools: [], onText: (d) => { out += d; } });
    expect(bodies[0].reasoning_effort).toBe('low');
    await a.stream({ model: 'old-model', effort: 'low', system: ['s', ''], messages: [{ role: 'user', content: 'hi' }], tools: [], onText: (d) => { out += d; } });
    expect(bodies.slice(1).map((b) => b.reasoning_effort)).toEqual(['low', undefined]);
    await a.stream({ model: 'old-model', effort: 'low', system: ['s', ''], messages: [{ role: 'user', content: 'hi' }], tools: [], onText: () => {} });
    expect(bodies.at(-1).reasoning_effort).toBeUndefined(); // 记住了，不再先失败一次
    expect(bodies).toHaveLength(4);
    expect(out).toBe('好好');
  });

  it('检索向量：同一句话复用；向量服务太慢时不等它', async () => {
    let calls = 0;
    let slow = false;
    const fetchImpl = async () => {
      calls++;
      if (slow) await new Promise((r) => setTimeout(r, 4000));
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }));
    };
    const e = createEmbedder({ keys: { openai: 'k' } }, { fetchImpl });
    expect(await e.embed(['你好'])).toEqual([[1, 2]]);
    expect(await e.embed(['你好'])).toEqual([[1, 2]]);
    expect(calls).toBe(1);
    slow = true;
    vi.useFakeTimers();
    const p = e.embed(['另一句']);
    const check = expect(p).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(2600);
    await check;
    vi.useRealTimers();
  });
});
