import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSportsScores, createSportsScoresTool, clearScoresCache } from '../src/agent/sportsScores.js';
import { clearZhibo8Cache, ZHIBO8_URL, fetchZhibo8 } from '../src/agent/sportsZhibo8.js';
import { SCHEDULE_URL, fetchSchedulePage } from '../src/agent/sportsSchedulePage.js';
import { SPORTS_FETCH_MS, SPORTS_OPERATION_MS, sportsDiagnostics } from '../src/agent/sportsRequest.js';
import { connectLookupTools, LOOKUP_OPERATIONS } from '../src/agent/lookup/operations.js';
import { lookupPlan } from '../src/agent/lookup/plan.js';
import { lookupIntent } from '../src/agent/lookup/intent.js';
import { createLookupHealth } from '../src/agent/lookup/health.js';
import { memoryLookupStorage } from '../src/agent/lookup/service.js';
import { refreshSports } from '../server/sports.mjs';
import { pageMatch } from './fixtures/sports-page.mjs';

const now = Date.parse('2026-11-08T12:00:00+08:00');
const args = { date: '2026-11-08', sport: 'football', period: 'all' };
const match = { id: 'fixture', sdate: args.date, time: '13:00', type: 'football', state: '2', home_team: '虚构甲队', visit_team: '虚构乙队', home_score: '1', visit_score: '0' };
const scores = () => new Response(JSON.stringify({ list: [match] }));
const page = () => new Response(pageMatch('fixture', '2026-11-08 13:00', match.home_team, match.visit_team));
const delay = (ms, value) => new Promise(resolve => setTimeout(() => resolve(value()), ms));
const networkError = () => Object.assign(new TypeError('上游私有错误正文不应公开'), { cause: { code: 'ECONNRESET' } });
beforeEach(() => {
  clearZhibo8Cache(); clearScoresCache();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.setSystemTime(now);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('慢而有效的7秒比分经预取/操作外层仍成功，不错切搜索', async () => {
  const get = vi.fn(() => delay(7000, scores));
  const search = vi.fn();
  const tools = connectLookupTools([createSportsScoresTool({ fetchImpl: get }), { name: 'web_search', run: search }], {});
  const text = '今天足球比分多少';
  const plan = lookupPlan(lookupIntent(text), { text, getTool: name => tools.find(t => t.name === name), now });
  expect(plan.timeoutMs).toBe(SPORTS_OPERATION_MS);
  expect(LOOKUP_OPERATIONS.find(row => row.id === 'query_sports').timeoutMs).toBe(SPORTS_OPERATION_MS);
  const pending = tools[0].run(args, { requestText: text });
  await vi.advanceTimersByTimeAsync(7000);
  expect(await pending).toContain('虚构甲队 1-0 虚构乙队');
  expect(search).not.toHaveBeenCalled(); expect(get).toHaveBeenCalledTimes(1);
});

it('主源超时后仍预留5秒读计划页；迟到比分不能回写卡片或缓存', async () => {
  const onScores = vi.fn();
  const get = vi.fn(url => url === ZHIBO8_URL ? delay(18000, scores) : delay(4500, page));
  const pending = getSportsScores(args, { get, now, onScores });
  await vi.advanceTimersByTimeAsync(12500);
  expect(await pending).toContain('实时状态未核实');
  expect(get.mock.calls.map(([url]) => url)).toEqual([ZHIBO8_URL, SCHEDULE_URL]);
  expect(onScores).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(6000);
  expect(onScores).toHaveBeenCalledTimes(1);
  const fresh = vi.fn(async () => scores());
  await getSportsScores(args, { get: fresh, now });
  expect(fresh).toHaveBeenCalledTimes(1);
});

it.each(['reset', '503'])('%s明确临时故障只重试一次，请求与重试先扣预算', async mode => {
  let paid = 0;
  const consume = vi.fn(() => paid++);
  const get = vi.fn(async () => {
    expect(paid).toBe(get.mock.calls.length);
    if (get.mock.calls.length === 1) {
      if (mode === '503') return new Response('', { status: 503 });
      throw networkError();
    }
    return scores();
  });
  const pending = getSportsScores(args, { get, now, retrieval: { consume } });
  await vi.advanceTimersByTimeAsync(301);
  expect(await pending).toContain('虚构甲队');
  expect(get.mock.calls.map(([url]) => url)).toEqual([ZHIBO8_URL, ZHIBO8_URL]);
  expect(consume.mock.calls).toEqual([['read'], ['read']]);
});

it('两源均失败也只允许全链一次重试，不能重复整条链', async () => {
  const get = vi.fn(async () => { throw networkError(); });
  const pending = getSportsScores(args, { get, now }).catch(e => e);
  await vi.advanceTimersByTimeAsync(400);
  const error = await pending;
  expect(get.mock.calls.map(([url]) => url)).toEqual([ZHIBO8_URL, ZHIBO8_URL, SCHEDULE_URL]);
  expect(error.sourceFailures).toHaveLength(3);
  expect(error.message).toContain('ECONNRESET');
  expect(error.message).not.toContain('私有错误正文');
});

it.each([403, 404, 429])('HTTP %i不原源重试，立即换计划页', async status => {
  const get = vi.fn(async url => url === ZHIBO8_URL ? new Response('', { status }) : page());
  expect(await getSportsScores(args, { get, now })).toContain('实时状态未核实');
  expect(get.mock.calls.map(([url]) => url)).toEqual([ZHIBO8_URL, SCHEDULE_URL]);
});

it('HTTP拒绝和解析失败留下真实来源、状态、阶段，不统称网络故障', async () => {
  const get = vi.fn(async url => new Response(url === ZHIBO8_URL ? '不要回显这段私有正文' : '', { status: url === ZHIBO8_URL ? 403 : 404 }));
  const error = await getSportsScores(args, { get, now }).catch(e => e);
  expect(error.sourceFailures).toMatchObject([
    { source: '直播吧比分接口', status: 403, code: 'HTTP_ERROR', stage: 'body', elapsedMs: 0 },
    { source: '直播吧赛程页', status: 404, code: 'HTTP_ERROR' }
  ]);
  expect(error.message).toContain('HTTP 403'); expect(error.message).not.toContain('私有正文');
  const malformed = vi.fn(async url => new Response(url === ZHIBO8_URL ? '{"changed":true}' : '<html>没有赛程</html>'));
  const parsed = await getSportsScores(args, { get: malformed, now }).catch(e => e);
  expect(parsed).toMatchObject({ kind: 'data', connected: true });
  expect(parsed.sourceFailures.map(row => row.code)).toEqual(['BAD_FORMAT', 'SPORTS_PAGE_EMPTY']);
  expect(malformed).toHaveBeenCalledTimes(2);
});

it('所有连接挂住时在共享预算内结束，并给搜索保留本轮余量', async () => {
  const signals = [];
  const get = vi.fn((url, { signal }) => { signals.push(signal); return new Promise(() => {}); });
  const pending = getSportsScores(args, { get, now }).catch(e => e);
  await vi.advanceTimersByTimeAsync(SPORTS_FETCH_MS);
  const error = await pending;
  expect(error.code).toBe('SPORTS_UNAVAILABLE');
  expect(error.sourceFailures.map(row => row.code)).toEqual(['SPORTS_TIMEOUT', 'SPORTS_TIMEOUT']);
  expect(error.sourceFailures.reduce((sum, row) => sum + row.elapsedMs, 0)).toBeLessThanOrEqual(SPORTS_FETCH_MS);
  expect(signals.every(s => s.aborted)).toBe(true);
  expect(get).toHaveBeenCalledTimes(2);
});

it('列表内出现null等格式错误不缓存；已取消的调用也不能读取旧缓存', async () => {
  const get = vi.fn(async url => url === ZHIBO8_URL ? new Response('{"list":[null]}') : new Response('', { status: 404 }));
  const error = await getSportsScores(args, { get, now }).catch(e => e);
  expect(error.sourceFailures[0]).toMatchObject({ stage: 'parse', code: 'BAD_FORMAT', connected: true });
  const fresh = vi.fn(async () => scores());
  await fetchZhibo8({ get: fresh }); expect(fresh).toHaveBeenCalledTimes(1);
  await fetchSchedulePage({ get: async () => page() });
  const ctrl = new AbortController(); ctrl.abort();
  await expect(fetchZhibo8({ get: fresh, signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  await expect(fetchSchedulePage({ get: fresh, signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
});

it('Retry-After在预算内按要求等待，超预算直接换源', async () => {
  const get = vi.fn(async url => get.mock.calls.length === 1 ? new Response('', { status: 503, headers: { 'Retry-After': '1' } }) : url === ZHIBO8_URL ? scores() : page());
  const pending = getSportsScores(args, { get, now });
  await vi.advanceTimersByTimeAsync(999); expect(get).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(await pending).toContain('1-0');
  clearZhibo8Cache();
  const long = vi.fn(async url => url === ZHIBO8_URL ? new Response('', { status: 503, headers: { 'Retry-After': '120' } }) : page());
  expect(await getSportsScores(args, { get: long, now })).toContain('计划赛程');
  expect(long).toHaveBeenCalledTimes(2);
});

it('重试等待中取消立即停止，不读备用页也不写卡片', async () => {
  const ctrl = new AbortController(), onScores = vi.fn();
  const get = vi.fn(async () => new Response('', { status: 503, headers: { 'Retry-After': '1' } }));
  const pending = getSportsScores(args, { get, now, signal: ctrl.signal, onScores }).catch(e => e);
  await vi.advanceTimersByTimeAsync(20); ctrl.abort();
  expect((await pending).name).toBe('AbortError');
  await vi.advanceTimersByTimeAsync(2000);
  expect(get).toHaveBeenCalledTimes(1); expect(onScores).not.toHaveBeenCalled();
});

it('重试预算耗尽在出站前停止，控制错误不包装成无结果', async () => {
  const budget = Object.assign(new Error('预算'), { code: 'RETRIEVAL_BUDGET' });
  const get = vi.fn(async () => { throw networkError(); });
  const consume = vi.fn(() => { if (consume.mock.calls.length === 2) throw budget; });
  const pending = getSportsScores(args, { get, now, retrieval: { consume } }).catch(e => e);
  await vi.advanceTimersByTimeAsync(301);
  expect(await pending).toBe(budget); expect(get).toHaveBeenCalledTimes(1);
});

it('卡片刷新使用同样预算，7秒成功且不请求搜索或模型', async () => {
  const get = vi.fn(() => delay(7000, scores));
  const pending = refreshSports(new URLSearchParams(args), { get });
  await vi.advanceTimersByTimeAsync(7000);
  expect(JSON.stringify(await pending)).toContain('虚构甲队'); expect(get).toHaveBeenCalledTimes(1);
});

it.each(['千帆', 'DeepSeek'])('两源失败后用已有%s搜索，保留指定球队与原始问题', async engine => {
  const get = vi.fn(async () => new Response('', { status: 403 }));
  const search = vi.fn(async () => JSON.stringify([{ title: '虚构甲队足球比赛比分', snippet: `${engine}测试回执，未当成实时比分验收`, url: 'https://news.example/fixture' }]));
  const getHealth = vi.fn(async () => ({ cooling: true }));
  const record = vi.fn();
  const tools = connectLookupTools([createSportsScoresTool({ fetchImpl: get }), { name: 'web_search', sourceHealthManaged: true, run: search }], { health: { get: getHealth, record } });
  const result = await tools[0].run({ ...args, teams: ['虚构甲队'] }, { requestText: '这队现在足球比分多少' });
  expect(result.lookupRecovery.state).toBe('recovered'); expect(result.text).toContain('虚构甲队');
  expect(search.mock.calls[0][0].query).toContain('虚构甲队');
  expect(search.mock.calls[0][0].query).toContain('这队现在足球比分多少');
  expect(get).toHaveBeenCalledTimes(2); expect(search).toHaveBeenCalledTimes(1);
  expect(getHealth).not.toHaveBeenCalled();
  expect(record.mock.calls.find(([id]) => id === 'query_sports')[1].providerFailure).toBe(false);
});

it('搜索也失败时诊断穿透恢复包装，健康记录只保存允许的安全字段', async () => {
  const storage = memoryLookupStorage();
  const health = createLookupHealth({ storage });
  const get = vi.fn(async () => new Response('', { status: 403 }));
  const tools = connectLookupTools([createSportsScoresTool({ fetchImpl: get }), { name: 'web_search', sourceHealthManaged: true, run: async () => '[]' }], { health });
  const error = await tools[0].run(args, { requestText: '今天足球比分多少' }).catch(e => e);
  expect(error.code).toBe('LOOKUP_RECOVERY_EXHAUSTED'); expect(error.message).toContain('直播吧比分接口'); expect(error.message).toContain('HTTP 403');
  expect(error.lookupRecovery.attempts[0].sourceFailures).toHaveLength(2);
  const record = await health.get('query_sports');
  expect(record.cooling).toBe(false); expect(record.samples[0].sourceFailures).toHaveLength(2);
  const safe = sportsDiagnostics([{ source: '直播吧比分接口', code: 'HTTP_ERROR', stage: 'body', elapsedMs: 10, status: 403, key: 'secret', url: 'https://secret/?key=x' }, { source: 'secret', code: 'HTTP_ERROR' }]);
  expect(JSON.stringify(safe)).not.toMatch(/secret|https|key/);
});
