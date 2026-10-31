import { missingDeliveries } from './finalDelivery.js';
import { reviewOutcome } from './reviewOutcome.js';
import * as memory from './memory.js';
import { lookupIntent } from './lookup/intent.js';
import { lookupClosingNote } from './lookup/answer.js';
import { MORE_TIME_ASK } from './lookupDeadline.js';

/** 保留已有验收、任务留存与最终事件顺序；不额外调用模型。 */
export async function finishAgentRun({
  step,
  limit,
  retrievalStopped,
  retrieval,
  stuck,
  review,
  nativeSearchCalls,
  light,
  signal,
  quiet,
  toolCount,
  lastToolOk,
  failCount,
  userText,
  finalText,
  emit,
  lookupFallback = '',
  lookupDeadline = false,
  autoExtend = false
}) {
  const query = lookupIntent(userText);
  const unifiedQuery = query.lookup && query.kind !== 'meta' && (query.sure || retrieval.active || nativeSearchCalls > 0);
  if (lookupFallback && (!finalText.trim() || finalText.trim().length < 200 && /没有可靠结果|没有确切结果|未能生成符合|未找到可靠|只找到候选|无法提供|没有查到/.test(finalText))) {
    const delta = (finalText.trim() ? '\n\n' : '') + lookupFallback;
    finalText += delta;
    emit({ type: 'text', delta });
  }
  // 普通问题一分钟内一个字都没答出来：不交白卷，交回去自动多查一会儿（见 lookupDeadline.js）
  if (autoExtend && lookupDeadline && (retrievalStopped || retrieval.reason) && !finalText.trim() && !signal?.aborted) return { text: '', steps: step + 1, toolCalls: toolCount, needsMoreTime: true };
  // 普通问题查到时限或次数上限：不说“检索已停止”，先给已有的，再问要不要再查
  //   模型已用现有资料答完（检索因时限、次数收住了）也问一句，方便接着查
  const quickStop = lookupDeadline && (retrievalStopped || Boolean(retrieval.reason));
  if (!unifiedQuery && (step >= limit || retrievalStopped || quickStop)) {
    // 一个字都没写出来（比如资料都没核实到）：别只剩一句“回答到这里”
    const note = quickStop && !finalText.trim()
      ? `这次一分钟内还没有确切结果（查到的资料都没能核实），先不乱说。${MORE_TIME_ASK}。`
      : quickStop && finalText.trim().length >= 300
      ? `\n\n（以上是一分钟内查到的。${MORE_TIME_ASK}。）`
      : quickStop
      ? `\n\n（普通问题我先回答到这里，上面是已经查到的；还没有确切结果、没核实的部分别当结论。${MORE_TIME_ASK}。）`
      : retrieval.reason
      ? `\n\n（本轮检索已停止：${retrieval.reason}。目前还没有确切结果；已取得的信息见上文，未核实的部分不能当作结论。）`
      : stuck
        ? `\n\n（最近的步骤大多失败，看起来卡住了，先停在这里。上面是目前的进展；换个说法或给我更多信息，我再接着做。）`
        : `\n\n（这个任务已经连续做了 ${step} 步，先停在这里，上面是目前的进展。）`;
    finalText += note;
    emit({ type: 'text', delta: note });
  }
  // 什么都没写出来（模型交了空白）：不留白，说清楚
  if (!finalText.trim()) {
    const blank = retrieval.reason
      ? '这次没查到能核实的确切结果（查到的资料都没能核实），先不乱说。可以换个问法，或者告诉我从哪儿查。'
      : '（这一轮模型没有写出回答，可以点“重新生成”再试一次。）';
    finalText = blank;
    emit({ type: 'text', delta: blank });
  }
  const acceptance = { ...review.report(), ...reviewOutcome(review.report(), { interrupted: retrievalStopped && !quickStop, nativeSearchCalls, answer: finalText }) };
  const delivery = missingDeliveries(finalText, acceptance);
  if (delivery) {
    finalText += delivery;
    emit({ type: 'text', delta: delivery });
  }
  const unmet = review.guidance();
  const alreadyExplained = acceptance.warnings?.length && acceptance.warnings.every(warning => finalText.includes(warning));
  if (unifiedQuery && !light) {
    const note = lookupClosingNote({ answer: finalText, quickStop, interrupted: retrievalStopped || step >= limit, warnings: acceptance.warnings, reason: retrieval.reason });
    finalText += note;
    if (note) emit({ type: 'text', delta: note });
  } else if (acceptance.notice && !light && !alreadyExplained) {
    finalText += acceptance.notice;
    emit({ type: 'text', delta: acceptance.notice });
  }
  emit({ type: 'task_review', review: { ...acceptance, request: undefined } });
  // 只有正常收尾、且最后一次工具调用成功，才记为“完成任务”（计入进化等级）；否则记为未完成，便于之后复盘
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  const hitLimit = step >= limit || retrievalStopped;
  if (quiet) {
    /* 分身做的子任务不单独计入任务记录 */
  } else if (toolCount && !hitLimit && lastToolOk && failCount === 0 && !unmet) {
    await memory.noteTask(`完成任务：${userText.slice(0, 40)}（调用工具 ${toolCount} 次${failCount ? `，其中 ${failCount} 次失败后已改正` : ''}）`);
  } else if (toolCount) {
    await memory.noteIssue(
      `未完成任务：${userText.slice(0, 40)}（${hitLimit ? '达到最大步数' : '存在失败步骤，需要核实结果'}；工具 ${toolCount} 次，失败 ${failCount} 次）`
    );
  }
  emit({ type: 'state', value: 'done' });
  return { text: finalText.trim(), steps: step + 1, toolCalls: toolCount, review: acceptance };
}
