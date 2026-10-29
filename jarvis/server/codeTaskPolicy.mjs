import { classifyTask } from '../src/llm/router.js';

export const CODE_TASK_MS = 15 * 60_000;
export const CODE_MAX_STEPS = 80;
const ACTION =
  /修复|修好|修改|改好|重构|开发|实现|新增|编写|写个|写一|跑|运行|执行|调试|测试|克隆|连接|拉取|检查|查看|读取|阅读|\b(?:fix|implement|refactor|clone|test|lint)\b/i;
const REPOSITORY = /仓库|GitHub|worktree|repo(?:sitory)?\b|代码|程序|前端|后端|bug|\.m?[jt]sx?\b|package\.json|npm\b|lint\b/i;
const BUILD_WEB = /^(?:请|帮我|给我|我想|需要|麻烦|先|现在|重新)?\s*(?:做|制作|搭建|开发|实现|编写|写)[^。！？\n]{0,30}(?:商城|电商|网站|网页|HTML|CSS)/i;
export const codeFollowup = text => {
  const explicit = /代码|仓库|商城|网页|项目|工作副本|截图|图片|lint|test|npm/i.test(text);
  if (/天气|新闻|闲聊|唱歌/.test(text) && !explicit) return false;
  return /^(?:继续|恢复|接着)/.test(text) && (/^(?:继续|恢复|接着)(?:吧|做吧|做|完成)?[。！!\s]*$/.test(text) || explicit || /原|刚才|上次|之前/.test(text));
};

/** 只给确实要动手的仓库任务放宽预算；寒暄/知识问答沿用旧值和旧路由。 */
export function codeTaskPolicy({ text, images = 0, hasRepos, hasProjects = false, projectBound = false, hasWorkspaces = false, resume, maxSteps = 28, codeMaxSteps = CODE_MAX_STEPS }) {
  const continuing =
    Boolean(resume?.codeTaskId || (resume?.taskId && ACTION.test(resume.text || '') && REPOSITORY.test(resume.text || '')) || hasWorkspaces) && codeFollowup(text);
  const buildingSite = BUILD_WEB.test(text) && !/架构图|流程图|思维导图|PPT|Word|Excel|文档|报告|海报/i.test(text);
  const creating = hasProjects && /(?:新建|创建|建立)[^。！？\n]{0,24}(?:项目|仓库|网站|商城)/i.test(text) && (!/Word|Excel|PPT|文档|报告|方案|架构图|流程图/i.test(text) || /GitHub|git仓库|代码项目/i.test(text));
  const inProject = projectBound && !/天气|新闻|唱歌|Word|Excel|PPT|架构图|文档/i.test(text) && (codeFollowup(text) || ACTION.test(text));
  const enabled = Boolean(creating || inProject || hasRepos && (continuing || buildingSite || (ACTION.test(text) && REPOSITORY.test(text))));
  return {
    enabled,
    kind: images ? 'vision' : enabled ? 'code' : classifyTask(text, { images }),
    maxSteps: enabled ? Math.max(1, Math.min(CODE_MAX_STEPS, Number(codeMaxSteps) || CODE_MAX_STEPS)) : maxSteps,
    ...(enabled && { maxTotalSteps: Math.max(1, Math.min(CODE_MAX_STEPS, Number(codeMaxSteps) || CODE_MAX_STEPS)) })
  };
}
