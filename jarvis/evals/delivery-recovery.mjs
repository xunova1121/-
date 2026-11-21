import fs from 'node:fs/promises';
import path from 'node:path';
import * as ws from '../src/agent/workspace.js';

/** 从隔离工作区导出已有产物，不请求模型。最多100件/80MB，不导出配置或会话状态。 */
export async function exportDeliveryRecovery(outDir) {
  const result = { files: [], skipped: 0, bytes: 0 };
  const entries = (await ws.list()).filter(file => /^(?:images|outputs)\//.test(file.path) && /\.(?:png|jpe?g|webp|pptx|docx|pdf)$/i.test(file.path));
  for (const file of entries) {
    if (result.files.length >= 100 || file.size > 20e6 || result.bytes + file.size > 80e6) { result.skipped++; continue; }
    const blob = await ws.readBlob(file.path);
    if (blob.size > 20e6 || result.bytes + blob.size > 80e6) { result.skipped++; continue; }
    const target = path.join(outDir, 'recovery', ws.normalize(file.path));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, new Uint8Array(await blob.arrayBuffer()), { mode: 0o600 });
    result.bytes += blob.size;
    result.files.push({ path: file.path, bytes: blob.size });
  }
  return result;
}
