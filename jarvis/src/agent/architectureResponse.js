import * as ws from './workspace.js';
import { architectureReferences } from './architectureReferences.js';
import { WORKFLOW_CONTENT_PROMPT } from './architectureWorkflowInput.js';
import { withWebDeadline } from './retrievalBudget.js';
import { throwControl } from '../core/networkRequest.js';
const invalid = (message, code = 'ARCHITECTURE_CONTENT_FORMAT') =>
  Object.assign(new Error(message), {
    code,
    kind: 'input',
    diagnostics: [
      {
        stage: code === 'ARCHITECTURE_WORKFLOW' ? 'content' : 'format',
        field: 'response',
        action: '查看任务保存的原始回复和停止类型；只续当前jobPath，格式与内容使用同一个3次总额度，不补造缺失数据。'
      }
    ]
  });
/** 最多3次模型总尝试；原始可见回复逐次存工作区（最多8万字符/份），状态只存路径与停止类型。 */
export async function architectureContentResponse(ctx, state, jobPath, materials, save, execution = {}) {
  throwControl(null, execution.signal);
  if (state.attempts >= 3) throw invalid('内容整理已达3次上限，保留原始回复与任务，不继续收费重试', 'ARCHITECTURE_WORKFLOW');
  const llm = ctx.reasonLlm || ctx.llm;
  if (!llm) throw invalid('未配置业务理解模型');
  let previousContent = null,
    pendingText = null;
  if (state.formatPending && state.responsePath) {
    const blob = await ws.readBlob(state.responsePath);
    if (blob.size > 320000) throw invalid('待修格式回复超限');
    pendingText = await blob.text();
  } else if (state.contentPath) {
    const blob = await ws.readBlob(state.contentPath);
    if (blob.size > 320000) throw invalid('历史业务内容超限');
    previousContent = JSON.parse(await blob.text());
  }
  let completeDiagnostics = null;
  if (pendingText === null && state.lastError?.issuesPath) {
    if (!/^文档检查\/架构(?:诊断\/[\w-]+\.issues-\d+|底稿\/[\w-]+\.review)\.json$/.test(state.lastError.issuesPath))
      throw invalid('架构诊断路径无效，不能读取其他文件作纠错指令');
    const blob = await ws.readBlob(state.lastError.issuesPath);
    if (blob.size > 1000000) throw invalid('架构诊断超过1MB');
    completeDiagnostics = JSON.parse(await blob.text());
  }
  const prompt = JSON.stringify(
    pendingText === null
      ? { request: state.request, materials: architectureReferences(materials), correction: state.lastError, completeDiagnostics, previousContent }
      : { invalidJson: pendingText, error: state.lastError }
  );
  throwControl(null, execution.signal);
  state.attempts++;
  await save();
  execution.retrieval?.consume('model');
  execution.progress?.(pendingText === null ? '正在根据编号原文整理架构内容…' : '正在修复已保存回复的JSON格式，不重新读取材料或重做业务设计…');
  const response = await withWebDeadline(
    (signal) =>
      llm({
        system:
          pendingText === null
            ? WORKFLOW_CONTENT_PROMPT
            : '只修复给定JSON的语法，保持对象、数量、关系、材料/段落编号及文字内容不变；不得新增事实、删除条目、补造缺失内容。无法恢复截断内容时不要猜。只返回合法JSON，不带代码块或解释。',
        prompt,
        signal,
        returnDetails: true,
        nativeSearch: false,
        allowWebSearch: false,
        maxWebSearches: 0,
        maxRetries: 0,
        maxTransientRetries: 0,
        maxPartialRetries: 0
      }),
    { signal: execution.signal, timeoutMs: 120000 }
  );
  const text = typeof response === 'string' ? response : response?.text;
  const stop = typeof response?.stop === 'string' ? response.stop.slice(0, 80) : 'unknown';
  if (typeof text !== 'string') throw invalid('业务模型未返回可见文本');
  const captured = text.slice(0, 80000),
    captureTruncated = text.length > 80000;
  const base = jobPath.replace('架构任务/', '架构回复/').replace(/\.json$/, '') + '.response-' + state.attempts;
  const responsePath = base + '.txt',
    metaPath = base + '.meta.json';
  await ws.write(responsePath, captured);
  await ws.write(
    metaPath,
    JSON.stringify({
      attempt: state.attempts,
      stop,
      chars: text.length,
      capturedChars: captured.length,
      captureTruncated,
      mode: pendingText === null ? 'content' : 'json_repair'
    })
  );
  state.responsePath = responsePath;
  state.responseMetaPath = metaPath;
  state.responseStop = stop;
  state.formatPending = false;
  await save();
  for (const path of [responsePath, metaPath]) await execution.checkpoint?.({ type: 'file', path });
  if (captureTruncated || ['max_tokens', 'length'].includes(stop))
    throw invalid('业务回复超限或服务商报告输出截断；原始回复已保留，不能补括号冒充完整', 'ARCHITECTURE_CONTENT_TRUNCATED');
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
  } catch (error) {
    throwControl(error, execution.signal);
    if (!(error instanceof SyntaxError)) throw error;
    state.formatPending = true;
    await save();
    throw invalid('业务回复JSON语法无效；已保存原始回复和停止类型，下一次仅修格式，不重做整份业务内容');
  }
}
