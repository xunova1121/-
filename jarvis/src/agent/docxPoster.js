/**
 * 单页告示（招租、出租、招聘、启事、寻物、海报、宣传单、告示）：一页 A4，大字，上下铺满。
 * 用户 2026-10-29 实测：招租广告按普通文档排，正文 12 磅、下半页空着、标题下有横线，连改 5 次都不对。
 *
 *   - 字号按页面自动算：标题尽量一行排下（最大 80 磅），正文取能放进一页的最大字号（最大 48 磅）
 *   - 用户说了具体字号（“正文小初”）就用用户的；说“小点”时在自动字号上缩一档
 *   - 剩下的空白平均分到标题上方、标题和正文之间、各段之间，整页铺满
 *   - 不加横线、下划线、页眉页脚、页码
 *   - 估算偏保守（留 8% 余量），换了字体排出两页时，交付的分页检查会照实报出来
 */
import { parseDoc } from './docModel.js';

const PAGE = { width: 595.3, height: 841.9 }; // A4，磅
const MARGIN = 54; // 约 19 毫米
const LINE = 1.3; // 行高 = 字号 × 1.3（固定行距，估算和实际一致）
const textOf = (inlines = []) => inlines.map((s) => s.text ?? '').join('');

/** 一行字的宽度（以字号为单位）：汉字和全角符号算 1，数字字母算 0.55 */
export const textUnits = (text) => [...String(text)].reduce((n, ch) => n + (/[⺀-￯]/.test(ch) ? 1 : /\s/.test(ch) ? 0.3 : 0.55), 0);
const linesAt = (text, size, width) => Math.max(1, Math.ceil((textUnits(text) * size) / width));

/** Markdown → 标题 + 每行一段（列表、小标题都摊平成一行一段；表格、图片不适合告示，按行取文字） */
export function posterLines(content, fallbackTitle = '') {
  const blocks = parseDoc(content);
  let title = '';
  const lines = [];
  const push = (inlines) => {
    for (const part of textOf(inlines).split('\n')) if (part.trim()) lines.push({ text: part.trim(), bold: inlines.some((s) => s.bold && part.includes(s.text)) });
  };
  for (const b of blocks) {
    if (b.type === 'heading' && !title && b.level <= 2) title = textOf(b.inlines).trim();
    else if (b.type === 'heading' || b.type === 'paragraph') push(b.inlines);
    else if (b.type === 'list') for (const it of b.items) push(it.inlines);
    else if (b.type === 'table') for (const row of [b.header, ...b.rows]) lines.push({ text: row.map(textOf).join('　'), bold: false });
    else if (b.type === 'quote') for (const q of b.blocks) if (q.inlines) push(q.inlines);
  }
  return { title: title || String(fallbackTitle).trim(), lines };
}

/**
 * 算字号和间距。
 * @param {{ title: string, lines: {text: string}[] }} poster
 * @param {{ title?: number, body?: number, scale?: number }} [want] 用户指定的字号；scale < 1 表示“小点”
 */
export function posterLayout({ title, lines }, want = {}) {
  const width = PAGE.width - MARGIN * 2;
  const height = (PAGE.height - MARGIN * 2) * 0.92;
  const titleSize = want.title ?? Math.max(28, Math.min(80, Math.floor((width / Math.max(1, textUnits(title))) * 0.95)));
  const titleH = title ? linesAt(title, titleSize, width) * titleSize * LINE : 0;
  const bodyH = (size) => lines.reduce((h, l) => h + linesAt(l.text, size, width) * size * LINE, 0);
  // 正文：从 48 磅往下找，放得下（再留出每段之间至少 0.4 个字的间距）就用
  let body = want.body;
  if (!body) {
    body = 14;
    // 正文不超过标题的 65%，主次分得清
    for (let s = Math.min(48, Math.floor(titleSize * 0.65)); s >= 14; s -= 1) {
      if (titleH + bodyH(s) + s * 0.4 * lines.length + s <= height) { body = s; break; }
    }
    if (want.scale) body = Math.max(10, Math.round(body * want.scale));
  }
  const used = titleH + bodyH(body);
  const gaps = lines.length + 1; // 标题上方 1 份，标题和正文之间 1.5 份，段间各 1 份
  const spare = Math.max(0, height - used);
  const unit = Math.min(body * 2.5, spare / (gaps + 0.5));
  return { title: titleSize, body, top: unit, afterTitle: unit * 1.5, between: unit, lineHeight: LINE };
}

/**
 * @param {typeof import('docx')} d docx 模块
 * @param {{ docTitle: string, content: string, titleFont: object, bodyFont: object, colors: object, typography: object }} o
 */
export async function makePosterDocx(d, { docTitle, content, titleFont, bodyFont, colors, typography = {} , scale }) {
  const { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, LineRuleType } = d;
  const poster = posterLines(content, docTitle);
  const size = posterLayout(poster, { title: typography.title?.size, body: typography.body?.size, scale });
  const TW = (pt) => Math.round(pt * 20);
  const exact = (pt) => ({ line: TW(pt * size.lineHeight), lineRule: LineRuleType.EXACT });
  // 短的“名目：内容”行（房屋面积：120平方米）名目加粗；长句居中照常
  const labelled = (text) => /^[^：:]{1,8}[：:]/.test(text) && text.length <= 30;
  const children = [];
  if (poster.title)
    children.push(new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { before: TW(size.top), after: TW(size.afterTitle), ...exact(size.title) },
      children: [new TextRun({ text: poster.title, bold: true, size: Math.round(size.title * 2), font: titleFont, color: colors.primary })]
    }));
  poster.lines.forEach((line, i) => {
    const split = labelled(line.text) ? line.text.match(/^([^：:]+[：:])(.*)$/) : null;
    const run = (text, bold) => new TextRun({ text, bold, size: Math.round(size.body * 2), font: bodyFont, color: colors.ink });
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: i === poster.lines.length - 1 ? 0 : TW(size.between), ...exact(size.body) },
      children: split ? [run(split[1], true), run(split[2], line.bold)] : [run(line.text, line.bold)]
    }));
  });
  const doc = new Document({
    creator: '未央',
    title: poster.title,
    styles: { default: { document: { run: { font: bodyFont, size: Math.round(size.body * 2), color: colors.ink } } } },
    sections: [{ properties: { page: { size: { width: TW(PAGE.width), height: TW(PAGE.height) }, margin: { top: TW(MARGIN), bottom: TW(MARGIN), left: TW(MARGIN), right: TW(MARGIN) } } }, children }]
  });
  const blob = await Packer.toBlob(doc);
  return { blob, info: { toc: false, images: 0, missingImages: [], headings: 0, template: null, typographyProfile: typography, poster: { titleSize: size.title, bodySize: size.body } } };
}
