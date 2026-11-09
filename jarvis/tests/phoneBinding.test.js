import { it, expect, vi, beforeEach, afterEach } from 'vitest';
const state = vi.hoisted(() => ({ settings: { url: '', enabled: false }, actions: null }));
vi.mock('../src/ui/phoneControlPanel.js', () => ({ createPhoneControlPanel: actions => { state.actions = actions; return {}; } }));
vi.mock('../src/core/serverClient.js', () => ({ loadServerSettings: () => state.settings }));
vi.mock('../src/app/env.js', () => ({ toast: vi.fn() }));
import { createPhoneControl } from '../src/app/phoneControl.js';
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('document', { querySelector: () => null }); vi.stubGlobal('addEventListener', () => {}); state.settings = { url: 'https://server.example', enabled: true, userId: 'alice' }; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const native = () => ({ stop: vi.fn().mockResolvedValue({}), status: vi.fn().mockResolvedValue({ accessibility: true, installationId: 'uuid', enabled: false }), apps: vi.fn().mockResolvedValue({ apps: [] }), enable: vi.fn().mockResolvedValue({}) });
const server = () => ({ base: 'https://server.example', phone: { register: vi.fn().mockResolvedValue({ id: 'device-a', token: 'fixture-device-token' }), disconnect: vi.fn().mockResolvedValue({}), list: vi.fn().mockResolvedValue([]) } });
it('初始化先停旧原生窗口，再注册并只把设备令牌交给原生', async () => {
  const n = native(), s = server(); createPhoneControl({ server: s }, { native: n });
  await state.actions.enable({ name: '手机', packages: ['com.tencent.mm'] });
  expect(n.stop.mock.invocationCallOrder[0]).toBeLessThan(n.enable.mock.invocationCallOrder[0]);
  expect(n.enable).toHaveBeenCalledWith({ packages: ['com.tencent.mm'], base: s.base, deviceId: 'device-a', token: 'fixture-device-token' });
});
it('绑定等待时切账号，撤销迟到注册，不允许开启旧账号设备', async () => {
  let registered; const n = native(), s = server(); s.phone.register.mockImplementation(() => new Promise(r => registered = r));
  createPhoneControl({ server: s }, { native: n });
  const enabling = state.actions.enable({ packages: ['com.tencent.mm'] });
  await vi.waitUntil(() => !!registered);
  state.settings = { ...state.settings, userId: 'bob' }; registered({ id: 'device-a', token: 'fixture' });
  await expect(enabling).rejects.toThrow(/账号已切换/); expect(n.enable).not.toHaveBeenCalled(); expect(s.phone.disconnect).toHaveBeenCalledWith('device-a');
});
it('本机停止失败仍撤销云端连接；账号切换自动停止', async () => {
  const n = native(), s = server(); createPhoneControl({ server: s }, { native: n });
  await state.actions.enable({ packages: ['com.tencent.mm'] });
  n.stop.mockRejectedValueOnce(new Error('native unavailable'));
  await expect(state.actions.stop()).rejects.toThrow('native unavailable'); expect(s.phone.disconnect).toHaveBeenCalledWith('device-a');
  await state.actions.enable({ packages: ['com.tencent.mm'] });
  state.settings = { ...state.settings, userId: 'bob' }; await vi.advanceTimersByTimeAsync(1001);
  expect(s.phone.disconnect).toHaveBeenCalledTimes(2); expect(n.stop).toHaveBeenCalledTimes(3);
});
