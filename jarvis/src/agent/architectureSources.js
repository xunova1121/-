// 只按声明的真实文件路径补读，绝不把章节标题、工具结果ID或模型转述当材料。
export function architectureSources(input) {
  if (input.sources?.length) return input.sources;
  const found = new Map();
  for (const [key, limit] of [
    ['entities', 60],
    ['relations', 100],
    ['requirements', 80]
  ]) {
    const items = input[key];
    if (!Array.isArray(items) || items.length > limit) continue;
    for (const item of items) {
      const path = item?.source;
      if (typeof path !== 'string' || path.length > 400 || !/\.(?:docx?|pdf|txt|md)$/i.test(path) || found.has(path)) continue;
      if (found.size === 4) throw Object.assign(new Error('架构材料最多4个，请明确选定相关原文件'), { code: 'DIAGRAM_SOURCE_SIZE', kind: 'input' });
      found.set(path, { path, excerpt: typeof item.excerpt === 'string' ? item.excerpt.slice(0, 240) : '' });
    }
  }
  return [...found.values()];
}
