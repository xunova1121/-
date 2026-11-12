/** 同一份像素版式生成自包含 SVG 与可编辑 PPTX；文字始终是字体文本，不交给图片模型画。 */
import { normalizePosterInput, normalizePosterBackground, posterError } from './posterCompositionInput.js';
import { applyPosterGradient } from './posterGradientPptx.js';

const PX_PER_INCH = 96;
const round = (value) => Math.round(value * 1000) / 1000;
const xml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);

function textPanel({ width, height, text_position: position, text_fraction: fraction }) {
  if (position === 'left' || position === 'right') {
    const w = width * fraction;
    return { x: position === 'right' ? width - w : 0, y: 0, w, h: height };
  }
  const h = height * fraction;
  return { x: 0, y: position === 'top' ? 0 : position === 'center' ? (height - h) / 2 : height - h, w: width, h };
}

function graphemes(text) {
  if (typeof Intl.Segmenter === 'function') return [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(text)].map((part) => part.segment);
  return [...text];
}

function glyphUnits(value) {
  // 中文真实字体通常为1em；额外10%留量兼容各端替代字体，西文保守估宽而不横向压缩字形。
  if (/^[\u0020-\u007e]+$/.test(value)) {
    return [...value].reduce((sum, ch) => sum + (/[MW@%]/.test(ch) ? 1.1 : /[il.,'!:;| ]/.test(ch) ? 0.4 : 0.8), 0);
  }
  const points = [...value];
  const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value);
  if (emoji && points.length <= 16 && points.every((ch) => /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200d\ufe0e\ufe0f\u20e3\u{e0020}-\u{e007f}0-9#*]/u.test(ch))) {
    // 未合成的ZWJ/国旗仍可能显示多个字形，按每个可见码点估宽，不假定平台都有彩色组合字库。
    return points.reduce((sum, ch) => sum + (/[\u200d\ufe0e\ufe0f\u{e0020}-\u{e007f}]/u.test(ch) ? 0 : 2.2), 0);
  }
  if (/^\p{Script=Latin}[\u0300-\u036f]?$/u.test(value)) return 1.5;
  if (value === '\u2e3a') return 2.2;
  if (value === '\u2e3b') return 3.3;
  if (points.length === 1 && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/u.test(value)) return 1.1;
  if (points.length === 1 && /[\p{Number}\p{Currency_Symbol}\p{Math_Symbol}\u00a0-\u00ac\u00ae-\u00bf\u2000-\u200a\u2010-\u2027\u2030-\u205e\u2100-\u214f\u2460-\u24ff\u25a0-\u25ff]/u.test(value)) return 2.2;
  // 复杂连字和堆叠附标没有可靠的跨端尺寸上界，明确拒绝而不截字或伪称检查通过。
  throw posterError('文字含当前不能保证完整排版的复杂字形；支持中文、西文、常用标点及有界emoji组合。', 'POSTER_UNSUPPORTED_TEXT', { character: value });
}

function wrapParagraphs(text, fontSize, width) {
  const rows = [];
  for (const paragraph of text.split('\n')) {
    let row = '';
    let used = 0;
    for (const glyph of graphemes(paragraph)) {
      const advance = glyphUnits(glyph) * fontSize;
      if (advance > width) return null;
      if (row && used + advance > width) {
        rows.push(row);
        row = '';
        used = 0;
      }
      row += glyph;
      used += advance;
    }
    rows.push(row);
  }
  return rows;
}

function textBlocks(input) {
  const blocks = [{ role: 'title', text: input.title, bold: true }];
  if (input.subtitle) blocks.push({ role: 'subtitle', text: input.subtitle });
  input.lines.forEach((text, index) => blocks.push({ role: 'lines', index, text }));
  if (input.footer) blocks.push({ role: 'footer', text: input.footer });
  return blocks;
}

function fitBlocks(input, inner, scale) {
  const shortSide = Math.min(input.width, input.height);
  const sizes = { title: [28, Math.min(160, shortSide * 0.094)], subtitle: [20, shortSide * 0.04], lines: [18, shortSide * 0.031], footer: [16, shortSide * 0.024] };
  const gap = Math.max(8, shortSide * 0.018 * scale);
  const blocks = [];
  let used = 0;
  for (const source of textBlocks(input)) {
    const [minimum, maximum] = sizes[source.role];
    const fontSize = round(Math.max(minimum, maximum * scale));
    const rowTexts = wrapParagraphs(source.text, fontSize, inner.w);
    if (!rowTexts) return null;
    const lineHeight = round(fontSize * 1.4);
    const h = rowTexts.length * lineHeight;
    blocks.push({ ...source, x: inner.x, y: inner.y + used, w: inner.w, h, fontSize, lineHeight, rowTexts });
    used += h + gap;
    if (used - gap > inner.h) return null;
  }
  return { blocks, used: used - gap };
}

/** 不省略任何文字；最小字号仍放不下时在生成文件之前明确失败。 */
export function composePosterLayout(options) {
  const input = normalizePosterInput(options);
  const margin = Math.min(input.width, input.height) * 0.06;
  const panel = textPanel(input);
  const inner = { x: panel.x + margin, y: panel.y + margin, w: panel.w - margin * 2, h: panel.h - margin * 2 };
  const fail = () => posterError('文字不能完整放入指定文字区；请增大文字区或画布，或明确减少文字后重试。未生成海报文件。', 'POSTER_TEXT_OVERFLOW', {
    width: input.width, height: input.height, text_position: input.text_position, text_fraction: input.text_fraction, characters: input.texts.reduce((sum, text) => sum + text.length, 0)
  });
  if (inner.w <= 0 || inner.h <= 0) throw fail();
  let fit = fitBlocks(input, inner, 1);
  if (!fit) {
    fit = fitBlocks(input, inner, 0);
    if (!fit) throw fail();
    let lower = 0;
    let upper = 1;
    // 有界二分只缩字号，不改正文、不截取要点、不使用PPT自动缩字。
    for (let attempt = 0; attempt < 16; attempt++) {
      const middle = (lower + upper) / 2;
      const candidate = fitBlocks(input, inner, middle);
      if (candidate) { fit = candidate; lower = middle; }
      else upper = middle;
    }
  }
  const offset = input.text_position === 'center' || input.text_style === 'gradient' ? (inner.h - fit.used) / 2 : 0;
  const blocks = fit.blocks.map((block) => {
    const y = block.role === 'footer' ? inner.y + inner.h - block.h : block.y + offset;
    const align = input.text_align;
    const rows = block.rowTexts.map((text, index) => ({ text, x: block.x, y: round(y + index * block.lineHeight), w: block.w, h: block.lineHeight, baseline: round(y + index * block.lineHeight + block.fontSize) }));
    return { ...block, y: round(y), align, rows };
  });
  return { width: input.width, height: input.height, margin, panel, inner, blocks, overflow: false, units: 'px', input };
}

function blendColor(first, second, fraction) {
  return `#${[1, 3, 5].map((at) => Math.round(parseInt(first.slice(at, at + 2), 16) * (1 - fraction) + parseInt(second.slice(at, at + 2), 16) * fraction).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function backgroundShapes(input, background) {
  const { width, height, backgroundColor, panelColor } = input;
  const shapes = [{ type: 'rect', x: 0, y: 0, w: width, h: height, color: backgroundColor, opacity: 1 }];
  if (!background) {
    // 32条渐变色带和两个圆都是原创几何装饰；两个格式共享形状，避免二次生成底图。
    for (let index = 0; index < 32; index++) {
      shapes.push({ type: 'rect', x: 0, y: height * index / 32, w: width, h: height / 32, color: blendColor(backgroundColor, '#617D93', index / 62), opacity: 1 });
    }
    shapes.push({ type: 'circle', cx: width * 0.76, cy: height * 0.21, r: Math.min(width, height) * 0.18, color: '#FFFFFF', opacity: 0.1 });
    shapes.push({ type: 'circle', cx: width * 0.2, cy: height * 0.38, r: Math.min(width, height) * 0.1, color: '#FFFFFF', opacity: 0.07 });
  }
  // 实色模式保持旧版安全底板；渐变使用两端透明度连续过渡，不用色带假装平滑渐变。
  shapes.push({ type: input.text_style === 'gradient' ? 'gradient' : 'rect', ...textPanel(input), color: panelColor, opacity: input.text_style === 'gradient' ? input.gradient_opacity : 1 });
  return shapes;
}

function shapeSvg(shape) {
  if (shape.type === 'gradient') return `<rect x="${round(shape.x)}" y="${round(shape.y)}" width="${round(shape.w)}" height="${round(shape.h)}" fill="url(#poster-text-gradient)"/>`;
  const fill = `fill="${shape.color}" fill-opacity="${shape.opacity}"`;
  if (shape.type === 'circle') return `<circle cx="${round(shape.cx)}" cy="${round(shape.cy)}" r="${round(shape.r)}" ${fill}/>`;
  return `<rect x="${round(shape.x)}" y="${round(shape.y)}" width="${round(shape.w)}" height="${round(shape.h)}" ${fill}/>`;
}

function composeSvg(layout, shapes, background) {
  const { input, width, height } = layout;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`];
  if (input.text_style === 'gradient') parts.push(`<defs><linearGradient id="poster-text-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${input.panelColor}" stop-opacity="0"/><stop offset="1" stop-color="${input.panelColor}" stop-opacity="${input.gradient_opacity}"/></linearGradient></defs>`);
  parts.push(shapeSvg(shapes[0]));
  if (background) parts.push(`<image x="0" y="0" width="${width}" height="${height}" href="${background.data}" preserveAspectRatio="xMidYMid slice"/>`);
  parts.push(...shapes.slice(1).map(shapeSvg));
  for (const block of layout.blocks) {
    for (const row of block.rows) {
      const x = block.align === 'center' ? row.x + row.w / 2 : row.x;
      parts.push(`<text x="${round(x)}" y="${row.baseline}" font-size="${block.fontSize}" font-family="${xml(input.fontFamily)}" font-weight="${block.bold ? 'bold' : 'normal'}" fill="${input.textColor}" text-anchor="${block.align === 'center' ? 'middle' : 'start'}" xml:space="preserve">${xml(row.text)}</text>`);
    }
  }
  parts.push('</svg>');
  return parts.join('');
}

function addPptShape(pptx, slide, shape) {
  const box = shape.type === 'circle' ? { x: shape.cx - shape.r, y: shape.cy - shape.r, w: shape.r * 2, h: shape.r * 2 } : shape;
  slide.addShape(shape.type === 'circle' ? pptx.ShapeType.ellipse : pptx.ShapeType.rect, {
    x: box.x / PX_PER_INCH, y: box.y / PX_PER_INCH, w: box.w / PX_PER_INCH, h: box.h / PX_PER_INCH,
    fill: { color: shape.color.slice(1), transparency: shape.type === 'gradient' ? 0 : Math.round((1 - shape.opacity) * 100) },
    line: { color: shape.color.slice(1), transparency: 100 },
    ...(shape.type === 'gradient' && { objectName: 'poster-text-gradient' })
  });
}

async function composePptx(layout, shapes, background) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  const { input, width, height } = layout;
  pptx.defineLayout({ name: 'POSTER_PIXELS', width: width / PX_PER_INCH, height: height / PX_PER_INCH });
  pptx.layout = 'POSTER_PIXELS';
  pptx.author = '未央';
  pptx.title = input.title;
  pptx.subject = `${width}×${height}；中文程序排版；文字可编辑`;
  pptx.lang = 'zh-CN';
  pptx.theme = { headFontFace: input.fonts[0], bodyFontFace: input.fonts[0], lang: 'zh-CN' };
  const slide = pptx.addSlide();
  addPptShape(pptx, slide, shapes[0]);
  if (background) {
    // 原图宽高参与cover裁切，不能把画布宽高当作原图宽高而拉伸图片。
    slide.addImage({ data: background.data, x: 0, y: 0, w: background.width / PX_PER_INCH, h: background.height / PX_PER_INCH,
      sizing: { type: 'cover', w: width / PX_PER_INCH, h: height / PX_PER_INCH }, objectName: 'poster-background' });
  }
  for (const shape of shapes.slice(1)) addPptShape(pptx, slide, shape);
  for (const block of layout.blocks) {
    block.rows.forEach((row, index) => slide.addText(row.text, {
      x: row.x / PX_PER_INCH, y: row.y / PX_PER_INCH, w: row.w / PX_PER_INCH, h: row.h / PX_PER_INCH,
      fontSize: block.fontSize * 72 / PX_PER_INCH, fontFace: input.fonts[0], lang: 'zh-CN', bold: Boolean(block.bold),
      color: input.textColor.slice(1), margin: 0, align: block.align, valign: 'top', breakLine: false, wrap: false,
      paraSpaceAfterPt: 0, paraSpaceBeforePt: 0, objectName: `poster-${block.role}-${block.index ?? 0}-${index}`
    }));
  }
  const blob = await pptx.write({ outputType: 'blob' });
  return input.text_style === 'gradient' ? applyPosterGradient(blob, { color: input.panelColor, opacity: input.gradient_opacity }) : blob;
}

/** @returns {Promise<{svg:string,pptx:Blob,layout:object,width:number,height:number,texts:string[],fonts:string[],fontFamily:string}>} */
export async function composePoster(options = {}) {
  const layout = composePosterLayout(options);
  const background = normalizePosterBackground(options.background);
  const shapes = backgroundShapes(layout.input, background);
  const svg = composeSvg(layout, shapes, background);
  const pptx = await composePptx(layout, shapes, background);
  const { width, height, texts, fonts, fontFamily } = layout.input;
  return { svg, pptx, layout, width, height, texts, fonts, fontFamily };
}
