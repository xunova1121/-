/** 栏目与配图共用分组，按实际文字行高排版，不把整页背景当作每条新闻的配图。 */
import { storyMetrics } from './layeredStoryLayout.js';
import { designError } from './layeredDesignInput.js';

export function illustratedStories(b, sections, box, assets) {
  const [x, y, width, height] = box, { u, palette: p } = b;
  const gap = 26 * u, inset = 24 * u;
  const rows = sections.map((section, i) => {
    if (section.asset && !assets.some(a => a.id === section.asset)) throw designError('栏目配图需引用assets中存在的ID');
    const image = section.asset || (i === 0 ? assets[0]?.id : undefined);
    const imageW = image ? width * (i === 0 ? 0.4 : 0.31) : 0;
    const textW = width - (image ? imageW + gap : 0);
    const metrics = storyMetrics(b, section, textW, i === 0);
    return { section, image, imageW, textW, metrics, height: Math.max(metrics.height, image ? 210 * u : 0) };
  });
  const needed = rows.reduce((sum, r) => sum + r.height, 0) + Math.max(0, rows.length - 1) * gap;
  if (needed > height + 0.01) throw designError('图文栏目在可读字号下放不下，请增高画布；保留全文和配图，不缩字', 'DESIGN_TEXT_OVERFLOW');
  let cy = y;
  rows.forEach((r, i) => {
    const group = `section-${i + 1}`, leftImage = Boolean(r.image && i % 2 === 1);
    const tx = x + (leftImage ? r.imageW + gap : 0), m = r.metrics;
    const meta = { group, category: r.section.category, detail: r.section.detail || r.section.body || r.section.title };
    if (r.image) b.add('image', group + '-image', [leftImage ? x : x + r.textW + gap, cy, r.imageW, r.height], { ...meta, asset: r.image, fit: 'cover' });
    b.text(group + '-label', r.section.eyebrow || `${String(i + 1).padStart(2, '0')} / ${m.label}`, [tx + inset, cy + inset, r.textW - 2 * inset, m.labelH], 26, { ...meta, role: 'label', color: p.accent, minFontSize: 26 * u });
    const titleY = cy + inset + m.labelH + 12 * u;
    b.text(group + '-title', r.section.title, [tx + inset, titleY, r.textW - 2 * inset, m.titleH], m.titleSize / u, { ...meta, role: 'body', weight: 700, minFontSize: m.titleSize });
    if (m.bodyH) b.text(group + '-body', r.section.body, [tx + inset, titleY + m.titleH + 10 * u, r.textW - 2 * inset, m.bodyH], 34, { ...meta, role: 'body', color: p.muted, minFontSize: 34 * u });
    b.shape(group + '-rule', [x, cy + r.height + gap / 2, width, 1 * u], p.accent, 0, { group });
    cy += r.height + gap;
  });
}
