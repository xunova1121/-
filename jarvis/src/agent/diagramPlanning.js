/** 画前规划只整理来源与覆盖，不把模型建议提升为事实，也不调用额外模型。 */
export const DIAGRAM_PLANNING = '重要总体架构图先完整读取相关原文章节并调用plan_architecture，登记对象职责、输入输出、依据和需求映射，区分包含/支撑/数据流/业务流/反馈，再按关系决定分层；业务是做什么、能力是共用服务、数据是信息对象、基础设施是运行资源，不能凭名称硬塞层或把所有关系画成箭头。总体架构图先读原始材料，按展示/用户、业务应用与闭环、平台模块和能力中心、感知/数据、终端/网络/算力云、安全保障、标准规范列内容提纲，再交create_diagram。材料中的数量、系统名、设备型号及主业务关系逐项保留，不压成一句概括；缺失层不硬凑，新增通用能力标为建议。用contentPlan.facts逐条登记关键事实及来源原文，用recommendations登记建议；事实text必须实际出现在图中标题、副标题、说明、要点或标签中，用户原话来源用user，文件来源用确切路径。先保证内容完整，再排版；不要为塞进一张图偷偷删数量或系统名称，超限明确拆图。';

const invalid = (message) => Object.assign(new Error(message), { code: 'DIAGRAM_CONTENT_PLAN', kind: 'input' });
const compact = (value) => String(value || '').replace(/\s+/g, '');
const LEVELS = [
  ['展示与用户', /展示|用户|大屏|移动|界面/],
  ['业务应用与闭环', /业务|应用|预警|指挥|执法|反馈|闭环/],
  ['平台能力', /平台|中台|能力|模块/],
  ['感知与数据', /感知|数据/],
  ['基础设施', /基础|终端|网络|算力|云/],
  ['安全保障', /安全|保障/],
  ['标准规范', /标准|规范/]
];

export function planDiagramContent(input, materials = [], requestText = '') {
  const supplied = input.contentPlan || {};
  const facts = supplied.facts || [];
  const recommendations = supplied.recommendations || [];
  if (!Array.isArray(facts) || facts.length > 80 || !Array.isArray(recommendations) || recommendations.length > 20)
    throw invalid('内容规划最多80条关键事实、20条建议');
  const drawn = compact([input.title, input.design?.message || '', ...input.layers.map(layer => [layer.title, layer.group || '', ...layer.nodes.map(node => `${node.title}\n${node.subtitle || ''}\n${node.detail || ''}\n${(node.bullets || []).map(item => item.text).join('\n')}\n${node.badge || ''}`)].join('\n'))].join('\n'));
  const errors = [];
  const checked = facts.map((fact, index) => {
    try {
    const reject = (stage, field, message, action) => { throw Object.assign(invalid(message + `（contentPlan.facts[${index}].${field}）`), { diagnostics: [{ stage, field: `contentPlan.facts[${index}].${field}`, action }] }); };
    if (typeof fact.text !== 'string' || !fact.text.trim() || fact.text.length > 160 || typeof fact.source !== 'string' || fact.source.length > 400 || typeof fact.excerpt !== 'string' || !fact.excerpt.trim() || fact.excerpt.length > 240)
      reject('arguments', 'text', '每条关键事实需text、source和不超过240字的原文excerpt', '按结构补全当前条目，不改其他事实');
    const original = fact.source === 'user' ? requestText : materials.find(item => item.path === fact.source)?.text;
    if (!original) reject('source', 'source', '关键事实无法匹配指定原文：来源未读取或路径不一致', '读取sources中确切文件；不要借另一份同名材料的证据');
    if (!compact(original).includes(compact(fact.excerpt))) reject('excerpt', 'excerpt', '关键事实无法匹配指定原文：摘录不存在', '从所选来源逐字摘取；检查正文范围与版本，不猜摘录');
    if (!compact(fact.excerpt).includes(compact(fact.text))) reject('fact', 'text', '关键事实无法匹配指定原文：事实不在摘录中', '保留摘录中的实际名称和数量；建议移到recommendations');
    if (!drawn.includes(compact(fact.text))) reject('inclusion', 'text', '关键事实未进入图形节点，请补齐后再绘制：' + fact.text, '把当前事实放入实际节点标题、说明或要点，不用元数据冒充入图');
    return { ...fact, evidence: 'source_excerpt_matched', included: true };
    } catch (error) {
      if (error.code !== 'DIAGRAM_CONTENT_PLAN') throw error;
      errors.push(error);
      return null;
    }
  });
  if (errors.length) throw Object.assign(errors[0], { diagnosticCount: errors.length, diagnostics: errors.flatMap(error => error.diagnostics || []).slice(0, 8) });
  if (recommendations.some(item => typeof item !== 'string' || !item.trim() || item.length > 160)) throw invalid('每条建议需为1至160字的文本');
  // 只给层级候选，不把缺失的层自动生成成项目事实。
  const levels = LEVELS.map(([label, pattern]) => ({ label, layers: input.layers.filter(layer => pattern.test(layer.title)).map(layer => layer.title) }));
  return { version: 1, levels, facts: checked, recommendations, coverage: checked.length ? 'declared_facts_matched' : 'not_checked', note: '仅核对已登记事实的原文和入图情况，不代表材料全部覆盖或业务真实性通过。' };
}
