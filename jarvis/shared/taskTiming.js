/** 只累计数字，不保存问题、网址、密钥、模型正文。工具并行时间取区间并集。 */
export function createTaskTiming(createdAt, now = Date.now) {
  let startedAt = null, endedAt = null, firstTextAt = null, contextMs = 0;
  let modelMs = 0, toolMs = 0, modelOpen = null, toolOpen = null;
  let modelCalls = 0, toolCalls = 0, failedTools = 0, retries = 0, fallbacks = 0, nativeSearchCalls = 0;
  let inputChars = 0, inputCharSamples = 0, helperModelCalls = 0, helperInputChars = 0;
  const activeTools = new Set();
  const elapsed = (a, b) => a == null || b == null ? null : Math.max(0, b - a);
  return {
    start() { if (startedAt == null && endedAt == null) startedAt = now(); },
    event(e) {
      if (endedAt != null) return;
      const t = now();
      if (e.type === 'diagnostic' && e.phase === 'helper_start') { helperModelCalls++; helperInputChars += Math.max(0, e.inputChars || 0); }
      if (e.type === 'text' && String(e.delta ?? '').trim() && firstTextAt == null) firstTextAt = t;
      if (e.type === 'timing' && Number.isFinite(e.contextMs)) contextMs += Math.max(0, e.contextMs);
      if (e.type === 'diagnostic' && e.phase === 'model_start') {
        if (Number.isFinite(e.inputChars) && e.inputChars >= 0) { inputChars += e.inputChars; inputCharSamples++; }
        modelCalls++; if (modelOpen == null) modelOpen = t; }
      if (e.type === 'diagnostic' && e.phase === 'model_end' && modelOpen != null) { modelMs += elapsed(modelOpen, t); modelOpen = null; }
      if (e.type === 'tool_start' && !activeTools.has(e.id)) { toolCalls++; activeTools.add(e.id); if (toolOpen == null) toolOpen = t; }
      if (e.type === 'tool_end' && activeTools.delete(e.id)) {
        if (e.ok === false) failedTools++;
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
        measurementVersion: 2,
        queueMs: elapsed(createdAt, startedAt ?? t),
        executionMs: elapsed(startedAt, t), totalMs: elapsed(createdAt, t),
        firstTextMs: elapsed(createdAt, firstTextAt), contextMs,
        modelMs: modelMs + (modelOpen == null ? 0 : elapsed(modelOpen, t)),
        toolMs: toolMs + (toolOpen == null ? 0 : elapsed(toolOpen, t)),
        inputChars: inputCharSamples === modelCalls && modelCalls > 0 ? inputChars : null,
        helperModelCalls, helperInputChars,
        inputCharSamples, modelCalls, toolCalls, failedTools, retries, fallbacks, nativeSearchCalls
      };
    }
  };
}
