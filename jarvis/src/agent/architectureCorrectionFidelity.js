const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => JSON.stringify(value, (_, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const identity = row => ({ from: row?.from ?? null, to: row?.to ?? null, type: row?.type ?? null });
const pair = (left, right) => object(left) && object(right) && left.from === right.from && left.to === right.to;
const proof = row => ({ ...(row?.citation !== undefined && { citation: row.citation }), ...(row?.assumption !== undefined && { assumption: row.assumption }) });
const sameProof = (left, right) => stable(proof(left)) === stable(proof(right));
const explicitIntent = row => ['usage', 'presentation', 'hosting'].includes(row?.intent) || (row?.type === 'dataflow' && typeof row.data === 'string' && Boolean(row.data.trim()));
const strongCitation = row => object(row?.citation) && Number.isInteger(row.citation.material) && row.citation.material >= 0 &&
  ((Number.isInteger(row.citation.block) && row.citation.block >= 0) || (typeof row.citation.quote === 'string' && Boolean(row.citation.quote.trim()) && row.citation.quote.length <= 240));
const fail = (group, index, message, action) => Object.assign(new Error(message), {
  code: 'ARCHITECTURE_CORRECTION_FIDELITY', kind: 'input',
  diagnostics: [{ field: group + '[' + index + ']', stage: 'review', action }]
});
function acknowledged(patch, before) {
  const expected = identity(before);
  return object(patch?.expected) && Object.keys(patch.expected).length === 3 &&
    ['from', 'to', 'type'].every(key => Object.hasOwn(patch.expected, key) && patch.expected[key] === expected[key]) &&
    typeof patch.reason === 'string' && Boolean(patch.reason.trim()) && patch.reason.length <= 240;
}
function validIdentity(row, entities) {
  return typeof row?.from === 'string' && typeof row?.to === 'string' && row.from !== row.to && entities.has(row.from) && entities.has(row.to);
}
function preserveFact(before, after, group, index) {
  if (before?.citation && after?.assumption && !after?.citation)
    throw fail(group, index, '不能将已登记事实改成假设以绕过核实', '保留事实及其引用；引用错误只修真实材料编号，不降级为推导');
}
function mapsPreserved(before, after, index, knownIds) {
  if (!Array.isArray(before?.entities)) return;
  const next = new Set(Array.isArray(after?.entities) ? after.entities : []);
  const removed = [...new Set(before.entities)].filter(id => typeof id === 'string' && id.trim() && (!knownIds || knownIds.has(id)) && !next.has(id));
  if (removed.length) throw fail('requirements', index, '需求修复丢失原对象关联：' + removed.slice(0, 8).join('、'), '保留全部原对象ID；每条超过12个时由程序无损拆组，不删关联来过上限');
}
function relationPreserved(before, after, previous, next, index, patch) {
  if (!object(before)) return;
  preserveFact(before, after, 'relations', index);
  if (pair(before, after)) return;
  const oldIds = new Set(previous.entities.map(row => row?.id));
  const shared = before.from === after.from || before.from === after.to || before.to === after.from || before.to === after.to;
  // 原始自连/不存在端点尚无有效拓扑，只在同一对象与依据下允许定点纠正。
  if (!validIdentity(before, oldIds) && shared && sameProof(before, after) && (!before.intent || before.intent === after.intent)) return;
  if (!acknowledged(patch, before) || !strongCitation(after))
    throw fail('relations', index, '改变关系端点须明确旧身份、修改原因与真实引用', '填expected:{from,to,type}逐字对应旧关系（缺省type用null）、reason不超过240字；同一对对象的反向修正还须明确intent或data，不换成无关边');
  const reverse = before.from === after.to && before.to === after.from;
  if (reverse && explicitIntent(after)) return;
  // 指错一个业务端点时仍须保留原职责含义和依据，不能借共享一个节点偷换业务。
  if (shared && before.meaning === after.meaning && sameProof(before, after)) return;
  if (next.relations.some((row, rowIndex) => rowIndex !== index && pair(before, row) && before.type === row.type && before.meaning === row.meaning && sameProof(before, row))) return;
  throw fail('relations', index, '局部修复替换了无关业务关系，原关系未被保留', '修正原关系的类型、交互数据或方向；不能将其换成另一条有依据但无关的边来凑通过');
}
const audit = (group, index, before, after, patch, kind) => ({
  group, index, kind, ...(group === 'relations' && { expected: identity(before) }),
  reason: typeof patch?.reason === 'string' ? patch.reason.trim() : '保留业务身份的定点修正',
  previous: structuredClone(before), next: structuredClone(after)
});

/** 最多240处替换，完整前后值仅供私有审计；外层仍守8万字符，不能靠行数不变隐藏删换关系。 */
export function checkArchitectureCorrectionFidelity(previous, next, patches) {
  const correctionAudit = [];
  const knownIds = new Set(previous.entities.map(row => row?.id));
  for (const patch of patches) {
    const before = previous[patch.group][patch.index], after = next[patch.group][patch.index];
    if (patch.reason !== undefined && (typeof patch.reason !== 'string' || !patch.reason.trim() || patch.reason.length > 240))
      throw fail(patch.group, patch.index, '修改原因需1～240字', '仅保留明确的定点修改原因，不在reason夹带整篇材料');
    if (patch.expected !== undefined && patch.group === 'relations' && !acknowledged(patch, before))
      throw fail(patch.group, patch.index, 'expected与旧身份不一致或缺少修改原因', 'expected只填原关系from/to/type，缺省type填null；同时写明reason，不能按过期索引覆盖新关系');
    preserveFact(before, after, patch.group, patch.index);
    if (patch.group === 'entities' && typeof before?.id === 'string' && before.id.trim() && before.id !== after.id)
      throw fail('entities', patch.index, '局部修复不能更换已登记对象ID', '保留id，只修职责、类型、端口或真实引用；新增对象不能覆盖原对象');
    if (patch.group === 'requirements') mapsPreserved(before, after, patch.index, knownIds);
    if (patch.group === 'relations') relationPreserved(before, after, previous, next, patch.index, patch);
    if (stable(before) !== stable(after)) correctionAudit.push(audit(patch.group, patch.index, before, after, patch, 'patch'));
  }
  return correctionAudit;
}

/** 完整回复兼容结构补充，但旧对象/需求关联/业务目的均须保留；改变身份请用可审计局部修复。 */
export function checkArchitectureReplacementFidelity(previous, next) {
  const correctionAudit = [];
  const entities = new Map(next.entities.map(row => [row?.id, row]));
  const oldIds = new Set(previous.entities.map(row => row?.id));
  for (const [index, row] of previous.entities.entries()) {
    if (!object(row) || typeof row.id !== 'string' || !row.id.trim()) continue;
    const current = entities.get(row.id);
    if (!current) throw fail('entities', index, '完整回复丢失已登记对象：' + row.id, '保留原对象ID和事实；拆分活动可增加新对象，不覆盖或重编号原对象');
    if (!sameProof(row, current)) throw fail('entities', index, '完整回复变更原对象依据，请改用定点修复', '用corrections明确修正引用，不借整稿重写替换原事实');
    preserveFact(row, current, 'entities', index);
    if (stable(row) !== stable(current)) correctionAudit.push(audit('entities', index, row, current, null, 'preserved_replacement'));
  }
  for (const [index, row] of previous.requirements.entries()) {
    if (!object(row)) continue;
    const candidates = next.requirements.filter(item => sameProof(row, item));
    if (!candidates.length) throw fail('requirements', index, '完整回复丢失原需求依据', '保留原条款与全部映射；同一条款可按原证据拆组');
    mapsPreserved(row, { entities: candidates.flatMap(item => item.entities || []) }, index, oldIds);
    if (!candidates.some(current => stable(row) === stable(current)))
      correctionAudit.push(audit('requirements', index, row, candidates.length === 1 ? candidates[0] : candidates, null, 'preserved_replacement'));
  }
  const used = new Set();
  for (const [index, row] of previous.relations.entries()) {
    if (!object(row)) continue;
    let match = next.relations.findIndex((item, slot) => !used.has(slot) && pair(row, item) && sameProof(row, item) &&
      (row.meaning === item.meaning || explicitIntent(item)));
    if (match < 0 && !validIdentity(row, oldIds)) match = next.relations.findIndex((item, slot) => !used.has(slot) && sameProof(row, item) &&
      (row.from === item.from || row.to === item.to || row.from === item.to || row.to === item.from) && (!row.intent || row.intent === item.intent));
    if (match < 0) throw fail('relations', index, '完整回复丢失或改换原业务关系', '保留原关系对象、目的和证据；分类/方向纠正用带expected与reason的corrections，不整稿覆盖');
    used.add(match);
    if (stable(row) !== stable(next.relations[match])) correctionAudit.push(audit('relations', index, row, next.relations[match], null, 'preserved_replacement'));
  }
  return correctionAudit;
}
