/** 业务关系先于坐标；最多60对象、100关系、80需求，事实须绑定实际材料，不能据名称猜归属。 */
export const ARCHITECTURE_KINDS = ['interface', 'application', 'capability', 'data', 'acquisition', 'infrastructure', 'system', 'security'];
export const ARCHITECTURE_RELATIONS = ['contains', 'supports', 'dataflow', 'workflow', 'feedback'];
const invalid = (message) => Object.assign(new Error(message), { code: 'ARCHITECTURE_PLAN', kind: 'input' });
const compact = (value) => String(value || '').replace(/\s+/g, '');
const field = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) throw invalid(label + '为空或过长');
  return value.trim();
};
function evidence(item, materials, requestText) {
  if (item.assumption) return { assumption: field(item.assumption, 240, '假设前提'), evidence: 'assumption' };
  const source = field(item.source, 400, '原文路径');
  const excerpt = field(item.excerpt, 400, '原文摘录');
  const original = source === 'user' ? requestText : materials.find((material) => material.path === source)?.text;
  if (!original || !compact(original).includes(compact(excerpt))) throw invalid('依据未出现在实际读取材料中：' + source);
  return { source, excerpt, evidence: 'excerpt_matched' };
}
function strings(values, label) {
  if (!Array.isArray(values) || values.length > 8) throw invalid(label + '最多8条');
  return values.map((value) => field(value, 100, label));
}
export function makeArchitecturePlan(input, materials = [], requestText = '') {
  const title = field(input.title, 80, '标题');
  if (!Array.isArray(input.entities) || !input.entities.length || input.entities.length > 60) throw invalid('业务对象需1～60个');
  if (!Array.isArray(input.relations) || input.relations.length > 100) throw invalid('关系最多100条');
  if (!Array.isArray(input.requirements) || input.requirements.length > 80) throw invalid('需求最多80条');
  const ids = new Set();
  const entities = input.entities.map((item) => {
    const id = field(item.id, 64, '对象ID');
    if (ids.has(id) || !ARCHITECTURE_KINDS.includes(item.kind)) throw invalid('对象ID重复或类型无效');
    ids.add(id);
    return {
      id,
      title: field(item.title, 48, '对象名称'),
      kind: item.kind,
      responsibility: field(item.responsibility, 160, '职责'),
      inputs: strings(item.inputs, '输入'),
      outputs: strings(item.outputs, '输出'),
      ...evidence(item, materials, requestText)
    };
  });
  const links = new Set();
  const relations = input.relations.map((item) => {
    if (!ids.has(item.from) || !ids.has(item.to) || item.from === item.to || !ARCHITECTURE_RELATIONS.includes(item.type)) throw invalid('关系类型或端点无效');
    const key = [item.from, item.to, item.type].join('\u0000');
    if (links.has(key)) throw invalid('同类型关系重复');
    links.add(key);
    return { from: item.from, to: item.to, type: item.type, meaning: field(item.meaning, 120, '关系含义'), ...evidence(item, materials, requestText) };
  });
  const requirements = input.requirements.map((item, index) => {
    const text = field(item.text, 240, '需求');
    if (!Array.isArray(item.entities) || !item.entities.length || item.entities.length > 12 || item.entities.some((id) => !ids.has(id)))
      throw invalid('每条需求必须映射1～12个存在的对象');
    const proof = evidence(item, materials, requestText);
    if (proof.evidence !== 'excerpt_matched' || !compact(proof.excerpt).includes(compact(text))) throw invalid('原始需求必须保留原文，不能用建议替代');
    return { id: 'requirement-' + index, text, entities: [...new Set(item.entities)], ...proof };
  });
  return {
    version: 1,
    title,
    entities,
    relations,
    requirements,
    coverage: requirements.length ? 'declared_requirements_mapped' : 'not_checked',
    semantic: 'not_checked',
    note: '原文摘录匹配与声明需求映射不代表完整材料覆盖或业务关系已经核实；假设单列。'
  };
}
export function architectureMarkdown(plan) {
  const escape = (value) => String(value).replace(/\|/g, '／').replace(/\n/g, ' ');
  const lines = [
    '# ' + plan.title + '：业务关系底稿',
    '',
    '业务语义：未验收。已登记需求覆盖：' + plan.coverage,
    '',
    '| 对象 | 类型 | 职责 | 输入 | 输出 | 依据或假设 |',
    '|---|---|---|---|---|---|'
  ];
  for (const item of plan.entities)
    lines.push(
      '| ' +
        [item.title, item.kind, item.responsibility, item.inputs.join('；'), item.outputs.join('；'), item.assumption || item.source + '：' + item.excerpt]
          .map(escape)
          .join(' | ') +
        ' |'
    );
  lines.push('', '## 明确关系');
  const byId = new Map(plan.entities.map((item) => [item.id, item.title]));
  for (const item of plan.relations)
    lines.push(
      '- ' +
        byId.get(item.from) +
        ' → ' +
        byId.get(item.to) +
        ' [' +
        item.type +
        ']：' +
        item.meaning +
        '；' +
        (item.assumption ? '假设：' + item.assumption : '依据：' + item.source + '：' + item.excerpt)
    );
  lines.push('', '## 需求映射');
  for (const item of plan.requirements) lines.push('- ' + item.text + ' → ' + item.entities.map((id) => byId.get(id)).join('、'));
  return lines.join('\n');
}
