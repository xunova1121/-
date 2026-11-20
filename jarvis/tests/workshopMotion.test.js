import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkshopMotion, stationForStep } from '../src/ui/workshopMotion.js';

describe('PC 工位上的动作', () => {
  let scene, motion, entries;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('document', { body: { classList: { contains: () => false } } });
    scene = { dataset: {} };
    motion = createWorkshopMotion(scene, { dataset: {} });
    entries = [];
  });
  afterEach(() => { motion.reset(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  function show(entry, mode = 'live', active = true) {
    const index = entries.findIndex(step => step.id === entry.id);
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
    const working = entry.status === 'running' && mode === 'live' || mode === 'play';
    motion.show(stationForStep(entries, entries.findIndex(step => step.id === entry.id)), { entry, entries, mode, active, working, travel: false });
  }
  const write = { id: 'w', station: 'bench', operation: 'write', pose: 'edit', status: 'running' };
  const type = { id: 'v', station: 'review', operation: 'type', pose: 'think', status: 'running' };
  const end = { id: 'end', pose: 'cheer', status: 'done' };

  it('瞬时完成的工作回执能做一次手部动作，即使渲染时最新事件已是回复结束', () => {
    show(write);
    show({ ...write, status: 'done' });
    show(end, 'live', false);
    expect(scene.dataset).toMatchObject({ operation: 'write', workPhase: 'working', workReceipt: 'true' });
    vi.advanceTimersByTime(641);
    expect(scene.dataset).toMatchObject({ operation: 'none', workPhase: 'idle', workReceipt: 'false' });
    show(end, 'live', false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('缓冲只保留最近一次；新工序、停止以及手动回看均可立即中断', () => {
    show(write);
    show({ ...write, status: 'done' });
    show(type);
    expect(scene.dataset).toMatchObject({ station: 'review', operation: 'type', workReceipt: 'false' });
    show({ ...type, status: 'done' });
    show({ id: 'stop', pose: 'stop', status: 'stopped' }, 'live', false);
    expect(scene.dataset).toMatchObject({ operation: 'none', workPhase: 'idle' });
    show(type, 'manual', false);
    expect(scene.dataset).toMatchObject({ operation: 'type', workPhase: 'snapshot' });
    show(type, 'play', false);
    expect(scene.dataset.workPhase).toBe('working');
    motion.reset();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('极速流式回复只在同一轮确实完成时补画，历史重开时保持静止', () => {
    const reply = { ...write, station: undefined };
    show(reply);
    entries[0] = { ...reply, status: 'done' };
    show(end, 'live', false);
    expect(scene.dataset.workReceipt).toBe('true');
    motion.reset();
    show(end, 'live', false);
    expect(scene.dataset).toMatchObject({ operation: 'none', workReceipt: 'false' });
  });
});
