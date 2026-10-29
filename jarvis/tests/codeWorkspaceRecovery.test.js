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
