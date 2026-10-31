/** 只分析已有私有报告；不联网、不调用模型，缺测值保持null。 */
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function distribution(values) {
  const rows = values.filter(valid).sort((a, b) => a - b);
  return { samples: rows.length, median: rows.length ? (rows[Math.floor((rows.length - 1) / 2)] + rows[Math.floor(rows.length / 2)]) / 2 : null, p90: rows.length ? rows[Math.ceil(rows.length * .9) - 1] : null };
}
export function speedQualityReport(report) {
  const turns = (report.results || []).flatMap(item => (item.runs || []).flatMap(run => (run.turns || []).map((turn, index) => {
    const timing = turn.timing || {};
    const phases = ['contextMs', 'modelWaitMs', 'modelOutputMs', 'searchMs', 'readMs', 'otherToolMs'].filter(key => valid(timing[key])).map(key => ({ phase: key, ms: timing[key] })).sort((a, b) => b.ms - a.ms);
    return { id: item.id, group: item.group, attempt: run.attempt, turn: index + 1, status: turn.status, totalMs: valid(turn.clientTotalMs) ? turn.clientTotalMs : null, firstTextMs: valid(timing.firstTextMs) ? timing.firstTextMs : null,
      firstUsefulAnswerMs: null, usefulAnswerReview: '需逐轮核对流式内容；首字可能只是过程说明，不能替代有效答案时间',
      modelCalls: timing.modelCalls ?? null, failedTools: timing.failedTools ?? null, inputTextChars: timing.inputTextChars ?? null, toolSchemaChars: timing.toolSchemaChars ?? null,
      phases, tools: timing.tools || {}, rewrites: timing.rewrites || {}, semantic: run.judgement ? { pass: run.judgement.pass ?? null, error: Boolean(run.judgement.error) } : null };
  })));
  const done = turns.filter(turn => turn.status === 'done');
  return { suiteVersion: report.suiteVersion, conditions: report.conditions, note: '按轮统计；完成样本耗时与失败数量分开。阶段可能重叠，不相加归因；样本少时P90仅作描述。无评审不算质量通过。',
    totals: { turns: turns.length, completed: done.length, other: turns.length - done.length },
    groups: [...new Set(turns.map(t => t.group))].map(group => { const rows = done.filter(t => t.group === group); return { group, completed: rows.length, totalMs: distribution(rows.map(t => t.totalMs)), firstTextMs: distribution(rows.map(t => t.firstTextMs)), firstUsefulAnswerMs: null }; }),
    slowest: [...turns].filter(t => valid(t.totalMs)).sort((a, b) => b.totalMs - a.totalMs).slice(0, 12), turns };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw Error('用法：node evals/speed-quality-report.mjs report.json speed-quality.json');
  await fs.writeFile(output, JSON.stringify(speedQualityReport(JSON.parse(await fs.readFile(input, 'utf8'))), null, 2), { mode: 0o600 });
  console.log('耗时诊断已保存；有效答案首字与语义质量需复核。');
}
