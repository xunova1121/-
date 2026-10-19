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
import { collection, uid } from './store.js';
import { buildIndex, tokenize } from './search.js';

const memories = collection('memories');
const lessons = collection('lessons');
const skills = collection('skills');
const events = collection('events');
const episodes = collection('episodes');
const kv = collection('kv');

const DAY = 86400000;
export const CATEGORIES = { profile: '身份', preference: '偏好', habit: '习惯', fact: '事实', goal: '目标', other: '其他' };
const CORE_LIMIT = 1200;

// ---------------------------------------------------------------- 可选的大模型与向量服务（由界面按当前配置注入）
let llm = null; // async ({ system, prompt }) => string
let embedder = null; // { model: string, embed: async (texts: string[]) => number[][] }
export function configureMemory({ llm: l = null, embedder: e = null } = {}) {
  llm = l;
  embedder = e;
}
export const memoryEngine = () => ({ llm: Boolean(llm), embeddings: embedder?.model ?? null });

async function log(kind, text) {
  await events.put({ id: uid('e'), kind, text, ts: Date.now() });
}

const now = () => Date.now();
// 还有效的记忆。自动提炼的（pending：用户没确认过）也算，参与回答时会标明“自动记下”，面板里可以确认或删除
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
export async function remember(content, category = 'fact', { importance = 3, source = 'tool', evidence = '' } = {}) {
  content = norm(content);
  if (!content) throw new Error('记忆内容为空');
  if (!CATEGORIES[category]) category = 'other';
  importance = Math.max(1, Math.min(5, Math.round(Number(importance) || 3)));
  const all = (await memories.all()).map(upgrade);
  const vec = await embedOne(content);
  const pending = source.includes('待核实');
  const duplicate = all.find(m=>!m.validTo && norm(m.content)===content);
  // 自动提炼的也走正常合并：同一件事的新说法（如搬家后的住址）取代旧的，不会新旧两条同时存在
  const { action, target } = duplicate ? { action: 'NOOP', target: duplicate } : await decide(content, category, all, vec);
  const t = now();
  if (action === 'NOOP') {
    Object.assign(target, { updatedAt: t, lastUsed: t, importance: Math.max(target.importance, importance) }, pending ? {} : { pending: false }); // 用户亲口要记的，自动记下的那条就算确认了
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
      source, evidence, pending
    };
    await memories.put({ ...target, validTo: t, supersededBy: next.id });
    await memories.put(next);
    await log('memory', `更新记忆：${target.content} → ${content}`);
    return { ...next, action, previous: target.content };
  }
  const m = {
    id: uid('m'), content, category, importance, ts: t, updatedAt: t, lastUsed: t, validFrom: t, validTo: null,
    uses: 0, history: [], source, evidence, pending, pinned: false,
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
export async function reflect(turns, { episode = true, session = null } = {}) {
  const userLines = turns.filter((t) => t.role === 'user').map((t) => t.content);
  if (!userLines.length) return { memories: [], episode: null };
  const pending = await openItems({ exclude: session?.id, days: 30, k: 12 });
  if (llm) {
    try {
      const text = await llm({
        system: '你是记忆整理器。只输出 JSON，不要解释。',
        prompt: `下面是一段用户与助手的对话。\n1. 抽取值得长期记住的“关于用户”的信息（身份、偏好、习惯、目标、重要事实），每条一句第三人称陈述（如“用户住在上海”）；临时性的问题、助手说的话、密码密钥等敏感信息不要记。\n2. 用一两句话概括这段对话做了什么。\n3. 列出这段对话里说好以后再做、还没做完的事（open），没有就空。\n4. 下面是之前对话里没做完的事，这段对话里已经完成或用户说不用做了的，原样列在 done 里。\n之前没做完的事：\n${pending.map((o) => `- ${o.text}`).join('\n') || '（无）'}\n\n输出格式：{"memories":[{"content":"…","category":"profile|preference|fact|goal","importance":1-5}],"summary":"…","topics":["…"],"open":["…"],"done":["…"]}\n\n对话：\n${turns.map((t) => `${t.role === 'user' ? '用户' : '助手'}：${String(t.content).slice(0, 600)}`).join('\n').slice(-6000)}`
      });
      const raw = String(text).match(/\{[\s\S]*\}/)?.[0];
      if (!raw) throw new Error('模型没有返回 JSON');
      const j = JSON.parse(raw);
      const facts = Array.isArray(j.memories) ? j.memories.filter((m) => m?.content) : [];
      const summary = String(j.summary || '');
      const topics = Array.isArray(j.topics) ? j.topics.slice(0, 5).map(String) : [];
      const open = Array.isArray(j.open) ? j.open.map(String) : [];
      if (Array.isArray(j.done)) await resolveOpen(pending.filter((o) => j.done.some((d) => lexicalSim(String(d), o.text) >= 0.6)));
      return { memories: await saveFacts(facts, userLines, session), episode: episode && summary ? await addEpisode({ summary, topics, turns: turns.length, session, open }) : null };
    } catch { /* 模型输出不合格：退回规则 */ }
  }
  const facts = ruleFacts(userLines.join('\n'));
  const summary = `用户：${userLines.slice(-3).map((l) => l.slice(0, 40)).join('；')}`;
  const text = userLines.join('\n');
  await resolveOpen(pending.filter((o) => lexicalSim(text, o.text) >= 0.5 || userLines.some((l) => lexicalSim(l, o.text) >= 0.5)));
  return { memories: await saveFacts(facts, userLines, session), episode: episode ? await addEpisode({ summary, turns: turns.length, session, open: ruleOpen(userLines) }) : null };
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
  for (const f of facts.slice(0, 8)) {
    try { out.push(await remember(f.content, f.category || 'fact', { importance: f.importance ?? 3, source: '会话 '+(session?.id || '未记录')+' · 自动提炼，待核实', evidence: userLines.join('\n').slice(-4000) })); } catch { /* 跳过 */ }
  }
  return out;
}

/** 离线规则：从用户原话里抽取明显的自我介绍与偏好 */
export function ruleFacts(text) {
  const out = [];
  const add = (content, category, importance = 3) => out.push({ content, category, importance });
  for (const line of String(text).split(/[\n。！!？?；;]/)) {
    const s = line.trim();
    let m;
    if ((m = s.match(/我(?:叫|的名字是)\s*([一-龥A-Za-z]{1,12})/))) add(`用户叫${m[1]}`, 'profile', 5);
    if ((m = s.match(/我(?:住在|在)\s*([一-龥]{2,8}?)(?:工作|上班|生活|住)/))) add(`用户在${m[1]}${s.includes('住') || s.includes('生活') ? '生活' : '工作'}`, 'profile', 4);
    if ((m = s.match(/我(?:是|是一名|是个)\s*([一-龥A-Za-z]{2,12}?)(?:[，,]|$)/)) && !/谁|什么/.test(m[1])) add(`用户是${m[1]}`, 'profile', 4);
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
async function embedOne(text) {
  if (!embedder) return null;
  try { return (await embedder.embed([text]))[0] ?? null; } catch { return null; }
}

/**
 * 混合检索 + 打分。
 * @param {Array} items
 * @param {string} query
 * @param {(x) => string} text
 * @param {{ k?: number, vec?: number[]|null, weights?: boolean }} o
 */
export function score(items, query, text, { k = 8, vec = null, weights = true, at = now() } = {}) {
  if (!items.length) return [];
  const search = buildIndex(items.map((x) => ({ id: x.id, text: text(x) })));
  const bm = new Map(search(query, items.length).map((h) => [h.id, h.score]));
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
export async function contextFor(query) {
  const [ms, ls, ss, eps, core] = await Promise.all([memories.all(), lessons.all(), skills.all(), episodes.all(), getCore()]);
  const vec = await embedOne(query);
  // 像注入指令的条目不交给模型（原文保留在库里，面板上标“可疑，未使用”）
  const cur = ms.map(upgrade).filter(current).filter(safe((m) => m.content));
  const relevant = score(cur, query, (m) => m.content, { k: 6, vec });
  // 身份与重要偏好：即使和问题不相关也带上几条，保证“认识用户”
  const profile = cur.filter((m) => m.pinned || ((m.category === 'profile' || m.category === 'preference') && m.importance >= 3))
    .sort((a, b) => (b.pinned - a.pinned) || (b.importance - a.importance) || (b.updatedAt - a.updatedAt)).slice(0, 5);
  const mem = [...new Map([...profile, ...relevant].map((m) => [m.id, m])).values()].slice(0, 9);
  reinforce(relevant).catch(() => {});
  return {
    core: cleanCore(core),
    memories: mem,
    episodes: score(eps.filter(safe((e) => e.summary)), query, (e) => `${e.summary} ${(e.topics || []).join(' ')}`, { k: 2, vec, weights: false }).filter((e) => e.relevance >= 0.2),
    lessons: score(ls.filter(safe((l) => `${l.content}\n${l.context ?? ''}`)), query, (l) => `${l.content} ${l.context}`, { k: 3, weights: false }),
    skills: score(ss.filter(safe(skillText)), query, (s) => `${s.name} ${s.description}`, { k: 3, weights: false })
  };
}
const skillText = (s) => `${s.name}\n${s.description ?? ''}\n${s.steps ?? ''}`;

export async function recall(query, { includeArchived = false } = {}) {
  const all = (await memories.all()).map(upgrade).filter(safe((m) => m.content));
  const pool = includeArchived ? all : all.filter(current);
  const vec = await embedOne(query);
  const hits = score(pool, query, (m) => m.content, { k: 8, vec });
  const eps = score((await episodes.all()).filter(safe((e) => e.summary)), query, (e) => e.summary, { k: 3, vec, weights: false });
  return { memories: hits, episodes: eps.filter((e) => e.relevance >= 0.2) };
}

/** 维护：长期不用、重要度低、没钉住的记忆归档（不删除）；补算缺失的向量 */
export async function maintain({ at = now() } = {}) {
  const all = (await memories.all()).map(upgrade);
  let archived = 0;
  let embedded = 0;
  for (const m of all) {
    if (!current(m)) continue;
    if (!m.pinned && m.importance <= 2 && (m.uses ?? 0) === 0 && at - (m.lastUsed ?? m.ts) > 120 * DAY) {
      await memories.put({ ...m, validTo: at, archivedReason: '长期未使用' });
      archived++;
    } else if (embedder && m.embModel !== embedder.model && embedded < 50) {
      const vec = await embedOne(m.content);
      if (vec) { await memories.put({ ...m, embedding: vec, embModel: embedder.model }); embedded++; }
    }
  }
  if (archived) await log('forget', `归档了 ${archived} 条长期未用的记忆`);
  return { archived, embedded };
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

