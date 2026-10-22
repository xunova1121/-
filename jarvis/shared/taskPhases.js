/** 只存数字与最多128个在途工具编号；每类工具取区间并集，不累加并行耗时。 */
export function createTaskPhases() {
  const groups = Object.fromEntries(['search', 'read', 'research', 'other'].map((key) => [key, { count: 0, opened: null, ms: 0 }]));
  const active = new Map();
  let modelOpened = null;
  let firstOutput = null;
  let waitMs = 0;
  let outputMs = 0;
  let outputSamples = 0;
  let lastAnswerMs = null;
  let overflow = false;
  const duration = (start, end) => Math.max(0, end - start);
  const kindOf = (tool) => tool === 'web_search' ? 'search' : tool === 'fetch_url' ? 'read' : /^(fact_check|deep_research)$/.test(tool) ? 'research' : 'other';
  return {
    event(event, time) {
      if (event.type === 'diagnostic' && event.phase === 'model_start') {
        // 未收尾的旧请求只按等待计，不能把丢失的回执当已生成答案。
        if (modelOpened !== null) waitMs += duration(modelOpened, time);
        modelOpened = time;
        firstOutput = null;
        lastAnswerMs = null;
      }
      if (event.type === 'diagnostic' && event.phase === 'model_first_output' && modelOpened !== null && firstOutput === null) {
        firstOutput = time;
        outputSamples++;
      }
      if (event.type === 'diagnostic' && event.phase === 'model_end' && modelOpened !== null) {
        waitMs += duration(modelOpened, firstOutput ?? time);
        if (firstOutput !== null) outputMs += duration(firstOutput, time);
        if (event.resultKind === 'answer') lastAnswerMs = duration(modelOpened, time);
        modelOpened = null;
        firstOutput = null;
      }
      if (event.type === 'tool_start' && !active.has(event.id)) {
        if (active.size >= 128) { overflow = true; return; }
        const kind = kindOf(event.name);
        const group = groups[kind];
        active.set(event.id, kind);
        if (!group.count++) group.opened = time;
      }
      if (event.type === 'tool_end' && active.has(event.id)) {
        const group = groups[active.get(event.id)];
        active.delete(event.id);
        if (!--group.count) {
          group.ms += duration(group.opened, time);
          group.opened = null;
        }
      }
    },
    snapshot(time) {
      const bucket = (kind) => groups[kind].ms + (groups[kind].opened === null ? 0 : duration(groups[kind].opened, time));
      return {
        breakdownVersion: 1,
        modelWaitMs: waitMs + (modelOpened === null ? 0 : duration(modelOpened, firstOutput ?? time)),
        modelOutputMs: outputMs + (firstOutput === null ? 0 : duration(firstOutput, time)),
        modelFirstOutputSamples: outputSamples,
        lastAnswerModelMs: lastAnswerMs,
        searchMs: bucket('search'),
        readMs: bucket('read'),
        researchMs: bucket('research'),
        otherToolMs: bucket('other'),
        phaseOverflow: overflow
      };
    }
  };
}
