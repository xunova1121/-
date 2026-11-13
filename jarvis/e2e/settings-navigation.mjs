/** 实际网页版/App构建：输入区简化、导航项目入口、模型唯一配置入口；无真实模型/Key。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-settings-navigation');
await fs.mkdir(output, { recursive: true });
async function serve(root) {
  const server = http.createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname),
        file = path.resolve(root, name === '/' ? 'index.html' : name.slice(1));
      if (!file.startsWith(root + path.sep)) throw Error('outside');
      const bytes = await fs.readFile(file);
      res.setHeader(
        'Content-Type',
        {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
          '.wasm': 'application/wasm'
        }[path.extname(file)] || 'application/octet-stream'
      );
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}
const web = await serve(path.resolve('dist')),
  mobile = await serve(path.resolve('dist-mobile'));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const checks = [];
let activePage = null,
  activeErrors = [];
const check = (id, ok) => {
  checks.push({ id, ok });
  assert.equal(ok, true, id);
};
try {
  for (const [width, theme, app] of [
    [320, 'day', true],
    [390, 'day', true],
    [390, 'night', true],
    [412, 'day', true],
    [1440, 'day', false]
  ]) {
    const label = `${app ? 'app' : 'web'}-${width}-${theme}`,
      ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: app, hasTouch: app });
    await ctx.addInitScript((theme) => {
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme, speechOutput: false }));
      localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'mock', models: { mock: 'mock' } }));
    }, theme);
    const page = await ctx.newPage(),
      errors = [];
    activePage = page;
    activeErrors = errors;
    page.on('pageerror', (e) => errors.push(e.message));
    page.setDefaultTimeout(15000);
    await page.goto((app ? mobile : web).base);
    await page.waitForFunction(() => window.__jarvis?.showPanel && document.querySelector('#project-chip'));
    await page.waitForFunction(() => !document.querySelector('#app-splash') || document.querySelector('#app-splash').hidden);
    check(label + '-composer-clean', (await page.locator('#inputbar #project-chip').count()) === 0);
    check(label + '-legacy-trigger-hidden', !(await page.locator('#project-chip').isVisible()));
    check(
      label + '-composer-fits',
      await page.locator('#inputbar').evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= -1 && r.right <= innerWidth + 1;
      })
    );
    await page.screenshot({ path: output + '/' + label + '-chat.png' });
    if (app) {
      await page.locator('#btn-menu').click();
      await page.waitForFunction(() => Math.abs(document.querySelector('#drawer').getBoundingClientRect().left) < 1);
      check(label + '-menu-settled', await page.locator('.drawer-project-entry').evaluate((el) => el.getBoundingClientRect().left >= 0));
      await page.screenshot({ path: output + '/' + label + '-menu.png' });
    }
    await page.locator('[data-destination="code-projects"]').click();
    await page.locator('.code-project-dialog').waitFor({ state: 'visible' });
    check(label + '-project-accessible', await page.locator('.code-project-dialog').isVisible());
    if (app) check(label + '-drawer-closed', !(await page.evaluate(() => document.body.classList.contains('drawer-open'))));
    await page.getByRole('button', { name: '关闭项目菜单' }).click();
    await page.evaluate(() => window.__jarvis.showPanel('models'));
    check(label + '-no-duplicate-advanced', (await page.locator('[data-pane="models"] #model-advanced').count()) === 0);
    check(label + '-fallback-in-options', (await page.locator('[data-pane="models"] #card-search').count()) === 0);
    check(label + '-one-workspace', (await page.locator('#model-workspace').count()) === 1);
    if (app) await page.locator('.mc-nav-tab').filter({ hasText: '服务商' }).click();
    await page.getByRole('button', { name: '本机连接与选项', exact: true }).click();
    await page.locator('#model-tools-dialog').waitFor({ state: 'visible' });
    check(label + '-response-controls-preserved', (await page.locator('#fast-chat').isVisible()) && (await page.locator('#hedge-backup').isVisible()));
    check(label + '-advanced-closed-by-default', !(await page.locator('#model-advanced').evaluate((el) => el.open)));
    await page.locator('#model-advanced summary').click();
    check(
      label + '-diagnostic-preserved',
      (await page.locator('#llm-provider').isVisible()) && (await page.getByRole('button', { name: '测试连接', exact: true }).isVisible())
    );
    await page.locator('.model-tools-search > summary').click();
    check(label + '-search-tools-preserved', await page.locator('#btn-search-test').isVisible());
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await page.waitForFunction(() => /连接成功/.test(document.querySelector('#llm-status').textContent));
    check(label + '-mock-connection-works', /连接成功/.test(await page.locator('#llm-status').innerText()));
    check(label + '-one-diagnostic-form', (await page.locator('#llm-provider').count()) === 1);
    await page.screenshot({ path: output + '/' + label + '-options.png' });
    await page.getByRole('button', { name: '关闭本机选项' }).click();
    check(label + '-dialog-closes', !(await page.locator('#model-tools-dialog').isVisible()));
    check(label + '-no-page-errors', errors.length === 0);
    await page.screenshot({ path: output + '/' + label + '-models.png' });
    await ctx.close();
  }
  await fs.writeFile(output + '/summary.json', JSON.stringify({ passed: true, checks }, null, 2));
  console.log('设置与导航：' + checks.length + '项真实浏览器检查通过');
} catch (error) {
  await fs.writeFile(output + '/failure.json', JSON.stringify({ message: error.message, errors: activeErrors, checks }, null, 2));
  await activePage?.screenshot({ path: output + '/failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await new Promise((r) => web.server.close(r));
  await new Promise((r) => mobile.server.close(r));
}
