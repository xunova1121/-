import { sectionElements, centerText } from './diagramSections.js';
import { cardElements, isDiagramCard, DIAGRAM_ACCENTS, DIAGRAM_ICONS, DIAGRAM_ICON_VERSION } from './diagramCards.js';
import { diagramLines } from './diagramText.js';
import { diagramRoutes } from './diagramRoutes.js';

export const DIAGRAM_SCENE_VERSION = 1;
const palettes = {
  'gov-blue': { ink: '#123b69', muted: '#547393', line: '#b7d7eb', surface: '#ffffff', accent: '#087fca', wash: '#eff8ff', light: '#e7f3fc' },
  navy: { ink: '#142c49', muted: '#5b6d80', line: '#dbe4ed', surface: '#f7f9fc', accent: '#174a78', wash: '#edf3f9', light: '#e2edf6' },
  jade: { ink: '#173a38', muted: '#57716c', line: '#d9e5df', surface: '#f8faf8', accent: '#246452', wash: '#edf5ef', light: '#e4f1e9' },
  charcoal: { ink: '#292f38', muted: '#68717d', line: '#dfe3e8', surface: '#fafafa', accent: '#333f50', wash: '#eef1f5', light: '#e7ebf1' }
};

/** 绝对坐标与逐行文字只在这里生成；SVG/PPT禁止各自换行或重新排版。 */
export function diagramScene(model, design = {}) {
  const theme = design.theme || (model.structured ? 'gov-blue' : 'navy');
  const colors = palettes[theme];
  if (!colors) throw Object.assign(new Error('不支持的图形主题'), { code: 'DIAGRAM_THEME', kind: 'input' });
  const elements = [];
  const rect = (x, y, width, height, fill, stroke, radius = 12, strokeWidth = 1) => ({ type: 'rect', x, y, width, height, fill, stroke, radius, strokeWidth });
  const text = (content, x, y, width, fontSize, maxLines, fill, bold = false) => ({
    type: 'text',
    x,
    y,
    width,
    fontSize,
    fill,
    bold,
    lines: diagramLines(content, width / fontSize, maxLines).map((value, index) => ({ text: value, x, y: y + index * fontSize * 1.4 }))
  });
  elements.push(rect(0, 0, model.width, model.height, theme === 'gov-blue' ? colors.wash : '#ffffff', null, 0));
  if (theme === 'gov-blue') {
    elements.push(...centerText(model.title, 54, 1440, 32, colors.ink, true, text));
    if (design.message)
      elements.push(...centerText(String(design.message), diagramLines(model.title, 1344 / 32, 2).length > 1 ? 128 : 88, 1440, 16, colors.accent, true, text));
  } else {
    elements.push(text(model.title, 48, 54, model.width - 96, 30, 2, colors.ink, true));
    if (design.message) elements.push(text(String(design.message), 48, [...model.title].length > 44 ? 128 : 88, model.width - 96, 14, 1, colors.muted));
  }
  const containers = new Map();
  const groupNames = [...new Set(model.layers.map((layer) => layer.group).filter(Boolean))];
  for (const group of groupNames) {
    const layers = model.layers.filter((layer) => layer.group === group);
    const y = layers[0].y - 52;
    const height = layers.at(-1).y + layers.at(-1).height + 12 - y;
    const body = [
      rect(36, y, 1368, height, '#ffffff', colors.line, 24, 1.5),
      rect(36, y, 1368, 44, colors.light, colors.line, 20),
      ...centerText(group, y + 29, 1440, 22, colors.ink, true, text)
    ];
    if (model.semanticRouting) {
      const container = { type: 'group', containerId: '平台 ' + group, children: body };
      containers.set(group, container);
      elements.push(container);
    } else elements.push(...body);
  }
  for (const layer of model.layers) {
    if (model.structured) {
      const section = { type: 'group', layer: layer.title, children: sectionElements(layer, colors, { rect, text }) };
      if (model.semanticRouting && layer.group) containers.get(layer.group).children.push(section);
      else elements.push(section);
      continue;
    }
    const children = [
      rect(
        48,
        layer.y,
        1344,
        layer.height,
        layer.emphasis ? colors.wash : colors.surface,
        layer.emphasis ? colors.accent : colors.line,
        12,
        layer.emphasis ? 1.5 : 1
      )
    ];
    const [heading, ...captions] = layer.title.split(/\s*[|｜·]\s*/);
    const caption = captions.join(' · ');
    const headingLines = diagramLines(heading, 150 / 18, caption ? 2 : 3).length;
    children.push(text(heading, 72, layer.y + 36, 150, 18, caption ? 2 : 3, colors.ink, true));
    if (caption) children.push(text(caption, 72, layer.y + 62 + (headingLines - 1) * 25.2, 150, 13, 2, colors.muted));
    for (const node of layer.nodes) {
      if (isDiagramCard(node)) {
        children.push({
          type: 'group',
          nodeId: node.id,
          bounds: { x: node.x, y: node.y, width: node.width, height: node.height },
          children: cardElements(node, colors, { rect, text })
        });
        continue;
      }
      const nodeChildren = [rect(node.x, node.y, node.width, node.height, layer.emphasis ? colors.accent : '#ffffff', null)];
      nodeChildren.push(text(node.title, node.x + 18, node.y + 30, node.width - 36, 20, 2, layer.emphasis ? '#ffffff' : colors.ink, true));
      if (node.detail)
        nodeChildren.push(
          text(
            node.detail,
            node.x + 18,
            node.y + 30 + diagramLines(node.title, (node.width - 36) / 20, 2).length * 28 + 4,
            node.width - 36,
            15,
            3,
            layer.emphasis ? colors.light : colors.muted
          )
        );
      children.push({ type: 'group', nodeId: node.id, bounds: { x: node.x, y: node.y, width: node.width, height: node.height }, children: nodeChildren });
    }
    elements.push({ type: 'group', layer: layer.title, children });
  }
  for (const edge of diagramRoutes(model)) {
    const from = model.nodes.find((node) => node.id === edge.from);
    const stroke = edge.type
      ? model.monochrome
        ? colors.accent
        : { supports: '#6683a4', dataflow: '#00856b', workflow: '#087fca', feedback: '#bd6200' }[edge.type]
      : edge.label
        ? DIAGRAM_ACCENTS[from.accent] || colors.accent
        : '#8291ad';
    elements.push({
      type: 'path',
      points: edge.points,
      from: edge.from,
      to: edge.to,
      stroke,
      strokeWidth: edge.label ? 3 : 1.6,
      arrow: true,
      ...(edge.type && {
        relationType: edge.type,
        meaning: edge.meaning,
        relationId: edge.relationId,
        ...(edge.type === 'supports' ? { dash: 'dash' } : edge.type === 'feedback' ? { dash: 'dot' } : {})
      })
    });
    if (edge.labelPosition)
      elements.push(text(edge.label, edge.labelPosition.x, edge.labelPosition.y, edge.labelPosition.width, 12, edge.labelPosition.maxLines || 1, stroke, true));
    else if (edge.label) {
      const left = Math.min(...edge.points.map((point) => point.x));
      const width = Math.abs(edge.points[1].x - edge.points[0].x);
      elements.push(text(edge.label, left + 6, edge.points[0].y - 36, width - 12, 12, 2, stroke, true));
    }
  }
  if (model.semanticRouting) {
    const notes = {
      overview: '总览：容器或编号表示归属；文字说明支撑；箭头表示业务主链；数据传输见数据流视图',
      workflow: '业务闭环视图：实线为业务推进，点线为已登记反馈；不表示数据传输或支撑依赖',
      dataflow: '数据流视图：箭头只表示已登记的数据传输；业务过程与支撑依赖见其他视图'
    };
    elements.push(
      text(
        notes[model.architectureView] ||
          (model.monochrome
            ? '业务/数据流为实线，支撑为虚线，反馈为点线；具体关系见底稿表；所属用容器或系统编号表达'
            : '关系类型：蓝色业务流 · 绿色数据流 · 灰蓝虚线支撑 · 橙色点线反馈；所属用容器或系统编号表达'),
        48,
        model.height - 18,
        1344,
        12,
        1,
        colors.muted
      )
    );
  }

  if (!model.edges.length && !model.structured) {
    for (let index = 1; index < model.layers.length; index++) {
      const upper = model.layers[index - 1];
      const lower = model.layers[index];
      elements.push({
        type: 'path',
        points: [
          { x: 804, y: lower.y - 4 },
          { x: 804, y: upper.y + upper.height + 6 }
        ],
        stroke: '#8291ad',
        strokeWidth: 1.6,
        arrow: true
      });
      elements.push(text('支撑', 822, lower.y - 12, 80, 12, 1, colors.muted));
    }
  }
  return {
    version: DIAGRAM_SCENE_VERSION,
    design: { theme, message: String(design.message || '').slice(0, 100), audience: String(design.audience || '').slice(0, 80) },
    title: model.title,
    width: model.width,
    height: model.height,
    fontFace: model.semanticRouting ? 'Noto Sans CJK SC' : 'Microsoft YaHei',
    fontFamily: model.semanticRouting ? 'Noto Sans CJK SC, Microsoft YaHei, sans-serif' : 'Microsoft YaHei, Noto Sans CJK SC, sans-serif',
    elements
  };
}

export function sceneElements(scene) {
  const result = [];
  const visit = (elements, depth = 0) => {
    if (!Array.isArray(elements) || depth > 16) throw Object.assign(new Error('设计稿分组无效或超过16层'), { code: 'DIAGRAM_SCENE_SIZE', kind: 'input' });
    for (const element of elements) {
      if (!element || typeof element !== 'object' || result.length >= 2000)
        throw Object.assign(new Error('设计稿元素无效或超过2000'), { code: 'DIAGRAM_SCENE_SIZE', kind: 'input' });
      result.push(element);
      if (element.type === 'group') visit(element.children, depth + 1);
    }
  };
  visit(scene.elements);
  return result;
}

export function validateScene(scene) {
  if (
    scene?.version !== DIAGRAM_SCENE_VERSION ||
    ![scene.width, scene.height].every((value) => Number.isFinite(value) && value > 0 && value <= 12000) ||
    scene.width * scene.height > 25e6 ||
    !Array.isArray(scene.elements)
  )
    throw Object.assign(new Error('图形设计稿版本或画布无效'), { code: 'DIAGRAM_SCENE', kind: 'input' });
  const invalid = (message) => Object.assign(new Error(message), { code: 'DIAGRAM_SCENE', kind: 'input' });
  if (
    typeof scene.title !== 'string' ||
    scene.title.length > 160 ||
    !(
      (scene.fontFace === 'Microsoft YaHei' && scene.fontFamily === 'Microsoft YaHei, Noto Sans CJK SC, sans-serif') ||
      (scene.fontFace === 'Noto Sans CJK SC' && scene.fontFamily === 'Noto Sans CJK SC, Microsoft YaHei, sans-serif')
    )
  )
    throw invalid('设计稿标题或字体无效');
  const color = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  let iconCount = 0;
  for (const item of sceneElements(scene)) {
    if (!['rect', 'text', 'path', 'group', 'icon'].includes(item.type)) throw invalid('设计稿含不支持的元素');
    if (item.type === 'group') {
      if (
        item.bounds &&
        (!['x', 'y', 'width', 'height'].every((key) => Number.isFinite(item.bounds[key])) ||
          item.bounds.x < 0 ||
          item.bounds.y < 0 ||
          item.bounds.width <= 0 ||
          item.bounds.height <= 0 ||
          item.bounds.x + item.bounds.width > scene.width ||
          item.bounds.y + item.bounds.height > scene.height)
      )
        throw invalid('节点分组边界无效');
      if (item.containerId !== undefined && (typeof item.containerId !== 'string' || item.containerId.length > 160)) throw invalid('平台分组标识无效');
      if ([item.nodeId, item.layer].some((value) => value != null && (typeof value !== 'string' || value.length > 160))) throw invalid('分组标识无效');
      continue;
    }
    if (item.type !== 'path' && !color(item.fill)) throw invalid('设计稿填色无效');
    if (
      item.type === 'icon' &&
      (++iconCount > 48 ||
        item.assetVersion !== DIAGRAM_ICON_VERSION ||
        !DIAGRAM_ICONS.includes(item.icon) ||
        !Number.isFinite(item.width) ||
        item.width < 12 ||
        item.width > 64 ||
        item.height !== item.width ||
        item.fill !== '#ffffff')
    )
      throw invalid('图标需为受控素材、12～64px正方形，最多48个');
    if (item.stroke != null && !color(item.stroke)) throw invalid('设计稿描边无效');
    if (item.dash !== undefined && !['dash', 'dot'].includes(item.dash)) throw invalid('设计稿线型无效');
    if (
      item.type === 'rect' &&
      (![item.width, item.height, item.radius, item.strokeWidth].every(Number.isFinite) ||
        item.width <= 0 ||
        item.height <= 0 ||
        item.radius < 0 ||
        item.radius > Math.min(item.width, item.height) / 2 ||
        item.strokeWidth < 0 ||
        item.strokeWidth > 10)
    )
      throw invalid('设计稿矩形尺寸无效');
    if (item.type === 'path' && (!color(item.stroke) || !Number.isFinite(item.strokeWidth) || item.strokeWidth <= 0 || item.strokeWidth > 10))
      throw invalid('设计稿连线无效');
    const points =
      item.type === 'path'
        ? item.points
        : item.type === 'text'
          ? item.lines
          : [
              { x: item.x, y: item.y },
              { x: item.x + item.width, y: item.y + item.height }
            ];
    if (
      !Array.isArray(points) ||
      !points.length ||
      points.length > 200 ||
      points.some(
        (point) => !point || ![point.x, point.y].every(Number.isFinite) || point.x < 0 || point.y < 0 || point.x > scene.width || point.y > scene.height
      )
    )
      throw invalid('设计稿坐标越界');
    if (
      item.type === 'path' &&
      (points.length < 2 || points.some((point, index) => index && point.x !== points[index - 1].x && point.y !== points[index - 1].y))
    )
      throw invalid('设计稿只支持正交连线');
    if (
      item.type === 'text' &&
      (!Number.isFinite(item.fontSize) ||
        item.fontSize < 8 ||
        item.fontSize > 100 ||
        !Number.isFinite(item.width) ||
        item.width <= 0 ||
        points.some((line) => line.x + item.width > scene.width || typeof line.text !== 'string' || line.text.length > 300))
    )
      throw invalid('设计稿文字无效');
  }
  return scene;
}
