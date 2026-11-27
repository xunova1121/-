import { describe, it, expect } from 'vitest';
import { initStandbyToggle } from '../src/mobile/standby.js';

const page = () => {
  const row = { hidden: true };
  const input = { checked: false, disabled: false, handlers: [], addEventListener(type, fn) { this.handlers.push(fn); } };
  return { row, input, doc: { getElementById: (id) => ({ 'row-standby': row, 'set-standby': input })[id] } };
};

describe('后台待命开关', () => {
  it('安卓 App 里显示，读出原生的开关状态；打开、关闭都交给原生', async () => {
    const calls = [];
    let on = false;
    const plugin = { standby: async (o) => { calls.push(o); if (typeof o.on === 'boolean') on = o.on; return { on }; } };
    const { row, input, doc } = page();
    const toasts = [];
    await initStandbyToggle({ plugin, doc, toast: (t) => toasts.push(t) });
    expect(row.hidden).toBe(false);
    expect(input.checked).toBe(false);
    input.checked = true;
    await input.handlers[0]();
    expect(calls.at(-1)).toEqual({ on: true });
    expect(input.checked).toBe(true);
    expect(toasts.at(-1)).toMatch(/已开启/);
  });
  it('网页版、电脑版（没有原生插件）或旧版 App：不显示', async () => {
    const a = page();
    await initStandbyToggle({ plugin: undefined, doc: a.doc });
    expect(a.row.hidden).toBe(true);
    const b = page();
    await initStandbyToggle({ plugin: { standby: async () => { throw new Error('not implemented'); } }, doc: b.doc });
    expect(b.row.hidden).toBe(true);
  });
  it('设置失败：开关退回原状并提示', async () => {
    const { input, doc } = page();
    const toasts = [];
    let first = true;
    await initStandbyToggle({ plugin: { standby: async () => { if (first) { first = false; return { on: false }; } throw new Error('权限不足'); } }, doc, toast: (t) => toasts.push(t) });
    input.checked = true;
    await input.handlers[0]();
    expect(input.checked).toBe(false);
    expect(toasts.at(-1)).toMatch(/没设置成功/);
  });
});
