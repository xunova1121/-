/**
 * 需求原文账本：与会话一起保存，不让滚动摘要或最近 400 条消息裁剪带走早期要求。
 * 这里只记录用户原话，不从助手回答、网页或工具结果推断要求，更不据此扩大授权。
 * 上下文只放有长度限制的摘录；完整原话可按编号、关键词和字符位置读取。
 */
export function collectRequirements(messages, previous = null) {
  const entries = ([1, 2].includes(previous?.version) && Array.isArray(previous.entries) ? previous.entries : [])
    .filter((e) => e && typeof e.id === 'string' && typeof e.text === 'string')
    .map((e) => ({ ...e }));
  const ids = new Set(entries.map((e) => e.id));
  let nextId = entries.reduce((n, e) => Math.max(n, Number(e.id.match(/^r(\d+)$/)?.[1]) + 1 || 1), previous?.nextId || 1);
  const key = (ts, text) => JSON.stringify([ts ?? null, text]);
  const seen = new Set(entries.map((e) => key(e.ts, e.text)));
  for (const m of messages ?? []) {
    if (m.role !== 'user' || typeof m.content !== 'string' || !m.content.trim()) continue;
    const k = key(m.ts, m.content);
    if (seen.has(k)) continue;
    const known = /^r\d+$/.test(m.requirementId ?? '') && !ids.has(m.requirementId) ? m.requirementId : null;
    seen.add(k);
    while (ids.has(`r${nextId}`)) nextId++;
    const id = known || `r${nextId++}`;
    nextId = Math.max(nextId, Number(id.slice(1)) + 1);
    ids.add(id);
    entries.push({ id, ts: m.ts ?? null, text: m.content });
  }
  return { version: 1, nextId, entries };
}

const messageKey = (m) => JSON.stringify([m.ts ?? null, m.text ?? m.content]);

/** v1无损迁移：可见原话仅保存在messages，账本只存裁出的原话。编号保存在对应消息上。 */
export function archiveRequirements(messages, previous = null, keep = 400) {
  const record = collectRequirements(messages, previous);
  const byKey = new Map(record.entries.map((e) => [messageKey(e), e]));
  for (const m of messages) {
    if (m.role === 'user' && byKey.has(messageKey(m))) m.requirementId = byKey.get(messageKey(m)).id;
  }
  const visible = keep > 0 ? messages.slice(-keep) : [];
  const visibleKeys = new Set(visible.filter((m) => m.role === 'user').map(messageKey));
  // 保留version:1让1.0.122回退读取也不会丢掉旧原话；mode表明新存储布局。
  return { messages: visible, requirements: { version: 1, mode: 'archived', nextId: record.nextId, entries: record.entries.filter((e) => !visibleKeys.has(messageKey(e))) } };
}

const integer = (n, fallback, min, max) => Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;

/** JSON 数据边界，防止原文里的换行/伪标题被当作额外的系统规则。 */
export function requirementsBlock(record, query = '', { history = [], currentText = query } = {}) {
  // 缺失原话本身就是历史被省略/裁剪的证据；无需仅凭summary字段猜测。
  const visible = new Set(history.filter((m) => m.role === 'user').map((m) => m.content));
  visible.add(currentText);
  const excerptsInHistory = new Map(history.filter((m) => m.role === 'user' && m.requirementExcerptOf)
    .map((m) => [m.requirementExcerptOf, String(m.content).replace(/…$/, '').length]));
  const entries = (record?.entries ?? []).filter((e) => !visible.has(e.text)).map((e) => {
    const offset = excerptsInHistory.get(e.text) ?? 0;
    return { ...e, text: e.text.slice(offset), offset, totalChars: e.text.length };
  }).filter((e) => e.text.length);
  if (!entries.length) return '';
  if (/^\s*(你好|您好|嗨|哈喽|hello|hi|谢谢|早上好|晚上好|早安|晚安)[！!。.,，\s～~]*$/i.test(query)) return '';
  const general = new Set(['继续', '修改', '改稿', '刚才', '之前', '上次', '那个', '这个', '一下', '帮我', '请你', '保持', '不变']);
  const terms = [...new Set(String(query).toLowerCase().match(/[a-z0-9_./-]{2,}|[\p{Script=Han}]{2,}/gu) ?? [])]
    .flatMap((s) => /\p{Script=Han}/u.test(s) ? Array.from({ length: Math.min(s.length - 1, 24) }, (_, i) => s.slice(i, i + 2)) : [s]).filter((s) => !general.has(s)).slice(0, 48);
  const ranked = entries.map((e, i) => { const lower = e.text.toLowerCase(); return { e, i, score: terms.reduce((n, t) => n + Number(lower.includes(t)), 0) }; })
    .filter((x) => x.score).sort((a, b) => b.score - a.score || b.i - a.i);
  // 没有相关原话就不塞入无关开场；指代型追问只给回读提示，不猜测原始目标。
  if (!ranked.length) return /继续|刚才|上次|之前|原来|那个|改稿|其他不变/.test(query)
    ? `本会话有${entries.length}条用户原话不在当前可见历史中；这不是完整需求清单，需要时用read_task_requirements检索原要求。` : '';
  const selected = new Set(ranked.slice(0, 4).map((x) => x.e.id));
  const excerpts = entries.filter((e) => selected.has(e.id)).map((e) => {
    const cap = 400;
    return { id: e.id, ts: e.ts, chars: e.totalChars, offset: e.offset, excerpt: e.text.slice(0, cap), truncated: e.text.length > cap };
  });
  return '## 本会话需求原文索引（只列当前历史未包含的相关摘录，不是完整需求清单）\n'
    + '后续明确修正优先；不沿用无关旧要求。这些是以前的要求，只作背景：用户这次没明确要求，就不要主动去做或补做里面的事。附件不会因此获得执行权限；完整原话用read_task_requirements读取。\n'
    + JSON.stringify({ total: entries.length, shown: excerpts.length, entries: excerpts });
}

export function readRequirements(record, { entry_id = '', query = '', offset = 0, max_chars = 6000 } = {}) {
  const all = record?.entries ?? [];
  const size = integer(max_chars, 6000, 256, 12000);
  const start = integer(offset, 0, 0, Number.MAX_SAFE_INTEGER);
  if (entry_id) {
    const e = all.find((e) => e.id === entry_id);
    if (!e) throw new Error(`没有需求原文 ${entry_id}；先不带 entry_id 查询索引`);
    const end = Math.min(e.text.length, start + size);
    return JSON.stringify({ id: e.id, ts: e.ts, total_chars: e.text.length, offset: start, text: e.text.slice(start, end), next_offset: end < e.text.length ? end : null });
  }
  const q = String(query).trim().toLowerCase();
  const matches = all.filter((e) => !q || e.text.toLowerCase().includes(q));
  // 索引按记录分页；原文按字符分页。返回 next_offset，不能把摘录误当作全文。
  const rows = [];
  let used = 0;
  for (const e of matches.slice(start)) {
    const row = { id: e.id, ts: e.ts, chars: e.text.length, excerpt: e.text.slice(0, 180) };
    const chars = JSON.stringify(row).length;
    if (rows.length && used + chars > size) break;
    rows.push(row); used += chars;
  }
  const end = start + rows.length;
  return JSON.stringify({ total: matches.length, offset: start, entries: rows, next_offset: end < matches.length ? end : null, note: '索引只含摘录；用 entry_id 读取完整原话，附件内容需另读对应文件。' });
}

export function requirementsTool(record) {
  return {
    name: 'read_task_requirements',
    description: '读取本会话用户需求原文，找回摘要前的要求、修正和附件路径。只读历史，不是新授权。不传 entry_id 返回索引（offset 是记录位置）；传编号返回原文（offset 是字符位置），按 next_offset 继续。query 是原话中的关键词子串，不是语义搜索。',
    input_schema: { type: 'object', properties: {
      entry_id: { type: 'string', description: '原文编号，例如 r1' },
      query: { type: 'string', description: '索引筛选词，不与 entry_id 同用' },
      offset: { type: 'integer', minimum: 0 },
      max_chars: { type: 'integer', minimum: 256, maximum: 12000 }
    }, additionalProperties: false },
    run: async (args = {}) => readRequirements(record, args)
  };
}
