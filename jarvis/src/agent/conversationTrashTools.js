/**
 * 说一句话删某段时间的对话（用户 2026-10-30）：
 *   1. delete_conversations 先只列清单（标题、时间、几条消息），不动任何东西；
 *   2. 用户在下一句明确说“确认删除”之类，再用 confirm:true 调用，才删——只删刚才列给用户看过的那几段；
 *   3. 删的进回收站，留 TRASH_DAYS 天能恢复（restore_conversations / list_deleted_conversations）。
 * 当前这段对话不删；评测会话里这些工具被拦（见 server/evaluation.mjs）。
 */
import * as sessions from './sessions.js';

const BJ = 8 * 3600000;
const LIST_TTL = 30 * 60000;
const MAX = 50;
/** “2026-10-25” 或 “2026-10-25 14:30”（北京时间）→ 毫秒；end 时日期取当天最后一毫秒 */
export function parseBeijing(text, { end = false } = {}) {
  const m = String(text || '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  if (h === undefined || Number.isNaN(h)) return Date.UTC(y, mo - 1, d) - BJ + (end ? 86400000 - 1 : 0);
  return Date.UTC(y, mo - 1, d, h, mi) - BJ + (end ? 59999 : 0);
}
const when = (t) => new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** 用户这句话是不是在确认删除（只认明确的说法，“嗯”“好”不算） */
// 刚问完“确认删除这 N 段吗？”，只回一个“确认 / 确定 / 删 / 是的”也算（用户 2026-10-30 实测：回“确认”被拒）
export const CONFIRM_DELETE = /确认删除|确定删除|确认删|确定删|删吧|删掉吧|全删了|可以删(?:了|除)?|就删这些|直接删|^\s*(?:确认|确定|删|删除|删了|删掉|是的?|对)[。.!！吧啊]*\s*$/;

/**
 * 对话 → { key, ids, at }：上一次列给用户看的清单。
 * 放在模块里而不是每套工具里：服务器每条消息都新建一套工具，放在里面下一句“确认”就找不到清单了（用户 2026-10-30 实测：确认三次都被拒）
 */
const listed = new Map();

export function createConversationTrashTools() {
  const S = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const range = (from, to) => {
    const a = parseBeijing(from), b = parseBeijing(to || from, { end: true });
    if (a === null || b === null) throw Object.assign(new Error('时间写成 YYYY-MM-DD 或 YYYY-MM-DD HH:mm（北京时间）'), { code: 'TRASH_INPUT', kind: 'input' });
    if (b < a) throw Object.assign(new Error('结束时间早于开始时间'), { code: 'TRASH_INPUT', kind: 'input' });
    return [a, b];
  };
  return [
    {
      name: 'delete_conversations',
      description: '按时间段（可加关键词）删除用户的历史对话，删到回收站，7 天内能恢复。两步：先不带 confirm 调用，只列出要删的对话给用户看，并问“确认删除这 N 段吗？”；用户下一句明确说“确认删除”后，用同样的时间段和关键词、confirm:true 再调用才会删。用户没明确确认就不要带 confirm。当前这段对话不会删。',
      input_schema: S({
        from: { type: 'string', description: '开始，YYYY-MM-DD 或 YYYY-MM-DD HH:mm（北京时间）' },
        to: { type: 'string', description: '结束（含），同上；只删一天就和 from 一样' },
        keyword: { type: 'string', description: '只删标题或内容里带这个词的（可选）' },
        confirm: { type: 'boolean', description: '用户已明确确认删除时填 true' }
      }, ['from']),
      run: async ({ from, to, keyword = '', confirm = false }, execution = {}) => {
        const [a, b] = range(from, to);
        const key = `${a}|${b}|${keyword}`;
        const found = (await sessions.findByTime({ from: a, to: b, query: keyword, exclude: execution.sessionId ?? null })).slice(0, MAX);
        const owner = execution.sessionId || 'local';
        if (!confirm) {
          if (!found.length) return `${from}${to && to !== from ? ` 到 ${to}` : ''}${keyword ? `、带“${keyword}”` : ''}没有找到对话，没有删任何东西。`;
          listed.set(owner, { key, ids: found.map((s) => s.id), at: Date.now() });
          return `找到 ${found.length} 段对话（还没删）：\n${found.map((s, i) => { const sp = sessions.sessionSpan(s); return `${i + 1}. 「${s.title}」 ${when(sp.from)}～${when(sp.to)}，${s.messages.length} 条${s.pinned ? '（已钉住）' : ''}`; }).join('\n')}\n把这份清单给用户看，问“确认删除这 ${found.length} 段吗？删了先放回收站，7 天内能恢复。”用户明确说确认后，再用同样的时间段${keyword ? '和关键词' : ''}、confirm:true 调用。`;
        }
        const prior = listed.get(owner);
        if (!prior || prior.key !== key || Date.now() - prior.at > LIST_TTL) return '还没把这个时间段的清单给用户看过（或已过 30 分钟）：先不带 confirm 调用一次，列清单让用户确认。没有删任何东西。';
        if (!CONFIRM_DELETE.test(String(execution.rawRequestText || ''))) return '用户这句话没有明确确认删除（要说“确认删除”之类）。没有删任何东西；请先问用户是否确认。';
        // 只删刚才列给用户看过、现在还在的
        const ids = found.map((s) => s.id).filter((id) => prior.ids.includes(id));
        const done = [];
        for (const id of ids) { const r = await sessions.trash(id); if (r) done.push(r.title); }
        listed.delete(owner);
        return done.length ? `已删除 ${done.length} 段对话，放在回收站，7 天内能恢复（说“恢复刚才删的对话”或在对话列表的回收站里点恢复）：${done.map((t) => `「${t}」`).join('、')}` : '清单里的对话都已经不在了，没有删任何东西。';
      }
    },
    {
      name: 'list_deleted_conversations',
      description: '看回收站里删掉的对话（7 天内能恢复）。',
      input_schema: S({}),
      run: async () => {
        const items = await sessions.listTrash();
        return items.length ? items.map((x) => `- 「${x.title}」（id ${x.id}）${when(x.from)}～${when(x.to)}，${x.count} 条；${when(x.trashedAt)} 删的，${when(x.expiresAt)} 后彻底删除`).join('\n') : '回收站是空的。';
      }
    },
    {
      name: 'restore_conversations',
      description: '把回收站里的对话恢复回对话列表。ids 填 list_deleted_conversations 里的 id；用户说“恢复刚才删的全部”时 all 填 true。',
      input_schema: S({ ids: { type: 'array', items: { type: 'string' }, maxItems: 50 }, all: { type: 'boolean' } }),
      run: async ({ ids = [], all = false }) => {
        const pool = await sessions.listTrash();
        const pick = all ? pool : pool.filter((x) => ids.includes(x.id));
        if (!pick.length) return '回收站里没有要恢复的对话（可能已超过 7 天被彻底删除）。';
        const back = [];
        for (const x of pick) { const r = await sessions.restore(x.id); if (r) back.push(r.title); }
        return `已恢复 ${back.length} 段对话：${back.map((t) => `「${t}」`).join('、')}`;
      }
    }
  ];
}
