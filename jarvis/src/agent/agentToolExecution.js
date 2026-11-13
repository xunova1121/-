import { isDiagramTool, diagramFailureDetails } from './diagramRecovery.js';
import { uid } from './store.js';
import { recordWorkAttempt } from './workLedger.js';
import { rememberStyle } from './styleCheck.js';
import { validateArgs } from './tools.js';
import { withWebDeadline } from './retrievalBudget.js';
import { throwControl } from '../core/networkRequest.js';
import { errorKind } from '../core/suggest.js';
import { assertArchitectureToolCall } from './architectureStateProtection.js';
import { toolFailureScope } from './toolFailureScope.js';
import { recordImageInputRecovery } from './imageInputRecovery.js';
import { isRetrievalStop, RETRIEVAL_FINISHED } from '../../shared/retrievalStop.js';

/** 产出文件、核对数字的本地工具：联网到点后照常可用 */
export const OUTPUT_TOOLS = /^(?:create_document|write_long_document|edit_office_document|check_document|write_file|edit_file|preview|create_diagram|export_diagram|make_poster|create_visual_demo|reconcile_numbers|verify_numbers|time_calc)$/;

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
  let phoneActionThisStep = false;
  const exec = async (c) => {
    const tool = loader.get(c.name);
    // 执行器分配操作ID，不依赖中转站可能重复的工具ID；同一实际调用的回执可幂等保存。
    const workCallId = uid('op') + ':' + c.id;
    const t0 = Date.now();
    emit({ type: 'state', value: 'processing' });
    emit({ type: 'tool_start', id: c.id, name: c.name, args: c.name === 'phone_action' ? { action: c.args?.action, deviceId: c.args?.deviceId } : c.args });
    let output;
    let outImages = [];
    let ok = true;
    let failure = null;
    let lookupRecovery;
    const sig = `${c.name}:${JSON.stringify(c.args ?? {})}`;
    const times = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, times);
    if (seen.size > 128) seen.delete(seen.keys().next().value);
    try {
      // 联网到点只停联网；要出文件（PPT、Word、图）就是文档任务，按深度任务继续，不能连生成也挡掉（用户 2026-11-05：三页 PPT 连试三次都被“联网预算”挡住）
      if (closing && !retrieval.extensive && !webTools.has(c.name) && OUTPUT_TOOLS.test(c.name)) retrieval.upgrade?.('文档');
      if (closing && (!retrieval.extensive || webTools.has(c.name))) throw Object.assign(new Error('联网检索已经结束，请直接整理已有资料回答，不要继续调用工具'), { code: 'RETRIEVAL_BUDGET' });
      if (!tool) throw new Error(`没有名为 ${c.name} 的工具`);
      const cooldownUntil = loader.cooldownUntil?.(c.name);
      if (cooldownUntil) throw Object.assign(new Error(`此工具冷却至北京时间${new Date(cooldownUntil).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}，本次未执行。不要重复调用或换参数重试，改用其他可用工具。`), { code: 'LOOKUP_SOURCE_COOLING', cooldownUntil, tool: c.name });
      if (!allowWebSearch && (webTools.has(c.name) || c.name === 'delegate_task'))
        throw Object.assign(new Error('当前描述/创作无需检索，请直接依据图片和材料回答；用户明确要求外部核实后再联网'), { code: 'SEARCH_NOT_REQUESTED', kind: 'api' });
      // 无状态相同参数最多2次；已声明的状态续接最多4次同参，仍执行自身额度/材料/阶段检查，不把新状态误作旧结果。
      if (times >= 3 && !(times <= 4 && tool.isStatefulResume?.(c.args)) && !/^computer_(look|click|type|key|scroll|drag|screenshot)$/.test(c.name) && !(c.name === 'phone_action' && ['read_screen', 'screenshot'].includes(c.args?.action)))
        throw Object.assign(new Error(`这个操作（同样的参数）已经做过 ${times - 1} 次了，结果不会变。请换一种方法，或者直接根据已有结果继续。`), isDiagramTool(c.name) ? { code: 'DIAGRAM_DUPLICATE_CALL', kind: 'input' } : {});
      const scopeIssue = review.toolBlock?.(c.name);
      if (scopeIssue) throw Object.assign(new Error(scopeIssue), { code: 'TASK_SCOPE_AFTER_DENIAL', kind: 'input' });
      const bad = c.parseError || validateArgs(tool, c.args);
      if (bad) throw Object.assign(new Error(`${bad}。请检查参数后重新调用。`), isDiagramTool(c.name) ? { code: 'DIAGRAM_INPUT', kind: 'input' } : { name: 'ValidationError', code: 'INVALID_TOOL_ARGS', kind: 'input' });
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
      if (c.name === 'phone_action') {
        if (phoneActionThisStep) throw new Error('先查看上一步手机回执，再决定下一步；本次未执行连续盲操作');
        phoneActionThisStep = true;
      }
      const ask = tool.approval?.(c.args);
      // 没确认：可能是用户点了拒绝，也可能是在服务器上运行、没法弹确认框。别让模型改做别的事来“补”
      if (ask && approve && !(await approve(ask, tool))) throw Object.assign(new Error('这个操作需要用户确认，这次没有得到确认（用户拒绝了，或在服务器上运行没法弹出确认框）。不要改做别的事来代替；在回答里说明没做成，并告诉用户可以自己在界面上操作（比如安装技能：在“技能”页粘贴地址安装）。'), { code: 'NOT_APPROVED' });
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      await checkpoint?.({ type: 'tool_start', id: c.id, name: c.name, args: c.args });
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      // 工具可以返回 { text, images }：图片会交给模型“看”（如截屏、工作区里的图片）
      const progress = (text) => emit({ type: 'tool_progress', id: c.id, name: c.name, text });
      const web = webTools.has(c.name);
      // 必须先协调预算再创建工具截止时间，避免深度流程仍被普通查询的3次/60秒限制截断。
      if (c.name === 'deep_research') retrieval.beginResearch?.(c.args?.depth);
      if (web && !retrieval.begin()) throw Object.assign(new Error(retrieval.reason || '联网检索已结束'), { code: 'RETRIEVAL_BUDGET' });
      const run = (s) => {
        // 并行批次等待截止时间包装期间，其它读取可能已触发收尾；执行前再检查一次。
        if (web && retrieval.reason) throw Object.assign(new Error(retrieval.reason), { code: 'RETRIEVAL_BUDGET' });
        return tool.run(c.args, {
          signal: s,
          progress,
          retrieval,
          sessionId,
          executionScope,
          rawRequestText: requirementText,
          requestText: review.report().request,
          checkpoint: async (event) => {
            if (event.type === 'artifact_validation') {
              // 带上上一轮的字号，“再大点”才有基准（见 styleCheck.js）
              const facts = event.validation?.styleFacts;
              review.artifact(facts ? { ...event, previousStyle: await rememberStyle({ sessionId, scope: executionScope, facts }) } : event);
            }
            return checkpoint?.(event);
          }
        });
      };
      const r =
        web && Number.isFinite(retrieval.remaining)
          ? await withWebDeadline(run, {
              signal,
              timeoutMs: Math.min(retrieval.remaining, lookupDeadline && lookupControl ? lookupControl.retrievalRemaining() : Infinity)
            })
          : await run(signal);
      if (r && typeof r === 'object' && 'text' in r) {
        output = String(r.text);
        lookupRecovery = r.lookupRecovery;
        outImages = r.images ?? [];
      } else output = String(r);
      if (outImages.length && /^computer_(look|click|type|key|scroll|drag|screenshot)$/.test(c.name)) newScreenThisStep = true;
    } catch (e) {
      ok = false;
      failure = e;
      lookupRecovery = e.lookupRecovery;
      if (e.code === 'RETRIEVAL_BUDGET') retrieval.close(e.message);
      output = isRetrievalStop(e) ? RETRIEVAL_FINISHED : `错误：${e.message || e}`;
      if (isRetrievalStop(e)) emit({ type: 'diagnostic', phase: 'retrieval_stop', code: e.code, tool: c.name, reason: String(e.message || '').slice(0, 240) });
      if (c.name === 'deep_research' && e.code === 'RETRIEVAL_BUDGET' && e.partialEvidence) output += '\n' + String(e.partialEvidence).slice(0, 1800);
      const scope = toolFailureScope(c.name, e);
      if (scope) output += '\n影响范围：' + scope;
      if (['verify_numbers', 'time_calc'].includes(c.name) && (e.name === 'ValidationError' || /^INVALID_/.test(e.code || ''))) output += '\n请按参数说明改写后重试一次。仍无法计算时必须给用户明确答复；能推算的注明“工具没能计算，以下按常识推算”，列基准和算式，不能称工具已核验，不能只说正在处理。';
    }
    if (failure?.code === 'LOOKUP_SOURCE_COOLING') loader.cool?.(c.name, failure.cooldownUntil);
    for (const attempt of lookupRecovery?.attempts || []) {
      if (attempt.failure === 'cooling') loader.cool?.(attempt.tool, attempt.cooldownUntil);
    }
    const recovery = recordImageInputRecovery(executionScope ?? seen, c.name, c.args, failure) || diagramRecovery?.record(c.name, c.args, failure);
    const diagnostics = diagramFailureDetails(failure);
    if (diagnostics.length) output += '\n定点修复：' + JSON.stringify(diagnostics);
    if (Number.isSafeInteger(failure?.diagnosticCount) && failure.diagnosticCount > 8) output += `\n共有${Math.min(80, failure.diagnosticCount)}条事实未通过，本次仅列前8条；按同一原文核对全部facts，不把未列出的条目当通过。`;
    if (recovery) output += '\n' + recovery.message;
    try {
      await recordWorkAttempt({ tool: c.name, args: c.args, output, ok, sessionId, scope: executionScope, callId: workCallId, failure });
    } catch {
      output += '\n成果记录保存失败；已有文件不受影响，统计可能不完整，不要重新提交生成请求。';
    }
    await checkpoint?.({ type: 'tool_end', id: c.id, name: c.name, ok, output, ...(failure?.code && { code: failure.code }) });
    emit({ type: 'tool_end', id: c.id, name: c.name, ok, output: c.name === 'phone_action' && ok ? '手机已返回操作回执；页面文字和截图仅供本轮核对，不写入进度记录。' : output, ...(failure && { errorKind: errorKind(failure), code: failure.code }), ms: Date.now() - t0 });
    if (failure?.code !== 'RETRIEVAL_BUDGET') throwControl(failure, signal);
    const receipt = review.record({ name: c.name, args: c.args, ok, output, code: failure?.code, lookupRecovery });
    const phoneStopped = c.name === 'phone_action' && /^PHONE_(RESULT_UNKNOWN|STOPPED|CANCELLED|LOCKED|DISABLED|PAUSED|DISCONNECTED|OFFLINE|EXPIRED|SCOPE|AUTH)$/.test(failure?.code || '');
    return { c, ok, output, outImages, ...(receipt?.dataRetrieved !== undefined && { dataRetrieved: receipt.dataRetrieved }), ...(lookupRecovery && { lookupRecovery }), ...(failure && { failure: { code: failure.code, name: failure.name, kind: failure.kind, status: failure.status, cooldownUntil: failure.cooldownUntil, tool: failure.tool } }), ...(recovery?.stopped && { recoveryStop: recovery.message }), ...(phoneStopped && { recoveryStop: output + '\n手机操作已停止，请核对手机上的实际状态后再继续。' }) };
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
        for (const pending of calls.slice(i + 1)) results.push({ c: pending, ok: false, output: (result.c.name === 'phone_action' ? '手机操作已停止，此操作未执行；' : result.c.name === 'inspect_image' ? '本轮原图复核参数纠正上限已触发，此操作未执行；' : '本轮图形恢复上限已触发，此操作未执行；') + result.recoveryStop, outImages: [] });
        break;
      }
      i++;
    }
  }
  return results;
}

