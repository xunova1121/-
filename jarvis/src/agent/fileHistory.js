/**
 * 工作区（浏览器内的虚拟工作区）的改动记录：覆盖、删除之前留一份旧版本，可以一键恢复。
 * 网页版和安卓 App 都用这一份；桌面版电脑上的文件另有 desktop/backups.mjs。
 *
 *   overwrite  覆盖同名文件：旧内容存进来
 *   create     新建文件：只记一笔（恢复 = 删掉这个文件）
 *   delete     用户在工作区里手动删除：删除前的内容存进来
 *
 * 存在本地数据库的 fileVersions 表里，不参与同步。
 * 浏览器给的空间小（手机更紧），上限比桌面版低：30 天、共 100 MB、单个文件 20 MB、同一文件最多 10 份。
 */
import { collection, uid } from './store.js';

export const LIMITS = { days: 30, totalBytes: 100 * 1024 * 1024, maxFile: 20 * 1024 * 1024, perPath: 10 };
export const OP_NAMES = { overwrite: '覆盖', create: '新建', move: '移动', copy: '复制', delete: '删除' };
const DAY = 86400_000;
const versions = collection('fileVersions');
// 时间严格递增：同一毫秒里的几次改动也能排出先后（列表“新的在前”、恢复的顺序都靠它）
let last = 0;
const stamp = (at) => (last = Math.max(at, last + 1));

/**
 * 记一笔改动。blob 是改动前的内容（新建时为空）
 * @returns {Promise<{ id: string, op: string, stored: boolean }>}
 */
export async function record({ path, op, blob = null, note = '', at = Date.now(), limits = LIMITS }) {
  const size = blob?.size ?? 0;
  const stored = Boolean(blob) && size <= limits.maxFile;
  const e = { id: uid('fv_'), path, op, ts: stamp(at), size, stored, note, ...(stored && { data: blob }) };
  await versions.put(e);
  await prune({ at, limits });
  return e;
}

/** 写完后记下修改时间：之后文件又被改过的话，恢复前提醒用户 */
export async function markWritten(id, mtime) {
  const e = await versions.get(id);
  if (e) await versions.put({ ...e, mtimeAfter: mtime });
}

export async function markRestored(id, at = Date.now()) {
  const e = await versions.get(id);
  if (e) await versions.put({ ...e, restoredAt: at });
}

export const get = (id) => versions.get(id);

/** 给界面看的列表（新的在前，不带文件内容） */
export async function list() {
  return (await versions.all())
    .sort((a, b) => b.ts - a.ts)
    .map(({ data, ...e }) => ({ ...e, opName: OP_NAMES[e.op] ?? e.op }));
}

/** 清理：超过天数的、同一文件超过份数的、总大小超限时最旧的 */
export async function prune({ at = Date.now(), limits = LIMITS } = {}) {
  const all = (await versions.all()).sort((a, b) => b.ts - a.ts);
  const keep = [];
  const removed = [];
  const perPath = new Map();
  for (const e of all) {
    const n = (perPath.get(e.path) ?? 0) + 1;
    perPath.set(e.path, n);
    if (at - e.ts > limits.days * DAY || n > limits.perPath) removed.push(e); else keep.push(e);
  }
  let total = keep.reduce((s, e) => s + (e.stored ? e.size : 0), 0);
  for (let i = keep.length - 1; i >= 0 && total > limits.totalBytes; i--) {
    if (!keep[i].stored) continue;
    total -= keep[i].size;
    removed.push(keep[i]);
  }
  for (const e of removed) await versions.delete(e.id);
  return removed.length;
}

export async function usage() {
  const all = await versions.all();
  return { count: all.length, bytes: all.reduce((s, e) => s + (e.stored ? e.size : 0), 0), limit: LIMITS.totalBytes };
}

export async function clear() {
  await versions.clear();
}
