import { it, expect } from 'vitest';
import { businessArchitectureLayout } from '../src/agent/architectureLayout.js';
import { architectureInput, projectArchitecture } from '../src/agent/architectureProjection.js';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramScene } from '../src/agent/diagramScene.js';
import { sceneSvg } from '../src/agent/diagramSceneSvg.js';
const entity = (id, kind) => ({ id, title: id, kind, responsibility: '已登记职责', inputs: [], outputs: [] });
const plan = () => ({ title: '合成业务架构', layoutProfile: 'business-v2', entities: [entity('platform', 'system'), entity('pc', 'interface'), entity('app', 'application'), entity('cap', 'capability'), entity('data', 'data'), entity('cloud', 'infrastructure'), entity('security', 'security')], relations: ['app', 'cap', 'data'].map(to => ({ from: 'platform', to, type: 'contains', meaning: '内部组成' })), requirements: [] });
it('新默认版式按系统分组、展示独立、安全通栏，不改写职责与对象', () => {
  const value = plan(); const before = JSON.stringify(value);
  const input = businessArchitectureLayout(value);
  expect(input.view).toBe('overview');
  expect(input.layers.filter(layer => layer.group).map(layer => layer.role)).toEqual(['application', 'capability', 'data']);
  expect(input.layers.at(-1).kind).toBe('band');
  const projected = projectArchitecture({ plan: value, report: { structure: 'passed', semantic: 'passed' } }, {});
  const model = layoutDiagram(projected);
  const svg = sceneSvg(diagramScene(model, projected.design));
  for (const node of model.nodes) expect(svg).toContain('id="node-' + node.id + '"');
  expect(JSON.stringify(value)).toBe(before);
  expect(new Set(projected.layers.flatMap(layer => layer.nodes.map(node => node.id))).has('app')).toBe(true);
});
it('旧底稿保留原默认，显式版式不被新自动版式覆盖', () => {
  const legacy = plan(); delete legacy.layoutProfile;
  expect(architectureInput(legacy, {}).layers.some(layer => layer.role === 'system')).toBe(true);
  const manual = { layers: [{ title: '业务应用', role: 'application', nodes: [] }] };
  expect(architectureInput(plan(), manual).layers).toEqual(manual.layers);
});
it('跨系统关系端点保留独立系统节点，不能为容器好看隐藏连接对象', () => {
  const value = plan();
  value.relations.push({ from: 'platform', to: 'cloud', type: 'dataflow', meaning: '监控信息' });
  const result = businessArchitectureLayout(value);
  expect(result.layers.flatMap(layer => layer.nodes).some(item => item.id === 'platform')).toBe(true);
});
it('密集对象分排但不丢对象，超单图容量清楚拒绝而不缩字删关系', () => {
  const value = { title: '密集架构', entities: Array.from({ length: 30 }, (_, i) => entity('cap' + i, 'capability')), relations: [] };
  const result = businessArchitectureLayout(value);
  expect(result.layers.flatMap(layer => layer.nodes)).toHaveLength(30);
  expect(result.layers).toHaveLength(3);
  expect(() => businessArchitectureLayout({ ...value, entities: Array.from({ length: 100 }, (_, i) => entity('cap' + i, 'capability')) })).toThrow(/8层/);
});
