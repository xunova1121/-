import { codeFollowup, codeTaskPolicy } from './codeTaskPolicy.mjs';
import { codeError } from './codeGit.mjs';

/** 续做只查服务器本会话索引。完成后的继续不重放旧计划，也不新建副本替代原文件。 */
export async function prepareCodeWork({ text, images, sessionId, taskId, checkpoint, resume, repos, evaluationId, maxSteps, codeMaxSteps, signal, hasProjects = false, projectBound = false }) {
  const previous = resume || (checkpoint.codeTaskId ? { codeTaskId: checkpoint.codeTaskId } : null);
  const following = codeFollowup(text);
  const codeReference = following && (previous || /代码|仓库|商城|网页|项目|工作副本|lint|test|npm/i.test(text));
  const options = { text, images, resume: previous, maxSteps, codeMaxSteps, hasProjects, projectBound };
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
  // 本对话没有副本：看看别的对话里有没有（用户 2026-10-30：换了对话就找不到原来的副本，还要用户报编号）。
  // 说“继续/接着改”且别处只有一份时直接接过来；多份就列给模型，让用户按时间和改动挑
  let elsewhere = [];
  let adopted = '';
  if (connected && !indexError && !found.items.length && repos.elsewhere) {
    elsewhere = (await repos.elsewhere(sessionId, { signal }).catch((error) => {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      return { items: [] };
    })).items;
    if (following && elsewhere.length === 1 && repos.adopt) {
      const taken = await repos.adopt(elsewhere[0].workspace_id, sessionId, { signal }).catch(() => null);
      if (taken) {
        adopted = taken.workspace_id;
        Object.assign(found, await repos.workspaces(sessionId, { signal }));
        elsewhere = [];
      }
    }
  }
  const policy = codeTaskPolicy({ ...options, hasRepos: connected, hasWorkspaces: following && (found.items.length > 0 || elsewhere.length > 0) });
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
    codeWork: { enabled: policy.enabled, workspaces: found.items, truncated: found.truncated, ...(indexError && { indexError }), ...(elsewhere.length && { elsewhere }), ...(adopted && { adopted }), continuing: following }
  };
}
