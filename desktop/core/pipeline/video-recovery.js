/**
 * 厂商异步视频任务的安全续跑决策。
 *
 * candidateShots 是本轮原本准备生成的镜头；freshShots 是免费重查后的最新项目状态。
 * 仍有 pendingTask 的镜头绝不能自动重提，否则一次网络查询失败就会造成重复计费。
 */
export function planVideoRecovery(candidateShots = [], freshShots = [], { regenerate = false } = {}) {
  const freshById = new Map((freshShots || []).map((shot) => [shot.id, shot]));
  const retryIds = [];
  const recoveredIds = [];
  const deferredIds = [];
  for (const candidate of candidateShots || []) {
    const shot = freshById.get(candidate.id) || candidate;
    if (shot.videoPath) recoveredIds.push(candidate.id);
    else if (!regenerate && shot.pendingTask) deferredIds.push(candidate.id);
    else retryIds.push(candidate.id);
  }
  return { retryIds, recoveredIds, deferredIds };
}
