/**
 * 工作区文件系统。两种模式：
 *   虚拟工作区（默认）：文件存在浏览器 IndexedDB 里，可随时下载；
 *   本地文件夹：用户点“连接文件夹”授权后（Chrome / Edge 的 File System Access API），
 *               直接读写这台电脑上的那个文件夹。
 *
 * 安全约定：智能体不能删除文件；在本地文件夹里写文件时，同名文件不会被覆盖，
 * 而是另存为“名称 (2).扩展名”，并在结果里说明。
 */
import { collection } from './store.js';

const files = collection('files');
const kv = collection('kv');
let dirHandle = null;

export const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', py: 'text/x-python', svg: 'image/svg+xml', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
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
 * @returns {Promise<{path: string, renamed: boolean}>}
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
    return { path: target, renamed: target !== path };
  }
  await files.put({ id: path, data: blob, size: blob.size, mtime: Date.now() });
  return { path, renamed: false };
}

/** 只用于虚拟工作区（用户手动删除）；智能体工具不暴露删除 */
export async function removeVirtual(path) {
  await files.delete(normalize(path));
}
