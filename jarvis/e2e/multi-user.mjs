/** 真实浏览器/HTTP/任务执行器，多人并发和切换账号；模型为受控替身，不消耗用户额度。 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from '../server/server.mjs';
import { createServerMode } from '../server/serverMode.mjs';
import { currentUser, runAsUser } from '../server/userScope.mjs';
import { useBackend } from '../src/agent/store.js';

const output = process.argv[2] || '/tmp/weiyang-multi-user-browser';
fs.mkdirSync(output, { recursive: true });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weiyang-multi-e2e-'));
fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ provider: 'mock', models: {}, keys: {}, autoMemory: false }));
const entered = new Set(), release = new Map(), results = [];
const check = (name, condition) => { results.push({ name, passed: Boolean(condition) }); assert.ok(condition, name); console.log('通过：' + name); };
const mode = createServerMode({ dataDir: directory, password: 'fixture-owner-password', makeTaskAdapter: () => ({ model: 'multi-user-fixture', adapter: {
  kind: 'mock', async stream({ onText, signal }) {
    const id = currentUser(); entered.add(id);
    await new Promise(resolve => { release.set(id, resolve); signal.addEventListener('abort', resolve, { once: true }); });
    const text = '已收到你的消息，这是你的独立对话。'; onText?.(text);
    return { text, toolCalls: [], stop: 'end_turn' };
  }
} }) });
await mode.ready;
const server = createServer({ serverMode: mode });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const mobileServer = createServer({ serverMode: mode, staticDir: path.resolve('dist-mobile') });
await new Promise(resolve => mobileServer.listen(0, '127.0.0.1', resolve));
const mobileBase = 'http://127.0.0.1:' + mobileServer.address().port;
const browser = await chromium.launch();
const pageErrors = [];
const members = [];
async function login(page, credential, address = base) {
  await page.goto(address);
  await page.waitForFunction(() => window.__jarvis);
  await page.evaluate(() => window.__jarvis.showPanel('settings'));
  await page.fill('#server-url', base);
  await page.fill('#server-pass', credential);
  await Promise.all([page.waitForEvent('load'), page.click('#btn-server-login')]);
  await page.waitForFunction(() => window.__jarvis);
}
async function clientApi(page, route, method = 'GET', body) {
  return page.evaluate(async ({ route, method, body }) => {
    const cfg = JSON.parse(localStorage.getItem('jarvis.server.v1'));
    const r = await fetch(route, { method, headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  }, { route, method, body });
}
try {
  const admin = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  admin.on('pageerror', e => pageErrors.push(e.message));
  await login(admin, 'fixture-owner-password');
  await admin.evaluate(() => window.__jarvis.showPanel('settings'));
  await admin.locator('.server-users summary').click();
  for (const name of ['甲', '乙']) {
    await admin.getByLabel('用户名称', { exact: true }).fill(name);
    await admin.getByRole('button', { name: '添加用户', exact: true }).click();
    const field = admin.getByLabel('本次生成的个人访问码');
    await field.waitFor({ state: 'visible' });
    const code = await field.inputValue();
    check('用户' + name + '通过界面生成个人访问码', /^wyu_/.test(code));
    members.push({ name, code });
    await admin.getByRole('button', { name: '已保存，隐藏', exact: true }).click();
  }
  check('管理员能设置两人并行且不修改环境文件', (await clientApi(admin, '/api/server/config')).body.taskConcurrency === 2);
  for (const [i, member] of members.entries()) {
    const context = await browser.newContext({ viewport: i === 0 ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    const page = await context.newPage(); member.page = page;
    page.on('pageerror', e => pageErrors.push(e.message));
    await login(page, member.code, i === 0 ? mobileBase : base);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.server.v1')));
    member.id = saved.userId;
    check(member.name + '登录绑定身份，不保存访问码', saved.role === 'member' && saved.userId && !JSON.stringify(saved).includes(member.code));
    await page.evaluate(() => { document.body.classList.add('side-closed'); document.body.classList.remove('side-open'); });
    await page.fill('#prompt', '你好，' + member.name + '的独立对话');
    // 手机版回车保留换行语义；两端都从真正的发送按钮提交。
    await page.click('#btn-send');
  }
  const deadline = Date.now() + 15000;
  while (entered.size < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  check('手机与电脑两个身份同时进入模型调用，无全局串行锁', entered.size === 2);
  const aTasks = runAsUser(members[0].id, () => mode.runner.list());
  check('另一用户不能停止或读取该任务', (await clientApi(members[1].page, '/api/tasks/' + aTasks[0].id)).status === 404 && (await clientApi(members[1].page, '/api/tasks/' + aTasks[0].id + '/stop', 'POST', {})).body.ok === false);
  for (const resume of release.values()) resume();
  await mode.runner.settled();
  for (const member of members) {
    await member.page.waitForFunction(() => [...document.querySelectorAll('#transcript .msg.agent')].some(el => el.textContent.includes('这是你的独立对话')) && !document.querySelector('.msg.agent.streaming'));
    const sessions = (await clientApi(member.page, '/api/sessions')).body;
    check(member.name + '仅返回自己的会话', sessions.length === 1 && sessions[0].title.includes(member.name));
    check(member.name + '不可改共享模型', (await clientApi(member.page, '/api/server/config', 'PUT', { provider: 'custom' })).status === 403);
    await member.page.screenshot({ path: path.join(output, member.name + '-chat.png'), fullPage: true });
  }
  const page = members[0].page;
  await login(page, members[1].code, mobileBase);
  await page.evaluate(() => window.__jarvis.showPanel('conversations'));
  check('同设备换账号不会恢复前一用户的聊天缓存', !(await page.locator('#transcript').textContent()).includes('甲的独立对话'));
  check('全部浏览器无未处理脚本异常', pageErrors.length === 0);
} finally {
  for (const user of members) mode.runner.stopUser(user.id);
  for (const resume of release.values()) resume();
  await mode.runner.settled();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ results, pageErrors, realModel: false, productionServer: false }, null, 2));
  await browser.close(); mobileServer.closeAllConnections(); await new Promise(resolve => mobileServer.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  useBackend(null); fs.rmSync(directory, { recursive: true, force: true });
}
