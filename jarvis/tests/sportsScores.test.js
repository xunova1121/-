import { describe, it, expect, beforeEach } from 'vitest';
import { getSportsScores, sportsPreCall, pickLeagues, LEAGUES, clearScoresCache, createSportsScoresTool } from '../src/agent/sportsScores.js';
import { preSearch, preSearchNote, reusesPreSearch } from '../src/agent/preSearch.js';
import { runAgent } from '../src/agent/agent.js';

// 北京时间 2026-10-24 14:00
const NOW = Date.parse('2026-10-24T06:00:00Z');

const team = (name, homeAway, score, extra = {}) => ({ homeAway, score, team: { displayName: name }, ...extra });
const ev = (id, date, home, away, type, extra = {}) => ({ id, date, status: { type }, competitions: [{ competitors: [team(home, 'home', extra.hs ?? '0', extra.hx), team(away, 'away', extra.as ?? '0', extra.ax)] }] });
const PRE = { name: 'STATUS_SCHEDULED', state: 'pre', shortDetail: '10/24 - 7:35 AM EDT' };
const FT = { name: 'STATUS_FULL_TIME', state: 'post', detail: 'FT', shortDetail: 'FT' };

/** 假的 ESPN：按赛事代码返回比赛，记下请求的网址 */
function fakeEspn(byLeague, { fail = [] } = {}) {
  const urls = [];
  const get = async (url) => {
    urls.push(url);
    const code = url.match(/sports\/[a-z]+\/([^/]+)\/scoreboard/)[1];
    if (fail.includes(code)) throw Object.assign(new TypeError('fetch failed'));
    return { ok: true, json: async () => ({ events: byLeague[code] ?? [] }) };
  };
  return { get, urls };
}

beforeEach(() => clearScoresCache());

describe('赛程赛果：按北京时间查', () => {
  it('北京“今天”跨 ESPN 的两天：往前多取一天，再按开球时间筛回北京当天；没开打的给时间，打完的给比分', async () => {
    const espn = fakeEspn({
      'chn.1': [
        ev('1', '2026-10-24T11:35Z', 'Shanghai Port', 'Shandong Taishan', PRE),
        ev('2', '2026-10-24T07:00Z', 'Beijing Guoan', 'Chengdu Rongcheng', FT, { hs: '2', as: '1' })
      ],
      'eng.1': [
        // 北京 10-23 23:00：昨天的，不算
        ev('3', '2026-10-23T15:00Z', 'Arsenal', 'Chelsea', FT, { hs: '1', as: '1' }),
        // 北京 10-24 03:00：欧洲“昨晚”的比赛，在北京是今天凌晨
        ev('4', '2026-10-23T19:00Z', 'Liverpool', 'Everton', FT, { hs: '3', as: '0' })
      ],
      'uefa.champions': [ev('5', '2026-10-24T19:00Z', 'Real Madrid', 'Inter', { name: 'STATUS_FINAL_PEN', state: 'post', detail: 'FT-Pens', shortDetail: 'FT-Pens' }, { hs: '1', as: '1', hx: { shootoutScore: 4 }, ax: { shootoutScore: 3 } })]
    });
    const out = await getSportsScores({ sport: 'football' }, { get: espn.get, now: NOW });
    expect(espn.urls[0]).toContain('dates=20261023-20261024');
    expect(out).toContain('北京时间 2026-10-24（周六）');
    expect(out).toMatch(/## 中超\n- 15:00 完场：Beijing Guoan（主）2-1 Chengdu Rongcheng（客）\n- 19:35 未开赛：Shanghai Port（主）vs Shandong Taishan（客）/);
    expect(out).toContain('03:00 完场：Liverpool（主）3-0 Everton（客）');
    expect(out).not.toContain('Arsenal');
    // 北京 10-25 03:00 的欧冠不在今天
    expect(out).not.toContain('Real Madrid');
    // 中超排在英超前面
    expect(out.indexOf('## 中超')).toBeLessThan(out.indexOf('## 英超'));
    expect(out).toContain('不在查询范围：CBA');
    expect(out).not.toContain('NBA');
  });

  it('点球、跨两天、只看某队', async () => {
    const espn = fakeEspn({ 'uefa.champions': [ev('5', '2026-10-24T19:00Z', 'Real Madrid', 'Inter', { name: 'STATUS_FINAL_PEN', state: 'post', detail: 'FT-Pens', shortDetail: 'FT-Pens' }, { hs: '1', as: '1', hx: { shootoutScore: 4 }, ax: { shootoutScore: 3 } }), ev('6', '2026-10-24T19:00Z', 'Bayern', 'PSG', PRE)] });
    const out = await getSportsScores({ date: '2026-10-24', end_date: '2026-10-25', leagues: ['欧冠'], team: 'madrid' }, { get: espn.get, now: NOW });
    expect(espn.urls).toHaveLength(1);
    expect(espn.urls[0]).toContain('dates=20261023-20261025');
    expect(out).toContain('# 2026-10-25（周日）');
    expect(out).toContain('03:00 完场（含点球）：Real Madrid（主）1-1 Inter（客），点球 4-3');
    expect(out).not.toContain('Bayern');
  });

  it('个别赛事连不上：其余照常给，并写明哪些没取到', async () => {
    const espn = fakeEspn({ 'eng.1': [ev('4', '2026-10-24T11:30Z', 'Liverpool', 'Everton', PRE)] }, { fail: ['chn.1'] });
    const out = await getSportsScores({ leagues: ['中超', '英超'] }, { get: espn.get, now: NOW });
    expect(out).toContain('Liverpool');
    expect(out).toMatch(/没取到的（1 个[^\n]*web_search[^\n]*）：中超/);
  });

  it('ESPN 完全连不上：很快放弃，不把几十个赛事一个个等超时；告诉模型改用搜索', async () => {
    const espn = fakeEspn({}, { fail: LEAGUES.map((l) => l.code) });
    await expect(getSportsScores({}, { get: espn.get, now: NOW })).rejects.toMatchObject({ code: 'SPORTS_UNAVAILABLE', message: expect.stringContaining('web_search') });
    expect(espn.urls.length).toBeLessThan(LEAGUES.length);
  });

  it('用户点停止：立即停，不当成“没取到”', async () => {
    const ctrl = new AbortController();
    const get = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    const p = getSportsScores({}, { get, signal: ctrl.signal, now: NOW });
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('整次查询只扣一次读取预算；日期不对、跨太多天、认不出的赛事报清楚', async () => {
    const espn = fakeEspn({});
    let reads = 0;
    await getSportsScores({}, { get: espn.get, now: NOW, retrieval: { consume: () => reads++ } });
    expect(reads).toBe(1);
    await expect(getSportsScores({ date: '2026-13-01' }, { get: espn.get })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(getSportsScores({ date: '2026-10-01', end_date: '2026-10-09' }, { get: espn.get })).rejects.toThrow(/最多查 3 天/);
    await expect(getSportsScores({ leagues: ['CBA'] }, { get: espn.get })).rejects.toThrow(/没认出/);
  });

  it('同一轮又查一次（先查过）：不重复联网', async () => {
    const espn = fakeEspn({});
    await getSportsScores({ leagues: ['中超'] }, { get: espn.get, now: NOW });
    await getSportsScores({ leagues: ['中超'] }, { get: espn.get, now: NOW });
    expect(espn.urls).toHaveLength(1);
  });

  it('赛事挑选：中文名、分组、项目', () => {
    expect(pickLeagues({ leagues: ['五大联赛'] }).map((l) => l.name)).toEqual(['英超', '西甲', '德甲', '意甲', '法甲']);
    expect(pickLeagues({ sport: 'basketball' }).map((l) => l.name)).toEqual(['NBA', 'WNBA']);
    expect(pickLeagues({}).length).toBe(LEAGUES.length);
  });
});

describe('问赛程比分时先查好', () => {
  it('认得出要查的日期、赛事、项目；CBA、网球、写文档的不先查', () => {
    expect(sportsPreCall('今天有什么比赛？', NOW)).toEqual({ sport: 'all' });
    expect(sportsPreCall('昨晚欧冠比分多少', NOW)).toEqual({ date: '2026-10-23', end_date: '2026-10-24', leagues: ['欧冠'] });
    expect(sportsPreCall('明天中超赛程', NOW)).toBeNull(); // 没在问
    expect(sportsPreCall('明天中超赛程是什么', NOW)).toEqual({ date: '2026-10-25', leagues: ['中超'] });
    expect(sportsPreCall('10月26日 NBA 有哪些比赛', NOW)).toEqual({ date: '2026-10-26', leagues: ['NBA'] });
    expect(sportsPreCall('昨天足球赛果查一下', NOW)).toEqual({ date: '2026-10-23', sport: 'football' });
    for (const q of ['CBA今天有比赛吗', '今天网球比赛有哪些', '帮我写一份今天比赛的总结文档', '你好', '我最近好累']) expect(sportsPreCall(q, NOW), q).toBeNull();
  });

  it('先查的结果随问题交给模型；模型再用同样参数查时直接用先查的', async () => {
    const found = await preSearch({ text: 'x', call: { name: 'get_sports_scores', args: { sport: 'all' } }, run: async ([c]) => [{ ok: true, output: `查到 ${c.name}` }] });
    expect(found).toMatchObject({ tool: 'get_sports_scores', output: '查到 get_sports_scores' });
    expect(preSearchNote(found)).toContain('系统已先查了赛程和比分');
    expect(reusesPreSearch({ name: 'get_sports_scores', args: { sport: 'all' } }, found)).toBe(true);
    expect(reusesPreSearch({ name: 'get_sports_scores', args: { sport: 'basketball' } }, found)).toBe(false);
  });

  it('实际智能体：问“今天有什么比赛”时第一次请求模型前就查好了赛程', async () => {
    clearScoresCache();
    const espn = fakeEspn({ 'chn.1': [ev('1', new Date(Date.now() + 3600_000).toISOString(), 'Shanghai Port', 'Shandong Taishan', PRE)] });
    const tool = createSportsScoresTool({ fetchImpl: espn.get });
    const seenByModel = [];
    const adapter = {
      stream: async ({ messages }) => {
        seenByModel.push(JSON.stringify(messages.at(-1)));
        return { text: '今天中超：上海海港 vs 山东泰山', toolCalls: [], stop: 'end_turn' };
      }
    };
    await runAgent({ adapter, model: 'fixture', history: [], userText: '今天有什么比赛？', tools: [tool], context: { dynamic: '' }, emit() {}, quiet: true });
    expect(espn.urls.length).toBeGreaterThan(0);
    expect(seenByModel[0]).toContain('Shanghai Port');
  });
});
