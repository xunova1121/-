/** 真正启动 Electron：未央说话时阻止显示器休眠，说完放开。 */
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-screen-'));
const results = [];
const check = (label, ok) => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${label}`); };
let app;
try {
  app = await electron.launch({ executablePath: path.join(root, 'desktop/node_modules/electron/dist/electron'), args: [path.join(root, 'desktop'), '--no-sandbox'], env: { ...process.env, HOME: home, JARVIS_HOME: path.join(home, '.jarvis'), JARVIS_DESKTOP_TEST: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const main = await app.firstWindow();
  await main.waitForFunction(() => window.__jarvis, null, { timeout: 60000 });
  // 记下阻止休眠的开关
  await app.evaluate(({ powerSaveBlocker }) => {
    globalThis.__blocks = new Set();
    let n = 0;
    powerSaveBlocker.start = (type) => { const id = ++n; globalThis.__blocks.add(`${id}:${type}`); return id; };
    powerSaveBlocker.stop = (id) => { for (const b of globalThis.__blocks) if (b.startsWith(`${id}:`)) globalThis.__blocks.delete(b); };
  });
  const blocks = () => app.evaluate(() => [...globalThis.__blocks]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  check('没说话时不阻止休眠', (await blocks()).length === 0);
  await main.evaluate(() => document.body.classList.add('speaking'));
  await wait(1500);
  check('说话时阻止显示器休眠', JSON.stringify(await blocks()) === JSON.stringify(['1:prevent-display-sleep']));
  await main.evaluate(() => document.body.classList.remove('speaking'));
  await wait(1500);
  check('说完放开', (await blocks()).length === 0);
} finally {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(`${results.filter(Boolean).length}/${results.length} 电脑版屏幕常亮通过`);
process.exit(results.length && results.every(Boolean) ? 0 : 1);
