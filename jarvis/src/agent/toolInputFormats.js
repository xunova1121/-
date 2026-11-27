/** 只归一化schema已声明的类型，不猜字段含义，不改文件路径/正文/URL，也不绕过业务范围校验。 */
export function normalizeToolFormats(tool, args) {
  for (const [key, schema] of Object.entries(tool.input_schema?.properties || {})) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const text = value.trim().normalize('NFKC');
    if (['number', 'integer'].includes(schema.type) && /^[+-]?(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)(?:e[+-]?\d+)?$/i.test(text)) {
      const numeric = Number(text.replace(/,/g, ''));
      if (Number.isFinite(numeric) && (schema.type !== 'integer' || Number.isSafeInteger(numeric))) args[key] = numeric;
    }
    if (schema.type === 'boolean' && /^(true|false)$/.test(text)) args[key] = text === 'true';
    if (['object', 'array'].includes(schema.type) && text.length <= 100000) {
      try {
        const parsed = JSON.parse(text);
        if (schema.type === 'array' ? Array.isArray(parsed) : parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args[key] = parsed;
      } catch { /* 不是JSON时保留原值，交给原校验提示。 */ }
    }
    if (schema.enum?.every(option => typeof option === 'string')) {
      const matches = schema.enum.filter(option => option.toLowerCase() === text.toLowerCase());
      if (matches.length === 1) args[key] = matches[0];
    }
  }
  return args;
}
