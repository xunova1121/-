/**
 * 屏幕常亮的规则（纯函数，三端共用）：
 *   smart  智能（默认）：未央说话、开着语音对话时屏幕不灭；亮着超过 30 秒没碰就调暗省电，点一下恢复。
 *          干长任务时不管屏幕：允许熄屏，任务在后台继续，做完发通知
 *   always 一直常亮：App 在前台就不灭，也不调暗
 *   system 跟随系统：不管屏幕
 */
export const SCREEN_MODES = ['smart', 'always', 'system'];
export const DIM_AFTER_MS = 30_000;

/**
 * @param {{ mode?: string, talking?: boolean, idleMs?: number, foreground?: boolean }} o
 * @returns {{ keep: boolean, dim: boolean }}
 */
export function screenPlan({ mode = 'smart', talking = false, idleMs = 0, foreground = true } = {}) {
  if (!foreground || mode === 'system') return { keep: false, dim: false };
  if (mode === 'always') return { keep: true, dim: false };
  const keep = Boolean(talking);
  return { keep, dim: keep && idleMs >= DIM_AFTER_MS };
}
