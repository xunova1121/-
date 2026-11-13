import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { diagramDigest } from '../src/agent/diagramExport.js';
import { ARCHITECTURE_CONTENT_EXAMPLE } from '../src/agent/architectureContentContract.js';
import { createArchitectureWorkflowTool } from '../src/agent/architectureWorkflow.js';
import { loadWorkflowContent, mapWorkflowDiagnostics, saveWorkflowContent } from '../src/agent/architectureWorkflowIntegrity.js';

let root;
const args = { files: ['虚构原文.md'], request: '制作总体架构', directory: '交付' };
const stateOf = async jobPath => JSON.parse(await ws.readText(jobPath));
const task = async () => (await ws.list('文档检查/架构任务')).find(file => /^文档检查\/架构任务\/[\w-]+\.json$/.test(file.path)).path;
const isContent = request => request.system.includes('你负责业务理解');
const malformedPlan = () => {
  const content = structuredClone(ARCHITECTURE_CONTENT_EXAMPLE);
  content.relations[0].type = 'dataflow'; content.entities[0].outputs = [];
  return content;
};
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-integrity-'));
  useBackend(createFileStore(root));
  await ws.write('虚构原文.md', '示范事项受理后办理，用户提交受理操作，平台提供查询与办理能力。');
});
afterEach(() => { useBackend(null); fs.rmSync(root, { recursive: true, force: true }); });
async function assertIntegrityFailure(jobPath, attempts) {
  const state = await stateOf(jobPath);
  expect(state).toMatchObject({ attempts, terminalFailure: { phase: 'integrity', code: 'WORKFLOW_CONTENT_CHANGED' } });
  expect(state.lastError).toMatchObject({ code: 'ARCHITECTURE_WORKFLOW_INTEGRITY', diagnostics: [{ field: 'contentPath', stage: 'integrity' }] });
  const full = JSON.parse(await ws.readText(state.lastError.issuesPath));
  expect(full.diagnostics[0]).toMatchObject({ field: 'contentPath', stage: 'integrity' });
  expect(state.manifestPath).toBeUndefined();
  return state;
}

it('形式需求索引只映射一次，保留原始编号及未知诊断；输入报告不被改写', () => {
  const report = {
    diagnostics: [{ field: 'requirements[3].entities', stage: 'arguments' }, { field: 'requirements[9].text', stage: 'fact' }],
    issues: [{ target: 'requirement:3', kind: 'coverage', detail: '按原文补关联' }, { target: 'relation:3', kind: 'flow', detail: '核对方向' }]
  }, before = structuredClone(report), indices = [0, 1, 1, 2];
  const mapped = mapWorkflowDiagnostics(report, indices);
  expect(mapped.diagnostics[0]).toMatchObject({ field: 'requirements[2].entities', formalField: 'requirements[3].entities' });
  expect(mapped.issues[0]).toMatchObject({ target: 'requirement:2', formalTarget: 'requirement:3' });
  expect(mapped.diagnostics[1]).toEqual(report.diagnostics[1]); expect(mapped.issues[1]).toEqual(report.issues[1]);
  expect(mapWorkflowDiagnostics(mapped, indices)).toEqual(mapped);
  expect(mapWorkflowDiagnostics(mapped.issues, indices)).toEqual(mapped.issues);
  expect(report).toEqual(before);
});

it('保存修订使用不可变版本并哈希绑定，审计保留完整前后值；不接纳越界路径或新正文', async () => {
  const jobPath = '文档检查/架构任务/synthetic.json', state = { attempts: 1 }, first = malformedPlan();
  await saveWorkflowContent(state, jobPath, first, [], [], {});
  const before = structuredClone(state), next = structuredClone(first);
  next.entities[0].outputs = ['已登记事项'];
  const audit = [{ group: 'entities', index: 0, previous: first.entities[0], next: next.entities[0] }];
  state.attempts++;
  await saveWorkflowContent(state, jobPath, next, [], audit, {});
  expect(state.contentPath).not.toBe(before.contentPath);
  expect(await loadWorkflowContent(before, jobPath)).toEqual(first);
  expect(await loadWorkflowContent(state, jobPath)).toEqual(next);
  const auditText = await ws.readText(state.correctionAudits[0].path);
  expect(await diagramDigest(auditText)).toBe(state.correctionAudits[0].hash);
  expect(JSON.parse(auditText)).toEqual({ attempt: 2, beforeHash: before.contentHash, corrections: audit });
  await expect(loadWorkflowContent({ ...state, contentPath: '虚构原文.md' }, jobPath)).rejects.toHaveProperty('code', 'ARCHITECTURE_WORKFLOW_INTEGRITY');
  await ws.write(state.contentPath, JSON.stringify(first));
  await expect(loadWorkflowContent(state, jobPath)).rejects.toHaveProperty('integrityFailure', true);
});

it('续接前外部删改内容会停止在真实完整性阶段，不新增模型收费或伪称三次额度用尽', async () => {
  const llm = vi.fn(async () => JSON.stringify(malformedPlan())), renderSvg = vi.fn();
  const tool = createArchitectureWorkflowTool({ llm, renderSvg });
  await expect(tool.run(args)).rejects.toHaveProperty('code', 'ARCHITECTURE_PLAN');
  const jobPath = await task(), before = await stateOf(jobPath), tampered = malformedPlan(); tampered.requirements[0].entities.pop();
  await ws.write(before.contentPath, JSON.stringify(tampered));
  await expect(tool.run({ jobPath })).rejects.toThrow('完整性核验失败');
  const stopped = await assertIntegrityFailure(jobPath, 1);
  expect(stopped.contentHash).toBe(before.contentHash);
  expect(await ws.readText(before.contentPath)).toBe(JSON.stringify(tampered));
  await expect(tool.run({ jobPath })).rejects.toThrow('完整性核验失败');
  expect(llm).toHaveBeenCalledTimes(1); expect(renderSvg).not.toHaveBeenCalled();
});

it('内容模型等待期间的外部改稿也被阻断，保留回复但不保存为受控修订或审计', async () => {
  let calls = 0, jobPath, contentPath;
  const llm = vi.fn(async () => {
    if (++calls === 2) {
      await ws.write(contentPath, JSON.stringify({ ...malformedPlan(), title: '外部替换' }));
      return JSON.stringify({ corrections: [{ group: 'entities', index: 0, value: ARCHITECTURE_CONTENT_EXAMPLE.entities[0] }] });
    }
    return JSON.stringify(malformedPlan());
  }), renderSvg = vi.fn(), tool = createArchitectureWorkflowTool({ llm, renderSvg });
  await expect(tool.run(args)).rejects.toHaveProperty('code', 'ARCHITECTURE_PLAN');
  jobPath = await task(); const before = await stateOf(jobPath); contentPath = before.contentPath;
  await expect(tool.run({ jobPath })).rejects.toThrow('完整性核验失败');
  const stopped = await assertIntegrityFailure(jobPath, 2);
  expect(stopped.contentHash).toBe(before.contentHash); expect(stopped.contentPath).toBe(contentPath);
  expect(stopped.correctionAudits).toBeUndefined(); expect(stopped.responsePath).toContain('.response-2.txt');
  expect(JSON.parse(await ws.readText(stopped.responsePath))).toHaveProperty('corrections');
  expect(llm).toHaveBeenCalledTimes(2); expect(renderSvg).not.toHaveBeenCalled();
});

it('内容模型等待时原文追加变更不能沿用旧快照进入审查，保留来源完整性诊断且不收费恢复', async () => {
  const original = await ws.readText('虚构原文.md');
  const llm = vi.fn(async request => {
    if (isContent(request)) {
      await ws.write('虚构原文.md', original + '\n新增一条实际要求，受理后必须人工复核。');
      return JSON.stringify(ARCHITECTURE_CONTENT_EXAMPLE);
    }
    return '{"passed":true,"issues":[]}';
  }), renderSvg = vi.fn(), tool = createArchitectureWorkflowTool({ llm, renderSvg });
  await expect(tool.run(args)).rejects.toHaveProperty('terminal', true);
  const jobPath = await task(), state = await stateOf(jobPath);
  expect(state).toMatchObject({ attempts: 1, terminalFailure: { phase: 'integrity', code: 'WORKFLOW_SOURCE_CHANGED' } });
  expect(state.lastError).toMatchObject({ code: 'ARCHITECTURE_WORKFLOW_INTEGRITY', diagnostics: [{ field: 'materialHash', stage: 'integrity' }] });
  const diagnostics = JSON.parse(await ws.readText(state.lastError.issuesPath));
  expect(diagnostics.diagnostics[0]).toMatchObject({ field: 'materialHash', stage: 'integrity' });
  expect(state.manifestPath).toBeUndefined();
  await expect(tool.run({ jobPath })).rejects.toBeTruthy();
  expect(llm).toHaveBeenCalledTimes(1); expect(renderSvg).not.toHaveBeenCalled();
  expect(await ws.readText('虚构原文.md')).toContain('新增一条实际要求');
});

it.each([false, true])('审查期间改稿阻断正式导出，恢复审查=%s 也不重新整理业务', async recovery => {
  let reviews = 0;
  const llm = vi.fn(async request => {
    if (isContent(request)) return JSON.stringify(ARCHITECTURE_CONTENT_EXAMPLE);
    if (recovery && ++reviews === 1) return '非JSON';
    const state = await stateOf(await task());
    await ws.write(state.contentPath, JSON.stringify({ ...ARCHITECTURE_CONTENT_EXAMPLE, title: '审查时外部变更' }));
    return '{"passed":true,"issues":[]}';
  }), renderSvg = vi.fn(), tool = createArchitectureWorkflowTool({ llm, renderSvg });
  if (recovery) {
    const first = JSON.parse(await tool.run(args)); expect(first.stage).toBe('review');
    await expect(tool.run({ jobPath: first.jobPath })).rejects.toThrow('完整性核验失败');
  } else await expect(tool.run(args)).rejects.toThrow('完整性核验失败');
  const stopped = await assertIntegrityFailure(await task(), 1);
  expect(stopped.architecturePath === undefined || stopped.architecturePath.endsWith('.architecture.json')).toBe(true);
  expect(llm.mock.calls.filter(([request]) => isContent(request))).toHaveLength(1);
  expect(llm).toHaveBeenCalledTimes(recovery ? 3 : 2); expect(renderSvg).not.toHaveBeenCalled();
  expect(await ws.list('交付')).toEqual([]);
});

function mappedContent() {
  const citation = { material: 0, block: 0 };
  return {
    title: '虚构映射与审计',
    entities: Array.from({ length: 15 }, (_, index) => ({
      id: 'e' + index, title: '示范对象' + index, kind: index === 0 ? 'interface' : index === 1 ? 'application' : 'capability',
      responsibility: index === 0 ? '提交受理操作' : '办理示范事项', inputs: index === 1 ? ['受理操作', '查询操作'] : [], outputs: index === 0 ? ['受理操作', '查询操作'] : [], citation
    })),
    relations: [{ from: 'e0', to: 'e1', type: 'supports', meaning: '用户提交受理操作', citation }],
    requirements: [{ entities: Array.from({ length: 15 }, (_, index) => 'e' + index), citation }, { entities: ['e1'], citation }]
  };
}
it('严格修订审计、显式端口编译轨迹及15项需求拆组贯穿真实工作流，审查意见回到正确原条款', async () => {
  const initial = mappedContent(), corrected = { ...initial.relations[0], type: 'dataflow', data: '受理操作' };
  const prompts = [], reviews = [];
  const llm = vi.fn(async request => {
    const payload = JSON.parse(request.prompt);
    if (isContent(request)) {
      prompts.push(payload);
      if (prompts.length === 1) return JSON.stringify(initial);
      if (prompts.length === 2) return JSON.stringify({ corrections: [{ group: 'relations', index: 0, value: corrected, expected: { from: 'e0', to: 'e1', type: 'supports' }, reason: '原文明确用户操作由业务接收，修正关系类别' }] });
      return JSON.stringify(payload.previousContent);
    }
    reviews.push(payload);
    return '{"passed":false,"issues":[{"target":"requirement:2","kind":"coverage","detail":"请核对第二条原始条款的业务关联"}]}';
  }), tool = createArchitectureWorkflowTool({ llm });
  await expect(tool.run(args)).rejects.toHaveProperty('code', 'ARCHITECTURE_PLAN');
  const jobPath = await task(), before = await stateOf(jobPath), firstText = await ws.readText(before.contentPath);
  const result = JSON.parse(await tool.run({ jobPath })), state = await stateOf(jobPath);
  expect(result).toMatchObject({ stage: 'content', ready: false, attemptsRemaining: 1 });
  expect(state.requirementSourceIndices).toEqual([0, 0, 1]);
  expect(state.lastError.issues[0]).toMatchObject({ target: 'requirement:1', formalTarget: 'requirement:2' });
  const formal = JSON.parse(await ws.readText(state.architecturePath));
  expect(formal.requirements.map(row => row.entities.length)).toEqual([12, 3, 1]);
  expect(formal.requirements.slice(0, 2).flatMap(row => row.entities)).toEqual(initial.requirements[0].entities);
  expect(formal.compilation).toMatchObject({ relationIntents: [{ index: 0, type: 'dataflow', data: '受理操作' }], requirementGroups: [{ sourceIndex: 0, outputIndices: [0, 1] }] });
  expect(formal.relations[0]).not.toHaveProperty('data');
  expect(reviews[0].plan.compilation).toEqual(formal.compilation);
  expect(reviews[0].plan.requirements[2].reviewTarget).toBe('requirement:2');
  const auditText = await ws.readText(state.correctionAudits[0].path), audit = JSON.parse(auditText);
  expect(await diagramDigest(auditText)).toBe(state.correctionAudits[0].hash);
  expect(audit).toMatchObject({ attempt: 2, beforeHash: before.contentHash, corrections: [{ group: 'relations', index: 0, previous: initial.relations[0], next: corrected }] });
  expect(await ws.readText(before.contentPath)).toBe(firstText);
  await expect(tool.run({ jobPath })).rejects.toHaveProperty('terminal', true);
  expect(prompts[2].correction.issues[0]).toMatchObject({ target: 'requirement:1', formalTarget: 'requirement:2' });
  expect(prompts[2].completeDiagnostics.issues[0]).toMatchObject({ target: 'requirement:1', formalTarget: 'requirement:2' });
  expect(prompts[2].previousContent.requirements[0].entities).toHaveLength(15);
  expect(reviews).toHaveLength(2); expect(llm).toHaveBeenCalledTimes(5);
});
