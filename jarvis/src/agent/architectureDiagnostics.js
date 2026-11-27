/** 仅供修复失败摘录：最多4份材料、每份12万字、24个候选，不参与是否通过的判断。 */
const quotes = text => text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
const normalized = text => quotes(text.normalize('NFKC')).replace(/[\s\u200B-\u200D\uFEFF]/g, '');
function indexed(text) {
  let value = '';
  const offsets = [];
  let offset = 0;
  for (const char of text) {
    const next = normalized(char);
    value += next;
    for (let i = 0; i < next.length; i++) offsets.push(offset);
    offset += char.length;
  }
  return { value, offsets };
}
export function excerptDiagnostics(actual, original, materials = []) {
  const readMaterials = materials.slice(0, 4).map(item => ({
    path: String(item.path || '').slice(0, 400), chars: String(item.text || '').length,
    ...(typeof item.truncated === 'boolean' && { truncated: item.truncated }),
    ...(item.scope === 'section' && { scope: 'section' })
  }));
  const result = { actual: String(actual).slice(0, 120), expected: '', offset: null, firstDiffAt: null, diffKind: 'not-found', readMaterials };
  if (typeof original !== 'string' || !actual || original.length > 120000) return result;
  const hay = indexed(original);
  const needle = normalized(actual);
  if (!needle) return result;
  let found = hay.value.indexOf(needle);
  const length = needle.length;
  if (found < 0 && needle.length >= 8) {
    // 只用确定存在的短锚点提出候选；不跑全文滑窗编辑距离，也不把近似匹配当成事实。
    const candidates = new Set();
    for (const at of [0, Math.floor((needle.length - 8) / 2), needle.length - 8]) {
      const anchor = needle.slice(at, at + 8);
      let hit = hay.value.indexOf(anchor);
      for (let count = 0; hit >= 0 && count < 8; count++) {
        if (hit >= at) candidates.add(hit - at);
        hit = hay.value.indexOf(anchor, hit + 1);
      }
    }
    let best = 0.8;
    for (const start of candidates) {
      const candidate = hay.value.slice(start, start + needle.length);
      let same = 0;
      for (let i = 0; i < needle.length; i++) if (needle[i] === candidate[i]) same++;
      if (same / needle.length > best) { best = same / needle.length; found = start; }
    }
    if (found >= 0) result.diffKind = 'text-difference';
  } else if (found >= 0) result.diffKind = 'normalizable';
  if (found < 0) return result;
  const start = hay.offsets[found];
  const last = hay.offsets[Math.min(found + length - 1, hay.offsets.length - 1)];
  const end = last + (original.codePointAt(last) > 0xFFFF ? 2 : 1);
  const expected = original.slice(start, end);
  if (result.diffKind === 'normalizable') {
    const compact = text => text.replace(/\s+/g, '');
    if (quotes(compact(actual)) === quotes(compact(expected))) result.diffKind = 'quote';
    else if (compact(actual).replace(/[\u200B-\u200D\uFEFF]/g, '') === compact(expected).replace(/[\u200B-\u200D\uFEFF]/g, '')) result.diffKind = 'zero-width';
    else result.diffKind = 'unicode';
  }
  let firstDiffAt = 0;
  while (firstDiffAt < actual.length && firstDiffAt < expected.length && actual[firstDiffAt] === expected[firstDiffAt]) firstDiffAt++;
  return { ...result, expected: expected.slice(0, 120), offset: start, firstDiffAt, candidateOnly: true };
}
