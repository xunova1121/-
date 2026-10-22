/**
 * 手机版“模型”“设置”页布局（真正的 build:mobile 产物）：
 *   - 型号名很长时整页也不能左右滑（以前“文档审查”下拉框按最长选项撑宽，整页错位）
 *   - 手机上不显示电脑才用得上的设置；去掉的功能不再出现
 * 用法：npm run build:mobile && node e2e/settings-layout.mjs [截图目录]
 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-mobile');
const OUT = process.argv[2] || '';
if (OUT) await mkdir(OUT, { recursive: true });
const results = [];
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`); };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  try {
    const f = path.resolve(ROOT, p === '/' ? 'index.html' : decodeURIComponent(p.slice(1)));
    if (!f.startsWith(ROOT)) throw new Error('outside');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(await readFile(f));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

// 很长的型号名：常用线路和“文档审查”下拉框里都会出现
const LONG = 'deepseek-v4-pro-thinking-2026-10-preview-with-a-really-long-name';
const CONFIG = { provider: 'deepseek', models: { deepseek: LONG }, keys: { deepseek: 'sk-test' }, baseURLs: {}, favoriteModels: [{ provider: 'deepseek', model: LONG }, { provider: 'openrouter', model: `anthropic/claude-${LONG}` }] };

const browser = await chromium.launch();
try {
  for (const width of [390, 412]) {
    const ctx = await browser.newContext({ viewport: { width, height: 860 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript((cfg) => {
      if (window.top !== window) return;
      localStorage.setItem('jarvis.llm.v1', cfg);
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false }));
    }, JSON.stringify(CONFIG));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE);
    await page.waitForFunction(() => window.__jarvis, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    for (const pane of ['models', 'settings']) {
      await page.evaluate((x) => window.__jarvis.showPanel(x), pane);
      await page.waitForTimeout(800);
      // 折叠的都展开，量最宽的样子
      await page.evaluate(() => document.querySelectorAll('#panel details').forEach((d) => { d.open = true; }));
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const panel = document.querySelector('#panel');
        const wide = [...panel.querySelectorAll('*')].filter((el) => el.offsetParent && el.getBoundingClientRect().right > vw + 1).map((el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : ''));
        return { vw, doc: document.documentElement.scrollWidth, panel: panel.scrollWidth, wide: wide.slice(0, 5) };
      });
      check(`${width}px「${pane === 'models' ? '模型' : '设置'}」页不左右滑`, m.doc <= m.vw && m.panel <= m.vw, m.wide.length ? `超出：${m.wide.join('、')}` : `${m.panel}/${m.vw}`);
      if (pane === 'models') {
        for (const label of ['能力', '服务商', '模型库']) {
          await page.getByRole('navigation', { name: '模型中心分类' }).getByRole('button', { name: label, exact: true }).click();
          const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#panel').scrollWidth <= innerWidth);
          check(`${width}px App 模型中心「${label}」长型号不撑宽`, fits);
        }
        await page.getByRole('navigation', { name: '模型中心分类' }).getByRole('button', { name: '能力', exact: true }).click();
        await page.getByRole('button', { name: '配置深度思考与写作', exact: true }).click();
        const bounds = await page.locator('.mc-sheet').evaluate(el => {
          const r = el.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && getComputedStyle(el.querySelector('.mc-sheet-results')).scrollbarWidth === 'none';
        });
        check(`${width}px App 能力选择器不越界、可滚动且不显示滚动条`, bounds);
        if (OUT) await page.screenshot({ path: path.join(OUT, `app-ability-picker-${width}.png`) });
        await page.keyboard.press('Escape');
        if (OUT) await page.screenshot({ path: path.join(OUT, `app-model-center-${width}.png`) });
      }
      if (pane === 'models' && width === 390) {
        await page.evaluate(() => document.querySelector('.ml-scope-tabs, .ml-tabs')?.querySelectorAll('button')[1]?.click());
      }
      if (OUT) {
        await page.evaluate(() => document.querySelectorAll('#panel details').forEach((d) => { d.open = false; }));
        const h = await page.evaluate(() => document.querySelector('#panel').scrollHeight);
        await page.setViewportSize({ width, height: Math.min(h + 160, 6000) });
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT, `${pane}-${width}.png`) });
        await page.setViewportSize({ width, height: 860 });
      }
    }
    if (width === 412) {
      await page.evaluate(() => window.__jarvis.showPanel('settings'));
      const shown = (sel) => page.evaluate((s) => { const el = document.querySelector(s); return Boolean(el && el.offsetParent); }, sel);
      check('手机上不显示键盘快捷键、人脸跟随', !(await shown('.shortcuts')) && !(await shown('#set-face')));
      check('去掉的功能不再出现：多设备同步、表情锁定', !(await shown('#row-sync')) && !(await shown('#set-emotion')));
      await page.evaluate(() => window.__jarvis.showPanel('models'));
      await page.evaluate(() => document.querySelectorAll('#panel details').forEach((d) => { d.open = true; }));
      const engines = await page.evaluate(() => [...document.querySelectorAll('#tts-engine option')].map((o) => o.value));
      check('声音只留三种：百炼实时、免费在线、手机自带', JSON.stringify(engines) === JSON.stringify(['auto', 'qwen-realtime', 'edge', 'browser']), engines.join(','));
    }
    check(`${width}px 没有页面错误`, errors.length === 0, errors.join('；'));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} 手机设置布局通过`);
process.exit(results.every(Boolean) ? 0 : 1);
