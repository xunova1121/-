import { pageMatch } from './fixtures/sports-page.mjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixture from './fixtures/zhibo8-real-redacted.json';
import { sportsWindow, inSportsWindow, inferSportsWindow } from '../src/agent/sportsWindow.js';
import { getSportsScores, sportsPreCall, clearScoresCache, createSportsScoresTool } from '../src/agent/sportsScores.js';
import { clearZhibo8Cache, zhibo8Result, normalizeZhibo8, ZHIBO8_URL } from '../src/agent/sportsZhibo8.js';
import { sportsSnapshot } from '../src/agent/sportsSnapshot.js';
import { refreshSports } from '../server/sports.mjs';
import { createServerClient } from '../src/core/serverClient.js';
const now = Date.parse('2026-10-30T00:30:00+08:00');
const match = (id, start, state = '1', period = '') => ({ id, type: 'football', leagueid: '100', sdate: start.slice(0, 10), time: start.slice(11, 16), state, period_cn: period, home_team: '主队' + id, visit_team: '客队' + id, home_score: '2', visit_score: '1' });
beforeEach(() => { clearScoresCache(); clearZhibo8Cache(); });
afterEach(() => vi.restoreAllMocks());

it('around两侧含边界、分钟可调；中场保留，已完场/延期/未知不混入', () => {
  const window = sportsWindow({ period: 'around' }, now);
  expect(window.minutes).toBe(120);
  for (const state of ['in', '2', 'pre', '1']) for (const delta of [-120, 120]) expect(inSportsWindow(now + delta * 60000, state, window)).toBe(true);
  for (const state of ['post', '3', '4', '6', '7', 'unknown', '99']) expect(inSportsWindow(now, state, window)).toBe(false);
  for (const delta of [-121, 121]) expect(inSportsWindow(now + delta * 60000, 'in', window)).toBe(false);
  expect(inSportsWindow(NaN, 'in', window)).toBe(false);
  expect(inSportsWindow(now + 31 * 60000, 'pre', sportsWindow({ period: 'around', window_minutes: 30 }, now))).toBe(false);
});

it('原话优先级：足彩/现在有什么球默认窗口，全天/下午/剩余/未来小时/明确日期不被覆盖', () => {
  for (const text of ['足彩赛程', '现在有什么球']) expect(sportsPreCall(text, now)).toMatchObject({ period: 'around', window_minutes: 120, sport: 'football' });
  expect(sportsPreCall('前后两小时的比赛', now)).toMatchObject({ period: 'around', window_minutes: 120, sport: 'all' });
  expect(inferSportsWindow('前后30分钟的比赛')).toEqual({ period: 'around', window_minutes: 30 });
  expect(inferSportsWindow('全天足彩赛程')).toEqual({ period: 'all' });
  expect(inferSportsWindow('下午足彩赛程')).toEqual({ period: 'afternoon' });
  expect(inferSportsWindow('今天剩余足彩赛程')).toEqual({ period: 'remaining' });
  expect(inferSportsWindow('接下来两小时足彩赛程')).toEqual({ period: 'upcoming', window_minutes: 120 });
  expect(sportsPreCall('明天足彩赛程', now)).toMatchObject({ date: '2026-10-31' });
  expect(sportsPreCall('明天足彩赛程', now)).not.toHaveProperty('period');
  for (const text of ['10/31足彩赛程', '10-31足彩赛程', '周日足彩赛程']) expect(inferSportsWindow(text)).not.toHaveProperty('period');
});

it('跨午夜真实查询前后两日，直播吧优先；进行中在未赛前，快照和文字同源', async () => {
  const list = [match('未赛', '2026-10-30T00:35'), match('边界直播', '2026-10-29T22:30', '2', '中场'), match('完场', '2026-10-29T23:30', '3'), match('上界', '2026-10-30T02:30'), match('超出', '2026-10-30T02:31')];
  const onScores = vi.fn(), consume = vi.fn(), get = vi.fn(async () => ({ ok: true, json: async () => ({ list }) }));
  const answer = await getSportsScores({ period: 'around', sport: 'football' }, { get, now, onScores, retrieval: { consume } });
  expect(get.mock.calls.map(([url]) => url)).toEqual([ZHIBO8_URL]); expect(consume).toHaveBeenCalledTimes(1);
  expect(answer).toContain('2026-10-29'); expect(answer).toContain('进行中 中场');
  expect(answer.indexOf('主队边界直播')).toBeLessThan(answer.indexOf('主队未赛'));
  expect(answer).not.toContain('主队完场'); expect(answer).not.toContain('主队超出');
  const card = onScores.mock.calls[0][0];
  expect(card.events.map(e => e.home)).toEqual(['主队边界直播', '主队未赛', '主队上界']);
  expect(card.events[0].score).toBe('2 : 1'); expect(card.events[1].score).toBe('VS');
  expect(card.query).not.toHaveProperty('date'); expect(card.sources).toEqual([{ name: '直播吧', count: 3 }]);
});

it('国内网页备用沿用around窗口，但不能把过去计划猜成中场或完场', async () => {
  const date = offset => new Date(now + 28800000 + offset * 60000).toISOString().slice(0, 16).replace('T', ' ');
  const get = async url => { if (url === ZHIBO8_URL) throw new TypeError('fetch failed'); return new Response(pageMatch('1', date(10), '未来计划') + pageMatch('2', date(-120), '过去计划') + pageMatch('3', date(130), '窗口外')); };
  const cards = [];
  const out = await getSportsScores({ period: 'around', leagues: ['英超'] }, { get, now, onScores: v => cards.push(v) });
  expect(out).toContain('公开赛程页'); expect(out).not.toMatch(/过去计划|窗口外|ESPN/);
  expect(cards[0].events.map(e => e.home)).toEqual(['未来计划']);
  expect(cards[0].events[0]).toMatchObject({ league: '英超', state: 'unknown', score: 'VS' });
});

it('真实返回脱敏样例：只按已知字段归一化，is_jingcai不是编号；联赛缺失不从队名猜', () => {
  expect(fixture.provenance.originalCount).toBeGreaterThan(0);
  for (const row of fixture.list) {
    const e = normalizeZhibo8(row);
    expect(e).not.toHaveProperty('lotteryNumber'); expect(e).not.toHaveProperty('odds'); expect(e).not.toHaveProperty('saleDeadline');
    expect(e.leagueId).toBe(String(row.leagueid));
  }
  const r = zhibo8Result(fixture.list, { from: '2026-10-30', to: '2026-10-30', today: '2026-10-30' });
  expect(r.text).toContain('未提供可核实的竞彩场次编号');
  expect(r.text).toContain('不能从队名推断联赛');
  const s = sportsSnapshot({ args: {}, groups: [{ source: '直播吧', events: r.events }], now });
  expect(s.events.every(e => e.league === '联赛名未提供')).toBe(true);
  const filtered = sportsSnapshot({ args: { leagues: ['英超'] }, groups: [{ source: '直播吧', events: r.events }], now });
  expect(filtered.notice).toContain('尚未按所选联赛核实归属');
  expect(normalizeZhibo8({ ...fixture.list[0], is_jingcai: 1 }).jingcai).toBe(true);
  expect(normalizeZhibo8({ ...fixture.list[0], is_jingcai: true }).jingcai).toBe(true);
});

it('快照有界，空结果说明覆盖局限，不冒充没有比赛', async () => {
  const onScores = vi.fn();
  const list = Array.from({ length: 40 }, (_, i) => match(String(i), '2026-10-30T00:40'));
  await getSportsScores({}, { get: async () => ({ ok: true, json: async () => ({ list }) }), now, onScores });
  expect(onScores.mock.calls[0][0]).toMatchObject({ truncated: true, sources: [{ name: '直播吧', count: 40 }] });
  expect(onScores.mock.calls[0][0].events).toHaveLength(12);
  clearZhibo8Cache();
  const answer = await getSportsScores({ period: 'around' }, { get: async () => ({ ok: true, json: async () => ({ list: [match('old', '2026-10-30T05:00'), match('previous', '2026-10-29T20:00', '3')] }) }), now, onScores });
  expect(answer).toContain('没有符合条件'); expect(answer).toContain('不代表所有联赛完整覆盖');
});

it('工具传出展示回执；显式刷新绕过30秒缓存，原失败仍向上抛出', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const onSportsScores = vi.fn(); let calls = 0;
  const get = async () => { calls++; return { ok: true, json: async () => ({ list: [match('new' + calls, '2026-10-30T00:40'), match('previous', '2026-10-29T20:00', '3')] }) }; };
  const tool = createSportsScoresTool({ fetchImpl: get, onSportsScores });
  await tool.run({}, { requestText: '足彩赛程' }); expect(onSportsScores).toHaveBeenCalledTimes(1);
  const r = await refreshSports(new URLSearchParams({ period: 'around', sport: 'football' }), { get });
  expect(calls).toBe(2); expect(r.events[0].home).toBe('主队new2');
  await expect(refreshSports(new URLSearchParams({ url: 'http://127.0.0.1' }), { get })).rejects.toMatchObject({ status: 400 });
  await expect(refreshSports(new URLSearchParams({ window_minutes: '999' }), { get })).rejects.toMatchObject({ code: 'INVALID_SPORTS_INPUT', status: 400 });
  const ctrl = new AbortController(); ctrl.abort();
  await expect(refreshSports(new URLSearchParams(), { get, signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
});

it('服务器客户端刷新带认证，不创建任务或发送模型请求', async () => {
  const calls = [];
  const client = createServerClient({ base: 'https://server.example', token: 'fixture-token', fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ version: 1, events: [] }), { headers: { 'Content-Type': 'application/json' } }); } });
  await client.sportsScores({ period: 'around', window_minutes: 120 });
  expect(calls).toHaveLength(1); expect(calls[0].url).toContain('/api/sports/scores?');
  expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer fixture-token');
});
