/** 统一外层条目，保留原工具全文供模型/卡片使用。没有发布时间就留null，不拿抓取时间冒充。 */
export function lookupReceiptItems(found, intent) {
  if (!found) return [];
  try {
    const data = JSON.parse(found.output);
    if (data.kind === 'today_news') return data.items || [];
    if (found.tool === 'get_stock_kline' && data.sourceUrl) return [{ title: `${data.symbol}日K`, url: data.sourceUrl,
      source: data.source, publishedAt: null, fetchedAt: data.fetchedAt, kind: intent.kind, category: '日K',
      summary: found.output, verified: 'api', latestClose: data.latestClose, previousClose: data.previousClose,
      priceDate: data.priceDate, previousPriceDate: data.previousPriceDate, adjustment: data.adjustment }];
    if (Array.isArray(data)) return data.slice(0, 24).filter(row => row.title && /^https?:\/\//.test(row.url)).map(row => ({
      title: row.title, url: row.url, source: row.source || '搜索摘要', publishedAt: row.publishedAt || null,
      kind: intent.kind, category: '搜索结果', summary: row.snippet || '', verified: 'index'
    }));
  } catch { /* 天气/赛程原回执为文字，保留真实来源文字，不推断新数字。 */ }
  const urls = [...String(found.output).matchAll(/https?:\/\/[^\s<>"）)]+/g)].map(match => match[0]);
  return [{ title: found.tool, url: urls[0] || null, source: String(found.output).match(/来源[：:]([^\n]+)/)?.[1] || found.tool,
    publishedAt: null, kind: intent.kind, category: intent.kind, summary: found.output,
    verified: found.tool === 'web_search' ? 'index' : 'api' }];
}
