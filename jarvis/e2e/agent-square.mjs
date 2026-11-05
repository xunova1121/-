/**
 * 智能体广场（第2步）真实构建验收：手机构建 dist-mobile（320 / 390 / 412、白天 / 夜间、1.3 倍字）+ 电脑构建 dist（1280）。
 * 抽屉入口 → 广场搜索 / 分类 / 空状态 → 选智能体 → 起始页、顶栏名字 → 推荐问题只填输入框不发送 → 表单选择记在对话上 → 返回广场保留搜索。
 * 不调用真实模型和外网（所有 https 请求拦掉）。用法：npm run build && npm run build:mobile && node e2e/agent-square.mjs [截图目录]
 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = process.argv[2] || '/tmp/weiyang-agent-square';
await mkdir(output, { recursive: true });
const results = [];
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' ' + detail : ''}`); };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.json': 'application/json' };

function serve(dir) {
  const root = path.resolve(here, '..', dir);
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    const target = path.resolve(root, p === '/' ? 'index.html' : decodeURIComponent(p.slice(1)));
    try {
      if (!target.startsWith(root + path.sep)) throw new Error('越界');
      const data = await readFile(target);
      res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function phone(browser, base, { width, theme, zoom }) {
  const tag = `${width}-${theme}${zoom ? '-big' : ''}`;
  const ctx = await browser.newContext({ viewport: { width, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => { localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: t, speechOutput: false })); }, theme === 'light' ? 'day' : 'night');
  await ctx.route('https://**/*', (route) => route.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base);
  await page.waitForSelector('#btn-menu:not([hidden])', { timeout: 20000 });
  await page.evaluate(() => document.querySelector('#app-splash')?.remove());
  if (zoom) await page.addStyleTag({ content: 'html{font-size:130% !important}' });
  // P1 抽屉入口
  await page.click('#btn-menu');
  await page.waitForSelector('.drawer-agents .drawer-agent-pick');
  check(`[${tag}] 抽屉有“发现智能体”和 3 个常用入口`, (await page.locator('.drawer-agent-pick').count()) === 3);
  await page.click('.drawer-agents-head');
  // P2 广场
  await page.waitForSelector('.wy-agents:not([hidden]) .wy-agent-card[data-agent]');
  check(`[${tag}] 广场 8 个内置智能体`, (await page.locator('.wy-agent-card[data-agent]').count()) === 8);
  check(`[${tag}] 广场不横向溢出`, (await overflow(page)) <= 0);
  check(`[${tag}] 分类标签看得见`, await page.evaluate(() => document.querySelector('.wy-agents-chips').getBoundingClientRect().height >= 44));
  const tooSmall = await page.evaluate(() => [...document.querySelectorAll('.wy-agents button, .wy-agents input')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 43.5).map((b) => b.className));
  check(`[${tag}] 可点元素都不小于 44px 高`, tooSmall.length === 0, tooSmall.slice(0, 3).join(','));
  await page.screenshot({ path: `${output}/square-${tag}.png` });
  await page.fill('.wy-agents-search-input', '公文');
  await page.waitForFunction(() => document.querySelectorAll('.wy-agent-card[data-agent]').length === 1);
  check(`[${tag}] 搜“公文”只剩公文写作`, (await page.locator('.wy-agent-card[data-agent="gongwen-writer"]').count()) === 1);
  await page.fill('.wy-agents-search-input', '不存在的东西xyz');
  await page.waitForSelector('.wy-agents-empty');
  check(`[${tag}] 搜不到时有空状态说明`, (await page.locator('.wy-agents-empty b').innerText()).includes('没有找到'));
  await page.fill('.wy-agents-search-input', '');
  await page.click('.wy-agents-chip[data-category="image"]');
  await page.waitForFunction(() => document.querySelectorAll('.wy-agent-card[data-agent]').length === 2);
  check(`[${tag}] 分类“图片处理”有海报和图片转文字`, (await page.locator('.wy-agent-card[data-agent="poster-designer"], .wy-agent-card[data-agent="image-reader"]').count()) === 2);
  await page.click('.wy-agents-chip[data-category="office"]');
  await page.click('.wy-agent-card[data-agent="ppt-maker"]');
  // P3 起始页
  await page.waitForSelector('.wy-agent-start[data-agent="ppt-maker"]');
  check(`[${tag}] 广场关闭，起始页显示，普通首页不显示`, await page.evaluate(() => document.querySelector('.wy-agents').hidden && !document.querySelector('#transcript .wy-home')));
  check(`[${tag}] 顶栏显示智能体名字`, (await page.locator('#chat-title').innerText()).includes('PPT 制作') && (await page.locator('#chat-title .wy-chat-agent').count()) === 1);
  check(`[${tag}] 起始页不横向溢出`, (await overflow(page)) <= 0);
  check(`[${tag}] 起始页不显示通用开场建议和“回到最新回复”`, await page.evaluate(() => ![...document.querySelectorAll('.wy-jump-latest, .wb-jump-latest')].some((b) => !b.hidden) && ![...document.querySelectorAll('.callout, .chip')].some((c) => c.offsetParent && /帮我规划今天的工作/.test(c.textContent))));
  await page.screenshot({ path: `${output}/start-${tag}.png` });
  await page.selectOption('.wy-agent-select[aria-label="页数"]', '6-10');
  await page.click('.wy-agent-starter >> nth=1');
  const prompt = await page.inputValue('#prompt');
  check(`[${tag}] 推荐问题只填进输入框`, prompt === '做一份 6–10 页的项目进展汇报', prompt);
  await page.waitForTimeout(300);
  check(`[${tag}] 没有自动发送（对话里没有消息）`, (await page.locator('#transcript .msg').count()) === 0);
  // 返回广场：保留分类
  await page.click('.wy-agent-back-link');
  await page.waitForSelector('.wy-agents:not([hidden])');
  check(`[${tag}] 返回广场保留上次的分类`, (await page.locator('.wy-agents-chip.on').getAttribute('data-category')) === 'office');
  await page.click('.wy-agents-back');
  check(`[${tag}] 关闭广场回到原起始页`, await page.locator('.wy-agent-start[data-agent="ppt-maker"]').isVisible());
  check(`[${tag}] 没有页面脚本错误`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();
}

async function desktop(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  await ctx.route('https://**/*', (route) => route.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(base);
  await page.waitForSelector('[data-destination="agents"]', { timeout: 20000 });
  await page.evaluate(() => document.querySelector('#app-splash')?.remove());
  await page.click('[data-destination="agents"]');
  await page.waitForSelector('.wy-agents:not([hidden]) .wy-agent-card[data-agent]');
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.wy-agents-grid')).gridTemplateColumns.split(' ').length);
  check('[1280] 电脑版广场四列', cols === 4, String(cols));
  await page.screenshot({ path: `${output}/square-1280.png` });
  await page.click('.wy-agent-card[data-agent="health-advisor"]');
  await page.waitForSelector('.wy-agent-start[data-agent="health-advisor"]');
  check('[1280] 电脑版起始页显示，工作台首页卡片隐藏', await page.evaluate(() => document.querySelector('.wb-landing')?.hidden !== false));
  await page.screenshot({ path: `${output}/start-1280.png` });
  check('[1280] 没有页面脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();
}

const browser = await chromium.launch();
const mobile = await serve('dist-mobile');
const web = await serve('dist');
try {
  for (const width of [320, 390, 412]) for (const theme of ['light', 'dark']) await phone(browser, mobile.base, { width, theme, zoom: false });
  await phone(browser, mobile.base, { width: 390, theme: 'light', zoom: true });
  await desktop(browser, web.base);
} finally {
  await browser.close();
  mobile.server.close();
  web.server.close();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过；截图在 ${output}`);
process.exit(passed === results.length ? 0 : 1);
