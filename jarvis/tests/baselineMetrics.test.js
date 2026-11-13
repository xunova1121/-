import { describe, it, expect } from 'vitest';
import { createTaskTiming } from '../shared/taskTiming.js';
import { baselineCases } from '../evals/baseline-cases.mjs';
import { metricsFor } from '../evals/baseline-report.mjs';
import { measureModelInput } from '../shared/modelMetrics.js';

describe('固定基线的模型计数口径', () => {
  it('测到系统提示与工具schema，但不保留提示原文或工具实现', () => {
    const options = { system: ['系统一', '系统二'], messages: [{ role: 'user', content: '你好' }], tools: [{ name: 'demo', description: '说明', parameters: { type: 'object' }, run: () => '机密实现' }] };
    const measured = measureModelInput(options);
    expect(measured.systemChars).toBe(6);
    expect(measured.messageChars).toBe(2);
    expect(measured.toolSchemaChars).toBeGreaterThan(20);
    expect(measured.inputTextChars).toBe(measured.systemChars + measured.messageChars + measured.toolSchemaChars);
    expect(Object.values(measured).every(Number.isFinite)).toBe(true);
    const timing = createTaskTiming(0, () => 1);
    timing.event({ type: 'diagnostic', phase: 'model_start', ...measured, inputChars: 2 });
    timing.event({ type: 'diagnostic', phase: 'helper_start', ...measured, inputChars: 2 });
    expect(timing.snapshot().inputTextChars).toBe(measured.inputTextChars * 2);
    expect(JSON.stringify(timing.snapshot())).not.toMatch(/系统一|机密实现|你好/);
  });

  it('并行工具的辅助调用各计一次，主循环分开；不保存正文', () => {
    const timing = createTaskTiming(0, () => 10);
    timing.start();
    timing.event({ type: 'diagnostic', phase: 'model_start', inputChars: 20 });
    for (let index = 0; index < 3; index++) {
      timing.event({ type: 'diagnostic', phase: 'helper_start', inputChars: 50, secret: '不应保存的正文' });
    }
    const snapshot = timing.snapshot();
    expect(snapshot).toMatchObject({ version: 1, measurementVersion: 2, modelCalls: 1, helperModelCalls: 3, inputChars: 20, helperInputChars: 150 });
    expect(JSON.stringify(snapshot)).not.toContain('不应保存');
    expect(metricsFor(baselineCases[0], [{ prompt: '你好', clientTotalMs: 10, timing: snapshot }])).toMatchObject({ allModelCalls: 4, userInputChars: 2 });
  });

  it('旧服务端缺辅助指标时不将主循环数量冒充全量', () => {
    expect(metricsFor(baselineCases[0], [{ clientTotalMs: 1, timing: { modelCalls: 2 } }]).allModelCalls).toBeNull();
  });
});
