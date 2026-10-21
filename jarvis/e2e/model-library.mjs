/** 使用本机假服务商与真正服务器模式，检查配置隔离和几百个模型的实际界面。 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const output = process.argv[2] || path.join(os.tmpdir(), 'jarvis-model-library');
fs.mkdirSync(output, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-model-library-data-'));
const password = 'library-test-password';
const token = createHash('sha256').update(`jarvis-server:${password}`).digest('hex');
const port = 8794;
const base = `http://127.0.0.1:${port}`;
const results = [];
const check = (title, ok) => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${title}`);
};
const requests = [];
const upstream = createServer((req, res) => {
  requests.push({ path: req.url, key: req.headers.authorization });
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ data: [{ id: 'shared-model' }, ...Array.from({ length: 300 }, (_, i) => ({ id: `chat-model-${i}` })), { id: 'gpt-image-2' }] }));
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${upstream.address().port}/v1`;
const serverConfig = {
  provider: 'custom',
  models: { custom: 'shared-model', 'relay-2': 'shared-model' },
  keys: { custom: 'server-key-secret', 'relay-2': 'backup-secret' },
  baseURLs: { custom: address, 'relay-2': address },
  providerNames: { custom: '供应商 A', 'relay-2': '供应商 B' },
  favoriteModels: [{ provider: 'relay-2', model: 'shared-model' }]
};
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(serverConfig));
const styleFolder = path.join(data, 'store', 'memories');
fs.mkdirSync(styleFolder, { recursive: true });
for (const id of ['docstyle_docx_font', 'docstyle_pptx_color']) {
  const filename = createHash('sha1').update(id).digest('hex') + '.json';
  fs.writeFileSync(path.join(styleFolder, filename), JSON.stringify({ id, category: 'doc_style', content: id.endsWith('font') ? 'docx · 用宋体' : 'pptx · 用深蓝', updatedAt: Date.now() }));
}
const gateway = spawn(process.execPath, ['server/server.mjs'], {
  env: { ...process.env, PORT: String(port), JARVIS_DATA: data, JARVIS_PASSWORD: password },
  stdio: 'pipe'
});
let logs = '';
gateway.stdout.on('data', (chunk) => {
  logs += chunk;
});
gateway.stderr.on('data', (chunk) => {
  logs += chunk;
});
const browser = await chromium.launch();
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/api/health')).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ base, token, address }) => {
        localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token, enabled: true }));
        localStorage.setItem(
          'jarvis.llm.v1',
          JSON.stringify({ provider: 'custom', models: { custom: 'local-model' }, keys: { custom: 'local-key-secret' }, baseURLs: { custom: address } })
        );
      },
      { base, token, address }
    );
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis?.showPanel);
    const reflectionIsolated = await page.evaluate(async () => {
      const app = window.__jarvis;
      const original = { server: app.server, session: app.session, from: app.reflectFrom };
      try {
        app.session = { id: 'isolated-style-test', messages: [{ role: 'user', content: '以后Word用黑体' }] };
        app.reflectFrom = 0;
        await app.reflectNow();
        app.server = null;
        app.session.evaluationId = 'evaluation-style-test';
        await app.reflectNow();
        return await new Promise((resolve, reject) => {
          const request = indexedDB.open('jarvis');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const database = request.result;
            const read = database.transaction('memories', 'readonly').objectStore('memories').getAll();
            read.onsuccess = () => { database.close(); resolve(!read.result.some(item => item.category === 'doc_style')); };
            read.onerror = () => { database.close(); reject(read.error); };
          };
        });
      } finally {
        app.server = original.server;
        app.session = original.session;
        app.reflectFrom = original.from;
      }
    });
    check(`${width} 服务器与评测后台整理不写本机偏好`, reflectionIsolated);
    await page.evaluate(() => window.__jarvis.showPanel('models'));
    await page.waitForSelector('.ml-provider');
    const stylesPanel = page.locator('details').filter({ has: page.getByText('写作偏好 · 云服务器', { exact: true }) });
    await stylesPanel.locator('summary').click();
    await stylesPanel.getByRole('button', { name: '查看写作偏好', exact: true }).click();
    await stylesPanel.locator('li').first().waitFor();
    const styleBefore = await stylesPanel.locator('li').count();
    const styleDeleted = page.waitForResponse(response => response.url().includes('/api/server/document-styles/') && response.request().method() === 'DELETE');
    await stylesPanel.getByRole('button', { name: '删除偏好', exact: true }).first().click();
    await styleDeleted;
    await page.waitForFunction(expected => document.querySelectorAll('.ml-style-list li').length === expected, styleBefore - 1);
    check(`${width} 云端写作偏好可查看删除且不读写本机`, (await stylesPanel.locator('li').count()) === styleBefore - 1);
    await stylesPanel.locator('summary').click();
    check(
      `${width} 配置位置默认云服务器，按服务商显示`,
      (await page.locator('#model-workspace .ml-scope-note').textContent()) === '正在修改服务器配置，不影响本机' &&
        (await page.locator('.ml-provider').count()) === 2
    );
    const reviewSaved = page.waitForResponse(response => response.url() === base + '/api/server/config' && response.request().method() === 'PUT' && response.request().postDataJSON()?.documentReviewer?.provider === 'relay-2');
    await page.getByLabel('文档审查模型', { exact: true }).selectOption({ label: '供应商 B · shared-model' });
    await reviewSaved;
    await page.waitForFunction(() => !document.querySelector('[aria-label="文档审查模型"]').disabled);
    const reviewConfig = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    check(`${width} 审查分工独立保存，不改聊天或泄露服务器配置到本机`, reviewConfig.documentReviewer?.provider === 'relay-2' && reviewConfig.models.custom === 'shared-model' && await page.evaluate(() => !JSON.parse(localStorage.getItem('jarvis.llm.v1')).documentReviewer));
    const reviewCleared = page.waitForResponse(response => response.url() === base + '/api/server/config' && response.request().method() === 'PUT' && response.request().postDataJSON()?.documentReviewer === null);
    await page.getByLabel('文档审查模型', { exact: true }).selectOption('');
    await reviewCleared;
    await page.waitForFunction(() => !document.querySelector('[aria-label="文档审查模型"]').disabled);
    check(`${width} 可清空审查分工回到同模型自查`, JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).documentReviewer === null);
    const card = () => page.locator('.ml-provider').filter({ has: page.getByText('供应商 A', { exact: true }) });
    await card().getByRole('button', { name: '拉取模型', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ml-notice')?.textContent.includes('已拉取 302'));
    check(`${width} 几百个模型分批展示，不全铺开`, (await page.locator('.ml-catalog-results [data-model]').count()) === 12);
    check(
      `${width} 拉取使用服务器密钥，默认不变`,
      requests.at(-1)?.key === 'Bearer server-key-secret' &&
        JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).models.custom === 'shared-model'
    );
    await page.getByRole('searchbox', { name: '搜索全部模型', exact: true }).fill('chat-model-299');
    await page.locator('[data-model="chat-model-299"]').getByRole('button', { name: '加入常用 chat-model-299', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.ml-model[data-model="chat-model-299"]').length === 2);
    await page.locator('.ml-model[data-model="chat-model-299"]').first().getByRole('button', { name: '设默认', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('model-chip-text').textContent.includes('chat-model-299'));
    check(
      `${width} 服务器默认切换不覆盖本机`,
      await page.evaluate(() => {
        const local = JSON.parse(localStorage.getItem('jarvis.llm.v1'));
        return local.models.custom === 'local-model' && local.keys.custom === 'local-key-secret' && !JSON.stringify(local).includes('server-key-secret');
      })
    );
    await page.getByRole('searchbox', { name: '搜索全部模型', exact: true }).fill('');
    await page.getByLabel('模型类别', { exact: true }).selectOption('image');
    const savedMedia = page.waitForResponse(
      (response) =>
        response.url() === base + '/api/server/config' &&
        response.request().method() === 'PUT' &&
        response.request().postDataJSON()?.imageModel === 'gpt-image-2'
    );
    await page.getByRole('button', { name: '用于画图', exact: true }).click();
    const mediaResponse = await savedMedia;
    const mediaReadback = await page.evaluate(async () => {
      const settings = JSON.parse(localStorage.getItem('jarvis.server.v1'));
      const response = await fetch(settings.url + '/api/server/config', { headers: { Authorization: 'Bearer ' + settings.token } });
      const cfg = await response.json();
      return { imageModel: cfg.imageModel, model: cfg.models?.custom };
    });
    const mediaConfig = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    check(
      `${width} 保留生成模型选择且不改变对话默认`,
      mediaResponse.ok() &&
        mediaConfig.imageModel === 'gpt-image-2' &&
        mediaConfig.models.custom === 'chat-model-299' &&
        mediaReadback.imageModel === 'gpt-image-2' &&
        mediaReadback.model === 'chat-model-299'
    );
    await card().getByRole('button', { name: '管理全部模型 · 302 ›', exact: true }).click();
    await page.locator('#toast').waitFor({ state: 'hidden' });
    await page.locator('#panel').evaluate((element) => (element.scrollTop = 0));
    check(
      `${width} 服务商卡片按屏幕排版且互不覆盖`,
      await page.locator('.ml-provider').evaluateAll((cards) => {
        const first = cards[0].getBoundingClientRect(),
          second = cards[1].getBoundingClientRect();
        return innerWidth >= 1000 ? first.right <= second.left : first.bottom <= second.top;
      })
    );
    await page.screenshot({ path: path.join(output, `model-settings-${width}.png`) });
    await page.evaluate(() => {
      document.body.classList.add('side-closed');
      document.body.classList.remove('side-open');
    });
    await page.click('#model-chip');
    await page.waitForSelector('.ml-picker-item');
    check(
      `${width} 对话只显示常用，保留同名模型的两个服务商`,
      (await page.locator('.ml-picker-item').count()) === 3 &&
        (await page
          .locator('.ml-picker-provider')
          .allTextContents()
          .then((items) => items.includes('供应商 A') && items.includes('供应商 B')))
    );
    check(
      `${width} 模型面板不越界且无可见滚动条`,
      await page.locator('.ml-picker').evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left >= 0 &&
          rect.right <= innerWidth + 1 &&
          rect.bottom <= innerHeight + 1 &&
          getComputedStyle(element.querySelector('.ml-picker-results')).scrollbarWidth === 'none'
        );
      })
    );
    await page.screenshot({ path: path.join(output, `model-picker-${width}.png`) });
    await page.keyboard.press('Escape');
    check(
      `${width} Esc关闭且焦点返回模型入口`,
      (await page.locator('.ml-picker').isHidden()) && (await page.locator('#model-chip').evaluate((element) => element === document.activeElement))
    );
    check(`${width} 无页面错误`, errors.length === 0);
    await context.close();
    // 下一种尺寸从相同配置开始，便于比较。
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(serverConfig));
  }
} finally {
  await browser.close();
  gateway.kill();
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(data, { recursive: true, force: true });
}
console.log(`模型工作台 ${results.filter(Boolean).length}/${results.length} 通过`);
if (results.some((value) => !value)) process.exitCode = 1;
