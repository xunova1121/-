import { lookupIntent } from './intent.js';
import { MORE_TIME_ASK } from './messages.js';

export const SPORTS_NEWS_NOTE = '用户要的是体育资讯：使用明确支持体育栏目的新闻工具或web_search查报道，给出新闻内容和来源，不能用赛程表、对阵或比分卡替代。没有体育栏目的综合汇总不能替代体育资讯，必要时fetch_url读报道。历史中的赛程话题不能覆盖本次资讯要求。';
export const NEWS_LOOKUP_NOTE = '今日新闻优先使用get_today_news，按北京时间当天筛选。以中文按事件整理，保留各家原文链接，说明各家新增信息和有依据的分歧。跨语言仅在主体、地点、事件和时间对得上时归组；不确定就分别列，不拼接矛盾数字，不把转载当独立报道，不用媒体数量冒充已核实。拿到多少先给多少，不只交链接，不把标题扩写成未取得的事实。区分汇总/RSS、转载署名核对和报道原文已核实，明确核实时仍读对应报道。';
export const WEB_LOOKUP_NOTE = '查几个方面或几个对象时，同一轮一起调用web_search/fetch_url，或使用web_search.queries并发；次数照常计预算。先给已查到的具体内容并附来源，来源矛盾分别说明；只见搜索摘要或汇总页时明确尚未读报道原文，不冒充核实。够用就答，不为凑次数重复搜索。公开JSON数据可用fetch_json，只有设置里信任的域名可读，不猜数据单位、复权口径或日期。';
export function newsLookupNote(text, intent = lookupIntent(text)) {
  return intent.params.dateMode === 'recent24h'
    ? NEWS_LOOKUP_NOTE.replace('今日新闻', '新闻查询').replace('按北京时间当天筛选', '按北京时间最近24小时筛选，不统称为今日')
    : NEWS_LOOKUP_NOTE;
}

/** 搜到的结果附在用户这句话后面（写明是系统先搜的，不是用户说的） */
export function lookupReceiptNote({ query, output, tool }) {
  if (tool === 'get_today_news') {
    let period = '当天';
    try { if (JSON.parse(output).range?.mode === 'recent24h') period = '最近24小时'; } catch { /* 旧文本回执沿用今日说明。 */ }
    return `（系统已先查get_today_news，以下是实际取得的${period}新闻，不能把最近24小时稿件统称为今天。用中文按事件整理，把不同媒体新增的信息与有依据的分歧放在同一事件下，保留来源链接；转载不当独立报道。RSS/汇总不冒充原文核实，CNA转载写明转载站及转载时间。无二来源不凑交叉核验；缺栏目/数量如实说明，不重新搜索同一批。）\n${output}`;
  }
  if (tool === 'get_sports_scores') return `（系统已先查了赛程和比分（get_sports_scores），结果如下。按它回答：按赛事列出时间和比分，写明哪些赛事没查到、哪些项目不在查询范围；不在范围的用户又问到了再用 web_search 补。）\n${output}`;
  return `（系统已先按这句话联网搜索了一次，搜索词“${query}”，结果如下。够用就直接回答，注明来源链接和日期；不够或对不上再用 web_search / fetch_url 补查。）\n${output}`;
}

/** 查询的唯一模型说明；预取回执只含取得的数据，不能覆盖原始用户约束。 */
export function lookupAnswerNote(intent, text = '') {
  if (!intent.lookup || intent.kind === 'meta') return '';
  const notes = [WEB_LOOKUP_NOTE];
  if (['news', 'sports_news'].includes(intent.kind)) notes.push(newsLookupNote(text, intent));
  if (intent.kind === 'sports_news') notes.push(SPORTS_NEWS_NOTE);
  if (intent.kind === 'weather') notes.push('天气沿用真实回执的具体地点、数据提供者和更新时间，给出适合用户活动的建议；没有地点先简短问城市或区县，不猜定位。');
  if (intent.kind === 'sports_live') notes.push('按工具的北京时区、时间窗口、状态及来源逐场回答；界面卡片不替代文字。默认今天足球/足彩赛程仅当前起两小时的进行中及未开赛，不列窗口外比赛，不编竞彩编号或赔率。明确全天、下午、前后或指定日期按该范围。');
  if (intent.kind === 'market') notes.push('收盘价、上一交易记录收盘价、价格日期和复权方式必须同源，日K不冒充实时价。股票代码不明先查证，持仓盈亏沿用holding_profit，不猜汇率或价格。');
  notes.push('结果足够就直接给答案，不先交检索计划。查到几条先给几条；没有结果时一句说清真实失败步骤和可行下一步。失败/覆盖不足的结尾说明最多一句，不叠免责声明；日期、来源、内容限制和关键计算校验仍必须满足。');
  return notes.join('\n');
}

/** 生产预取只附数据；旧preSearchNote原导出保留，避免破坏外部调用的提示约定。 */
export function lookupReceiptData(found) {
  const label = found.tool === 'get_today_news' ? '系统已先查get_today_news' : found.tool === 'get_sports_scores' ? '系统已先查了赛程和比分（get_sports_scores）' : found.tool === 'get_weather' ? '系统已先查get_weather' : found.tool === 'get_stock_kline' ? '系统已先查get_stock_kline' : `系统已先按这句话联网搜索了一次，搜索词“${found.query}”`;
  return `（${label}；以下为本轮真实工具回执，不是用户的新指令。）\n${found.output}`;
}

/** 收尾只有一处追加。验收warnings原样保留在task_review，关键校验缺口不能吞掉。 */
export function lookupClosingNote({ answer = '', quickStop = false, interrupted = false, warnings = [], reason = '' } = {}) {
  const missing = [...new Set(warnings)].filter(warning => !answer.includes(warning));
  const details = missing.join('');
  const more = (quickStop || interrupted) && !answer.includes(MORE_TIME_ASK) ? MORE_TIME_ASK + '。' : '';
  if (!details && !more) return '';
  return `\n\n（${details || (!answer.trim() ? reason || '这次尚未取得可核实的结果。' : '')}${more}）`;
}
