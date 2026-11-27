import { pageMatch } from './fixtures/sports-page.mjs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { sportsWindow, inSportsWindow, beijingTimestamp, inferSportsWindow } from '../src/agent/sportsWindow.js';
import { getSportsScores, createSportsScoresTool, clearScoresCache, sportsPreCall } from '../src/agent/sportsScores.js';
import { zhibo8Result, clearZhibo8Cache, ZHIBO8_URL } from '../src/agent/sportsZhibo8.js';

const now = Date.parse('2026-10-25T06:04:00+08:00');
const match = (id, time, state = '1') => ({ id, type: 'football', sdate: '2026-10-25', time, state, leagueid: '1', home_team: `主队${id}`, visit_team: `客队${id}`, home_score: '0', visit_score: '0' });
// 假赛程固定在2026-10-25，测试时钟也必须固定；不改变国内源优先的原断言。
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  clearScoresCache();
  clearZhibo8Cache();
});
afterEach(() => { vi.restoreAllMocks(); });
describe('赛程时间由程序筛选', () => {
  it('FR-07：只返回未来60分钟，UTC先换算再比较', () => {
    const window = sportsWindow({ period: 'upcoming' }, now);
    const cases = [['A', '2026-10-25T00:30:00+08:00'], ['B', '2026-10-25T06:30:00+08:00'], ['C', '2026-10-24T22:15:00Z'], ['D', '2026-10-25T03:00:00+08:00'], ['E', '2026-10-25T00:50:00Z']];
    expect(cases.filter(([, time]) => inSportsWindow(Date.parse(time), 'pre', window)).sort((a, b) => Date.parse(a[1]) - Date.parse(b[1])).map(([id]) => id)).toEqual(['C', 'B']);
    expect(inSportsWindow(now + 60 * 60_000, 'pre', window)).toBe(false);
    expect(inSportsWindow(now + 60_000, 'in', window)).toBe(false);
  });
  it('FR-08：下午含12点不含18点，未知时间不能猜', () => {
    const window = sportsWindow({ period: 'afternoon' }, now);
    expect(inSportsWindow(Date.parse('2026-10-25T05:00:00Z'), 'pre', window)).toBe(true);
    expect(inSportsWindow(Date.parse('2026-10-25T10:00:00Z'), 'pre', window)).toBe(false);
    expect(inSportsWindow(NaN, 'pre', window)).toBe(false);
    expect(beijingTimestamp('2026-10-25', '待定')).toBeNaN();
  });
  it('直播吧按窗口和时间排序，不将已开赛列为马上开赛', () => {
    const list = [match('past', '00:30'), match('later', '06:30'), match('soon', '06:15'), match('live', '06:20', '2')];
    const result = zhibo8Result(list, { from: '2026-10-25', to: '2026-10-25', today: '2026-10-25', window: sportsWindow({ period: 'upcoming' }, now) });
    expect(result.text).not.toContain('主队past');
    expect(result.text).not.toContain('主队live');
    expect(result.text.indexOf('06:15')).toBeLessThan(result.text.indexOf('06:30'));
    expect(result.text).toContain('不能从队名推断联赛');
  });
  it('仍优先国内来源、预算一次；原话的下午优先于模型误填全天', async () => {
    const calls = [];
    const get = async (url) => { calls.push(url); return { ok: true, json: async () => ({ list: [match('morning', '08:00'), match('afternoon', '13:00')] }) }; };
    let reads = 0;
    const tool = createSportsScoresTool({ fetchImpl: get });
    const result = await tool.run({ period: 'all' }, { requestText: '今天下午足球赛程', retrieval: { consume: () => reads++ } });
    expect(calls).toEqual([ZHIBO8_URL]);
    expect(reads).toBe(1);
    expect(result).toContain('主队afternoon');
    expect(result).not.toContain('主队morning');
  });
  it('国内赛程页备用同样筛时间，不把旧计划混回结果或编成实时比分', async () => {
    const get = async url => url === ZHIBO8_URL ? new Response('{"list":[]}') : new Response(pageMatch('0', '2026-10-25 00:30', '主队0') + pageMatch('1', '2026-10-25 06:30', '主队1'));
    const result = await getSportsScores({ leagues: ['英超'], period: 'upcoming' }, { get, now });
    expect(result).toContain('主队1'); expect(result).not.toContain('主队0');
    expect(result).toContain('实时状态未核实'); expect(result).not.toContain('ESPN');
  });
  it('跨午夜未来窗口会包含次日，而非只查今天', async () => {
    const list = [{ ...match('today', '23:55') }, { ...match('tomorrow', '00:10'), sdate: '2026-10-26' }];
    const get = async () => ({ ok: true, json: async () => ({ list }) });
    const result = await getSportsScores({ period: 'upcoming' }, { get, now: Date.parse('2026-10-25T23:50:00+08:00') });
    expect(result).toContain('主队today');
    expect(result).toContain('主队tomorrow');
    expect(inferSportsWindow('接下来两小时的比赛')).toEqual({ period: 'upcoming', window_minutes: 120 });
  });
  it('最新明确改全天可解除筛选，非法预算参数不发请求', () => {
    expect(inferSportsWindow('今天下午赛程\n补充：改成全天')).toEqual({ period: 'all' });
    expect(sportsPreCall('下午足球赛程有哪些', now)).toMatchObject({ period: 'afternoon' });
    expect(() => sportsWindow({ window_minutes: 10000 }, now)).toThrow(/1至360/);
  });
});
