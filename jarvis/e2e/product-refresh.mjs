/** 渐变UI只接原页面：真实导航、窄屏、恢复及可读性；不请求模型。 */
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
    const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 2 });
    await page.addInitScript(() => localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false })));
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis && document.querySelector('.product-navigation'));
    assert.equal(await page.locator('.product-navigation button').count(), 3);
    checks++;
    await page.locator('.product-navigation [data-page="workspace"]').click();
    await page.waitForFunction(() => document.body.classList.contains('side-open') && !document.querySelector('[data-pane="workspace"]').hidden);
    assert.equal(await page.locator('.product-navigation [data-page="workspace"]').getAttribute('aria-current'), 'page');
    checks++;
    await page.screenshot({ path: path.join(output, `workspace-${width}.png`) });
    await page.locator('.product-navigation [data-page="settings"]').click();
    assert.equal(await page.locator('[data-pane="settings"]').isVisible(), true);
    checks++;
    await page.locator('.product-navigation [data-page="chat"]').click();
    await page.waitForFunction(() => !document.body.classList.contains('side-open'));
    assert.equal(await page.locator('.home-reference').isVisible(), true);
    checks++;
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    checks++;
    const atmosphere = await page.evaluate(() => {
      const style = (s) => getComputedStyle(document.querySelector(s));
      const clear = (s) => style(s).backgroundImage === 'none' && style(s).backgroundColor === 'rgba(0, 0, 0, 0)';
      const body = getComputedStyle(document.body);
      return {
        backdrop: body.backgroundImage,
        size: body.backgroundSize,
        repeat: body.backgroundRepeat,
        unified: ['.app', '.main', '.transcript', '.topbar', '.welcome.home-reference', '.product-navigation'].every(clear),
        colors: ['--text', '--muted', '--dim', '--accent'].map((key) => body.getPropertyValue(key).trim()),
        touch: [...document.querySelectorAll('.product-navigation button')].every((b) => {
          const r = b.getBoundingClientRect();
          return r.height >= 44 && r.width >= 44;
        }),
        vector: document.querySelector('.home-task-icon svg')?.getAttribute('viewBox')
      };
    });
    assert.ok(atmosphere.backdrop.includes('radial-gradient') && atmosphere.unified, '顶栏、首页和底栏共用连续背景，不能各画色块');
    checks++;
    assert.ok(atmosphere.size.split(',').every((size) => size.trim() === `${width}px 844px`) && atmosphere.repeat.split(',').every((repeat) => repeat.trim() === 'no-repeat'), '背景铺满完整视口，底栏处不能重新起色');
    checks++;
    // 与渐变最深的端点比；半透明表面混白只会提高这些深色文字的对比度。
    const luminance = (hex) => {
      const values = hex.match(/[a-f\d]{2}/gi).map((x) => parseInt(x, 16) / 255).map((x) => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    for (const ink of atmosphere.colors) {
      for (const background of ['#c8effa', '#e2dcfb', '#f5f7ff', '#fdfbfc', '#e9f7fc']) {
        assert.ok((luminance(background) + 0.05) / (luminance(ink) + 0.05) >= 4.5, `${ink}在${background}上对比度不足`);
      }
    }
    checks++;
    assert.ok(atmosphere.touch && atmosphere.vector, '导航可点击、图标为矢量，高清不靠放大截图');
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
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.side-back')).backgroundColor), 'rgba(0, 0, 0, 0)');
    checks++;
    if (width === 390) {
      await page.locator('.product-navigation [data-page="chat"]').click();
      await page.fill('#prompt', '你好，记住这是界面恢复测试');
      await page.click('#btn-send');
      await page.waitForFunction(() => document.querySelector('.msg.agent') && !document.querySelector('.msg.agent.streaming'));
      await page.screenshot({ path: path.join(output, 'conversation-390.png') });
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
  console.log(`柔和渐变UI：${checks}/${checks}`);
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
