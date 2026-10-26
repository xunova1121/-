import * as workspace from './workspace.js';
import { parseFile } from './docs.js';

export async function checkSources(sources, signal) {
  const checks = [];
  const materials = [];
  for (const source of sources) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const blob = await workspace.readBlob(source.path);
    if (blob.size > 10e6) throw Object.assign(new Error('来源文件超过10MB，请先分段提取相关材料'), { code: 'DIAGRAM_SOURCE_SIZE', kind: 'input' });
    const parsed = await parseFile(blob, source.path, { limit: 120000 });
    const excerpt = String(source.excerpt || '').trim();
    const matched = Boolean(excerpt && parsed.text.replace(/\s+/g, '').includes(excerpt.replace(/\s+/g, '')));
    materials.push({ path: source.path, text: parsed.text });
    checks.push({ path: source.path, matched, truncated: parsed.chars > 120000 });
  }
  return { checks, materials };
}
