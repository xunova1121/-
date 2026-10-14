/**
 * Markdown → PPT（.pptx），用 PptxGenJS（MIT）。16:9，配色用主题（themes.js）。
 *
 * 写法：“# 标题”或“## 标题”开始一页，也可以用 --- 分页；页内的列表、段落、表格、图片决定版式。
 * 版式按内容自动选：
 *   cover     封面：文档标题、副标题、日期（深色底）
 *   section   章节页：只有标题（或标题 + 一句话），或标题像“第二部分 …”
 *   stats     大数字：2–4 条要点，每条以数字开头（如“1,236 万元 销售额”）
 *   bullets   要点：列表 / 段落；超过 7 条自动拆成两页（续）
 *   imageText 左文右图：有图片也有文字
 *   image     大图：只有图片
 *   compare   对比：页内有两个 ### 小标题，左右两栏
 *   chart     数据：表格里有数字列 → 柱状图（数据少于等于 8 行）
 *   table     表格：其他表格
 *   end       结尾：标题是“谢谢 / 感谢 / Q&A / 结束”
 * 以“备注：”开头的段落放进演讲者备注，不上屏。
 */
import { parseDoc, plain } from './docModel.js';
import { imageInfo } from './imageInfo.js';

const W = 13.333;
const H = 7.5;
const FONT = '微软雅黑';
const NUM_ITEM = /^(?:\*\*)?([-+]?[\d,.]+\s*(?:%|万亿元|亿元|万元|千元|万亿|亿|万|千|元|个|家|人次|人|倍|天|小时|分钟|项|台|套|次)?)(?:\*\*)?(?:\s*[：:]\s*|\s+)(.+)$/;
const END = /^(谢谢|感谢|谢谢观看|感谢聆听|thanks|thank you|q\s*&\s*a|结束)/i;
const SECTION = /^(第[一二三四五六七八九十\d]+(部分|章|篇)|part\s*\d+)/i;

/** 按页拆开，每页保留原始块，供选版式 */
export function parseSlides(title, md) {
  const blocks = parseDoc(md);
  const slides = [];
  let cur = null;
  const start = (t) => { cur = { title: t, blocks: [], notes: [] }; slides.push(cur); };
  for (const b of blocks) {
    if (b.type === 'heading' && b.level <= 2) { start(plain(b.inlines)); continue; }
    if (b.type === 'hr') { cur = null; continue; }
    if (!cur) start(slides.length ? '' : title);
    if (b.type === 'paragraph' && /^备注[:：]/.test(plain(b.inlines))) { cur.notes.push(plain(b.inlines).replace(/^备注[:：]\s*/, '')); continue; }
    cur.blocks.push(b);
  }
  return slides;
}

/** 兼容旧接口：{ title, lines } */
export function splitSlides(title, md) {
  return parseSlides(title, md).map((s) => ({ title: s.title, lines: s.blocks.flatMap(blockLines) }));
}
function blockLines(b) {
  if (b.type === 'paragraph') return [plain(b.inlines)];
  if (b.type === 'list') return b.items.flatMap((it) => [plain(it.inlines), ...it.children.flatMap(blockLines)]);
  if (b.type === 'heading') return [plain(b.inlines)];
  if (b.type === 'quote') return b.blocks.flatMap(blockLines);
  if (b.type === 'code') return b.text.split('\n');
  return [];
}

/** 选版式 */
export function layoutOf(slide, { first = false, last = false } = {}) {
  const bs = slide.blocks;
  const has = (t) => bs.some((b) => b.type === t);
  const lines = bs.flatMap(blockLines).filter(Boolean);
  if (first && !bs.length) return 'cover';
  if (END.test(slide.title.trim()) && (last || lines.length <= 2)) return 'end';
  if (!bs.length || (SECTION.test(slide.title) && lines.length <= 1)) return 'section';
  const table = bs.find((b) => b.type === 'table');
  if (table) return numericColumns(table).length && table.rows.length <= 8 ? 'chart' : 'table';
  const imgs = bs.filter((b) => b.type === 'image');
  if (imgs.length) return lines.length ? 'imageText' : 'image';
  if (bs.filter((b) => b.type === 'heading' && b.level >= 3).length === 2) return 'compare';
  const items = bs.filter((b) => b.type === 'list').flatMap((b) => b.items.map((it) => plain(it.inlines)));
  if (items.length >= 2 && items.length <= 4 && items.length === lines.length && items.every((t) => NUM_ITEM.test(t))) return 'stats';
  return 'bullets';
}

const num = (s) => {
  const t = String(s).replace(/[,，\s]/g, '').replace(/[%万亿元个家人次倍天项台套]+$/, '');
  return /^[-+]?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};
function numericColumns(table) {
  return table.header.map((_, i) => i).filter((i) => i > 0 && table.rows.length && table.rows.every((r) => num(plain(r[i] ?? [])) !== null));
}

/**
 * @param {{ title: string, content: string, theme: object, subtitle?: string, author?: string, date?: string, loadImage?: (src: string) => Promise<Uint8Array|null> }} o
 * @returns {Promise<{ blob: Blob, info: { slides: number, layouts: string[], missingImages: string[] } }>}
 */
export async function makePptx({ title, content, theme, subtitle = '', author = '', date = '', loadImage = null }) {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = title;
  pptx.author = '贾维斯';
  const C = theme.colors;
  const dark = C.primary;
  const light = theme.official ? 'FFFFFF' : C.bg;
  const muted = '7F8C99';
  const missingImages = [];
  const layouts = [];

  let slides = parseSlides(title, content);
  // 第一页如果就是文档标题（# 标题后面没有内容），当作封面
  if (slides[0] && !slides[0].blocks.length) { title = slides[0].title || title; slides = slides.slice(1); }
  // 超过 7 条要点拆页
  const expanded = [];
  for (const s of slides) {
    const items = s.blocks.length === 1 && s.blocks[0].type === 'list' ? s.blocks[0].items : null;
    if (items && items.length > 7) {
      for (let i = 0; i < items.length; i += 6) expanded.push({ ...s, title: i ? `${s.title}（续）` : s.title, blocks: [{ ...s.blocks[0], items: items.slice(i, i + 6) }], notes: i ? [] : s.notes });
    } else expanded.push(s);
  }
  slides = expanded;

  const imageData = async (src) => {
    try {
      const bytes = loadImage ? await loadImage(src) : null;
      const info = bytes && imageInfo(bytes);
      if (!info) { missingImages.push(src); return null; }
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { data: `image/${info.type === 'jpg' ? 'jpeg' : info.type};base64,${btoa(bin)}`, ratio: info.width / info.height };
    } catch { missingImages.push(src); return null; }
  };

  const titleBar = (sl, text) => {
    sl.background = { color: light };
    sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: H, fill: { color: C.accent }, line: { color: C.accent } });
    sl.addText(text, { x: 0.6, y: 0.35, w: W - 1.2, h: 0.9, fontSize: 28, bold: true, color: dark, fontFace: FONT, valign: 'middle', fit: 'shrink' });
    sl.addShape(pptx.ShapeType.line, { x: 0.6, y: 1.3, w: W - 1.2, h: 0, line: { color: C.soft, width: 1.5 } });
  };
  const pageNo = (sl, n) => sl.addText(String(n), { x: W - 1.1, y: H - 0.5, w: 0.6, h: 0.3, fontSize: 10, color: muted, align: 'right', fontFace: FONT });
  const bulletRuns = (items, size) => items.flatMap((it, i) => {
    const run = (s) => ({ text: s.text, options: { bold: s.bold, italic: s.italic, color: s.link ? '0563C1' : undefined } });
    const head = it.inlines.map(run);
    head[0] = { ...head[0], options: { ...head[0]?.options, bullet: { code: '25A0', indent: 26 }, paraSpaceBefore: i ? Math.round(size * 0.6) : 0 } };
    head[head.length - 1].options.breakLine = true;
    const subs = it.children.filter((c) => c.type === 'list').flatMap((c) => c.items.map((sub) => ({ text: plain(sub.inlines), options: { bullet: { indent: 26 }, indentLevel: 1, fontSize: size - 4, color: '595959', breakLine: true } })));
    return [...head, ...subs];
  });
  const textOf = (bs) => bs.flatMap((b) => (b.type === 'list' ? [b] : b.type === 'paragraph' ? [{ type: 'list', items: [{ inlines: b.inlines, children: [] }] }] : []));
  const fontFor = (n, chars) => (n > 6 || chars > 260 ? 16 : n > 4 || chars > 160 ? 18 : 22);

  // ---------- 封面
  const cover = pptx.addSlide();
  cover.background = { color: dark };
  cover.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.75, w: 1.4, h: 0.07, fill: { color: C.accent }, line: { color: C.accent } });
  cover.addText(title, { x: 0.8, y: 2.0, w: W - 1.6, h: 1.6, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: FONT, valign: 'bottom', fit: 'shrink' });
  if (subtitle) cover.addText(subtitle, { x: 0.8, y: 4.0, w: W - 1.6, h: 0.6, fontSize: 20, color: C.soft, fontFace: FONT });
  cover.addText([author, date || today()].filter(Boolean).join('　'), { x: 0.8, y: H - 1.2, w: W - 1.6, h: 0.5, fontSize: 14, color: C.soft, fontFace: FONT });
  layouts.push('cover');

  // ---------- 各页
  for (const [i, s] of slides.entries()) {
    const kind = layoutOf(s, { last: i === slides.length - 1 });
    layouts.push(kind);
    const sl = pptx.addSlide();
    const n = i + 2;
    const lines = s.blocks.flatMap(blockLines).filter(Boolean);
    switch (kind) {
      case 'section':
      case 'end': {
        sl.background = { color: dark };
        sl.addShape(pptx.ShapeType.rect, { x: 0.8, y: 3.9, w: 1.2, h: 0.06, fill: { color: C.accent }, line: { color: C.accent } });
        sl.addText(s.title || (kind === 'end' ? '谢谢' : ''), { x: 0.8, y: 2.3, w: W - 1.6, h: 1.5, fontSize: kind === 'end' ? 44 : 36, bold: true, color: 'FFFFFF', fontFace: FONT, valign: 'bottom', fit: 'shrink' });
        if (lines.length) sl.addText(lines.join('　'), { x: 0.8, y: 4.15, w: W - 1.6, h: 0.8, fontSize: 18, color: C.soft, fontFace: FONT });
        break;
      }
      case 'stats': {
        titleBar(sl, s.title);
        const items = s.blocks.find((b) => b.type === 'list').items.map((it) => plain(it.inlines).match(NUM_ITEM));
        const cw = (W - 1.2 - 0.3 * (items.length - 1)) / items.length;
        items.forEach((m, k) => {
          const x = 0.6 + k * (cw + 0.3);
          sl.addShape(pptx.ShapeType.roundRect, { x, y: 2.1, w: cw, h: 3.2, fill: { color: C.soft }, line: { color: C.soft }, rectRadius: 0.08 });
          sl.addText(m[1].trim(), { x, y: 2.5, w: cw, h: 1.3, fontSize: 40, bold: true, color: C.accent, align: 'center', fontFace: FONT, fit: 'shrink' });
          sl.addText(m[2].trim(), { x: x + 0.2, y: 3.9, w: cw - 0.4, h: 1.1, fontSize: 16, color: dark, align: 'center', valign: 'top', fontFace: FONT });
        });
        pageNo(sl, n);
        break;
      }
      case 'compare': {
        titleBar(sl, s.title);
        const groups = [];
        for (const b of s.blocks) {
          if (b.type === 'heading') groups.push({ title: plain(b.inlines), blocks: [] });
          else if (groups.length) groups.at(-1).blocks.push(b);
        }
        groups.slice(0, 2).forEach((g, k) => {
          const x = 0.6 + k * ((W - 1.2) / 2 + 0.15);
          const w = (W - 1.2) / 2 - 0.15;
          const color = k ? C.extra : C.accent;
          sl.addShape(pptx.ShapeType.rect, { x, y: 1.65, w, h: 0.6, fill: { color }, line: { color } });
          sl.addText(g.title, { x, y: 1.65, w, h: 0.6, fontSize: 20, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT });
          const items = textOf(g.blocks).flatMap((b) => b.items);
          // 框的高度跟着内容走：要点少时不留一大片空底色
          const rows = items.reduce((a, it) => a + Math.ceil(plain(it.inlines).length / 22) + it.children.length, 0);
          if (items.length) sl.addText(bulletRuns(items, 20), { x, y: 2.4, w, h: Math.min(4.4, Math.max(1.6, 0.5 + rows * 0.62)), fontSize: 20, color: C.ink, fontFace: FONT, valign: 'top', fill: { color: C.soft }, margin: 14 });
        });
        pageNo(sl, n);
        break;
      }
      case 'chart': {
        titleBar(sl, s.title);
        const t = s.blocks.find((b) => b.type === 'table');
        const cols = numericColumns(t).slice(0, 3);
        const labels = t.rows.map((r) => plain(r[0] ?? []));
        const data = cols.map((c) => ({ name: plain(t.header[c]), labels, values: t.rows.map((r) => num(plain(r[c] ?? []))) }));
        const note = s.blocks.filter((b) => b.type !== 'table').flatMap(blockLines).filter(Boolean);
        const chartW = note.length ? 8.2 : W - 1.2;
        sl.addChart(pptx.ChartType.bar, data, {
          x: 0.6, y: 1.55, w: chartW, h: 5.3, barDir: 'col', barGapWidthPct: 60,
          chartColors: [C.accent, C.extra, C.primary].map((c) => c.toUpperCase()),
          showLegend: cols.length > 1, legendPos: 'b', legendFontFace: FONT, legendFontSize: 12,
          showValue: true, dataLabelFontSize: 11, dataLabelFontFace: FONT, dataLabelColor: '404040',
          catAxisLabelFontFace: FONT, catAxisLabelFontSize: 12, valAxisLabelFontSize: 11, valGridLine: { color: 'E5E8EC', size: 0.5 }
        });
        if (note.length) sl.addText(note.map((x) => ({ text: x, options: { bullet: { code: '25A0' }, breakLine: true, paraSpaceAfter: 8 } })), { x: 9.1, y: 1.8, w: W - 9.7, h: 4.8, fontSize: 16, color: C.ink, fontFace: FONT, valign: 'top' });
        pageNo(sl, n);
        break;
      }
      case 'table': {
        titleBar(sl, s.title);
        const t = s.blocks.find((b) => b.type === 'table');
        const fs = t.rows.length > 10 ? 11 : t.rows.length > 6 ? 13 : 16;
        const rowH = t.rows.length > 10 ? undefined : Math.min(0.62, 5.0 / (t.rows.length + 1)); // 行少时加高，不挤在页面顶上
        const head = t.header.map((c) => ({ text: plain(c), options: { bold: true, color: 'FFFFFF', fill: { color: C.accent }, align: 'center' } }));
        const body = t.rows.map((r, ri) => t.header.map((_, ci) => ({ text: plain(r[ci] ?? []), options: { fill: { color: ri % 2 ? C.soft : 'FFFFFF' }, align: t.align[ci] ?? (num(plain(r[ci] ?? [])) !== null ? 'right' : 'left') } })));
        sl.addTable([head, ...body], { x: 0.6, y: 1.6, w: W - 1.2, fontSize: fs, fontFace: FONT, color: C.ink, border: { type: 'solid', pt: 0.75, color: 'BFC7D1' }, valign: 'middle', ...(rowH && { rowH }), autoPage: true, autoPageRepeatHeader: true });
        pageNo(sl, n);
        break;
      }
      case 'imageText':
      case 'image': {
        titleBar(sl, s.title);
        const img = s.blocks.find((b) => b.type === 'image');
        const pic = await imageData(img.src);
        const area = kind === 'image' ? { x: 0.6, y: 1.55, w: W - 1.2, h: 5.4 } : { x: 7.0, y: 1.6, w: 5.7, h: 5.2 };
        if (pic) {
          let w = area.w;
          let h = w / pic.ratio;
          if (h > area.h) { h = area.h; w = h * pic.ratio; }
          sl.addImage({ data: pic.data, x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h });
        } else {
          sl.addShape(pptx.ShapeType.rect, { ...area, fill: { color: C.soft }, line: { color: C.soft } });
          sl.addText(`［图片：${img.alt || img.src}］`, { ...area, fontSize: 16, color: muted, align: 'center', fontFace: FONT });
        }
        if (img.alt) sl.addText(img.alt, { x: area.x, y: area.y + area.h - 0.05, w: area.w, h: 0.4, fontSize: 12, color: muted, align: 'center', fontFace: FONT });
        if (kind === 'imageText') {
          const items = textOf(s.blocks.filter((b) => b.type !== 'image')).flatMap((b) => b.items);
          const size = fontFor(items.length, lines.join('').length) - 2;
          sl.addText(bulletRuns(items, size), { x: 0.6, y: 1.6, w: 6.1, h: 5.2, fontSize: size, color: C.ink, fontFace: FONT, valign: 'top' });
        }
        pageNo(sl, n);
        break;
      }
      default: {
        titleBar(sl, s.title || title);
        const items = textOf(s.blocks.filter((b) => b.type === 'list' || b.type === 'paragraph')).flatMap((b) => b.items);
        const extra = s.blocks.filter((b) => !['list', 'paragraph'].includes(b.type)).flatMap(blockLines).filter(Boolean);
        for (const t of extra) items.push({ inlines: [{ text: t }], children: [] });
        const short = items.length >= 2 && items.length <= 4 && items.every((it) => !it.children.some((c) => c.type === 'list') && plain(it.inlines).length <= 46);
        if (short) {
          // 要点少而短：做成一行一张卡片，带序号，铺满页面，不让三行字挤在左上角
          const gap = 0.22, top = 1.75, h = Math.min(1.25, (5.1 - gap * (items.length - 1)) / items.length);
          items.forEach((it, k) => {
            const y = top + k * (h + gap);
            sl.addShape(pptx.ShapeType.roundRect, { x: 0.8, y, w: W - 1.6, h, fill: { color: C.soft }, line: { color: C.soft }, rectRadius: 0.06 });
            sl.addShape(pptx.ShapeType.ellipse, { x: 1.05, y: y + h / 2 - 0.3, w: 0.6, h: 0.6, fill: { color: C.accent }, line: { color: C.accent } });
            sl.addText(String(k + 1), { x: 1.05, y: y + h / 2 - 0.3, w: 0.6, h: 0.6, fontSize: 18, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FONT });
            sl.addText(it.inlines.map((r) => ({ text: r.text, options: { bold: r.bold, italic: r.italic } })), { x: 1.95, y, w: W - 3.0, h, fontSize: 22, color: C.ink, fontFace: FONT, valign: 'middle', fit: 'shrink' });
          });
        } else if (items.length) {
          const size = fontFor(items.length, lines.join('').length);
          sl.addText(bulletRuns(items, size), { x: 0.8, y: 1.6, w: W - 1.6, h: 5.3, fontSize: size, color: C.ink, fontFace: FONT, valign: 'top', lineSpacingMultiple: 1.15, fit: 'shrink' });
        }
        pageNo(sl, n);
      }
    }
    if (s.notes.length) sl.addNotes(s.notes.join('\n'));
  }
  const blob = await pptx.write({ outputType: 'blob' });
  return { blob, info: { slides: slides.length + 1, layouts, missingImages } };
}

function today() {
  const d = new Date(Date.now() + 8 * 3600_000);
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}
