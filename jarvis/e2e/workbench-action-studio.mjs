/** 正式 PC/手机网页、真实工作区和云端 SSE；只替换模型，不访问付费服务。 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { createTaskRunner } from '../server/taskRunner.mjs';
import { currentUser, runAsUser } from '../server/userScope.mjs';
import { createTools } from '../src/agent/tools.js';
import { createServerClient } from '../src/core/serverClient.js';
import { useBackend } from '../src/agent/store.js';
import { openTaskFloor } from './workshop-test-view.mjs';
import { checkWorkshopRoom } from './workshop-room-check.mjs';
import { checkNestHistory } from './workbench-nest-history.mjs';

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
// 等测试端观察到每道真实工序，再放行对应工具，避免本机文件在一帧内做完。
const cloudCalls = [
  { id: 'collect-cloud', name: 'list_files', args: {} }, write(cloudFile),
  { id: 'audit-cloud', name: 'list_work_records', args: {} },
  { id: 'inspect-cloud', name: 'verify_delivery', args: { paths: [cloudFile] } }
];
const steps = new Map(['list_files', 'write_file', 'list_work_records'].map(name => [name, Promise.withResolvers()]));
const runner = createTaskRunner({
  getConfig: async () => config,
  userAccess: { current: currentUser, run: runAsUser, active: () => true },
  makeTools: ctx => createTools(ctx).map(tool => {
    const gate = steps.get(tool.name);
    return gate ? { ...tool, async run(...args) { await gate.promise; return tool.run(...args); } } : tool;
  }),
  makeAdapter: () => ({ model: 'studio-fixture', adapter: { async stream(input) {
    const tool = cloudCalls[cloudRounds++];
    if (tool) return { text: '', toolCalls: [tool], stop: 'tool_use' };
    input.onText?.('已保存云端简报。');
    await cloudGate;
    return { text: '已保存云端简报。', toolCalls: [], stop: 'end_turn' };
  } } })
});
const mode = createServerMode({ dataDir: dir, password: 'studio-fixture', runner });
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
async function enter(page, taskFloor = true) {
  await page.locator('.wb-tabs').getByRole('button', { name: '工作台', exact: true }).click();
  await stage(page).waitFor();
  if (taskFloor) await openTaskFloor(stage(page));
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
    for (const bounds of [room, floor.closest('.ws-scene').getBoundingClientRect()]) {
      if (actor.left < bounds.left - 1 || actor.right > bounds.right + 1 || actor.top < bounds.top - 1 || actor.bottom > bounds.bottom + 1) {
        throw new Error('角色被车间画面的边缘裁掉');
      }
    }
    return { x: (actor.left + actor.width / 2 - room.left) / room.width, y: (actor.bottom - room.top) / room.height };
  });
}

async function observeWalk(page, startAction) {
  const actor = stage(page).locator('.ws-actor');
  // 跨进程先装好逐帧观察，再准许工具完成，避免在短动画结束后才启动采样。
  await actor.evaluate(el => {
    el.observedTravel = (async () => {
      const start = performance.now();
      const scene = el.closest('.ws-scene');
      const phases = new Set();
      let from, walkingFrames = 0;
      while (performance.now() - start < 9000) {
        await new Promise(requestAnimationFrame);
        phases.add([scene.dataset.station, scene.dataset.workPhase, scene.dataset.lifePose].join('/'));
        if (el.dataset.walking !== 'true') { from = null; continue; }
        const now = el.getBoundingClientRect();
        walkingFrames++;
        // 必须是在同一次走动中，真正绘制的两帧在屏幕上发生了位移。
        if (from && Math.hypot(now.left - from.left, now.top - from.top) >= 3) return true;
        from ??= now;
      }
      throw Error('没有捕捉到实际步行位移；行走帧 ' + walkingFrames + '；所见工位 ' + [...phases].join('，'));
    })();
  });
  await startAction();
  return actor.evaluate(el => el.observedTravel);
}
// 工具实际运行时验证专用接触动作的三帧。单纯改标签、挪角色或让静态立绘上下浮动都不够。
async function checkWorkingHands(page, operation) {
  const sprite = stage(page).locator(`.ws-scene[data-operation="${operation}"][data-work-phase="working"] .ws-actor > .ws-sprite`);
  await sprite.waitFor();
  // 图集中三帧的取件尖端、笔尖和指尖。目标取自页面里的真实道具，缩放后也要对得上。
  const contacts = {
    archive: { row: '0%', target: '.ws-rack-folder', points: [[.104,.532],[.178,.559],[.164,.564]] },
    write: { row: '50%', target: '.ws-drawing-slip', points: [[.898,.723],[.901,.736],[.898,.620]] },
    type: { row: '100%', target: '.ws-keyboard', points: [[.863,.647],[.845,.622],[.856,.626]] }
  };
  const frames = await sprite.evaluate(async (node, { row, target, points }) => {
    const samples = [];
    const prop = node.closest('.ws-floorplan').querySelector(target);
    const start = performance.now();
    while (samples.filter(Boolean).length < 3 && performance.now() - start < 4000) {
      const style = getComputedStyle(node);
      const index = ['0%', '50%', '100%'].indexOf(style.backgroundPositionX);
      if (index >= 0 && !samples[index] && /workshop-actions[^/]*\.webp/.test(style.backgroundImage) && style.backgroundPositionY === row) {
        const spriteBox = node.getBoundingClientRect(), objectBox = prop.getBoundingClientRect();
        const x = spriteBox.left + points[index][0] * spriteBox.width;
        const y = spriteBox.top + points[index][1] * spriteBox.height;
        const gap = Math.max(0, objectBox.left - x, x - objectBox.right, objectBox.top - y, y - objectBox.bottom);
        samples[index] = { gap: gap / spriteBox.width, x: x / spriteBox.width, y: y / spriteBox.height };
      }
      await new Promise(requestAnimationFrame);
    }
    return samples.filter(Boolean);
  }, contacts[operation]);
  assert.equal(frames.length, 3, operation + ' 实际作业使用对应工位的三帧手部接触动作');
  const count = { archive: 1, write: 2, type: 3 }[operation];
  assert.ok(frames.slice(0, count).every(p => p.gap < .045), operation + ' 手部接触实际道具：' + JSON.stringify(frames));
  if (operation === 'archive') assert.ok(frames[1].x - frames[0].x > .05, '取出资料后与柜格拉开');
  if (operation === 'write') assert.ok(frames[1].y - frames[2].y > .07, '纸面书写后抬起笔尖');
}
async function checkFit(page) {
  const box = await page.locator('#prompt').boundingBox();
  assert.ok(box && box.height > 0 && box.y >= 0 && box.y + box.height <= page.viewportSize().height + 1, '输入框完整可见');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '无横向溢出');
}
try {
  let roomModelCalls = 0;
  const roomPage = await open(desktop, { viewport: { width: 1392, height: 900 }, timezoneId: 'Asia/Shanghai' }, null, route => {
    roomModelCalls++;
    return route.abort();
  });
  await checkWorkshopRoom({ page: roomPage, enter, send, output });
  assert.equal(roomModelCalls, 0, '工作台查询、控灯和生活操作都在本机完成');
  await roomPage.context().close();
  let modelCalls = 0;
  const local = await open(desktop, { viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' }, null, async route => {
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
  // 固定在电脑前整理笔记的时段，和写文件用的制作台明确区分；任务计时与动画仍往前走。
  await local.clock.setSystemTime(new Date('2026-11-20T11:11:00+08:00'));
  assert.ok(await local.evaluate(() => window.__jarvis.stage == null), '普通对话不创建经典 WebGL 场景');
  await enter(local);
  assert.ok(await local.evaluate(() => window.__jarvis.stage == null), '工作台的角色不拉起星系 GPU 场景');
  assert.equal(await rows(local).count(), 0, '空会话只显示待命');
  assert.equal(await stage(local).getAttribute('data-pose'), 'idle');
  const idleActivity = await stage(local).locator('.ws-scene').getAttribute('data-life-activity');
  assert.equal(idleActivity, 'study', '11:11 的个人作息在电脑前');
  await stationPoint(local, ({ plan: 'bench', tidy: 'archive', study: 'review' })[idleActivity] || 'rest');
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
  assert.equal(await stage(local).locator('.ws-scene').getAttribute('data-operation'), 'none', '读取失败没有继续取件的动作');
  const archive = await stationPoint(local, 'archive');
  assert.notEqual(await actor.getAttribute('data-walking'), 'true', '手动回看停在读取文件的工位');
  await local.screenshot({ path: path.join(output, 'pc-studio-retry.png') });
  const edits = stage(local).locator('[data-entry-id][data-pose="edit"]').filter({ hasText: '写入文件' });
  assert.equal(await edits.count(), 1, '工具开始和结束合并为一次编辑');
  await edits.click();
  assert.equal(await stage(local).getAttribute('data-mode'), 'review');
  const snapshot = stage(local).locator('.ws-scene[data-work-phase="snapshot"][data-operation="write"] .ws-sprite');
  assert.equal(await snapshot.evaluate(el => getComputedStyle(el).backgroundPositionX), '50%', '手动回看已执行的写入停留在笔尖接触纸面的帧');
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
  const inspection = stage(local).locator('[data-entry-id]').filter({ hasText: '核验交付文件' });
  await inspection.click();
  const review = await stationPoint(local, 'review');
  await stage(local).locator('[data-action="live"]').click();
  assert.equal(await stage(local).getAttribute('data-pose'), 'cheer');
  await stage(local).locator('[data-entry-id][data-pose="cheer"]').click();
  await stationPoint(local, 'bench'); // 核验后还写了回复，庆祝应在最后一次实际工作的地方。
  for (const [a, b] of [[archive, bench], [archive, review], [bench, review]]) {
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > .08, '读取、修改和复核有不同的实际站位');
  }
  const ids = await rows(local).evaluateAll(list => list.map(el => el.dataset.entryId));
  const walked = await observeWalk(local, () => stage(local).locator('[data-action="play"]').click());
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
  assert.equal(await stage(local).locator('.ws-scene').getAttribute('data-life-activity'), 'study', '重开后实时视图恢复当前作息');
  await stationPoint(local, 'review');
  await edits.click();
  assert.equal(await stage(local).locator('.ws-scene').getAttribute('data-operation'), 'write', '窄屏回看真实写入步骤');
  await stationPoint(local, 'bench');
  await local.screenshot({ path: path.join(output, 'pc-studio-compact.png') });
  await local.setViewportSize({ width: 768, height: 620 });
  for (const [row, station] of [[failure, 'archive'], [edits, 'bench'], [inspection, 'review']]) {
    await row.click();
    await stationPoint(local, station);
  }
  await checkFit(local);
  await local.screenshot({ path: path.join(output, 'workshop-narrow.png') });
  await stage(local).locator('[data-action="live"]').click();
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
  await enter(remote, false);
  const roomSession = await remote.evaluate(() => window.__jarvis.sessionId);
  const memberClient = createServerClient({ base: url(cloud), token: login.token });
  const savedRoom = remote.waitForResponse(res => res.request().method() === 'POST' && res.url().endsWith('/' + roomSession + '/append'));
  await send(remote, '请打开工作台的台灯');
  assert.equal((await savedRoom).status(), 200, '工作台问答真实保存到当前云账号');
  assert.deepEqual((await memberClient.getSession(roomSession)).messages.map(m => m.content), ['请打开工作台的台灯', '工作台的台灯已经打开了。']);
  assert.equal(await owner.getSession(roomSession), null, '房间对话存入成员自己的空间');
  assert.equal(requests.filter(req => req.method === 'POST' && req.path === '/api/tasks').length, 0, '房间灯控没有提交云任务');
  await send(remote, '请列出已有文件，再写一份简报保存到' + cloudFile + '，最后核对成果记录并核验交付文件。');
  // 2026-11-25：小窝里取文件时不再换成早期工坊的小人（用户：那个小未央太小了），保持书桌边的整幅人物
  await stage(remote).locator('.ws-scene[data-room-view="nest"][data-nest-pose="work"]').waitFor();
  assert.equal(await stage(remote).locator('.ws-scene[data-room-view="nest"] .ws-floorplan > .ws-actor').isVisible(), false, '小窝任务中不出现小人贴纸');
  await openTaskFloor(stage(remote));
  await stage(remote).locator('.ws-scene[data-station="archive"]').waitFor();
  await checkWorkingHands(remote, 'archive');
  await send(remote, '未央，你在干嘛？');
  await remote.locator('#transcript .msg.agent').filter({ hasText: '当前步骤是“列出文件”' }).waitFor();
  assert.equal(requests.filter(req => req.method === 'POST' && req.path.endsWith('/append')).length, 1, '忙中问进度没有往执行中的会话追加工具或消息');
  await remote.locator('.wb-tabs').getByRole('button', { name: '对话', exact: true }).click();
  steps.get('list_files').resolve();
  await remote.locator('#transcript').getByText('写入文件', { exact: true }).first().waitFor();
  await enter(remote);
  await stationPoint(remote, 'bench');
  const liveActor = stage(remote).locator('.ws-actor');
  assert.notEqual(await liveActor.getAttribute('data-walking'), 'true', '切回后直接定位正在写文件的工位');
  await checkWorkingHands(remote, 'write');
  const wideActor = await liveActor.boundingBox();
  await stage(remote).getByRole('button', { name: '近看操作' }).click();
  await remote.waitForFunction(width => {
    const activeActor = document.querySelector('.work-studio[data-zoom="detail"] .ws-actor');
    return activeActor && activeActor.getBoundingClientRect().width > width * 1.5;
  }, wideActor.width);
  await checkWorkingHands(remote, 'write');
  await stage(remote).getByRole('button', { name: '看全景' }).click();
  await remote.waitForFunction(width => {
    const activeActor = document.querySelector('.work-studio[data-zoom="wide"] .ws-actor');
    return activeActor && Math.abs(activeActor.getBoundingClientRect().width - width) < 1;
  }, wideActor.width);
  assert.ok(await observeWalk(remote, steps.get('write_file').resolve), '返回工作台后，下一道真实工序开始时小人继续走动');
  await stage(remote).locator('.ws-scene[data-station="review"]').waitFor();
  await checkWorkingHands(remote, 'type');
  steps.get('list_work_records').resolve();
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
  await checkNestHistory(remote, memberClient);

  const phone = await open(mobile, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  assert.equal(await phone.locator('.wb-tabs:visible').count(), 0);
  assert.equal(await stage(phone).count(), 0, '手机页不会常驻 PC 舞台');
  await checkFit(phone);
  assert.deepEqual(errors, []);
  console.log('工作台通过三工位真实工具、手部三帧、近看、切回定位、云端断线续接、回放及桌面/手机布局验收。');
} finally {
  for (const gate of steps.values()) gate.resolve();
  continueCloud();
  await browser.close();
  await mode.tenders.stop(); await mode.runner.settled();
  for (const service of [desktop, mobile, cloud]) {
    service.closeAllConnections();
    await new Promise(resolve => service.close(resolve));
  }
  useBackend(null); await rm(dir, { recursive: true, force: true });
}
