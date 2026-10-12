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
