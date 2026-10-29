/** DeepSeek公开Search/Fetch协议；仅访问固定官方端点，不复用中转商密钥。 */
import { isPrivateHost } from '../../shared/providers.js';
import { retryRead, throwControl, httpError } from '../core/networkRequest.js';
import { webBody } from './webBody.js';

const ORIGIN = 'https://api.deepseek.com/v1/tools/';
const secret = (value) => (typeof value === 'string' && !value.startsWith('••••') ? value.trim() : '');

export function deepseekSearchOptions(cfg = {}) {
  let official = !cfg.baseURLs?.deepseek;
  try {
    official ||= new URL(cfg.baseURLs.deepseek).origin === 'https://api.deepseek.com';
  } catch {
    /* 无效或第三方地址不复用。 */
  }
  return {
    deepseekSearchEnabled: cfg.deepseekSearchEnabled === true,
    deepseekSearchKey: secret(cfg.deepseekSearchKey) || (official ? secret(cfg.keys?.deepseek) : '')
  };
}

function publicUrl(address) {
  let parsed;
  try {
    parsed = new URL(address);
  } catch {
    throw Object.assign(new Error('请提供有效的公网网页地址'), { code: 'INVALID_FETCH_URL', kind: 'api' });
  }
  if (
    !/^https?:$/.test(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    isPrivateHost(parsed.hostname.replace(/\.$/, '')) ||
    parsed.hostname.endsWith('.internal') ||
    !parsed.hostname.includes('.') ||
    address.length > 8192
  )
    throw Object.assign(new Error('私有、含凭据或无效地址不发送到公共抓取服务'), { code: 'PRIVATE_NETWORK_BLOCKED', kind: 'api', status: 403 });
  return parsed.href;
}

export function createDeepseekSearch({ deepseekSearchEnabled, deepseekSearchKey, fetchViaGateway, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  if (!deepseekSearchEnabled) return null;
  const get = fetchViaGateway || fetchImpl;
  // 熔断：服务商自身出错（5xx / 连不上）后 3 分钟内不再先试它，直接走下一条线路，
  // 免得每次都先撞一次坏接口、白扣用户的查询额度（用户 2026-10-29 实测 DeepSeek Fetch 连续 500）
  const unavailableUntil = { search: 0, fetch: 0 };
  async function request(kind, body, { signal, consume } = {}) {
    if (unavailableUntil[kind] > Date.now())
      throw Object.assign(new Error('DeepSeek ' + (kind === 'search' ? '搜索' : '读网页') + '接口刚刚连续出错，3 分钟内先走其他线路'), { code: 'DEEPSEEK_UNAVAILABLE', kind: 'api', skipped: true });
    try {
      return await requestOnce(kind, body, { signal, consume });
    } catch (error) {
      if (error.status >= 500 || ['network', 'timeout'].includes(error.kind) || error.name === 'TimeoutError') unavailableUntil[kind] = Date.now() + 3 * 60_000;
      throw error;
    }
  }
  async function requestOnce(kind, body, { signal, consume } = {}) {
    if (!secret(deepseekSearchKey))
      throw Object.assign(new Error('请配置DeepSeek官方搜索Key，或该位置的DeepSeek官方模型Key'), { code: 'DEEPSEEK_SEARCH_KEY_MISSING', kind: 'api' });
    return retryRead(
      async (activeSignal) => {
        let response;
        try {
          response = await get(ORIGIN + kind, {
            method: 'POST',
            signal: activeSignal,
            redirect: 'error',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + deepseekSearchKey },
            body: JSON.stringify(body)
          });
        } catch (error) {
          throwControl(error, activeSignal);
          if (error.kind === 'api') throw error;
          throw Object.assign(new Error('DeepSeek搜索服务连接失败'), { kind: 'network', name: 'NetworkError', code: 'DEEPSEEK_SEARCH_NETWORK' });
        }
        if (!response.ok) {
          await response.body?.cancel?.();
          // 不回显上游正文，避免服务商把请求或密钥带进错误消息。
          const reason =
            response.status === 401
              ? '官方Key无效'
              : response.status === 402
                ? '服务商账户余额不足'
                : response.status === 429
                  ? '请求受到限流'
                  : '接口暂不可用';
          throw httpError(response.status, reason, 'DeepSeek Search/Fetch');
        }
        const bytes = await webBody(response, 2 * 1024 * 1024, activeSignal);
        try {
          return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw Object.assign(new Error('DeepSeek搜索接口未返回有效JSON'), { kind: 'api', code: 'DEEPSEEK_SEARCH_FORMAT' });
        }
      },
      {
        signal,
        timeoutMs: 10000,
        beforeAttempt: (attempt) => {
          if (attempt) consume?.(kind === 'search' ? 'search' : 'read');
        }
      }
    );
  }
  return {
    name: 'DeepSeek Search（官方，按成功请求计费）',
    async search(query, count = 6, options = {}) {
      let value = String(query).trim();
      if (options.freshness) {
        const days = { day: 1, week: 7, month: 30, year: 365 }[options.freshness];
        if (days && !/\bafter:/.test(value)) value += ' after:' + new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      }
      if (!value || [...value].length > 128)
        throw Object.assign(new Error('DeepSeek搜索词须为1到128个字符；可缩短或使用免费线路'), { code: 'DEEPSEEK_QUERY_LIMIT', kind: 'api' });
      const data = await request('search', { query: value, count: Math.max(1, Math.min(10, Math.floor(count) || 6)), need_content: false }, options);
      if (!Array.isArray(data?.results)) throw Object.assign(new Error('DeepSeek搜索结果缺少results列表'), { code: 'DEEPSEEK_SEARCH_FORMAT', kind: 'api' });
      const rows = [];
      for (const item of data.results.slice(0, 50)) {
        try {
          const url = publicUrl(String(item.url || ''));
          rows.push({
            title: String(item.title || '').slice(0, 200),
            url,
            snippet: String(item.summary || item.snippet || '').slice(0, 800),
            source: 'deepseek',
            publishedAt: String(item.date || '').slice(0, 50),
            authority: Number.isFinite(item.authority) ? item.authority : null,
            rerankScore: Number.isFinite(item.rerank_score) ? item.rerank_score : null
          });
        } catch (error) {
          if (!['PRIVATE_NETWORK_BLOCKED', 'INVALID_FETCH_URL'].includes(error.code)) throw error;
        }
        if (rows.length >= Math.min(10, count)) break;
      }
      return rows;
    },
    async read(url, options = {}) {
      const data = await request('fetch', { url: publicUrl(String(url)) }, options);
      if (typeof data?.content !== 'string' || !data.content.trim())
        throw Object.assign(new Error('DeepSeek Fetch未取得正文'), { code: 'DEEPSEEK_FETCH_EMPTY', kind: 'api' });
      return (
        '# ' +
        String(data.title || '').slice(0, 200) +
        '\n\n' +
        data.content.slice(0, 60000) +
        (data.content.length > 60000 ? '\n（正文已截断，不能当作全文已读。）' : '')
      );
    }
  };
}

/** 用户主动点击后只测固定公开内容；每次最多两次请求，不经过模型或免费降级。 */
export async function testDeepseekSearch(cfg, kind, options = {}) {
  if (!['search', 'fetch'].includes(kind)) throw Object.assign(new Error('请选择Search或Fetch'), { kind: 'api', code: 'INVALID_SEARCH_TEST' });
  const client = createDeepseekSearch({ ...options, ...deepseekSearchOptions(cfg) });
  if (!client) throw Object.assign(new Error('请先保存并启用DeepSeek搜索'), { kind: 'api', code: 'DEEPSEEK_SEARCH_DISABLED' });
  let calls = 0;
  const consume = () => {
    if (++calls > 2) throw Object.assign(new Error('测试请求已达上限'), { code: 'RETRIEVAL_BUDGET', kind: 'budget' });
  };
  const started = Date.now();
  consume();
  const result =
    kind === 'search'
      ? await client.search('江苏省供销合作总社', 3, { ...options, consume })
      : await client.read('https://api-docs.deepseek.com/zh-cn/', { ...options, consume });
  return { kind, ms: Date.now() - started, requests: calls, count: kind === 'search' ? result.length : result.length };
}
