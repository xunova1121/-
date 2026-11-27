/**
 * 界面最上面的颜色（#RRGGBB），给状态栏下面的底色用：背景渐变取第一个颜色，没有渐变取背景色。
 * @param {{ backgroundImage?: string, backgroundColor?: string }} style getComputedStyle(document.body)
 */
export function topColor(style, fallback = '#DDE1FB') {
  const src = /gradient/.test(style.backgroundImage || '') ? style.backgroundImage : style.backgroundColor || '';
  const m = src.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return fallback;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
