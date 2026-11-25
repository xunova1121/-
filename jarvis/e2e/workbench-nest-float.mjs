/**
 * 电脑小窝：对话浮在房间上（2026-11-25 用户：PC 端小窝有问题，借鉴手机那种浮在上面的对话）。
 * 用法：npm run build && node e2e/workbench-nest-float.mjs [截图目录]
 * 核对：房间用满工作台、对话框整个落在房间画面里、不挡地毯上的猫；翻聊天记录再收起房间大小不变；任务工位仍是原来的左右布局。
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../server/server.mjs';

const out = path.resolve(process.argv[2] || '/tmp/weiyang-nest-float');
await mkdir(out, { recursive: true });
const server = createServer({ staticDir: path.resolve('dist'), ollama: null });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ' ' + detail}`); if (!ok) failed++; };
try {
  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    const tag = `${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height } });
    await context.route('https://**/*', route => route.abort());
    await context.addInitScript(() => {
      localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'mock' }));
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ speechOutput: false, theme: 'day' }));
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.__jarvis, null, { timeout: 60000 });
    await page.evaluate(() => document.querySelector('#app-splash')?.remove());
    await page.locator('.wb-tabs').getByRole('button', { name: '工作台', exact: true }).click();
    await page.locator('.wb-desk[data-desk-chat=preview] .ws-scene[data-room-view="nest"]').waitFor();
    // 猫在房间忙时会暂停可点，和对话位置无关；与 conversation-guide 一致，在发消息前核对
    check(`${tag} 地毯上的猫没被对话挡住、可以点`, await page.locator('.wb-desk [data-furniture="cat"]').evaluate(el => {
      const b = el.getBoundingClientRect();
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest('[data-furniture="cat"]') === el;
    }));
    await page.fill('#prompt', '你好'); await page.click('#btn-send');
    await page.waitForFunction(() => !document.body.classList.contains('generating'));
    const box = sel => page.locator(sel).first().evaluate(el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; });
    const scene = await box('.wb-desk .ws-scene'), chat = await box('.wb-desk-chat'), desk = await box('.wb-desk');
    check(`${tag} 房间用满工作台高度（对话不再占房间下面一整行）`, scene.h >= desk.h * 0.85, JSON.stringify({ scene, desk }));
    check(`${tag} 对话框整个浮在房间画面里`, chat.x >= scene.x - 1 && chat.r <= scene.r + 1 && chat.y >= scene.y - 1 && chat.b <= scene.b + 1, JSON.stringify({ scene, chat }));
    check(`${tag} 房间下面的任务记录条收起`, !(await page.locator('.wb-desk .ws-timeline').isVisible()));
    await page.screenshot({ path: path.join(out, `nest-float-${tag}.png`) });
    await page.getByRole('button', { name: '聊天记录', exact: true }).click();
    await page.locator('.wb-desk[data-desk-chat=history]').waitFor();
    const historyScene = await box('.wb-desk .ws-scene');
    check(`${tag} 翻聊天记录时房间大小不变`, Math.abs(historyScene.h - scene.h) < 2 && Math.abs(historyScene.w - scene.w) < 2, JSON.stringify({ scene, historyScene }));
    await page.getByRole('button', { name: '收起记录', exact: true }).click();
    await page.locator('.wb-desk[data-desk-chat=preview]').waitFor();
    const backScene = await box('.wb-desk .ws-scene');
    check(`${tag} 收起记录后房间大小不变`, Math.abs(backScene.h - scene.h) < 2, JSON.stringify({ scene, backScene }));
    await page.locator('[data-action="work-floor"]').first().click();
    await page.locator('.wb-desk .ws-scene:not([data-room-view="nest"])').waitFor();
    const floorDesk = await page.locator('.wb-desk').evaluate(el => getComputedStyle(el).display);
    const floorChat = await box('.wb-desk-chat'), floorScene = await box('.wb-desk .ws-scene');
    check(`${tag} 任务工位仍是原来的左右布局`, floorDesk === 'grid' && floorChat.x >= floorScene.r - 1, JSON.stringify({ floorDesk, floorChat, floorScene }));
    check(`${tag} 无页面异常`, errors.length === 0, errors.join(' | '));
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? `电脑小窝浮动对话 ${failed} 项未通过` : '电脑小窝浮动对话全部通过');
process.exit(failed ? 1 : 0);
