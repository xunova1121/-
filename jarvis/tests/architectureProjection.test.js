import { it, expect } from 'vitest';
import { makeArchitecturePlan } from '../src/agent/architecturePlan.js';
import { projectArchitecture, loadArchitecture } from '../src/agent/architectureProjection.js';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramScene } from '../src/agent/diagramScene.js';
import { diagramRoutes } from '../src/agent/diagramRoutes.js';
import { sceneSvg } from '../src/agent/diagramSceneSvg.js';
import { createArchitecturePlanTool } from '../src/agent/architectureTool.js';
import { createDiagramTool } from '../src/agent/diagramTool.js';
import * as workspace from '../src/agent/workspace.js';
const entity = (id, kind) => ({ id, title: id, kind, responsibility: '职责明确', inputs: ['事件'], outputs: ['事件'], assumption: '虚构测试对象' });
const raw = () => ({
  title: '虚构架构',
  entities: [entity('研判', 'application'), entity('处置', 'application'), entity('算法', 'capability'), entity('事件', 'data')],
  relations: [
    { from: '研判', to: '处置', type: 'workflow', meaning: '派单', assumption: '测试流程' },
    { from: '算法', to: '研判', type: 'supports', meaning: '算法辅助研判', assumption: '测试支撑' },
    { from: '事件', to: '算法', type: 'supports', meaning: '提供事件数据', assumption: '测试支撑' }
  ],
  requirements: [{ text: '建设架构', source: 'user', excerpt: '建设架构', entities: ['研判', '处置'] }]
});
const bundle = () => ({ plan: makeArchitecturePlan(raw(), [], '建设架构'), report: { structure: 'passed', semantic: 'passed' }, reviewPath: '审查.json' });
it('按职责分层并生成全部已登记箭头，节点/标题/安全子集有效', () => {
  const input = projectArchitecture(bundle(), { path: '架构.svg' });
  expect(input.layers.map((layer) => layer.role)).toEqual(['application', 'capability', 'data']);
  const model = layoutDiagram(input);
  const routes = diagramRoutes(model);
  expect(routes).toHaveLength(3);
  for (const edge of routes)
    for (let i = 1; i < edge.points.length; i++) expect(edge.points[i].x === edge.points[i - 1].x || edge.points[i].y === edge.points[i - 1].y).toBe(true);
  const svg = sceneSvg(diagramScene(model, input.design));
  expect(svg).toContain('stroke-dasharray');
  expect(svg).toContain('派单');
  expect(svg).not.toMatch(/<script|href=/);
});
it('业务塞入数据层、遗漏对象、私删或反向关系必须拒绝', () => {
  const value = bundle();
  const input = projectArchitecture(value, { path: '图.svg' });
  input.layers[0].role = 'data';
  expect(() => projectArchitecture(value, input)).toThrow(/职责不匹配/);
  const omitted = projectArchitecture(value, { path: '图.svg' });
  omitted.layers.pop();
  expect(() => projectArchitecture(value, omitted)).toThrow(/未进入/);
  expect(() => projectArchitecture(value, { path: '图.svg', edges: [{ from: '处置', to: '研判', type: 'workflow' }] })).toThrow(/不一致/);
});
it('没审查不能正式交付，失败不能借草图绕过；草图强制黑白和SVG/PNG', () => {
  const value = bundle();
  value.report.semantic = 'not_checked';
  expect(() => projectArchitecture(value, { path: '图.svg' })).toThrow(/语义审查未完成/);
  const draft = projectArchitecture(value, { path: '图.svg', draft: true, formats: ['pptx'] });
  expect(draft.formats).toEqual(['svg', 'png']);
  expect(draft.design.theme).toBe('charcoal');
  expect(draft.layers.flatMap((layer) => layer.nodes).every((node) => !node.accent)).toBe(true);
  value.report.semantic = 'failed';
  expect(() => projectArchitecture(value, { draft: true })).toThrow(/未通过/);
});
it('程序保留同端点不同类型的关系，不去重丢失；数据流单向不产生纵向回折', () => {
  const value = bundle();
  value.plan.relations.push({ from: '算法', to: '研判', type: 'dataflow', meaning: '输出事件' });
  const model = layoutDiagram(projectArchitecture(value, {}));
  expect(model.edges).toHaveLength(4);
  for (const route of diagramRoutes(model).filter((edge) => edge.type !== 'workflow'))
    for (let i = 1; i < route.points.length; i++) expect(route.points[i].y <= route.points[i - 1].y).toBe(true);
});
it('实际底稿与审查匹配，修改底稿或原材料后禁止沿用', async () => {
  await workspace.write('原文.txt', '建设架构');
  const input = raw();
  input.sources = [{ path: '原文.txt', excerpt: '建设架构' }];
  const receipt = JSON.parse(
    await createArchitecturePlanTool({ llm: async () => JSON.stringify({ passed: true, issues: [] }) }).run(input, { rawRequestText: '建设架构' })
  );
  expect((await loadArchitecture(receipt.architecturePath)).report.semantic).toBe('passed');
  await workspace.write('原文.txt', '材料已改');
  await expect(loadArchitecture(receipt.architecturePath)).rejects.toThrow(/材料已变化/);
  await workspace.write('原文.txt', '建设架构');
  const saved = JSON.parse(await workspace.readText(receipt.architecturePath));
  saved.title = '被修改';
  await workspace.write(receipt.architecturePath, JSON.stringify(saved));
  await expect(loadArchitecture(receipt.architecturePath)).rejects.toThrow(/底稿已变化/);
});
it('正式工具入口不能跳底稿或伪称草图；旧低层调用仍兼容', async () => {
  const tool = createDiagramTool({}, { requireArchitecture: true });
  await expect(tool.run({ path: '图.svg' }, { rawRequestText: '制作架构图' })).rejects.toMatchObject({ code: 'ARCHITECTURE_PLAN_REQUIRED' });
  await expect(
    tool.run({ path: '图.svg', architecturePath: 'test.architecture.json', draft: true }, { rawRequestText: '制作正式架构图' })
  ).rejects.toMatchObject({ code: 'ARCHITECTURE_DRAFT_ONLY' });
});
