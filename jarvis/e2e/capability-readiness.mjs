/** 实际手机版构建+真实鉴权接口；固定环境结果，不调用模型/公网API。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { MockAgent } from '../server/agents.mjs';
import { readinessItem } from '../shared/capabilityReadiness.js';
import { useBackend } from '../src/agent/store.js';

const out = path.resolve(process.argv[2] || '/tmp/weiyang-capability-readiness');
await fs.mkdir(out, { recursive: true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-readiness-e2e-'));
const configFile = path.join(data, 'config.json');
const original = JSON.stringify({
  provider: 'custom',
  models: { custom: 'gpt-6.1-sol' },
  keys: { custom: 'private-model-fixture' },
  baseURLs: { custom: 'https://upstream.invalid/v1' },
  pixabayKey: 'private-pixabay-fixture'
});
await fs.writeFile(configFile, original);
let holding = false,
  release,
  modelRequests = 0,
  probes = 0;
const runtime = {
  check: async () => {
    probes++;
    if (holding)
      await new Promise((resolve) => {
        release = resolve;
      });
    return {
      version: '1.0.377',
      checkedAt: Date.now(),
      checks: [
        readinessItem('office', 'executable'),
        readinessItem('fonts', 'font_ready'),
        readinessItem('ffmpeg', 'command_missing'),
        readinessItem('sandbox', 'missing')
      ]
    };
  }
};
const mode = createServerMode({ dataDir: data, password: 'readiness-e2e-password', readinessRuntime: runtime });
const server = createServer({ serverMode: mode, agent: new MockAgent(), staticDir: path.resolve('dist-mobile'), ollama: null });
const local = createServer({ agent: new MockAgent(), staticDir: path.resolve('dist-mobile'), ollama: null });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`,
  localBase = `http://127.0.0.1:${local.address().port}`;
const token = tokenFor('readiness-e2e-password');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let checks = 0;
const check = (ok, title) => {
  assert.ok(ok, title);
  checks++;
  console.log('✓ ' + title);
};
try {
  check((await fetch(base + '/api/server/readiness', { method: 'POST' })).status === 401, '能力自检必须经过服务器鉴权');
  for (const width of [390, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await ctx.route('https://upstream.invalid/**', (route) => {
      modelRequests++;
      return route.fulfill({ status: 503, body: 'not requested in this test' });
    });
    await page.addInitScript(
      ({ base, token }) => {
        localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token, enabled: true }));
        localStorage.setItem('jarvis.weather.locationAsked.v1', '1');
        localStorage.setItem('jarvis.settings.v1', JSON.stringify({ speechOutput: false }));
      },
      { base, token }
    );
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis?.showPanel);
    await page.evaluate(() => window.__jarvis.showPanel('models'));
    let pane = page.locator('.capability-readiness');
    await pane.locator('summary').filter({ hasText: '云服务器' }).click();
    await pane.getByRole('button', { name: '开始自检', exact: true }).click();
    await pane.locator('[data-readiness-id="chat"]').waitFor();
    check((await pane.locator('[data-readiness-id="chat"]').getAttribute('data-readiness-status')) === 'configured', width + '：有Key的模型显示待实测');
    check((await pane.locator('[data-readiness-id="pixabay"]').getAttribute('data-readiness-status')) === 'configured', width + '：图库未检测不能显示已启用');
    check((await pane.locator('[data-readiness-id="ffmpeg"]').getAttribute('data-readiness-status')) === 'unavailable', width + '：缺ffmpeg明确标不可用');
    check((await pane.innerText()).includes('处理位置：'), width + '：问题提供具体处理位置');
    check(!(await pane.innerText()).includes('private-'), width + '：自检文字没有Key与配置原文');
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await pane.getByRole('button', { name: '复制脱敏结果', exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check(JSON.parse(copied).scope === 'server' && !copied.includes('private-'), width + '：复制的是当前配置位置的脱敏报告');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + '：自检结果不撑出横向滚动');
    await page.screenshot({ path: path.join(out, `readiness-${width}.png`), fullPage: false });
    if (width === 390) {
      holding = true;
      release = null;
      await pane.getByRole('button', { name: '开始自检', exact: true }).click();
      for (let index = 0; index < 100 && !release; index++) await page.waitForTimeout(25);
      check(Boolean(release), '云端慢检查确实处于进行中');
      await page.getByRole('group', { name: '正在修改的配置位置' }).getByRole('button', { name: '本机', exact: true }).click();
      await page.locator('.capability-readiness summary').filter({ hasText: '本机' }).waitFor();
      holding = false;
      release();
      await page.waitForTimeout(100);
      pane = page.locator('.capability-readiness');
      check((await pane.locator('.readiness-row').count()) === 0, '迟到云端结果不会跑到本机配置中');
      await page.getByRole('group', { name: '正在修改的配置位置' }).getByRole('button', { name: '云服务器', exact: true }).click();
      pane = page.locator('.capability-readiness');
      await pane.locator('summary').click();
      holding = true;
      release = null;
      await pane.getByRole('button', { name: '开始自检', exact: true }).click();
      for (let index = 0; index < 100 && !release; index++) await page.waitForTimeout(25);
      await pane.getByRole('button', { name: '停止等待', exact: true }).click();
      holding = false;
      release?.();
      await page.waitForTimeout(100);
      check((await pane.innerText()).includes('已停止等待') && (await pane.locator('.readiness-row').count()) === 0, '停止后迟到响应不能覆盖已停止状态');
      await page.route('**/api/server/readiness', (route) => route.fulfill({ status: 404, json: { error: 'old server' } }));
      await pane.getByRole('button', { name: '开始自检', exact: true }).click();
      await pane.getByRole('status').filter({ hasText: '请先更新服务器' }).waitFor();
      check((await pane.locator('.readiness-row').count()) === 0, '旧服务器404提示升级，不把旧结果当成功');
      await pane.getByRole('button', { name: '服务商与 Key', exact: true }).click();
      check(await page.locator('.ml-service-keys').evaluate((element) => element.open), '自检的处理入口能打开原服务Key设置');
    }
    check(errors.length === 0, width + '：自检与切换没有页面异常');
    await ctx.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('jarvis.weather.locationAsked.v1', '1'));
  await page.goto(localBase);
  await page.waitForFunction(() => window.__jarvis?.showPanel);
  await page.evaluate(() => window.__jarvis.showPanel('models'));
  const pane = page.locator('.capability-readiness');
  await pane.locator('summary').filter({ hasText: '本机' }).click();
  await pane.getByRole('button', { name: '开始自检', exact: true }).click();
  await pane.locator('[data-readiness-id="chat"]').waitFor();
  check((await pane.locator('[data-readiness-id="chat"]').getAttribute('data-readiness-status')) === 'demo', '本机检查使用本机配置，不把云端真实模型套到本机');
  check((await pane.locator('[data-readiness-id="sandbox"]').getAttribute('data-readiness-status')) === 'unknown', '本机不把云端Docker镜像检查当成本机结果');
  check(modelRequests === 0, '全部自检没有调用模型或图库公网接口');
  check(probes > 0, '界面经过真实服务器自检路由');
  check((await fs.readFile(configFile, 'utf8')) === original, '全部自检没有改写正式配置或Key');
  await ctx.close();
  console.log(`\n${checks}/${checks} 通过；环境依赖为固定替身，本机依赖为实际检测；不代表用户服务器或真实模型已验收。`);
} finally {
  holding = false;
  release?.();
  await browser.close();
  await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => local.close(resolve))]);
  await mode.ready;
  useBackend(null);
  await fs.rm(data, { recursive: true, force: true });
}
