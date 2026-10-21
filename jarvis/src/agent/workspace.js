/**
 * 工作区文件系统。两种模式：
 *   虚拟工作区（默认）：文件存在浏览器 IndexedDB 里，可随时下载；
 *   本地文件夹：用户点“连接文件夹”授权后（Chrome / Edge 的 File System Access API），
 *               直接读写这台电脑上的那个文件夹。
 *
 * 安全约定：智能体不能删除文件；在本地文件夹里写文件时，同名文件不会被覆盖，
 * 而是另存为“名称 (2).扩展名”，并在结果里说明。
 * 虚拟工作区里覆盖、删除之前自动留一份旧版本，可在“改动记录”里恢复（见 fileHistory.js）。
 */
import { collection } from './store.js';
import * as history from './fileHistory.js';

const files = collection('files');
const kv = collection('kv');
let dirHandle = null;

export const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', py: 'text/x-python', svg: 'image/svg+xml', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
export const ext = (p) => (String(p).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
export const isText = (p) => /^(html?|css|m?js|json|md|txt|csv|py|svg|xml|ts|tsx|jsx|yml|yaml|ini|log|sh|bat)$/.test(ext(p));

/** 规范化路径：去掉开头的 /、./，禁止 .. 跳出工作区 */
export function normalize(p) {
  const parts = [];
  for (const seg of String(p || '').replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') throw new Error('路径不能包含 ..');
    parts.push(seg);
  }
  if (!parts.length) throw new Error('路径为空');
  return parts.join('/');
}

export const mode = () => (dirHandle ? 'folder' : 'virtual');
export const folderName = () => dirHandle?.name ?? null;
export const canUseFolders = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export async function connectFolder() {
  if (!canUseFolders()) throw new Error('当前浏览器不支持连接本地文件夹，请使用 Chrome 或 Edge');
  const h = await window.showDirectoryPicker({ mode: 'readwrite' });
  dirHandle = h;
  try { await kv.put({ id: 'folder', handle: h }); } catch { /* 部分浏览器不能持久化句柄 */ }
  return h.name;
}

export async function disconnectFolder() {
  dirHandle = null;
  await kv.delete('folder');
}

/** 页面重新打开后恢复上次连接的文件夹（浏览器会要求用户再点一次授权） */
export async function restoreFolder({ prompt = false } = {}) {
  const rec = await kv.get('folder').catch(() => null);
  if (!rec?.handle) return null;
  const perm = await rec.handle.queryPermission?.({ mode: 'readwrite' });
  if (perm === 'granted' || (prompt && (await rec.handle.requestPermission?.({ mode: 'readwrite' })) === 'granted')) {
    dirHandle = rec.handle;
    return dirHandle.name;
  }
  return { pending: rec.handle.name };
}

async function walkFolder(handle, prefix = '', out = [], depth = 0) {
  if (depth > 4 || out.length > 500) return out;
  for await (const [name, h] of handle.entries()) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const p = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'directory') await walkFolder(h, p, out, depth + 1);
    else {
      const f = await h.getFile();
      out.push({ path: p, size: f.size, mtime: f.lastModified });
    }
  }
  return out;
}

async function folderFileHandle(path, create = false) {
  const segs = path.split('/');
  let dir = dirHandle;
  for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create });
  return dir.getFileHandle(segs.at(-1), { create });
}

export async function list(prefix = '') {
  const pre = prefix ? normalize(prefix) : '';
  const all = dirHandle ? await walkFolder(dirHandle) : (await files.all()).map(({ id, size, mtime }) => ({ path: id, size, mtime }));
  return all.filter((f) => !pre || f.path === pre || f.path.startsWith(`${pre}/`)).sort((a, b) => a.path.localeCompare(b.path));
}

/** @returns {Promise<Blob>} */
export async function readBlob(path) {
  path = normalize(path);
  if (dirHandle) return (await folderFileHandle(path)).getFile();
  const f = await files.get(path);
  if (!f) throw new Error(`找不到文件：${path}`);
  return f.data instanceof Blob ? f.data : new Blob([f.data], { type: MIME[ext(path)] || 'text/plain' });
}

export async function readText(path) {
  return (await readBlob(path)).text();
}

export async function exists(path) {
  try { await readBlob(path); return true; } catch { return false; }
}

/**
 * 写文件。data 可以是字符串、Blob 或 ArrayBuffer。
 * backup：虚拟工作区里 saved 已备份旧内容 / recorded 新建，记了一笔 / too-big 太大没备份；本地文件夹不覆盖，为 null
 * @returns {Promise<{path: string, renamed: boolean, backup: string|null}>}
 */
export async function write(path, data) {
  path = normalize(path);
  const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[ext(path)] || 'text/plain' });
  if (dirHandle) {
    let target = path;
    for (let i = 2; await exists(target); i++) target = path.replace(/(\.[^./]+)?$/, (m) => ` (${i})${m}`);
    const h = await folderFileHandle(target, true);
    const w = await h.createWritable();
    await w.write(blob);
    await w.close();
    return { path: target, renamed: target !== path, backup: null };
  }
  const e = await writeVirtual(path, blob);
  return { path, renamed: false, backup: e.op === 'create' ? 'recorded' : e.stored ? 'saved' : 'too-big' };
}

const asBlob = (f, path) => (f.data instanceof Blob ? f.data : new Blob([f.data], { type: MIME[ext(path)] || 'text/plain' }));

/** 写进虚拟工作区：同名文件先留一份旧版本 */
async function writeVirtual(path, blob, note = '') {
  const old = await files.get(path);
  const e = await history.record({ path, op: old ? 'overwrite' : 'create', blob: old ? asBlob(old, path) : null, note });
  const mtime = Date.now();
  await files.put({ id: path, data: blob, size: blob.size, mtime });
  await history.markWritten(e.id, mtime);
  return e;
}

/** 只用于虚拟工作区（用户手动删除）；智能体工具不暴露删除。删除前留一份，可在“改动记录”里恢复 */
export async function removeVirtual(path, note = '') {
  path = normalize(path);
  const old = await files.get(path);
  if (old) await history.record({ path, op: 'delete', blob: asBlob(old, path), note });
  await files.delete(path);
}

/**
 * 恢复前检查（虚拟工作区的改动记录）
 * @returns {Promise<{ ok: boolean, problem?: string, warning?: string }>}
 */
export async function checkVersion(id) {
  const e = await history.get(id);
  if (!e) return { ok: false, problem: '找不到这条记录，可能已经过期被清理' };
  const cur = await files.get(e.path);
  const changed = cur && e.mtimeAfter && cur.mtime !== e.mtimeAfter;
  if (e.op === 'create') {
    if (!cur) return { ok: false, problem: `文件已经不在了，不需要撤销：${e.path}` };
    return { ok: true, warning: changed ? '这个文件建好之后又被改过，撤销会删掉它（当前内容会先备份）' : '' };
  }
  if (!e.stored) return { ok: false, problem: `当时文件太大（超过 ${LIMIT_MB} MB），没有备份：${e.path}` };
  return { ok: true, warning: changed ? '这个文件在那之后又被改过，恢复会覆盖这些改动（当前内容会先备份）' : '' };
}
const LIMIT_MB = history.LIMITS.maxFile / 1048576;

/** 恢复一条改动记录。恢复前当前内容也会留一份，所以恢复本身也能撤销 */
export async function restoreVersion(id) {
  const check = await checkVersion(id);
  if (!check.ok) throw new Error(check.problem);
  const e = await history.get(id);
  if (e.op === 'create') await removeVirtual(e.path, '撤销新建前的内容');
  else await writeVirtual(e.path, e.data instanceof Blob ? e.data : new Blob([e.data]), '恢复前的内容');
  await history.markRestored(id);
  return { path: e.path, op: e.op };
}
