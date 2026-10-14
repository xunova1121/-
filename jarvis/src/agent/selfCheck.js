/**
 * 生成后自查：
 *   1. 规则检查（不花钱，每次都做）：空章节、标题跳级、表格列数对不上、单元格太长撑破版面、[分页] 造成空白页、
 *      占位文字（XXX、待补充、TODO）、PPT 某页字太多会溢出、表格行数太多挤不下
 *   2. 模型检查（有用户原始要求或规则查出硬伤时做）：把文档“排出来的样子”（标题层级、每节字数、表格行列、图片、分页）
 *      和正文交给模型，对照原始要求找漏项、溢出、错乱；模型只给具体修改（按原文片段替换 / 在某个标题后补内容），
 *      程序改好后重新生成一次。只改一轮。
 */
import { parseDoc, plain } from './docModel.js';
import { parseSlides } from './pptxWriter.js';
import { parseSheets } from './sheetParse.js';
import { parseJson } from './research.js';

const PLACEHOLDER = /X{3,}|×{3,}|待补充|待完善|此处填写|【此处|\[此处|TODO|TBD|lorem ipsum|某某某/i;
const DOC_FORMATS = ['docx', 'pdf', 'html', 'md'];

/**
 * @param {string} format
 * @param {string} content  Markdown / 表格
 * @returns {Array<{ level: 'error'|'warn', text: string }>}
 */
export function lint(format, content) {
  const issues = [];
  const add = (level, text) => issues.push({ level, text });
  const md = String(content ?? '');
  if (md.replace(/\s/g, '').length < 10) { add('error', '内容几乎是空的'); return issues; }
  const ph = md.match(PLACEHOLDER);
  if (ph) add('error', `还有占位文字没填：“${ph[0]}”`);

  if (format === 'xlsx' || format === 'csv') {
    for (const s of parseSheets(md, { raw: true })) {
      if (!s.rows.length) add('error', `工作表“${s.name}”是空的`);
      const n = s.rows[0]?.length ?? 0;
      const bad = s.rows.findIndex((r) => r.length !== n);
      if (bad > 0) add('warn', `工作表“${s.name}”第 ${bad + 1} 行有 ${s.rows[bad].length} 列，表头是 ${n} 列`);
    }
    return issues;
  }

  if (format === 'pptx') {
    for (const [i, s] of parseSlides('', md).entries()) {
      const chars = s.blocks.map((b) => blockText(b)).join('').length;
      const label = `第 ${i + 2} 页「${s.title || '无标题'}」`;
      if (chars > 350) add('error', `${label}字太多（约 ${chars} 字），会溢出页面，应拆成两页或精简到每页 7 条以内`);
      const t = s.blocks.find((b) => b.type === 'table');
      if (t && t.rows.length > 8) add('warn', `${label}的表格有 ${t.rows.length} 行，一页放不下，建议拆页或只留关键行`);
      if (t && t.header.length > 6) add('warn', `${label}的表格有 ${t.header.length} 列，字会很小`);
      if (s.title.length > 30) add('warn', `${label}标题太长（${s.title.length} 字），建议 20 字以内`);
    }
    return issues;
  }

  // Word / PDF / 网页
  const blocks = parseDoc(md);
  let prevLevel = 0;
  blocks.forEach((b, i) => {
    if (b.type === 'heading') {
      if (prevLevel && b.level > prevLevel + 1) add('warn', `标题跳级：“${plain(b.inlines)}”从 ${'#'.repeat(prevLevel)} 直接到了 ${'#'.repeat(b.level)}`);
      prevLevel = b.level;
      const next = blocks[i + 1];
      if (b.level > 1 && (!next || (next.type === 'heading' && next.level <= b.level))) add('error', `“${plain(b.inlines)}”这一节没有内容`);
    }
    if (b.type === 'table') {
      const n = b.header.length;
      const long = b.rows.flat().find((c) => plain(c).length > 200);
      if (long) add('warn', `表格里有一格超过 200 字（“${plain(long).slice(0, 20)}…”），会把表格撑得很长，建议放到正文`);
      if (n > 8) add('warn', `有个表格 ${n} 列，A4 竖版放不下，字会很挤`);
    }
    if (b.type === 'pagebreak' && (i === 0 || i === blocks.length - 1 || blocks[i - 1]?.type === 'pagebreak')) add('error', '[分页] 位置会产生空白页（在开头、结尾或连着两个）');
  });
  // 表格列数：按原文逐行数（解析器会悄悄丢掉多出来的格、补齐少的格，排出来就错位了）
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length;
  let head = 0;
  let row = 0;
  for (const line of md.split('\n')) {
    if (!/^\s*\|.*\|\s*$/.test(line)) { head = 0; continue; }
    if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line)) continue; // 分隔行
    if (!head) { head = cells(line); row = 0; continue; }
    row++;
    if (cells(line) !== head) { add('error', `有个表格第 ${row} 行是 ${cells(line)} 列，表头是 ${head} 列，列数和表头不一致，排出来会错位`); head = -1; }
  }
  const titles = blocks.filter((b) => b.type === 'heading').map((b) => plain(b.inlines));
  const dup = titles.find((t, i) => t && titles.indexOf(t) !== i);
  if (dup) add('warn', `标题“${dup}”重复出现`);
  return issues;
}

function blockText(b) {
  if (b.type === 'paragraph' || b.type === 'heading') return plain(b.inlines);
  if (b.type === 'list') return b.items.map((it) => plain(it.inlines) + it.children.map(blockText).join('')).join('');
  if (b.type === 'table') return [b.header, ...b.rows].flat().map(plain).join('');
  if (b.type === 'quote') return b.blocks.map(blockText).join('');
  if (b.type === 'code') return b.text;
  return '';
}

/** 文档“排出来的样子”：给模型看结构，而不是只看原文 */
export function layoutSummary(format, content) {
  if (format === 'pptx') {
    return parseSlides('', content).map((s, i) => `第 ${i + 2} 页「${s.title}」：${s.blocks.map((b) => (b.type === 'table' ? `表格 ${b.rows.length} 行 × ${b.header.length} 列` : b.type === 'image' ? '图片' : b.type === 'list' ? `${b.items.length} 条要点` : '段落')).join('、') || '只有标题'}，约 ${s.blocks.map(blockText).join('').length} 字`).join('\n');
  }
  const blocks = parseDoc(content);
  const out = [];
  let words = 0;
  let cur = null;
  const flush = () => { if (cur) out.push(`${cur}（约 ${words} 字）`); words = 0; };
  for (const b of blocks) {
    if (b.type === 'heading') { flush(); cur = `${'  '.repeat(Math.max(0, b.level - 1))}${'#'.repeat(b.level)} ${plain(b.inlines)}`; continue; }
    if (b.type === 'table') out.push(`${cur ? '    ' : ''}[表格 ${b.rows.length} 行 × ${b.header.length} 列]`);
    if (b.type === 'image') out.push(`${cur ? '    ' : ''}[图片：${b.alt || b.src}]`);
    if (b.type === 'pagebreak') out.push('    [分页]');
    words += blockText(b).length;
  }
  flush();
  return out.join('\n');
}

/**
 * 模型对照要求检查，返回修改
 * @returns {Promise<{ problems: string[], content: string, changed: number }>}
 */
export async function reviewWithModel({ format, content, requirements = '', issues = [], llm, signal }) {
  const j = parseJson(await llm({
    signal,
    system: '你是严格的文档审校。对照用户的原始要求检查刚生成的文档，只找真正的问题，并给出能直接执行的修改。只输出 JSON。',
    prompt: `文档格式：${format}
${requirements ? `用户的原始要求：\n${String(requirements).slice(0, 2000)}\n` : ''}
排版后的结构：
${layoutSummary(format, content).slice(0, 4000)}

程序检查发现的问题：
${issues.map((x) => `- ${x.text}`).join('\n') || '（无）'}

文档原文（Markdown）：
${String(content).slice(0, 24000)}

检查：有没有漏掉用户要求的内容、字数或页数明显不符、空页空节、表格错乱、${format === 'pptx' ? '某页字太多溢出、' : ''}占位文字没填、前后矛盾。
输出 JSON：{"problems":["问题，没有就空数组"],"edits":[{"find":"原文里一字不差的片段（10-80 字）","replace":"改成"}],"append_after":[{"heading":"已有的标题原文（不带 #）","markdown":"要补在这一节末尾的 Markdown"}]}
修改只针对上面的问题；数据材料里没有的写“待确认”，不要编造。没有问题就都给空数组。`
  }));
  let text = String(content);
  let changed = 0;
  for (const e of Array.isArray(j?.edits) ? j.edits.slice(0, 12) : []) {
    const find = String(e?.find ?? '');
    if (find.length >= 4 && text.includes(find) && typeof e.replace === 'string') { text = text.replace(find, () => e.replace); changed++; }
  }
  for (const a of Array.isArray(j?.append_after) ? j.append_after.slice(0, 6) : []) {
    const h = String(a?.heading ?? '').replace(/^#+\s*/, '').trim();
    const add = String(a?.markdown ?? '').trim();
    if (!h || !add) continue;
    const lines = text.split('\n');
    const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').trim() === h);
    if (at < 0) continue;
    const level = lines[at].match(/^#+/)[0].length;
    let end = lines.findIndex((l, k) => k > at && /^#{1,6}\s/.test(l) && l.match(/^#+/)[0].length <= level);
    if (end < 0) end = lines.length;
    while (end > at + 1 && !lines[end - 1].trim()) end--; // 补在这一节最后一行文字后面
    lines.splice(end, 0, '', add, '');
    text = lines.join('\n');
    changed++;
  }
  return { problems: (Array.isArray(j?.problems) ? j.problems : []).map(String).filter(Boolean), content: text, changed };
}

/**
 * 生成前后的自查流程（create_document 用）
 * @returns {Promise<{ content: string, issues: object[], problems: string[], changed: number, checked: boolean }>}
 */
export async function selfCheck({ format, content, requirements = '', llm = null, signal, onProgress }) {
  const issues = lint(format, content);
  const needModel = llm && DOC_FORMATS.concat('pptx').includes(format) && (requirements || issues.some((x) => x.level === 'error'));
  if (!needModel) return { content, issues, problems: [], changed: 0, checked: false };
  onProgress?.('对照要求自查…');
  try {
    const r = await reviewWithModel({ format, content, requirements, issues, llm, signal });
    const after = r.changed ? lint(format, r.content) : issues;
    return { content: r.content, issues: after, problems: r.problems, changed: r.changed, checked: true };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return { content, issues, problems: [], changed: 0, checked: false };
  }
}
