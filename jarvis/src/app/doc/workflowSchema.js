// 输入超限直接说明，不能静默裁掉客户的明确要求。
export const LIMITS = Object.freeze({ task: 16000, material: 48000, draft: 64000, response: 96000, requirements: 40, issues: 30, edits: 24, calls: 8 });

export function workflowError(message, code = 'DOCUMENT_WORKFLOW') {
  return Object.assign(new Error(message), { code, kind: 'document' });
}

export function boundedText(value, limit, label, required = false) {
  const text = String(value ?? '');
  if ((required && !text.trim()) || text.length > limit) {
    throw workflowError(`${label}为空或超过${limit}字，请拆分材料`, 'DOCUMENT_INPUT');
  }
  return text;
}

export function readJson(value) {
  const text = boundedText(value, LIMITS.response, '模型响应', true).trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw workflowError('模型未返回有效的结构化结果，已保留上一阶段', 'DOCUMENT_RESPONSE');
  }
}

export function textList(value, label, max = 12) {
  if (!Array.isArray(value) || value.length > max) throw workflowError(`${label}格式或数量无效`, 'DOCUMENT_RESPONSE');
  return value.map((item) => boundedText(item, 1600, label, true));
}

export function normalizeBrief(value, source) {
  const brief = value.brief;
  const scenarios = value.scenarios;
  if (!brief || !scenarios) throw workflowError('缺少任务底稿或业务推演', 'DOCUMENT_RESPONSE');
  const requirements = textList(brief.requirements, '需求原话', LIMITS.requirements);
  if (!requirements.length || requirements.some((quote) => !source.includes(quote))) {
    throw workflowError('需求必须摘录输入原话，不能虚构或改写为新要求', 'DOCUMENT_REQUIREMENTS');
  }
  for (const key of ['normal', 'exceptions', 'settlement', 'acceptance', 'structure']) {
    if (!scenarios[key]?.length) throw workflowError('业务推演缺少必要场景', 'DOCUMENT_RESPONSE');
  }
  return {
    brief: {
      purpose: boundedText(brief.purpose, 1600, '用途与读者', true),
      requirements: [...new Set(requirements)].map((quote, index) => ({ id: `REQ-${index + 1}`, quote })),
      relationships: textList(brief.relationships, '业务关系'),
      facts: textList(brief.facts, '用户事实'),
      assumptions: textList(brief.assumptions, '建议及假设'),
      unknowns: textList(brief.unknowns, '未知事项及影响'),
      direction: boundedText(brief.direction, 2400, '建议方向', true)
    },
    scenarios: {
      normal: textList(scenarios.normal, '正常流'),
      exceptions: textList(scenarios.exceptions, '异常流'),
      settlement: textList(scenarios.settlement, '结算或核算流'),
      acceptance: textList(scenarios.acceptance, '验收场景'),
      structure: textList(scenarios.structure, '推演后的结构')
    }
  };
}
