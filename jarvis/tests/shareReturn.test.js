import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createShareReturnCoordinator, readShareReturn, SHARE_RETURN_KEY, SHARE_RETURN_TTL, shareAccountScope } from '../src/mobile/shareReturn.js';
import { createNativeSharer } from '../src/mobile/saveNative.js';
import { createShareRecovery } from '../src/app/shareReturn.js';
import { createNewSessionAction, noteSessionNavigation } from '../src/app/sessionNavigation.js';

const scopeA = 'a'.repeat(64), scopeB = 'b'.repeat(64);
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
function setup(options = {}) {
  const saved = storage(), native = { prepare: vi.fn(async () => ({ notification: true })), finish: vi.fn(async () => {}) };
  const context = vi.fn(async () => ({ scope: scopeA, sessionId: 'c_original', filePath: 'images/原图.png', token: 'never-store-this', content: '不保存正文' }));
  let active = true;
  const coordinator = createShareReturnCoordinator({ storage: saved, native, context, foreground: () => active, ...options });
  return { coordinator, saved, native, context, foreground: value => { active = value; coordinator.foreground(value); } };
}
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); delete globalThis.__jarvisGetShareContext; });

describe('分享返回指针和生命周期', () => {
  it('摘要绑定服务器、账号和登录，存盘不含密钥或正文', async () => {
    const a = await shareAccountScope({ url: 'https://server.test', userId: 'u_a', token: 'secret' }, true, webcrypto);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    for (const account of [{ url: 'https://other.test', userId: 'u_a', token: 'secret' }, { url: 'https://server.test', userId: 'u_b', token: 'secret' }, { url: 'https://server.test', userId: 'u_a', token: 'changed' }]) expect(await shareAccountScope(account, true, webcrypto)).not.toBe(a);
    expect(await shareAccountScope({}, false, {})).toBeNull();
    const f = setup(); const ticket = await f.coordinator.begin();
    expect(f.coordinator.pending()).toMatchObject({ sessionId: 'c_original', filePath: 'images/原图.png', scope: scopeA });
    expect(f.saved.getItem(SHARE_RETURN_KEY)).not.toMatch(/never-store|content|不保存正文/);
    f.coordinator.cancel(ticket);
  });

  it('过期、未来时间、越界路径和过大记录不能恢复', () => {
    const saved = storage(), base = { version: 1, id: 'share_1', at: 100, scope: scopeA, sessionId: 'c_a', filePath: 'a.png' };
    saved.setItem(SHARE_RETURN_KEY, JSON.stringify(base));
    expect(readShareReturn(saved, 101)).toMatchObject(base);
    for (const value of [{ ...base, at: 102 }, { ...base, at: 101 - SHARE_RETURN_TTL }, { ...base, filePath: '../secret' }, { ...base, sessionId: 'x'.repeat(161) }, { ...base, scope: 'token' }]) {
      saved.setItem(SHARE_RETURN_KEY, JSON.stringify(value)); expect(readShareReturn(saved, 101)).toBeNull();
    }
    saved.setItem(SHARE_RETURN_KEY, 'x'.repeat(1601)); expect(readShareReturn(saved)).toBeNull();
  });

  it('等待上下文时已互斥，准备失败后可重试', async () => {
    let reject;
    const f = setup({ context: () => new Promise((_resolve, fail) => { reject = fail; }) });
    const first = f.coordinator.begin();
    await expect(f.coordinator.begin()).rejects.toThrow(/进行中/);
    reject(new Error('无法准备')); await expect(first).rejects.toThrow('无法准备');
    const next = f.coordinator.begin(); await tick(); reject(new Error('仍不可用')); await expect(next).rejects.toThrow('仍不可用');
  });

  it('选择器瞬间resume不能清掉微信返回入口，真实返回后才结束', async () => {
    vi.useFakeTimers();
    const f = setup(), ticket = await f.coordinator.begin();
    await f.coordinator.prepare(ticket); f.coordinator.launch(ticket);
    f.foreground(false); f.foreground(true); await vi.advanceTimersByTimeAsync(100); f.foreground(false);
    f.coordinator.settle(ticket); await vi.advanceTimersByTimeAsync(1000);
    expect(f.coordinator.pending()?.id).toBe(ticket.id); expect(f.native.finish).not.toHaveBeenCalled();
    await expect(f.coordinator.begin()).rejects.toThrow(/进行中/);
    f.foreground(true); await vi.advanceTimersByTimeAsync(800);
    expect(f.coordinator.pending()).toBeNull(); expect(f.native.finish).toHaveBeenCalledWith({ id: ticket.id });
    const next = await f.coordinator.begin();
    f.coordinator.settle(ticket, true); f.coordinator.forget(ticket.id);
    expect(f.coordinator.pending()?.id).toBe(next.id);
    f.coordinator.cancel(next);
  });

  it('失败取消清理；未结束的原生选择器超时不允许叠开', async () => {
    vi.useFakeTimers();
    const f = setup(), cancelled = await f.coordinator.begin();
    f.coordinator.launch(cancelled); f.coordinator.settle(cancelled, true);
    const pending = await f.coordinator.begin(); f.coordinator.launch(pending);
    await vi.advanceTimersByTimeAsync(SHARE_RETURN_TTL);
    expect(f.coordinator.pending()).toBeNull();
    await expect(f.coordinator.begin()).rejects.toThrow(/状态未确认/);
    f.coordinator.settle(pending); const next = await f.coordinator.begin(); f.coordinator.cancel(next);
  });

  it('准备期超时释放，迟到的旧准备不能影响新分享', async () => {
    vi.useFakeTimers();
    let ready;
    const f = setup({ context: () => new Promise(resolve => { ready = resolve; }) });
    const pending = f.coordinator.begin();
    const rejected = expect(pending).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(3000); await rejected;
    const oldReady = ready;
    const next = f.coordinator.begin(); await tick();
    oldReady({ scope: scopeB }); ready({ scope: scopeA });
    const ticket = await next;
    expect(f.coordinator.pending()?.scope).toBe(scopeA);
    f.coordinator.cancel(ticket);
  });

  it('通知插件不响应时3秒结束准备，不让迟到通知覆盖下一次分享', async () => {
    vi.useFakeTimers();
    let prepared;
    const f = setup({ native: { prepare: () => new Promise(resolve => { prepared = resolve; }), finish: vi.fn(async () => {}) } });
    const ticket = await f.coordinator.begin();
    const result = f.coordinator.prepare(ticket);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toEqual({ notification: false });
    f.coordinator.cancel(ticket);
    const next = await f.coordinator.begin();
    prepared({ notification: true }); await tick();
    expect(f.coordinator.pending()?.id).toBe(next.id);
    f.coordinator.cancel(next);
  });

  it('多个sharer实例共享锁，缓存路径唯一并保持原字节', async () => {
    const writes = [], resolvers = [];
    const Share = { share: vi.fn(() => new Promise(resolve => resolvers.push(resolve))) };
    const deps = { Share, Directory: { Cache: 'CACHE' }, Filesystem: { writeFile: vi.fn(async value => { writes.push(value); return { uri: 'file:///' + value.path }; }) } };
    const bytes = new Uint8Array([0, 1, 255, 128, 32]);
    const first = createNativeSharer(deps), second = createNativeSharer(deps);
    expect(await first(new Blob([bytes]), '原图.png')).toContain('已请求打开');
    await expect(second(new Blob([bytes]), '原图.png')).rejects.toThrow(/进行中/);
    expect(Share.share).toHaveBeenCalledTimes(1);
    expect(Buffer.from(writes[0].data, 'base64')).toEqual(Buffer.from(bytes));
    resolvers[0](); await tick();
    await second(new Blob([bytes]), '原图.png');
    expect(writes[1].path).not.toBe(writes[0].path);
    resolvers[1](); await tick();
  });
});

describe('分享后冷启动只读恢复', () => {
  function fixture({ scope = async () => scopeA, getSession = async () => ({ id: 'c_original', messages: [{ role: 'user', content: '原会话' }], taskId: 'existing_task' }) } = {}) {
    const coordinator = { pending: () => ({ id: 'share_a', scope: scopeA, sessionId: 'c_original' }), forget: vi.fn() };
    const app = { server: {}, session: { id: 'c_empty', messages: [] }, active: null, send: vi.fn(), reflectNow: vi.fn() };
    Object.defineProperty(app, 'history', { get: () => app.session.messages });
    app.switchTo = vi.fn(async (session, options) => { if (!options.isCurrent()) return false; app.session = session; return true; });
    const toast = vi.fn();
    return { app, coordinator, toast, recovery: createShareRecovery(app, { coordinator, scope, getSession, toast }) };
  }
  it('有效分享优先恢复原会话，不反思也不重新提交任务', async () => {
    const f = fixture(); expect(await f.recovery.restore()).toBe(true);
    expect(f.app.session.id).toBe('c_original'); expect(f.app.switchTo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reflect: false }));
    expect(f.app.send).not.toHaveBeenCalled(); expect(f.app.reflectNow).not.toHaveBeenCalled(); expect(f.coordinator.forget).toHaveBeenCalledWith('share_a');
  });
  it('账号不匹配不读取原会话', async () => {
    const getSession = vi.fn(), f = fixture({ scope: async () => scopeB, getSession });
    expect(await f.recovery.restore()).toBe(false); expect(getSession).not.toHaveBeenCalled(); expect(f.app.switchTo).not.toHaveBeenCalled();
  });
  it('等待期间用户切会话、开始任务或切服务器，迟到结果不抢回', async () => {
    for (const mutate of [app => { app.session = { id: 'c_new', messages: [] }; }, app => { app.active = {}; }, app => { app.server = {}; }]) {
      let complete; const f = fixture({ getSession: () => new Promise(resolve => { complete = resolve; }) });
      const pending = f.recovery.restore(); await tick(); mutate(f.app);
      complete({ id: 'c_original', messages: [{ role: 'user', content: '原会话' }] });
      expect(await pending).toBe(true); expect(f.app.switchTo).not.toHaveBeenCalled(); expect(f.app.send).not.toHaveBeenCalled();
    }
  });
  it('等待期间登录身份改变，不打开旧账号数据', async () => {
    let complete, count = 0;
    const f = fixture({ scope: async () => ++count === 1 ? scopeA : scopeB, getSession: () => new Promise(resolve => { complete = resolve; }) });
    const pending = f.recovery.restore(); await tick(); complete({ id: 'c_original', messages: [] });
    expect(await pending).toBe(true); expect(f.app.switchTo).not.toHaveBeenCalled();
  });
  it('空会话点新建仍保持原ID并聚焦，但迟到恢复不能覆盖明确导航', async () => {
    let complete;
    const f = fixture({ getSession: () => new Promise(resolve => { complete = resolve; }) });
    const focus = vi.fn(), create = vi.fn();
    const newSession = createNewSessionAction(f.app, { create, focus });
    const pending = f.recovery.restore(); await tick();
    newSession();
    expect(f.app.session.id).toBe('c_empty'); expect(focus).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled();
    complete({ id: 'c_original', messages: [{ role: 'user', content: '旧会话' }] });
    expect(await pending).toBe(true); expect(f.app.switchTo).not.toHaveBeenCalled(); expect(f.app.send).not.toHaveBeenCalled();
  });
  it('恢复等待中输入草稿或打开会话意图即失效，不要求ID已经变更', async () => {
    for (const intent of [app => { app.prompt.value = '新问题草稿'; }, app => noteSessionNavigation(app)]) {
      let complete;
      const f = fixture({ getSession: () => new Promise(resolve => { complete = resolve; }) });
      f.app.prompt = { value: '' };
      const pending = f.recovery.restore(); await tick(); intent(f.app);
      complete({ id: 'c_original', messages: [{ role: 'user', content: '旧会话' }] });
      expect(await pending).toBe(true); expect(f.app.switchTo).not.toHaveBeenCalled();
    }
  });
  it('已有草稿时不启动自动恢复读取', async () => {
    const getSession = vi.fn(), f = fixture({ getSession }); f.app.prompt = { value: '不要替换我的草稿' };
    expect(await f.recovery.restore()).toBe(true); expect(getSession).not.toHaveBeenCalled(); expect(f.app.prompt.value).toBe('不要替换我的草稿');
  });
  it('原会话暂时取不到也不落入pending自动续做分支', async () => {
    const f = fixture({ getSession: async () => { throw new Error('网络离线'); } });
    expect(await f.recovery.restore()).toBe(true); expect(f.app.send).not.toHaveBeenCalled(); expect(f.toast).toHaveBeenCalledWith(expect.stringContaining('未重新发送'));
  });
});
