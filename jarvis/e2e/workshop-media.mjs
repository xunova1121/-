/** 正式 PC/手机界面；替换外部新闻和模型响应，实际操作当前会话和工作区。 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { openTaskFloor } from './workshop-test-view.mjs';
import { checkNewsEntrance } from './workshop-news-zoom.mjs';
import JSZip from 'jszip';
import { createServer } from '../server/server.mjs';
import { checkWorkshopTvPlayback, checkTvActor, openMobileCloudRoom } from './workshop-tv-playback.mjs';
import { checkWorkshopLighting } from './workshop-lighting.mjs';
import { checkNewsDeliveryInNest } from './workshop-nest-delivery.mjs';
import { checkWorkshopSourceManagement } from './workshop-source-management.mjs';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-workshop-media');
const briefFile = '工作台新闻简报.docx';
const now = Date.now();
const items = ['城市图书馆开放夜间借阅，首批社区阅览室同步延长开放时间', '社区科学讲堂公布新一期安排'].map((title, i) => ({
  title, source: '央视网', publishedAt: new Date(now - (i + 1) * 60000).toISOString(),
  url: `https://news.cctv.com/2026/11/20/ARTIworkshop${i + 1}.shtml`
}));
const servers = [];
// CI 默认用 Playwright Chromium；支持 AVC 的系统浏览器还可覆盖原生 HLS/TS。
const browser = await chromium.launch({ executablePath: process.env.WORKSHOP_CHROMIUM_EXECUTABLE });
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
  await openTaskFloor(room);
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

// 核对真正露出的文字行和最后一个字。只检查容器的 scrollHeight 会漏掉被工具栏盖住的正文。
async function checkReadingSpace(monitor, minimumLines) {
  const port = monitor.locator('.ws-media-scroll');
  const story = monitor.locator('.ws-article-content');
  await port.evaluate(el => { el.scrollTop = 0; });
  const layout = await story.evaluate(el => {
    const viewport = el.closest('.ws-media-scroll').getBoundingClientRect();
    const title = el.closest('.ws-media-news').querySelector('.ws-media-title');
    const titleRange = document.createRange();
    titleRange.selectNodeContents(title);
    const titleEnd = [...titleRange.getClientRects()].at(-1);
    let lines = 0;
    for (const paragraph of el.querySelectorAll('p')) {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      for (const line of range.getClientRects()) {
        if (line.top >= viewport.top && line.bottom <= viewport.bottom &&
            paragraph.contains(document.elementFromPoint(line.x + 1, line.y + line.height / 2))) lines++;
      }
    }
    return {
      lines,
      overflows: el.scrollWidth > el.clientWidth + 1,
      titleVisible: titleEnd.top >= viewport.top - 1 && titleEnd.bottom <= viewport.bottom + 1 &&
        title.contains(document.elementFromPoint(titleEnd.x + 1, titleEnd.y + titleEnd.height / 2))
    };
  });
  assert(layout.titleVisible && !layout.overflows && layout.lines >= minimumLines,
    '打开报道后应能看全标题并立即阅读多行正文 ' + JSON.stringify(layout));
  const last = story.locator('p').last();
  await last.scrollIntoViewIfNeeded();
  const endVisible = await last.evaluate(el => {
    const lastWord = document.createRange();
    lastWord.setStart(el.lastChild, el.lastChild.length - 1);
    lastWord.setEndAfter(el.lastChild);
    const end = lastWord.getClientRects()[0];
    const scroll = el.closest('.ws-media-scroll');
    return scroll.scrollTop > 0 && ['auto', 'scroll'].includes(getComputedStyle(scroll).overflowY) &&
      el.contains(document.elementFromPoint(end.x + end.width / 2, end.y + end.height / 2));
  });
  assert(endVisible, '可滚到长篇报道末段且最后一个字无遮挡');
  await port.evaluate(el => { el.scrollTop = 0; });
  return layout.lines;
}

function modelResponse(request, calls) {
  const marker = '\n\n〔工作台新闻〕\n';
  const lastIndex = request.messages.findLastIndex(row => row.role === 'user' && row.content?.includes(marker));
  assert(lastIndex >= 0, '实际模型须收到带新闻引用的用户请求');
  const question = request.messages[lastIndex].content;
  calls.push(question);
  const [instruction, reference] = question.split(marker, 2);
  const wantsFile = instruction.includes('核实后生成一份可下载的 Word 简报（.docx）');
  if (wantsFile && !request.messages.slice(lastIndex + 1).some(m => m.role === 'tool')) {
    const url = /^原文：(https?:\/\/\S+)$/mu.exec(reference)?.[1];
    const item = items.find(row => row.url === url);
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
  let feedCount = 0, articleRequests = 0;
  await context.route('https://**/*', route => {
    externals.push(route.request().url());
    return route.abort();
  });
  // 桌面搜索通过同源网关发出。使用带 keyword 参数的实际 RSS 格式，
  // 确认搜索证据里的英文子串不会把单纯的新闻追问变成文档请求。
  if (!mobile) await context.route('**/api/fetch?*', route => {
    const target = new URL(new URL(route.request().url()).searchParams.get('url') || '/', base);
    const query = target.searchParams.get('q') || target.searchParams.get('wd') || '';
    if (!query.includes(items[1].title)) return route.fallback();
    if (target.pathname === '/search' && /^(?:cn|www)\.bing\.com$/.test(target.hostname) && target.searchParams.get('format') === 'rss') {
      const rows = ['报名', '时间', '地点', '交通'].map((topic, i) => `<item><title>${items[1].title}：${topic}</title><link>https://news.cctv.com/science/${i}?keyword=lecture</link><description>社区科学讲堂活动信息和报名说明。</description></item>`);
      return route.fulfill({ contentType: 'application/rss+xml', body: `<rss version="2.0"><channel>${rows.join('')}</channel></rss>` });
    }
    if (target.hostname === 'www.baidu.com' && target.pathname === '/s') return route.fulfill({ contentType: 'text/html', body: '<html></html>' });
    return route.fallback();
  });
  await context.route('**/api/workshop/news', route => {
    feedCount++;
    return route.fulfill({ json: { items, updatedAt: now, stale: false } });
  });
  const articleText = '记者在现场看到，第一批夜读读者已入馆借阅。';
  const article = [articleText,
    '阅览室新增了面向街道一侧的夜间入口。读者可以在这里领取借阅指引，也可以咨询续借、预约还书和跨馆取书的办理方式。',
    '靠窗的座位留给安静阅读的市民，活动区安排在另一侧。工作人员介绍，这一调整来自此前试开放期间收集到的读者建议。',
    '几位下班后来借书的读者说，过去总要赶在闭馆前到达，现在有充裕的时间挑选图书，还能坐下来读完一章再回家。',
    '社区志愿者将在晚间协助引导读者。馆方把无障碍通道、卫生间和自助借还设备的位置标在入口地图上，首次到访也能找到。',
    ...['江北', '城西', '东湖', '南河', '林荫路', '大学城'].map(name =>
      name + '阅览室将定期邀请读者分享夜读体验。本周的讨论围绕预约流程、自助设备与返程交通，读者可在馆内填写意见。'),
    '试运行结束后，各社区阅览室将根据借阅情况分别调整晚间服务。最新安排会同时公布在馆内告示栏和图书馆网站。'];
  let failArticle = true;
  await context.route('**/api/workshop/news/article?*', route => {
    articleRequests++;
    const url = new URL(route.request().url()).searchParams.get('url');
    assert(items.some(item => item.url === url));
    if (url === items[1].url && failArticle) {
      failArticle = false;
      return route.fulfill({ status: 503, json: { error: '测试来源暂时不可用' } });
    }
    return route.fulfill({ json: { url, paragraphs: url === items[0].url ? article : ['讲座将面向社区居民开放。'], truncated: false } });
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
    if (!mobile) await page.waitForFunction(() => window.__jarvis.gateway?.origin === location.origin);
    const room = await openRoom(page, mobile);
    const device = type => room.locator(`[data-media-device="${type}"]`);
    const panel = type => room.locator(`.ws-media-panel[data-device="${type}"]`);
    const tv = panel('tv'), monitor = panel('monitor');
    const button = (parent, name) => parent.getByRole('button', { name, exact: true });
    const link = (parent, name) => parent.getByRole('link', { name, exact: true });
    await device('tv').click();
    assert.equal(await tv.locator('[data-channel="retrostrange-tv"]').getAttribute('aria-pressed'), 'true',
      '新安装应默认选中已提供节目的电影频道');
    const demo = tv.locator('[data-channel="ireplay-blender"]');
    await demo.click();
    assert.equal(await demo.getAttribute('aria-pressed'), 'true', '遥控器也可切换到公开演示频道');
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

    await checkNewsEntrance({ page, room, platform, output });
    // 近看家具的焦点和键盘会尝试滚动祖先；实际阅读时只允许正文区滚动。
    const stage = room.locator('.ws-scene');
    const offsets = await stage.evaluate(scene => {
      scene.scrollTo(scene.scrollWidth, scene.scrollHeight);
      return [scene.scrollLeft, scene.scrollTop, getComputedStyle(scene).overflow];
    });
    assert.deepEqual(offsets, [0, 0, 'clip'], '桌面与手机的共同阅读视口不会被家具焦点推离原位');
    await checkLayout(room);
    await monitor.getByText(items[0].title, { exact: true }).waitFor();
    const digest = monitor.getByRole('navigation', { name: '本期其他报道' });
    await button(digest, items[1].title).click();
    assert.equal(await monitor.locator('.ws-media-title:visible').innerText(), items[1].title);
    assert.equal(await link(monitor, '阅读原文').getAttribute('href'), items[1].url);
    await button(digest, items[0].title).click();
    assert.equal(articleRequests, 0, '点选已载入简报中的标题无需请求正文');
    assert(feedCount > 0, '真实取闻入口发起请求');
    assert.equal(await link(monitor, '阅读原文').getAttribute('href'), items[0].url);
    const initialUrl = page.url();
    await link(monitor, '阅读原文').click();
    await monitor.locator('.ws-article-content').getByText(articleText, { exact: true }).waitFor();
    assert(!await digest.isVisible(), '正文阅读空间留给当前报道');
    assert.equal(page.url(), initialUrl, '阅读原文留在工作台');
    assert.equal(context.pages().length, 1, '阅读原文没有打开其他窗口');
    const lines = await checkReadingSpace(monitor, mobile ? 5 : 7);
    await checkLayout(room);
    await page.screenshot({ path: path.join(output, platform + '-article.png') });
    console.log(platform + ' 新闻首屏正文可读 ' + lines + ' 行，长文末字可见');
    if (mobile) {
      await page.setViewportSize({ width: 360, height: 640 });
      await checkLayout(room);
      const shortLines = await checkReadingSpace(monitor, 3);
      console.log('360 × 640 新闻首屏正文可读 ' + shortLines + ' 行，长文末字可见');
      await page.screenshot({ path: path.join(output, 'mobile-compact-article.png') });
      await page.setViewportSize({ width: 390, height: 844 });
    }
    const readingPort = monitor.locator('.ws-media-scroll');
    const savedTop = await readingPort.evaluate(port => (port.scrollTop = 90, port.scrollTop));
    assert(savedTop > 0, '长文有可保存的阅读位置');
    await button(monitor, '返回房间').click();
    await monitor.waitFor({ state: 'hidden' });
    await device('monitor').click();
    await monitor.locator('.ws-article-content').getByText(articleText, { exact: true }).waitFor();
    await page.waitForFunction(top => [...document.querySelectorAll('.ws-media-scroll')]
      .some(port => port.clientHeight && Math.abs(port.scrollTop - top) <= 1), savedTop);
    assert.equal(await link(monitor, '收起原文').getAttribute('href'), items[0].url);
    const readCount = articleRequests;
    await button(monitor, '下一条').click();
    await monitor.getByText(items[1].title, { exact: true }).waitFor();
    await button(monitor, '上一条').click();
    await monitor.locator('.ws-article-content').getByText(articleText, { exact: true }).waitFor();
    await page.waitForFunction(top => [...document.querySelectorAll('.ws-media-scroll')]
      .some(port => port.clientHeight && Math.abs(port.scrollTop - top) <= 1), savedTop);
    assert.equal(articleRequests, readCount, '返回读过的报道无需重新抓取');
    await link(monitor, '收起原文').click();
    await button(monitor, '下一条').click();
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
        // Android 的方向通知可能晚于聚焦和键盘 resize，不应把 480 当成竖屏的完整高度。
        window.dispatchEvent(new Event('orientationchange'));
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
    if (!mobile) assert(calls[0].includes('?keyword=lecture'), '桌面首轮应把搜索网关的固定资料交给模型');
    // 真实回答尚在进行时，打开电视仍可见当下工作的精灵。
    await button(monitor, '返回房间').click();
    await device('tv').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('.work-studio:where([data-visible="true"]) .ws-tv-standby video');
      return el && !el.paused && el.videoWidth > 0 && el.currentTime > 0;
    }, null, { timeout: 12000 });
    await checkTvActor(room, { working: true });
    await checkLayout(room);
    await page.screenshot({ path: path.join(output, platform + '-tv-working.png') });
    await button(tv, '返回房间').click();
    await device('monitor').click();
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
    const discussion = page.locator('#transcript .msg.agent').first();
    await discussion.filter({ hasText: '收到，开始讨论你选择的报道。' }).waitFor();
    assert(!(await discussion.innerText()).includes(briefFile), '普通新闻追问不应生成 Word');
    const actualWord = await readBrief(page);
    assert(actualWord.includes(items[0].title) && !actualWord.includes(items[1].title), '切换新闻不改写队列中那份简报的原文');
    await page.waitForFunction(() => !document.body.classList.contains('generating'));
    await checkWorkshopLighting(page, room, platform, output);
    await checkNewsDeliveryInNest(page, room, briefFile, items[0].title);
    await page.reload();
    await page.waitForFunction(() => window.__jarvis?.send);
    const reopened = await openRoom(page, mobile);
    await reopened.locator('[data-media-device="tv"]').click();
    assert.equal(await link(reopened, '去央视网观看').getAttribute('href'), 'https://tv.cctv.com/live/cctv2/', '重开仍保留上次频道');
    await button(reopened, '返回房间').click();
    const checkTv = async room => {
      const setup = { page, context, room, output, platform };
      await checkWorkshopTvPlayback(setup);
      await checkWorkshopSourceManagement(setup);
    };
    if (mobile) await openMobileCloudRoom({ page, staticDir, openRoom, check: checkTv });
    else await checkTv(reopened);
    assert.deepEqual(errors, []);
    console.log(`${platform} 工作台已验证电视选台、新闻原文与切换、同一会话追问、真实 Word 读回。`);
  } catch (error) {
    await page.screenshot({ path: path.join(output, `${platform}-failure.png`) }).catch(() => {});
    console.error(platform, error.message);
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
