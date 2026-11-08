/** 两个真实浏览器身份经HTTP访问私人作品及共享库，不请求模型。 */
import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.mjs';
import { createServerMode, tokenFor } from '../server/serverMode.mjs';
import { createServerClient } from '../src/core/serverClient.js';
import { generate } from '../src/agent/docs.js';
import { useBackend } from '../src/agent/store.js';
const out = path.resolve(process.argv[2] || '/tmp/weiyang-studio-team'); await mkdir(out, { recursive: true });
const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-team-e2e-'));
const mode = createServerMode({ dataDir: dir, password: 'fixture-studio-e2e' }); await mode.ready;
const server = createServer({ serverMode: mode, staticDir: path.resolve('dist-mobile') });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = 'http://127.0.0.1:' + server.address().port;
const owner = tokenFor('fixture-studio-e2e');
const api = async (route, token, body) => { const r = await fetch(base + route, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error('fixture HTTP ' + r.status); return r.json(); };
const results = []; const check = (label, ok) => { results.push({ label, ok }); console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) throw new Error(label); };
const browser = await chromium.launch();
try {
  const members = [];
  for (const name of ['甲', '乙']) {
    const user = await api('/api/server/users', owner, { name });
    const login = await api('/api/server/login', '', { password: user.accessCode });
    const client = createServerClient({ base, token: login.token });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route('https://**/*', route => route.abort());
    await ctx.addInitScript(({ base, login, user }) => {
      localStorage.setItem('jarvis.server.v1', JSON.stringify({ url: base, token: login.token, enabled: true, userId: user.id, role: 'member' }));
    }, { base, login, user });
    const page = await ctx.newPage(); const loaded = page.waitForResponse(r => r.url().includes('/api/sessions') && r.ok());
    await page.goto(base); await loaded; await page.waitForFunction(() => window.__jarvis?.agents?.studioPanel);
    await page.evaluate(() => document.querySelector('#app-splash')?.remove());
    members.push({ client, page, ctx });
  }
  const [a, b] = members;
  const doc = (await generate('docx', { title: '团队稿件', content: '甲的原件内容，修改不能覆盖。', toc: false })).blob;
  await a.client.upload('私人资料/团队稿件.docx', doc);
  await b.client.upload('乙的私稿.txt', new Blob(['乙的内容']));
  await a.page.evaluate(async () => { await window.__jarvis.workspace.write('私人资料/团队稿件.docx', '本机同名文件必须保留'); await window.__jarvis.agents.studioPanel.open('works'); });
  await a.page.waitForSelector('.wy-library-row');
  await a.page.getByRole('button', { name: '打开与修改', exact: true }).click();
  await a.page.getByRole('button', { name: '预览', exact: true }).click();
  await a.page.waitForSelector('.wy-studio-preview canvas', { timeout: 60000 });
  await a.page.waitForFunction(() => {
    const canvas = document.querySelector('.wy-studio-preview canvas');
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 200) return true;
    return false;
  });
  await a.page.getByRole('button', { name: '放大查看', exact: true }).click();
  check('手机PDF可放大阅读再恢复适合宽度', await a.page.evaluate(() => document.querySelector('.wy-studio-preview canvas').getBoundingClientRect().width > document.querySelector('.wy-studio-preview').clientWidth));
  await a.page.getByRole('button', { name: '适合宽度', exact: true }).click();
  check('云端真实PDF预览未覆盖本机同名文件', await a.page.evaluate(async () => (await window.__jarvis.workspace.readBlob('私人资料/团队稿件.docx')).text()) === '本机同名文件必须保留');
  await a.page.screenshot({ path: out + '/cloud-preview.png' });
  await a.page.getByRole('button', { name: '发布到团队', exact: true }).click();
  check('发布前明确确认共享范围', (await a.page.locator('.wy-library-confirm').textContent()).includes('不会共享对话和私人目录'));
  await a.page.locator('.wy-library-confirm').getByRole('button', { name: '确认', exact: true }).click();
  await a.page.waitForFunction(() => !document.querySelector('.wy-library-confirm'));
  await b.page.evaluate(() => window.__jarvis.agents.studioPanel.open('team'));
  await b.page.waitForSelector('.wy-library-row');
  check('成员能看到已共享的文件，不能撤回别人共享', (await b.page.locator('.wy-library-row').textContent()).includes('团队稿件') && await b.page.getByRole('button', { name: '撤回共享', exact: true }).count() === 0);
  check('共享界面不显示原私人目录', !(await b.page.locator('.wy-library').textContent()).includes('私人资料/'));
  await b.page.screenshot({ path: out + '/team-member.png' });
  await b.page.getByRole('button', { name: '复制到我的作品', exact: true }).click();
  await b.page.waitForFunction(() => document.querySelector('.wy-library h2')?.textContent === '我的作品');
  await b.page.waitForSelector('.wy-library-row');
  check('复制后本人作品出现两份，原稿仍留在发布者', await b.page.locator('.wy-library-row').count() === 2 && (await a.client.studio.list()).length === 1);
  await a.page.evaluate(() => window.__jarvis.agents.studioPanel.open('team'));
  await a.page.getByRole('button', { name: '撤回共享', exact: true }).click();
  await a.page.locator('.wy-library-confirm').getByRole('button', { name: '确认', exact: true }).click();
  await a.page.waitForFunction(() => document.querySelector('.wy-library-empty'));
  check('发布者撤回生效，领取副本不被删除', (await b.client.studio.team()).length === 0 && (await b.client.studio.list()).length === 2);
  for (const member of members) await member.ctx.close();
} finally { await browser.close(); await mode.runner.settled(); server.closeAllConnections(); await new Promise(r => server.close(r)); useBackend(null); await rm(dir, { recursive: true, force: true }); await writeFile(out + '/results.json', JSON.stringify(results, null, 2)); }
console.log(`通过 ${results.length} 项`);
