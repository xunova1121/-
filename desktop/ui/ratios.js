/**
 * 影片比例（画幅）。
 *
 * 单独抽出来，是因为它在三个地方要**保持一致**：新建项目、项目卡片、全局设置。
 * 三处各写一份列表，迟早出现"设置里有 21:9，新建项目里没有"这种事。
 *
 * 顺序是按实际用得多少排的：横屏和竖屏占了绝大多数，摆前面。
 */
import { h } from './lib.js';

export const RATIOS = [
  { id: '16:9', label: '16:9 横屏', hint: '宣传片、纪录片、常规影视' },
  { id: '9:16', label: '9:16 竖屏', hint: '短剧、抖音 / 视频号' },
  { id: '1:1', label: '1:1 方形', hint: '朋友圈、封面图' },
  { id: '4:3', label: '4:3 传统', hint: '老电视、复古质感' },
  { id: '21:9', label: '21:9 宽银幕', hint: '电影感横幅' }
];

export const RATIO_IDS = RATIOS.map((r) => r.id);

/** 显示用短名，项目卡片上的小标签用它 */
export function ratioLabel(id) {
  if (!id) return '';
  return RATIOS.find((r) => r.id === id)?.label || id;
}

/**
 * 画一个比例示意小方块。选比例时给一眼看得出的形状，
 * 比五个长得一样的下拉选项好判断得多。
 */
export function ratioBox(id, box = 34) {
  const [w, hh] = String(id || '16:9').split(':').map(Number);
  const scale = w >= hh ? box / w : box / hh;
  return { w: Math.round(w * scale), h: Math.round(hh * scale) };
}

/**
 * 比例选择器：一排会按真实比例变形的小方块。
 *
 * `allowInherit` 给的是"跟随设置"这一项 —— 项目上留空就用全局默认，
 * 这样老项目不会因为多了这个字段而被迫立刻选一个。
 */
export function ratioPicker(current, onPick, { allowInherit = false, fallback = '16:9' } = {}) {
  const row = h('div', { class: 'ratio-row' });
  const items = allowInherit
    ? [{ id: '', label: '跟随设置', hint: `当前默认 ${fallback}` }, ...RATIOS]
    : RATIOS;

  for (const r of items) {
    const shape = ratioBox(r.id || fallback);
    const card = h('button', {
      class: `ratio-card ${r.id === (current || '') ? 'active' : ''}`,
      type: 'button',
      title: r.hint,
      onclick: () => {
        onPick(r.id);
        for (const el of row.children) el.classList.remove('active');
        card.classList.add('active');
      }
    },
    h('span', { class: 'ratio-slot' },
      h('span', { class: `ratio-shape ${r.id ? '' : 'inherit'}`, style: `width:${shape.w}px;height:${shape.h}px` })),
    h('span', { class: 'ratio-label' }, r.label),
    h('span', { class: 'ratio-hint' }, r.hint));
    row.append(card);
  }
  return row;
}
