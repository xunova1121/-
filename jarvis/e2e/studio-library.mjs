/** 正式构建：真实文件、收藏/模板持久化、局部编辑、预览与草稿保护；不请求生成模型。 */
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { generate } from '../src/agent/docs.js';
import { createStudioLibrary } from '../src/agent/studioLibrary.js';
import { renderOffice } from '../server/officeRender.mjs';
import { openOfficePackage } from '../src/agent/officePackage.js';
import { digest } from '../src/agent/documentXml.js';
const out = path.resolve(process.argv[2] || '/tmp/weiyang-studio-library');
await mkdir(out, { recursive: true });
const results = [];
const check = (label, ok) => { results.push({ label, ok }); console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) throw new Error(label); };
const root = path.resolve('.');
const types = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const p = path.resolve(root, '.' + (pathname.startsWith('/assets/') ? '/dist' + pathname : pathname));
    if (!p.startsWith(root + path.sep)) throw new Error('path');
    const bytes = await readFile(p.endsWith('/') ? p + 'index.html' : p);
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const original = (await generate('docx', { title: '季度复盘', content: '# 季度复盘\n\n本季度完成十二个项目。\n\n## 下一步\n\n继续优化客户体验。', toc: false })).blob;
const raw = Buffer.from(await original.arrayBuffer()).toString('base64');
const browser = await chromium.launch();
try {
  for (const [width, theme] of [[390, 'day'], [320, 'night'], [1280, 'day']]) {
    const tag = `${width}-${theme}`;
    const ctx = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1, isMobile: width < 800 });
    await ctx.route('https://**/*', r => r.abort());
    await ctx.addInitScript(theme => localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme, speechOutput: false })), theme);
    const page = await ctx.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/${width < 800 ? 'dist-mobile' : 'dist'}/index.html`);
    await page.waitForFunction(() => window.__jarvis?.agents?.studioPanel);
    await page.evaluate(async raw => {
      document.querySelector('#app-splash')?.remove();
      const db = await new Promise((resolve, reject) => { const q = indexedDB.open('jarvis'); q.onsuccess = () => resolve(q.result); q.onerror = reject; });
      const blob = new Blob([Uint8Array.from(atob(raw), c => c.charCodeAt(0))]);
      await new Promise((resolve, reject) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put({ id: '作品/季度复盘.docx', data: blob, size: blob.size, mtime: Date.now() }); tx.oncomplete = resolve; tx.onerror = reject; }); db.close();
    }, raw);
    await page.evaluate(() => window.__jarvis.agents.openSquare());
    await page.waitForSelector('.wy-agent-favorite');
    const smallTargets = selector => page.evaluate(selector => [...document.querySelectorAll(selector)].filter(node => node.offsetParent && node.getBoundingClientRect().height < 43.5).map(node => node.textContent.trim()), selector);
    check(`${tag} 广场含收藏及折叠入口的触控高度至少44px`, (await smallTargets('.wy-agents button, .wy-agents input, .wy-hub summary')).length === 0);
    await page.locator('.wy-hub-workflows summary').click();
    check(`${tag} 展开流程后操作的触控高度至少44px`, (await smallTargets('.wy-hub button, .wy-hub summary')).length === 0);
    await page.locator('.wy-hub-workflows summary').click();
    await page.locator('.wy-agent-card-shell').filter({ has: page.locator('[data-agent="ppt-maker"]') }).locator('.wy-agent-favorite').click();
    await page.getByRole('tab', { name: '收藏', exact: true }).click();
    check(`${tag} 收藏筛选真实智能体`, await page.locator('.wy-agent-card[data-agent]').count() === 1);
    await page.getByRole('tab', { name: '全部', exact: true }).click();
    await page.locator('.wy-agents-search-input').fill('述职');
    await page.waitForTimeout(200);
    check(`${tag} 按任务词找到PPT`, await page.locator('[data-agent="ppt-maker"]').count() === 1);
    await page.locator('.wy-agents-search-input').fill(''); await page.waitForTimeout(200);
    await page.screenshot({ path: `${out}/square-${tag}.png` });
    await page.getByRole('button', { name: '我的作品', exact: true }).click();
    await page.waitForSelector('.wy-library-row');
    check(`${tag} 真实文件而非演示卡片`, (await page.locator('.wy-library-row').textContent()).includes('季度复盘'));
    await page.getByRole('button', { name: '打开与修改', exact: true }).click();
    await page.getByText('直接调整文字与格式 · 不调用模型', { exact: true }).click();
    check(`${tag} 作品编辑及版本入口的触控高度至少44px`, (await smallTargets('.wy-library button, .wy-library summary')).length === 0);
    await page.locator('[aria-label="原文字（须唯一匹配）"]').fill('本季度完成十二个项目');
    await page.locator('[aria-label="替换为"]').fill('本季度完成十五个项目');
    await page.getByRole('button', { name: '替换文字并另存', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wy-library h2')?.textContent.includes('-'));
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wy-studio-preview div')?.shadowRoot?.textContent.includes('十五个'));
    await page.screenshot({ path: `${out}/edit-preview-${tag}.png` });
    const docs = await page.evaluate(async () => {
      const db = await new Promise(resolve => { const q = indexedDB.open('jarvis'); q.onsuccess = () => resolve(q.result); });
      const rows = await new Promise(resolve => { const q = db.transaction('files').objectStore('files').getAll(); q.onsuccess = () => resolve(q.result); }); db.close();
      return Promise.all(rows.filter(r => r.id.endsWith('.docx')).map(async r => ({ path: r.id, data: Array.from(new Uint8Array(await r.data.arrayBuffer())) })));
    });
    const source = docs.find(x => x.path === '作品/季度复盘.docx'), edited = docs.find(x => x.path !== source.path);
    check(`${tag} 原件字节不变`, await digest(new Blob([new Uint8Array(source.data)])) === await digest(original));
    check(`${tag} 新文件读回已改字`, (await (await openOfficePackage(new Blob([new Uint8Array(edited.data)]))).file('word/document.xml').async('string')).includes('十五个'));
    await page.getByRole('button', { name: '存为我的模板', exact: true }).click();
    await page.waitForTimeout(150);
    await page.evaluate(() => window.__jarvis.agents.studioPanel.open('brand'));
    await page.getByPlaceholder('单位或品牌', { exact: true }).fill('测试团队');
    await page.getByRole('button', { name: '保存品牌样式', exact: true }).click();
    await page.evaluate(() => window.__jarvis.agents.studioPanel.open('templates'));
    await page.waitForSelector('.wy-library-row');
    await page.screenshot({ path: `${out}/templates-${tag}.png` });
    check(`${tag} 窄屏无横向溢出`, await page.evaluate(() => document.querySelector('.wy-library').scrollWidth <= document.querySelector('.wy-library').clientWidth + 1));
    await page.getByRole('button', { name: '用此模板', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#prompt').value.includes('测试团队'));
    check(`${tag} 模板+品牌只填草稿`, (await page.inputValue('#prompt')).includes('保留可编辑文字') && await page.locator('#transcript .msg').count() === 0);
    await page.reload(); await page.waitForFunction(() => window.__jarvis?.agents?.studioPanel);
    await page.evaluate(() => { document.querySelector('#app-splash')?.remove(); return window.__jarvis.agents.studioPanel.open('templates'); });
    await page.waitForSelector('.wy-library-row');
    check(`${tag} 模板刷新仍保留`, await page.locator('.wy-library-row').count() === 1);
    check(`${tag} 无页面异常`, errors.length === 0);
    await ctx.close();
  }
  // 真实Office渲染必须成功，不能以结构检查代替最终页面。
  const data = new Map(), prefs = new Map();
  const files = { ext: p => p.split('.').pop(), readBlob: async p => data.get(p), write: async (path, blob) => { data.set(path, blob); return { path }; } };
  const library = createStudioLibrary({ files, storage: { get: async id => prefs.get(id), put: async row => prefs.set(row.id, row) } });
  for (const kind of ['docx', 'pptx']) {
    const blob = kind === 'docx' ? original : (await generate('pptx', { title: '项目复盘', content: '# 项目成果\n\n本季度完成十二个项目。\n\n# 下一步\n\n继续优化客户体验。', cover: false })).blob;
    const file = '验收.' + kind; await files.write(file, blob);
    const structure = await library.inspect(file);
    const revised = await library.edit({ path: file, sha256: structure.sha256, replacements: [{ find: '十二个', replace: '十五个' }] });
    const result = await renderOffice(data.get(revised.path), kind);
    check(`${kind} 真实LibreOffice渲染成功`, result.available && result.blob.size > 1000);
    await writeFile(`${out}/edited.${kind}`, Buffer.from(await data.get(revised.path).arrayBuffer()));
    await writeFile(`${out}/edited-${kind}.pdf`, Buffer.from(await result.blob.arrayBuffer()));
  }
} finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2)); }
console.log(`通过 ${results.length} 项`);
