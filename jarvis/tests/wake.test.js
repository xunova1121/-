import { describe, it, expect } from 'vitest';
import { matchWake, WakeWindow } from '../src/core/wakeWord.js';

describe('唤醒词', () => {
  it('认出名字及常见同音字，去掉后得到指令', () => {
    expect(matchWake('未央，帮我写个网页')).toEqual({ woke: true, rest: '帮我写个网页' });
    expect(matchWake('嘿 未央 现在几点')).toEqual({ woke: true, rest: '现在几点' });
    expect(matchWake('嘉维斯今天天气怎么样').woke).toBe(true);
    expect(matchWake('魏阳，几点了')).toEqual({ woke: true, rest: '几点了' }); // 识别成同音字
    expect(matchWake('贾维斯，几点了')).toEqual({ woke: true, rest: '几点了' }); // 改名前的叫法照样认
    expect(matchWake('Hey Jarvis, what time is it?')).toEqual({ woke: true, rest: 'what time is it?' });
    expect(matchWake('未央')).toEqual({ woke: true, rest: '' });
    expect(matchWake('帮我查下天气未央')).toEqual({ woke: true, rest: '帮我查下天气' });
  });
  it('没叫名字不算唤醒', () => {
    expect(matchWake('今天中午吃什么').woke).toBe(false);
    expect(matchWake('维斯特布鲁克').woke).toBe(false);
  });
  it('对话窗口到期后需要重新唤醒', () => {
    let t = 0;
    const w = new WakeWindow({ windowMs: 1000, now: () => t });
    expect(w.awake).toBe(false);
    w.wake();
    t = 900;
    expect(w.awake).toBe(true);
    t = 1100;
    expect(w.awake).toBe(false);
    w.wake();
    w.sleep();
    expect(w.awake).toBe(false);
  });
});
