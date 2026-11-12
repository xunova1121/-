/** 正式构建下检查新智能体入口、表单与草稿；不调用付费模型或外部数据。 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const output = process.argv[2] || '/tmp/weiyang-business-ui';
await mkdir(output, { recursive: true });
const root = path.resolve('.');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  try {
    const request = new URL(req.url, 'http://localhost').pathname;
    const filename = path.resolve(root, '.' + decodeURIComponent(request.startsWith('/assets/') ? '/dist' + request : request));
    if (!filename.startsWith(root + path.sep)) throw new Error('path');
    const data = await readFile(filename); res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
const results = [];
const check = (label, ok) => { results.push({ label, ok }); console.log(`${ok ? '✓' : '✗'} ${label}`); };
try {
  for (const [width, theme] of [[320, 'day'], [390, 'day'], [412, 'night'], [1280, 'day']]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 800 });
    await context.route('https://**/*', route => route.abort());
    await context.addInitScript(theme => localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme, speechOutput: false })), theme);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/${width < 800 ? 'dist-mobile' : 'dist'}/index.html`);
    await page.waitForFunction(() => window.__jarvis?.agents);
    await page.evaluate(() => { document.querySelector('#app-splash')?.remove(); window.__jarvis.agents.openSquare(); });
    await page.waitForSelector('.wy-agent-card[data-agent="business-intelligence"]');
    check(`${width} 广场包含原8项与企业招投标`, await page.locator('.wy-agent-card[data-agent]').count() === 9);
    await page.fill('.wy-agents-search-input', '招标');
    await page.waitForTimeout(180);
    check(`${width} 搜索可找到新入口`, await page.locator('.wy-agent-card[data-agent="business-intelligence"]').count() === 1);
    await page.click('.wy-agent-card[data-agent="business-intelligence"]');
    await page.waitForSelector('.wy-agent-start[data-agent="business-intelligence"]');
    await page.locator('.wy-business-more > summary').click();
    await page.fill('[data-field="region"] input', '江苏南京');
    await page.selectOption('[data-field="period"] select', '最近7天');
    await page.selectOption('[data-field="notice"] select', '招标采购');
    await page.selectOption('[data-field="company_source"] select', '公开来源');
    await page.evaluate(() => window.__jarvis.agents.renderStart());
    check(`${width} 表单重绘保留地区时间类型`, await page.inputValue('[data-field="region"] input') === '江苏南京' && await page.inputValue('[data-field="notice"] select') === '招标采购');
    await page.locator('.wy-business-advanced > summary').click();
    for (const label of ['找招标', '查企业', '读公告', '跟踪项目']) {
      await page.getByRole('button', { name: new RegExp('^' + label) }).click();
      check(`${width} ${label}只填草稿`, (await page.inputValue('#prompt')).length > 8 && await page.locator('#transcript .msg').count() === 0);
    }
    check(`${width} 无横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.wy-agent-start').scrollWidth <= document.querySelector('#transcript').clientWidth));
    await page.evaluate(() => { document.activeElement?.blur(); document.querySelector('#transcript').scrollTop = 0; });
    await page.screenshot({ path: `${output}/business-${width}-${theme}.png`, fullPage: true });
    check(`${width} 无页面异常`, errors.length === 0);
    await context.close();
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
if (results.some(row => !row.ok)) process.exitCode = 1;
