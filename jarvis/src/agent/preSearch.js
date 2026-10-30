/**
 * 先搜再答：明显要查实时信息的短问题（比分、赛程、新闻、股价、汇率……），在第一次请求模型之前
 * 就按原话搜一次，结果和问题一起交给模型。模型通常一轮就能答完，省掉“先决定去搜 → 等搜索 → 再答”的一整轮。
 * 搜得慢（超过 PRE_SEARCH_MS）或没搜到就算了，照旧让模型自己搜。天气走 get_weather，不在这里搜。
 */
import { sportsNewsIntent, lookupComplaint } from './newsIntent.js';
// 要有具体的实时话题（光有“最近”“今天”不算：“我最近好累”不用搜），并且是在问或要查
const TOPIC = /比分|赛程|赛果|战报|对阵|开球|比赛|直播|新闻|热搜|头条|股价|收盘|开盘|涨跌|行情|大盘|汇率|油价|金价|币价|价格|多少钱|上映|票房|开奖|航班|列车|车次|限行|放假|调休|发布会/;
const ASKING = /[？?]|什么|哪|几|多少|吗|呢|怎么样|如何|查|搜|有没有|是否/;
const WEATHER = /天气|气温|下雨|下雪|带伞|温度|雾霾|空气质量/;
const MAKING = /写|生成|做一?[份个张页]|制作|整理成|翻译|改写|总结|画|唱|记住|提醒|定时|文件|文档|表格|PPT|Word|Excel/i;

export const PRE_SEARCH_MS = 6000;
/** 先查赛程比分（get_sports_scores）：要读几十个赛事，比搜一次慢，多给些时间 */
export const PRE_SPORTS_MS = 15000;

/** 这个问题值不值得先搜一次 */
export function wantsPreSearch(text) {
  const t = String(text ?? '').trim();
  return t.length >= 4 && t.length <= 120 && !lookupComplaint(t) && (sportsNewsIntent(t) || TOPIC.test(t) && ASKING.test(t)) && !WEATHER.test(t) && !MAKING.test(t) && !/https?:\/\//.test(t);
}

/** 原话 → 搜索词：去掉“帮我查一下”“告诉我”这类客气话和结尾的问号 */
export function preSearchQuery(text) {
  return String(text ?? '')
    .trim()
    .replace(/^(?:请|麻烦|能不能|可以)?(?:帮我|给我|替我)?(?:查一?下|查询|搜一?下|搜索|看一?下|看看|找一?下|告诉我|问一?下)?[，,：:\s]*/, '')
    .replace(/[？?。！!～~\s]+$/, '')
    .slice(0, 80) || String(text ?? '').trim().slice(0, 80);
}

/**
 * 跑一次搜索（走 web_search 工具本身：预算、进度、去重和平时一样），超时或失败返回 null。
 * 给了 call 就改跑这个工具（如问赛程时先查 get_sports_scores）。
 * @param {{ run: (calls: object[], signal: AbortSignal) => Promise<Array<{ ok: boolean, output: string }>>, text: string, signal?: AbortSignal, timeoutMs?: number, call?: { name: string, args: object } }} o
 */
export async function preSearch({ run, text, signal, timeoutMs = PRE_SEARCH_MS, call = null }) {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const query = call ? '' : preSearchQuery(text);
    const [result] = await run([{ id: 'pre-search', name: call?.name ?? 'web_search', args: call?.args ?? { query } }], ctrl.signal);
    if (!result?.ok || !String(result.output || '').trim()) return null;
    return { query, output: String(result.output), tool: call?.name ?? 'web_search', args: call?.args ?? { query } };
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

/** 搜到的结果附在用户这句话后面（写明是系统先搜的，不是用户说的） */
export function preSearchNote({ query, output, tool }) {
  if (tool === 'get_today_news') return `（系统已先查get_today_news，以下是实际取得的当天新闻。用中文按事件整理，把不同媒体新增的信息与有依据的分歧放在同一事件下，保留来源链接；转载不当独立报道。RSS/汇总不冒充原文核实，CNA转载写明转载站及转载时间。无二来源不凑交叉核验；缺栏目/数量如实说明，不重新搜索同一批。）\n${output}`;
  if (tool === 'get_sports_scores') return `（系统已先查了赛程和比分（get_sports_scores），结果如下。按它回答：按赛事列出时间和比分，写明哪些赛事没查到、哪些项目不在查询范围；不在范围的用户又问到了再用 web_search 补。）\n${output}`;
  return `（系统已先按这句话联网搜索了一次，搜索词“${query}”，结果如下。够用就直接回答，注明来源链接和日期；不够或对不上再用 web_search / fetch_url 补查。）\n${output}`;
}

const norm = (q) => String(q ?? '').toLowerCase().replace(/[\s，。！？、；：,.!?;:]+/gu, '');
/** 模型这次的 web_search 调用是不是和先搜的一模一样（同一个搜索词、没有别的词） */
export function reusesPreSearch(call, found) {
  // 赛程比分：参数和先查的一样就直接用先查的结果
  if (found?.tool === 'get_sports_scores' || found?.tool === 'get_today_news') return call?.name === found.tool && JSON.stringify(call.args ?? {}) === JSON.stringify(found.args ?? {});
  if (!found || call?.name !== 'web_search') return false;
  const extra = Array.isArray(call.args?.queries) ? call.args.queries.filter((q) => norm(q) && norm(q) !== norm(found.query)) : [];
  return !extra.length && norm(call.args?.query || call.args?.queries?.[0]) === norm(found.query);
}
