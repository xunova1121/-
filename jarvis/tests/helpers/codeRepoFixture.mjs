import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitRunner } from '../../server/codeGit.mjs';
import { createCodeRepos } from '../../server/codeRepos.mjs';
/** 仅虚构本地上游，不读取真实测试仓库的隐藏答案。 */
export async function codeRepoFixture(files, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'code-p2-fixture-'));
  const source = path.join(directory, 'upstream'),
    root = path.join(directory, 'repos');
  await fs.mkdir(source);
  const command = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  command(source, 'init', '-q', '-b', 'main');
  command(source, 'config', 'user.email', 'test@example.invalid');
  command(source, 'config', 'user.name', '虚构测试');
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(source, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  command(source, 'add', '.');
  command(source, 'commit', '-qm', 'fixture');
  const original = command(source, 'rev-parse', 'HEAD');
  const cfg = { codeRepos: { repository: 'demo/sandbox', verifiedAt: 'fixture', token: options.token || '' } };
  const git = createGitRunner();
  const repos = createCodeRepos({
    baseDir: root,
    getConfig: async () => cfg,
    editing: true,
    ...options,
    git: (args, init) =>
      git(['-c', 'protocol.file.allow=always', ...args.map((value) => (value === 'https://github.com/demo/sandbox.git' ? 'file://' + source : value))], init),
    hosting: { repository: async () => ({ repository: 'demo/sandbox', defaultBranch: 'main' }) }
  });
  return {
    directory,
    source,
    root,
    repos,
    cfg,
    original,
    command,
    cwd: (id) => path.join(root, 'demo__sandbox/worktrees', id),
    async close() {
      repos.abortAll();
      await fs.rm(directory, { recursive: true, force: true });
    }
  };
}
