import { estimateTokens } from './contextBudget.js';
import { compactToolResults } from './turnContext.js';

/** 普通查询只裁发送副本，持久历史、核验账本与本轮执行数据原样保留。 */
export function projectLookupMessages(messages, { historyLength = 0, archive, enabled = false, query = '' } = {}) {
  if (!enabled) return { messages, droppedMessages: 0, savedChars: 0 };
  const old = messages.slice(0, historyLength);
  // 某些恢复入口仅带历史工具快照，没有原assistant调用；不能裁掉其原文或制造新的不配对消息。
  const calls = new Set(old.flatMap(message => (message.toolCalls || []).map(call => call.id)));
  if (old.some(message => message.role === 'tool' && !calls.has(message.toolCallId))) return { messages, droppedMessages: 0, savedChars: 0 };
  const turns = [];
  for (const message of old) {
    if (!turns.length || message.role === 'user') turns.push([]);
    turns.at(-1).push(message);
  }
  const textSize = list => list.reduce((sum, message) => sum + String(message.content || '').length, 0);
  const tokenSize = groups => groups.flat().reduce((sum, message) => sum + estimateTokens(message.content || ''), 0);
  // 按完整用户轮次移除，不能留下孤立tool结果或拆断同批工具调用。
  while (turns.length > 5 || turns.length > 1 && tokenSize(turns) > 8000) turns.shift();
  const kept = turns.flat();
  const projected = [...kept, ...messages.slice(historyLength)].map(message => ({ ...message }));
  for (const message of projected) {
    if (message.role !== 'tool' || String(message.content || '').length <= 2000) continue;
    // 明确请求的原文分段不再包成新编号；否则模型将永远读不到原文。
    if (['read_tool_result', 'read_evidence', 'read_task_requirements'].includes(message.name)) continue;
    compactToolResults([message], { budget: 0, keep: 0, short: 1400, archive, preserveEvidence: true, query });
  }
  const droppedMessages = old.length - kept.length;
  if (droppedMessages && projected.length) {
    const current = projected[kept.length];
    if (current?.role === 'user') current.content += '\n（系统上下文说明：发送副本只带最近相关对话，较早记录未发送；缺少指代依据时查历史，不凭空补全。）';
  }
  return { messages: projected, droppedMessages, savedChars: Math.max(0, textSize(messages) - textSize(projected)) };
}

/** 来源丰富的结构化新闻/赛程保留整批条目；其余长回执存本轮原件，附编号按需读取。 */
export function compactLookupReceipt(found, archive) {
  if (['get_today_news', 'get_sports_scores'].includes(found.tool) || String(found.output || '').length <= 2000) return found;
  const message = { role: 'tool', name: found.tool, content: found.output };
  compactToolResults([message], { budget: 0, keep: 0, short: 1400, archive, preserveEvidence: true, query: found.query || '' });
  return { ...found, output: message.content };
}
