/** 先量原文需要的行高，再分配图和栏目；不把剩余空间硬塞成小字列表。 */
import { wrapParagraphs } from './posterComposition.js';
import { designError } from './layeredDesignInput.js';

const textHeight = (text, size, width) => {
  const rows = wrapParagraphs(text, size, width);
  if (!rows) throw designError('原文无法在可读字号下换行，请增大画幅', 'DESIGN_TEXT_OVERFLOW');
  return Math.max(1, rows.length) * size * 1.4;
};
export function storyMetrics(b, section, width, lead = false) {
  const { u } = b, pad = 24 * u, labelSize = 26 * u;
  const titleSize = (lead ? 44 : 36) * u, bodySize = 34 * u, innerW = width - 2 * pad;
  const label = section.eyebrow || section.category || '要闻';
  const labelH = textHeight(section.eyebrow || '00 / ' + label, labelSize, innerW - 44 * u);
  const titleH = textHeight(section.title, titleSize, innerW);
  const bodyH = section.body ? textHeight(section.body, bodySize, innerW) : 0;
  return { pad, label, labelH, titleSize, titleH, bodySize, bodyH,
    height: pad * 2 + labelH + 12 * u + titleH + (bodyH ? 10 * u + bodyH : 0) };
}
export function drawStory(b, section, index, box, { lead = false, ruled = false } = {}) {
  const [x, y, w] = box, { u, palette: p } = b, m = storyMetrics(b, section, w, lead);
  if (m.height > box[3] + 0.01) throw designError('栏目在可读字号下放不下，请增大文字区或改用通栏，未缩字', 'DESIGN_TEXT_OVERFLOW');
  const group = `section-${index + 1}`, meta = { group, category: section.category, detail: section.detail || section.body || section.title };
  const ink = lead ? p.background : p.ink, secondary = lead ? p.background : p.muted;
  b.shape(group + '-card', box, lead ? p.ink : ruled ? p.background : p.card, ruled ? 0 : 20 * u, { group });
  b.text(group + '-label', section.eyebrow || `${String(index + 1).padStart(2, '0')} / ${m.label}`, [x + m.pad + 44 * u, y + m.pad, w - 2 * m.pad - 44 * u, m.labelH], 26, { ...meta, color: lead ? ink : p.accent, role: 'label', minFontSize: 26 * u });
  b.add('icon', group + '-icon', [x + m.pad, y + m.pad + 2 * u, 28 * u, 28 * u], { ...meta, icon: section.icon || 'news', color: lead ? ink : p.accent });
  const titleY = y + m.pad + m.labelH + 12 * u;
  b.text(group + '-title', section.title, [x + m.pad, titleY, w - 2 * m.pad, m.titleH], m.titleSize / u, { ...meta, color: ink, weight: 700, minFontSize: m.titleSize, role: 'body' });
  if (m.bodyH) b.text(group + '-body', section.body, [x + m.pad, titleY + m.titleH + 10 * u, w - 2 * m.pad, m.bodyH], 34, { ...meta, color: secondary, minFontSize: m.bodySize, role: 'body' });
  if (ruled) b.shape(group + '-rule', [x, y + box[3] - 2 * u, w, 1 * u], p.accent, 0, { group });
}
function rowsFor(b, sections, width, columns) {
  const gap = 20 * b.u, cw = (width - gap * (columns - 1)) / columns;
  const rows = [];
  for (let i = 0; i < sections.length; i += columns) {
    const entries = sections.slice(i, i + columns);
    rows.push({ entries, height: Math.max(...entries.map(s => storyMetrics(b, s, cw).height)) });
  }
  return { rows, cw, gap, height: rows.reduce((sum, row) => sum + row.height, 0) + Math.max(0, rows.length - 1) * gap };
}
/** 网格放不下时改为通栏；不在一堆窄框里逐级缩字。 */
export function readableStoryPlan(b, sections, width, available, preferred = 2) {
  for (const columns of preferred === 1 ? [1] : [2, 1]) {
    const plan = rowsFor(b, sections, width, columns);
    if (plan.height <= available + 0.01) return plan;
  }
  throw designError('原文在手机可读字号下放不下；请增加画布高度、减少主视觉占比或拆为多页，未缩小正文或删字', 'DESIGN_TEXT_OVERFLOW');
}
export function drawStoryPlan(b, sections, box, plan, options = {}) {
  const [x, y, , h] = box;
  const surplus = Math.max(0, h - plan.height), extra = Math.min(24 * b.u, surplus / Math.max(1, plan.rows.length));
  let cy = y, index = options.startIndex || 0;
  for (const row of plan.rows) {
    row.entries.forEach((s, col) => drawStory(b, s, index++, [x + col * (plan.cw + plan.gap), cy, plan.cw, row.height + extra], options));
    cy += row.height + extra + plan.gap;
  }
}
export function timelineStories(b, sections, box) {
  const { u, palette: p } = b, [x, y, w, h] = box, rail = 90 * u, bodyW = w - rail;
  const rows = sections.map(s => {
    const label = s.eyebrow || s.category || '要闻', labelW = Math.min(bodyW * 0.3, Math.max(110 * u, ([...label].length + 1.5) * 26 * u));
    const titleW = bodyW - labelW - 64 * u;
    const titleH = textHeight(s.title, 40 * u, titleW), labelH = textHeight(label, 26 * u, labelW);
    const bodyH = s.body ? textHeight(s.body, 34 * u, bodyW) : 0;
    return { label, labelW, labelH, titleW, titleH, bodyH, height: Math.max(titleH, labelH) + (bodyH ? 10 * u + bodyH : 0) + 38 * u };
  });
  const needed = rows.reduce((sum, row) => sum + row.height, 0);
  if (needed > h) throw designError('时间轴原文在手机可读字号下放不下，请增高画布，未缩字', 'DESIGN_TEXT_OVERFLOW');
  const gap = Math.min(26 * u, Math.max(0, (h - needed) / Math.max(1, rows.length - 1)));
  b.shape('timeline-spine', [x + 28 * u, y + 16 * u, 2 * u, Math.max(1, needed + gap * Math.max(0, rows.length - 1) - 40 * u)], p.accent);
  let cy = y;
  sections.forEach((s, i) => {
    const r = rows[i], group = `section-${i + 1}`, meta = { group, category: s.category, detail: s.detail || s.body || s.title };
    b.shape(`timeline-node-${i + 1}`, [x, cy, 58 * u, 58 * u], p.accent, 29 * u);
    b.text(`timeline-number-${i + 1}`, String(i + 1).padStart(2, '0'), [x, cy + 10 * u, 58 * u, 38 * u], 26, { ...meta, color: p.background, align: 'center', role: 'label' });
    b.text(group + '-title', s.title, [x + rail, cy, r.titleW, r.titleH], 40, { ...meta, weight: 700, minFontSize: 40 * u });
    b.text(group + '-label', r.label, [x + w - r.labelW, cy + 6 * u, r.labelW, r.labelH], 26, { ...meta, color: p.accent, align: 'right', role: 'label', minFontSize: 26 * u });
    b.add('icon', group + '-icon', [x + w - r.labelW - 42 * u, cy + 8 * u, 28 * u, 28 * u], { ...meta, icon: s.icon || 'news', color: p.accent });
    if (r.bodyH) b.text(group + '-body', s.body, [x + rail, cy + Math.max(r.titleH, r.labelH) + 10 * u, bodyW, r.bodyH], 34, { ...meta, color: p.muted, minFontSize: 34 * u });
    b.shape(group + '-rule', [x + rail, cy + r.height - 2 * u, bodyW, 1 * u], p.accent, 0, { group });
    cy += r.height + gap;
  });
}
export function newspaperStories(b, sections, box) {
  const { u } = b, [x, y, w, h] = box;
  if (!sections.length) return;
  const leadH = storyMetrics(b, sections[0], w, true).height;
  drawStory(b, sections[0], 0, [x, y, w, leadH], { lead: true });
  const tail = sections.slice(1);
  if (!tail.length) return;
  const gap = 28 * u, cw = (w - gap) / 2, start = y + leadH + gap;
  b.shape('newspaper-divider', [x + cw + gap / 2, start, 1 * u, h - leadH - gap], b.palette.accent);
  for (let col = 0; col < 2; col++) {
    let cy = start;
    tail.forEach((s, i) => {
      if (i % 2 !== col) return;
      const sh = storyMetrics(b, s, cw).height;
      if (cy + sh > y + h + 0.01) throw designError('报纸双栏原文超出可读空间，请增高画布或减少插图面积，未缩字', 'DESIGN_TEXT_OVERFLOW');
      drawStory(b, s, i + 1, [x + col * (cw + gap), cy, cw, sh], { ruled: true });
      cy += sh + 12 * u;
    });
  }
}
