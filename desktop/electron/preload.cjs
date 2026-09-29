/**
 * 预加载脚本。
 *
 * 界面本身完全通过 HTTP 和本地服务打交道，不需要任何 Node 能力，
 * 所以这里只暴露几个只读的环境标记 —— 攻击面能小就小。
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('futuredream', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }
});
