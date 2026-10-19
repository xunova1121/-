/**
 * 深度调研：像研究员一样多轮“规划 → 搜索 → 阅读 → 找缺口 → 补查”，最后写出带引用的报告。
 * 思路参考 GPT Researcher / open_deep_research / node-DeepResearch：
 *
 *   1. 规划：把问题拆成几个子问题，各配一个搜索词
 *   2. 搜索：每个搜索词取前几条，去重，同一网站最多取 2 篇（来源多样）
 *   3. 阅读：逐篇读全文，只摘与问题有关的要点（每条要点带来源编号）
 *   4. 反思：看要点覆盖了没有，缺什么就生成新的搜索词再来一轮
 *   5. 写作：按大纲写报告，正文用 [1] [2] 标注出处，文末列参考来源
 *
 * 没有接入大模型（内置演示）时，退化为“抽取式”：按关键词挑出各来源里最相关的句子，照样带引用。
 */

export const DEPTHS = {
  quick: { name: '快速', rounds: 1, queries: 3, pages: 4 },
  standard: { name: '标准', rounds: 2, queries: 4, pages: 8 },
  deep: { name: '深入', rounds: 3, queries: 5, pages: 14 }
};

const PAGE_CHARS = 9000;
const PER_SITE = 2;

/** 从模型回复里取出 JSON（容忍 ```json 包裹和前后废话） */
export function parseJson(text) {
  const s = String(text || '');
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, s.slice(s.search(/[[{]/))];
  try { return JSON.parse(m[1]); } catch { /* 再试：截到最后一个括号 */ }
  const body = m[1] || '';
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  try { return JSON.parse(body.slice(0, end + 1)); } catch { return null; }
}

const terms = (q) => {
  const t = String(q).toLowerCase();
  const words = t.match(/[a-z0-9][a-z0-9.+#-]*/g) ?? [];
  const han = (t.match(/[一-鿿]+/g) ?? []).flatMap((s) => (s.length < 2 ? [s] : [...s].slice(0, -1).map((_, i) => s.slice(i, i + 2))));
  const stop = new Set(['什么', '怎么', '如何', '哪些', '一下', '的是', '是否', '可以', '我们', '你们', '目前', '现在', 'the', 'and', 'for', 'what', 'how']);
  return [...new Set([...words, ...han])].filter((w) => !stop.has(w));
};

/** 抽取式要点：挑出和问题最相关的几句（去重，最相关的在前） */
export function extractive(question, text, n = 4) {
  const ts = terms(question);
  const sents = [...new Set(String(text).replace(/\s+/g, ' ').split(/(?<=[。！？!?；;]|\.\s)/).map((s) => s.trim()).filter((s) => s.length >= 12 && s.length <= 300))];
  return sents
    .map((s, i) => ({ s, i, score: ts.reduce((a, w) => a + (s.toLowerCase().includes(w) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, n)
    .map((x) => x.s);
}

const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const today = () => new Date().toISOString().slice(0, 10);

/**
 * @param {object} o
 * @param {string} o.question
 * @param {'quick'|'standard'|'deep'} [o.depth]
 * @param {((p: { system: string, prompt: string }) => Promise<string>) | null} o.llm  没有时用抽取式
 * @param {(query: string, n: number) => Promise<Array<{title,url,snippet}>>} o.search
 * @param {(url: string) => Promise<string>} o.read  读网页正文（失败时抛错，会退回用搜索摘要）
 * @param {(p: { stage: string, text: string }) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{ title: string, markdown: string, sources: Array<{n,title,url}>, queries: string[], rounds: number }>}
 */
export async function deepResearch({ question, depth = 'standard', llm = null, search, read, onProgress, signal }) {
  const cfg = DEPTHS[depth] ?? DEPTHS.standard;
  const say = (stage, text) => onProgress?.({ stage, text });
  const check = () => { if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' }); };
  const ask = async (system, prompt) => { check(); return llm({ system, prompt, signal }); };

  // ---------- 1. 规划
  say('plan', '拆解问题');
  let title = question.slice(0, 40);
  let outline = [];
  let queries = [question];
  if (llm) {
    const plan = parseJson(await ask(
      '你是严谨的研究员，负责为调研制定检索计划。只输出 JSON。',
      `今天是 ${today()}。调研问题：${question}\n\n输出 JSON：{"title":"报告标题（不超过 20 字）","outline":["报告的 3-6 个小节标题"],"queries":["${cfg.queries} 个搜索词，覆盖不同角度；时效性问题加上年份；需要时可用英文搜索词"]}`
    ));
    if (plan?.queries?.length) queries = plan.queries.map(String).filter(Boolean).slice(0, cfg.queries);
    if (plan?.title) title = String(plan.title).slice(0, 40);
    if (Array.isArray(plan?.outline)) outline = plan.outline.map(String).slice(0, 8);
  } else {
    queries = [question, `${question} ${new Date().getFullYear()}`, `${question} 分析`].slice(0, cfg.queries);
  }

  const sources = []; // { n, title, url, snippet, points: string[] }
  const seen = new Set();
  const allQueries = [];
  let round = 0;

  for (; round < cfg.rounds; round++) {
    check();
    // ---------- 2. 搜索
    const fresh = queries.filter((q) => !allQueries.includes(q));
    allQueries.push(...fresh);
    const found = [];
    for (const q of fresh) {
      say('search', `搜索：${q}`);
      try { found.push(...(await search(q, 6)).map((r, rank) => ({ ...r, rank, q }))); } catch (e) { say('search', `搜索失败：${e.message}`); }
      check();
    }
    // 按名次轮流取（每个搜索词的第 1 名、再第 2 名…），同一网站最多 PER_SITE 篇
    const perSite = new Map(sources.map((s) => [host(s.url), 0]));
    for (const s of sources) perSite.set(host(s.url), (perSite.get(host(s.url)) ?? 0) + 1);
    const budget = Math.ceil(cfg.pages / cfg.rounds) + (round === 0 ? cfg.pages % cfg.rounds : 0);
    const pick = [];
    for (const r of found.sort((a, b) => a.rank - b.rank)) {
      if (pick.length >= budget) break;
      const key = r.url.replace(/#.*$/, '').replace(/\/$/, '');
      const h = host(r.url);
      if (seen.has(key) || (perSite.get(h) ?? 0) >= PER_SITE) continue;
      seen.add(key);
      perSite.set(h, (perSite.get(h) ?? 0) + 1);
      pick.push(r);
    }
    if (!pick.length && round > 0) break;

    // ---------- 3. 阅读（3 篇并行）
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(3, pick.length) }, async () => {
      while (i < pick.length) {
        const r = pick[i++];
        check();
        say('read', `阅读：${r.title || host(r.url)}`);
        let text = '';
        try { text = String(await read(r.url)).slice(0, PAGE_CHARS); } catch { /* 读不了：只用搜索摘要 */ }
        const body = text.trim().length > 80 ? text : `${r.title}\n${r.snippet}`;
        let points = [];
        if (llm) {
          try {
            const j = parseJson(await ask(
              '你从网页中摘录与调研问题相关的事实。只输出 JSON。不要编造网页里没有的内容。',
              `调研问题：${question}\n网页标题：${r.title}\n网址：${r.url}\n\n网页内容：\n${body}\n\n输出 JSON：{"relevant":true/false,"date":"网页上能看出的发布日期，没有则空","points":["3-8 条要点：具体的数据、结论、观点、时间，每条一句话"]}`
            ));
            if (j?.relevant !== false) points = (j?.points ?? []).map(String).filter(Boolean).slice(0, 8);
            if (j?.date && points.length) points[0] = `（${j.date}）${points[0]}`;
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            points = extractive(question, body);
          }
        } else {
          points = extractive(question, body);
          if (!points.length && r.snippet) points = [r.snippet];
        }
        if (points.length) sources.push({ n: 0, title: r.title || host(r.url), url: r.url, snippet: r.snippet, points });
      }
    }));
    sources.forEach((s, k) => { s.n = k + 1; });

    // ---------- 4. 反思：还缺什么
    if (!llm || round + 1 >= cfg.rounds) continue;
    say('reflect', `已读 ${sources.length} 个来源，检查还缺什么`);
    const gap = parseJson(await ask(
      '你是严谨的研究员，判断现有资料是否足以回答问题。只输出 JSON。',
      `调研问题：${question}\n报告大纲：${outline.join(' / ') || '（无）'}\n已用过的搜索词：${allQueries.join('；')}\n\n已收集的要点：\n${notes(sources, 60)}\n\n输出 JSON：{"enough":true/false,"missing":"还缺哪些方面","queries":["最多 ${cfg.queries} 个新的搜索词，针对缺失的部分"]}`
    ));
    if (!gap || gap.enough || !gap.queries?.length) { round++; break; }
    queries = gap.queries.map(String).filter(Boolean).slice(0, cfg.queries);
  }
  if (round >= cfg.rounds) round = cfg.rounds;

  // ---------- 5. 写报告
  check();
  if (!sources.length) throw new Error('没有找到可用的资料（搜索没有结果或网页都读不了）。可以换个问法，或在“模型”面板填 Tavily Key');
  say('write', `撰写报告（${sources.length} 个来源）`);
  let body;
  if (llm) {
    body = await ask(
      '你是资深研究员，用中文撰写结构清晰、信息密集的调研报告。只依据给出的资料，每个事实后用 [编号] 标注出处，可以多个如 [1][3]。资料之间有矛盾时指出来。不要编造资料里没有的数据。',
      `今天是 ${today()}。调研问题：${question}\n建议大纲：${outline.join(' / ') || '自行组织'}\n\n资料（编号即引用号）：\n${notes(sources)}\n\n请输出 Markdown 正文（不要写标题和参考来源列表，会自动添加）：先写“## 结论摘要”（3-5 条要点），再按大纲分节，最后写“## 不确定与待核实”。`
    );
    body = String(body || '').replace(/^#\s+.*\n/, '').replace(/\n#{1,3}\s*(参考来源|参考资料|References)[\s\S]*$/i, '').trim();
    // 去掉不存在的引用号
    body = body.replace(/\[(\d+)\]/g, (m, n) => (Number(n) >= 1 && Number(n) <= sources.length ? m : ''));
  } else {
    body = [
      '## 结论摘要',
      ...summaryPoints(sources),
      '',
      '## 各来源要点',
      ...sources.flatMap((s) => [`### ${s.title} [${s.n}]`, ...s.points.map((p) => `- ${p}`), '']),
      '> 当前是内置演示模式：以上为从网页中自动摘出的原句，未经大模型归纳。接入大模型后会生成完整的分析报告。'
    ].join('\n');
  }
  const markdown = [
    `# ${title}`,
    '',
    `> 调研问题：${question}  `,
    `> 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })} · 深度：${cfg.name} · 检索 ${allQueries.length} 次 · 阅读 ${sources.length} 个来源`,
    '',
    body,
    '',
    '## 参考来源',
    ...sources.map((s) => `${s.n}. [${s.title.replace(/[[\]]/g, '')}](${s.url})`)
  ].join('\n');
  say('done', '完成');
  return { title, markdown, sources: sources.map(({ n, title: t, url }) => ({ n, title: t, url })), queries: allQueries, rounds: Math.max(1, round) };
}

/** 抽取式摘要：每个来源取一条，跳过和已选内容重复的（转载、同一句话） */
function summaryPoints(sources, max = 5) {
  const used = [];
  const out = [];
  for (const s of sources) {
    const p = s.points.find((x) => !used.some((u) => u.includes(x.slice(0, 20)) || x.includes(u.slice(0, 20))));
    if (!p) continue;
    used.push(p);
    out.push(`- ${p} [${s.n}]`);
    if (out.length >= max) break;
  }
  return out;
}

function notes(sources, maxPoints = 200) {
  let left = maxPoints;
  return sources.map((s) => {
    const pts = s.points.slice(0, Math.max(0, Math.min(s.points.length, left)));
    left -= pts.length;
    return `[${s.n}] ${s.title}（${host(s.url)}）\n${pts.map((p) => `  - ${p}`).join('\n')}`;
  }).join('\n');
}
