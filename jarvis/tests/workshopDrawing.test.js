import { describe, it, expect, vi } from 'vitest';
import { createWorkshopDrawing } from '../src/mobile/workshopDrawing.js';

function fixture() {
  const calls = [];
  const renders = [];
  const change = createWorkshopDrawing({
    plugin: () => ({ setWorkshopDrawing(options) {
      return new Promise((resolve, reject) => calls.push({ ...options, resolve, reject }));
    } }),
    now: () => 100,
    show: () => renders.push('show'),
    hide: () => renders.push('hide'),
    failed: reason => renders.push(reason)
  });
  return { change, calls, renders };
}

describe('手机小屋与聊天各自的绘制模式', () => {
  it('等待原生确认，重复的前台通知不重建；快速进出时丢弃上次进入的回执', async () => {
    const { change, calls, renders } = fixture();
    change(true); change(true); change(false); change(true);
    expect(calls.map(({active, revision}) => [active, revision])).toEqual([[true,100],[false,101],[true,102]]);
    expect(renders).toEqual(['hide']);
    calls[0].resolve({ status: 'applied', active: true });
    calls[1].resolve({ status: 'applied', active: false, softwareLayer: true });
    await Promise.resolve();
    expect(renders).toEqual(['hide']);
    calls[2].resolve({ status: 'applied', active: true, softwareLayer: false });
    await Promise.resolve();
    change(true);
    expect(renders).toEqual(['hide','show']);
    expect(calls).toHaveLength(3);
  });

  it('前后台通知错序时可以在回到前台时重试，原生限制期间不播放', async () => {
    const { change, calls, renders } = fixture();
    change(true);
    calls[0].resolve({ status: 'background', active: false });
    await Promise.resolve();
    expect(renders).toEqual([]);
    change(true);
    calls[1].resolve({ status: 'cooldown', active: false });
    await Promise.resolve();
    expect(renders).toEqual(['cooldown']);
    change(false);
    expect(calls.at(-1).active).toBe(false);
  });

  it('浏览器与旧安装包仍能打开，已经退出时旧的错误回执不显示提示', async () => {
    const show = vi.fn(), hide = vi.fn(), failed = vi.fn();
    const web = createWorkshopDrawing({ show, hide, failed, plugin: () => null });
    web(true); web(false);
    expect(show).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledOnce();
    const { change, calls, renders } = fixture();
    change(true);
    calls[0].reject(Object.assign(new Error('missing method'), { code: 'UNIMPLEMENTED' }));
    await Promise.resolve();
    change(false); change(true); change(false);
    calls[2].reject(new Error('bridge detached'));
    await Promise.resolve();
    expect(renders).toEqual(['show','hide','hide']);
  });
});
