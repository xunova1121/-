const groups = { entities: 60, relations: 100, requirements: 80 };
const failure = (message, field, action) => Object.assign(new Error(message), {
  code: 'ARCHITECTURE_CONTENT_SCHEMA', kind: 'input', diagnostics: [{ field, stage: 'format', action }]
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** 可执行示例用于约束实际提示词，测试须用同一示例走原编译/结构校验，避免只测手写正确回复。 */
export const ARCHITECTURE_CONTENT_EXAMPLE = {
  title: '虚构示例架构',
  entities: [
    { id: 'receive', title: '受理', kind: 'application', responsibility: '登记事项', inputs: [], outputs: ['已登记事项'], citation: { material: 0, block: 0 } },
    { id: 'handle', title: '办理', kind: 'application', responsibility: '处理已登记事项', inputs: ['已登记事项'], outputs: [], citation: { material: 0, block: 0 } }
  ],
  relations: [{ from: 'receive', to: 'handle', type: 'workflow', meaning: '受理后办理', citation: { material: 0, block: 0 } }],
  requirements: [{ entities: ['receive', 'handle'], citation: { material: 0, block: 0 } }]
};
/** 只做无损字段适配，不改业务、证据或条数；歧义/未知顶层字段拒绝，原始回复另存。 */
export function normalizeArchitectureContent(value) {
  if (!object(value)) throw failure('业务内容根节点必须是JSON对象', 'response', '使用title/entities/relations/requirements四个根键');
  const keys = Object.keys(value);
  if (Object.hasOwn(value, 'entities') && Object.hasOwn(value, 'objects'))
    throw failure('同时出现entities和objects，不能猜测采用哪份对象', 'entities', '仅保留一份完整entities，不合并或删除两份内容');
  const unknown = keys.filter(key => !['title', 'entities', 'objects', 'relations', 'requirements'].includes(key));
  if (unknown.length) throw failure('业务内容包含未约定根键：' + unknown.slice(0, 8).map(key => key.slice(0, 60)).join('、'), 'response', '把业务内容放在约定字段；不能静默丢弃其他根键');
  const adapted = Object.hasOwn(value, 'objects');
  const content = adapted ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key === 'objects' ? 'entities' : key, item])) : value;
  if (JSON.stringify(content).length > 80000)
    throw failure('业务内容超过8万字符，不能靠多次局部替换累积无界内容', 'response', '保留本轮原稿；在原容量内按具体诊断修正，不截断条目');
  const diagnostics = [];
  for (const [group, max] of Object.entries(groups)) {
    if (!Array.isArray(content[group]) || !content[group].length || content[group].length > max)
      diagnostics.push({ field: group, stage: 'format', message: group + '必须非空且不超过' + max + '项', action: '根键必须为title/entities/relations/requirements；保留全部真实内容，不用objects或其他别名' });
  }
  if (diagnostics.length) throw Object.assign(failure('业务内容结构未通过：' + diagnostics.map(item => item.message).join('；'), diagnostics[0].field, diagnostics[0].action), { diagnostics });
  return { content, adapters: adapted ? ['objects->entities'] : [] };
}
/** 续改只替换明确的现有行，不删项/添项；完成后仍过原文、结构、业务和导出全部门槛。 */
export function applyArchitectureCorrections(response, previousContent) {
  if (!object(response) || !Object.hasOwn(response, 'corrections')) return normalizeArchitectureContent(response);
  if (!previousContent || Object.keys(response).length !== 1 || !Array.isArray(response.corrections) || !response.corrections.length || response.corrections.length > 240)
    throw failure('局部修复需要已有完整内容及1～240项corrections，不混入完整稿', 'corrections', '首次返回完整内容；续改仅返回corrections数组');
  const { content, adapters } = normalizeArchitectureContent(previousContent);
  const next = structuredClone(content), touched = new Set();
  for (const patch of response.corrections) {
    const key = patch?.group + ':' + patch?.index;
    if (!object(patch) || Object.keys(patch).some(key => !['group', 'index', 'value'].includes(key)) || !Object.hasOwn(groups, patch.group) || !Number.isInteger(patch.index) || patch.index < 0 || !next[patch.group][patch.index] || !object(patch.value) || touched.has(key))
      throw failure('局部修复位置无效、重复或包含删除/新增操作', 'corrections', '按现有group/index替换完整value；不能删行、增加行或重复修同一位置');
    touched.add(key);
    next[patch.group][patch.index] = structuredClone(patch.value);
  }
  const checked = normalizeArchitectureContent(next);
  return { content: checked.content, adapters };
}
