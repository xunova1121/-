import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { baselineSummary, compareBaseline } from './baseline-report.mjs';

/** 审查意见另存文件；必须逐项说明依据，不能批量把done改成通过。 */
export function applyReviews(report, reviews) {
  const revised = structuredClone(report);
  if (!Array.isArray(reviews) || reviews.length > 30) throw new Error('审查条目应为0至30条');
  const seen = new Set();
  for (const review of reviews) {
    if (seen.has(review.id)) throw new Error('重复审查题号');
    seen.add(review.id);
    const item = revised.results.find((entry) => entry.id === review.id);
    if (!item || !['passed', 'failed'].includes(review.quality)) throw new Error('题号或审查状态错误');
    if (!Array.isArray(review.checkpoints) || review.checkpoints.length !== item.rubric.length || !review.checkpoints.every((entry) => typeof entry?.passed === 'boolean' && typeof entry?.evidence === 'string' && entry.evidence.trim().length >= 8 && entry.evidence.length <= 2000)) throw new Error('每个检查点都需要判定及具体依据');
    if (review.quality === 'passed' && (item.status !== 'done' || item.assessment.mechanical !== 'passed' || !review.checkpoints.every((entry) => entry.passed))) throw new Error('失败或缺检查点的题不能判通过');
    item.quality = review.quality;
    item.assessment.semantic = review.quality;
    item.humanReview = { checkpoints: review.checkpoints, reviewedAt: new Date().toISOString() };
  }
  revised.summary = baselineSummary(revised.results);
  return revised;
}

export async function main(args = process.argv.slice(2)) {
  const [mode, oldFile, otherFile, outFile] = args;
  if (!['review', 'compare'].includes(mode) || !oldFile || !otherFile || !outFile) throw new Error('用法：baseline-review.mjs review|compare 报告.json 审查.json|新报告.json 新输出.json');
  const old = JSON.parse(await fs.readFile(oldFile, 'utf8'));
  const other = JSON.parse(await fs.readFile(otherFile, 'utf8'));
  const result = mode === 'review' ? applyReviews(old, other) : compareBaseline(old, other);
  await fs.writeFile(outFile, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(`结果已写入：${outFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('审查或比较未完成；请检查文件和检查点，未输出正文。');
    process.exitCode = 1;
  });
}
