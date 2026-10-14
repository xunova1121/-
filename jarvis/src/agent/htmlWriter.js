/**
 * Markdown → 排好版的 HTML 文档（网页、可打印 / PDF 共用），配色和字体跟 Word 用同一套主题（themes.js）。
 * 打印版：A4、页边距、[分页]、页码（浏览器支持 @page 页边框时；桌面版导出 PDF 时由 Electron 加页脚）。
 * 所有文字都转义；链接只允许 http(s) / mailto；图片只用预先读好的 data: 地址。
 */
import { parseDoc, plain, headings } from './docModel.js';
import { FONTS, THEMES } from './themes.js';

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeHref = (u) => (/^(https?:|mailto:)/i.test(String(u).trim()) ? String(u).trim() : null);
const fontStack = (key) => {
  const f = FONTS[key] ?? FONTS.sans;
  const cn = { 微软雅黑: '"Microsoft YaHei","PingFang SC","Noto Sans SC"', 宋体: '"SimSun","Songti SC","Noto Serif SC"', 黑体: '"SimHei","Heiti SC","Noto Sans SC"', 楷体: '"KaiTi","STKaiti","Kaiti SC"', 仿宋: '"FangSong","STFangsong","FangSong_GB2312"', 方正小标宋简体: '"FZXiaoBiaoSong-B05S","方正小标宋简体","SimSun","Songti SC"' }[f.eastAsia] ?? '"Microsoft YaHei"';
  return `"${f.latin}",${cn},sans-serif`;
};

function inlineHtml(ins = []) {
  return ins.map((s) => {
    let h = esc(s.text).replace(/\n/g, '<br>');
    if (s.code) h = `<code>${h}</code>`;
    if (s.bold) h = `<strong>${h}</strong>`;
    if (s.italic) h = `<em>${h}</em>`;
    if (s.strike) h = `<del>${h}</del>`;
    const href = s.link && safeHref(s.link);
    if (href) h = `<a href="${esc(href)}">${h}</a>`;
    return h;
  }).join('');
}

/**
 * @param {object[]} blocks  docModel 的块
 * @param {{ images?: Map<string,string>, shift?: number, ids?: string[] }} [o]  images：图片路径 → data: 地址
 */
export function blocksToHtml(blocks, { images = new Map(), shift = 0, ids = [] } = {}) {
  let h = 0;
  let fig = 0;
  const walk = (bs) => bs.map((b) => {
    switch (b.type) {
      case 'heading': {
        const l = Math.min(6, Math.max(1, b.level - shift));
        const id = ids[h++] ?? '';
        return `<h${l}${id ? ` id="${id}"` : ''}>${inlineHtml(b.inlines)}</h${l}>`;
      }
      case 'paragraph': return `<p>${inlineHtml(b.inlines)}</p>`;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        return `<${tag}${b.ordered && b.start !== 1 ? ` start="${b.start}"` : ''}>${b.items.map((it) => `<li>${inlineHtml(it.inlines)}${walk(it.children)}</li>`).join('')}</${tag}>`;
      }
      case 'table': {
        const al = (i) => (b.align[i] ? ` style="text-align:${b.align[i]}"` : '');
        return `<table><thead><tr>${b.header.map((c) => `<th>${inlineHtml(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c, i) => `<td${al(i)}>${inlineHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      }
      case 'code': return `<pre><code>${esc(b.text)}</code></pre>`;
      case 'quote': return `<blockquote>${walk(b.blocks)}</blockquote>`;
      case 'image': {
        const src = images.get(b.src);
        if (!src) return `<p class="missing">［图片：${esc(b.alt || b.src)}］</p>`;
        fig++;
        return `<figure><img src="${esc(src)}" alt="${esc(b.alt)}">${b.alt ? `<figcaption>图 ${fig}　${esc(b.alt)}</figcaption>` : ''}</figure>`;
      }
      case 'hr': return '<hr>';
      case 'pagebreak': return '<div class="page-break"></div>';
      default: return '';
    }
  }).join('\n');
  return walk(blocks);
}

/** 兼容旧接口：Markdown 片段 → HTML */
export const markdownToHtml = (md) => blocksToHtml(parseDoc(md));

/**
 * 完整的 HTML 文档
 * @param {string} title
 * @param {string} md
 * @param {{ printable?: boolean, theme?: object, cover?: boolean, subtitle?: string, author?: string, date?: string, toc?: 'auto'|boolean, images?: Map<string,string> }} [o]
 */
export function htmlDocument(title, md, { printable = false, theme = THEMES.business, cover = false, subtitle = '', author = '', date = '', toc = 'auto', images } = {}) {
  const blocks = parseDoc(md);
  const official = Boolean(theme.official);
  const C = theme.colors;
  // 开头唯一的一级标题 = 文档大标题（和 Word 一致）
  const h1 = blocks.filter((b) => b.type === 'heading' && b.level === 1);
  let docTitle = title;
  let shift = 0;
  if (h1.length === 1 && blocks[0] === h1[0]) { docTitle = plain(blocks.shift().inlines) || title; shift = 1; } else if (!h1.length) shift = 1;
  const hs = headings(blocks).map((x, i) => ({ ...x, level: Math.max(1, x.level - shift), id: `s${i + 1}` }));
  const wantToc = toc === true || (toc === 'auto' && hs.filter((x) => x.level === 1).length >= 3);
  const tocHtml = wantToc
    ? `<nav class="toc"><h2 class="toc-title">目　录</h2><ol>${hs.filter((x) => x.level <= 3).map((x) => `<li class="l${x.level}"><a href="#${x.id}">${esc(x.text)}</a></li>`).join('')}</ol></nav>${printable ? '<div class="page-break"></div>' : ''}`
    : '';
  const coverHtml = cover
    ? `<section class="cover"><h1>${esc(docTitle)}</h1>${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}<div class="rule"></div><p class="meta">${author ? `${esc(author)}<br>` : ''}${esc(date || today())}</p></section><div class="page-break"></div>`
    : `<h1 class="doc-title">${esc(docTitle)}</h1>${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}`;
  const bodyFont = fontStack(theme.fonts.body);
  const headFont = fontStack(theme.fonts.heading);
  const css = `
:root{--ink:#${C.ink};--primary:#${C.primary};--accent:#${C.accent};--soft:#${C.soft};--bg:#${C.bg}}
*{box-sizing:border-box}
body{font-family:${bodyFont};color:var(--ink);background:#fff;max-width:800px;margin:40px auto;padding:0 24px;line-height:${official ? 1.8 : 1.75};font-size:${official ? '16pt' : '15px'}}
h1,h2,h3,h4,h5,h6{font-family:${headFont};color:var(--primary);line-height:1.35;break-after:avoid;page-break-after:avoid}
.doc-title,.cover h1{font-family:${fontStack(theme.fonts.title ?? theme.fonts.heading)};text-align:center;font-size:${official ? '22pt' : '28px'};margin:8px 0 6px}
.sub{text-align:center;color:var(--accent);margin:0 0 24px}
h1{font-size:${official ? '16pt' : '22px'};margin:32px 0 12px;${official ? '' : 'border-bottom:2px solid var(--accent);padding-bottom:6px'}}
h2{font-size:${official ? '16pt' : '18px'};margin:24px 0 10px${official ? `;font-family:${fontStack(theme.fonts.h2)};font-weight:normal` : ''}}
h3{font-size:${official ? '16pt' : '16px'};margin:18px 0 8px;color:${official ? 'var(--ink)' : 'var(--accent)'}${official ? `;font-family:${fontStack(theme.fonts.h3)}` : ''}}
p{margin:0 0 10px;text-indent:2em;text-align:justify}
li>p,blockquote p,figcaption,.sub,.meta,.missing{text-indent:0}
ul,ol{margin:0 0 10px;padding-left:2em}li{margin:3px 0}
ul li::marker{color:var(--accent)}
a{color:#0563c1}
table{border-collapse:collapse;width:100%;margin:12px 0 16px;font-size:.95em;break-inside:auto}
th,td{border:1px solid ${official ? '#000' : '#bfc7d1'};padding:6px 10px;text-align:left;vertical-align:middle}
th{background:${official ? '#f2f2f2' : 'var(--accent)'};color:${official ? '#000' : '#fff'};font-weight:bold;text-align:center}
tbody tr:nth-child(even) td{background:${official ? 'transparent' : 'var(--soft)'}}
thead{display:table-header-group}tr{break-inside:avoid}
code{font-family:Consolas,monospace;background:#f2f4f7;padding:1px 5px;border-radius:4px;font-size:.92em}
pre{background:#f6f8fa;padding:12px 14px;border-radius:6px;overflow:auto;line-height:1.5}pre code{background:none;padding:0}
blockquote{margin:12px 0;padding:8px 14px;border-left:4px solid var(--accent);background:var(--soft);color:#404040}
hr{border:0;border-top:1px solid var(--soft);margin:20px 0}
figure{margin:16px 0;text-align:center;break-inside:avoid}figure img{max-width:100%;height:auto}figcaption{font-size:.9em;color:#595959;margin-top:6px}
.missing{text-align:center;color:#888;font-style:italic}
.toc{margin:8px 0 28px}.toc-title{text-align:center;border:0}.toc ol{list-style:none;padding:0}.toc li{margin:4px 0}.toc .l2{padding-left:2em}.toc .l3{padding-left:4em}.toc a{color:inherit;text-decoration:none;border-bottom:1px dotted #bbb}
.cover{min-height:80vh;display:flex;flex-direction:column;justify-content:center;text-align:center}.cover .rule{width:180px;height:3px;background:var(--accent);margin:20px auto}.cover .meta{margin-top:40vh;text-indent:0}
.page-break{break-after:page;page-break-after:always;height:0}
${printable ? `@page{size:A4;margin:${official ? '37mm 26mm 35mm 28mm' : '25.4mm 31.8mm'};@bottom-center{content:${official ? '"— " counter(page) " —"' : '"第 " counter(page) " 页"'};font-size:9pt;color:#7f7f7f}}
@media print{body{margin:0;max-width:none;padding:0}a{color:inherit;text-decoration:none}}` : ''}`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(docTitle)}</title>
<style>${css}</style></head><body>
${coverHtml}
${tocHtml}
${blocksToHtml(blocks, { images, shift, ids: hs.map((x) => x.id) })}
</body></html>`;
}

function today() {
  const d = new Date(Date.now() + 8 * 3600_000);
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}
