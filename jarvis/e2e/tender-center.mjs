/** 三端共用正式页面、真实HTTP双账号；上游用明确夹具，不调用模型或收费API。 */
import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { useBackend } from '../src/agent/store.js';
import { businessDay } from '../src/agent/businessSources.js';
const out = path.resolve(process.argv[2] || '/tmp/weiyang-tender-ui'); await mkdir(out, { recursive: true });
const dir = await mkdtemp(path.join(os.tmpdir(), 'tender-e2e-'));
let records = [], failSource = false;
const notice = id => ({ title: `江苏智慧农业监测平台建设项目${id}公开招标公告`, region: '江苏', type: 'tender', publishedAt: businessDay(),
  url: `https://www.ccgp.gov.cn/cggg/dfgg/gkzb/fixture-${id}.htm`, snippet: '农业监测设备与平台建设（本地验收夹具）' });
const collector = {
  async listing(source) { if (failSource && source.id === 'ccgp') throw Object.assign(new Error('fixture unavailable'), { code: 'TENDER_HTTP', status: 503 }); return { rows: source.id === 'ccgp' ? records : [], partial: false }; },
  async detail() { return { budgetText: '320万元', deadlineText: '2026年11月30日 09:00', excerpt: '项目编号：TEST-2026-01\n采购需求：农业物联网监测平台。\n资格要求：请核对原文。', detailAt: Date.now() }; }
};
const mode = createServerMode({ dataDir: dir, password: 'fixture-tender-e2e', tenderCollector: collector }); await mode.ready;
const server = createServer({ serverMode: mode, staticDir: path.resolve('dist-mobile') });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const desktopServer = createServer({ serverMode: mode, staticDir: path.resolve('dist') });
await new Promise(resolve => desktopServer.listen(0, '127.0.0.1', resolve));
const desktopBase = 'http://127.0.0.1:' + desktopServer.address().port;
const base = 'http://127.0.0.1:' + server.address().port, owner = tokenFor('fixture-tender-e2e');
const api = async (route, token, body) => { const r = await fetch(base + route, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error('fixture HTTP ' + r.status); return r.json(); };
const results = []; const check = (label, ok) => { results.push({ label, ok }); console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) throw new Error(label); };
const browser = await chromium.launch();
try {
  records = [notice(1), { ...notice(2), type: 'correction', title: '江苏智慧农业监测平台项目2延期更正公告' }];
  await mode.tenders.refresh();
  for (const [width, theme] of [[320, 'day'], [390, 'day'], [412, 'night'], [1280, 'day']]) {
    const entry = width >= 800 ? desktopBase : base;
    const user = await api('/api/server/users', owner, { name: `验收${width}` });
    const login = await api('/api/server/login', '', { password: user.accessCode });
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 800 });
    await ctx.route('https://**/*', route => route.abort());
    await ctx.addInitScript(({ base, login, user, theme }) => {
      if (location.origin !== base) return;
      localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token: login.token, enabled: true, userId: user.id, role: 'member' }));
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme, speechOutput: false }));
    }, { base: entry, login, user, theme });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.log('页面异常：' + error.stack); });
    await page.goto(entry); await page.waitForFunction(() => window.__jarvisServerClient?.tenders && window.__jarvis?.agents);
    await page.evaluate(async () => { document.querySelector('#app-splash')?.remove(); const app = window.__jarvis; await app.agents.start(await app.agents.profileOf('business-intelligence')); });
    await page.getByRole('tab', { name: '找招标', exact: true }).click();
    await page.waitForSelector('.wy-tender-card h3');
    check(`${width} 打开即有公告，无需发送对话`, (await page.locator('.wy-tender-card').count()) >= 2 && mode.runner.list().length === 0);
    check(`${width} 显示预算、截止与原文，成员无全局管理按钮`, (await page.locator('.wy-tender-body').textContent()).includes('320万元') && await page.locator('.wy-tender-admin').count() === 0);
    await page.getByLabel('关键词 / 行业 / 企业名称').fill('农业');
    await page.getByLabel('项目地区（如江苏）').fill('江苏');
    await page.getByRole('button', { name: '筛选公告', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wy-tender-message').textContent.includes('每30分钟'));
    await page.locator('.wy-tender-subscribe summary').click();
    await page.getByLabel('订阅名称（可选）').fill('我的农业项目');
    await page.getByRole('button', { name: '保存为自动订阅', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wy-tender-body').textContent.includes('我的农业项目'));
    check(`${width} 订阅落盘，不产生模型任务`, mode.runner.list().length === 0);
    // 关闭页面后采集，重新进入后仍可查看个人提醒。
    await page.goto('about:blank'); records = [...records, notice(width)]; await mode.tenders.refresh();
    await page.goto(entry); await page.waitForFunction(() => window.__jarvisServerClient?.tenders && window.__jarvis?.agents);
    await page.evaluate(async () => { document.querySelector('#app-splash')?.remove(); const app = window.__jarvis; await app.agents.start(await app.agents.profileOf('business-intelligence')); });
    await page.getByRole('tab', { name: '找招标', exact: true }).click();
    await page.getByRole('tab', { name: /^提醒/ }).click();
    await page.waitForFunction(width => document.querySelector('.wy-tender-tabs [aria-selected="true"]')?.textContent.startsWith('提醒') && document.querySelector('.wy-tender-body').textContent.includes(`项目${width}`), width);
    check(`${width} App关闭期间照常匹配，提醒重新打开可见`, (await page.locator('.wy-tender-body').textContent()).includes('未读'));
    await page.getByRole('button', { name: '全部标为已读', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.wy-tender-body').textContent.includes('未读'));
    await page.getByRole('tab', { name: '最新公告', exact: true }).click();
    await page.waitForSelector('.wy-tender-card h3');
    await page.getByRole('button', { name: '收藏', exact: true }).first().click();
    await page.getByRole('tab', { name: '我的收藏', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wy-tender-message').textContent.includes('筛选 1 条'));
    check(`${width} 收藏与提醒属于本人`, await page.locator('.wy-tender-card').count() === 1);
    await page.getByRole('button', { name: '请未央解读', exact: true }).click();
    check(`${width} 解读只填草稿，由用户决定调用模型`, (await page.inputValue('#prompt')).includes('https://www.ccgp.gov.cn/') && mode.runner.list().length === 0);
    await page.getByRole('tab', { name: '最新公告', exact: true }).click();
    await page.waitForSelector('.wy-tender-card h3');
    await page.evaluate(() => { document.activeElement?.blur(); document.querySelector('#transcript').scrollTop = 0; });
    check(`${width} 无横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.wy-tender-center').scrollWidth <= document.querySelector('#transcript').clientWidth));
    check(`${width} 主要操作触控高度至少44`, await page.locator('.wy-tender-center button').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length).every(n => n.getBoundingClientRect().height >= 44)));
    await page.screenshot({ path: `${out}/tenders-${width}-${theme}.png`, fullPage: true });
    check(`${width} 无页面异常`, errors.length === 0);
    await ctx.close();
  }
  failSource = true; await mode.tenders.refresh();
  check('来源失败不清空公告，保留成功时间与503证据', (await mode.tenders.list()).sources[0].error.http === 503 && (await mode.tenders.list()).total >= 2);
} finally {
  await browser.close(); await mode.tenders.stop(); await mode.runner.settled(); server.closeAllConnections(); desktopServer.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => desktopServer.close(resolve))]); useBackend(null); await rm(dir, { recursive: true, force: true });
  await writeFile(out + '/results.json', JSON.stringify(results, null, 2));
}
console.log(`通过 ${results.length} 项`);
