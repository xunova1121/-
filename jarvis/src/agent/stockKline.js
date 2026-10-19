import { retryRead, httpError, throwControl } from '../core/networkRequest.js';

const invalid = (message) => Object.assign(new Error(message), { name: 'ValidationError', code: 'INVALID_STOCK_INPUT' });
export function stockSymbol(code) {
  const value = String(code ?? '')
    .trim()
    .toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(value)) return value;
  if (!/^\d{6}$/.test(value)) throw invalid('请提供六位证券代码，不凭名称猜测代码');
  if (/^6/.test(value)) return 'sh' + value;
  if (/^[03]/.test(value)) return 'sz' + value;
  if (/^[48]|^92/.test(value)) return 'bj' + value;
  throw invalid('证券市场不明确，请提供sh/sz/bj前缀');
}

function day(value) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ||
    !Number.isFinite(Date.parse(value + 'T00:00:00Z')) ||
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value
  )
    throw invalid('日期无效，需要YYYY-MM-DD');
  return value;
}

export function normalizeBars(rows) {
  const seen = new Set();
  const bars = [];
  for (const row of rows ?? []) {
    const data = Array.isArray(row)
      ? { date: row[0], open: row[1], close: row[2], high: row[3], low: row[4], volume: row[5] }
      : { date: String(row.day ?? row.date).slice(0, 10), open: row.open, close: row.close, high: row.high, low: row.low, volume: row.volume };
    day(data.date);
    for (const key of ['open', 'close', 'high', 'low', 'volume']) {
      data[key] = Number(data[key]);
      if (!Number.isFinite(data[key]) || data[key] < 0) throw invalid('行情包含非法数值');
    }
    if (data.low > Math.min(data.open, data.close) || data.high < Math.max(data.open, data.close) || data.high < data.low)
      throw invalid('行情高低价与开收盘矛盾');
    if (seen.has(data.date)) throw invalid('行情日期重复');
    seen.add(data.date);
    bars.push(data);
  }
  return bars.sort((left, right) => left.date.localeCompare(right.date));
}

export function summarizeKline(rows, { start, end } = {}) {
  const all = normalizeBars(rows);
  const bars = all.filter((bar) => (!start || bar.date >= start) && (!end || bar.date <= end));
  if (!bars.length) throw Object.assign(new Error('指定范围没有取得日K数据，不代表该证券没有交易'), { code: 'NO_MARKET_DATA', kind: 'api' });
  const highest = Math.max(...bars.map((bar) => bar.high));
  const lowest = Math.min(...bars.map((bar) => bar.low));
  return {
    bars,
    count: bars.length,
    highest,
    highestDates: bars.filter((bar) => bar.high === highest).map((bar) => bar.date),
    lowest,
    lowestDates: bars.filter((bar) => bar.low === lowest).map((bar) => bar.date),
    range: { first: bars[0].date, last: bars.at(-1).date },
    coverage: start && all[0]?.date > start ? 'start_not_covered_check_listing_or_provider_limit' : 'returned_records_only'
  };
}

export function createStockKlineTool(ctx = {}) {
  const get = ctx.fetchViaGateway ?? ctx.fetchImpl ?? ((...args) => fetch(...args));
  return {
    name: 'get_stock_kline',
    description: '读取A股历史日K，JS计算返回记录内最高/最低及日期。需六位证券代码；明确复权方式和实际覆盖范围，不等于实时成交价或完整上市历史。',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        adjustment: { type: 'string', enum: ['none', 'qfq', 'hfq'] },
        limit: { type: 'integer', minimum: 1, maximum: 120 }
      },
      required: ['code'],
      additionalProperties: false
    },
    run: async ({ code, start, end, adjustment = 'none', limit = 60 }, { signal, retrieval } = {}) => {
      const symbol = stockSymbol(code);
      if (start) day(start);
      if (end) day(end);
      if (start && end && start > end) throw invalid('开始日期不能晚于结束日期');
      if (!['none', 'qfq', 'hfq'].includes(adjustment) || !Number.isInteger(limit) || limit < 1 || limit > 120) throw invalid('复权方式或条数不合法');
      const mode = adjustment === 'none' ? '' : adjustment;
      const providers = [
        {
          source: '腾讯行情',
          url: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + encodeURIComponent([symbol, 'day', start ?? '', end ?? '', limit, mode].join(',')),
          parse: (text) => {
            const response = JSON.parse(text);
            const data = response.data?.[symbol];
            // 不允许请求前复权却偷偷使用未复权字段。
            return data?.[mode ? mode + 'day' : 'day'] ?? [];
          }
        }
      ];
      if (adjustment === 'none')
        providers.push({
          source: '新浪行情',
          url: 'https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_k=/CN_MarketDataService.getKLineData?symbol=' + symbol + '&scale=240&ma=no&datalen=1023',
          parse: (text) => {
            const array = text.match(/\[[\s\S]*\]/)?.[0];
            return array ? JSON.parse(array) : [];
          }
        });
      let lastError;
      for (const provider of providers) {
        try {
          const rows = await retryRead(
            async (requestSignal) => {
              const response = await get(provider.url, { signal: requestSignal });
              if (!response.ok) throw httpError(response.status, '', provider.source);
              return provider.parse(await response.text());
            },
            { signal, timeoutMs: 5000, beforeAttempt: () => retrieval?.consume('read') }
          );
          const result = summarizeKline(rows, { start, end });
          const requested = result.bars.slice(-limit);
          const trimmed = summarizeKline(requested, { start, end });
          return JSON.stringify({
            symbol,
            source: provider.source,
            sourceUrl: provider.url,
            adjustment,
            fetchedAt: new Date().toISOString(),
            ...trimmed,
            providerRows: result.count,
            truncated: result.count > limit,
            note: '极值仅针对返回bars；停牌、上市日期、接口历史上限均可能影响覆盖。成交量沿用来源单位，未跨源混合；今日数据可能仍在变化。'
          });
        } catch (error) {
          throwControl(error, signal);
          lastError = error;
        }
      }
      throw lastError ?? Object.assign(new Error('行情暂时不可用'), { code: 'NO_MARKET_DATA', kind: 'network' });
    }
  };
}
