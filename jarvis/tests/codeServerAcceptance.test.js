import { it, expect } from 'vitest';
import { codeAcceptance } from '../evals/code-server-acceptance.mjs';
import { CODE_TASK_CORE } from '../src/agent/codeDevelopment.js';
import { createToolLoader } from '../src/agent/toolLoader.js';
import { withLookupDeadline } from '../src/agent/lookupDeadline.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main as runLive } from '../evals/code-server.mjs';
const id = 'a'.repeat(24),
  commit = 'b'.repeat(40);
const scope = { before: commit, after: commit, head: commit, workspaceId: id };
const receipt = (command, ok, digest = 'c'.repeat(64), workspace_id = id) => {
  const toolId = command + String(ok) + digest;
  const result = { command, ok, exitCode: ok ? 0 : 1, install: { exitCode: 0 }, stage: command, isolation: 'docker_offline_snapshot', sourceDigest: digest };
  return [
    { type: 'tool_start', id: toolId, name: 'code_run', args: { workspace_id, command } },
    { type: 'tool_end', id: toolId, name: 'code_run', ok, output: (ok ? '' : '测试失败。完整回执：') + JSON.stringify(result) }
  ];
};
it('真实红转绿、同稿lint和test、只改src/main不变才通过', () => {
  const events = [...receipt('test', false), { type: 'tool_end', name: 'code_edit', ok: true }, ...receipt('lint', true), ...receipt('test', true)];
  expect(codeAcceptance(events, [{ path: 'src/main.mjs' }], scope).state).toBe('passed');
  expect(codeAcceptance(events, [{ path: 'test/main.mjs' }], scope).state).toBe('failed');
  expect(codeAcceptance(events, [{ path: 'src/main.mjs' }], { ...scope, after: 'd'.repeat(40) }).state).toBe('failed');
  expect(codeAcceptance([...events, { type: 'tool_end', name: 'code_write', ok: true }], [{ path: 'src/main.mjs' }], scope).state).toBe('failed');
});
it('伪造done、仅lint、不同副本/不同快照不能算测试通过', () => {
  for (const events of [
    [],
    receipt('lint', true),
    [...receipt('test', false), ...receipt('lint', true), ...receipt('test', true, 'e'.repeat(64))],
    [...receipt('test', false), ...receipt('lint', true), ...receipt('test', true, 'c'.repeat(64), 'f'.repeat(24))]
  ]) {
    expect(codeAcceptance(events, [{ path: 'src/main.mjs' }], scope).state).toBe('failed');
  }
});
it('代码工作模式常驻代码工具，其他工具仍可按需取；默认加载行为不变', () => {
  const tools = Array.from({ length: 30 }, (_, n) => ({ name: 'other_' + n, description: 'other' }));
  tools.push({ name: 'code_read' }, { name: 'write_file' });
  const loader = createToolLoader(tools, { core: CODE_TASK_CORE });
  expect(loader.list().map((tool) => tool.name)).toContain('code_read');
  expect(loader.list().map((tool) => tool.name)).not.toContain('write_file');
  expect(loader.get('write_file').name).toBe('write_file');
  expect(
    createToolLoader(tools)
      .list()
      .map((tool) => tool.name)
  ).toContain('write_file');
});
it('代码工作模式的总时限由任务执行器掌管，不被60秒查询包装再次覆盖', async () => {
  const options = { userText: '检查GitHub仓库', codeWork: { enabled: true } };
  await withLookupDeadline(
    options,
    async (received) => {
      expect(received).toBe(options);
    },
    { totalMs: 1 }
  );
});

it('未配置真实模型时实测入口先阻断，报告不带配置或凭据，也不冒充已验收', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'code-live-input-test-'));
  const oldExit = process.exitCode;
  try {
    const production = path.join(folder, 'production');
    await fs.mkdir(production);
    const secret = 'private-test-value-never-export';
    await fs.writeFile(path.join(production, 'config.json'), JSON.stringify({ provider: 'mock', keys: { mock: secret } }));
    const report = await runLive(['--live', '--data-dir=' + production, '--out-dir=' + path.join(folder, 'results')]);
    expect(report.status).toBe('blocked_readiness');
    expect(report.acceptance.state).toBe('failed');
    expect(report.taskId).toBeUndefined();
    expect(await fs.readFile(path.join(folder, 'results/report.json'), 'utf8')).not.toContain(secret);
  } finally {
    process.exitCode = oldExit;
    await fs.rm(folder, { recursive: true, force: true });
  }
});
