/** PC/手机版正式页面与服务器使用不同端口，保留浏览器跨域安全；不拦截/伪造业务响应。 */
import { chromium } from 'playwright';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { createServerClient } from '../src/core/serverClient.js';
import { BUILTIN_AGENTS } from '../src/agent/agentProfiles.js';
import { useBackend } from '../src/agent/store.js';
import { businessDay } from '../src/agent/businessSources.js';

const out = path.resolve(process.argv[2] || '/tmp/weiyang-agent-cross-origin');
await mkdir(out, { recursive: true });
const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-cross-origin-'));
const mode = createServerMode({ dataDir: dir, password: 'fixture-agent-cors-e2e', tenderCollector: {
  listing: async source => ({ rows: source.id === 'ccgp' ? [{ title: '农业设备采购（跨域验收夹具）', region: '江苏', type: 'tender', publishedAt: businessDay(), url: 'https://www.ccgp.gov.cn/cggg/dfgg/gkzb/fixture-cors.htm' }] : [] }),
  detail: async () => ({ budgetText: '100万元', detailAt: Date.now() })
} });
await mode.ready; await mode.tenders.refresh();
const server = createServer({ serverMode: mode });
const desktop = createServer({ staticDir: path.resolve('dist') });
const mobile = createServer({ staticDir: path.resolve('dist-mobile') });
for (const app of [server, desktop, mobile]) await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const owner = createServerClient({ base, token: tokenFor('fixture-agent-cors-e2e') });
const browser = await chromium.launch(), results = [], preflights = new Set();
server.on('request', req => { if (req.method === 'OPTIONS') preflights.add(new URL(req.url, base).pathname); });
const check = (name, ok) => { results.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) throw new Error(name); };
try {
  for (const [width, app] of [[1280, desktop], [390, mobile]]) {
    const user = await owner.createUser('跨域验收' + width);
    const login = await owner.loginAccount(user.accessCode);
    const client = createServerClient({ base, token: login.token });
    await client.upload('作品/跨域验证.md', new Blob(['# 我的跨域作品\n仅为本地测试文件。']));
    const context = await browser.newContext({ viewport: { width, height: 860 } });
    await context.addInitScript(({ base, token, userId }) => {
      localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token, userId, role: 'member', enabled: true }));
      localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false }));
    }, { base, token: login.token, userId: user.id });
    const page = await context.newPage(), errors = [], failed = [];
    // 不使用Playwright route：请求接管会影响Chromium自动预检；只禁止外部HTTPS。
    const network = await context.newCDPSession(page);
    await network.send('Network.enable');
    await network.send('Network.setBlockedURLs', { urls: ['https://*'] });
    page.on('pageerror', e => errors.push(e.message));
    page.on('requestfailed', r => { if (r.url().startsWith(base) && /\/api\/(agent-profiles|studio|tenders)(\/|\?|$)/.test(r.url())) failed.push(new URL(r.url()).pathname); });
    await page.goto('http://127.0.0.1:' + app.address().port);
    await page.waitForFunction(() => window.__jarvisServerClient?.agentProfiles && window.__jarvis?.agents);
    check(`${width} 页面和服务器确实跨域，普通会话接口可读`, await page.evaluate(async () => location.origin !== new URL(window.__jarvisServerClient.base).origin && Array.isArray(await window.__jarvisServerClient.listSessions())));
    await page.evaluate(() => { document.querySelector('#app-splash')?.remove(); window.__jarvis.agents.openSquare(); });
    await page.waitForFunction(() => document.querySelector('.wy-agent-favorite') || document.querySelector('.wy-agents-empty'));
    await page.screenshot({ path: `${out}/square-${width}.png` });
    check(`${width} 跨域加载9个智能体，不出现Failed to fetch`, await page.locator('.wy-agent-card[data-agent]').count() === 9 && await page.locator('.wy-agents-empty').count() === 0);
    const favorite = page.locator('.wy-agent-card-shell').filter({ has: page.locator('[data-agent="ppt-maker"]') }).locator('.wy-agent-favorite');
    await favorite.click(); await page.waitForFunction(() => document.querySelector('[aria-label="收藏PPT 制作"]')?.getAttribute('aria-pressed') === 'true');
    check(`${width} 收藏经跨域PATCH写到本人服务器`, (await client.studio.preferences()).favorites.includes('ppt-maker'));
    await page.getByRole('button', { name: '我的作品', exact: true }).click();
    await page.waitForSelector('.wy-library-row');
    check(`${width} 作品库读取本人远端文件`, (await page.locator('.wy-library-row').allTextContents()).some(x => x.includes('跨域验证')));
    await page.evaluate(() => window.__jarvis.agents.studioPanel.close());
    const profile = { ...structuredClone(BUILTIN_AGENTS[0]), id: 'cors-agent', name: '跨域私人助手', source: 'user' };
    const crud = await page.evaluate(async profile => {
      const api = window.__jarvisServerClient.agentProfiles;
      await api.createAgent(profile); await api.updateAgent(profile.id, { ...profile, name: '已更新的助手' });
      const found = await api.getAgent(profile.id); await api.removeAgent(profile.id);
      return found.name === '已更新的助手' && await api.getAgent(profile.id) === null;
    }, profile);
    check(`${width} 个人智能体跨域新增/修改/读取/删除可用`, crud);
    await page.locator('.wy-agent-card[data-agent="business-intelligence"]').click();
    await page.getByRole('tab', { name: '找招标', exact: true }).click();
    await page.waitForSelector('.wy-tender-card h3');
    check(`${width} 招投标目录通过远端接口展示`, (await page.locator('.wy-tender-card h3').first().textContent()).includes('跨域验收夹具'));
    await page.getByLabel('关键词 / 行业 / 企业名称').fill('农业');
    await page.getByRole('button', { name: '筛选公告', exact: true }).click();
    await page.locator('.wy-tender-subscribe summary').click();
    await page.getByLabel('订阅名称（可选）').fill('跨域订阅' + width);
    await page.getByRole('button', { name: '保存为自动订阅', exact: true }).click();
    await page.waitForFunction(name => document.querySelector('.wy-tender-body')?.textContent.includes(name), '跨域订阅' + width);
    check(`${width} 跨域订阅写入本人账号`, (await client.tenders.mine()).subscriptions.some(x => x.name === '跨域订阅' + width));
    const rejected = await page.evaluate(async () => {
      try { await window.__jarvisServerClient.tenders.configure(false); return null; }
      catch (error) { return error.status; }
    });
    check(`${width} 跨域放行后成员仍不能修改管理员设置`, rejected === 403);
    check(`${width} 页面无脚本异常或资源接口连接失败`, errors.length === 0 && failed.length === 0);
    await context.close();
  }
  for (const route of ['/api/agent-profiles', '/api/agent-profiles/cors-agent', '/api/studio/preferences', '/api/studio/works', '/api/tenders/catalog', '/api/tenders/mine']) {
    check(`浏览器真实发出预检 ${route}`, preflights.has(route));
  }
  check('没有产生模型任务', mode.runner.list().length === 0);
} finally {
  await browser.close(); await mode.tenders.stop(); await mode.runner.settled();
  for (const app of [server, desktop, mobile]) { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
  useBackend(null); await rm(dir, { recursive: true, force: true });
  await writeFile(out + '/results.json', JSON.stringify(results, null, 2));
  await writeFile(out + '/preflights.json', JSON.stringify([...preflights].sort(), null, 2));
}
console.log(`跨域智能体资源 ${results.length}/${results.length} 通过`);
