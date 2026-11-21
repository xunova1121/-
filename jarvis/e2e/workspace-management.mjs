/** 真实手机构建：五千文件、分组、别名、项目、收藏、回收站和来源对话；无真实模型调用。 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { createServerClient } from '../src/core/serverClient.js';
import { useBackend } from '../src/agent/store.js';
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
async function readActiveFiles(page, paths) {
  return page.evaluate(async names => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('jarvis');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const store = db.transaction('files').objectStore('files');
      return await Promise.all(names.map(name => new Promise((resolve, reject) => {
        const read = store.get(name);
        read.onsuccess = () => resolve(read.result?.data ? read.result.data.text() : null);
        read.onerror = () => reject(read.error);
      })));
    } finally { db.close(); }
  }, paths);
}
async function checkCloudTrash() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-trash-phone-'));
  const password = 'workspace-fixture';
  const mode = createServerMode({ dataDir: dir, password });
  const cloud = createServer({ serverMode: mode, staticDir: root });
  try {
    await mode.ready;
    await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + cloud.address().port;
    const owner = createServerClient({ base: url, token: tokenFor(password) });
    const member = await owner.createUser('文件空间验收');
    const login = await owner.loginAccount(member.accessCode);
    const client = createServerClient({ base: url, token: login.token });
    const config = { enabled: true, url, userId: member.id, token: login.token, role: 'member' };
    const filename = '附件/历史报价.md';
    const openPhone = async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await context.addInitScript(cfg => localStorage.setItem('jarvis.server.v1', JSON.stringify(cfg)), config);
      const page = await context.newPage();
      await page.goto(url);
      await page.waitForFunction(() => window.__jarvis?.showPanel);
      await page.evaluate(() => window.__jarvis.showPanel('workspace'));
      return page;
    };
    await owner.upload(filename, new Blob(['另一账号的报价']));
    await client.upload(filename, new Blob(['旧版报价']));
    const first = await openPhone();
    const row = first.locator('#file-list li.ws-result').filter({ hasText: filename });
    await row.locator('>button').click();
    await first.getByRole('button', { name: '移至回收站', exact: true }).click();
    await first.locator('.ws-manager').waitFor({ state: 'hidden' });
    check('手机删除云端旧附件后实际从成员文件空间移除', !(await client.listFiles()).some(f => f.path === filename) && (await client.listTrashedFiles()).some(f => f.path === filename));
    check('同名的另一账号文件保持可读', await (await owner.download(filename)).text() === '另一账号的报价');
    await first.context().close();
    // 新的手机上下文没有前一台设备的 IndexedDB；只能从真实服务器取回回收列表。
    const second = await openPhone();
    await second.locator('[data-view="trash"]').click();
    await second.locator('#file-list li.ws-result').filter({ hasText: filename }).locator('>button').click();
    await second.getByRole('button', { name: '恢复到工作区', exact: true }).click();
    await second.locator('.ws-manager').waitFor({ state: 'hidden' });
    check('另一台手机恢复后原路径原字节可读，成员回收站已清除', await (await client.download(filename)).text() === '旧版报价' && !(await client.listTrashedFiles()).some(f => f.path === filename));
    await second.route('**/api/files/trash', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) }));
    await second.locator('[data-view="recent"]').click();
    await second.locator('#file-list li.ws-result').filter({ hasText: filename }).waitFor();
    await second.locator('[data-view="trash"]').click();
    await second.locator('#file-list').getByText(/更新服务器/).waitFor();
    check('旧服务器仍能访问正常目录，回收站明确要求更新', (await client.listFiles()).some(f => f.path === filename));
    await second.unroute('**/api/files/trash');
    const extra = ['.workflows/清理验收/过程稿.md', ...Array.from({ length: 22 }, (_, i) => '其他/旧文' + i + '.txt')];
    for (const path of extra) await client.upload(path, new Blob(['一稿']));
    await second.locator('[data-view="recent"]').click();
    await second.getByRole('searchbox', { name: '搜索文件名' }).fill('历史报价');
    await second.locator('#file-list li.ws-result').filter({ hasText: filename }).waitFor();
    const clear = second.getByRole('button', { name: '全部移入回收站', exact: true });
    const preview = second.getByRole('dialog', { name: '清理当前文件空间' });
    await clear.click();
    await preview.getByText(/云服务器（当前账号.*共有 24 个文件/).waitFor();
    await preview.getByRole('button', { name: '取消', exact: true }).click();
    check('有搜索筛选仍按当前云账号预览24个文件，取消后零移动', (await client.listFiles()).length === 24 && !(await client.listTrashedFiles()).length);
    await clear.click();
    await preview.getByText(/共有 24 个文件/).waitFor();
    const addedLater = '附件/确认之后新增.txt';
    await client.upload(addedLater, new Blob(['新文件']));
    await client.upload(filename, new Blob(['确认前修改过的报价']));
    await preview.getByRole('button', { name: '确认移入回收站' }).click();
    await preview.getByText('已移入 23 个，1 个未移入。').waitFor();
    const active = await client.listFiles();
    check('一批可处理超过20个文件和过程稿，新增或修改的文件仍保留', active.length === 2 && [filename, addedLater].every(name => active.some(f => f.path === name)) && (await client.listTrashedFiles()).some(f => f.path === extra[0]));
    await preview.getByRole('button', { name: '关闭', exact: true }).click();
    await clear.click();
    await preview.getByText(/共有 2 个文件/).waitFor();
    await preview.getByRole('button', { name: '确认移入回收站' }).click();
    await preview.waitFor({ state: 'hidden' });
    check('再次预览确认后本人云空间为零，其他账号文件仍可读', !(await client.listFiles()).length && (await client.listTrashedFiles()).length === 25 && await (await owner.download(filename)).text() === '另一账号的报价');
    await second.context().close();
  } finally {
    await mode.tenders.stop();
    await mode.runner.settled();
    cloud.closeAllConnections();
    if (cloud.listening) await new Promise(resolve => cloud.close(resolve));
    useBackend(null);
    await fs.rm(dir, { recursive: true, force: true });
  }
}
async function checkLocalClear() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  await page.goto(base);
  await page.waitForFunction(() => window.__jarvis?.workspace);
  const paths = ['上传/申请.md', '备忘录.txt', '.workflows/task/过程稿.md'];
  await page.evaluate(async names => {
    for (const name of names) await window.__jarvis.workspace.write(name, '验收：' + name);
    window.__jarvis.showPanel('workspace');
  }, paths);
  const row = name => page.locator('#file-list li.ws-result').filter({ hasText: name });
  for (const name of paths.slice(0, 2)) await row(name).locator('>input').check();
  const batch = page.locator('.ws-batch');
  await batch.getByText('已选 2 项').waitFor();
  await batch.getByRole('button', { name: '移至回收站', exact: true }).click();
  await batch.waitFor({ state: 'hidden' });
  const active = await readActiveFiles(page, paths);
  const trashedPaths = () => page.evaluate(async () => (await window.__jarvis.workspace.listTrash()).map(file => file.path).sort());
  const moved = await trashedPaths();
  check('手动勾选两项不同成果后只移走所选文件，未选文件原字节保留',
    active[0] === null && active[1] === null && active[2] === '验收：' + paths[2] && moved.length === 2 && moved.includes(paths[0]) && moved.includes(paths[1]));
  await page.locator('[data-view="trash"]').click();
  for (const [index, name] of paths.slice(0, 2).entries()) {
    await row(name).locator('>button').click();
    await page.getByRole('button', { name: '恢复到工作区', exact: true }).click();
    await page.locator('.ws-manager').waitFor({ state: 'hidden' });
    const bytes = await readActiveFiles(page, paths);
    const remaining = await trashedPaths();
    check('可单独恢复所选成果 ' + name,
      bytes[index] === '验收：' + name && bytes[2] === '验收：' + paths[2] &&
      (index === 0 ? bytes[1] === null && remaining.length === 1 && remaining[0] === paths[1] : bytes[0] === '验收：' + paths[0] && remaining.length === 0));
  }
  await page.locator('[data-view="recent"]').click();
  await page.getByRole('searchbox', { name: '搜索文件名' }).fill('找不到的名字');
  await page.getByRole('button', { name: '全部移入回收站', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '清理当前文件空间' });
  await dialog.getByText(/本机工作区共有 3 个文件/).waitFor();
  await page.screenshot({ path: path.join(output, 'workspace-file-cleanup.png') });
  await dialog.getByRole('button', { name: '确认移入回收站' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const result = await page.evaluate(async () => [(await window.__jarvis.workspace.list()).length, (await window.__jarvis.workspace.listTrash()).length]);
  check('本机搜索无结果也能确认全部移入回收站，活动目录为零', result[0] === 0 && result[1] === 3);
  await page.close();
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
      files.put({ id: '旧档/旧版隐藏.txt', data: new Blob(['保留旧文件']), size: 15, mtime: now });
      kv.put({ id: 'workspace-catalog:local:virtual:', items: { '旧档/旧版隐藏.txt': { trash: true } } });
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
    await search.fill('旧版隐藏');
    await page.waitForFunction(() => !document.querySelector('#file-list li.ws-result'));
    await page.locator('[data-view="trash"]').click();
    await page.locator('#file-list li.ws-result').filter({ hasText: '旧版隐藏.txt' }).locator('>button').click();
    await page.getByRole('button', { name: '恢复到工作区', exact: true }).click();
    await page.locator('.ws-manager').waitFor({ state: 'hidden' });
    await page.locator('[data-view="recent"]').click();
    await page.locator('#file-list li.ws-result').filter({ hasText: '旧版隐藏.txt' }).waitFor();
    check(`${width} 旧版仅隐藏的文件能恢复，原文件字节保留`, (await readActiveFiles(page, ['旧档/旧版隐藏.txt']))[0] === '保留旧文件');
    await search.fill('测试文件4999');
    await page.waitForFunction(() => document.querySelector('#file-list').getAttribute('aria-busy') !== 'true' && document.querySelectorAll('#file-list li.ws-result').length === 1);
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
    const formats = ['项目/方案.docx', '项目/方案.pdf'];
    check(`${width} 移入回收站后两个实际文件均已离开活动目录`, (await readActiveFiles(page, formats)).every(value => value === null));
    await page.locator('#file-list li.ws-result>button').click();
    await dialog.getByRole('button', { name: '恢复到工作区', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    check(`${width} 在手机恢复后两个文件原字节可读`, (await readActiveFiles(page, formats)).every(value => value === 'fixture'));
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
    const reused = '附件/同名新增.md';
    await page.evaluate(async name => {
      const ws = window.__jarvis.workspace;
      await ws.write(name, '旧附件');
      await ws.trash(name);
      await ws.write(name, '同名新附件');
    }, reused);
    await page.getByRole('searchbox', { name: '搜索文件名' }).fill('同名新增');
    await page.locator('#file-list li.ws-result').filter({ hasText: reused }).locator('>button').click();
    await dialog.getByRole('button', { name: '恢复到工作区', exact: true }).click();
    await page.getByText(/工作区已存在同名文件/).waitFor();
    await dialog.getByLabel(/确认永久删除/).check();
    await dialog.getByRole('button', { name: '永久删除文件', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    check(`${width} 从真实回收站清理只作用于旧附件，当前同名新文件保留`, (await readActiveFiles(page, [reused]))[0] === '同名新附件');
    await context.close();
  }
  await checkLocalClear();
  await checkCloudTrash();
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
console.log(`工作区成果管理 ${total - failed}/${total} 通过`);
if (failed) process.exitCode = 1;
