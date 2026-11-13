import {architectureScope} from './documentSections.js';
import { createArchitecturePlanTool } from './architectureTool.js';
import { loadArchitecture } from './architectureProjection.js';
import { diagramDigest } from './diagramExport.js';
import { throwControl } from '../core/networkRequest.js';
const invalid = message => Object.assign(new Error(message), { code: 'ARCHITECTURE_REVISION', kind: 'input', diagnostics: [{ stage: 'review', field: 'changes', action: '读取审查意见，仅修改对应对象/关系/需求；保留原文和未改部分，未发生实质变更不能重新审到通过' }] });
const fields = {
  entities: new Set(['id', 'title', 'kind', 'responsibility', 'inputs', 'outputs', 'source', 'excerpt', 'evidenceId', 'assumption']),
  relations: new Set(['from', 'to', 'type', 'meaning', 'source', 'excerpt', 'evidenceId', 'assumption']),
  requirements: new Set(['text', 'entities', 'source', 'excerpt', 'evidenceId'])
};
const clean = (item, key) => Object.fromEntries(Object.entries(item).filter(([field]) => fields[key].has(field)));
/** 每次最多60处显式修改；不按审查文字自动删对象/关系，旧稿保持不动。 */
export function reviseArchitectureInput(plan, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw invalid('修订需要changes');
  const allowed = new Set(['entities', 'relations', 'requirements', 'addEntities', 'addRelations', 'addRequirements', 'removeEntities', 'removeRelations']);
  let count = 0;
  for (const [key, values] of Object.entries(changes)) {
    if (!allowed.has(key) || !Array.isArray(values) || values.length > 60) throw invalid('修订类型无效或单项超过60条');
    count += values.length;
  }
  if (!count || count > 60) throw invalid('修订需1～60处显式修改');
  const input = { title: plan.title, sources: (plan.sources || []).map(item => ({ path: item.path, excerpt: item.excerpt || '', ...architectureScope(item) })) };
  for (const key of ['entities', 'relations', 'requirements']) {
    input[key] = plan[key].map(item => clean(item, key));
    const touched = new Set();
    for (const patch of changes[key] || []) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('修改项需为对象');
      const index = key === 'entities' ? input.entities.findIndex(item => item.id === patch.id) : patch.index;
      if (!Number.isInteger(index) || index < 0 || index >= input[key].length || touched.has(index)) throw invalid('修改目标不存在、重复或索引越界');
      for (const field of Object.keys(patch)) if (!fields[key].has(field) && field !== 'index') throw invalid('修改含未知字段：' + field);
      touched.add(index);
      const next = { ...input[key][index], ...clean(patch, key) };
      // 改证据时不能把旧编号/假设和新证据混在一起；最终仍走原严格校验。
      if (patch.evidenceId !== undefined) {
        if (patch.source === undefined) delete next.source;
        if (patch.excerpt === undefined) delete next.excerpt;
        if (patch.assumption === undefined) delete next.assumption;
      }
      else if (patch.source !== undefined || patch.excerpt !== undefined) { delete next.evidenceId; delete next.assumption; }
      else if (patch.assumption !== undefined) { delete next.evidenceId; delete next.source; delete next.excerpt; }
      input[key][index] = next;
    }
    const removed = key === 'entities' ? changes.removeEntities || [] : key === 'relations' ? changes.removeRelations || [] : [];
    const indices = new Set();
    for (const target of removed) {
      const index = key === 'entities' ? input.entities.findIndex(item => item.id === target) : target;
      if (!Number.isInteger(index) || index < 0 || index >= input[key].length || indices.has(index) || touched.has(index)) throw invalid('移除目标不存在、重复或同时被修改');
      indices.add(index);
    }
    input[key] = input[key].filter((_, index) => !indices.has(index));
    const additions = changes['add' + key[0].toUpperCase() + key.slice(1)] || [];
    for (const addition of additions) {
      if (!addition || typeof addition !== 'object' || Array.isArray(addition) || Object.keys(addition).some(field => !fields[key].has(field))) throw invalid('新增项含未知字段');
      input[key].push(clean(addition, key));
    }
  }
  const before = Object.fromEntries(['entities', 'relations', 'requirements'].map(key => [key, plan[key].map(item => clean(item, key))]));
  if (JSON.stringify(before) === JSON.stringify({ entities: input.entities, relations: input.relations, requirements: input.requirements })) throw invalid('没有实质变更，不能重复请求审查');
  return input;
}
export function createArchitectureRevisionTool(ctx) {
  const base = createArchitecturePlanTool(ctx);
  const properties = base.input_schema.properties;
  const patch = (key, required) => ({ type: 'array', maxItems: 30, items: { type: 'object', properties: { ...properties[key].items.properties, ...(key !== 'entities' && { index: { type: 'integer', minimum: 0, maximum: 99 } }) }, required, additionalProperties: false } });
  return {
    name: 'revise_architecture_plan',
    description: '根据架构审查具体意见定点修改已有底稿；保留未改对象、证据与原稿，修订另存新稿并重新严格审查。entities按id，relations/requirements按旧稿数组index；删除仅支持显式对象/关系，不能删除需求绕过覆盖。无实质修改不能反复审到通过。技术not_checked优先create_diagram恢复，不重建。',
    input_schema: { type: 'object', properties: {
      architecturePath: { type: 'string', maxLength: 400 }, reason: { type: 'string', minLength: 1, maxLength: 240 },
      changes: { type: 'object', properties: {
        entities: patch('entities', ['id']), relations: patch('relations', ['index']), requirements: patch('requirements', ['index']),
        addEntities: properties.entities, addRelations: properties.relations, addRequirements: properties.requirements,
        removeEntities: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } }, removeRelations: { type: 'array', maxItems: 30, items: { type: 'integer', minimum: 0, maximum: 99 } }
      }, additionalProperties: false }
    }, required: ['architecturePath', 'reason', 'changes'], additionalProperties: false },
    run: async ({ architecturePath, reason, changes }, execution = {}) => {
      throwControl(null, execution.signal);
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 240) throw invalid('修订原因需1～240字');
      const bundle = await loadArchitecture(architecturePath, execution.signal);
      const input = reviseArchitectureInput(bundle.plan, changes);
      const previousUserEvidence = ['entities', 'relations', 'requirements'].flatMap(key => bundle.plan[key]).filter(item => item.source === 'user' && item.evidence === 'excerpt_matched').map(item => item.excerpt);
      const contentHash = await diagramDigest(JSON.stringify({ entities: bundle.plan.entities, relations: bundle.plan.relations, requirements: bundle.plan.requirements }));
      return base.run(input, { ...execution, previousUserEvidence, architectureRevision: { parentPath: architecturePath, parentHash: bundle.planHash, contentHash, reason } });
    }
  };
}
