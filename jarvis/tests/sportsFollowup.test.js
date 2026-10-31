import { beforeEach, expect, it, vi } from 'vitest';
import { sportsFollowupScope } from '../src/agent/sportsFollowup.js';
import { sportsAnswerTable } from '../src/agent/sportsPresentation.js';
import { getSportsScores, createSportsScoresTool, clearScoresCache } from '../src/agent/sportsScores.js';
import { clearZhibo8Cache, ZHIBO8_URL } from '../src/agent/sportsZhibo8.js';
import { parseSchedulePage, fetchSchedulePage, SCHEDULE_URL } from '../src/agent/sportsSchedulePage.js';
import { withoutRetiredSports, sportsQuery } from '../src/agent/sportsSnapshot.js';
import { createLastGood } from '../src/agent/lookup/lastGood.js';
import { memoryLookupStorage } from '../src/agent/lookup/service.js';
import { responseGuidance } from '../src/agent/responseGuidance.js';
import { runAgent } from '../src/agent/agent.js';
import { pageMatch } from './fixtures/sports-page.mjs';
const now = Date.parse('2026-10-31T13:50:00+08:00');
const names = ['甲队', '乙队', '丙队', '丁队', '戊队', '己队'];
const history = [{ role: 'user', content: '看这六场截图的比赛' }, { role: 'assistant', content: names.map(n => `- ${n} vs 对手：半场 0:0`).join('\n') }];
const rows = [...names, '无关队'].map((name, i) => ({ id: String(i), sdate: '2026-10-31', time: '13:00', type: 'football', state: '2', leagueid: 'fixture', home_team: name, visit_team: '对手', home_score: String(i + 1), visit_score: '0', period_cn: '中场' }));
beforeEach(() => { clearScoresCache(); clearZhibo8Cache(); });
it('比分追问继承六场队名，不继承旧比分；明确全天请求解除前文范围', () => {
  expect(sportsFollowupScope('比分是多少', history)).toEqual({ required: true, teams: names, count: 6 });
  expect(sportsFollowupScope('今天全部比赛比分', history)).toBeNull();
  expect(sportsFollowupScope('比分是多少', [{ role: 'user', content: '这张截图', images: [{}] }])).toMatchObject({ required: true, teams: [] });
});
it('选定六场只返回六场和新比分，不把其他运动/场次混进来', async () => {
  const cards = []; const get = vi.fn(async url => { expect(url).toBe(ZHIBO8_URL); return new Response(JSON.stringify({ list: rows })); });
  const tool = createSportsScoresTool({ fetchImpl: get, onSportsScores: c => cards.push(c) });
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  try {
    const out = await tool.run({}, { requestText: '比分是多少', retrieval: { sportsScope: sportsFollowupScope('比分是多少', history), consume() {} } });
    expect(out).not.toContain('无关队'); expect(out).toContain('甲队 1-0 对手');
    expect(cards[0].events).toHaveLength(6); expect(cards[0].query.teams).toEqual(names);
  } finally { vi.useRealTimers(); }
});
it('未匹配指定球队明确缺口，不能用其他场次凑六场', async () => {
  const out = await getSportsScores({ teams: [...names.slice(0, 5), '没有的球队'] }, { now, get: async () => new Response(JSON.stringify({ list: rows })) });
  expect(out).toContain('未匹配到：没有的球队'); expect(out).not.toContain('无关队'); expect(out).not.toContain('己队 6-0');
});
it('截图还没有可读队名时拒绝全站查分，不发任何请求', async () => {
  const get = vi.fn(); const tool = createSportsScoresTool({ fetchImpl: get });
  await expect(tool.run({}, { requestText: '那6场比分', retrieval: { sportsScope: { required: true, teams: [] } } })).rejects.toMatchObject({ name: 'ValidationError' });
  expect(get).not.toHaveBeenCalled();
});
it('真实agent入口先交模型辨认追问范围，不在第一轮前预取全站', async () => {
  let calls = 0; const get = vi.fn(async () => new Response(JSON.stringify({ list: rows })));
  const tool = createSportsScoresTool({ fetchImpl: get }); const receipts = [];
  const adapter = { stream: async ({ onText }) => {
    if (!calls++) { expect(get).not.toHaveBeenCalled(); return { text: '', toolCalls: [{ id: 'six', name: tool.name, args: {} }], stop: 'tool_use' }; }
    onText('六场比分已按指定对阵查到，来源直播吧。'); return { text: '六场比分已按指定对阵查到，来源直播吧。', toolCalls: [], stop: 'end_turn' };
  } };
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  try {
    await runAgent({ adapter, model: 'fixture', history, userText: '比分是多少', tools: [tool], context: { dynamic: '' }, emit: e => { if (e.type === 'tool_end') receipts.push(e); }, quiet: true });
    const out = receipts.find(e => e.name === 'get_sports_scores');
    expect(out.ok).toBe(true); expect(out.output).toContain('指定的6个'); expect(out.output).not.toContain('无关队');
  } finally { vi.useRealTimers(); }
});
it('百场回执兜底为六行表格，来源一次，进行中优先', () => {
  const output = '来源：直播吧\n查询于北京时间 2026-10-31 13:50\n' + Array.from({ length: 123 }, (_, i) => `- 13:00 ${i === 100 ? '进行中 中场' : '未开赛'}：主队${i} ${i === 100 ? '1-0' : 'vs'} 客队`).join('\n');
  const text = sportsAnswerTable(output, '比分是多少');
  expect(text).toContain('| 时间（北京）'); expect(text.match(/^\| 13:00/gm)).toHaveLength(6);
  expect(text.indexOf('主队100')).toBeLessThan(text.indexOf('主队0 ')); expect(text).toContain('其余 117 场');
  expect(text.match(/来源：/g)).toHaveLength(1); expect(text).not.toContain('赛事编号');
});
it('真实页面结构只解析明确对阵日期，反向主客正确；无比分不编造', () => {
  const html = pageMatch('1', '2026-10-31 14:30', '甲队').replace('data-rightishome="0"', 'data-rightishome="1"');
  const events = parseSchedulePage(html + html + pageMatch('bad', '2026-02-31 14:30', '假日期'));
  expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ home: { name: '客队', score: '' }, state: 'unknown' });
});
it('赛程网页读取限制大小，取消后不缓存旧响应', async () => {
  await expect(fetchSchedulePage({ get: async () => new Response('x', { headers: { 'content-length': '1000001' } }) })).rejects.toMatchObject({ code: 'WEB_BODY_LIMIT' });
  const ctrl = new AbortController(); ctrl.abort(); const get = vi.fn();
  await expect(fetchSchedulePage({ get, signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(get).not.toHaveBeenCalled();
});
it('旧ESPN卡片及缓存不继续回放，不改原历史对象', async () => {
  const old = { version: 1, events: [{ source: 'ESPN', home: '旧队' }, { source: '直播吧', home: '国内队' }], sources: [{ name: 'ESPN', count: 1 }, { name: '直播吧', count: 1 }] };
  expect(withoutRetiredSports(old).events).toEqual([{ source: '直播吧', home: '国内队' }]); expect(old.events).toHaveLength(2);
  const storage = memoryLookupStorage(); await storage.put({ id: 'lookup.last-good.v1', rows: [{ key: 'scores', kind: 'sports_live', at: now, found: { output: '来源 ESPN https://espn.com/' } }] });
  expect(await createLastGood({ storage, now: () => now }).get('scores', 'sports_live')).toBeNull();
});
it('多球队刷新参数保留，通用排版不破坏文章和短答', () => {
  expect(sportsQuery({ teams: names }).teams).toEqual(names);
  for (const text of ['你好', '分析方案', '写一封信', '今天天气']) {
    const note = responseGuidance(text, [], { light: true });
    expect(note).toContain('所有答复按内容清晰排版'); expect(note).toContain('短问题简短答'); expect(note).toContain('保留其自然文体');
  }
});
