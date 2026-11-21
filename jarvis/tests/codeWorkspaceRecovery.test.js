import { it, expect } from 'vitest';
import { codeRepoFixture } from './helpers/codeRepoFixture.mjs';
import { createCodeRepos } from '../server/codeRepos.mjs';

it('重建仓库管理器后从持久索引恢复；原任务clone复用旧副本，不覆盖脏文件', async () => {
  const f = await codeRepoFixture({ 'src/demo.mjs': 'export const n=1;' });
  try {
    const scope = { sessionId: 'owner', taskId: 'original' };
    const first = await f.repos.clone({}, scope);
    await f.repos.edit(first.workspace_id, scope.sessionId, { path: 'src/demo.mjs', old: 'n=1', new: 'n=2' });
    const restarted = createCodeRepos({ baseDir: f.root, getConfig: async () => f.cfg, editing: true });
    const found = await restarted.workspaces(scope.sessionId);
    expect(found.items).toHaveLength(1);
    expect(found.items[0].workspace_id).toBe(first.workspace_id);
    expect((await restarted.clone({}, scope)).workspace_id).toBe(first.workspace_id);
    expect((await restarted.read(first.workspace_id, scope.sessionId, 'src/demo.mjs')).lines[0].text).toContain('n=2');
    expect((await restarted.status(first.workspace_id, scope.sessionId)).changes).toEqual([{ path: 'src/demo.mjs', status: ' M' }]);
    expect((await restarted.workspaces('other')).items).toEqual([]);
    f.cfg.codeRepos.repository = 'other/repository';
    expect((await restarted.workspaces(scope.sessionId)).items).toEqual([]);
    expect(f.command(f.source, 'rev-parse', 'HEAD')).toBe(f.original);
    expect(f.command(f.source, 'status', '--porcelain')).toBe('');
  } finally {
    await f.close();
  }
});

it('索引最多返回8个同会话副本，超出明确标注；停止后不继续读取', async () => {
  const f = await codeRepoFixture({ 'a.js': '1' });
  try {
    const ids = [];
    for (let n = 0; n < 9; n++) ids.push((await f.repos.clone({}, { sessionId: 'owner', taskId: 'task' + n })).workspace_id);
    const result = await f.repos.workspaces('owner');
    expect(result.truncated).toBe(true);
    expect(result.items.map((item) => item.workspace_id)).toEqual(ids.slice(-8));
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(f.repos.workspaces('owner', { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    await f.close();
  }
});

it('仓库管理器存在不等于已连接，断开配置后工作模式不得继续启用', async () => {
  const f = await codeRepoFixture({ 'a.js': '1' });
  try {
    expect(await f.repos.connected()).toBe(true);
    delete f.cfg.codeRepos;
    expect(await f.repos.connected()).toBe(false);
  } finally {
    await f.close();
  }
});

it('换了对话也能找到原副本：别的对话里的副本能列出、接过来接着改，不另开新副本（用户 2026-10-30）', async () => {
  const f = await codeRepoFixture({ 'src/cart.js': 'export const max=1;' });
  try {
    const first = await f.repos.clone({}, { sessionId: 'old-chat', taskId: 'original' });
    await f.repos.edit(first.workspace_id, 'old-chat', { path: 'src/cart.js', old: 'max=1', new: 'max=2' });
    expect((await f.repos.workspaces('new-chat')).items).toEqual([]);
    const listed = await f.repos.elsewhere('new-chat');
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ workspace_id: first.workspace_id, session_id: 'old-chat', changedCount: 1, changedFiles: ['src/cart.js'] });
    expect((await f.repos.elsewhere('old-chat')).items).toEqual([]);
    // 新对话直接拿编号查：说清楚在别的对话里，可以接过来
    await expect(f.repos.status(first.workspace_id, 'new-chat')).rejects.toMatchObject({ code: 'CODE_WORKTREE', message: expect.stringContaining('另一段对话里') });
    const taken = await f.repos.adopt(first.workspace_id, 'new-chat');
    expect(taken).toMatchObject({ workspace_id: first.workspace_id, adopted: true, task_id: 'original' });
    expect((await f.repos.status(first.workspace_id, 'new-chat')).changes).toEqual([{ path: 'src/cart.js', status: ' M' }]);
    expect((await f.repos.workspaces('old-chat')).items).toEqual([]); // 同一时间只归一段对话
    // 续做按原任务clone：认出接过来的那份，不另开
    expect((await f.repos.clone({}, { sessionId: 'new-chat', taskId: 'original' })).workspace_id).toBe(first.workspace_id);
    expect((await f.repos.read(first.workspace_id, 'new-chat', 'src/cart.js')).lines[0].text).toContain('max=2');
    await expect(f.repos.adopt('f'.repeat(24), 'new-chat')).rejects.toMatchObject({ code: 'CODE_WORKTREE' });
  } finally {
    await f.close();
  }
});

it('repo_adopt 工具：用户给编号就能接过来（用户 2026-10-30：新对话里报“当前对话没有这个工作副本”）', async () => {
  const { createRepoAdoptTool } = await import('../server/codeTools.mjs');
  const f = await codeRepoFixture({ 'a.js': '1' });
  try {
    const first = await f.repos.clone({}, { sessionId: 'chat-a', taskId: 't' });
    const tool = createRepoAdoptTool({ repos: f.repos, sessionId: 'chat-b' });
    expect(JSON.parse(await tool.run({ workspace_id: first.workspace_id }))).toMatchObject({ workspace_id: first.workspace_id, adopted: true });
    expect((await f.repos.workspaces('chat-b')).items.map((x) => x.workspace_id)).toEqual([first.workspace_id]);
  } finally {
    await f.close();
  }
});
