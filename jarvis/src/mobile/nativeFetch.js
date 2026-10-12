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

const toB64 = (buf) => { const u8 = new Uint8Array(buf); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

/** FormData → CapacitorHttp 的 formData 格式 */
export async function formDataEntries(form) {
  const entries = [];
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') entries.push({ key, value, type: 'string' });
    else entries.push({ key, value: toB64(await value.arrayBuffer()), type: 'base64File', fileName: value.name || 'file', contentType: value.type || 'application/octet-stream' });
  }
  return { data: entries, dataType: 'formData' };
}

/** 原生请求 → 标准 Response */
export function nativeFetcher(http) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const signal = init.signal;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let data = init.body ?? undefined;
    let dataType;
    if (typeof FormData !== 'undefined' && data instanceof FormData) {
      // 上传文件（如语音转写）：转成原生插件认识的格式，文件内容用 Base64
      ({ data, dataType } = await formDataEntries(data));
      headers['content-type'] = 'multipart/form-data';
    } else if (data instanceof Blob || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      data = await new Response(data).text();
    }
    const req = http.request({ url, method: init.method || 'GET', headers, data, dataType, responseType: 'text', connectTimeout: 20000, readTimeout: 180000 });
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

/** 搜索、读网页用：系统原生网络 + 普通手机浏览器的请求头（不带请求头时有的网站会拦截或返回空页） */
export const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};
export function nativeWebFetch(native) {
  return (url, init = {}) => native(url, { ...init, headers: { ...(init.method && init.method !== 'GET' ? {} : BROWSER_HEADERS), ...(init.headers || {}) } });
}
