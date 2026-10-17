/**
 * Markdown → Word（.docx），用 docx 库（MIT）。
 *
 *   版面    A4；普通文档上下 2.54 cm、左右 3.18 cm；公文按 GB/T 9704—2012（上 37 / 下 35 / 左 28 / 右 26 mm）
 *   正文    小四号、1.5 倍行距、首行缩进 2 字；公文：三号仿宋、固定行距 28.95 磅（每页 22 行）
 *   标题    文档开头唯一的“# 标题”当作文档大标题（居中），其余 ## / ### / #### 依次为一 / 二 / 三级标题
 *   列表    Word 真正的多级编号和项目符号（不是手打的“•”），每个有序列表从 1 重新编号
 *   表格    细边框、表头底色 + 白字加粗、隔行浅底、表头跨页重复、按 Markdown 对齐
 *   其他    斜体 / 删除线 / 行内代码 / 链接 / 引用块 / 代码块 / 分隔线 / [分页] / 工作区图片（自动缩放，带图注）
 *   页脚    “第 X 页 / 共 Y 页”（公文“— X —”）；正文二级标题（##）有 3 个以上时自动加目录；可选封面
 *   模板    传入 template（用户的 .docx）时沿用它的样式定义（styles.xml）
 */
import { parseDoc, plain, headings, markSalutationAndSignature } from './docModel.js';
import { FONTS } from './themes.js';
import { imageInfo } from './imageInfo.js';

const PT = (n) => Math.round(n * 2); // 字号：磅 → 半磅
const MM = (n) => Math.round((n * 1440) / 25.4); // 毫米 → twip

/** 字体风格 → docx 的 font 对象 */
const font = (key) => {
  const f = FONTS[key] ?? FONTS.sans;
  return { ascii: f.latin, hAnsi: f.latin, eastAsia: f.eastAsia, cs: f.latin };
};

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.content  Markdown
 * @param {object} o.theme  themes.js 里的主题
 * @param {boolean} [o.cover]  加封面
 * @param {string} [o.subtitle]
 * @param {string} [o.author]
 * @param {string} [o.date]
 * @param {'auto'|boolean} [o.toc]
 * @param {(src: string) => Promise<Uint8Array|null>} [o.loadImage]  读工作区图片
 * @param {Uint8Array|ArrayBuffer} [o.template]  用户的 .docx 模板：沿用其样式
 * @returns {Promise<{ blob: Blob, info: { toc: boolean, images: number, missingImages: string[], headings: number } }>}
 */
export async function makeDocx({ title, content, theme, cover = false, subtitle = '', author = '', date = '', toc = 'auto', loadImage = null, template = null }) {
  const d = await import('docx');
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle,
    ShadingType, LevelFormat, PageNumber, Footer, Header, ExternalHyperlink, ImageRun, TableOfContents, PageBreak,
    LineRuleType, VerticalAlign, LevelSuffix
  } = d;
  const official = Boolean(theme.official);
  const C = theme.colors;
  const bodyFont = font(theme.fonts.body);
  const headFont = font(theme.fonts.heading);
  const bodySize = official ? 16 : 12;
  const lineSpacing = official ? { line: 579, lineRule: LineRuleType.EXACT } : { line: 360, lineRule: LineRuleType.AUTO };
  const page = official
    ? { top: MM(37), bottom: MM(35), left: MM(28), right: MM(26) }
    : { top: MM(25.4), bottom: MM(25.4), left: MM(31.8), right: MM(31.8) };
  const textWidthPx = Math.floor(((11906 - page.left - page.right) / 1440) * 96); // 版心宽度（像素，96dpi）

  // ---------- 结构：开头唯一的一级标题 = 文档大标题
  const blocks = parseDoc(content);
  const h1s = blocks.filter((b) => b.type === 'heading' && b.level === 1);
  let docTitle = title;
  let shift = 0;
  if (h1s.length === 1 && blocks[0] === h1s[0]) {
    docTitle = plain(blocks.shift().inlines) || title;
    shift = 1;
  } else if (!h1s.length) shift = 1; // 没有 #：## 就是一级标题
  const level = (l) => Math.max(1, l - shift);
  const hs = headings(blocks).map((h) => ({ ...h, level: level(h.level) }));
  // 公文不加目录（除非明确要求）
  const wantToc = toc === true || (toc === 'auto' && !official && hs.filter((h) => h.level === 1).length >= 3);
  markSalutationAndSignature(blocks);

  // ---------- 行内
  let numberingInstance = 0;
  const missingImages = [];
  let imageCount = 0;
  const run = (s, extra = {}) => new TextRun({
    text: s.text,
    bold: s.bold || extra.bold,
    italics: s.italic || extra.italics,
    strike: s.strike,
    font: s.code ? { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: bodyFont.eastAsia } : extra.font,
    size: s.code ? PT(Math.max(9, (extra.sizePt ?? bodySize) - 1)) : extra.sizePt ? PT(extra.sizePt) : undefined,
    color: s.link ? '0563C1' : extra.color,
    underline: s.link ? {} : undefined,
    shading: s.code ? { type: ShadingType.CLEAR, fill: 'F2F4F7', color: 'auto' } : undefined
  });
  const runs = (ins, extra) => {
    const out = [];
    for (const s of ins) {
      // 行内的换行
      const parts = s.text.split('\n');
      parts.forEach((p, i) => {
        const r = run({ ...s, text: p }, extra);
        const node = s.link ? new ExternalHyperlink({ link: s.link, children: [r] }) : r;
        out.push(node);
        if (i < parts.length - 1) out.push(new TextRun({ break: 1 }));
      });
    }
    return out;
  };

  // ---------- 块
  const body = (ins, opts = {}) => new Paragraph({
    children: runs(ins),
    alignment: official ? AlignmentType.JUSTIFIED : AlignmentType.JUSTIFIED,
    // 首行缩进 2 字：同时写字符数和绝对值，不认 firstLineChars 的软件也能缩进
    indent: opts.noIndent ? undefined : { firstLineChars: 200, firstLine: bodySize * 2 * 20 },
    ...opts.paragraph
  });

  const HL = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

  async function imageBlock(b, out) {
    let bytes = null;
    try { bytes = loadImage ? await loadImage(b.src) : null; } catch { bytes = null; }
    const info = bytes ? imageInfo(bytes) : null;
    if (!info) {
      missingImages.push(b.src);
      out.push(body([{ text: `［图片：${b.alt || b.src}］`, italic: true }], { noIndent: true, paragraph: { alignment: AlignmentType.CENTER } }));
      return;
    }
    imageCount++;
    const w = Math.min(info.width, textWidthPx);
    const h = Math.round((info.height * w) / info.width);
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 }, keepNext: true, children: [new ImageRun({ type: info.type, data: bytes, transformation: { width: w, height: h }, altText: { name: b.alt || 'image', description: b.alt || '', title: b.alt || '' } })] }));
    if (b.alt) out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: `图 ${imageCount}  ${b.alt}`, size: PT(bodySize - 1.5), color: official ? '000000' : '595959' })] }));
  }

  function listBlock(b, out, depth = 0) {
    const ref = b.ordered ? 'jarvis-ordered' : 'jarvis-bullets';
    const instance = b.ordered ? ++numberingInstance : 0;
    for (const it of b.items) {
      out.push(new Paragraph({ children: runs(it.inlines), numbering: { reference: ref, level: Math.min(depth, 8), ...(b.ordered && { instance }) }, spacing: { after: 60 } }));
      for (const c of it.children) {
        if (c.type === 'list') listBlock(c, out, depth + 1);
        else if (c.type === 'paragraph') out.push(new Paragraph({ children: runs(c.inlines), indent: { left: 420 * (depth + 1) }, spacing: { after: 60 } }));
      }
    }
  }

  function tableBlock(b) {
    const cols = Math.max(b.header.length, ...b.rows.map((r) => r.length));
    const align = (i) => ({ center: AlignmentType.CENTER, right: AlignmentType.RIGHT }[b.align[i]] ?? AlignmentType.LEFT);
    const border = { style: BorderStyle.SINGLE, size: 4, color: official ? '000000' : 'BFC7D1' };
    const borders = { top: border, bottom: border, left: border, right: border };
    const cell = (ins, i, { head = false, zebra = false } = {}) => new TableCell({
      borders,
      width: { size: widths[i], type: WidthType.DXA },
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      shading: head ? { type: ShadingType.CLEAR, fill: official ? 'F2F2F2' : C.accent, color: 'auto' } : zebra ? { type: ShadingType.CLEAR, fill: C.soft, color: 'auto' } : undefined,
      children: [new Paragraph({ alignment: head ? AlignmentType.CENTER : align(i), spacing: { before: 0, after: 0, line: 300, lineRule: LineRuleType.AUTO }, children: runs(ins ?? [], head ? { bold: true, color: official ? '000000' : 'FFFFFF' } : {}) })]
    });
    const pad = (r) => Array.from({ length: cols }, (_, i) => r[i] ?? []);
    // 列宽按内容分：每列取最长的单元格（中文算 2、西文算 1），限制在 4–40 之间，按比例分版心宽度
    const textW = 11906 - page.left - page.right;
    const len = (ins) => [...plain(ins ?? [])].reduce((n, ch) => n + (/[⺀-￿]/.test(ch) ? 2 : 1), 0);
    const weights = Array.from({ length: cols }, (_, i) => Math.min(40, Math.max(4, len(b.header[i]) + 2, ...b.rows.map((r) => len(r[i])))));
    const sum = weights.reduce((a, x) => a + x, 0);
    const widths = weights.map((w) => Math.round((w / sum) * textW));
    return new Table({
      width: { size: textW, type: WidthType.DXA },
      columnWidths: widths,
      rows: [
        new TableRow({ tableHeader: true, cantSplit: true, children: pad(b.header).map((c, i) => cell(c, i, { head: true })) }),
        ...b.rows.map((r, ri) => new TableRow({ cantSplit: true, children: pad(r).map((c, i) => cell(c, i, { zebra: !official && ri % 2 === 1 })) }))
      ]
    });
  }

  async function render(bs, out, { inQuote = false } = {}) {
    for (const b of bs) {
      switch (b.type) {
        case 'heading': {
          const l = level(b.level);
          out.push(new Paragraph({ heading: HL[Math.min(l, 6) - 1], children: runs(b.inlines) }));
          break;
        }
        case 'paragraph':
          if (b.salutation) { out.push(body(b.inlines, { noIndent: true })); break; }
          if (b.signature) {
            out.push(new Paragraph({ alignment: AlignmentType.RIGHT, indent: { right: official ? bodySize * 4 * 20 : 0 }, spacing: { before: b.signFollow ? 0 : official ? 579 : 360 }, children: runs(b.inlines) }));
            break;
          }
          out.push(inQuote
            ? new Paragraph({ children: runs(b.inlines, { color: '404040' }), indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: official ? '808080' : C.accent, space: 8 } }, shading: { type: ShadingType.CLEAR, fill: official ? 'FFFFFF' : C.soft, color: 'auto' }, spacing: { before: 60, after: 60 } })
            : body(b.inlines));
          break;
        case 'list': listBlock(b, out); break;
        case 'table': out.push(tableBlock(b), new Paragraph({ spacing: { after: 120 }, children: [] })); break;
        case 'code':
          for (const [i, line] of b.text.split('\n').entries()) {
            out.push(new Paragraph({
              spacing: { before: i === 0 ? 120 : 0, after: 0, line: 280, lineRule: LineRuleType.AUTO },
              shading: { type: ShadingType.CLEAR, fill: 'F6F8FA', color: 'auto' },
              children: [new TextRun({ text: line || ' ', font: { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: bodyFont.eastAsia }, size: PT(9.5) })]
            }));
          }
          out.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
          break;
        case 'quote': await render(b.blocks, out, { inQuote: true }); break;
        case 'image': await imageBlock(b, out); break;
        case 'hr': out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: official ? '000000' : C.soft, space: 1 } }, spacing: { after: 200 }, children: [] })); break;
        case 'pagebreak': out.push(new Paragraph({ children: [new PageBreak()] })); break;
        default: break;
      }
    }
  }

  // ---------- 正文
  const children = [];
  const front = [];
  if (cover) {
    front.push(
      // 用段前距留白，不用空段落：空段落会继承正文的 1.5 倍行距和段后距，封面会被挤到第二页
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 3400, after: 360 }, children: [new TextRun({ text: docTitle, bold: true, size: PT(official ? 22 : 28), font: font(theme.fonts.title ?? theme.fonts.heading), color: official ? '000000' : C.primary })] }),
      ...(subtitle ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: subtitle, size: PT(16), color: official ? '000000' : C.accent, font: headFont })] })] : []),
      ...(official ? [] : [new Paragraph({ alignment: AlignmentType.CENTER, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: C.accent, space: 1 } }, indent: { left: 3000, right: 3000 }, children: [] })]),
      ...(author ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 4200, after: 120 }, indent: { firstLine: 0 }, children: [new TextRun({ text: author, size: PT(14), font: bodyFont })] })] : []),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: author ? 0 : 4200, after: 0 }, indent: { firstLine: 0 }, children: [new TextRun({ text: date || today(), size: PT(14), font: bodyFont })] }),
      new Paragraph({ children: [new PageBreak()] })
    );
  } else {
    // 没有封面：居中的大标题。有目录时放在目录页最上面（标题 → 目录 → 正文），没有目录时在正文开头
    const titleBlock = [new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun(docTitle)] })];
    if (subtitle) titleBlock.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: subtitle, color: official ? '000000' : C.accent, size: PT(bodySize + 1), font: headFont })] }));
    (wantToc ? front : children).push(...titleBlock);
  }
  if (wantToc) {
    front.push(
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: '目　录', bold: true, size: PT(official ? 16 : 18), font: headFont, color: official ? '000000' : C.primary })] }),
      new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-3' }),
      new Paragraph({ children: [new PageBreak()] })
    );
  }
  await render(blocks, children);

  // ---------- 样式
  const heading = (id, name, sizePt, f, { color = official ? '000000' : C.primary, before = 240, after = 120, outline, bold = true, align } = {}) => ({
    id, name, basedOn: 'Normal', next: 'Normal', quickFormat: true,
    run: { font: f, size: PT(sizePt), bold, color },
    paragraph: { spacing: { before, after, line: official ? 579 : 300, lineRule: official ? LineRuleType.EXACT : LineRuleType.AUTO }, keepNext: true, keepLines: true, outlineLevel: outline, ...(align && { alignment: align }) }
  });
  const H2font = official ? font(theme.fonts.h2) : headFont;
  const H3font = official ? font(theme.fonts.h3) : headFont;
  const paragraphStyles = [
    heading('Title', 'Title', official ? 22 : 22, font(theme.fonts.title ?? theme.fonts.heading), { before: 0, after: 360, align: AlignmentType.CENTER }),
    heading('Heading1', 'heading 1', official ? 16 : 16, headFont, { outline: 0, before: 360, after: 180 }),
    heading('Heading2', 'heading 2', official ? 16 : 14, H2font, { outline: 1, bold: !official }),
    heading('Heading3', 'heading 3', official ? 16 : 12, H3font, { outline: 2, color: official ? '000000' : C.accent }),
    heading('Heading4', 'heading 4', bodySize, headFont, { outline: 3, before: 120, after: 60 }),
    heading('Heading5', 'heading 5', bodySize, headFont, { outline: 4, before: 120, after: 60, bold: false }),
    heading('Heading6', 'heading 6', bodySize, headFont, { outline: 5, before: 120, after: 60, bold: false })
  ];

  // ---------- 编号：项目符号三级循环；有序列表 1. → (1) → ① → a. …
  const bulletChars = ['●', '○', '■'];
  const orderedLevels = [
    [LevelFormat.DECIMAL, '%1.'], [LevelFormat.DECIMAL, '(%2)'], [LevelFormat.DECIMAL_ENCLOSED_CIRCLE, '%3'],
    [LevelFormat.LOWER_LETTER, '%4.'], [LevelFormat.LOWER_ROMAN, '%5.'], [LevelFormat.DECIMAL, '%6.'],
    [LevelFormat.DECIMAL, '%7.'], [LevelFormat.DECIMAL, '%8.'], [LevelFormat.DECIMAL, '%9.']
  ];
  // 公文的“1.”和正文一样首行缩进 2 字、编号紧跟文字；其他文档用悬挂缩进
  const indent = (lvl) => (official ? { left: 0, firstLine: bodySize * 2 * 20 * (lvl + 1) } : { left: 420 * (lvl + 1), hanging: 420 });
  const suffix = official ? LevelSuffix.NOTHING : LevelSuffix.TAB;
  const numbering = {
    config: [
      { reference: 'jarvis-bullets', levels: Array.from({ length: 9 }, (_, l) => ({ level: l, format: LevelFormat.BULLET, text: bulletChars[l % 3], alignment: AlignmentType.LEFT, suffix, style: { paragraph: { indent: indent(l) }, run: { font: { ascii: 'Arial', hAnsi: 'Arial', eastAsia: '宋体' }, size: PT(bodySize * (l % 3 === 0 ? 0.7 : 0.8)), color: official ? '000000' : C.accent } } })) },
      { reference: 'jarvis-ordered', levels: orderedLevels.map(([format, text], l) => ({ level: l, format, text, start: 1, alignment: AlignmentType.LEFT, suffix, style: { paragraph: { indent: indent(l) } } })) }
    ]
  };

  // ---------- 页眉页脚
  const muted = official ? '000000' : '7F7F7F';
  const footer = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: official
        ? [new TextRun({ children: ['— ', PageNumber.CURRENT, ' —'], size: PT(14), font: font('serif') })]
        : [new TextRun({ children: ['第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'], size: PT(9), color: muted, font: bodyFont })]
    })]
  });
  const header = official ? null : new Header({
    children: [new Paragraph({ alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.soft, space: 4 } }, children: [new TextRun({ text: docTitle, size: PT(9), color: muted, font: bodyFont })] })]
  });
  const empty = () => new Footer({ children: [new Paragraph({ children: [] })] });

  const pageProps = { page: { size: { width: 11906, height: 16838 }, margin: { ...page, header: MM(15), footer: MM(official ? 28 : 15) } } };
  const sections = [];
  if (front.length) sections.push({ properties: { ...pageProps, titlePage: false }, footers: { default: empty() }, children: front });
  sections.push({
    properties: { ...pageProps, page: { ...pageProps.page, pageNumbers: { start: 1 } } },
    footers: { default: footer },
    ...(header && { headers: { default: header } }),
    children
  });

  const doc = new Document({
    creator: '未央',
    title: docTitle,
    description: subtitle || undefined,
    styles: {
      default: {
        document: { run: { font: bodyFont, size: PT(bodySize), color: C.ink }, paragraph: { spacing: { ...lineSpacing, after: official ? 0 : 120 } } },
        title: { run: { font: font(theme.fonts.title ?? theme.fonts.heading), size: PT(22), bold: !official, color: official ? '000000' : C.primary } }
      },
      paragraphStyles,
      characterStyles: [{ id: 'Hyperlink', name: 'Hyperlink', basedOn: 'DefaultParagraphFont', run: { color: '0563C1', underline: { type: 'single' } } }]
    },
    numbering,
    features: { updateFields: wantToc },
    sections
  });
  let blob = await Packer.toBlob(doc);
  let templateInfo = null;
  if (template) ({ blob, info: templateInfo } = await applyTemplate(blob, template));
  return { blob, info: { toc: wantToc, images: imageCount, missingImages, headings: hs.length, template: templateInfo } };
}

/**
 * 沿用用户模板的样式：用模板的 styles.xml（字体、字号、标题和正文样式、默认段落），
 * 按样式名称（heading 1、Title……）对上模板里的样式 id —— 中文版 Word 的模板里标题样式的 id 常常是“1”“2”而不是 Heading1；
 * 模板里没有的样式（比如没定义标题 4）用未央自己的补上。
 * @returns {Promise<{ blob: Blob, info: { matched: string[], added: string[] } }>}
 */
export async function applyTemplate(blob, template) {
  const JSZip = (await import('jszip')).default;
  let tpl;
  try { tpl = await JSZip.loadAsync(template); } catch { throw new Error('模板打不开，不是有效的 Word 文件（.docx）'); }
  const tplStyles = await tpl.file('word/styles.xml')?.async('string');
  if (!tplStyles) throw new Error('模板里没有样式定义（word/styles.xml），不是有效的 Word 文件');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const ours = await zip.file('word/styles.xml').async('string');
  const styleRe = /<w:style\b[^>]*>[\s\S]*?<\/w:style>/g;
  const info = (xml) => [...xml.matchAll(styleRe)].map((m) => ({
    xml: m[0],
    id: m[0].match(/w:styleId="([^"]+)"/)?.[1],
    type: m[0].match(/w:type="([^"]+)"/)?.[1],
    name: (m[0].match(/<w:name w:val="([^"]+)"/)?.[1] ?? '').toLowerCase()
  }));
  const tplList = info(tplStyles);
  const ourList = info(ours);
  const map = {};
  const matched = [];
  const added = [];
  let extra = '';
  for (const id of ['Title', 'Heading1', 'Heading2', 'Heading3', 'Heading4', 'Heading5', 'Heading6', 'Hyperlink']) {
    const mine = ourList.find((s) => s.id === id);
    if (!mine) continue;
    const theirs = tplList.find((s) => s.type === mine.type && s.name === mine.name);
    if (theirs) { map[id] = theirs.id; matched.push(mine.name); continue; }
    // 模板里没有：用自己的，id 撞了就换一个
    const newId = tplList.some((s) => s.id === id) ? `Jarvis${id}` : id;
    map[id] = newId;
    extra += mine.xml.replace(`w:styleId="${id}"`, `w:styleId="${newId}"`);
    added.push(mine.name);
  }
  zip.file('word/styles.xml', tplStyles.replace('</w:styles>', `${extra}</w:styles>`));
  for (const f of Object.keys(zip.files).filter((x) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(x))) {
    const xml = await zip.file(f).async('string');
    zip.file(f, xml.replace(/<w:(pStyle|rStyle) w:val="([^"]+)"\/>/g, (m, k, v) => (map[v] ? `<w:${k} w:val="${map[v]}"/>` : m)));
  }
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return { blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), info: { matched, added } };
}

/** 工作区里像模板的 Word 文件：放在“模板 / templates”文件夹里，或文件名里有“模板 / template” */
export const TEMPLATE_PATH = /(^|\/)(模板|templates?)\/[^/]+\.docx$|(^|\/)[^/]*(模板|template)[^/]*\.docx$/i;

function today() {
  const d = new Date(Date.now() + 8 * 3600_000); // 北京时间
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}
