/** 渐变UI只接原页面：真实导航、窄屏、恢复及可读性；不请求模型。 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const output = process.argv[2] || '/tmp/weiyang-home-history';
await fs.mkdir(output, { recursive: true });
const root = path.resolve('dist-mobile');
const server = http.createServer(async (req, res) => {
  try {
    const target = path.resolve(
      root,
      '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname === '/' ? '/index.html' : new URL(req.url, 'http://x').pathname)
    );
    if (!target.startsWith(root + path.sep)) throw Error('outside');
    const data = await fs.readFile(target);
    res.setHeader(
      'Content-Type',
      {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.wasm': 'application/wasm'
      }[path.extname(target)] || 'application/octet-stream'
    );
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
let checks = 0;
// 夹具使用真实服务器会话接口；任务状态由可控runner提供，不发模型请求。
const { createServerMode, tokenFor } = await import('../server/serverMode.mjs');
const { createServer } = await import('../server/server.mjs');
const { useBackend } = await import('../src/agent/store.js');
const os = await import('node:os');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'home-history-'));
const tasks = [{ id: 'fixture-running', sessionId: 'history-1', status: 'running' }, { id: 'fixture-queue', sessionId: 'history-2', status: 'queued' }];
const password = 'home-history-test-password';
const sessionStore = await import('../src/agent/sessions.js');
const mode = createServerMode({ dataDir, password, runner: { list: () => tasks, edit: async (id, change) => { const row = await sessionStore.get(id); if (!row) return false; await change(row); return true; } } });
await mode.ready;
const gateway = createServer({ serverMode: mode, ollama: null });
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
const gatewayBase = `http://127.0.0.1:${gateway.address().port}`;
const api = async (p, body) => {
  const response = await fetch(gatewayBase + p, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tokenFor(password)}`, 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${p}: ${response.status}`);
  return response.json();
};
const now = Date.now();
for (let i = 0; i < 10; i++) await api('/api/sessions/import', { id: `history-${i}`, title: ['每日重点新闻', '周末出行安排', '项目需求与开发计划', '帮我把今天要做的事排好，保留完整标题'][i] || `历史对话 ${i}`, titleSet: true, createdAt: now - i * 3600000, updatedAt: now - i * 3600000, messages: [{ role: 'user', content: '测试问题', ts: now - 10000 }, { role: 'assistant', content: '测试回答', ts: now - 9000 }] });
try {
  const startupContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  let releaseEntry;
  const gate = new Promise((resolve) => { releaseEntry = resolve; });
  await startupContext.route('**/*.js', async (route) => { await gate; await route.continue(); });
  const startup = await startupContext.newPage();
  await startup.goto(base, { waitUntil: 'commit' });
  await startup.waitForFunction(() => document.querySelector('.as-drop') && getComputedStyle(document.querySelector('#app-splash .as-logo')).backgroundImage.includes('mascot-startup'));
  const startEffects = await startup.evaluate(() => {
    const style = (s) => getComputedStyle(document.querySelector(s));
    return { ripple: style('.as-glow').animationName, droplet: style('.as-drop').animationName, character: style('.as-character').animationName, message: document.querySelector('.as-sub').textContent, hiddenApp: style('.app').visibility };
  });
  assert.deepEqual(startEffects, { ripple: 'startup-water', droplet: 'startup-droplet', character: 'startup-emerge', message: '我在，随时陪你。', hiddenApp: 'hidden' }); checks++;
  const capture = await startupContext.newCDPSession(startup);
  for (const [frame, ms] of [['water', 120], ['mascot', 900]]) {
    await startup.evaluate((time) => document.getAnimations().forEach((animation) => { animation.pause(); animation.currentTime = time; }), ms);
    const shot = await capture.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(path.join(output, `startup-${frame}.png`), Buffer.from(shot.data, 'base64'));
  }
  await startup.evaluate(() => document.getAnimations().forEach((animation) => animation.play()));
  releaseEntry();
  await startup.waitForFunction(() => document.documentElement.classList.contains('mobile-ui-ready'));
  await startup.waitForFunction(() => !document.querySelector('#app-splash'), null, { timeout: 600 }); checks++;
  await startupContext.close();
  for (const [width, height] of [[320, 640], [390, 844], [430, 932]]) {
    console.log(`开始首页与历史 ${width}×${height}`);
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(([url, token]) => {
      localStorage.setItem('jarvis.server.v1', JSON.stringify({ url, token, enabled: true }));
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false }));
      globalThis.prompt = () => '改过的对话名称';
    }, [gatewayBase, tokenFor(password)]);
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis && !document.querySelector('#app-splash'));
    await page.waitForSelector('.home-resume:not([hidden])');
    const home = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { fileGap: r('#inputbar').top - r('.home-files').bottom, footerFit: r('.home-files').bottom <= r('#inputbar').top, widthFit: document.documentElement.scrollWidth <= innerWidth, overlap: r('.home-pet-hint').bottom > r('.home-resume').top, fileDescription: document.querySelector('.home-files small')?.textContent, boxes: Object.fromEntries(['.home-hero','.home-pet','.home-pet-hint','.home-resume'].map(s=>[s,{top:r(s).top,bottom:r(s).bottom}])) };
    });
    await page.screenshot({ path: path.join(output, `measure-${width}.png`) });
    assert.ok(home.fileGap >= 0 && home.fileGap <= 40 && home.footerFit && home.widthFit && !home.overlap, JSON.stringify({ width, home })); checks++;
    assert.equal(home.fileDescription, '文档、图片与生成作品'); checks++;
    await page.screenshot({ path: path.join(output, `home-${width}.png`) });
    await page.locator('.home-files').click();
    assert.equal(await page.locator('.product-page-title').textContent(), '工作区'); checks++;
    await page.click('#btn-side-back');
    await page.click('#btn-menu');
    await page.waitForSelector('.drawer-row[data-activity="running"]');
    assert.equal(await page.locator('.drawer-item-icon').count(), 0); checks++;
    assert.equal(await page.locator('.drawer-row[data-id="history-1"] .drawer-activity').textContent(), '回答中'); checks++;
    assert.equal(await page.locator('.drawer-row[data-id="history-2"] .drawer-activity').textContent(), '排队中'); checks++;
    const density = await page.evaluate(() => [...document.querySelectorAll('.drawer-row')].map((row) => {
      const css = getComputedStyle(row), box = row.getBoundingClientRect(), title = row.querySelector('.drawer-item-t');
      return {id:row.dataset.id,height:box.height,bg:css.backgroundColor,current:!!row.querySelector('[aria-current]'),wrap:getComputedStyle(title).whiteSpace,overflow:getComputedStyle(title).textOverflow};
    }));
    await page.screenshot({ path: path.join(output, `history-${width}.png`) });
    assert.ok(density.every(r=>r.height>=44&&r.height<=54&&(r.current||r.bg==='rgba(0, 0, 0, 0)')&&r.wrap==='nowrap'&&r.overflow==='ellipsis'), `历史条目仍臃肿或标题换行：${width} ${JSON.stringify(density)}`); checks++;
    assert.equal(await page.locator('.drawer-grid button').count(), 8); checks++;
    assert.equal(await page.locator('.drawer-project-entry').isVisible(), true); checks++;
    await page.screenshot({ path: path.join(output, `history-${width}.png`) });
    await page.fill('.drawer-search', '项目需求');
    await page.waitForSelector('.drawer-row[data-id="history-2"]');
    assert.equal(await page.locator('.drawer-row').count(), 1); checks++;
    await page.fill('.drawer-search', '');
    await page.locator('.drawer-close').click();
    assert.equal(await page.locator('#drawer').getAttribute('aria-hidden'), 'true'); checks++;
    // 实际点开才记已读；另一个设备新回复后出现蓝点，刷新仍保留，打开后清除。
    await page.evaluate(() => window.__jarvis.openSession('history-3'));
    await page.evaluate(() => window.__jarvis.openSession('history-0'));
    await api('/api/sessions/history-3/append', { messages: [{ role: 'assistant', content: '另一台设备的新回复', ts: Date.now() }] });
    await page.click('#btn-menu');
    await page.waitForSelector('.drawer-row[data-id="history-3"] .drawer-unread', { timeout: 12000 }); checks++;
    await page.locator('.drawer-row[data-id="history-3"] .drawer-item').click();
    await page.waitForFunction(() => window.__jarvis.sessionId === 'history-3');
    await page.click('#btn-menu');
    await page.waitForSelector('.drawer-row[data-id="history-3"] .drawer-item[aria-current="true"]');
    assert.equal(await page.locator('.drawer-row[data-id="history-3"] .drawer-unread').count(), 0); checks++;
    await page.locator('.drawer-row[data-id="history-3"] .drawer-item-more').click();
    assert.ok((await page.locator('.drawer-menu').textContent()).includes('导出为 Word')); checks++;
    await page.locator('.drawer-menu button', { hasText: '重命名' }).click();
    await page.waitForFunction(() => document.querySelector('.drawer-row[data-id="history-3"] .drawer-item-t')?.textContent === '改过的对话名称'); checks++;
    assert.deepEqual(errors, []); checks++;
    await page.close();
  }
  console.log(`首页与历史列表：${checks}/${checks}，真实浏览器/会话接口，任务状态为runner夹具，无模型请求`);
} finally {
  await browser.close();
  await new Promise((resolve) => gateway.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  useBackend(null);
  await fs.rm(dataDir, { recursive: true, force: true });
}
