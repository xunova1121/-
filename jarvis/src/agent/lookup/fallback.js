import { newsDate } from '../newsSources.js';

/** 只整理真实天气回执；完整性只覆盖当日简单天气，其他问题保留待核对状态。 */
export function weatherFallback(output, request, now) {
  const lines = String(output).split('\n');
  const place = lines.find(line => line.startsWith('地点：'))?.slice(3).trim();
  const current = lines.find(line => /^实况/.test(line));
  const today = lines.find(line => line.startsWith(`今天（${newsDate(now)}）`));
  const source = lines.find(line => line.startsWith('来源：'));
  const link = lines.find(line => line.startsWith('本次数据链接'))?.match(/https:\/\/\S+/)?.[0];
  const switched = lines.find(line => /^(?:和风天气暂时|前面的天气来源)/.test(line));
  const clean = value => value.replace(/本次数据链接（[^\n]*?）：/, '数据来源：');
  const text = place && current && today
    ? `${switched ? switched + '\n' : ''}${place}，${today.replace(/^今天（[^）]+）：/, '今天') }。\n\n${current}。\n${lines.filter(line => /^(?:预警|生活指数|未来两小时|空气质量|明天|后天)/.test(line)).join('\n')}\n${source || ''}${link ? '\n' + link : ''}`.trim()
    : lines.map(clean).join('\n');
  // 不把天气泛答当成空气质量/未来多日/活动建议、比较或带具体条件的问题已完成。
  const simple = /^(?:请|帮我|查一下|查询|看看)?[^，,。！？?\n]{0,32}?(?:今天|今日|现在)?(?:的)?(?:天气|气温)(?:怎么样|如何)?[？?。]*$/.test(request)
    && !/明天|后天|未来|一周|几天|周末|比较|和|及|空气|带伞|建议|昨天|20\d{2}/.test(request);
  const valid = current && today && !/undefined|NaN|null/.test(current + today)
    && /-?\d+(?:\.\d+)?[～~—-]-?\d+(?:\.\d+)?°C/.test(today)
    && /-?\d+(?:\.\d+)?°C/.test(current);
  return { text, complete: Boolean(simple && valid && place && source && link && current.includes(newsDate(now))) };
}

/** 日K只选已取得字段；JSON和工具使用说明不直接作为回答。 */
const INDEX_NAMES = { sh000001: '上证指数', sz399001: '深证成指', sz399006: '创业板指' };
const pct = (value, base) => `${value >= base ? '涨' : '跌'}${Math.abs((value - base) / base * 100).toFixed(2)}%`;
export function marketFallback(output) {
  try {
    const row = JSON.parse(output);
    if (!row.symbol || !Number.isFinite(row.latestClose) || !row.priceDate || !row.sourceUrl) return '';
    const name = INDEX_NAMES[row.symbol];
    const last = Array.isArray(row.bars) ? row.bars.at(-1) : null;
    // 指数：今天盘中那条日K（日期晚于最近收盘日）照实写成“盘中”，不冒充收盘
    const live = name && last && last.date > row.priceDate && Number.isFinite(last.close)
      ? `${last.date}盘中（取数时）：${last.close}，较上一收盘${pct(last.close, row.latestClose)}；今日最高${last.high}、最低${last.low}。\n` : '';
    if (name) return `${name}\n${live}${row.priceDate}收盘：${row.latestClose}${Number.isFinite(row.previousClose) ? `，${pct(row.latestClose, row.previousClose)}` : ''}。\n来源：${row.source || ''} ${row.sourceUrl}\n${live ? '盘中数字是取数那一刻的日K，不是逐笔实时行情。' : '日K收盘数据，不是实时行情。'}`;
    return `${row.symbol} ${row.priceDate}收盘价：${row.latestClose}；${Number.isFinite(row.previousClose) ? `上一交易记录（${row.previousPriceDate}）收盘价：${row.previousClose}；` : ''}复权方式：${row.adjustment || '未注明'}。\n来源：${row.source || ''} ${row.sourceUrl}\n日K收盘数据，不是实时行情。`;
  } catch { return ''; }
}
