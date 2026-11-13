/**
 * 实时报价：个股（A股按名字也行）、港股美股、港美指数、金价、汇率。
 * 用户 2026-11-03：“金价/汇率/茅台股价/港美股”原先只能搜文章再找数字，常是旧文或自媒体观点。
 * 改为先取免费公开行情接口，全部失败才由查询流程退回搜索。来源：
 *   腾讯行情 qt.gtimg.cn（A/港/美股与指数，GBK 文本）；腾讯 smartbox（名字→代码）；
 *   东方财富 push2（金价、汇率、港美指数备用；fltt=2 直接给小数）；open.er-api.com（每日参考汇率，备用）。
 * 新浪行情要带 Referer，经网关转发会被丢掉，不用。接口格式按公开惯例解析，逐项校验，不合格就当没取到。
 */
import { shortSourceRetry } from './lookup/sourceRetry.js';
import { httpError, throwControl } from '../core/networkRequest.js';
import { normalizeMarketSnapshot } from '../../shared/marketSnapshot.js';

const invalid = message => Object.assign(new Error(message), { name: 'ValidationError', code: 'INVALID_QUOTE_INPUT' });
const num = value => (value === '' || value === null || value === undefined || value === '-' ? NaN : Number(value));

// 港美指数：腾讯代码 + 东方财富备用 secid
const INDEXES = [
  { test: /恒生科技|恒科/, name: '恒生科技指数', tencent: ['hkHSTECH'], east: '124.HSTECH' },
  { test: /国企指数|恒生中国企业/, name: '恒生中国企业指数', tencent: ['hkHSCEI'], east: '100.HSCEI' },
  { test: /恒生|恒指|港股大盘|港股指数/, name: '恒生指数', tencent: ['hkHSI'], east: '100.HSI' },
  { test: /纳斯达克|纳指/, name: '纳斯达克综合指数', tencent: ['usIXIC', 'us.IXIC'], east: '100.NDX' },
  { test: /道琼斯|道指/, name: '道琼斯工业指数', tencent: ['usDJI', 'us.DJI'], east: '100.DJIA' },
  { test: /标普|标准普尔/, name: '标普500指数', tencent: ['usINX', 'us.INX'], east: '100.SPX' },
  { test: /日经/, name: '日经225指数', tencent: [], east: '100.N225' }
];
// 只问“港股/美股怎么样”：给一组主要指数
const INDEX_GROUPS = { 港股: ['恒生指数', '恒生科技指数'], 美股: ['道琼斯工业指数', '纳斯达克综合指数', '标普500指数'] };
const CURRENCIES = [
  ['美元', 'USD'], ['欧元', 'EUR'], ['日元', 'JPY'], ['英镑', 'GBP'], ['港币', 'HKD'], ['港元', 'HKD'],
  ['澳元', 'AUD'], ['加元', 'CAD'], ['瑞郎', 'CHF'], ['新加坡元', 'SGD'], ['韩元', 'KRW'], ['泰铢', 'THB'], ['卢布', 'RUB']
];
const GOLD = /金价|黄金|金条|au9999|伦敦金|国际金/i;
const FX = /汇率|兑人民币|兑换人民币|人民币兑|(?:美元|欧元|日元|英镑|港币|港元|澳元|加元|瑞郎|新加坡元|韩元|泰铢|卢布)(?:多少|价格|行情|今天|现在|最新|$)/;
// 问法里的客气话、时间词、行情词，去掉后剩下的就是名字
const FILLER = /今天|今日|现在|目前|当前|最新|实时|刚才|最近|帮我|给我|查一?下|查询|查查|查|看一?下|看看|告诉我|一下|多少钱?|多少|是多少|怎么样|如何|咋样|情况|走势|表现|行情|报价|价格|价位|股价|股票|个股|涨跌幅?|涨了|跌了|涨没涨|收盘价?|开盘价?|的|了|吗|呢|啊|呀|[？?。！!，,、\s]/g;

/** 从一句话里认出要报价的对象；认不出返回 null（交给搜索）。 */
export function quoteTarget(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 60) return null;
  if (/油价|汽油|柴油|比特币|币价|以太坊|基金净值|房价/.test(value)) return null;
  if (GOLD.test(value)) return { kind: 'gold', target: '金价' };
  const currency = CURRENCIES.find(([word]) => value.includes(word));
  if (FX.test(value) || currency && /汇率|兑/.test(value)) return currency ? { kind: 'fx', target: currency[1] } : { kind: 'fx', target: 'USD' };
  const index = INDEXES.find(row => row.test.test(value));
  if (index) return { kind: 'index', target: index.name };
  const code = value.match(/(?<![A-Za-z\d])((?:sh|sz|bj)\d{6}|\d{6}|hk\d{5}|us[A-Z][A-Z.]{0,7})(?![A-Za-z\d])/)?.[1];
  if (code) return { kind: 'stock', target: code };
  const rest = value.replace(FILLER, '').replace(/大盘|指数|市场|整体/g, '');
  if (INDEX_GROUPS[rest]) return { kind: 'index', target: rest };
  const name = value.replace(/港股|美股|A股/g, '').replace(FILLER, '').trim();
  return name.length >= 2 && name.length <= 12 && /股价|股票|行情|报价|涨|跌|收盘|开盘|多少钱/.test(value) ? { kind: 'stock', target: name } : null;
}

/** 腾讯行情一行：v_sh600519="1~贵州茅台~600519~现价~昨收~今开~…"，第30项时间、31涨跌、32涨跌幅、33最高、34最低 */
export function parseTencentQuote(text) {
  const rows = [];
  for (const match of String(text).matchAll(/v_([A-Za-z0-9_.]+)="([^"]*)"/g)) {
    const f = match[2].split('~');
    if (f.length < 35) continue;
    const price = num(f[3]), prevClose = num(f[4]);
    if (!f[1] || !(price > 0) || !(prevClose > 0)) continue;
    const high = num(f[33]), low = num(f[34]);
    rows.push({
      symbol: match[1], name: f[1], price, prevClose, open: num(f[5]) > 0 ? num(f[5]) : null,
      change: Number.isFinite(num(f[31])) ? num(f[31]) : +(price - prevClose).toFixed(4),
      changePct: Number.isFinite(num(f[32])) ? num(f[32]) : +((price - prevClose) / prevClose * 100).toFixed(2),
      ...(high > 0 && low > 0 && high >= low && { high, low }),
      time: tencentTime(f[30])
    });
  }
  return rows;
}
function tencentTime(value) {
  const raw = String(value || '').trim();
  const digits = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (digits) return `${digits[1]}-${digits[2]}-${digits[3]} ${digits[4]}:${digits[5]}:${digits[6]}`;
  return /^\d{4}[-/]\d{2}[-/]\d{2}/.test(raw) ? raw.replace(/\//g, '-').slice(0, 19) : null;
}

/** 腾讯 smartbox：v_hint="sh~600519~贵州茅台~gzmt~GP-A^hk~00700~..." → 行情代码 */
export function parseTencentSuggest(text) {
  const body = String(text).match(/v_hint="([^"]*)"/)?.[1];
  if (!body || body === 'N') return [];
  let decoded = body;
  try { decoded = JSON.parse(`"${body.replace(/"/g, '\\"')}"`); } catch { /* 已是明文 */ }
  return decoded.split('^').map(item => item.split('~')).filter(f => f.length >= 5 && /^(?:GP|ZS|ETF|LOF)/.test(f[4])).map(([market, code, name, , type]) => ({
    symbol: market === 'us' ? 'us' + code.split('.')[0].toUpperCase() : market + code, name, type
  })).filter(row => /^(?:sh|sz|bj)\d{6}$|^hk\d{5}$|^hk[A-Z]+$|^us[A-Z.]+$/.test(row.symbol));
}

/** 东方财富 push2（fltt=2）：f43最新 f44最高 f45最低 f46今开 f58名称 f60昨收 f86时间戳(秒) f169涨跌 f170涨跌幅 */
export function parseEastQuote(text, secid) {
  const data = JSON.parse(text)?.data;
  const price = num(data?.f43), prevClose = num(data?.f60);
  if (!data?.f58 || !(price > 0) || !(prevClose > 0)) return null;
  const high = num(data.f44), low = num(data.f45);
  return {
    symbol: secid, name: String(data.f58), price, prevClose, open: num(data.f46) > 0 ? num(data.f46) : null,
    change: Number.isFinite(num(data.f169)) ? num(data.f169) : +(price - prevClose).toFixed(4),
    changePct: Number.isFinite(num(data.f170)) ? num(data.f170) : +((price - prevClose) / prevClose * 100).toFixed(2),
    ...(high > 0 && low > 0 && high >= low && { high, low }),
    time: num(data.f86) > 0 ? new Date(num(data.f86) * 1000 + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19) : null
  };
}

const unitOf = symbol => /^(?:sh|sz|bj)\d/.test(symbol) && !/^(?:sh000|sz399)/.test(symbol) ? '元' : /^hk\d/.test(symbol) ? '港元' : /^us[A-Z]/.test(symbol) && !/^us\.?(?:IXIC|DJI|INX)$/.test(symbol) ? '美元' : '';
const sign = value => (value > 0 ? '+' : '') + value;
const beijingNow = now => new Date(now + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);

export function quoteLine(row) {
  const unit = row.unit ?? unitOf(row.symbol);
  const range = row.high ? `；最高 ${row.high}，最低 ${row.low}` : '';
  return `${row.name}（${row.symbol}）：${row.price}${unit ? ' ' + unit : ''}，较昨收${row.changePct >= 0 ? '涨' : '跌'} ${Math.abs(row.changePct)}%（${sign(+Number(row.change).toFixed(4))}）${row.open ? `；今开 ${row.open}` : ''}${range}${row.time ? `；行情时间 ${row.time}` : ''}`;
}

export function createMarketQuoteTool(ctx = {}) {
  const get = ctx.fetchViaGateway ?? ctx.fetchImpl ?? ((...args) => fetch(...args));
  const nowFn = typeof ctx.now === 'function' ? ctx.now : Date.now;
  async function read(url, { signal, retrieval, source, gbk = false, onConnected }) {
    return shortSourceRetry(async requestSignal => {
      retrieval?.consume('read');
      const response = await get(url, { signal: requestSignal });
      if (!response.ok) throw httpError(response.status, '', source);
      if (!gbk || typeof response.arrayBuffer !== 'function') {
        const text = await response.text();
        onConnected?.();
        return text;
      }
      const bytes = await response.arrayBuffer();
      onConnected?.();
      // 腾讯接口一般是 GBK；经网关或手机原生网络可能已转成 UTF-8。先严格按 UTF-8 解，不合法再按 GBK
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* 不是 UTF-8 */ }
      try { return new TextDecoder('gbk').decode(bytes); } catch { return new TextDecoder().decode(bytes); }
    // 用户国内服务器2026-11-03实测每日汇率约4.1秒，原3.5秒会过早中止；仍受整轮预算约束。
    }, { signal, ...(source === '参考汇率' && { firstMs: 6000, retryMs: 1000 }) });
  }
  return {
    name: 'get_market_quote',
    description: '取实时报价（免费公开行情接口，可能延迟几秒到15分钟）：A股（代码或名字，如“茅台”）、港股（hk00700/腾讯控股）、美股（usAAPL/苹果）、港美日指数（恒生、纳斯达克、道琼斯、标普、日经）、金价（上海金Au99.99元/克、伦敦金美元/盎司）、汇率（美元/欧元/日元等兑人民币）。A股历史日K、持仓盈亏仍用get_stock_kline。油价、比特币不在范围内，用搜索。回执带来源链接和行情时间，照实写，不补没取到的数字。',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string', description: '要查的对象：股票名字或代码、指数名、“金价”，或货币代码如USD/EUR/JPY' } },
      required: ['target'],
      additionalProperties: false
    },
    run: async ({ target } = {}, { signal, retrieval } = {}) => {
      const value = String(target || '').trim().slice(0, 40);
      if (!value) throw invalid('请说明要查哪只股票、哪个指数、金价还是哪种货币的汇率');
      const parsed = quoteTarget(value) || (/^[A-Z]{3}$/.test(value) ? { kind: 'fx', target: value } : { kind: 'stock', target: value });
      const failed = [];
      const sourceFailures = [];
      let connected = false;
      const onConnected = () => { connected = true; };
      const rows = [];
      const sources = [];
      const tencent = async symbols => {
        const url = 'https://qt.gtimg.cn/q=' + symbols.join(',');
        const list = parseTencentQuote(await read(url, { signal, retrieval, source: '腾讯行情', gbk: true, onConnected }));
        if (list.length) sources.push('腾讯行情 ' + url);
        return list.map(row => ({ ...row, source: { name: '腾讯行情', url } }));
      };
      const east = async (secid, extra = {}) => {
        const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fltt=2&invt=2&fields=f43,f44,f45,f46,f58,f60,f86,f169,f170`;
        const row = parseEastQuote(await read(url, { signal, retrieval, source: '东方财富行情', onConnected }), secid);
        if (row) { rows.push({ ...row, ...extra, source: { name: '东方财富行情', url } }); sources.push('东方财富行情 ' + url); }
        return row;
      };
      const tryStep = async (label, work) => {
        try {
          const value = await work();
          if (!value || Array.isArray(value) && !value.length) sourceFailures.push({ source: label, code: 'EMPTY_OR_UNRECOGNIZED' });
          return value;
        } catch (error) {
          throwControl(error, signal);
          const code = String(error.cause?.code || error.code || error.status || error.name || '失败').slice(0, 60);
          sourceFailures.push({ source: label, code });
          failed.push(label + '：' + code);
          return null;
        }
      };
      let note = '免费公开行情接口，可能延迟几秒到15分钟，不是交易所逐笔成交。';
      if (parsed.kind === 'gold') {
        await tryStep('上海金', () => east('118.AU9999', { name: '上海黄金交易所 Au99.99', unit: '元/克' }));
        await tryStep('伦敦金', () => east('122.XAU', { name: '伦敦金（现货）', unit: '美元/盎司' }));
        note += '金店零售价通常比上海金高出几十元/克（含加工费、品牌溢价），以门店报价为准。';
      } else if (parsed.kind === 'fx') {
        const code = parsed.target;
        // 先取离岸人民币实时价（东方财富），再用每日参考汇率兜底
        const live = await tryStep('东方财富外汇', () => east(`133.${code}CNH`, { name: `${code}/人民币（离岸）`, unit: '' }));
        if (!live) await tryStep('参考汇率', async () => {
          const url = `https://open.er-api.com/v6/latest/${code}`;
          const data = JSON.parse(await read(url, { signal, retrieval, source: '参考汇率', onConnected }));
          const rate = Number(data?.rates?.CNY);
          if (data?.result !== 'success' || !(rate > 0)) throw Object.assign(new Error('参考汇率无效'), { code: 'NO_MARKET_DATA' });
          rows.push({ symbol: code + 'CNY', name: `1 ${code} 兑人民币（每日参考价）`, price: +rate.toFixed(4), prevClose: null, change: null, changePct: null, time: String(data.time_last_update_utc || '').slice(0, 25), unit: '元', reference: true, source: { name: 'ExchangeRate-API', url } });
          sources.push('ExchangeRate-API ' + url);
          note = '每日参考汇率（一天更新一次），不是实时成交价；银行买卖价以银行牌价为准。';
        });
        if (live) note += '离岸人民币（CNH）和在岸（CNY）通常相差很小；银行买卖价以银行牌价为准。';
      } else if (parsed.kind === 'index') {
        for (const name of INDEX_GROUPS[parsed.target] || [parsed.target]) {
          const index = INDEXES.find(row => row.name === name);
          let got = null;
          for (const symbol of index.tencent) {
            got = await tryStep(index.name + '（腾讯行情）', async () => (await tencent([symbol]))[0]);
            if (got) { rows.push({ ...got, name: got.name || index.name }); break; }
          }
          if (!got) await tryStep(index.name + '（东方财富行情）', () => east(index.east, { name: index.name }));
        }
      } else {
        const raw = parsed.target;
        let symbol = '';
        if (/^(?:sh|sz|bj)\d{6}$|^hk\d{5}$/i.test(raw)) symbol = raw.toLowerCase();
        else if (/^us[A-Za-z][A-Za-z.]*$/.test(raw)) symbol = 'us' + raw.slice(2).toUpperCase();
        else if (/^\d{6}$/.test(raw)) symbol = (/^[65]/.test(raw) ? 'sh' : /^[48]|^92/.test(raw) ? 'bj' : 'sz') + raw;
        if (!symbol) {
          const url = 'https://smartbox.gtimg.cn/s3/?v=2&t=all&q=' + encodeURIComponent(parsed.target);
          const hits = await tryStep('名字查代码', async () => parseTencentSuggest(await read(url, { signal, retrieval, source: '腾讯代码查询', gbk: true, onConnected })));
          symbol = hits?.[0]?.symbol || '';
          if (!symbol && !failed.length) throw invalid(`没找到“${parsed.target}”对应的股票，请给出代码或完整名称`);
        }
        if (symbol) {
          const got = await tryStep('腾讯行情', async () => (await tencent([symbol]))[0]);
          if (got) rows.push(got);
        }
      }
      if (!rows.length) throw Object.assign(new Error(`报价来源都没取到数据（${failed.join('；') || '无结果'}）`), { code: 'NO_MARKET_DATA', kind: connected ? 'data' : 'network', connected, sourceFailures });
      throwControl(null, signal);
      const snapshot = normalizeMarketSnapshot({
        version: 1, kind: 'quote', title: parsed.kind === 'gold' ? '黄金行情' : parsed.kind === 'fx' ? '汇率行情' : '市场行情', fetchedAt: nowFn(), note,
        quotes: rows.map(row => ({ ...row, unit: row.unit || (parsed.kind === 'index' ? '点' : parsed.kind === 'fx' ? `CNH/${parsed.target}` : unitOf(row.symbol)) }))
      });
      // 展示层异常不能把成功报价变为失败，更不能触发额外上游请求。
      if (snapshot) { try { ctx.onMarketQuote?.(snapshot); } catch { /* 原始工具回执仍照常返回 */ } }
      return [
        `报价（取数时间 ${beijingNow(nowFn())} 北京时间）`,
        ...rows.map(row => (row.reference ? `${row.name}：${row.price} 元${row.time ? `（更新于 ${row.time}）` : ''}` : quoteLine(row))),
        ...[...new Set(sources)].map(source => '来源：' + source),
        '说明：' + note,
        ...(failed.length ? ['未取到：' + failed.join('；')] : [])
      ].join('\n');
    }
  };
}
