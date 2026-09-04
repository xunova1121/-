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

/** 把厂商单次查询结果归一成稳定状态，避免“还在跑”和“接口暂时不可达”被误报为失败。 */
export function taskQueryOutcome(result = {}, error = null) {
  if (error) return { kind: 'unreachable', terminal: false, message: String(error.message || error || '查询失败') };
  if (result?.done && result?.url) return { kind: 'claimed', terminal: true, url: result.url, message: '任务完成' };
  if (result?.failed) return { kind: 'failed', terminal: true, message: String(result.reason || '厂商任务失败') };
  return { kind: 'pending', terminal: false, state: String(result?.state || 'pending'), message: String(result?.reason || '厂商仍在处理') };
}
