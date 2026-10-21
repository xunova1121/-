import { describe, it, expect } from 'vitest';
import { createTaskTiming } from '../shared/taskTiming.js';
import { baselineCases } from '../evals/baseline-cases.mjs';
import { metricsFor } from '../evals/baseline-report.mjs';

describe('固定基线的模型计数口径', () => {
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
