import { it, expect } from 'vitest';
import { applyArchitectureCorrections } from '../src/agent/architectureContentContract.js';

const proof = block => ({ material: 0, block });
const entity = id => ({ id, title: id, kind: 'application', responsibility: '示范职责', inputs: [], outputs: [], citation: proof(0) });
const relation = (from, to, block = 0) => ({ from, to, type: 'supports', meaning: '示范业务关系' + block, citation: proof(block) });
const fixture = () => ({
  title: '虚构架构', entities: ['a', 'b', 'c', 'd'].map(entity),
  relations: [relation('a', 'b'), relation('c', 'd', 1)],
  requirements: [{ entities: ['a', 'b', 'c', 'd'], citation: proof(0) }]
});
const strict = (response, previous) => applyArchitectureCorrections(response, previous, { strictTopology: true });
const change = (group, index, value, rest = {}) => ({ corrections: [{ group, index, value, ...rest }] });
it('同位置替换成另一条有据但无关的边仍拒绝，不能靠条数不变隐藏原关系丢失', () => {
  const previous = fixture(), before = structuredClone(previous);
  const response = change('relations', 0, relation('c', 'd', 1), { expected: { from: 'a', to: 'b', type: 'supports' }, reason: '尝试通过' });
  expect(() => strict(response, previous)).toThrow('原关系未被保留');
  expect(previous).toEqual(before);
  // 旧直接接口保持兼容；管理工作流须显式启用strictTopology。
  expect(applyArchitectureCorrections(change('relations', 0, relation('c', 'd', 1)), previous).content.relations).toHaveLength(2);
});
it('重排索引不能删除最后一条关系；不能把事实降级假设或缩减需求关联', () => {
  const previous = fixture();
  const changed = { corrections: [
    { group: 'relations', index: 0, value: relation('c', 'd', 1), expected: { from: 'a', to: 'b', type: 'supports' }, reason: '换位' },
    { group: 'relations', index: 1, value: relation('b', 'c', 2), expected: { from: 'c', to: 'd', type: 'supports' }, reason: '换位' }
  ] };
  expect(() => strict(changed, previous)).toThrow('原关系未被保留');
  expect(() => strict(change('requirements', 0, { ...previous.requirements[0], entities: ['a', 'b'] }), previous)).toThrow('丢失原对象关联');
  const { citation, ...oldRelation } = previous.relations[0];
  expect(() => strict(change('relations', 0, { ...oldRelation, assumption: '无法核实所以改为建议' }), previous)).toThrow('不能将已登记事实');
  expect(() => strict(change('entities', 0, { ...previous.entities[0], id: 'renamed' }), previous)).toThrow('不能更换');
});
it('同一对对象分类可修正；反向须有明确intent、旧身份、原因及真实形状引用并留下审计', () => {
  const previous = fixture();
  const classified = { ...previous.relations[0], intent: 'usage', type: 'dataflow', data: '用户操作' };
  const first = strict(change('relations', 0, classified), previous);
  expect(first.correctionAudit).toHaveLength(1);
  expect(first.correctionAudit[0]).toMatchObject({ group: 'relations', index: 0, expected: { from: 'a', to: 'b', type: 'supports' }, previous: previous.relations[0], next: classified });
  const reversed = { ...previous.relations[0], from: 'b', to: 'a', intent: 'presentation', type: 'dataflow', data: '展示数据' };
  expect(() => strict(change('relations', 0, reversed), previous)).toThrow('旧身份');
  const patch = { expected: { from: 'a', to: 'b', type: 'supports' }, reason: '由业务产生展示数据供界面显示' };
  const second = strict(change('relations', 0, reversed, patch), previous);
  expect(second.content.relations[0]).toEqual(reversed);
  expect(second.correctionAudit[0].reason).toBe(patch.reason);
  expect(() => strict(change('relations', 0, reversed, { ...patch, expected: { from: 'a', to: 'b', type: 'workflow' } }), previous)).toThrow('旧身份');
  expect(() => strict(change('relations', 0, { ...reversed, citation: {} }, patch), previous)).toThrow('真实引用');
});
it('原始自连和不存在端点可保留共同对象/引用进行定点纠正，不随意更换目的', () => {
  for (const target of ['a', 'missing']) {
    const previous = fixture(); previous.relations[0].to = target;
    const fixed = { ...previous.relations[0], to: 'b' };
    expect(strict(change('relations', 0, fixed), previous).content.relations[0].to).toBe('b');
    expect(() => strict(change('relations', 0, relation('c', 'd', 1)), previous)).toThrow('旧身份');
  }
});
it('完整回复保留全部旧身份/需求/关系，可补结构；不能以整稿覆盖绕过局部保真', () => {
  const previous = fixture();
  expect(strict(structuredClone(previous), previous).content).toEqual(previous);
  const next = structuredClone(previous); next.entities.push(entity('e')); next.relations.push(relation('b', 'e', 2));
  expect(strict(next, previous).content.entities).toHaveLength(5);
  const missingRelation = structuredClone(previous); missingRelation.relations.pop();
  expect(() => strict(missingRelation, previous)).toThrow('丢失或改换原业务关系');
  const missingEntity = structuredClone(previous); missingEntity.entities[0].id = 'renamed';
  expect(() => strict(missingEntity, previous)).toThrow('丢失已登记对象');
  const missingMap = structuredClone(previous); missingMap.requirements[0].entities.pop();
  expect(() => strict(missingMap, previous)).toThrow('丢失原对象关联');
  const newProof = structuredClone(previous); newProof.entities[0].citation.block = 3;
  expect(() => strict(newProof, previous)).toThrow('变更原对象依据');
});
it('同条款完整映射可无损拆组，节点和关系原身份均保留', () => {
  const previous = fixture(); previous.entities = Array.from({ length: 15 }, (_, index) => entity('e' + index));
  previous.relations = [relation('e0', 'e1')]; previous.requirements[0].entities = previous.entities.map(item => item.id);
  const next = structuredClone(previous), ids = previous.requirements[0].entities;
  next.requirements = [{ entities: ids.slice(0, 12), citation: proof(0) }, { entities: ids.slice(12), citation: proof(0) }];
  const result = strict(next, previous);
  expect(result.content.requirements.flatMap(row => row.entities)).toEqual(ids);
  expect(result.correctionAudit).toEqual([expect.objectContaining({ group: 'requirements', index: 0, previous: previous.requirements[0], next: next.requirements })]);
});
it('完整回复的对象职责/端口及需求扩充同样记录真实前后值，原稿不被审计写坏', () => {
  const previous = fixture(), saved = structuredClone(previous), next = structuredClone(previous);
  next.entities.push(entity('e'));
  next.entities[0] = { ...next.entities[0], kind: 'capability', responsibility: '原文支持的共用检索能力', inputs: ['检索请求'], outputs: ['检索结果'] };
  next.requirements[0].entities.push('e');
  const result = strict(next, previous);
  expect(result.correctionAudit).toEqual([
    expect.objectContaining({ group: 'entities', index: 0, kind: 'preserved_replacement', previous: previous.entities[0], next: next.entities[0] }),
    expect.objectContaining({ group: 'requirements', index: 0, kind: 'preserved_replacement', previous: previous.requirements[0], next: next.requirements[0] })
  ]);
  result.correctionAudit[0].previous.inputs.push('不能污染原文');
  expect(previous).toEqual(saved);
  expect(strict(structuredClone(previous), previous).correctionAudit).toEqual([]);
});
it('无效空行/未登记对象引用可以定点修复，不把无效输入锁成永久身份', () => {
  const previous = fixture(); previous.entities[0] = null;
  expect(strict(change('entities', 0, entity('a')), previous).content.entities[0].id).toBe('a');
  const missing = fixture(); missing.requirements[0].entities = ['a', 'unknown'];
  expect(strict(change('requirements', 0, { ...missing.requirements[0], entities: ['a', 'b'] }), missing).content.requirements[0].entities).toEqual(['a', 'b']);
  expect(() => strict(change('requirements', 0, { ...missing.requirements[0], entities: ['b'] }), missing)).toThrow('丢失原对象关联');
});
