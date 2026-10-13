// 贾维斯桌面版 preload：只向页面暴露有限的接口，页面拿不到 Node / Electron 本身
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('jarvis:info');

contextBridge.exposeInMainWorld('jarvisDesktop', {
  platform: info.platform,
  version: info.version,
  paths: info.paths,
  /** 调用主进程里的电脑操作；失败时抛出可读的错误 */
  async invoke(op, args) {
    const r = await ipcRenderer.invoke('jarvis:desktop', op, args);
    if (!r?.ok) throw new Error(r?.error || '操作失败');
    return r.value;
  },
  /** 全局快捷键呼出时通知页面（聚焦输入框） */
  onSummon(fn) {
    ipcRenderer.on('jarvis:summon', () => fn());
  },
  /** 用户按了紧急停止热键（电脑操作中） */
  onStop(fn) {
    ipcRenderer.on('jarvis:stop', () => fn());
  },
  /** 离开电脑一段时间后回来了（{ awayMs, reason }） */
  onPresence(fn) {
    ipcRenderer.on('jarvis:presence', (_e, info) => fn(info));
  },
  /** 自动更新状态（checking / downloading / ready / available / latest / error） */
  onUpdate(fn) {
    ipcRenderer.on('jarvis:update', (_e, state) => fn(state));
  },
  /** 操作习惯学习：前台程序采样（只有程序名和时间） */
  onActivity(fn) {
    ipcRenderer.on('jarvis:activity', (_e, sample) => fn(sample));
  },
  /** 桌面背景窗口：接收主窗口同步过来的状态 */
  onWallpaper(fn) {
    ipcRenderer.on('jarvis:wallpaper', (_e, payload) => fn(payload));
  },
  setAlwaysOnTop: (on) => ipcRenderer.invoke('jarvis:window', 'alwaysOnTop', on),
  /** 右上角系统按钮的底色 / 图标颜色 / 高度（跟随明暗主题） */
  setTitleBar: (o) => ipcRenderer.invoke('jarvis:window', 'titleBar', o)
});
