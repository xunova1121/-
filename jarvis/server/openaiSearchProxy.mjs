/** 自定义联网搜索的受限代理；登录令牌不出站，公网地址和正文均在请求前验证。 */
import { openaiSearchEndpoint } from '../src/agent/openaiSearch.js';
import { webBody } from '../src/agent/webBody.js';
import { abortableFetch } from '../src/core/abortableFetch.js';

const rejected = (status, code) => Object.assign(new Error('搜索代理拒绝请求'), { status, code });
const requestLimit = 32768;
const responseLimit = 2 * 1024 * 1024;

function requestBody(req, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = error => { cleanup(); reject(error); };
    const onError = () => fail(rejected(400, 'OPENAI_SEARCH_REQUEST'));
    const onAbort = () => fail(rejected(504, 'OPENAI_SEARCH_TIMEOUT'));
    const onData = chunk => {
      size += chunk.length;
      if (size > requestLimit) {
        req.pause();
        return fail(rejected(413, 'OPENAI_SEARCH_REQUEST_LIMIT'));
      }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => {
      cleanup();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || Array.isArray(body) || typeof body !== 'object' || body.stream === true)
          throw rejected(400, 'OPENAI_SEARCH_REQUEST');
        resolve(JSON.stringify(body));
      } catch { reject(rejected(400, 'OPENAI_SEARCH_REQUEST')); }
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
  });
}

export async function proxyOpenaiSearch(req, res, protocol, {
  json, fetchImpl, timeoutMs = 20000
} = {}) {
  if (req.method !== 'POST') return json(res, 405, { error: '只支持 POST', code: 'OPENAI_SEARCH_METHOD' });
  if (!['responses', 'chat-completions'].includes(protocol))
    return json(res, 404, { error: '不支持这个搜索接口', code: 'OPENAI_SEARCH_PROTOCOL' });
  const key = String(req.headers['x-jarvis-search-key'] || '').trim();
  if (!key || key.length > 4096 || /[\r\n\0]/.test(key))
    return json(res, 400, { error: '请配置独立的搜索 API Key', code: 'OPENAI_SEARCH_KEY' });
  let target;
  try { target = openaiSearchEndpoint(String(req.headers['x-jarvis-upstream'] || ''), protocol); }
  catch { return json(res, 400, { error: '搜索地址须为匹配协议的公网 HTTPS 接口', code: 'OPENAI_SEARCH_ADDRESS' }); }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);
  req.once('aborted', cancel);
  const timer = setTimeout(cancel, Math.min(20000, Math.max(1, timeoutMs)));
  let upstream;
  try {
    const body = await requestBody(req, controller.signal);
    // 沿用任务联网的 DNS 私网拦截；禁止任何重定向，不把凭据发往其他目标。
    const get = fetchImpl || (await import('./taskRunner.mjs')).publicFetch;
    upstream = await abortableFetch(get, target, {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body
    });
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      const upstreamStatus = upstream.status;
      const status = upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 502;
      return json(res, status, { error: '自定义搜索服务未完成请求', code: 'OPENAI_SEARCH_UPSTREAM', upstreamStatus });
    }
    const bytes = await webBody(upstream, responseLimit, controller.signal);
    controller.signal.throwIfAborted();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(Buffer.from(bytes));
  } catch (error) {
    if (res.destroyed) return;
    const status = controller.signal.aborted ? 504 : error.code === 'WEB_BODY_LIMIT' ? 413
      : error.code === 'PRIVATE_NETWORK_BLOCKED' ? 403 : [400, 413, 504].includes(error.status) ? error.status : 502;
    const code = controller.signal.aborted ? 'OPENAI_SEARCH_TIMEOUT'
      : ['WEB_BODY_LIMIT', 'PRIVATE_NETWORK_BLOCKED', 'REDIRECT_BLOCKED', 'OPENAI_SEARCH_REQUEST_LIMIT', 'OPENAI_SEARCH_REQUEST'].includes(error.code)
        ? error.code : 'OPENAI_SEARCH_PROXY';
    json(res, status, { error: '自定义搜索请求未完成，请检查搜索配置或稍后重试', code });
  } finally {
    clearTimeout(timer);
    res.off('close', cancel);
    req.off('aborted', cancel);
    await upstream?.body?.cancel().catch(() => {});
  }
}
