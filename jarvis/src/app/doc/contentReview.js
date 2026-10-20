import { LIMITS, readJson, workflowError } from './workflowSchema.js';
import { WRITING_RULES } from './workflowPolicy.js';

export function validateReview(value, plan, draft) {
  if (!value || (!Array.isArray(value.issues) && !Array.isArray(value.coverage))) throw workflowError('内容审查格式无效', 'DOCUMENT_RESPONSE');
  // 审查结果格式不完美时不整篇失败：编号不认识、重复的忽略；没审到的需求一律按“缺失”，绝不默认通过
  const byId = new Map();
  for (const item of Array.isArray(value.coverage) ? value.coverage : []) {
    if (!item || byId.has(item.id)) continue;
    byId.set(item.id, item);
  }
  const coverage = plan.brief.requirements.map(({ id }) => {
    const item = byId.get(id);
    if (!item) return { id, result: 'missing', quote: '' };
    const quote = String(item.quote ?? '').slice(0, 1600);
    const result = ['supported', 'partial', 'missing'].includes(item.result) ? item.result : 'partial';
    return { id, result: result === 'supported' && (!quote.trim() || !draft.includes(quote)) ? 'missing' : result, quote };
  });
  const issues = (Array.isArray(value.issues) ? value.issues : [])
    .filter((item) => item && String(item.problem ?? '').trim())
    .slice(0, LIMITS.issues)
    .map((item, index) => ({
      id: `ISSUE-${index + 1}`,
      severity: item.severity === 'must_fix' ? 'must_fix' : 'warning',
      location: String(item.location || '（未注明位置）').slice(0, 300),
      problem: String(item.problem).slice(0, 1600),
      fix: String(item.fix || '按问题说明修改').slice(0, 1600)
    }));
  for (const item of coverage.filter((item) => item.result !== 'supported')) {
    issues.push({
      id: `COVERAGE-${item.id}`,
      severity: 'must_fix',
      location: item.id,
      problem: '明确需求未充分落实，不能靠关键词声称通过',
      fix: '恢复该要求，写明推荐方案及实施条件'
    });
  }
  return { coverage, issues, outcome: issues.some((item) => item.severity === 'must_fix') ? 'needs_revision' : 'model_reviewed' };
}

export async function reviewDocument(input, plan, draft, ask, stage = 'reviewing') {
  const output = await ask(stage, {
    system: `你是严格的文档内容审查员，不因文风正式而认可方案。${WRITING_RULES}只输出JSON。`,
    prompt: `核对完整原始要求，不只核对底稿。检查需求遗漏或降级、业务断点、无依据的数字、事实与建议混淆、重复空话、验收场景。\n原始要求：${input.task}\n材料：${input.material}\n底稿与推演：${JSON.stringify(plan)}\n正文：\n${draft}\n输出{"coverage":[{"id":"REQ-1","result":"supported或partial或missing","quote":"正文中逐字存在的支撑片段；缺失留空"}],"issues":[{"severity":"must_fix或warning","location":"具体标题或段落","problem":"具体缺陷及理由","fix":"可执行修改要求"}]}。每条需求必须出现且只出现一次；严重问题最多30项。不要输出数字评分，不把需求词出现当作需求落实，不作未执行的事实核实或视觉检查声明。`
  });
  return validateReview(readJson(output), plan, draft);
}
