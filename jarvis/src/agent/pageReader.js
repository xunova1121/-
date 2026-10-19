import { retryRead, throwControl, httpError } from '../core/networkRequest.js';
/**
 * 读网页正文：
 *   1. 先直接打开（桌面版经本机网关、手机 App 用系统网络、浏览器直连）
 *   2. 打不开（被拦、超时、HTTP 错误），或读出来几乎没字（靠脚本加载内容的页面），
 *      且填了 Tavily Key：改用 Tavily /extract 代读（基础档，每 5 个网页 1 个额度）
 * 同一个地址 15 分钟内再读直接用缓存（查证时几项常落到同一篇文章）。
 */
import { htmlToText } from './docs.js';

const CACHE_MS = 15 * 60e3;
const THIN = 300; // 正文少于这么多字（去掉空白）就当没读到

/**
 * 按网页声明的编码解码：不少中文站（彩票、论坛、老新闻站）还是 GBK / GB2312，
 * 一律按 UTF-8 读会变成乱码。先看响应头，再看网页开头的 <meta charset>，都没有就按 UTF-8
 */
export function decodeBody(bytes, contentType = '') {
  let cs = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!cs) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    cs = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] || /^<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1];
  }
  cs = String(cs || 'utf-8').toLowerCase();
  if (/^(gb2312|gbk|x-gbk|gb_2312-80)$/.test(cs)) cs = 'gb18030'; // GB18030 兼容前两者，且能解出更多字
  try { return new TextDecoder(cs).decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

/**
 * @param {{ tavilyKey?: string, fetchViaGateway?: (url: string, init?: object) => Promise<Response>, fetchImpl?: typeof fetch, now?: () => number }} o
 * @returns {(url: string) => Promise<string>}
 */
export function createPageReader({ tavilyKey, fetchViaGateway, fetchImpl = (...a) => globalThis.fetch(...a), now = Date.now } = {}) {
  const get = (url, init) => (fetchViaGateway ? fetchViaGateway(url, init) : fetchImpl(url, init));
  const cache = new Map();
  const failures = new Map();
  const blocked = new Map(); // 两次明确拒绝后暂不直抓该站；有代读服务仍可尝试代读

  async function direct(url, signal) {
    let res;
    try { res = await get(url, { signal }); } catch (e) {
      if (signal?.aborted) throw signal.reason;
      throw Object.assign(new Error('网页连接失败：' + e.message), { name: e.name === 'TimeoutError' ? 'TimeoutError' : 'NetworkError', cause: e, status: e.status, code: e.code, kind: e.kind || 'network' });
    }
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}${[401,403,429].includes(res.status) ? '（网站要求登录、验证或限制程序访问）' : res.status === 404 ? '（网页不存在或链接已失效）' : ''}`), { status: res.status });
    const type = res.headers.get('content-type') || '';
    if (type && !/html|text|json|xml/.test(type)) throw new Error('不是网页');
    const body = decodeBody(new Uint8Array(await res.arrayBuffer()), type);
    const text = /html/.test(type) || (!type && /<html|<body/i.test(body)) ? htmlToText(body) : body;
    if (text.replace(/\s+/g, '').length < 1000 && /请完成.{0,8}验证|访问过于频繁|访问异常|安全验证|verify you are human|just a moment|enable javascript and cookies/i.test(text)) throw Object.assign(new Error('网站返回验证页，未取得正文'), { status: 403 });
    if (!text.trim()) throw new Error('网页没有可读取正文，可能需要登录或运行页面脚本');
    return text;
  }

  async function extract(url, signal) {
    const init = { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tavilyKey}` }, body: JSON.stringify({ api_key: tavilyKey, urls: [url], extract_depth: 'basic', include_images: false }) };
    const res = await get('https://api.tavily.com/extract', init);
    if (!res.ok) throw httpError(res.status, '', 'Tavily');
    const j = await res.json();
    const text = String(j.results?.[0]?.raw_content || '').trim();
    if (!text) throw new Error(j.failed_results?.[0]?.error || 'Tavily 也没读到正文');
    return text;
  }

  return async function read(url, { signal, progress, consume } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('已停止读取网页'), { name: 'AbortError' });
    const hit = cache.get(url);
    if (hit && now() - hit.at < CACHE_MS) return hit.text;
    const failure = failures.get(url);
    if (failure && now() - failure.at < 60_000) throw Object.assign(new Error('该链接刚刚读取失败，暂不重复访问：' + failure.message), failure.type);
    let text = '';
    let err = null;
    const host = new URL(url).hostname;
    const state = blocked.get(host);
    try {
      if (state?.count >= 2 && now() - state.at < 10 * 60_000) throw new Error('该网站连续拒绝访问，暂时跳过直接读取，请换其他来源');
      text = await retryRead((s) => direct(url, s), { signal, timeoutMs: 4000, beforeAttempt: attempt => { if (attempt) consume?.('read'); } });
    } catch (e) {
      throwControl(e, signal);
      err = e;
      if ([401,403,429].includes(e.status)) blocked.set(host, { count: (state && now() - state.at < 10 * 60_000 ? state.count : 0) + 1, at: now() });
    }
    if (tavilyKey && (err || text.replace(/\s+/g, '').length < THIN)) {
      try {
        progress?.('直接读取未取得正文，尝试已配置的 Tavily 代读');
        const t = await retryRead((s) => extract(url, s), { signal, timeoutMs: 3000, beforeAttempt: () => consume?.('read') });
        if (t.length > text.length) text = t;
        err = null;
      } catch (e) {
        throwControl(e, signal);
        if (err) err = Object.assign(new Error(err.message + '；Tavily 代读也失败：' + e.message), { cause: err, kind: err.kind, status: err.status, code: err.code, name: err.name });
      }
    }
    if (err) {
      failures.set(url, { at: now(), message: err.message, type: { kind: err.kind, code: err.code, status: err.status, name: err.name } });
      if (failures.size > 60) failures.delete(failures.keys().next().value);
      if (blocked.size > 60) blocked.delete(blocked.keys().next().value);
      throw err;
    }
    cache.set(url, { at: now(), text });
    if (cache.size > 60) cache.delete(cache.keys().next().value);
    return text;
  };
}

