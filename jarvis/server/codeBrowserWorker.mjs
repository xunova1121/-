/** 仅在隔离浏览器容器运行；声明式操作在页面内执行，不向项目开放宿主文件/凭据。 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
const input = JSON.parse(await fs.readFile('/request.json', 'utf8'));
let chrome,
  socket,
  server,
  documentStatus = null;
const deadline = setTimeout(() => {
  chrome?.kill('SIGKILL');
  process.exit(124);
}, 85000);
let serial = 0;
const pending = new Map(),
  errors = [],
  external = new Set();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('浏览器操作超时：' + method));
    }, 7000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      }
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error('页面操作异常：' + (value.exceptionDetails.text || '执行失败'));
  return value.result?.value;
};
async function action(step) {
  const selector = JSON.stringify(step.selector || '');
  if (step.action === 'reload') {
    await send('Page.reload', { ignoreCache: true });
    await wait(300);
    return { ok: true };
  }
  if (step.action === 'wait') {
    await wait(Math.min(2000, Math.max(0, step.ms || 300)));
    return { ok: true };
  }
  if (step.action === 'press') {
    const key = step.key === 'Shift+Tab' ? 'Tab' : step.key;
    if (!['Tab', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp'].includes(key)) throw new Error('不支持的按键');
    const value = {
      key,
      code: key,
      modifiers: step.key === 'Shift+Tab' ? 8 : 0,
      windowsVirtualKeyCode: { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 }[key]
    };
    await send('Input.dispatchKeyEvent', { ...value, type: 'keyDown' });
    await send('Input.dispatchKeyEvent', { ...value, type: 'keyUp' });
    return { ok: true };
  }
  if (step.action === 'scroll') {
    await evaluate(`window.scrollTo({top:${Math.min(10000, Math.max(0, step.y || 0))},behavior:'instant'})`);
    return { ok: true };
  }
  if (step.action === 'assert' && step.property === 'count') {
    const actual = await evaluate(`document.querySelectorAll(${selector}).length`);
    return { ok: actual === step.expected, property: 'count', expected: step.expected, actual };
  }
  const found = await evaluate(
    `(()=>{const e=document.querySelector(${selector});if(!e)return null;if(${JSON.stringify(step.action)}!=='assert')e.scrollIntoView({block:'nearest',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`
  );
  if (!found) throw new Error('页面找不到元素：' + step.selector);
  if (step.action === 'click') {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...found, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...found, button: 'left', clickCount: 1 });
    await wait(300);
    return { ok: true };
  }
  if (step.action === 'fill') {
    await evaluate(
      `(()=>{const e=document.querySelector(${selector});if(!['INPUT','TEXTAREA','SELECT'].includes(e.tagName))throw Error('目标不是表单');e.focus();e.value=${JSON.stringify(step.value || '')};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`
    );
    return { ok: true };
  }
  const actual = await evaluate(
    `(()=>{const e=document.querySelector(${selector}),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {text:e.textContent,value:e.value,count:document.querySelectorAll(${selector}).length,visible:r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none',focused:e===document.activeElement,disabled:Boolean(e.disabled),scrollY:window.scrollY};})()`
  );
  const property = step.property || 'text';
  const observed = actual[property];
  const ok = property === 'text' ? String(observed).includes(String(step.expected ?? '')) : observed === step.expected;
  return { ok, property, expected: step.expected, actual: typeof observed === 'string' ? observed.slice(0, 800) : observed };
}
async function main() {
  server = http.createServer(async (req, res) => {
    try {
      const target = path.resolve('/source', '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
      if (!target.startsWith('/source/')) throw new Error('path');
      const bytes = await fs.readFile(target);
      res.setHeader(
        'Content-Type',
        {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript',
          '.mjs': 'application/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.webp': 'image/webp'
        }[path.extname(target)] || 'application/octet-stream'
      );
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const targetUrl = new URL('/' + input.entry, base).href;
  chrome = spawn(
    process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    [
      '--headless',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--remote-debugging-port=0',
      '--user-data-dir=/tmp/browser-profile',
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const debugUrl = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error('Chromium启动失败')), 10000);
    chrome.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    chrome.stderr.on('data', (chunk) => {
      log = (log + chunk).slice(-8000);
      const url = log.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    });
  });
  const targets = await (await fetch('http://' + new URL(debugUrl).host + '/json/list')).json();
  socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const job = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) job?.reject(new Error(message.error.message));
      else job?.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown' && errors.length < 16)
      errors.push(String(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text).slice(0, 500));
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error' && errors.length < 16)
      errors.push(
        message.params.args
          .map((a) => String(a.value ?? a.description ?? ''))
          .join(' ')
          .slice(0, 500)
      );
    if (message.method === 'Network.responseReceived') {
      const response = message.params.response;
      if (message.params.type === 'Document' && response.url === targetUrl) documentStatus = response.status;
      if (response.status >= 400 && response.url.startsWith(base + '/') && !response.url.endsWith('/favicon.ico') && errors.length < 16)
        errors.push('项目资源HTTP' + response.status + ': ' + response.url.slice(base.length, base.length + 200));
    }
    if (message.method === 'Network.requestWillBeSent') {
      const url = message.params.request.url;
      if (/^https?:/.test(url) && !url.startsWith(base + '/') && external.size < 20) {
        try {
          external.add(new URL(url).origin);
        } catch {}
      }
    }
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: input.width, height: input.height, deviceScaleFactor: 1, mobile: input.width < 600 });
  await send('Page.navigate', { url: targetUrl });
  await wait(500);
  const checks = [];
  for (let i = 0; i < input.steps.length; i++) {
    try {
      checks.push({ step: i + 1, action: input.steps[i].action, ...(await action(input.steps[i])) });
    } catch (e) {
      checks.push({ step: i + 1, action: input.steps[i].action, ok: false, error: String(e.message).slice(0, 300) });
      break;
    }
  }
  const page = await evaluate(`({title:document.title,url:location.href,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,scrollY:scrollY})`);
  const picture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const bytes = Buffer.from(picture.data, 'base64');
  if (bytes.length > 4_000_000) throw new Error('浏览器截图超过4MB');
  await fs.writeFile('/output/preview.png', bytes);
  const layoutOk = page.scrollWidth <= page.width + 1;
  const report = {
    ok: checks.every((c) => c.ok) && errors.length === 0 && layoutOk && documentStatus >= 200 && documentStatus < 400 && page.url.startsWith(base + '/'),
    documentStatus,
    layoutOk,
    checks,
    errors,
    page,
    screenshot: 'preview.png',
    externalOrigins: [...external],
    visual: external.size ? 'limited_external_resources' : 'rendered_not_human_reviewed',
    network: 'container_offline',
    hostWorktreeWritable: false
  };
  await fs.writeFile('/output/report.json', JSON.stringify(report));
  console.log(JSON.stringify({ ok: report.ok, checks: checks.length, errors: errors.length }));
}
try {
  await main();
} catch (e) {
  console.error(String(e.message).slice(0, 500));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  socket?.close();
  chrome?.kill('SIGKILL');
  server?.close();
}
