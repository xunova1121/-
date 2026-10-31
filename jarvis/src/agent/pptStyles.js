/**
 * PPT 设计风格：同一份内容按不同风格画，构图真的不一样，不只是换颜色。
 * 配色仍来自主题（themes.js），风格决定底色、标题栏、卡片、图标、封面和章节页的画法。
 *
 *   business  稳重商务：浅底、左上标题、白卡片带淡阴影、圆形图标、左侧深色块封面（原来的样子）
 *   minimal   简洁留白：纯白底、大标题配一道短线、不用卡片阴影，用细线和编号分隔；封面大字留白
 *   story     叙事氛围：整页深色底、楷体标题、金色点缀和细线框、章节编号“壹贰叁”；适合剧情、人物、历史、文化
 *   data      数据报告：顶部色带标题、直角浅灰面板、紧凑网格；数字和图表优先，适合经营、财务、统计
 */

/** 颜色混合：a 和 b 按 t（0–1，越大越接近 b）混 */
export function mix(a, b, t) {
  const p = (c) => [0, 2, 4].map((i) => parseInt(String(c).slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
}
const lum = (c) => { const [r, g, b] = [0, 2, 4].map((i) => parseInt(String(c).slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

export const STYLE_IDS = ['business', 'minimal', 'story', 'data'];
export const STYLE_NAMES = { business: '稳重商务', minimal: '简洁留白', story: '叙事氛围', data: '数据报告' };

/**
 * 按主题配色算出这种风格的全部设计规范
 * @param {string} id  风格
 * @param {object} theme  themes.js 的主题
 */
export function styleTokens(id, theme) {
  const C = theme.colors;
  const official = Boolean(theme.official);
  const base = {
    id: 'business', name: STYLE_NAMES.business,
    font: '微软雅黑', headFont: '微软雅黑',
    bg: official ? 'FFFFFF' : 'F7F9FC',
    surface: 'FFFFFF', border: 'E3E8F0', shadow: true, radius: 0.06,
    head: C.primary, text: C.ink, sub: '5B6577', muted: '8A94A6',
    accent: C.accent, strong: C.primary, onStrong: 'FFFFFF', gold: official ? 'C00000' : C.extra,
    soft: C.soft, track: 'E9EDF3', grid: 'E5E8EC',
    titleBar: 'plain', icon: 'circle', cover: 'split', section: 'dark', chapter: 'number',
    titleSize: 24, ornament: true, footer: true
  };
  if (official || id === 'business' || !STYLE_IDS.includes(id)) return base;
  if (id === 'minimal') {
    return {
      ...base, id, name: STYLE_NAMES.minimal,
      bg: 'FFFFFF', surface: 'FFFFFF', border: mix(C.accent, 'FFFFFF', 0.78), shadow: false, radius: 0,
      soft: mix(C.soft, 'FFFFFF', 0.4), strong: C.primary,
      titleBar: 'rule', icon: 'number', cover: 'airy', section: 'light', titleSize: 28, ornament: false
    };
  }
  if (id === 'data') {
    return {
      ...base, id, name: STYLE_NAMES.data,
      bg: 'FFFFFF', surface: 'F4F6F9', border: 'DDE3EA', shadow: false, radius: 0,
      titleBar: 'band', icon: 'square', cover: 'band', section: 'band', titleSize: 22, ornament: false
    };
  }
  // story：主题深色太浅时压暗，保证整页深底上的字看得清
  const deep = lum(C.primary) > 0.28 ? mix(C.primary, '000000', 0.55) : mix(C.primary, '000000', 0.25);
  const gold = lum(C.extra) < 0.35 ? mix(C.extra, 'FFFFFF', 0.45) : C.extra;
  return {
    ...base, id, name: STYLE_NAMES.story,
    headFont: '楷体',
    bg: deep, surface: mix(deep, 'FFFFFF', 0.07), border: mix(deep, gold, 0.45), shadow: false, radius: 0.02,
    head: 'F4EFE4', text: 'E9E4D8', sub: 'BDB6A8', muted: mix(deep, 'FFFFFF', 0.45),
    accent: gold, strong: mix(deep, gold, 0.22), onStrong: 'F4EFE4', gold,
    soft: mix(deep, 'FFFFFF', 0.1), track: mix(deep, 'FFFFFF', 0.16), grid: mix(deep, 'FFFFFF', 0.18),
    titleBar: 'story', icon: 'ring', cover: 'centered', section: 'story', chapter: 'hanzi', titleSize: 26, ornament: true
  };
}

const HANZI = ['壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖', '拾'];
/** 章节编号：01 / 壹 */
export const chapterMark = (t, k) => (t.chapter === 'hanzi' ? HANZI[k] ?? String(k + 1) : String(k + 1).padStart(2, '0'));
