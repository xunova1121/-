/**
 * 写文档用的 Markdown → 文档结构（Word / PPT / 网页 / PDF 共用）。
 * 用 marked（MIT）的词法分析，比聊天气泡用的 core/markdown.js 完整：多级列表、斜体、链接、删除线、引用块、
 * 图片、分隔线、对齐的表格。聊天气泡仍用原来的轻量解析，互不影响。
 *
 * 块：
 *   { type: 'heading', level, inlines }
 *   { type: 'paragraph', inlines }
 *   { type: 'list', ordered, start, items: [{ inlines, children: 块[] }] }
 *   { type: 'table', header: inlines[], align: ('left'|'center'|'right'|null)[], rows: inlines[][] }
 *   { type: 'code', text, lang }
 *   { type: 'quote', blocks }
 *   { type: 'image', src, alt }
 *   { type: 'hr' }
 *   { type: 'pagebreak' }           单独一行写 [分页] 或 <!-- 分页 -->
 * 行内：{ text, bold?, italic?, code?, strike?, link? }
 */
import { Marked } from 'marked';

// 中文的粗体：“**编制单位：**江苏省……”按 CommonMark 规则不算粗体（结束的 ** 前面是标点、后面紧跟汉字），
// 模型却经常这样写，结果文档里露出星号。这里先按“同一行里成对的 **”认粗体
const cjkStrong = {
  name: 'cjkStrong',
  level: 'inline',
  start(src) { const i = src.indexOf('**'); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^\*\*(?![\s*])([^\n]*?[^\s*])\*\*(?!\*)/.exec(src);
    if (m) return { type: 'strong', raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
  }
};
const markedCjk = new Marked({ gfm: true, extensions: [cjkStrong] });

const PAGEBREAK = /^\s*(\[分页\]|<!--\s*(分页|pagebreak)\s*-->|\\newpage|\\pagebreak)\s*$/i;

/** 行内 token → 扁平的 [{ text, bold, italic, ... }] */
function inlines(tokens = [], style = {}) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'strong': out.push(...inlines(t.tokens, { ...style, bold: true })); break;
      case 'em': out.push(...inlines(t.tokens, { ...style, italic: true })); break;
      case 'del': out.push(...inlines(t.tokens, { ...style, strike: true })); break;
      case 'codespan': out.push({ ...style, text: decode(t.text), code: true }); break;
      case 'link': out.push(...inlines(t.tokens, { ...style, link: t.href })); break;
      case 'br': out.push({ ...style, text: '\n' }); break;
      case 'image': out.push({ ...style, text: t.text || '' , image: t.href }); break;
      case 'text': case 'escape':
        if (t.tokens?.length) out.push(...inlines(t.tokens, style));
        else out.push({ ...style, text: decode(t.text) });
        break;
      case 'html': if (!/^<!--/.test(t.text)) out.push({ ...style, text: t.text }); break; // 行内 HTML 当文字
      default: if (t.text) out.push({ ...style, text: decode(t.text) });
    }
  }
  // 相邻同样式合并
  const merged = [];
  for (const s of out) {
    const last = merged.at(-1);
    if (last && !s.image && !last.image && ['bold', 'italic', 'code', 'strike', 'link'].every((k) => last[k] === s[k])) last.text += s.text;
    else merged.push({ ...s });
  }
  return merged.filter((s) => s.text || s.image);
}

const decode = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function blocks(tokens = []) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': out.push({ type: 'heading', level: Math.min(6, t.depth), inlines: inlines(t.tokens) }); break;
      case 'paragraph': {
        if (PAGEBREAK.test(t.text)) { out.push({ type: 'pagebreak' }); break; }
        const ins = inlines(t.tokens);
        // 只有一张图片的段落 → 图片块
        if (ins.length === 1 && ins[0].image) out.push({ type: 'image', src: ins[0].image, alt: ins[0].text });
        else out.push({ type: 'paragraph', inlines: ins.filter((s) => !s.image || s.text) });
        break;
      }
      case 'text': out.push({ type: 'paragraph', inlines: inlines(t.tokens ?? [{ type: 'text', text: t.text }]) }); break;
      case 'list': {
        // 紧跟在列表项后面的图片会被 Markdown 并进那一项：拿出来，放在列表后面单独成块
        const pics = [];
        out.push({
          type: 'list', ordered: t.ordered, start: Number(t.start) || 1,
          items: t.items.map((it) => {
            const sub = blocks(it.tokens);
            const first = sub[0]?.type === 'paragraph' ? sub.shift() : null;
            const text = (first?.inlines ?? []).filter((s) => {
              if (!s.image) return true;
              pics.push({ type: 'image', src: s.image, alt: s.text });
              return false;
            });
            if (text.length) text[text.length - 1] = { ...text.at(-1), text: text.at(-1).text.replace(/\s+$/, '') };
            for (let k = sub.length - 1; k >= 0; k--) if (sub[k].type === 'image') pics.push(...sub.splice(k, 1));
            if (it.task) text.unshift({ text: it.checked ? '☑ ' : '☐ ' });
            return { inlines: text, children: sub };
          })
        });
        out.push(...pics);
        break;
      }
      case 'table':
        out.push({ type: 'table', header: t.header.map((c) => inlines(c.tokens)), align: t.align ?? [], rows: t.rows.map((r) => r.map((c) => inlines(c.tokens))) });
        break;
      case 'code': out.push({ type: 'code', text: t.text, lang: t.lang || '' }); break;
      case 'blockquote': out.push({ type: 'quote', blocks: blocks(t.tokens) }); break;
      case 'hr': out.push({ type: 'hr' }); break;
      case 'html':
        // 分页标记；其余 HTML 原样当文字显示（不执行，也不吞掉内容）
        if (PAGEBREAK.test(t.text)) out.push({ type: 'pagebreak' });
        else if (!/^\s*<!--[\s\S]*-->\s*$/.test(t.text) && t.text.trim()) out.push({ type: 'paragraph', inlines: [{ text: t.text.trim() }] });
        break;
      case 'space': break;
      default: if (t.text) out.push({ type: 'paragraph', inlines: [{ text: decode(t.text) }] });
    }
  }
  return out;
}

/** @returns {Array<object>} 文档块 */
export function parseDoc(md) {
  // 单独一行的 --- 一律当分隔线（Markdown 里“文字\n---”会被当成二级标题，写文档时没人这么用）
  const text = String(md ?? '').replace(/\r\n/g, '\n').replace(/\n[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*(?=\n|$)/g, '\n\n$1\n');
  return blocks(markedCjk.lexer(text));
}

/** 行内 → 纯文字 */
export const plain = (ins = []) => ins.map((s) => s.text).join('');

/** 文档里的各级标题（目录用） */
export function headings(doc) {
  return doc.filter((b) => b.type === 'heading').map((b) => ({ level: b.level, text: plain(b.inlines) }));
}

/** 落款里的日期：2026 年 10 月 14 日 / 2026-10-14 / 二〇二六年十月十四日 */
const SIGN_DATE = /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-./]\d{1,2}[-./]\d{1,2}|[〇零一二三四五六七八九十]{4}年[一二三四五六七八九十]{1,3}月[一二三四五六七八九十]{1,3}日)$/;

/** 称呼（开头单独一段、以冒号结尾，如“各部门：”）标 salutation，顶格；落款（结尾的单位 + 日期）标 signature，右对齐 */
export function markSalutationAndSignature(doc) {
  const first = doc.find((b) => b.type !== 'heading');
  if (first?.type === 'paragraph' && /[:：]$/.test(plain(first.inlines).trim()) && plain(first.inlines).length <= 40) first.salutation = true;
  const last = doc.at(-1);
  if (last?.type === 'paragraph' && SIGN_DATE.test(plain(last.inlines).trim()) && plain(last.inlines).length <= 60) last.signature = true;
  return doc;
}

/** 文档里的图片路径 */
export function images(doc) {
  const out = [];
  const walk = (bs) => {
    for (const b of bs) {
      if (b.type === 'image') out.push(b.src);
      else if (b.type === 'quote') walk(b.blocks);
      else if (b.type === 'list') for (const it of b.items) walk(it.children);
    }
  };
  walk(doc);
  return out;
}
