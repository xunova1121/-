/** 真正启动 Electron：对话里的链接在内置浏览器打开，网页和未央隔开，右上角能转到系统浏览器。 */
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-browser-'));
const results = [];
const check = (label, ok) => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${label}`); };

// 本机假网站：a 页有一个普通链接、一个新窗口链接
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (req.url === '/a') res.end('<title>页面A</title><a id="next" href="/b">去B</a> <a id="blank" href="/c" target="_blank">新窗口C</a>');
  else res.end(`<title>页面${req.url.slice(1).toUpperCase()}</title><p>${req.url}</p>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

let app;
try {
  app = await electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/electron'), args: [path.join(root, 'desktop'), '--no-sandbox'], env: { ...process.env, HOME: home, JARVIS_HOME: path.join(home, '.jarvis'), JARVIS_DESKTOP_TEST: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const main = await app.firstWindow();
  await main.waitForFunction(() => window.__jarvis, null, { timeout: 60000 });
  const mainUrl = main.url();
  // 记下“用系统浏览器打开”，不真的开
  await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u); }; });
  const views = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => ({ id: w.id, url: w.getURL(), title: w.getTitle() })));
  const run = (match, js) => app.evaluate(async ({ webContents }, [m, code]) => {
    const w = webContents.getAllWebContents().find((x) => x.getURL().includes(m));
    return w ? w.executeJavaScript(code) : '没找到';
  }, [match, js]);
  const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

  // 模拟对话里的来源链接（target=_blank）
  await main.evaluate((url) => { const a = Object.assign(document.createElement('a'), { href: url, target: '_blank', id: 'test-link', textContent: '来源' }); document.body.append(a); a.click(); }, `${base}/a`);
  check('点对话里的链接：在内置浏览器打开', await waitFor(async () => (await views()).some((v) => v.url === `${base}/a`)));
  check('主窗口还在未央，没有被跳走', main.url() === mainUrl);
  check('工具栏地址栏显示当前网址', await waitFor(async () => (await run('browserBar.html', "document.getElementById('address').value")) === `${base}/a`));
  check('网页拿不到未央和工具栏的任何接口', (await run(`${base}/a`, 'typeof window.jarvisDesktop + "," + typeof window.jarvisBrowser + "," + typeof require')) === 'undefined,undefined,undefined');
  check('网页用单独的登录存储，和未央不共用', await app.evaluate(({ webContents, session }) => {
    const page = webContents.getAllWebContents().find((w) => /\/a$/.test(w.getURL()));
    return page.session !== session.defaultSession;
  }));

  await run(`${base}/a`, "document.getElementById('blank').click()");
  check('网页里的新窗口链接就在当前窗口打开，不弹新窗口', await waitFor(async () => (await views()).some((v) => v.url === `${base}/c`)) && !(await views()).some((v) => v.url === `${base}/a`));
  await run('browserBar.html', "document.getElementById('back').click()");
  check('后退回到上一页', await waitFor(async () => (await views()).some((v) => v.url === `${base}/a`)));
  await run('browserBar.html', "document.getElementById('external').click()");
  check('右上角“在浏览器中打开”交给系统浏览器', await waitFor(async () => (await app.evaluate(() => globalThis.__opened)).includes(`${base}/a`)));
  await run('browserBar.html', "document.getElementById('address').value='" + base + "/b'; document.getElementById('form').requestSubmit()");
  check('地址栏输入网址能打开', await waitFor(async () => (await views()).some((v) => v.url === `${base}/b`)));

  const before = (await views()).length;
  await main.evaluate(() => { window.open('file:///etc/passwd'); });
  await new Promise((r) => setTimeout(r, 800));
  check('file: 这类本机文件链接不打开', !(await views()).some((v) => /etc\/passwd/.test(v.url)) && (await views()).length === before);
  await main.evaluate((url) => window.open(url), `${base}/c`);
  check('再点别的链接：复用同一个浏览器窗口', await waitFor(async () => (await views()).some((v) => v.url === `${base}/c`)) && (await views()).filter((v) => v.url.includes('browserBar.html')).length === 1);
} finally {
  await app?.close();
  site.close();
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(`${results.filter(Boolean).length}/${results.length} 内置浏览器通过`);
process.exit(results.length && results.every(Boolean) ? 0 : 1);
