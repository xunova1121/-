import { it, expect } from 'vitest';
import { businessArchitectureLayout } from '../src/agent/architectureLayout.js';
import { projectArchitecture } from '../src/agent/architectureProjection.js';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramScene, sceneElements, validateScene } from '../src/agent/diagramScene.js';
import { sceneSvg } from '../src/agent/diagramSceneSvg.js';

const entity = (id, kind) => ({ id, kind, title: '虚构' + id, responsibility: '维护已登记的业务职责与记录', inputs: [], outputs: [] });
function densePlan() {
  const counts = { system: 6, interface: 4, application: 18, capability: 5, data: 2, acquisition: 4, infrastructure: 4, security: 1 };
  const entities = Object.entries(counts).flatMap(([kind, count]) => Array.from({ length: count }, (_, index) => entity(kind + index, kind)));
  const relations = Array.from({ length: 18 }, (_, index) => ({ from: 'system' + index % 6, to: 'application' + index, type: 'contains', meaning: '系统内部组成' }));
  for (let index = 0; index < 6; index++) relations.push({ from: 'system' + index, to: 'data0', type: 'dataflow', meaning: '交换已登记记录' });
  for (let index = 0; index < 6; index++) relations.push({ from: 'application' + index, to: 'application' + (index + 1), type: 'workflow', meaning: '业务推进' });
  relations.push({ from: 'application6', to: 'application0', type: 'feedback', meaning: '处置结果回流' });
  return { title: '虚构园区多系统总体架构', layoutProfile: 'business-v2', entities, relations, requirements: [] };
}
const project = value => projectArchitecture({ plan: value, report: { structure: 'passed', semantic: 'passed' } }, {});

it('44对象八职责保留原8层上限：7项链路业务在组合层保留正文，其余11项标题/所属不丢失', () => {
  const plan = densePlan(), before = JSON.stringify(plan), result = project(plan);
  expect(result.layers).toHaveLength(8);
  const catalog = result.layers.find(layer => layer.kind === 'catalog');
  expect(catalog.catalog.primary).toHaveLength(3); expect(catalog.catalog.detailed).toHaveLength(4); expect(catalog.nodes).toHaveLength(18);
  expect(catalog.nodes.every(node => node.badge?.startsWith('归属 C'))).toBe(true);
  expect(catalog.footer.relationIds).toEqual(['relation-30']); expect(catalog.footer.detail).toContain('处置结果回流');
  expect(result.relationCoverage).toHaveLength(plan.relations.length);
  const model = layoutDiagram(result), scene = validateScene(diagramScene(model, result.design));
  expect(model.layers).toHaveLength(8); expect(model.nodes).toHaveLength(44);
  const groups = sceneElements(scene).filter(item => item.type === 'group' && item.nodeId);
  expect(new Set(groups.map(item => item.nodeId)).size).toBe(44);
  const text = sceneElements(scene).filter(item => item.type === 'text');
  expect(text.every(item => item.fontSize >= 12)).toBe(true);
  const svg = sceneSvg(scene);
  for (const item of plan.entities) expect(svg).toContain('id="node-' + item.id + '"');
  expect(svg).toContain('反馈闭环'); expect(svg).toContain('网格列名称');
  expect(JSON.stringify(plan)).toBe(before);
});

it('组合层有独立容量与职责规则，普通12/纯网格18/总60/8层上限继续拒绝越界', () => {
  const base = project(densePlan()), catalog = base.layers.find(layer => layer.kind === 'catalog');
  expect(() => layoutDiagram({ title: '拒绝普通超额', layers: [{ title: '普通', nodes: catalog.nodes.slice(0, 13) }] })).toThrow(/12/);
  expect(() => layoutDiagram({ title: '拒绝网格超额', layers: [{ title: '网格', kind: 'grid', nodes: Array.from({ length: 19 }, (_, index) => ({ id: 'n' + index, title: '模块' })) }] })).toThrow(/18/);
  expect(() => layoutDiagram({ ...base, layers: [...base.layers, { title: '额外', nodes: [{ id: 'extra', title: '额外' }] }] })).toThrow(/8层/);
  const wrong = structuredClone(catalog); wrong.role = 'data';
  expect(() => layoutDiagram({ title: '错误职责', layers: [wrong] })).toThrow(/业务组合层/);
  const lost = structuredClone(catalog); lost.nodes.find(node => !lost.catalog.primary.includes(node.id) && !lost.catalog.detailed.includes(node.id)).detail = '不能丢掉说明';
  expect(() => layoutDiagram({ title: '错误模块', layers: [lost] })).toThrow(/不能静默丢弃/);
  const duplicate = structuredClone(catalog); duplicate.catalog.detailed.push(duplicate.catalog.primary[0]);
  expect(() => layoutDiagram({ title: '重复卡片', layers: [duplicate] })).toThrow(/编号重复/);
  expect(() => businessArchitectureLayout({ title: '极限', entities: Array.from({ length: 100 }, (_, index) => entity('cap' + index, 'capability')), relations: [] })).toThrow(/8层/);
});

it('反馈条仅由真实关系生成，160字上限与原有层容量不放宽', () => {
  const plan = densePlan();
  plan.relations.at(-1).meaning = '说明'.repeat(90);
  expect(() => project(plan)).toThrow(/反馈闭环条超出版面/);
  const edited = project(densePlan());
  expect(() => projectArchitecture({ plan: densePlan(), report: { structure: 'passed', semantic: 'passed' } }, { layers: edited.layers })).toThrow(/反馈条由已审关系生成/);
});

it('密集同职责跨容器业务合并展示时系统独立保留，原归属通过真实编号完整呈现', () => {
  const plan = densePlan();
  plan.relations = plan.relations.filter(link => !(link.from === 'system5' && link.type === 'dataflow'));
  const before = JSON.stringify(plan), projected = project(plan), model = layoutDiagram(projected);
  expect(projected.layers).toHaveLength(8); expect(model.nodes).toHaveLength(44);
  expect(model.nodes.some(node => node.id === 'system5')).toBe(true);
  const applications = projected.layers.find(layer => layer.kind === 'catalog');
  expect(applications.nodes).toHaveLength(18);
  for (const link of plan.relations.filter(link => link.type === 'contains')) {
    expect(applications.nodes.find(node => node.id === link.to).badge).toBe('归属 C' + (Number(link.from.at(-1)) + 1));
  }
  expect(validateScene(diagramScene(model, projected.design))).toBeTruthy();
  expect(JSON.stringify(plan)).toBe(before);
});

it('真实文字量触发加宽减列，集成标签通道不挤掉101字原职责或改小标准资源字号', () => {
  const plan = densePlan();
  const target = plan.entities.find(item => item.id === 'system1'); target.responsibility = '原文职责'.repeat(25) + '。';
  plan.relations.push({ from: 'system1', to: 'system2', type: 'integration', meaning: '应用集成' });
  const projected = project(plan), model = layoutDiagram(projected), system = model.layers.find(layer => layer.role === 'system');
  expect(new Set(system.nodes.map(node => node.x)).size).toBe(2);
  const scene = validateScene(diagramScene(model, projected.design));
  const group = sceneElements(scene).find(item => item.type === 'group' && item.nodeId === target.id);
  const visible = sceneElements({ elements: group.children }).filter(item => item.type === 'text').flatMap(item => item.lines.map(line => line.text)).join('');
  expect(visible).toContain(target.responsibility);
  expect(sceneElements({ elements: group.children }).filter(item => item.type === 'text').every(item => item.fontSize >= 13)).toBe(true);
});

it('跨组合业务层的关系避开内部反馈条，不把反馈文字当可穿越的空隙', () => {
  const plan = densePlan();
  plan.relations.push({ from: 'application6', to: 'infrastructure0', type: 'integration', meaning: '应用集成' });
  const projected = project(plan), model = layoutDiagram(projected), scene = validateScene(diagramScene(model, projected.design));
  const box = model.layers.find(layer => layer.kind === 'catalog').footerBox;
  const path = sceneElements(scene).find(item => item.type === 'path' && item.relationType === 'integration');
  expect(path).toBeTruthy();
  for (let index = 1; index < path.points.length; index++) {
    const a = path.points[index - 1], b = path.points[index];
    const overlaps = a.x === b.x
      ? a.x > box.x - 2 && a.x < box.x + box.width + 2 && Math.max(a.y, b.y) > box.y - 2 && Math.min(a.y, b.y) < box.y + box.height + 2
      : a.y > box.y - 2 && a.y < box.y + box.height + 2 && Math.max(a.x, b.x) > box.x - 2 && Math.min(a.x, b.x) < box.x + box.width + 2;
    expect(overlaps).toBe(false);
  }
});

it('已审非业务资源卡在标准18/13版式完整绘出所属badge，不能升级成巨大英雄卡或丢失文字', () => {
  const plan = densePlan();
  for (const entity of plan.entities.filter(item => item.kind === 'system')) entity.responsibility = '按原文保留职责'.repeat(8) + '，不能删减。';
  plan.relations.push({ from: 'system0', to: 'system1', type: 'integration', meaning: '应用集成' });
  const projected = project(plan), model = layoutDiagram(projected), scene = validateScene(diagramScene(model, projected.design));
  const resources = model.nodes.filter(node => node.id.startsWith('system'));
  expect(resources.every(node => node.compactSummary === true)).toBe(true);
  for (const node of resources) {
    const group = sceneElements(scene).find(item => item.type === 'group' && item.nodeId === node.id);
    const text = sceneElements({ elements: group.children }).filter(item => item.type === 'text');
    const visible = text.flatMap(item => item.lines.map(line => line.text)).join('');
    expect(visible).toContain(node.title); expect(visible).toContain(node.detail);
    expect(text.find(item => item.lines.map(line => line.text).join('') === node.title)?.fontSize).toBe(18);
    expect(text.find(item => item.lines.map(line => line.text).join('') === node.detail)?.fontSize).toBe(13);
    if (node.badge) expect(text.find(item => item.lines.map(line => line.text).join('') === node.badge)?.fontSize).toBe(14);
    for (const item of text) expect(item.lines.at(-1).y + item.fontSize * 0.25).toBeLessThan(node.y + node.height);
  }
  const business = model.nodes.find(node => node.id === 'application0');
  expect(business.compactSummary).toBeUndefined();
});
