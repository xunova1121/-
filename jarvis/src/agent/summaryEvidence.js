/** 这里只保存有界的用户陈述索引，不保存网页、工具正文或助手推断。 */
export function userEvidence(previous = [], messages = []) {
  const records = [...previous];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = String(message.content || '').trim();
    if (!/(?:成本|封单|孕周|预产期|叫|住在|记住|不对|不是|说错|查到|查过|不用|取消)/.test(text)) continue;
    const quote = text.slice(0, 160);
    const kind = /不对|说错|不是|不用|取消|查过|查到了/.test(text) ? 'correction' : 'user_statement';
    if (!records.some(record => record.ts === message.ts && record.quote === quote)) {
      records.push({kind, quote, ts:message.ts || 0});
    }
  }
  // 摘要最多保留八条短原话，完整原文仍由会话/需求账本持有。
  return records.slice(-8);
}

export function hasCorrection(messages = []) {
  return messages.some(message => message.role === 'user' && /(?:你.*(?:不是.*查到|查过|说错)|(?:价格|数据|数字|结论|刚才|之前).{0,20}(?:不对|不可信|错了)|不用(?:写|做)|取消)/.test(String(message.content || '')));
}

export function summaryForTurn(summary, messages = []) {
  if (!summary) return summary;
  if (!hasCorrection(messages.slice(-8))) return summary;
  return {...summary, review:true, facts:userEvidence(summary.facts, messages.slice(-8))};
}

export function evidenceBlock(records = []) {
  return records.length ? '\n用户短原话索引（保留原措辞，时间冲突先核对，不把提问当已确认事实）：\n' + records.map(record => `- [${record.kind}; ${record.ts}] ${record.quote}`).join('\n') : '';
}
