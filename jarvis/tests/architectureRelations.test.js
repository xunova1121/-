import { it, expect } from 'vitest';
import { compileArchitectureRelations, architectureRelationDiagnostics } from '../src/agent/architectureRelations.js';
import { inspectArchitecture } from '../src/agent/architectureReview.js';
const entities = () => [
  { id: 'person', title: '示范用户', kind: 'interface', inputs: [], outputs: ['受理操作'] },
  { id: 'portal', title: '示范门户', kind: 'application', inputs: ['受理操作'], outputs: ['办理态势'] },
  { id: 'screen', title: '示范展示入口', kind: 'interface', inputs: ['办理态势'], outputs: [] },
  { id: 'device', title: '示范设备', kind: 'infrastructure', inputs: [], outputs: [] }
];
const relation = extra => ({ from: 'person', to: 'portal', type: 'supports', meaning: '提交受理操作', citation: { material: 0, block: 0 }, ...extra });
const plan = rows => ({ entities: entities(), relations: rows, requirements: [{ text: '虚构需求' }] });
it('显式usage由真实共同端口编译，不猜类型或箭头；原义/引用保留且输入不变', () => {
  const rows = [relation({ intent: 'usage', data: '受理操作' })], before = structuredClone(rows);
  const result = compileArchitectureRelations(rows, entities());
  expect(result).toEqual([relation({ type: 'dataflow' })]);
  expect(rows).toEqual(before);
  expect(inspectArchitecture(plan(result)).structure).toBe('passed');
});
it('presentation由业务输出指向界面；hosting只处理已声明的真实资源承载', () => {
  const rows = [
    relation({ from: 'portal', to: 'screen', type: 'dataflow', intent: 'presentation', data: '办理态势', meaning: '展示办理态势' }),
    relation({ from: 'device', to: 'portal', intent: 'hosting', meaning: '承载门户运行' })
  ];
  const result = compileArchitectureRelations(rows, entities());
  expect(result.map(row => [row.from, row.to, row.type])).toEqual([['portal', 'screen', 'dataflow'], ['device', 'portal', 'supports']]);
  expect(inspectArchitecture(plan(result)).structure).toBe('passed');
  expect(() => compileArchitectureRelations([relation({ from: 'screen', to: 'portal', intent: 'presentation', data: '办理态势' })], entities())).toThrow('关系语义');
  expect(() => compileArchitectureRelations([relation({ intent: 'hosting' })], entities())).toThrow('关系语义');
});
it('数据缺失/错端口/职责错误/与所属冲突都批量拒绝，不能把所有supports直接放行', () => {
  const values = [
    relation({ intent: 'usage' }),
    relation({ intent: 'usage', data: '编造数据' }),
    relation({ intent: 'presentation', data: '受理操作' }),
    relation({ intent: 'usage', data: '受理操作', type: 'contains' }),
    relation({ from: 'device', to: 'portal', intent: 'hosting', data: '受理操作' })
  ];
  let error; try { compileArchitectureRelations(values, entities()); } catch (e) { error = e; }
  expect(error.code).toBe('ARCHITECTURE_RELATION');
  expect(error.diagnostics).toHaveLength(5);
  expect(error.diagnostics[0]).toMatchObject({ field: 'relations[0].data', from: { id: 'person', kind: 'interface', outputs: ['受理操作'] }, to: { id: 'portal', kind: 'application', inputs: ['受理操作'] } });
  const unchanged = compileArchitectureRelations([relation({ meaning: '任意改写说明也不能变更关系' })], entities());
  expect(unchanged[0].type).toBe('supports');
  expect(inspectArchitecture(plan(unchanged)).structure).toBe('failed');
});
it('精确诊断带实际端点职责/输入输出，候选仅是建议，反向呈现不会自动应用', () => {
  const value = plan([relation(), relation({ from: 'screen', to: 'portal', meaning: '展示态势' })]);
  const report = inspectArchitecture(value), before = structuredClone(value);
  expect(report.issues).toHaveLength(2);
  expect(report.issues[0].detail).toContain('person:interface→portal:application');
  expect(report.issues[0]).not.toHaveProperty('from');
  const diagnostics = architectureRelationDiagnostics(value, report.issues);
  expect(diagnostics[0]).toMatchObject({ field: 'relations[0]', from: { id: 'person', kind: 'interface' }, to: { id: 'portal', kind: 'application' } });
  expect(diagnostics[0].repairCandidates).toContainEqual({ intent: 'usage', from: 'person', to: 'portal', dataOptions: ['受理操作'], candidateOnly: true });
  expect(diagnostics[1].repairCandidates).toContainEqual({ intent: 'presentation', from: 'portal', to: 'screen', dataOptions: ['办理态势'], candidateOnly: true });
  expect(value).toEqual(before);
  const mismatch = plan([relation({ type: 'dataflow' })]);
  mismatch.entities[1].inputs = ['另一事项'];
  const mismatchDetails = architectureRelationDiagnostics(mismatch, inspectArchitecture(mismatch).issues);
  expect(mismatchDetails[0].portMismatch).toEqual({ producedButNotAccepted: ['受理操作'], acceptedButNotProduced: ['另一事项'], candidateOnly: true });
});
it('无明确intent的旧数据流精确同名规则保持，不靠trim/同义词/说明去匹配', () => {
  const value = plan([relation({ type: 'dataflow' })]);
  value.entities[0].outputs = ['受理 操作'];
  expect(inspectArchitecture(value).structure).toBe('failed');
  value.entities[0].outputs = [' 受理操作'];
  expect(inspectArchitecture(value).structure).toBe('failed');
  expect(() => compileArchitectureRelations([relation({ type: 'dataflow', data: '受理操作' })], value.entities)).toThrow();
  expect(() => compileArchitectureRelations([relation({ type: 'supports', data: '受理操作' })], entities())).toThrow();
  expect(() => compileArchitectureRelations([relation({ intent: 'not-real', data: '受理操作' })], entities())).toThrow();
  expect(() => compileArchitectureRelations([relation({ intent: 'usage', data: ' 受理操作' })], entities())).toThrow();
  const unicode = plan([relation({ type: 'dataflow' })]);
  unicode.entities[0].outputs = ['😀'.repeat(60)]; unicode.entities[1].inputs = ['😀'.repeat(60)];
  expect(inspectArchitecture(unicode).structure).toBe('passed');
  expect(() => compileArchitectureRelations([relation({ intent: 'usage', data: '受理操作', from: '' })], [null])).toThrow('关系语义');
});
it('显式integration保留无向应用级原义，不要求端口也不自动归为支撑或数据传输', () => {
  const objects = [
    { id: 'a', kind: 'system', inputs: [], outputs: [] },
    { id: 'b', kind: 'application', inputs: [], outputs: [] },
    { id: 'c', kind: 'capability', inputs: [], outputs: [] }
  ], rows = [relation({ from: 'a', to: 'b', type: 'integration', meaning: '原文明确应用间集成' }), relation({ from: 'c', to: 'a', type: 'integration', meaning: '共用能力与系统集成' })];
  expect(compileArchitectureRelations(rows, objects)).toEqual(rows);
  expect(inspectArchitecture({ entities: objects, relations: rows, requirements: [{}] }).structure).toBe('passed');
  expect(rows.every(row => row.type === 'integration')).toBe(true);
});
it('integration不能用来跳过界面、资源、设备或数据端点门槛，不能混入intent/data', () => {
  for (const kind of ['interface', 'data', 'infrastructure', 'acquisition', 'security']) {
    const objects = [{ id: 'a', kind, inputs: [], outputs: [] }, { id: 'b', kind: 'application', inputs: [], outputs: [] }];
    const rows = [relation({ from: 'a', to: 'b', type: 'integration' })];
    expect(() => compileArchitectureRelations(rows, objects)).toThrow('关系语义');
    expect(inspectArchitecture({ entities: objects, relations: rows, requirements: [{}] })).toMatchObject({ structure: 'failed', issues: [{ target: 'relation:0', kind: 'classification' }] });
  }
  const objects = [{ id: 'a', kind: 'system', inputs: [], outputs: ['事项'] }, { id: 'b', kind: 'application', inputs: ['事项'], outputs: [] }];
  for (const extra of [{ intent: 'usage' }, { data: '事项' }, { data: undefined }, { from: 'a', to: 'a' }])
    expect(() => compileArchitectureRelations([relation({ from: 'a', to: 'b', type: 'integration', ...extra })], objects)).toThrow('关系语义');
});
