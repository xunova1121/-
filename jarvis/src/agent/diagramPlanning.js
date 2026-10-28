/** 画前规划只整理来源与覆盖，不把模型建议提升为事实，也不调用额外模型。 */
/**
 * 用户明确要“逐条核对需求原文 / 严格审查”时才走 build_architecture 严格流水线。
 * 平时的总体架构图直接 create_diagram：严格流水线要模型一次写对几十条带类型的关系，
 * 2026-10-26～29 真实测试连续五六次一张图都没出（见 docs/交接给Claude-架构实测失败与未发布改动-20261029.md）。
 */
export const STRICT_ARCHITECTURE = /逐[条项一](?:核对|对应|核实|审查)|对应(?:到)?(?:每条|逐条)?需求原文|需求原文.{0,6}(?:核对|对应)|严格(?:核对|审查|模式)|业务审查/;
export const strictArchitecture = (text) => STRICT_ARCHITECTURE.test(String(text || ''));

export const DIAGRAM_PLANNING =
  '画总体架构图 / 项目架构图：直接用 create_diagram 出图。先用 read_file 读原始材料（长文件先 view=sections 看目录，再读建设内容、技术要求等相关章节）。材料里的数量、系统名、设备型号逐项写进标题、说明或要点，不压成一句概括；材料没有的层不硬凑。design.theme=gov-blue，direction=top-down，design.message 写一句主线（如“平台统筹 · 三端协同 · 感知联动”）。' +
  '好看的版式照这个填（自上而下）：①展示层 columns 3～4个（title=大屏/PC/手机，detail=用途）；②业务应用层 cards 2～4张主卡，每张都给 icon、accent（orange/blue/green 轮换）、bullets 3～4条 {text}（每条≤14字）、badge=这一端的核心能力（≤8字），相邻主卡之间连 edges 并写 label（≤6字，如“结构化线索”“任务工单”）；③闭环反馈用 band（层标题≤6字如“处置反馈”，节点 detail 写“事件回溯 · 结果归档 · 数据回流 → 支撑下次研判”）；④平台的几层用同一 group（写平台名）：业务模块 grid（8～18个只写标题），能力中心 columns（2～4个，icon + subtitle 用“/”分隔要点），感知与协同 columns；⑤基础层 columns 3个（终端感知 / 网络传输 / 云基础设施：subtitle=作用，detail=设备和数量）；⑥安全保障 band 放最后（层标题≤6字）。' +
  '节点标题≤10字、说明≤40字。跨层不连线（上下排列就是支撑关系，连了会交叉），只有同层相邻主卡用带字箭头。版式参数不合规则时程序会自动调整并在 layoutAdjusted 里说明，交付时告诉用户；仍报错就按报错删减或拆分后再画一次，一定要交出图。contentPlan 可不填。' +
  '只有用户明确要求“逐条核对需求原文 / 严格审查”时才用 build_architecture(files,request,directory,views) 严格流水线，失败只用 jobPath 继续。' +
  '已有 architecturePath 时交 create_diagram 复用；明确业务 failed 须读 reviewPath，用 revise_architecture_plan 按意见定点修订。';

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
