import { architectureReviewStatus } from './architectureReview.js';
import { loadArchitecture } from './architectureProjection.js';
import { resumeArchitectureReview } from './architectureResume.js';
/** 审查服务/格式失败只恢复同一底稿，不能消耗内容次数或重新改业务。 */
export function setWorkflowReview(state, receipt) {
  state.architecturePath = receipt.architecturePath;
  if (receipt.readyForRender) {
    state.stage = 'export';
    state.lastError = null;
    return;
  }
  state.stage = receipt.structure === 'passed' && receipt.semantic === 'not_checked' ? 'review' : 'content';
  state.lastError = {
    code: receipt.reviewErrorCode || 'ARCHITECTURE_REVIEW', issuesPath: receipt.reviewPath,
    issues: receipt.reviewIssues, note: receipt.reviewNote,
    diagnostics: [{ field: 'architecturePath', stage: 'review', action: receipt.nextAction }]
  };
}
export async function continueWorkflowReview(ctx, state, execution) {
  const bundle = await loadArchitecture(state.architecturePath, execution.signal);
  const current = await resumeArchitectureReview(ctx, bundle, { ...execution, rawRequestText: state.request });
  const status = architectureReviewStatus(current.report, current.reviewPath);
  setWorkflowReview(state, {
    architecturePath: current.path, reviewPath: current.reviewPath, structure: current.report.structure,
    semantic: current.report.semantic, ...status
  });
  return { report: current.report, ...status };
}
