import { describe, it, expect } from 'vitest';
import { createTaskTiming } from '../shared/taskTiming.js';
import { createModelRequest } from '../src/agent/agentModelRequest.js';

describe('任务分段计时，不把并行时间相加', () => {
  it('模型等待、输出、最后答案及并行搜索/读页分别记录', () => {
    let time = 0;
    const timing = createTaskTiming(0, () => time);
    timing.start();
    const send = (at, event) => { time = at; timing.event(event); };
    send(5, { type: 'diagnostic', phase: 'model_start' });
    send(15, { type: 'diagnostic', phase: 'model_first_output' });
    send(25, { type: 'diagnostic', phase: 'model_end', resultKind: 'tools' });
    send(25, { type: 'tool_start', id: 's1', name: 'web_search' });
    send(30, { type: 'tool_start', id: 's2', name: 'web_search' });
    send(35, { type: 'tool_start', id: 'r1', name: 'fetch_url' });
    send(45, { type: 'tool_end', id: 's1' });
    send(50, { type: 'tool_end', id: 's2' });
    send(55, { type: 'tool_end', id: 'r1' });
    send(55, { type: 'diagnostic', phase: 'model_start' });
    send(65, { type: 'diagnostic', phase: 'model_first_output' });
    send(75, { type: 'diagnostic', phase: 'model_end', resultKind: 'answer' });
    expect(timing.finish()).toMatchObject({
      totalMs: 75, modelMs: 40, modelWaitMs: 20, modelOutputMs: 20,
      modelFirstOutputSamples: 2, lastAnswerModelMs: 20,
      searchMs: 25, readMs: 20, toolMs: 30, breakdownVersion: 1
    });
  });

  it('运行中的快照不重复累计，停止后冻结；不保存事件正文和网址', () => {
    let time = 10;
    const timing = createTaskTiming(0, () => time);
    timing.start();
    timing.event({ type: 'tool_start', id: 'read', name: 'fetch_url', args: { url: 'https://secret.invalid' } });
    time = 20;
    expect(timing.snapshot().readMs).toBe(10);
    expect(timing.snapshot().readMs).toBe(10);
    const frozen = timing.finish();
    time = 40;
    timing.event({ type: 'tool_end', id: 'read', output: '秘密正文' });
    expect(timing.snapshot()).toEqual(frozen);
    expect(JSON.stringify(frozen)).not.toMatch(/secret|秘密/);
  });

  it('复合调研单独计时，失败答案不标成最终回答；有界在途表报告溢出', () => {
    let time = 0;
    const timing = createTaskTiming(0, () => time);
    timing.start();
    timing.event({ type: 'diagnostic', phase: 'model_start' });
    time = 5;
    timing.event({ type: 'diagnostic', phase: 'model_end', resultKind: 'error' });
    timing.event({ type: 'tool_start', id: 'research', name: 'fact_check' });
    time = 15;
    timing.event({ type: 'tool_end', id: 'research', ok: false });
    for (let index = 0; index < 130; index++) timing.event({ type: 'tool_start', id: String(index), name: 'web_search' });
    expect(timing.finish()).toMatchObject({ researchMs: 10, modelWaitMs: 5, lastAnswerModelMs: null, phaseOverflow: true });
  });

  it('真实请求包装发出观察点；纯工具回复到完整参数时才算可观察输出', async () => {
    for (const toolCalls of [[], [{ id: 's', name: 'web_search', args: {} }]]) {
      let time = 0;
      const timing = createTaskTiming(0, () => time);
      timing.start();
      timing.event({ type: 'diagnostic', phase: 'model_start' });
      const request = createModelRequest({
        current: { model: 'fixture', adapter: { kind: 'openai', async stream(options) {
          time = 10;
          if (!toolCalls.length) options.onText('答案');
          time = 20;
          return { text: toolCalls.length ? '' : '答案', toolCalls, stop: 'end_turn' };
        } } },
        signal: new AbortController().signal, lookupDeadline: false, closing: false,
        retrieval: { left: 6 }, emit: (event) => timing.event(event), onText() {}, onNativeSearch() {}
      });
      try { await request.run({ system: [''], messages: [], tools: [] }); }
      finally { request.dispose(); }
      expect(timing.finish()).toMatchObject({
        modelWaitMs: toolCalls.length ? 20 : 10,
        modelOutputMs: toolCalls.length ? 0 : 10,
        lastAnswerModelMs: toolCalls.length ? null : 20
      });
    }
  });
});
