/**
 * 对话记忆：带时间戳的消息列表，可选择持久化到 localStorage，按天分组成时间线。
 */
const KEY = 'jarvis.memory.v1';
export const MAX_ENTRIES = 200;

export function loadMemory(storage) {
  try {
    const arr = JSON.parse(storage?.getItem(KEY) || '[]');
    return Array.isArray(arr)
      ? arr.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && Number.isFinite(m.ts))
      : [];
  } catch {
    return [];
  }
}

export function saveMemory(entries, storage) {
  try {
    storage?.setItem(KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch { /* 存储满：本次会话内仍可用 */ }
}

export function clearMemory(storage) {
  try { storage?.removeItem(KEY); } catch { /* ignore */ }
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 按天分组（新的在前），标签为 今天 / 昨天 / M月D日 */
export function groupByDay(entries, now = Date.now()) {
  const today = dayKey(now);
  const yesterday = dayKey(now - 86400000);
  const groups = new Map();
  for (const e of entries) {
    const k = dayKey(e.ts);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([k, items]) => {
      const [, m, d] = k.split('-').map(Number);
      return { key: k, label: k === today ? '今天' : k === yesterday ? '昨天' : `${m}月${d}日`, items };
    });
}
