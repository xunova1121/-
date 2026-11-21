/** 真实工具产物、HTTP原字节、手机/PC浏览器；云端API为受控夹具，不冒充用户服务器或真机。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { createFileStore } from '../server/fileStore.mjs';
import { useBackend, collection } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { createPosterTool } from '../src/agent/posterTool.js';
import { renderPoster } from '../server/posterRaster.mjs';
import { listWorkRecords } from '../src/agent/workLedger.js';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-poster-cloud-delivery');
await fs.mkdir(output, { recursive: true });
const store = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-cloud-files-'));
useBackend(createFileStore(store));
const checks = [];
const check = (label, pass) => { checks.push({ label, pass: Boolean(pass) }); console.log(`${pass ? '✓' : '✗'} ${label}`); assert.ok(pass, label); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sessionId = 'poster-cloud-fixture';
await collection('sessions').put({ id: sessionId, messages: [] });
const receipt = JSON.parse(await createPosterTool({ renderPoster }).run({ title: '云端源文件验收', subtitle: '中文文字可编辑', width: 1080, height: 1920, lines: ['保留原文件', '按需下载，不压缩'], path: '海报/云端验收.png' }, { sessionId, executionScope: {}, rawRequestText: '制作一张海报' }));
const record = (await listWorkRecords({ kind: 'image', status: '' })).items[0];
check('使用真实海报工具产物及真实来源索引', receipt.files.length >= 3 && record?.sourceFiles.some(p => p.endsWith('.pptx')));
const assets = new Map();
for (const file of await ws.list()) assets.set(file.path, { ...file, bytes: Buffer.from(await (await ws.readBlob(file.path)).arrayBuffer()) });
const original = record.files[0];
const sourceSvg = record.sourceFiles.find(p => p.endsWith('.svg'));
const sourcePptx = record.sourceFiles.find(p => p.endsWith('.pptx'));
const png = assets.get(original).bytes;
const attempt = n => original.replace(/\/attempt-\d+\//, `/attempt-${n}/`);
for (const n of [2, 3]) assets.set(attempt(n), { path: attempt(n), size: png.length, mtime: Date.now(), bytes: png });
record.files = [attempt(3)];
const requests = [];
const html = (await fs.readFile('index.html', 'utf8')).replace(/<script\b[\s\S]*?<\/script>/gi, '');
const server = await createServer({ configFile: false, define: { __STANDALONE__: 'true', __MOBILE__: 'false' }, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'poster-cloud-fixture', configureServer(vite) {
  vite.middlewares.use((req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__cloud-poster.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    if (!url.pathname.startsWith('/api/')) return next();
    if (req.headers.authorization !== 'Bearer fixture-only') { res.writeHead(401); res.end('{}'); return; }
    requests.push({ path: url.pathname, file: url.searchParams.get('path') });
    if (url.pathname === '/api/files') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([...assets.values()].map(({ bytes, ...meta }) => meta))); return;
    }
    if (url.pathname === '/api/files/raw') {
      const asset = assets.get(url.searchParams.get('path'));
      if (!asset) { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(asset.bytes); return;
    }
    if (url.pathname === '/api/work-records') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ items: [record] })); return; }
    res.writeHead(404); res.end('{}');
  });
} }] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    await page.goto(base + '/__cloud-poster.html');
    await page.evaluate(async ({ base, primary, pngBase64 }) => {
      const { initPanels } = await import('/src/ui/panels.js');
      const { createWorkspaceFiles } = await import('/src/app/workspaceFiles.js');
      const { createServerClient } = await import('/src/core/serverClient.js');
      const { Transcript } = await import('/src/ui/transcript.js');
      const { createRemoteTask } = await import('/src/app/remoteTask.js');
      const ws = await import('/src/agent/workspace.js');
      await ws.write(primary, new Blob([Uint8Array.from(atob(pngBase64), c => c.charCodeAt(0))]));
      const app = { server: createServerClient({ base, token: 'fixture-only' }) };
      const getWorkspace = createWorkspaceFiles(app);
      const panels = initPanels({ settings: {}, toast: text => { window.lastToast = text; }, getGateway: () => null,
        getWorkspace, getWorkspaceScope: () => app.server ? 'server:' + app.server.base : 'local',
        getWorkRecords: options => app.server.listWorkRecords(options) });
      app.panels = panels;
      app.openInWorkspace = panels.openFile;
      const transcript = new Transcript(document.querySelector('#transcript'), { progress: true });
      const bubble = transcript.add('agent');
      const turn = { bubble, files: new Set(), ctrl: new AbortController() };
      window.fixture = { app, panels, getWorkspace, bubble, turn, remote: createRemoteTask(app), ws, transcript };
      document.body.classList.add('side-open');
      for (const pane of document.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== 'workspace';
      // 只把既有工作区组件放到可见全宽容器，不改组件内部布局。
      Object.assign(document.querySelector('#panel').style, { position: 'relative', width: '100%', maxWidth: '100%', height: 'auto', inset: 'auto', transform: 'none', display: 'block' });
      document.querySelector('#transcript').style.display = 'none';
      await panels.refreshFiles();
    }, { base, primary: attempt(3), pngBase64: png.toString('base64') });
    check(`${width}px：本机仅PNG仍显示三份云端源文件`, await page.locator('.ws-poster-files summary').first().textContent() === '源文件（3）');
    check(`${width}px：列表没有提前下载SVG或PPTX`, !requests.some(r => r.file === sourceSvg || r.file === sourcePptx));
    check(`${width}px：云端工作区标记正确，不误称浏览器内`, await page.locator('#ws-mode').textContent() === '云服务器');
    await page.locator('.ws-poster-files summary').first().click();
    const svgButton = page.locator('.ws-poster-files').first().getByRole('button', { name: /\.svg$/ });
    await svgButton.click();
    await page.waitForFunction(() => { const img = document.querySelector('#viewer-body img'); return img?.complete && img.naturalWidth === 1080; });
    check(`${width}px：SVG经HTTP原字节读取并真实解码，不是白页`, await page.locator('#viewer-body img').evaluate(img => img.naturalHeight === 1920));
    const colors = await page.locator('#viewer-body img').evaluate(img => {
      const canvas = document.createElement('canvas'); canvas.width = 180; canvas.height = 320;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, 180, 320);
      const data = ctx.getImageData(0, 0, 180, 320).data;
      const values = new Set();
      for (let i = 0; i < data.length; i += 4) if (data[i + 3]) values.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      return values.size;
    });
    check(`${width}px：SVG实际绘制有多色像素，不只检查文件尺寸`, colors > 100);
    const svgDownload = page.waitForEvent('download');
    await page.locator('#btn-v-download').click();
    const svgFile = await svgDownload;
    const svgBytes = await fs.readFile(await svgFile.path());
    check(`${width}px：SVG下载摘要与云端原件完全一致`, sha(svgBytes) === sha(assets.get(sourceSvg).bytes));
    // 打开文件会刷新列表，重新展开；下载PPT用真实保存按钮。
    await page.locator('.ws-poster-files summary').first().click();
    await page.locator('.ws-poster-files').first().getByRole('button', { name: /\.pptx$/ }).click();
    await page.waitForFunction(() => document.querySelector('#viewer-body').textContent.includes('云端源文件验收'));
    const pptDownload = page.waitForEvent('download');
    await page.locator('#btn-v-download').click();
    const pptFile = await pptDownload;
    const pptBytes = await fs.readFile(await pptFile.path());
    check(`${width}px：PPTX可读取中文且下载摘要与云端原件一致`, sha(pptBytes) === sha(assets.get(sourcePptx).bytes));
    const zip = await JSZip.loadAsync(pptBytes);
    const slide = await zip.file('ppt/slides/slide1.xml').async('string');
    check(`${width}px：PPT是可编辑文字对象，不是空页或只有截图`, /<a:t>云端源文件验收<\/a:t>/.test(slide));
    await fs.writeFile(path.join(output, `download-${width}.pptx`), pptBytes);
    const images = await page.evaluate(async paths => {
      for (const p of paths) await fixture.remote.pullServerFile(p, fixture.turn);
      // 同图再次展示以及模型显式show_image都不能追加副本。
      const latest = paths[0];
      const blob = await fixture.app.server.download(latest);
      fixture.bubble.image(URL.createObjectURL(blob), undefined, latest);
      const root = document.querySelector('#transcript');
      const before = [...root.querySelectorAll('.gen-image')].map(n => n.dataset.path);
      const buttons = [...root.querySelectorAll('.file-link')].map(n => n.dataset.path);
      const other = latest.replace(/([a-f0-9-]{36})\//, '22222222-2222-2222-2222-222222222222/');
      fixture.bubble.image(URL.createObjectURL(blob), undefined, other);
      fixture.bubble.image(URL.createObjectURL(blob), undefined, 'images/独立配图.png');
      return { before, buttons, after: root.querySelectorAll('.gen-image').length };
    }, [attempt(3), attempt(1), attempt(2)]);
    check(`${width}px：三次试排+重复通知只留一张最新图，旧下载不覆盖`, images.before.length === 1 && images.before[0] === attempt(3) && images.buttons.length === 1 && images.buttons[0] === attempt(3));
    check(`${width}px：另一任务和独立配图仍各自保留`, images.after === 3);
    await page.evaluate(() => fixture.panels.refreshFiles());
    await page.locator('.ws-poster-files summary').first().click();
    check(`${width}px：默认只有一张成品卡片，源文件有真实入口`, await page.locator('#file-list .ws-result').count() === 1 && await page.locator('.ws-poster-files[open] button').count() === 3);
    check(`${width}px：工作区无横向溢出`, await page.locator('#file-list').evaluate(n => n.scrollWidth <= n.clientWidth + 1));
    await page.screenshot({ path: path.join(output, `cloud-workspace-${width}.png`), fullPage: true });
    requests.length = 0;
    await context.close();
  }
  execFileSync('soffice', ['-env:UserInstallation=file://' + path.join(output, 'lo-profile'), '--headless', '--convert-to', 'pdf', '--outdir', output, path.join(output, 'download-390.pptx')], { timeout: 60000, stdio: 'pipe' });
  const pdfText = execFileSync('pdftotext', [path.join(output, 'download-390.pdf'), '-'], { encoding: 'utf8' });
  check('实际下载的PPT经LibreOffice打开转PDF后仍有中文正文', pdfText.replace(/\s/g, '').includes('云端源文件验收'));
} finally {
  await browser?.close();
  await server.close();
  useBackend(null);
  await fs.rm(store, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ checks, actualDevicesTested: false, productionServerTested: false }, null, 2));
}
console.log(`完成${checks.length}项云端交付检查`);
