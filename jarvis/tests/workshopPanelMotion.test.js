import { afterEach, describe, expect, it, vi } from 'vitest';
import { animateWorkshopPanel } from '../src/ui/workshopMedia.js';

const screen = { left: 311, top: 305, width: 40, height: 28 };
function setup(mode = '') {
  vi.stubGlobal('document', {
    documentElement: {classList: {contains: () => mode === 'safe'}},
    body: {classList: {contains: () => mode === 'less'}}
  });
  vi.stubGlobal('matchMedia', () => ({matches: mode === 'system'}));
  return { animate: vi.fn(() => ({})), getBoundingClientRect: () => ({left: 11, top: 165, width: 320, height: 280}) };
}

afterEach(() => vi.unstubAllGlobals());
describe('工作台设备原位展开', () => {
  it('打开和收起使用同一实物的坐标，只移动屏幕内容', () => {
    const panel = setup();
    animateWorkshopPanel(panel, screen, true);
    animateWorkshopPanel(panel, screen, false);
    const out = panel.animate.mock.calls[0][0], back = panel.animate.mock.calls[1][0];
    expect(out[0].transform).toBe('translate(300px,140px) scale(0.125,0.1)');
    expect(back).toEqual([...out].reverse());
    expect(out[1].transform).toBe('none');
  });
  it.each(['safe','less','system'])('%s 显示设置直接打开，不让手机动画阻塞内容', mode => {
    const panel = setup(mode);
    expect(animateWorkshopPanel(panel, screen, true)).toBeNull();
    expect(panel.animate).not.toHaveBeenCalled();
  });
  it('没有可见设备或面板尺寸时不制作失效动画', () => {
    const panel = setup();
    animateWorkshopPanel(panel, null, true);
    animateWorkshopPanel(panel, {...screen, width: 0}, true);
    panel.getBoundingClientRect = () => ({width: 0, height: 0});
    animateWorkshopPanel(panel, screen, false);
    expect(panel.animate).not.toHaveBeenCalled();
  });
});
