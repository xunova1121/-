/** 正式 PC/手机界面；替换外部新闻和模型响应，实际操作当前会话和工作区。 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { createServer } from '../server/server.mjs';
import { checkWorkshopTvPlayback, openMobileCloudRoom } from './workshop-tv-playback.mjs';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-workshop-media');
const briefFile = '工作台新闻简报.docx';
const now = Date.now();
const items = ['城市图书馆开放夜间借阅', '社区科学讲堂公布新一期安排'].map((title, i) => ({
  title, source: '央视网', publishedAt: new Date(now - (i + 1) * 60000).toISOString(),
  url: `https://news.cctv.com/2026/11/20/ARTIworkshop${i + 1}.shtml`
}));
const servers = [];
const browser = await chromium.launch();
await mkdir(output, { recursive: true });

async function openRoom(page, mobile) {
  if (mobile) {
    await page.locator('#btn-menu').click();
    await page.getByRole('button', { name: '未央工作台', exact: true }).click();
  } else {
    await page.locator('.wb-tabs').getByRole('button', { name: '工作台', exact: true }).click();
  }
  const room = page.locator('.work-studio:visible');
  await room.waitFor();
  return room;
}

// 只读真实生成的 Office 压缩包，核对正文使用的是选中的新闻。
async function readBrief(page) {
  await page.locator('#transcript .msg.agent .body').filter({ hasText: '新闻简报已写入工作区。' }).waitFor();
  assert(await page.evaluate(file => window.__jarvis.workspace.exists(file), briefFile));
  const bytes = await page.evaluate(async file => {
    const blob = await window.__jarvis.workspace.readBlob(file);
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, briefFile);
  const zip = await JSZip.loadAsync(Uint8Array.from(bytes));
  return zip.file('word/document.xml').async('string');
}

async function checkLayout(room) {
  const layout = await room.evaluate(async el => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const box = selector => el.querySelector(selector).getBoundingClientRect();
    const scene = box('.ws-scene'), panel = box('.ws-media-panel:not([hidden])');
    const input = document.getElementById('prompt').getBoundingClientRect();
    const at = document.elementFromPoint(input.x + input.width / 2, input.y + input.height / 2);
    const stage = el.querySelector('.ws-scene');
    const overlay = el.querySelector('.ws-media-panel:not([hidden])');
    return {
      inside: stage.contains(overlay) && panel.left >= scene.left - 2 && panel.right <= scene.right + 2 &&
        panel.top >= scene.top - 2 && panel.bottom <= scene.bottom + 2,
      officeVisible: scene.height >= 40 && scene.width >= 45 && scene.top >= 0 && scene.bottom <= visualViewport.height + 1,
      panelVisible: panel.height >= 45 && panel.width >= 160,
      canType: !!at?.closest('#inputbar') && input.bottom <= visualViewport.height + 1,
      boxes: [scene.toJSON(), panel.toJSON(), input.toJSON()]
    };
  });
  assert(layout.inside && layout.officeVisible && layout.panelVisible && layout.canType,
    '电视和新闻须嵌在可见的办公室画面里，输入框应可点击 ' + JSON.stringify(layout));
}

function modelResponse(request, calls) {
  const lastIndex = request.messages.findLastIndex(row => row.role === 'user');
  const question = request.messages[lastIndex]?.content;
  calls.push(question);
  const wantsFile = /Word|docx/i.test(question);
  if (wantsFile && !request.messages.slice(lastIndex + 1).some(m => m.role === 'tool')) {
    const item = items.find(row => question.includes(row.url));
    assert(item, '实际模型须收到简报原文链接');
    const args = { format: 'docx', path: briefFile, content: `# 工作台新闻简报\n\n## 新闻摘要\n\n${item.title}。\n\n## 来源\n\n${item.source} ${item.url}`, requirements: '根据选中的新闻整理成一份 Word 简报' };
    return { delta: { tool_calls: [{ index: 0, type: 'function', id: 'workshop-news-doc', function: { name: 'create_document', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' };
  }
  return { delta: { content: wantsFile ? '新闻简报已写入工作区。' : '收到，开始讨论你选择的报道。' }, finish_reason: 'stop' };
}

async function check(mobile) {
  const platform = mobile ? 'mobile' : 'pc';
  const staticDir = process.env[mobile ? 'WORKSHOP_MOBILE_DIST' : 'WORKSHOP_PC_DIST'] || (mobile ? 'dist-mobile' : 'dist');
  const server = createServer({ staticDir: path.resolve(staticDir), ollama: null });
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
  const calls = [], errors = [], externals = [];
  const firstQuestion = Promise.withResolvers();
  const firstAnswer = Promise.withResolvers();
  let feedCount = 0;
  await context.route('https://**/*', route => {
    externals.push(route.request().url());
    return route.abort();
  });
  await context.route('**/api/workshop/news', route => {
    feedCount++;
    return route.fulfill({ json: { items, updatedAt: now, stale: false } });
  });
  const articleText = '记者在现场看到，第一批夜读读者已入馆借阅。';
  let failArticle = true;
  await context.route('**/api/workshop/news/article?*', route => {
    const url = new URL(route.request().url()).searchParams.get('url');
    assert(items.some(item => item.url === url));
    if (url === items[1].url && failArticle) {
      failArticle = false;
      return route.fulfill({ status: 503, json: { error: '测试来源暂时不可用' } });
    }
    return route.fulfill({ json: { url, paragraphs: [url === items[0].url ? articleText : '讲座将面向社区居民开放。'], truncated: false } });
  });
  await context.route('**/cmsdatainterface/page/news_1.jsonp', route => {
    feedCount++;
    const list = items.map(({ title, url, publishedAt }) => ({ title, url, focus_date: new Date(Date.parse(publishedAt) + 28800000).toISOString().slice(0, 19).replace('T', ' ') }));
    return route.fulfill({ contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: `news(${JSON.stringify({ data: { list } })})` });
  });
  await context.route('**/chat/completions', async route => {
    const choice = modelResponse(route.request().postDataJSON(), calls);
    if (calls.length === 1) {
      firstQuestion.resolve();
      await firstAnswer.promise;
    }
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n` });
  });
  await context.addInitScript(base => {
    localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', autoMemory: false, speechOutput: false, teamMode: 'off' }));
    localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'custom', models: { custom: 'workshop-test' }, keys: { custom: 'fixture' }, baseURLs: { custom: base + '/v1' }, hedgeBackup: false, routing: { enabled: false } }));
  }, base);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis?.send);
    const room = await openRoom(page, mobile);
    const device = type => room.locator(`[data-media-device="${type}"]`);
    const panel = type => room.locator(`.ws-media-panel[data-device="${type}"]`);
    const tv = panel('tv'), monitor = panel('monitor');
    const button = (parent, name) => parent.getByRole('button', { name, exact: true });
    const link = (parent, name) => parent.getByRole('link', { name, exact: true });
    await device('tv').click();
    await button(tv, 'CCTV-2 财经').click();
    assert.equal(await link(tv, '去央视网观看').getAttribute('href'), 'https://tv.cctv.com/live/cctv2/');
    await checkLayout(room);
    const lamp = button(room, '控制桌上的台灯');
    const lampState = await lamp.getAttribute('aria-pressed');
    await lamp.click();
    assert.notEqual(await lamp.getAttribute('aria-pressed'), lampState, '电视旁可操作真实房间热区');
    await page.screenshot({ path: path.join(output, `${platform}-tv.png`) });
    await button(tv, '返回房间').click();
    await device('tv').click();
    assert.equal(await link(tv, '去央视网观看').getAttribute('href'), 'https://tv.cctv.com/live/cctv2/');
    await button(tv, '返回房间').click();
    assert.ok(!externals.some(u => new URL(u).hostname === 'tv.cctv.com'), '用户选择官方入口前不播放');

    await device('monitor').click();
    await monitor.getByText(items[0].title, { exact: true }).waitFor();
    assert(feedCount > 0, '真实取闻入口发起请求');
    assert.equal(await link(monitor, '阅读原文').getAttribute('href'), items[0].url);
    const initialUrl = page.url();
    await link(monitor, '阅读原文').click();
    await monitor.locator('.ws-article-content').getByText(articleText, { exact: true }).waitFor();
    assert.equal(page.url(), initialUrl, '阅读原文留在工作台');
    assert.equal(context.pages().length, 1, '阅读原文没有打开其他窗口');
    await button(monitor, '下一条').click();
    await monitor.getByText(items[1].title, { exact: true }).waitFor();
    assert.equal(await link(monitor, '阅读原文').getAttribute('href'), items[1].url);
    assert(!await monitor.getByText(articleText, { exact: true }).isVisible(), '翻到另一条新闻后不残留上一篇正文');
    await link(monitor, '阅读原文').click();
    await link(monitor, '重试阅读').click();
    await monitor.getByText('讲座将面向社区居民开放。', { exact: true }).waitFor();
    assert.equal(context.pages().length, 1, '来源出错及重试均留在工作台');
    await link(monitor, '收起原文').click();
    await checkLayout(room);
    await lamp.click();
    assert.equal(await lamp.getAttribute('aria-pressed'), lampState, '读新闻时仍可操作台灯');
    await page.screenshot({ path: path.join(output, `${platform}-news.png`) });
    const composer = page.locator('#prompt');
    if (mobile) {
      await page.setViewportSize({ width: 844, height: 390 });
      assert(await page.locator('#mobile-work-studio').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      await checkLayout(room);
      await page.screenshot({ path: path.join(output, 'mobile-news-landscape.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await composer.focus();
      await page.evaluate(() => {
        Object.defineProperty(visualViewport, 'height', { configurable: true, value: 480 });
        visualViewport.dispatchEvent(new Event('resize'));
      });
      await page.waitForFunction(() => document.body.classList.contains('wy-keyboard-open'));
      await checkLayout(room);
      await page.screenshot({ path: path.join(output, 'mobile-news-keyboard.png'), clip: { x: 0, y: 0, width: 390, height: 480 } });
      await page.evaluate(() => {
        delete visualViewport.height;
        visualViewport.dispatchEvent(new Event('resize'));
        document.activeElement.blur();
      });
    }
    await button(monitor, '问未央').click();
    assert.equal(await composer.evaluate(el => el === document.activeElement), true);
    await composer.fill('这条新闻对我有什么影响？');
    await page.locator('#btn-send').click();
    await Promise.race([firstQuestion.promise, page.waitForFunction(() => document.querySelector('.msg.agent .body')?.textContent.includes('出错了'))]);
    assert(calls.some(content => content.includes(items[1].title) && content.includes(items[1].url)));
    assert(!calls.some(content => content.includes(items[0].url)));
    // 回答期间显示工位进度；仍可自己切回新闻，把另一篇排队做成文件。
    await button(monitor, '切到新闻').click();
    await button(monitor, '上一条').click();
    assert.equal(await link(monitor, '阅读原文').getAttribute('href'), items[0].url);
    await button(monitor, '生成简报').click();
    const queue = page.getByRole('region', { name: '待发送问题' });
    await queue.locator('li').filter({ hasText: items[0].title }).waitFor();
    assert.equal(calls.length, 1, '当前回答结束前不会启动简报请求');
    await button(monitor, '下一条').click();
    assert.equal(await link(monitor, '阅读原文').getAttribute('href'), items[1].url);
    firstAnswer.resolve();
    await page.locator('#transcript .msg.agent').filter({ hasText: '收到，开始讨论你选择的报道。' }).waitFor();
    const actualWord = await readBrief(page);
    assert(actualWord.includes(items[0].title) && !actualWord.includes(items[1].title), '切换新闻不改写队列中那份简报的原文');
    await page.waitForFunction(() => !document.body.classList.contains('generating'));
    await page.reload();
    await page.waitForFunction(() => window.__jarvis?.send);
    const reopened = await openRoom(page, mobile);
    await reopened.locator('[data-media-device="tv"]').click();
    assert.equal(await link(reopened, '去央视网观看').getAttribute('href'), 'https://tv.cctv.com/live/cctv2/', '重开仍保留上次频道');
    await button(reopened, '返回房间').click();
    if (mobile) {
      await openMobileCloudRoom({ page, staticDir, openRoom, check: room =>
        checkWorkshopTvPlayback({ page, context, room, output, platform }) });
    } else await checkWorkshopTvPlayback({ page, context, room: reopened, output, platform });
    assert.deepEqual(errors, []);
    console.log(`${platform} 工作台已验证电视选台、新闻原文与切换、同一会话追问、真实 Word 读回。`);
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${platform}-failure.png`) }).catch(() => {});
    console.error(platform, errors, (await page.locator('.work-studio:visible').innerText({ timeout: 1000 }).catch(() => '')).slice(-1000));
    console.error((await page.locator('#transcript').innerText({ timeout: 1000 }).catch(() => '')).slice(-1500),
      await page.evaluate(() => window.__jarvis?.workspace.list()).catch(() => []));
    throw error;
  } finally { firstAnswer.resolve(); await context.close(); }
}

try {
  const failures = [];
  for (const mobile of [false, true]) {
    try { await check(mobile); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, '工作台跨端验收未通过');
} finally {
  await browser.close();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
