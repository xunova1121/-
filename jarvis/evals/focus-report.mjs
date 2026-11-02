import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { jointSummary, summaryMarkdown } from './joint-report.mjs';
import { speedQualityReport } from './speed-quality-report.mjs';
import { focusCases, focusSuiteVersion } from './focus-cases.mjs';

/** 没评审、缺环境、未完成或文件不符都不能变成通过；重点题不能冒充全量准确率。 */
export function focusSummary(report) {
  if (report.suiteVersion !== focusSuiteVersion) throw new Error('不是重点复测报告');
  const summary = jointSummary(report.results || []);
  const present = new Set((report.results || []).map((row) => row.id));
  const missing = focusCases.filter((row) => !present.has(row.id)).map((row) => row.id);
  const expected = focusCases.length * (report.repeats || 2);
  const attempts = (report.results || []).flatMap((row) => row.runs || []);
  const wrongCoverage = focusCases.some((item) => {
    const entries = (report.results || []).filter((row) => row.id === item.id);
    return entries.length !== 1 || entries[0].runs?.length !== (report.repeats || 2);
  });
  const unfinished = missing.length || wrongCoverage || attempts.length !== expected || !report.conditions?.finishedAt;
  const failed = attempts.some(
    (run) =>
      !['done', 'skipped'].includes(run.status) ||
      run.mechanical?.mechanical === 'failed' ||
      run.fileProblems?.length ||
      run.judgement?.pass === false ||
      run.judgement?.overclaim
  );
  const state = unfinished
    ? 'incomplete'
    : summary.notReady.length
      ? 'blocked_readiness'
      : failed
        ? 'failed'
        : summary.pendingReview
          ? 'needs_review'
          : 'automatic_review_passed';
  return {
    suiteVersion: focusSuiteVersion,
    state,
    expectedRuns: expected,
    recordedRuns: attempts.length,
    missingCases: missing,
    ...summary,
    calibrationRequired: true,
    scopeNote: '仅五类重点题；未完成原30题全量复试，不代表总体准确率或已验证手机真实体验'
  };
}
export async function main(args = process.argv.slice(2)) {
  const file = args[0];
  if (!file) throw new Error('需要私有报告路径');
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  const result = focusSummary(report);
  report.summary = jointSummary(report.results);
  const directory = path.dirname(file);
  await fs.writeFile(path.join(directory, '重点汇总.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(directory, '摘要.md'), `状态：${result.state}（执行结束不代表质量通过）\n\n${result.scopeNote}\n\n${summaryMarkdown(report)}`, {
    mode: 0o600
  });
  await fs.writeFile(path.join(directory, 'speed-quality.json'), JSON.stringify(speedQualityReport(report), null, 2), { mode: 0o600 });
  console.log(`重点复测状态：${result.state}；报告私有保存，未自动升级为人工验收通过。`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('重点汇总未生成，请保留私有报告核查');
    process.exitCode = 1;
  });
