/** 真服务器保存与浏览器交互；搜索回包使用明确的替身，不调用付费接口。 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const output = process.argv[2] || path.join(os.tmpdir(), 'jarvis-openai-search-settings');
fs.mkdirSync(output, { recursive: true });
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-openai-search-settings-data-'));
const password = 'openai-search-settings-fixture';
const token = createHash('sha256').update(`jarvis-server:${password}`).digest('hex');
const base = 'http://127.0.0.1:8813';
const server = spawn(process.execPath, ['server/server.mjs'], {
  env: { ...process.env, PORT: '8813', JARVIS_DATA: data, JARVIS_PASSWORD: password }, stdio: 'pipe'
});
let logs = '';
server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
let browser;
const checks = [];
const check = (title, ok) => {
  checks.push({ title, ok });
  console.log(`${ok ? '✓' : '✗'} ${title}`);
  if (!ok) throw new Error(title);
};
try {
  browser = await chromium.launch();
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ base, token }) => {
      localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token, enabled: true }));
      localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'mock', keys: { custom: 'untouched-local-chat-key' } }));
    }, { base, token });
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis?.showPanel);
    await page.waitForFunction(() => /^[A-Za-z0-9_-]{43}$/.test(JSON.parse(localStorage.getItem('jarvis.server.v1') || '{}').token || ''));
    await page.evaluate(() => window.__jarvis.showPanel('models'));
    await page.locator('#model-workspace .ml-scope-note').waitFor();
    if (width < 721) await page.getByRole('navigation', { name: '模型中心分类' }).getByRole('button', { name: '服务商', exact: true }).click();
    const panel = page.locator('.ml-openai-search');
    await panel.locator('summary').click();
    check(`${width} 云端搜索入口与当前位置一致`, (await panel.locator('summary').textContent()).includes('云服务器'));
    await panel.getByLabel('启用自定义联网搜索', { exact: true }).check();
    await panel.getByLabel('自定义搜索API地址', { exact: true }).fill('https://search.example.com/v1');
    await panel.getByLabel('自定义搜索API Key', { exact: true }).fill(`server-search-secret-${width}`);
    await panel.getByLabel('自定义搜索模型ID', { exact: true }).fill('fixture-web-model');
    await panel.getByLabel('自定义搜索接口格式', { exact: true }).selectOption('chat-completions');
    const searchRequests = [];
    let simulatedFailure = false;
    await page.route('**/api/server/search-test', async route => {
      searchRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: simulatedFailure ? 400 : 200, contentType: 'application/json',
        body: JSON.stringify(simulatedFailure
          ? { error: '接口未返回网页来源；请确认模型支持联网搜索', code: 'OPENAI_SEARCH_NO_SOURCES' }
          : { count: 2, ms: 140, requests: 1 })
      });
    });
    await panel.getByRole('button', { name: '测试自定义搜索', exact: true }).click();
    await panel.getByText('配置有未保存的修改，请先保存，再测试。', { exact: true }).waitFor();
    check(`${width} 未保存的新密钥不会用旧配置测试`, searchRequests.length === 0);
    const save = page.waitForResponse(r => r.url() === base + '/api/server/config' && r.request().method() === 'PUT');
    await panel.getByRole('button', { name: '保存自定义搜索', exact: true }).click();
    check(`${width} 自定义搜索真实保存接口成功`, (await save).ok());
    await panel.getByText('已保存到云服务器，不改变聊天模型', { exact: true }).waitFor();
    const config = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8'));
    check(`${width} 云端地址、协议、模型和独立密钥完整保存`, config.openaiSearchEnabled === true
      && config.openaiSearchBaseURL === 'https://search.example.com/v1' && config.openaiSearchModel === 'fixture-web-model'
      && config.openaiSearchProtocol === 'chat-completions' && config.openaiSearchKey === `server-search-secret-${width}`);
    const readback = await page.evaluate(async () => {
      const settings = JSON.parse(localStorage.getItem('jarvis.server.v1'));
      return (await fetch(settings.url + '/api/server/config', { headers: { Authorization: 'Bearer ' + settings.token } })).json();
    });
    check(`${width} 云端读回密钥掩码`, readback.openaiSearchKey === `••••${`server-search-secret-${width}`.slice(-4)}`
      && !JSON.stringify(readback).includes('server-search-secret'));
    check(`${width} 本机聊天配置保留，云搜索密钥不落本机`, await page.evaluate(() => {
      const local = JSON.parse(localStorage.getItem('jarvis.llm.v1'));
      return local.keys.custom === 'untouched-local-chat-key' && !JSON.stringify(local).includes('server-search-secret');
    }));
    await panel.getByRole('button', { name: '测试自定义搜索', exact: true }).click();
    await panel.getByText(/搜索可用：.*返回2条网页来源/).waitFor();
    check(`${width} 测试专用搜索服务，显示来源数，不将普通回复当搜索`, searchRequests.length === 1 && searchRequests[0].kind === 'openai');
    simulatedFailure = true;
    await panel.getByRole('button', { name: '测试自定义搜索', exact: true }).click();
    await panel.getByText(/接口未返回网页来源/).waitFor();
    check(`${width} 上游无来源的错误可见，不误报可用`, !(await panel.locator('[role="status"]').textContent()).includes('搜索可用'));
    await page.unroute('**/api/server/search-test');
    await panel.getByLabel('启用自定义联网搜索', { exact: true }).uncheck();
    const disableSaved = page.waitForResponse(r => r.url() === base + '/api/server/config' && r.request().method() === 'PUT');
    await panel.getByRole('button', { name: '保存自定义搜索', exact: true }).click();
    await disableSaved;
    await panel.getByText('已保存到云服务器，不改变聊天模型', { exact: true }).waitFor();
    const disabled = page.waitForResponse(r => r.url() === base + '/api/server/search-test');
    await panel.getByRole('button', { name: '测试自定义搜索', exact: true }).click();
    check(`${width} 已关闭搜索的真实测试接口拒绝调用`, (await disabled).status() === 400);
    await page.screenshot({ path: path.join(output, `openai-search-${width}.png`) });
    check(`${width} 配置面板无横向溢出`, await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    check(`${width} 搜索接口选择器满足手机点击高度`, (await panel.getByLabel('自定义搜索接口格式', { exact: true }).boundingBox()).height >= 44);
    await page.locator('#model-workspace .ml-tabs').getByRole('button', { name: '本机', exact: true }).click();
    await panel.locator('summary').click();
    check(`${width} 本机默认搜索关闭、地址和Key独立`, !(await panel.getByLabel('启用自定义联网搜索', { exact: true }).isChecked())
      && await panel.getByLabel('自定义搜索API地址', { exact: true }).inputValue() === ''
      && await panel.getByLabel('自定义搜索API Key', { exact: true }).inputValue() === '');
    await panel.getByLabel('自定义搜索API地址', { exact: true }).fill('https://local-search.example.com/v1');
    await panel.getByLabel('自定义搜索模型ID', { exact: true }).fill('local-web-model');
    await panel.getByLabel('自定义搜索API Key', { exact: true }).fill('local-only-search-key');
    await panel.getByRole('button', { name: '保存自定义搜索', exact: true }).click();
    await panel.getByText('已保存到本机，不改变聊天模型', { exact: true }).waitFor();
    check(`${width} 本机保存不覆盖云端地址或密钥`, await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.llm.v1')).openaiSearchKey === 'local-only-search-key')
      && JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')).openaiSearchKey === `server-search-secret-${width}`);
    check(`${width} 无浏览器脚本异常`, errors.length === 0);
    await context.close();
  }
} catch (error) {
  console.error(error);
  console.error(logs);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(checks, null, 2));
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
  fs.rmSync(data, { recursive: true, force: true });
}
