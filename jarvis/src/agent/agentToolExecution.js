import { isDiagramTool, diagramFailureDetails } from './diagramRecovery.js';
import { uid } from './store.js';
import { recordWorkAttempt } from './workLedger.js';
import { validateArgs } from './tools.js';
import { withWebDeadline } from './retrievalBudget.js';
import { throwControl } from '../core/networkRequest.js';
import { errorKind } from '../core/suggest.js';
import { assertArchitectureToolCall } from './architectureStateProtection.js';

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
    executionScope,
    requirementText,
    lookupDeadline,
    lookupControl,
    webTools,
    parallelSafe,
    diagramRecovery,
    allowWebSearch = true
  }
) {
  let newScreenThisStep = false;
  const exec = async (c) => {
    const tool = loader.get(c.name);
    // 执行器分配操作ID，不依赖中转站可能重复的工具ID；同一实际调用的回执可幂等保存。
    const workCallId = uid('op') + ':' + c.id;
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
      if (!allowWebSearch && (webTools.has(c.name) || c.name === 'delegate_task'))
        throw Object.assign(new Error('当前描述/创作无需检索，请直接依据图片和材料回答；用户明确要求外部核实后再联网'), { code: 'SEARCH_NOT_REQUESTED', kind: 'api' });
      // 无状态相同参数最多2次；已声明的状态续接最多4次同参，仍执行自身额度/材料/阶段检查，不把新状态误作旧结果。
      if (times >= 3 && !(times <= 4 && tool.isStatefulResume?.(c.args)) && !/^computer_(look|click|type|key|scroll|drag|screenshot)$/.test(c.name))
        throw Object.assign(new Error(`这个操作（同样的参数）已经做过 ${times - 1} 次了，结果不会变。请换一种方法，或者直接根据已有结果继续。`), isDiagramTool(c.name) ? { code: 'DIAGRAM_DUPLICATE_CALL', kind: 'input' } : {});
      const scopeIssue = review.toolBlock?.(c.name);
      if (scopeIssue) throw Object.assign(new Error(scopeIssue), { code: 'TASK_SCOPE_AFTER_DENIAL', kind: 'input' });
      const bad = c.parseError || validateArgs(tool, c.args);
      if (bad) throw Object.assign(new Error(`${bad}。请检查参数后重新调用。`), isDiagramTool(c.name) ? { code: 'DIAGRAM_INPUT', kind: 'input' } : {});
      await assertArchitectureToolCall(c.name, c.args, { signal });
      // 文件已验过可用（能读回、没报错、之后没改过）且已经核实过一次：不再读，免得“读取 → 核实 → 再核实”绕圈
      if (review.rereadBlocked?.(c.name, c.args)) {
        output = `${c.args.path} 本轮已经核实过：能正常读回，没有报错，之后也没改过。不需要再读，直接把结果交给用户；没查到的内容（如“待查”）在回答里说明即可。`;
        emit({ type: 'tool_end', id: c.id, name: c.name, ok, output, ms: Date.now() - t0 });
        review.record({ name: c.name, args: c.args, ok });
        return { c, ok, output, outImages };
      }
      // 有风险的操作（操作电脑、MCP 工具）先征得用户同意
      if (newScreenThisStep && /^computer_(click|type|key|scroll|drag)$/.test(c.name))
        throw new Error('本步已有新的屏幕截图，请先查看返回的截图，再在下一步决定操作，不能连续盲点或盲输');
      const ask = tool.approval?.(c.args);
      // 没确认：可能是用户点了拒绝，也可能是在服务器上运行、没法弹确认框。别让模型改做别的事来“补”
      if (ask && approve && !(await approve(ask, tool))) throw Object.assign(new Error('这个操作需要用户确认，这次没有得到确认（用户拒绝了，或在服务器上运行没法弹出确认框）。不要改做别的事来代替；在回答里说明没做成，并告诉用户可以自己在界面上操作（比如安装技能：在“技能”页粘贴地址安装）。'), { code: 'NOT_APPROVED' });
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
          executionScope,
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
    const recovery = diagramRecovery?.record(c.name, c.args, failure);
    const diagnostics = diagramFailureDetails(failure);
    if (diagnostics.length) output += '\n定点修复：' + JSON.stringify(diagnostics);
    if (Number.isSafeInteger(failure?.diagnosticCount) && failure.diagnosticCount > 8) output += `\n共有${Math.min(80, failure.diagnosticCount)}条事实未通过，本次仅列前8条；按同一原文核对全部facts，不把未列出的条目当通过。`;
    if (recovery) output += '\n' + recovery.message;
    try {
      await recordWorkAttempt({ tool: c.name, args: c.args, output, ok, sessionId, scope: executionScope, callId: workCallId, failure });
    } catch {
      output += '\n成果记录保存失败；已有文件不受影响，统计可能不完整，不要重新提交生成请求。';
    }
    await checkpoint?.({ type: 'tool_end', id: c.id, name: c.name, ok, output });
    emit({ type: 'tool_end', id: c.id, name: c.name, ok, output, ...(failure && { errorKind: errorKind(failure), code: failure.code }), ms: Date.now() - t0 });
    if (failure?.code !== 'RETRIEVAL_BUDGET') throwControl(failure, signal);
    review.record({ name: c.name, args: c.args, ok, output, code: failure?.code });
    return { c, ok, output, outImages, ...(recovery?.stopped && { recoveryStop: recovery.message }) };
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
      const result = await exec(calls[i]);
      results.push(result);
      if (result.recoveryStop) {
        // 已停止本批执行，仍补齐工具响应，避免用户同时插话后续请求缺tool_call_id。
        for (const pending of calls.slice(i + 1)) results.push({ c: pending, ok: false, output: '本轮图形恢复上限已触发，此操作未执行；' + result.recoveryStop, outImages: [] });
        break;
      }
      i++;
    }
  }
  return results;
}

