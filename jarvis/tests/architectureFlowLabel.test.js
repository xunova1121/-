import { it, expect } from 'vitest';
import { architectureFlowLabel } from '../src/agent/architectureFlowLabel.js';
import { projectArchitecture } from '../src/agent/architectureProjection.js';
import { layoutDiagram } from '../src/agent/diagramModel.js';
import { diagramScene } from '../src/agent/diagramScene.js';
import { sceneSvg } from '../src/agent/diagramSceneSvg.js';

const plan = (ports = ['已登记事项']) => ({
  title: '虚构业务系统',
  entities: [
    { id: 'a', title: '受理业务', kind: 'application', responsibility: '登记受理事项', inputs: [], outputs: [...ports] },
    { id: 'b', title: '办理业务', kind: 'application', responsibility: '办理登记事项', inputs: [...ports], outputs: [] }
  ],
  relations: [{ from: 'a', to: 'b', type: 'dataflow', meaning: '提供完整事项以供后续业务办理' }],
  requirements: [{ text: '登记受理后办理', entities: ['a', 'b'] }]
});
const project = value => projectArchitecture({ plan: value, report: { structure: 'passed', semantic: 'passed' } }, { view: 'dataflow' });

it('唯一真实共同端口成为数据流标签，专题投影不改回泛称，原端口/原义保持完整', () => {
  const value = plan(), before = structuredClone(value);
  expect(architectureFlowLabel(value, 0)).toBe('已登记事项');
  const result = project(value);
  expect(result.edges[0]).toMatchObject({ label: '已登记事项', meaning: value.relations[0].meaning, relationId: 'relation-0' });
  const model = layoutDiagram(result), svg = sceneSvg(diagramScene(model, result.design));
  expect(model.edges[0].label).toBe('已登记事项'); expect(svg).toContain('已登记事项');
  expect(value).toEqual(before);
});

it('多个端口只信任同一关系index的精确显式数据，不信任稀疏数组位置或失效记录', () => {
  const value = plan(['事件', '办理结果']);
  value.compilation = { relationIntents: [{ index: 4, data: '事件' }, { index: 0, data: '办理结果' }] };
  expect(architectureFlowLabel(value, 0)).toBe('办理结果'); expect(project(value).edges[0].label).toBe('办理结果');
  value.compilation.relationIntents = [{ index: 4, data: '事件' }];
  expect(architectureFlowLabel(value, 0)).toBe('数据流');
  value.compilation.relationIntents = [{ index: 0, data: '编造数据' }];
  expect(architectureFlowLabel(value, 0)).toBe('数据流');
  value.entities[0].outputs = ['办理结果'];
  expect(architectureFlowLabel(value, 0)).toBe('办理结果');
});

it('歧义、缺端口、长名称只回退泛称，不从说明猜名、不截断或添加端口', () => {
  const long = '保持全称的十四字完整业务事项数据', value = plan([long]), before = structuredClone(value);
  value.compilation = { relationIntents: [{ index: 0, data: long }] };
  expect(architectureFlowLabel(value, 0)).toBe('数据流'); expect(project(value).edges[0].label).toBe('数据流');
  expect(value.entities).toEqual(before.entities);
  const ambiguous = plan(['事件', '结果']); expect(architectureFlowLabel(ambiguous, 0)).toBe('数据流');
  ambiguous.entities[1].inputs = ['另一数据'];
  ambiguous.relations[0].meaning = '事件';
  expect(architectureFlowLabel(ambiguous, 0)).toBe('数据流');
  expect(ambiguous.entities[1].inputs).toEqual(['另一数据']);
});

it('精确端口不做trim/同义词匹配，十二字上限遵循现有Unicode计数', () => {
  const value = plan(['受理事项']); value.entities[1].inputs = ['受理 事项'];
  value.compilation = { relationIntents: [{ index: 0, data: '受理事项' }] };
  expect(architectureFlowLabel(value, 0)).toBe('数据流');
  const boundary = plan(['一二三四五六七八九十甲乙']);
  expect(architectureFlowLabel(boundary, 0)).toBe('一二三四五六七八九十甲乙');
  boundary.entities[0].outputs.push('一二三四五六七八九十甲乙丙'); boundary.entities[1].inputs = ['一二三四五六七八九十甲乙丙'];
  expect(architectureFlowLabel(boundary, 0)).toBe('数据流');
  const unicode = plan(['😀'.repeat(12)]); expect(architectureFlowLabel(unicode, 0)).toBe('😀'.repeat(12));
  value.relations[0].type = 'workflow'; expect(architectureFlowLabel(value, 0)).toBeUndefined();
});
