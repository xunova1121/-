import { it, expect } from 'vitest';
import { lookupIntent } from '../src/agent/lookup/intent.js';
import { LOOKUP_INTENT_EXAMPLES } from '../src/agent/lookup/intentExamples.js';
it.each(LOOKUP_INTENT_EXAMPLES)('$text → $kind', ({ text, kind }) => { expect(lookupIntent(text).kind).toBe(kind); });
it('真实口径和反例显式记录：第1步不改旧比分卡窗口，前向两小时留第2步迁移', () => {
  expect(lookupIntent('今天足球赛程').params).toMatchObject({ sport: 'football', period: 'forward_live', window_minutes: 120, states: ['in', 'pre'] });
  expect(lookupIntent('前后两小时足球赛程').params.period).toBe('around');
  expect(lookupIntent('全天足球赛程').params.period).toBe('all');
  expect(lookupIntent('集团年天气').params.city).toBe('南京');
  expect(lookupIntent('给我体育资讯，不要比分').params.includeScores).toBe(false);
  expect(lookupIntent('体育新闻和NBA比分').params.includeScores).toBe(true);
});
it('各三条继承本轮新闻；新问题不由之前比分话题覆盖，创建/文档动作不走查询', () => {
  expect(lookupIntent('各三条', { history: [{ role: 'user', content: '今日新闻' }] })).toMatchObject({ kind: 'news', params: { perCategory: 3, continuation: true } });
  expect(lookupIntent('体育资讯', { history: [{ role: 'user', content: '足彩赛程' }] }).kind).toBe('sports_news');
  for (const text of ['写一篇今天体育新闻稿', '制作今日新闻PPT', '根据附件画架构图', '开发天气接口', '取消查今日新闻']) expect(lookupIntent(text).lookup, text).toBe(false);
  for (const text of ['天气怎么这么慢', '比分怎么那么慢', '体育资讯怎么这么慢']) expect(lookupIntent(text), text).toMatchObject({ kind: 'meta', lookup: false });
});
it('明确保存的用户口径先于默认规则；无关偏好不改写查询', () => {
  const preferences = [{ phrases: ['足球赛程'], kind: 'sports_live', params: { sport: 'football', window_minutes: 60, period: 'forward_live' } }];
  expect(lookupIntent('足球赛程', { preferences }).params.window_minutes).toBe(60);
  expect(lookupIntent('体育资讯', { preferences }).kind).toBe('sports_news');
});
