import { it, expect } from 'vitest';
import { architectureSpec, architectureLayout } from '../e2e/fixtures/architecture-plan.mjs';
import { makeArchitecturePlan } from '../src/agent/architecturePlan.js';
import { projectArchitecture } from '../src/agent/architectureProjection.js';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramScene } from '../src/agent/diagramScene.js';
import { sceneSvg } from '../src/agent/diagramSceneSvg.js';
const bundle = () => ({
  plan: makeArchitecturePlan(architectureSpec, [], '建设示范业务闭环，统一权限与审计'),
  report: { structure: 'passed', semantic: 'passed' }
});
const input = (view) => ({ ...structuredClone(architectureLayout), view });
it('总览用容器/编号表达包含、文字表达支撑、闭环条表达反馈，不混入数据流线', () => {
  const value = bundle();
  const before = JSON.stringify(value.plan);
  const result = projectArchitecture(value, input('overview'));
  expect(result.edges.map((edge) => edge.type)).toEqual(['workflow', 'workflow']);
  expect(result.layers.some((layer) => layer.kind === 'band' && layer.title === '反馈闭环')).toBe(true);
  expect(result.layers.flatMap((layer) => layer.nodes).find((node) => node.id === 'cloud').detail).toContain('支撑：空间服务、现场感知接入');
  expect(result.relationCoverage).toHaveLength(value.plan.relations.length);
  expect(result.relationCoverage.filter((item) => item.type === 'dataflow').every((item) => item.display === 'dataflow_view')).toBe(true);
  expect(JSON.stringify(value.plan)).toBe(before);
  const svg = sceneSvg(diagramScene(layoutDiagram(result), result.design));
  expect(svg).toContain('数据传输见数据流视图');
});
it('业务图和数据图只显示各自对象与关系，保留委派范围', () => {
  for (const view of ['workflow', 'dataflow']) {
    const value = projectArchitecture(bundle(), input(view));
    expect(value.edges.every((edge) => (view === 'workflow' ? ['workflow', 'feedback'].includes(edge.type) : edge.type === 'dataflow'))).toBe(true);
    const ids = new Set(value.edges.flatMap((edge) => [edge.from, edge.to]));
    expect(value.layers.flatMap((layer) => layer.nodes).every((node) => ids.has(node.id))).toBe(true);
    expect(value.relationCoverage.length).toBe(bundle().plan.relations.length);
  }
});
it('错误容器和职责混放拒绝；所属编号不会覆盖原标签', () => {
  const value = input('overview');
  value.layers[1].group = '示范感知接入子系统';
  expect(() => projectArchitecture(bundle(), value)).toThrow(/归属与底稿不一致/);
  const plain = projectArchitecture(bundle(), { view: 'relations' });
  const platform = plain.layers.flatMap((layer) => layer.nodes).find((node) => node.id === 'platform');
  expect(platform.badge).toContain('C1');
});
it('底稿没有登记该类关系时，不编造新视图或连接', () => {
  const value = bundle();
  value.plan.relations = value.plan.relations.filter((link) => link.type !== 'dataflow');
  expect(() => projectArchitecture(value, input('dataflow'))).toThrow(/没有登记/);
});
