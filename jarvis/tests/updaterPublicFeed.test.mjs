import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createUpdater, RELEASE_FEED, RELEASES_URL } from '../desktop/updater.mjs';
afterEach(() => vi.useRealTimers());
const fake = () => Object.assign(new EventEmitter(), { setFeedURL: vi.fn(), checkForUpdates: vi.fn(async () => ({})), quitAndInstall: vi.fn() });
describe('Windows公开发布源', () => {
  it('安装包元数据与运行时第一次检查都指向公开发布仓库', async () => {
    const updater = fake();
    const client = await createUpdater({ updater, app: { getVersion: () => '1.0.1' }, send: () => {} });
    expect(updater.setFeedURL).toHaveBeenCalledWith(RELEASE_FEED);
    await client.check(); expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    const pkg = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url)));
    expect(pkg.build.publish[0]).toMatchObject({ owner: 'xunova1121', repo: 'weiyang-release' });
    expect(pkg.build.appId).toBe('com.jarvis.desktop');
  });
  it('404不能提示用户填写模型Key；保留手动官方安装入口', async () => {
    const updater = fake(), send = vi.fn(), log = vi.fn();
    updater.checkForUpdates.mockRejectedValue(new Error('404 authentication token is correct Bearer PRIVATE_EXAMPLE'));
    const client = await createUpdater({ updater, app: { getVersion: () => '1.0.382' }, send, log });
    await client.check();
    expect(client.state).toMatchObject({ state: 'error', current: '1.0.382', manual: true, url: RELEASES_URL });
    expect(client.state.error).toContain('官方下载页');
    expect(JSON.stringify([send.mock.calls, log.mock.calls])).not.toMatch(/PRIVATE_EXAMPLE|Bearer|authentication/);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });
  it('校验失败继续阻止安装，关闭更新器也取消首次检查定时器', async () => {
    vi.useFakeTimers(); const updater = fake();
    const client = await createUpdater({ updater, app: { getVersion: () => '1.0.1', isPackaged: true }, send: () => {}, log: () => {} });
    updater.emit('error', new Error('sha512 checksum mismatch'));
    expect(client.state.error).toContain('完整性校验未通过'); expect(client.install()).toBe(false);
    client.start(); client.stop(); await vi.advanceTimersByTimeAsync(24 * 3600000);
    expect(updater.checkForUpdates).not.toHaveBeenCalled(); expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
