import { codeFollowup, codeTaskPolicy } from './codeTaskPolicy.mjs';
import { codeError } from './codeGit.mjs';

/** 续做只查服务器本会话索引。完成后的继续不重放旧计划，也不新建副本替代原文件。 */
export async function prepareCodeWork({ text, images, sessionId, taskId, checkpoint, resume, repos, evaluationId, maxSteps, codeMaxSteps, signal }) {
  const previous = resume || (checkpoint.codeTaskId ? { codeTaskId: checkpoint.codeTaskId } : null);
  const following = codeFollowup(text);
  const codeReference = following && (previous || /代码|仓库|商城|网页|项目|工作副本|lint|test|npm/i.test(text));
  const options = { text, images, resume: previous, maxSteps, codeMaxSteps };
  const candidate = codeTaskPolicy({ ...options, hasRepos: Boolean(repos && !evaluationId) });
  const eligible = Boolean(repos && !evaluationId && (candidate.enabled || codeReference));
  const connected = eligible && (repos.connected ? await repos.connected() : candidate.enabled);
  const found = { items: [], truncated: false };
  let indexError = '';
  if (connected && repos.workspaces) {
    try {
      Object.assign(found, await repos.workspaces(sessionId, { signal }));
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError' || error.code === 'RETRIEVAL_BUDGET') throw error;
      indexError = /^[A-Z_]{1,60}$/.test(error.code || '') ? error.code : 'CODE_INDEX_UNAVAILABLE';
    }
  }
  const policy = codeTaskPolicy({ ...options, hasRepos: connected, hasWorkspaces: following && found.items.length > 0 });
  const originalTask = previous?.codeTaskId || previous?.taskId;
  const only = !found.truncated && found.items.length === 1 ? found.items[0] : null;
  const selected = found.items.find((item) => item.task_id === originalTask) || (!originalTask || !only?.task_id ? only : null);
  const codeTaskId = originalTask || selected?.task_id || taskId;
  let scopedRepos = repos;
  if (policy.enabled && following) {
    scopedRepos = {
      ...repos,
      clone: async (input, scope, execution) => {
        if (indexError || !selected) throw codeError('CODE_WORKTREE', '服务器原工作副本未能唯一定位；先查本会话repo_status，不搜索电脑目录，不克隆新副本替代');
        if (input.repository && input.repository.toLowerCase() !== selected.repository) throw codeError('CODE_REPO_NOT_ALLOWED', '续做不能切到其他仓库');
        if (selected.task_id || originalTask) return repos.clone(input, { ...scope, taskId: selected.task_id || originalTask }, execution);
        return repos.status(selected.workspace_id, sessionId, execution);
      }
    };
  }
  return {
    policy,
    codeTaskId,
    scopedRepos,
    codeWork: { enabled: policy.enabled, workspaces: found.items, truncated: found.truncated, ...(indexError && { indexError }), continuing: following }
  };
}
