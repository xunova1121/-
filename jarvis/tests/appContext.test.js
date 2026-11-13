import { describe, it, expect } from 'vitest';
import { createApp, mount } from '../src/app/context.js';
import { friendlyError } from '../src/core/friendlyError.js';

describe('前端模块的 app 上下文', () => {
  it('app.history 永远是当前对话的消息，换对话只改 app.session', () => {
    const app = createApp({ settings: {} });
    app.session = { id: 'a', messages: [{ role: 'user', content: '你好' }] };
    expect(app.history).toBe(app.session.messages);
    app.session = { id: 'b', messages: [] };
    expect(app.history).toEqual([]);
    expect(() => { 'use strict'; app.history = []; }).toThrow(TypeError); // 不能直接换 history
  });
  it('模块挂上去的 getter 保持实时（不会被复制成当时的值）', () => {
    const app = createApp();
    let voice = 'old';
    mount(app, { get voice() { return voice; }, hello: () => 'hi' });
    voice = 'new';
    expect(app.voice).toBe('new');
    expect(app.hello()).toBe('hi');
  });
  it('两个模块用了同一个名字：启动时直接报错，不会悄悄覆盖', () => {
    const app = createApp();
    mount(app, { send() {} });
    expect(() => mount(app, { send() {} })).toThrow('app.send 重名');
    expect(() => mount(app, { session: 1 })).toThrow('重名');
  });
});

describe('模型报错翻译成人话', () => {
  it('常见状态码给出能照着做的提示，其他原样返回', () => {
    expect(friendlyError('模型接口返回 524：timeout')).toContain('中转站等模型回复超时');
    expect(friendlyError('模型接口返回 429')).toContain('限流');
    expect(friendlyError('模型接口返回 429')).not.toContain('额度用完');
    expect(friendlyError('模型接口返回 401')).toContain('API Key');
    expect(friendlyError('模型接口返回 502')).toContain('服务商临时故障');
    expect(friendlyError('read ECONNRESET')).toContain('网络连接被断开');
    expect(friendlyError('别的错误')).toBe('别的错误');
  });
});
