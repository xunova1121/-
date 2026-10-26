import { diagramLines } from './diagramText.js';
import { cardMetrics, cardElements, isDiagramCard, DIAGRAM_ICON_VERSION, DIAGRAM_ACCENTS } from './diagramCards.js';

const invalid = (message) => Object.assign(new Error(message), { code: 'DIAGRAM_SECTION', kind: 'input' });
export const SECTION_KINDS = ['cards', 'band', 'grid', 'columns'];
/** 通栏文字距色条左右边的距离 */
const BAND_PAD = 16;
export function sectionFields(layer) {
  const kind = layer.kind === undefined ? 'cards' : layer.kind;
  if (!SECTION_KINDS.includes(kind)) throw invalid('层类型只支持cards/band/grid/columns');
  if (layer.group !== undefined && (typeof layer.group !== 'string' || !layer.group.trim() || [...layer.group].length > 48))
    throw invalid('平台分组名称需1～48字');
  const count = layer.nodes?.length;
  if (kind === 'grid' && (count < 8 || count > 18)) throw invalid('模块网格需8～18个节点');
  if (kind === 'columns' && (count < 2 || count > 4)) throw invalid('分栏层需2～4个节点');
  if (kind === 'band' && count !== 1) throw invalid('通栏层需一个内容节点');
  for (const node of layer.nodes || []) {
    if (!node || typeof node !== 'object') throw invalid('节点需为对象');
    if (kind === 'grid' && (node.detail || node.subtitle || isDiagramCard(node))) throw invalid('网格只展示标题，说明/图标/要点请移到能力层，不会静默丢弃');
    if (kind === 'band' && (node.subtitle || isDiagramCard(node))) throw invalid('通栏只支持内容标题和说明');
    if (kind === 'columns' && (node.bullets || node.badge)) throw invalid('分栏请用subtitle和detail，要点卡片请选cards');
    if (kind === 'cards' && node.subtitle) throw invalid('subtitle仅用于分栏层，请选columns或并入卡片说明');
    if (node.subtitle !== undefined && (typeof node.subtitle !== 'string' || !node.subtitle.trim() || [...node.subtitle].length > 48))
      throw invalid('分栏副标题需1～48字');
  }
  return { kind, ...(layer.group ? { group: layer.group.trim() } : {}) };
}

export function columnMetrics(node, width, compact = false) {
  const titleWidth = width - 36 - (node.icon ? 38 : 0);
  let cursor = (compact ? 35 : 30) + (diagramLines(node.title, titleWidth / 18, 2).length - 1) * 25.2;
  const subtitleY = cursor + 30;
  if (node.subtitle) cursor = subtitleY + (diagramLines(node.subtitle, (width - 36) / 14, 2).length - 1) * 19.6;
  const detailY = cursor + (node.icon && !node.subtitle ? 31 : 23);
  if (node.detail) cursor = detailY + (diagramLines(node.detail, (width - 36) / 13, 3).length - 1) * 18.2;
  return { titleWidth, subtitleY, detailY, height: Math.ceil(Math.max(compact ? 56 : 84, cursor + 18)) };
}
function sideHeight(layer) {
  const [heading, ...captions] = layer.title.split(/\s*[|｜·]\s*/);
  const count = diagramLines(heading, 150 / 18, captions.length ? 2 : 3).length;
  return captions.length ? 62 + (count - 1) * 25.2 + (diagramLines(captions.join(' · '), 150 / 13, 2).length - 1) * 18.2 + 12 : 36 + (count - 1) * 25.2 + 12;
}

/** 新组合层独立计算；旧主题的普通卡片继续走原布局，避免旧稿被统一重排。 */
export function layoutSection(layer, y, edges, govBlue) {
  const kind = layer.kind;
  if(layer.semanticRouting && kind==='cards' && layer.role!=='application') for(const node of layer.nodes) node.compactSummary=!node.bullets&&!node.badge;
  layer.y = y;
  layer.compact = kind === 'columns' && layer.nodes.every((node) => !node.subtitle && !node.detail);
  layer.sideHeading = Boolean(layer.group || kind === 'grid' || kind === 'band' || layer.compact);
  const x = layer.sideHeading ? 240 : 48;
  const totalWidth = layer.sideHeading ? 1128 : 1344;
  const flow = edges.some((edge) => edge.label && layer.nodes.some((node) => node.id === edge.from));
  let columns = Math.min(layer.nodes.length, kind === 'cards' ? 3 : 4);
  let gap = flow ? 112 : 16;
  let top = layer.sideHeading ? 16 : 38;
  let rowGap = 16;
  let rowHeight;
  if (kind === 'grid') {
    columns = 6;
    gap = 12;
    rowGap = 8;
    rowHeight = 44;
  }
  if (kind === 'band') {
    columns = 1;
    top = 0;
    const node = layer.nodes[0];
    // 通栏文字左右各留 BAND_PAD：贴着色条边写，字体稍宽的机器上首字会出框 1 像素（2026-10-26 CI 实测）
    rowHeight = Math.max(48, 18 + diagramLines([node.title, node.detail].filter(Boolean).join(' · '), (totalWidth - BAND_PAD * 2) / 15, 2).length * 21);
  }
  const width = (totalWidth - (columns - 1) * gap) / columns;
  layer.rows = Math.ceil(layer.nodes.length / columns);
  if (kind === 'columns') {
    top = layer.compact ? 0 : top;
    rowHeight = Math.max(...layer.nodes.map((node) => columnMetrics(node, width, layer.compact).height));
  }
  if (kind === 'cards') {
    rowHeight = Math.max(
      ...layer.nodes.map((node) => {
        node.compactLayout = govBlue;
        return isDiagramCard(node) && !node.compactSummary ? cardMetrics(node, width, { compact: govBlue }).height : columnMetrics(node, width).height;
      })
    );
  }
  for (const [index, node] of layer.nodes.entries()) {
    if (kind === 'grid') diagramLines(node.title, (width - 20) / 14, 2);
    Object.assign(node, {
      x: x + (index % columns) * (width + gap),
      y: y + top + Math.floor(index / columns) * (rowHeight + rowGap),
      width,
      height: rowHeight
    });
  }
  layer.height = top + layer.rows * rowHeight + (layer.rows - 1) * rowGap + (kind === 'band' || layer.compact ? 0 : 16);
  if (layer.sideHeading && kind !== 'band') layer.height = Math.max(layer.height, sideHeight(layer));
  return layer.height;
}

export function centerText(content, y, width, fontSize, fill, bold, text, { left = 0, inset = 48 } = {}) {
  const element = text(content, left + inset, y, width - inset * 2, fontSize, 2, fill, bold);
  return element.lines.map((line) => {
    const measured = [...line.text].reduce((sum, letter) => sum + (/[\u0000-\u007f]/.test(letter) ? 0.58 : 1), 0) * fontSize;
    return { ...element, width: measured + 2, lines: [{ ...line, x: left + (width - measured) / 2 }] };
  });
}
export function sectionElements(layer, colors, { rect, text }) {
  const children = [];
  if (layer.kind === 'band' || (!layer.group && (layer.kind === 'grid' || layer.compact)))
    children.push(
      rect(
        48,
        layer.y,
        1344,
        layer.height,
        layer.kind === 'band' ? (layer.emphasis ? colors.ink : colors.accent) : colors.surface,
        layer.kind === 'band' ? null : colors.line,
        layer.kind === 'band' ? 4 : 14
      )
    );
  const [heading, ...captions] = layer.title.split(/\s*[|｜·]\s*/);
  if (layer.kind === 'band') {
    children.push(text(layer.title, 68, layer.y + 30, 150, 16, 1, '#ffffff', true));
  } else if (layer.sideHeading) {
    const lines = diagramLines(heading, 150 / 18, captions.length ? 2 : 3).length;
    children.push(text(heading, 72, layer.y + 36, 150, 18, captions.length ? 2 : 3, colors.ink, true));
    if (captions.length) children.push(text(captions.join(' · '), 72, layer.y + 62 + (lines - 1) * 25.2, 150, 13, 2, colors.muted));
  } else children.push(...centerText(layer.title, layer.y + 24, 1440, 17, colors.ink, true, text));
  for (const node of layer.nodes) {
    const parts = [];
    if (layer.kind === 'cards' && isDiagramCard(node) && !node.compactSummary) parts.push(...cardElements(node, colors, { rect, text }));
    if (layer.kind === 'band') parts.push(text([node.title, node.detail].filter(Boolean).join(' · '), node.x + BAND_PAD, node.y + 29, node.width - BAND_PAD * 2, 15, 2, '#ffffff', true));
    if (layer.kind === 'grid') {
      parts.push(rect(node.x, node.y, node.width, node.height, colors.light, colors.line, 4));
      const lineCount = diagramLines(node.title, (node.width - 20) / 14, 2).length;
      parts.push(...centerText(node.title, node.y + (lineCount === 1 ? 27 : 18), node.width, 14, colors.ink, true, text, { left: node.x, inset: 10 }));
    }
    if (layer.kind === 'columns' || (layer.kind === 'cards' && !isDiagramCard(node))) {
      const metrics = columnMetrics(node, node.width, layer.compact);
      const accent = DIAGRAM_ACCENTS[node.accent] || colors.accent;
      if (!layer.compact)
        parts.push(
          rect(
            node.x,
            node.y,
            node.width,
            node.height,
            layer.compact ? colors.surface : layer.group ? colors.light : '#ffffff',
            layer.compact ? null : colors.line,
            8
          )
        );
      if (node.icon) {
        parts.push(rect(node.x + 14, node.y + 14, 28, 28, accent, null, 7));
        parts.push({
          type: 'icon',
          assetVersion: DIAGRAM_ICON_VERSION,
          icon: node.icon,
          x: node.x + 18,
          y: node.y + 18,
          width: 20,
          height: 20,
          fill: '#ffffff'
        });
      }
      parts.push(
        text(
          node.title,
          node.x + 18 + (node.icon ? 38 : 0),
          node.y + (layer.compact ? 35 : 30),
          metrics.titleWidth,
          18,
          2,
          node.accent ? accent : colors.ink,
          true
        )
      );
      if (node.subtitle) parts.push(text(node.subtitle, node.x + 18, node.y + metrics.subtitleY, node.width - 36, 14, 2, accent, true));
      if (node.detail) parts.push(text(node.detail, node.x + 18, node.y + metrics.detailY, node.width - 36, 13, 3, colors.muted));
    }
    children.push({ type: 'group', nodeId: node.id, children: parts });
  }
  return children;
}
