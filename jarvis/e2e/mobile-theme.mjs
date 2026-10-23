/** 实际手机构建的统一主题验收；使用假天气，不调用真实模型。 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-mobile');
const output = process.argv[2] || '/tmp/weiyang-mobile-theme';
await mkdir(output, { recursive: true });
const checks = [];
function check(label, passed, detail = '') {
  checks.push(passed);
  console.log(`${passed ? '✓' : '✗'} ${label} ${detail}`);
}
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm'
};
const server = http.createServer(async (req, res) => {
  const requestPath = new URL(req.url, 'http://localhost').pathname;
  const target = path.resolve(root, requestPath === '/' ? 'index.html' : decodeURIComponent(requestPath.slice(1)));
  try {
    if (!target.startsWith(root + path.sep)) throw new Error('路径越界');
    const data = await readFile(target);
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  for (const width of [320, 390, 412]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      if (window.top !== window) return;
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false }));
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: { getCurrentPosition: (success) => success({ coords: { latitude: 31.234, longitude: 121.474 } }) }
      });
    });
    await context.route('https://**/*', (route) => route.abort());
    await context.route('https://api.open-meteo.com/**', (route) => {
      const today = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
      return route.fulfill({
        json: {
          utc_offset_seconds: 28800,
          current: { temperature_2m: 22, weather_code: 0, is_day: 1, time: today + 'T12:00' },
          daily: { time: [today], temperature_2m_min: [16], temperature_2m_max: [24], weather_code: [0], precipitation_probability_max: [0] }
        }
      });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => window.__jarvis?.showPanel && document.querySelector('.home-reference'));
    await page.waitForFunction(() => document.querySelector('#app-splash')?.hidden !== false);
    const metrics = await page.evaluate(() => {
      const home = document.querySelector('.home-reference');
      const model = document.querySelector('#model-chip').getBoundingClientRect();
      const input = document.querySelector('#inputbar').getBoundingClientRect();
      return {
        background: getComputedStyle(document.body).getPropertyValue('--bg').trim(),
        titleSize: parseFloat(getComputedStyle(home.querySelector('h1')).fontSize),
        count: home.querySelectorAll('.home-suggestion').length,
        width: document.documentElement.scrollWidth,
        composerFits: input.left >= 0 && input.right <= innerWidth && input.bottom <= innerHeight,
        modelFits: model.top >= 0 && model.bottom <= input.top + 2,
        image: getComputedStyle(home.querySelector('.wy-mascot')).backgroundImage
      };
    });
    check(`${width} 首页参考配色与字号`, metrics.background === '#eef0ff' && metrics.titleSize >= 16 && metrics.titleSize <= 22 && metrics.count === 3);
    check(`${width} 输入区与模型标签可见且无横向溢出`, metrics.width <= width && metrics.composerFits && metrics.modelFits, JSON.stringify(metrics));
    check(`${width} 使用批准的新未央形象`, metrics.image.includes('mascot-approved'));
    await page.screenshot({ path: path.join(output, `theme-home-${width}.png`) });
    for (const pane of ['sessions', 'workspace', 'knowledge', 'mind', 'skills', 'models', 'system', 'settings']) {
      await page.evaluate((value) => window.__jarvis.showPanel(value), pane);
      await page.waitForTimeout(150);
      const panelMetrics = await page.evaluate((value) => {
        const panel = document.querySelector('#panel');
        const content = panel.querySelector(`[data-pane="${value}"]`);
        return {
          width: panel.scrollWidth,
          doc: document.documentElement.scrollWidth,
          visible: !content.hidden,
          background: getComputedStyle(panel).backgroundImage,
          font: getComputedStyle(content).fontFamily
        };
      }, pane);
      check(
        `${width} ${pane}统一主题且不撑宽`,
        panelMetrics.visible &&
          panelMetrics.width <= width &&
          panelMetrics.doc <= width &&
          panelMetrics.background.includes('gradient') &&
          panelMetrics.font.includes('HarmonyOS'),
        JSON.stringify(panelMetrics)
      );
      await page.screenshot({ path: path.join(output, `theme-${pane}-${width}.png`) });
    }
    await page.click('#btn-theme');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    check(
      `${width} 夜间仍使用深色令牌`,
      await page.evaluate(
        () =>
          getComputedStyle(document.body).getPropertyValue('--bg').trim() === '#191b2b' &&
          getComputedStyle(document.querySelector('#panel')).color === 'rgb(240, 239, 250)'
      )
    );
    await page.screenshot({ path: path.join(output, `theme-dark-${width}.png`) });
    await page.click('#btn-theme');
    await page.click('#btn-side-back');
    await page.locator('.brand-mark').click();
    const companion = await page.locator('.wy-companion').evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { width: box.width, left: box.left, right: box.right, title: parseFloat(getComputedStyle(el.querySelector('h2')).fontSize) };
    });
    check(`${width} 陪伴完整页和参考字号`, companion.left >= 0 && companion.right <= width && companion.title <= 22);
    await page.screenshot({ path: path.join(output, `theme-companion-${width}.png`) });
    await page.getByRole('button', { name: '摸摸头', exact: true }).click();
    check(
      `${width} 摸头真实更新形态与对白`,
      (await page.locator('.wy-companion-stage .wy-mascot').getAttribute('data-state')) === 'pet' &&
        /温柔/.test(await page.locator('.wy-companion-say').textContent())
    );
    await page.getByRole('button', { name: '关闭未央', exact: true }).click();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
    });
    check(
      `${width} 大字体仍可滚动且输入可见`,
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#inputbar').getBoundingClientRect().bottom <= innerHeight
      )
    );
    check(`${width} 无页面脚本异常`, errors.length === 0, errors.join(';'));
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(`统一主题 ${checks.filter(Boolean).length}/${checks.length}`);
if (checks.some((item) => !item)) process.exitCode = 1;
