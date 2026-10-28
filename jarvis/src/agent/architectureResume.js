import * as workspace from './workspace.js';
import { loadArchitecture } from './architectureProjection.js';
import { reviewArchitecture } from './architectureReview.js';
import { throwControl } from '../core/networkRequest.js';
import { architectureMarkdown } from './architecturePlan.js';

// 最多16个并发底稿，不合并不同任务的停止信号；每份底稿仅恢复一次并提前落盘。
const active = new Set();
export async function resumeArchitectureReview(ctx, bundle, options = {}) {
  if (bundle.report.structure !== 'passed' || bundle.report.semantic !== 'not_checked') return bundle;
  if (!ctx.reasonLlm && !ctx.llm) return bundle;
  if (bundle.report.errorCode === 'ARCHITECTURE_REVIEW_SIZE') return bundle;
  if (active.has(bundle.path) || active.size >= 16)
    throw Object.assign(new Error('该底稿正在审查，请勿同时重复提交'), { code: 'ARCHITECTURE_REVIEW_BUSY', kind: 'api' });
  active.add(bundle.path);
  try {
    throwControl(null, options.signal);
    // 获取并发占位后再读持久状态，另一个请求可能已经完成恢复，不能拿旧bundle重置次数。
    bundle = await loadArchitecture(bundle.path, options.signal);
    if (bundle.report.structure !== 'passed' || bundle.report.semantic !== 'not_checked' || bundle.report.resumeAttempts >= 1) return bundle;
    await workspace.write(bundle.reviewPath, JSON.stringify({ ...bundle.report, resumeAttempts: 1 }));
    options.progress?.('沿用已有底稿，恢复业务审查（最多一次）…');
    // 推理分工未完成时仅恢复一次到已配置写作分工，不暗中换第三方服务商。
    const reviewer = ctx.reasonLlm && ctx.llm ? { ...ctx, reasonLlm: null } : ctx;
    const report = await reviewArchitecture(reviewer, bundle.plan, {
      ...options,
      reviewPath: bundle.reviewPath,
      reviewAttempt: 1,
      materials: bundle.materials,
      recoveryReason: bundle.report.errorCode || '前次审查未完成；沿用本底稿重新审查，仅返回约定JSON'
    });
    throwControl(null, options.signal);
    await workspace.write(bundle.reviewPath, JSON.stringify({ ...report, planHash: bundle.planHash, resumeAttempts: 1 }));
    ctx.onFileChanged?.(bundle.reviewPath);
    // 审查期间材料或底稿可能改变，出图前重新核对摘要，不能用旧结果覆盖新内容。
    const current = await loadArchitecture(bundle.path, options.signal);
    const markdownPath = bundle.path.replace(/\.architecture\.json$/, '.md');
    await workspace.write(markdownPath, architectureMarkdown({ ...current.plan, semantic: current.report.semantic }));
    ctx.onFileChanged?.(markdownPath);
    return current;
  } finally {
    active.delete(bundle.path);
  }
}
