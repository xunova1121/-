import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getSportsScores, sportsPreCall, pickLeagues, LEAGUES, clearScoresCache, createSportsScoresTool } from '../src/agent/sportsScores.js';
import { preSearch, preSearchNote, reusesPreSearch } from '../src/agent/preSearch.js';
import { clearZhibo8Cache, ZHIBO8_URL } from '../src/agent/sportsZhibo8.js';
import { runAgent } from '../src/agent/agent.js';

// 北京时间 2026-10-24 14:00
const NOW = Date.parse('2026-10-24T06:00:00Z');

const team = (name, homeAway, score, extra = {}) => ({ homeAway, score, team: { displayName: name }, ...extra });
const ev = (id, date, home, away, type, extra = {}) => ({ id, date, status: { type }, competitions: [{ competitors: [team(home, 'home', extra.hs ?? '0', extra.hx), team(away, 'away', extra.as ?? '0', extra.ax)] }] });
const PRE = { name: 'STATUS_SCHEDULED', state: 'pre', shortDetail: '10/24 - 7:35 AM EDT' };
const FT = { name: 'STATUS_FULL_TIME', state: 'post', detail: 'FT', shortDetail: 'FT' };

/** 假的 ESPN：按赛事代码返回比赛，记下请求的网址（直播吧默认连不上，测 ESPN 这条路） */
function fakeEspn(byLeague, { fail = [], zhibo8 = null } = {}) {
  const urls = [];
  const get = async (url) => {
    if (url === ZHIBO8_URL) {
      if (!zhibo8) throw new TypeError('fetch failed');
      return { ok: true, json: async () => ({ list: zhibo8 }) };
    }
    urls.push(url);
    const code = url.match(/sports\/[a-z]+\/([^/]+)\/scoreboard/)[1];
    if (fail.includes(code)) throw Object.assign(new TypeError('fetch failed'));
    return { ok: true, json: async () => ({ events: byLeague[code] ?? [] }) };
  };
  return { get, urls };
}

beforeEach(() => {
  clearScoresCache();
  clearZhibo8Cache();
});

const domesticMatch = (id, date, time, home, away, state = '1', hs = '', vs = '') => ({ id, sdate: date, time, type: 'football', leagueid: 'fixture', home_team: home, visit_team: away, state, home_score: hs, visit_score: vs });
const domesticGet = list => vi.fn(async url => { expect(url).toBe(ZHIBO8_URL); return new Response(JSON.stringify({ list })); });
const scheduleHtml = (date, home = '测试主队', away = '测试客队') => `<li id="saishi1" data-time="${date}" data-type="football" data-rightishome="0"><time>19:30</time><b><span class="_league">英超第1轮</span><span class="_teams">${home}<span> - </span>${away}</span></b></li>`;

describe('赛程赛果：按北京时间查（用户停用ESPN，保留业务边界）', () => {
  it('北京今天只含当日场次：凌晨/晚间均保留，昨天明天排除，未赛不编比分', async () => {
    const get = domesticGet([
      domesticMatch('1', '2026-10-24', '19:35', 'Shanghai Port', 'Shandong Taishan'),
      domesticMatch('2', '2026-10-24', '15:00', 'Beijing Guoan', 'Chengdu Rongcheng', '3', '2', '1'),
      domesticMatch('3', '2026-10-23', '23:00', 'Arsenal', 'Chelsea', '3', '1', '1'),
      domesticMatch('4', '2026-10-24', '03:00', 'Liverpool', 'Everton', '3', '3', '0'),
      domesticMatch('5', '2026-10-25', '03:00', 'Real Madrid', 'Inter')]);
    const out = await getSportsScores({ sport: 'football' }, { get, now: NOW });
    expect(get.mock.calls.map(([url]) => url)).toEqual([ZHIBO8_URL]);
    expect(out).toContain('北京时间 2026-10-24（周六）');
    expect(out).toContain('15:00 完场：Beijing Guoan 2-1 Chengdu Rongcheng');
    expect(out).toContain('19:35 未开赛：Shanghai Port vs Shandong Taishan');
    expect(out).toContain('03:00 完场：Liverpool 3-0 Everton');
    expect(out).not.toMatch(/Arsenal|Real Madrid|ESPN/);
    expect(out).toContain('列表不带联赛名');
  });
  it('跨两天只看某队；新来源没有点球字段时不补猜点球结果', async () => {
    const get = domesticGet([domesticMatch('0', '2026-10-24', '21:00', '其他队', '对手'), domesticMatch('1', '2026-10-25', '03:00', 'Real Madrid', 'Inter', '3', '1', '1'), domesticMatch('2', '2026-10-25', '03:00', 'Bayern', 'PSG')]);
    const out = await getSportsScores({ date: '2026-10-24', end_date: '2026-10-25', team: 'madrid' }, { get, now: NOW });
    expect(out).toContain('# 2026-10-25（周日）');
    expect(out).toContain('03:00 完场：Real Madrid 1-1 Inter');
    expect(out).not.toMatch(/Bayern|其他队|点球|ESPN/);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('国内日期只部分覆盖：网页失败也保留已取得场次，明确缺口', async () => {
    const get = vi.fn(async url => url === ZHIBO8_URL ? new Response(JSON.stringify({ list: [domesticMatch('1', '2026-10-24', '19:30', 'Liverpool', 'Everton')] })) : new Response('', { status: 503 }));
    const out = await getSportsScores({ date: '2026-10-24', end_date: '2026-10-25' }, { get, now: NOW });
    expect(out).toContain('Liverpool'); expect(out).toContain('缺失日期'); expect(out).toContain('web_search');
    expect(get.mock.calls.some(([u]) => /espn/i.test(u))).toBe(false);
  });
  it('国内接口与网页均失败：只有两条国内请求，不尝试ESPN，交搜索自救', async () => {
    const get = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(getSportsScores({}, { get, now: NOW })).rejects.toMatchObject({ code: 'SPORTS_UNAVAILABLE', message: expect.stringContaining('web_search') });
    expect(get.mock.calls.map(([u]) => u)).toEqual([ZHIBO8_URL, 'https://www.zhibo8.com/']);
  });
  it('用户点停止：立即停，不当成没取到，也不再读赛程页', async () => {
    const ctrl = new AbortController();
    const get = vi.fn((url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })));
    const p = getSportsScores({}, { get, signal: ctrl.signal, now: NOW });
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' }); expect(get).toHaveBeenCalledTimes(1);
  });
  it('整次查询只扣一次读取预算；日期不对、跨太多天、认不出的赛事报清楚', async () => {
    const get = domesticGet([domesticMatch('1', '2026-10-24', '19:30', '甲', '乙')]); let reads = 0;
    await getSportsScores({}, { get, now: NOW, retrieval: { consume: () => reads++ } }); expect(reads).toBe(1);
    await expect(getSportsScores({ date: '2026-13-01' }, { get })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(getSportsScores({ date: '2026-10-01', end_date: '2026-10-09' }, { get })).rejects.toThrow(/最多查 3 天/);
    clearZhibo8Cache();
    await expect(getSportsScores({ leagues: ['排球联赛'] }, { get: async () => { throw new TypeError('offline'); } })).rejects.toThrow(/没认出/);
  });
  it('同一轮又查一次：国内接口使用短时缓存不重复联网', async () => {
    const get = domesticGet([domesticMatch('1', '2026-10-24', '19:30', '甲', '乙')]);
    await getSportsScores({}, { get, now: NOW }); await getSportsScores({}, { get, now: NOW });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('赛事挑选：中文名、分组、项目；旧代码仅为名称别名，不发海外请求', () => {
    expect(pickLeagues({ leagues: ['五大联赛'] }).map(l => l.name)).toEqual(['英超', '西甲', '德甲', '意甲', '法甲']);
    expect(pickLeagues({ sport: 'basketball' }).map(l => l.name)).toEqual(['NBA', 'WNBA']);
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
    expect(sportsPreCall('CBA今天有比赛吗', NOW)).toEqual({ leagues: ['CBA'] });
    expect(sportsPreCall('今天网球比赛有哪些', NOW)).toEqual({ sport: 'tennis' });
    for (const q of ['今天排球比赛有哪些', '帮我写一份今天比赛的总结文档', '你好', '我最近好累']) expect(sportsPreCall(q, NOW), q).toBeNull();
  });

  it('先查的结果随问题交给模型；模型再用同样参数查时直接用先查的', async () => {
    const found = await preSearch({ text: 'x', call: { name: 'get_sports_scores', args: { sport: 'all' } }, run: async ([c]) => [{ ok: true, output: `查到 ${c.name}` }] });
    expect(found).toMatchObject({ tool: 'get_sports_scores', output: '查到 get_sports_scores' });
    expect(preSearchNote(found)).toContain('系统已先查了赛程和比分');
    expect(reusesPreSearch({ name: 'get_sports_scores', args: { sport: 'all' } }, found)).toBe(true);
    expect(reusesPreSearch({ name: 'get_sports_scores', args: { sport: 'basketball' } }, found)).toBe(false);
  });

  it('实际智能体：问“今天有什么比赛”时第一次请求模型前就查好了赛程', async () => {
    // 固定日期，不伪造定时器：真实时钟23点后“+1小时”会变成明天，被今天筛选正确排除。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      clearScoresCache();
      clearZhibo8Cache();
      const espn = { get: domesticGet([domesticMatch('1', '2026-10-24', '15:00', 'Shanghai Port', 'Shandong Taishan')]) };
      const tool = createSportsScoresTool({ fetchImpl: espn.get });
      const seenByModel = [];
      const adapter = {
        stream: async ({ messages }) => {
          seenByModel.push(JSON.stringify(messages.at(-1)));
          return { text: '今天中超：上海海港 vs 山东泰山', toolCalls: [], stop: 'end_turn' };
        }
      };
      await runAgent({ adapter, model: 'fixture', history: [], userText: '今天有什么比赛？', tools: [tool], context: { dynamic: '' }, emit() {}, quiet: true });
      expect(espn.get).toHaveBeenCalledTimes(1);
      expect(seenByModel[0]).toContain('Shanghai Port');
    } finally {
      vi.useRealTimers();
    }
  });
});

// 2026-10-25 在用户服务器上实测的直播吧返回（节选，字段原样）
const Z = (o) => ({ rightishome: '0', home_score: '', visit_score: '', period_cn: '', state: '1', ...o });
// 北京时间 2026-10-25 08:00（实测那天）
const NOW2 = Date.parse('2026-10-25T00:00:00Z');
const ZHIBO8 = [
  Z({ id: '1', leagueid: '244', sdate: '2026-10-25', time: '05:30', type: 'football', home_team: '纽约红牛', visit_team: '迈阿密国际', home_score: '1', visit_score: '0', period_cn: '89′', state: '2', half_score: '（半: 1-0）' }),
  Z({ id: '2', leagueid: '51', sdate: '2026-10-25', time: '19:35', type: 'football', home_team: '上海海港', visit_team: '山东泰山' }),
  Z({ id: '3', leagueid: '51', sdate: '2026-10-25', time: '15:30', type: 'football', home_team: '北京国安', visit_team: '成都蓉城', home_score: '2', visit_score: '1', period_cn: '完赛', state: '3', half_score: '（半: 1-1）' }),
  Z({ id: '4', leagueid: '3395', sdate: '2026-10-25', time: '08:00', type: 'basketball', home_team: '湖人', visit_team: '勇士', home_score: '88', visit_score: '90', period_cn: '第3节\n10:07', state: '2', rightishome: '1' }),
  Z({ id: '5', leagueid: '900', sdate: '2026-10-25', time: '12:00', type: 'football', home_team: '某低级别队', visit_team: '另一队', period_cn: '延期', state: '4' }),
  Z({ id: '6', leagueid: '51', sdate: '2026-10-24', time: '19:35', type: 'football', home_team: '天津津门虎', visit_team: '河南队', home_score: '0', visit_score: '0', state: '3' }),
  Z({ id: '7', leagueid: '8', sdate: '2026-10-26', time: '00:30', type: 'football', home_team: '桑德兰', visit_team: '利兹联' })
];

describe('国内来源：直播吧', () => {
  it('国内连得上直播吧：中文队名、北京时间，进行中给分钟、完场给半场；延期的只计数；不再去连 ESPN', async () => {
    const espn = fakeEspn({}, { zhibo8: ZHIBO8 });
    const out = await getSportsScores({}, { get: espn.get, now: NOW2 });
    expect(espn.urls).toHaveLength(0);
    expect(out).toContain('来源直播吧');
    expect(out).toContain('- 05:30 进行中 89′：纽约红牛 1-0 迈阿密国际');
    expect(out).toMatch(/赛事编号 51\n- 15:30 完场：北京国安 2-1 成都蓉城（半场 1-1）\n- 19:35 未开赛：上海海港 vs 山东泰山/);
    // rightishome=1：右边是主队，主队写前面
    expect(out).toContain('08:00 进行中 第3节 10:07：勇士 90-88 湖人');
    expect(out).toContain('另有 1 场延期、取消或待定');
    expect(out).not.toContain('天津津门虎');
    expect(out).not.toContain('桑德兰');
    expect(out.indexOf('## 足球')).toBeLessThan(out.indexOf('## 篮球'));
  });

  it('点名联赛（含 ESPN 没有的 CBA、中甲）：按项目筛，并提醒模型只挑这个联赛；明天的提示不全；按中文队名筛', async () => {
    const espn = fakeEspn({}, { zhibo8: ZHIBO8 });
    const cba = await getSportsScores({ leagues: ['CBA'] }, { get: espn.get, now: NOW2 });
    expect(cba).toContain('勇士');
    expect(cba).not.toContain('上海海港 vs');
    expect(cba).toContain('用户问的是：CBA');
    const tomorrow = await getSportsScores({ date: '2026-10-26' }, { get: espn.get, now: NOW2 });
    expect(tomorrow).toContain('桑德兰 vs 利兹联');
    expect(tomorrow).toContain('只排进了少数几场');
    const team = await getSportsScores({ team: '海港' }, { get: espn.get, now: NOW2 });
    expect(team).toContain('上海海港');
    expect(team).not.toContain('北京国安 2-1');
  });

  it('直播吧接口未覆盖日期时读国内赛程页，不请求ESPN', async () => {
    const get = vi.fn(async url => url === ZHIBO8_URL ? new Response(JSON.stringify({ list: ZHIBO8 })) : new Response(scheduleHtml('2026-10-22 19:30', 'Arsenal', 'Chelsea')));
    const out = await getSportsScores({ date: '2026-10-22', leagues: ['英超'] }, { get, now: NOW2 });
    expect(get.mock.calls.map(([u]) => u)).toEqual([ZHIBO8_URL, 'https://www.zhibo8.com/']);
    expect(out).toContain('Arsenal（主）vs Chelsea（客）'); expect(out).toContain('实时状态未核实');
    expect(out).not.toMatch(/2-0|ESPN/);
  });
});
