/** 只剔除明显错题的后备搜索结果；通过不等于日期/事实已核实，仍须原文与原审查。 */
export function relevantRecoverySearch(output, intent, args = {}, request = '') {
  let rows;
  try { const value = JSON.parse(output); if (Array.isArray(value)) rows = value; } catch { /* 原工具为列表文本。 */ }
  if (!rows) rows = String(output).split(/\n(?=- )/).map(block => ({ title: block.split('\n')[0].replace(/^-\s*/, ''), url: block.match(/https?:\/\/[^\s]+/)?.[0], snippet: block.split('\n').slice(2).join(' ') }));
  const kept = rows.filter(row => {
    if (!row.url || !row.title) return false;
    const text = `${row.title} ${row.snippet || ''}`;
    if (/客服电话|售后维修|账号登录|验证码/.test(text) && !/客服|售后|维修|登录|验证码/.test(request)) return false;
    if (intent.kind === 'weather') return /天气|气温|温度|weather|forecast/i.test(text) && text.includes(String(args.place || '').replace(/[市区县]$/, ''));
    if (intent.kind === 'sports_live') return /赛程|比分|对阵|开球|比赛|schedule|fixtures|score/i.test(text) && (/篮球|NBA|CBA/i.test(request) ? /篮球|NBA|CBA|basketball/i.test(text) : /足球|足彩|中超|英超|欧冠|足协|足联|世界杯|football|soccer/i.test(text));
    if (intent.kind === 'sports_news') return /体育|体坛|足球|篮球|球员|球队|转会|奥运|网球|乒乓|羽毛球|sports|football|soccer|basketball/i.test(text);
    if (intent.kind === 'market' && args.code) return text.includes(String(args.code).replace(/^(sh|sz|bj)/i, '')) && /股票|股价|行情|收盘|证券|日K|K线|stock|quote/i.test(text);
    if (intent.kind === 'news') return /新闻|资讯|报道|发布|消息|时政|财经|国际|经济|科技|news|report/i.test(text);
    const words = String(request).replace(/什么时候|是什么|怎么|如何|多少|最新|今天|今日|一下|官方资料|查询|搜索/g, ' ').match(/[A-Za-z]{3,}|[\u4e00-\u9fff]{2,}/g) || [];
    return !words.length || words.some(word => text.toLowerCase().includes(word.toLowerCase()) || /[\u4e00-\u9fff]/.test(word) && [...word].slice(0, -1).some((_, i) => text.includes(word.slice(i, i + 2))));
  }).slice(0, 12);
  return kept.length ? JSON.stringify(kept) : '';
}
