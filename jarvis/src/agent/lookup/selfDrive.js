/**
 * 自主编排（用户 2026-11-01：“未央连自己编排的能力都没有吗”）
 * 快查（专用接口 + 程序自救）没拿到结果时，不再到点收工说“查不到”：解除普通查询时限，
 * 把真实失败经过交给模型，由模型自己换搜索词、换来源、直接打开可靠网页，直到查到或确实试过几种办法。
 * 程序只管：总时长上限（SELF_DRIVE_MS）、安全网关和域名白名单、用户随时可停。
 */
export const SELF_DRIVE_MS = 2 * 60_000;
/** 程序换来源取到资料后，再给模型写答案的时间 */
export const RECOVERED_ANSWER_MS = 30_000;
export const SELF_DRIVE_PROGRESS = '快查没查到，换办法接着查…';

const LABEL = { get_weather: '天气接口', get_sports_scores: '赛程接口', get_today_news: '新闻汇总', get_stock_kline: '行情接口', get_market_quote: '报价接口', web_search: '搜索', fetch_url: '打开网页', fetch_json: '公开数据接口' };
const REASON = { transient: '连接超时或不稳定', cooling: '近期连续失败', auth: '授权或额度问题', budget: '时间用完', empty: '没有有效内容', input: '缺少信息' };

/** 一行写清试过什么、各卡在哪（给模型，也存进执行记录） */
export function triedSummary({ recovery, calls = [] } = {}) {
  const rows = [];
  for (const a of recovery?.attempts || []) rows.push(`${a.label}${a.state === 'ok' ? '：取得结果' : `：${REASON[a.failure] || '未取得有效内容'}`}`);
  for (const c of calls) {
    const what = c.args?.query || c.args?.url || c.args?.place || '';
    rows.push(`${LABEL[c.name] || c.name}${what ? `“${String(what).slice(0, 60)}”` : ''}：${c.ok ? '取得结果' : briefError(c.output)}`);
  }
  return [...new Set(rows)].slice(0, 10).join('；');
}
function briefError(output = '') {
  const text = String(output).replace(/^错误：/, '');
  if (/超时|timeout|timed out/i.test(text)) return '超时';
  if (/冷却|暂时不可用/.test(text)) return '近期连续失败';
  if (/授权|401|403|额度/.test(text)) return '授权或额度问题';
  if (/预算|时间已用完/.test(text)) return '时间用完';
  return '没取得有效结果';
}

/** 天气、赛程等给几个国内能直接打开的可靠页面，模型自己挑；不是固定路线 */
function hints(kind, place = '') {
  const q = encodeURIComponent(place ? `${place}天气` : '');
  if (kind === 'weather') return `可以试：web_search 换个说法（如“${place || '城市'} 天气预报 今天”）；fetch_url 打开百度搜索结果页 https://www.baidu.com/s?wd=${q || '城市天气'}，或中国天气网 https://www.weather.com.cn 、中央气象台 https://www.nmc.cn 的对应城市页。`;
  if (kind === 'sports_live') return '可以试：web_search 换个说法（加联赛名、日期）；fetch_url 打开直播吧 https://www.zhibo8.com 或懂球帝等赛程页。';
  if (kind === 'news' || kind === 'sports_news') return '可以试：web_search 换关键词；fetch_url 打开新华网、中新网、央视网等对应栏目页。';
  if (kind === 'market') return '可以试：web_search 加证券代码和“收盘”；fetch_url 打开东方财富、新浪财经的个股页。';
  return '可以试：web_search 换关键词或换成英文；fetch_url 直接打开官方网站或权威媒体页面。';
}

/** 交给模型的话：真实经过 + 要它自己想办法 + 收尾规矩 */
export function selfDriveNote({ kind = 'general', place = '', tried = '' } = {}) {
  return `（系统：程序的快查没拿到可用结果${tried ? `。已经试过：${tried}` : ''}。这些路这轮不要原样重试。普通查询时限已解除，你还有约${SELF_DRIVE_MS / 60000}分钟：自己想办法把问题查到——换搜索词、换来源、直接打开可靠网页。${hints(kind, place)}每次失败先想清原因再换办法，至少换两种不同办法；查到就直接回答并给来源和数据时间。真的都失败，只用一句话说清试过哪几种办法、各卡在哪，不要编造原因；也不要说“额度用完”“明天再查”。）`;
}

/**
 * 拿到了结果但跟点名的对象毫不相干（用户 2026-11-02：问日本新闻，汇总拿回10条国内报道就交差）：
 * 结果里一个对象词都没有，就算没查到，交给模型接着查。对象词取每个词的前两个字比对，“韩国在”也能认出“韩国”。
 */
export function offSubject(output, subject) {
  const terms = String(subject || '').split(/\s+/).filter(Boolean).map(word => /^[A-Za-z]/.test(word) ? word.toLowerCase() : word.slice(0, 2)).filter(word => word.length >= 2);
  if (!terms.length) return false;
  const text = String(output || '').toLowerCase();
  // 只判断真有条目（带链接）的结果；没有链接的回执交给原有流程，不在这里改判
  if (!/https?:\/\//.test(text)) return false;
  return !terms.some(term => text.includes(term));
}
