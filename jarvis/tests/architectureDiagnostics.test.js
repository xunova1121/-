import { it, expect } from 'vitest';
import { makeArchitecturePlan } from '../src/agent/architecturePlan.js';
import { excerptDiagnostics } from '../src/agent/architectureDiagnostics.js';
import { diagramFailureDetails } from '../src/agent/diagramRecovery.js';
const original = '配置“数据服务”，支撑研判处置。';
const materials = [{ path: '合成采购.md', text: '正文：' + original, truncated: false }];
const input = excerpt => ({ title: '合成架构', entities: [{ id: 'data', title: '数据服务', kind: 'capability', responsibility: '提供数据', inputs: [], outputs: [], source: '合成采购.md', excerpt }], relations: [], requirements: [] });
function failure(value, sources = materials) {
  try { makeArchitecturePlan(value, sources); } catch (error) { return error; }
  throw new Error('应拒绝不匹配原文');
}
it('引号差异拒绝且向调用方给真实短候选和位置，原有错误码和阶段不变', () => {
  const actual = original.replace(/[“”]/g, '"');
  const error = failure(input(actual));
  expect(error.code).toBe('ARCHITECTURE_PLAN');
  expect(error.diagnostics[0]).toMatchObject({ field: 'entities[0].excerpt', stage: 'excerpt', diffKind: 'quote', actual, expected: original, offset: 3, firstDiffAt: 2 });
  expect(diagramFailureDetails(error)[0]).toMatchObject({ expected: original, candidateOnly: true, readMaterials: [{ path: '合成采购.md', chars: materials[0].text.length, truncated: false }] });
});
it('缺失来源与内容差异分开，不把标题自动映射成路径', () => {
  const value = input(original); value.entities[0].source = '采购章节标题';
  expect(failure(value).diagnostics[0]).toMatchObject({ field: 'entities[0].source', stage: 'source', diffKind: 'source-missing', expected: '', offset: null });
  expect(failure(value).diagnostics[0].readMaterials[0].path).toBe('合成采购.md');
  const error = failure(input('完全无关的材料和其他项目内容'));
  expect(error.diagnostics[0]).toMatchObject({ diffKind: 'not-found', expected: '', offset: null });
});
it('零宽和全半角只能作诊断，原本忽略空白的成功行为保留', () => {
  expect(failure(input(original.replace('数据', '数\u200b据'))).diagnostics[0].diffKind).toBe('zero-width');
  expect(excerptDiagnostics('模块(接口)', '模块（接口）').diffKind).toBe('unicode');
  expect(() => makeArchitecturePlan(input(original.replace('支撑', '\r\n支 撑')), materials)).not.toThrow();
});
it('相近候选只供人工核对，文字改动与原始需求仍拒绝', () => {
  const altered = original.replace('研判', '调度');
  expect(failure(input(altered)).diagnostics[0]).toMatchObject({ diffKind: 'text-difference', candidateOnly: true });
  const value = input(original);
  value.requirements = [{ text: '改写的需求', entities: ['data'], source: '合成采购.md', excerpt: original }];
  expect(failure(value).diagnostics[0]).toMatchObject({ field: 'requirements[0].text', stage: 'fact' });
});
it('回显大小、候选扫描、材料数量有界，超长材料不做近似搜索', () => {
  const diag = excerptDiagnostics('甲'.repeat(400), '乙'.repeat(120001), Array.from({ length: 10 }, () => ({ path: 'x'.repeat(800), text: 'secret-head' })));
  expect(diag.actual).toHaveLength(120);
  expect(diag.expected).toBe(''); expect(diag.readMaterials).toHaveLength(4);
  expect(diag.readMaterials[0].path).toHaveLength(400);
  expect(JSON.stringify(diag)).not.toContain('secret-head');
});
