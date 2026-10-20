import { boundedText, LIMITS, readJson, workflowError } from './workflowSchema.js';
import { WRITING_RULES } from './workflowPolicy.js';

export function validateReview(value, plan, draft) {
  if (!Array.isArray(value.issues) || value.issues.length > LIMITS.issues || !Array.isArray(value.coverage)) {
    throw workflowError('内容审查格式无效', 'DOCUMENT_RESPONSE');
  }
  const known = new Set(plan.brief.requirements.map(item => item.id));
  const seen = new Set();
  const coverage = value.coverage.map(item => {
    if (!known.has(item.id) || seen.has(item.id) || !['supported', 'partial', 'missing'].includes(item.result)) {
      throw workflowError('审查需求编号缺失、重复或无效', 'DOCUMENT_RESPONSE');
    }
    seen.add(item.id);
    const quote = boundedText(item.quote, 1600, '正文证据');
    return { id: item.id, result: item.result === 'supported' && (!quote.trim() || !draft.includes(quote)) ? 'missing' : item.result, quote };
  });
  if (seen.size !== known.size) throw workflowError('审查没有覆盖全部需求', 'DOCUMENT_RESPONSE');
  if (value.issues.some(item => !['must_fix', 'warning'].includes(item.severity))) throw workflowError('审查问题严重程度无效', 'DOCUMENT_RESPONSE');
  const issues = value.issues.map((item, index) => ({
    id: `ISSUE-${index + 1}`,
    severity: item.severity === 'must_fix' ? 'must_fix' : 'warning',
    location: boundedText(item.location, 300, '问题位置', true),
    problem: boundedText(item.problem, 1600, '问题说明', true),
    fix: boundedText(item.fix, 1600, '修复要求', true)
  }));
  for (const item of coverage.filter(item => item.result !== 'supported')) {
    issues.push({ id: `COVERAGE-${item.id}`, severity: 'must_fix', location: item.id, problem: '明确需求未充分落实，不能靠关键词声称通过', fix: '恢复该要求，写明推荐方案及实施条件' });
  }
  return { coverage, issues, outcome: issues.some(item => item.severity === 'must_fix') ? 'needs_revision' : 'model_reviewed' };
}

export async function reviewDocument(input, plan, draft, ask, stage = 'reviewing') {
  const output = await ask(stage, {
    system: `你是严格的文档内容审查员，不因文风正式而认可方案。${WRITING_RULES}只输出JSON。`,
    prompt: `核对完整原始要求，不只核对底稿。检查需求遗漏或降级、业务断点、无依据的数字、事实与建议混淆、重复空话、验收场景。\n原始要求：${input.task}\n材料：${input.material}\n底稿与推演：${JSON.stringify(plan)}\n正文：\n${draft}\n输出{"coverage":[{"id":"REQ-1","result":"supported或partial或missing","quote":"正文中逐字存在的支撑片段；缺失留空"}],"issues":[{"severity":"must_fix或warning","location":"具体标题或段落","problem":"具体缺陷及理由","fix":"可执行修改要求"}]}。每条需求必须出现且只出现一次；严重问题最多30项。不要输出数字评分，不把需求词出现当作需求落实，不作未执行的事实核实或视觉检查声明。`
  });
  return validateReview(readJson(output), plan, draft);
}
