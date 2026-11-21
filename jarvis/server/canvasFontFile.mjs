/** 取出fontconfig实际选中的TTC字面，避免原生Canvas只读集合首个日文字体而冒称简中字体。 */
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4)
    sum =
      (sum +
        (((bytes[i] || 0) * 0x1000000 +
          (bytes[i + 1] || 0) * 0x10000 +
          (bytes[i + 2] || 0) * 256 +
          (bytes[i + 3] || 0)) >>>
          0)) >>>
      0;
  return sum;
}
export function fontCollectionFace(input, index) {
  const bytes = Buffer.from(input);
  if (bytes.length < 12 || bytes.length > 32e6) throw new Error('font size');
  if (bytes.toString('ascii', 0, 4) !== 'ttcf') return bytes;
  const count = bytes.readUInt32BE(8);
  if (!Number.isInteger(index) || index < 0 || index >= count || count > 64 || 12 + count * 4 > bytes.length)
    throw new Error('font index');
  const offset = bytes.readUInt32BE(12 + index * 4);
  if (offset + 12 > bytes.length) throw new Error('font offset');
  const tables = bytes.readUInt16BE(offset + 4);
  if (!tables || tables > 128 || offset + 12 + tables * 16 > bytes.length) throw new Error('font tables');
  const entries = [];
  let length = 12 + tables * 16;
  for (let i = 0; i < tables; i++) {
    const pos = offset + 12 + i * 16,
      start = bytes.readUInt32BE(pos + 8),
      size = bytes.readUInt32BE(pos + 12);
    if (start + size > bytes.length || size > 32e6) throw new Error('font table range');
    entries.push({ tag: bytes.toString('ascii', pos, pos + 4), start, size, offset: length });
    length += (size + 3) & ~3;
  }
  if (length > 32e6) throw new Error('font face size');
  const out = Buffer.alloc(length);
  bytes.copy(out, 0, offset, offset + 12);
  let head;
  entries.forEach((e, i) => {
    bytes.copy(out, e.offset, e.start, e.start + e.size);
    if (e.tag === 'head') {
      if (e.size < 12) throw new Error('font head');
      out.writeUInt32BE(0, e.offset + 8);
      head = e.offset;
    }
    const pos = 12 + i * 16;
    out.write(e.tag, pos, 4, 'ascii');
    out.writeUInt32BE(checksum(out.subarray(e.offset, e.offset + e.size)), pos + 4);
    out.writeUInt32BE(e.offset, pos + 8);
    out.writeUInt32BE(e.size, pos + 12);
  });
  if (head !== undefined) out.writeUInt32BE((0xb1b0afba - checksum(out)) >>> 0, head + 8);
  return out;
}
export async function canvasFontFiles(family, signal) {
  const files = [];
  for (const weight of ['80', '200']) {
    const { stdout } = await run('fc-match', ['-f', '%{file}\n%{index}\n', `${family}:weight=${weight}`], {
      signal,
      timeout: 3000,
      maxBuffer: 4096
    });
    const [path, index] = stdout.trim().split('\n');
    if ((await stat(path)).size > 32e6) throw new Error('font size');
    const raw = await readFile(path);
    files.push(fontCollectionFace(raw, Number(index) & 0xffff));
  }
  return files;
}
