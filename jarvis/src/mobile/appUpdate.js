/**
 * 手机自动更新（安卓 App）：和电脑版用同一个发布页。
 *   1. 启动 8 秒后、之后每 6 小时，读发布页里的 latest.yml 拿到最新版本号
 *   2. 比手机上的版本新：连着 Wi-Fi 就在后台下载安装包（约 11 MB），用流量时先问
 *   3. 下载好后顶栏出现“安装新版本”，点一下打开系统安装界面（安卓不允许静默安装，要用户点“安装”）
 * 国内直连 GitHub 不稳定：先直连，失败再走镜像。安装包有签名，镜像改不了内容（被改过的装不上）。
 */
export const REPO = 'xunova1121/-';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const DOWNLOAD = `https://github.com/${REPO}/releases`;
export const MIRRORS = [(u) => u, (u) => `https://ghfast.top/${u}`];
const KEY = 'jarvis.update.downloaded'; // 已下载好的安装包是哪个版本

/** '1.0.63' → [1, 0, 63]；不是正式版本号（本地调试包）返回 null */
export function parseVersion(v) {
  const m = String(v ?? '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? m.slice(1).map(Number) : null;
}
export function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
/** 从 latest.yml（电脑版自动更新用的清单）里读版本号 */
export function versionFromYml(text) {
  return String(text ?? '').match(/^version:\s*['"]?([\d.]+)['"]?\s*$/m)?.[1] ?? null;
}
export const apkUrl = (version) => `${DOWNLOAD}/download/desktop-v${version}/Jarvis-${version}-android.apk`;
export const ymlUrl = () => `${DOWNLOAD}/latest/download/latest.yml`;

/**
 * @param {object} o
 * @param {(url:string)=>Promise<string>} o.getText  取网页文本（失败抛错）
 * @param {{download:Function, install:Function, clear:Function, addListener:Function}} o.plugin 原生插件 AppUpdate
 * @param {string} o.current     手机上装的版本号
 * @param {() => boolean} [o.metered] 是否在用流量（用流量时不自动下载）
 * @param {Storage} [o.storage]
 */
export function createAppUpdater({ getText, plugin, current, metered = () => false, storage = globalThis.localStorage }) {
  const listeners = new Set();
  let state = { state: parseVersion(current) ? 'idle' : 'dev', current, mobile: true };
  let busy = null;
  const set = (patch) => { state = { ...state, ...patch }; for (const f of listeners) f(state); return state; };
  const read = () => { try { return storage?.getItem(KEY) || ''; } catch { return ''; } };
  const write = (v) => { try { v ? storage?.setItem(KEY, v) : storage?.removeItem(KEY); } catch { /* 存不了就下次重新下载 */ } };

  // 已经装上了下载好的版本：删掉安装包
  if (read() && !isNewer(read(), current)) { write(''); plugin.clear?.().catch(() => {}); }
  plugin.addListener?.('progress', (e) => { if (state.state === 'downloading') set({ percent: e?.percent ?? 0 }); });

  async function latestVersion() {
    let last;
    for (const via of MIRRORS) {
      try {
        const v = versionFromYml(await getText(via(ymlUrl())));
        if (v) return v;
      } catch (e) { last = e; }
    }
    throw last ?? new Error('读不到版本信息');
  }

  async function download(version) {
    set({ state: 'downloading', version, percent: 0 });
    let last;
    for (const via of MIRRORS) {
      try {
        await plugin.download({ url: via(apkUrl(version)) });
        write(version);
        return set({ state: 'ready', version, percent: 100 });
      } catch (e) { last = e; set({ percent: 0 }); }
    }
    return set({ state: 'error', error: last?.message ?? '下载失败' });
  }

  async function check({ auto = false } = {}) {
    if (state.state === 'dev') return state;
    if (busy) return busy;
    busy = (async () => {
      if (!auto) set({ state: 'checking' });
      try {
        const version = await latestVersion();
        if (!isNewer(version, current)) return set({ state: 'latest', version });
        if (read() === version) return set({ state: 'ready', version });
        if (auto && metered()) return set({ state: 'available', version });
        return await download(version);
      } catch (e) {
        return set({ state: auto ? state.state : 'error', error: e.message });
      } finally { busy = null; }
    })();
    return busy;
  }

  return {
    get state() { return state; },
    onUpdate(f) { listeners.add(f); return () => listeners.delete(f); },
    check,
    /** 顶栏按钮：available → 下载；ready → 打开系统安装界面 */
    async act() {
      if (state.state === 'available') return download(state.version);
      if (state.state !== 'ready') return state;
      const r = await plugin.install();
      if (r?.needPermission) return set({ hint: '请在打开的设置里允许未央“安装未知应用”，回来后再点一次“安装新版本”' });
      return set({ hint: '' });
    },
    /** 启动后自动检查，之后每隔一段时间再查 */
    start({ delayMs = 8000, everyMs = 6 * 3600_000 } = {}) {
      if (state.state === 'dev') return () => {};
      const t1 = setTimeout(() => check({ auto: true }), delayMs);
      const t2 = setInterval(() => check({ auto: true }), everyMs);
      return () => { clearTimeout(t1); clearInterval(t2); };
    }
  };
}
