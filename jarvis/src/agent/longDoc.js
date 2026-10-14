/**
 * 长文档写作流程（报告、方案、总结、标书……）：一次写完的长文常常前后脱节、后半截草草收尾，所以分步写。
 *
 *   1. 大纲    模型按要求和材料列出各节标题、要点和字数；用户说“先看大纲”时到这里就停，把大纲给用户确认
 *   2. 逐节写  每节都带上完整大纲和前面各节的摘要，只写这一节；写完附一句摘要给后面的节用
 *   3. 统一润色 通读全文，只给出具体的替换（术语统一、重复删减、衔接补充），程序按原文片段替换，不整篇重写
 *   4. 读者测试 另一个不带对话上下文的模型只拿到成品，以目标读者身份通读，找出看不懂、缺依据、前后矛盾的地方
 *   5. 返工一轮 有问题的节带着读者意见重写，只改一轮
 *
 * 写作“先结构后分节、写完找读者试读”是通用的写作方法，这里按贾维斯的工具自己实现。
 */
import { parseJson } from './research.js';

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const SUMMARY_MARK = '<<<本节摘要>>>';
const MAX_SECTIONS = 12;

/**
 * @param {object} o
 * @param {string} o.task  写什么：用途、读者、要求（越具体越好）
 * @param {string} [o.title]
 * @param {string} [o.material]  用户给的材料、数据、要点
 * @param {number} [o.words]  目标字数
 * @param {Array<{ heading: string, points?: string[], words?: number }>} [o.outline]  已确认的大纲（跳过第 1 步）
 * @param {boolean} [o.outlineOnly]  只出大纲
 * @param {boolean} [o.review]  做读者测试（默认做）
 * @param {(p: { system: string, prompt: string, signal?: AbortSignal }) => Promise<string>} o.llm
 * @param {(p: { system: string, prompt: string, signal?: AbortSignal }) => Promise<string>} [o.readerLlm]  读者用的模型（默认同 llm）
 * @param {(text: string) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{ title: string, outline: object[], markdown?: string, edits?: number, review?: { issues: object[], revised: string[] } }>}
 */
export async function writeLongDocument({ task, title = '', material = '', words = 0, outline = null, outlineOnly = false, review = true, llm, readerLlm = null, onProgress, signal }) {
  if (!llm) throw new Error('长文档分节写作需要配置大模型（内置演示不支持）。可以直接用 create_document 一次写完');
  const say = (t) => onProgress?.(t);
  const mat = material ? `\n\n用户提供的材料（必须用上，不要编造材料以外的数据）：\n${clip(material, 12000)}` : '';

  // ---------- 1. 大纲
  let plan = outline?.length ? { title, sections: outline } : null;
  if (!plan) {
    say('列大纲…');
    const j = parseJson(await llm({
      signal,
      system: '你是资深的中文文字工作者，擅长写结构清楚、内容具体的报告和方案。只输出 JSON。',
      prompt: `写作任务：${task}${title ? `\n标题：${title}` : ''}${words ? `\n目标字数：约 ${words} 字` : ''}${mat}

列出文档大纲。输出 JSON：{"title":"文档标题","sections":[{"heading":"一级标题（带序号，如“一、背景与目标”）","points":["这一节要写的 2-5 个要点，写具体"],"words":这一节的字数}]}
要求：3-${MAX_SECTIONS} 节；按这类文档的惯常结构（如总结：基本情况、成绩、问题、计划；方案：背景目标、现状、方案、实施计划、预算、风险）；各节字数加起来接近目标字数。`
    }));
    const sections = Array.isArray(j?.sections) ? j.sections.filter((s) => s?.heading).slice(0, MAX_SECTIONS) : [];
    if (!sections.length) throw new Error('没能生成大纲，请把要求写得更具体一些再试');
    plan = { title: String(j.title || title || '未命名文档'), sections };
  }
  plan.sections = plan.sections.map((s) => ({ heading: String(s.heading).replace(/^#+\s*/, '').trim(), points: (s.points ?? []).map(String), words: Number(s.words) || 0 }));
  if (outlineOnly) return { title: plan.title, outline: plan.sections };

  const outlineText = plan.sections.map((s, i) => `${i + 1}. ${s.heading}${s.points.length ? `：${s.points.join('；')}` : ''}${s.words ? `（约 ${s.words} 字）` : ''}`).join('\n');

  // ---------- 2. 逐节写
  const parts = [];
  const summaries = [];
  for (const [i, s] of plan.sections.entries()) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    say(`写第 ${i + 1}/${plan.sections.length} 节：${s.heading}`);
    parts.push(await writeSection({ i, s, plan, outlineText, summaries, task, mat, llm, signal }));
    summaries.push(parts[i].summary);
  }
  let body = parts.map((p) => p.text).join('\n\n');

  // ---------- 3. 统一润色（只做具体替换）
  say('通读全文，统一术语和衔接…');
  let edits = 0;
  try {
    const j = parseJson(await llm({
      signal,
      system: '你是严谨的编辑。只输出 JSON。',
      prompt: `下面是一篇分节写成的文档《${plan.title}》。请通读，找出需要统一修改的地方：同一事物前后叫法不一致、数字前后矛盾、相邻两节内容重复、节与节之间缺少衔接。
只给出具体的替换，每条的 find 必须是原文里一字不差的片段（10-80 字），replace 是改后的文字。没有要改的就返回空数组。最多 12 条。
输出 JSON：{"edits":[{"find":"原文片段","replace":"改成","why":"原因"}]}

${clip(body, 30000)}`
    }));
    for (const e of Array.isArray(j?.edits) ? j.edits.slice(0, 12) : []) {
      const find = String(e?.find ?? '');
      if (find.length >= 4 && body.includes(find) && typeof e.replace === 'string') { body = body.replace(find, e.replace); edits++; }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
  }

  // ---------- 4. 读者测试 + 5. 返工一轮
  let rev = null;
  if (review) {
    say('请一位“读者”通读挑问题…');
    rev = await readerTest({ title: plan.title, body, task, llm: readerLlm ?? llm, signal });
    if (rev.issues.length) {
      const bySection = splitSections(body);
      const touched = new Set();
      for (const issue of rev.issues) {
        const idx = bySection.findIndex((sec) => issue.quote && sec.text.includes(issue.quote)) ;
        const k = idx >= 0 ? idx : bySection.findIndex((sec) => issue.section && sec.heading.includes(issue.section));
        if (k >= 0) (bySection[k].issues ??= []).push(issue);
      }
      for (const [k, sec] of bySection.entries()) {
        if (!sec.issues?.length || touched.size >= 4) continue;
        say(`按读者意见修改：${sec.heading}`);
        const fixed = await reviseSection({ sec, plan, outlineText, task, mat, llm, signal });
        if (fixed) { bySection[k].text = fixed; touched.add(sec.heading); }
      }
      body = bySection.map((x) => x.text).join('\n\n');
      rev.revised = [...touched];
    }
  }
  return { title: plan.title, outline: plan.sections, markdown: `# ${plan.title}\n\n${body}\n`, edits, review: rev };
}

async function writeSection({ i, s, plan, outlineText, summaries, task, mat, llm, signal }) {
  const prev = summaries.length ? summaries.map((x, k) => `${k + 1}. ${plan.sections[k].heading}：${x}`).join('\n') : '（这是第一节）';
  const raw = String(await llm({
    signal,
    system: '你是资深的中文文字工作者。直接输出这一节的 Markdown 正文，不要寒暄、不要解释。',
    prompt: `写作任务：${task}
文档标题：${plan.title}
完整大纲：
${outlineText}

前面各节已经写了（摘要）：
${prev}
${mat}

现在只写第 ${i + 1} 节「${s.heading}」${s.words ? `，约 ${s.words} 字` : ''}。要点：${s.points.join('；') || '按大纲'}。
格式：第一行是“## ${s.heading}”；节内小标题用 ###、####；数据对比和计划安排用 Markdown 表格；并列要点用列表。
要求：内容具体（数字、时间、责任人、依据），不重复前面各节已经写过的内容，不写本节以外的内容，不写空话套话；材料里没有的数据写“待确认”，不要编造。
写完后另起一行写 ${SUMMARY_MARK}，后面用一两句话概括这一节写了什么（给后面的节参考，不会出现在文档里）。`
  }));
  const [text, summary = ''] = raw.split(SUMMARY_MARK);
  let t = text.trim().replace(/^```(?:markdown)?\s*|\s*```$/g, '');
  if (!/^##\s/.test(t)) t = `## ${s.heading}\n\n${t.replace(/^#\s+.*\n/, '')}`;
  return { text: t, summary: clip(summary.trim() || t.replace(/[#|*\-\n]+/g, ' '), 200) };
}

/** 读者测试：只给成品，不给对话和写作过程 */
export async function readerTest({ title, body, task, llm, signal }) {
  try {
    const j = parseJson(await llm({
      signal,
      system: '你是这份文档的目标读者，第一次看到它，不了解写作背景。认真通读，找出真正影响理解和决策的问题。只输出 JSON。',
      prompt: `文档的用途：${clip(task, 300)}

《${title}》全文：
${clip(body, 30000)}

找出这几类问题（没有就不要硬凑，最多 8 条）：
- 看不懂：术语没解释、指代不明、逻辑跳跃
- 缺依据：结论、数字没有来源或推导
- 前后矛盾：数字、说法、时间前后不一致
- 缺内容：读者最关心的问题没回答（比如方案没写预算、计划没写负责人）
输出 JSON：{"issues":[{"type":"看不懂|缺依据|前后矛盾|缺内容","section":"所在的一级标题","quote":"原文里一字不差的片段（10-60 字，没有就留空）","problem":"问题是什么","suggestion":"怎么改"}]}`
    }));
    const issues = (Array.isArray(j?.issues) ? j.issues : []).slice(0, 8).map((x) => ({
      type: String(x?.type ?? ''), section: String(x?.section ?? ''), quote: String(x?.quote ?? ''), problem: String(x?.problem ?? ''), suggestion: String(x?.suggestion ?? '')
    })).filter((x) => x.problem);
    return { issues, revised: [] };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return { issues: [], revised: [], failed: true };
  }
}

async function reviseSection({ sec, plan, outlineText, task, mat, llm, signal }) {
  try {
    const raw = String(await llm({
      signal,
      system: '你是资深的中文文字工作者。直接输出修改后的这一节 Markdown，不要解释。',
      prompt: `写作任务：${task}
文档：《${plan.title}》，大纲：
${outlineText}
${mat}

读者试读后对「${sec.heading}」这一节提了意见：
${sec.issues.map((x, i) => `${i + 1}. 【${x.type}】${x.problem}${x.quote ? `（原文：“${x.quote}”）` : ''}${x.suggestion ? ` 建议：${x.suggestion}` : ''}`).join('\n')}

原文：
${sec.text}

按意见修改这一节，其余内容保持不变；需要的数据材料里没有的，写“待确认”，不要编造。第一行保持“## ${sec.heading}”。`
    })).trim().replace(/^```(?:markdown)?\s*|\s*```$/g, '');
    return /^##\s/.test(raw) && raw.length > sec.text.length * 0.5 ? raw : null; // 改坏了（太短、丢了标题）就保留原文
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return null;
  }
}

/** 按“## ”切成节 */
export function splitSections(body) {
  const out = [];
  for (const chunk of String(body).split(/\n(?=##\s)/)) {
    const heading = chunk.match(/^##\s+(.+)$/m)?.[1]?.trim() ?? '';
    out.push({ heading, text: chunk.trim() });
  }
  return out.filter((x) => x.text);
}

/** 大纲 → 给用户看的文字 */
export const outlineMarkdown = (title, sections) => `# ${title}\n\n${sections.map((s) => `## ${s.heading}${s.words ? `（约 ${s.words} 字）` : ''}\n${s.points.map((p) => `- ${p}`).join('\n')}`).join('\n\n')}`;
