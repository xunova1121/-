import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { ARCHITECTURE_CONTENT_EXAMPLE, normalizeArchitectureContent, applyArchitectureCorrections } from '../src/agent/architectureContentContract.js';
import { WORKFLOW_CONTENT_PROMPT, compileArchitectureContent } from '../src/agent/architectureWorkflowInput.js';
import { makeArchitecturePlan } from '../src/agent/architecturePlan.js';
import { inspectArchitecture } from '../src/agent/architectureReview.js';
import { validateArchitectureContent } from '../src/agent/architectureContentValidation.js';
import { createArchitectureWorkflowTool } from '../src/agent/architectureWorkflow.js';
let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-contract-'));
  useBackend(createFileStore(root));
});
afterEach(() => {
  useBackend(null);
  fs.rmSync(root, { recursive: true, force: true });
});
const original = '示范事项受理后办理。';
const materials = [{ path: '虚构原文.md', text: original }];
const sources = [{ path: '虚构原文.md', excerpt: original }];
const compiled = value => compileArchitectureContent(value, sources, materials);
it('实际注入模型的完整JSON示例能通过原编译和关系校验，不只验证测试手写回复', () => {
  expect(WORKFLOW_CONTENT_PROMPT).toContain(JSON.stringify(ARCHITECTURE_CONTENT_EXAMPLE));
  const plan = makeArchitecturePlan(compiled(ARCHITECTURE_CONTENT_EXAMPLE), materials);
  expect(inspectArchitecture(plan).structure).toBe('passed');
  expect(plan.entities).toHaveLength(2);
  expect(plan.requirements[0].text).toBe(original);
});
it('objects只作为无损别名，不改内容/证据/条数；歧义、未知根键和缺失数组批量拒绝', () => {
  const { entities, ...rest } = structuredClone(ARCHITECTURE_CONTENT_EXAMPLE);
  const raw = { ...rest, objects: entities }, before = structuredClone(raw);
  const result = normalizeArchitectureContent(raw);
  expect(result.content).toEqual(ARCHITECTURE_CONTENT_EXAMPLE);
  expect(result.adapters).toEqual(['objects->entities']);
  expect(raw).toEqual(before);
  expect(makeArchitecturePlan(compiled(raw), materials).entities).toHaveLength(2);
  for (const value of [{ ...raw, entities }, { ...raw, hiddenBusiness: ['不可丢弃'] }, [], null])
    expect(() => normalizeArchitectureContent(value)).toThrow();
  let error;
  try { normalizeArchitectureContent({ title: '缺结构', objects: [], relations: [], requirements: [] }); } catch (e) { error = e; }
  expect(error.diagnostics.map(row => row.field)).toEqual(['entities', 'relations', 'requirements']);
});
it('局部修复只替换已有行，不能删项、加项、重复或夹带完整稿；坏引用和自循环仍拒绝', () => {
  const base = structuredClone(ARCHITECTURE_CONTENT_EXAMPLE), previous = structuredClone(base);
  const relation = { ...base.relations[0], meaning: '修正说明' };
  const response = { corrections: [{ group: 'relations', index: 0, value: relation }] };
  const result = applyArchitectureCorrections(response, base);
  expect(result.content.relations[0]).toEqual(relation);
  expect(result.content.entities).toEqual(base.entities);
  expect(result.content.requirements).toEqual(base.requirements);
  expect(base).toEqual(previous);
  for (const changed of [
    { corrections: [] }, { ...response, title: '夹带' },
    { corrections: [...response.corrections, ...response.corrections] },
    { corrections: [{ ...response.corrections[0], index: 5 }] },
    { corrections: [{ ...response.corrections[0], index: '0' }] },
    { corrections: [{ ...response.corrections[0], remove: true }] }
  ]) expect(() => applyArchitectureCorrections(changed, base)).toThrow();
  expect(() => applyArchitectureCorrections(response, null)).toThrow();
  expect(() => applyArchitectureCorrections({ corrections: [{ ...response.corrections[0], value: { ...relation, meaning: '甲'.repeat(80000) } }] }, base)).toThrow('8万字符');
  const bad = { corrections: [{ group: 'relations', index: 0, value: { ...relation, to: 'receive' } }] };
  expect(() => makeArchitecturePlan(compiled(applyArchitectureCorrections(bad, base).content), materials)).toThrow('自身');
  bad.corrections[0].value.citation.block = 999;
  expect(() => compiled(applyArchitectureCorrections(bad, base).content)).toThrow('原文引用');
});
it('批量字段预检用原校验器，保留旧单错行为；每条自循环/错端点/重复关系都拒绝', () => {
  const input = compiled(ARCHITECTURE_CONTENT_EXAMPLE);
  input.relations = [
    { ...input.relations[0], to: 'receive' }, { ...input.relations[0], to: 'missing' },
    input.relations[0], input.relations[0]
  ];
  expect(() => makeArchitecturePlan(input, materials)).toThrow('自身');
  let error;
  try { makeArchitecturePlan(input, materials, '', [], { collectErrors: true }); } catch (e) { error = e; }
  expect(error.diagnostics.map(row => row.field)).toEqual(['relations[0].to', 'relations[1].from/to', 'relations[3]']);
  expect(error.diagnostics.map(row => row.message).join('')).toContain('重复');
});
it('字段失败时也一并给出可确定的输入输出/闭环错误，不需要另花一轮才发现', () => {
  const input = compiled(ARCHITECTURE_CONTENT_EXAMPLE);
  input.relations = [
    { ...input.relations[0], from: 'handle', to: 'handle' },
    { ...input.relations[0], type: 'dataflow', from: 'handle', to: 'receive' }
  ];
  let error;
  try { validateArchitectureContent(input, materials); } catch (e) { error = e; }
  expect(error.diagnostics.some(row => row.field === 'relations[0].to')).toBe(true);
  expect(error.diagnostics.some(row => row.field === 'relations[1]' && row.stage === 'review')).toBe(true);
  expect(input.relations).toHaveLength(2);
});
it('真实工作流适配objects后进入后续校验，续接只修错误行，完整诊断不会被8项内联上限吞掉', async () => {
  await ws.write('虚构原文.md', original);
  const content = structuredClone(ARCHITECTURE_CONTENT_EXAMPLE);
  content.relations = Array.from({ length: 10 }, () => ({ ...content.relations[0], to: 'receive' }));
  const { entities, ...rest } = content;
  const llm = vi.fn(async args => {
    const prompt = JSON.parse(args.prompt);
    if (args.system.includes('你负责业务理解')) {
      if (!prompt.previousContent) return JSON.stringify({ ...rest, objects: entities });
      expect(prompt.completeDiagnostics.diagnostics).toHaveLength(11);
      expect(prompt.previousContent.entities).toHaveLength(2);
      expect(prompt.previousContent).not.toHaveProperty('objects');
      return JSON.stringify({ corrections: [{ group: 'relations', index: 0, value: ARCHITECTURE_CONTENT_EXAMPLE.relations[0] }] });
    }
    throw new Error('输入仍有9项问题，禁止进入付费业务审查');
  });
  const tool = createArchitectureWorkflowTool({ llm });
  await expect(tool.run({ files: ['虚构原文.md'], request: '制作总体架构', directory: '交付' })).rejects.toThrow('11项');
  const jobPath = (await ws.list('文档检查/架构任务')).find(file => !file.path.includes('.content.')).path;
  const first = JSON.parse(await ws.readText(jobPath));
  expect(first.contentAdapters).toEqual(['objects->entities']);
  expect(first.lastError.diagnostics).toHaveLength(8);
  await expect(tool.run({ jobPath })).rejects.toThrow('10项');
  expect(llm).toHaveBeenCalledTimes(2);
  const state = JSON.parse(await ws.readText(jobPath));
  const saved = JSON.parse(await ws.readText(state.contentPath));
  expect(saved.relations).toHaveLength(10);
  expect(saved.relations[0]).toEqual(ARCHITECTURE_CONTENT_EXAMPLE.relations[0]);
  expect(saved.relations.slice(1)).toEqual(content.relations.slice(1));
  expect(state.stage).toBe('content');
});
