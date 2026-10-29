import { it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createGitRunner, gitRetry, repositoryName, redactCode } from '../server/codeGit.mjs';
import { createGitHubHost, githubSettings, withoutCodeCredentials } from '../server/gitHosting.mjs';

const secret = 'ghp_' + 'FixtureOnlyCredential'.repeat(2);
function fakeSpawn(action) {
  return vi.fn((binary, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => action?.(child, { binary, args, options }));
    return child;
  });
}
it('Git认证不进argv、不继承宿主git配置；跨块输出与失败回执脱敏', async () => {
  const spawnImpl = fakeSpawn((child) => {
    child.stdout.write(secret.slice(0, 10));
    child.stdout.write(secret.slice(10));
    child.stderr.write(Buffer.from('x-access-token:' + secret).toString('base64'));
    child.emit('close', 0);
  });
  const result = await createGitRunner({ spawnImpl })(['status'], { cwd: '/tmp', token: secret });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.stdout).toBe('[已隐藏凭据]');
  const [binary, args, options] = spawnImpl.mock.calls[0];
  expect(binary).toBe('git');
  expect(args).toEqual(['status']);
  expect(options.shell).toBe(false);
  expect(options.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
  expect(options.env.GH_TOKEN).toBeUndefined();
  expect(Object.values(options.env)).toContain('http.sslVerify');
  expect(Object.values(options.env)).toContain('Authorization: Basic ' + Buffer.from('x-access-token:' + secret).toString('base64'));
  const fail = createGitRunner({
    spawnImpl: fakeSpawn((child) => {
      child.stderr.write(secret);
      child.emit('close', 128);
    })
  });
  await expect(fail(['fetch'], { token: secret })).rejects.toMatchObject({ code: 'CODE_GIT_FAILED', exitCode: 128 });
  try {
    await fail(['fetch'], { token: secret });
  } catch (error) {
    expect(error.message).not.toContain(secret);
  }
});
it('Git超时、输出过大、缺命令与用户停止均带类型并结束', async () => {
  await expect(createGitRunner({ spawnImpl: fakeSpawn(), timeoutMs: 5 })(['status'])).rejects.toMatchObject({ code: 'CODE_GIT_TIMEOUT' });
  await expect(createGitRunner({ spawnImpl: fakeSpawn((child) => child.stdout.write('too large')), maxOutput: 2 })(['status'])).rejects.toMatchObject({
    code: 'CODE_GIT_OUTPUT'
  });
  await expect(createGitRunner({ spawnImpl: fakeSpawn((child) => child.emit('error', { code: 'ENOENT' })) })(['status'])).rejects.toMatchObject({
    code: 'CODE_GIT_MISSING'
  });
  const ctrl = new AbortController(),
    run = createGitRunner({ spawnImpl: fakeSpawn(() => ctrl.abort(new Error('cancelled'))) });
  await expect(run(['fetch'], { signal: ctrl.signal })).rejects.toThrow('cancelled');
  const operation = vi.fn(async () => {
    throw Object.assign(new Error('stop'), { code: 'RETRIEVAL_BUDGET' });
  });
  await expect(gitRetry(operation)).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
  expect(operation).toHaveBeenCalledTimes(1);
  const retry = vi.fn().mockRejectedValueOnce({ code: 'CODE_GIT_TIMEOUT' }).mockResolvedValue('ok');
  expect(await gitRetry(retry)).toBe('ok');
  expect(retry).toHaveBeenCalledTimes(2);
  const abortWait = new AbortController();
  const waiting = gitRetry(async () => {
    queueMicrotask(() => abortWait.abort(new Error('stop retry')));
    throw { code: 'CODE_GIT_FAILED' };
  }, abortWait.signal);
  await expect(waiting).rejects.toThrow('stop retry');
});
it('固定GitHub API验证，重定向不转发凭据，鉴权与超时不回显上游正文', async () => {
  for (const [status, code] of [
    [401, 'CODE_GITHUB_AUTH'],
    [403, 'CODE_GITHUB_FORBIDDEN'],
    [404, 'CODE_GITHUB_NOT_FOUND'],
    [302, 'CODE_GITHUB_REDIRECT']
  ]) {
    const fetchImpl = vi.fn(async () => new Response(secret, { status }));
    await expect(createGitHubHost({ fetchImpl }).repository({ repository: 'Demo/Sandbox', token: secret })).rejects.toMatchObject({
      code,
      upstreamStatus: status
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/demo/sandbox');
    expect(init.redirect).toBe('manual');
  }
  const host = createGitHubHost({ fetchImpl: async () => new Response(JSON.stringify({ full_name: 'Demo/Sandbox', default_branch: 'main' })) });
  expect(await host.repository({ repository: 'Demo/Sandbox' })).toEqual({ repository: 'demo/sandbox', defaultBranch: 'main' });
  await expect(createGitHubHost({ fetchImpl: async () => new Response('x'.repeat(65537)) }).repository({ repository: 'demo/sandbox' })).rejects.toMatchObject({
    code: 'CODE_GITHUB_SIZE'
  });
  const hanging = createGitHubHost({
    timeoutMs: 5,
    fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  });
  await expect(hanging.repository({ repository: 'demo/sandbox' })).rejects.toMatchObject({ code: 'CODE_GITHUB_TIMEOUT' });
});
it('配置剥离可重复执行，拒绝任意地址与关闭主线保护，空令牌保留原值', () => {
  expect(withoutCodeCredentials(withoutCodeCredentials({ provider: 'mock', codeRepos: { token: secret } }))).toEqual({ provider: 'mock' });
  expect(githubSettings({ repository: 'Demo/Sandbox', token: '' }, { token: secret }).token).toBe(secret);
  for (const value of ['https://evil.invalid/repo', '../outside', 'a/..', 'a/repo.git/other']) expect(() => repositoryName(value)).toThrow();
  expect(() => githubSettings({ repository: 'demo/sandbox', protectDefaultBranch: false })).toThrow();
  expect(() => githubSettings({ repository: 'demo/sandbox', provider: 'gitlab' })).toThrow();
  expect(redactCode(secret)).not.toContain(secret);
});
