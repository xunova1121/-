/**
 * 运行位置切换端到端测试：先 npm run build，再执行
 *   node e2e/runtime-switch.mjs [截图输出目录]
 * 用户 2026-11-01：切到本机后无法切回云服务器。模型中心顶上的“本机 / 云服务器”只切换正在编辑哪边的设置，
 * 不切换运行位置；现在模型中心单独显示“任务现在在哪儿运行”和真正的切换按钮。这里两条路都走一遍：
 * 登录 → 模型名弹窗切到本机 → 模型中心说明在本机运行、编辑页签不会改运行位置 → 点“切换到云服务器运行”回到云端
 * → 再从模型名弹窗切到本机、切回云服务器。手机宽度和电脑宽度各一遍。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || '.';
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'e2e-password-123';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-runtime-'));
const gw = spawn(process.execPath, ['server/server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), JARVIS_DATA: dataDir, JARVIS_PASSWORD: PASS, ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
gw.stdout.on('data', (d) => { log += d; });
gw.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 50 && !/服务器模式已开启/.test(log); i++) await new Promise((r) => setTimeout(r, 200));

const browser = await chromium.launch();
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const chip = () => page.locator('#model-chip-text').textContent();
    const ready = () => page.waitForFunction(() => window.__jarvis);
    const closeSide = () => page.evaluate(() => { document.body.classList.add('side-closed'); document.body.classList.remove('side-open'); });
    const runtime = () => page.evaluate(() => JSON.parse(localStorage.getItem('jarvis.server.v1') || '{}').enabled === true);

    await page.goto(BASE);
    await ready();
    await page.evaluate(() => window.__jarvis.showPanel('settings'));
    await page.fill('#server-url', BASE);
    await page.fill('#server-pass', PASS);
    await Promise.all([page.waitForEvent('load'), page.click('#btn-server-login')]);
    await ready();
    await page.waitForFunction(() => /^云端/.test(document.querySelector('#model-chip-text')?.textContent || ''));
    check(`${width} 登录后在云服务器运行`, /^云端/.test(await chip()));

    // 模型名弹窗切到本机
    await closeSide();
    await page.click('#prompt');
    await page.click('#model-chip');
    await Promise.all([page.waitForEvent('load'), page.locator('.ml-picker .ml-tabs button', { hasText: '本机' }).click()]);
    await ready();
    check(`${width} 弹窗切到本机后显示本机`, /^本机/.test(await chip()) && !(await runtime()));

    // 模型中心：编辑页签只改正在编辑哪边，不切换运行位置
    await page.evaluate(() => window.__jarvis.showPanel('models'));
    const row = page.locator('#model-workspace .ml-runtime');
    await row.waitFor();
    check(`${width} 模型中心写明任务现在在本机运行`, (await row.textContent()).includes('任务现在在本机运行'));
    await page.locator('#model-workspace .ml-tabs').getByRole('button', { name: '云服务器', exact: true }).click();
    await page.waitForFunction(() => /正在修改服务器配置/.test(document.querySelector('#model-workspace .ml-scope-note')?.textContent || ''));
    check(`${width} 编辑页签切到云服务器设置时提示怎么让任务回到云服务器`, /切换到云服务器运行/.test(await page.locator('#model-workspace .ml-scope-note').textContent()) && !(await runtime()));

    // 真正的切换按钮
    await Promise.all([page.waitForEvent('load'), page.locator('#model-workspace .ml-runtime-switch').click()]);
    await ready();
    await page.waitForFunction(() => /^云端/.test(document.querySelector('#model-chip-text')?.textContent || ''));
    check(`${width} 模型中心“切换到云服务器运行”能切回云端`, /^云端/.test(await chip()) && (await runtime()));

    // 再从弹窗切到本机、切回云服务器
    await closeSide();
    await page.click('#prompt');
    await page.click('#model-chip');
    await Promise.all([page.waitForEvent('load'), page.locator('.ml-picker .ml-tabs button', { hasText: '本机' }).click()]);
    await ready();
    await closeSide();
    await page.click('#prompt');
    await page.click('#model-chip');
    await Promise.all([page.waitForEvent('load'), page.locator('.ml-picker .ml-tabs button', { hasText: '云服务器' }).click()]);
    await ready();
    await page.waitForFunction(() => /^云端/.test(document.querySelector('#model-chip-text')?.textContent || ''));
    check(`${width} 弹窗切到本机后能从弹窗切回云服务器`, /^云端/.test(await chip()) && (await runtime()));

    await page.evaluate(() => window.__jarvis.showPanel('models'));
    await page.locator('#model-workspace .ml-runtime').waitFor();
    await page.screenshot({ path: path.join(OUT, `runtime-switch-${width}.png`) });
    check(`${width} 无页面错误`, errors.length === 0, errors.join(' | '));
    await page.close();
  }
} finally {
  await browser.close();
  gw.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
