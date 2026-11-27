import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { executeScheduled, parseReply, scheduledPrompt, notificationFor, IDLE_MS, QUIET_MARK, TIMEOUT_NOTE, EMPTY_NOTE } from '../src/agent/scheduledRun.js';
import * as sch from '../src/agent/scheduler.js';
import { collection } from '../src/agent/store.js';

const MIN = 60_000;

describe('卡住保护', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('连续 10 分钟没有进展：中断（signal）并记为失败，即使工具不理会中断也能返回', async () => {
    let signal;
    // 模拟一个卡死的模型 / 工具：永远不返回，也不理会 signal
    const p = executeScheduled((o) => { signal = o.signal; return new Promise(() => {}); });
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(signal.aborted).toBe(true);
    expect(r).toMatchObject({ ok: false, timedOut: true, note: TIMEOUT_NOTE });
  });

  it('一直有进展（输出 / 工具事件）的长任务不会被中断', async () => {
    const events = [];
    const p = executeScheduled(async ({ emit, signal }) => {
      for (let i = 0; i < 6; i++) { // 共 30 分钟，每 5 分钟一个事件
        await new Promise((r) => setTimeout(r, 5 * MIN));
        emit({ type: i % 2 ? 'text' : 'tool_end', name: 'web_search' });
      }
      expect(signal.aborted).toBe(false);
      return { text: '调研完成' };
    }, { onEvent: (e) => events.push(e.type) });
    await vi.advanceTimersByTimeAsync(30 * MIN);
    const r = await p;
    expect(r).toMatchObject({ ok: true, text: '调研完成', timedOut: false });
    expect(events).toHaveLength(6);
  });

  it('runAgent 自己因中断抛错时同样记为超时', async () => {
    const p = executeScheduled(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }), { idleMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toMatchObject({ ok: false, timedOut: true, note: TIMEOUT_NOTE });
  });
});

describe('回复判定', () => {
  it('空回复算失败：“没有得到结果”', async () => {
    for (const text of ['', '   \n ', undefined]) {
      expect(await executeScheduled(async () => ({ text }))).toMatchObject({ ok: false, note: EMPTY_NOTE });
    }
  });

  it('普通错误：记为失败并带上原因', async () => {
    const r = await executeScheduled(async () => { throw new Error('模型服务 502'); });
    expect(r).toMatchObject({ ok: false, timedOut: false, note: '模型服务 502' });
  });

  it('【无需通知】：识别为 quiet，标记从结果里去掉', async () => {
    expect(parseReply(`${QUIET_MARK}还没降价，现价 3999 元。`)).toEqual({ quiet: true, text: '还没降价，现价 3999 元。' });
    expect(parseReply(`  ${QUIET_MARK}`)).toEqual({ quiet: true, text: '' });
    expect(parseReply('降价了！现价 2999 元')).toEqual({ quiet: false, text: '降价了！现价 2999 元' });
    // 只在开头才算
    expect(parseReply(`降价了。不要写${QUIET_MARK}`).quiet).toBe(false);
    const r = await executeScheduled(async () => ({ text: `${QUIET_MARK}还没降价` }));
    expect(r).toMatchObject({ ok: true, quiet: true, text: '还没降价' });
    // 只有标记、没写其他内容：照样算“已检查，无需通知”，不算空回复
    expect(await executeScheduled(async () => ({ text: QUIET_MARK }))).toMatchObject({ ok: true, quiet: true });
  });

  it('任务说明里告诉模型怎么写【无需通知】', () => {
    const p = scheduledPrompt({ title: '盯价格', prompt: '降价了再告诉我' }, '每天 09:00');
    expect(p).toContain('盯价格');
    expect(p).toContain(QUIET_MARK);
    expect(p.endsWith('降价了再告诉我')).toBe(true);
  });
});

describe('通知', () => {
  beforeEach(async () => { await collection('kv').delete('schedules'); });
  const s = { title: '盯价格' };

  it('【无需通知】不弹通知，但结果照样记录，任务列表显示“已检查，无需通知”', async () => {
    const task = await sch.upsert({ title: '盯价格', prompt: '降价了再告诉我', kind: 'daily', time: '09:00' });
    const res = await executeScheduled(async () => ({ text: `${QUIET_MARK}还没降价` }));
    const rec = await sch.recordRun(task.id, { ok: res.ok, quiet: res.quiet, session: 'sess1', note: res.note });
    expect(notificationFor(s, res, rec)).toBeNull();
    expect(rec.lastStatus).toBe('quiet');
    expect(rec.lastSession).toBe('sess1');
    expect(rec.fails).toBe(0);
  });

  it('正常结果、失败、自动暂停各自的通知内容', () => {
    expect(notificationFor(s, { ok: true, quiet: false, text: '降价了\n现价 2999', note: '' }, {})).toEqual({ title: '⏰ 盯价格', body: '降价了 现价 2999' });
    expect(notificationFor(s, { ok: false, quiet: false, text: '', note: TIMEOUT_NOTE }, {})).toEqual({ title: '⏰ 盯价格', body: `失败：${TIMEOUT_NOTE}` });
    const paused = notificationFor(s, { ok: false, quiet: false, text: '', note: EMPTY_NOTE }, { paused: true, lastStatus: sch.PAUSED_STATUS });
    expect(paused.body).toContain('连续失败 3 次，已暂停，请检查后重新启用');
    expect(paused.body).toContain(EMPTY_NOTE);
  });
});
