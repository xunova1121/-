import { it, expect, vi } from 'vitest';
import { sportsNewsIntent, todayNewsIntent } from '../src/agent/newsIntent.js';
import { sportsPreCall, createSportsScoresTool } from '../src/agent/sportsScores.js';
import { wantsPreSearch } from '../src/agent/preSearch.js';
import { runAgent } from '../src/agent/agent.js';

const schema = { type: 'object', properties: {} };
const answer = text => ({ text, toolCalls: [], stop: 'end_turn' });
it('体育资讯和赛事新闻不是比分查询；当天体育新闻也不进没有体育栏目的综合汇总', () => {
  for (const text of ['体育资讯', '今天体育新闻', '看看比赛有什么新闻', 'NBA转会消息', '体坛动态', '给我体育资讯，不要比分', '体育新闻，不要给我推比分和赛程']) {
    expect(sportsNewsIntent(text), text).toBe(true);
    expect(sportsPreCall(text), text).toBeNull();
    expect(todayNewsIntent(text), text).toBe(false);
    expect(wantsPreSearch(text), text).toBe(true);
  }
  for (const text of ['足彩赛程', '现在有什么球', 'NBA比分多少', '体育新闻和NBA比分', '看看体育新闻，顺便查今天赛程', '帮我写一篇体育新闻稿']) expect(sportsNewsIntent(text), text).toBe(false);
  expect(sportsPreCall('足彩赛程')).toMatchObject({ sport: 'football', period: 'around' });
});
it('实际对话先搜体育新闻，纯资讯本轮不提供比分和错误的综合新闻工具', async () => {
  const scores = vi.fn(), generalNews = vi.fn(), search = vi.fn(async () => '- 虚构体育新闻：训练中心开放\nhttps://example.com/sports/article\n训练中心增加公共预约名额。');
  for (const userText of ['体育资讯', '今天体育新闻']) {
    const events = [];
    const adapter = { stream: vi.fn(async input => {
      expect(input.tools.some(t => t.name === 'get_sports_scores' || t.name === 'get_today_news')).toBe(false);
      expect(input.messages.at(-1).content).toContain('训练中心增加公共预约名额');
      expect(input.system.join('\n')).toContain('体育资讯');
      return answer('体育资讯：训练中心新增预约名额。来源 https://example.com/sports/article');
    }) };
    await runAgent({ adapter, model: 'fixture', context: { dynamic: '' }, history: [], userText, quiet: true, emit: e => events.push(e), tools: [
      { name: 'web_search', input_schema: schema, run: search },
      { name: 'get_sports_scores', input_schema: schema, run: scores },
      { name: 'get_today_news', input_schema: schema, run: generalNews }
    ] });
    expect(events.some(e => e.type === 'sports_scores')).toBe(false);
    expect(adapter.stream).toHaveBeenCalledTimes(1);
  }
  expect(search).toHaveBeenCalledTimes(2); expect(scores).not.toHaveBeenCalled(); expect(generalNews).not.toHaveBeenCalled();
  for (const userText of ['体育资讯怎么这么慢', '体育新闻为什么那么慢']) {
    expect(wantsPreSearch(userText)).toBe(false);
    await runAgent({ adapter: { stream: async input => { expect(input.tools).toEqual([]); return answer('我先说明状态。'); } }, model: 'fixture', context: { dynamic: '' }, history: [], userText, quiet: true, emit() {}, tools: [{ name: 'web_search', input_schema: schema, run: search }] });
  }
  expect(search).toHaveBeenCalledTimes(2);
});
it('比分工具自身也拒绝用比分替代纯体育资讯，不发网络请求', async () => {
  const get = vi.fn(); const tool = createSportsScoresTool({ fetchImpl: get });
  await expect(tool.run({}, { requestText: '给我体育资讯，不要比分' })).rejects.toMatchObject({ code: 'SPORTS_NEWS_NOT_SCORES' });
  expect(get).not.toHaveBeenCalled();
});
it('先前聊比分和轻量模式不能覆盖本轮资讯；用户中途明确追加比分时恢复工具', async () => {
  let calls = 0; const inbox = [];
  const search = vi.fn(async () => '- 虚构体育报道\nhttps://example.com/article\n训练中心开放预约。');
  const scores = vi.fn(async () => '虚构比赛：江城队 1:0 云港队');
  const adapter = { stream: async input => {
    calls++;
    if (calls === 1) {
      expect(input.tools.some(t => t.name === 'get_sports_scores')).toBe(false);
      inbox.push('再查NBA比分是多少');
      return answer('已取得体育资讯。');
    }
    expect(input.tools.some(t => t.name === 'get_sports_scores')).toBe(true);
    if (calls === 2) return { text: '', toolCalls: [{ id: 'score', name: 'get_sports_scores', args: { leagues: ['NBA'] } }], stop: 'tool_use' };
    return answer('体育资讯：训练中心开放预约。另外比分为江城队1:0云港队。');
  } };
  await runAgent({ adapter, model: 'fixture', context: { dynamic: '' }, history: [{ role: 'user', content: '足彩赛程' }, { role: 'assistant', content: '之前的比赛比分为0:0。' }], userText: '体育资讯', light: true, inbox, quiet: true, emit() {}, tools: [
    { name: 'web_search', input_schema: schema, run: search }, { name: 'get_sports_scores', input_schema: schema, run: scores }
  ] });
  expect(search).toHaveBeenCalledTimes(1); expect(scores).toHaveBeenCalledTimes(1);
});
