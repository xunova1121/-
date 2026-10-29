import { classifyTask } from '../src/llm/router.js';

export const CODE_TASK_MS = 15 * 60_000;
export const CODE_MAX_STEPS = 80;
const ACTION =
  /修复|修好|修改|改好|重构|开发|实现|新增|编写|写个|写一|跑|运行|执行|调试|测试|克隆|连接|拉取|检查|查看|读取|阅读|\b(?:fix|implement|refactor|clone|test|lint)\b/i;
const REPOSITORY = /仓库|GitHub|worktree|repo(?:sitory)?\b|代码|程序|前端|后端|bug|\.m?[jt]sx?\b|package\.json|npm\b|lint\b/i;

/** 只给确实要动手的仓库任务放宽预算；寒暄/知识问答沿用旧值和旧路由。 */
export function codeTaskPolicy({ text, images = 0, hasRepos, resume, maxSteps = 28, codeMaxSteps = CODE_MAX_STEPS }) {
  const continuing =
    Boolean(resume?.codeTaskId || (resume?.taskId && ACTION.test(resume.text || '') && REPOSITORY.test(resume.text || ''))) && /^(继续|恢复|接着)/.test(text);
  const enabled = Boolean(hasRepos && (continuing || (ACTION.test(text) && REPOSITORY.test(text))));
  return {
    enabled,
    kind: images ? 'vision' : enabled ? 'code' : classifyTask(text, { images }),
    maxSteps: enabled ? Math.max(1, Math.min(CODE_MAX_STEPS, Number(codeMaxSteps) || CODE_MAX_STEPS)) : maxSteps,
    ...(enabled && { maxTotalSteps: Math.max(1, Math.min(CODE_MAX_STEPS, Number(codeMaxSteps) || CODE_MAX_STEPS)) })
  };
}
