import { architectureReviewInput } from './architectureReviewResponse.js';

const groups = ['entities', 'relations', 'requirements'];
const keyFor = row => typeof row?.source === 'string' && typeof row?.excerpt === 'string' && !Object.hasOwn(row, 'evidenceRef')
  ? JSON.stringify([row.source, row.excerpt]) : null;

/** 只合并逐字重复的证据副本，保留原文材料、采购条款、目标编号及所有业务字段。 */
export function serializeArchitectureReviewContext(plan, options = {}) {
  const context = {
    plan: architectureReviewInput(plan), sourceMaterials: options.materials || [], userRequest: options.rawRequestText || '',
    ...(options.previousUserEvidence?.length && { previousUserEvidence: options.previousUserEvidence }),
    ...(options.recoveryReason && { recoveryReason: options.recoveryReason })
  };
  const original = JSON.stringify(context);
  // 正式入口原上限为60对象/100关系/80需求；超出2MB不再复制，仍由原200k门槛拒绝。
  if (new TextEncoder().encode(original).length > 2000000 || groups.reduce((count, group) => count + plan[group].length, 0) > 240) return original;
  const counts = new Map();
  for (const group of groups) for (const row of context.plan[group]) {
    const key = keyFor(row);
    if (key !== null) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const references = new Map(), evidenceDictionary = {};
  for (const [key, count] of counts) if (count > 1) {
    const id = 'e' + references.size, [source, excerpt] = JSON.parse(key);
    references.set(key, id); evidenceDictionary[id] = { source, excerpt };
  }
  if (!references.size) return original;
  const compactPlan = { ...context.plan };
  for (const group of groups) compactPlan[group] = context.plan[group].map(row => {
    const id = references.get(keyFor(row));
    if (id === undefined) return row;
    const copy = { ...row, evidenceRef: id };
    delete copy.excerpt;
    return copy;
  });
  const compact = JSON.stringify({ ...context, plan: compactPlan, evidenceDictionary });
  return compact.length < original.length ? compact : original;
}
