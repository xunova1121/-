import { describe, it, expect, beforeEach } from 'vitest';
import * as sch from '../src/agent/scheduler.js';
import { collection } from '../src/agent/store.js';
import * as sessions from '../src/agent/sessions.js';
import { createServerSchedules, notices, MAX_NOTICES } from '../server/serverSchedules.mjs';
import { SERVER_BLOCKED } from '../server/taskRunner.mjs';
import { createTools } from '../src/agent/tools.js';

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
const MON_8 = at(2026, 10, 12, 8, 0);

beforeEach(async () => {
  await collection('kv').delete('schedules');
  await collection('kv').delete('scheduleNotices');
});

/** 假的任务执行器：start 记下来，按给定回答立即“做完” */
function fakeRunner(reply = '该吃药了', { status = 'done', error = '' } = {}) {
  const started = [];
  const tasks = new Map();
  return {
    started,
    async start({ sessionId, text }) {
      const id = `t${started.length + 1}`;
      started.push({ id, sessionId, text });
      await sessions.save({ ...sessions.create(), id: sessionId, messages: [{ role: 'user', content: text, ts: 1 }] });
      tasks.set(id, { status, error, text: reply });
      return { id, sessionId };
    },
    edit: async (id, fn) => fn(await sessions.get(id)),
    get: (id) => tasks.get(id) && { id, status: tasks.get(id).status, error: tasks.get(id).error },
    events: (id) => [{ type: 'task_state', status: tasks.get(id).status, text: tasks.get(id).text }]
  };
}

describe('定时任务：防重复与修改', () => {
  it('同一件事、同一个时间说两遍：不建第二个', async () => {
    const a = await sch.upsert({ title: '吃药', prompt: '提醒用户：吃药', ...sch.parseWhen('每天 8:00') });
    const b = await sch.upsert({ title: '吃药提醒', prompt: '提醒用户：吃药', ...sch.parseWhen('每天 8:00') });
    expect(b.duplicate).toBe(true);
    expect(b.id).toBe(a.id);
    expect(await sch.list()).toHaveLength(1);
    // 时间不同就是另一个提醒
    await sch.upsert({ title: '吃药', prompt: '提醒用户：吃药', ...sch.parseWhen('每天 20:00') });
    expect(await sch.list()).toHaveLength(2);
  });

  it('修改只改给出的那项，改时间重新排下一次；暂停 / 恢复', async () => {
    const a = await sch.upsert({ title: '吃药', prompt: '提醒用户：吃药', ...sch.parseWhen('每天 8:00') });
    const b = await sch.update(a.id, { when: '每天 9:30' });
    expect(b).toMatchObject({ id: a.id, kind: 'daily', time: '09:30', prompt: '提醒用户：吃药', title: '吃药', enabled: true });
    expect(new Date(b.nextRun).getHours()).toBe(9);
    expect((await sch.update(a.id, { enabled: false })).enabled).toBe(false);
    expect((await sch.update(a.id, { enabled: true })).nextRun).toBeTruthy();
    expect(await sch.update('不存在', { when: '每天 9:00' })).toBeNull();
    expect(await sch.list()).toHaveLength(1);
  });

  it('工具：update_schedule 改时间，cancel_schedule 找不到 id 时照实说；服务器上开放定时工具并说明由服务器执行', async () => {
    const tools = createTools({ scheduleHost: 'server' });
    const tool = (n) => tools.find((t) => t.name === n);
    const made = await tool('schedule_task').run({ title: '喝水', prompt: '提醒用户：喝水', when: '每天 15:00' });
    expect(made).toMatch(/服务器自动执行/);
    expect(made).toMatch(/北京时间/);
    expect(await tool('schedule_task').run({ title: '喝水', prompt: '提醒用户：喝水', when: '每天 15:00' })).toMatch(/没有重复创建/);
    const [s] = await sch.list();
    expect(await tool('update_schedule').run({ id: s.id, when: '每天 16:00' })).toMatch(/每天 16:00/);
    expect(await tool('cancel_schedule').run({ id: 'nope' })).toMatch(/没有找到/);
    expect(await tool('cancel_schedule').run({ id: s.id })).toMatch(/已删除「喝水」/);
    for (const n of ['schedule_task', 'list_schedules', 'update_schedule', 'cancel_schedule']) expect(SERVER_BLOCKED.has(n)).toBe(false);
    expect(await createTools({}).find((t) => t.name === 'schedule_task').run({ title: '喝水', prompt: '提醒用户：喝水', when: '每天 15:00' })).toMatch(/应用需要在运行中/);
  });
});

describe('服务器按时执行', () => {
  it('到点新开“⏰”对话交给任务执行器，记下结果并留通知；同一次不跑第二遍', async () => {
    const s = await sch.upsert({ title: '吃药', prompt: '提醒用户：吃药', ...sch.parseWhen('每天 8:00') });
    let clock = s.nextRun + 1000;
    const runner = fakeRunner('该吃药了，记得饭后吃。');
    const loop = createServerSchedules({ runner, now: () => clock, pollMs: 1 });
    await loop.tick();
    expect(runner.started).toHaveLength(1);
    expect(runner.started[0].text).toMatch(/定时任务「吃药」/);
    const sess = await sessions.get(runner.started[0].sessionId);
    expect(sess.title).toBe('⏰ 吃药');
    const [after] = await sch.list();
    expect(after).toMatchObject({ lastStatus: 'ok', runs: 1, lastSession: sess.id });
    expect(after.nextRun).toBeGreaterThan(clock);
    const list = await notices(0);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: '⏰ 吃药', body: '该吃药了，记得饭后吃。', sessionId: sess.id });
    expect(await notices(list[0].at)).toHaveLength(0);
    // 同一分钟再检查一次（或服务重启后新的计时器）：不重复执行
    await createServerSchedules({ runner, now: () => clock, pollMs: 1 }).tick();
    expect(runner.started).toHaveLength(1);
  });

  it('开始执行时服务重启（已 claim、没记结果）：重启后不把同一次再跑一遍', async () => {
    const s = await sch.upsert({ title: '日报', prompt: '总结今天新闻', ...sch.parseWhen('每天 8:00') });
    const clock = s.nextRun + 1000;
    await sch.claim(s.id, clock); // 旧进程到这一步就挂了
    const runner = fakeRunner();
    await createServerSchedules({ runner, now: () => clock, pollMs: 1 }).tick();
    expect(runner.started).toHaveLength(0);
    expect((await sch.list())[0].nextRun).toBeGreaterThan(clock);
  });

  it('服务器关着错过的：12 小时内补跑一次，更早的排到下一次', async () => {
    const s = await sch.upsert({ title: '日报', prompt: '总结今天新闻', ...sch.parseWhen('每天 8:00') });
    const runner = fakeRunner();
    await createServerSchedules({ runner, now: () => s.nextRun + 3 * 3600_000, pollMs: 1 }).tick();
    expect(runner.started).toHaveLength(1);
    const late = await sch.upsert({ title: '周报', prompt: '写周报', kind: 'once', at: Date.now() + 60_000 });
    await createServerSchedules({ runner, now: () => late.nextRun + 13 * 3600_000, pollMs: 1 }).tick();
    expect(runner.started).toHaveLength(1);
    expect((await sch.list()).find((x) => x.id === late.id)).toMatchObject({ enabled: false, lastStatus: '错过（应用当时没有运行）' });
  });

  it('一次性提醒做完就停用；【无需通知】不留通知；失败照实记下并通知', async () => {
    const once = await sch.upsert({ title: '开会', prompt: '提醒用户：开会', kind: 'once', at: Date.now() + 60_000 });
    await createServerSchedules({ runner: fakeRunner('【无需通知】还没降价'), now: () => once.nextRun + 1000, pollMs: 1 }).tick();
    expect((await sch.list())[0]).toMatchObject({ enabled: false, lastStatus: 'quiet' });
    expect(await notices(0)).toHaveLength(0);
    const bad = await sch.upsert({ title: '查价', prompt: '查机票价格', kind: 'once', at: Date.now() + 60_000 });
    await createServerSchedules({ runner: fakeRunner('', { status: 'error', error: '模型接口出错' }), now: () => bad.nextRun + 1000, pollMs: 1 }).tick();
    expect((await sch.list()).find((x) => x.id === bad.id).lastStatus).toMatch(/失败：模型接口出错/);
    expect((await notices(0))[0]).toMatchObject({ title: '⏰ 查价', body: '失败：模型接口出错' });
  });

  it('“立即运行”在后台做，已有任务在跑时不叠加；通知最多留最近 50 条', async () => {
    const s = await sch.upsert({ title: '喝水', prompt: '提醒用户：喝水', ...sch.parseWhen('每天 15:00') });
    const runner = fakeRunner('喝水啦');
    const loop = createServerSchedules({ runner, pollMs: 1 });
    expect(loop.runNow(s)).toBe(true);
    expect(loop.runNow(s)).toBe(false);
    for (let i = 0; i < 100 && loop.busy; i++) await new Promise((r) => setTimeout(r, 5));
    expect(runner.started).toHaveLength(1);
    expect(MAX_NOTICES).toBe(50);
  });
});

describe('手机 / 电脑在服务器模式下管理服务器上的定时任务', () => {
  it('面板的增删改查都走服务器接口', async () => {
    const { serverScheduleStore } = await import('../src/ui/schedulesPanel.js');
    const { createServerClient } = await import('../src/core/serverClient.js');
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push(`${init.method || 'GET'} ${new URL(url).pathname}${new URL(url).search}`);
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const client = createServerClient({ base: 'https://d.example.com', token: 't', fetchImpl });
    const store = serverScheduleStore(client);
    await store.list();
    await store.setEnabled('a1', false);
    await store.remove('a1');
    await store.upsert({ title: 'x', prompt: 'y', kind: 'daily', time: '09:00' });
    await client.notices(123);
    await client.runSchedule('a1');
    expect(store.server).toBe(true);
    expect(calls).toEqual(['GET /api/server/schedules', 'PATCH /api/server/schedules/a1', 'DELETE /api/server/schedules/a1', 'POST /api/server/schedules', 'GET /api/server/notices?after=123', 'POST /api/server/schedules/a1/run']);
  });
});
