/** 真实手机版构建/浏览器；只模拟原生boot写入的mobile-app标记，不冒充安卓真机。 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const out = process.argv[2] || '/tmp/weiyang-native-startup';
await fs.mkdir(out, { recursive: true });
const root = path.resolve('dist-mobile');
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture');
    const target = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!target.startsWith(root + path.sep)) throw Error('outside');
    let bytes = await fs.readFile(target);
    if (url.pathname === '/' && url.searchParams.has('native')) bytes = Buffer.from(bytes.toString().replace('<html ', '<html class="mobile-app" '));
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
    res.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream');
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const checks = [];
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log('通过：' + label); };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    window.startupTrace = [];
    new MutationObserver(() => {
      const splash = document.querySelector('#app-splash');
      const phase = !splash ? 'removed' : splash.classList.contains('out') ? 'out' : splash.classList.contains('native-playing') ? 'playing' : 'loading';
      if (window.startupTrace.at(-1)?.phase !== phase) window.startupTrace.push({ phase, at: performance.now() });
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // 不拦截/拖慢JS和素材，覆盖APK本地资源很快就绪时原动画一闪而过的路径。
  await page.goto(base + '/?native', { waitUntil: 'commit' });
  await page.waitForFunction(() => document.documentElement.classList.contains('mobile-ui-ready'));
  const readyState = await page.evaluate(() => {
    const splash = document.querySelector('#app-splash');
    return { present: Boolean(splash), opacity: splash ? Number(getComputedStyle(splash).opacity) : 0, leaving: Boolean(splash?.classList.contains('out')) };
  });
  await fs.writeFile(path.join(out, 'startup-ready.json'), JSON.stringify(readyState));
  check('APK快速就绪后启动层仍可见：' + JSON.stringify(readyState), readyState.present && readyState.opacity > .9 && !readyState.leaving);
  await page.waitForSelector('#app-splash.native-playing', { timeout: 10000 });
  const logo = page.locator('#app-splash .as-logo');
  const first = await logo.evaluate(el => getComputedStyle(el).backgroundPosition);
  await page.waitForTimeout(250);
  check('快速资源就绪后仍显示角色，图集帧实际移动', await logo.isVisible() && first !== await logo.evaluate(el => getComputedStyle(el).backgroundPosition));
  const shot = await context.newCDPSession(page);
  const frame = await shot.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(path.join(out, 'native-playing.png'), Buffer.from(frame.data, 'base64'));
  await page.waitForFunction(() => !document.querySelector('#app-splash'));
  const trace = await page.evaluate(() => window.startupTrace);
  const playing = trace.find(x => x.phase === 'playing'), leaving = trace.find(x => x.phase === 'out');
  check('APK一轮播放不少于1.6秒且按时退出', leaving.at - playing.at >= 1550 && leaving.at - playing.at < 2500);
  check('启动后首页输入框可用', await page.locator('#prompt').isVisible());
  await page.locator('#prompt').fill('启动后可以输入');
  check('启动动画不吞掉输入', await page.locator('#prompt').inputValue() === '启动后可以输入');
  await page.reload({ waitUntil: 'commit' });
  await page.waitForSelector('#app-splash.native-playing');
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#app-splash'), null, { timeout: 600 });
  check('缓存启动仍可播放，并能立即跳过', true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  check('返回前台不会重新盖住已有对话', !await page.locator('#app-splash').count());
  check('启动页面没有未处理脚本异常', errors.length === 0);
  await context.close();
  for (const mode of ['browser', 'safe', 'reduced', 'broken']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(mode === 'reduced' ? { reducedMotion: 'reduce' } : {}) });
    if (mode === 'safe') await ctx.addInitScript(() => localStorage.setItem('jarvis.renderSafe', 'true'));
    if (mode === 'broken') await ctx.route('**/*mascot-startup*.webp', route => route.abort());
    const p = await ctx.newPage();
    await p.goto(base + (mode === 'browser' ? '/' : '/?native'));
    await p.waitForFunction(() => document.documentElement.classList.contains('mobile-ui-ready'));
    await p.waitForFunction(() => !document.querySelector('#app-splash'), null, { timeout: 600 });
    check(`${mode}保留快速进入和安全回退`, await p.locator('#prompt').isVisible());
    await ctx.close();
  }
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ actualAndroidDevice: false, build: 'dist-mobile', checks, trace }, null, 2));
  console.log(`启动动画 ${checks.length}/${checks.length}；安卓真机未测。`);
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
