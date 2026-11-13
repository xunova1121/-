import { DIAGRAM_ICON_ASSETS } from './diagramIconAssets.js';
import { diagramLines } from './diagramText.js';

export const DIAGRAM_ICON_VERSION = 'lucide-0.577.0';
export const DIAGRAM_ICONS = Object.keys(DIAGRAM_ICON_ASSETS);
export const DIAGRAM_ACCENTS = { orange: '#bd6200', blue: '#007fc4', green: '#00856b' };
const invalid = (message) => Object.assign(new Error(message), { code: 'DIAGRAM_CARD', kind: 'input' });
const field = (value, max, label) => {
  // 写清上限和当前字数，模型一次就能改对（以前只说“为空或过长”，模型自己猜成8字反复重试）
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${label}不能为空（不需要就不填这个字段）`);
  if ([...value].length > max) throw invalid(`${label}最多${max}字，当前${[...value].length}字`);
  return value.trim();
};
export function cardFields(node) {
  const result = {};
  if (node.icon !== undefined) {
    if (!DIAGRAM_ICONS.includes(node.icon)) throw invalid('请选择受支持的Lucide图标');
    result.icon = node.icon;
  }
  if (node.accent !== undefined) {
    if (!Object.hasOwn(DIAGRAM_ACCENTS, node.accent)) throw invalid('强调色仅支持orange/blue/green');
    result.accent = node.accent;
  }
  if (node.badge !== undefined) result.badge = field(node.badge, 28, '卡片标签');
  if (node.bullets !== undefined) {
    if (!Array.isArray(node.bullets) || node.bullets.length < 2 || node.bullets.length > 5) throw invalid('卡片要点需2～5条');
    result.bullets = node.bullets.map((item) => {
      if (!item || typeof item !== 'object') throw invalid('要点需text及可选icon');
      const bullet = { text: field(item.text, 80, '要点') };
      if (item.icon !== undefined) {
        if (!DIAGRAM_ICONS.includes(item.icon)) throw invalid('要点图标不受支持');
        bullet.icon = item.icon;
      }
      return bullet;
    });
  }
  return result;
}
export const isDiagramCard = (node) => Boolean(node.icon || node.accent || node.badge || node.bullets);

/** 量文字与真正绘制共用同一套换行；不为压高度截断要点。 */
export function cardMetrics(node, width, { compact = false } = {}) {
  const titleWidth = width - 44 - (node.icon ? 60 : 0);
  const titleLines = diagramLines(node.title, titleWidth / 24, 2);
  let cursor = Math.max(compact ? 84 : 76, 28 + titleLines.length * 33.6);
  const detailY = cursor + 10;
  if (node.detail) cursor = detailY + diagramLines(node.detail, (width - 44) / 15, 3).length * 21;
  const bullets = (node.bullets || []).map((bullet) => {
    const y = cursor + (compact ? 6 : 15);
    cursor = y + Math.max(compact ? 18 : 24, diagramLines(bullet.text, (width - 76) / 15, 2).length * 21 + (compact ? 0 : 4));
    return { ...bullet, y };
  });
  return {
    titleWidth,
    detailY,
    bullets,
    height: Math.ceil(Math.max(compact ? 160 : 180, cursor + (compact ? 14 : 20) + (node.badge ? (compact ? 42 : 46) : 0)))
  };
}

export function cardElements(node, colors, { rect, text }) {
  const accent = DIAGRAM_ACCENTS[node.accent] || colors.accent;
  const metrics = cardMetrics(node, node.width, { compact: node.compactLayout === true });
  const children = [rect(node.x, node.y, node.width, node.height, '#ffffff', colors.line, 16, 1.5)];
  if (node.icon) {
    children.push(rect(node.x + 20, node.y + 22, 44, 44, accent, null, 22));
    children.push({
      type: 'icon',
      assetVersion: DIAGRAM_ICON_VERSION,
      icon: node.icon,
      x: node.x + 30,
      y: node.y + 32,
      width: 24,
      height: 24,
      fill: '#ffffff'
    });
  }
  children.push(text(node.title, node.x + 22 + (node.icon ? 60 : 0), node.y + 46, metrics.titleWidth, 24, 2, accent, true));
  if (node.detail) children.push(text(node.detail, node.x + 22, node.y + metrics.detailY, node.width - 44, 15, 3, colors.muted));
  for (const bullet of metrics.bullets) {
    if (bullet.icon) {
      children.push(rect(node.x + 22, node.y + bullet.y - 15, 19, 19, accent, null, 4));
      children.push({
        type: 'icon',
        assetVersion: DIAGRAM_ICON_VERSION,
        icon: bullet.icon,
        x: node.x + 24,
        y: node.y + bullet.y - 13,
        width: 15,
        height: 15,
        fill: '#ffffff'
      });
    } else children.push(rect(node.x + 28, node.y + bullet.y - 7, 5, 5, accent, null, 2));
    children.push(text(bullet.text, node.x + 52, node.y + bullet.y, node.width - 76, 15, 2, colors.ink));
  }
  if (node.badge) {
    children.push(rect(node.x + 20, node.y + node.height - 46, node.width - 40, 30, accent, null, 4));
    children.push(text(node.badge, node.x + 34, node.y + node.height - 25, node.width - 68, 14, 1, '#ffffff', true));
  }
  return children;
}
