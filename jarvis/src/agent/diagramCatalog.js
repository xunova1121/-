import { diagramLines } from './diagramText.js';
import { DIAGRAM_ACCENTS, DIAGRAM_ICON_VERSION } from './diagramCards.js';

const invalid = message => Object.assign(new Error(message), { code: 'DIAGRAM_SECTION', kind: 'input' });
export const isCatalogModule = (layer, node) => layer.kind === 'catalog' && Array.isArray(layer.catalog?.primary) && Array.isArray(layer.catalog?.detailed) && !layer.catalog.primary.includes(node.id) && !layer.catalog.detailed.includes(node.id);
/** 独立受控组合层：最多18个同职责对象；主线最多3张，详细卡最多12张，其余只列组成及所属。 */
export function catalogFields(layer) {
  const value = layer.catalog, ids = new Set(layer.nodes.map(node => node.id));
  if (layer.role !== 'application' || layer.nodes.length < 8 || layer.nodes.length > 18 || !value || !Array.isArray(value.primary) || !Array.isArray(value.detailed) || value.primary.length > 3 || value.detailed.length > 12)
    throw invalid('业务组合层需8～18个业务对象，主线最多3张、详细卡最多12张');
  const selected = [...value.primary, ...value.detailed];
  if (new Set(selected).size !== selected.length || selected.some(id => typeof id !== 'string' || !ids.has(id))) throw invalid('业务组合层卡片编号重复或不存在');
  for (const node of layer.nodes) if (isCatalogModule(layer, node) && (node.detail || node.subtitle || node.icon || node.accent || node.bullets))
    throw invalid('组成模块只展示标题与所属，正文和图标需归入详细卡，不能静默丢弃');
  for (const node of layer.nodes) if (value.detailed.includes(node.id) && (node.subtitle || node.bullets)) throw invalid('组合详细卡需原职责说明，不支持另放副标题或要点');
  return { primary: [...value.primary], detailed: [...value.detailed] };
}

function summaryMetrics(node, width) {
  const titleWidth = width - 36 - (node.icon ? 38 : 0);
  const titleLines = diagramLines(node.title, titleWidth / 18, 3).length;
  const detailY = 30 + (titleLines - 1) * 25.2 + 25;
  const detailLines = node.detail ? diagramLines(node.detail, (width - 36) / 13, 7).length : 0;
  const body = detailY + Math.max(0, detailLines - 1) * 18.2 + 18;
  const badgeLines = node.badge ? diagramLines(node.badge, (width - 56) / 14, 2).length : 0;
  return { titleWidth, detailY, badgeLines, height: Math.ceil(Math.max(90, body) + (badgeLines ? badgeLines * 19.6 + 18 : 0)) };
}

/** 只在一个职责层里组合不同展示密度；坐标和字号仍由程序统一生成。 */
export function layoutCatalog(layer, y, edges, govBlue, layoutSection) {
  layer.y = y; layer.sideHeading = true; layer.parts = [];
  let cursor = y;
  const makePart = (ids, kind, title) => {
    const nodes = ids.map(id => layer.nodes.find(node => node.id === id));
    if (!nodes.length) return;
    const part = { kind, title, role: 'application', ...(layer.group ? { group: layer.group } : kind !== 'cards' ? { group: '__catalog__' } : {}), nodes, semanticRouting: layer.semanticRouting };
    if (kind === 'cards') layoutSection(part, cursor, edges, govBlue);
    else {
      part.y = cursor; part.sideHeading = true;
      const flow = kind === 'catalog-summary' && edges.some(edge => edge.label && nodes.some(node => node.id === edge.from));
      const columns = kind === 'catalog-summary' ? 3 : 6, gap = flow ? 112 : 12, rowGap = flow ? 64 : 8, width = (1128 - (columns - 1) * gap) / columns;
      const rows = Math.ceil(nodes.length / columns);
      const height = kind === 'catalog-summary' ? Math.max(...nodes.map(node => summaryMetrics(node, width).height)) : Math.max(...nodes.map(node => 44 + (node.badge ? diagramLines(node.badge, (width - 20) / 14, 2).length * 19.6 + 12 : 0)));
      for (const [index, node] of nodes.entries()) {
        if (kind === 'catalog-modules') diagramLines(node.title, (width - 20) / 14, 2);
        Object.assign(node, { x: 240 + index % columns * (width + gap), y: cursor + 16 + Math.floor(index / columns) * (height + rowGap), width, height });
      }
      part.height = Math.max(78, 16 + rows * height + (rows - 1) * rowGap + 16);
    }
    layer.parts.push(part); cursor += part.height + 12;
  };
  makePart(layer.catalog.primary, 'cards', layer.title + '｜业务主线');
  makePart(layer.catalog.detailed, 'catalog-summary', layer.title + '｜关联业务');
  makePart(layer.nodes.filter(node => isCatalogModule(layer, node)).map(node => node.id), 'catalog-modules', layer.title + '｜模块组成');
  layer.height = cursor - y - 12;
  return layer.height;
}

export function catalogElements(layer, colors, draw, sectionElements) {
  const { rect, text } = draw, children = [];
  if (!layer.group) children.push(rect(48, layer.y, 1344, layer.height, colors.surface, colors.line, 14));
  for (const part of layer.parts) {
    if (part.kind === 'cards') { children.push(...sectionElements(part, colors, draw)); continue; }
    const [heading, caption] = part.title.split('｜');
    children.push(text(heading, 72, part.y + 36, 150, 18, 3, colors.ink, true));
    children.push(text(caption, 72, part.y + 66, 150, 13, 2, colors.muted));
    for (const node of part.nodes) {
      const parts = [rect(node.x, node.y, node.width, node.height, colors.light, colors.line, 6)];
      if (part.kind === 'catalog-summary') {
        const metrics = summaryMetrics(node, node.width), accent = DIAGRAM_ACCENTS[node.accent] || colors.accent;
        if (node.icon) {
          parts.push(rect(node.x + 14, node.y + 14, 28, 28, accent, null, 7));
          parts.push({ type: 'icon', assetVersion: DIAGRAM_ICON_VERSION, icon: node.icon, x: node.x + 18, y: node.y + 18, width: 20, height: 20, fill: '#ffffff' });
        }
        parts.push(text(node.title, node.x + 18 + (node.icon ? 38 : 0), node.y + 30, metrics.titleWidth, 18, 3, colors.ink, true));
        if (node.detail) parts.push(text(node.detail, node.x + 18, node.y + metrics.detailY, node.width - 36, 13, 7, colors.muted));
      } else parts.push(text(node.title, node.x + 10, node.y + 23, node.width - 20, 14, 2, colors.ink, true));
      if (node.badge) {
        const lineCount = diagramLines(node.badge, (node.width - (part.kind === 'catalog-summary' ? 56 : 20)) / 14, 2).length;
        parts.push(text(node.badge, node.x + (part.kind === 'catalog-summary' ? 28 : 10), node.y + node.height - 14 - (lineCount - 1) * 19.6, node.width - (part.kind === 'catalog-summary' ? 56 : 20), 14, 2, colors.accent, true));
      }
      children.push({ type: 'group', nodeId: node.id, bounds: { x: node.x, y: node.y, width: node.width, height: node.height }, children: parts });
    }
  }
  return children;
}
