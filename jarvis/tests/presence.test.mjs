import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createPresence } from '../desktop/presence.mjs';
import { attachScript, hwndOf } from '../desktop/wallpaper.mjs';
import { composeGreeting, nameFrom, timeGreeting } from '../src/core/greeting.js';

describe('在场检测', () => {
  function setup() {
    const pm = Object.assign(new EventEmitter(), { idle: 0, getSystemIdleTime() { return this.idle; } });
    let t = 1_000_000;
    const events = [];
    const p = createPresence({ powerMonitor: pm, onBack: (i) => events.push(['back', i]), onAway: (r) => events.push(['away', r]), awayAfterSec: 300, pollMs: 10000, now: () => t });
    p.start();
    return { pm, p, events, advance: (ms) => { t += ms; } };
  }
  it('空闲 5 分钟算离开，有操作算回来，带上离开时长', () => {
    const { pm, p, events, advance } = setup();
    pm.idle = 299; p.poll();
    expect(events).toEqual([]);
    pm.idle = 300; p.poll();
    expect(events[0]).toEqual(['away', 'idle']);
    advance(3600_000);
    pm.idle = 1; p.poll();
    expect(events[1][0]).toBe('back');
    expect(events[1][1].awayMs).toBe(3600_000 + 300_000);
    p.stop();
  });
  it('锁屏 / 解锁', () => {
    const { pm, events, advance, p } = setup();
    pm.emit('lock-screen');
    advance(1200_000);
    pm.emit('unlock-screen');
    expect(events).toEqual([['away', 'lock'], ['back', { awayMs: 1200_000, reason: 'unlock' }]]);
    p.stop();
  });
});

describe('桌面背景', () => {
  it('窗口句柄与挂载脚本', () => {
    const b = Buffer.alloc(8); b.writeBigUInt64LE(132456n);
    expect(hwndOf(b)).toBe('132456');
    expect(attachScript('132456')).toContain('[IntPtr]::new(132456)');
    expect(attachScript('1')).toContain('WorkerW');
    expect(() => attachScript('1; rm -rf')).toThrow();
  });
});

describe('主动问好', () => {
  it('称呼与时段', () => {
    expect(nameFrom('用户叫小王，在上海工作')).toBe('小王');
    expect(nameFrom('称呼他为王总。')).toBe('王总');
    expect(nameFrom('用户在上海')).toBe('');
    expect(timeGreeting(8)).toBe('早上好');
    expect(timeGreeting(15)).toBe('下午好');
  });
  it('模板：优先提上次没做完的事，其次今天的定时任务', async () => {
    const now = new Date(2026, 9, 12, 9, 5);
    const sched = [{ title: '写周报', nextRun: new Date(2026, 9, 12, 17, 30).getTime() }, { title: '明天的', nextRun: new Date(2026, 9, 13, 9, 0).getTime() }];
    const a = await composeGreeting({ now, awayMs: 5 * 3600_000, coreHuman: '用户叫小王', openItems: [{ text: '明天再帮我算一下厨房报价' }], schedules: sched });
    expect(a.text).toBe('上午好，小王。欢迎回来。上次说好的「明天再帮我算一下厨房报价」，要现在接着做吗？');
    const b = await composeGreeting({ now, awayMs: 20 * 60_000, schedules: sched });
    expect(b.text).toBe('上午好。今天还有 1 个定时任务，下一个是 17:30 的「写周报」。');
    const c = await composeGreeting({ now, awayMs: 20 * 60_000 });
    expect(c.text).toBe('上午好。有什么需要我做的，随时说。');
  });
  it('有大模型时让模型说，失败或太长时退回模板', async () => {
    const now = new Date(2026, 9, 12, 20, 0);
    let prompt = '';
    const ok = await composeGreeting({ now, awayMs: 3600_000, openItems: [{ text: '整理发票' }], llm: async (p) => { prompt = p.prompt; return '“晚上好，发票还没整理，要我现在开始吗？”'; } });
    expect(ok.text).toBe('晚上好，发票还没整理，要我现在开始吗？');
    expect(prompt).toContain('上次说好以后再做：整理发票');
    const bad = await composeGreeting({ now, awayMs: 3600_000, llm: async () => { throw new Error('x'); } });
    expect(bad.text).toMatch(/^晚上好。/);
  });
});
