import { codePublishPlan, commitCodeBranch, pushCodeBranch } from './codePublish.mjs';
import { codePreview } from './codePreview.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { codeError, createGitRunner, gitRetry, repositoryName } from './codeGit.mjs';
import { createGitHubHost } from './gitHosting.mjs';
import { allowedCodePath, readCodeFile, codeLines, searchCode } from './codeRepoFiles.mjs';
import { writeCodeFile } from './codeRepoWrite.mjs';

/** 仅GitHub只读。最多8仓库缓存/32工作副本；不自动删用户工作，索引不保存代码正文或凭据。 */
export function createCodeRepos({ baseDir, getConfig, git = createGitRunner(), hosting = createGitHubHost(), editing = false, sandbox = null, browser = null }) {
  const root = path.resolve(baseDir),
    indexPath = path.join(root, 'index.json');
  const busy = new Map();
  const operations = new Map(); // 最多两个活动操作，同一worktree不能边写边运行。
  let saving = Promise.resolve();
  const config = async (requested) => {
    const value = (await getConfig()).codeRepos;
    if (!value?.verifiedAt) throw codeError('CODE_NOT_CONNECTED', '请先到设置→代码仓库连接GitHub');
    const repository = repositoryName(value.repository);
    if (requested && repositoryName(requested) !== repository) throw codeError('CODE_REPO_NOT_ALLOWED', '只操作设置中已连接的仓库，请先明确切换仓库');
    return { ...value, repository };
  };
  const directory = async (location) => {
    await fs.mkdir(location, { recursive: true, mode: 0o700 });
    const real = await fs.realpath(location);
    if (real !== location) throw codeError('CODE_PATH', '仓库目录不能是符号链接');
    return real;
  };
  const load = async () => {
    await directory(root);
    let bytes;
    try {
      const stat = await fs.lstat(indexPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw codeError('CODE_REPO_INDEX', '仓库工作副本索引无效');
      bytes = await fs.readFile(indexPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    let rows;
    try {
      rows = JSON.parse(bytes);
    } catch {
      throw codeError('CODE_REPO_INDEX', '工作副本索引损坏，请先核对，未覆盖原记录');
    }
    if (
      !Array.isArray(rows) ||
      rows.length > 32 ||
      rows.some((row) => !/^[a-f0-9]{24}$/.test(row.id) || typeof row.sessionId !== 'string' || typeof row.taskId !== 'string')
    )
      throw codeError('CODE_REPO_INDEX', '工作副本索引格式无效');
    for (const row of rows) repositoryName(row.repository);
    return rows;
  };
  const save = (row) => {
    // 最多两个克隆同时进行；索引写入串行，避免切换仓库时后写覆盖前写。
    const pending = saving.then(async () => {
      const rows = await load(),
        next = [...rows.filter((item) => item.id !== row.id), row];
      if (next.length > 32) throw codeError('CODE_REPO_CAPACITY', '工作副本已达32个，请先由管理员核对保留的工作，不自动删除');
      const tmp = indexPath + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
        await fs.rename(tmp, indexPath);
      } finally {
        await fs.rm(tmp, { force: true });
      }
    });
    saving = pending.catch(() => {}); // 当前调用仍收到原错误，后续写入不被永久锁死。
    return pending;
  };
  const location = (row) => path.join(root, row.repository.replace('/', '__'), 'worktrees', row.id);
  const run = (args, cwd, execution, connection) => git(args, { cwd, signal: execution.signal, token: connection.token || '' });
  const resolve = async (id, sessionId) => {
    if (!/^[a-f0-9]{24}$/.test(id || '')) throw codeError('CODE_WORKTREE', '需要repo_clone返回的工作副本编号');
    const row = (await load()).find((item) => item.id === id && item.sessionId === sessionId);
    if (!row) throw codeError('CODE_WORKTREE', '当前对话没有这个工作副本');
    const connection = await config(row.repository);
    const cwd = location(row);
    if ((await fs.realpath(cwd).catch(() => '')) !== cwd) throw codeError('CODE_WORKTREE', '工作副本不存在或路径已改变，未读取其他目录');
    return { row, connection, cwd };
  };
  const snapshot = async (row, cwd, execution, connection) => {
    const branch = (await run(['symbolic-ref', '--short', 'HEAD'], cwd, execution, connection)).stdout.trim();
    if (branch !== 'weiyang/task-' + row.id) throw codeError('CODE_BRANCH', '工作分支与任务不一致，未重置原工作');
    const head = (await run(['rev-parse', 'HEAD'], cwd, execution, connection)).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw codeError('CODE_COMMIT', '无法核对工作副本提交');
    return {
      workspace_id: row.id,
      repository: row.repository,
      branch,
      head,
      defaultBranch: row.defaultBranch,
      protectDefaultBranch: true,
      readOnly: !editing,
      connection: '已连接'
    };
  };
  async function clone({ repository }, scope, execution = {}) {
    execution.signal?.throwIfAborted();
    if (!scope.sessionId || !scope.taskId) throw codeError('CODE_SCOPE', '克隆需要真实会话和任务编号');
    const connection = await config(repository);
    if (busy.size >= 2 || busy.has(connection.repository)) throw codeError('CODE_REPO_BUSY', '仓库操作正在进行，请等当前操作结束');
    const ctrl = new AbortController();
    const signal = execution.signal ? AbortSignal.any([execution.signal, ctrl.signal]) : ctrl.signal;
    busy.set(connection.repository, ctrl);
    const context = { ...execution, signal };
    try {
      const rows = await load();
      const id = createHash('sha256')
        .update(JSON.stringify([connection.repository, scope.sessionId, scope.taskId]))
        .digest('hex')
        .slice(0, 24);
      const old = rows.find((item) => item.id === id);
      if (old) {
        const current = await resolve(id, scope.sessionId);
        return snapshot(old, current.cwd, context, connection);
      }
      if (rows.length >= 32) throw codeError('CODE_REPO_CAPACITY', '工作副本已达32个，未自动删除或覆盖原工作');
      const caches = (await fs.readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name);
      const cache = path.join(root, connection.repository.replace('/', '__'));
      if (caches.length >= 8 && !caches.includes(path.basename(cache))) throw codeError('CODE_REPO_CAPACITY', '仓库缓存已达8个，请先核对保留的工作');
      await directory(cache);
      context.retrieval?.consume('fetch');
      const meta = await hosting.repository(connection, { signal });
      const bare = path.join(cache, 'bare.git');
      if (!(await fs.stat(bare).catch(() => null))) {
        const staged = path.join(cache, 'clone.pending');
        await gitRetry(async () => {
          await fs.rm(staged, { recursive: true, force: true });
          context.retrieval?.consume('fetch');
          try {
            await run(
              [
                'clone',
                '--bare',
                '--quiet',
                '--depth',
                '1',
                '--single-branch',
                '--branch',
                meta.defaultBranch,
                '--',
                'https://github.com/' + connection.repository + '.git',
                staged
              ],
              cache,
              context,
              connection
            );
            await fs.rename(staged, bare);
          } catch (error) {
            await fs.rm(staged, { recursive: true, force: true });
            throw error;
          }
        }, signal);
      } else {
        await directory(bare);
        await gitRetry(async () => {
          context.retrieval?.consume('fetch');
          await run(
            ['fetch', '--quiet', '--depth', '1', '--no-tags', 'origin', '+refs/heads/' + meta.defaultBranch + ':refs/heads/' + meta.defaultBranch],
            bare,
            context,
            connection
          );
        }, signal);
      }
      const row = {
        id,
        repository: connection.repository,
        sessionId: scope.sessionId,
        taskId: scope.taskId,
        defaultBranch: meta.defaultBranch,
        createdAt: Date.now()
      };
      const worktrees = await directory(path.join(cache, 'worktrees')),
        cwd = path.join(worktrees, id);
      const branch = 'weiyang/task-' + id;
      // 中断后同任务使用同一路径；已有工作只核对，不删文件、不重置分支。
      if (!(await fs.stat(cwd).catch(() => null))) {
        // 包括中断后未登记的副本，不以索引缺失绕开磁盘数量上限。
        if ((await fs.readdir(worktrees)).length >= 32) throw codeError('CODE_REPO_CAPACITY', '此仓库已有32个工作副本，请先核对保留的工作');
        const existing = await git(['show-ref', '--verify', '--quiet', 'refs/heads/' + branch], { cwd: bare, signal, accept: [0, 1] });
        await run(
          existing.exitCode === 0
            ? ['worktree', 'add', '--quiet', cwd, branch]
            : ['worktree', 'add', '--quiet', '-b', branch, cwd, 'refs/heads/' + meta.defaultBranch],
          bare,
          context,
          connection
        );
      }
      await directory(cwd);
      const result = await snapshot(row, cwd, context, connection);
      await save(row);
      return result;
    } finally {
      busy.delete(connection.repository);
    }
  }
  const files = async (current, execution) =>
    (await run(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--'], current.cwd, execution, current.connection)).stdout
      .split('\0')
      .filter(Boolean);
  const operate = async (id, sessionId, execution, action) => {
    execution.signal?.throwIfAborted();
    if (!editing) throw codeError('CODE_READ_ONLY', '当前只开放只读仓库工具');
    if (operations.has(id) || operations.size >= 2) throw codeError('CODE_REPO_BUSY', '工作副本正在操作，请等当前操作结束');
    const ctrl = new AbortController();
    const signal = execution.signal ? AbortSignal.any([execution.signal, ctrl.signal]) : ctrl.signal;
    operations.set(id, ctrl);
    try {
      const current = await resolve(id, sessionId),
        context = { ...execution, signal };
      const view = await snapshot(current.row, current.cwd, context, current.connection);
      const common = (await run(['rev-parse', '--git-common-dir'], current.cwd, context, current.connection)).stdout.trim();
      const expected = path.join(root, current.row.repository.replace('/', '__'), 'bare.git');
      if (view.branch === view.defaultBranch || (await fs.realpath(path.resolve(current.cwd, common))) !== expected)
        throw codeError('CODE_BRANCH', '只能修改本任务的受管工作分支，默认分支或Git目录已变化');
      return await action(current, context);
    } finally {
      operations.delete(id);
    }
  };
  return {
    async connected() {
      const value = (await getConfig()).codeRepos;
      return Boolean(value?.repository && value?.verifiedAt);
    },
    clone,
    // 独立于工具摘要的持久索引；只查真实会话、当前连接仓库，最多8项。
    async workspaces(sessionId, execution = {}) {
      execution.signal?.throwIfAborted();
      const connection = await config();
      const rows = (await load()).filter(row => row.sessionId === sessionId && row.repository === connection.repository);
      const items = [];
      for (const row of rows.slice(-8)) {
        execution.signal?.throwIfAborted();
        const current = await resolve(row.id, sessionId);
        items.push({ ...await snapshot(row, current.cwd, execution, connection), task_id: row.taskId });
      }
      return { items, truncated: rows.length > 8 };
    },
    writable: editing,
    runConfigured: Boolean(editing && sandbox?.configured),
    browserConfigured: Boolean(editing && browser?.configured),
    abortAll() {
      for (const ctrl of busy.values()) ctrl.abort(codeError('CODE_CONNECTION_CHANGED', '仓库连接已变更，当前操作已停止'));
      for (const ctrl of operations.values()) ctrl.abort(codeError('CODE_CONNECTION_CHANGED', '仓库连接已变更，当前操作已停止'));
    },
    async status(id, sessionId, execution = {}) {
      const current = await resolve(id, sessionId);
      const result = await snapshot(current.row, current.cwd, execution, current.connection);
      const raw = (await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], current.cwd, execution, current.connection)).stdout.split('\0');
      const changes = [];
      for (let i = 0; i < raw.length; i++) {
        if (!raw[i]) continue;
        const status = raw[i].slice(0, 2),
          file = raw[i].slice(3);
        if (allowedCodePath(file)) changes.push({ path: file, status });
        if (/[RC]/.test(status)) i++;
      }
      return { ...result, changes: changes.slice(0, 200), truncated: changes.length > 200 };
    },
    async diff(id, sessionId, relative, execution = {}) {
      const current = await resolve(id, sessionId),
        names = relative ? [relative] : (await files(current, execution)).filter(allowedCodePath).slice(0, 200);
      if (relative) await readCodeFile(current.cwd, relative, current.connection.token);
      if (!names.length) return { diff: '', truncated: false };
      let untracked = false;
      if (relative && editing) {
        const found = await git(['ls-files', '--error-unmatch', '--', relative], {
          cwd: current.cwd,
          signal: execution.signal,
          token: current.connection.token || '',
          accept: [0, 1]
        });
        untracked = found.exitCode === 1;
      }
      const args = [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        ...(untracked ? ['--no-index', '--', '/dev/null', relative] : [...(relative ? [] : ['--stat']), 'HEAD', '--', ...names])
      ];
      const output = await git(args, { cwd: current.cwd, signal: execution.signal, token: current.connection.token || '', accept: untracked ? [0, 1] : [0] });
      return {
        diff: output.stdout.slice(0, 16000),
        truncated: output.stdout.length > 16000 || (!relative && names.length === 200),
        scope: relative || '前200个可读已跟踪文件的改动概要；新文件请按repo_status路径读取补丁'
      };
    },
    async read(id, sessionId, relative, start, end, execution = {}) {
      execution.signal?.throwIfAborted();
      const current = await resolve(id, sessionId),
        read = await readCodeFile(current.cwd, relative, current.connection.token);
      execution.signal?.throwIfAborted();
      return { path: relative, sha256: read.sha256, redacted: read.redacted, ...codeLines(read.text, start, end) };
    },
    async search(id, sessionId, query, mode, execution = {}) {
      const current = await resolve(id, sessionId);
      return searchCode(current.cwd, await files(current, execution), query, { mode, token: current.connection.token, signal: execution.signal });
    },
    edit(id, sessionId, input, execution = {}) {
      return operate(id, sessionId, execution, (current, context) =>
        writeCodeFile(current.cwd, input, { token: current.connection.token, signal: context.signal, edit: true })
      );
    },
    write(id, sessionId, input, execution = {}) {
      return operate(id, sessionId, execution, (current, context) =>
        writeCodeFile(current.cwd, input, { token: current.connection.token, signal: context.signal })
      );
    },
    async preview(id, sessionId, entry = 'index.html', execution = {}) {
      const current = await resolve(id, sessionId);
      return codePreview(current.cwd, entry, current.connection.token);
    },
    publishPlan(id, sessionId, execution = {}) {
      return operate(id, sessionId, execution, (current, context) => codePublishPlan(current, context, run));
    },
    commit(id, sessionId, input, execution = {}) {
      return operate(id, sessionId, execution, (current, context) => commitCodeBranch(current, input, context, run));
    },
    push(id, sessionId, input, execution = {}) {
      return operate(id, sessionId, execution, (current, context) => pushCodeBranch(current, input, context, run));
    },
    browser(id, sessionId, input, execution = {}) {
      return operate(id, sessionId, execution, async (current, context) => {
        if (!browser) throw codeError('CODE_BROWSER_UNAVAILABLE', '网页浏览器尚未配置');
        return browser.run({ root: current.cwd, files: await files(current, context), token: current.connection.token, ...input }, context);
      });
    },
    run(id, sessionId, command, execution = {}) {
      return operate(id, sessionId, execution, async (current, context) => {
        if (!sandbox) throw codeError('CODE_SANDBOX_UNAVAILABLE', '尚未配置代码隔离器，不在宿主机执行');
        return sandbox.run({ root: current.cwd, files: await files(current, context), command, token: current.connection.token }, context);
      });
    }
  };
}
