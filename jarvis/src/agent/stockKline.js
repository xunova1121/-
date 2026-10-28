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

/** 持仓用同来源、同复权的已结束日K；盘中最新价不冒充收盘，上一条缺失时不补0或猜日期。 */
export function completedStockCloses(rows, { start, end, adjustment = 'none', now = Date.now() } = {}) {
  const all = normalizeBars(rows);
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const completed = all.filter(bar => bar.close > 0 && bar.date <= today && (bar.date < today || now >= Date.parse(bar.date + 'T15:05:00+08:00')));
  const latest = completed.filter(bar => (!start || bar.date >= start) && (!end || bar.date <= end)).at(-1);
  const previous = latest && completed.filter(bar => bar.date < latest.date).at(-1);
  return {
    latestClose: latest?.close ?? null,
    previousClose: previous?.close ?? null,
    priceDate: latest?.date ?? null,
    previousPriceDate: previous?.date ?? null,
    priceState: latest ? 'completed_daily_bar' : 'missing_completed_bar',
    holdingCompatible: Boolean(latest && adjustment === 'none'),
    marketTimeZone: 'Asia/Shanghai',
    closeCutoff: '15:05 Asia/Shanghai',
    priceScope: 'latest_completed_bar_in_requested_range',
    previousCloseBasis: 'previous_available_daily_bar_same_source_and_adjustment'
  };
}

export function createStockKlineTool(ctx = {}) {
  const get = ctx.fetchViaGateway ?? ctx.fetchImpl ?? ((...args) => fetch(...args));
  return {
    name: 'get_stock_kline',
    description: '读取A股历史日K和程序计算的极值。回执latestClose/previousClose/priceDate分别为最新已结束日K收盘、上一条日K收盘及日期，缺项为null；给holding_profit映射price/prevClose/priceDate，按现金成本算盈亏须adjustment=none。今日盘中日K不冒充收盘；不等于实时成交价或完整历史。',
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
      const requestTime = typeof ctx.now === 'function' ? ctx.now() : Date.now();
      const providers = [
        {
          source: '腾讯行情',
          url: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + encodeURIComponent([symbol, 'day', start ?? '', end ?? '', Math.max(3, limit), mode].join(',')),
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
      const failedSources = [];
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
            ...completedStockCloses(rows, { start, end, adjustment, now: requestTime }),
            failedSources,
            fetchedAt: new Date().toISOString(),
            ...trimmed,
            providerRows: result.count,
            truncated: result.count > limit,
            note: '极值仅针对返回bars；停牌、上市日期、来源历史上限均可能影响覆盖。latestClose等字段只用同来源同复权的已结束日K（北京时间当日15:05前不采用当日条目），不等于实时成交价；previousClose是上一条可取得日K，缺失为null。复权价格不能直接和未复权现金成本混算。成交量沿用来源单位，未跨源混合；bars可能含今日盘中条目。'
          });
        } catch (error) {
          throwControl(error, signal);
          lastError = error;
          failedSources.push({ source: provider.source, code: String(error.code || error.name || 'MARKET_SOURCE_ERROR').slice(0, 80) });
        }
      }
      throw lastError ?? Object.assign(new Error('行情暂时不可用'), { code: 'NO_MARKET_DATA', kind: 'network' });
    }
  };
}
