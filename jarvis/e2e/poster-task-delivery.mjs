/** 真实PNG/字体/PPTX/PDF和手机/PC文件空间；视觉服务为协议夹具，不冒充付费模型验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { useBackend, collection } from '../src/agent/store.js';
import { createFileStore } from '../server/fileStore.mjs';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { createPosterTool } from '../src/agent/posterTool.js';
import { recordWorkAttempt, listWorkRecords } from '../src/agent/workLedger.js';
import { imageInfo } from '../src/agent/imageInfo.js';
import { createVisualDemoTool } from '../src/agent/visualDemoTool.js';
import * as ws from '../src/agent/workspace.js';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-poster-task-delivery');
await fs.mkdir(output, { recursive: true });
const store = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-poster-task-store-'));
useBackend(createFileStore(store));
const checks = [];
const check = (label, pass) => { checks.push({ label, pass: Boolean(pass) }); console.log(`${pass ? '✓' : '✗'} ${label}`); assert.ok(pass, label); };
let visionCalls = 0;
const ctx = { renderVisualScene, visionLlm: async () => { visionCalls++; return JSON.stringify({ copyMatches: true, readable: true, noOverlap: true, visualsPresent: true, relatedToTopic: true, integrated: true, issues: [] }); } };
const input = { title: '市场观察', width: 1080, height: 1920, dataMode: 'provided', source: '固定验收夹具，不代表真实行情', asOf: '2026-11-13', design: { layout: 'free', reading: 'phone', concept: { idea: '三大指数一眼对比，配图点明市场情绪', relation: 'interleave', focus: '指数涨跌' }, // 2026-11-17 起新自由稿须写构思
  palette: { background: '#F5F7FB', ink: '#15243E', muted: '#415574', accent: '#2354C7', card: '#FFFFFF' }, layers: [
    { id: 'eyebrow', type: 'text', text: 'MARKET BRIEF · 数据对比', x: 70, y: 70, w: 940, h: 70, fontSize: 36, role: 'caption' },
    { id: 'title', type: 'text', text: '美股三大指数速览', x: 70, y: 190, w: 940, h: 130, fontSize: 76, weight: 700, role: 'heading' },
    { id: 'subtitle', type: 'text', text: '同一交易日涨跌幅（%）', x: 70, y: 350, w: 940, h: 80, fontSize: 44, role: 'body' },
    { id: 'chart-card', type: 'shape', x: 50, y: 480, w: 980, h: 760, fill: '#FFFFFF', radius: 24, decorative: true },
    { id: 'comparison', type: 'chart', chartType: 'bar', unit: '%', x: 90, y: 530, w: 900, h: 650, points: [
      { label: '道琼斯', value: 0.1 }, { label: '标普500', value: -0.4 }, { label: '纳斯达克', value: -0.91 }
    ] },
    { id: 'body', type: 'text', text: '观察要点\n三项数据以同一零轴对照。\n这是分类比较，不是分时走势。', x: 70, y: 1330, w: 940, h: 280, fontSize: 44, role: 'body' },
    { id: 'source', type: 'text', text: '验收示例 · 非实时行情\n固定数据仅用于验证标签及数值精度', x: 70, y: 1710, w: 940, h: 140, fontSize: 36, role: 'caption' }
  ] } };
const sessionId = 'poster-task-fixture', scope = {};
await collection('sessions').put({ id: sessionId, messages: [] });
const events = [], tool = createPosterTool({ ...ctx, onFileChanged: p => events.push(p) });
const options = { executionScope: scope, sessionId, rawRequestText: '制作一张图文并茂的海报' };
let receipt;
for (let n = 0; n < 6; n++) {
  const outputText = await tool.run({ ...input, path: `海报/改名${n}.png` }, options);
  receipt = JSON.parse(outputText);
  await recordWorkAttempt({ tool: 'make_poster', args: input, output: outputText, ok: true, sessionId, scope, callId: String(n) });
}
check('真实交付、字体、原文、像素对比及手机阅读通过', receipt.status === 'complete' && receipt.copyCheck.status === 'passed' && receipt.fontCheck === 'passed' && receipt.contrast.status === 'passed' && receipt.presentation.status === 'passed');
check('6次同稿改名只导出一次，视觉协议只调用一次', events.length === 1 && visionCalls === 1 && receipt.delivery.attempts === 1);
check('图文结构及语义回执分开记录', receipt.contentCheck.status === 'passed' && receipt.contentCheck.semantic === 'passed');
for (const file of receipt.files) {
  const bytes = new Uint8Array(await (await ws.readBlob(file.path)).arrayBuffer());
  await fs.writeFile(path.join(output, 'market.' + file.format), bytes);
  if (file.format === 'png') check('真实PNG尺寸1080×1920', imageInfo(bytes).width === 1080 && imageInfo(bytes).height === 1920);
}
const source = await ws.readText(receipt.designPath);
await fs.writeFile(path.join(output, 'market.design.json'), source);
execFileSync('soffice', ['-env:UserInstallation=file://' + path.join(output, 'lo-profile'), '--headless', '--convert-to', 'pdf', '--outdir', output, path.join(output, 'market.pptx')], { timeout: 60000, stdio: 'pipe' });
const pdfText = execFileSync('pdftotext', [path.join(output, 'market.pdf'), '-'], { encoding: 'utf8' });
check('PPTX实际转PDF保留中文、分类标签、正负原值与单位', ['美股三大指数速览', '道琼斯', '标普500', '纳斯达克', '0.1%', '-0.4%', '-0.91%'].every(t => pdfText.replace(/\s/g, '').includes(t)));
const demo = JSON.parse(await createVisualDemoTool(ctx).run({ source_path: receipt.designPath, path: 'Demo/指数观察.png' }));
check('同源Demo继续生成可编辑稿及离线HTML/ZIP，不重画图片', demo.status === 'complete' && demo.files.some(f => f.format === 'html') && demo.files.some(f => f.format === 'zip'));

const records = (await listWorkRecords({ kind: 'image' })).items;
check('成果索引只有一条，默认主文件是PNG', records.length === 1 && records[0].files.length === 1 && records[0].files[0] === receipt.delivery.primaryPath);
const browserFiles = [];
for (const file of (await ws.list()).filter(f => f.path.startsWith(receipt.delivery.historyPrefix) || receipt.delivery.sourceAliases.includes(f.path))) {
  browserFiles.push({ ...file, base64: Buffer.from(await (await ws.readBlob(file.path)).arrayBuffer()).toString('base64') });
}
// 重现旧版30份过程文件；仅测试列表收纳，不把这些占位字节当成真实设计产物。
for (let n = 0; n < 30; n++) browserFiles.push({ path: receipt.delivery.historyPrefix + `old-history/过程夹具-${n}.txt`, size: 7, mtime: Date.now(), base64: Buffer.from('fixture').toString('base64') });
const nextReceipt = JSON.parse(await tool.run({ ...input, title: '第二项海报任务' }, { ...options, executionScope: {} }));
const nextRecord = (await listWorkRecords({ kind: 'image' })).items.find(r => r.deliveryId === nextReceipt.delivery.id);
const nextFiles = [];
for (const file of (await ws.list()).filter(f => f.path.startsWith(nextReceipt.delivery.historyPrefix) || nextReceipt.delivery.sourceAliases.includes(f.path))) {
  nextFiles.push({ ...file, base64: Buffer.from(await (await ws.readBlob(file.path)).arrayBuffer()).toString('base64') });
}
const root = path.resolve('dist-mobile');
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)));
    if (!file.startsWith(root + path.sep)) throw Error('outside');
    const bytes = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch();
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(() => { localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'mock' })); localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false })); });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.__jarvis?.showPanel);
    await page.evaluate(async ({ files, record }) => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('jarvis'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const tx = db.transaction(['files', 'kv', 'sessions'], 'readwrite');
      for (const f of files) {
        const bytes = Uint8Array.from(atob(f.base64), c => c.charCodeAt(0));
        tx.objectStore('files').put({ id: f.path, data: new Blob([bytes], { type: f.path.endsWith('.png') ? 'image/png' : 'application/octet-stream' }), size: bytes.length, mtime: f.mtime });
      }
      tx.objectStore('sessions').put({ id: record.sessionId, messages: [], title: '海报来源' });
      tx.objectStore('kv').put({ id: 'work-ledger-v1', ids: [record.id], since: Date.now() });
      tx.objectStore('kv').put({ ...record, id: 'work-record:' + record.id, generationId: record.id });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      db.close();
      window.__jarvis.showPanel('workspace');
    }, { files: browserFiles, record: records[0] });
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 1);
    check(`${width}px：30份历史文件默认只显示一张成品`, await page.locator('#file-list li.ws-result').count() === 1);
    // 2026-11-17 用户：做海报产出那么多历史稿。同一轮的试排/过程文件不再列为“历史稿”（原断言为“历史稿（32）”可展开）
    check(`${width}px：同轮试排不列为历史稿，只剩源文件一个折叠项`, await page.locator('.ws-poster-files').count() === 1 && await page.locator('.ws-poster-files[open]').count() === 0 && await page.getByText(/^历史稿/).count() === 0);
    await page.getByText('源文件（3）', { exact: true }).click();
    check(`${width}px：展开可见原PPTX/SVG/JSON，点击未误开主图`, await page.locator('.ws-poster-files[open] button').count() === 3);
    await page.getByText('显示过程文件', { exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length > 1);
    check(`${width}px：试排和手机校验文件没删，打开“显示过程文件”仍可查看`, await page.locator('#file-list li.ws-result').count() >= 31);
    await page.getByText('显示过程文件', { exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 1);
    check(`${width}px：主卡片无横向溢出`, await page.locator('#file-list').evaluate(n => n.scrollWidth <= n.clientWidth + 1));
    await page.evaluate(async ({ files, record, previous }) => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('jarvis'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const tx = db.transaction(['files', 'kv'], 'readwrite');
      for (const f of files) tx.objectStore('files').put({ id: f.path, data: new Blob([Uint8Array.from(atob(f.base64), c => c.charCodeAt(0))]), size: f.size, mtime: f.mtime });
      tx.objectStore('kv').put({ id: 'work-ledger-v1', ids: [previous, record.id], since: Date.now() });
      tx.objectStore('kv').put({ ...record, id: 'work-record:' + record.id, generationId: record.id });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      db.close();
      window.__jarvis.showPanel('workspace');
    }, { files: nextFiles, record: nextRecord, previous: records[0].id });
    await page.waitForFunction(() => document.querySelectorAll('#file-list li.ws-result').length === 2);
    check(`${width}px：30秒缓存内的新任务也立即出现，未合并到上一任务`, await page.locator('#file-list li.ws-result').count() === 2);
    await page.screenshot({ path: path.join(output, `workspace-${width}.png`), fullPage: true });
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  useBackend(null);
  await fs.rm(store, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ checks, receipt, actualModelTested: false, actualDevicesTested: false }, null, 2));
}
console.log(`完成 ${checks.length} 项实际产物/浏览器检查`);
