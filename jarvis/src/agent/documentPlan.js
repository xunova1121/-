import { DOCUMENT_TEMPLATES } from './documentTemplates.js';

export function documentError(message, code = 'DOCUMENT_INPUT') {
  return Object.assign(new Error(message), { code, kind: 'validation' });
}

/** 对不上任何场景时用的通用做法：只管结构清楚，不带某个行业的规则 */
const GENERAL = {
  pptx: {
    id: 'ppt-general', name: '按内容组织的演示', theme: '', options: {},
    outline: ['用户给了分段就一段一页、顺序不变', '每页标题概括这一页讲什么', '内容按事实写，不改成汇报腔'],
    rules: ['用户给出的分段、顺序和页数优先', '每段内容只放在对应的那一页，不挪到别的页', '标题简洁准确，不硬写成“观点句”']
  },
  docx: {
    id: 'word-general', name: '按内容组织的文档', theme: '', options: {},
    outline: ['按用户给的结构分节', '每节先说结论再展开', '必要时附表格或清单'],
    rules: ['用户给出的结构和顺序优先', '篇幅短就不加封面和目录', '事实、推断分开写']
  },
  xlsx: {
    id: 'excel-general', name: '按内容组织的表格', theme: '', options: {},
    outline: ['明细表', '汇总（需要时）', '说明'],
    rules: ['原始输入和计算结果分开', '能用公式的用公式', '单位、期间写清楚']
  }
};

/** 计划仅返回短资料索引与边界，不重复网页/文件正文，不额外请求模型。 */
export function planDocument({ format, task = '', template_id: templateId, audience = '', sources = [] } = {}) {
  if (!['docx', 'pptx', 'xlsx', 'pdf', 'html', 'md'].includes(format)) {
    throw documentError('请选择支持的文档格式');
  }
  const recipeFormat = ['pdf', 'html', 'md'].includes(format) ? 'docx' : format;
  let recipe;
  if (templateId && templateId !== 'auto') {
    recipe = DOCUMENT_TEMPLATES.find((item) => item.id === templateId);
    if (!recipe || recipe.format !== recipeFormat) throw documentError('模板不存在或与输出格式不匹配', 'DOCUMENT_TEMPLATE');
  } else {
    const candidates = DOCUMENT_TEMPLATES.filter((item) => item.format === recipeFormat);
    const text = String(task).slice(0, 8000);
    const ranked = candidates.map((item) => ({ item, score: (item.keywords || []).reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0) }));
    const best = ranked.sort((a, b) => b.score - a.score)[0];
    // 一个关键词都对不上（剧情梳理、旅行攻略、读书笔记……）：不硬套“决策汇报”之类的场景规则，按用户给的内容组织
    recipe = best?.score ? best.item : GENERAL[recipeFormat];
  }
  if (!recipe) throw documentError('没有可用的制作方案');
  return {
    format,
    templateId: recipe.id,
    templateName: recipe.name,
    theme: recipe.theme || undefined,
    objective: String(task).slice(0, 2000),
    audience: String(audience).slice(0, 120) || '按用户要求；未说明时不虚构身份',
    sources: (Array.isArray(sources) ? sources : []).slice(0, 12).map((item) => String(item).slice(0, 300)),
    options: recipe.options || {},
    outline: recipe.outline,
    rules: recipe.rules,
    starter: recipe.starter,
    steps: [
      '读取完整要求和参考文件',
      '区分事实、假设与待确认内容',
      '按受众组织内容并选择版式',
      '生成可编辑文件',
      '结构读回与专项检查',
      '可用时真实渲染；报告未完成检查'
    ],
    limits: ['配方是制作方法，骨架不能直接作为已完成正文', '来源清单不代表已读取或已核实', '结构检查、公式静态检查和PDF转换均不等于人工视觉验收']
  };
}
