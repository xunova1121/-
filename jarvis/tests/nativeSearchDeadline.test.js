import { describe, it, expect, vi } from 'vitest';
import { nativeSearchAllowed } from '../src/llm/nativeSearch.js';
import { createAnthropicAdapter } from '../src/llm/anthropic.js';
import { createResponsesAdapter } from '../src/llm/responses.js';
import { createModelRequest } from '../src/agent/agentModelRequest.js';

const applicationSearch = { name: 'web_search' };
const input = { system: ['', ''], messages: [], tools: [applicationSearch] };
const makeRequest = (adapter, extra = {}) => createModelRequest({
  current: { adapter, model: 'fixture' },
  signal: new AbortController().signal,
  lookupDeadline: true,
  lookupControl: { remaining: () => 30_000, retrievalRemaining: () => 0 },
  closing: false,
  retrieval: { active: false, left: 6, remaining: Infinity, close() {} },
  emit() {}, onNativeSearch() {}, onText() {}, onRetry() {},
  ...extra
});

describe('本次实际搜索能力决定检索窗口', () => {
  it('同名应用工具、预算耗尽、明确关闭时不启用原生搜索', () => {
    expect(nativeSearchAllowed({ enabled: true })).toBe(true);
    expect(nativeSearchAllowed({ enabled: true, tools: [applicationSearch] })).toBe(false);
    expect(nativeSearchAllowed({ enabled: true, maxWebSearches: 0 })).toBe(false);
    expect(nativeSearchAllowed({ enabled: true, allowWebSearch: false })).toBe(false);
  });

  it.each(['anthropic', 'responses'])('%s真实适配器暴露同一判断，不只按型号判断', (kind) => {
    const adapter = kind === 'anthropic'
      ? createAnthropicAdapter({ client: {}, webSearch: true })
      : createResponsesAdapter({ baseURL: 'https://fixture.invalid', webSearch: true });
    expect(adapter.usesNativeSearch({ tools: [] })).toBe(true);
    expect(adapter.usesNativeSearch({ tools: [applicationSearch] })).toBe(false);
    expect(adapter.usesNativeSearch({ tools: [], maxWebSearches: 0 })).toBe(false);
  });

  it.each(['anthropic', 'openai-responses'])('%s提供应用搜索时，不在模型尚未检索前错误终止', async (kind) => {
    const stream = vi.fn(async () => ({ text: '正常答案', toolCalls: [], stop: 'end_turn' }));
    const request = makeRequest({ kind, stream });
    try {
      expect((await request.run(input)).text).toBe('正常答案');
      expect(stream).toHaveBeenCalledTimes(1);
    } finally { request.dispose(); }
  });

  it('实际开启原生搜索或已开始应用检索时，过期窗口仍在发请求前拦截', async () => {
    for (const active of [false, true]) {
      const stream = vi.fn();
      const request = makeRequest({ kind: 'anthropic', usesNativeSearch: () => !active, stream }, {
        retrieval: { active, left: 6, remaining: Infinity, close() {} }
      });
      try {
        await expect(request.run(input)).rejects.toMatchObject({ code: 'LOOKUP_RETRIEVAL_END' });
        expect(stream).not.toHaveBeenCalled();
      } finally { request.dispose(); }
    }
  });

  it('检索次数为零时请求不带原生搜索，但仍可整理答案', async () => {
    const stream = vi.fn(async (options) => {
      expect(options.allowWebSearch).toBe(false);
      expect(options.maxWebSearches).toBe(0);
      return { text: '已有资料', toolCalls: [], stop: 'end_turn' };
    });
    const request = makeRequest({ kind: 'anthropic', stream }, { retrieval: { active: false, left: 0, remaining: Infinity, close() {} } });
    try { expect((await request.run({ ...input, tools: [] })).text).toBe('已有资料'); }
    finally { request.dispose(); }
  });

  it.each([false, true])('停止信号在调用前=%s：忽略signal的模型也能停止且不变成检索耗尽', async (before) => {
    const controller = new AbortController();
    const stream = vi.fn(() => new Promise(() => {}));
    const request = makeRequest({ kind: 'anthropic', stream }, { signal: controller.signal });
    if (before) controller.abort();
    try {
      const result = request.run(input);
      if (!before) controller.abort();
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      if (before) expect(stream).not.toHaveBeenCalled();
    } finally { request.dispose(); }
  });
});
