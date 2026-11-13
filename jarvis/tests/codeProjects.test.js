import { it, expect } from 'vitest';
import { createCodeProjects } from '../server/codeProjects.mjs';
import { createGitRunner } from '../server/codeGit.mjs';
import { codeRepoFixture } from './helpers/codeRepoFixture.mjs';
import { withoutCodeCredentials } from '../server/gitHosting.mjs';
import { createGitHubProjects } from '../server/githubProjects.mjs';
it('项目确认后真实本地Git建分支/保存；持久绑定与hash守护，main不变', async () => {
  const f = await codeRepoFixture({ 'README.md': 'fixture\n' }),
    cfg = { ...f.cfg, codeAccount: { login: 'demo', token: 'x'.repeat(32), verifiedAt: 'fixture' } };
  const commands = [],
    calls = [],
    bindings = [],
    raw = createGitRunner();
  const git = (args, init) => {
    commands.push(args);
    return raw(
      ['-c', 'protocol.file.allow=always', ...args.map((v) => (/^https:\/\/github.com\/demo\/[a-z-]+\.git$/.test(v) ? 'file://' + f.source : v))],
      init
    );
  };
  const o = {
    dataDir: f.directory,
    getConfig: () => cfg,
    saveConfig: (v) => Object.assign(cfg, v),
    legacyRepos: f.repos,
    git,
    hosting: { repository: async (c) => ({ repository: c.repository, defaultBranch: 'main' }) },
    github: {
      account: async () => ({ login: 'demo' }),
      create: async (_, r) => {
        calls.push(r);
        return { repository: 'demo/' + r.name, private: r.private, defaultBranch: 'main' };
      },
      ensureBranch: async () => {}
    },
    onBind: async (...a) => bindings.push(a)
  };
  try {
    const p = createCodeProjects(o),
      r = await p.prepare({ name: 'new-project', title: '测试项目' }, 'owner');
    expect(calls).toHaveLength(0);
    expect(r.private).toBe(true);
    const made = await p.execute(r.id, 'owner');
    expect(calls).toHaveLength(1);
    expect(made.workspace.branch).toMatch(/^weiyang\/task-[a-f0-9]{24}$/);
    expect((await p.execute(r.id, 'owner')).workspace.workspace_id).toBe(made.workspace.workspace_id);
    expect(calls).toHaveLength(1);
    const q = createCodeProjects(o),
      s = await q.list('owner');
    expect(s.current.name).toBe('测试项目');
    expect(s.workspaces.items[0].workspace_id).toBe(made.workspace.workspace_id);
    expect(JSON.stringify(s)).not.toContain(cfg.codeAccount.token);
    expect(bindings.at(-1)[2]).toBe('project-' + r.id);
    const repos = await q.reposFor('owner'),
      id = made.workspace.workspace_id;
    await repos.write(id, 'owner', { path: 'index.html', content: '<title>First</title>' });
    const proposal = await q.prepareSave({ workspace_id: id }, 'owner');
    expect(proposal.files).toHaveLength(1);
    expect(commands.some((a) => a.includes('push'))).toBe(false);
    const before = await repos.read(id, 'owner', 'index.html', 1, 10);
    await repos.write(id, 'owner', { path: 'index.html', content: '<title>Changed</title>', expected_sha256: before.sha256 });
    await expect(q.execute(proposal.id, 'owner')).rejects.toMatchObject({ code: 'CODE_APPROVAL_STALE' });
    expect(commands.some((a) => a.includes('push'))).toBe(false);
    const next = await q.prepareSave({ workspace_id: id, message: 'Add page' }, 'owner'),
      saved = await q.execute(next.id, 'owner');
    expect(saved.pushed).toBe(true);
    expect(f.command(f.source, 'rev-parse', 'main')).toBe(f.original);
    expect(f.command(f.source, 'rev-parse', saved.branch)).toBe(saved.commit);
    expect(commands.find((a) => a.includes('push'))).not.toContain('--force');
    expect((await repos.status(id, 'owner')).changes).toEqual([]);
    await expect(q.selectWorkspace(id, 'other')).rejects.toMatchObject({ code: 'CODE_WORKTREE' });
  } finally {
    await f.close();
  }
}, 30000);
it('模型配置不能包含独立GitHub账号凭据', () => {
  expect(withoutCodeCredentials({ keys: { custom: 'model' }, codeRepos: { token: 'repo' }, codeAccount: { token: 'account' } })).toEqual({
    keys: { custom: 'model' }
  });
});
it('固定GitHub API默认私有，拒绝访问有明确错误', async () => {
  const seen = [],
    h = createGitHubProjects({
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return new Response(JSON.stringify(url.endsWith('/user') ? { login: 'demo' } : { full_name: 'demo/example', private: true, default_branch: 'main' }));
      }
    });
  expect(await h.create('x'.repeat(32), { name: 'example' })).toMatchObject({ repository: 'demo/example', private: true });
  expect(seen.every((r) => r.url.startsWith('https://api.github.com/') && r.init.redirect === 'manual')).toBe(true);
  expect(JSON.parse(seen.at(-1).init.body)).toMatchObject({ private: true, auto_init: true });
  const denied = createGitHubProjects({ fetchImpl: async () => new Response('upstream text', { status: 403 }) });
  await expect(denied.account('x'.repeat(32))).rejects.toMatchObject({ code: 'CODE_GITHUB_FORBIDDEN', upstreamStatus: 403 });
});
it('建仓外部写入前已持久登记；重启后不重复POST，未知对话不发外部请求', async () => {
  const fs = await import('node:fs/promises'),
    os = await import('node:os'),
    path = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'code-create-guard-'));
  const cfg = { codeAccount: { login: 'demo', token: 'x'.repeat(32), verifiedAt: 'fixture' } };
  let calls = 0;
  const options = {
    dataDir: directory,
    getConfig: () => cfg,
    saveConfig: () => {},
    legacyRepos: {},
    github: {
      account: async () => ({ login: 'demo' }),
      create: async () => {
        calls++;
        const index = JSON.parse(await fs.readFile(path.join(directory, 'code-projects/index.json'), 'utf8'));
        expect(index.requests[0].status).toBe('creating');
        throw Object.assign(new Error('network uncertain'), { code: 'CODE_GITHUB_NETWORK' });
      }
    },
    validateSession: async (id) => {
      if (id !== 'owner') throw Object.assign(new Error('unknown'), { code: 'CODE_SCOPE' });
    }
  };
  try {
    const p = createCodeProjects(options);
    await expect(p.prepare({ name: 'no-side-effect' }, 'unknown')).rejects.toMatchObject({ code: 'CODE_SCOPE' });
    expect(calls).toBe(0);
    const r = await p.prepare({ name: 'retry-guard' }, 'owner');
    await expect(p.execute(r.id, 'owner')).rejects.toMatchObject({ code: 'CODE_GITHUB_NETWORK' });
    expect(calls).toBe(1);
    const restored = createCodeProjects(options);
    await expect(restored.execute(r.id, 'owner')).rejects.toMatchObject({ code: 'CODE_PROJECT_UNCERTAIN' });
    expect(calls).toBe(1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
it('本地已提交但提交号没记下（服务重启）：再确认时沿用原提交推送，不重复提交、不卡死；别的提交不冒认', async () => {
  const f = await codeRepoFixture({ 'README.md': 'fixture\n' }),
    cfg = { ...f.cfg, codeAccount: { login: 'demo', token: 'x'.repeat(32), verifiedAt: 'fixture' } };
  const raw = createGitRunner(),
    commands = [];
  const git = (args, init) => {
    commands.push(args);
    return raw(['-c', 'protocol.file.allow=always', ...args.map((v) => (/^https:\/\/github.com\/demo\/[a-z-]+\.git$/.test(v) ? 'file://' + f.source : v))], init);
  };
  const o = {
    dataDir: f.directory,
    getConfig: () => cfg,
    saveConfig: (v) => Object.assign(cfg, v),
    legacyRepos: f.repos,
    git,
    hosting: { repository: async (c) => ({ repository: c.repository, defaultBranch: 'main' }) },
    github: { account: async () => ({ login: 'demo' }), create: async (_, r) => ({ repository: 'demo/' + r.name, private: true, defaultBranch: 'main' }), ensureBranch: async () => {} },
    onBind: async () => {}
  };
  try {
    const p = createCodeProjects(o),
      made = await p.execute((await p.prepare({ name: 'restart-project', title: '重启' }, 'owner')).id, 'owner'),
      id = made.workspace.workspace_id,
      repos = await p.reposFor('owner');
    await repos.write(id, 'owner', { path: 'index.html', content: '<title>A</title>' });
    const save = await p.prepareSave({ workspace_id: id, message: 'Add page' }, 'owner');
    // 模拟：提交已经做完，但还没来得及把提交号写进确认记录就重启了
    const lost = await repos.commit(id, 'owner', { digest: save.digest, message: save.message });
    const again = createCodeProjects(o),
      pushed = await again.execute(save.id, 'owner');
    expect(pushed.commit).toBe(lost.commit);
    expect(f.command(f.source, 'rev-parse', pushed.branch)).toBe(lost.commit);
    expect(commands.filter((a) => a.includes('commit')).length).toBe(1);
    // 说明不同的提交（不是这次确认产生的）不能冒认
    await repos.write(id, 'owner', { path: 'b.html', content: '<title>B</title>' });
    const other = await again.prepareSave({ workspace_id: id, message: 'Add b' }, 'owner');
    await repos.commit(id, 'owner', { digest: other.digest, message: 'Something else' });
    await expect(again.execute(other.id, 'owner')).rejects.toMatchObject({ code: 'CODE_APPROVAL_STALE' });
    expect(f.command(f.source, 'rev-parse', 'main')).toBe(f.original);
  } finally {
    await f.close();
  }
}, 30000);
