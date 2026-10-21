import { baselineCases } from './baseline-cases.mjs';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { baselineSummary, compareBaseline, checkResult, assessmentVersion } from './baseline-report.mjs';

/** 旧报告只离线重判检查规则，不重跑模型、不覆盖原文件或把未知质量改成通过。 */
export function recheckReport(report) {
  const revised = structuredClone(report);
  revised.assessmentVersion = assessmentVersion;
  revised.executionProfile ??= 'legacy_personalized';
  for (const item of revised.results) {
    const definition = baselineCases.find((entry) => entry.id === item.id);
    if (!definition || !item.turns?.length) throw Object.assign(new Error('缺少原始题目或轮次，不能重新评测'), { code: 'EVAL_REVIEW', kind: 'api' });
    item.previousAssessment = item.assessment;
    item.assessment = checkResult(definition, item.turns.at(-1));
    if (definition.followup && item.turns.length !== 2) {
      item.assessment.failures.push('未完成同会话纠正');
      item.assessment.mechanical = 'failed';
      item.assessment.quality = 'failed';
    }
    if (item.humanReview) item.previousHumanReview = item.humanReview;
    delete item.humanReview;
    item.quality = item.assessment.quality;
  }
  revised.summary = baselineSummary(revised.results);
  return revised;
}

/** 审查意见另存文件；必须逐项说明依据，不能批量把done改成通过。 */
export function applyReviews(report, reviews) {
  const revised = structuredClone(report);
  if (!Array.isArray(reviews) || reviews.length > 30) throw Object.assign(new Error('审查条目应为0至30条'), { code: 'EVAL_REVIEW', kind: 'api' });
  const seen = new Set();
  for (const review of reviews) {
    if (seen.has(review.id)) throw Object.assign(new Error('重复审查题号'), { code: 'EVAL_REVIEW', kind: 'api' });
    seen.add(review.id);
    const item = revised.results.find((entry) => entry.id === review.id);
    if (!item || !['passed', 'failed'].includes(review.quality)) throw Object.assign(new Error('题号或审查状态错误'), { code: 'EVAL_REVIEW', kind: 'api' });
    if (!Array.isArray(review.checkpoints) || review.checkpoints.length !== item.rubric.length || !review.checkpoints.every((entry) => typeof entry?.passed === 'boolean' && typeof entry?.evidence === 'string' && entry.evidence.trim().length >= 8 && entry.evidence.length <= 2000)) throw Object.assign(new Error('每个检查点都需要判定及具体依据'), { code: 'EVAL_REVIEW', kind: 'api' });
    if (review.quality === 'passed' && (item.status !== 'done' || item.assessment.mechanical !== 'passed' || !review.checkpoints.every((entry) => entry.passed))) throw Object.assign(new Error('失败或缺检查点的题不能判通过'), { code: 'EVAL_REVIEW', kind: 'api' });
    item.quality = review.quality;
    item.assessment.semantic = review.quality;
    item.humanReview = { checkpoints: review.checkpoints, reviewedAt: new Date().toISOString() };
  }
  revised.summary = baselineSummary(revised.results);
  return revised;
}

export async function main(args = process.argv.slice(2)) {
  const [mode, oldFile, otherFile, outFile] = args;
  if (!['review', 'compare', 'recheck'].includes(mode) || !oldFile || !otherFile || (mode !== 'recheck' && !outFile)) throw Object.assign(new Error('用法：baseline-review.mjs review|compare 报告.json 审查.json|新报告.json 新输出.json'), { code: 'EVAL_REVIEW', kind: 'api' });
  const old = JSON.parse(await fs.readFile(oldFile, 'utf8'));
  const other = mode === 'recheck' ? null : JSON.parse(await fs.readFile(otherFile, 'utf8'));
  const result = mode === 'recheck' ? recheckReport(old) : mode === 'review' ? applyReviews(old, other) : compareBaseline(old, other);
  const destination = mode === 'recheck' ? otherFile : outFile;
  await fs.writeFile(destination, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(`结果已写入：${destination}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.code === 'EVAL_REVIEW' ? error.message : '审查或比较未完成；请检查文件，未输出正文。');
    process.exitCode = 1;
  });
}
