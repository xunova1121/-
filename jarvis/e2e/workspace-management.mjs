/** 真实手机构建：五千文件、分组、别名、项目、收藏、回收站和来源对话；无真实模型调用。 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const root = path.resolve('dist-mobile');
const output = process.argv[2] || '/tmp/workspace-management';
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)));
    if (!file.startsWith(root + path.sep)) throw Error('outside');
    const bytes = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type':
        { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp' }[
          path.extname(file)
        ] || 'application/octet-stream'
    });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch();
let total = 0;
let failed = 0;
function check(label, passed) {
  total++;
  if (!passed) failed++;
  console.log((passed ? '✓ ' : '✗ ') + label);
}
try {
  for (const width of [390, 412]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
      if (window.top !== window) return;
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false }));
      localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'mock' }));
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis?.showPanel);
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('jarvis');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const now = Date.now();
      const transaction = db.transaction(['files', 'kv', 'sessions'], 'readwrite');
      const files = transaction.objectStore('files');
      for (let index = 0; index < 5000; index++)
        files.put({ id: `日常/测试文件${String(index).padStart(4, '0')}.md`, data: new Blob(['# 示例']), size: 8, mtime: now - index * 1000 });
      for (const name of ['项目/方案.docx', '项目/方案.pdf', '文档检查/方案-docx.json', '音乐/实测歌曲.mp3'])
        files.put({ id: name, data: new Blob(['fixture']), size: 7, mtime: now + 1000 });
      const kv = transaction.objectStore('kv');
      kv.put({ id: 'work-ledger-v1', since: now, ids: ['test-generation'], truncated: false });
      kv.put({
        id: 'work-record:test-generation',
        generationId: 'test-generation',
        sessionId: 'source-conversation',
        tool: 'sing_song',
        kind: 'song',
        title: '实测歌曲',
        files: ['音乐/实测歌曲.mp3'],
        status: 'success',
        createdAt: now
      });
      transaction.objectStore('sessions').put({
        id: 'source-conversation',
        title: '歌曲来源对话',
        titleSet: true,
        createdAt: now,
        updatedAt: now,
        messages: [
          { role: 'user', content: '给我唱一首歌', ts: now },
          { role: 'assistant', content: '已经唱好。', files: ['音乐/实测歌曲.mp3'], ts: now + 1 }
        ]
      });
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
      window.__jarvis.showPanel('workspace');
    });
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 50);
    check(`${width} 五千文件仅渲染50项`, (await page.locator('#file-list li.ws-result').count()) === 50);
    await page.screenshot({ path: path.join(output, `workspace-list-${width}.png`) });
    check(`${width} 过程文件默认收起`, !(await page.locator('#file-list').textContent()).includes('方案-docx.json'));
    await page.locator('.ws-load-more').click();
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 100);
    check(`${width} 按需加载到100项`, (await page.locator('#file-list li.ws-result').count()) === 100);
    const search = page.getByRole('searchbox', { name: '搜索文件名' });
    await search.fill('测试文件4999');
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 1);
    check(`${width} 能查到列表尾部文件`, (await page.locator('#file-list').textContent()).includes('测试文件4999.md'));
    await search.fill('测试文件499');
    await page.waitForFunction(
      () => document.querySelector('#file-list').getAttribute('aria-busy') !== 'true' && document.querySelectorAll('#file-list li.ws-result').length === 10
    );
    await page.locator('#file-list li.ws-result>input').nth(0).check();
    await page.locator('#file-list li.ws-result>input').nth(1).check();
    await page.locator('.ws-batch').getByRole('button', { name: '收藏', exact: true }).click();
    await page.locator('[data-view="favorites"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 2);
    check(`${width} 支持批量收藏`, (await page.locator('#file-list li.ws-result').count()) === 2);
    await page.locator('#file-list li.ws-result>input').nth(0).check();
    await page.locator('#file-list li.ws-result>input').nth(1).check();
    await page.locator('.ws-batch').getByRole('button', { name: '取消收藏', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 0);
    await page.locator('[data-view="recent"]').click();
    await search.fill('方案');
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 2);
    // 搜索时允许查到过程文件，普通浏览时不混入主成果。
    check(`${width} 同名Word与PDF归拢`, (await page.locator('#file-list li.ws-result .ws-formats button').count()) === 2);
    await page.locator('#file-list li.ws-result').filter({ hasText: '项目/方案' }).locator('>button').click();
    const dialog = page.locator('.ws-manager');
    await dialog.getByLabel('显示名称').fill('客户方案初稿');
    await dialog.getByLabel('所属项目').fill('水产平台');
    await dialog.getByRole('button', { name: '保存名称与项目' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await search.fill('水产平台');
    await page
      .waitForFunction(
        () => document.querySelectorAll('#file-list li.ws-result').length === 1 && document.querySelector('#file-list').textContent.includes('客户方案初稿')
      )
      .catch(async (error) => {
        console.log(
          '项目搜索失败状态',
          await page.evaluate(() => ({
            search: document.querySelector('.ws-controls input[type=search]').value,
            text: document.querySelector('#file-list').textContent.slice(0, 500)
          }))
        );
        throw error;
      });
    check(`${width} 可按项目名找到别名成果`, (await page.locator('#file-list').textContent()).includes('客户方案初稿'));
    await page.locator('#file-list li.ws-result>button').click();
    await dialog.getByRole('button', { name: '收藏成果', exact: true }).click();
    await page.locator('[data-view="favorites"]').click();
    check(`${width} 收藏视图保留成果`, (await page.locator('#file-list li.ws-result').count()) === 1);
    await page.locator('#file-list li.ws-result>button').click();
    await dialog.getByRole('button', { name: '移至回收站', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 0);
    await page.locator('[data-view="trash"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 1);
    check(`${width} 回收站可恢复且不破坏原路径`, (await page.locator('#file-list').textContent()).includes('项目/方案.docx'));
    await page.locator('#file-list li.ws-result>button').click();
    await dialog.getByRole('button', { name: '恢复到工作区', exact: true }).click();
    await page.locator('[data-view="recent"]').click();
    await search.fill('实测歌曲');
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 1);
    await page.locator('#file-list li.ws-result>button').click();
    await dialog.getByRole('button', { name: '查看来源对话' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__jarvis.sessionId === 'source-conversation');
    check(`${width} 成果能追到来源对话`, await page.evaluate(() => window.__jarvis.sessionId === 'source-conversation'));
    await page.evaluate(() => window.__jarvis.showPanel('workspace'));
    await search.fill('实测歌曲');
    await page.waitForFunction(
      () =>
        document.querySelector('#file-list').getAttribute('aria-busy') !== 'true' && document.querySelector('#file-list').textContent.includes('实测歌曲.mp3')
    );
    await page.locator('#file-list li.ws-result>button').click();
    await dialog.getByLabel('显示名称').fill('纠正后的歌名');
    await dialog.getByRole('button', { name: '保存名称与项目' }).click();
    await dialog.waitFor({ state: 'hidden' });
    check(
      `${width} 可纠正来源生成记录`,
      await page.evaluate(async () => {
        const db = await new Promise((resolve) => {
          const request = indexedDB.open('jarvis');
          request.onsuccess = () => resolve(request.result);
        });
        const record = await new Promise((resolve) => {
          const request = db.transaction('kv').objectStore('kv').get('work-record:test-generation');
          request.onsuccess = () => resolve(request.result);
        });
        db.close();
        return record.displayTitle === '纠正后的歌名' && record.title === '实测歌曲';
      })
    );
    await page.locator('#file-list li.ws-result>button').click();
    await dialog.getByRole('button', { name: '删除生成记录（保留文件）' }).click();
    await dialog.waitFor({ state: 'hidden' });
    check(
      `${width} 删除记录保留文件`,
      await page.evaluate(async () => {
        const db = await new Promise((resolve) => {
          const request = indexedDB.open('jarvis');
          request.onsuccess = () => resolve(request.result);
        });
        const read = (store, id) =>
          new Promise((resolve) => {
            const request = db.transaction(store).objectStore(store).get(id);
            request.onsuccess = () => resolve(request.result);
          });
        const record = await read('kv', 'work-record:test-generation');
        const file = await read('files', '音乐/实测歌曲.mp3');
        db.close();
        return !record && Boolean(file);
      })
    );
    await search.fill('水产平台');
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 1);
    await page.waitForFunction(
      () =>
        document.querySelector('#file-list').getAttribute('aria-busy') !== 'true' && document.querySelector('#file-list').textContent.includes('客户方案初稿')
    );
    check(
      `${width} 没有横向溢出`,
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#panel').scrollWidth <= document.querySelector('#panel').clientWidth
      )
    );
    await page.screenshot({ path: path.join(output, `workspace-${width}.png`) });
    await page.click('#btn-theme');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    check(
      `${width} 夜间主题保留管理布局`,
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#file-list').textContent.includes('客户方案初稿'))
    );
    await page.screenshot({ path: path.join(output, `workspace-night-${width}.png`) });
    await page.click('#btn-theme');
    await page.waitForFunction(() => document.documentElement.dataset.theme !== 'dark');

    await page.reload();
    await page.waitForFunction(() => window.__jarvis?.showPanel);
    await page.evaluate(() => window.__jarvis.showPanel('workspace'));
    await page.getByRole('searchbox', { name: '搜索文件名' }).fill('水产平台');
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 1);
    await page.waitForFunction(() => document.querySelector('#file-list').textContent.includes('客户方案初稿'));
    check(`${width} 重启后保留管理标记`, (await page.locator('#file-list').textContent()).includes('客户方案初稿'));
    check(`${width} 无页面异常`, errors.length === 0);
    await page.getByRole('searchbox', { name: '搜索文件名' }).fill('测试文件4999');
    await page.waitForFunction(
      () => document.querySelector('#file-list').getAttribute('aria-busy') !== 'true' && document.querySelectorAll('#file-list li.ws-result').length === 1
    );
    await page.locator('#file-list li.ws-result>button').click();
    await dialog.getByRole('button', { name: '移至回收站', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('[data-view="trash"]').click();
    await page.waitForFunction(
      () => document.querySelector('#file-list').getAttribute('aria-busy') !== 'true' && document.querySelectorAll('#file-list li.ws-result').length === 1
    );
    await page.locator('#file-list li.ws-result>button').click();
    const permanent = dialog.getByRole('button', { name: '永久删除文件', exact: true });
    const guarded = await permanent.isDisabled();
    await dialog.getByLabel(/确认永久删除/).check();
    await permanent.click();
    await dialog.waitFor({ state: 'hidden' });
    const removed = await page.evaluate(async () => {
      const db = await new Promise((resolve) => {
        const request = indexedDB.open('jarvis');
        request.onsuccess = () => resolve(request.result);
      });
      const file = await new Promise((resolve) => {
        const request = db.transaction('files').objectStore('files').get('日常/测试文件4999.md');
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return !file;
    });
    check(`${width} 永久删除必须明确勾选确认`, guarded && removed);
    await context.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
console.log(`工作区成果管理 ${total - failed}/${total} 通过`);
if (failed) process.exitCode = 1;
