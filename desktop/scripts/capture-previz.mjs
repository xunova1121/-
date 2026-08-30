/** Windows 构建机上的真实 Electron/Three.js 预演台截图。 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.FD_PREVIZ_URL || 'http://127.0.0.1:5178/ui/previz-demo.html';
const output = path.resolve(process.env.FD_PREVIZ_SCREENSHOT || 'dist/FutureDream-Previz-Stage4.png');
const deadline = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时（${ms / 1000}秒）`)), ms))
]);

await app.whenReady();
const win = new BrowserWindow({
  width: 1600,
  height: 1100,
  show: false,
  backgroundColor: '#0c0e13',
  webPreferences: { backgroundThrottling: false }
});

let exitCode = 0;
try {
  await deadline(win.loadURL(url), 30_000, '预演页面加载');
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const state = await win.webContents.executeJavaScript(`({
    title: document.title,
    canvas: document.querySelectorAll('canvas').length,
    controls: document.querySelectorAll('button').length,
    text: document.body.innerText.slice(0, 300)
  })`);
  if (!state.canvas || !/3D导演预演台/.test(state.text)) {
    throw new Error(`预演组件未完成渲染：${JSON.stringify(state)}`);
  }
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, image.toPNG());
  console.log(`真实预演台截图：${output}（${image.getSize().width}×${image.getSize().height}）`);
} catch (error) {
  exitCode = 1;
  console.error(error?.stack || error);
} finally {
  win.destroy();
  // Windows runner 上 app.quit() 可能被页面的 beforeunload 卡住；截图任务必须确定退出。
  app.exit(exitCode);
}
