import { createTaskPhases } from './taskPhases.js';
/** 只累计数字，不保存问题、网址、密钥、模型正文。工具并行时间取区间并集。 */
export function createTaskTiming(createdAt, now = Date.now) {
  const phases = createTaskPhases();
  let startedAt = null, endedAt = null, firstTextAt = null, contextMs = 0;
  let modelMs = 0, toolMs = 0, modelOpen = null, toolOpen = null;
  let modelCalls = 0, toolCalls = 0, failedTools = 0, retries = 0, fallbacks = 0, nativeSearchCalls = 0;
  let inputChars = 0, inputCharSamples = 0, helperModelCalls = 0, helperInputChars = 0;
  let inputTextChars = 0, inputTextSamples = 0, systemChars = 0, toolSchemaChars = 0;
  let delegateTasks = 0;
  const activeTools = new Set();
  // 每次模型调用的明细（只记用途、型号、耗时、Token，不记内容）：评测看哪一步多、哪一步慢
  const calls = [], openCalls = new Map(), rewrites = {};
  let backgroundModelCalls = 0, mainSeq = 0;
  const openCall = (key, row, t) => { if (calls.length < 200) { const call = { n: calls.length + 1, ...row, ms: null, usage: null }; calls.push(call); openCalls.set(key, { call, at: t }); } };
  const closeCall = (key, t, e) => {
    const open = openCalls.get(key);
    if (!open) return;
    openCalls.delete(key);
    open.call.ms = elapsed(open.at, t);
    if (e.usage) open.call.usage = { input: e.usage.input ?? null, output: e.usage.output ?? null, cached: e.usage.cached ?? null };
    if (e.resultKind) open.call.result = String(e.resultKind).slice(0, 20);
    if (e.ok === false) open.call.result = 'error';
  };
  // 每种工具各用了几次、多久、失败几次（只记工具名和数字）：评测报告里看慢在哪一步
  const byTool = {};
  const toolStarted = new Map();
  const elapsed = (a, b) => a == null || b == null ? null : Math.max(0, b - a);
  return {
    start() { if (startedAt == null && endedAt == null) startedAt = now(); },
    event(e) {
      if (endedAt != null) return;
      const t = now();
      phases.event(e, t);
      if (e.type === 'diagnostic' && ['model_start', 'helper_start'].includes(e.phase) && Number.isFinite(e.inputTextChars)) {
        inputTextChars += e.inputTextChars;
        inputTextSamples++;
        systemChars += e.systemChars || 0;
        toolSchemaChars += e.toolSchemaChars || 0;
      }
      if (e.type === 'diagnostic' && e.phase === 'helper_start') {
        helperModelCalls++;
        helperInputChars += Math.max(0, e.inputChars || 0);
        openCall('helper:' + e.id, { kind: 'helper', purpose: String(e.purpose || 'helper').slice(0, 40), model: String(e.model || '').slice(0, 120) }, t);
      }
      if (e.type === 'diagnostic' && e.phase === 'background_start') {
        backgroundModelCalls++;
        openCall('bg:' + e.id, { kind: 'background', purpose: String(e.purpose || 'background').slice(0, 40), model: String(e.model || '').slice(0, 120) }, t);
      }
      if (e.type === 'diagnostic' && e.phase === 'helper_end') closeCall('helper:' + e.id, t, e);
      if (e.type === 'diagnostic' && e.phase === 'background_end') closeCall('bg:' + e.id, t, e);
      if (e.type === 'diagnostic' && e.phase === 'hedge_start') openCall('hedge', { kind: 'hedge', purpose: 'hedge', model: String(e.model || '').slice(0, 120) }, t);
      if (e.type === 'diagnostic' && e.phase === 'answer_rewrite') for (const rule of (e.rules || []).slice(0, 8)) rewrites[String(rule).slice(0, 40)] = (rewrites[String(rule).slice(0, 40)] || 0) + 1;
      if (e.type === 'text' && String(e.delta ?? '').trim() && firstTextAt == null) firstTextAt = t;
      if (e.type === 'timing' && Number.isFinite(e.contextMs)) contextMs += Math.max(0, e.contextMs);
      if (e.type === 'diagnostic' && e.phase === 'model_start') {
        if (Number.isFinite(e.inputChars) && e.inputChars >= 0) {
          inputChars += e.inputChars;
          inputCharSamples++;
        }
        modelCalls++;
        if (modelOpen == null) modelOpen = t;
        openCall('main', { kind: 'main', purpose: String(e.purpose || 'answer').slice(0, 40), model: String(e.model || '').slice(0, 120), main: ++mainSeq }, t);
      }
      if (e.type === 'diagnostic' && e.phase === 'model_end') { closeCall('main', t, e); closeCall('hedge', t, {}); }
      if (e.type === 'diagnostic' && e.phase === 'model_end' && modelOpen != null) { modelMs += elapsed(modelOpen, t); modelOpen = null; }
      if (e.type === 'tool_start' && !activeTools.has(e.id)) {
        if (e.name === 'delegate_task') delegateTasks++;
        toolCalls++; activeTools.add(e.id); if (toolOpen == null) toolOpen = t;
        if (e.name && Object.keys(byTool).length < 60) toolStarted.set(e.id, { name: String(e.name).slice(0, 60), at: t });
      }
      if (e.type === 'tool_end' && activeTools.delete(e.id)) {
        if (e.ok === false) failedTools++;
        const began = toolStarted.get(e.id);
        if (began) {
          toolStarted.delete(e.id);
          const row = (byTool[began.name] ??= { calls: 0, ms: 0, failed: 0 });
          row.calls++; row.ms += elapsed(began.at, t); if (e.ok === false) row.failed++;
        }
        if (!activeTools.size) { toolMs += elapsed(toolOpen, t); toolOpen = null; }
      }
      if (e.type === 'retry') retries++;
      if (e.type === 'fallback') fallbacks++;
      if (e.type === 'server_tool' && /search/.test(e.name || '')) nativeSearchCalls++;
    },
    finish() { if (endedAt == null) endedAt = now(); return this.snapshot(); },
    snapshot() {
      const t = endedAt ?? now();
      return {
        version: 1,
        ...phases.snapshot(t),
        measurementVersion: 2,
        callDetailVersion: 1, // 有 calls 明细、视觉 / 文档审稿辅助调用和后台记忆调用单独计数
        queueMs: elapsed(createdAt, startedAt ?? t),
        executionMs: elapsed(startedAt, t), totalMs: elapsed(createdAt, t),
        firstTextMs: elapsed(createdAt, firstTextAt), contextMs,
        modelMs: modelMs + (modelOpen == null ? 0 : elapsed(modelOpen, t)),
        toolMs: toolMs + (toolOpen == null ? 0 : elapsed(toolOpen, t)),
        inputChars: inputCharSamples === modelCalls && modelCalls > 0 ? inputChars : null,
        inputTextChars: inputTextSamples === modelCalls + helperModelCalls && inputTextSamples > 0 ? inputTextChars : null,
        inputTextSamples, systemChars, toolSchemaChars,
        helperModelCalls, helperInputChars, delegateTasks,
        inputCharSamples, modelCalls, toolCalls, failedTools, retries, fallbacks, nativeSearchCalls,
        tools: structuredClone(byTool),
        backgroundModelCalls,
        rewrites: { ...rewrites },
        calls: calls.map((c) => ({ ...c, ...(c.usage && { usage: { ...c.usage } }) })),
        // Token 合计：有一次调用没拿到用量就是 null（不能当成 0）
        tokens: calls.length && calls.every((c) => c.usage && Number.isFinite(c.usage.input) && Number.isFinite(c.usage.output))
          ? calls.reduce((sum, c) => ({ input: sum.input + c.usage.input, output: sum.output + c.usage.output, cached: sum.cached + (c.usage.cached || 0) }), { input: 0, output: 0, cached: 0 })
          : null,
        tokenSamples: calls.filter((c) => c.usage).length
      };
    }
  };
}

