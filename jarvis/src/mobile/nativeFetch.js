/**
 * 安卓 App 的网络：先用 WebView 自己的 fetch（能流式显示回答）；
 * 服务商不允许网页跨域调用时（fetch 直接报 TypeError），改用系统原生网络请求（一次性拿到完整回答）。
 * 失败过的域名之后直接走原生网络，不再先试一次。
 */

/** 系统返回的响应头里可能有状态行（键为空）或不合规的名字 / 值，构造 Response 时会直接报错：只留合规的 */
export function safeHeaders(h = {}) {
  const out = new Headers();
  for (const [k, v] of Object.entries(h || {})) {
    if (!k || k === 'null' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) continue;
    try { out.append(k, String(v).replace(/[\r\n]+/g, ' ')); } catch { /* 跳过非法值 */ }
  }
  return out;
}

/** 原生请求 → 标准 Response */
export function nativeFetcher(http) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const signal = init.signal;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const req = http.request({ url, method: init.method || 'GET', headers, data: init.body ?? undefined, responseType: 'text', connectTimeout: 20000, readTimeout: 180000 });
    const res = await (signal ? Promise.race([req, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true }))]) : req);
    const body = typeof res.data === 'string' ? res.data : res.data == null ? '' : JSON.stringify(res.data);
    return new Response([204, 205, 304].includes(res.status) ? null : body, { status: res.status || 200, headers: safeHeaders(res.headers) });
  };
}

/**
 * @param {typeof fetch} webFetch WebView 自带 fetch
 * @param {typeof fetch} native   原生请求
 * @param {string} selfOrigin     App 自己的地址（这些请求不用换）
 */
export function wrapFetch(webFetch, native, selfOrigin, g = globalThis) {
  const nativeHosts = new Set();
  // 诊断用：这个地址最近走的是哪条网络
  g.__jarvisNetVia = (url) => { try { return nativeHosts.has(new URL(url).host) ? 'native' : 'web'; } catch { return 'web'; } };
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, selfOrigin);
    if (url.origin === selfOrigin || !/^https?:$/.test(url.protocol)) return webFetch(input, init);
    if (nativeHosts.has(url.host)) return native(url.href, init);
    try {
      return await webFetch(input, init);
    } catch (e) {
      if (e?.name === 'AbortError' || init.signal?.aborted || !(e instanceof TypeError)) throw e;
      nativeHosts.add(url.host);
      return native(url.href, init);
    }
  };
}
