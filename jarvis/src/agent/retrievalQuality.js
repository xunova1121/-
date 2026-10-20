/** 机械筛查只排除明显错题，不把摘要当作已经核实的事实。 */
export function requiresSources(text = '') {
  return /(?:今天|今日|最新).{0,30}(?:新闻|资讯|行情|价格|汇率|天气|比分)|(?:查|搜索|核实).{0,25}(?:新闻|行情|价格|比分|资料|来源)/.test(String(text));
}

const newsToday = (text) => /今天|今日/.test(text) && /新闻|资讯|时事/.test(text);
const beijingDay = (now) => new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

export function searchRequest(query, requestText = '', freshness, now = Date.now()) {
  const today = newsToday(String(requestText));
  const value = String(query).trim();
  return {
    query: today && !/新闻|资讯|时事/.test(value) ? `${value} ${beijingDay(now)} 新闻`.slice(0, 800) : value,
    freshness: freshness ?? (today ? 'day' : undefined)
  };
}

export function screenSearchHits(hits, requestText = '') {
  const input = Array.isArray(hits) ? hits.slice(0, 20) : [];
  if (!newsToday(String(requestText))) return { hits: input, rejected: 0 };
  const kept = input.filter((hit) => {
    const title = String(hit.title || '').trim();
    // 年度日历、概况、往年节假日通知不能充当今日新闻；真实当日报道仍保留。
    const reference = /^\d{4}年(?:概况|日历|节假日|全年|放假安排)|关于\d{4}年部分节假日安排/.test(title);
    const reported = /今日|今天|报道|消息|发布|公布/.test(title);
    return !reference || reported;
  });
  return { hits: kept, rejected: input.length - kept.length };
}

/** 每轮最多记32个短查询指纹，不缓存网页；忽略空白和中文格式标点，保留语言名及URL的有效标点。 */
export function createQueryLedger() {
  const seen = new Set();
  return (query) => {
    const key = String(query)
      .toLowerCase()
      .replace(/[\s，。！？、；：]+/gu, '')
      .slice(0, 800);
    if (seen.has(key)) throw Object.assign(new Error('相同搜索词本轮已查询，请使用已有结果或换有实质差异的检索词'), { code: 'REPEATED_SEARCH', kind: 'api' });
    if (seen.size >= 32) throw Object.assign(new Error('本轮搜索词已达到上限'), { code: 'RETRIEVAL_BUDGET', kind: 'budget' });
    seen.add(key);
  };
}
