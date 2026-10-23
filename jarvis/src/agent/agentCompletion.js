import { reviewOutcome } from './reviewOutcome.js';
import * as memory from './memory.js';
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
  lookupDeadline = false
}) {
  // 普通问题查到时限或次数上限：不说“检索已停止”，先给已有的，再问要不要再查
  //   模型已用现有资料答完（检索因时限、次数收住了）也问一句，方便接着查
  const quickStop = lookupDeadline && (retrievalStopped || Boolean(retrieval.reason));
  if (step >= limit || retrievalStopped || quickStop) {
    const note = quickStop
      ? `\n\n（普通问题我先回答到这里，上面是已经查到的；还没有确切结果、没核实的部分别当结论。${MORE_TIME_ASK}。）`
      : retrieval.reason
      ? `\n\n（本轮检索已停止：${retrieval.reason}。目前还没有确切结果；已取得的信息见上文，未核实的部分不能当作结论。）`
      : stuck
        ? `\n\n（最近的步骤大多失败，看起来卡住了，先停在这里。上面是目前的进展；换个说法或给我更多信息，我再接着做。）`
        : `\n\n（这个任务已经连续做了 ${step} 步，先停在这里，上面是目前的进展。）`;
    finalText += note;
    emit({ type: 'text', delta: note });
  }
  const acceptance = { ...review.report(), ...reviewOutcome(review.report(), { interrupted: retrievalStopped && !quickStop, nativeSearchCalls }) };
  const unmet = review.guidance();
  if (acceptance.notice && !light) {
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
