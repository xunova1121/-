import { pageMatch } from './fixtures/sports-page.mjs';
import { parseSchedulePage } from '../src/agent/sportsSchedulePage.js';
import { beforeEach, expect, it } from 'vitest';
import { sportsWindow, inSportsWindow, inferSportsWindow } from '../src/agent/sportsWindow.js';
import { zhibo8Result, clearZhibo8Cache, ZHIBO8_URL } from '../src/agent/sportsZhibo8.js';
import { clearScoresCache, getSportsScores } from '../src/agent/sportsScores.js';
const now = Date.parse('2026-10-25T12:00:00+08:00');
const event = (id, state, time = '20:00') => ({ id, state, time, sdate: '2026-10-25', type: 'football', leagueid: '1', home_team: '主队' + id, visit_team: '客队' + id, home_score: '', visit_score: '' });
beforeEach(() => { clearZhibo8Cache(); clearScoresCache(); });
it('延期/取消/待定和未知全部保留明细、原状态，不按未来时间改写', () => {
  const list = ['1','2','3','4','6','7','99'].map(state => event(state,state));
  const out = zhibo8Result(list, { from: '2026-10-25', to: '2026-10-25', today: '2026-10-25' });
  expect(out.count).toBe(7);
  for (const state of ['4','6','7','99']) expect(out.text).toContain('主队' + state);
  expect(out.text).toContain('20:00 延期');
  expect(out.text).toContain('原状态99');
  expect(out.text).not.toContain('多是低级别');
});
it('今天剩余不缩成一小时；明确分钟窗口和跨午夜原规则保持', () => {
  expect(inferSportsWindow('今天还有哪些足球比赛')).toEqual({ period: 'remaining' });
  expect(inferSportsWindow('今天接下来60分钟的比赛')).toEqual({ period: 'upcoming', window_minutes: 60 });
  const remaining = sportsWindow({ period: 'remaining' }, now);
  const upcoming = sportsWindow({ period: 'upcoming' }, now);
  const late = Date.parse('2026-10-25T23:00:00+08:00');
  expect(inSportsWindow(late, '1', remaining)).toBe(true);
  expect(inSportsWindow(late, '1', upcoming)).toBe(false);
  expect(inSportsWindow(Date.parse('2026-10-26T00:00:00+08:00'), '1', remaining)).toBe(false);
  expect(inSportsWindow(late, '99', remaining)).toBe(false);
});
it('国内赛程页没有状态时不默认为未赛，也不伪造比分', () => {
  expect(parseSchedulePage(pageMatch('1', '2026-10-25 20:00', '测试主队'))[0]).toMatchObject({ state: 'unknown', status: expect.stringContaining('未核实'), home: { score: '' } });
});
it('日期只部分覆盖时保留国内已取得明细，国内网页补充成功也不覆盖旧来源结果', async () => {
  const get = async url => url === ZHIBO8_URL ? { ok: true, json: async () => ({ list: [event('国内已知', '1')] }) } : new Response(pageMatch('2', '2026-10-26 20:00', '另一日主队'));
  const result = await getSportsScores({ date: '2026-10-25', end_date: '2026-10-26', leagues: ['英超'] }, { get, now });
  expect(result).toContain('主队国内已知');
  expect(result).toContain('公开赛程页');
  expect(result).toContain('不能把两份场数直接相加');
});
