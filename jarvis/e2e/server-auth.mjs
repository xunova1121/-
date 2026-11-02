/** 实际浏览器、真实鉴权与任务路由；临时6位密码/演示模型，不读取用户配置。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';

const out = path.resolve(process.argv[2] || '/tmp/weiyang-server-auth');
await fs.mkdir(out, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-auth-e2e-'));
const password = 'sIx123'; // 合成夹具，恰好6位。
const mode = createServerMode({ dataDir, password });
await mode.ready;
const server = createServer({ serverMode: mode, staticDir: path.resolve('dist'), ollama: null });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log('✓ ' + label); };
const errors = [];
const settings = async page => {
  await page.waitForFunction(() => globalThis.__jarvis?.showPanel);
  await page.evaluate(() => globalThis.__jarvis.showPanel('settings'));
};
const tokenOf = page => page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.server.v1')).token);
async function login(page) {
  page.on('pageerror', failure => errors.push(failure.stack || failure.message));
  await page.goto(base);
  await settings(page);
  await page.fill('#server-url', base);
  await page.fill('#server-pass', password);
  await Promise.all([page.waitForEvent('load'), page.click('#btn-server-login')]);
  await page.waitForFunction(() => globalThis.__jarvisServerMode === true);
  return tokenOf(page);
}
const api = (url, token, method = 'GET', body) => fetch(base + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
try {
  const first = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 Android Chrome/138', reducedMotion: 'reduce' });
  const page = await first.newPage();
  const ownerToken = await login(page);
  check(Buffer.from(ownerToken, 'base64url').length >= 32 && ownerToken !== tokenFor(password), '6位主密码实际登录，新凭证为独立随机会话');
  check(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(password), '访问密码未写入浏览器存储');
  await settings(page);
  await page.locator('.server-security summary').click();
  await page.locator('.server-security-warning').filter({ hasText: '最低允许6位' }).waitFor();
  check(true, '短密码只提醒，不强制改密或登出');
  let leakedRequests = 0;
  await page.route('https://must-not-send.invalid/**', async route => { leakedRequests++; await route.fulfill({ status: 403, body: '{}' }); });
  await page.fill('#server-url', 'https://must-not-send.invalid');
  const refreshed = page.waitForResponse(response => response.url() === base + '/api/server/security');
  await page.locator('.server-security').getByRole('button', { name: '刷新安全状态', exact: true }).click();
  assert.equal((await refreshed).status(), 200);
  check(leakedRequests === 0, '编辑未登录的新地址不会把旧会话凭据带给它');
  await page.fill('#server-url', base);
  const second = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 Windows Chrome/138', reducedMotion: 'reduce' });
  const secondPage = await second.newPage();
  let secondToken = await login(secondPage);
  await page.bringToFront();
  await page.getByText(/新设备登录：/).first().waitFor();
  check(true, '第二浏览器登录后原设备沿用真实通知通道收到提醒');
  const kicked = page.waitForResponse(response => response.url().includes('/api/server/security/devices/') && response.request().method() === 'DELETE');
  await page.locator('#toast').getByRole('button', { name: '踢掉', exact: true }).click();
  assert.equal((await kicked).status(), 200);
  check((await api('/api/sessions', secondToken)).status === 401, '新设备提醒旁边的踢掉按钮实际撤销会话');
  await secondPage.reload();
  await secondPage.locator('.wb-history-list').getByText('登录已失效，请到设置重新登录。', { exact: true }).waitFor();
  check(true, '被踢设备重新打开页面显示登录提示，历史读取失败不冒充空列表');
  secondToken = await login(secondPage);
  await page.bringToFront();
  await page.locator('.server-security').getByRole('button', { name: '刷新安全状态', exact: true }).click();
  const secondRow = page.locator('.server-security-devices .server-security-row').filter({ hasText: 'Windows' });
  await secondRow.getByRole('button', { name: '退出此设备', exact: true }).click();
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await api('/api/sessions', secondToken)).status === 401) break;
    await page.waitForTimeout(50);
  }
  check((await api('/api/sessions', secondToken)).status === 401 && (await api('/api/sessions', ownerToken)).status === 200, '从设备列表退出第二台后它返回401，当前设备仍可用');
  await page.getByRole('textbox', { name: '评测授权名称', exact: true }).fill('浏览器合成验收');
  await page.getByRole('spinbutton', { name: '每日模型与搜索次数上限', exact: true }).fill('1');
  await page.getByRole('button', { name: '生成评测令牌', exact: true }).click();
  const issued = page.getByRole('textbox', { name: '仅本次显示的评测令牌', exact: true });
  await issued.waitFor();
  const evaluationToken = await issued.inputValue();
  check(evaluationToken.length >= 43, '主人界面可生成一次性显示的专用授权');
  await page.getByRole('button', { name: '已保存，隐藏令牌', exact: true }).click();
  check(await page.locator('.server-security-issued textarea').inputValue() === '' && await page.locator('.server-security-issued').isHidden(), '隐藏后明文从视图清除，不留在列表');
  const submitted = await api('/api/tasks', evaluationToken, 'POST', { text: '你好', evaluationId: 'untrusted-client-id' });
  const task = await submitted.json();
  check(submitted.status === 200, '评测令牌通过真实任务接口创建任务');
  let observed;
  for (let attempt = 0; attempt < 120; attempt++) {
    observed = await (await api('/api/tasks/' + task.id, evaluationToken)).json();
    if (['done', 'error', 'stopped'].includes(observed.status)) break;
    await page.waitForTimeout(100);
  }
  check(observed.status === 'done' && /^ev_[a-f0-9]{24}_/.test(observed.evaluationId) && observed.evaluationId !== 'untrusted-client-id', '演示任务实际完成，评测编号由服务端强制隔离');
  check((await api('/api/tasks', evaluationToken, 'POST', { text: '第二次不得执行' })).status === 429, '每日额度耗尽后真实任务接口返回429，不再请求模型');
  check((await api('/api/server/config', evaluationToken)).status === 403 && (await api('/api/files', evaluationToken)).status === 403, '专用授权不能读取主人设置或文件');
  const ownList = await (await api('/api/sessions', ownerToken)).json();
  check(!ownList.some(row => row.id === task.sessionId), '评测任务不进入用户的对话列表');
  const ledger = await (await api('/api/server/security', ownerToken)).json();
  check(!JSON.stringify(ledger).includes(evaluationToken) && ledger.evaluations.some(row => row.used >= 1), '管理列表不回显令牌，演示适配器的实际调用已计数');
  await page.screenshot({ path: path.join(out, 'security-mobile.png'), fullPage: false });
  for (const width of [390, 1280]) {
    const legacyContext = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    await legacyContext.addInitScript(({ base, old }) => {
      if (!localStorage.getItem('jarvis.server.v1')) localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token: old, enabled: true }));
    }, { base, old: tokenFor(password) });
    const legacyPage = await legacyContext.newPage();
    legacyPage.on('pageerror', failure => errors.push(failure.message));
    await legacyPage.goto(base);
    await legacyPage.waitForFunction(() => {
      const value = JSON.parse(localStorage.getItem('jarvis.server.v1') || '{}');
      return value.token && !/^[a-f0-9]{64}$/.test(value.token) && globalThis.__jarvisServerMode;
    });
    const migrated = await tokenOf(legacyPage);
    const gatewayRequest = legacyPage.waitForRequest(request => request.url() === base + '/api/server/status?upgrade-check=1');
    const gatewayStatus = await legacyPage.evaluate(() => fetch('/api/server/status?upgrade-check=1').then(response => response.status));
    assert.equal(gatewayStatus, 200);
    check((await gatewayRequest).headers().authorization === 'Bearer ' + migrated, width + '：同源网关立即使用换发后的凭证');
    await legacyPage.reload();
    await legacyPage.waitForFunction(() => globalThis.__jarvisServerMode);
    check(await tokenOf(legacyPage) === migrated && (await api('/api/sessions', migrated)).status === 200, width + '：旧登录自动换发、刷新仍有效，不输入密码');
    await legacyContext.close();
  }
  check(errors.length === 0, '安全管理与迁移无页面异常：' + JSON.stringify(errors));
  await first.close(); await second.close();
  console.log(`${checks}/${checks} 通过；临时演示环境，不是用户真机或正式服务器验收。`);
} finally {
  await browser.close();
  await mode.runner.settled();
  await new Promise(resolve => server.close(resolve));
  useBackend(null);
  await fs.rm(dataDir, { recursive: true, force: true });
}
