import { describe, it, expect, beforeEach } from 'vitest';
import * as sch from '../src/agent/scheduler.js';
import { collection } from '../src/agent/store.js';

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
// 2026-10-12 是星期一
const MON_8 = at(2026, 10, 12, 8, 0);

beforeEach(async () => { await collection('kv').delete('schedules'); });

describe('时间解析', () => {
  it('口语化的说法', () => {
    expect(sch.parseWhen('每天早上9点', MON_8)).toEqual({ kind: 'daily', time: '09:00' });
    expect(sch.parseWhen('工作日 18:30')).toEqual({ kind: 'workdays', time: '18:30' });
    expect(sch.parseWhen('每周五下午5点半')).toEqual({ kind: 'weekly', weekday: 5, time: '17:30' });
    expect(sch.parseWhen('每周日 20:00')).toEqual({ kind: 'weekly', weekday: 0, time: '20:00' });
    expect(sch.parseWhen('每30分钟')).toEqual({ kind: 'interval', everyMinutes: 30 });
    expect(sch.parseWhen('每小时')).toEqual({ kind: 'interval', everyMinutes: 60 });
    expect(sch.parseWhen('明天 8点', MON_8)).toEqual({ kind: 'once', at: at(2026, 10, 13, 8, 0) });
    expect(sch.parseWhen('2026-10-20 15:00')).toEqual({ kind: 'once', at: at(2026, 10, 20, 15, 0) });
    expect(sch.parseWhen('10分钟后', MON_8)).toEqual({ kind: 'once', at: MON_8 + 600000 });
    expect(() => sch.parseWhen('有空的时候')).toThrow(/看不懂/);
  });
});

describe('下一次运行时间', () => {
  it('每天 / 工作日 / 每周 / 一次 / 间隔', () => {
    expect(sch.nextRun({ kind: 'daily', time: '09:00' }, MON_8)).toBe(at(2026, 10, 12, 9, 0));
    expect(sch.nextRun({ kind: 'daily', time: '07:00' }, MON_8)).toBe(at(2026, 10, 13, 7, 0));
    const fri18 = at(2026, 10, 16, 18, 0);
    expect(sch.nextRun({ kind: 'workdays', time: '09:00' }, fri18)).toBe(at(2026, 10, 19, 9, 0)); // 跳过周末
    expect(sch.nextRun({ kind: 'weekly', weekday: 5, time: '17:30' }, MON_8)).toBe(at(2026, 10, 16, 17, 30));
    expect(sch.nextRun({ kind: 'once', at: MON_8 - 1 }, MON_8)).toBeNull();
    expect(sch.nextRun({ kind: 'interval', everyMinutes: 30, lastRun: MON_8 }, MON_8 + 1000)).toBe(MON_8 + 30 * 60000);
  });
  it('描述', () => {
    expect(sch.describe({ kind: 'weekly', weekday: 5, time: '17:30' })).toBe('每周五 17:30');
    expect(sch.describe({ kind: 'workdays', time: '09:00' })).toBe('工作日 09:00');
  });
});

describe('存取与到期', () => {
  it('新建、到期、记录运行后排下一次；一次性任务跑完即停用', async () => {
    const s = await sch.upsert({ title: '晨报', prompt: '总结今天的安排', kind: 'daily', time: '09:00' });
    const first = s.nextRun;
    expect(first).toBeGreaterThan(Date.now());
    const later = first + 1000;
    expect((await sch.due(later)).map((x) => x.id)).toEqual([s.id]);
    const r = await sch.recordRun(s.id, { ok: true, session: 'c1', at: later });
    expect(r.nextRun).toBe(first + 86400000);
    expect(r.runs).toBe(1);
    const once = await sch.upsert({ title: '提醒', prompt: '提醒我开会', kind: 'once', at: Date.now() + 60000 });
    await sch.recordRun(once.id, { ok: true, at: Date.now() + 61000 });
    expect((await sch.list()).find((x) => x.id === once.id).enabled).toBe(false);
  });
  it('错过太久的不补跑', async () => {
    const s = await sch.upsert({ title: 'x', prompt: 'y', kind: 'daily', time: '09:00' });
    const muchLater = s.nextRun + 20 * 3600_000;
    expect(await sch.due(muchLater)).toEqual([]);
    expect((await sch.list())[0].nextRun).toBeGreaterThan(muchLater);
  });
  it('校验', async () => {
    await expect(sch.upsert({ title: 'x', prompt: '', kind: 'daily', time: '09:00' })).rejects.toThrow(/做什么/);
    await expect(sch.upsert({ title: 'x', prompt: 'y', kind: 'once', at: Date.now() - 1000 })).rejects.toThrow(/过去/);
  });
});

describe('先排下一次再执行（崩溃不重复）', () => {
  it('周期任务：claim 后中途崩溃（没有 recordRun），重启后同一次不会再跑', async () => {
    const s = await sch.upsert({ title: '晨报', prompt: '总结今天的安排', kind: 'daily', time: '09:00' });
    const first = s.nextRun; // 测试用的内存存储返回同一个对象，claim 之后 s 也会变
    const fire = first + 1000;
    expect((await sch.due(fire)).map((x) => x.id)).toEqual([s.id]);
    const claimed = await sch.claim(s.id, fire);
    expect(claimed.nextRun).toBe(first + 86400000); // 已经存好下一次
    // 模拟重启：几分钟后重新检查到期任务
    expect(await sch.due(fire + 5 * 60_000)).toEqual([]);
    // 到了第二天照常运行
    expect((await sch.due(first + 86400000 + 1000)).map((x) => x.id)).toEqual([s.id]);
  });

  it('间隔任务：claim 从开始时间排下一次', async () => {
    const s = await sch.upsert({ title: '巡检', prompt: '看看服务器', kind: 'interval', everyMinutes: 30 });
    const fire = s.nextRun + 1000;
    const claimed = await sch.claim(s.id, fire);
    expect(claimed.nextRun).toBe(fire + 30 * 60_000);
    expect(await sch.due(fire + 60_000)).toEqual([]);
  });

  it('一次性任务：崩溃后允许重试一次，再中断就停用', async () => {
    const at = Date.now() + 60_000;
    const s = await sch.upsert({ title: '提醒', prompt: '提醒我开会', kind: 'once', at });
    const fire = at + 1000;
    expect((await sch.due(fire)).map((x) => x.id)).toEqual([s.id]);
    await sch.claim(s.id, fire); // 第一次开始后崩溃
    expect((await sch.due(fire + 60_000)).map((x) => x.id)).toEqual([s.id]); // 重启后重试一次
    await sch.claim(s.id, fire + 60_000); // 第二次开始后又崩溃
    expect(await sch.due(fire + 120_000)).toEqual([]);
    const after = (await sch.list())[0];
    expect(after.enabled).toBe(false);
    expect(after.lastStatus).toMatch(/中途中断两次/);
  });

  it('一次性任务重试成功：正常完成并停用', async () => {
    const at = Date.now() + 60_000;
    const s = await sch.upsert({ title: '提醒', prompt: '提醒我开会', kind: 'once', at });
    await sch.claim(s.id, at + 1000);
    expect((await sch.due(at + 60_000)).map((x) => x.id)).toEqual([s.id]);
    await sch.claim(s.id, at + 60_000);
    const r = await sch.recordRun(s.id, { ok: true, at: at + 90_000 });
    expect(r).toMatchObject({ enabled: false, lastStatus: 'ok', attempts: 0 });
  });
});

describe('连续失败自动暂停', () => {
  it('连续失败 3 次被暂停，状态写明原因', async () => {
    const s = await sch.upsert({ title: '盯价格', prompt: '降价了再告诉我', kind: 'daily', time: '09:00' });
    let t = s.nextRun;
    let r;
    for (let i = 1; i <= 2; i++) {
      r = await sch.recordRun(s.id, { ok: false, note: '没有得到结果', at: (t += 86400000) });
      expect(r).toMatchObject({ fails: i, enabled: true, paused: false });
    }
    r = await sch.recordRun(s.id, { ok: false, note: '没有得到结果', at: (t += 86400000) });
    expect(r).toMatchObject({ fails: 3, enabled: false, nextRun: null, paused: true, lastStatus: '连续失败 3 次，已暂停，请检查后重新启用' });
    expect(await sch.due(t + 3 * 86400000)).toEqual([]);
  });

  it('成功一次（包括“无需通知”）就清零', async () => {
    const s = await sch.upsert({ title: '盯价格', prompt: '降价了再告诉我', kind: 'daily', time: '09:00' });
    await sch.recordRun(s.id, { ok: false, note: 'x' });
    await sch.recordRun(s.id, { ok: false, note: 'x' });
    expect((await sch.recordRun(s.id, { ok: true, quiet: true })).fails).toBe(0);
    await sch.recordRun(s.id, { ok: false, note: 'x' });
    await sch.recordRun(s.id, { ok: false, note: 'x' });
    expect((await sch.recordRun(s.id, { ok: true })).fails).toBe(0);
    const r = await sch.recordRun(s.id, { ok: false, note: 'x' });
    expect(r).toMatchObject({ fails: 1, enabled: true, paused: false });
  });

  it('用户重新启用也清零（开关和编辑保存两种方式）', async () => {
    const s = await sch.upsert({ title: '盯价格', prompt: '降价了再告诉我', kind: 'daily', time: '09:00' });
    for (let i = 0; i < 3; i++) await sch.recordRun(s.id, { ok: false, note: 'x' });
    await sch.setEnabled(s.id, true);
    let cur = (await sch.list())[0];
    expect(cur).toMatchObject({ enabled: true, fails: 0 });
    expect(cur.nextRun).toBeGreaterThan(Date.now());
    for (let i = 0; i < 3; i++) await sch.recordRun(s.id, { ok: false, note: 'x' });
    cur = await sch.upsert({ ...(await sch.list())[0], enabled: true });
    expect(cur).toMatchObject({ enabled: true, fails: 0 });
  });
});
