/** 真实构建/HTTP/账号/任务链路；原生桥与模型为替身，不宣称安卓真机验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';
import { createServerMode } from '../server/serverMode.mjs';
import { currentUser, runAsUser } from '../server/userScope.mjs';
import { useBackend } from '../src/agent/store.js';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-phone-e2e');
await fs.mkdir(output, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-phone-e2e-'));
await fs.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ provider: 'mock', models: {}, keys: {}, autoMemory: false }));
const devices = new Map(), stages = new Map(), observed = new Map(), checks = [], errors = [];
const check = (name, condition) => { checks.push({ name, passed: !!condition }); assert.ok(condition, name); console.log('通过：' + name); };
const mode = createServerMode({ dataDir, password: 'fixture-owner-phone', autoSchedules: false, makeTaskAdapter: () => ({ model: 'phone-e2e-fixture', adapter: { async stream({ messages, onText }) {
  const owner = currentUser(), stage = stages.get(owner) || 0; stages.set(owner, stage + 1);
  observed.set(owner, messages);
  if (stage === 0) return { text: '', toolCalls: [{ id: 'phone-list', name: 'phone_devices', args: {} }], stop: 'tool_use' };
  if (stage === 1) return { text: '', toolCalls: [{ id: 'phone-read', name: 'phone_action', args: { deviceId: devices.get(owner).id, action: 'read_screen' } }], stop: 'tool_use' };
  const text = '已读取你授权的手机页面，页面显示测试联系人；尚未发送消息。'; onText?.(text); return { text, toolCalls: [], stop: 'end_turn' };
} } }) });
await mode.ready;
const server = createServer({ serverMode: mode, staticDir: path.resolve('dist-mobile') });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
async function api(token, route, method = 'GET', body) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const browser = await chromium.launch();
const deadline = async (fn, label) => { const end = Date.now() + 15000; while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 50)); } throw Error(label); };
try {
  const owner = (await api('', '/api/server/login', 'POST', { password: 'fixture-owner-phone' })).body;
  const people = [];
  for (const name of ['甲', '乙']) {
    const user = (await api(owner.token, '/api/server/users', 'POST', { name })).body;
    const login = (await api('', '/api/server/login', 'POST', { password: user.accessCode })).body;
    check(name + '独立登录成功', !!login.token && !!login.userId);
    const d = (await api(login.token, '/api/phone/devices', 'POST', { name: name + '的手机', installationId: randomUUID(), owner: 'owner' })).body;
    check(name + '注册返回一次性限时设备凭据', /^phone_/.test(d.token) && !!d.id); devices.set(login.userId, d); people.push({ ...login, device: d });
  }
  const [a, b] = people;
  check('其他成员不能看见和移除这台手机', (await api(b.token, '/api/phone/devices')).body.every(d => d.id !== a.device.id) && (await api(b.token, '/api/phone/devices/' + a.device.id, 'DELETE')).status === 404);
  check('无登录不能注册；无设备凭据不能轮询', (await api('', '/api/phone/devices', 'POST', { installationId: randomUUID() })).status === 401 && (await api('', '/api/phone/transport', 'POST', { deviceId: a.device.id, op: 'poll' })).status === 401);
  check('设备凭据不能读账号数据或串其他手机', (await api(a.device.token, '/api/sessions')).status === 401 && (await api(a.device.token, '/api/phone/transport', 'POST', { deviceId: b.device.id, op: 'poll' })).status === 401);
  const evaluations = await api(owner.token, '/api/server/security/evaluations', 'POST', { name: 'phone-no-access' });
  check('管理员能创建评测令牌', evaluations.status === 200 && !!evaluations.body.token);
  check('评测令牌不可注册手机', (await api(evaluations.body.token, '/api/phone/devices', 'POST', { installationId: randomUUID() })).status === 403);
  for (const p of people) {
    await api(p.device.token, '/api/phone/transport', 'POST', { deviceId: p.device.id, op: 'poll' });
    p.task = await runAsUser(p.userId, () => mode.runner.start({ text: '读取我手机当前页面' }));
  }
  for (const p of people) {
    const command = await deadline(async () => (await api(p.device.token, '/api/phone/transport', 'POST', { deviceId: p.device.id, op: 'poll' })).body.command, '任务未派发到手机');
    check('任务使用实际 phone_action 取屏幕', command.action === 'read_screen');
    check('已领取命令不重复下发', (await api(p.device.token, '/api/phone/transport', 'POST', { deviceId: p.device.id, op: 'poll' })).body.command === null);
    check('执行前二次校验通过', (await api(p.device.token, '/api/phone/transport', 'POST', { deviceId: p.device.id, op: 'validate', commandId: command.id })).status === 200);
    await api(p.device.token, '/api/phone/transport', 'POST', { deviceId: p.device.id, op: 'complete', commandId: command.id, result: { ok: true, screen: { snapshotId: 'fresh', packageName: 'com.example.contacts', width: 1080, height: 1920, nodes: [{ id: 'n1', text: '测试联系人-' + p.userId }] } } });
  }
  await mode.runner.settled();
  for (const p of people) {
    const task = runAsUser(p.userId, () => mode.runner.get(p.task.id));
    check('任务在收到设备真实回执后完成', task.status === 'done' && (observed.get(p.userId) || []).some(m => m.role === 'tool' && m.name === 'phone_action' && m.content.includes('测试联系人-' + p.userId)));
    check('保存检查点不携带手机屏幕正文', !JSON.stringify((await runAsUser(p.userId, () => mode.store.get('sessions', p.task.sessionId)))?.taskCheckpoint).includes('测试联系人-'));
  }

  // 真实 mobile 构建，原生桥由可观察的替身提供；每种屏宽保留截图。
  for (const [width, theme, native] of [[320, 'day', true], [390, 'night', true], [1280, 'day', false]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(({ theme, native }) => {
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme, speechOutput: false }));
      localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'mock', models: { mock: 'mock' } }));
      if (!native) return;
      const state = { accessibility: true, enabled: false, paused: false, remainingMs: 900000, deviceName: '测试安卓', installationId: '12345678-1234-4234-8234-123456789abc' };
      window.phoneFixture = { state, stops: 0, calls: [] };
      window.__jarvisPhoneControl = { status: async () => ({ ...state }), apps: async () => ({ apps: [{ label: '微信', packageName: 'com.tencent.mm' }, { label: '地图', packageName: 'com.example.maps' }] }), stop: async () => { state.enabled = false; window.phoneFixture.stops++; }, enable: async options => { window.phoneFixture.calls.push(options); state.enabled = true; }, pause: async ({ paused }) => { state.paused = paused; }, settings: async () => {} };
    }, { theme, native });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(base); await page.waitForFunction(() => window.__jarvis?.showPanel);
    await page.waitForFunction(() => !document.querySelector('#app-splash') || document.querySelector('#app-splash').hidden);
    await page.evaluate(() => window.__jarvis.showPanel('settings'));
    await page.click('#btn-phone-control'); await page.getByText(native ? '这台手机：未开启' : '请在安卓 APK', { exact: false }).waitFor();
    check(`${width} ${theme} 面板不横向溢出`, await page.locator('.wy-phone').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    if (theme === 'night') check('夜间面板使用深色背景，文字保持对比', await page.locator('.wy-phone').evaluate(el => { const rgb = getComputedStyle(el).backgroundColor.match(/\d+/g); return rgb && rgb.slice(0, 3).every(v => Number(v) < 90); }));
    await page.screenshot({ path: path.join(output, `phone-${width}-${theme}.png`), fullPage: true });
    if (native) {
      await page.getByRole('button', { name: '开启本机操控15分钟', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '请选择1到12' }).waitFor();
      check('未选应用不能开始', await page.evaluate(() => !phoneFixture.state.enabled));
      await page.getByLabel('微信', { exact: true }).check(); await page.getByRole('button', { name: '开启本机操控15分钟', exact: true }).click();
      await page.getByRole('button', { name: '暂停操控', exact: true }).waitFor();
      check('只把选定应用交给原生', await page.evaluate(() => JSON.stringify(phoneFixture.calls[0].packages) === '["com.tencent.mm"]'));
      await page.getByRole('button', { name: '暂停操控', exact: true }).click(); await page.getByRole('button', { name: '恢复操控', exact: true }).waitFor();
      check('暂停实际调用原生桥', await page.evaluate(() => phoneFixture.state.paused));
      await page.getByRole('button', { name: '停止并断开', exact: true }).click(); await page.getByText('这台手机：未开启', { exact: true }).waitFor();
      check('停止实际关闭原生能力', await page.evaluate(() => !phoneFixture.state.enabled && phoneFixture.stops >= 2));
    }
    await context.close();
  }
  check('浏览器无未处理异常', errors.length === 0);
  await api(a.token, '/api/phone/devices/' + a.device.id, 'DELETE');
  check('设备移除后旧令牌立即失效', (await api(a.device.token, '/api/phone/transport', 'POST', { deviceId: a.device.id, op: 'poll' })).status === 401);
} finally {
  await browser.close(); for (const [id] of devices) runAsUser(id, () => mode.runner.stopUser(id)); await mode.runner.settled();
  await new Promise(r => server.close(r)); mode.schedules.stop(); useBackend(null); await fs.rm(dataDir, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ realDeviceTested: false, realModelTested: false, checks, errors }, null, 2));
}
console.log(`手机控制链路 ${checks.length} 项通过；原生桥/模型替身，安卓真机未测。`);
