// 输入超限直接说明，不能静默裁掉客户的明确要求。
export const LIMITS = Object.freeze({ task: 16000, material: 48000, draft: 64000, response: 96000, requirements: 40, issues: 30, edits: 24, calls: 20 });

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

/**
 * 模型给的列表：多了截掉、太长截短、空的去掉。
 * 以前这里格式稍有不对就整篇报错，代理换着法子重来，一篇文档要折腾半小时；现在只丢有问题的那一条。
 */
export function textList(value, label, max = 12) {
  if (value != null && !Array.isArray(value)) value = [value];
  return (value || [])
    .map((item) =>
      String(item ?? '')
        .trim()
        .slice(0, 1600)
    )
    .filter(Boolean)
    .slice(0, max);
}

/** 把用户原话按句子切开（每句都是原话），模型摘录的需求全对不上原文时用 */
export function sentencesOf(source, max = LIMITS.requirements) {
  return String(source)
    .split(/(?<=[。；！？\n])/)
    .map((x) => x.trim().replace(/[。；！？]$/, ''))
    .filter((x) => x.length >= 4)
    .map((x) => x.slice(0, 200))
    .slice(0, max);
}

export function normalizeBrief(value, source) {
  const brief = value.brief || {};
  const scenarios = value.scenarios || {};
  if (!value.brief && !value.scenarios) throw workflowError('缺少任务底稿或业务推演', 'DOCUMENT_RESPONSE');
  // 需求只认用户原话：模型改写、虚构的那条丢掉（不让它冒充用户要求），其余照常；一条都对不上就按原话分句
  const quoted = textList(brief.requirements, '需求原话', LIMITS.requirements).filter((quote) => source.includes(quote));
  const requirements = quoted.length ? quoted : sentencesOf(source);
  if (!requirements.length) throw workflowError('没能从要求里找到明确需求，请把要求写具体', 'DOCUMENT_REQUIREMENTS');
  // 推演缺的部分标出来交给起草和审查补，不因此整篇失败
  const gaps = ['normal', 'exceptions', 'settlement', 'acceptance', 'structure'].filter((key) => !textList(scenarios[key], key).length);
  const scene = (key, label) => {
    const list = textList(scenarios[key], label);
    return list.length ? list : ['（推演没有给出这一项：起草时按文种补上，不适用的说明理由）'];
  };
  return {
    gaps,
    brief: {
      purpose: String(brief.purpose || '（未说明，按原始要求判断）').slice(0, 1600),
      requirements: [...new Set(requirements)].map((quote, index) => ({ id: `REQ-${index + 1}`, quote })),
      relationships: textList(brief.relationships, '业务关系'),
      facts: textList(brief.facts, '用户事实'),
      assumptions: textList(brief.assumptions, '建议及假设'),
      unknowns: textList(brief.unknowns, '未知事项及影响'),
      direction: String(brief.direction || '（未给出，按原始要求和推演确定）').slice(0, 2400)
    },
    scenarios: {
      normal: scene('normal', '正常流'),
      exceptions: scene('exceptions', '异常流'),
      settlement: scene('settlement', '结算或核算流'),
      acceptance: scene('acceptance', '验收场景'),
      structure: textList(scenarios.structure, '推演后的结构')
    }
  };
}
