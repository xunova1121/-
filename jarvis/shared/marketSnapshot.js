/** 行情卡只接收工具回执；不解析模型文字。历史附加数据独立于模型上下文。 */
export const MARKET_CARD_LIMIT = 4;
export const MARKET_QUOTE_LIMIT = 8;
export const MARKET_BAR_LIMIT = 60;
export const MARKET_SNAPSHOT_BYTES = 16 * 1024;
const words = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit) : '';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
function source(value) {
  const name = words(value?.name, 64), raw = words(value?.url, 512);
  if (!name || !raw || raw !== value.url) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return { name, url: raw };
  } catch { return null; }
}
function quote(value) {
  const symbol = words(value?.symbol, 40), name = words(value?.name, 80), from = source(value?.source);
  if (!symbol || !name || !from || !finite(value.price) || value.price <= 0) return null;
  return {
    symbol, name, price: value.price, unit: words(value.unit, 24), time: words(value.time, 64), source: from,
    ...Object.fromEntries(['change', 'changePct', 'prevClose', 'open', 'high', 'low'].filter(key => finite(value[key])).map(key => [key, value[key]])),
    ...(value.reference === true && { reference: true })
  };
}
/** 只保留绘图需要的原始日期和收盘价，不扩充、不插值、不把查询时间当行情时间。 */
export function normalizeMarketSnapshot(input) {
  if (!input || input.version !== 1 || !finite(input.fetchedAt) || input.fetchedAt <= 0 || input.fetchedAt > 8640000000000000) return null;
  const base = { version: 1, kind: input.kind, title: words(input.title, 96), fetchedAt: input.fetchedAt };
  const note = words(input.note, 240);
  if (note) base.note = note;
  if (input.kind === 'quote') {
    const quotes = (Array.isArray(input.quotes) ? input.quotes : []).slice(0, MARKET_QUOTE_LIMIT).map(quote).filter(Boolean);
    if (!quotes.length) return null;
    return { ...base, id: 'quote:' + quotes.map(row => row.symbol).join(','), quotes };
  }
  if (input.kind !== 'kline') return null;
  const symbol = words(input.symbol, 40), from = source(input.source);
  if (!symbol || !from || !Array.isArray(input.bars)) return null;
  const dates = new Set(), bars = [];
  for (const row of input.bars.slice(-MARKET_BAR_LIMIT)) {
    if (typeof row?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !finite(row.close) || row.close <= 0) return null;
    const date = new Date(row.date + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== row.date || dates.has(row.date)) return null;
    dates.add(row.date); bars.push({ date: row.date, close: row.close });
  }
  if (!bars.length) return null;
  bars.sort((a, b) => a.date.localeCompare(b.date));
  const adjustment = ['none', 'qfq', 'hfq'].includes(input.adjustment) ? input.adjustment : 'none';
  return { ...base, id: `kline:${symbol}:${adjustment}`, symbol, unit: words(input.unit, 24), source: from, adjustment, bars };
}
/** 整轮最多四张，合计不超过16KiB；同一对象保留较新的成功快照，不累积重复回执。 */
export function mergeMarketSnapshots(previous, incoming) {
  const cards = [];
  const candidates = [...(Array.isArray(previous) ? previous.slice(-MARKET_CARD_LIMIT) : []), ...(incoming ? [incoming] : [])];
  for (const value of candidates) {
    const clean = normalizeMarketSnapshot(value);
    if (!clean || size([clean]) > MARKET_SNAPSHOT_BYTES) continue;
    const index = cards.findIndex(card => card.id === clean.id);
    if (index >= 0) {
      if (cards[index].fetchedAt > clean.fetchedAt) continue;
      cards.splice(index, 1);
    }
    cards.push(clean);
    while (cards.length > MARKET_CARD_LIMIT || size(cards) > MARKET_SNAPSHOT_BYTES) cards.shift();
  }
  return cards;
}
