/** 用 Windows Edge 的 DevTools 协议核验 Three.js 画布后截取真实预演台。 */
import fs from 'node:fs';
import path from 'node:path';

const endpoint = process.env.FD_EDGE_DEBUG || 'http://127.0.0.1:9222';
const url = process.env.FD_PREVIZ_URL || 'http://127.0.0.1:5178/previz-demo.html';
const output = path.resolve(process.env.FD_PREVIZ_SCREENSHOT || 'dist/FutureDream-Previz-Stage4.png');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let target;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    const list = await fetch(`${endpoint}/json/list`).then((response) => response.json());
    target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    if (target) break;
  } catch {}
  await delay(250);
}
if (!target) throw new Error('无法连接 Windows Edge 调试端口');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let serial = 0;
const pending = new Map();
const exceptions = [];
const network = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    return message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text);
  }
  if (message.method === 'Network.responseReceived') {
    const response = message.params.response;
    if (/previz|three|demo-assets/.test(response.url)) network.push({ url: response.url, status: response.status, mime: response.mimeType });
  }
  if (message.method === 'Network.loadingFailed') {
    network.push({ failed: true, error: message.params.errorText, blocked: message.params.blockedReason || '' });
  }
  if (message.method === 'Log.entryAdded') exceptions.push(`${message.params.entry.level}: ${message.params.entry.text}`);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await delay(12_000);
const evaluated = await send('Runtime.evaluate', {
  expression: `({title:document.title,canvas:document.querySelectorAll('canvas').length,buttons:document.querySelectorAll('button').length,error:document.querySelector('#demo-error')?.textContent||'',demo:document.querySelector('#demo')?.innerHTML||'',resources:performance.getEntriesByType('resource').map(x=>x.name),text:document.body.innerText.slice(0,500)})`,
  returnByValue: true
});
const state = evaluated.result?.value || {};
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Buffer.from(shot.data, 'base64'));
console.log(`预演页面状态：${JSON.stringify({ ...state, network })}`);
if (!state.canvas || !/3D导演预演台/.test(state.text || '')) {
  throw new Error(`Three.js 预演画布未完成渲染。异常：${exceptions.join(' | ') || state.error || '无运行时异常'}`);
}
console.log(`真实预演台截图：${output}`);
socket.close();
