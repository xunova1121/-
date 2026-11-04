/** npm子项目范围。只接受工作副本内的普通相对目录，调用与验收共用同一规范。 */
export function codeProjectScope(value = '.') {
  if (typeof value !== 'string' || value.length > 200) return null;
  if (value === '.' || value === './') return '.';
  const relative = value.replace(/^\.\//, '').replace(/\/$/, '');
  const parts = relative.split('/');
  if (parts.length > 16 || parts.some(part => !/^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*$/u.test(part) || part === 'node_modules')) return null;
  return relative;
}
