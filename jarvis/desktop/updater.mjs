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
// 代码仓库已改私密（2026-11-03），下载页改指向公开的安装包仓库
export const RELEASES_URL = 'https://github.com/xunova1121/weiyang-release/releases/latest';
/** 从第一次检查起就使用公开仓库，不再先请求私密代码仓库。 */
export const RELEASE_FEED = { provider: 'github', owner: 'xunova1121', repo: 'weiyang-release', releaseType: 'release' };
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
export async function createUpdater({ app, send, log = console.log, onBeforeInstall, updater }) {
  const autoUpdater = updater ?? (await import('electron-updater')).default.autoUpdater; // 只在 Electron 里加载
  const auto = canAutoInstall();
  let state = { state: 'idle', current: app.getVersion() };
  const set = (patch) => { state = { ...state, ...patch }; send(state); };

  autoUpdater.autoDownload = auto;
  autoUpdater.autoInstallOnAppQuit = auto;
  autoUpdater.allowPrerelease = false;
  autoUpdater.setFeedURL(RELEASE_FEED);
  autoUpdater.logger = { info: (m) => log(`[更新] ${m}`), warn: (m) => log(`[更新] ${m}`), error: (m) => log(`[更新] ${m}`), debug: () => {} };

  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'latest' }));
  autoUpdater.on('update-available', (info) => set({ state: auto ? 'downloading' : 'available', version: info.version, percent: 0, manual: !auto, url: RELEASES_URL }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent), transferred: p.transferred, total: p.total }));
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }));
  const failed = (e) => {
    const error = updateError(e);
    log(`[更新] ${error}`);
    set({ state: 'error', error, url: RELEASES_URL, manual: true });
  };
  autoUpdater.on('error', failed);

  let timer = 0, firstTimer = 0;
  const check = () => autoUpdater.checkForUpdates().catch(failed);
  return {
    get state() { return state; },
    auto,
    start() {
      if (!app.isPackaged) return; // 从源码运行（开发 / 测试）时不检查
      firstTimer = setTimeout(check, FIRST_CHECK_MS);
      timer = setInterval(check, EVERY_MS);
    },
    check,
    install() {
      if (state.state !== 'ready') return false;
      onBeforeInstall?.();
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
      return true;
    },
    stop() { clearTimeout(firstTimer); clearInterval(timer); }
  };
}

/** 下载更新不需要用户的模型Key；不要把GitHub的通用鉴权提示误报成模型密钥错误。 */
export function updateError(error) {
  const message = String(error?.message || error);
  if (/404|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/.test(message)) return '公开发布信息暂时不可用，请稍后重试或打开官方下载页下载安装';
  if (/sha512|checksum|signature|ERR_UPDATER_INVALID_SIGNATURE/i.test(message)) return '安装包完整性校验未通过，已停止更新，请重新下载官方安装包';
  return '无法连接公开更新服务，请检查网络后重试，或打开官方下载页下载安装';
}
