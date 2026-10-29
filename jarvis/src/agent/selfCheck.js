import { throwControl } from '../core/networkRequest.js';
/**
 * 生成后自查：
 *   1. 规则检查（不花钱，每次都做）：空章节、标题跳级、表格列数对不上、单元格太长撑破版面、[分页] 造成空白页、
 *      占位文字（XXX、TODO；“待查 / 待补充”只算提醒）、PPT 某页字太多会溢出、表格行数太多挤不下
 *   2. 模型检查（有用户原始要求或规则查出硬伤时做）：把文档“排出来的样子”（标题层级、每节字数、表格行列、图片、分页）
 *      和正文交给模型，对照原始要求找漏项、溢出、错乱；模型只给具体修改（按原文片段替换 / 在某个标题后补内容），
 *      程序改好后重新生成一次。只改一轮。
 */
import { CHECKLIST } from './writingGuide.js';
import { parseDoc, plain } from './docModel.js';
import { parseSlides } from './pptxWriter.js';
import { parseSheets } from './sheetParse.js';
import { parseJson } from './research.js';

const PLACEHOLDER = /X{3,}|×{3,}|此处填写|【此处|\[此处|TODO|lorem ipsum|某某某/i;
/** 如实标出“没查到 / 还没定”的格子（门票待查、价格待确认）：是允许交付的提醒，不当成错误去反复返工 */
const PENDING_MARK = /待补充|待完善|待查|待确认|待定|TBD/gi;
/** 汇报里的空话套话：查出来提醒换成具体的动作和数字 */
const CLICHE = /赋能|抓手|闭环|全方位|深度融合|高度重视|积极推进|持续发力/g;
const DOC_FORMATS = ['docx', 'pdf', 'html', 'md'];

/**
 * @param {string} format
 * @param {string} content  Markdown / 表格
 * @returns {Array<{ level: 'error'|'warn', text: string }>}
 */
export function lint(format, content, { kind = '' } = {}) {
  const issues = [];
  const add = (level, text) => issues.push({ level, text });
  const md = String(content ?? '');
  if (md.replace(/\s/g, '').length < 10) { add('error', '内容几乎是空的'); return issues; }
  const ph = md.match(PLACEHOLDER);
  if (ph) add('error', `还有占位文字没填：“${ph[0]}”`);
  const pending = md.match(PENDING_MARK);
  if (pending) add('warn', `有 ${pending.length} 处标着“${[...new Set(pending)].slice(0, 3).join('、')}”，交付时告诉用户哪些还没查到，不用为此返工`);

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
    const cliches = [...new Set(md.match(CLICHE) ?? [])];
    if (cliches.length) add('warn', `用了套话“${cliches.join('、')}”，换成具体的动作和数字`);
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
      // 单页告示本来就一行一条（“面积 120 平方”“价格面议”写成小标题也照样排成一行），不算“这一节没有内容”
      if (kind !== 'poster' && b.level > 1 && (!next || (next.type === 'heading' && next.level <= b.level))) add('error', `“${plain(b.inlines)}”这一节没有内容`);
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

/**
 * 用户自己给了分段（“1. 深渊脱困，天运子追杀（131—132集）：……”）：每段要有对应的一页 / 一节，顺序不变。
 * 以前审稿模型按套来的模板规则把几段内容挪来挪去，第 3 段整段塞进别的页、第 5 段拆成两页还重复。
 */
export function userSections(requirements) {
  const out = [];
  for (const line of String(requirements ?? '').split('\n')) {
    const m = /^\s*(?:第?([一二三四五六七八九十\d]{1,2})[.、．）)]|[（(]([一二三四五六七八九十\d]{1,2})[）)])\s*(.{2,40}?)(?:[（(][^）)]*[）)])?\s*[:：]/.exec(line);
    if (m) out.push(m[3].replace(/[*#]/g, '').trim());
  }
  return out.length >= 3 ? out : [];
}
const grams = (t) => { const s = String(t).replace(/[\s\p{P}\d]/gu, ''); const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
const overlap = (a, b) => { const A = grams(a); if (!A.size) return 0; const B = grams(b); let n = 0; for (const x of A) if (B.has(x)) n++; return n / A.size; };
export function coverageIssues(format, requirements, content) {
  const secs = userSections(requirements);
  if (!secs.length || !['pptx', ...DOC_FORMATS].includes(format)) return [];
  // 每页 / 每节：标题 + 正文（模型常把标题改写成别的说法，只比标题会误报）
  const parts = format === 'pptx'
    ? parseSlides('', content).map((sl) => `${sl.title} ${sl.title} ${sl.blocks.map(blockText).join('')}`)
    : sectionTexts(content);
  const unit = format === 'pptx' ? '页' : '节';
  const issues = [];
  const at = secs.map((sec) => {
    const scores = parts.map((t) => overlap(sec, t));
    const best = Math.max(0, ...scores);
    return best < 0.15 ? -1 : scores.indexOf(best);
  });
  at.forEach((i, k) => {
    if (i < 0) issues.push({ level: 'error', text: `用户给的第 ${k + 1} 段「${secs[k]}」找不到对应的一${unit}，按用户的分段一段一${unit}、顺序不变` });
  });
  const found = at.filter((i) => i >= 0);
  if (found.some((i, k) => k && i < found[k - 1])) issues.push({ level: 'error', text: `各${unit}顺序和用户给的分段顺序不一致，按用户给的顺序排` });
  for (let k = 1; k < at.length; k++) {
    if (at[k] >= 0 && at[k] === at[k - 1]) issues.push({ level: 'error', text: `用户给的第 ${k} 段和第 ${k + 1} 段挤在了同一${unit}，应各占一${unit}` });
  }
  return issues;
}

/** Word：按 ## 分节，每节的标题 + 正文 */
function sectionTexts(content) {
  const out = [];
  for (const b of parseDoc(content)) {
    if (b.type === 'heading' && b.level === 2) out.push('');
    if (out.length) out[out.length - 1] += ' ' + blockText(b);
  }
  return out;
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
export async function reviewWithModel({ format, content, requirements = '', issues = [], llm, signal, layout = '' }) {
  const sheet = format === 'xlsx';
  const j = parseJson(await llm({
    signal,
    system: '你是严格的文档审校。对照用户的原始要求检查刚生成的文档，只找真正的问题，并给出能直接执行的修改。只输出 JSON。',
    prompt: `文档格式：${format}
${requirements ? `用户的原始要求：\n${String(requirements).slice(0, 2000)}\n` : ''}
${sheet ? '生成后每个单元格在 Excel 里的位置（公式里的行号以这里为准，和原文的行不一样）' : '排版后的结构'}：
${(layout || layoutSummary(format, content)).slice(0, sheet ? 8000 : 4000)}

程序检查发现的问题：
${issues.map((x) => `- ${x.text}`).join('\n') || '（无）'}

文档原文（Markdown）：
${String(content).slice(0, 24000)}

${sheet ? `检查：程序查出的每个公式问题都要改掉——对照上面的单元格位置改成正确的引用（如 =SUM(B2:B9) 改成 =SUM(B4:B11)），函数名拼错的改对，除数可能是 0 或空的用 IFERROR(…,"") 包住；在原文里找到那个公式原样替换。也看看有没有漏掉用户要求的内容。` : `检查：有没有漏掉用户要求的内容、字数或页数明显不符、空页空节、表格错乱、${format === 'pptx' ? '某页字太多溢出、一页里混进了别的段落的内容、' : ''}占位文字没填、前后矛盾${format === 'pptx' ? '' : '、只有一句话没有展开的要点（用 append_after 补上依据和分析）'}。`}
${format === 'pptx' || sheet ? '' : CHECKLIST}
输出 JSON：{"problems":["问题，没有就空数组"],"edits":[{"find":"原文里一字不差的片段（10-80 字）","replace":"改成"}],"append_after":[{"heading":"已有的标题原文（不带 #）","markdown":"要补在这一节末尾的 Markdown"}]}
修改只针对上面的问题；用户自己给了分段和顺序的，保持一段一${format === 'pptx' ? '页' : '节'}、顺序不变，不把一段的内容挪到别处；材料没有的事实数字不得编造；业务建议可以提出但写明假设。真正需要决策的未知事项集中列出并说明影响，不要满篇待确认，也不能擅自延后用户明确要求。没有问题就都给空数组。`
  }));
  return applyEdits(content, j);
}

/** 按模型给的 JSON 改原文：edits（原文片段替换）、append_after（补在某个标题那一节末尾） */
export function applyEdits(content, j) {
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

/** 模型自查一次最多等这么久：它是锦上添花的一步，模型迟迟不回就跳过，文档照常生成（以前会一直“对照要求自查…”） */
export const REVIEW_CAP_MS = 60_000;
export function capped(llm, signal, ms = REVIEW_CAP_MS) {
  return (request) =>
    new Promise((resolve, reject) => {
      const ctrl = new AbortController();
      // 用户点停止：马上停，不等模型那边响应
      const stop = () => {
        ctrl.abort(signal.reason);
        reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (signal?.aborted) stop();
      else signal?.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(() => {
        ctrl.abort();
        reject(Object.assign(new Error('自查等待太久，先跳过'), { code: 'REVIEW_TIMEOUT' }));
      }, ms);
      Promise.resolve()
        .then(() => llm({ ...request, signal: ctrl.signal, maxTransientRetries: 0 }))
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', stop);
        });
    });
}

/**
 * 生成前后的自查流程（create_document 用）
 * @returns {Promise<{ content: string, issues: object[], problems: string[], changed: number, checked: boolean }>}
 */
export async function selfCheck({ format, content, requirements = '', llm = null, signal, onProgress, quick = false, kind = '' }) {
  const issues = [...lint(format, content, { kind }), ...coverageIssues(format, requirements, content)];
  const hard = issues.some((x) => x.level === 'error');
  // quick：短文件、或同一个文件已经自查过一遍——规则检查没查出硬伤就不再请模型（省十几秒）
  const needModel = llm && DOC_FORMATS.concat('pptx').includes(format) && (hard || (requirements && !quick));
  if (!needModel) return { content, issues, problems: [], changed: 0, checked: false };
  onProgress?.('对照要求自查…');
  try {
    const r = await reviewWithModel({ format, content, requirements, issues, llm: capped(llm, signal), signal });
    const after = r.changed ? [...lint(format, r.content, { kind }), ...coverageIssues(format, requirements, r.content)] : issues;
    return { content: r.content, issues: after, problems: r.problems, changed: r.changed, checked: true };
  } catch (e) {
    throwControl(e, signal);
    if (e?.code === 'REVIEW_TIMEOUT') onProgress?.('自查等待太久，先跳过，直接生成…');
    return { content, issues, problems: [], changed: 0, checked: false };
  }
}

/**
 * 生成之后才查得出的问题（Excel 公式、PPT 排出来放不下 / 重叠）：请模型按问题改原文，改了就重新生成一次。只改一轮。
 * @param {{ format: string, content: string, issues: object[], layout?: string, requirements?: string, llm: Function|null, signal?: AbortSignal,
 *           rebuild: (content: string) => Promise<{ issues: object[] }>, onProgress?: (t: string) => void, label?: string }} o
 * @returns {Promise<{ content: string, fixed: number, left: object[], result: object|null, problems: string[] }>}
 */
export async function fixAfterBuild({ format, content, issues, layout = '', requirements = '', llm, signal, rebuild, onProgress, label = '检查生成结果…' }) {
  const hard = issues.filter((x) => x.level === 'error');
  if (!llm || !hard.length) return { content, fixed: 0, left: issues, result: null, problems: [] };
  onProgress?.(label);
  try {
    const r = await reviewWithModel({ format, content, requirements, issues: hard, llm: capped(llm, signal), signal, layout });
    if (!r.changed) return { content, fixed: 0, left: issues, result: null, problems: r.problems };
    const result = await rebuild(r.content);
    const before = hard.length;
    const after = result.issues.filter((x) => x.level === 'error').length;
    // 改完反而更糟：用原来的
    if (after > before) return { content, fixed: 0, left: issues, result: null, problems: r.problems };
    return { content: r.content, fixed: before - after, left: result.issues, result, problems: r.problems };
  } catch (e) {
    throwControl(e, signal);
    return { content, fixed: 0, left: issues, result: null, problems: [] };
  }
}

/**
 * 看图检查 PPT：把每页画出来的样子交给能看图的模型，找“看得见”的问题（字溢出、压住、太挤、太空、对不齐、配色看不清），
 * 给出按原文片段替换的修改。只改一轮。
 * @param {{ images: Array<{ mime: string, data: string }>, pages: number[], content: string, requirements?: string, llm: Function, signal?: AbortSignal }} o
 * @returns {Promise<{ problems: string[], content: string, changed: number }>}
 */
export async function reviewSlidesByImage({ images, pages, content, requirements = '', llm: rawLlm, signal }) {
  const llm = capped(rawLlm, signal);
  const j = parseJson(await llm({
    signal,
    images,
    system: '你是严格的演示文稿审校。看每页幻灯片排出来的样子，只找看得见的真问题，并给出能直接执行的修改。只输出 JSON。',
    prompt: `下面的图片是刚生成的 PPT（每张图拼了几页，左上角标着第几页），共看 ${pages.length} 页：第 ${pages.join('、')} 页。
${requirements ? `用户的原始要求：\n${String(requirements).slice(0, 1500)}\n` : ''}
每页对应的原文（Markdown，“## 标题”开始一页，第 1 页是封面）：
${String(content).slice(0, 16000)}

逐页看：文字有没有溢出框、超出页面、压在别的字或图上；有没有一页字太多太挤（应删减或拆成两页）、或者大片空白只有一两行字；标题是不是太长折成两行；表格、图表是否看得清。
排版是程序按原文自动做的，你只能改原文：删减啰嗦的字、把一条长要点拆成两条、一页太多就在中间插入新的“## 标题（续）”拆页。
输出 JSON：{"problems":["第 N 页：问题，没有就空数组"],"edits":[{"find":"原文里一字不差的片段（10-80 字）","replace":"改成"}]}
没有明显问题就都给空数组；不要为了改而改，不要改数字和事实。`
  }));
  const r = applyEdits(content, j);
  return { problems: (Array.isArray(j?.problems) ? j.problems : []).map(String).filter(Boolean), content: r.content, changed: r.changed };
}

