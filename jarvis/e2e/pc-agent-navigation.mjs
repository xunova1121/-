/** PC正式页面导航回归：本机临时数据，无模型/外网调用；PREVIEW仅用于开发期布局预览。 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
const output = path.resolve(process.argv[2] || '/tmp/weiyang-pc-agents'); await mkdir(output, { recursive: true });
const preview = process.env.WEIYANG_PC_PREVIEW_URL;
const server = preview ? null : createServer({ staticDir: path.resolve('dist') });
if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = preview || 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch(), results = [];
const check = (name, ok) => { results.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) throw new Error(name); };
try {
  for (const [width, height, frame] of [[1440, 900, false], [1280, 820, false], [1024, 600, false], [760, 700, false], [1280, 720, true]]) {
    const tag = `${width}-${height}${frame ? '-titlebar' : ''}`, context = await browser.newContext({ viewport: { width, height } });
    await context.route('https://**/*', route => route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base); await page.waitForFunction(() => window.__jarvis?.agents && document.querySelector('.wb-agent-square'));
    await page.evaluate(() => document.querySelector('#app-splash')?.remove());
    // 使用真实个人历史库，短窗口也必须能看到四条记录与查看更多。
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('jarvis'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      await new Promise((resolve, reject) => { const t = db.transaction('sessions', 'readwrite'); for (let i = 0; i < 6; i++) t.objectStore('sessions').put({ id: 'pc-nav-' + i, title: ['项目需求整理', '本周工作计划', '企业与招投标', '演示文稿修改', '资料核对', '学习笔记'][i], createdAt: Date.now() - i * 1000, updatedAt: Date.now() - i * 1000, messages: [] }); t.oncomplete = resolve; t.onerror = () => reject(t.error); }); db.close();
    });
    await page.waitForSelector('.wb-history-list .wb-chat:nth-child(4)');
    if (frame) await page.evaluate(() => {
      document.body.classList.add('weiyang-desktop'); const bar = document.createElement('div'); bar.className = 'weiyang-titlebar'; bar.textContent = '未央 · 标题栏布局验收'; document.body.prepend(bar);
    });
    await page.fill('#prompt', '这段草稿切换页面后应保留');
    const entry = page.locator('.rail [data-destination="agents"]');
    if (width === 1440) {
      // 固定打开页与下一帧的顺序，复现慢机器上返回按钮抢走搜索输入焦点。
      await page.evaluate(() => {
        const original = window.requestAnimationFrame;
        window.__agentOpenFrames = [];
        window.requestAnimationFrame = callback => { window.__agentOpenFrames.push(callback); return 0; };
        try { document.querySelector('.rail [data-destination="agents"]').click(); }
        finally { window.requestAnimationFrame = original; }
      });
      await page.locator('.wy-agents-search-input').fill('招投标');
      await page.evaluate(() => { for (const callback of window.__agentOpenFrames) callback(performance.now()); delete window.__agentOpenFrames; });
      check('打开后的下一帧不能抢走搜索框焦点', await page.locator('.wy-agents-search-input').evaluate(n => n === document.activeElement));
      await page.waitForFunction(() => document.querySelectorAll('.wy-agent-card[data-agent]').length === 1);
      await page.locator('.wy-agents-search-input').fill('');
      await page.waitForFunction(() => document.querySelectorAll('.wy-agent-card[data-agent]').length === 9);
      check('清空搜索恢复全部智能体', await page.inputValue('.wy-agents-search-input') === '');
      await page.locator('.wb-agent-square .wy-agents-back').click();
    }
    check(`${tag} 入口位于新建对话后，顶栏不再重复`, await entry.evaluate(n => n.previousElementSibling?.classList.contains('wb-new')) && await page.locator('.topbar [data-destination="agents"]').count() === 0);
    await entry.click(); await page.waitForSelector('.wb-agent-square:not([hidden]) .wy-agent-card[data-agent]');
    await page.waitForFunction(() => document.querySelector('.rail [data-destination="agents"]').getAttribute('aria-current') === 'page');
    check(`${tag} 广场在主内容区，左栏仍可见`, await page.evaluate(() => document.querySelector('.wb-agent-square').getBoundingClientRect().left >= document.querySelector('.rail').getBoundingClientRect().right - 1));
    check(`${tag} 不溢出，分类与9个智能体保留`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.wy-agents-body').scrollWidth <= document.querySelector('.wy-agents-body').clientWidth + 1 && document.querySelectorAll('.wy-agent-card[data-agent]').length === 9));
    check(`${tag} 四条历史、查看更多、设置均留在窗口内`, await page.evaluate(() => {
      const recent = document.querySelector('.wb-recent').getBoundingClientRect(), foot = document.querySelector('.wb-bottom').getBoundingClientRect(), more = document.querySelector('.wb-recent-more').getBoundingClientRect();
      return [...document.querySelectorAll('.wb-chat')].every(n => { const r = n.getBoundingClientRect(); return r.top >= recent.top && r.bottom <= recent.bottom; }) && more.bottom <= recent.bottom + 1 && foot.bottom <= innerHeight && foot.top >= recent.bottom;
    }));
    await page.locator('.wy-agents-search-input').fill('招投标');
    await page.waitForFunction(() => document.querySelectorAll('.wy-agent-card[data-agent]').length === 1);
    await page.locator('.rail [data-destination="workspace"]').click();
    await page.waitForFunction(() => document.querySelector('.wb-agent-square').hidden && document.querySelector('.rail [data-destination="workspace"]').getAttribute('aria-current') === 'page');
    check(`${tag} 切换文件空间关闭广场且保留草稿`, await page.inputValue('#prompt') === '这段草稿切换页面后应保留');
    await entry.click(); await page.waitForSelector('.wb-agent-square:not([hidden]) .wy-agent-card[data-agent]');
    check(`${tag} 返回广场保留搜索条件`, await page.inputValue('.wy-agents-search-input') === '招投标');
    await page.locator('.wy-agents-search-input').fill(''); await page.waitForFunction(() => document.querySelectorAll('.wy-agent-card[data-agent]').length === 9);
    await page.locator('.wb-rail-toggle').click(); await page.waitForFunction(() => document.body.classList.contains('wb-rail-folded'));
    check(`${tag} 折叠导航仍可打开并正确铺满内容`, await entry.isVisible() && await page.locator('.wb-agent-square').evaluate(n => Math.abs(n.getBoundingClientRect().left - 76) < 1));
    await page.locator('.wb-rail-toggle').click();
    await page.locator('.wb-agent-square .wy-agent-card[data-agent="health-advisor"]').click();
    await page.waitForSelector('.wy-agent-start[data-agent="health-advisor"]');
    check(`${tag} 选择智能体进入原对话起始页`, await page.locator('.wb-agent-square').evaluate(n => n.hidden) && await page.locator('.wy-agent-starter').count() === 3);
    await page.locator('.wy-agent-back-link').click(); await page.waitForSelector('.wb-agent-square:not([hidden])');
    await page.locator('.wb-agent-square .wy-agents-back').click();
    check(`${tag} 返回对话保留智能体起始页`, await page.locator('.wy-agent-start[data-agent="health-advisor"]').isVisible());
    // 非侧栏的入口（命令、页面内部）也应从已打开的功能面板正确进入。
    await page.evaluate(() => { window.__jarvis.showPanel('models'); window.__jarvis.agents.openSquare(); });
    await page.waitForSelector('.wb-agent-square:not([hidden]) .wy-agent-card[data-agent]');
    check(`${tag} 从设置打开广场不被旧面板挡住`, await page.evaluate(() => document.body.classList.contains('side-closed')));
    await page.evaluate(() => { const pill = document.querySelector('#update-pill'); pill.hidden = false; pill.textContent = '重启以更新'; });
    check(`${tag} 顶栏更新入口未被广场覆盖`, await page.locator('#update-pill').evaluate(n => { const r = n.getBoundingClientRect(); return r.height > 0 && r.bottom <= document.querySelector('.wb-agent-square').getBoundingClientRect().top && n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }));
    await page.evaluate(() => { document.querySelector('#update-pill').hidden = true; document.querySelector('.wb-agent-square .wy-agents-body').scrollTop = 0; document.activeElement?.blur(); });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${output}/agents-${tag}.png` });
    check(`${tag} 无页面异常`, errors.length === 0);
    await context.close();
  }
} finally {
  await browser.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(output + '/navigation-results.json', JSON.stringify(results, null, 2));
}
console.log(`PC导航 ${results.length}/${results.length} 通过`);
