import { describe, it, expect, vi } from 'vitest';
import { isSmallTalk } from '../src/llm/router.js';
import { createEmbedder } from '../src/llm/embeddings.js';
import { createModelRequest } from '../src/agent/agentModelRequest.js';

describe('寒暄回得快', () => {
  it('“在吗？”“你好，在吗”“你好，简单打个招呼”都算寒暄；带了事情的不算', () => {
    expect(['在吗？', '你好，在吗？', '你好，简单打个招呼。', '早上好!', '未央你好'].every(isSmallTalk)).toBe(true);
    expect(['在吗？帮我查天气', '你好，帮我写个周报', '今天天气怎么样'].some(isSmallTalk)).toBe(false);
  });

  it('向量服务 1.2 秒没回就不等了（以前 2.5 秒，很多轮都白等）', async () => {
    vi.useFakeTimers();
    const cfg = { keys: { zhipu: 'k' }, abilities: { embed: { main: { provider: 'zhipu', model: 'embedding-3' } } } };
    const e = createEmbedder(cfg, { direct: true, fetchImpl: () => new Promise(() => {}) });
    if (!e) { vi.useRealTimers(); return; } // 这台配置下没有可用的向量服务时跳过计时部分
    const p = e.embed(['你好']).then(() => 'ok', (err) => err.message);
    await vi.advanceTimersByTimeAsync(1300);
    expect(await p).toMatch(/超时/);
    vi.useRealTimers();
  });

  it('闲聊时主模型 12 秒没动静就算卡住、不重试，交给备用模型', async () => {
    let opts;
    const current = { model: 'm', adapter: { stream: async (o) => { opts = o; return { text: 'hi', toolCalls: [] }; } } };
    const retrieval = { left: 0, close() {}, begin: () => true, active: false };
    const req = createModelRequest({ current, signal: undefined, lookupDeadline: false, light: true, closing: false, retrieval, emit() {}, onNativeSearch() {}, onText() {} });
    await req.run({ system: '', messages: [], tools: [] }).catch(() => {});
    expect(opts.stallTimeouts.first).toBe(12_000);
    expect(opts.maxTransientRetries).toBe(0);
  });
});
