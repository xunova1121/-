/** 凭据只能来自设置，模型参数不允许指定API地址或Key。 */
export function qibookSelected(request = '') {
  const text = String(request);
  if (/(?:不|别|勿|禁止)[^。\n；]{0,6}(?:企百科|qibook)/i.test(text)) return false;
  return /用户选择：[^\n）]*企业资料\s+企百科|(?:使用|用|通过|选择)\s*(?:已配置的)?(?:企百科|qibook)(?:查询|查|搜索|检索|接口|服务|[，,：:\s])/i.test(text);
}
export function qibookConfig(config = {}) {
  const key = typeof config.qibookAccessKey === 'string' ? config.qibookAccessKey.trim() : '';
  if (!key || key.startsWith('••••') || !config.qibookBaseUrl) return null;
  let url;
  try { url = new URL(config.qibookBaseUrl); } catch { throw new Error('企百科API地址必须是完整HTTPS地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname)) throw new Error('企百科API地址须为公开HTTPS地址，不能带账号、查询参数或内网地址');
  return { key, baseUrl: url.href.replace(/\/+$/, '') };
}
