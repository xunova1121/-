import * as workspace from './workspace.js';
const compact = rows => rows?.slice(0, 8).map(row => Object.fromEntries(['field', 'stage', 'message', 'action'].filter(key => row[key] !== undefined).map(key => [key, String(row[key]).slice(0, key === 'field' ? 160 : key === 'action' ? 380 : 280)])));
/** 内容3次和原审查恢复1次是各自的上限；终止时沿用最后真实阶段，不覆盖诊断文件。 */
export function workflowStop(state, message) {
  const previous = state.lastError || state.terminalFailure || {};
  const stage = previous.diagnostics?.[0]?.stage || (state.stage === 'review' ? 'review' : 'content');
  return Object.assign(new Error(message + (previous.message || previous.note ? '；最后真实问题：' + (previous.message || previous.note) : '')), {
    code: 'ARCHITECTURE_WORKFLOW', kind: 'input', terminal: true,
    diagnostics: previous.diagnostics?.length ? previous.diagnostics.slice(0, 8) : [{ stage, field: state.stage === 'review' ? 'architecturePath' : 'response', action: '恢复额度已用尽，保留已有底稿和真实报告，不再重复提交或重建任务绕过额度' }]
  });
}
export async function saveWorkflowFailure(error, state, jobPath, save, execution) {
  if (!error.terminal || error.integrityFailure) {
    let issuesPath;
    if (error.diagnostics?.length) {
      issuesPath = jobPath.replace('架构任务/', '架构诊断/').replace(/\.json$/, '.issues-' + state.attempts + '-' + crypto.randomUUID() + '.json');
      await workspace.writeArchitectureState(issuesPath, JSON.stringify({ total: error.diagnostics.length, diagnostics: error.diagnostics }));
      await execution.checkpoint?.({ type: 'file', path: issuesPath });
    }
    state.lastError = {
      ...(issuesPath && { issuesPath }), code: String(error.code || error.name).slice(0, 80),
      message: String(error.message).slice(0, 1000), diagnostics: compact(error.diagnostics)
    };
  }
  if (error.terminal || (state.stage === 'content' && state.attempts >= 3)) {
    if (!state.lastError) state.lastError = { message: String(error.message).slice(0, 1000), diagnostics: compact(error.diagnostics) };
    if (error.integrityFailure) {
      state.terminalFailure = { phase: 'integrity', code: error.materialIntegrity ? 'WORKFLOW_SOURCE_CHANGED' : 'WORKFLOW_CONTENT_CHANGED' };
      await save();
      return workflowStop(state, '架构内容完整性核验失败，停止收费重试和交付');
    }
    state.terminalFailure = { phase: state.stage, code: state.stage === 'review' ? 'REVIEW_RECOVERY_EXHAUSTED' : 'CONTENT_ATTEMPTS_EXHAUSTED' };
    await save();
    return workflowStop(state, state.stage === 'review' ? '业务审查恢复已用尽，停止本轮重复执行' : '内容整理已达3次上限，停止本轮重复执行');
  }
  await save();
  return error;
}
