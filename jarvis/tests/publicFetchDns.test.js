import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicFetch } from '../server/taskRunner.mjs';
import { createPageReader } from '../src/agent/pageReader.js';
import { errorKind } from '../src/core/suggest.js';

const publicAddress = [{ address: '93.184.216.34', family: 4 }];
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
};
afterEach(() => vi.restoreAllMocks());

describe('公网抓取：DNS失败不冒充安全拦截', () => {
  it.each(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'])('%s保留安全错误码并归类网络失败，不发HTTP请求', async code => {
    const fetchImpl = vi.fn();
    const error = await publicFetch('https://public.example/path?key=private-query', {}, fetchImpl,
      async () => { throw Object.assign(new Error('resolver private-secret private-query'), { code }); }).catch(e => e);
    expect(error).toMatchObject({ name: 'NetworkError', kind: 'network', code });
    expect(errorKind(error)).toBe('network');
    expect(error.status).toBeUndefined();
    expect(error.message).toContain('域名解析失败');
    expect(JSON.stringify(error) + error.message).not.toMatch(/private-secret|private-query|PRIVATE_NETWORK_BLOCKED|只允许/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('不复制不可信的解析器错误正文、任意代码或私网错误码', async () => {
    const fetchImpl = vi.fn();
    for (const code of ['PRIVATE_NETWORK_BLOCKED', 'secret https://private.example', 'E'.repeat(100)]) {
      await expect(publicFetch('https://public.example', {}, fetchImpl,
        async () => { throw Object.assign(new Error('secret'), { code }); }))
        .rejects.toMatchObject({ code: 'DNS_LOOKUP_FAILED', kind: 'network' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([[], null, undefined])('空DNS结果%j明确报网络失败且不放行', async answer => {
    const fetchImpl = vi.fn();
    await expect(publicFetch('https://public.example', {}, fetchImpl, async () => answer))
      .rejects.toMatchObject({ code: 'DNS_NO_RESULTS', kind: 'network', message: expect.stringContaining('未返回可用地址') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ address: 'not-an-ip' }], [null], [{ address: '93.184.216.34' }, { address: '' }]])('无效DNS结果%j失败关闭', async (...entries) => {
    const fetchImpl = vi.fn();
    await expect(publicFetch('https://public.example', {}, fetchImpl, async () => entries))
      .rejects.toMatchObject({ code: 'DNS_INVALID_RESULT', kind: 'network' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([{ address: '93.184.216.34' }, '93.184.216.34'])('非数组DNS结果%j明确报格式异常，不放行', async answer => {
    const fetchImpl = vi.fn();
    await expect(publicFetch('https://public.example', {}, fetchImpl, async () => answer))
      .rejects.toMatchObject({ code: 'DNS_INVALID_RESULT', kind: 'network', message: expect.stringContaining('格式异常') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['file:///etc/passwd', 'ftp://public.example/file', 'http://localhost/', 'http://127.0.0.1/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/'])('非法目标%s仍返回403，解析及HTTP均不执行', async url => {
    const fetchImpl = vi.fn(), lookup = vi.fn();
    await expect(publicFetch(url, {}, fetchImpl, lookup))
      .rejects.toMatchObject({ code: 'PRIVATE_NETWORK_BLOCKED', kind: 'api', status: 403 });
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:101', '0:0:0:0:0:ffff:7f00:1'])('解析含%s时整组拒绝，包括与公网混合的记录', async address => {
    const fetchImpl = vi.fn();
    await expect(publicFetch('https://public.example', {}, fetchImpl, async () => [...publicAddress, { address }]))
      .rejects.toMatchObject({ code: 'PRIVATE_NETWORK_BLOCKED', status: 403 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['::ffff:93.184.216.34', '::ffff:5db8:d822', '2606:4700:4700::1111'])('正常公网IPv6与mapped地址%s保持可用', async address => {
    const fetchImpl = vi.fn(async () => new Response('ok'));
    expect(await (await publicFetch(`https://[${address}]/`, {}, fetchImpl, async () => [{ address }])).text()).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('重定向解析到内网仍阻断第二跳，不借网络降级放行', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://internal.example/' } }));
    await expect(publicFetch('https://public.example', {}, fetchImpl,
      async host => host === 'internal.example' ? [{ address: '::ffff:7f00:1' }] : publicAddress))
      .rejects.toMatchObject({ code: 'PRIVATE_NETWORK_BLOCKED', status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('DNS未返回时取消立即结束；迟到地址不会开始HTTP请求', async () => {
    const waiting = deferred(), started = deferred(), controller = new AbortController();
    const stop = new DOMException('用户停止', 'AbortError');
    const fetchImpl = vi.fn(), remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = publicFetch('https://public.example', { signal: controller.signal }, fetchImpl,
      () => { started.resolve(); return waiting.promise; });
    const assertion = expect(pending).rejects.toBe(stop);
    await started.promise;
    controller.abort(stop);
    await assertion;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    waiting.resolve(publicAddress);
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('已取消请求不解析域名、不出站', async () => {
    const controller = new AbortController();
    controller.abort();
    const lookup = vi.fn(), fetchImpl = vi.fn();
    await expect(publicFetch('https://public.example', { signal: controller.signal }, fetchImpl, lookup))
      .rejects.toBe(controller.signal.reason);
    expect(lookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('默认20秒期限贯穿第二跳DNS，不在重定向时重新计时', async () => {
    const controller = new AbortController(), secondLookup = deferred(), waiting = deferred();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init.signal).toBe(controller.signal);
      return new Response('', { status: 302, headers: { location: 'https://second.example/' } });
    });
    const pending = publicFetch('https://public.example', {}, fetchImpl, host => {
      if (host !== 'second.example') return publicAddress;
      secondLookup.resolve();
      return waiting.promise;
    });
    const reason = new DOMException('请求超时', 'TimeoutError');
    const assertion = expect(pending).rejects.toBe(reason);
    await secondLookup.promise;
    controller.abort(reason);
    await assertion;
    waiting.resolve(publicAddress);
    await Promise.resolve();
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(20000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['AbortError', 'RETRIEVAL_BUDGET', 'EVAL_QUOTA', 'EVAL_EXPIRED'])('解析器抛出的%s控制信号原样上抛', async control => {
    const reason = Object.assign(new Error('停止'), control === 'AbortError' ? { name: control } : { code: control });
    const fetchImpl = vi.fn();
    await expect(publicFetch('https://public.example', {}, fetchImpl, async () => { throw reason; })).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('网页读取与真实公网校验接缝（纯模拟）', () => {
  it('DNS临时故障允许既有一次重试，再用已配置Tavily代读；未关闭SSRF检查', async () => {
    const body = '这是备用来源返回的有效正文。'.repeat(40);
    const lookup = vi.fn(async host => {
      if (host === 'public.example') throw Object.assign(new Error('暂时无法解析'), { code: 'EAI_AGAIN' });
      return publicAddress;
    });
    const fetchImpl = vi.fn(async url => {
      expect(String(url)).toBe('https://api.tavily.com/extract');
      return Response.json({ results: [{ raw_content: body }] });
    });
    const read = createPageReader({ tavilyKey: 'fake-only', fetchViaGateway: (url, init) => publicFetch(url, init, fetchImpl, lookup) });
    expect(await read('https://public.example/article')).toBe(body);
    expect(lookup.mock.calls.filter(([host]) => host === 'public.example')).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('真实私网解析仍立即失败，不重试、不把私网目标发给Tavily', async () => {
    const fetchImpl = vi.fn(), lookup = vi.fn(async () => [{ address: '192.168.1.1' }]);
    const read = createPageReader({ tavilyKey: 'fake-only', fetchViaGateway: (url, init) => publicFetch(url, init, fetchImpl, lookup) });
    await expect(read('https://public.example/article')).rejects.toMatchObject({ code: 'PRIVATE_NETWORK_BLOCKED', status: 403 });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
