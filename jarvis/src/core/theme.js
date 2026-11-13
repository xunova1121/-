/**
 * 界面明暗：time（7:00–19:00 白天）/ system（跟随系统）/ day / night
 */
export const THEMES = { time: '按时间', system: '跟随系统', day: '白天', night: '夜间' };

export function resolveTheme(mode, { hour = new Date().getHours(), prefersLight = false } = {}) {
  if (mode === 'day') return 'light';
  if (mode === 'night') return 'dark';
  if (mode === 'system') return prefersLight ? 'light' : 'dark';
  return hour >= 7 && hour < 19 ? 'light' : 'dark';
}

/** 顶栏按钮：在“白天 / 夜间”之间切换（切换后固定，不再按时间变） */
export const toggled = (current) => (current === 'light' ? 'night' : 'day');
