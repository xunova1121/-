/** 真实原尺寸渲染、离线浏览器交互与原字节下载。示例数据，不冒充真实模型/用户真机验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { useBackend } from '../src/agent/store.js';
import { createFileStore } from '../server/fileStore.mjs';
import * as ws from '../src/agent/workspace.js';
import { createVisualDemoTool } from '../src/agent/visualDemoTool.js';
import { createPosterTool } from '../src/agent/posterTool.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { renderPoster } from '../server/posterRaster.mjs';
import { imageInfo } from '../src/agent/imageInfo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || '/tmp/weiyang-visual-demo');
await fs.mkdir(output, { recursive: true });
await fs.rm(path.join(output, 'failure.json'), { force: true });
const store = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-visual-store-'));
useBackend(createFileStore(store));
const checks = [], products = [];
const check = (label, pass, detail) => { checks.push({ label, pass: Boolean(pass), detail }); console.log(`${pass ? '✓' : '✗'} ${label}`); assert.ok(pass, label + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const tool = createVisualDemoTool({ renderVisualScene });
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'visual-fixture', configureServer(vite) {
  vite.middlewares.use('/__visual.html', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><meta charset="utf-8"></head><body>视觉渲染验收</body></html>'); });
} }] });
let browser;

async function product(name, input) {
  const receipt = JSON.parse(await tool.run({ ...input, path: `视觉验收/${name}.html` }));
  check(`${name}：工具四格式完整交付`, receipt.status === 'complete' && receipt.files.length === 4 && receipt.fontCheck === 'passed', receipt);
  check(`${name}：不虚报视觉与交互验收`, receipt.visual === 'not_checked' && receipt.interaction === 'not_checked');
  const files = {};
  for (const file of receipt.files) {
    files[file.format] = Buffer.from(await (await ws.readBlob(file.path)).arrayBuffer());
    await fs.writeFile(path.join(output, `${name}.${file.format}`), files[file.format]);
  }
  const design = JSON.parse(await ws.readText(receipt.designPath));
  await fs.writeFile(path.join(output, `${name}.visual.json`), JSON.stringify(design, null, 2));
  const size = imageInfo(files.png);
  check(`${name}：PNG实际像素达到请求尺寸`, size.width === receipt.width && size.height === receipt.height, size);
  check(`${name}：中文使用文字元素，地图使用路径`, files.svg.toString().includes('<text ') && (input.source_path || files.svg.toString().includes('<path ')));
  const result = { name, input, receipt, files, design }; products.push(result); return result;
}

async function inspectHtml(item, viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true, offline: true });
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  try {
    await page.setContent(item.files.html.toString(), { waitUntil: 'load' });
    await page.locator('#scene-detail-content dl').waitFor();
    check(`${item.name}/${viewport.width}：离线脚本运行且无外部请求`, !errors.length && !requests.length, { errors, requests });
    const selected = item.design.options.preset === 'poster' ? 'text' : 'marker';
    const target = page.locator(`[data-viz="${selected}"][data-index="0"]`).first();
    await target.focus(); await page.keyboard.press('Enter');
    check(`${item.name}/${viewport.width}：键盘选择实际图元并展示详情`, await target.getAttribute('data-selected') === 'true' && await page.locator('#scene-detail-content').innerText() !== '');
    if (selected !== 'text') {
      check(`${item.name}/${viewport.width}：城市中文与数据对应`, await page.locator('#scene-detail-title').textContent() === item.design.options.markers[0].name && (await page.locator('#scene-detail-content').textContent()).includes(item.design.options.markers[0].value));
      await page.locator('#scene-date').selectOption('2');
      check(`${item.name}/${viewport.width}：切换已有趋势点`, await page.locator('[data-viz="series-point"][data-index="2"]').getAttribute('data-selected') === 'true');
      await page.locator('[data-viz="time-label"]').click();
      const timeDetails = await page.locator('#scene-detail-content').innerText();
      check(`${item.name}/${viewport.width}：页头时间展示快照来源而非首个趋势值`, await page.locator('#scene-detail-title').textContent() === '数据时间' && timeDetails.includes(item.design.options.asOf) && timeDetails.includes(item.design.options.source) && !(await page.locator('#scene-detail-content dt').allTextContents()).includes('观测值'));
      check(`${item.name}/${viewport.width}：查看快照时间不改变已有趋势时段`, await page.locator('#scene-date').inputValue() === '2');
      await page.locator('#layer-radar').uncheck();
      check(`${item.name}/${viewport.width}：雷达图层实际隐藏`, await page.locator('[data-viz="radar"]').getAttribute('visibility') === 'hidden');
    } else check(`${item.name}/${viewport.width}：展示准确海报原文`, (await page.locator('#scene-detail-content').textContent()).includes(item.input.title || '春日计划'));
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download-png').click()]);
    const downloaded = await fs.readFile(await download.path());
    check(`${item.name}/${viewport.width}：下载初始PNG原字节完全相同`, digest(downloaded) === digest(item.files.png));
    const [svgDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#download-svg').click()]);
    const svg = await fs.readFile(await svgDownload.path(), 'utf8');
    check(`${item.name}/${viewport.width}：导出SVG保留当前选择状态`, svg.includes('visual-demo-selection') && svg.includes('data-selected="true"'));
    await page.locator('#scene-reset').click();
    check(`${item.name}/${viewport.width}：重置实际图层与选择`, await page.locator('[data-selected="true"]').count() === 0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check(`${item.name}/${viewport.width}：页面没有横向溢出`, !overflow);
    const bounds = await page.evaluate(() => {
      const svg = document.getElementById('visual-scene'), outer = svg.getBoundingClientRect();
      return [...svg.querySelectorAll('text')].filter(node => {
        const box = node.getBoundingClientRect();
        return box.left < outer.left - 1 || box.top < outer.top - 1 || box.right > outer.right + 1 || box.bottom > outer.bottom + 1;
      }).map(node => node.textContent);
    });
    check(`${item.name}/${viewport.width}：中文全文在画布内`, bounds.length === 0, bounds);
    await page.screenshot({ path: path.join(output, `${item.name}-${viewport.width}.png`), fullPage: true });
    check(`${item.name}/${viewport.width}：完成交互无脚本错误`, !errors.length, errors);
  } finally { await context.close(); }
}

try {
  const weather = await product('weather-4k', { title: '区域气象监测预警中心' });
  const operations = await product('operations-4k', { preset: 'operations', title: '城市运营指挥中心' });
  const poster = JSON.parse(await createPosterTool({ renderPoster }).run({ title: '春日计划', subtitle: '城市生活美学展', lines: ['让自然与灵感相遇', '2026年11月 · 南京'], width: 1024, height: 1536, text_position: 'bottom', text_fraction: 0.38, path: '视觉验收/原始海报.png' }));
  check('原海报仍完整交付PNG/SVG/PPTX', poster.status === 'complete', poster);
  const posterSvg = await ws.readText(poster.files.find(file => file.format === 'svg').path);
  const converted = await product('poster-demo', { source_path: poster.designPath });
  check('海报补Demo保持原文字与SVG逐字节相同', converted.files.svg.toString() === posterSvg);
  const old = weather.files.svg;
  const revised = await product('weather-revised', { source_path: weather.receipt.designPath, title: '区域气象展示样例' });
  check('改标题不覆盖原稿且底层点位数据保持', (await ws.readText(weather.receipt.files.find(file => file.format === 'svg').path)) === old.toString() && JSON.stringify(weather.design.options.markers) === JSON.stringify(revised.design.options.markers));
  await server.listen();
  const base = server.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  await inspectHtml(weather, { width: 1440, height: 1000 });
  await inspectHtml(weather, { width: 390, height: 844 });
  await inspectHtml(operations, { width: 1440, height: 1000 });
  await inspectHtml(converted, { width: 390, height: 844 });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/__visual.html`);
  const result = await page.evaluate(async () => {
    const { createVisualDemoTool } = await import('/src/agent/visualDemoTool.js');
    const workspace = await import('/src/agent/workspace.js');
    const receipt = JSON.parse(await createVisualDemoTool().run({ title: '浏览器高清输出', width: 1920, height: 1080 }));
    const png = receipt.files.find(file => file.format === 'png');
    if (!png) return { receipt };
    const blob = await workspace.readBlob(png.path), bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(100, 40, 700, 80).data;
    let bright = 0;
    for (let at = 0; at < data.length; at += 4) if (data[at] > 180 && data[at + 1] > 180 && data[at + 2] > 180) bright++;
    return { receipt, width: bitmap.width, height: bitmap.height, titleInk: bright };
  });
  check('浏览器专用渲染器真实输出1920×1080且字体检测通过', result.receipt.status === 'complete' && result.receipt.fontCheck === 'passed' && result.width === 1920 && result.height === 1080, result);
  check('浏览器PNG标题有真实字形像素，不是透明空图', result.titleInk > 500, result.titleInk);
  const material = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 2248; canvas.height = 1000;
    const ctx = canvas.getContext('2d'), gradient = ctx.createLinearGradient(0, 0, 2248, 1000);
    gradient.addColorStop(0, '#204e9a'); gradient.addColorStop(0.5, '#1e7589'); gradient.addColorStop(1, '#a27e50');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 2248, 1000);
    for (let index = 0; index < 12; index++) { ctx.fillStyle = `rgba(227,245,255,${0.04 + index / 200})`; ctx.beginPath(); ctx.ellipse(120 + index * 175, 430 + Math.sin(index) * 70, 260, 80, -0.15, 0, Math.PI * 2); ctx.fill(); }
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await ws.write('视觉验收/无字纹理.png', new Blob([Buffer.from(material, 'base64')], { type: 'image/png' }));
  const textured = await product('weather-material', { title: '区域气象监测预警中心', background_path: '视觉验收/无字纹理.png' });
  check('视觉素材保持原尺寸，按实际放置框计算倍率', textured.receipt.background.scale === 1 && textured.receipt.background.placement.mode === 'map', textured.receipt.background);
  const diff = await page.evaluate(async ({ first, second, placement }) => {
    const pixels = async encoded => { const img = new Image(); img.src = 'data:image/png;base64,' + encoded; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return ctx.getImageData(placement.x, placement.y, placement.width, placement.height).data; };
    const a = await pixels(first), b = await pixels(second);
    let changed = 0;
    for (let at = 0; at < a.length; at += 4) if (Math.abs(a[at] - b[at]) + Math.abs(a[at + 1] - b[at + 1]) + Math.abs(a[at + 2] - b[at + 2]) > 30) changed++;
    return changed / (a.length / 4);
  }, { first: weather.files.png.toString('base64'), second: textured.files.png.toString('base64'), placement: textured.receipt.background.placement });
  check('底图主体真实可见，没有被不透明卡片全部盖住', diff > 0.6, diff);
  await inspectHtml(textured, { width: 1440, height: 1000 });
  await page.close();
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({ status: 'passed', checks, products: products.map(({ name, receipt }) => ({ name, receipt })), limits: ['演示数据，不是实时天气接口验收', '没有调用收费图像模型', '没有安卓或Windows真机、微信分享验收'] }, null, 2));
  console.log(`视觉Demo验收：${checks.length}/${checks.length}通过；${output}`);
} catch (error) {
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks }, null, 2));
  throw error;
} finally {
  await browser?.close(); await server.close();
  useBackend(null); await fs.rm(store, { recursive: true, force: true });
}
