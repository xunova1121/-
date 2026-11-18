/** 2026-11-18 用户：手指滑动是返回，现在直接退出了；检查所有页面是返回上级还是退出 */
import { describe, expect, it, vi } from 'vitest';
import { createBackNavigation } from '../src/mobile/backNavigation.js';

/** 极简页面：只实现返回逻辑用到的接口 */
function page() {
  const els = [], classes = new Set(), events = [];
  const el = (props) => {
    const e = { hidden: false, parent: null, clicked: 0, listeners: {}, ...props,
      closest(sel) { let p = this.parent; while (p) { if (sel === '[hidden]' && p.hidden) return p; p = p.parent; } return null; },
      click() { this.clicked++; this.onclick?.(); },
      dispatchEvent(ev) { (this.listeners[ev.type] || []).forEach(f => f(ev)); return true; },
      addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
      replaceChildren() { this.emptied = true; } };
    els.push(e); return e;
  };
  const doc = {
    body: { classList: { contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c) } },
    querySelectorAll: sel => els.filter(e => e.matches?.includes(sel)),
    querySelector: sel => els.find(e => e.matches?.includes(sel)) || null,
    getElementById: id => els.find(e => e.id === id) || null,
    dispatchEvent: ev => { events.push(ev.key || ev.type); return true; }
  };
  return { doc, el, classes, events };
}
const nav = (p, o = {}) => createBackNavigation({ doc: p.doc, win: { dispatchEvent: e => p.events.push(e.type) }, ...o });
globalThis.KeyboardEvent ??= class extends Event { constructor(t, o) { super(t, o); this.key = o.key; } };

describe('返回逐层退', () => {
  it('弹窗最先关，多个弹窗先关最后打开的', () => {
    const p = page(), a = p.el({ matches: ['dialog[open]'], open: true, close() { this.open = false; } }), b = p.el({ matches: ['dialog[open]'], open: true, close() { this.open = false; } });
    expect(nav(p)()).toBe('dialog');
    expect(b.open).toBe(false); expect(a.open).toBe(true);
  });
  it('底部选择面板点关闭；菜单发 Esc', () => {
    const p = page(), x = p.el({ matches: ['.mp-sheet .x-btn'] });
    expect(nav(p)()).toBe('sheet'); expect(x.clicked).toBe(1);
    const q = page(); q.classes.add('ml-modal-open');
    expect(nav(q)()).toBe('menu'); expect(q.events).toContain('Escape');
  });
  it('文件预览先回到文件列表，不直接关掉整个面板或退出 App', () => {
    const p = page(); p.classes.add('side-open');
    const viewer = p.el({ id: 'viewer' }), body = p.el({ id: 'viewer-body' }), back = p.el({ id: 'btn-side-back' });
    const handle = nav(p);
    expect(handle()).toBe('viewer');
    expect(viewer.hidden).toBe(true); expect(body.emptied).toBe(true); expect(back.clicked).toBe(0);
    expect(handle()).toBe('panel'); expect(back.clicked).toBe(1);
  });
  it('隐藏面板里的预览不算打开（不拦截返回）', () => {
    const p = page(), pane = p.el({ hidden: true }), viewer = p.el({ id: 'viewer', parent: pane });
    p.classes.add('side-open'); p.el({ id: 'btn-side-back' });
    expect(nav(p)()).toBe('panel'); expect(viewer.hidden).toBe(false);
  });
  it('工作台菜单、抽屉、侧边面板依次回到对话', () => {
    const w = page(); w.classes.add('workbench'); w.classes.add('weiyang-menu-open'); w.classes.add('side-closed');
    expect(nav(w)()).toBe('workbench'); expect(w.events).toContain('weiyang:back');
    const d = page(); d.classes.add('drawer-open'); const scrim = d.el({ matches: ['.drawer-scrim'] });
    expect(nav(d)()).toBe('drawer'); expect(scrim.clicked).toBe(1);
  });
  it('对话首页：第一次只提示，2秒内再滑才退到后台；超过2秒重新提示', () => {
    const p = page(), minimize = vi.fn(), toast = vi.fn();
    let t = 1000;
    const handle = nav(p, { minimize, toast, now: () => t });
    expect(handle()).toBe('confirm'); expect(toast).toHaveBeenCalledWith('再滑一次退到后台'); expect(minimize).not.toHaveBeenCalled();
    t += 1500; expect(handle()).toBe('minimize'); expect(minimize).toHaveBeenCalledTimes(1);
    t += 100; expect(handle()).toBe('confirm');
    t += 2500; expect(handle()).toBe('confirm'); expect(minimize).toHaveBeenCalledTimes(1);
  });
});
