import test from 'node:test';
import assert from 'node:assert/strict';
import { readAnthropicStream } from '../src/llm/anthropicStream.js';
import { stallGuard } from '../src/llm/openai.js';

const message = (stop = 'end_turn') => ({ content: [{ type: 'text', text: '完成' }], stop_reason: stop });

/** 模拟协议事件，不模拟模型质量；消息完成后底层连接故意保持打开。 */
function fixture(events, { final = message(), close = false } = {}) {
  const listeners = new Set();
  let index = 0;
  let aborted = false;
  let finalCalls = 0;
  return {
    on(type, callback) {
      if (type === 'message') listeners.add(callback);
    },
    off(type, callback) {
      if (type === 'message') listeners.delete(callback);
    },
    abort() {
      aborted = true;
    },
    get cleaned() {
      return aborted && listeners.size === 0;
    },
    get finalCalls() {
      return finalCalls;
    },
    finalMessage() {
      finalCalls++;
      return new Promise(() => {});
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= events.length) return close ? { done: true } : new Promise(() => {});
          const event = events[index++];
          if (event.type === 'message_stop') for (const callback of listeners) callback(final);
          return { done: false, value: event };
        }
      };
    }
  };
}

async function read(stream, options = {}) {
  const guard = stallGuard(options.signal, { first: 40, between: 40 });
  try {
    return await readAnthropicStream(stream, { guard, ...options });
  } finally {
    guard.done();
  }
}

const textDelta = { type: 'content_block_delta', delta: { type: 'text_delta', text: '完成' } };
const stopped = { type: 'message_stop' };

test('完成消息后连接不关闭，也立即返回并清理，不等待 finalMessage', async () => {
  const stream = fixture([textDelta, stopped]);
  const seen = [];
  const result = await read(stream, { onText: (value) => seen.push(value) });
  assert.equal(result.text, '完成');
  assert.equal(result.message.stop_reason, 'end_turn');
  assert.deepEqual(seen, ['完成']);
  assert.equal(stream.finalCalls, 0);
  assert.equal(stream.cleaned, true);
});

test('SDK 完整工具参数、思考块和签名按原对象保留', async () => {
  const final = {
    content: [
      { type: 'thinking', thinking: 'fixture', signature: 'signature-fixture' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'test.txt' } }
    ],
    stop_reason: 'tool_use'
  };
  const stream = fixture([stopped], { final });
  assert.equal((await read(stream)).message, final);
});

test('完成块不能替代整条消息完成，部分文字超时仍是失败', async () => {
  const stream = fixture([textDelta, { type: 'content_block_stop', index: 0 }]);
  await assert.rejects(read(stream), (error) => error.stalled && error.partialText === '完成');
  assert.equal(stream.cleaned, true);
});

test('提前 EOF 不把收到的文字当成功', async () => {
  const stream = fixture([textDelta], { close: true });
  await assert.rejects(read(stream), { code: 'MODEL_STREAM_INCOMPLETE', kind: 'api', partialText: '完成' });
  assert.equal(stream.cleaned, true);
});

test('空内容提前 EOF 也失败', async () => {
  await assert.rejects(read(fixture([], { close: true })), { code: 'MODEL_STREAM_INCOMPLETE' });
});

test('message_stop 缺少有效停止原因不能成功', async () => {
  await assert.rejects(read(fixture([stopped], { final: message(null) })), { code: 'MODEL_STREAM_INCOMPLETE' });
});

test('用户运行中停止保留 AbortError 与部分文字，并清理请求', async () => {
  const controller = new AbortController();
  const stream = fixture([textDelta]);
  await assert.rejects(
    read(stream, {
      signal: controller.signal,
      onText: () => controller.abort()
    }),
    { name: 'AbortError', partialText: '完成' }
  );
  assert.equal(stream.cleaned, true);
});

test('预取消不会继续消费协议事件', async () => {
  const controller = new AbortController();
  controller.abort();
  const stream = fixture([textDelta, stopped]);
  await assert.rejects(read(stream, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(stream.cleaned, true);
});

test('max_tokens 不被改成正常 end_turn，由调度层报告长度中断', async () => {
  assert.equal((await read(fixture([stopped], { final: message('max_tokens') }))).message.stop_reason, 'max_tokens');
});

test('原生搜索事件保留，不能误当最终答复', async () => {
  const names = [];
  const stream = fixture([{ type: 'content_block_start', content_block: { type: 'server_tool_use', name: 'web_search' } }, textDelta, stopped]);
  await read(stream, { onServerTool: (name) => names.push(name) });
  assert.deepEqual(names, ['web_search']);
});

// 预算中断与用户取消不同，不能被SDK收尾逻辑改成普通失败。
test('预算控制信号不吞掉或改写', async () => {
  const controller = new AbortController();
  const budgetError = Object.assign(new Error('预算用完'), { code: 'RETRIEVAL_BUDGET' });
  const stream = fixture([textDelta]);
  await assert.rejects(
    read(stream, {
      signal: controller.signal,
      onText: () => controller.abort(budgetError)
    }),
    { code: 'RETRIEVAL_BUDGET', partialText: '完成' }
  );
  assert.equal(stream.cleaned, true);
});
