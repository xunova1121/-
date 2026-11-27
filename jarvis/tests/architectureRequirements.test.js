import { it, expect } from 'vitest';
import { splitArchitectureRequirements } from '../src/agent/architectureRequirements.js';
import { makeArchitecturePlan } from '../src/agent/architecturePlan.js';

const ids = count => Array.from({ length: count }, (_, index) => 'entity-' + index);
const source = { source: '虚构原文.md', excerpt: '示范采购条款须覆盖所有登记对象。', text: '示范采购条款须覆盖所有登记对象。' };
it('15对象需求拆为12+3，原文、证据和所有关联完整保留，不修改输入', () => {
  const original = [{ ...source, entities: ids(15), citation: { material: 0, block: 7 } }], before = structuredClone(original);
  const result = splitArchitectureRequirements(original);
  expect(result.requirements.map(row => row.entities.length)).toEqual([12, 3]);
  expect(result.requirements.flatMap(row => row.entities)).toEqual(ids(15));
  for (const row of result.requirements) {
    expect(row.source).toBe(source.source); expect(row.excerpt).toBe(source.excerpt); expect(row.text).toBe(source.text);
    expect(row.citation).toEqual(original[0].citation);
  }
  expect(result.splits).toEqual([{ sourceIndex: 0, outputIndices: [0, 1], entityIds: ids(15) }]);
  expect(original).toEqual(before);
});
it('拆分结果仍过原每行12个对象校验器，60对象全部可追溯', () => {
  const entities = ids(60).map(id => ({ id, title: id, kind: 'capability', responsibility: '示范职责', inputs: [], outputs: [], ...source }));
  const { requirements } = splitArchitectureRequirements([{ ...source, entities: ids(60) }]);
  const plan = makeArchitecturePlan({ title: '虚构总体架构', entities, relations: [], requirements }, [{ path: source.source, text: source.text }]);
  expect(plan.requirements).toHaveLength(5);
  expect(new Set(plan.requirements.flatMap(row => row.entities))).toEqual(new Set(ids(60)));
  expect(plan.requirements.every(row => row.entities.length <= 12)).toBe(true);
  expect(() => makeArchitecturePlan({ title: '虚构总体架构', entities, relations: [], requirements: [{ ...source, entities: ids(60) }] }, [{ path: source.source, text: source.text }])).toThrow('1～12');
});
it('未知ID仍由原校验器拒绝，总行上限不扩充、不截断', () => {
  const rows = Array.from({ length: 80 }, () => ({ ...source, entities: ids(1) }));
  expect(splitArchitectureRequirements(rows).requirements).toHaveLength(80);
  rows[0].entities = ids(13);
  expect(() => splitArchitectureRequirements(rows)).toThrow('超过80');
  expect(() => splitArchitectureRequirements([{ ...source, entities: ids(61) }])).toThrow('1～60');
  expect(() => splitArchitectureRequirements([{ ...source, entities: [] }])).toThrow();
  expect(() => splitArchitectureRequirements([{ ...source, entities: [null] }])).toThrow();
  const { requirements } = splitArchitectureRequirements([{ ...source, entities: ['missing'] }]);
  expect(() => makeArchitecturePlan({ title: '虚构总体架构', entities: [{ id: 'a', title: '对象', kind: 'capability', responsibility: '职责', inputs: [], outputs: [], ...source }], relations: [], requirements }, [{ path: source.source, text: source.text }])).toThrow('存在的对象');
});
it('所有正式行都保留原始需求索引映射，后续诊断不会因拆分而错位', () => {
  const result = splitArchitectureRequirements([{ ...source, entities: ids(1) }, { ...source, entities: ids(15) }, { ...source, entities: ids(2) }]);
  expect(result.mapping.map(entry => ({ sourceIndex: entry.sourceIndex, outputIndices: entry.outputIndices }))).toEqual([
    { sourceIndex: 0, outputIndices: [0] }, { sourceIndex: 1, outputIndices: [1, 2] }, { sourceIndex: 2, outputIndices: [3] }
  ]);
});
