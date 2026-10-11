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
  setAlwaysOnTop: (on) => ipcRenderer.invoke('jarvis:window', 'alwaysOnTop', on)
});
