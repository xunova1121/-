import { it, expect, vi, beforeEach } from 'vitest';
const state = vi.hoisted(() => ({ identity: 'user-a', options: null }));
vi.mock('../src/core/userStorage.js', () => ({ userStorageSuffix: () => state.identity }));
vi.mock('../src/ui/tenderCenter.js', () => ({ createTenderCenterView: options => { state.options = options; return { root: {}, destroy() {} }; } }));
import { mountTenderCenter } from '../src/app/tenderCenter.js';
const target = () => ({ classList: { toggle: vi.fn() }, querySelector: () => ({ after: vi.fn() }) });
beforeEach(() => { state.identity = 'user-a'; state.options = null; });
it('请求期间切换账号、运行端或草稿，旧私人响应不得渲染', async () => {
  for (const change of [app => { app.server = null; }, () => { state.identity = 'user-b'; }, app => { app.session = {}; }]) {
    state.identity = 'user-a'; let release;
    const app = { session: {}, server: { tenders: { mine: () => new Promise(resolve => { release = resolve; }) } } };
    mountTenderCenter(app, target(), vi.fn());
    const pending = state.options.call('mine'); change(app); release({ subscriptions: ['甲的私有条件'] });
    await expect(pending).rejects.toThrow('已切换'); expect(state.options.valid()).toBe(false);
  }
});
it('云端失败不落回本机，不在无服务器模式创建订阅或查询', async () => {
  mountTenderCenter({ session: {}, server: null }, target(), vi.fn()); expect(state.options.call).toBeNull();
  const remote = vi.fn(async () => { throw new Error('云端断开'); });
  mountTenderCenter({ session: {}, server: { tenders: { change: remote } } }, target(), vi.fn());
  await expect(state.options.call('change', { action: 'subscribe' })).rejects.toThrow('云端断开');
  expect(remote).toHaveBeenCalledTimes(1);
});
