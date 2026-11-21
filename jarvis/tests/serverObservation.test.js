import { describe, expect, it, vi } from 'vitest';
import { createServerClient, followTask, runRemote } from '../src/core/serverClient.js';

const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const done = { seq: 2, type: 'task_state', status: 'done', text: '完成' };
const offline = () => { throw new TypeError('Failed to fetch'); };
const bounded = async run => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 250);
  try { return await run(ctrl.signal); } finally { clearTimeout(timer); }
};

describe('已提交任务的观察连接', () => {
  it('连续离线有上限，提示原任务可能仍在运行，事件不含请求地址或正文', async () => {
    const events = vi.fn(offline), observed = [];
    const error = await bounded(signal => followTask({ events }, 'task', {
      signal, retryMs: [1], maxConsecutiveFailures: 3, onEvent: e => observed.push(e)
    })).catch(e => e);
    expect(error).toMatchObject({ code: 'TASK_OBSERVATION_LOST', kind: 'network' });
    expect(error.message).toContain('已提交');
    expect(error.message).toContain('可能继续运行');
    expect(error.message).toContain('原对话');
    expect(events).toHaveBeenCalledTimes(3);
    expect(observed).toEqual([{ type: 'server_connection', state: 'reconnecting', attempt: 2 }]);
  });

  it('短断线恢复继续同一任务和序号，连接状态仅变化时通知', async () => {
    const observed = [], calls = [];
    const client = { async events(id, after) {
      calls.push({ id, after });
      if (calls.length <= 2) return offline();
      return new Response(frame({ seq: 1, type: 'text', delta: '旧内容' }) + frame(done));
    } };
    const result = await followTask(client, 'same-task', { after: 1, retryMs: [1], onEvent: e => observed.push(e) });
    expect(result).toEqual(done);
    expect(calls).toEqual(Array(3).fill({ id: 'same-task', after: 1 }));
    expect(observed).toEqual([
      { type: 'server_connection', state: 'reconnecting', attempt: 2 },
      { type: 'server_connection', state: 'connected', attempt: 3 },
      done
    ]);
  });

  it('持续失败不重复提交也不停止服务器任务', async () => {
    const client = { startTask: vi.fn(async () => ({ id: 'submitted' })), stopTask: vi.fn(async () => {}), events: vi.fn(offline) };
    const error = await bounded(signal => runRemote(client, {
      sessionId: 'session', userText: '查资料', emit: vi.fn(), signal,
      observation: { retryMs: [1], maxConsecutiveFailures: 3 }
    })).catch(e => e);
    expect(error.code).toBe('TASK_OBSERVATION_LOST');
    expect(client.startTask).toHaveBeenCalledTimes(1);
    expect(client.stopTask).not.toHaveBeenCalled();
    expect(client.events).toHaveBeenCalledTimes(3);
  });

  it('默认最多连续失败五次，不依赖测试传入阈值', async () => {
    const events = vi.fn(offline);
    const error = await bounded(signal => followTask({ events }, 'task', { signal, retryMs: [1] })).catch(e => e);
    expect(error.code).toBe('TASK_OBSERVATION_LOST');
    expect(events).toHaveBeenCalledTimes(5);
  });

  it('底层取消后仍迟到的响应也计入失败上限', async () => {
    const events = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return new Response('');
    });
    const error = await bounded(signal => followTask({ events, getTask: async () => ({ status: 'running' }) }, 'task', {
      signal, retryMs: [1], checkMs: 2, idleMs: 5, maxConsecutiveFailures: 3
    })).catch(e => e);
    expect(error.code).toBe('TASK_OBSERVATION_LOST');
    expect(events).toHaveBeenCalledTimes(3);
  });

  it('用户在退避期间主动停止，立刻取消等待并停止原任务一次', async () => {
    const ctrl = new AbortController();
    const client = { startTask: vi.fn(async () => ({ id: 'submitted' })), stopTask: vi.fn(async () => {}), events: vi.fn(offline) };
    const timer = setTimeout(() => ctrl.abort(), 100);
    try {
      await expect(runRemote(client, {
        sessionId: 'session', userText: '查资料', signal: ctrl.signal, emit: vi.fn(),
        observation: { retryMs: [10000] }
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(client.startTask).toHaveBeenCalledTimes(1);
      expect(client.stopTask).toHaveBeenCalledTimes(1);
      expect(client.stopTask).toHaveBeenCalledWith('submitted');
      expect(client.events).toHaveBeenCalledTimes(1);
    } finally { clearTimeout(timer); }
  });

  it.each([401, 403, 404])('抛出 HTTP %s 也立即停止观察', async status => {
    const events = vi.fn(async () => { throw Object.assign(new Error('response'), { status }); });
    const error = await bounded(signal => followTask({ events }, 'task', { signal, retryMs: [1] })).catch(e => e);
    expect(error.status).toBe(status);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404])('返回 HTTP %s 立即停止观察', async status => {
    const events = vi.fn(async () => new Response('', { status }));
    await expect(followTask({ events }, 'task')).rejects.toMatchObject({
      status, requestTiming: { path: '/api/tasks/task/events', method: 'GET', status, kind: 'api' }
    });
    expect(events).toHaveBeenCalledTimes(1);
  });

  it.each(['http', 'empty', 'html'])('连续无有效事件的 %s 响应不能无限重连', async type => {
    const events = vi.fn(async () => new Response(type === 'html' ? '<html>temporary proxy error</html>' : '', { status: type === 'http' ? 503 : 200 }));
    const error = await bounded(signal => followTask({ events }, 'task', {
      signal, retryMs: [1], maxConsecutiveFailures: 3
    })).catch(e => e);
    expect(error.code).toBe('TASK_OBSERVATION_LOST');
    expect(events).toHaveBeenCalledTimes(3);
  });

  it('手机事件流首次失败立即降级，不重新启动任务', async () => {
    let streaming = true;
    const client = {
      get streaming() { return streaming; },
      streamFailed: vi.fn(() => { const changed = streaming; streaming = false; return changed; }),
      events: vi.fn(async () => streaming ? offline() : new Response(frame(done)))
    };
    expect(await followTask(client, 'same-task', { retryMs: [10000] })).toEqual(done);
    expect(client.events).toHaveBeenCalledTimes(2);
    expect(client.streamFailed).toHaveBeenCalledTimes(1);
  });

  it('正常心跳长任务不消耗失败额度，也不冒充模型内容', async () => {
    const observed = [];
    const encoder = new TextEncoder();
    const events = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      let beats = 0;
      const timer = setInterval(() => {
        if (++beats < 12) controller.enqueue(encoder.encode(': ping\n\n'));
        else { clearInterval(timer); controller.enqueue(encoder.encode(frame(done))); controller.close(); }
      }, 5);
    } })));
    expect(await followTask({ events, getTask: async () => ({ status: 'running', seq: 0 }) }, 'task', {
      onEvent: e => observed.push(e), checkMs: 5, idleMs: 25, maxConsecutiveFailures: 2
    })).toEqual(done);
    expect(events).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([done]);
  });

  it('状态轮询发现登录失效时结束挂起的观察，不继续等事件流', async () => {
    const events = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
    const getTask = vi.fn(async () => { throw Object.assign(new Error('login'), { status: 401 }); });
    const error = await bounded(signal => followTask({ events, getTask }, 'task', {
      signal, checkMs: 5, retryMs: [1]
    })).catch(e => e);
    expect(error.status).toBe(401);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it.each(['done', 'denied'])('任务结束后迟到的 %s 状态查询不再重连', async result => {
    let finishStatus, failStatus;
    const pendingStatus = new Promise((resolve, reject) => { finishStatus = resolve; failStatus = reject; });
    const observed = [];
    const abort = vi.spyOn(AbortController.prototype, 'abort');
    try {
      const client = {
        getTask: vi.fn(() => pendingStatus),
        events: vi.fn(async () => new Response(new ReadableStream({ start(controller) {
          setTimeout(() => { controller.enqueue(new TextEncoder().encode(frame(done))); controller.close(); }, 15);
        } })))
      };
      await followTask(client, 'task', { checkMs: 1, onEvent: e => observed.push(e) });
      expect(client.getTask).toHaveBeenCalledTimes(1);
      abort.mockClear();
      if (result === 'done') finishStatus({ status: 'done', seq: 100 });
      else failStatus(Object.assign(new Error('expired'), { status: 401 }));
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(abort).not.toHaveBeenCalled();
      expect(client.events).toHaveBeenCalledTimes(1);
      expect(observed).toEqual([done]);
    } finally { abort.mockRestore(); }
  });
});

it('HTTP 错误附固定路由诊断，不附服务器 URL、令牌、查询参数或响应正文', async () => {
  const client = createServerClient({ base: 'https://fixture.example', token: 'fixture-token', fetchImpl: async () => new Response(JSON.stringify({ error: 'denied' }), { status: 401 }) });
  const error = await client.startTask({ text: 'fixture-text' }).catch(e => e);
  expect(error.requestTiming).toMatchObject({ path: '/api/tasks', method: 'POST', status: 401, kind: 'api', attempt: 1 });
  expect(JSON.stringify(error.requestTiming)).not.toMatch(/fixture|denied|https:/);
  const queryError = await client.listCodeProjects('fixture-private-query').catch(e => e);
  expect(queryError.requestTiming.path).toBe('/api/server/code-projects');
  expect(JSON.stringify(queryError.requestTiming)).not.toMatch(/fixture|denied|https:/);
});
