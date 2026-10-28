import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { workflowMaterials, compileArchitectureContent } from '../src/agent/architectureWorkflowInput.js';
import { createArchitectureWorkflowTool } from '../src/agent/architectureWorkflow.js';
import { mediaReceipt } from '../src/agent/actionDelivery.js';
let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-flow-'));
  useBackend(createFileStore(root));
});
afterEach(() => {
  useBackend(null);
  fs.rmSync(root, { recursive: true, force: true });
});
const content = {
  title: '虚构架构',
  entities: [
    { id: 'a', title: '平台', kind: 'system', responsibility: '承载业务', inputs: [], outputs: [], citation: { material: 0, quote: '平台承载业务。' } }
  ],
  relations: [{ from: 'a', to: 'b', type: 'contains', meaning: '承载', assumption: '设计关系，待核对' }],
  requirements: [{ entities: ['a'], citation: { material: 0, quote: '平台承载业务。' } }]
};
it('程序绑定路径与原文，采购需求不采用模型改写，拒绝假引文和空需求', () => {
  const compiled = compileArchitectureContent(
    { ...content, requirements: [{ ...content.requirements[0], text: '模型概括' }] },
    [{ path: '虚构.md' }],
    [{ path: '虚构.md', text: '平台承载业务。' }]
  );
  expect(compiled.requirements[0].text).toBe('平台承载业务。');
  expect(compiled.entities[0].source).toBe('虚构.md');
  expect(compiled.relations[0].assumption).toBeTruthy();
  for (const change of [
    { requirements: [] },
    { entities: [{ ...content.entities[0], citation: { material: 0, quote: '编造' } }] },
    { entities: [{ ...content.entities[0], source: 'user' }] }
  ])
    expect(() => compileArchitectureContent({ ...content, ...change }, [], [{ path: '虚构.md', text: '平台承载业务。' }])).toThrow();
});
it('完整采购大章程序化拆分，不截断，不把其他章节误作已覆盖', async () => {
  await ws.write('原文.md', '第一章 其他\n无关\n第四章 采购需求\n' + '甲'.repeat(125000) + '\n第五章 评审\n结束');
  const result = await workflowMaterials(['原文.md'], undefined);
  expect(result.materials.reduce((n, m) => n + m.text.length, 0)).toBe(('第四章 采购需求\n' + '甲'.repeat(125000) + '\n').length);
  expect(result.sources).toHaveLength(3);
  expect(result.materials.every((m) => !m.text.includes('无关'))).toBe(true);
});
it('坏JSON状态可续用且最多3次理解模型，停止和原件变化不能悄悄重做', async () => {
  await ws.write('原文.md', '平台承载业务。');
  const llm = vi.fn(async () => 'bad-json');
  const tool = createArchitectureWorkflowTool({ llm });
  await expect(tool.run({ files: ['原文.md'], request: '制作架构', directory: '交付' })).rejects.toBeTruthy();
  const jobPath = (await ws.list('文档检查/架构任务')).find((f) => !f.path.includes('.content.')).path;
  for (let i = 0; i < 2; i++) await expect(tool.run({ jobPath })).rejects.toBeTruthy();
  await expect(tool.run({ jobPath })).rejects.toHaveProperty('code', 'ARCHITECTURE_WORKFLOW');
  expect(llm).toHaveBeenCalledTimes(3);
  await ws.write('原文.md', '内容改变');
  await expect(tool.run({ jobPath })).rejects.toThrow('原件已变化');
  expect(llm).toHaveBeenCalledTimes(3);
  const ctrl = new AbortController();
  ctrl.abort();
  await expect(tool.run({ jobPath }, { signal: ctrl.signal })).rejects.toHaveProperty('name', 'AbortError');
});
it('不接受草稿路径当任务，也不把缺四格式/partial回执当完成', async () => {
  const llm = vi.fn();
  await expect(createArchitectureWorkflowTool({ llm }).run({ jobPath: '文档检查/架构底稿/x.architecture.json' })).rejects.toBeTruthy();
  expect(llm).not.toHaveBeenCalled();
  expect(mediaReceipt('build_architecture', true, JSON.stringify({ status: 'partial', completedViews: [] })).state).toBe('pending');
  expect(
    mediaReceipt(
      'build_architecture',
      true,
      JSON.stringify({ status: 'complete', completedViews: [{ editable: true, files: [{ format: 'svg', path: 'a.svg' }] }] })
    ).state
  ).toBe('pending');
});
