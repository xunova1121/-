import { it, expect } from 'vitest';
import { jointCases } from '../evals/joint-cases.mjs';
import { speedQualityCases } from '../evals/speed-quality-cases.mjs';
import { distribution, speedQualityReport } from '../evals/speed-quality-report.mjs';
it('原30题不变，六道补充题编号独立，范围题保留六对与追问', () => {
  expect(jointCases).toHaveLength(30); expect(speedQualityCases).toHaveLength(6);
  expect(new Set([...jointCases, ...speedQualityCases].map(c => c.id)).size).toBe(36);
  expect(speedQualityCases[0].prompt.match(/ vs /g)).toHaveLength(6);
  expect(speedQualityCases[0].followup).toContain('不用联网');
  expect(speedQualityCases.every(c => c.requires.length === 0 && c.rubric.length > 0)).toBe(true);
});
it('缺值不变零，中位与P90采用有效数字', () => {
  expect(distribution([null, undefined, NaN, -1, '8'])).toEqual({ samples: 0, median: null, p90: null });
  expect(distribution([10, 20, 30, 40, null])).toEqual({ samples: 4, median: 25, p90: 40 });
});
it('追问逐轮统计，失败单列，不把首字当有效答复或执行成功当质量成功', () => {
  const r = speedQualityReport({ results: [{ id: 'a', group: 'live', runs: [{ attempt: 1, turns: [
    { status: 'done', clientTotalMs: 100, timing: { firstTextMs: 2, modelWaitMs: 70 } },
    { status: 'error', clientTotalMs: 1000, timing: {} }
  ] }] }] });
  expect(r.totals).toEqual({ turns: 2, completed: 1, other: 1 });
  expect(r.groups[0].totalMs.median).toBe(100);
  expect(r.turns[0].firstUsefulAnswerMs).toBeNull(); expect(r.turns[0].semantic).toBeNull();
  expect(r.slowest[0].status).toBe('error'); expect(r.turns[0].phases[0].phase).toBe('modelWaitMs');
});
