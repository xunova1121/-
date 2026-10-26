/** 使用本机假服务商与真正服务器模式，检查配置隔离和几百个模型的实际界面。 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForDocumentStyle } from './wait-document-style.mjs';

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
  if (req.method === 'POST') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: '+JSON.stringify({choices:[{delta:{content:'已收到。'}}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    return;
  }

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
    const connectionTrace = [];
    const rememberConnection = (entry) => {
      connectionTrace.push(entry);
      if (connectionTrace.length > 12) connectionTrace.shift();
      fs.writeFileSync(path.join(output, `document-styles-network-${width}.json`), JSON.stringify({ serverExit: gateway.exitCode, entries: connectionTrace }, null, 2));
    };
    page.on('requestfailed', (request) => {
      if (new URL(request.url()).pathname === '/api/server/document-styles')
        rememberConnection({ method: request.method(), phase: 'transport_failed', code: request.failure()?.errorText?.slice(0, 80) });
    });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/server/document-styles')
        rememberConnection({ method: response.request().method(), phase: 'headers', httpStatus: response.status() });
    });
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
    await page.evaluate(() => window.__jarvis.send('以后Word用黑体'));
    await page.waitForFunction(() => !document.querySelector('.msg.agent.streaming'));
    const reflectionIsolated = await page.evaluate(async () => {
      await window.__jarvis.reflectNow();
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('jarvis');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const read = database.transaction('memories', 'readonly').objectStore('memories').getAll();
          read.onsuccess = () => { database.close(); resolve(!read.result.some(item => item.category === 'doc_style')); };
          read.onerror = () => { database.close(); reject(read.error); };
        };
      });
    });
    check(`${width} 服务器对话后台整理不写本机偏好`, reflectionIsolated);
    await waitForDocumentStyle(page);
    await page.evaluate(() => window.__jarvis.showPanel('models'));
    await page.waitForSelector('.ml-provider', { state: 'attached' });
    const mobileTab = async (label) => { if (width < 721) await page.getByRole('navigation', { name: '模型中心分类' }).getByRole('button', { name: label, exact: true }).click(); };
    if (width < 721) {
      check('手机默认能力页，隐藏服务商配置且没有常用/备用原生下拉框', await page.locator('[data-model-page=abilities]').isVisible() && !(await page.locator('[data-model-page=providers]').isVisible()) && await page.locator('.mc-abilities select:visible').count() === 0);
      await page.getByRole('button', { name: '配置编程', exact: true }).click();
      await page.getByRole('searchbox', { name: '搜索能力模型' }).fill('shared-model');
      check('手机能力选择器保留同名型号的两家服务商', await page.locator('.mc-choice').count() === 2 && (await page.locator('.mc-choice small').allTextContents()).includes('供应商 B'));
      const chosen = page.waitForResponse(r => r.url() === base + '/api/server/config' && r.request().method() === 'PUT' && r.request().postDataJSON()?.abilities?.code?.main?.provider === 'relay-2');
      await page.locator('.mc-choice').filter({ hasText: '供应商 B' }).click();
      await chosen;
      await page.waitForFunction(() => !document.querySelector('dialog.mc-sheet'));
      check('手机能力选择写入云端，不覆盖日常默认或本机密钥', JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).abilities.code.main.provider === 'relay-2' && JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).models.custom === 'shared-model' && await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.llm.v1')).keys.custom === 'local-key-secret'));
      await page.getByRole('button', { name: '配置编程', exact: true }).click();
      await page.locator('.mc-choice').filter({ hasText: '跟随日常对话' }).click();
      await page.waitForFunction(() => !document.querySelector('dialog.mc-sheet'));
      const focusAnchor = page.getByRole('button', { name: '配置看图', exact: true });
      await focusAnchor.click();
      await page.keyboard.press('Escape');
      await page.locator('dialog.mc-sheet').waitFor({ state: 'detached' });
      check('手机选择器 Esc 关闭并返回能力入口', await page.locator('dialog.mc-sheet').count() === 0 && await focusAnchor.evaluate(el => el === document.activeElement));
      await page.screenshot({ path: path.join(output, 'app-model-center-390.png') });
    }
    // 写作偏好收在“文档审查与写作偏好”里：先展开外层，再找里层
    await page.locator('details.ml-review').evaluate((d) => { d.open = true; });
    const stylesPanel = page.locator('details:has(> summary:text-is("写作偏好 · 云服务器"))');
    await stylesPanel.locator('> summary').click();
    // 两次失败覆盖GET的一次自动重试；随后用户再次点击应能恢复，不能登出或显示额度耗尽。
    let abortedReads = 0;
    await page.route('**/api/server/document-styles', async (route) => {
      if (route.request().method() === 'GET') { abortedReads++; await route.abort('failed'); }
      else await route.continue();
    });
    await stylesPanel.getByRole('button', { name: '查看写作偏好', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ml-style-list')?.parentElement.querySelector('[role="status"]')?.dataset.failureKind === 'network');
    check(`${width} 写作偏好断网最多重试一次，显示连接问题且保留登录`,
      abortedReads === 2 && await stylesPanel.locator('[role="status"]').getAttribute('data-attempt') === '2'
      && await page.evaluate((expected) => JSON.parse(localStorage.getItem('jarvis.server.v1')).token === expected, token));
    await page.unroute('**/api/server/document-styles');
    await stylesPanel.getByRole('button', { name: '查看写作偏好', exact: true }).click();
    await stylesPanel.locator('li').first().waitFor();
    const styleBefore = await stylesPanel.locator('li').count();
    check(`${width} 再次查看恢复真实服务器偏好列表并清除失败状态`, styleBefore > 0 && !(await stylesPanel.locator('[role="status"]').getAttribute('data-failure-kind')));
    const styleDeleted = page.waitForResponse(response => response.url().includes('/api/server/document-styles/') && response.request().method() === 'DELETE');
    await stylesPanel.getByRole('button', { name: '删除偏好', exact: true }).first().click();
    await styleDeleted;
    await page.waitForFunction(expected => document.querySelectorAll('.ml-style-list li').length === expected, styleBefore - 1);
    check(`${width} 云端写作偏好可查看删除且不读写本机`, (await stylesPanel.locator('li').count()) === styleBefore - 1);
    await stylesPanel.locator('> summary').click();
    check(
      `${width} 配置位置默认云服务器，按服务商显示，说明这就是实际在用的配置`,
      (await page.locator('#model-workspace .ml-scope-note').textContent()) === '任务在云服务器上做：这里改的就是实际在用的配置' &&
        (await page.locator('.ml-provider').count()) === 2
    );
    await mobileTab('服务商');
    const searchPanel = page.locator('details').filter({ has: page.getByText('联网搜索 · DeepSeek Search/Fetch · 云服务器', { exact: true }) });
    await searchPanel.locator('summary').click();
    await searchPanel.getByLabel('DeepSeek搜索Key', { exact: true }).fill('fake-search-key-secret');
    await searchPanel.getByLabel('启用DeepSeek搜索', { exact: true }).check();
    let searchSaved = page.waitForResponse(response => response.url() === base + '/api/server/config' && response.request().method() === 'PUT' && response.request().postDataJSON()?.deepseekSearchEnabled === true);
    await searchPanel.getByRole('button', { name: '保存搜索设置', exact: true }).click();
    await searchSaved;
    await searchPanel.getByText('已保存到云服务器，不改变聊天模型', { exact: true }).waitFor();
    const searchReadback = await page.evaluate(async () => {
      const settings = JSON.parse(localStorage.getItem('jarvis.server.v1'));
      const cfg = await (await fetch(settings.url + '/api/server/config', { headers: { Authorization: 'Bearer ' + settings.token } })).json();
      return { cfg, local: JSON.parse(localStorage.getItem('jarvis.llm.v1')) };
    });
    check(`${width} DeepSeek搜索云端独立保存、掩码且不改变默认模型`,
      searchReadback.cfg.deepseekSearchEnabled === true && searchReadback.cfg.deepseekSearchKey === '••••cret'
      && searchReadback.cfg.provider === 'custom' && !JSON.stringify(searchReadback.local).includes('fake-search-key-secret'));
    await searchPanel.getByLabel('启用DeepSeek搜索', { exact: true }).uncheck();
    searchSaved = page.waitForResponse(response => response.url() === base + '/api/server/config' && response.request().method() === 'PUT' && response.request().postDataJSON()?.deepseekSearchEnabled === false);
    await searchPanel.getByRole('button', { name: '保存搜索设置', exact: true }).click();
    await searchSaved;
    const disabledTest = page.waitForResponse(response => response.url() === base + '/api/server/search-test');
    await searchPanel.getByRole('button', { name: '测试Search', exact: true }).click();
    const testResponse = await disabledTest;
    check(`${width} 关闭搜索后主动测试明确拒绝，不调用真实付费接口`,
      testResponse.status() === 400 && (await testResponse.json()).code === 'DEEPSEEK_SEARCH_DISABLED');
    const unauthorizedTest = await fetch(base + '/api/server/search-test', { method: 'POST', body: '{"kind":"search"}' });
    check(`${width} 搜索测试接口要求登录`, unauthorizedTest.status === 401);
    await searchPanel.locator('summary').click();

    await page.locator('#model-workspace .ml-tabs').getByRole('button', { name: '本机', exact: true }).click();
    const localSearch = page.locator('details').filter({ has: page.getByText('联网搜索 · DeepSeek Search/Fetch · 本机', { exact: true }) });
    await localSearch.locator('summary').click();
    await localSearch.getByLabel('DeepSeek搜索Key', { exact: true }).fill('fake-local-search-key');
    await localSearch.getByLabel('启用DeepSeek搜索', { exact: true }).check();
    await localSearch.getByRole('button', { name: '保存搜索设置', exact: true }).click();
    await localSearch.getByText('已保存到本机，不改变聊天模型', { exact: true }).waitFor();
    let searchHeaders;
    await page.route('**/api/llm/deepseek/tools/search', async route => {
      searchHeaders = route.request().headers();
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [{ title: '假数据官网', url: 'https://www.gov.cn/test', summary: '测试摘要' }] }) });
    });
    await localSearch.getByRole('button', { name: '测试Search', exact: true }).click();
    await localSearch.getByText(/search：.*返回1条结果/).waitFor();
    check(`${width} 本机Search测试经过网关，登录令牌与上游Key分开`,
      searchHeaders?.authorization === 'Bearer ' + token && searchHeaders?.['x-jarvis-search-key'] === 'fake-local-search-key');
    await page.unroute('**/api/llm/deepseek/tools/search');
    await localSearch.getByLabel('启用DeepSeek搜索', { exact: true }).uncheck();
    await localSearch.getByRole('button', { name: '保存搜索设置', exact: true }).click();
    await localSearch.getByText('已保存到本机，不改变聊天模型', { exact: true }).waitFor();
    check(`${width} 本机搜索设置不覆盖云端独立密钥`,
      JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).deepseekSearchKey === 'fake-search-key-secret'
      && await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.llm.v1')).deepseekSearchKey === 'fake-local-search-key'));
    await page.locator('#model-workspace .ml-tabs').getByRole('button', { name: '云服务器', exact: true }).click();
    await page.waitForSelector('.ml-provider', { state: 'attached' });
    await mobileTab('能力');
    // 审查模型收在“文档审查与写作偏好”里（展开状态会保留，没展开才展开）
    await page.locator('details.ml-review').evaluate((d) => { d.open = true; });
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
    await mobileTab('服务商');
    const card = () => page.locator('.ml-provider').filter({ has: page.getByText('供应商 A', { exact: true }) });
    await card().getByRole('button', { name: '拉取模型', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ml-notice')?.textContent.includes('已拉取 302'));
    // 结果要写在“拉取模型”按钮旁边，不只在页面最上面（手机上翻不到，像没反应）
    check(`${width} 拉取结果显示在按钮旁边`, await page.locator('.ml-pull-status:visible').filter({ hasText: '已拉取 302' }).count() === 1);
    check(`${width} 几百个模型分批展示，不全铺开`, (await page.locator('.ml-catalog-results [data-model]').count()) === 12);
    check(
      `${width} 拉取使用服务器密钥，默认不变`,
      requests.at(-1)?.key === 'Bearer server-key-secret' &&
        JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).models.custom === 'shared-model'
    );
    await page.getByRole('searchbox', { name: '搜索全部模型', exact: true }).fill('chat-model-299');
    await page.locator('[data-model="chat-model-299"]').getByRole('button', { name: '加入常用 chat-model-299', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.ml-model[data-model="chat-model-299"]').length === 2);
    await page.locator('.ml-model[data-model="chat-model-299"]:visible').first().getByRole('button', { name: '设默认', exact: true }).click();
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
    await mobileTab('能力');
    if (width < 721) await page.locator('details.mc-image-options').evaluate(element => { element.open = true; });
    const savedImageOptions = page.waitForResponse(response => response.url() === base + '/api/server/config' && response.request().method() === 'PUT' && response.request().postDataJSON()?.imageOptions?.quality === 'high');
    const imageOptionBeforeSave = await page.getByLabel('画图画质', { exact: true }).elementHandle();
    await page.getByLabel('画图画质', { exact: true }).selectOption('high');
    await savedImageOptions;
    await page.waitForFunction(element => !element.isConnected, imageOptionBeforeSave);
    await page.locator('#model-workspace .ml-tabs').getByRole('button', { name: '本机', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('#model-workspace .ml-tabs button')].some(element => element.textContent === '本机' && element.getAttribute('aria-pressed') === 'true'));
    if (width < 721) await page.locator('details.mc-image-options').evaluate(element => { element.open = true; });
    await page.getByLabel('画图画质', { exact: true }).selectOption('medium');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('jarvis.llm.v1')).imageOptions?.quality === 'medium');
    check(`${width} 画图参数本机云端独立且不改默认模型`, JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).imageOptions.quality === 'high' && await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.llm.v1')).models.custom === 'local-model'));
    await page.locator('#model-workspace .ml-tabs').getByRole('button', { name: '云服务器', exact: true }).click();
    if (width < 721) await page.locator('details.mc-image-options').evaluate(element => { element.open = true; });
    await page.waitForFunction(() => document.querySelector('select[aria-label="画图画质"]')?.value === 'high');
    check(`${width} 画图参数重新读取及页面不横向溢出`, await page.locator('#panel').evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.screenshot({ path: path.join(output, `image-options-${width}.png`) });
    if (width < 721) await mobileTab('服务商');
    else await card().getByRole('button', { name: '管理全部模型 · 302 ›', exact: true }).click();
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
