/**
 * 打开压缩包（2026-11-17 用户：压缩打包的文件怎么读取）。
 *
 * 支持 zip、tar、tar.gz/.tgz：先列出里面的文件，再解压到工作区里同名文件夹，模型像普通文件一样读。
 * 中文 Windows 打包的 zip 文件名常是 GBK 编码，按 UTF-8 解不通就按 GBK 解，不出乱码。
 * 安全：最多解压 500 个文件、合计 300MB、单个 50MB；压缩比异常（疑似“压缩炸弹”）直接停；
 *       带 ../、绝对路径、盘符的条目一律跳过；加密包如实说打不开。rar/7z 需要另装组件，提示转成 zip。
 */
import JSZip from 'jszip';
import * as ws from './workspace.js';
import { throwControl } from '../core/networkRequest.js';

export const ARCHIVE_LIMITS = { files: 500, total: 300e6, single: 50e6, ratio: 200, archive: 50e6 };
const archiveError = (message, code = 'ARCHIVE_INPUT') => Object.assign(new Error(message), { code, kind: 'input' });

export function archiveKind(bytes, path = '') {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5)) return 'zip';
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
  if (bytes.length > 262 && String.fromCharCode(...bytes.slice(257, 262)) === 'ustar') return 'tar';
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'Rar!') return 'rar';
  if (bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf) return '7z';
  if (/\.tar$/i.test(path)) return 'tar';
  return null;
}

/** zip 文件名：没有 UTF-8 标记的按 UTF-8 严格解，解不通再按 GBK（中文 Windows 默认） */
export function decodeEntryName(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { try { return new TextDecoder('gbk').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); } }
}

/** 条目路径安全化：去掉开头斜杠和 ./，拒绝 ..、盘符；跳过系统垃圾文件 */
export function safeEntryPath(name) {
  const clean = String(name).replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!clean || /^\/|^[a-z]:/i.test(clean) || clean.split('/').some(p => p === '..')) return null;
  if (/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(clean)) return null;
  return clean.replace(/\/+/g, '/');
}

async function gunzip(bytes, signal) {
  if (typeof DecompressionStream !== 'function') throw archiveError('当前环境不能解开 gzip，请改用 zip', 'ARCHIVE_UNSUPPORTED');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader(), parts = [];
  let size = 0;
  for (;;) {
    throwControl(null, signal);
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > ARCHIVE_LIMITS.total) { reader.cancel(); throw archiveError('解压后超过300MB上限，可能是压缩炸弹或文件过大，已停止', 'ARCHIVE_TOO_LARGE'); }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** 极简 tar 解析：普通文件和目录；支持 ustar 前缀和 GNU 长文件名（L 类型） */
function readTar(bytes) {
  const entries = [];
  let offset = 0, longName = null;
  const str = (a, b) => new TextDecoder('utf-8').decode(bytes.subarray(a, b)).replace(/\0.*$/s, '');
  while (offset + 512 <= bytes.length) {
    if (bytes.subarray(offset, offset + 512).every(b => b === 0)) break;
    const size = parseInt(str(offset + 124, offset + 136).trim() || '0', 8), type = String.fromCharCode(bytes[offset + 156] || 48);
    const prefix = str(offset + 345, offset + 500), base = str(offset, offset + 100);
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    if (type === 'L') longName = new TextDecoder('utf-8').decode(data).replace(/\0.*$/s, '');
    else {
      const name = longName || (prefix ? `${prefix}/${base}` : base);
      longName = null;
      if (type === '0' || type === '\0' || type === '7') entries.push({ name, size, dir: false, data: () => data });
      else if (type === '5') entries.push({ name, size: 0, dir: true });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** 读出条目清单（不解压内容）；compressed 为压缩包字节数，用来查压缩比 */
export async function listArchive(blob, path, { signal } = {}) {
  if (blob.size > ARCHIVE_LIMITS.archive) throw archiveError('压缩包超过50MB上限，请拆成几个包', 'ARCHIVE_TOO_LARGE');
  let bytes = new Uint8Array(await blob.arrayBuffer());
  let kind = archiveKind(bytes, path);
  if (kind === 'rar' || kind === '7z') throw archiveError(`${kind.toUpperCase()} 格式暂不支持，请在电脑上解压后重新打成 zip 再上传`, 'ARCHIVE_UNSUPPORTED');
  if (!kind) throw archiveError('不是支持的压缩包（支持 zip、tar、tar.gz）', 'ARCHIVE_UNSUPPORTED');
  if (kind === 'gzip') {
    bytes = await gunzip(bytes, signal);
    if (archiveKind(bytes, path.replace(/\.(gz|tgz)$/i, '.tar')) !== 'tar') {
      // 单个 .gz 文件（不是 tar 包）：当成一个文件
      return { kind: 'gzip', entries: [{ name: path.split('/').pop().replace(/\.gz$/i, '') || 'file', size: bytes.length, dir: false, data: () => bytes }] };
    }
    kind = 'tar';
  }
  if (kind === 'tar') return { kind: 'tar', entries: readTar(bytes) };
  let zip;
  try { zip = await JSZip.loadAsync(bytes, { decodeFileName: decodeEntryName }); }
  catch (error) {
    if (/encrypt/i.test(error.message)) throw archiveError('压缩包有密码，打不开；请解除密码后重新上传', 'ARCHIVE_ENCRYPTED');
    throw archiveError('压缩包损坏或格式不对，打不开', 'ARCHIVE_BROKEN');
  }
  // JSZip 会把 ../ 之类的危险路径悄悄改掉；用原始名字判断，危险的一律跳过而不是换个地方写
  const entries = Object.values(zip.files).filter(f => !(f.dir && f.name === '/')).map(f => ({ name: f.unsafeOriginalName ?? f.name, dir: f.dir, size: f._data?.uncompressedSize ?? 0, data: () => f.async('uint8array') }));
  return { kind: 'zip', entries };
}

async function freeFolder(base, signal) {
  for (let i = 0; i < 20; i++) {
    throwControl(null, signal);
    const name = i ? `${base}（${i + 1}）` : base;
    if (!(await ws.list(name)).length) return name;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * 解压到工作区：返回实际写出的文件、跳过的条目和原因。
 * only：只解压这些条目（列表里的原名），不给就全部。
 */
export async function extractArchive(path, { only = null, signal, onFileChanged } = {}) {
  const blob = await ws.readBlob(path);
  const { kind, entries } = await listArchive(blob, path, { signal });
  const files = entries.filter(e => !e.dir);
  const wanted = only?.length ? files.filter(e => only.includes(e.name)) : files;
  const declared = wanted.reduce((s, e) => s + e.size, 0);
  if (wanted.length > ARCHIVE_LIMITS.files) throw archiveError(`包里有${wanted.length}个文件，超过一次500个的上限；请用only挑出需要的文件`, 'ARCHIVE_TOO_MANY');
  if (declared > ARCHIVE_LIMITS.total) throw archiveError('解压后超过300MB上限；请用only挑出需要的文件', 'ARCHIVE_TOO_LARGE');
  if (kind === 'zip' && declared > 100e6 && declared / Math.max(1, blob.size) > ARCHIVE_LIMITS.ratio) throw archiveError('压缩比异常（疑似压缩炸弹），已停止解压', 'ARCHIVE_BOMB');
  const folder = await freeFolder(ws.normalize(path).replace(/\.(zip|tar|tgz|tar\.gz|gz)$/i, ''), signal);
  const written = [], skipped = [];
  let total = 0;
  for (const entry of wanted) {
    throwControl(null, signal);
    const rel = safeEntryPath(entry.name);
    if (!rel) { skipped.push({ name: entry.name, reason: '路径不安全或是系统文件，已跳过' }); continue; }
    const data = await entry.data();
    if (data.length > ARCHIVE_LIMITS.single) { skipped.push({ name: entry.name, reason: '单个文件超过50MB，未解压' }); continue; }
    total += data.length;
    if (total > ARCHIVE_LIMITS.total) throw archiveError('实际解压超过300MB上限（声明大小与实际不符），已停止', 'ARCHIVE_BOMB');
    const saved = await ws.write(`${folder}/${rel}`, new Blob([data]));
    written.push({ path: saved.path, size: data.length, nested: /\.(zip|tar|tgz|gz|rar|7z)$/i.test(rel) });
  }
  if (written.length) onFileChanged?.(written[0].path);
  return { kind, folder, written, skipped };
}
