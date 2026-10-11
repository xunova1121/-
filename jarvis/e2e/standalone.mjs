/**
 * 单文件版测试：直接用 file:// 打开 jarvis-standalone.html（不启动任何服务器）。
 *   npm run build:standalone && node e2e/standalone.mjs [截图目录]
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = pathToFileURL(path.resolve(here, '../../jarvis-standalone.html')).href;
const OUT = process.argv[2] || '.';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
const requests = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('request', (r) => requests.push(r.url()));

await page.goto(FILE);
await page.waitForFunction(() => window.__jarvis?.stage?.stats.frames > 10, null, { timeout: 30000 });
const stats = await page.evaluate(() => window.__jarvis.stage.stats);
check('双击打开即渲染（file://，无服务器）', true, `${stats.style} / ${stats.vertices} 顶点 / ${stats.drawCalls} draw calls`);

await page.fill('#prompt', '最近压力好大');
await page.press('#prompt', 'Enter');
await page.waitForFunction(() => window.__jarvis.machine.task === 'done', null, { timeout: 20000 });
const reply = await page.locator('.msg.agent .body').last().textContent();
check('内置演示助手可以对话', reply.includes('没关系'), reply.slice(0, 30));

await page.fill('#prompt', '电脑现在状态怎么样');
await page.press('#prompt', 'Enter');
await page.waitForFunction(() => window.__jarvis.machine.task === 'done', null, { timeout: 20000 });
const reply2 = await page.locator('.msg.agent .body').last().textContent();
check('本机状态问答（浏览器指标）', /网络在线|网络离线/.test(reply2), reply2.slice(0, 50));

await page.waitForTimeout(3500);
const conn = await page.locator('[data-conn]').first().textContent();
check('仪表显示浏览器估算指标', conn === '浏览器估算', conn);

await page.click('[data-view="settings"]');
await page.fill('#set-key', 'sk-ant-test-123');
await page.click('#btn-save-key');
const title = await page.getAttribute('#mode-pill', 'title');
check('保存密钥后切到 Claude 直连', title.includes('浏览器直连'), title);
await page.click('#btn-clear-key');
check('删除密钥后回到演示助手', (await page.getAttribute('#mode-pill', 'title')).includes('内置演示'));
await page.click('[data-view="settings"]');

for (const s of ['holo', 'orb']) {
  await page.click(`[data-style="${s}"]`);
  await page.waitForTimeout(400);
  check(`样式切换：${s}`, await page.evaluate((s) => window.__jarvis.stage.stats.style === s, s));
}
await page.screenshot({ path: `${OUT}/standalone.png` });

const external = requests.filter((u) => !u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('blob:'));
check('启动与对话不依赖网络', external.length === 0, external.join(' | '));
check('无页面错误', errors.length === 0, errors.join(' | '));

await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
