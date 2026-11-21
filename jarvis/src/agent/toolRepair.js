/** 排序对象键，避免只换参数顺序绕过同参守护；不重排数组，不保存大块输入。 */
export function toolCallKey(name, args = {}) {
  const stable = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 24) return value;
    return Array.isArray(value) ? value.map(v => stable(v, depth + 1)) : Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k], depth + 1)]));
  };
  const text = JSON.stringify(stable(args));
  if (text.length < 8000) return name + ':' + text;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${name}:${text.length}:${hash >>> 0}`;
}
export function toolRepairNote(error) {
  if (!error || ['AbortError', 'TimeoutError'].includes(error.name)) return '';
  if (/^(?:INVALID_TOOL_ARGS|FETCH_URL_INPUT|DESIGN_(?:INVALID|BOUNDS|TEXT_OVERFLOW)|POSTER_INPUT_INVALID|CANVAS_INPUT)$/.test(error.code || ''))
    return '\n下一步：按缺失字段/范围修正参数；不要原样重发或换名字重做。只改指定问题，已有原图与源稿保持。';
  if (error.code === 'TOOL_DUPLICATE_CALL') return '\n下一步：使用已有回执继续，或改用确有不同作用的工具；不能靠调换参数键顺序重试。';
  return '';
}
