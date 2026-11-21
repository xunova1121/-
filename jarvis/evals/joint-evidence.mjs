/** 每轮独立文件快照；同名文件后续修改不能覆盖上一轮证据。只写私有评测目录。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export function evidenceDownloader(download, root) {
  const cache = new Map(), files = new Map();
  const read = async (name, options = {}) => {
    const key = `${name}:${options.maxBytes || 20e6}`;
    if (!cache.has(key)) cache.set(key, (async () => {
      const bytes = await download(name, options);
      if (!bytes || !root) return bytes;
      const hash = createHash('sha256').update(bytes).digest('hex');
      const ext = path.extname(name).replace(/[^.a-z0-9]/gi, '').slice(0, 12);
      const file = `${hash}${ext}`;
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(root, file), bytes, { mode: 0o600 });
      files.set(name, { file, sha256: hash, bytes: bytes.byteLength });
      return bytes;
    })());
    return cache.get(key);
  };
  read.artifact = name => files.get(name) || null;
  return read;
}
export function searchEvidence(turn) {
  const count = turn.timing?.nativeSearchCalls;
  return { nativeSearchCalls: Number.isInteger(count) && count >= 0 ? count : null,
    note: '内置搜索不在普通tools列表中；次数只证明发生搜索，不证明网页正文已读或事实已核实。缺少来源回执时应标待复核，不能推断完全没联网。' };
}
