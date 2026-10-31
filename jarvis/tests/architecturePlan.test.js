import { it, expect } from 'vitest';
import { makeArchitecturePlan, architectureMarkdown } from '../src/agent/architecturePlan.js';
const entity = (id, kind) => ({ id, title: id, kind, responsibility: '明确职责', inputs: ['输入'], outputs: ['输出'], source: 'user', excerpt: '原始需求' });
const input = () => ({
  title: '虚构项目',
  entities: [entity('预警处置', 'application'), entity('预警事件', 'data')],
  relations: [{ from: '预警处置', to: '预警事件', type: 'dataflow', meaning: '保存事件', assumption: '假设本系统负责事件留存' }],
  requirements: [{ text: '原始需求', source: 'user', excerpt: '原始需求', entities: ['预警处置'] }]
});
it('区分业务和数据对象，职责输入输出及原文映射保留，不能冒充语义通过', () => {
  const plan = makeArchitecturePlan(input(), [], '原始需求');
  expect(plan.entities.map((item) => item.kind)).toEqual(['application', 'data']);
  expect(plan.semantic).toBe('not_checked');
  expect(plan.relations[0].evidence).toBe('assumption');
  expect(architectureMarkdown(plan)).toContain('假设本系统');
});
it('假原文、未映射需求、缺职责、未知关系及重复对象必须拒绝', () => {
  for (const change of [
    (value) => (value.entities[0].excerpt = '不存在'),
    (value) => (value.requirements[0].entities = ['不存在']),
    (value) => (value.entities[0].responsibility = ''),
    (value) => (value.relations[0].type = '随意'),
    (value) => value.entities.push(value.entities[0])
  ]) {
    const value = input();
    change(value);
    expect(() => makeArchitecturePlan(value, [], '原始需求')).toThrow();
  }
});
it('仅实际读取文件可作依据，需求不能由假设冒充', () => {
  const value = input();
  value.entities[0].source = '原文.txt';
  expect(() => makeArchitecturePlan(value, [], '原始需求')).toThrow();
  expect(makeArchitecturePlan(value, [{ path: '原文.txt', text: '原始需求' }], '原始需求').entities).toHaveLength(2);
  value.requirements[0].assumption = '我猜的';
  expect(() => makeArchitecturePlan(value, [{ path: '原文.txt', text: '原始需求' }], '原始需求')).toThrow();
});
it('所有集合有上限，不截掉超限内容', () => {
  const value = input();
  value.entities = Array.from({ length: 61 }, (_, i) => entity('id' + i, 'data'));
  expect(() => makeArchitecturePlan(value, [], '原始需求')).toThrow(/60/);
});
