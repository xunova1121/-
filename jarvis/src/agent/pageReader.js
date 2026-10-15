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

  async function direct(url) {
    let res;
    try { res = await get(url); } catch (e) {
      throw new Error(fetchViaGateway ? `打不开（${e.message}）` : '浏览器无法直接读取该网站（跨域限制）');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (type && !/html|text|json|xml/.test(type)) throw new Error('不是网页');
    const body = decodeBody(new Uint8Array(await res.arrayBuffer()), type);
    return /html/.test(type) || (!type && /<html|<body/i.test(body)) ? htmlToText(body) : body;
  }

  async function extract(url) {
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tavilyKey}` }, body: JSON.stringify({ api_key: tavilyKey, urls: [url], extract_depth: 'basic', include_images: false }) };
    const res = await get('https://api.tavily.com/extract', init);
    if (!res.ok) throw new Error(`Tavily 返回 ${res.status}`);
    const j = await res.json();
    const text = String(j.results?.[0]?.raw_content || '').trim();
    if (!text) throw new Error(j.failed_results?.[0]?.error || 'Tavily 也没读到正文');
    return text;
  }

  return async function read(url) {
    const hit = cache.get(url);
    if (hit && now() - hit.at < CACHE_MS) return hit.text;
    let text = '';
    let err = null;
    try { text = await direct(url); } catch (e) { err = e; }
    if (tavilyKey && (err || text.replace(/\s+/g, '').length < THIN)) {
      try {
        const t = await extract(url);
        if (t.length > text.length) text = t;
        err = null;
      } catch (e) {
        if (err) throw new Error(`${err.message}；Tavily 代读也失败：${e.message}`);
      }
    }
    if (err) throw err;
    cache.set(url, { at: now(), text });
    if (cache.size > 60) cache.delete(cache.keys().next().value);
    return text;
  };
}
