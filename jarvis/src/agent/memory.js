/**
 * 记忆与进化（v2）。
 *
 * “自主学习”在这里的含义很具体：不改大模型参数，而是在本机持续积累、整理下面几类东西，
 * 每次对话按相关度取出放进上下文，让回答越来越贴合用户。
 *
 *   core      核心记忆（参考 Letta / MemGPT 的 core memory）：两段简短文字——“关于用户”和“我的设定”，
 *             每轮都在上下文里；模型可用 core_memory_update 改写，用户也能在面板里直接编辑
 *   memories  长期记忆：偏好、身份、事实、目标。写入时先和已有记忆比对（参考 Mem0 的“抽取→更新”流程）：
 *             新增 / 合并重复 / 更新（旧版本保留为历史，带有效期，参考 Graphiti 的时间有效性）
 *   episodes  情景记忆：每段对话结束后的摘要，“上次我们聊到……”
 *   lessons   经验教训：用户点 👎 并说明原因时记下
 *   skills    习得技能：完成多步任务后模型总结的做法
 *   events    进化日志
 *
 * 检索打分（参考 Generative Agents）：相关度 × 1 + 新近度 × 0.5 + 重要度 × 0.5（钉住的额外加分）；
 * 相关度 = BM25（本地，离线可用）与语义向量（配置了 embedding 服务时）混合。被取用的记忆会“巩固”：使用次数 +1、刷新最近使用时间。
 * 长期不用、重要度低的记忆会被归档（不删除，可在面板里看到）。
 */
import { preferenceClaim, preferenceSupported, wasPreferenceRetracted } from './memoryPreference.js';
import { collection, uid } from './store.js';
import { buildIndex, tokenize } from './search.js';
import { createDocumentStyles } from './documentStyles.js';

const memories = collection('memories');
const documentStyles = createDocumentStyles({ store: memories, unsafe: text => Boolean(injectionReason(text)) });
export const listDocumentStyles = () => documentStyles.list();
export const deleteDocumentStyle = id => documentStyles.remove(id);
export const documentStyleContext = signal => documentStyles.context(signal);
const lessons = collection('lessons');
const skills = collection('skills');
const events = collection('events');
const episodes = collection('episodes');
const kv = collection('kv');

const DAY = 86400000;
export const CATEGORIES = { profile: '身份', preference: '偏好', habit: '习惯', fact: '事实', goal: '目标', doc_style: '写作偏好', other: '其他' };
const CORE_LIMIT = 1200;

// ---------------------------------------------------------------- 可选的大模型与向量服务（由界面按当前配置注入）
let llm = null; // async ({ system, prompt }) => string
let embedder = null; // { model: string, embed: async (texts: string[]) => number[][] }
export function configureMemory({ llm: l = null, embedder: e = null } = {}) {
  llm = l;
  embedder = e;
}
/** 只换向量服务，不动整理用的大模型（服务器查向量状态时用） */
export function setEmbedder(e = null) {
  embedder = e;
}
export const memoryEngine = () => ({ llm: Boolean(llm), embeddings: embedder?.model ?? null });

async function log(kind, text) {
  await events.put({ id: uid('e'), kind, text, ts: Date.now() });
}

const now = () => Date.now();
// 还有效的记忆。没找到原话依据的（pending：线索）也算，参与回答时会标明“线索”；别的对话再提到会自动转正，30 天没再出现自动归档
const current = (m) => !m.validTo;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/[。.!！]+$/, '');

/** 旧记录补齐字段（v1 只有 content / category / ts / uses） */
function upgrade(m) {
  return {
    importance: 3, updatedAt: m.ts, lastUsed: m.ts, uses: 0, history: [], source: 'tool', pinned: false, validTo: null,
    ...m
  };
}

// ---------------------------------------------------------------- 相似度
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
/** 词面相似度（Dice 系数，中文按单字 + 二元组），不依赖向量模型 */
export function lexicalSim(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * “属性”：同一属性只能有一个当前值（住在哪、叫什么、在哪工作……），新值会取代旧值；
 * 喜欢什么之类的可以有多个，不互相取代。
 */
const SINGLE = [
  ['name', /(叫|名字是|姓名是|称呼)/],
  ['city', /(住在|居住在|生活在|家在|人在|base\s*在|在\S{1,6}(工作|上班|生活))/],
  ['company', /(就职于|任职于|供职于|在\S{1,12}(公司|集团|单位)(工作|上班)?)/],
  ['job', /(职业是|职位是|岗位是|是一名|是个|做\S{0,4}(工作|开发|设计|运营|销售))/],
  ['birthday', /(生日|出生于|出生在)/],
  ['email', /(邮箱|email)/i],
  ['phone', /(电话|手机号)/]
];
export function attributeOf(text) {
  const t = String(text);
  for (const [k, re] of SINGLE) if (re.test(t)) return k;
  return null;
}

// ---------------------------------------------------------------- 写入（抽取 → 比对 → 新增 / 合并 / 更新）
/**
 * 决定一条新记忆怎么处理。
 * @returns {{ action: 'ADD'|'NOOP'|'UPDATE', target?: object }}
 */
export async function decide(content, category, existing, vec = null) {
  const cur = existing.filter(current);
  let best = null;
  let bestSim = 0;
  for (const m of cur) {
    const lex = lexicalSim(content, m.content);
    const sem = vec && m.embedding && m.embModel === embedder?.model ? cosine(vec, m.embedding) : 0;
    const sim = Math.max(lex, sem * 0.98);
    if (sim > bestSim) { bestSim = sim; best = m; }
  }
  if (best && norm(best.content) === norm(content)) return { action: 'NOOP', target: best };
  // 同一单值属性（如“住在哪”）的新说法 → 取代旧值
  const attr = attributeOf(content);
  if (attr) {
    const subject = /^(用户|我)(?!的)/.test(content) ? 'user' : null;
    const same = subject && cur.find((m) => /^(用户|我)(?!的)/.test(m.content) && attributeOf(m.content) === attr && !/(不|没|否|未)/.test(content+m.content));
    if (same) return { action: 'UPDATE', target: same };
  }
  // Similarity only ranks retrieval; ambiguous facts stay separate for review.
  return { action: 'ADD' };
}

/**
 * @param {string} content
 * @param {string} [category]
 * @param {{ importance?: number, source?: string }} [o]
 * @returns {Promise<object>} 记忆，带 action 字段说明发生了什么
 */
export async function remember(content, category = 'fact', { importance = 3, source = 'tool', evidence = '', sessionId = null } = {}) {
  if (category === 'doc_style') {
    const recorded = await documentStyles.learn([evidence]);
    if (!recorded.length) throw Object.assign(new Error('写作偏好需要用户明确的长期文档要求原话'), { kind: 'input', code: 'DOC_STYLE_SOURCE' });
    return recorded[0];
  }
  content = norm(content);
  if (!content) throw new Error('记忆内容为空');
  if (!CATEGORIES[category]) category = 'other';
  importance = Math.max(1, Math.min(5, Math.round(Number(importance) || 3)));
  const all = (await memories.all()).map(upgrade);
  const automatic = /自动|模型工具/.test(source);
  const preference = preferenceClaim(content, category);
  if (automatic && wasPreferenceRetracted(content, category, all)) throw Object.assign(new Error('这条偏好此前已被用户撤回，不能从旧对话自动恢复；需要用户明确重新记录'), { code: 'MEMORY_RETRACTED', kind: 'input' });
  const needsPreferenceConfirmation = Boolean(automatic && (preference || category === 'preference') && !preferenceSupported(content, evidence, category));
  if (needsPreferenceConfirmation && !source.includes('待核实')) source += ' · 偏好语义待核实';
  const vec = await embedOne(content);
  let pending = source.includes('待核实');
  const duplicate = all.find(m=>!m.validTo && norm(m.content)===content);
  // 自动提炼有冲突时先保留为候选，不能直接覆盖用户已确认的记录。
  const { action, target } = duplicate ? { action: 'NOOP', target: duplicate } : await decide(content, category, all, vec);
  const t = now();
  if (action === 'NOOP') {
    // 另一段对话里又总结出同一件事：算她自己核实过了，转正（同一段对话里重复提炼不算）
    const repeated = pending && target.pending && !needsPreferenceConfirmation && !target.needsPreferenceConfirmation && sessionId && target.sessionId && sessionId !== target.sessionId;
    if (repeated) {
      pending = false;
      source = target.source.replace('待核实', '两段对话都提到，已自动核实');
    }
    // 只有确认过（用户亲口要记、原话已核对或两段对话都提到）才使冲突的旧值失效
    if (!pending && target.conflictsWith) {
      const previous = await memories.get(target.conflictsWith);
      if (previous && !previous.validTo) {
        await memories.put({ ...previous, validTo: t, supersededBy: target.id });
        target.history = [...(target.history || []), { content: previous.content, until: t }].slice(-10);
      }
      target.supersedes = target.conflictsWith;
      delete target.conflictsWith;
    }
    // 用户亲口要记的、原话核对过的、两段对话都提到的：自动记下的那条就算确认了
    Object.assign(target, { needsPreferenceConfirmation, updatedAt: t, lastUsed: t, importance: Math.max(target.importance, importance) }, pending ? {} : { pending: false, source: repeated ? source : target.source });
    await memories.put(target);
    return { ...target, action };
  }
  if (action === 'UPDATE' && !(pending && !target.pending)) {
    // 旧版本保留为历史：标记失效时间，新版本记录它取代了谁
    const next = {
      ...target,
      id: uid('m'),
      content,
      category,
      importance: Math.max(target.importance, importance),
      updatedAt: t,
      lastUsed: t,
      validFrom: t,
      history: [...(target.history || []), { content: target.content, until: t }].slice(-10),
      embedding: vec ?? undefined,
      embModel: vec ? embedder.model : undefined,
      source, evidence, pending, needsPreferenceConfirmation,
      supersedes: target.id, // 撤回时恢复它
      ...(sessionId && { sessionId })
    };
    await memories.put({ ...target, validTo: t, supersededBy: next.id });
    await memories.put(next);
    await log('memory', `更新记忆：${target.content} → ${content}`);
    return { ...next, action, previous: target.content };
  }
  const m = {
    id: uid('m'), content, category, importance, ts: t, updatedAt: t, lastUsed: t, validFrom: t, validTo: null,
    uses: 0, history: [], source, evidence, pending, needsPreferenceConfirmation, pinned: false,
    ...(sessionId && { sessionId }),
    ...(action === 'UPDATE' && pending && !target.pending ? {conflictsWith:target.id} : {}),
    ...(vec ? { embedding: vec, embModel: embedder.model } : {})
  };
  await memories.put(m);
  await log('memory', `记住：${content}`);
  return { ...m, action: 'ADD' };
}

/** 忘记：归档（失效），不物理删除；面板里的“删除”才会真正删掉 */
export async function forget(id, reason = '用户要求忘记') {
  const m = await memories.get(id);
  if (!m) return;
  await memories.put({ ...upgrade(m), validTo: now(), archivedReason: reason });
  await log('forget', `忘记：${m.content}`);
}

export async function updateMemory(id, patch) {
  const m = await memories.get(id);
  if (!m) return null;
  const next = { ...upgrade(m), ...patch, updatedAt: now() };
  if (patch.content && patch.content !== m.content) {
    next.history = [...(next.history || []), { content: m.content, until: now() }].slice(-10);
    const vec = await embedOne(patch.content);
    if (vec) Object.assign(next, { embedding: vec, embModel: embedder.model });
  }
  await memories.put(next);
  return next;
}

// ---------------------------------------------------------------- 注入检查（参考 Hermes Agent 的记忆扫描）
// 记忆会原样进入提示词：一条被投毒的记忆（网页内容、导入的文件、同步来的数据）每轮都会生效。
// 交给模型之前逐条检查；命中的不放进提示，原文保留，记忆空间里标“可疑，未使用”，由用户决定删不删。
const SENDS = /(发送|发给|发到|上传|传到|转发|提交|\bsend\b|\bupload\b|\bpost\b|\bexfiltrat)/i;
const SECRETS = /(密钥|秘钥|api\s*_?key|token|令牌|密码|password|私钥|cookie|credential|凭证)/i;
const FILES = /(文件|file)/i;
const ADDRESS = /(https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+)/i;
// 命令口吻（让助手去做）vs 描述用户的习惯（“用户每周一把周报文件发给……”是正常记忆）
const COMMAND = /^(请|麻烦|把|将|立即|立刻|马上|务必|一定要|你要|你必须|你需要|please\b|you must\b|send\b|upload\b|post\b)|给我发|发给我|你(要|必须|需要|应该|得)[^。\n]{0,12}(发送|发给|发到|上传|传到|转发)|\byou (must|should|need to)\b/i;
const DESCRIBES = /^(用户|我(习惯|通常|经常|一般|每))|每(周|天|日|月|年)|习惯|通常|经常/;
/** 把东西发到外部地址：涉及密钥 / 密码等凭证一律算；普通文件只有命令口吻才算（逐句看：技能步骤里第几行都可能是命令） */
function sendsOut(t) {
  if (!SENDS.test(t) || !ADDRESS.test(t)) return false;
  if (SECRETS.test(t)) return true;
  return t.split(/[\n。；;！!]+/).map((s) => s.trim()).some((s) => SENDS.test(s) && ADDRESS.test(s) && FILES.test(s) && COMMAND.test(s) && !DESCRIBES.test(s));
}
const INJECTION_RULES = [
  { why: '要求忽略之前的指令', test: (t) => /(忽略|无视|忘掉|忘记|不要理会|不用管)(掉)?(你)?(之前|以上|前面|先前|上面|此前|所有|全部|原有|原来)的?(所有|全部)?(指令|指示|命令|规则|设定|提示|要求)/.test(t) },
  { why: '要求忽略之前的指令', test: (t) => /\b(ignore|disregard|forget|override)\b.{0,24}\b(previous|prior|above|earlier|preceding|all)\b.{0,24}\b(instructions?|prompts?|rules|directions)\b/i.test(t) },
  { why: '试图改变身份设定', role: true, test: (t) => /(你现在是|从现在起你是|从现在开始你是|\byou are now\b)/i.test(t) },
  { why: '涉及系统提示词', test: (t) => /(system\s*prompt|系统提示词|系统指令)/i.test(t) },
  { why: '要求把文件或密钥发送到外部地址', test: sendsOut }
];

/**
 * 看起来像注入指令就返回原因，否则 null。
 * 核心记忆（core: true）不套用“你现在是……”这条：那是正常的角色设定。
 */
export function injectionReason(text, { core = false } = {}) {
  const t = String(text ?? '');
  return INJECTION_RULES.find((r) => !(core && r.role) && r.test(t))?.why ?? null;
}

/** 核心记忆逐行检查：命中的行去掉，其余照常使用 */
export function coreFlags(core) {
  const flags = [];
  for (const block of ['human', 'persona']) {
    for (const line of String(core?.[block] ?? '').split('\n')) {
      const why = injectionReason(line, { core: true });
      if (why) flags.push({ block, line: line.trim(), why });
    }
  }
  return flags;
}
export function cleanCore(core) {
  const keep = (text) => String(text ?? '').split('\n').filter((line) => !injectionReason(line, { core: true })).join('\n').trim();
  return { ...core, human: keep(core.human), persona: keep(core.persona) };
}
const safe = (text) => (x) => !injectionReason(text(x));

// ---------------------------------------------------------------- 核心记忆
export async function getCore() {
  const c = await kv.get('core');
  return { human: c?.human ?? '', persona: c?.persona ?? '', updatedAt: c?.updatedAt ?? 0 };
}
export async function setCore(block, content) {
  if (!['human', 'persona'].includes(block)) throw new Error('block 只能是 human 或 persona');
  const text = String(content ?? '').trim().slice(0, CORE_LIMIT);
  const c = await getCore();
  await kv.put({ id: 'core', ...c, [block]: text, updatedAt: now() });
  await log('core', `更新核心记忆（${block === 'human' ? '关于用户' : '我的设定'}）`);
  return text;
}

// ---------------------------------------------------------------- 情景记忆（对话摘要）
export async function addEpisode({ summary, topics = [], turns = 0, session = null, open = [] }) {
  summary = norm(summary);
  if (!summary) return null;
  const vec = await embedOne(summary);
  const e = {
    id: uid('ep'), summary, topics, turns, ts: now(),
    ...(session?.id && { sessionId: session.id, sessionTitle: session.title }),
    ...(open.length && { open: open.map(norm).filter(Boolean).slice(0, 5) }),
    ...(vec ? { embedding: vec, embModel: embedder.model } : {})
  };
  await episodes.put(e);
  await log('episode', `记下一段对话：${summary.slice(0, 40)}`);
  return e;
}

/**
 * 一段对话结束后：抽取值得长期记住的信息，并写一段摘要。
 * 有大模型时让模型做（更准）；离线时用规则兜底。
 * @param {Array<{role: string, content: string}>} turns 这段对话（user / assistant）
 */
export async function reflect(turns, { episode = true, session = null, evaluationId = null } = {}) {
  if (evaluationId || session?.evaluationId) return { memories: [], episode: null };
  const userLines = turns.filter((t) => t.role === 'user').map((t) => t.content);
  if (!userLines.length) return { memories: [], episode: null };
  const styles = await documentStyles.learn(userLines, { sessionId: session?.id });
  const pending = await openItems({ exclude: session?.id, days: 30, k: 12 });
  if (llm) {
    try {
      const text = await llm({
        system: '你是记忆整理器。只输出 JSON，不要解释。',
        prompt: `下面是一段用户与助手的对话。\n1. 抽取值得长期记住的“关于用户”的信息（身份、偏好、习惯、目标、重要事实），每条一句第三人称陈述（如“用户住在上海”），quote 填用户说过的、能证明这条的原话（从对话里一字不差地摘，找不到就留空，不要自己编）；临时性的问题、助手说的话、密码密钥等敏感信息不要记。\n2. 用一两句话概括这段对话做了什么。\n3. 列出这段对话里说好以后再做、还没做完的事（open），没有就空。\n4. 下面是之前对话里没做完的事，这段对话里已经完成或用户说不用做了的，原样列在 done 里。\n之前没做完的事：\n${pending.map((o) => `- ${o.text}`).join('\n') || '（无）'}\n\n输出格式：{"memories":[{"content":"…","quote":"用户原话","category":"profile|preference|fact|goal","importance":1-5}],"summary":"…","topics":["…"],"open":["…"],"done":["…"]}\n\n对话：\n${turns.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${String(t.content).slice(0, 600)}`).join('\n').slice(-6000)}`
      });
      const raw = String(text).match(/\{[\s\S]*\}/)?.[0];
      if (!raw) throw new Error('模型没有返回 JSON');
      const j = JSON.parse(raw);
      const facts = Array.isArray(j.memories) ? j.memories.filter((m) => m?.content) : [];
      const summary = String(j.summary || '');
      const topics = Array.isArray(j.topics) ? j.topics.slice(0, 5).map(String) : [];
      const open = Array.isArray(j.open) ? j.open.map(String) : [];
      if (Array.isArray(j.done)) await resolveOpen(pending.filter((o) => j.done.some((d) => lexicalSim(String(d), o.text) >= 0.6)));
      return { memories: [...styles, ...await saveFacts(facts, userLines, session)], episode: episode && summary ? await addEpisode({ summary, topics, turns: turns.length, session, open }) : null };
    } catch { /* 模型输出不合格：退回规则 */ }
  }
  const facts = ruleFacts(userLines.join('\n'));
  const summary = `用户：${userLines.slice(-3).map((l) => l.slice(0, 40)).join('；')}`;
  const text = userLines.join('\n');
  await resolveOpen(pending.filter((o) => lexicalSim(text, o.text) >= 0.5 || userLines.some((l) => lexicalSim(l, o.text) >= 0.5)));
  return { memories: [...styles, ...await saveFacts(facts, userLines, session)], episode: episode ? await addEpisode({ summary, turns: turns.length, session, open: ruleOpen(userLines) }) : null };
}

/** 离线规则：用户说“下次 / 明天 / 回头再……”的事记为未完成 */
export function ruleOpen(userLines) {
  const out = [];
  for (const line of userLines) {
    for (const part of String(line).split(/[。！!？?；;\n]/)) {
      const m = part.match(/(?:下次|明天|回头|以后|改天|待会儿?|晚点|之后)(?:再|继续|帮我|接着)(.{2,40})/);
      if (m) out.push(m[0].trim());
    }
  }
  return [...new Set(out)].slice(0, 3);
}

/**
 * 之前对话里还没做完的事（最新的在前）
 * @returns {Promise<Array<{ episodeId, sessionId, sessionTitle, text, ts }>>}
 */
export async function openItems({ exclude = null, days = 14, k = 4, at = now() } = {}) {
  const eps = (await episodes.all()).filter((e) => e.open?.length && e.sessionId !== exclude && at - e.ts <= days * DAY).filter(safe((e) => e.summary));
  return eps.sort((a, b) => b.ts - a.ts)
    .flatMap((e) => e.open.filter((text) => !injectionReason(text)).map((text) => ({ episodeId: e.id, sessionId: e.sessionId ?? null, sessionTitle: e.sessionTitle ?? '', text, ts: e.ts })))
    .slice(0, k);
}

/** 标记为已完成（从所在的对话摘要里移除） */
export async function resolveOpen(items) {
  const byEp = new Map();
  for (const o of items) byEp.set(o.episodeId, [...(byEp.get(o.episodeId) ?? []), o.text]);
  for (const [id, texts] of byEp) {
    const e = await episodes.get(id);
    if (!e) continue;
    await episodes.put({ ...e, open: (e.open ?? []).filter((t) => !texts.includes(t)) });
    await log('episode', `完成了之前没做完的事：${texts.join('；').slice(0, 40)}`);
  }
}

async function saveFacts(facts, userLines=[], session=null) {
  const out = [];
  const said = squash(userLines.join('\n'));
  for (const f of facts.slice(0, 8)) {
    // 能在用户原话里一字不差找到依据的，直接生效；找不到原话（模型推测的）只当线索，等别的对话再证实
    const quote = String(f.quote ?? '').trim();
    const backed = quote.length >= 2 && said.includes(squash(quote));
    const where = '会话 ' + (session?.id || '未记录');
    const source = backed ? where + ' · 自动提炼，原话已核对' : where + ' · 自动提炼，待核实';
    const evidence = backed ? quote.slice(0, 500) : userLines.join('\n').slice(-4000);
    try { out.push(await remember(f.content, f.category || 'fact', { importance: f.importance ?? 3, source, evidence, sessionId: session?.id ?? null })); } catch { /* 跳过 */ }
  }
  return out;
}
/** 核对原话时不管空白和标点 */
const squash = (text) => String(text).replace(/[\s，,。.！!？?、；;：:“”"'‘’（）()]/g, '');

/** 离线规则：从用户原话里抽取明显的自我介绍与偏好 */
export function ruleFacts(text) {
  const out = [];
  let s = '';
  // 规则是直接从用户原话里抠出来的，原话就是依据
  // “我是……”容易误抓（“我是想问”），只当线索，不带原话
  const add = (content, category, importance = 3, sure = true) => out.push({ content, category, importance, ...(sure && { quote: s }) });
  for (const line of String(text).split(/[\n。！!？?；;]/)) {
    s = line.trim();
    let m;
    if ((m = s.match(/我(?:叫|的名字是)\s*([一-龥A-Za-z]{1,12})/))) add(`用户叫${m[1]}`, 'profile', 5);
    if ((m = s.match(/我(?:住在|在)\s*([一-龥]{2,8}?)(?:工作|上班|生活|住)/))) add(`用户在${m[1]}${s.includes('住') || s.includes('生活') ? '生活' : '工作'}`, 'profile', 4);
    if ((m = s.match(/我(?:是|是一名|是个)\s*([一-龥A-Za-z]{2,12}?)(?:[，,]|$)/)) && !/谁|什么/.test(m[1])) add(`用户是${m[1]}`, 'profile', 4, false);
    if ((m = s.match(/我(?:很|比较|最|特别)?(喜欢|讨厌|不喜欢|习惯)\s*([^，,]{2,24})/))) add(`用户${m[1]}${m[2]}`, 'preference', 3);
  }
  return out;
}

// ---------------------------------------------------------------- 其他学习
export async function addLesson(content, context = '') {
  const l = { id: uid('l'), content: String(content).trim(), context: String(context).slice(0, 200), ts: now() };
  await lessons.put(l);
  await log('lesson', `吸取教训：${l.content}`);
  return l;
}

export async function saveSkill({ name, description, steps }) {
  name = String(name || '').trim();
  if (!name || !steps) throw new Error('技能需要名称和步骤');
  const all = await skills.all();
  const old = all.find((s) => s.name === name);
  const s = { id: old?.id ?? uid('s'), name, description: String(description || ''), steps: String(steps), ts: now(), uses: old?.uses ?? 0, version: (old?.version ?? 0) + 1 };
  await skills.put(s);
  await log('skill', old ? `技能升级：${name}（v${s.version}）` : `习得技能：${name}`);
  return s;
}

export async function noteTask(text) {
  await log('task', text);
}

/** 没做成的任务：记进进化记录但不算“完成任务”，不加经验 */
export async function noteIssue(text) {
  await log('issue', text);
}

// ---------------------------------------------------------------- 检索
/** 向量服务上次出错（模型页显示，免得出错了谁也不知道） */
let lastEmbedError = null;
async function embedOne(text) {
  if (!embedder) return null;
  try { return (await embedder.embed([text]))[0] ?? null; } catch (e) { lastEmbedError = { message: String(e?.message || e).slice(0, 160), at: Date.now() }; return null; }
}

/**
 * 给还没有当前向量的记忆补算（换了向量服务、刚填 Key 时）：一批 16 条，一次最多 limit 条
 * @returns {Promise<number>} 补了几条
 */
export async function backfillVectors({ limit = 400 } = {}) {
  if (!embedder) return 0;
  const model = embedder.model;
  const missing = (await memories.all()).map(upgrade).filter(current).filter((m) => m.embModel !== model && m.content).slice(0, limit);
  let done = 0;
  for (let i = 0; i < missing.length; i += 16) {
    const batch = missing.slice(i, i + 16);
    let vecs;
    try {
      vecs = await embedder.embed(batch.map((m) => m.content));
    } catch (e) {
      lastEmbedError = { message: String(e?.message || e).slice(0, 160), at: Date.now() };
      break;
    }
    for (const [j, m] of batch.entries()) {
      if (!vecs?.[j]) continue;
      await memories.put({ ...m, embedding: vecs[j], embModel: model });
      done++;
    }
  }
  return done;
}

/** 向量现在的情况：用哪个模型、多少条记忆算好了、上次出错 */
export async function vectorStatus() {
  const all = (await memories.all()).map(upgrade).filter(current);
  return { model: embedder?.model ?? null, total: all.length, embedded: embedder ? all.filter((m) => m.embModel === embedder.model).length : 0, lastError: lastEmbedError };
}

/**
 * 混合检索 + 打分。
 * @param {Array} items
 * @param {string} query
 * @param {(x) => string} text
 * @param {{ k?: number, vec?: number[]|null, weights?: boolean }} o
 */
/**
 * 本地同义词：问法和记下的说法用字不一样时（“我多大了”↔“用户今年35岁”），按关键词也能找到。
 * 不靠任何接口，向量服务不可用时照样有效
 */
const ALIASES = [
  [/多大|几岁|年龄|岁数|年纪|出生|生日|属相|属什么/, '岁 年龄 出生 生日'],
  [/住哪|住在|住址|家在|哪里人|哪儿人|老家|家乡|哪个城市|在哪/, '住 住在 住址 城市 老家 家乡'],
  [/老婆|妻子|爱人|媳妇|老公|丈夫|孩子|儿子|女儿|宝宝|怀孕|预产期|产检|家人|家里/, '妻子 老婆 爱人 丈夫 孩子 女儿 儿子 怀孕 预产期 家人'],
  [/工作|职业|做什么的|干什么的|公司|单位|上班|岗位|行业|职位/, '工作 职业 公司 单位 岗位 行业'],
  [/叫什么|名字|称呼|怎么叫/, '叫 名字 称呼'],
  [/股票|持仓|炒股|A股|仓位/, '股票 持仓 股'],
  [/喜欢|爱好|偏好|习惯/, '喜欢 爱好 偏好 习惯']
];
export function expandQuery(query) {
  const q = String(query ?? '');
  const extra = ALIASES.filter(([re]) => re.test(q)).map(([, words]) => words);
  return extra.length ? `${q} ${extra.join(' ')}` : q;
}

export function score(items, query, text, { k = 8, vec = null, weights = true, at = now() } = {}) {
  if (!items.length) return [];
  const search = buildIndex(items.map((x) => ({ id: x.id, text: text(x) })));
  const bm = new Map(search(expandQuery(query), items.length).map((h) => [h.id, h.score]));
  const maxBm = Math.max(1e-9, ...bm.values());
  const out = [];
  for (const x of items) {
    const lex = (bm.get(x.id) ?? 0) / maxBm;
    const sem = vec && x.embedding && x.embModel === embedder?.model ? Math.max(0, cosine(vec, x.embedding)) : null;
    const relevance = sem == null ? lex : 0.45 * lex + 0.55 * sem;
    if (relevance < 0.12 && !x.pinned) continue;
    let s = relevance;
    if (weights) {
      const ageDays = (at - (x.lastUsed ?? x.updatedAt ?? x.ts ?? at)) / DAY;
      const recency = Math.exp(-ageDays / 30);
      s += 0.5 * recency + 0.5 * ((x.importance ?? 3) / 5) + (x.pinned ? 0.6 : 0);
    }
    out.push({ ...x, score: s, relevance });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}

/** 被取用的记忆“巩固”一下：使用次数 +1，刷新最近使用时间 */
async function reinforce(list) {
  const t = now();
  await Promise.all(list.map(async (m) => {
    const raw = await memories.get(m.id);
    if (raw) await memories.put({ ...upgrade(raw), uses: (raw.uses ?? 0) + 1, lastUsed: t });
  }));
}

/** 为当前问题取出：核心记忆、相关记忆、相关的过往对话、教训、技能 */
export async function contextFor(query, { vector = true } = {}) {
  // 向量和读库同时进行；闲聊（你好、在吗）不按意思检索，只用关键词，不等向量服务
  const [ms, ls, ss, eps, core, vec] = await Promise.all([memories.all(), lessons.all(), skills.all(), episodes.all(), getCore(), vector ? embedOne(query) : null]);
  // 像注入指令的条目不交给模型（原文保留在库里，面板上标“可疑，未使用”）
  const cur = ms.map(upgrade).filter(current).filter(m => m.category !== 'doc_style').filter(safe((m) => m.content));
  const relevant = score(cur, query, (m) => m.content, { k: 6, vec });
  // 基本情况（年龄、称呼、住址、家人、工作……）：每轮都带上，不和偏好抢名额，也不靠和问题像不像
  const basics = basicFacts(cur);
  // 重要偏好：即使和问题不相关也带上几条
  const prefs = cur.filter((m) => !basics.includes(m) && (m.pinned || (m.category === 'preference' && m.importance >= 3)))
    .sort((a, b) => (b.pinned - a.pinned) || (b.importance - a.importance) || (b.updatedAt - a.updatedAt)).slice(0, 5);
  const mem = [...new Map([...prefs, ...relevant].filter((m) => !basics.includes(m)).map((m) => [m.id, m])).values()].slice(0, 9);
  reinforce(relevant).catch(() => {});
  return {
    core: cleanCore(core),
    basics,
    memories: [...basics, ...mem], // 含基本情况（旧调用方照旧拿得到）；拼提示时基本情况单独一节，这里的不重复列
    episodes: score(eps.filter(safe((e) => e.summary)), query, (e) => `${e.summary} ${(e.topics || []).join(' ')}`, { k: 2, vec, weights: false }).filter((e) => e.relevance >= 0.2),
    lessons: score(ls.filter(safe((l) => `${l.content}\n${l.context ?? ''}`)), query, (l) => `${l.content} ${l.context}`, { k: 3, weights: false }),
    skills: score(ss.filter(safe(skillText)), query, (s) => `${s.name} ${s.description}`, { k: 3, weights: false })
  };
}
const skillText = (s) => `${s.name}\n${s.description ?? ''}\n${s.steps ?? ''}`;

/** 像“用户的基本情况”的记忆：身份类，或者事实里说的是年龄、称呼、住址、家人、工作 */
const BASIC = /岁|年龄|出生|生日|名字|叫(?:他|她|用户)?|称呼|住在|住址|老家|家乡|籍贯|城市|妻子|丈夫|老婆|老公|爱人|孩子|女儿|儿子|父亲|母亲|爸爸|妈妈|怀孕|预产期|职业|工作|公司|单位|岗位|行业|学校|专业/;
export const BASICS_LIMIT = { items: 14, chars: 700 };
export function basicFacts(list) {
  const picked = list
    .filter((m) => m.category === 'profile' || (m.category === 'fact' && BASIC.test(m.content)) || (m.pinned && BASIC.test(m.content)))
    .sort((a, b) => Number(a.pending) - Number(b.pending) || (b.pinned - a.pinned) || (b.importance - a.importance) || (b.updatedAt - a.updatedAt));
  const out = [];
  let size = 0;
  for (const m of picked) {
    if (out.length >= BASICS_LIMIT.items || size + m.content.length > BASICS_LIMIT.chars) break;
    out.push(m);
    size += m.content.length;
  }
  return out;
}

export async function recall(query, { includeArchived = false } = {}) {
  const all = (await memories.all()).map(upgrade).filter(safe((m) => m.content));
  const pool = includeArchived ? all : all.filter(current);
  const vec = await embedOne(query);
  const hits = score(pool, query, (m) => m.content, { k: 8, vec });
  const eps = score((await episodes.all()).filter(safe((e) => e.summary)), query, (e) => e.summary, { k: 3, vec, weights: false });
  const ls = score((await lessons.all()).filter(safe((l) => l.content)), query, (l) => `${l.content} ${l.context ?? ''}`, { k: 3, weights: false });
  return { memories: hits, episodes: eps.filter((e) => e.relevance >= 0.2), lessons: ls };
}

/**
 * 维护：长期不用、重要度低、没钉住的记忆归档（不删除）；线索 30 天没再被证实也归档；补算缺失的向量；
 * 有大模型时每天最多整理一次（合并重复、去掉和更新的记忆矛盾的旧条目）。
 */
export async function maintain({ at = now() } = {}) {
  const all = (await memories.all()).map(upgrade);
  let archived = 0;
  let embedded = 0;
  for (const m of all) {
    if (!current(m)) continue;
    if (!m.pinned && m.importance <= 2 && (m.uses ?? 0) === 0 && at - (m.lastUsed ?? m.ts) > 120 * DAY) {
      await memories.put({ ...m, validTo: at, archivedReason: '长期未使用' });
      archived++;
    } else if (m.pending && !m.pinned && at - (m.updatedAt ?? m.ts) > CLUE_DAYS * DAY) {
      await memories.put({ ...m, validTo: at, archivedReason: `${CLUE_DAYS} 天没再被证实的线索` });
      archived++;
    }
  }
  // 没有当前向量的一次补完（以前每次只补 50 条，刚填 Key 时要好几轮才补齐）
  embedded = await backfillVectors();
  if (archived) await log('forget', `归档了 ${archived} 条长期未用或没被证实的记忆`);
  const tidied = await consolidate({ at }).catch(() => null);
  return { archived, embedded, ...(tidied && { merged: tidied.merged, dropped: tidied.dropped }) };
}

const CLUE_DAYS = 30;
/** 整理一次最多动几条：模型可能合错，改动小、留历史、能撤回 */
const TIDY = { every: DAY, pool: 60, merges: 5, drops: 5 };

/**
 * 整理记忆（每天最多一次，要有大模型）：把说同一件事的几条合成一条、把和更新记忆矛盾的旧条目归档。
 * 钉住的、写作偏好不动；被合并 / 归档的旧条目留在归档里，新条目记着它们，面板上能撤回。
 * @returns {Promise<{ merged: number, dropped: number } | null>} 没整理时返回 null
 */
export async function consolidate({ at = now(), force = false } = {}) {
  if (!llm) return null;
  const last = await kv.get('memory:tidiedAt');
  if (!force && last?.at && at - last.at < TIDY.every) return null;
  await kv.put({ id: 'memory:tidiedAt', at });
  const pool = (await memories.all()).map(upgrade).filter(current)
    .filter((m) => !m.pinned && m.category !== 'doc_style').filter(safe((m) => m.content))
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, TIDY.pool);
  if (pool.length < 2) return { merged: 0, dropped: 0 };
  const byId = new Map(pool.map((m) => [m.id, m]));
  const text = await llm({
    system: '你是记忆整理器。只输出 JSON，不要解释。',
    prompt: `下面是关于用户的记忆，每行：id | 记下的时间 | 内容。请整理：
1. merge：几条说的是同一件事（重复、换了说法、一条包含另一条），合成一句更准确简洁的第三人称陈述。不同的事不要合并。
2. drop：一条和另一条更新的记忆直接矛盾（如住址、职位变了），列出旧的那条 id 和取代它的新 id。只是不同、不算矛盾的不要列。
拿不准就不要动。最多 merge ${TIDY.merges} 组、drop ${TIDY.drops} 条。
输出：{"merge":[{"ids":["…","…"],"content":"…"}],"drop":[{"id":"旧的","by":"新的"}]}

${pool.map((m) => `${m.id} | ${new Date(m.updatedAt).toISOString().slice(0, 10)} | ${m.content}`).join('\n')}`
  });
  const j = JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] ?? '{}');
  const touched = new Set();
  let merged = 0;
  let dropped = 0;
  for (const g of (Array.isArray(j.merge) ? j.merge : []).slice(0, TIDY.merges)) {
    const ids = [...new Set(Array.isArray(g?.ids) ? g.ids.map(String) : [])].filter((id) => byId.has(id) && !touched.has(id));
    const content = norm(g?.content).slice(0, 200);
    if (ids.length < 2 || !content || injectionReason(content)) continue;
    const olds = ids.map((id) => byId.get(id));
    const vec = await embedOne(content);
    const m = {
      id: uid('m'), content, category: olds[0].category, importance: Math.max(...olds.map((x) => x.importance)),
      ts: Math.min(...olds.map((x) => x.ts)), updatedAt: at, lastUsed: at, validFrom: at, validTo: null,
      uses: olds.reduce((n, x) => n + (x.uses ?? 0), 0),
      history: olds.map((x) => ({ content: x.content, until: at })).slice(-10),
      // 有一条确认过，合并后就算确认过
      pending: olds.every((x) => x.pending), pinned: false,
      source: '整理时合并了 ' + olds.length + ' 条', evidence: olds.map((x) => x.evidence).filter(Boolean).join('\n').slice(0, 1000),
      mergedFrom: ids,
      ...(vec ? { embedding: vec, embModel: embedder.model } : {})
    };
    for (const x of olds) await memories.put({ ...x, validTo: at, supersededBy: m.id, archivedReason: '整理时合并' });
    await memories.put(m);
    ids.forEach((id) => touched.add(id));
    merged++;
  }
  for (const d of (Array.isArray(j.drop) ? j.drop : []).slice(0, TIDY.drops)) {
    const old = byId.get(String(d?.id));
    const by = byId.get(String(d?.by));
    // 只按“更新的那条”取代旧的：新的必须真比旧的晚，而且没被这次合并动过
    if (!old || !by || old === by || touched.has(old.id) || touched.has(by.id) || by.updatedAt <= old.updatedAt) continue;
    await memories.put({ ...old, validTo: at, supersededBy: by.id, archivedReason: '和更新的记忆矛盾' });
    await memories.put({ ...by, supersedes: old.id, history: [...(by.history || []), { content: old.content, until: at }].slice(-10) });
    touched.add(old.id);
    dropped++;
  }
  if (merged || dropped) await log('memory', `整理记忆：合并 ${merged} 组，替换 ${dropped} 条旧说法`);
  return { merged, dropped };
}

/** 撤回自动做的替换 / 合并：恢复被取代的旧条目，这一条归档 */
export async function revert(id) {
  const m = await memories.get(id);
  const previous = [...(m?.mergedFrom ?? []), ...(m?.supersedes ? [m.supersedes] : [])];
  if (!m || !previous.length) throw new Error('这条记忆没有可以撤回的旧版本');
  const t = now();
  for (const pid of previous) {
    const old = await memories.get(pid);
    if (!old) continue;
    const { validTo, supersededBy, archivedReason, ...rest } = upgrade(old);
    await memories.put({ ...rest, validTo: null, updatedAt: t });
  }
  await memories.put({ ...upgrade(m), validTo: t, archivedReason: '用户撤回' });
  await log('memory', `撤回：${m.content}`);
}

// ---------------------------------------------------------------- 面板
export async function listAll() {
  const [ms, ls, ss, es, eps, core] = await Promise.all([memories.all(), lessons.all(), skills.all(), events.all(), episodes.all(), getCore()]);
  const by = (a, b) => (b.updatedAt ?? b.ts) - (a.updatedAt ?? a.ts);
  // 标出像注入指令、不会交给模型的条目（suspicious = 原因）
  const flag = (text) => (x) => { const why = injectionReason(text(x)); return why ? { ...x, suspicious: why } : x; };
  const all = ms.map(upgrade).map(flag((m) => m.content));
  return {
    core,
    coreFlags: coreFlags(core),
    memories: all.filter(m=>!m.validTo).sort((a, b) => Number(b.pending)-Number(a.pending) || (b.pinned - a.pinned) || by(a, b)),
    archived: all.filter((m) => m.validTo).sort(by),
    lessons: ls.map(flag((l) => `${l.content}\n${l.context ?? ''}`)).sort(by),
    skills: ss.map(flag(skillText)).sort(by),
    events: es.sort(by),
    episodes: eps.map(flag((e) => e.summary)).sort(by)
  };
}

export async function deleteItem(kind, id) {
  const c = { memories, lessons, skills, episodes }[kind];
  if (c) await c.delete(id);
}

export async function confirmCandidate(id) {
 const m=await memories.get(id);
 if(!m || !m.pending || m.validTo)throw new Error('没有可确认的候选');
 const result=await remember(m.content,m.category,{importance:m.importance,source:m.source.replace('待核实','用户已核实'),evidence:m.evidence});
 await memories.delete(id);
 await memories.put({...result,pending:false,confirmedAt:now()});
}

/** 备份：导出全部记忆数据（不含向量，导入后会重新计算） */
export async function exportAll() {
  const strip = (x) => { const { embedding, embModel, ...rest } = x; return rest; };
  const [ms, ls, ss, eps, core] = await Promise.all([memories.all(), lessons.all(), skills.all(), episodes.all(), getCore()]);
  return { format: 'jarvis-memory', version: 2, exportedAt: new Date().toISOString(), core, memories: ms.map(strip), lessons: ls, skills: ss, episodes: eps.map(strip) };
}
export async function importAll(data) {
  if (data?.format !== 'jarvis-memory') throw new Error('不是未央的记忆备份文件');
  const put = async (c, list) => { for (const x of list || []) if (x?.id) await c.put(x); };
  await put(memories, data.memories);
  await documentStyles.learn([]);
  await put(lessons, data.lessons);
  await put(skills, data.skills);
  await put(episodes, data.episodes);
  if (data.core) await kv.put({ id: 'core', ...data.core });
  await log('import', `导入记忆备份（${(data.memories || []).length} 条记忆）`);
  return { memories: (data.memories || []).length, lessons: (data.lessons || []).length, skills: (data.skills || []).length, episodes: (data.episodes || []).length };
}

/** 进化等级：积累越多等级越高（经验值 = 记忆×2 + 教训×3 + 技能×5 + 知识文档×2 + 完成任务×1 + 对话片段×1） */
export function levelOf({ memories: m = 0, lessons: l = 0, skills: s = 0, docs = 0, tasks = 0, episodes: e = 0 }) {
  const xp = m * 2 + l * 3 + s * 5 + docs * 2 + tasks + e;
  const level = Math.floor(Math.sqrt(xp / 5)) + 1;
  const cur = 5 * (level - 1) ** 2;
  const next = 5 * level ** 2;
  return { xp, level, progress: (xp - cur) / (next - cur), next };
}
