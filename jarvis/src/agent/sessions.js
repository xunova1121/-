import { dropSessionWork } from './workLedger.js';
/**
 * 多会话：每段对话单独保存（本机 IndexedDB），可以新建、切换、搜索、重命名、导出、删除。
 * 消息只存文本（用户原话与未央的回答），工具调用记录只存名字，用于回看时显示“用了哪些工具”。
 */
import { collection, uid } from './store.js';
import { buildIndex } from './search.js';
import { archiveRequirements } from './taskRequirements.js';
import { evidence } from './evidenceStore.js';

const sessions = collection('sessions');
const TITLE_MAX = 24;
/** 服务器模式：对话存在自己的服务器上（见 core/serverClient.js 的 remoteSessions），读写都交给它 */
let remote = null;
export function useRemote(r) { remote = r; }

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
  if (remote) return remote.save(session);
  if (!session.messages.length) return session; // 空对话不落盘
  // 必须先保全原话，再裁剪消息；随会话导入/备份/删除，不另建隐蔽的长期记忆库。
  const archived = archiveRequirements(session.messages, session.requirements);
  session.requirements = archived.requirements;
  if (!session.titleSet) {
    const first = session.messages.find((m) => m.role === 'user');
    if (first) session.title = autoTitle(first.content);
  }
  await sessions.put({ ...session, messages: archived.messages });
  return session;
}

export const get = (id) => (remote ? remote.get(id) : sessions.get(id));
/** 服务器模式：手机 / 电脑上留的副本（马上能拿到，不等网络）；本机模式没有副本，返回 null */
export const cachedList = () => remote?.cachedList?.() ?? null;
export const cachedGet = (id) => remote?.cachedGet?.(id) ?? null;
/** 本机保存的全部对话（服务器模式下也读本机的，用来上传到服务器） */
export const listLocal = async () => (await sessions.all()).sort((a, b) => b.updatedAt - a.updatedAt);

export async function list() {
  if (remote) return remote.list();
  return (await sessions.all()).filter((s) => !s.evaluationId).sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
}

export async function rename(id, title) {
  if (remote) return remote.rename(id, title);
  const s = await sessions.get(id);
  if (!s) return null;
  const next = { ...s, title: String(title).trim().slice(0, 60) || s.title, titleSet: true };
  await sessions.put(next);
  return next;
}

export async function setPinned(id, pinned) {
  if (remote) return remote.setPinned(id, pinned);
  const s = await sessions.get(id);
  if (s) await sessions.put({ ...s, pinned });
}

export function remove(id) {
  evidence.drop(id).catch(() => {}); // 这段对话读过的网页证据一起删
  return remote ? remote.remove(id) : Promise.all([sessions.delete(id), dropSessionWork(id)]);
}

// ---------------------------------------------------------------- 回收站（用户 2026-10-30：说一句话删某段时间的对话，删的先留 7 天能找回）
// 放在已有的 kv 表里（不加新表：本机数据库版本不动）：目录一条 + 每段对话一条存档
const kv = collection('kv');
const TRASH_INDEX = 'session-trash';
const trashKey = (id) => 'session-trash:' + id;
export const TRASH_DAYS = 7;
const DAY = 86400000;
const trashIndex = async () => (await kv.get(TRASH_INDEX))?.items ?? [];

/** 一段对话的时间范围（第一条到最后一条消息；没有时间就用创建 / 更新时间） */
export function sessionSpan(s) {
  const ts = (s.messages || []).map((m) => m.ts).filter(Number.isFinite);
  return { from: ts.length ? Math.min(...ts) : s.createdAt ?? s.updatedAt, to: ts.length ? Math.max(...ts) : s.updatedAt ?? s.createdAt };
}

/**
 * 找某个时间段里说过话的对话（任何一条消息落在段内就算；评测会话、当前这段不算）
 * @param {{ from: number, to: number, query?: string, exclude?: string|null }} o 毫秒时间戳，含头含尾
 */
export async function findByTime({ from, to, query = '', exclude = null }) {
  const q = String(query || '').trim().toLowerCase();
  const all = remote ? await Promise.all((await remote.list()).map((x) => remote.get(x.id).catch(() => null))) : await sessions.all();
  return all
    .filter((s) => s && !s.evaluationId && s.id !== exclude)
    .filter((s) => {
      const ts = (s.messages || []).map((m) => m.ts).filter(Number.isFinite);
      const hits = ts.length ? ts.some((t) => t >= from && t <= to) : (s.updatedAt >= from && s.updatedAt <= to);
      if (!hits) return false;
      return !q || String(s.title || '').toLowerCase().includes(q) || (s.messages || []).some((m) => String(m.content || '').toLowerCase().includes(q));
    })
    .sort((a, b) => sessionSpan(a).from - sessionSpan(b).from);
}

/** 删到回收站：TRASH_DAYS 天内能恢复，之后才真正删掉（连同证据和成果记录） */
export async function trash(id, at = Date.now()) {
  if (remote?.trash) return remote.trash(id);
  const s = await sessions.get(id);
  if (!s) return null;
  await kv.put({ id: trashKey(id), session: s, trashedAt: at });
  const span = sessionSpan(s);
  await kv.put({ id: TRASH_INDEX, items: [...(await trashIndex()).filter((x) => x.id !== id), { id, title: s.title, count: s.messages.length, from: span.from, to: span.to, trashedAt: at }] });
  await sessions.delete(id);
  await purgeTrash(at);
  return { id, title: s.title };
}

/** 回收站里的对话（新删的在前） */
export async function listTrash(at = Date.now()) {
  if (remote?.listTrash) return remote.listTrash();
  await purgeTrash(at);
  return [...(await trashIndex())].sort((a, b) => b.trashedAt - a.trashedAt).map((x) => ({ ...x, expiresAt: x.trashedAt + TRASH_DAYS * DAY }));
}

/** 从回收站恢复 */
export async function restore(id) {
  if (remote?.restore) return remote.restore(id);
  const rec = await kv.get(trashKey(id));
  if (!rec?.session) return null;
  await sessions.put(rec.session);
  await kv.delete(trashKey(id));
  await kv.put({ id: TRASH_INDEX, items: (await trashIndex()).filter((x) => x.id !== id) });
  return { id, title: rec.session.title };
}

/** 超过 TRASH_DAYS 天的真正删掉 */
export async function purgeTrash(at = Date.now()) {
  if (remote) return;
  const items = await trashIndex();
  const old = items.filter((x) => at - x.trashedAt >= TRASH_DAYS * DAY);
  if (!old.length) return;
  for (const x of old) {
    await kv.delete(trashKey(x.id));
    evidence.drop(x.id).catch(() => {});
    await dropSessionWork(x.id).catch(() => {});
  }
  await kv.put({ id: TRASH_INDEX, items: items.filter((x) => !old.includes(x)) });
}

/** 按标题和内容搜索；返回带命中片段的会话 */
export async function search(query) {
  if (remote) return remote.search(query);
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
/** 按内容搜对话（标题或任何一条消息里有这个词，不分大小写），每段给一句带上下文的摘录。服务器模式下交给服务器搜 */
export async function searchContent(query, { max = 30 } = {}) {
  const q = String(query || '').trim().toLowerCase().slice(0, 50);
  if (!q) return [];
  if (remote) return remote.searchContent ? remote.searchContent(q) : [];
  const hits = [];
  for (const one of await list()) {
    if (one.evaluationId) continue;
    const m = one.messages.find((x) => String(x.content).toLowerCase().includes(q));
    if (!m && !String(one.title).toLowerCase().includes(q)) continue;
    const text = m ? String(m.content).replace(/\s+/g, ' ') : '';
    const i = text.toLowerCase().indexOf(q);
    const end = i + q.length + 36;
    hits.push({ id: one.id, title: one.title, updatedAt: one.updatedAt, snippet: m ? `${i > 24 ? '…' : ''}${text.slice(Math.max(0, i - 24), end)}${end < text.length ? '…' : ''}` : '' });
    if (hits.length >= max) break;
  }
  return hits;
}

/**
 * 按时间翻看用户说过的所有话（跨全部对话），用来回答“我问过哪些… / 所有…”这类要列全的问题。
 * searchMessages 只取最像的几条、每段对话一条，列不全；这里一条不漏、分页。
 * @param {{ query?: string, from?: number, to?: number, page?: number, pageSize?: number, current?: string, exclude?: string }} o
 *   query：空格隔开的几个词，含任意一个就算（不区分大小写）；from / to：时间范围（毫秒）
 * @returns {Promise<{ total: number, page: number, pages: number, items: Array<{ sessionId, title, ts, text }>, span: [number, number] | null }>}
 */
export async function listUserMessages({ query = '', from = 0, to = Infinity, page = 1, pageSize = 40, current = null, exclude = null } = {}) {
  const words = String(query).toLowerCase().split(/[\s,，、]+/).filter(Boolean);
  const all = [];
  for (const s of await sessions.all()) {
    if (s.evaluationId || s.id === exclude) continue;
    s.messages.forEach((m, i) => {
      if (m.role !== 'user') return;
      // 本段对话里正在问的这一句不算
      if (s.id === current && i >= s.messages.length - 1) return;
      const ts = m.ts ?? s.updatedAt;
      const text = String(m.content ?? '');
      if (ts < from || ts > to) return;
      if (words.length && !words.some((w) => text.toLowerCase().includes(w))) return;
      all.push({ sessionId: s.id, title: s.title, ts, text });
    });
  }
  all.sort((a, b) => a.ts - b.ts);
  const pages = Math.max(1, Math.ceil(all.length / pageSize));
  const p = Math.min(Math.max(1, Math.floor(page)), pages);
  return { total: all.length, page: p, pages, items: all.slice((p - 1) * pageSize, p * pageSize), span: all.length ? [all[0].ts, all.at(-1).ts] : null };
}

export async function searchMessages(query, { exclude = null, current = null, k = 3, minScore = 2 } = {}) {
  const all = (await sessions.all()).filter((s) => !s.evaluationId && s.id !== exclude);
  const units = [];
  for (const s of all) {
    s.messages.forEach((m, i) => {
      if (m.role !== 'user') return;
      const reply = s.messages[i + 1]?.role === 'assistant' ? s.messages[i + 1].content : '';
      // 本段对话里正在回答的这句问话不算结果：每段对话只取一处，它会把前面真正有用的原话挤掉
      if (s.id === current && !reply && i >= s.messages.length - 2) return;
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
  return (await sessions.all()).filter((s) => !s.evaluationId && s.id !== exclude && s.messages.length)
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
