/** 保守文本估算；不包含图片编码成本，不冒充服务商实际计费Token。 */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const wide = (text.match(/[^\x00-\x7f]/g) || []).length;
  return Math.ceil(wide + (text.length - wide) / 3);
}
