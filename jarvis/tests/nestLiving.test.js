import { describe, it, expect, vi } from 'vitest';
import { coffeeMoment, createNestLiving } from '../src/ui/nestLiving.js';

describe('小窝书桌冲咖啡', () => {
  it('先握壶，再把水倒入固定的杯子，放下壶以后才喝', () => {
    expect([0,1200,4600,5700,8200].map(t => coffeeMoment(t).phase)).toEqual(['reach','pour','set-down','sip','hold']);
    for (const t of [0,1199,4599,5699,8199]) expect(coffeeMoment(t).next).toBeGreaterThan(t);
  });
  it('饮用期间只端杯和放杯，回来时按原来经过的时长继续', () => {
    expect(coffeeMoment(28699)).toEqual({phase:'hold',next:28700});
    expect(coffeeMoment(28700)).toEqual({phase:'sip',next:31700});
    expect(coffeeMoment(52750)).toEqual({phase:'sip',next:55200});
    expect(coffeeMoment(180000).phase).toBe('hold');
  });
  it('兼容显示完整冲饮一次，到放下杯子便停止安排动作', () => {
    expect([0,1200,4600,5700,8200].map(t => coffeeMoment(t, true).phase)).toEqual(['reach','pour','set-down','sip','hold']);
    for (const t of [8200,28700,180000]) expect(coffeeMoment(t, true)).toEqual({phase:'hold',next:null});
  });

  it('相同竖屏背景从咖啡切后台再回来吃饭时，清理桌前人物', () => {
    const element = () => ({dataset:{}, children:[], setAttribute() {}, append(child) { this.children.push(child); }});
    vi.stubGlobal('document', {createElement: element, documentElement:{classList:{contains: () => true}}, body:{classList:{contains: () => true}}});
    vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener() {}, removeEventListener() {}}));
    const floor = element();
    try {
      const living = createNestLiving(floor);
      const layer = floor.children.find(el => el.className === 'ws-nest-living');
      living.setVisible(true);
      living.render('', {}, 'same-room.webp');
      living.render('coffee', {nextAt: 10}, 'same-room.webp');
      expect(layer.dataset.coffeePhase).toBe('pour');
      living.setVisible(false);
      living.setVisible(true);
      living.render('', {}, 'same-room.webp');
      expect(layer.dataset.coffeePhase).toBeUndefined();
      living.setVisible(false);
    } finally { vi.unstubAllGlobals(); }
  });
});
