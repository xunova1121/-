import { validateArgs } from './tools.js';
import { withWebDeadline } from './retrievalBudget.js';
import { throwControl } from '../core/networkRequest.js';
import { errorKind } from '../core/suggest.js';

/** 原顺序执行副作用，仅将连续的只读调用并行；检查点先于操作落盘。 */
export async function executeToolCalls(
  calls,
  {
    loader,
    emit,
    seen,
    closing,
    retrieval,
    approve,
    signal,
    checkpoint,
    review,
    sessionId,
    requirementText,
    lookupDeadline,
    lookupControl,
    webTools,
    parallelSafe
  }
) {
  let newScreenThisStep = false;
  const exec = async (c) => {
    const tool = loader.get(c.name);
    const t0 = Date.now();
    emit({ type: 'state', value: 'processing' });
    emit({ type: 'tool_start', id: c.id, name: c.name, args: c.args });
    let output;
    let outImages = [];
    let ok = true;
    let failure = null;
    const sig = `${c.name}:${JSON.stringify(c.args ?? {})}`;
    const times = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, times);
    if (seen.size > 128) seen.delete(seen.keys().next().value);
    try {
      if (closing && (!retrieval.extensive || webTools.has(c.name))) throw new Error('联网检索已经结束，请直接整理已有资料回答，不要继续调用工具');
      if (!tool) throw new Error(`没有名为 ${c.name} 的工具`);
      // 一模一样的调用已经做过两次：结果不会变，不再执行，让模型换思路
      if (times >= 3 && !/^computer_(look|click|type|key|scroll|drag|screenshot)$/.test(c.name))
        throw new Error(`这个操作（同样的参数）已经做过 ${times - 1} 次了，结果不会变。请换一种方法，或者直接根据已有结果继续。`);
      const bad = c.parseError || validateArgs(tool, c.args);
      if (bad) throw new Error(`${bad}。请检查参数后重新调用。`);
      // 有风险的操作（操作电脑、MCP 工具）先征得用户同意
      if (newScreenThisStep && /^computer_(click|type|key|scroll|drag)$/.test(c.name))
        throw new Error('本步已有新的屏幕截图，请先查看返回的截图，再在下一步决定操作，不能连续盲点或盲输');
      const ask = tool.approval?.(c.args);
      if (ask && approve && !(await approve(ask, tool))) throw new Error('用户拒绝了这个操作。请换一种方式，或询问用户的意见。');
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      await checkpoint?.({ type: 'tool_start', id: c.id, name: c.name, args: c.args });
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      // 工具可以返回 { text, images }：图片会交给模型“看”（如截屏、工作区里的图片）
      const progress = (text) => emit({ type: 'tool_progress', id: c.id, name: c.name, text });
      const web = webTools.has(c.name);
      if (web && !retrieval.begin()) throw new Error(retrieval.note);
      const run = (s) =>
        tool.run(c.args, {
          signal: s,
          progress,
          retrieval,
          sessionId,
          rawRequestText: requirementText,
          requestText: review.report().request,
          checkpoint: (event) => {
            if (event.type === 'artifact_validation') review.artifact(event);
            return checkpoint?.(event);
          }
        });
      const r =
        web && Number.isFinite(retrieval.remaining)
          ? await withWebDeadline(run, {
              signal,
              timeoutMs: Math.min(retrieval.remaining, lookupDeadline && lookupControl ? lookupControl.retrievalRemaining() : Infinity)
            })
          : await run(signal);
      if (r && typeof r === 'object' && 'text' in r) {
        output = String(r.text);
        outImages = r.images ?? [];
      } else output = String(r);
      if (outImages.length && /^computer_(look|click|type|key|scroll|drag|screenshot)$/.test(c.name)) newScreenThisStep = true;
    } catch (e) {
      ok = false;
      failure = e;
      if (e.code === 'RETRIEVAL_BUDGET') retrieval.close(e.message);
      output = `错误：${e.message || e}`;
    }
    await checkpoint?.({ type: 'tool_end', id: c.id, name: c.name, ok, output });
    emit({ type: 'tool_end', id: c.id, name: c.name, ok, output, ...(failure && { errorKind: errorKind(failure), code: failure.code }), ms: Date.now() - t0 });
    if (failure?.code !== 'RETRIEVAL_BUDGET') throwControl(failure, signal);
    review.record({ name: c.name, args: c.args, ok });
    return { c, ok, output, outImages };
  };
  // 互不影响的只读调用（搜索、读文件、读网页……）同时做；其余按顺序一个个做
  const results = [];
  for (let i = 0; i < calls.length;) {
    let j = i;
    while (j < calls.length && parallelSafe.has(calls[j].name)) j++;
    if (j - i > 1) {
      results.push(...(await Promise.all(calls.slice(i, j).map(exec))));
      i = j;
    } else {
      results.push(await exec(calls[i]));
      i++;
    }
  }
  return results;
}
