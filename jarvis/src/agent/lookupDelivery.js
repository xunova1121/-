import { sportsAnswerTable } from './sportsPresentation.js';
import { readableRecovery } from './lookup/recoveryData.js';
import { newsCandidates } from './newsDelivery.js';
import { answerConstraintIssues, answerConstraints } from './answerRequirements.js';
import { todayNewsIntent } from './newsIntent.js';
import { newsDate } from './newsSources.js';
import { lookupIntent, newsSubject } from './lookup/intent.js';
import { marketIndex } from './lookup/plan.js';
import { weatherFallback, marketFallback } from './lookup/fallback.js';
const MARKET_TOPIC = /指数|沪指|上证|深成|深证|创业板|科创|A股|大A|两市|股市|成交|涨停|跌停|券商|板块|收盘|开盘|行情|个股/;
const MARKET_OFF = /金价|黄金|回收|楼盘|小区|学区|房价|二手房/;
/** 一句话摘要：按句号截断，最多90字，去掉话题标签。 */
export function oneLine(text) {
  const value = String(text || '').replace(/#[^#\s]{1,30}#?/g, '').replace(/\s+/g, ' ').trim();
  if (value.length <= 90) return value;
  const cut = value.slice(0, 90).search(/[。！？!?](?=[^。！？!?]*$)/);
  return cut >= 15 ? value.slice(0, cut + 1) : value.slice(0, 88) + '…';
}
/** 兜底条目：去重标题、剔除和问题不对题的（问行情时剔除金价/楼盘），最多5条。 */
export function digestRows(items, request) {
  // 只有问“大盘/沪指/深成/创业板”才按指数话题筛；金价、汇率、油价、个股名字按问题里的关键词筛（前两个字出现即可）
  const market = lookupIntent(request).kind === 'market';
  const index = market && Boolean(marketIndex(request));
  const terms = market && !index ? newsSubject(request).split(/\s+/).map(word => word.slice(0, 2)).filter(word => word.length >= 2) : [];
  const seen = new Set();
  return items.filter(item => {
    const key = String(item.title).replace(/\s+/g, '').slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    const text = item.title + ' ' + (item.summary || '');
    if (/^\s*[{[]/.test(item.title)) return false; // 接口原始JSON当标题的，不给人看
    if (index) return MARKET_TOPIC.test(text) && !MARKET_OFF.test(item.title);
    return !terms.length || terms.some(term => text.includes(term));
  }).slice(0, 5);
}
/** 本轮最多12条短证据，只存于执行期；不用模型旧回复填补失败，不把正文放入检查点。 */
export function createLookupDelivery(request, now = Date.now) {
  const rows = new Map(), failures = [], direct = [], failedSources = [];
  let recovery = null, recoveredText = '';
  const safe = text => !answerConstraintIssues(request, text, now()).length;
  function add(row) {
    if (rows.size < 12 && /^https:\/\//.test(row.url) && row.title && safe(row.title + ' ' + (row.summary || ''))) rows.set(row.url, row);
  }
  return {
    record({ name: toolName, args = {}, ok, output = '', lookupRecovery }) {
      if (lookupRecovery && lookupRecovery.state !== 'fresh') {
        recovery = lookupRecovery;
        const raw = lookupRecovery.output || String(output).replace(/^错误：/, '');
        recoveredText = readableRecovery({ output: raw, recovery });
        if (!safe(recoveredText)) recoveredText = '这次取得的资料尚未满足你指定的范围，可以补充具体地点、日期或来源后再查。';
        if (lookupRecovery.state === 'failed' || lookupRecovery.state === 'input' || lookupRecovery.state === 'cached' || lookupRecovery.tool !== toolName) return;
      }
      if (['get_weather', 'get_stock_kline', 'get_sports_scores'].includes(toolName)) {
        if (ok && String(output).trim() && safe(String(output)) && direct.length < 3) direct.push({ name: toolName, output: String(output).slice(0, 8000) });
        else if (!ok && failures.length < 4) failures.push(toolName + '：' + String(output).slice(0, 150));
        return;
      }
      if (!['get_today_news', 'web_search', 'fetch_url', 'fetch_json'].includes(toolName)) return;
      if (!ok) { if (failures.length < 4) failures.push(toolName + '：' + String(output).slice(0, 150)); return; }
      if (toolName === 'get_today_news') {
        try {
          const result = JSON.parse(output);
          if (result.kind !== 'today_news' || result.date !== newsDate(now())) return;
          const recent = lookupIntent(request).params.dateMode === 'recent24h' && !answerConstraints(request).todayNews;
          for (const item of (result.items || []).slice(0, 24)) {
            const at = Date.parse(item.publishedAt);
            if (item.publishedAt?.startsWith(result.date) && at <= now() || recent && result.range?.mode === 'recent24h' && at >= now() - 86400000 && at <= now()) add(item);
          }
          for (const source of result.sources || []) if (source.error && failures.length < 4) {
            failures.push(source.source + '：' + source.error);
            const label = String(source.source || '新闻来源').replace(/[^\p{L}\p{N} ·.-]/gu, '').slice(0, 40);
            failedSources.push(label + '暂未取得有效内容');
          }
        } catch { /* 非结构化结果不能当作已读当天新闻。 */ }
      } else if (toolName === 'web_search') {
        if (todayNewsIntent(request) || answerConstraints(request).todayNews) return; // 未知日期摘要不能混入今日新闻。
        try {
          const items = JSON.parse(output);
          if (Array.isArray(items)) for (const item of items.slice(0, 12)) add({ title: item.title, url: item.url, summary: String(item.snippet || '').slice(0, 350), publishedAt: item.publishedAt || null, verification: 'search_only' });
        } catch { /* 原搜索工具的文本回执继续使用下方解析。 */ }
        const lines = String(output).slice(0, 24000).split('\n');
        for (const item of newsCandidates(output)) {
          const index = lines.findIndex(line => line.trim() === item.url);
          const summary = index >= 0 ? String(lines[index + 1] || '').trim().slice(0, 300) : '';
          add({ ...item, summary, verification: 'search_only' });
        }
      } else if (toolName === 'fetch_json' && !todayNewsIntent(request) && !answerConstraints(request).todayNews) {
        try {
          const value = JSON.parse(output);
          if (value.kind === 'public_json' && !value.truncated) add({ url: value.url, title: '公开接口返回数据', summary: JSON.stringify(value.data).slice(0, 350), verification: 'json_read' });
        } catch { /* 解析失败不补数据。 */ }
      } else if (toolName === 'fetch_url' && !todayNewsIntent(request) && !answerConstraints(request).todayNews) {
        const body = String(output).replace(/^【网页读取回执】[^\n]*\n/, '').split('【页面内链接')[0].trim();
        if (body.length > 50 && args.url) add({ url: args.url, title: body.split('\n')[0].slice(0, 120), summary: body.slice(0, 350), verification: 'page_read' });
      }
    },
    get recovery() { return recovery; },
    get hasResults() { return rows.size > 0 || direct.length > 0; },
    delivery() {
      if (recovery && recoveredText) return { text: recoveredText, complete: false, recovery };
      if (direct.length === 1 && direct[0].name === 'get_weather') {
        const result = weatherFallback(direct[0].output, request, now());
        return safe(result.text) ? result : { text: '', complete: false };
      }
      return { text: this.text(), complete: false };
    },
    text() {
      if (recovery && recoveredText) return recoveredText;
      if (direct.length) {
        const text = direct.map(row => row.name === 'get_weather' ? weatherFallback(row.output, request, now()).text : row.name === 'get_stock_kline' ? marketFallback(row.output) : sportsAnswerTable(row.output, request)).filter(Boolean).join('\n\n');
        return safe(text) ? text : '';
      }
      if (!rows.size) return failures.length ? `本轮还没有确切结果（${failedSources.length ? failedSources.join('、') : '查询来源暂时未能提供可用资料'}），可以稍后再试。` : '';
      // 用户 2026-11-03：问大盘，到点后贴出6段300多字的搜索原文，还混着金价“大盘价”、楼盘“核心大盘”、重复条目。
      // 兜底只给相关的、去重后的最多5条，每条一句话；“未读原文”统一写在末尾，不逐条重复。
      const picked = digestRows([...rows.values()], request);
      if (!picked.length) return '这次搜到的条目都和你问的不对题，我没有拿它们凑答案。可以回“再查”，或者换个说法再问一次。';
      const unread = picked.some(item => !['page_read', 'json_read'].includes(item.verification));
      const text = '先给你已经取得的内容（模型没来得及整理，以下是搜到的相关条目）：\n\n' + picked.map(item => `- **${item.title}**：${oneLine(item.summary) || '来源只提供了这一标题，未取得报道正文，不补写细节。'}${item.publishedAt ? `（${item.timeBasis || '发布时间'} ${item.publishedAt.replace('T', ' ').replace('+08:00', '')}，北京时间）` : ''}\n  ${item.source ? item.source + ' ' : ''}${item.url}`).join('\n') + (unread ? '\n\n待核实：尚未读取报道原文，以上只是搜索摘要。' : '\n\n已读取该来源，未做独立交叉核验。');
      return safe(text) ? text : '';
    },
    substitute(text) {
      const value = String(text).trim();
      if (rows.size && (!value || value.length < 200 && /没有可靠结果|没有确切结果|未能生成符合|未找到可靠|只找到候选|无法提供|没有查到/.test(value))) return this.text();
      return text;
    }
  };
}
