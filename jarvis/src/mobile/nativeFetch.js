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

const b64ToBytes = (b64) => { const bin = atob(b64.replace(/\s+/g, '')); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
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
    // binary：读网页时要原始字节（GBK 等编码的中文站由调用方按网页声明的编码解码；原生按 UTF-8 读会把字读坏）
    const binary = Boolean(init.binary);
    const req = http.request({ url, method: init.method || 'GET', headers, data, dataType, responseType: binary ? 'arraybuffer' : 'text', connectTimeout: 20000, readTimeout: init.readTimeout || 180000 });
    const res = await (signal ? Promise.race([req, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true }))]) : req);
    // 原生插件：arraybuffer 时正文是 Base64；出错（4xx/5xx）或 JSON 时仍是文字 / 对象
    const body = binary && typeof res.data === 'string' && res.status < 400 ? b64ToBytes(res.data)
      : typeof res.data === 'string' ? res.data : res.data == null ? '' : JSON.stringify(res.data);
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
  return (url, init = {}) => {
    const get = !init.method || init.method === 'GET';
    // GET 是读网页 / 搜索结果页：要原始字节（编码由读取方判断），30 秒读不完就算打不开
    return native(url, { ...init, ...(get && { binary: true, readTimeout: 30000 }), headers: { ...(get ? BROWSER_HEADERS : {}), ...(init.headers || {}) } });
  };
}

/** 要边收边显示的请求：大模型的流式回答（请求里 stream: true，或要求 text/event-stream） */
export function wantsStream(init = {}) {
  if (typeof init.body !== 'string') return false;
  const accept = new Headers(init.headers || {}).get('accept') || '';
  return /text\/event-stream/i.test(accept) || /"stream"\s*:\s*true/.test(init.body);
}

/**
 * 边收边给的原生请求（NativeStream 插件）→ 标准 Response，body 是一边到一边读的流。
 * 插件事件：head（状态、响应头）→ data（Base64 片段）… → end / error
 */
export function nativeStreamFetcher(plugin) {
  let seq = 0;
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const id = `s${Date.now().toString(36)}${(seq++).toString(36)}`;
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let controller;
    let settled = false;
    const stream = new ReadableStream({ start(c) { controller = c; }, cancel() { plugin.cancel({ id }).catch(() => {}); off(); } });
    const subs = [];
    const off = () => { for (const s of subs) Promise.resolve(s).then((h) => h?.remove?.()).catch(() => {}); };
    return new Promise((resolve, reject) => {
      const fail = (err) => { if (!settled) { settled = true; reject(err); } try { controller.error(err); } catch { /* 已经关了 */ } off(); };
      const on = (name, fn) => subs.push(plugin.addListener(name, (e) => { if (e?.id === id) fn(e); }));
      on('head', (e) => {
        settled = true;
        resolve(new Response([204, 205, 304].includes(e.status) ? null : stream, { status: e.status || 200, headers: safeHeaders(e.headers) }));
      });
      on('data', (e) => { try { controller.enqueue(b64ToBytes(e.data || '')); } catch { /* 读的一方已经取消 */ } });
      on('end', () => { try { controller.close(); } catch { /* 已经关了 */ } off(); });
      on('error', (e) => fail(new TypeError(e.message || '网络请求失败')));
      init.signal?.addEventListener('abort', () => { plugin.cancel({ id }).catch(() => {}); fail(new DOMException('Aborted', 'AbortError')); }, { once: true });
      // 先把监听都挂好再发请求，免得最前面的事件漏掉
      Promise.all(subs)
        .then(() => plugin.start({ id, url, method: init.method || 'GET', headers, body: init.body }))
        .catch((e) => fail(e));
    });
  };
}

/**
 * 原生网络：流式回答走 NativeStream（边收边显示），其余（读网页、上传文件、普通接口）走原来的一次性请求。
 * 旧安装包没有 NativeStream 插件时，自动退回一次性请求。
 */
export function nativeRouter(native, stream) {
  let streamOk = Boolean(stream);
  return async (url, init = {}) => {
    if (!streamOk || !wantsStream(init)) return native(url, init);
    try {
      return await stream(url, init);
    } catch (e) {
      if (/not implemented|UNIMPLEMENTED|is not available/i.test(String(e?.message || e?.code || ''))) { streamOk = false; return native(url, init); }
      throw e;
    }
  };
}
