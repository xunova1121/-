/**
 * 自动更新：第一次完整安装之后，新版本只下载改动的部分（差量更新，通常几 MB 到十几 MB）。
 *
 *   Windows 安装版 / Linux AppImage：后台自动下载，下载完提示“重启更新”
 *   Windows 免安装版（zip）/ macOS：只提示有新版本，点击打开下载页
 *     （免安装版没有安装程序可替换；macOS 自动安装要求付费开发者签名，我们的安装包没有）
 *
 * 版本信息来自 GitHub Releases 上的 latest.yml / latest-mac.yml / latest-linux.yml（打包时自动生成）。
 */
import fs from 'node:fs';
import path from 'node:path';
export const RELEASES_URL = 'https://github.com/xunova1121/-/releases/latest';
const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 6 * 3600_000;

/** 能不能自动安装更新 */
export function canAutoInstall({ platform = process.platform, execPath = process.execPath, env = process.env, exists = fs.existsSync } = {}) {
  if (platform === 'darwin') return false;
  if (platform === 'linux') return Boolean(env.APPIMAGE);
  // Windows：装过的才有卸载程序；解压即用的 zip 版没有
  return exists(path.join(path.dirname(execPath), 'Uninstall Jarvis.exe'));
}

/**
 * @param {{ app, send: (payload: object) => void, log?: Function, onBeforeInstall?: Function }} d
 */
export async function createUpdater({ app, send, log = console.log, onBeforeInstall }) {
  const { default: pkg } = await import('electron-updater'); // 只在 Electron 里加载
  const { autoUpdater } = pkg;
  const auto = canAutoInstall();
  let state = { state: 'idle', current: app.getVersion() };
  const set = (patch) => { state = { ...state, ...patch }; send(state); };

  autoUpdater.autoDownload = auto;
  autoUpdater.autoInstallOnAppQuit = auto;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info: (m) => log(`[更新] ${m}`), warn: (m) => log(`[更新] ${m}`), error: (m) => log(`[更新] ${m}`), debug: () => {} };

  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'latest' }));
  autoUpdater.on('update-available', (info) => set({ state: auto ? 'downloading' : 'available', version: info.version, percent: 0, manual: !auto, url: RELEASES_URL }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent), transferred: p.transferred, total: p.total }));
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (e) => { log(`[更新] ${e?.message || e}`); set({ state: 'error', error: String(e?.message || e).slice(0, 200) }); });

  let timer = 0;
  const check = () => autoUpdater.checkForUpdates().catch((e) => set({ state: 'error', error: String(e?.message || e).slice(0, 200) }));
  return {
    get state() { return state; },
    auto,
    start() {
      if (!app.isPackaged) return; // 从源码运行（开发 / 测试）时不检查
      setTimeout(check, FIRST_CHECK_MS);
      timer = setInterval(check, EVERY_MS);
    },
    check,
    install() {
      if (state.state !== 'ready') return false;
      onBeforeInstall?.();
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
      return true;
    },
    stop() { clearInterval(timer); }
  };
}
