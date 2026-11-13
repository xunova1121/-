import { makeArchitecturePlan } from './architecturePlan.js';
import { inspectArchitecture } from './architectureReview.js';
import { architectureRelationDiagnostics } from './architectureRelations.js';
/** 同一次预检收集字段与可安全检查的关系问题；只出诊断，不删坏行、不返回可交付的部分底稿。 */
export function validateArchitectureContent(input, materials, request = '') {
  let diagnostics = [];
  try {
    makeArchitecturePlan(input, materials, request, [], { collectErrors: true });
  } catch (error) {
    if (error.code !== 'ARCHITECTURE_PLAN' || !error.diagnostics?.length) throw error;
    diagnostics = [...error.diagnostics];
  }
  const ids = new Set(input.entities.map(item => item.id));
  const inspectable = input.entities.every(item => Array.isArray(item.inputs) && Array.isArray(item.outputs)) &&
    input.relations.every(item => ids.has(item.from) && ids.has(item.to));
  if (inspectable) {
    // 编译输入的sources尚非已核回执；本处只检查关系，原来源完整性仍由原底稿入口重读核验。
    const report = inspectArchitecture({ ...input, sources: undefined });
    diagnostics.push(...architectureRelationDiagnostics(input, report.issues));
  }
  if (diagnostics.length) throw Object.assign(new Error('架构预检共' + diagnostics.length + '项未通过，请按完整清单定点修正'), {
    code: 'ARCHITECTURE_PLAN', kind: 'input', diagnostics
  });
}
