// 内置浏览器工具栏的 preload：只给工具栏页面几个按钮动作，网页本身没有 preload
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvisBrowser', {
  /** back / forward / reload / go（带网址）/ external（用系统浏览器打开当前页） */
  do: (action, value) => ipcRenderer.send('jarvis-browser:do', action, value),
  /** 网页的地址、标题、能否后退前进、是否在加载 */
  onState: (fn) => ipcRenderer.on('jarvis-browser:state', (_e, state) => fn(state))
});
