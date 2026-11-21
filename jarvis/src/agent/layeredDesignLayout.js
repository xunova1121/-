/** 内容驱动的起稿；结果都是独立图层，后续可自由移动/改字，而非锁死模板截图。 */
import { PALETTES, normalizeLayerDesign, boundedText, designError } from './layeredDesignInput.js';
import { wrapParagraphs } from './posterComposition.js';
import { storyMetrics, drawStory, readableStoryPlan, drawStoryPlan, timelineStories, newspaperStories } from './layeredStoryLayout.js';
import { illustratedStories } from './illustratedStoryLayout.js';

function builder(width, height, palette) {
  const layers = [];
  const u = Math.min(width, height) / 1080;
  const add = (type, id, box, props = {}) => {
    layers.push({ id, type, x: box[0], y: box[1], w: box[2], h: box[3], ...props });
  };
  const text = (id, textValue, box, size, props = {}) => add('text', id, box, { text: textValue, fontSize: size * u, color: palette.ink, ...props });
  const shape = (id, box, fill = palette.card, radius = 0, props = {}) => add('shape', id, box, { fill, radius, decorative: true, ...props });
  return { layers, u, add, text, shape, width, height, palette };
}

function sectionsOf(input) {
  if (input.lines?.length && input.design.sections) throw designError('请将正文统一放在design.sections，不同时传lines，未丢掉任一份内容');
  if (input.markers?.length) throw designError('分层稿不自动猜测地图坐标；请用既有气象preset，或提供有依据的底图/图层');
  const supplied = ['metrics', 'series', 'alerts'].some(key => input[key]?.length);
  if (supplied && input.design.sections) throw designError('请把数据统一放入design.sections，或只用原metrics/series/alerts字段，未忽略任一组数据');
  const sections = input.design.sections ?? [
    ...(input.lines || []).map(line => ({ title: line })),
    ...(input.metrics || []).map(m => ({ title: m.label, value: String(m.value), unit: m.unit || '', detail: m.detail || '' })),
    ...(input.series?.length ? [{ title: input.seriesLabel || '用户提供趋势', points: input.series, detail: input.seriesUnit ? '单位：' + input.seriesUnit : '' }] : []),
    ...(input.alerts || []).map(a => ({ title: a.title, body: a.detail || '', eyebrow: a.time || '', category: '预警' }))
  ];
  if (!Array.isArray(sections) || sections.length > 12) throw designError('自动起稿最多12组内容；更多内容请拆版或用自由图层');
  return sections.map(section => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) throw designError('内容分组必须是对象');
    return { ...section, title: boundedText(section.title, 500), body: boundedText(section.body || '', 1600),
      ...(section.value !== undefined && { value: boundedText(String(section.value), 100) }), unit: boundedText(section.unit || '', 30),
      eyebrow: boundedText(section.eyebrow || '', 100), category: boundedText(section.category || '', 40), detail: boundedText(section.detail || '', 1600) };
  });
}
function header(b, input, label, contentWidth) {
  const { width: w, u, palette: p, text, shape } = b, m = 64 * u;
  const wide = w > b.height;
  const textW = contentWidth ?? w - m * 2;
  text('eyebrow', input.design.eyebrow || label, [m, (wide ? 30 : 48) * u, textW, (wide ? 32 : 50) * u], wide ? 20 : 26, { color: p.accent, weight: 700, role: 'label' });
  const titleSize = input.title.length > 24 ? (wide ? 48 : 60) : (wide ? 64 : 84);
  const titleRows = wrapParagraphs(input.title, titleSize * u, textW);
  const titleHeight = (titleRows?.length || 1) * titleSize * u * 1.4;
  const titleY = (wide ? 88 : 116) * u;
  text('title', input.title, [m, titleY, textW, titleHeight], titleSize, { weight: 700, role: 'heading' });
  let bottom = titleY + titleHeight;
  if (input.subtitle) {
    const subtitleSize = (wide ? 24 : 34) * u;
    const subtitleHeight = (wrapParagraphs(input.subtitle, subtitleSize, textW)?.length || 1) * subtitleSize * 1.4;
    text('subtitle', input.subtitle, [m, bottom + 12 * u, textW, subtitleHeight], subtitleSize / u, { color: p.muted, role: 'body', minFontSize: subtitleSize });
    bottom += subtitleHeight + 12 * u;
  }
  shape('header-rule', [m, bottom + 24 * u, w - 2 * m, 2 * u], p.accent);
  return bottom + 58 * u;
}
function footer(b, input) {
  const { u, width: w, height: h, palette: p } = b;
  const copy = input.footer || (input.dataMode === 'provided' ? input.source : '设计演示 · 内容为样例');
  const height = b.footerHeight || 55 * u;
  b.text('footer', copy || '用户提供内容', [64 * u, h - height - 28 * u, w - 128 * u, height], b.footerSize, { color: p.muted, role: 'caption', minFontSize: b.footerSize * u });
}
function card(b, section, index, box, lead = false) {
  if (b.width <= b.height) return drawStory(b, section, index, box, { lead });
  const { u, palette: p, text, shape, add } = b, [x, y, w, h] = box;
  const group = `section-${index + 1}`, meta = { group, category: section.category, detail: section.detail || section.body || section.title };
  const compact = b.width > b.height && !lead;
  const pad = (compact ? 20 : 30) * u, labelSpace = (compact ? 44 : 64) * u;
  shape(group + '-card', box, lead ? p.ink : p.card, 20 * u, { group });
  const ink = lead ? p.background : p.ink, muted = lead ? p.background : p.muted;
  add('icon', group + '-icon', [x + pad, y + pad, (compact ? 28 : 38) * u, (compact ? 28 : 38) * u], { ...meta, icon: section.icon || ['news', 'chart', 'leaf', 'building', 'calendar', 'star'][index % 6], color: lead ? p.background : p.accent });
  text(group + '-label', section.eyebrow || String(index + 1).padStart(2, '0'), [x + pad + 56 * u, y + pad, w - 2 * pad - 56 * u, (compact ? 32 : 48) * u], 22, { ...meta, color: lead ? p.background : p.accent, weight: 700 });
  const hasBody = Boolean(section.body), titleY = y + pad + labelSpace;
  const innerH = h - pad * 2 - labelSpace, titleH = hasBody ? innerH * 0.48 : innerH;
  text(group + '-title', section.title, [x + pad, titleY, w - pad * 2, titleH], lead ? (hasBody ? 48 : 64) : (hasBody ? 31 : 40), { ...meta, color: ink, weight: 700, minFontSize: (lead ? 32 : 23) * u });
  if (hasBody) text(group + '-body', section.body, [x + pad, titleY + titleH + 12 * u, w - pad * 2, innerH - titleH - 12 * u], lead ? 28 : 25, { ...meta, color: muted, minFontSize: (compact ? 18 : 21) * u });
}
function editorial(b, input, sections) {
  const { width: w, height: h, u } = b, m = 64 * u, gap = 22 * u;
  let y = header(b, input, 'WEIYANG / EDITORIAL');
  const bottom = h - b.footerHeight - 61 * u;
  const asset = input.design.assets?.[0];
  if (asset && w > h) {
    const imageH = Math.min((bottom - y) * 0.3, (w - m * 2) * 0.52);
    b.add('image', 'hero-image', [m, y, w - m * 2, imageH], { asset: asset.id, group: 'hero', detail: '工作区原始视觉素材；图中文字不作为准确文案' });
    y += imageH + gap;
  }
  if (!sections.length) {
    b.text('statement', input.subtitle || input.title, [m, y + (bottom - y) * 0.15, w - 2 * m, (bottom - y) * 0.6], 100, { color: b.palette.accent, weight: 700 });
    return;
  }
  // 内容多时主稿+双栏；横版改三栏。文字框按真实内容留量，溢出会拒绝而非删字。
  const tail = sections.length - 1;
  if (w > h) {
    const leftW = (w - 2 * m - gap) * 0.42, sideX = m + leftW + gap, sideW = w - m - sideX;
    card(b, sections[0], 0, [m, y, tail ? leftW : w - 2 * m, bottom - y], true);
    const sideCols = tail > 3 ? 2 : 1, sideRows = Math.ceil(tail / sideCols);
    const cw = (sideW - gap * (sideCols - 1)) / sideCols, ch = (bottom - y - gap * (sideRows - 1)) / sideRows;
    sections.slice(1).forEach((s, i) => card(b, s, i + 1, [sideX + (i % sideCols) * (cw + gap), y + Math.floor(i / sideCols) * (ch + gap), cw, ch]));
    return;
  }
  const contentW = w - 2 * m, needed = editorialHeight(b, sections, contentW);
  if (asset) {
    const imageH = Math.min((bottom - y) * 0.28, bottom - y - needed - gap);
    if (imageH < 110 * u) throw designError('原文和插图无法同时保持手机可读，请增高画布或重新构图，未缩字或丢掉插图', 'DESIGN_TEXT_OVERFLOW');
    b.add('image', 'hero-image', [m, y, contentW, imageH], { asset: asset.id, group: 'hero' });
    y += imageH + gap;
  }
  editorialStories(b, sections, [m, y, contentW, bottom - y]);
}
function editorialHeight(b, sections, width) {
  if (!sections.length) return 0;
  const tail = sections.slice(1), lead = storyMetrics(b, sections[0], width, true).height;
  if (!tail.length) return lead;
  const height = Math.min(readableStoryPlan(b, tail, width, Infinity, 2).height, readableStoryPlan(b, tail, width, Infinity, 1).height);
  return lead + 20 * b.u + height;
}
function editorialStories(b, sections, box) {
  if (!sections.length) return;
  const [x, y, w, h] = box, lead = storyMetrics(b, sections[0], w, true).height;
  if (lead > h) throw designError('头条在可读字号下放不下，请增高画布', 'DESIGN_TEXT_OVERFLOW');
  drawStory(b, sections[0], 0, [x, y, w, lead], { lead: true });
  const tail = sections.slice(1), start = y + lead + 20 * b.u;
  if (tail.length) drawStoryPlan(b, tail, [x, start, w, y + h - start], readableStoryPlan(b, tail, w, y + h - start), { startIndex: 1 });
}
function campaign(b, input, sections) {
  const { width: w, height: h, u, palette: p } = b, m = 52 * u, bottom = h - b.footerHeight - 55 * u;
  const titleW = w * 0.46, titleSize = 76 * u;
  const titleH = (wrapParagraphs(input.title, titleSize, titleW)?.length || 1) * titleSize * 1.4;
  const subtitleH = input.subtitle ? (wrapParagraphs(input.subtitle, 34 * u, titleW)?.length || 1) * 34 * u * 1.4 : 0;
  const minimumHero = 120 * u + titleH + (subtitleH ? 18 * u + subtitleH : 0);
  const heroH = Math.min(h * 0.32, bottom - editorialHeight(b, sections, w - 2 * m) - 28 * u);
  if (heroH < minimumHero) throw designError('主视觉标题与正文在可读字号下放不下，请增加画布高度或用free重新分配图文，未把新闻挤成小字', 'DESIGN_TEXT_OVERFLOW');
  const asset = input.design.assets?.[0];
  if (asset) b.add('image', 'hero-image', [w * 0.5, 0, w * 0.5, heroH], { asset: asset.id, group: 'hero' });
  else b.add('icon', 'hero-symbol', [w * 0.65, heroH * 0.25, 180 * u, 180 * u], { icon: 'news', color: p.accent, decorative: true });
  b.text('eyebrow', input.design.eyebrow || 'WEIYANG / DAILY BRIEF', [m, 36 * u, titleW, 52 * u], 26, { color: p.accent, role: 'label', weight: 700 });
  b.text('title', input.title, [m, 100 * u, titleW, titleH], 76, { color: p.ink, role: 'heading', weight: 700, minFontSize: titleSize });
  if (input.subtitle) b.text('subtitle', input.subtitle, [m, 100 * u + titleH + 18 * u, titleW, subtitleH], 34, { color: p.muted, role: 'body', minFontSize: 34 * u });
  b.shape('hero-rule', [m, heroH - 4 * u, w - 2 * m, 3 * u], p.accent);
  editorialStories(b, sections, [m, heroH + 28 * u, w - 2 * m, bottom - heroH - 28 * u]);
}
function alternateStories(b, input, sections, timeline) {
  const asset = input.design.assets?.[0], headerW = (b.width - 128 * b.u) * 0.64;
  const y = header(b, input, timeline ? 'WEIYANG / TIMELINE' : 'WEIYANG / NEWSPAPER', asset ? headerW : undefined);
  const m = 56 * b.u;
  if (asset) {
    const imageX = 64 * b.u + headerW + 24 * b.u;
    b.add('image', 'hero-image', [imageX, 48 * b.u, b.width - 64 * b.u - imageX, y - 98 * b.u], { asset: asset.id, fit: 'contain', group: 'hero' });
  }
  (timeline ? timelineStories : newspaperStories)(b, sections, [m, y, b.width - 2 * m, b.height - b.footerHeight - 61 * b.u - y]);
}
function celebration(b, input, sections) {
  const { width: w, height: h, u, palette: p, text, shape, add } = b;
  const m = 64 * u, y = header(b, input, '把美好，慢慢收藏');
  const end = h - b.footerHeight - 61 * u, available = end - y;
  const imageH = Math.min(available * 0.42, (w - 2 * m) * 0.67);
  if (input.design.assets?.length) add('image', 'hero-image', [m, y, w - 2 * m, imageH], { asset: input.design.assets[0].id, group: 'hero' });
  else {
    shape('hero-surface', [m, y, w - 2 * m, imageH], '#F4E2D9', 36 * u);
    add('icon', 'hero-symbol', [(w - 180 * u) / 2, y + (imageH - 180 * u) / 2, 180 * u, 180 * u], { icon: 'heart', color: p.accent, decorative: true });
  }
  const gap = 22 * u, start = y + imageH + gap;
  const count = Math.max(1, sections.length), cols = count > 1 ? 2 : 1, rows = Math.ceil(count / cols);
  const cellH = (end - start - (rows - 1) * gap) / rows, cellW = (w - 2 * m - (cols - 1) * gap) / cols;
  sections.forEach((s, i) => {
    const x = m + (i % cols) * (cellW + gap), cy = start + Math.floor(i / cols) * (cellH + gap), group = `section-${i + 1}`;
    if (!s.value) return card(b, s, i, [x, cy, cellW, cellH]);
    const meta = { group, detail: s.detail || `${s.title}：${s.value}${s.unit || ''}`, category: s.category };
    shape(group + '-card', [x, cy, cellW, cellH], p.card, 24 * u, { group });
    text(group + '-title', s.title, [x + 28 * u, cy + 24 * u, cellW - 56 * u, 52 * u], 34, { ...meta, color: p.muted, role: 'body', minFontSize: 34 * u });
    text(group + '-value', s.value + (s.unit || ''), [x + 28 * u, cy + 94 * u, cellW - 56 * u, cellH - 120 * u], 92, { ...meta, color: p.accent, weight: 700, minFontSize: 38 * u });
  });
}
function dashboard(b, input, sections) {
  const { width: w, height: h, u, palette: p, text, shape, add } = b;
  const m = 48 * u, gap = 24 * u;
  text('eyebrow', input.dataMode === 'provided' ? '用户提供数据 · 未核实实时性' : '演示数据 · 离线原型', [m, 26 * u, w - 2 * m, 40 * u], 22, { color: p.accent });
  text('title', input.title, [m, 76 * u, w - 2 * m, 96 * u], 64, { weight: 700 });
  if (input.subtitle) text('subtitle', input.subtitle, [m, 180 * u, w - 2 * m, 40 * u], 24, { color: p.muted });
  const top = 230 * u, end = h - b.footerHeight - 55 * u, leftW = (w - 2 * m - gap) * 0.29, rightX = m + leftW + gap, rightW = w - m - rightX;
  const metrics = sections.filter(s => s.value !== undefined), main = sections.filter(s => s.value === undefined);
  const count = Math.max(1, metrics.length), cellH = (end - top - gap * (count - 1)) / count;
  metrics.forEach((s, i) => {
    const y = top + i * (cellH + gap), group = `section-${sections.indexOf(s) + 1}`, meta = { group, category: s.category, detail: s.detail || s.title };
    shape(group + '-card', [m, y, leftW, cellH], p.card, 18 * u, { group });
    add('icon', group + '-icon', [m + 26 * u, y + 24 * u, 42 * u, 42 * u], { icon: s.icon || 'chart', color: p.accent, ...meta });
    text(group + '-title', s.title, [m + 86 * u, y + 24 * u, leftW - 110 * u, 52 * u], 27, meta);
    const valueH = cellH - 108 * u, valueSize = Math.min(70, valueH / u / 1.4);
    text(group + '-value', String(s.value) + (s.unit || ''), [m + 30 * u, y + 92 * u, leftW - 60 * u, valueH], valueSize, { ...meta, weight: 700, color: p.accent });
  });
  const image = input.design.assets?.[0], imageH = image ? (end - top - gap) * 0.58 : 0;
  if (image) add('image', 'hero-image', [rightX, top, rightW, imageH], { asset: image.id, group: 'hero', detail: '仅视觉背景，文字/数据/交互为独立图层；不代表真实地理数据' });
  const chart = main.find(s => s.points), bodyY = top + (image ? imageH + gap : 0), bodyH = end - bodyY;
  if (chart) {
    const group = `section-${sections.indexOf(chart) + 1}`;
    shape(group + '-card', [rightX, bodyY, rightW, bodyH], p.card, 18 * u, { group });
    text(group + '-title', chart.title, [rightX + 30 * u, bodyY + 18 * u, rightW - 60 * u, 55 * u], 28, { group });
    add('chart', group + '-chart', [rightX + 30 * u, bodyY + 90 * u, rightW - 60 * u, bodyH - 118 * u], { points: chart.points, chartType: chart.chartType, unit: chart.unit, color: p.accent, group, detail: chart.detail || chart.title });
  } else if (main.length) card(b, main[0], sections.indexOf(main[0]), [rightX, bodyY, rightW, bodyH], false);
  else text('empty-data', '未提供趋势数据', [rightX, bodyY, rightW, bodyH], 34, { color: p.muted });
  // 不允许自动布局静默丢掉尚未容纳的内容。
  const usedMain = chart ? [chart] : main.slice(0, 1);
  if (main.some(s => !usedMain.includes(s))) throw designError('驾驶舱起稿只能安排一组趋势或说明；请用layers自由排版其余内容，未删除文案');
}

export function planLayerDesign(input, defaultSize = [1080, 1920], normalization = {}) {
  const spec = input.design;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw designError('请提供design构图参数');
  if (JSON.stringify(input).length > 180000) throw designError('设计参数超过180KB');
  // 自由稿常已写出完整title文字层；只复用这个唯一明确标题，不从主题/文件名猜文案。
  const titles = Array.isArray(spec.layers) ? spec.layers.filter(n => n?.id === 'title' && n.type === 'text') : [];
  input = { ...input, title: boundedText(input.title ?? (titles.length === 1 ? titles[0].text : undefined), 300) };
  if (!input.title.trim() && !spec.layers) throw designError('请提供准确标题');
  const width = input.width ?? defaultSize[0], height = input.height ?? defaultSize[1];
  const layout = spec.layout || (width > height ? 'dashboard' : 'editorial');
  if (!['editorial', 'magazine', 'campaign', 'timeline', 'newspaper', 'celebration', 'dashboard', 'free'].includes(layout)) throw designError('请选择支持的起稿布局，或用free自由图层');
  const palette = { ...(PALETTES[layout] || PALETTES.editorial),
    ...(input.background_color && { background: input.background_color }), ...(input.text_color && { ink: input.text_color }), ...(input.panel_color && { card: input.panel_color }), ...spec.palette };
  const assets = spec.assets || (input.background_path ? [{ id: 'hero', path: input.background_path }] : []);
  input = { ...input, design: { ...spec, assets } };
  const b = builder(width, height, palette);
  const footerCopy = input.footer || (input.dataMode === 'provided' ? input.source : '设计演示 · 内容为样例') || '用户提供内容';
  b.footerSize = spec.reading === 'desktop' || width > height ? 20 : 34;
  const footerRows = spec.layers ? [''] : wrapParagraphs(footerCopy, b.footerSize * b.u, width - 128 * b.u);
  if (!footerRows) throw designError('脚注在当前画幅放不下，请调整宽度', 'DESIGN_TEXT_OVERFLOW');
  b.footerHeight = Math.max(55 * b.u, footerRows.length * b.footerSize * b.u * 1.4);
  if (spec.layers) b.layers.push(...spec.layers);
  else {
    if (layout === 'free') throw designError('自由排版需明确提供layers');
    const sections = sectionsOf(input);
    if (layout === 'magazine' || sections.some(s => s.asset)) {
      const start = header(b, input, 'WEIYANG / NEWS');
      illustratedStories(b, sections, [64 * b.u, start, width - 128 * b.u, height - b.footerHeight - 61 * b.u - start], assets);
    }
    else if (layout === 'timeline' || layout === 'newspaper') alternateStories(b, input, sections, layout === 'timeline');
    else ({ editorial, campaign, celebration, dashboard })[layout](b, input, sections);
    footer(b, input);
  }
  return normalizeLayerDesign({ ...input, width, height, palette, assets, layers: b.layers, states: spec.states, concept: spec.concept, fontFamily: input.font_family || 'sans', reading: spec.reading || (width > height ? 'desktop' : 'phone') }, normalization);
}

/** 未指定尺寸的新竖稿可在写文件前增加高度；明确画幅、原稿和横版绝不悄悄改变。 */
export function planReadableLayerDesign(input, defaultSize = [1080, 1920], grow = false) {
  const width = input.width ?? defaultSize[0], first = input.height ?? defaultSize[1];
  for (let height = first; ; height = Math.min(4096, height + 384)) {
    try { return planLayerDesign({ ...input, width, height }, defaultSize); }
    catch (error) {
      if (!grow || width > first || height >= 4096 || error.code !== 'DESIGN_TEXT_OVERFLOW') throw error;
    }
  }
}
