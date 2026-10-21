/**
 * 长文档写作流程（报告、方案、总结、标书……）：一次写完的长文常常前后脱节、后半截草草收尾，所以分步写。
 *
 *   1. 大纲    模型按要求和材料列出各节标题、要点和字数；用户说“先看大纲”时到这里就停，把大纲给用户确认
 *   2. 分节写  第一节先写，其余 3 节一起写；每节带完整大纲和已写完各节的摘要，只写这一节
 *   （返工也是几节一起改：一节一节排队，十几节的文档要半小时以上）
 *   3. 合并通读 不带写作过程，以目标读者/编辑身份一次找出术语替换与内容问题
 *   4. 定点修正 只替换能匹配的原文，保留未修改部分
 *   5. 返工一轮 有问题的节带着读者意见重写，只改一轮（几节同时改）
 *
 * 写作“先结构后分节、写完找读者试读”是通用的写作方法，这里按未央的工具自己实现。
 */
import { parseJson } from './research.js';
import { throwControl } from '../core/networkRequest.js';

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const SUMMARY_MARK = '<<<本节摘要>>>';
import { METHOD, CHECKLIST, detectGenre, genreHint } from './writingGuide.js';

const MAX_SECTIONS = 12;
/** 同时写几节（太多容易被服务商限流） */
export const SECTION_CONCURRENCY = 3;

/** 按顺序取任务，最多 limit 个同时做；有一个出错就整体报错（已经发出的照常结束） */
export async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
const MAT_LIMIT = 24000; // 材料超过这么长时不整篇塞进提示

/** 材料里像标题的行（一、（一）、1. 、# 开头的短行），列大纲时让模型看到材料的完整结构 */
export function skeleton(text) {
  return String(text).split('\n').map((l) => l.trim()).filter((l) => l.length <= 40 && /^(#{1,4}\s|[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）|\d+(\.\d+)*[.、]\s?\S)/.test(l)).join('\n');
}

/** 长材料里和这一节最相关的段落（按原文顺序），短材料原样返回 */
export function relevantMaterial(text, query, limit = MAT_LIMIT) {
  const t = String(text);
  if (t.length <= limit) return t;
  const paras = t.split(/\n{2,}|\n(?=[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）|#)/).filter((p) => p.trim());
  const grams = (s) => { const g = new Set(); const x = s.replace(/\s/g, ''); for (let i = 0; i < x.length - 1; i++) g.add(x.slice(i, i + 2)); return g; };
  const q = grams(query);
  const scored = paras.map((p, i) => { let hit = 0; for (const g of grams(p)) if (q.has(g)) hit++; return { i, p, s: hit / Math.sqrt(p.length + 20) }; });
  const keep = new Set();
  let used = 0;
  for (const x of [...scored].sort((a, b) => b.s - a.s)) {
    if (used + x.p.length > limit) continue;
    keep.add(x.i); used += x.p.length;
  }
  return scored.filter((x) => keep.has(x.i)).map((x) => x.p).join('\n\n');
}

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
  // 材料长时：列大纲给开头一段加材料里的标题结构；逐节写时给和这一节最相关的段落（见 relevantMaterial）
  const mat = material ? `\n\n用户提供的材料（必须用上，不要编造材料以外的数据）：\n${material.length > MAT_LIMIT ? `${clip(material, MAT_LIMIT - 3000)}\n\n【材料里的标题结构】\n${clip(skeleton(material), 3000)}` : material}` : '';
  // 给了长材料又没说字数：按材料篇幅定，不要比材料还短
  if (!words && material.length > 6000) words = Math.min(40000, Math.round(material.replace(/\s/g, '').length * 1.1));

  const genre = detectGenre(task, title);

  // ---------- 1. 大纲
  let plan = outline?.length ? { title, sections: outline } : null;
  if (!plan) {
    say('列大纲…');
    const j = parseJson(await llm({
      signal,
      system: '你是资深的中文文字工作者，擅长写结构清楚、内容具体的报告和方案。只输出 JSON。',
      prompt: `写作任务：${task}${title ? `\n标题：${title}` : ''}${words ? `\n目标字数：约 ${words} 字` : ''}${mat}

列出文档大纲。输出 JSON：{"title":"文档标题","sections":[{"heading":"一级标题（带序号，如“一、背景与目标”）","points":["这一节要写的 2-5 个要点，写具体"],"words":这一节的字数}]}
要求：3-${MAX_SECTIONS} 节；按这类文档的惯常结构（如总结：基本情况、成绩、问题、计划；方案：背景目标、现状、方案、实施计划、预算、风险）；各节字数加起来接近目标字数；论证性的章节（背景、必要性、需求、方案、效益）字数给足，不要平均分配。用户提供的材料里有的章节，大纲里都要有。${genreHint(genre)}`
    }));
    const sections = Array.isArray(j?.sections) ? j.sections.filter((s) => s?.heading).slice(0, MAX_SECTIONS) : [];
    if (!sections.length) throw new Error('没能生成大纲，请把要求写得更具体一些再试');
    plan = { title: String(j.title || title || '未命名文档'), sections };
  }
  plan.sections = plan.sections.map((s) => ({ heading: String(s.heading).replace(/^#+\s*/, '').trim(), points: (s.points ?? []).map(String), words: Number(s.words) || 0 }));
  if (outlineOnly) return { title: plan.title, outline: plan.sections };

  const outlineText = plan.sections.map((s, i) => `${i + 1}. ${s.heading}${s.points.length ? `：${s.points.join('；')}` : ''}${s.words ? `（约 ${s.words} 字）` : ''}`).join('\n');

  // ---------- 2. 分节写：第一节先写（定下术语和口径），其余各节 3 节一起写——一节一节排队写，十几节要半小时以上。
  // 每节都带完整大纲，以及开写时已经写完的各节摘要
  const parts = new Array(plan.sections.length);
  const summaries = [];
  const writeOne = async (i) => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const s = plan.sections[i];
    say(`写第 ${i + 1}/${plan.sections.length} 节：${s.heading}`);
    const secMat = material ? `\n\n用户提供的材料（和这一节相关的部分，必须用上，不要编造材料以外的数据）：\n${relevantMaterial(material, `${s.heading} ${s.points.join(' ')}`)}` : '';
    const done = summaries.map((x, k) => (x ? { k, x } : null)).filter(Boolean);
    parts[i] = await writeSection({ i, s, plan, outlineText, done, task, mat: secMat, llm, signal });
    summaries[i] = parts[i].summary;
  };
  await writeOne(0);
  await mapLimit(plan.sections.slice(1).map((_, k) => k + 1), SECTION_CONCURRENCY, writeOne);
  let body = parts.map((p) => p.text).join('\n\n');

  // ---------- 3. 一次通读同时完成编辑与读者审查；关闭读者测试时只做编辑。
  let edits = 0;
  let rev = null;
  if (review) {
    say('请一位“读者”通读挑问题…');
    rev = await readerTest({ title: plan.title, body, task, llm: readerLlm ?? llm, signal });
  } else {
    say('通读全文，统一术语和衔接…');
  }
  let changes = rev?.edits || [];
  if (!review) {
    try {
      const result = parseJson(await llm({
        signal,
        system: '你是严谨的编辑。只输出 JSON。',
        prompt: `请通读《${plan.title}》，找出需要统一修改的地方：术语、数字矛盾、重复和衔接。只给出原文片段的替换，最多12条，不补造事实。输出JSON：{"edits":[{"find":"原文片段","replace":"改成","why":"原因"}]}\n${clip(body, 30000)}`
      }));
      changes = Array.isArray(result?.edits) ? result.edits.slice(0, 12) : [];
    } catch (error) {
      throwControl(error, signal);
    }
  }
  for (const change of changes) {
    const find = String(change?.find || '');
    if (find.length < 4 || !body.includes(find) || typeof change.replace !== 'string') continue;
    const fixed = body.replace(find, change.replace);
    if (fixed.length < body.length * 0.5) continue;
    body = fixed;
    edits++;
  }

  // ---------- 4. 按同一次通读的读者意见，最多返工一轮。
  if (review) {
    if (rev.issues.length) {
      const bySection = splitSections(body);
      const touched = new Set();
      for (const issue of rev.issues) {
        const idx = bySection.findIndex((sec) => issue.quote && sec.text.includes(issue.quote)) ;
        const k = idx >= 0 ? idx : bySection.findIndex((sec) => issue.section && sec.heading.includes(issue.section));
        if (k >= 0) (bySection[k].issues ??= []).push(issue);
      }
      // 最多改 6 节，各节互不相干，同时改
      const todo = bySection.map((sec, k) => ({ sec, k })).filter(({ sec }) => sec.issues?.length).slice(0, 6);
      await mapLimit(todo, SECTION_CONCURRENCY, async ({ sec, k }) => {
        say(`按读者意见修改：${sec.heading}`);
        const fixed = await reviseSection({ sec, plan, outlineText, task, mat, llm, signal });
        if (fixed) { bySection[k].text = fixed; touched.add(sec.heading); }
      });
      body = bySection.map((x) => x.text).join('\n\n');
      rev.revised = [...touched];
    }
  }
  return { title: plan.title, outline: plan.sections, markdown: `# ${plan.title}\n\n${body}\n`, edits, review: rev };
}

async function writeSection({ i, s, plan, outlineText, done, task, mat, llm, signal }) {
  const prev = done.length ? `${done.map(({ k, x }) => `${k + 1}. ${plan.sections[k].heading}：${x}`).join('\n')}\n（其余各节由同事按大纲同时在写）` : i === 0 ? '（这是第一节）' : '（其余各节由同事按大纲同时在写）';
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
${METHOD}

要求：
- 每个要点都要展开写，不要压成一句话：先写观点，再写依据（政策文件全称和文号、具体条款、数据、事实），再说明对本项目意味着什么；需要时用一个通俗的比方帮读者理解。
- 材料里有的细节（数字、文件名称和文号、系统和模块名称、流程步骤、表格）尽量完整保留并用上；材料里的表格照样做成表格。
- 字数宁多勿少，至少写到上面要求的字数。
- 不重复前面各节已经写过的内容，不写本节以外的内容，不写空话套话；材料没有的事实数字不得编造；可以提出标明假设的业务建议，未知事项集中说明影响，不得擅自降级明确要求。
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
- 太单薄：只有一句话的要点、只有观点没有依据和分析的段落
${CHECKLIST}
同时找出需要统一修改的地方：术语叫法、数字矛盾、重复和衔接，按原文片段给最多12条edits，find必须原样，replace不得编造事实。\n输出 JSON：{"edits":[{"find":"原文片段","replace":"改后文字","why":"原因"}],"issues":[{"type":"看不懂|缺依据|前后矛盾|缺内容|太单薄","section":"所在的一级标题","quote":"原文里一字不差的片段（10-60 字，没有就留空）","problem":"问题是什么","suggestion":"怎么改"}]}`
    }));
    const issues = (Array.isArray(j?.issues) ? j.issues : []).slice(0, 8).map((x) => ({
      type: String(x?.type ?? ''), section: String(x?.section ?? ''), quote: String(x?.quote ?? ''), problem: String(x?.problem ?? ''), suggestion: String(x?.suggestion ?? '')
    })).filter((x) => x.problem);
    if (!Array.isArray(j?.issues)) return { issues: [], edits: [], revised: [], failed: true };
    return { issues, edits: Array.isArray(j.edits) ? j.edits.slice(0, 12) : [], revised: [] };
  } catch (e) {
    throwControl(e, signal);
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

${METHOD}

读者试读后对「${sec.heading}」这一节提了意见：
${sec.issues.map((x, i) => `${i + 1}. 【${x.type}】${x.problem}${x.quote ? `（原文：“${x.quote}”）` : ''}${x.suggestion ? ` 建议：${x.suggestion}` : ''}`).join('\n')}

原文：
${sec.text}

按意见修改这一节，其余内容保持不变；缺少事实数字不得编造；建议标注假设，关键未知事项说明影响，不以待确认代替方案。第一行保持“## ${sec.heading}”。`
    })).trim().replace(/^```(?:markdown)?\s*|\s*```$/g, '');
    return /^##\s/.test(raw) && raw.length > sec.text.length * 0.5 ? raw : null; // 改坏了（太短、丢了标题）就保留原文
  } catch (e) {
    throwControl(e, signal);
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


