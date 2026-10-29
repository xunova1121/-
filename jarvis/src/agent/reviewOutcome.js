import { requiresSources } from './retrievalQuality.js';
import { explainedRepositoryFailure } from './codeRepositoryReview.js';

/** 失败提示里说人话 */
const TOOL_NAMES = { code_browser: '网页浏览器检查', project_prepare: '准备项目确认', project_save: '准备分支保存', convert_legacy_doc: '转换旧Word', code_edit: '修改仓库代码', code_write: '保存仓库文件', code_run: '隔离运行检查', create_document: '生成文档', write_long_document: '写长文档', write_professional_document: '写正式文档', edit_office_document: '修改文档', edit_spreadsheet: '修改表格', write_file: '写文件', edit_file: '改文件', run_javascript: '运行代码', run_python: '运行代码', generate_image: '画图', sing_song: '生成歌曲', schedule_task: '定时任务', remember: '记忆', computer_run: '电脑上运行命令', run_project_tests: '运行测试' };

/** 执行结束不等于任务验收通过；这里只报告可确定的缺口，不自动评判语义正确率。 */
export function reviewOutcome(report, { interrupted = false, nativeSearchCalls = 0, answer = '' } = {}) {
  const warnings = [];
  if (report.visualIssue) warnings.push('图像识别的执行依据不足，不能视为已核实。');
  let partial = interrupted || Boolean(report.visualIssue);
  if (report.answerIssues?.length || report.sourceIssue) {
    warnings.push('当前内容限制或具体来源要求尚未全部满足，不能当作完整交付。');
    partial = true;
  }
  if (report.media && report.media.state !== 'completed') {
    warnings.push(`${report.media.label}还没有取得真实文件回执，当前为${report.media.state}；不能当作生成完成。`);
    partial = true;
  }
  if (report.pendingFormats?.length) {
    warnings.push(`尚未取得 ${report.pendingFormats.join('、')} 文件的有效读回结果。`);
    partial = true;
  }
  if (report.calculation === 'failed') {
    warnings.push('关键数值校验失败，请人工复核。');
    partial = true;
  } else if (report.contract?.calculation && report.calculation === 'not_checked') {
    warnings.push('关键数值尚未完成工具校验，请人工复核。');
    partial = true;
  }
  if (report.pendingReadback?.length) {
    warnings.push(`有 ${report.pendingReadback.length} 个修改后的文件尚未读回检查。`);
    partial = true;
  }
  if (report.memory === 'not_saved') {
    warnings.push('用户要求记住的内容没有真正存进记忆。');
    partial = true;
  }
  if (report.codeExecution === 'not_run') warnings.push('代码尚未实际运行测试。');
  if (report.artifacts?.some((item) => item.errors > 0)) {
    warnings.push('文档仍有未解决的生成或排版检查问题。');
    partial = true;
  }
  const failures = report.failures?.filter(tool => tool !== 'code_run' || !explainedRepositoryFailure(report, answer));
  if (failures?.length) warnings.push(`这些操作没成功：${[...new Set(failures)].map((tool) => TOOL_NAMES[tool] || tool).join('、')}，相关结果仍需核对。`);
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
