import { isPrivateHost } from '../../shared/providers.js';
import { webBody } from './webBody.js';
import { withWebDeadline } from './retrievalBudget.js';
/** 默认仅列实测可读的免费公开JSON域名；统计局本轮403，不把其标为可用。允许显式保存空清单关闭。 */
export const DEFAULT_PUBLIC_DATA_HOSTS = ['push2.eastmoney.com', 'api.github.com'];
export const PUBLIC_JSON_LIMIT = 200 * 1024;
export function publicDataHosts(value = DEFAULT_PUBLIC_DATA_HOSTS) {
  if (!Array.isArray(value) || value.length > 24) throw Object.assign(new Error('可信公开数据域名最多24个'), { code: 'PUBLIC_JSON_HOSTS', kind: 'input' });
  return [...new Set(value.map(raw => {
    const host = String(raw).trim().toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || isPrivateHost(host)) throw Object.assign(new Error('请填写公网域名，不填网址、端口、通配符或内网地址'), { code: 'PUBLIC_JSON_HOSTS', kind: 'input' });
    return host;
  }))];
}
export function publicJsonUrl(value, domains) {
  let url;
  try { url = new URL(value); } catch { throw Object.assign(new Error('公开数据接口地址无效'), { code: 'PUBLIC_JSON_URL', kind: 'input' }); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || isPrivateHost(url.hostname) || url.href.length > 2000 || !publicDataHosts(domains).includes(url.hostname)) throw Object.assign(new Error('仅允许可信域名清单内的公网HTTPS接口；不允许凭据、非标准端口或内网地址'), { code: 'PUBLIC_JSON_BLOCKED', kind: 'input' });
  if ([...url.searchParams.keys()].some(key => /^(?:(?:x[-_]?)?api[-_]?key|key|access[-_]?token|token|password|passwd|(?:app[-_]?|client[-_]?)?secret|authorization|auth|cookie|signature|sig|jwt|bearer)$/i.test(key))) throw Object.assign(new Error('公开数据接口不能携带密钥或登录凭据'), { code: 'PUBLIC_JSON_CREDENTIALS', kind: 'input' });
  url.hash = '';
  return url.href;
}
export async function readPublicJson(address, { domains = DEFAULT_PUBLIC_DATA_HOSTS, get = (...args) => fetch(...args), signal, consume } = {}) {
  const url = publicJsonUrl(address, domains);
  consume?.('read');
  return withWebDeadline(async activeSignal => {
    const response = await get(url, { method: 'GET', credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' }, signal: activeSignal });
    if (!response.ok) throw Object.assign(new Error('公开数据接口HTTP ' + response.status), { code: 'PUBLIC_JSON_HTTP', kind: 'api', status: response.status });
    if (response.redirected) throw Object.assign(new Error('公开数据接口不允许重定向'), { code: 'REDIRECT_BLOCKED', kind: 'api' });
    const bytes = await webBody(response, PUBLIC_JSON_LIMIT, activeSignal);
    try { return { url, data: JSON.parse(new TextDecoder().decode(bytes)) }; }
    catch { throw Object.assign(new Error('接口没有返回有效JSON，可能是登录页或验证页'), { code: 'PUBLIC_JSON_PARSE', kind: 'api' }); }
  }, { signal, timeoutMs: 8000 });
}
export function createPublicJsonTool(ctx = {}) {
  return {
    name: 'fetch_json',
    description: '只读可信域名内的免费公开JSON数据接口。只允许HTTPS GET，不带登录、Cookie、密钥或自定义鉴权，禁止内网与重定向。8秒/200KB上限，返回过长会明确截断；必须按接口实际日期和单位解释，不凭字段名猜口径。可信域名须由用户在模型中心设置，不能由工具更改。',
    input_schema: { type: 'object', properties: { url: { type: 'string', maxLength: 2000 } }, required: ['url'], additionalProperties: false },
    run: async ({ url }, { signal, retrieval } = {}) => {
      if (ctx.publicJsonAvailable === false || !ctx.fetchPublicJson && !ctx.fetchImpl) throw Object.assign(new Error('公开数据工具需要本机网关或服务器模式进行公网地址校验，请切换服务器模式'), { code: 'PUBLIC_JSON_GATEWAY_REQUIRED', kind: 'api' });
      const result = await readPublicJson(url, { domains: ctx.publicDataHosts, get: ctx.fetchPublicJson || ctx.fetchImpl, signal, consume: kind => retrieval?.consume(kind) });
      const text = JSON.stringify(result.data);
      return JSON.stringify({ kind: 'public_json', url: result.url, fetchedAt: new Date(ctx.now?.() ?? Date.now()).toISOString(), truncated: text.length > 16000, ...(text.length > 16000 ? { preview: text.slice(0, 16000), note: 'JSON预览已截断，不是完整结构；请用接口分页或字段过滤，不补猜后半段' } : { data: result.data }) });
    }
  };
}
