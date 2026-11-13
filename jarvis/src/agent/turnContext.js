/**
 * 一轮任务中途的上下文瘦身：步骤多了，前面工具返回的大段原文（网页、文件、搜索结果、截图）会把上下文撑满，
 * 模型变慢、变笨，甚至超出上限报错。超过预算时，把较早的工具结果缩成开头一段 + 说明，最近几条原样保留；
 * 较早的截图只留最近两张。需要原文时模型可以再调用一次工具。只改这一轮的工作副本，不影响保存的对话。
 */
export const TURN_BUDGET = 60_000; // 工具结果合计超过这么多字才瘦身
export const KEEP_RECENT = 6; // 最近几条工具结果原样保留
export const SHORT = 800; // 较早的结果保留开头这么多字

export function compactToolResults(convo, { budget = TURN_BUDGET, keep = KEEP_RECENT, short = SHORT, archive = null, preserveEvidence = false, query = '' } = {}) {
  const tools = convo.filter((m) => m.role === 'tool');
  const total = tools.reduce((n, m) => n + String(m.content ?? '').length, 0);
  let saved = 0;
  if (total > budget) {
    for (const m of keep > 0 ? tools.slice(0, -keep) : tools) {
      const text = String(m.content ?? '');
      if (m.compacted || text.length <= short * 1.5) continue;
      const id = ['read_tool_result', 'phone_action'].includes(m.name) ? null : archive?.remember(m);
      const receipt = preserveEvidence ? receiptSummary(text, short, query) : text.slice(0, short);
      m.content = `${receipt}\n…（这是较早的工具结果，为节省上下文已缩短，原文共 ${text.length} 字；${id ? `本轮原文编号 ${id}，用 read_tool_result 分段读取；若已过期需重读来源` : '还需要细节就再调用一次工具'}；省略部分不代表不存在，核对数字、来源和失败原因须回读）`;
      m.compacted = true;
      saved += text.length - m.content.length;
    }
  }
  // 截图、图片很占上下文：只留最近两条带图的工具结果
  const withImages = tools.filter((m) => m.images?.length);
  for (const m of withImages.slice(0, -2)) { delete m.images; m.content = `${m.content}\n（较早的截图已省略）`; }
  return { total, saved };
}

/** 结构化回执优先保留状态、来源、时间、单位；其余正文仍以可回读原件为准。 */
function receiptSummary(text, short, query) {
  const pageHeader = /^【网页读取回执】([^\n]+)\n/.exec(text);
  if (pageHeader) {
    try {
      const value = JSON.parse(pageHeader[1]);
      const receipt = Array.isArray(value.pages) ? { read_mode: value.read_mode, pages: value.pages.map(page => ({ url: page.url, read: page.read, ...(page.evidenceId && { evidenceId: page.evidenceId }), ...(page.code && { code: page.code }), ...(page.error && { error: String(page.error).slice(0, 160) }) })) } : { url: value.url, ...(Object.hasOwn(value, 'read') && { read: value.read }), ...(value.code && { code: value.code }), ...(value.evidenceId && { evidenceId: value.evidenceId }) };
      const header = '【网页读取回执】' + JSON.stringify(receipt) + '\n';
      // 长URL是来源标识，不能为满足字数把URL截成不可用地址；此时保留完整来源并回读正文。
      return header + relevantExcerpt(text.slice(pageHeader[0].length), Math.max(0, short - header.length), query);
    } catch { /* 损坏回执不补造成成功来源。 */ }
  }
  try {
    const value = JSON.parse(text);
    const fields = ['ok', 'status', 'state', 'code', 'error', 'verified', 'source', 'sources', 'url', 'time', 'timestamp', 'date', 'unit', 'value', 'price', 'path', 'files', 'outcome'];
    const picked = {};
    for (const key of fields) if (value && Object.hasOwn(value, key)) {
      const field = JSON.stringify(value[key]);
      picked[key] = field.length <= 350 ? value[key] : '[字段较长，需回读原文]';
    }
    const evidence = JSON.stringify(picked);
    if (Object.keys(picked).length && evidence.length <= short) return `关键回执字段：${evidence}\n正文节选：${relevantExcerpt(text, Math.max(0, short - evidence.length), query)}`;
  } catch { /* 普通文本没有结构化回执。 */ }
  if (query) return relevantExcerpt(text, short, query);
  const half = Math.floor(short / 2);
  return `${text.slice(0, half)}\n[中段省略，须按编号回读]\n${text.slice(-half)}`;
}

/** 不改写事实，只从原件选连续片段；省略处明确标记，引用细节仍可按编号回读。 */
function relevantExcerpt(text, limit, query = '') {
  if (text.length <= limit) return text;
  const subject = String(query).slice(0, 300).replace(/^(?:(?:请|帮我|查询|搜索|查一下|介绍一下|看一下)[，,\s]*)+/, '').replace(/(?:简介|的情况|最新信息|介绍)[？?。\s]*$/, '');
  const terms = [...new Set(subject.match(/[A-Za-z0-9._-]{2,}|[\u4e00-\u9fff]{2,24}/g) || [])].slice(0, 16);
  if (!terms.length || limit < 300) return text.slice(0, limit);
  const headSize = Math.min(350, Math.floor(limit / 3)), tailSize = Math.min(150, Math.floor(limit / 5));
  const positions = [];
  for (const term of terms) {
    const index = text.indexOf(term);
    if (index > headSize && index < text.length - tailSize) positions.push(index);
  }
  const windows = [...new Set(positions)].sort((a, b) => a - b).slice(0, 3);
  const marker = '\n[原文片段省略，细节需回读]\n';
  if (!windows.length) return text.slice(0, Math.max(0, limit - tailSize - marker.length)) + marker + text.slice(-tailSize);
  const size = Math.max(0, Math.floor((limit - headSize - tailSize - marker.length * (windows.length + 1)) / windows.length));
  const middle = windows.map(index => text.slice(Math.max(headSize, index - Math.floor(size / 3)), Math.max(headSize, index - Math.floor(size / 3)) + size));
  return [text.slice(0, headSize), ...middle, text.slice(-tailSize)].join(marker).slice(0, limit);
}

/** 本轮原文缓冲：最多约 512KB UTF-16 文本，不持久化、不复制图片，结束后随本轮释放。 */
export function createTurnArchive({ maxChars = 256_000 } = {}) {
  const items = new Map();
  let count = 0, chars = 0;
  return {
    remember(m) {
      const text = String(m.content ?? '');
      if (text.length > maxChars) return null;
      // 请求副本每轮投影时复用原编号，避免重复归档挤掉模型正在回读的证据。
      for (const [id, item] of items) if (item.text === text && item.name === (m.name ?? '') && item.toolCallId === (m.toolCallId ?? '') && item.isError === Boolean(m.isError)) return id;
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

