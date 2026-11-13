const plain = (text) => String(text).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** 仅返回可继续读取的链接，不自动打开。最多扫描500个锚点、返回30条，附件/机构栏目优先。 */
export function pageLinks(html, address) {
  const links = new Map();
  let scanned = 0;
  for (const anchor of String(html).matchAll(/<a\b([^>]{0,5000})>([\s\S]{0,2000}?)<\/a>/gi)) {
    if (++scanned > 500) break;
    const href = anchor[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const value = plain(href?.[1] ?? href?.[2] ?? href?.[3] ?? '');
    if (!value || value.startsWith('#')) continue;
    try {
      const url = new URL(value, address);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) continue;
      url.hash = '';
      if (url.href === address || links.has(url.href)) continue;
      const title = plain(anchor[2] || anchor[1].match(/title=["']([^"']*)/)?.[1] || url.pathname).slice(0, 120);
      if (!title) continue;
      const score = (/\.pdf(?:$|\?)/i.test(url.href) ? 5 : 0) + (/概况|职责|职能|简介|指南|申请|政策|通知|正文|全文|附件|下载|信息公开/.test(title) ? 3 : 0);
      links.set(url.href, { title, url: url.href, score });
    } catch { /* 忽略不能解析的网址，不执行页面脚本。 */ }
  }
  return [...links.values()].sort((a, b) => b.score - a.score).slice(0, 30).map(({ title, url }) => ({ title, url }));
}

export const LINK_MARKER = '\n\n【页面内链接（链接指向的内容尚未读取）】';
export function appendPageLinks(text, links) {
  return links.length ? text + LINK_MARKER + '\n' + links.map((link, index) => `${index + 1}. ${link.title} — ${link.url}`).join('\n') : text;
}

/** 主体较长时也给栏目/附件链接留位置，不能先裁正文时把链接列表全裁掉。 */
export function formatPageResult(text) {
  const [body, links] = String(text).split(LINK_MARKER);
  if (!links) return body.length > 15000 ? body.slice(0, 15000) + '\n（正文已截断）' : body;
  const selected = [];
  let length = 0;
  for (const line of links.split('\n').filter(Boolean)) {
    if (length + line.length > 7000) break;
    selected.push(line);
    length += line.length + 1;
  }
  return body.slice(0, 7500) + (body.length > 7500 ? '\n（正文已截断；证据缓存同样有长度上限）' : '') + LINK_MARKER + '\n' + selected.join('\n');
}
