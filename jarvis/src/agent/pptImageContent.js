import { plain } from './docModel.js';
import { wrapText } from './slidePreview.js';
import { selectPictureLayout } from './pptImageLayout.js';
import { documentError } from './documentPlan.js';

const statistic = (text) => /^([-+]?\d[\d,.]*\s*(?:%|亿元|万元|万|元|项|场|人|家|台|次)?)[：:\s]+(.+)$/.exec(text);
const chain = (text) => text.split(/\s*(?:→|->|⟶|➜|=>)\s*/).filter(Boolean);

/** 图片页把正文按真实文字框重新测量，而非缩放旧版式坐标。 */
export function pictureTextUnits(blocks) {
  return blocks.flatMap((block) => {
    if (block.type === 'image') return [];
    if (block.type === 'list')
      return block.items.flatMap((item) => [{ type: 'paragraph', inlines: item.inlines, bullet: true }, ...pictureTextUnits(item.children || [])]);
    if (block.type === 'quote') return pictureTextUnits(block.blocks);
    if (block.type === 'table') return block.rows.map((row) => ({ ...block, rows: [row] }));
    if (block.type === 'code') return [{ type: 'paragraph', inlines: [{ text: block.text }] }];
    if (block.inlines && chain(plain(block.inlines)).length >= 3)
      return chain(plain(block.inlines)).map((text, index) => ({ type: 'paragraph', inlines: [{ text }], flowIndex: index }));
    return block.inlines ? [block] : [];
  });
}
export function pictureMetrics(blocks) {
  const units = pictureTextUnits(blocks);
  return {
    items: units.length,
    chars: units.reduce((sum, u) => sum + (u.type === 'table' ? [u.header, ...u.rows].flat().map(plain).join('').length : plain(u.inlines).length), 0),
    structured:
      units.some((u) => u.flowIndex != null) ||
      units.filter((u) => statistic(plain(u.inlines || []))).length >= 2 ||
      blocks.some((b) => b.type === 'table') ||
      units.filter((u) => /[:：]/.test(plain(u.inlines || []))).length >= 3
  };
}
const textHeight = (text, w, size) => wrapText(text, { w, h: 5, fontSize: size, margin: 0, lineSpacingMultiple: 1.15 }, w).height;
const merged = (units) =>
  units.reduce((all, unit) => {
    const previous = all.at(-1);
    if (unit.type === 'table' && previous?.type === 'table' && JSON.stringify(unit.header) === JSON.stringify(previous.header))
      previous.rows.push(...unit.rows);
    else all.push(unit.type === 'table' ? { ...unit, rows: [...unit.rows] } : unit);
    return all;
  }, []);
export function measurePictureUnits(units, area, size = 18) {
  return merged(units).map((unit) => {
    if (unit.type === 'table') {
      const cells = [unit.header, ...unit.rows];
      const weights = unit.header.map((_, i) => Math.min(28, Math.max(5, ...cells.map((row) => plain(row[i] || []).length))));
      const sum = weights.reduce((a, b) => a + b, 0);
      const colW = weights.map((n) => (area.w * n) / sum);
      const rowH = Math.max(
        0.36,
        Math.min(0.9, (area.h * 0.72) / cells.length),
        ...cells.flatMap((row) => row.map((cell, i) => textHeight(plain(cell), colW[i] - 0.18, size) + 0.1))
      );
      return { unit, height: rowH * cells.length + 0.16, rowH, colW };
    }
    const stat = statistic(plain(unit.inlines));
    if (stat) return { unit, stat, height: textHeight(stat[1], area.w - 0.4, Math.max(size, 26)) + textHeight(stat[2], area.w - 0.4, size) + 0.3 };
    return { unit, height: textHeight(plain(unit.inlines), area.w - (unit.bullet ? 0.3 : 0), size) + (unit.flowIndex != null ? 0.38 : 0.17) };
  });
}
export function pictureBodySize(units, area, preferred = 20, minimum = 14) {
  for (let size = Math.max(14, preferred); size >= minimum; size--) {
    if (measurePictureUnits(units, area, size).reduce((n, u) => n + u.height, 0) <= area.h) return size;
  }
  return null;
}
function splitLongUnit(unit) {
  if (unit.type === 'table') throw documentError('图片页的单行表格按要求字号仍放不下，请拆分单元格内容或另页排表；未删除内容', 'PPT_IMAGE_OVERFLOW');
  const text = plain(unit.inlines);
  if (text.length < 2) throw documentError('图片页文字区域不足，无法保持14磅', 'PPT_IMAGE_OVERFLOW');
  const middle = Math.ceil(text.length / 2);
  let offset = 0;
  const slice = (from, to) =>
    unit.inlines.flatMap((run) => {
      const start = offset;
      offset += run.text.length;
      const value = run.text.slice(Math.max(0, from - start), Math.min(run.text.length, to - start));
      return offset > from && start < to && value ? [{ ...run, text: value }] : [];
    });
  const first = slice(0, middle);
  offset = 0;
  return [
    { ...unit, inlines: first },
    { ...unit, inlines: slice(middle, text.length) }
  ];
}

/** 最多120页；只拆页，不丢正文或压到14磅以下，页数冲突交原slideBudget拒绝。 */
export async function preparePicturePages(slides, { load, style = 'business', previous = null, onOmitted = () => {}, bodySize = null } = {}) {
  const result = [];
  for (const slide of slides) {
    const allImages = slide.blocks.filter((b) => b.type === 'image');
    if (!allImages.length) {
      result.push(slide);
      previous = null;
      continue;
    }
    const images = allImages.slice(0, 4),
      extras = allImages.slice(4);
    extras.forEach((image) => onOmitted(`${image.src}（本页最多4图，未放入）`));
    const ratios = await Promise.all(images.map(async (image) => (await load(image.src))?.ratio || 1));
    let groups = [{ images, ratios }];
    const units = pictureTextUnits(slide.blocks);
    const gallery = selectPictureLayout({ count: images.length, ratios, ...pictureMetrics(slide.blocks), style });
    if (gallery.needsSplit) {
      groups = [];
      let i = 0;
      while (i < images.length) {
        let n = Math.min(2, images.length - i);
        while (n > 1 && selectPictureLayout({ count: n, ratios: ratios.slice(i, i + n) }).needsSplit) n--;
        groups.push({ images: images.slice(i, i + n), ratios: ratios.slice(i, i + n) });
        i += n;
      }
      if (units.length) groups.unshift({ images: [images[0]], ratios: [ratios[0]], text: true });
    } else groups[0].text = true;
    let continuation = 0;
    for (const group of groups) {
      const pending = group.text ? [...units] : [];
      do {
        const metric = pictureMetrics(pending);
        const plan = selectPictureLayout({ count: group.images.length, ratios: group.ratios, ...metric, previous, style });
        const selected = [];
        while (pending.length) {
          const next = pending[0];
          if (plan.text && pictureBodySize([...selected, next], plan.text, bodySize || 20, bodySize || 14)) selected.push(pending.shift());
          else if (!selected.length && plan.text) pending.splice(0, 1, ...splitLongUnit(next));
          else break;
        }
        const title = continuation++ ? `${slide.title}（续）` : slide.title;
        const blocks = [...merged(selected), ...group.images];
        result.push({ ...slide, title, blocks, notes: continuation === 1 ? slide.notes : [], picture: plan });
        previous = plan;
        if (result.length > 120) throw documentError('图片排版超过120页上限，请分批；正文未截断', 'DOCUMENT_SIZE');
      } while (pending.length);
    }
  }
  return result;
}

export function drawPictureBody(slide, blocks, plan, { tokens: t, shape, kind, bodySize = null, chart = null }) {
  const units = pictureTextUnits(blocks);
  if (!units.length || !plan.text) return;
  const size = pictureBodySize(units, plan.text, bodySize || 20, bodySize || 14);
  if (!size) throw documentError('图片页正文在14磅下仍溢出，需拆页', 'PPT_IMAGE_OVERFLOW');
  const measured = measurePictureUnits(units, plan.text, size);
  const usedHeight = measured.reduce((sum, item) => sum + item.height, 0);
  let y = plan.text.y + (plan.name !== 'hero' ? Math.max(0, plan.text.h - usedHeight) * 0.35 : 0);
  const foreground = plan.name === 'hero' ? 'FFFFFF' : t.text;
  for (const entry of measured) {
    const u = entry.unit;
    if (entry.stat && !u.inlines.some((run) => run.link)) {
      const numberHeight = textHeight(entry.stat[1], plan.text.w - 0.4, Math.max(size, 26));
      slide.addShape(shape.rect, { x: plan.text.x, y, w: plan.text.w, h: entry.height - 0.12, fill: { color: t.soft }, line: { transparency: 100 } });
      slide.addText(entry.stat[1], {
        objectName: 'wy-stat-number',
        x: plan.text.x + 0.2,
        y: y + 0.04,
        w: plan.text.w - 0.4,
        h: numberHeight,
        fontSize: Math.max(size, 26),
        bold: true,
        fontFace: t.font,
        color: t.accent,
        margin: 0
      });
      slide.addText(entry.stat[2], {
        objectName: 'wy-body',
        x: plan.text.x + 0.2,
        y: y + numberHeight + 0.08,
        w: plan.text.w - 0.4,
        h: entry.height - numberHeight - 0.2,
        fontSize: size,
        fontFace: t.font,
        color: t.text,
        margin: 0,
        lineSpacingMultiple: 1.15
      });
      y += entry.height;
      continue;
    }
    if (u.type === 'table' && chart) {
      slide.addChart(chart.type, chart.data, { x: plan.text.x, y, w: plan.text.w, h: entry.height - 0.16, ...chart.options });
      y += entry.height;
      continue;
    }
    if (u.type === 'table') {
      const rows = [u.header, ...u.rows].map((row, ri) =>
        row.map((cell) => ({
          text: plain(cell),
          options: { bold: ri === 0, fill: { color: ri === 0 ? t.strong : ri % 2 ? t.surface : t.soft }, color: ri === 0 ? t.onStrong : t.text }
        }))
      );
      slide.addTable(rows, {
        x: plan.text.x,
        y,
        w: plan.text.w,
        h: entry.height - 0.16,
        colW: entry.colW,
        rowH: entry.rowH,
        fontSize: size,
        fontFace: t.font,
        margin: 3,
        border: { type: 'solid', pt: 0.5, color: t.border },
        valign: 'middle',
        autoPage: false
      });
    } else {
      const card = ['cards', 'stats', 'steps', 'timeline', 'relation', 'compare', 'flow', 'progress'].includes(kind) || u.flowIndex != null;
      if (card)
        slide.addShape(shape.rect, {
          x: plan.text.x - 0.08,
          y: y - 0.04,
          w: plan.text.w + 0.16,
          h: entry.height - 0.04,
          line: { color: t.border, transparency: 100 },
          fill: { color: t.soft }
        });
      const labelLength = card ? plain(u.inlines).match(/^([^：:]{1,14}[：:])(.+)$/)?.[1].length || 0 : 0;
      let offset = 0;
      const inlines = u.inlines.flatMap((run) => {
        const cut = Math.max(0, Math.min(run.text.length, labelLength - offset));
        offset += run.text.length;
        return cut ? [{ ...run, text: run.text.slice(0, cut), bold: true }, ...(cut < run.text.length ? [{ ...run, text: run.text.slice(cut) }] : [])] : [run];
      });
      const runs = inlines.map((run) => ({
        text: run.text,
        options: { bold: run.bold || u.type === 'heading', italic: run.italic, ...(run.link && { hyperlink: { url: run.link } }) }
      }));
      slide.addText(runs, {
        objectName: 'wy-body',
        x: plan.text.x + (u.bullet ? 0.2 : 0),
        y,
        w: plan.text.w - (u.bullet ? 0.2 : 0),
        h: entry.height - 0.12,
        fontSize: size,
        fontFace: t.font,
        color: foreground,
        margin: 0,
        lineSpacingMultiple: 1.15,
        valign: 'top',
        breakLine: false
      });
      if (u.flowIndex != null && entry !== measured.at(-1))
        slide.addShape(shape.downArrow, {
          x: plan.text.x + plan.text.w / 2 - 0.08,
          y: y + entry.height - 0.19,
          w: 0.16,
          h: 0.16,
          fill: { color: t.accent },
          line: { transparency: 100 }
        });
      if (u.bullet)
        slide.addShape(shape.ellipse, {
          x: plan.text.x,
          y: y + 0.1,
          w: 0.055,
          h: 0.055,
          fill: { color: plan.name === 'hero' ? 'FFFFFF' : t.accent },
          line: { color: t.accent, transparency: 100 }
        });
    }
    y += entry.height;
  }
}
