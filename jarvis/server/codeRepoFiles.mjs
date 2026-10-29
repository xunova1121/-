import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { codeError, redactCode } from './codeGit.mjs';

export function allowedCodePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1000 || /[\x00-\x1f\x7f\\:]/.test(value) || path.posix.isAbsolute(value)) return false;
  const parts = value.split('/');
  return parts.every(
    (part) =>
      part &&
      part !== '.' &&
      part !== '..' &&
      !/^(?:\.git|\.env(?:\..*)?|\.npmrc|\.netrc|credentials|id_rsa|id_ed25519)$/i.test(part) &&
      !/\.(?:pem|key|p12|pfx|keystore|jks)$/i.test(part)
  );
}
export async function readCodeFile(root, relative, token = '') {
  if (!allowedCodePath(relative)) throw codeError('CODE_PATH', '文件路径越界或属于凭据文件，不能读取');
  const base = await fs.realpath(root);
  let target = base;
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    let item;
    try {
      item = await fs.lstat(target);
    } catch (error) {
      if (error.code === 'ENOENT') throw codeError('CODE_FILE_MISSING', '工作副本中没有该文件');
      throw error;
    }
    if (item.isSymbolicLink()) throw codeError('CODE_SYMLINK', '不通过符号链接读取代码，防止越过工作副本');
  }
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1_000_000) throw codeError('CODE_FILE_SIZE', '只读取1MB以内的普通文本文件');
    // Linux服务端核对真正打开的文件，而不是只检查打开前的路径。
    if (process.platform === 'linux') {
      const actual = await fs.realpath('/proc/self/fd/' + handle.fd);
      if (!actual.startsWith(base + path.sep)) throw codeError('CODE_PATH', '实际打开的文件不在工作副本内');
    }
    // 即使文件被并发增大，也不无界分配内存或卡在FIFO上。
    const buffer = Buffer.alloc(1_000_001);
    let length = 0;
    while (length < buffer.length) {
      const part = await handle.read(buffer, length, buffer.length - length, null);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.length > 1_000_000 || bytes.includes(0)) throw codeError('CODE_FILE_BINARY', '该文件过大或不是普通文本');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw codeError('CODE_FILE_BINARY', '该文件不是UTF-8文本');
    }
    return { text: redactCode(text, token), bytes: bytes.length };
  } finally {
    await handle.close();
  }
}
export function codeLines(text, start = 1, end = start + 119) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || start > 1_000_000 || end < start || end - start >= 200)
    throw codeError('CODE_LINES', '按行读取每次最多200行，起始行从1开始');
  const all = text.split(/\r?\n/),
    lines = [];
  let size = 0,
    truncated = false;
  for (let i = start - 1; i < Math.min(end, all.length); i++) {
    const value = all[i].slice(0, 2000);
    if (size + value.length > 16000) {
      truncated = true;
      break;
    }
    lines.push({ line: i + 1, text: value });
    size += value.length;
    truncated ||= value.length !== all[i].length;
  }
  return { lines, totalLines: all.length, truncated, start, end: lines.at(-1)?.line ?? start - 1 };
}
export async function searchCode(root, files, query, { mode = 'content', token = '', signal } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200 || !['content', 'name'].includes(mode))
    throw codeError('CODE_SEARCH', '搜索用1至200字的普通文本，mode为content或name');
  const needle = query.toLowerCase(),
    matches = [];
  let scannedFiles = 0,
    bytes = 0,
    skippedFiles = 0,
    truncated = files.length > 1000;
  for (const file of files.slice(0, 1000)) {
    signal?.throwIfAborted();
    if (!allowedCodePath(file)) {
      skippedFiles++;
      continue;
    }
    if (mode === 'name') {
      if (file.toLowerCase().includes(needle)) matches.push({ path: file });
    } else {
      if (scannedFiles >= 200 || bytes >= 8_000_000) {
        truncated = true;
        break;
      }
      let read;
      try {
        read = await readCodeFile(root, file, token);
      } catch (error) {
        if (['CODE_FILE_SIZE', 'CODE_FILE_BINARY', 'CODE_SYMLINK', 'CODE_FILE_MISSING'].includes(error.code)) {
          skippedFiles++;
          continue;
        }
        throw error;
      }
      scannedFiles++;
      bytes += read.bytes;
      const lines = read.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++)
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({ path: file, line: i + 1, text: lines[i].slice(0, 240) });
          if (matches.length === 50) break;
        }
    }
    if (matches.length === 50) {
      truncated = true;
      break;
    }
  }
  return { matches, scannedFiles, skippedFiles, truncated };
}
