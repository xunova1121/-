import { it, expect } from 'vitest';
import { compileArchitectureContent } from '../src/agent/architectureWorkflowInput.js';
import { makeArchitecturePlan } from '../src/agent/architecturePlan.js';
import { inspectArchitecture } from '../src/agent/architectureReview.js';
const text = '示范事项受理后办理，用户提交受理操作，平台提供查询与办理能力。';
const materials = [{ path: '虚构协议.md', text }], sources = [{ path: '虚构协议.md', excerpt: text }];
const citation = { material: 0, block: 0 };
const content = () => ({
  title: '虚构协议编译',
  entities: Array.from({ length: 15 }, (_, index) => ({
    id: 'entity-' + index, title: '示范对象' + index, kind: index === 0 ? 'interface' : index === 1 ? 'application' : 'capability',
    responsibility: index === 0 ? '提交受理操作' : '办理示范事项', inputs: index === 1 ? ['受理操作'] : [], outputs: index === 0 ? ['受理操作'] : [], citation
  })),
  relations: [{ from: 'entity-0', to: 'entity-1', intent: 'usage', data: '受理操作', meaning: '用户提交受理操作', citation }],
  requirements: [{ entities: Array.from({ length: 15 }, (_, index) => 'entity-' + index), citation }]
});
it('内容编译贯穿明确交互与15项无损需求映射，正式关系/行上限和原文绑定保持', () => {
  const raw = content(), before = structuredClone(raw), maps = [];
  const result = compileArchitectureContent(raw, sources, materials, { onRequirementMap: (...args) => maps.push(args) });
  expect(result.relations[0]).toMatchObject({ from: 'entity-0', to: 'entity-1', type: 'dataflow', source: materials[0].path, excerpt: text });
  expect(result.relations[0]).not.toHaveProperty('intent'); expect(result.relations[0]).not.toHaveProperty('data');
  expect(result.requirements.map(row => row.entities.length)).toEqual([12, 3]);
  expect(result.requirements.flatMap(row => row.entities)).toEqual(raw.requirements[0].entities);
  expect(maps[0][0]).toMatchObject([{ sourceIndex: 0, outputIndices: [0, 1], entityIds: raw.requirements[0].entities }]);
  const plan = makeArchitecturePlan(result, materials);
  expect(inspectArchitecture(plan).structure).toBe('passed');
  expect(plan.requirements.every(row => row.text === text && row.entities.length <= 12)).toBe(true);
  expect(raw).toEqual(before);
});
it('内容编译仍拒绝未登记交互数据，不因intent标签跳过端口或来源核验', () => {
  const raw = content(); raw.relations[0].data = '未登记数据';
  expect(() => compileArchitectureContent(raw, sources, materials)).toThrow('关系语义');
  raw.relations[0].data = '受理操作'; raw.relations[0].citation = { material: 0, block: 99 };
  expect(() => compileArchitectureContent(raw, sources, materials)).toThrow('原文引用');
});
