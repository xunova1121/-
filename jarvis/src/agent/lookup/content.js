/** 纯解析依赖，服务器探测与实际runner共用，不加载Office/模型依赖。 */
export function decodeLookupBody(bytes, contentType = '') {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] || /^<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1];
  }
  charset = String(charset || 'utf-8').toLowerCase();
  if (/^(gb2312|gbk|x-gbk|gb_2312-80)$/.test(charset)) charset = 'gb18030';
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}
