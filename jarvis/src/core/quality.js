/**
 * 画质档位：
 *   high      泛光 + 星尘 + 60fps
 *   standard  无泛光 + 星尘 + 60fps
 *   eco       省电：无泛光、无星尘、24fps
 *   auto      桌面高端 → high；移动端 / 低端 / 软件渲染 → standard（低端另外已把粒子降到 40%）
 * 移动端无论档位都上限 30fps；专注视图上限 20fps（需求 9.3 / 10）。
 */
export const QUALITY_LABELS = { auto: '自动', high: '高（泛光）', standard: '标准', eco: '省电' };

export function resolveQuality(setting, { lowEnd = false, isMobile = false, focusView = false, softwareRenderer = false } = {}) {
  let tier = setting;
  if (!['high', 'standard', 'eco'].includes(tier)) tier = lowEnd || isMobile || softwareRenderer ? 'standard' : 'high';
  const base = {
    high: { bloom: true, stars: true, fps: 60 },
    standard: { bloom: false, stars: true, fps: 60 },
    eco: { bloom: false, stars: false, fps: 24 }
  }[tier];
  let fps = base.fps;
  if (isMobile) fps = Math.min(fps, 30);
  if (focusView) fps = Math.min(fps, 20);
  return { tier, ...base, fps };
}
