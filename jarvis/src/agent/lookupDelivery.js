import { recoveryText } from './lookup/recoveryData.js';
import { newsCandidates } from './newsDelivery.js';
import { answerConstraintIssues, answerConstraints } from './answerRequirements.js';
import { todayNewsIntent } from './newsIntent.js';
import { newsDate } from './newsSources.js';
import { lookupIntent } from './lookup/intent.js';
import { weatherFallback, marketFallback } from './lookup/fallback.js';
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
        recoveredText = recoveryText({ output: raw, recovery });
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
        const text = direct.map(row => row.name === 'get_weather' ? weatherFallback(row.output, request, now()).text : row.name === 'get_stock_kline' ? marketFallback(row.output) : row.output.replace(/^球队名是英文[^\n]*$/m, '')).filter(Boolean).join('\n\n');
        return safe(text) ? text : '';
      }
      if (!rows.size) return failures.length ? `本轮还没有确切结果（${failedSources.length ? failedSources.join('、') : '查询来源暂时未能提供可用资料'}），可以稍后再试。` : '';
      const text = '先给你已经取得的内容：\n\n' + [...rows.values()].map(item => `- **${item.title}**\n${item.summary || '来源只提供了这一标题，未取得报道正文，不补写细节。'}\n${item.publishedAt ? (item.timeBasis || '发布时间') + '：' + item.publishedAt.replace('T', ' ').replace('+08:00', '') + '（北京时间）；' : ''}来源：${item.source || ''} ${item.url}\n${['page_read', 'json_read'].includes(item.verification) ? '已读取该来源，未做独立交叉核验。' : '待核实：尚未读取报道原文。'}`).join('\n\n');
      return safe(text) ? text : '';
    },
    substitute(text) {
      const value = String(text).trim();
      if (rows.size && (!value || value.length < 200 && /没有可靠结果|没有确切结果|未能生成符合|未找到可靠|只找到候选|无法提供|没有查到/.test(value))) return this.text();
      return text;
    }
  };
}
