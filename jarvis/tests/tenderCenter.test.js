import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTenderCenter } from '../server/tenderCenter.mjs';
import { runAsUser } from '../server/userScope.mjs';
import { tenderBudget, tenderFilters, tenderMatches, TENDER_LIMITS } from '../src/core/tenderCenterData.js';
import { createTenderCollector, ccgpPages, TENDER_SOURCES } from '../server/tenderSources.mjs';

const dirs = [], centers = [];
const A = 'u_' + 'a'.repeat(24), B = 'u_' + 'b'.repeat(24);
const date = Date.parse('2026-11-12T12:00:00+08:00');
const row = (id, extra = {}) => ({ title: `江苏农业项目${id}招标公告`, publishedAt: '2026-11-12', type: 'tender', region: '江苏', snippet: '',
  url: `https://www.ccgp.gov.cn/cggg/dfgg/gkzb/202611/t20261112_${id}.htm`, ...extra });
function fixture(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-center-')); dirs.push(dir);
  let rows = [row(1)], ms = date;
  const collector = { listing: vi.fn(async () => ({ rows, partial: false })), detail: vi.fn(async () => ({ budgetText: '100万元', projectNumber: 'X-1', excerpt: '采购需求：农业项目', deadlineText: '2026年11月20日 09:00', detailAt: ms })) };
  const options = { dataDir: dir, collector, now: () => ms, sources: [TENDER_SOURCES[0]], users: () => ['owner', A, B], ...extra };
  const create = () => { const c = createTenderCenter(options); centers.push(c); return c; };
  return { center: create(), create, collector, setRows: x => { rows = x; }, advance: t => { ms += t; } };
}
afterEach(async () => { for (const c of centers.splice(0)) await c.stop(); vi.useRealTimers(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it('浏览直接读取缓存，不联网、不建对话；重启保留目录、预算与来源', async () => {
  const f = fixture();
  expect((await f.center.list()).total).toBe(0);
  expect(f.collector.listing).not.toHaveBeenCalled();
  await f.center.refresh();
  expect((await f.center.list({ query: '农业', region: '江苏' })).items[0]).toMatchObject({ budget: 1e6, source: '中国政府采购网' });
  await f.center.stop();
  expect((await f.create().list()).total).toBe(1);
  expect(f.collector.listing).toHaveBeenCalledTimes(1);
});
it('手机未打开也匹配订阅；重启/重复采集不重复通知；已读同步保存', async () => {
  const f = fixture(); await f.center.refresh();
  await runAsUser(A, () => f.center.change({ action: 'subscribe', filters: { query: '农业' } }));
  f.setRows([row(1), row(2)]); f.advance(1800000); await f.center.refresh();
  let state = await runAsUser(A, () => f.center.mine());
  expect(state.alerts).toHaveLength(1);
  expect(state.alerts[0].body).toContain('项目2');
  await f.center.stop(); const restarted = f.create(); await restarted.refresh();
  expect((await runAsUser(A, () => restarted.mine())).alerts).toHaveLength(1);
  await runAsUser(A, () => restarted.change({ action: 'read', id: state.alerts[0].id }));
  expect((await runAsUser(A, () => restarted.notices(0)))).toHaveLength(0);
});
it('并发保存与恶意owner字段不串账号，收藏共享公告但个人列表隔离', async () => {
  const f = fixture(); await f.center.refresh(); const id = (await f.center.list()).items[0].id;
  await Promise.all([
    runAsUser(A, () => f.center.change({ action: 'subscribe', name: '甲私有', filters: { query: '农业' }, owner: B })),
    runAsUser(B, () => f.center.change({ action: 'favorite', id }))
  ]);
  expect((await runAsUser(B, () => f.center.mine())).subscriptions).toHaveLength(0);
  expect((await runAsUser(A, () => f.center.list({ favorites: 'true' }))).total).toBe(0);
  expect((await runAsUser(B, () => f.center.list({ favorites: 'true' }))).total).toBe(1);
  const sub = (await runAsUser(A, () => f.center.mine())).subscriptions[0];
  await expect(runAsUser(B, () => f.center.change({ action: 'subscribe', id: sub.id }))).rejects.toMatchObject({ status: 404 });
});
it('暂停和恢复不补发历史；取消订阅之后不再产生提醒', async () => {
  const f = fixture(); await f.center.refresh();
  const sub = (await f.center.change({ action: 'subscribe', filters: {} })).subscriptions[0];
  await f.center.change({ ...sub, action: 'subscribe', enabled: false });
  f.setRows([row(2)]); await f.center.refresh();
  expect((await f.center.mine()).alerts).toHaveLength(0);
  await f.center.change({ ...sub, action: 'subscribe', enabled: true });
  await f.center.refresh(); expect((await f.center.mine()).alerts).toHaveLength(0);
  await f.center.change({ action: 'unsubscribe', id: sub.id });
  f.setRows([row(3)]); await f.center.refresh(); expect((await f.center.mine()).alerts).toHaveLength(0);
});
it('同项目不同公告URL不合并，正文修订保留前后截止和预算，时钟变化不误报', async () => {
  const f = fixture(); await f.center.refresh();
  await f.center.change({ action: 'subscribe', filters: {} });
  f.advance(7 * 3600000);
  f.collector.detail.mockImplementation(async () => ({ budgetText: '120万元', deadlineText: '2026年11月22日 09:00', projectNumber: 'X-1', excerpt: '更正后的采购需求', detailAt: date + 7 * 3600000 }));
  await f.center.refresh();
  expect((await f.center.mine()).alerts[0].change).toMatchObject({ before: { budgetText: '100万元' }, after: { budgetText: '120万元' } });
  await f.center.refresh(); expect((await f.center.mine()).alerts).toHaveLength(1);
  f.setRows([row(1), row(2, { title: '江苏农业项目更正公告', type: 'correction' })]); await f.center.refresh();
  expect((await f.center.list()).total).toBe(2);
  expect((await f.center.mine()).alerts).toHaveLength(2);
});
it('一个上游失效保留旧目录和最近成功时间；其他来源照常刷新，错误不泄漏正文', async () => {
  const f = fixture({ sources: TENDER_SOURCES }); await f.center.refresh();
  f.collector.listing.mockImplementation(async source => {
    if (source.id === 'ccgp') throw Object.assign(new Error('secret-upstream-body'), { status: 503, code: 'TENDER_HTTP' });
    return { rows: [{ ...row(2), url: 'https://www.ggzy.gov.cn/information/deal/html/a/320000/0101/new.html' }] };
  });
  f.advance(1800000); await f.center.refresh();
  const result = await f.center.list();
  expect(result.total).toBe(2);
  expect(result.sources[0]).toMatchObject({ state: 'failed', lastSuccess: date, error: { http: 503 } });
  expect(result.sources[1].state).toBe('ok');
  expect(JSON.stringify(result)).not.toContain('secret-upstream-body');
});
it('相同刷新并发合并一次；刷新期间暂停不能被迟到快照覆盖', async () => {
  const f = fixture(); let release;
  f.collector.listing.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const first = f.center.refresh(), second = f.center.refresh();
  expect(first).toBe(second);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await f.center.configure(false); release({ rows: [row(1)] }); await first;
  expect((await f.center.list()).enabled).toBe(false);
  expect(f.collector.listing).toHaveBeenCalledTimes(1);
});
it('自动调度无需请求触发，重启按持久时间等待，不进行模型或历史补跑风暴', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = fixture(); f.center.start();
  await vi.advanceTimersByTimeAsync(2000);
  await vi.waitFor(() => expect(f.collector.listing).toHaveBeenCalledTimes(1));
  await f.center.stop(); const next = f.create(); next.start();
  await vi.advanceTimersByTimeAsync(2000); expect(f.collector.listing).toHaveBeenCalledTimes(1);
  f.advance(TENDER_LIMITS.interval); await vi.advanceTimersByTimeAsync(60000);
  await vi.waitFor(() => expect(f.collector.listing).toHaveBeenCalledTimes(2));
});
it('存储有上限，过期/未来/跨域注入公告不入库，提醒数和订阅数有限', async () => {
  const f = fixture(); f.setRows([row(1, { publishedAt: '2026-01-01' }), row(2, { publishedAt: '2027-01-01' }), row(3, { url: 'http://127.0.0.1/private' }), row(4)]);
  await f.center.refresh(); expect((await f.center.list()).total).toBe(1);
  for (let n = 0; n < TENDER_LIMITS.subscriptions; n++) await f.center.change({ action: 'subscribe', filters: {} });
  await expect(f.center.change({ action: 'subscribe', filters: {} })).rejects.toThrow('20');
  f.setRows(Array.from({ length: 240 }, (_, index) => row(index + 10))); await f.center.refresh();
  expect((await f.center.mine()).alerts).toHaveLength(TENDER_LIMITS.alerts);
});
it('地区不以供应商地址误匹配，预算未知不充0，金额与日期错误不悄悄放宽', () => {
  expect(tenderBudget('人民币1.20亿元')).toBe(1.2e8);
  expect(tenderBudget('100万美元')).toBeNull();
  expect(tenderBudget('第一包100万元；第二包200万元')).toBeNull();
  const unknown = { ...row(1, { region: '浙江', title: '设备采购', snippet: '供应商地址：江苏' }), budget: null };
  expect(tenderMatches(unknown, tenderFilters({ region: '江苏' }))).toBe(false);
  expect(tenderMatches(unknown, tenderFilters({ minBudget: 0 }))).toBe(false);
  for (const input of [{ from: '2026/2/30' }, { minBudget: 'x' }, { minBudget: 20, maxBudget: 10 }, { notice_type: 'invalid' }]) expect(() => tenderFilters(input)).toThrow();
});
it('采集器以真实页面夹具解析，验证码/空页失败，分页只允许固定相对路径', async () => {
  const html = fs.readFileSync(new URL('./fixtures/business-ggzy-list-20261111.html', import.meta.url), 'utf8');
  const get = vi.fn(async () => new Response(html));
  const collector = createTenderCollector({ get });
  expect((await collector.listing(TENDER_SOURCES[1])).rows).toHaveLength(24);
  get.mockResolvedValue(new Response('<html>请验证</html>'));
  await expect(collector.listing(TENDER_SOURCES[0])).rejects.toMatchObject({ code: 'TENDER_LIST_FORMAT' });
  expect(ccgpPages("Pager({size:1000, current:0, prefix:'index',suffix:'htm'});", TENDER_SOURCES[0].url)).toEqual(['https://www.ccgp.gov.cn/cggg/index_1.htm', 'https://www.ccgp.gov.cn/cggg/index_2.htm']);
  expect(ccgpPages("Pager({size:99,current:0,prefix:'http://127.0.0.1/secret',suffix:'htm'})", TENDER_SOURCES[0].url)).toEqual([]);
});

it('收藏与多个订阅命中相同修订只通知一次', async () => {
  const f = fixture(); await f.center.refresh();
  const id = (await f.center.list()).items[0].id;
  await f.center.change({ action: 'favorite', id });
  await f.center.change({ action: 'subscribe', filters: { query: '农业' } });
  await f.center.change({ action: 'subscribe', filters: { region: '江苏' } });
  f.setRows([row(1, { title: '江苏农业项目延期公告', type: 'correction' })]); await f.center.refresh();
  expect((await f.center.mine()).alerts).toHaveLength(1);
  expect((await f.center.mine()).alerts[0].title).toBe('收藏公告有更新');
});

it('目录已保存但通知尚未派发时重启，凭游标补收一次', async () => {
  let active = true;
  const f = fixture({ active: () => active });
  await f.center.change({ action: 'subscribe', filters: { query: '农业' } });
  active = false; await f.center.refresh(); await f.center.stop();
  active = true; const next = f.create();
  expect((await next.mine()).alerts).toHaveLength(1);
  expect((await next.mine()).alerts).toHaveLength(1);
});

it('停止传播到来源请求，迟到采集不能覆盖已保存目录', async () => {
  const f = fixture(); await f.center.refresh(); f.center.start();
  let signal;
  f.collector.listing.mockImplementation(async (_source, s) => { signal = s; return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(s.reason), { once: true })); });
  const pending = f.center.refresh().catch(error => error);
  await vi.waitFor(() => expect(signal).toBeTruthy());
  await f.center.stop(); await pending;
  expect(signal.aborted).toBe(true);
  expect((await f.center.list()).total).toBe(1);
});

it('已收藏项目超过7天仍复查正文，无人收藏的旧正文不反复抓取', async () => {
  const f = fixture(); f.setRows([row(1), row(2)]); await f.center.refresh();
  const first = (await f.center.list()).items.find(item => item.title.includes('项目1'));
  await f.center.change({ action: 'favorite', id: first.id });
  f.advance(8 * 86400000); f.collector.detail.mockClear(); await f.center.refresh();
  expect(f.collector.detail).toHaveBeenCalledTimes(1);
  expect(f.collector.detail.mock.calls[0][0].id).toBe(first.id);
});

it('公共目录到期清理不删除私人收藏；归档快照仍可打开原文和取消收藏', async () => {
  const f = fixture(); await f.center.refresh();
  const saved = (await f.center.list()).items[0]; await f.center.change({ action: 'favorite', id: saved.id });
  f.advance(91 * 86400000); f.setRows([]); await f.center.refresh();
  expect((await f.center.list()).total).toBe(0);
  const favorites = await f.center.list({ favorites: 'true' });
  expect(favorites.items[0]).toMatchObject({ id: saved.id, url: saved.url, archived: true, favorite: true });
  await f.center.change({ action: 'favorite', id: saved.id, enabled: false });
  expect((await f.center.list({ favorites: 'true' })).total).toBe(0);
});
