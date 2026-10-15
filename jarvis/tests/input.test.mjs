import { describe, it, expect } from 'vitest';
import { parseKeys, winScript, winVk, macScript, xdoArgs, pasteCombo, createInput } from '../desktop/input.mjs';
import { createControl, toScreen } from '../desktop/control.mjs';

describe('按键解析', () => {
  it('各种写法都能识别', () => {
    expect(parseKeys('Ctrl+Shift+S')).toEqual(['ctrl', 'shift', 's']);
    expect(parseKeys('cmd + space')).toEqual(['meta', 'space']);
    expect(parseKeys('Return')).toEqual(['enter']);
    expect(parseKeys('alt tab')).toEqual(['alt', 'tab']);
    expect(() => parseKeys('  ')).toThrow();
    expect(() => winVk('hyper')).toThrow(/不认识/);
    expect(pasteCombo('darwin')).toBe('meta+v');
    expect(pasteCombo('win32')).toBe('ctrl+v');
  });
});

describe('Windows：user32 命令', () => {
  it('点击 / 双击 / 右键', () => {
    expect(winScript({ type: 'click', x: 100, y: 200 })).toBe('move 100 200;sleep 40;mouse 2 0;mouse 4 0;sleep 60');
    expect(winScript({ type: 'click', x: 1, y: 2, count: 2 }).match(/mouse 2 0/g)).toHaveLength(2);
    expect(winScript({ type: 'click', x: 1, y: 2, button: 'right' })).toContain('mouse 8 0;mouse 16 0');
  });
  it('快捷键：按下顺序、反向松开；方向键带扩展标志', () => {
    expect(winScript({ type: 'key', keys: 'ctrl+s' })).toBe('key 17 0;key 83 0;key 83 2;key 17 2');
    expect(winScript({ type: 'key', keys: 'down' })).toBe('key 40 1;key 40 3');
    expect(winScript({ type: 'key', keys: 'f5' })).toBe('key 116 0;key 116 2');
  });
  it('滚轮与拖动', () => {
    expect(winScript({ type: 'scroll', x: 5, y: 6, direction: 'down', amount: 2 })).toBe('move 5 6;sleep 30;mouse 2048 -120;sleep 20;mouse 2048 -120;sleep 20');
    const drag = winScript({ type: 'drag', x: 0, y: 0, toX: 80, toY: 40 });
    expect(drag).toMatch(/^move 0 0;sleep 40;mouse 2 0/);
    expect(drag).toMatch(/move 80 40;sleep 25;sleep 60;mouse 4 0$/);
  });
});

describe('macOS：CoreGraphics 脚本', () => {
  it('点击带点击次数；快捷键带修饰键标志', () => {
    const c = macScript({ type: 'click', x: 10, y: 20, count: 2 });
    expect(c).toContain('kCGEventLeftMouseDown');
    expect(c).toContain('kCGMouseEventClickState,2');
    const k = macScript({ type: 'key', keys: 'cmd+shift+s' });
    expect(k).toContain('CGEventCreateKeyboardEvent(null,1,true)');
    expect(k).toContain('$.kCGEventFlagMaskCommand|$.kCGEventFlagMaskShift');
    expect(() => macScript({ type: 'key', keys: 'cmd+a+b' })).toThrow(/一个主键/);
    expect(macScript({ type: 'scroll', x: 1, y: 1, direction: 'up', amount: 2 })).toContain('CGEventCreateScrollWheelEvent2(null,$.kCGScrollEventUnitLine,1,6,0,0)');
  });
});

describe('Linux：xdotool 参数', () => {
  it('点击、按键、滚动', () => {
    expect(xdoArgs({ type: 'click', x: 3, y: 4, count: 2, button: 'right' })).toEqual(['mousemove', '--sync', '3', '4', 'click', '--repeat', '2', '--delay', '60', '3']);
    expect(xdoArgs({ type: 'key', keys: 'ctrl+alt+t' })).toEqual(['key', '--clearmodifiers', 'ctrl+alt+t']);
    expect(xdoArgs({ type: 'key', keys: 'pagedown' })).toEqual(['key', '--clearmodifiers', 'Next']);
    expect(xdoArgs({ type: 'scroll', x: 1, y: 1, direction: 'up' }).slice(-1)).toEqual(['4']);
  });
  it('没有 xdotool 时给出安装提示', async () => {
    const input = createInput({ platform: 'linux', exec: async () => { throw Object.assign(new Error('spawn xdotool ENOENT'), { code: 'ENOENT' }); } });
    await expect(input.run({ type: 'move', x: 1, y: 1 })).rejects.toThrow(/安装 xdotool/);
  });
});

describe('坐标换算', () => {
  const disp = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, size: { width: 1440, height: 900 }, scaleFactor: 2 };
  it('按截图比例换算：macOS 用点，Linux 用物理像素，Windows 交给系统换算', () => {
    expect(toScreen({ x: 720, y: 450, imgW: 1440, imgH: 900 }, disp, 'darwin')).toEqual({ x: 720, y: 450 });
    expect(toScreen({ x: 360, y: 225, imgW: 720, imgH: 450 }, disp, 'darwin')).toEqual({ x: 720, y: 450 });
    expect(toScreen({ x: 720, y: 450, imgW: 1440, imgH: 900 }, disp, 'linux')).toEqual({ x: 1440, y: 900 });
    expect(toScreen({ x: 720, y: 450, imgW: 1440, imgH: 900 }, disp, 'win32', (p) => ({ x: p.x * 1.5, y: p.y * 1.5 }))).toEqual({ x: 1080, y: 675 });
    expect(() => toScreen({ x: 1, y: 1 }, disp, 'linux')).toThrow(/先截屏/);
    expect(() => toScreen({ x: -1, y: 1, imgW: 10, imgH: 10 }, disp, 'linux')).toThrow(/超出/);
  });
});

function fakeElectron() {
  const actions = [];
  const st = { cursor: { x: 500, y: 500 }, clip: '用户原来的剪贴板', visible: true, minimized: false, trusted: true };
  const win = { isVisible: () => st.visible, isMinimized: () => st.minimized, minimize: () => { st.minimized = true; }, hide: () => { st.visible = false; }, show: () => { st.visible = true; st.minimized = false; }, focus() {} };
  const display = { bounds: { x: 0, y: 0, width: 1000, height: 800 }, size: { width: 1000, height: 800 }, scaleFactor: 1 };
  return {
    st, actions,
    deps: {
      platform: 'linux',
      getWin: () => win,
      screen: { getPrimaryDisplay: () => display, getCursorScreenPoint: () => st.cursor },
      clipboard: { readText: () => st.clip, writeText: (t) => { st.clip = t; actions.push(`clipboard:${t}`); } },
      desktopCapturer: { getSources: async () => [{ thumbnail: { getSize: () => ({ width: 1000, height: 800 }), toPNG: () => Buffer.from('png') } }] },
      systemPreferences: { isTrustedAccessibilityClient: () => st.trusted },
      input: { run: async (a) => { actions.push(a); if (a.x !== undefined) st.cursor = { x: a.x, y: a.y }; }, close() {} }
    }
  };
}

describe('电脑操作控制器', () => {
  it('截屏前隐藏自己，结束后放回来', async () => {
    const f = fakeElectron();
    const c = createControl(f.deps);
    const shot = await c.look();
    expect(shot).toMatchObject({ width: 1000, height: 800, cursor: { x: 500, y: 500 } });
    expect(f.st.minimized).toBe(true);
    c.end();
    expect(f.st.minimized).toBe(false);
  });

  it('输入文字：粘贴后恢复原来的剪贴板', async () => {
    const f = fakeElectron();
    const c = createControl(f.deps);
    await c.act({ type: 'type', text: '你好，未央', enter: true });
    expect(f.actions).toEqual(['clipboard:你好，未央', { type: 'key', keys: 'ctrl+v' }, 'clipboard:用户原来的剪贴板', { type: 'key', keys: 'enter' }]);
  });

  it('紧急停止：鼠标被用户甩到左上角；自己点左上角不算；begin 后恢复', async () => {
    const f = fakeElectron();
    const c = createControl(f.deps);
    await c.act({ type: 'click', x: 1, y: 1, imgW: 1000, imgH: 800 });
    await c.act({ type: 'click', x: 100, y: 100, imgW: 1000, imgH: 800 }); // 上一步自己点的左上角：不触发
    f.st.cursor = { x: 0, y: 0 };
    await expect(c.act({ type: 'click', x: 100, y: 100, imgW: 1000, imgH: 800 })).rejects.toThrow(/紧急停止/);
    await expect(c.look()).rejects.toThrow(/紧急停止/);
    c.begin();
    await expect(c.look()).resolves.toBeTruthy();
    c.stop();
    await expect(c.act({ type: 'key', keys: 'enter' })).rejects.toThrow(/紧急停止/);
  });

  it('macOS 没有辅助功能权限时提示去授权', async () => {
    const f = fakeElectron();
    f.st.trusted = false;
    const c = createControl({ ...f.deps, platform: 'darwin' });
    await expect(c.act({ type: 'key', keys: 'cmd+s' })).rejects.toThrow(/辅助功能/);
  });
});
