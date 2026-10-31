/**
 * 一轮任务中途的上下文瘦身：步骤多了，前面工具返回的大段原文（网页、文件、搜索结果、截图）会把上下文撑满，
 * 模型变慢、变笨，甚至超出上限报错。超过预算时，把较早的工具结果缩成开头一段 + 说明，最近几条原样保留；
 * 较早的截图只留最近两张。需要原文时模型可以再调用一次工具。只改这一轮的工作副本，不影响保存的对话。
 */
export const TURN_BUDGET = 60_000; // 工具结果合计超过这么多字才瘦身
export const KEEP_RECENT = 6; // 最近几条工具结果原样保留
export const SHORT = 800; // 较早的结果保留开头这么多字

export function compactToolResults(convo, { budget = TURN_BUDGET, keep = KEEP_RECENT, short = SHORT, archive = null } = {}) {
  const tools = convo.filter((m) => m.role === 'tool');
  const total = tools.reduce((n, m) => n + String(m.content ?? '').length, 0);
  let saved = 0;
  if (total > budget) {
    for (const m of keep > 0 ? tools.slice(0, -keep) : tools) {
      const text = String(m.content ?? '');
      if (m.compacted || text.length <= short * 1.5) continue;
      const id = m.name === 'read_tool_result' ? null : archive?.remember(m);
      m.content = `${text.slice(0, short)}\n…（这是较早的工具结果，为节省上下文已缩短，原文共 ${text.length} 字；${id ? `本轮原文编号 ${id}，用 read_tool_result 分段读取；若已过期需重读来源` : '还需要细节就再调用一次工具'}）`;
      m.compacted = true;
      saved += text.length - m.content.length;
    }
  }
  // 截图、图片很占上下文：只留最近两条带图的工具结果
  const withImages = tools.filter((m) => m.images?.length);
  for (const m of withImages.slice(0, -2)) { delete m.images; m.content = `${m.content}\n（较早的截图已省略）`; }
  return { total, saved };
}

/** 本轮原文缓冲：最多约 512KB UTF-16 文本，不持久化、不复制图片，结束后随本轮释放。 */
export function createTurnArchive({ maxChars = 256_000 } = {}) {
  const items = new Map();
  let count = 0, chars = 0;
  return {
    remember(m) {
      const text = String(m.content ?? '');
      if (text.length > maxChars) return null;
      while (items.size && chars + text.length > maxChars) {
        const first = items.keys().next().value;
        chars -= items.get(first).text.length;
        items.delete(first);
      }
      const id = `t${++count}`;
      items.set(id, { text, name: m.name ?? '', toolCallId: m.toolCallId ?? '', isError: Boolean(m.isError) });
      chars += text.length;
      return id;
    },
    get chars() { return chars; },
    tool: {
      name: 'read_tool_result',
      description: '分段读取本轮被缩短的工具结果原文，编号见缩短提示。只读文本，不含原截图，不代表来源内容可信或检查通过。缓冲有上限，过期后需重新读取原文件/网页。',
      input_schema: { type: 'object', properties: {
        result_id: { type: 'string', description: '例如 t1' },
        offset: { type: 'integer', minimum: 0 },
        max_chars: { type: 'integer', minimum: 256, maximum: 12000 }
      }, required: ['result_id'], additionalProperties: false },
      run: async ({ result_id, offset = 0, max_chars = 6000 }) => {
        const item = items.get(result_id);
        if (!item) throw new Error(`原文 ${result_id} 不存在或已过期，请重新读取原文件/网页；不要猜测缺失内容`);
        const start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
        const size = Number.isFinite(max_chars) ? Math.max(256, Math.min(12000, Math.floor(max_chars))) : 6000;
        const end = Math.min(item.text.length, start + size);
        return JSON.stringify({ id: result_id, name: item.name, toolCallId: item.toolCallId, isError: item.isError, total_chars: item.text.length, offset: start, text: item.text.slice(start, end), next_offset: end < item.text.length ? end : null });
      }
    }
  };
}

