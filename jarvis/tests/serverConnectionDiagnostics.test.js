import { describe, it, expect, vi } from 'vitest';
import { createServerClient } from '../src/core/serverClient.js';
import { abortableFetch } from '../src/core/abortableFetch.js';
import { waitForDocumentStyle } from '../e2e/wait-document-style.mjs';

const response = (data = {}) => new Response(JSON.stringify(data));

describe('服务器读取诊断、重试与停止', () => {
  it('读取网络失败只重试一次，记状态/类型/次数，不存Key、正文和查询', async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(response({ secret: '响应正文' }));
    const client = createServerClient({ base: 'https://fixture.invalid', token: 'private-token', fetchImpl });
    await client.getConfig();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.timings).toMatchObject([{ kind: 'response', status: 200, attempt: 2 }, { kind: 'network', status: 0, attempt: 1 }]);
    expect(JSON.stringify(client.timings)).not.toMatch(/private-token|响应正文/);
    for (let index = 0; index < 12; index++) { fetchImpl.mockResolvedValueOnce(response()); await client.getConfig(); }
    expect(client.timings).toHaveLength(8);
  });

  it('两次都失败带最后的读取诊断；HTTP错误和写操作不盲目重试', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const client = createServerClient({ base: 'https://fixture.invalid', fetchImpl });
    await expect(client.listDocumentStyles()).rejects.toMatchObject({ requestTiming: { attempt: 2, kind: 'network', method: 'GET' } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const denied = vi.fn(async () => new Response('{"error":"拒绝"}', { status: 401 }));
    await expect(createServerClient({ base: 'https://fixture.invalid', fetchImpl: denied }).getConfig()).rejects.toMatchObject({ status: 401 });
    expect(denied).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear();
    await expect(client.putConfig({ provider: 'fixture' })).rejects.toBeInstanceOf(TypeError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('预算错误原样抛出；读取正文时的停止/预算也不吞掉', async () => {
    const budget = Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET', kind: 'budget' });
    const fetchImpl = vi.fn(async () => { throw budget; });
    await expect(createServerClient({ base: 'https://fixture.invalid', fetchImpl }).getConfig()).rejects.toBe(budget);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const bodyClient = createServerClient({ base: 'https://fixture.invalid', fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw budget; } }) });
    await expect(bodyClient.getConfig()).rejects.toBe(budget);
  });

  it('用户在随机退避期间停止，不发第二次请求', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
      const client = createServerClient({ base: 'https://fixture.invalid', fetchImpl });
      const checked = expect(client.status(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await checked;
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('传输忽略signal也按时超时且最多两次，不被当作余额不足', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(() => new Promise(() => {}));
      const client = createServerClient({ base: 'https://fixture.invalid', timeoutMs: 10, fetchImpl });
      const checked = expect(client.getConfig()).rejects.toMatchObject({ kind: 'timeout', requestTiming: { attempt: 2, kind: 'timeout' } });
      await vi.advanceTimersByTimeAsync(1000);
      await checked;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('取消后迟到响应只清理正文，不交给业务；预先停止不发请求', async () => {
    const controller = new AbortController();
    let finish;
    const cancel = vi.fn();
    const fetchImpl = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const work = abortableFetch(fetchImpl, 'https://fixture.invalid', { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    finish({ body: { cancel } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear();
    await expect(abortableFetch(fetchImpl, 'https://fixture.invalid', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('等待后台偏好的网络错误最多3次；鉴权失败不循环等待', async () => {
    vi.useFakeTimers();
    try {
      const page = { evaluate: vi.fn(async () => ({ kind: 'network' })) };
      const checked = expect(waitForDocumentStyle(page)).rejects.toMatchObject({ code: 'DOCUMENT_STYLE_WAIT_FAILED', kind: 'network' });
      await vi.advanceTimersByTimeAsync(2000);
      await checked;
      expect(page.evaluate).toHaveBeenCalledTimes(3);
      page.evaluate.mockReset().mockResolvedValue({ kind: 'http', httpStatus: 401 });
      await expect(waitForDocumentStyle(page)).rejects.toMatchObject({ status: 401, kind: 'api' });
      expect(page.evaluate).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
