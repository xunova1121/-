/**
 * 多会话：每段对话单独保存（本机 IndexedDB），可以新建、切换、搜索、重命名、导出、删除。
 * 消息只存文本（用户原话与未央的回答），工具调用记录只存名字，用于回看时显示“用了哪些工具”。
 */
import { collection, uid } from './store.js';
import { buildIndex } from './search.js';

const sessions = collection('sessions');
const TITLE_MAX = 24;

/** 用第一句话做标题 */
export function autoTitle(text) {
  const t = String(text || '').replace(/\[已上传到工作区：[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return '新对话';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
}

export function create({ title = '新对话', messages = [] } = {}) {
  const t = Date.now();
  return { id: uid('c'), title, titleSet: false, createdAt: t, updatedAt: t, pinned: false, messages };
}

export async function save(session) {
  if (!session.messages.length) return session; // 空对话不落盘
  if (!session.titleSet) {
    const first = session.messages.find((m) => m.role === 'user');
    if (first) session.title = autoTitle(first.content);
  }
  await sessions.put({ ...session, messages: session.messages.slice(-400) });
  return session;
}

export const get = (id) => sessions.get(id);

export async function list() {
  return (await sessions.all()).sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
}

export async function rename(id, title) {
  const s = await sessions.get(id);
  if (!s) return null;
  const next = { ...s, title: String(title).trim().slice(0, 60) || s.title, titleSet: true };
  await sessions.put(next);
  return next;
}

export async function setPinned(id, pinned) {
  const s = await sessions.get(id);
  if (s) await sessions.put({ ...s, pinned });
}

export const remove = (id) => sessions.delete(id);

/** 按标题和内容搜索；返回带命中片段的会话 */
export async function search(query) {
  const all = await list();
  const q = String(query || '').trim();
  if (!q) return all;
  const docs = all.map((s) => ({ id: s.id, text: `${s.title}\n${s.messages.map((m) => m.content).join('\n')}` }));
  const hits = buildIndex(docs)(q, 30);
  const byId = new Map(all.map((s) => [s.id, s]));
  const lower = q.toLowerCase();
  return hits.map((h) => {
    const s = byId.get(h.id);
    const m = s.messages.find((x) => x.content.toLowerCase().includes(lower)) ?? s.messages.find((x) => x.role === 'user');
    const i = m ? Math.max(0, m.content.toLowerCase().indexOf(lower)) : 0;
    return { ...s, snippet: m ? m.content.slice(Math.max(0, i - 16), i + 40) : '' };
  });
}

/**
 * 跨对话检索：在其他对话的原话里找和问题相关的片段（一问一答为一个单位）
 * @returns {Promise<Array<{ sessionId, title, ts, user, reply, score }>>}
 */
export async function searchMessages(query, { exclude = null, k = 3, minScore = 2 } = {}) {
  const all = (await sessions.all()).filter((s) => s.id !== exclude);
  const units = [];
  for (const s of all) {
    s.messages.forEach((m, i) => {
      if (m.role !== 'user') return;
      const reply = s.messages[i + 1]?.role === 'assistant' ? s.messages[i + 1].content : '';
      units.push({ id: `${s.id}#${i}`, sessionId: s.id, title: s.title, ts: m.ts ?? s.updatedAt, user: m.content, reply });
    });
  }
  if (!units.length || !String(query || '').trim()) return [];
  const byId = new Map(units.map((u) => [u.id, u]));
  const hits = buildIndex(units.map((u) => ({ id: u.id, text: `${u.user}\n${u.reply.slice(0, 800)}` })))(query, k * 3);
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (h.score < minScore) continue;
    const u = byId.get(h.id);
    if (seen.has(u.sessionId)) continue; // 每段对话最多取一处，覆盖更多对话
    seen.add(u.sessionId);
    out.push({ ...u, score: h.score });
    if (out.length >= k) break;
  }
  return out;
}

/** 最近的几段其他对话 */
export async function recent({ exclude = null, k = 3 } = {}) {
  return (await sessions.all()).filter((s) => s.id !== exclude && s.messages.length)
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, k);
}

/** 导出为 Markdown */
export function toMarkdown(s) {
  const when = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
  return [`# ${s.title}`, '', `> ${when(s.createdAt)} · ${s.messages.length} 条消息`, '',
    ...s.messages.flatMap((m) => [`### ${m.role === 'user' ? '你' : '未央'} · ${when(m.ts)}`, '', m.content, ''])].join('\n');
}

/** 旧版只保存一条对话流（localStorage）：迁移成一个会话 */
export async function migrateLegacy(entries) {
  if (!entries?.length || (await sessions.all()).length) return null;
  const s = create({ messages: entries.map((e) => ({ role: e.role, content: e.content, ts: e.ts })) });
  s.createdAt = entries[0].ts;
  s.updatedAt = entries.at(-1).ts;
  await save(s);
  return s;
}
