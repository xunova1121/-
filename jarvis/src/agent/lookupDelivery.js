import { newsCandidates } from './newsDelivery.js';
import { answerConstraintIssues, answerConstraints } from './answerRequirements.js';
import { todayNewsIntent } from './newsIntent.js';
import { newsDate } from './newsSources.js';
/** 本轮最多12条短证据，只存于执行期；不用模型旧回复填补失败，不把正文放入检查点。 */
export function createLookupDelivery(request, now = Date.now) {
  const rows = new Map(), failures = [];
  const safe = text => !answerConstraintIssues(request, text, now()).length;
  function add(row) {
    if (rows.size < 12 && /^https:\/\//.test(row.url) && row.title && safe(row.title + ' ' + (row.summary || ''))) rows.set(row.url, row);
  }
  return {
    record({ name: toolName, args = {}, ok, output = '' }) {
      if (!['get_today_news', 'web_search', 'fetch_url', 'fetch_json'].includes(toolName)) return;
      if (!ok) { if (failures.length < 4) failures.push(toolName + '：' + String(output).slice(0, 150)); return; }
      if (toolName === 'get_today_news') {
        try {
          const result = JSON.parse(output);
          if (result.kind !== 'today_news' || result.date !== newsDate(now())) return;
          for (const item of (result.items || []).slice(0, 24)) if (item.publishedAt?.startsWith(result.date)) add(item);
          for (const source of result.sources || []) if (source.error && failures.length < 4) failures.push(source.source + '：' + source.error);
        } catch { /* 非结构化结果不能当作已读当天新闻。 */ }
      } else if (toolName === 'web_search') {
        if (todayNewsIntent(request) || answerConstraints(request).todayNews) return; // 未知日期摘要不能混入今日新闻。
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
    get hasResults() { return rows.size > 0; },
    text() {
      if (!rows.size) return failures.length ? '本轮尚未取得可交付的资料。具体卡点：\n' + failures.map(text => '- ' + text).join('\n') : '';
      const text = '先给你已经取得的内容：\n\n' + [...rows.values()].map(item => `- **${item.title}**\n${item.summary || '来源只提供了这一标题，未取得报道正文，不补写细节。'}\n${item.publishedAt ? '发布时间：' + item.publishedAt.replace('T', ' ').replace('+08:00', '') + '（北京时间）；' : ''}来源：${item.source || ''} ${item.url}\n${['page_read', 'json_read'].includes(item.verification) ? '已读取该来源，未做独立交叉核验。' : '待核实：尚未读取报道原文。'}`).join('\n\n');
      return safe(text) ? text : '';
    },
    substitute(text) {
      const value = String(text).trim();
      if (rows.size && (!value || value.length < 200 && /没有可靠结果|没有确切结果|未能生成符合|未找到可靠|只找到候选|无法提供|没有查到/.test(value))) return this.text();
      return text;
    }
  };
}
