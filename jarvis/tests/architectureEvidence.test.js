import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { architectureEvidence, resolveArchitectureEvidence } from '../src/agent/architectureEvidence.js';
import { createArchitectureEvidenceTool } from '../src/agent/architectureEvidenceTool.js';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import { createTools } from '../src/agent/tools.js';
import { createToolLoader } from '../src/agent/toolLoader.js';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
let folder;
beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-evidence-')); useBackend(createFileStore(folder)); });
afterEach(() => { useBackend(null); fs.rmSync(folder, { recursive: true, force: true }); });
const original = '配置“数据服务”，支撑研判处置。';
const prepare = (args, execution) => createArchitectureEvidenceTool().run(args, execution).then(JSON.parse);
const input = receipt => ({ title: '虚构业务架构', sources: receipt.sources,
  entities: [{ id: 'data', title: '数据服务', kind: 'capability', responsibility: '提供数据', inputs: [], outputs: [], evidenceId: receipt.items[0].evidenceId }],
  relations: [], requirements: [{ entities: ['data'], evidenceId: receipt.items[0].evidenceId }]
});
it('实际文件取号、只传编号、保存原文和版本、正式SVG落盘；仅业务审查调用模型', async () => {
  await ws.write('采购.md', original);
  const receipt = await prepare({ sources: [{ path: '采购.md' }] });
  expect(receipt.items[0]).toMatchObject({ source: '采购.md', text: original });
  expect(receipt.readMaterials[0]).not.toHaveProperty('matched');
  const llm = vi.fn(async () => '{"passed":true,"issues":[]}');
  const result = JSON.parse(await createArchitecturePlanTool({ llm }).run(input(receipt)));
  const saved = JSON.parse(await ws.readText(result.architecturePath));
  expect(saved.entities[0]).toMatchObject({ source: '采购.md', excerpt: original, evidenceId: receipt.items[0].evidenceId });
  expect(saved.requirements[0].text).toBe(original);
  expect(llm).toHaveBeenCalledTimes(1);
  await createDiagramTool({}, { requireArchitecture: true }).run({ architecturePath: result.architecturePath, path: '编号架构.svg', formats: ['svg'] });
  expect(await ws.readText('编号架构.svg')).toContain('数据服务');
});
it('编号绑定当前内容和路径，变化后旧号拒绝且不进入业务模型', async () => {
  await ws.write('采购.md', original);
  const receipt = await prepare({ sources: [{ path: '采购.md' }] });
  const llm = vi.fn();
  await ws.write('采购.md', original + '新版本');
  await expect(createArchitecturePlanTool({ llm }).run(input(receipt))).rejects.toHaveProperty('code', 'ARCHITECTURE_EVIDENCE');
  expect(llm).not.toHaveBeenCalled();
  await ws.write('另一份.md', original);
  const moved = input(receipt); moved.sources = [{ path: '另一份.md' }];
  await expect(createArchitecturePlanTool({ llm }).run(moved)).rejects.toHaveProperty('code', 'ARCHITECTURE_EVIDENCE');
});
it('伪造编号、冲突原文、编号加假设、改写原需求仍拒绝', async () => {
  await ws.write('采购.md', original);
  const receipt = await prepare({ sources: [{ path: '采购.md' }] });
  for (const patch of [{ evidenceId: 'ev:fake' }, { excerpt: '改写' }, { source: '错误路径' }, { assumption: '假设' }]) {
    const value = input(receipt); Object.assign(value.entities[0], patch);
    await expect(createArchitecturePlanTool({}).run(value)).rejects.toHaveProperty('code', 'ARCHITECTURE_EVIDENCE');
  }
  const value = input(receipt); value.requirements[0].text = '编造的需求';
  await expect(createArchitecturePlanTool({}).run(value)).rejects.toMatchObject({ code: 'ARCHITECTURE_PLAN', diagnostics: [{ field: 'requirements[0].text', stage: 'fact', diffKind: 'not-found' }] });
});
it('分页有界、nextOffset明确、过滤零命中不宣称全文覆盖', async () => {
  await ws.write('长文.md', '采购事项，配置数据服务。'.repeat(1000));
  const sources = [{ path: '长文.md' }];
  const first = await prepare({ sources, limit: 2 });
  const next = await prepare({ sources, limit: 2, offset: first.nextOffset });
  expect(first.items).toHaveLength(2); expect(first.total).toBeGreaterThan(2);
  expect(new Set([...first.items, ...next.items].map(item => item.evidenceId)).size).toBe(4);
  expect(first.items.every(item => item.text.length <= 240)).toBe(true);
  expect((await prepare({ sources, query: '不存在的词' })).matched).toBe(0);
  await expect(prepare({ sources, limit: 21 })).rejects.toHaveProperty('code', 'ARCHITECTURE_EVIDENCE');
});
it('截断材料必须明确章节，同范围重复和超过4份材料拒绝', async () => {
  await ws.write('长文.md', '甲'.repeat(121000) + '\n真实章节唯一\n' + original + '\n结束唯一');
  await expect(prepare({ sources: [{ path: '长文.md' }] })).rejects.toHaveProperty('code', 'ARCHITECTURE_EVIDENCE');
  const receipt = await prepare({ sources: [{ path: '长文.md', sectionStart: '真实章节唯一', sectionEnd: '结束唯一' }] });
  expect(receipt.readMaterials[0]).toMatchObject({ scope: 'section', truncated: false });
  await expect(prepare({ sources: Array.from({ length: 5 }, () => ({ path: '长文.md' })) })).rejects.toHaveProperty('code', 'DIAGRAM_SOURCE_SIZE');
  await expect(prepare({ sources: [receipt.sources[0], receipt.sources[0]] })).rejects.toHaveProperty('code', 'ARCHITECTURE_EVIDENCE');
});
it('停止上抛，旧手填方式原样兼容，编号可无注册表重算', async () => {
  const ctrl = new AbortController(); ctrl.abort();
  await expect(prepare({ sources: [{ path: 'x.md' }] }, { signal: ctrl.signal })).rejects.toHaveProperty('name', 'AbortError');
  const legacy = { entities: [{ source: '采购.md', excerpt: original }], relations: [], requirements: [] };
  expect(await resolveArchitectureEvidence(legacy, [])).toBe(legacy);
  const [first] = await architectureEvidence([{ path: '采购.md', text: original }]);
  expect(first.evidenceId).toBe((await architectureEvidence([{ path: '采购.md', text: original }]))[0].evidenceId);
});
it('工具真实注册且可按名称加载', async () => {
  const tools = createTools({});
  expect(tools.some(tool => tool.name === 'prepare_architecture_evidence')).toBe(true);
  const loader = createToolLoader(tools);
  const search = loader.list().find(tool => tool.name === 'tool_search');
  await search.run({ names: ['prepare_architecture_evidence', 'plan_architecture'] });
  expect(loader.list().some(tool => tool.name === 'prepare_architecture_evidence')).toBe(true);
});
it('关键词跨240字分页边界仍返回连续原文编号，重读可解析且不放宽原文校验', async () => {
  const keyword = '跨页边界采购需求';
  const text = '甲'.repeat(237) + keyword + '乙'.repeat(260);
  await ws.write('跨页.md', text);
  const sources = [{ path: '跨页.md' }];
  const old = await architectureEvidence([{ path: '跨页.md', text }]);
  expect(old.some(item => item.text.includes(keyword))).toBe(false);
  const receipt = await prepare({ sources, query: keyword });
  expect(receipt.matched).toBe(1);
  const proof = receipt.items[0];
  expect(proof.text).toContain(keyword);
  expect(proof.end - proof.start).toBeLessThanOrEqual(240);
  const resolved = await resolveArchitectureEvidence({ entities: [{ evidenceId: proof.evidenceId }] }, [{ path: '跨页.md', text }]);
  expect(resolved.entities[0]).toMatchObject({ source: '跨页.md', excerpt: proof.text });
  for (const suffix of [':999999:1', ':0:241', ':0:0', ':01:1']) {
    const evidenceId = proof.evidenceId.replace(/:\d+:\d+$/, suffix);
    await expect(resolveArchitectureEvidence({ entities: [{ evidenceId }] }, [{ path: '跨页.md', text }])).rejects.toHaveProperty('code', 'ARCHITECTURE_EVIDENCE');
  }
});
it('查询的连续窗口不切断表情代理对，材料更新后仍拒绝旧编号', async () => {
  const text = '甲'.repeat(118) + '😀' + '乙'.repeat(116) + '业务能力中心' + '丙'.repeat(250);
  const items = await architectureEvidence([{ path: '原文.md', text }], [], undefined, '业务能力中心');
  expect(items).toHaveLength(1);
  expect(items[0].text).toContain('业务能力中心');
  expect(/[\uDC00-\uDFFF]/.test(text[items[0].start])).toBe(false);
  await expect(resolveArchitectureEvidence({ entities: [{ evidenceId: items[0].evidenceId }] }, [{ path: '原文.md', text: text + '更新' }])).rejects.toHaveProperty('code', 'ARCHITECTURE_EVIDENCE');
});
it('同一长文件分两章取证，第二章引用和底稿重开不误报原文变化，任一章改动仍拒绝', async () => {
  const { loadArchitecture } = await import('../src/agent/architectureProjection.js');
  await ws.write('分章.md', '第一章唯一\n配置门户。\n第二章唯一\n配置数据服务。\n第三章唯一');
  const sources = [
    { path: '分章.md', sectionStart: '第一章唯一', sectionEnd: '第二章唯一' },
    { path: '分章.md', sectionStart: '第二章唯一', sectionEnd: '第三章唯一' }
  ];
  const receipt = await prepare({ sources });
  const entity = { id: 'data', title: '数据服务', kind: 'capability', responsibility: '提供数据', inputs: [], outputs: [], evidenceId: receipt.items[1].evidenceId };
  const plan = JSON.parse(await createArchitecturePlanTool({}).run({ title: '分章测试', sources, entities: [entity, { ...entity, id: 'portal', title: '门户', kind: 'application', evidenceId: receipt.items[0].evidenceId }], relations: [], requirements: [{ entities: ['data'], evidenceId: receipt.items[1].evidenceId }, { entities: ['portal'], evidenceId: receipt.items[0].evidenceId }] }));
  expect(plan.structure).toBe('passed');
  const reopened = await loadArchitecture(plan.architecturePath);
  expect(reopened.materials).toHaveLength(2);
  expect(reopened.plan.entities[0].excerpt).toContain('配置数据服务');
  await ws.write('分章.md', '第一章唯一\n门户已变。\n第二章唯一\n配置数据服务。\n第三章唯一');
  await expect(loadArchitecture(plan.architecturePath)).rejects.toHaveProperty('code', 'ARCHITECTURE_PROJECTION');
});
