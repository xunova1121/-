/** 正式手机/PC构建与真实云任务接口：默认排队、菜单引导、附件和晚到请求隔离。模型为夹具。 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { createServerClient } from '../src/core/serverClient.js';
import { useBackend } from '../src/agent/store.js';

const out = path.resolve(process.argv[2] || '/tmp/weiyang-conversation-guide');
await mkdir(out, { recursive: true });
const dir = await mkdtemp(path.join(os.tmpdir(), 'conversation-guide-'));
const modelCalls = [], httpCalls = [], results = [];
let holdNext = false, release = null;
const mode = createServerMode({ dataDir: dir, password: 'guide-fixture-password', makeTaskAdapter: () => ({ model: 'fixture', adapter: {
  async stream(input) {
    modelCalls.push(structuredClone(input.messages));
    let text = '计划已按收到的要求整理。';
    if (holdNext) {
      holdNext = false; input.onText?.('正在整理原计划。');
      await new Promise(resolve => { release = resolve; input.signal?.addEventListener('abort', resolve, { once: true }); });
      text = '正在整理原计划。' + text;
    }
    input.onText?.('计划已按收到的要求整理。');
    return { text, toolCalls: [], stop: 'end_turn' };
  }
} }) });
await mode.ready;
const server = createServer({ serverMode: mode, ollama: null });
const mobile = createServer({ staticDir: path.resolve('dist-mobile'), ollama: null });
const desktop = createServer({ staticDir: path.resolve(process.env.WORKSHOP_PC_DIST || 'dist'), ollama: null });
const servers = [server, mobile, desktop];
for (const app of servers) await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
server.on('request', req => httpCalls.push({ method: req.method, path: new URL(req.url, base).pathname }));
const owner = createServerClient({ base, token: tokenFor('guide-fixture-password') });
await owner.putConfig({ provider: 'custom', models: { custom: 'fixture' }, keys: { custom: 'fixture-only' }, baseURLs: { custom: 'https://fixture.invalid/v1' }, routing: { enabled: false }, hedgeBackup: false });
let browser;
const check = (name, ok) => { results.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}`); assert.ok(ok, name); };
try {
  browser = await chromium.launch();
  for (const [width, app, inRoom] of [[390, mobile], [1280, desktop], [320, mobile], [1366, desktop, true]]) {
    const user = await owner.createUser('引导验收' + width), login = await owner.loginAccount(user.accessCode);
    const client = createServerClient({ base, token: login.token });
    const context = await browser.newContext({ viewport: { width, height: inRoom ? 720 : 844 }, isMobile: width < 800, hasTouch: width < 800 });
    await context.addInitScript(({ base, token, userId, width }) => {
      localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token, userId, role: 'member', enabled: true }));
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: width === 320 ? 'night' : 'day', speechOutput: false, autoMemory: false, teamMode: 'off' }));
    }, { base, token: login.token, userId: user.id, width });
    const page = await context.newPage(), errors = [];
    const network = await context.newCDPSession(page); await network.send('Network.enable'); await network.send('Network.setBlockedURLs', { urls: ['https://*'] });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + app.address().port);
    await page.waitForFunction(() => window.__jarvisServerClient && window.__jarvis?.send);
    await page.evaluate(() => document.querySelector('#app-splash')?.remove());
    if (inRoom) {
      await page.locator('.wb-tabs').getByRole('button', { name:'工作台', exact:true }).click();
      await page.locator('.wb-desk[data-desk-chat=preview]').waitFor();
      const visible = await page.locator('#prompt').evaluate(input => {
        const box = input.getBoundingClientRect();
        return box.bottom <= innerHeight && document.elementFromPoint(box.x + 10, box.y + 10) === input;
      });
      check('720px 高的电脑窗口在工作台首屏可以直接点击输入框', visible);
      const field = page.locator('#prompt');
      await field.fill('第一行');
      const single = await field.boundingBox();
      await field.fill('第一行\n第二行\n第三行');
      const multi = await field.boundingBox();
      await field.fill('');
      const reset = await field.boundingBox();
      check('输入多行时自动增高，清空后恢复初始高度', multi.height > single.height && Math.abs(reset.height - single.height) < 1);
      const cat = page.locator('.wb-desk [data-furniture="cat"]');
      check('矮窗口保留地毯上的猫和交互位置', await cat.evaluate(el => {
        const b = el.getBoundingClientRect();
        return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('[data-furniture="cat"]') === el;
      }));
    }
    const submit = async text => { await page.fill('#prompt', text); await page.click('#btn-send'); };
    holdNext = true;
    const start = httpCalls.length, callsStart = modelCalls.length;
    await submit('请介绍甲方案的优缺点');
    await page.waitForFunction(() => document.querySelector('.msg.agent.streaming .body')?.textContent.includes('正在整理原计划'));
    if (inRoom) {
      const bothLines = await page.locator('#transcript').evaluate(el => {
        const area = el.getBoundingClientRect();
        return ['user', 'agent'].every(role => {
          const msg = el.querySelector('.msg.' + role + ' > .body')?.getBoundingClientRect();
          return msg && msg.top >= area.top - 1 && msg.bottom <= area.bottom + 1;
        });
      });
      check('短提问和流式回复可同时读到', bothLines);
      const original = await page.locator('.wb-desk .ws-floorplan').boundingBox();
      await page.getByRole('button', { name:'隐藏消息' }).click();
      check('收起房间消息时仍可输入', !await page.locator('#transcript').isVisible() && await page.locator('#prompt').isVisible());
      await page.getByRole('button', { name:'显示消息' }).click();
      await page.locator('#transcript .msg.agent .body').filter({hasText:'正在整理原计划'}).click();
      check('点击回复正文时仍为短气泡', await page.locator('.wb-desk').getAttribute('data-desk-chat') === 'preview');
      await page.getByRole('button', { name:'聊天记录', exact:true }).click();
      const rect = await page.locator('#transcript').boundingBox();
      check('小窝回复可展开阅读（实测 ' + Math.round(rect.height) + 'px）', rect.height >= 200);
      const final = await page.locator('.wb-desk .ws-floorplan').boundingBox();
      check('阅读时房间与沙发位置保持一致 ' + JSON.stringify([original, final]), Object.keys(original).every(key => Math.abs(original[key] - final[key]) < 1));
      await page.getByRole('button', { name:'收起记录' }).click();
    }
    const queue = page.getByRole('region', { name: '待发送问题' });
    check(`${width} 发送前没有模式按钮`, await page.locator('.composer-send-modes').count() === 0);
    await submit('原计划补充：保留三个重点');
    await submit('这条应该取消');
    check(`${width} 默认排队，当前请求和对话不提前收到新问题`, await queue.locator('li').count() === 2 && modelCalls.length === callsStart + 1 && !JSON.stringify(modelCalls[callsStart]).includes('保留三个重点') && !(await page.locator('#transcript').textContent()).includes('保留三个重点'));
    const menu = page.getByRole('menu', { name: '待发消息操作', exact: true });
    await queue.locator('li').last().getByRole('button', { name: '待发消息操作', exact: true }).click();
    check(`${width} 菜单提供编辑/引导/取消`, (await menu.getByRole('menuitem').allTextContents()).join('|') === '编辑消息|改为引导|取消消息');
    const menuRect = await menu.boundingBox(), formRect = await page.locator('#inputbar').boundingBox(), queueRect = await queue.boundingBox();
    check(`${width} 待发列表在输入框上方，菜单完整可见`, queueRect.y + queueRect.height <= formRect.y + 1 && menuRect.x >= 0 && menuRect.y >= 0 && menuRect.x + menuRect.width <= width && menuRect.y + menuRect.height <= page.viewportSize().height);
    check(`${width} 菜单触控至少44px`, await menu.getByRole('menuitem').evaluateAll(items => items.every(item => item.getBoundingClientRect().height >= 44)));
    await page.screenshot({ path: `${out}/menu-${width}.png` });
    await page.keyboard.press('Escape');
    check(`${width} Escape关闭菜单并回到消息操作按钮`, !(await menu.isVisible()) && await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '待发消息操作'));
    await queue.locator('li').last().getByRole('button', { name: '待发消息操作', exact: true }).click();
    await menu.getByRole('menuitem', { name: '取消消息', exact: true }).click();
    check(`${width} 取消只移除目标消息`, await queue.locator('li').count() === 1);
    await queue.locator('li').getByRole('button', { name: '待发消息操作', exact: true }).click();
    await menu.getByRole('menuitem', { name: '编辑消息', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#prompt').value === '原计划补充：保留三个重点');
    await submit('原计划补充：保留四个重点');
    await page.setInputFiles('#file-input', { name: '引导材料.txt', mimeType: 'text/plain', buffer: Buffer.from('只给当前任务的附件') });
    await page.waitForFunction(() => document.querySelector('#attach-list').textContent.includes('引导材料.txt'));
    await submit('请结合这份附件');
    await page.fill('#prompt', '尚未发送的草稿');
    await page.setInputFiles('#file-input', { name: '草稿材料.txt', mimeType: 'text/plain', buffer: Buffer.from('不能混进引导的草稿附件') });
    await page.waitForFunction(() => document.querySelector('#attach-list').textContent.includes('草稿材料.txt'));
    for (let n = 0; n < 2; n++) {
      await queue.locator('li').first().getByRole('button', { name: '待发消息操作', exact: true }).click();
      await menu.getByRole('menuitem', { name: '改为引导', exact: true }).click();
      await page.waitForFunction(count => document.querySelectorAll('.composer-message-queue li').length === count, 1 - n);
    }
    check(`${width} 两条引导写回同一原任务，不创建新任务`, httpCalls.slice(start).filter(row => row.method === 'POST' && row.path === '/api/tasks').length === 1 && httpCalls.slice(start).filter(row => row.method === 'POST' && row.path.endsWith('/notes')).length === 2);
    check(`${width} 引导后草稿及其附件仍在输入框`, await page.locator('#prompt').inputValue() === '尚未发送的草稿' && (await page.locator('#attach-list').textContent()).includes('草稿材料.txt'));
    check(`${width} 仅引导材料上传到本人服务器`, await (await client.download('上传/引导材料.txt')).text() === '只给当前任务的附件' && !(await client.listFiles()).some(row => row.path === '上传/草稿材料.txt'));
    release(); release = null;
    await page.waitForFunction(() => !document.querySelector('.msg.agent.streaming'), null, { timeout: 20000 });
    const sent = JSON.stringify(modelCalls.slice(callsStart));
    check(`${width} 当前模型实际收到修改后要求和附件，不收到取消项和草稿`, sent.includes('保留四个重点') && sent.includes('引导材料.txt') && !sent.includes('保留三个重点') && !sent.includes('这条应该取消') && !sent.includes('草稿材料.txt') && !sent.includes('尚未发送的草稿'));
    await page.screenshot({ path: `${out}/guided-${width}.png` });
    await page.fill('#prompt', ''); await page.locator('#attach-list > span > button').click();
    holdNext = true;
    await submit('请介绍乙方案的优缺点');
    await page.waitForFunction(() => document.querySelector('.msg.agent.streaming .body')?.textContent.includes('正在整理原计划'));
    await submit('失败时仍保留这条要求');
    let delayedNote = null;
    await context.route(base + '/api/tasks/*/notes', route => { delayedNote = route; });
    const failedStart = httpCalls.length;
    await queue.locator('li').getByRole('button', { name: '待发消息操作', exact: true }).click();
    await menu.getByRole('menuitem', { name: '改为引导', exact: true }).click();
    for (let attempt = 0; !delayedNote && attempt < 150; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(delayedNote, '实际引导请求未发出');
    const stopped = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/stop') && response.status() === 200);
    await page.click('#btn-stop'); await stopped;
    release?.(); release = null;
    const rejected = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/notes') && response.status() === 409);
    await delayedNote.continue(); await rejected;
    await page.waitForFunction(() => document.querySelector('.composer-message-queue')?.textContent.includes('已暂停'));
    check(`${width} 停止后晚到引导由服务器真实409拒绝，消息保留暂停且不转新任务`, await queue.locator('li').count() === 1 && !httpCalls.slice(failedStart).some(row => row.method === 'POST' && row.path === '/api/tasks'));
    await context.unroute(base + '/api/tasks/*/notes');
    await page.waitForFunction(() => !document.querySelector('.msg.agent.streaming'));
    await queue.locator('li').getByRole('button', { name: '待发消息操作', exact: true }).click();
    check(`${width} 原任务停止后不提供改为引导`, await menu.getByRole('menuitem', { name: '改为引导', exact: true }).count() === 0);
    await menu.getByRole('menuitem', { name: '取消消息', exact: true }).click();
    check(`${width} 无页面异常和横向溢出`, errors.length === 0 && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await context.close(); await mode.runner.settled();
  }
} finally {
  release?.(); await browser?.close(); await mode.tenders.stop(); await mode.runner.settled();
  for (const app of servers) { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
  useBackend(null); await rm(dir, { recursive: true, force: true });
  await writeFile(out + '/results.json', JSON.stringify(results, null, 2));
}
console.log(`真实云端消息排队与引导 ${results.length}/${results.length} 通过；无付费模型和真机验收。`);
