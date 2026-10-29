import { beforeEach, afterEach, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitRunner } from '../server/codeGit.mjs';
import { createCodeRepos } from '../server/codeRepos.mjs';
import { codeLines } from '../server/codeRepoFiles.mjs';
import { createCodeTools } from '../server/codeTools.mjs';
import { isReadOnlyTool } from '../shared/taskCheckpoint.js';

let dir, source, root, service, cfg, head;
const calls = [];
const token = 'ghp_' + 'DummyTestCredential'.repeat(3);
const local = (...args) =>
  execFileSync('git', args, { cwd: source, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const scope = { sessionId: 'session-a', taskId: 'task-a' };
const host = { repository: async () => ({ repository: 'demo/sandbox', defaultBranch: 'main' }) };
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-code-test-'));
  source = path.join(dir, 'upstream');
  root = path.join(dir, 'repos');
  await fs.mkdir(source);
  local('init', '-q', '-b', 'main');
  local('config', 'user.name', '虚构测试');
  local('config', 'user.email', 'test@example.invalid');
  await fs.mkdir(path.join(source, 'src'));
  await fs.writeFile(path.join(source, 'README.md'), '# 示例\n只读仓库\n');
  await fs.writeFile(path.join(source, 'src/demo.js'), 'export const count = 1;\n// hello\n');
  await fs.writeFile(path.join(source, '.env'), 'PRIVATE=must-not-read');
  await fs.writeFile(path.join(source, 'credential.txt'), token);
  local('add', '.');
  local('commit', '-qm', 'fixture');
  head = local('rev-parse', 'HEAD');
  calls.length = 0;
  cfg = { codeRepos: { repository: 'demo/sandbox', verifiedAt: 'test', token } };
  const run = createGitRunner();
  const git = (args, options) => {
    calls.push([...args]);
    // 仅测试适配器映射到虚构本地仓库；生产始终禁file/ext协议。
    return run(['-c', 'protocol.file.allow=always', ...args.map((arg) => (arg === 'https://github.com/demo/sandbox.git' ? 'file://' + source : arg))], options);
  };
  service = createCodeRepos({ baseDir: root, getConfig: async () => cfg, git, hosting: host });
});
afterEach(async () => {
  service?.abortAll();
  await fs.rm(dir, { recursive: true, force: true });
});
const cwd = (id) => path.join(root, 'demo__sandbox', 'worktrees', id);

it('真实git克隆、隔离任务、复用同任务、重启读回，默认主线与上游不变', async () => {
  const a = await service.clone({}, scope);
  const b = await service.clone({}, { ...scope, taskId: 'task-b' });
  expect(a.workspace_id).not.toBe(b.workspace_id);
  expect(a).toMatchObject({ repository: 'demo/sandbox', head, defaultBranch: 'main', readOnly: true, protectDefaultBranch: true });
  expect(a.branch).toBe('weiyang/task-' + a.workspace_id);
  const clones = calls.length;
  expect(await service.clone({}, scope)).toEqual(a);
  expect(calls.slice(clones).some((args) => args.includes('fetch') || args.includes('clone'))).toBe(false);
  const restarted = createCodeRepos({ baseDir: root, getConfig: async () => cfg });
  expect((await restarted.status(a.workspace_id, scope.sessionId)).changes).toEqual([]);
  const read = await restarted.read(a.workspace_id, scope.sessionId, 'README.md', 2, 2);
  expect(read.lines).toEqual([{ line: 2, text: '只读仓库' }]);
  expect(local('rev-parse', 'HEAD')).toBe(head);
  expect(local('symbolic-ref', '--short', 'HEAD')).toBe('main');
  expect(local('status', '--porcelain')).toBe('');
  const gitConfig = await fs.readFile(path.join(root, 'demo__sandbox/bare.git/config'), 'utf8');
  expect(gitConfig).not.toContain(token);
  expect(await fs.readFile(path.join(root, 'index.json'), 'utf8')).not.toContain(token);
  expect((await fs.stat(path.join(root, 'index.json'))).mode & 0o777).toBe(0o600);
  expect(calls.flat().join(' ')).not.toContain(token);
});

it('限制当前已连接仓库、对话范围、路径、符号链接、凭据文件与二进制', async () => {
  const a = await service.clone({}, scope);
  await expect(service.clone({ repository: 'other/repo' }, scope)).rejects.toMatchObject({ code: 'CODE_REPO_NOT_ALLOWED' });
  await expect(service.read(a.workspace_id, 'other-session', 'README.md')).rejects.toMatchObject({ code: 'CODE_WORKTREE' });
  for (const file of ['../upstream/README.md', '/etc/passwd', '.git', '.env', 'src/../README.md', 'id_rsa', 'private.pem', 'C:\\secret']) {
    await expect(service.read(a.workspace_id, scope.sessionId, file)).rejects.toMatchObject({ code: 'CODE_PATH' });
  }
  await fs.symlink(source, path.join(cwd(a.workspace_id), 'outside'));
  await expect(service.read(a.workspace_id, scope.sessionId, 'outside/README.md')).rejects.toMatchObject({ code: 'CODE_SYMLINK' });
  await fs.writeFile(path.join(cwd(a.workspace_id), 'big.txt'), 'x'.repeat(1_000_001));
  await expect(service.read(a.workspace_id, scope.sessionId, 'big.txt')).rejects.toMatchObject({ code: 'CODE_FILE_SIZE' });
  await fs.writeFile(path.join(cwd(a.workspace_id), 'binary'), Buffer.from([0, 1, 2]));
  await expect(service.read(a.workspace_id, scope.sessionId, 'binary')).rejects.toMatchObject({ code: 'CODE_FILE_BINARY' });
  const result = await service.read(a.workspace_id, scope.sessionId, 'credential.txt');
  expect(JSON.stringify(result)).not.toContain(token);
  expect(result.lines[0].text).toContain('已隐藏凭据');
  cfg = {};
  await expect(service.status(a.workspace_id, scope.sessionId)).rejects.toMatchObject({ code: 'CODE_NOT_CONNECTED' });
});

it('搜索、按行读取与补丁回执有界且不泄漏凭据', async () => {
  const a = await service.clone({}, scope),
    id = a.workspace_id;
  expect((await service.search(id, scope.sessionId, 'demo', 'name')).matches).toEqual([{ path: 'src/demo.js' }]);
  expect((await service.search(id, scope.sessionId, 'hello', 'content')).matches[0]).toMatchObject({ path: 'src/demo.js', line: 2 });
  expect((await service.search(id, scope.sessionId, 'must-not-read', 'content')).matches).toEqual([]);
  await fs.writeFile(path.join(cwd(id), 'src/demo.js'), 'export const count = 2;\n' + token);
  expect((await service.status(id, scope.sessionId)).changes).toContainEqual({ path: 'src/demo.js', status: ' M' });
  const diff = await service.diff(id, scope.sessionId, 'src/demo.js');
  expect(diff.diff).toContain('+export const count = 2;');
  expect(diff.diff).not.toContain(token);
  // 文件名也可能含Git通配符；不能通过一个名为*的文件读到被屏蔽的.env补丁。
  await fs.writeFile(path.join(cwd(id), '*'), 'literal filename');
  await fs.writeFile(path.join(cwd(id), '.env'), 'PRIVATE=do-not-leak-env');
  expect((await service.diff(id, scope.sessionId, '*')).diff).toBe('');
  expect((await service.diff(id, scope.sessionId)).diff).toContain('src/demo.js');
  expect(codeLines(('a'.repeat(3000) + '\n').repeat(200), 1, 200)).toMatchObject({ truncated: true });
  expect(() => codeLines('x', 0, 1)).toThrow();
  expect(() => codeLines('x', 1, 201)).toThrow();
});

it('取消/预算耗尽不重试，索引损坏不覆盖，仓库名带点也计入容量', async () => {
  const ctrl = new AbortController();
  ctrl.abort(new Error('stop'));
  await expect(service.clone({}, scope, { signal: ctrl.signal })).rejects.toThrow('stop');
  await expect(
    service.clone({}, scope, {
      retrieval: {
        consume() {
          throw Object.assign(new Error('budget'), { code: 'RETRIEVAL_BUDGET' });
        }
      }
    })
  ).rejects.toMatchObject({ code: 'RETRIEVAL_BUDGET' });
  expect(calls).toHaveLength(0);
  for (let i = 0; i < 8; i++) await fs.mkdir(path.join(root, 'demo__repo.' + i));
  cfg.codeRepos.repository = 'demo/new-repo';
  await expect(service.clone({}, scope)).rejects.toMatchObject({ code: 'CODE_REPO_CAPACITY' });
  await fs.writeFile(path.join(root, 'index.json'), '{broken');
  await expect(service.clone({}, scope)).rejects.toMatchObject({ code: 'CODE_REPO_INDEX' });
  expect(await fs.readFile(path.join(root, 'index.json'), 'utf8')).toBe('{broken');
});

it('五项工具绑定真实会话/任务、保持停止信号，不开放执行/推送；克隆仍记作本机写入', async () => {
  const tools = createCodeTools({ repos: service, ...scope });
  expect(tools.map((t) => t.name)).toEqual(['repo_clone', 'repo_status', 'repo_diff', 'code_search', 'code_read']);
  const result = JSON.parse(await tools[0].run({ sessionId: 'forged', taskId: 'forged' }));
  expect(await service.status(result.workspace_id, scope.sessionId)).toMatchObject({ readOnly: true });
  await expect(service.status(result.workspace_id, 'forged')).rejects.toMatchObject({ code: 'CODE_WORKTREE' });
  expect(isReadOnlyTool('repo_clone')).toBe(false);
  expect(tools.slice(1).every((t) => isReadOnlyTool(t.name))).toBe(true);
});
