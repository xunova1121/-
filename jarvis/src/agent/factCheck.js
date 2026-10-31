import { throwControl } from '../core/networkRequest.js';
/**
 * 逐项查证（fact_check）：把“截图里的 7 场比赛查赛果”“这 10 只股票今天收盘价”这类任务交给程序按固定流程做，
 * 而不是全靠模型自己决定搜什么、信什么。每一项：
 *
 *   1. 定名：把译名 / 简称还原成原文名和别名（如“迪拜连接”→ Al Wasl），配上日期，生成多语言搜索词
 *   2. 搜索：几个搜索词一起搜，按“结果里出现了几个名字、日期对不对、是不是权威网站”排序
 *   3. 阅读：读排在前面的几篇原文（Tavily 直接给正文），只截取提到这些名字的段落
 *   4. 摘答案：模型从段落里找答案，并给出“原文引用”
 *   5. 核对引用：程序检查每条引用是不是真的出现在那篇原文里——编出来的引用直接作废
 *   6. 判定：两个不同网站的引用都支持，或官方原文引用支持 → 已核实；其他只有一个 → 单一来源；没有 → 未核实，换搜索词再查一轮
 *
 * 结果给主模型时明确标出每项的状态和出处；主模型只能用这里核实过的内容下结论。
 */
import { parseJson, extractive } from './research.js';
import { isOfficialSource } from './officialSources.js';
import { LINK_MARKER } from './pageLinks.js';

const PAGE_CHARS = 60000; // 一篇原文最多看这么长
const WINDOW = 450; // 名字前后各取多少字
const PER_PAGE = 2600; // 每篇给模型的段落总长
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** 比较用的规范化：全半角、大小写、去重音、去空白和常见标点差异 */
export function norm(s) {
  return String(s || '').normalize('NFKC').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[–—−‐-‒―]/g, '-').replace(/[“”„«»"「」『』]/g, '"').replace(/[‘’']/g, "'")
    .replace(/[\s 　]+/g, '');
}

/** 引用是否真的出现在原文里（允许用 … 省略中间部分，各段按顺序出现即可） */
export function quoteInText(quote, text) {
  const parts = String(quote || '').split(/…|\.\.\.|……/).map(norm).filter((p) => p.length >= 4);
  if (!parts.length) return false;
  const hay = norm(text);
  let from = 0;
  for (const p of parts) {
    const i = hay.indexOf(p, from);
    if (i < 0) return false;
    from = i + p.length;
  }
  return true;
}

/** 从原文里截出提到这些名字的段落（合并重叠部分） */
export function passages(text, names, max = PER_PAGE) {
  const src = String(text || '').slice(0, PAGE_CHARS);
  const hay = src.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const spans = [];
  for (const n of names) {
    const k = String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    if (k.length < 2) continue;
    for (let i = hay.indexOf(k); i >= 0 && spans.length < 40; i = hay.indexOf(k, i + k.length)) spans.push([Math.max(0, i - WINDOW), Math.min(src.length, i + k.length + WINDOW)]);
  }
  if (!spans.length) return src.slice(0, Math.min(max, 1200));
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) { const last = merged.at(-1); if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]); else merged.push([...s]); }
  // 名字出现得最集中的段落优先
  const scored = merged.map(([a, b]) => ({ a, b, n: names.filter((n) => n && hay.slice(a, b).includes(String(n).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase())).length }))
    .sort((x, y) => y.n - x.n || x.a - y.a);
  let out = '';
  for (const { a, b } of scored) {
    if (out.length >= max) break;
    out += `${out ? '\n…\n' : ''}${src.slice(a, b).replace(/\s+/g, ' ').trim()}`;
  }
  return out.slice(0, max);
}

/** 搜索结果排序：标题和摘要里出现的名字越多、带对日期、是优先网站的排前面 */
export function rankHits(hits, { names = [], dateHints = [], preferSites = [] }) {
  const ns = names.map(norm).filter((n) => n.length >= 2);
  const ds = dateHints.map(norm).filter(Boolean);
  const ps = preferSites.map((s) => String(s).replace(/^https?:\/\/|^www\.|\/.*$/g, '').toLowerCase()).filter(Boolean);
  return hits.map((h, i) => {
    const t = norm(`${h.title} ${h.snippet} ${h.url}`);
    const score = ns.filter((n) => t.includes(n)).length * 3 + (ds.some((d) => t.includes(d)) ? 2 : 0) + (ps.some((p) => host(h.url).endsWith(p)) ? 3 : 0) - i * 0.01;
    return { ...h, score };
  }).sort((a, b) => b.score - a.score);
}

const PLAN_SYS = `你是查证助手的“定名与搜索规划”步骤。只输出 JSON，不要解释。
给定一个要查证的对象，输出：
{"names": ["原文名或英文名", "常见别名或缩写", "中文名"], "dateHints": ["2026-10-12", "12 October 2026", "12 ottobre"], "queries": ["搜索词1", "搜索词2", "搜索词3", "搜索词4"], "preferSites": ["权威网站域名"]}
要求：
- names：把中文译名还原成原文（当地语言）名和英文名；体育队伍给出俱乐部全名和常用简称；不认识的译名按字面意思推断（如“迪拜连接”= Al Wasl，wasl 是阿拉伯语“连接”）。最多 6 个。
- queries：4 个左右，覆盖不同语言和说法：一个原文 / 当地语言、一个英文、一个中文；都带上日期或年份、赛事 / 场合；不要只用中文译名。
- 时差：给出的时间默认是北京时间（UTC+8）。先按事件发生地的时区换算成当地日期再写搜索词，例如北京时间 10-13 01:00 开赛的欧洲比赛，当地是 10-12 晚上；美洲的比赛还要再早一天。拿不准就两个日期都覆盖。中国体彩“周一001”里的“周一”是销售日（北京时间），不是比赛当地日期，比赛可能在第二天凌晨（北京时间）才开始。
- dateHints：结果里可能出现的日期写法（当地语言、英文、数字格式），当地日期和北京日期不同时两个都写。
- 用户是国内用户：queries 里至少一个中文搜索词（用常见中文译名 + 赛事 + 日期），中文专业来源也放进 preferSites（如体育赛果：sporttery.cn、500.com、zgzcw.com、okooo.com、titan007.com、dongqiudi.com、sports.sina.com.cn）。
- preferSites：这类信息的权威或专业来源（官方网站、专业数据站、主流媒体），没有就给空数组。`;

const EXTRACT_SYS = `你是查证助手的“摘答案”步骤。只输出 JSON，不要解释。
你会拿到：要查证的对象、要找的信息、若干编号的来源段落。只能根据这些段落回答，段落里没有的信息不要补，不要凭记忆。
输出：
{"answer": "一句话答案（找不到就写 null）", "fields": {"关键字段": "值"}, "evidence": [{"source": 编号, "quote": "从该来源段落里原样复制的一句话"}], "confidence": "high|medium|low", "conflict": "不同来源说法不一致时写明，否则 null", "missing": "还缺什么", "nextQueries": ["如果还没找到或只有一个来源，下一轮可以试的新搜索词（换语言、换说法）"]}
要求：
- quote 必须逐字复制段落里的原文（可以只取一句），程序会核对，不是原文的引用会被丢弃。
- 注意日期和时差：段落说的必须是同一场；当地日期可能比北京时间早一天，这不算对不上。往年的、赛前预告、比赛进行中的数据不能当最终结果。
- 尽量给出两个不同来源的 quote。`;

/**
 * @param {object} o
 * @param {string} o.question 每一项要查什么（如“这场比赛的全场比分和半场比分”）
 * @param {Array<{ label: string, details?: string }>} o.items
 * @param {string} [o.date] 事件日期或时间范围
 * @param {string} [o.context] 补充背景（如“竞彩足球 第 2610121 期”）
 * @param {((p: { system: string, prompt: string, signal?: AbortSignal }) => Promise<string>) | null} o.llm
 * @param {(q: string, n: number, opts?: object) => Promise<Array<{ title, url, snippet, raw? }>>} o.search
 * @param {(url: string) => Promise<string>} o.read
 */
export async function factCheck({ question, items, date = '', context = '', llm, search, read, onProgress, signal, rounds = 2, concurrency = 3, mode = 'thorough', consume = () => {}, evidence = [], onEvidence, today = new Date().toISOString().slice(0, 10) }) {
  const list = (items || []).filter((x) => x && String(x.label || '').trim()).slice(0, 20);
  if (!list.length) throw new Error('请把要查证的对象逐项列在 items 里');
  const quick = mode === 'quick';
  if (quick) rounds = 1;
  const guard = kind => { if(signal?.aborted) throw Object.assign(new Error('已停止核验'),{name:'AbortError'}); consume(kind); };
  const ask = async args => { guard('model'); return llm(args); };
  const pageCache = new Map();
  const getPage = async (hit) => {
    if (hit.raw) return hit.raw;
    if (!pageCache.has(hit.url)) pageCache.set(hit.url, (async()=>{guard('read');return read(hit.url);})().catch(e => {throwControl(e, signal);return '';}));
    return pageCache.get(hit.url);
  };
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < list.length; i = next++) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      results[i] = await checkOne(list[i], i).catch((e) => { throwControl(e, signal); return ({ label: list[i].label, status: 'error', answer: null, error: e.message, sources: [] }); });
      onProgress?.(`已查完 ${results.filter(Boolean).length}/${list.length}：${list[i].label}`);
    }
  };

  async function checkOne(item, idx) {
    const tag = `第 ${idx + 1} 项「${item.label}」`;
    // 1. 定名与搜索规划
    let plan = null;
    if (llm && !quick) {
      plan = parseJson(await ask({ system: PLAN_SYS, prompt: `今天：${today}\n背景：${context || '无'}\n事件日期：${date || '未说明'}\n要查的信息：${question}\n对象：${item.label}${item.details ? `\n对象详情：${item.details}` : ''}`, signal }).catch(e => {throwControl(e, signal);return '';}));
    }
    if (quick) plan = { queries:[`${item.label} ${date} ${question}`.trim(), `${item.label} ${date} 官方`.trim()] };
    const names = [...new Set([...(plan?.names || []), ...String(item.label).split(/\s+(?:vs\.?|VS|v)\s+|\s*(?:对阵|对|－|—)\s*/)].map((s) => String(s).trim()).filter((s) => s.length >= 2))].slice(0, 8);
    const dateHints = [...new Set([...(plan?.dateHints || []), date].filter(Boolean))];
    const preferSites = plan?.preferSites || [];
    let queries = [...new Set([...(plan?.queries || []), `${item.label} ${date}`.trim(), `${item.label} ${date} ${question}`.trim(), `${item.label} ${date} 原文`.trim()])].slice(0, quick ? 2 : 5);

    const seen = new Set();
    const key = JSON.stringify([question,item.label,item.details||'',date,context,today]);
    const cached = [...evidence].reverse().find(x=>x.key===key && Date.now()-x.savedAt>=0 && Date.now()-x.savedAt<10*60_000);
    const sources = (cached?.sources || []).slice(0,4).map((s,i)=>({...s,n:i+1,excerpt:passages(s.text,names)}));
    for(const s of sources) seen.add(s.url);
    const publish = async () => { if(signal?.aborted)return; await onEvidence?.({key,savedAt:cached?.savedAt||Date.now(),sources:sources.slice(-4).map(s=>({...s,text:passages(s.text,names,6000)}))}); };
    let best = null;
    for (let round = 1; round <= rounds; round++) {
      onProgress?.(`${tag}：第 ${round} 轮搜索（${queries.length} 个搜索词）`);
      // 2. 搜索
      const found = sources.length>=2 && round===1 ? [] : (await Promise.all(queries.slice(0,quick?2:5).map(async q => {
        guard('search');
        return search(q, quick?4:6, {deep:!quick}).catch(e=>{throwControl(e, signal);return [];});
      }))).flat();
      const fresh = rankHits(found.filter((h) => h?.url && !seen.has(h.url) && (seen.add(h.url), true)), { names, dateHints, preferSites });
      // 3. 优先读正文；读取失败仍保留摘要线索，但不能把摘要标成官方原文。
      // 同项最多两篇并行，先完成的证据先落检查点；所有请求共用预算和停止信号。
      const selected=fresh.slice(0,quick?2:4), pages=new Array(selected.length);
      let pageIndex=0;
      await Promise.all(Array.from({length:Math.min(2,selected.length)},async()=>{
        for(let i=pageIndex++;i<selected.length;i=pageIndex++){
          const h=selected[i], page=await getPage(h);
          if(signal?.aborted)throw Object.assign(new Error('已停止核验'),{name:'AbortError'});
          // 链接列表和搜索摘要不能冒充官方正文；只核对实际读到的文本。
          const body = String(page || '').split(LINK_MARKER)[0].trim();
          pages[i]={url:h.url,title:h.title,original:Boolean(body),text:body || `${h.title}\n${h.snippet||''}`};
          const ready=[...sources,...pages.filter(Boolean)].slice(-4);
          await onEvidence?.({key,sources:ready.map(s=>({...s,text:passages(s.text,names,6000)}))});
        }
      }));
      for(const page of pages.filter(Boolean))sources.push({...page,n:sources.length+1,excerpt:passages(page.text,names)});
      await publish();
      for (const h of fresh.slice(4, 8)) sources.push({ n: sources.length + 1, url: h.url, title: h.title, text: `${h.title}\n${h.snippet || ''}`, excerpt: `${h.title}\n${h.snippet || ''}`.slice(0, 500) });
      if (!sources.length) continue;

      // 4. 摘答案
      let out = null;
      if (llm) {
        const prompt = `今天：${today}\n背景：${context || '无'}\n事件日期：${date || '未说明'}\n要找的信息：${question}\n对象：${item.label}${item.details ? `（${item.details}）` : ''}\n可能的名字：${names.join(' / ')}\n\n${sources.map((s) => `[${s.n}] ${s.title}（${host(s.url)}）\n${s.excerpt}`).join('\n\n')}`;
        out = parseJson(await ask({ system: EXTRACT_SYS, prompt, signal }).catch(e => {throwControl(e, signal);return '';}));
      } else {
        const lines = sources.flatMap((s) => extractive(`${item.label} ${question}`, s.text, 2).map((q) => ({ source: s.n, quote: q })));
        out = { answer: lines[0]?.quote ?? null, evidence: lines.slice(0, 3), confidence: 'low' };
      }
      // 5. 核对引用：必须真的在那篇原文里
      const evidence = (out?.evidence || []).map((e) => {
        const s = sources.find((x) => x.n === Number(e.source));
        return s && quoteInText(e.quote, s.text) ? { url: s.url, title: s.title, quote: String(e.quote).trim(), original: s.original === true } : null;
      }).filter(Boolean);
      const hosts = new Set(evidence.map((e) => host(e.url)));
      const status = !out?.answer || !evidence.length ? 'unverified' : out?.conflict ? 'single' : hosts.size >= 2 ? 'confirmed' : evidence.some(e => e.original && isOfficialSource(e.url)) ? 'official_original' : 'single';
      const dropped = (out?.evidence || []).length - evidence.length;
      const cur = { label: item.label, answer: out?.answer ?? null, fields: out?.fields || {}, status, sources: evidence, conflict: out?.conflict || null, dropped, names, round };
      if (!best || rank(cur) > rank(best)) best = cur;
      // 6. 两个网站都支持或读到官方原文就结束；否则换搜索词再查一轮
      if (['confirmed', 'official_original'].includes(status) && !out?.conflict) break;
      const more = (out?.nextQueries || []).filter((q) => q && !queries.includes(q));
      queries = more.length ? more.slice(0, 4) : [`${names[0] || item.label} ${question} ${date}`.trim(), `${names.slice(0, 2).join(' ')} ${dateHints[1] || date}`.trim()].filter((q) => !queries.includes(q));
      if (!queries.length) break;
    }
    return best || { label: item.label, status: 'unverified', answer: null, sources: [], names };
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return { question, date, items: results };
}

const rank = (r) => ({ confirmed: 3, official_original: 3, single: 2, unverified: 1, error: 0 }[r.status] ?? 0) * 10 + r.sources.length;

const STATUS = { official_original: '✅ 已核实（官方原文）', confirmed: '✅ 已核实（两个以上网站一致）', single: '⚠️ 单一来源', unverified: '❓ 未核实', error: '✕ 查询出错' };

/** 给主模型看的结果：每项的结论、状态、原文引用和链接 */
export function formatReport(r) {
  const lines = [`查证结果（${r.question}${r.date ? `，${r.date}` : ''}）。只能使用下面核实过的内容；“单一来源 / 未核实”的项目在回答里要标明，不要用记忆补全。`, ''];
  r.items.forEach((x, i) => {
    lines.push(`${i + 1}. ${x.label}：${x.answer ?? '没有找到可靠结果'}　${STATUS[x.status] ?? x.status}`);
    if (x.fields && Object.keys(x.fields).length) lines.push(`   字段：${Object.entries(x.fields).map(([k, v]) => `${k}=${v}`).join('；')}`);
    if (x.conflict) lines.push(`   来源说法不一致：${x.conflict}`);
    for (const s of x.sources.slice(0, 3)) lines.push(`   - 「${s.quote.slice(0, 160)}」 ${s.url}`);
    if (x.dropped) lines.push(`   （另有 ${x.dropped} 条引用在原文里找不到，已作废）`);
    if (x.error) lines.push(`   出错：${x.error}`);
  });
  return lines.join('\n');
}

