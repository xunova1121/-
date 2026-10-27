import * as sessions from './sessions.js';
import { summaryForTurn } from './summaryEvidence.js';
import { collectRequirements, requirementsBlock } from './taskRequirements.js';
import { createTurnArchive } from './turnContext.js';

/** 准备本轮上下文；构建器由入口注入，避免循环导入。 */
export async function prepareAgentContext({
  userText,
  priorMessages,
  context,
  sessionId,
  summary,
  light,
  requirements,
  depth,
  requirementText,
  emit,
  buildContext
}) {
  const tCtx = Date.now();
  const ctx =
    context ??
    (await buildContext(userText, {
      sessionId,
      history: priorMessages,
      turns: priorMessages.filter((m) => m.role === 'user').length,
      summary: summaryForTurn(summary, [...priorMessages, { role: 'user', content: userText }]),
      light
    }));
  // 界面传完整原文账本；非界面入口可从会话取回，最后才退回本轮可见消息。
  const saved = !requirements && sessionId && depth === 0 ? await sessions.get(sessionId).catch(() => null) : null;
  const record =
    requirements ??
    (saved ? collectRequirements(saved.messages, saved.requirements) : collectRequirements([...priorMessages, { role: 'user', content: userText }]));
  const requirementContext = requirementsBlock(record, userText, { history: priorMessages, currentText: requirementText });
  const archive = createTurnArchive(); // 有内存上限、只保留本轮文本，不复制截图
  emit({ type: 'timing', contextMs: Date.now() - tCtx });
  if (ctx.kbHits?.length) emit({ type: 'sources', items: ctx.kbHits.map((h) => h.name) });
  return { ctx, record, requirementContext, archive };
}
