import { decodeBody } from '../src/agent/pageReader.js';
import { webBody } from '../src/agent/webBody.js';
import { htmlToText } from '../src/agent/docs.js';
import { parseTenderListing, parseGgzyListing, ggzyBodyUrl } from '../src/agent/tenderNotices.js';
import { parseTenderFields } from '../src/agent/tenderFields.js';

// 固定公开列表，不借用模型、付费搜索或用户凭据；单源失败不影响其他来源。
export const TENDER_SOURCES = Object.freeze([
  { id: 'ccgp', label: '中国政府采购网', url: 'https://www.ccgp.gov.cn/cggg/', coverage: '采购公告公开列表及页面公开分页（每次最多3页）' },
  { id: 'ggzy', label: '全国公共资源交易平台', url: 'https://www.ggzy.gov.cn/', coverage: '首页公开交易公告；不代表全国全量公告' }
]);

/** 只解析网站实际声明的静态分页，禁止执行上游脚本或接受任意翻页地址。 */
export function ccgpPages(html, base) {
  const match = String(html).match(/Pager\(\{size:(\d+),\s*current:0,\s*prefix:'index',\s*suffix:'(htm|html)'/);
  if (!match) return [];
  return Array.from({ length: Math.max(0, Math.min(3, Number(match[1])) - 1) }, (_, i) => new URL(`index_${i + 1}.${match[2]}`, base).href);
}

export function createTenderCollector({ get, now = Date.now }) {
  async function html(url, parentSignal) {
    const signal = AbortSignal.any([parentSignal || new AbortController().signal, AbortSignal.timeout(10000)]);
    const res = await get(url, { signal, headers: { Accept: 'text/html' } });
    if (!res.ok) { await res.body?.cancel(); throw Object.assign(new Error('公开来源请求失败'), { code: 'TENDER_HTTP', status: res.status }); }
    return decodeBody(await webBody(res, 2 * 1024 * 1024, signal), res.headers.get('content-type'));
  }
  return {
    async listing(source, signal) {
      const first = await html(source.url, signal);
      const parse = source.id === 'ccgp' ? parseTenderListing : parseGgzyListing;
      const rows = parse(first, source.url);
      if (!rows.length) throw Object.assign(new Error('公开列表未解析出公告，可能是验证页面或结构变化'), { code: 'TENDER_LIST_FORMAT' });
      let partial = false;
      for (const page of source.id === 'ccgp' ? ccgpPages(first, source.url) : []) {
        try {
          const next = parse(await html(page, signal), page);
          if (!next.length) { partial = true; break; }
          rows.push(...next);
        }
        catch (error) { if (signal?.aborted) throw error; partial = true; break; }
      }
      return { rows, partial };
    },
    async detail(row, signal) {
      let body = await html(row.url, signal);
      const inner = ggzyBodyUrl(body, row.url);
      if (inner) body = await html(inner, signal);
      const text = htmlToText(body);
      if (text.length < 100 || !/采购需求|采购内容|招标内容|招标范围|投标人|供应商|更正内容|中标人|成交人/.test(text))
        throw Object.assign(new Error('未读取到公告正文'), { code: 'TENDER_NO_BODY' });
      // 类型和发布时间保留列表证据，不用抓取时间补日期。正文只补原文明示字段。
      return parseTenderFields(body, row, now());
    }
  };
}
