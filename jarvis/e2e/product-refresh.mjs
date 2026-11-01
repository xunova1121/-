/** 蓝白UI只接原页面：真实导航、窄屏、夜间及键盘空间；不请求模型。 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const output = process.argv[2] || '/tmp/weiyang-product-refresh';
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
try {
  for (const width of [320, 390, 430]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.addInitScript(() => localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false })));
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis && document.querySelector('.product-navigation'));
    assert.equal(await page.locator('.product-navigation button').count(), 3);
    checks++;
    await page.locator('.product-navigation [data-page="workspace"]').click();
    await page.waitForFunction(() => document.body.classList.contains('side-open') && !document.querySelector('[data-pane="workspace"]').hidden);
    assert.equal(await page.locator('.product-navigation [data-page="workspace"]').getAttribute('aria-current'), 'page');
    checks++;
    await page.locator('.product-navigation [data-page="settings"]').click();
    assert.equal(await page.locator('[data-pane="settings"]').isVisible(), true);
    checks++;
    await page.locator('.product-navigation [data-page="chat"]').click();
    await page.waitForFunction(() => !document.body.classList.contains('side-open'));
    assert.equal(await page.locator('.home-reference').isVisible(), true);
    checks++;
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    checks++;
    assert.equal(
      await page.evaluate(
        () => document.querySelector('#inputbar').getBoundingClientRect().bottom <= document.querySelector('.product-navigation').getBoundingClientRect().top
      ),
      true
    );
    checks++;
    await page.screenshot({ path: path.join(output, `home-${width}.png`) });
    await page.evaluate(() => window.__jarvis.showPanel('models'));
    await page.screenshot({ path: path.join(output, `models-${width}.png`) });
    assert.equal(await page.locator('.ml-runtime-switch').isVisible(), true);
    checks++;
    if (width === 390) {
      await page.locator('.product-navigation [data-page="chat"]').click();
      await page.fill('#prompt', '你好，记住这是界面恢复测试');
      await page.click('#btn-send');
      await page.waitForFunction(() => document.querySelector('.msg.agent') && !document.querySelector('.msg.agent.streaming'));
      const sessionId = await page.evaluate(() => window.__jarvis.sessionId);
      await page.waitForFunction(async (id) => {
        const saved = await window.__jarvis.sessionGet(id);
        return saved?.messages?.some((m) => m.role === 'user' && m.content.includes('界面恢复测试')) && !document.querySelector('.msg.agent.streaming');
      }, sessionId);
      await page.reload();
      await page.waitForFunction((id) => window.__jarvis?.sessionId === id && document.querySelector('.msg'), sessionId);
      checks++;
      await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('jarvis');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction('sessions', 'readwrite');
          tx.objectStore('sessions').put({
            id: 'older-pinned',
            title: '置顶旧对话',
            titleSet: true,
            pinned: true,
            createdAt: 1,
            updatedAt: 1,
            messages: [{ role: 'user', content: '旧记录', ts: 1 }]
          });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      });
      // 刷新按原逻辑恢复当前会话；重新进入应用才留首页，两条行为都保留。
      await page.goto(base);
      try {
        await page.waitForSelector('.home-resume:not([hidden])');
      } catch (error) {
        console.log(
          await page.evaluate(
            async (id) => ({
              home: document.querySelector('.home-reference')?.textContent,
              resume: document.querySelector('.home-resume')?.outerHTML,
              saved: await window.__jarvis.sessionGet(id)
            }),
            sessionId
          )
        );
        throw error;
      }
      assert.equal(await page.locator('.msg').count(), 0, '重启只显示首页，不自动打开历史');
      checks++;
      assert.ok((await page.locator('.home-resume').textContent()).includes('界面恢复测试'), '置顶旧记录不能挤掉最新对话');
      checks++;
      await page.locator('.home-resume').click();
      await page.waitForFunction((id) => window.__jarvis.sessionId === id && document.querySelector('.msg'), sessionId);
      assert.ok((await page.locator('#transcript').textContent()).includes('界面恢复测试'));
      checks++;
    }
    await page.close();
  }
  console.log(`蓝白UI：${checks}/${checks}`);
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
