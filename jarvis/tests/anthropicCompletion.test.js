import { describe, it, expect, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicAdapter } from '../src/llm/anthropic.js';

const request = {
  model: 'claude-fixture', system: ['测试', ''],
  messages: [{ role: 'user', content: '你好' }], tools: [],
  stallTimeouts: { first: 1000, between: 100 }, maxTransientRetries: 0
};

function sdkFixture({ complete = true, stop = 'end_turn', text = '完成', close = false } = {}) {
  const events = [
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } },
    ...(complete ? [{ type: 'message_stop' }] : [])
  ];
  const cancel = vi.fn();
  const fetchMock = vi.fn(async () => new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      if (close) controller.close();
    }, cancel
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const client = new Anthropic({ apiKey: 'fixture-not-a-secret', baseURL: 'https://fixture.invalid', fetch: fetchMock, maxRetries: 0, dangerouslyAllowBrowser: true });
  return { adapter: createAnthropicAdapter({ client }), cancel, fetchMock };
}

describe('真实 Anthropic SDK 的协议完成收尾（不访问外网）', () => {
  it('收到 message_stop 后底层 HTTP 不关闭也能完成，取消剩余读取', async () => {
    const { adapter, cancel, fetchMock } = sdkFixture();
    const result = await adapter.stream(request);
    expect(result).toMatchObject({ text: '完成', stop: 'end_turn', toolCalls: [] });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('已经有文字但没有 message_stop，不能伪装成功或自动重复输出', async () => {
    const { adapter, fetchMock } = sdkFixture({ complete: false });
    const seen = [];
    await expect(adapter.stream({ ...request, onText: (value) => seen.push(value) })).rejects.toMatchObject({ stalled: true, partialText: '完成' });
    expect(seen.join('')).toBe('完成');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('提前关闭 HTTP 不把不完整消息当完成', async () => {
    const { adapter } = sdkFixture({ complete: false, close: true });
    await expect(adapter.stream(request)).rejects.toMatchObject({ code: 'MODEL_STREAM_INCOMPLETE', partialText: '完成' });
  });

  it('完成消息的长度截断原因不丢失', async () => {
    const { adapter } = sdkFixture({ stop: 'max_tokens' });
    expect((await adapter.stream(request)).stop).toBe('max_tokens');
  });

  it('用户取消不会因收尾逻辑变成成功', async () => {
    const { adapter } = sdkFixture({ complete: false });
    const controller = new AbortController();
    await expect(adapter.stream({ ...request, signal: controller.signal, onText: () => controller.abort() })).rejects.toMatchObject({ name: 'AbortError', partialText: '完成' });
  });
});
