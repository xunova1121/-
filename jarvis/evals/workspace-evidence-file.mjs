import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const maxEvidenceBytes = 20_000_000;
const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function readBounded(dir, name, maxBytes) {
  const file = path.join(dir, name);
  const entry = await fs.lstat(file);
  if (!entry.isFile() || entry.size > maxBytes) return null;
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size > maxBytes) return null;
    const bytes = Buffer.alloc(stat.size);
    let pos = 0;
    while (pos < bytes.length) {
      const { bytesRead } = await handle.read(bytes, pos, bytes.length - pos);
      if (!bytesRead) return null;
      pos += bytesRead;
    }
    // 同一文件读取中增长时也须拒绝，不能把截断的证据当成原件。
    return (await handle.read(Buffer.alloc(1), 0, 1)).bytesRead ? null : bytes;
  } finally { await handle.close(); }
}

/** 仅从指定存储目录读取这一条活动记录。不会打开可写的 FileStore 或回退到回收站。 */
export async function readWorkspaceEvidence(filesDir, relativePath, { maxBytes = maxEvidenceBytes } = {}) {
  if (typeof filesDir !== 'string' || !filesDir || typeof relativePath !== 'string' || !relativePath ||
      relativePath.length > 1024 || path.win32.isAbsolute(relativePath) ||
      relativePath.includes('\0') || relativePath.split(/[\\/]/).some(part => !part || part === '..' || part === '.') ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
  const root = path.resolve(filesDir);
  const hash = createHash('sha1').update(relativePath).digest('hex');
  const recordName = hash + '.json';
  let directory;
  try {
    // realpath 同时检查所有父目录；Linux 再固定目录句柄，避免读取时被换成链接。
    if (await fs.realpath(root) !== root) return null;
    let dir = root;
    if (process.platform === 'linux') {
      directory = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      dir = '/proc/self/fd/' + directory.fd;
      if (await fs.realpath(dir) !== root) return null;
    }
    const metadata = await readBounded(dir, recordName, 100_000);
    if (!metadata) return null;
    const record = JSON.parse(metadata.toString('utf8'));
    const name = record?.data?.$file;
    if (record?.id !== relativePath || typeof name !== 'string') return null;
    if (name !== hash + '.data.bin') {
      const uuid = name.slice(hash.length + 1, -4);
      if (uuid.length !== 36 || !uuidV4.test(uuid) || name !== hash + '.' + uuid + '.bin') return null;
    }
    const bytes = await readBounded(dir, name, Math.min(maxBytes, maxEvidenceBytes));
    if (!bytes || await fs.realpath(root) !== root) return null;
    const latest = await readBounded(dir, recordName, 100_000);
    if (!latest || !metadata.equals(latest)) return null;
    return bytes;
  } catch { return null; }
  finally { await directory?.close(); }
}
