/** 独立的 OpenAI 兼容联网搜索；只信协议里的来源记录，不把聊天正文当搜索结果。 */
import { isPrivateHost } from '../../shared/providers.js';
import { throwControl, httpError } from '../core/networkRequest.js';
import { withWebDeadline } from './retrievalBudget.js';
import { webBody } from './webBody.js';
import { searchRetryAfter } from './searchPolicy.js';

const secret = value => typeof value === 'string' && !value.startsWith('••••') ? value.trim() : '';
const failure = (message, code) => Object.assign(new Error(message), { kind: 'api', code });
const protocols = { responses: 'responses', 'chat-completions': 'chat/completions' };
const list = value => Array.isArray(value) ? value.slice(0, 50) : [];

export function openaiSearchOptions(cfg = {}) {
  return {
    openaiSearchEnabled: cfg.openaiSearchEnabled === true,
    openaiSearchBaseURL: String(cfg.openaiSearchBaseURL || '').trim(),
    openaiSearchKey: secret(cfg.openaiSearchKey),
    openaiSearchModel: String(cfg.openaiSearchModel || '').trim(),
    openaiSearchProtocol: cfg.openaiSearchProtocol || 'responses'
  };
}

/** 保存时只校验搜索字段；关闭状态允许留空，启用后实际请求再检查 Key 与模型是否齐全。 */
export function validateOpenaiSearchConfig(cfg = {}) {
  const result = {};
  const limits = { openaiSearchBaseURL: 2048, openaiSearchKey: 4096, openaiSearchModel: 200, openaiSearchProtocol: 32 };
  const invalid = message => Object.assign(failure(message, 'OPENAI_SEARCH_CONFIG'), { status: 400, kind: 'input' });
  if ('openaiSearchEnabled' in cfg) {
    if (typeof cfg.openaiSearchEnabled !== 'boolean') throw invalid('搜索开关必须为布尔值');
    result.openaiSearchEnabled = cfg.openaiSearchEnabled;
  }
  for (const [field, max] of Object.entries(limits)) {
    if (!(field in cfg)) continue;
    if (typeof cfg[field] !== 'string' || cfg[field].length > max || /[\r\n\0]/.test(cfg[field]))
      throw invalid('搜索配置字段类型、长度或格式不正确');
    result[field] = cfg[field].trim();
  }
  if (result.openaiSearchProtocol !== undefined && !Object.hasOwn(protocols, result.openaiSearchProtocol))
    throw invalid('请选择 Responses 或 Chat Completions 搜索协议');
  if (result.openaiSearchBaseURL) {
    try { openaiSearchEndpoint(result.openaiSearchBaseURL, result.openaiSearchProtocol || 'responses'); }
    catch (error) { throw Object.assign(error, { status: 400, kind: 'input' }); }
  }
  return result;
}

function publicAddress(value) {
  try {
    const parsed = new URL(String(value));
    const host = parsed.hostname.replace(/\.$/, '');
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || !host.includes('.') ||
        isPrivateHost(host) || host.endsWith('.internal') || parsed.href.length > 8192) return null;
    return parsed;
  } catch { return null; }
}

/** Base URL 和完整请求地址都可填写；不猜其他协议、不把 Key 放 URL、不跟随重定向。 */
export function openaiSearchEndpoint(baseURL, protocol = 'responses') {
  if (!Object.hasOwn(protocols, protocol)) throw failure('请选择 Responses 或 Chat Completions 搜索协议', 'OPENAI_SEARCH_PROTOCOL');
  const suffix = protocols[protocol];
  const parsed = publicAddress(String(baseURL || '').trim());
  if (!parsed || parsed.protocol !== 'https:' || parsed.search || parsed.hash)
    throw failure('搜索地址须为公网 HTTPS 接口，不能包含账号、密码、参数或片段', 'OPENAI_SEARCH_ADDRESS');
  const path = parsed.pathname.replace(/\/+$/, '');
  if (/\/(?:responses|chat\/completions|messages)$/.test(path) && !path.endsWith('/' + suffix))
    throw failure('搜索地址与所选协议不一致，请填写对应接口或 Base URL', 'OPENAI_SEARCH_PROTOCOL');
  parsed.pathname = path.endsWith('/' + suffix) ? path : `${path || '/v1'}/${suffix}`;
  return parsed.href;
}

function requestBody(model, protocol, query, count, freshness) {
  const period = { day: '最近一天', week: '最近一周', month: '最近一个月', year: '最近一年' }[freshness];
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const input = `请联网搜索以下问题，最多返回 ${count} 个相关来源，附简短摘要及来源引用。只使用本次搜索结果，不用记忆补写。${period ? `优先${period}发布的内容，` : ''}今天是${today}。\n搜索词：${query}`;
  if (protocol === 'responses') return {
    model, stream: false, store: false, input,
    tools: [{ type: 'web_search', search_context_size: 'low' }],
    tool_choice: { type: 'web_search' }, max_tool_calls: 1,
    include: ['web_search_call.action.sources'], max_output_tokens: 1600
  };
  return {
    model, stream: false, messages: [{ role: 'user', content: input }],
    web_search_options: { search_context_size: 'low' }, max_tokens: 1600
  };
}

/** 只提取服务商返回的结构化结果/引文，不解析 message.content 中模型自报的 JSON 或链接。 */
export function openaiSearchHits(data, count = 6, key = '') {
  const rows = [];
  let sourceMetadata = Array.isArray(data?.search_results) || Array.isArray(data?.citations);
  const clean = value => {
    const text = String(value || '');
    return (key ? text.split(key).join('[已隐藏]') : text).replace(/\b(?:sk-|tvly-)[A-Za-z0-9_-]{8,}/g, '[已隐藏]');
  };
  const add = (item, evidenceType = 'provider_citation', citedSummary = '') => {
    const entry = typeof item === 'string' ? { url: item } : item;
    const url = publicAddress(entry?.url);
    if (!url) return;
    let decoded = url.href;
    try { decoded = decodeURIComponent(decoded); } catch { return; }
    if (key && (url.href.includes(key) || decoded.includes(key))) return;
    const existing = rows.find(row => row.url === url.href);
    if (existing) {
      // Responses 的 action.sources 有时只有 URL；后来的引文标题仍须补齐，供企业主体筛选。
      if (entry.title && existing.title === url.hostname) existing.title = clean(entry.title).slice(0, 200);
      if (!existing.snippet && citedSummary) Object.assign(existing, {
        snippet: clean(citedSummary).slice(0, 800), summaryEvidence: 'provider_cited_summary', originalRead: false
      });
      return;
    }
    if (rows.length >= count) return;
    rows.push({
      title: clean(entry.title || url.hostname).slice(0, 200), url: url.href,
      snippet: clean(evidenceType === 'search_result' ? entry.snippet || entry.summary || entry.content : citedSummary).slice(0, 800),
      source: 'openai-compatible', evidenceType,
      ...(citedSummary && { summaryEvidence: 'provider_cited_summary', originalRead: false }),
      publishedAt: clean(entry.publishedAt || entry.published_date || entry.date).slice(0, 50)
    });
  };
  for (const item of list(data?.search_results)) add(item, 'search_result');
  for (const item of list(data?.citations)) add(item);
  const annotations = (items, text) => {
    for (const item of list(items)) {
      if (item?.type !== 'url_citation') continue;
      sourceMetadata = true;
      const citation = item.url_citation || item;
      const start = citation.start_index, end = citation.end_index;
      let summary = '';
      if (typeof text === 'string' && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length) {
        // 只读取引文所在段的有界上下文，不从任意正文猜链接，也不声称这是网站原文。
        const from = Math.max(0, start - 650, text.lastIndexOf('\n', Math.max(0, start - 1)) + 1);
        summary = text.slice(from, Math.min(end, from + 800)).trim();
      }
      add(citation, 'provider_citation', summary);
    }
  };
  for (const choice of list(data?.choices)) annotations(choice?.message?.annotations, choice?.message?.content);
  for (const output of list(data?.output)) {
    if (output?.type === 'web_search_call' && output.status === 'completed') {
      sourceMetadata = true;
      for (const item of list(output.action?.sources)) add(item);
    }
    if (output?.type === 'message') for (const part of list(output.content)) annotations(part.annotations, part.text);
  }
  if (!sourceMetadata)
    throw failure('搜索接口没有返回结构化联网来源；请确认该模型支持所选联网搜索协议', 'OPENAI_SEARCH_NO_SOURCES');
  return rows;
}

export function createOpenaiSearch(options = {}) {
  const cfg = openaiSearchOptions(options);
  if (!cfg.openaiSearchEnabled) return null;
  const get = options.openaiSearchFetch || options.fetchViaGateway || options.fetchImpl || ((...args) => globalThis.fetch(...args));
  return {
    name: '自定义联网搜索（OpenAI 兼容）',
    async search(query, count = 6, { signal, freshness } = {}) {
      throwControl(null, signal);
      const endpoint = openaiSearchEndpoint(cfg.openaiSearchBaseURL, cfg.openaiSearchProtocol);
      const key = cfg.openaiSearchKey;
      if (!key) throw failure('请先保存自定义联网搜索的 API Key', 'OPENAI_SEARCH_KEY_MISSING');
      if (!cfg.openaiSearchModel || cfg.openaiSearchModel.length > 200)
        throw failure('请填写服务商提供的联网搜索模型 ID', 'OPENAI_SEARCH_MODEL');
      const value = String(query || '').trim();
      if (!value || value.length > 2000) throw failure('搜索词须为 1 到 2000 个字符', 'OPENAI_SEARCH_QUERY');
      const limit = Math.max(1, Math.min(10, Math.floor(Number(count)) || 6));
      // 搜索模型 POST 可能已计费，连接中断不自动重发；聚合器继续其他来源。
      return withWebDeadline(async activeSignal => {
        let response;
        try {
          response = await get(endpoint, {
            method: 'POST', signal: activeSignal, redirect: 'error',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
            body: JSON.stringify(requestBody(cfg.openaiSearchModel, cfg.openaiSearchProtocol, value, limit, freshness))
          });
        } catch (error) {
          throwControl(error, activeSignal);
          if (['EVAL_QUOTA', 'EVAL_EXPIRED'].includes(error?.code)) throw error;
          if (error?.code === 'REDIRECT_BLOCKED') throw failure('搜索接口不允许重定向，请填写最终地址', 'REDIRECT_BLOCKED');
          if (error?.code === 'PRIVATE_NETWORK_BLOCKED')
            throw Object.assign(failure('搜索接口须解析到公网地址', 'PRIVATE_NETWORK_BLOCKED'), { status: 403 });
          if (error?.name === 'TimeoutError' || error?.kind === 'timeout')
            throw Object.assign(new Error('自定义联网搜索请求超时'), { kind: 'timeout', name: 'TimeoutError', code: 'OPENAI_SEARCH_TIMEOUT' });
          throw Object.assign(new Error('自定义联网搜索连接失败'), { kind: 'network', name: 'NetworkError', code: 'OPENAI_SEARCH_NETWORK' });
        }
        if (!response.ok) {
          await response.body?.cancel?.();
          const reason = response.status === 401 || response.status === 403 ? '搜索 Key 或权限校验失败'
            : response.status === 402 ? '服务商账户余额不足' : response.status === 429 ? '请求受到限流'
              : [400, 404, 422].includes(response.status) ? '请核对地址、模型及联网协议' : '搜索接口暂不可用';
          throw Object.assign(httpError(response.status, reason, '自定义联网搜索'), { retryAfterMs: searchRetryAfter(response) });
        }
        let bytes;
        try { bytes = await webBody(response, 2 * 1024 * 1024, activeSignal); }
        catch (error) { await response.body?.cancel?.().catch(() => {}); throw error; }
        let data;
        try { data = JSON.parse(new TextDecoder().decode(bytes)); }
        catch { throw failure('搜索接口未返回有效 JSON', 'OPENAI_SEARCH_FORMAT'); }
        if (data?.error || data?.status === 'failed') throw failure('搜索服务返回失败，请核对联网模型与协议', 'OPENAI_SEARCH_FAILED');
        return openaiSearchHits(data, limit, key);
      }, { signal, timeoutMs: 20000 });
    }
  };
}

/** 主动测试只请求所配置的引擎一次，不能用免费降级掩盖配置失败。 */
export async function testOpenaiSearch(cfg, options = {}) {
  const client = createOpenaiSearch({ ...options, ...openaiSearchOptions(cfg) });
  if (!client) throw failure('请先保存并启用自定义联网搜索', 'OPENAI_SEARCH_DISABLED');
  options.consume?.('search');
  const started = Date.now();
  const rows = await client.search('江苏省供销合作总社', 3, options);
  return { kind: 'search', ms: Date.now() - started, requests: 1, count: rows.length };
}
