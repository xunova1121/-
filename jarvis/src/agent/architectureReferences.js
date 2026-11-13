/** 最多4材料/18万字符；连续块120～240字符，最多1600块，不删正文、不生成模糊引文。 */
const invalid = (message) => Object.assign(new Error(message), { code: 'ARCHITECTURE_WORKFLOW', kind: 'input' });
export function architectureReferences(materials) {
  if (!Array.isArray(materials) || materials.length > 4 || materials.reduce((n, m) => n + (m.text?.length || 0), 0) > 180000) throw invalid('引用材料超限');
  let count = 0;
  return materials.map((source, material) => {
    if (typeof source.text !== 'string') throw invalid('引用材料正文无效');
    const blocks = [];
    let start = 0;
    while (start < source.text.length) {
      let end = Math.min(start + 240, source.text.length);
      if (end < source.text.length) {
        const candidate = Math.max(source.text.lastIndexOf('\n', end - 1), source.text.lastIndexOf('。', end - 1), source.text.lastIndexOf('；', end - 1));
        if (candidate >= start + 120) end = candidate + 1;
        if (/[\uDC00-\uDFFF]/.test(source.text[end])) end--;
      }
      if (++count > 1600) throw invalid('引用块超过1600项');
      blocks.push({ block: blocks.length, text: source.text.slice(start, end) });
      start = end;
    }
    return { material, blocks };
  });
}
export function architectureCitation(citation, materials, references = architectureReferences(materials)) {
  const source = materials[citation?.material];
  if (!Number.isInteger(citation?.material) || !source) throw invalid('citation.material需当前材料整数编号');
  if (Object.hasOwn(citation, 'block')) {
    if (Object.hasOwn(citation, 'quote') || !Number.isInteger(citation.block) || citation.block < 0)
      throw invalid('citation.block需程序给出的整数编号，不与quote混用');
    const block = references[citation.material]?.blocks[citation.block];
    if (!block?.text.trim()) throw invalid('citation.block不存在或没有可引用正文');
    return { source: source.path, excerpt: block.text, block: citation.block };
  }
  // 旧任务仍支持逐字引文，但绝不把改写/近似文字自动匹配为事实。
  if (typeof citation.quote !== 'string' || !citation.quote.trim() || citation.quote.length > 240 || !source.text.includes(citation.quote))
    throw invalid('旧citation.quote需当前材料内连续原文；新任务请使用block整数编号，不抄写或改写原文');
  return { source: source.path, excerpt: citation.quote };
}
