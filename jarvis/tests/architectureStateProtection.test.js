import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { isArchitectureManagedPath, assertArchitectureWriteAllowed, assertArchitectureMutationBatch, assertArchitectureToolCall } from '../src/agent/architectureStateProtection.js';
import { executeToolCalls } from '../src/agent/agentToolExecution.js';
import { createExecutionReview } from '../src/agent/executionReview.js';
let root;
const managed = '文档检查/架构任务/synthetic.content.json';
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-protection-'));
  useBackend(createFileStore(root));
  await ws.write(managed, '{"relations":[{"from":"a","to":"b"}]}');
});
afterEach(() => { useBackend(null); fs.rmSync(root, { recursive: true, force: true }); });
it('真实受管目录、路径别名、百分号编码及目录本身都不能由通用工具改写', async () => {
  for (const input of [managed, './'+managed, '/workspace/'+managed, managed.replaceAll('/', '\\'), encodeURIComponent(managed), '文档检查', '文档检查/架构任务', '文档检查/普通/../架构任务/synthetic.content.json', 'C:\\Work\\文档检查.\\架构任务 \\synthetic.content.json']) {
    expect(isArchitectureManagedPath(input)).toBe(true);
    await expect(assertArchitectureWriteAllowed(input, '{}')).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
  }
  for (const input of ['交付/架构图.svg', '用户文档/说明.json', '文档检查/架构核验报告.md'])
    await expect(assertArchitectureWriteAllowed(input, '普通用户文件')).resolves.toBeUndefined();
});
it('未知修改别名及补丁路径也检查；普通文件正文里提到受管路径不误拦', async () => {
  for (const [tool, args] of [
    ['edit_file', { path: managed, edits: [] }], ['write_file', { path: managed, content: '{}' }],
    ['mcp_custom_patch', { parameters: { operations: [{ op: 'remove', path: managed }] } }],
    ['mcp_custom_patch', { payload: { path: managed, content: '{}' } }],
    ['custom_remove', { body: { path: managed } }],
    ['move_file', { from: managed, to: '公开/备份.json' }], ['mcp_move', { source: managed, destinationPath: '普通.json' }],
    ['custom_move', { old_path: '普通.json', newPath: managed }], ['remove_folder', { path: '文档检查/架构任务' }],
    ['apply_patch', { input: '*** Begin Patch\n*** Update File: '+managed+'\n@@\n-a\n+b\n*** End Patch' }],
    ['apply_patch', { input: '*** Begin Patch\n*** Update File: 普通.txt\n*** Move to: '+managed+'\n@@\n-a\n+b\n*** End Patch' }],
    ['git_patch', { diff: 'diff --git a/普通.json b/'+managed+'\nrename from 普通.json\nrename to '+managed }],
    ['custom_alias', { params: { patch: '--- a/'+managed+'\n+++ b/'+managed+'\n@@\n-a\n+b' } }],
    ['computer_run', { command: 'sed -i "s/a/b/" "'+managed+'"' }]
  ]) await expect(assertArchitectureToolCall(tool, args)).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
  await expect(assertArchitectureToolCall('write_file', { path: '说明.md', content: '请阅读'+managed })).resolves.toBeUndefined();
});
it('通用读取与工作流自己的续接/修订保持可用，不能把显式输出定到内部目录', async () => {
  for (const tool of ['read_file', 'preview', 'computer_read_file']) await expect(assertArchitectureToolCall(tool, { path: managed })).resolves.toBeUndefined();
  await expect(assertArchitectureToolCall('build_architecture', { jobPath: '文档检查/架构任务/synthetic.json' })).resolves.toBeUndefined();
  await expect(assertArchitectureToolCall('revise_architecture_plan', { architecturePath: '文档检查/架构底稿/synthetic.architecture.json' })).resolves.toBeUndefined();
  await expect(assertArchitectureToolCall('create_diagram', { path: '交付/图.svg', architecturePath: '文档检查/架构底稿/synthetic.architecture.json' })).resolves.toBeUndefined();
  await expect(assertArchitectureToolCall('create_diagram', { path: managed })).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
  // 内部程序写入不经通用工具门，既有工作流不用新增全局异步锁或暗中放行。
  await ws.write(managed, '{"relations":[]}'); expect(await ws.readText(managed)).toBe('{"relations":[]}');
});
it('动态交付/设计清单按真实所有权元数据识别；阻止新伪造及覆盖，不封锁普通JSON', async () => {
  const owner = { version: 1, architecturePath: '文档检查/架构底稿/a.architecture.json', planHash: 'sha256:fixture' };
  await ws.write('项目/交付清单.json', JSON.stringify(owner));
  await expect(assertArchitectureToolCall('edit_file', { path: '项目/交付清单.json', edits: [] })).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
  await expect(assertArchitectureToolCall('write_file', { path: '其他/交付清单.json', content: JSON.stringify(owner) })).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
  await ws.write('项目/总体.diagram.json', JSON.stringify({ architecture: { planPath: owner.architecturePath, planHash: owner.planHash } }));
  await expect(assertArchitectureToolCall('edit_file', { path: '项目/总体.diagram.json' })).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
  await expect(assertArchitectureToolCall('write_file', { path: '普通/交付清单.json', content: '{"files":["报告.docx"]}' })).resolves.toBeUndefined();
});
it('实际回写批次先全部检查，Python动态拼接路径也不能落盘；停止信号继续上抛', async () => {
  const constructed = ['文档检查', '架构任务', 'synthetic.content.json'].join('/');
  const changes = [{ path: 'public.txt', bytes: new TextEncoder().encode('尚不写入') }, { path: constructed, bytes: new TextEncoder().encode('{}') }];
  await expect(assertArchitectureMutationBatch(changes)).rejects.toHaveProperty('code', 'ARCHITECTURE_STATE_PROTECTED');
  expect(await ws.exists('public.txt')).toBe(false);
  expect(await ws.readText(managed)).toContain('relations');
  const controller = new AbortController(); controller.abort();
  await expect(assertArchitectureMutationBatch(changes, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
});
it('执行器在审批/检查点/副作用前拦截，原工作稿逐字不变；普通修改照常执行', async () => {
  const run = vi.fn(async args => { await ws.write(args.path, args.content || '{}'); return 'done'; });
  const tools = new Map(['edit_file', 'mcp_patch_alias', 'write_file'].map(name => [name, { name, input_schema: { properties: {} }, run, approval: vi.fn(() => null) }]));
  const context = { loader: { get: name => tools.get(name) }, emit: vi.fn(), seen: new Map(), review: createExecutionReview('编辑工作区文件'), webTools: new Set(), parallelSafe: new Set(), retrieval: { extensive: true, consume: vi.fn() }, checkpoint: vi.fn() };
  const original = await ws.readText(managed);
  for (const name of ['edit_file', 'mcp_patch_alias']) {
    const result = await executeToolCalls([{ id: name, name, args: { path: managed, content: '{}' } }], context);
    expect(result[0].ok).toBe(false); expect(result[0].output).toContain('受管文件');
  }
  expect(run).not.toHaveBeenCalled(); expect(await ws.readText(managed)).toBe(original);
  expect(context.checkpoint.mock.calls.some(([event]) => event.type === 'tool_start')).toBe(false);
  const result = await executeToolCalls([{ id: 'normal', name: 'write_file', args: { path: '普通.txt', content: '允许修改' } }], context);
  expect(result[0].ok).toBe(true); expect(await ws.readText('普通.txt')).toBe('允许修改');
});
