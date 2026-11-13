import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createArchitectureRevisionTool, reviseArchitectureInput } from '../src/agent/architectureRevision.js';
import { architectureBusinessSummary } from '../src/agent/architectureBusiness.js';
import { createArchitectureEvidenceTool } from '../src/agent/architectureEvidenceTool.js';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
let folder;
beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-revision-')); useBackend(createFileStore(folder)); });
afterEach(() => { useBackend(null); fs.rmSync(folder, { recursive: true, force: true }); });
const raw = '建设事件数据服务';
const input = () => ({ title: '合成数据系统', entities: [{ id: 'data', title: '事件数据', kind: 'application', responsibility: '管理事件数据', inputs: ['事件'], outputs: ['事件'], source: 'user', excerpt: raw }], relations: [], requirements: [{ text: raw, entities: ['data'], source: 'user', excerpt: raw }] });
const failed = JSON.stringify({ passed: false, issues: [{ target: 'entity:data', kind: 'classification', detail: '事件数据为信息对象，请核对数据层' }] });
it('按具体意见定点修订，保留未改原文与原文件，再审后给自下而上说明', async () => {
  const before = JSON.parse(await createArchitecturePlanTool({ llm: async () => failed }).run(input(), { rawRequestText: raw }));
  const original = await ws.readText(before.architecturePath);
  const llm = vi.fn(async request => {
    expect(JSON.parse(request.prompt).previousUserEvidence).toContain(raw);
    return '{"passed":true,"issues":[]}';
  });
  const after = JSON.parse(await createArchitectureRevisionTool({ llm }).run({ architecturePath: before.architecturePath, reason: '按数据对象意见修正', changes: { entities: [{ id: 'data', kind: 'data' }] } }, { rawRequestText: '按意见修正分层' }));
  expect(after.semantic).toBe('passed'); expect(llm).toHaveBeenCalledTimes(1);
  expect(after.architecturePath).not.toBe(before.architecturePath);
  expect(await ws.readText(before.architecturePath)).toBe(original);
  const saved = JSON.parse(await ws.readText(after.architecturePath));
  expect(saved.requirements).toEqual(JSON.parse(original).requirements);
  expect(saved.entities[0]).toMatchObject({ kind: 'data', source: 'user', excerpt: raw });
  expect(saved.revision).toMatchObject({ parentPath: before.architecturePath, reason: '按数据对象意见修正' });
  const md = await ws.readText(after.relationTablePath);
  expect(md).toContain('自下而上分层'); expect(md).toContain('数据资源');
});
it('无修改或未知字段/越界/删除需求不能触发新审查', async () => {
  const before = JSON.parse(await createArchitecturePlanTool({ llm: async () => failed }).run(input(), { rawRequestText: raw }));
  const llm = vi.fn(); const revise = createArchitectureRevisionTool({ llm });
  for (const changes of [{}, { entities: [{ id: 'data', kind: 'application' }] }, { relations: [{ index: 10, type: 'feedback' }] }, { removeRequirements: [0] }, { entities: [{ id: 'data', fake: 'x' }] }])
    await expect(revise.run({ architecturePath: before.architecturePath, reason: '修正', changes })).rejects.toHaveProperty('code', 'ARCHITECTURE_REVISION');
  expect(llm).not.toHaveBeenCalled();
});
it('不因移除对象静默删需求或连线，旧严格映射继续拦截', async () => {
  const before = JSON.parse(await createArchitecturePlanTool({ llm: async () => failed }).run(input(), { rawRequestText: raw }));
  await expect(createArchitectureRevisionTool({}).run({ architecturePath: before.architecturePath, reason: '删对象', changes: { removeEntities: ['data'] } })).rejects.toHaveProperty('code', 'ARCHITECTURE_PLAN');
});
it('源码变更与停止仍拦截，修订不能复用过期材料或吞掉控制信号', async () => {
  await ws.write('采购.md', raw);
  const value = input(); value.entities[0].source = '采购.md'; value.requirements[0].source = '采购.md';
  const before = JSON.parse(await createArchitecturePlanTool({ llm: async () => failed }).run(value));
  await ws.write('采购.md', raw + '新版本');
  await expect(createArchitectureRevisionTool({}).run({ architecturePath: before.architecturePath, reason: '修正', changes: { entities: [{ id: 'data', kind: 'data' }] } })).rejects.toHaveProperty('code', 'ARCHITECTURE_PROJECTION');
  const ctrl = new AbortController(); ctrl.abort();
  await expect(createArchitectureRevisionTool({}).run({}, { signal: ctrl.signal })).rejects.toHaveProperty('name', 'AbortError');
});
it('编号规范化后仍无修改的请求拒绝，不靠重传同一编号抽签审查', async () => {
  await ws.write('采购.md', raw);
  const page = JSON.parse(await createArchitectureEvidenceTool().run({ sources: [{ path: '采购.md' }] }));
  const value = input(); value.sources = page.sources;
  for (const item of [value.entities[0], value.requirements[0]]) { delete item.source; delete item.excerpt; item.evidenceId = page.items[0].evidenceId; }
  const before = JSON.parse(await createArchitecturePlanTool({ llm: async () => failed }).run(value));
  const llm = vi.fn();
  await expect(createArchitectureRevisionTool({ llm }).run({ architecturePath: before.architecturePath, reason: '重试', changes: { entities: [{ id: 'data', evidenceId: page.items[0].evidenceId }] } })).rejects.toHaveProperty('code', 'ARCHITECTURE_REVISION');
  expect(llm).not.toHaveBeenCalled();
});
it('分层顺序以职责为准，系统单列边界，不按名字把数据层与数据库软件混成一个', () => {
  const plan = { entities: [{ id: 'cloud', title: '数据底座', kind: 'infrastructure' }, { id: 'app', title: '数据管理', kind: 'application' }, { id: 'system', title: '协同系统', kind: 'system' }], relations: [{ from: 'system', to: 'app', type: 'contains' }] };
  const summary = architectureBusinessSummary(plan);
  expect(summary.layers.map(item => item.role)).toEqual(['infrastructure', 'application']);
  expect(summary.systems[0].id).toBe('system'); expect(summary.layers[1].entities[0].owner).toBe('system');
});
it('纯修订函数不修改原对象/未改关系，单次修改有上限', () => {
  const plan = input(); const before = JSON.stringify(plan);
  const next = reviseArchitectureInput(plan, { entities: [{ id: 'data', kind: 'data' }] });
  expect(JSON.stringify(plan)).toBe(before); expect(next.requirements).toEqual(plan.requirements);
  expect(() => reviseArchitectureInput(plan, { removeRelations: Array(61).fill(0) })).toThrow();
});
