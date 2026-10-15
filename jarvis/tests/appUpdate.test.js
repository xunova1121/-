import { describe, it, expect } from 'vitest';
import { parseVersion, isNewer, versionFromYml, apkUrl, createAppUpdater } from '../src/mobile/appUpdate.js';

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const yml = (v) => `version: ${v}\nfiles:\n  - url: Jarvis-Setup-${v}.exe\npath: Jarvis-Setup-${v}.exe\n`;
function fakePlugin({ failDownload = 0, needPermission = false } = {}) {
  const calls = { download: [], install: 0, clear: 0 };
  let fails = failDownload, progress = null;
  return {
    calls,
    addListener: (_, f) => { progress = f; },
    download: async ({ url }) => { calls.download.push(url); if (fails-- > 0) throw new Error('网络错误'); progress?.({ percent: 50 }); return { bytes: 1 }; },
    install: async () => { calls.install++; return { needPermission }; },
    clear: async () => { calls.clear++; }
  };
}

describe('手机自动更新', () => {
  it('版本号比较', () => {
    expect(parseVersion('1.0.63')).toEqual([1, 0, 63]);
    expect(parseVersion('1.0')).toBeNull(); // 本地调试包
    expect(isNewer('1.0.64', '1.0.63')).toBe(true);
    expect(isNewer('1.0.100', '1.0.99')).toBe(true);
    expect(isNewer('1.0.63', '1.0.63')).toBe(false);
    expect(isNewer('1.0.64', '1.0')).toBe(false);
    expect(versionFromYml(yml('1.0.70'))).toBe('1.0.70');
    expect(apkUrl('1.0.70')).toBe('https://github.com/xunova1121/-/releases/download/desktop-v1.0.70/Jarvis-1.0.70-android.apk');
  });

  it('有新版本：后台下载，下载好后点按钮打开安装界面', async () => {
    const plugin = fakePlugin();
    const seen = [];
    const u = createAppUpdater({ current: '1.0.63', plugin, storage: mem(), getText: async () => yml('1.0.64') });
    u.onUpdate((s) => seen.push(s.state));
    const s = await u.check();
    expect(s).toMatchObject({ state: 'ready', version: '1.0.64', mobile: true });
    expect(seen).toContain('downloading');
    expect(plugin.calls.download[0]).toBe(apkUrl('1.0.64'));
    await u.act();
    expect(plugin.calls.install).toBe(1);
  });

  it('已是最新版本、调试版都不下载', async () => {
    const plugin = fakePlugin();
    expect((await createAppUpdater({ current: '1.0.64', plugin, storage: mem(), getText: async () => yml('1.0.64') }).check()).state).toBe('latest');
    expect((await createAppUpdater({ current: '1.0', plugin, storage: mem(), getText: async () => yml('1.0.64') }).check()).state).toBe('dev');
    expect(plugin.calls.download).toHaveLength(0);
  });

  it('直连 GitHub 失败时走镜像', async () => {
    const urls = [];
    const plugin = fakePlugin({ failDownload: 1 });
    const u = createAppUpdater({ current: '1.0.63', plugin, storage: mem(), getText: async (url) => { urls.push(url); if (url.startsWith('https://github.com')) throw new Error('超时'); return yml('1.0.64'); } });
    expect((await u.check()).state).toBe('ready');
    expect(urls[1]).toMatch(/^https:\/\/ghfast\.top\/https:\/\/github\.com\//);
    expect(plugin.calls.download[1]).toBe(`https://ghfast.top/${apkUrl('1.0.64')}`);
  });

  it('用流量时自动检查只提示，不下载；已下载过的版本不重复下载', async () => {
    const plugin = fakePlugin();
    const storage = mem();
    const u = createAppUpdater({ current: '1.0.63', plugin, storage, metered: () => true, getText: async () => yml('1.0.64') });
    expect((await u.check({ auto: true })).state).toBe('available');
    expect(plugin.calls.download).toHaveLength(0);
    expect((await u.act()).state).toBe('ready'); // 用户点“下载”
    const again = createAppUpdater({ current: '1.0.63', plugin, storage, getText: async () => yml('1.0.64') });
    expect((await again.check()).state).toBe('ready');
    expect(plugin.calls.download).toHaveLength(1);
  });

  it('装好新版后清掉安装包；没有安装权限时提示去设置里允许', async () => {
    const storage = mem();
    storage.setItem('jarvis.update.downloaded', '1.0.64');
    const plugin = fakePlugin({ needPermission: true });
    createAppUpdater({ current: '1.0.64', plugin, storage, getText: async () => yml('1.0.64') });
    expect(plugin.calls.clear).toBe(1);
    const u = createAppUpdater({ current: '1.0.63', plugin: fakePlugin({ needPermission: true }), storage: mem(), getText: async () => yml('1.0.64') });
    await u.check();
    expect((await u.act()).hint).toMatch(/安装未知应用/);
  });
});
