import { requiresSources } from './retrievalQuality.js';

/** 执行结束不等于任务验收通过；这里只报告可确定的缺口，不自动评判语义正确率。 */
export function reviewOutcome(report, { interrupted = false, nativeSearchCalls = 0 } = {}) {
  const warnings = [];
  let partial = interrupted;
  if (report.pendingFormats?.length) {
    warnings.push(`尚未取得 ${report.pendingFormats.join('、')} 文件的有效读回结果。`);
    partial = true;
  }
  if (report.contract?.calculation && report.calculation === 'not_checked') {
    warnings.push('数值计算尚未通过计算工具核对。');
    partial = true;
  }
  if (report.pendingReadback?.length) {
    warnings.push(`有 ${report.pendingReadback.length} 个修改后的文件尚未读回检查。`);
    partial = true;
  }
  if (report.codeExecution === 'not_run') warnings.push('代码尚未实际运行测试。');
  if (report.artifacts?.some((item) => item.errors > 0)) {
    warnings.push('文档仍有未解决的生成或排版检查问题。');
    partial = true;
  }
  if (report.failures?.length) warnings.push('部分操作未成功，相关结果仍需核对。');
  if (requiresSources(report.request) && !report.retrievalReceipts && !nativeSearchCalls) {
    warnings.push('尚未取得可核查的联网资料，不能当作查询成功。');
    partial = true;
  }
  if (interrupted) warnings.push('本轮已停止继续检索，保留已有内容；未完成的部分可继续处理。');
  return {
    outcome: partial ? 'partial' : warnings.length || report.contract?.researching ? 'needs_review' : 'not_checked',
    warnings,
    notice: warnings.length ? `\n\n（${partial ? '部分完成' : '仍需核对'}：${warnings.join('')}）` : ''
  };
}
