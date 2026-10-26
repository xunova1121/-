import { reviewPeriod } from './periodReview.js';
import { collection, uid } from './store.js';
import { mediaReceipt } from './actionDelivery.js';
import * as workspace from './workspace.js';

const kv = collection('kv');
const sessions = collection('sessions');
const INDEX = 'work-ledger-v1';
export const WORK_RECORD_LIMIT = 4096;
const TOOLS =
  /^(sing_song|generate_image|generate_video|create_diagram|export_diagram|create_document|write_long_document|write_professional_document|edit_office_document|edit_spreadsheet)$/;
const scopes = new WeakMap();
let tail = Promise.resolve();
let pending = 0;

function serial(job) {
  if (pending >= 32) throw Object.assign(new Error('成果索引繁忙'), { code: 'WORK_LEDGER_BUSY', kind: 'storage' });
  pending++;
  const next = tail.catch(() => {}).then(job);
  tail = next;
  return next.finally(() => {
    pending--;
  });
}
async function recordId(scope, callId, files) {
  if (!scope || typeof scope !== 'object') return uid('wr');
  if (!scopes.has(scope)) scopes.set(scope, uid('turn'));
  const bytes = new TextEncoder().encode(JSON.stringify(files));
  let digest;
  if (globalThis.crypto?.subtle) {
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    digest = [...hash.slice(0, 8)].map((value) => value.toString(16).padStart(2, '0')).join('');
  } else {
    let hash = 2166136261;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
    digest = (hash >>> 0).toString(16);
  }
  return `${scopes.get(scope)}:${String(callId).slice(0, 100)}:${digest}`;
}
const keyOf = (id) => 'work-record:' + id;

/** 仅存精简生成回执，不存歌词、提示、工具原文或密钥；保留4096条并明确覆盖缺口。 */
export async function recordWorkAttempt({ tool, args = {}, output = '', ok, sessionId, scope, callId }) {
  if (!sessionId || !TOOLS.test(tool)) return null;
  const session = await sessions.get(sessionId);
  if (!session || session.evaluationId) return null;
  const media = mediaReceipt(tool, ok, output);
  const candidates = [
    ...String(output)
      .slice(0, 12000)
      .matchAll(/[^\s"'<>（），。]+\.(?:docx|pptx|xlsx|svg)\b/gi)
  ]
    .slice(0, 12)
    .map((match) => match[0]);
  const paths = [...new Set([...(media?.files || []), ...(typeof args.path === 'string' ? [args.path] : []), ...candidates])];
  const files = [];
  for (const path of paths.slice(0, 12)) {
    if (path.length <= 400 && (await workspace.exists(path))) files.push(path);
  }
  const generationStatus = !ok ? 'failed' : files.length && (!media || media.state === 'completed') ? 'success' : 'unverified';
  const record = {
    id: await recordId(scope, callId, files),
    sessionId: String(sessionId).slice(0, 200),
    tool,
    kind:
      tool === 'sing_song'
        ? 'song'
        : tool === 'generate_image'
          ? 'image'
          : tool === 'generate_video'
            ? 'video'
            : /^(create_diagram|export_diagram)$/.test(tool)
              ? 'diagram'
              : 'document',
    title: String(args.title || files[0]?.split('/').pop() || tool).slice(0, 160),
    files,
    status: generationStatus,
    createdAt: Date.now()
  };
  return serial(async () => {
    if (!(await sessions.get(sessionId))) return null;
    const previous = await kv.get(keyOf(record.id));
    if (previous?.status === 'success') return { ...previous, id: previous.generationId };
    const index = (await kv.get(INDEX)) || { id: INDEX, since: Date.now(), ids: [], truncated: false };
    await kv.put({ ...record, id: keyOf(record.id), generationId: record.id });
    const ids = [...index.ids.filter((id) => id !== record.id), record.id];
    const removed = ids.splice(0, Math.max(0, ids.length - WORK_RECORD_LIMIT));
    await kv.put({ ...index, ids, truncated: index.truncated || removed.length > 0 });
    for (const id of removed) await kv.delete(keyOf(id));
    return record;
  });
}

export async function listWorkRecords({
  kind = '',
  from = 0,
  to = Infinity,
  offset = 0,
  limit = 50,
  status: recordStatus = 'success',
  format = '',
  path = '',
  signal
} = {}) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const index = await kv.get(INDEX);
  const selected = [];
  let total = 0;
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const size = Math.min(200, Math.max(1, Math.floor(Number(limit) || 50)));
  const ids = (Array.isArray(index?.ids) ? index.ids : [])
    .slice(-WORK_RECORD_LIMIT)
    .filter((id) => typeof id === 'string' && id.length <= 200)
    .reverse();
  for (let position = 0; position < ids.length; position += 32) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = await Promise.all(ids.slice(position, position + 32).map((id) => kv.get(keyOf(id))));
    for (const record of batch) {
      if (
        !record ||
        (path && !record.files.includes(path)) ||
        (kind && record.kind !== kind) ||
        (recordStatus && record.status !== recordStatus) ||
        record.createdAt < from ||
        record.createdAt >= to ||
        (format && !record.files.some((path) => path.toLowerCase().endsWith('.' + format)))
      )
        continue;
      if (total >= start && selected.length < size) selected.push({ ...record, id: record.generationId });
      total++;
    }
  }
  return {
    total,
    items: selected,
    offset: start,
    more: start + selected.length < total,
    recordingSince: index?.since || null,
    completeHistory: false,
    truncated: Boolean(index?.truncated),
    note: '仅统计成功且当时文件存在的生成回执，按生成ID去重；旧对话、删除记录及超出保留范围的操作不保证完整，历史总数只能说至少。'
  };
}
export async function renameWorkRecord(id, title) {
  return serial(async () => {
    const record = await kv.get(keyOf(id));
    if (!record) throw Object.assign(new Error('生成记录不存在'), { code: 'WORK_RECORD_MISSING', status: 404, kind: 'storage' });
    await kv.put({ ...record, displayTitle: String(title).trim().slice(0, 160), correctedAt: Date.now() });
  });
}
export async function removeWorkRecord(id) {
  return serial(async () => {
    const index = await kv.get(INDEX);
    if (!index) return;
    await kv.put({ ...index, ids: index.ids.filter((value) => value !== id), truncated: true });
    await kv.delete(keyOf(id));
  });
}
export async function dropSessionWork(sessionId) {
  return serial(async () => {
    const index = await kv.get(INDEX);
    if (!index) return;
    const removed = new Set();
    for (let offset = 0; offset < index.ids.length; offset += 32) {
      const ids = index.ids.slice(offset, offset + 32);
      const rows = await Promise.all(ids.map((id) => kv.get(keyOf(id))));
      rows.forEach((row, position) => {
        if (row?.sessionId === sessionId) removed.add(ids[position]);
      });
    }
    await kv.put({ ...index, ids: index.ids.filter((id) => !removed.has(id)), truncated: index.truncated || removed.size > 0 });
    for (const id of removed) await kv.delete(keyOf(id));
  });
}
export function workQuestion(text = '') {
  if (/(?:要|准备|打算|计划).{0,8}(?:做|生成|唱|写)/.test(text)) return '';
  if (!/一共|总共|多少首|几首歌|列全|全部.*(?:做|生成)|做过哪些|生成过哪些/.test(text)) return '';
  return /歌|音乐/.test(text)
    ? 'song'
    : /架构图|流程图/.test(text)
      ? 'diagram'
      : /图片|画过/.test(text)
        ? 'image'
        : /视频/.test(text)
          ? 'video'
          : /文档|Word|PPT|Excel/i.test(text)
            ? 'document'
            : /文件/.test(text)
              ? 'all'
              : '';
}
export async function workHistoryBlock(text, sessionId, { signal } = {}) {
  const kind = workQuestion(text);
  if (!kind || (sessionId && (await sessions.get(sessionId))?.evaluationId)) return '';
  const period = reviewPeriod('做过' + text);
  const format = /Excel/i.test(text) ? 'xlsx' : /PPT/i.test(text) ? 'pptx' : /Word/i.test(text) ? 'docx' : '';
  const result = await listWorkRecords({ kind: kind === 'all' ? '' : kind, format, ...(period && { from: period.from, to: period.to }), signal, limit: 12 });
  while (JSON.stringify(result).length > 10000 && result.items.length) {
    result.items.pop();
    result.more = true;
  }
  return (
    '\n## 程序核对的成果生成记录\n' +
    JSON.stringify(result) +
    '\n摘要不是完整清单。仅按上述成功记录确认至少数量，不补猜名称；有more需用list_work_records继续翻页，每条可按sessionId读回原对话。'
  );
}
export function createWorkRecordsTool() {
  return {
    name: 'list_work_records',
    description: '查成功生成的歌曲/图片/架构图/文档操作记录，按生成ID去重，用于总共多少、列全做过哪些；分页含来源对话ID。历史缺口只能回答至少，不从摘要补猜。',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['song', 'image', 'video', 'diagram', 'document'] },
        format: { type: 'string', enum: ['docx', 'pptx', 'xlsx'] },
        from: { type: 'number', minimum: 0 },
        to: { type: 'number', minimum: 0 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50 }
      },
      additionalProperties: false
    },
    run: async (args, { signal } = {}) => JSON.stringify(await listWorkRecords({ ...args, signal }))
  };
}
