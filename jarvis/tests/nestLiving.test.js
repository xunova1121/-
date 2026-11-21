import { describe, it, expect } from 'vitest';
import { coffeeMoment } from '../src/ui/nestLiving.js';

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
});
