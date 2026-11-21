/** 真实工具/渲染/Office/聊天文件点击链路；模型决策与视觉回复为明确标注的受控协议，不冒充付费服务。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createFileStore } from '../server/fileStore.mjs';
import { collection, useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { createPosterTool } from '../src/agent/posterTool.js';
import { createVisualDemoTool } from '../src/agent/visualDemoTool.js';
import { runAgent } from '../src/agent/agent.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { listWorkRecords } from '../src/agent/workLedger.js';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-poster-intelligence');
await fs.mkdir(output, { recursive: true });
const store = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-intelligence-store-'));
useBackend(createFileStore(store));
const checks = [];
const check = (label, pass) => { checks.push({ label, pass: Boolean(pass) }); console.log(`${pass ? '✓' : '✗'} ${label}`); assert.ok(pass, label); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const art = {
  port: '<path d="M130 710h940l-110 150H260Z" fill="#163C58"/><g fill="#EBAA4B"><rect x="300" y="540" width="160" height="160"/><rect x="480" y="540" width="160" height="160"/><rect x="660" y="540" width="160" height="160"/></g><path d="M210 200v490M210 210h750M760 210v260M900 210v320" stroke="#176A85" stroke-width="28"/><path d="M0 925q200-90 400 0t400 0t400 0" fill="none" stroke="#62C7DA" stroke-width="25"/>',
  rain: '<circle cx="440" cy="410" r="160" fill="#E4B85D"/><path d="M250 640q-90-180 100-240q110-210 300-60q230-20 250 210q160 100 20 200H300Z" fill="#FAFDFF"/><g stroke="#4199BE" stroke-width="25" stroke-linecap="round"><path d="M350 820l-45 90M560 820l-45 90M770 820l-45 90"/></g>',
  flight: '<path d="M135 620l370-130V255q0-130 90-130t90 130v235l370 130v110L685 650v230l130 80v70l-220-45-220 45v-70l130-80V650l-370 80Z" fill="#F8FBFC"/><path d="M50 1060h1100" stroke="#37758A" stroke-width="22"/><g fill="#9BCBD6"><circle cx="180" cy="245" r="70"/><circle cx="1050" cy="390" r="95"/></g>'
};
let browser, server;
let first, revised, demo, agentRun;
try {
  browser = await chromium.launch();
  const artPage = await browser.newPage();
  for (const [id, drawing] of Object.entries(art)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#CDEAF0"/><stop offset="1" stop-color="#72A9BC"/></linearGradient></defs><rect width="1200" height="1200" fill="url(#bg)"/>${drawing}</svg>`;
    const data = await artPage.evaluate(async source => {
      const image = new Image(); image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source); await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      canvas.getContext('2d').drawImage(image, 0, 0); return canvas.toDataURL('image/png').split(',')[1];
    }, svg);
    await ws.write(`素材/${id}.png`, new Blob([Buffer.from(data, 'base64')], { type: 'image/png' }));
  }
  await artPage.close();
  const sessionId = 'intelligence-e2e';
  await collection('sessions').put({ id: sessionId, title: '图文海报验收', messages: [] });
  const ctx = { renderVisualScene, visionLlm: async () => JSON.stringify({ copyMatches: true, readable: true, noOverlap: true, visualsPresent: true, relatedToTopic: true, integrated: true, issues: [] }) };
  const poster = createPosterTool(ctx), visual = createVisualDemoTool(ctx);
  const input = { title: '城市观察', subtitle: '七个切面，看见生活的新变化', footer: '仅用于图文排版验收 · 程序插画及演示文案，不对应真实新闻\n文字、素材、来源与时间均可修改；未接入实时数据', design: { layout: 'magazine', eyebrow: 'WEIYANG / DAILY JOURNAL',
    assets: Object.keys(art).map(id => ({ id, path: `素材/${id}.png` })), sections: [
      { title: '港口运行 · 智慧协同', body: '连接码头、运输与仓储，让调度信息清楚可见。', category: '产业', asset: 'port' },
      { title: '城市降水 · 从容应对', body: '风速6.8m/s、降水28.4mm，均为排版演示值。', category: '天气', asset: 'rain' },
      { title: '便捷出行 · 连接远方', body: '从出发到抵达，关注每一段行程的体验。', category: '交通', asset: 'flight' },
      { title: '把阅读带进街角', body: '一间书屋，连接一座城市的精神生活。', category: '文化' },
      { title: '绿色空间 · 日常相伴', body: '从公园到街区，让自然融入日常生活。', category: '环境' },
      { title: '科技服务 · 简单好用', body: '用清楚的界面，帮助人们完成复杂的工作。', category: '科技' },
      { title: '认真记录 · 保留细节', body: '比例1/5、日期2026年11月16日，保持完整可读。', category: '生活' }
    ] } };
  let call = 0, receipt;
  const adapter = { async stream({ onText, messages }) {
    call++;
    const bad = [{}, { ...input, width: 1, height: 768 }, { title: '错误布局', width: 1080, height: 1920, design: { layout: 'free', layers: [{ id: 'title', type: 'text', text: '越界', x: 1060, y: 40, w: 100, h: 100 }] } }];
    if (call <= 4) return { text: '', stop: 'tool_use', toolCalls: [{ id: 'poster-' + call, name: 'make_poster', args: call <= 3 ? bad[call - 1] : input }] };
    const toolMessage = [...messages].reverse().find(m => m.role === 'tool' && m.name === 'make_poster');
    receipt = JSON.parse(toolMessage.content);
    const text = `已生成排版验收样张：[查看海报](${receipt.delivery.primaryPath})。图文语义为受控测试回执，不是实际收费模型验收。`;
    onText?.(text); return { text, stop: 'end_turn', toolCalls: [] };
  } };
  agentRun = await runAgent({ adapter, model: 'controlled-protocol', context: { dynamic: '受控验收：内容为演示，不对应实际新闻。', kbHits: [] },
    userText: '制作一张图文并茂的新闻海报，中文清楚，手机整图可读', history: [], sessionId, tools: [poster, visual], emit: () => {}, maxSteps: 12 });
  first = receipt;
  check('真实智能体执行链三次参数错误后成功交付，没有被试排预算锁死', first.delivery.attempts === 1 && first.delivery.corrections === 3 && first.status === 'complete');
  check('最终文件实际读回、像素与手机字体检查通过', first.deliveryAccess.status === 'ready' && first.presentation.status === 'passed' && first.fontCheck === 'passed');
  const design = JSON.parse(await ws.readText(first.designPath));
  check('七条正文完整，三张主题配图分别属于对应栏目', design.layers.filter(n => /-body$/.test(n.id)).length === 7 && design.layers.filter(n => n.type === 'image' && /^section-/.test(n.group)).length === 3);
  revised = JSON.parse(await poster.run({ source_path: first.designPath, changes: [{ id: 'title', text: '每日观察' }] }, { executionScope: {}, sessionId, rawRequestText: '只改标题为每日观察' }));
  check('新一轮修改仍归同一作品，旧文件保留且路径不覆盖', revised.delivery.id === first.delivery.id && revised.delivery.primaryPath !== first.delivery.primaryPath && await ws.exists(first.delivery.primaryPath));
  demo = JSON.parse(await visual.run({ source_path: revised.designPath }, { executionScope: {}, sessionId, rawRequestText: '补个Demo' }));
  check('同稿Demo继承图文语义检查与同一作品ID', demo.status === 'complete' && demo.contentCheck.semantic === 'passed' && demo.delivery.id === first.delivery.id);
  const records = (await listWorkRecords({ kind: 'image' })).items;
  check('跨轮修改和补Demo后，文件空间仍只有一个当前作品', records.length === 1 && records[0].files[0] === demo.delivery.primaryPath);
  for (const format of ['png', 'pptx', 'html', 'zip']) {
    const file = demo.files.find(f => f.format === format);
    await fs.writeFile(path.join(output, '城市观察.' + format), new Uint8Array(await (await ws.readBlob(file.path)).arrayBuffer()));
  }
  execFileSync('soffice', ['-env:UserInstallation=file://' + path.join(output, 'lo'), '--headless', '--convert-to', 'pdf', '--outdir', output, path.join(output, '城市观察.pptx')], { timeout: 60000, stdio: 'pipe' });
  const pdf = execFileSync('pdftotext', [path.join(output, '城市观察.pdf'), '-'], { encoding: 'utf8' }).replace(/\s/g, '');
  check('真实PPTX转PDF保留新标题、比例、日期和全部栏目', ['每日观察', '1/5', '2026年11月16日', ...input.design.sections.map(s => s.title.replace(/\s/g, ''))].every(t => pdf.includes(t)));
  const files = [];
  for (const f of await ws.list()) files.push({ path: f.path, size: f.size, data: Buffer.from(await (await ws.readBlob(f.path)).arrayBuffer()).toString('base64') });
  const root = path.resolve('dist-mobile');
  server = http.createServer(async (req, res) => {
    try {
      const name = new URL(req.url, 'http://localhost').pathname;
      const filename = path.resolve(root, name === '/' ? 'index.html' : decodeURIComponent(name.slice(1)));
      if (!filename.startsWith(root + path.sep)) throw new Error('outside');
      const bytes = await fs.readFile(filename);
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(filename)] || 'application/octet-stream' }); res.end(bytes);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, acceptDownloads: true });
    const page = await context.newPage();
    await page.addInitScript(() => { localStorage.setItem('jarvis.llm.v1', JSON.stringify({ provider: 'mock' })); localStorage.setItem('jarvis.settings.v1', JSON.stringify({ theme: 'day', speechOutput: false })); });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.__jarvis?.openSession);
    await page.evaluate(async ({ files, record, sessionId, primary }) => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('jarvis'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const tx = db.transaction(['files', 'kv', 'sessions'], 'readwrite');
      for (const file of files) tx.objectStore('files').put({ id: file.path, data: new Blob([Uint8Array.from(atob(file.data), c => c.charCodeAt(0))], { type: file.path.endsWith('.png') ? 'image/png' : 'application/octet-stream' }), size: file.size, mtime: Date.now() });
      tx.objectStore('sessions').put({ id: sessionId, title: '图文海报成品', updatedAt: Date.now(), messages: [{ role: 'user', content: '做海报', ts: Date.now() }, { role: 'assistant', content: '已生成排版样张', files: [primary], ts: Date.now() }] });
      tx.objectStore('kv').put({ id: 'work-ledger-v1', ids: [record.id], since: Date.now() });
      tx.objectStore('kv').put({ ...record, id: 'work-record:' + record.id, generationId: record.id });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
      await window.__jarvis.openSession(sessionId);
    }, { files, record: records[0], sessionId, primary: demo.delivery.primaryPath });
    const button = page.locator('#transcript .file-link');
    await button.waitFor();
    check(`${width}px聊天中主PNG按钮不再被过程目录规则隐藏`, await button.count() === 1);
    await button.click();
    await page.waitForFunction(() => document.querySelector('#viewer-body img')?.naturalWidth > 0);
    check(`${width}px实际点击打开的是完整PNG`, await page.locator('#viewer-body img').evaluate(img => img.naturalWidth === 1080 && img.naturalHeight > 1900));
    const pending = page.waitForEvent('download'); await page.click('#btn-v-download');
    const download = await pending, downloaded = await fs.readFile(await download.path());
    check(`${width}px下载字节与最终原PNG一致`, digest(downloaded) === digest(await fs.readFile(path.join(output, '城市观察.png'))));
    await page.screenshot({ path: path.join(output, `成品打开-${width}.png`), fullPage: true });
    await context.close();
  }
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  useBackend(null); await fs.rm(store, { recursive: true, force: true });
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ checks, first, revised, demo, steps: agentRun?.steps, actualModelTested: false, actualDevicesTested: false }, null, 2));
}
console.log(`完成 ${checks.length} 项海报闭环检查`);
