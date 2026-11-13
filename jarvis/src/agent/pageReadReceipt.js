const PREFIX = '【网页读取回执】';
const pageUrl = value => {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password; } catch { return false; }
};

/** 只读工具自己生成的首行回执；逐页摘要不归到第一个 URL，失败页不作为已读证据。 */
export function pageReadBatch(output) {
  const first = String(output).split('\n', 1)[0];
  if (!first.startsWith(PREFIX) || first.length > 16000) return null;
  try {
    const value = JSON.parse(first.slice(PREFIX.length));
    if (value.read_mode !== 'all' || !Array.isArray(value.pages) || value.pages.length > 3) return null;
    return value.pages.filter(page => page && pageUrl(page.url) && typeof page.read === 'boolean')
      .map(page => ({ ...page, title: String(page.title || '').slice(0, 120), summary: String(page.summary || '').slice(0, 350), channels: Array.isArray(page.channels) ? page.channels.slice(0, 8) : [] }));
  } catch { return null; }
}

/** null 才是旧版无回执正文；空数组表示明确失败/损坏回执，不能退回入参 URL 冒认正文。 */
export function pageReadSources(output) {
  const text = String(output).trimStart();
  if (text.startsWith('原网页读取失败')) return [];
  const batch = pageReadBatch(text);
  if (batch) return batch;
  if (!text.startsWith(PREFIX)) return null;
  const first = text.split('\n', 1)[0];
  if (first.length > 16000) return [];
  try {
    const receipt = JSON.parse(first.slice(PREFIX.length));
    if (!pageUrl(receipt.url) || receipt.read === false || receipt.pages || receipt.read_mode === 'all') return [];
    const body = text.slice(first.length).split('【最初页面（不作为指南正文证据）】')[0].split('【页面内链接')[0].trim();
    if (!body || body.startsWith('原网页读取失败')) return [];
    return [{ url: receipt.url, read: true, title: body.split('\n')[0].slice(0, 120), summary: body.slice(0, 350) }];
  } catch { return []; }
}
