import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** 工程通过、规则检查、人工语义验收分开；未评审的题目不能算准确率。 */
export function qualityReport(report) {
  const results = report.results ?? [];
  const reviewed = results.filter((item) => ['passed', 'failed'].includes(item.quality));
  const passed = reviewed.filter((item) => item.quality === 'passed');
  const totals = results
    .map((item) => item.clientTotalMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const first = results
    .map((item) => item.timing?.firstTextMs)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const percentile = (values, ratio) => (values.length ? values[Math.max(0, Math.ceil(values.length * ratio) - 1)] : null);
  const usageKnown = results.filter((item) => Number.isFinite(item.usage?.totalTokens));
  return {
    count: results.length,
    reviewed: reviewed.length,
    correct: passed.length,
    reviewedAccuracy: reviewed.length ? passed.length / reviewed.length : null,
    reviewCoverage: results.length ? reviewed.length / results.length : null,
    executionComplete: results.filter((item) => item.status === 'done' && !item.protocolIssue).length,
    totalP50Ms: percentile(totals, 0.5),
    totalP95Ms: percentile(totals, 0.95),
    firstTextP50Ms: percentile(first, 0.5),
    tokens: usageKnown.length === results.length && results.length ? usageKnown.reduce((sum, item) => sum + item.usage.totalTokens, 0) : null,
    tokenCoverage: usageKnown.length,
    note: '准确率只针对已语义评审题；工程断言或任务状态done不代表回答正确。未知Token不是零。'
  };
}

export function compareReports(baseline, current) {
  const before = qualityReport(baseline);
  const after = qualityReport(current);
  const oldItems = new Map((baseline.results ?? []).map((item) => [item.id, item]));
  const comparable = (current.results ?? []).filter((item) => oldItems.has(item.id));
  const regressions = comparable
    .filter((item) => oldItems.get(item.id).quality === 'passed' && (item.quality === 'failed' || item.status !== 'done'))
    .map((item) => item.id);
  return {
    before,
    after,
    comparableCases: comparable.length,
    regressions,
    totalP50ChangeMs: before.totalP50Ms !== null && after.totalP50Ms !== null ? after.totalP50Ms - before.totalP50Ms : null,
    note: '不同题集、模型、服务端或网络条件的耗时不能作为严格对照实验。'
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [oldFile, newFile] = process.argv.slice(2);
  if (!oldFile || !newFile) throw new Error('用法：node evals/quality-report.mjs 基线.json 新报告.json');
  console.log(JSON.stringify(compareReports(JSON.parse(await fs.readFile(oldFile, 'utf8')), JSON.parse(await fs.readFile(newFile, 'utf8'))), null, 2));
}
