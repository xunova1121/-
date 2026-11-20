/** 正式 PC/手机网页、真实工作区和云端 SSE；只替换模型，不访问付费服务。 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { createServerClient } from '../src/core/serverClient.js';
import { useBackend } from '../src/agent/store.js';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-workbench-action-studio');
await mkdir(output, { recursive: true });
const dir = await mkdtemp(path.join(os.tmpdir(), 'work-studio-'));
const localFile = '方案/春季活动.md', cloudFile = '资料/云端简报.md';
const privateText = 'STUDIO_FIXTURE_FILE_BODY_PRIVATE';
const write = file => ({ id: 'write-design', name: 'write_file', args: { path: file, content: privateText } });
let continueCloud;
const cloudGate = new Promise(resolve => { continueCloud = resolve; });
let cloudRounds = 0, eventsResponse;
const requests = [];
const mode = createServerMode({
  dataDir: dir, password: 'studio-fixture',
  makeTaskAdapter: () => ({ model: 'studio-fixture', adapter: { async stream(input) {
    if (cloudRounds++ === 0) return { text: '', toolCalls: [write(cloudFile)], stop: 'tool_use' };
    input.onText?.('已保存云端简报。');
    await cloudGate;
    return { text: '已保存云端简报。', toolCalls: [], stop: 'end_turn' };
  } } })
});
await mode.ready;
const desktop = createServer({ staticDir: path.resolve('dist'), ollama: null });
const mobile = createServer({ staticDir: path.resolve('dist-mobile'), ollama: null });
const cloud = createServer({ serverMode: mode, ollama: null });
for (const server of [desktop, mobile, cloud]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = server => 'http://127.0.0.1:' + server.address().port;
cloud.on('request', (req, res) => {
  const parsed = new URL(req.url, url(cloud));
  requests.push({ path: parsed.pathname, method: req.method, after: Number(parsed.searchParams.get('after') || 0) });
  if (req.method === 'GET' && parsed.pathname.endsWith('/events')) eventsResponse = res;
});
const config = { provider: 'custom', models: { custom: 'studio-fixture' }, keys: { custom: 'fixture' }, baseURLs: { custom: url(desktop) + '/v1' }, routing: { enabled: false }, hedgeBackup: false };
const errors = [];
const browser = await chromium.launch();
async function open(server, options = {}, serverConfig = null, intercept) {
  const context = await browser.newContext(options);
  await context.route('https://**/*', route => route.abort());
  if (intercept) await context.route('**/chat/completions', intercept);
  await context.addInitScript(({ config, serverConfig }) => {
    localStorage.setItem('jarvis.llm.v1', JSON.stringify(config));
    localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', autoMemory: false, speechOutput: false, teamMode: 'off' }));
    if (serverConfig) localStorage.setItem('jarvis.server.v1', JSON.stringify(serverConfig));
  }, { config, serverConfig });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url(server));
  await page.waitForFunction(() => window.__jarvis?.send);
  return page;
}
const stage = page => page.locator('.work-studio:visible');
async function enter(page) {
  await page.locator('.wb-tabs').getByRole('button', { name: '工作台', exact: true }).click();
  await stage(page).waitFor();
  assert.equal(await page.locator('#stage-wrap').isVisible(), false, '工作台隐藏星系');
  assert.equal(await page.getByRole('button', { name: /经典舞台/ }).count(), 0, '工作台不保留旧舞台按钮');
  for (const selector of ['.work-studio', '#transcript', '#inputbar']) {
    const element = page.locator('.wb-desk').locator(selector);
    assert.ok(await element.isVisible(), selector + ' 在工作台内部可见');
    const rect = await element.boundingBox();
    assert.ok(rect && rect.width > 160 && rect.height >= 36, selector + ' 有可用的工作区域');
  }
  assert.equal(await page.locator('#inputbar').count(), 1, '只有一个输入框');
  assert.equal(await page.locator('#transcript').count(), 1, '只有一份会话');
}
async function send(page, prompt) {
  await page.fill('#prompt', prompt);
  await page.click('#btn-send');
}
const rows = page => stage(page).locator('[data-entry-id]');
// 用角色的实际脚下位置检查工位，不能只改变动作名称。
async function stationPoint(page, station) {
  const scene = stage(page).locator('.ws-scene');
  assert.equal(await scene.getAttribute('data-station'), station);
  return scene.locator('.ws-floorplan').evaluate(floor => {
    const room = floor.getBoundingClientRect();
    const actor = floor.querySelector('.ws-actor').getBoundingClientRect();
    if (actor.width <= 0 || actor.height <= 0 || actor.height > room.height * .32 || actor.width > room.width * .21) {
      throw new Error('角色没有保持车间远景比例：' + JSON.stringify({ actor, room }));
    }
    if (actor.left < room.left - 1 || actor.right > room.right + 1 || actor.top < room.top - 1 || actor.bottom > room.bottom + 1) {
      throw new Error('角色离开了车间画面');
    }
    return { x: (actor.left + actor.width / 2 - room.left) / room.width, y: (actor.bottom - room.top) / room.height };
  });
}

async function observeWalk(page) {
  return stage(page).locator('.ws-actor').evaluate(async actor => {
    const start = performance.now();
    let from;
    // 只计同一段行走里的位移，工位瞬移或原地切换精灵图不能算通过。
    while (performance.now() - start < 9000) {
      await new Promise(requestAnimationFrame);
      if (actor.dataset.walking !== 'true') { from = null; continue; }
      const now = actor.getBoundingClientRect();
      if (from && Math.hypot(now.left - from.left, now.top - from.top) >= 3) return true;
      from ??= now;
    }
    return false;
  });
}
async function checkFit(page) {
  const box = await page.locator('#prompt').boundingBox();
  assert.ok(box && box.height > 0 && box.y >= 0 && box.y + box.height <= page.viewportSize().height + 1, '输入框完整可见');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '无横向溢出');
}
try {
  let modelCalls = 0;
  const local = await open(desktop, { viewport: { width: 1440, height: 900 } }, null, async route => {
    modelCalls++;
    const messages = route.request().postDataJSON().messages;
    const count = messages.filter(m => m.role === 'tool').length;
    const followUp = messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('刚才的文件叫什么'));
    const result = followUp || count >= 3;
    if (!followUp && count === 3) {
      const receipt = messages.filter(m => m.role === 'tool').at(-1);
      assert.match(JSON.stringify(receipt.content), /readback.{0,10}passed/, '核验工具确实读回了活动方案');
    }
    const calls = [
      { id: 'read-design', name: 'read_file', args: { path: localFile } },
      write(localFile),
      { id: 'verify-design', name: 'verify_delivery', args: { paths: [localFile] } }
    ];
    const call = calls[count];
    const notes = Array.from({ length: 18 }, (_, i) => (i + 1) + '. 排期复核与责任人确认');
    const answer = followUp ? '刚才保存的是春季活动.md。\n\n' + notes.join('\n') : '活动方案已保存。';
    const delta = result ? { content: answer } : { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
    const chunk = { choices: [{ delta, finish_reason: result ? 'stop' : 'tool_calls' }] };
    await route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n' });
  });
  assert.ok(await local.evaluate(() => window.__jarvis.stage == null), '普通对话不创建经典 WebGL 场景');
  await enter(local);
  assert.ok(await local.evaluate(() => window.__jarvis.stage == null), '工作台的角色不拉起星系 GPU 场景');
  assert.equal(await rows(local).count(), 0, '空会话只显示待命');
  assert.equal(await stage(local).getAttribute('data-pose'), 'idle');
  await stationPoint(local, 'rest');
  const actor = stage(local).locator('.ws-floorplan .ws-actor');
  assert.notEqual(await actor.getAttribute('data-walking'), 'true', '空会话安静待命');
  await send(local, '请先读取' + localFile + '，文件不存在就写一份活动方案保存到这个位置。');
  await local.locator('#transcript .msg.agent').filter({ hasText: '活动方案已保存。' }).waitFor();
  await stage(local).locator('[data-entry-id][data-pose="cheer"]').waitFor();
  const sessionId = await local.evaluate(() => window.__jarvis.sessionId);
  assert.equal(await local.evaluate(file => window.__jarvis.workspace.readText(file), localFile), privateText);
  assert.equal(modelCalls, 4, '实际读取失败后，写入文件、核验交付并收到最终回复');
  const failure = stage(local).locator('[data-entry-id][data-pose="stomp"]').filter({ hasText: '读取文件' });
  assert.equal(await failure.count(), 1, '读取失败只显示一条真实记录');
  await failure.click();
  assert.equal(await stage(local).getAttribute('data-pose'), 'stomp');
  const archive = await stationPoint(local, 'archive');
  assert.notEqual(await actor.getAttribute('data-walking'), 'true', '手动回看停在读取文件的工位');
  await local.screenshot({ path: path.join(output, 'pc-studio-retry.png') });
  const edits = stage(local).locator('[data-entry-id][data-pose="edit"]').filter({ hasText: '写入文件' });
  assert.equal(await edits.count(), 1, '工具开始和结束合并为一次编辑');
  await edits.click();
  assert.equal(await stage(local).getAttribute('data-mode'), 'review');
  const bench = await stationPoint(local, 'bench');
  assert.ok((await stage(local).innerText()).includes(path.basename(localFile)), '动作显示真实文件名');
  assert.ok(!(await stage(local).innerText()).includes(privateText), '排除文件正文');
  const assetCount = await stage(local).evaluate(async el => {
    const urls = new Set();
    const backgrounds = [getComputedStyle(el.closest('.wb-desk'), '::before')];
    for (const selector of ['.ws-scene', '.ws-floorplan', '.ws-sprite']) backgrounds.push(getComputedStyle(el.querySelector(selector)));
    for (const css of backgrounds) {
      for (const match of css.backgroundImage.matchAll(/url\(["']?(.*?)["']?\)/g)) urls.add(match[1]);
    }
    for (const url of urls) { const img = new Image(); img.src = url; await img.decode(); if (!img.naturalWidth) throw Error('工作台图片解码失败'); }
    return urls.size;
  });
  assert.ok(assetCount >= 2, '正式构建的人物和场景图均可解码');
  await checkFit(local);
  await local.screenshot({ path: path.join(output, 'pc-studio-edit.png') });
  await stage(local).locator('[data-entry-id]').filter({ hasText: '核验交付文件' }).click();
  const review = await stationPoint(local, 'review');
  await stage(local).locator('[data-action="live"]').click();
  assert.equal(await stage(local).getAttribute('data-pose'), 'cheer');
  await stationPoint(local, 'bench'); // 核验后还写了回复，庆祝应在最后一次实际工作的地方。
  for (const [a, b] of [[archive, bench], [archive, review], [bench, review]]) {
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > .08, '读取、修改和复核有不同的实际站位');
  }
  const ids = await rows(local).evaluateAll(list => list.map(el => el.dataset.entryId));
  const [walked] = await Promise.all([observeWalk(local), stage(local).locator('[data-action="play"]').click()]);
  assert.ok(walked, '播放真实任务时，小人跑过车间而不是瞬移');
  await local.emulateMedia({ reducedMotion: 'reduce' });
  await local.waitForFunction(() => {
    const actor = document.querySelector('.wb-desk .ws-floorplan .ws-actor');
    return actor.dataset.walking !== 'true' && !actor.getAnimations({ subtree: true }).some(a => a.playState === 'running');
  });
  await stage(local).locator('[data-action="back"]:enabled').waitFor();
  await stage(local).locator('[data-action="back"]').click();
  await stage(local).locator('[data-action="forward"]').click();
  await stage(local).locator('[data-action="live"]').click();
  assert.deepEqual(await rows(local).evaluateAll(list => list.map(el => el.dataset.entryId)), ids, '回放不重复写入记录');
  await local.emulateMedia({ reducedMotion: 'no-preference' });
  const draft = '这条草稿先保留';
  await local.fill('#prompt', draft);
  await local.locator('.wb-tabs').getByRole('button', { name: '对话', exact: true }).click();
  assert.equal(await stage(local).count(), 0);
  assert.equal(await local.locator('#prompt').inputValue(), draft);
  await enter(local);
  assert.equal(await local.locator('#prompt').inputValue(), draft, '两视图共用同一份草稿');
  assert.equal(await local.locator('.wb-desk #transcript .msg.user').count(), 1);
  assert.equal(await local.locator('.wb-desk #transcript .msg.agent').filter({ hasText: '活动方案已保存。' }).count(), 1, '工作台没有额外复制回复');
  await local.fill('#prompt', '');
  await local.setViewportSize({ width: 1024, height: 600 });
  await checkFit(local);
  await stationPoint(local, 'bench');
  await local.screenshot({ path: path.join(output, 'pc-studio-compact.png') });
  await local.setViewportSize({ width: 768, height: 620 });
  await stationPoint(local, 'bench');
  await checkFit(local);
  await local.setViewportSize({ width: 1024, height: 600 });
  await local.locator('.rail .wb-new').click();
  assert.ok(await local.evaluate(() => window.__jarvis.stage == null), '普通对话不创建经典 WebGL 场景');
  await enter(local);
  assert.ok(await local.evaluate(() => window.__jarvis.stage == null), '工作台的角色不拉起星系 GPU 场景');
  assert.equal(await rows(local).count(), 0, '新会话不带入上次任务');
  await local.evaluate(id => window.__jarvis.openSession(id), sessionId);
  await enter(local);
  assert.equal(await edits.count(), 1, '打开原会话能回看真实操作');
  await local.locator('.wb-tabs').getByRole('button', { name: '对话', exact: true }).click();
  assert.equal(await stage(local).count(), 0);
  await checkFit(local);
  await send(local, '刚才的文件叫什么？');
  await local.locator('#transcript .msg.agent').filter({ hasText: '刚才保存的是春季活动.md。' }).waitFor();
  assert.equal(modelCalls, 5, '切换多个工作视图后同一对话仍可继续发送');
  await enter(local);
  const scrolls = await local.locator('.wb-desk #transcript').evaluate(el => {
    el.scrollTop = el.scrollHeight;
    const end = el.scrollTop;
    el.scrollTop = 0;
    return end > 0 && el.scrollTop < end;
  });
  assert.ok(scrolls, '窄桌面可独立滚动长对话');
  await checkFit(local);

  const owner = createServerClient({ base: url(cloud), token: tokenFor('studio-fixture') });
  await owner.putConfig(config);
  const member = await owner.createUser('工作台验收');
  const login = await owner.loginAccount(member.accessCode);
  const remote = await open(desktop, { viewport: { width: 1280, height: 860 } }, { enabled: true, url: url(cloud), userId: member.id, token: login.token, role: 'member' });
  await enter(remote);
  const [liveWalk] = await Promise.all([observeWalk(remote), send(remote, '请写一份简报并保存到' + cloudFile)]);
  assert.ok(liveWalk, '实际云任务运行期间可见跨工位移动');
  await remote.locator('#transcript').getByText('已保存云端简报。', { exact: false }).first().waitFor();
  const remoteEdit = stage(remote).locator('[data-entry-id][data-pose="edit"]').filter({ hasText: '写入文件' });
  await remoteEdit.waitFor();
  await send(remote, '请把复核意见也列进去');
  const queue = remote.getByRole('region', { name: '待发送问题' });
  assert.ok((await queue.innerText()).includes('请把复核意见也列进去'), '工作台内运行中发送的新问题默认排队');
  await queue.getByRole('button', { name: '待发消息操作', exact: true }).click();
  await remote.getByRole('menuitem', { name: '改为引导', exact: true }).click();
  await remote.locator('.wb-desk #transcript').getByText('收到，做完手上这一步就按这句调整', { exact: false }).first().waitFor();
  assert.equal(await queue.isVisible(), false, '引导被当前任务接收后退出队列');
  assert.ok(requests.some(req => req.method === 'POST' && req.path.endsWith('/notes')), '引导确实提交给同一个云任务');
  assert.ok(eventsResponse, '正在消费云端真实 SSE');
  const resumed = remote.waitForRequest(req => req.url().includes('/events?') && Number(new URL(req.url()).searchParams.get('after')) > 0);
  eventsResponse.end(': heartbeat\n\n');
  await resumed;
  continueCloud();
  await stage(remote).locator('[data-entry-id][data-pose="cheer"]').waitFor();
  assert.equal(await remoteEdit.count(), 1, '断线续接后没有重复工具步骤');
  assert.equal(requests.filter(req => req.method === 'POST' && req.path === '/api/tasks').length, 1, '回放和重连都未重复提交云端任务');

  const phone = await open(mobile, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  assert.equal(await phone.locator('.wb-tabs:visible').count(), 0);
  assert.equal(await stage(phone).count(), 0, '手机页不会常驻 PC 舞台');
  await checkFit(phone);
  assert.deepEqual(errors, []);
  console.log('工作台通过本机工具、云端断线续接、回放、会话隔离、场景资源及桌面/手机布局验收。');
} finally {
  continueCloud();
  await browser.close();
  await mode.tenders.stop(); await mode.runner.settled();
  for (const service of [desktop, mobile, cloud]) {
    service.closeAllConnections();
    await new Promise(resolve => service.close(resolve));
  }
  useBackend(null); await rm(dir, { recursive: true, force: true });
}
