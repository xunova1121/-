/** 屏幕常亮（网页版，真浏览器 + 假时钟）：说话时申请唤醒锁，30 秒没碰调暗，点一下恢复，说完放开。先开 node server/server.mjs */
import { chromium } from 'playwright';

const BASE = process.env.JARVIS_URL || 'http://127.0.0.1:8787';
const results = [];
const check = (label, ok) => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${label}`); };
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 记下唤醒锁的申请和释放（无头浏览器本身不给锁）
  await page.addInitScript(() => {
    globalThis.__locks = [];
    Object.defineProperty(navigator, 'wakeLock', { value: { request: async (type) => { const l = { type, released: false, release: async () => { l.released = true; } }; globalThis.__locks.push(l); return l; } } });
  });
  await page.clock.install();
  await page.goto(BASE);
  await page.waitForFunction(() => window.__jarvis, null, { timeout: 60000 });
  const held = () => page.evaluate(() => globalThis.__locks.filter((l) => !l.released).length);
  const veil = () => page.evaluate(() => !document.querySelector('.screen-veil').hidden);

  check('没说话时不占着屏幕', (await held()) === 0 && !(await veil()));
  await page.evaluate(() => document.body.classList.add('speaking'));
  await page.clock.runFor(1500);
  check('开始说话：申请屏幕唤醒锁', (await held()) === 1);
  await page.clock.runFor(31_000);
  check('说了 30 秒没碰：调暗（盖黑幕）', await veil());
  await page.mouse.click(200, 200);
  await page.clock.runFor(500);
  check('点一下：恢复亮度，屏幕仍保持亮着', !(await veil()) && (await held()) === 1);
  await page.evaluate(() => document.body.classList.remove('speaking'));
  await page.clock.runFor(1500);
  check('说完：放开唤醒锁', (await held()) === 0 && !(await veil()));
  await page.selectOption('#set-screen', 'system').catch(() => page.evaluate(() => { const s = document.getElementById('set-screen'); s.value = 'system'; s.dispatchEvent(new Event('change')); }));
  await page.evaluate(() => document.body.classList.add('speaking'));
  await page.clock.runFor(1500);
  check('跟随系统：说话也不占屏幕', (await held()) === 0);
  check('设置记住了', (await page.evaluate(() => window.__jarvis.settings.screenAwake)) === 'system');
  check('没有页面错误', errors.length === 0);
  if (errors.length) console.log(errors.join('\n'));
} finally {
  await browser.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} 屏幕常亮通过`);
process.exit(results.every(Boolean) ? 0 : 1);
