import { chromium } from 'playwright';
const out = process.argv[2], tag = process.argv[3] || 'a';
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const theme of ['night', 'day']) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => { try { sessionStorage.setItem('jarvis.booted', '1'); const s = JSON.parse(localStorage.getItem('jarvis.settings.v1') || '{}'); } catch {} }, theme);
  const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:8787/');
  await p.waitForFunction(() => window.__jarvis?.showPanel);
  await p.click(`#set-theme [data-v="${theme}"]`).catch(async () => { await p.evaluate(() => window.__jarvis.showPanel('settings')); await p.click(`#set-theme [data-v="${theme}"]`); });
  await p.evaluate(() => window.__jarvis.showPanel('skills'));
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `${out}/pc-${tag}-${theme}-skills.png` });
  await p.fill('#prompt', '帮我写一份周报提纲');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(5000);
  await p.screenshot({ path: `${out}/pc-${tag}-${theme}-chat.png` });
  await ctx.close();
}
await b.close();
