import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { codeRepoFixture } from './helpers/codeRepoFixture.mjs';
import { createCodeTools } from '../server/codeTools.mjs';
const files = { 'sum.js': 'export const sum=(a,b)=>a-b;\n', 'sum.test.js': '// original tests must remain unchanged\n' };
const scope = { sessionId: 'p2-session', taskId: 'p2-task' };
it('可写服务仅改任务分支，旧测试保持、状态/补丁真实、上游main不变', async () => {
  const f = await codeRepoFixture(files);
  try {
    const a = await f.repos.clone({}, scope);
    expect(a.readOnly).toBe(false);
    await f.repos.edit(a.workspace_id, scope.sessionId, { path: 'sum.js', old: 'a-b', new: 'a+b' });
    const read = await f.repos.read(a.workspace_id, scope.sessionId, 'sum.js');
    expect(read.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(read.lines[0].text).toContain('a+b');
    expect((await f.repos.diff(a.workspace_id, scope.sessionId, 'sum.js')).diff).toContain('+export const sum=(a,b)=>a+b;');
    await f.repos.write(a.workspace_id, scope.sessionId, { path: 'src/extra.js', content: 'export const x=1;' });
    expect((await f.repos.status(a.workspace_id, scope.sessionId)).changes.map((v) => v.path)).toContain('src/extra.js');
    expect((await f.repos.diff(a.workspace_id, scope.sessionId, 'src/extra.js')).diff).toContain('+export const x=1;');
    expect(await fs.readFile(path.join(f.cwd(a.workspace_id), 'sum.test.js'), 'utf8')).toBe(files['sum.test.js']);
    expect(f.command(f.source, 'status', '--porcelain')).toBe('');
    expect(f.command(f.source, 'rev-parse', 'HEAD')).toBe(f.original);
    await expect(f.repos.edit(a.workspace_id, 'other-session', { path: 'sum.js', old: 'a+b', new: 'x' })).rejects.toMatchObject({ code: 'CODE_WORKTREE' });
    f.command(f.cwd(a.workspace_id), 'symbolic-ref', 'HEAD', 'refs/heads/main');
    await expect(f.repos.edit(a.workspace_id, scope.sessionId, { path: 'sum.js', old: 'a+b', new: 'x' })).rejects.toMatchObject({ code: 'CODE_BRANCH' });
  } finally {
    await f.close();
  }
});
it('执行和修改互斥；断开连接停止正在运行的沙箱，失败后不锁死', async () => {
  let observed = false;
  const sandbox = {
    configured: true,
    run: async (input, { signal }) => {
      observed = true;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  };
  const f = await codeRepoFixture(files, { sandbox });
  try {
    const a = await f.repos.clone({}, scope),
      pending = f.repos.run(a.workspace_id, scope.sessionId, 'test');
    const failure = expect(pending).rejects.toMatchObject({ code: 'CODE_CONNECTION_CHANGED' });
    for (let i = 0; i < 100 && !observed; i++) await new Promise((r) => setTimeout(r, 10));
    expect(observed).toBe(true);
    await expect(f.repos.edit(a.workspace_id, scope.sessionId, { path: 'sum.js', old: 'a-b', new: 'a+b' })).rejects.toMatchObject({ code: 'CODE_REPO_BUSY' });
    f.repos.abortAll();
    await failure;
    expect((await f.repos.edit(a.workspace_id, scope.sessionId, { path: 'sum.js', old: 'a-b', new: 'a+b' })).saved).toBe(true);
  } finally {
    await f.close();
  }
});
it('代码工具显式开放P2，测试失败必须标错并带退出码/真实日志；无推送/合并入口', async () => {
  const seen = [];
  const repos = {
    run: async (...args) => {
      seen.push(args);
      return { ok: false, stage: 'test', exitCode: 1, stdout: 'assertion 2 != 3', stderr: '' };
    }
  };
  expect(createCodeTools({ repos, ...scope })).toHaveLength(5);
  const tools = createCodeTools({ repos, ...scope, editing: true });
  expect(tools.map((t) => t.name)).toEqual(['repo_clone', 'repo_status', 'repo_diff', 'code_search', 'code_read', 'code_edit', 'code_write', 'code_run']);
  const ctrl = new AbortController();
  await expect(tools.find((t) => t.name === 'code_run').run({ workspace_id: 'a'.repeat(24), command: 'test' }, { signal: ctrl.signal })).rejects.toMatchObject({
    code: 'CODE_TEST_FAILED',
    message: expect.stringContaining('assertion 2 != 3')
  });
  expect(seen[0].slice(0, 3)).toEqual(['a'.repeat(24), scope.sessionId, 'test']);
  expect(seen[0][3].signal).toBe(ctrl.signal);
});
it('长验收元数据不能挤掉200字失败摘要中的实际错误，沿用原失败记录而不另造解释', async () => {
  const value = {
    command: 'test',
    files: 1000,
    bytes: 16_000_000,
    sourceDigest: 'a'.repeat(64),
    dependencies: { packages: 128, downloadedBytes: 32_000_000, registry: 'https://registry.npmmirror.com' },
    imageId: 'sha256:' + 'b'.repeat(64),
    isolation: 'docker_offline_snapshot',
    hostWorktreeWritable: false,
    stage: 'test',
    ok: false,
    exitCode: 1,
    stdout: 'normal preamble\nnot ok 3 - discount mismatch\nexpected 10 actual 9',
    stderr: ''
  };
  const tool = createCodeTools({ repos: { run: async () => value }, ...scope, editing: true }).find((t) => t.name === 'code_run');
  try {
    await tool.run({ workspace_id: 'a'.repeat(24), command: 'test' });
    throw Error('should reject');
  } catch (error) {
    expect(error.code).toBe('CODE_TEST_FAILED');
    expect(error.message.slice(0, 200)).toContain('discount mismatch');
    expect(error.message.slice(0, 200)).toContain('expected 10 actual 9');
    expect(error.result).toBe(value);
  }
});
