/** 三类真实文件、同源换稿、实际中文像素、离线手机/PC交互和Office导出；不冒充付费模型/真机验收。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { useBackend } from '../src/agent/store.js';
import { createFileStore } from '../server/fileStore.mjs';
import * as ws from '../src/agent/workspace.js';
import { createPosterTool } from '../src/agent/posterTool.js';
import { createVisualDemoTool } from '../src/agent/visualDemoTool.js';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { createTools } from '../src/agent/tools.js';
import { runAgent } from '../src/agent/agent.js';
import { imageInfo } from '../src/agent/imageInfo.js';
import { composeLayeredSvg } from '../src/agent/layeredDesignSvg.js';
import { normalizeLayerDesign } from '../src/agent/layeredDesignInput.js';
import { applyDesignState } from '../src/agent/layeredDesignQuality.js';
import { planLayerDesign } from '../src/agent/layeredDesignLayout.js';
import { createLayeredHtml } from '../src/agent/layeredDesignHtml.js';
import { sampleArt, newsInput, babyInput, dashboardInput } from './fixtures/layered-design.mjs';

const output = path.resolve(process.argv[2] || '/tmp/weiyang-layered-design');
await fs.mkdir(output, { recursive: true });
await fs.rm(path.join(output, 'failure.json'), { force: true });
const store = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-layered-store-'));
useBackend(createFileStore(store));
const digest = bytes => createHash('sha256').update(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).digest('hex');
const checks = [], products = [], ctx = { renderVisualScene };
const check = (label, pass, detail) => { checks.push({ label, pass: Boolean(pass), detail }); console.log(`${pass ? '✓' : '✗'} ${label}`); assert.ok(pass, label + (detail ? ': ' + JSON.stringify(detail) : '')); };
const poster = createPosterTool(ctx), demo = createVisualDemoTool(ctx);
let browser;

async function makeAssets() {
  const page = await browser.newPage();
  for (const [name, svg] of Object.entries(sampleArt)) {
    const data = await page.evaluate(async raw => {
      const image = new Image(); image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(raw); await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      canvas.getContext('2d').drawImage(image, 0, 0); return canvas.toDataURL('image/png').split(',')[1];
    }, svg);
    const bytes = Buffer.from(data, 'base64');
    await ws.write(`分层验收/assets/${name}.png`, new Blob([bytes], { type: 'image/png' }));
    await fs.writeFile(path.join(output, `${name}-asset.png`), bytes);
  }
  await page.close();
}
async function product(name, tool, input) {
  const receipt = JSON.parse(await tool.run({ ...input, path: `分层验收/${name}.png` }));
  check(`${name}：真实交付与字体、原文、几何、对比全部通过`, receipt.status === 'complete' && receipt.fontCheck === 'passed' && receipt.copyCheck.status === 'passed' && receipt.layoutCheck.status === 'passed' && receipt.contrast.status === 'passed', receipt);
  check(`${name}：不把程序检查冒充视觉模型或交互实测`, receipt.visual === 'not_checked' && receipt.interaction === 'not_checked');
  const files = {};
  for (const file of receipt.files) {
    files[file.format] = Buffer.from(await (await ws.readBlob(file.path)).arrayBuffer());
    await fs.writeFile(path.join(output, `${name}.${file.format}`), files[file.format]);
  }
  const source = await ws.readText(receipt.designPath), design = JSON.parse(source);
  await fs.writeFile(path.join(output, `${name}.design.json`), source);
  const info = imageInfo(files.png);
  check(`${name}：PNG实际像素与请求相同`, info.width === receipt.width && info.height === receipt.height, info);
  const zip = await JSZip.loadAsync(files.pptx), slide = await zip.file('ppt/slides/slide1.xml').async('string');
  check(`${name}：PPTX有独立原生文字/卡片与图标对象`, slide.includes('layer-title') && slide.includes('<a:t>') && slide.includes('layer-section-1'));
  const item = { name, receipt, files, design }; products.push(item); return item;
}
async function htmlInteractions(item, viewport) {
  const context = await browser.newContext({ viewport, offline: true, acceptDownloads: true });
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (/^https?:/.test(req.url())) requests.push(req.url()); });
  await page.setContent(item.files.html.toString(), { waitUntil: 'load' });
  await page.locator('#design-canvas svg').waitFor({ state: 'attached' });
  const mobile = viewport.width <= 700, prefix = mobile ? '#design-mobile ' : '#design-canvas ';
  const title = page.locator(mobile ? '[data-node="title"]' : '#layer-title');
  await title.focus(); await page.keyboard.press('Enter');
  check(`${item.name}/${viewport.width}：键盘点击实际文字打开详情`, await page.locator('#design-detail').evaluate(el => el.open) && (await page.locator('#design-detail-title').innerText()) === item.design.layers.find(n => n.id === 'title').text);
  await page.locator('#design-close').click();
  if (item.design.states.length) {
    await page.locator('#design-state').selectOption('1');
    const change = item.design.states[0].changes.find(c => c.text !== undefined);
    const target = page.locator(mobile ? `[data-node="${change.id}"]` : `#layer-${change.id}`);
    check(`${item.name}/${viewport.width}：快照真正改变可见图层值`, (await target.textContent()).replace(/\n/g, '') === change.text);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#design-download-source').click()]);
    const source = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    check(`${item.name}/${viewport.width}：下载源稿保留当前值`, source.layers.find(n => n.id === change.id).text === change.text);
    check(`${item.name}/${viewport.width}：当前源稿能再次归一化`, normalizeLayerDesign(source).kind === 'layered-design');
  }
  const choice = item.design.layers.find(n => n.category);
  if (choice) {
    await page.locator('#design-category').selectOption(choice.category);
    const other = item.design.layers.find(n => !n.decorative && n.category && n.category !== choice.category);
    if (other) check(`${item.name}/${viewport.width}：分类实际隐藏不匹配内容`, !(await page.locator(mobile ? `[data-node="${other.id}"]` : `#layer-${other.id}`).isVisible()));
  }
  await page.locator('#design-search').fill('不可能匹配的检索词');
  check(`${item.name}/${viewport.width}：搜索无匹配有真实空状态`, await page.locator('#design-empty').isVisible());
  await page.locator('#design-reset').click();
  if (item.design.layers.some(n => n.type === 'image')) {
    await page.locator('#design-images').click();
    check(`${item.name}/${viewport.width}：图片图层实际隐藏`, !(await page.locator(prefix + (mobile ? '.mobile-image' : 'image')).first().isVisible()));
    await page.locator('#design-reset').click();
  }
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#design-download-png').click()]);
  check(`${item.name}/${viewport.width}：下载初始PNG与原件逐字节相同`, digest(await fs.readFile(await download.path())) === digest(item.files.png));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  check(`${item.name}/${viewport.width}：无横向溢出`, !overflow);
  if (mobile) {
    const sizes = await page.locator('#design-mobile p').evaluateAll(nodes => nodes.filter(n => !n.hidden).map(n => parseFloat(getComputedStyle(n).fontSize)));
    check(`${item.name}/${viewport.width}：手机是可读文字而非4K缩略图`, sizes.length > 5 && Math.min(...sizes) >= 16 && await page.locator('#design-canvas').isHidden());
    const boxes = await page.locator('#design-mobile [data-node]').evaluateAll(nodes => nodes.filter(n => !n.hidden && n.tagName === 'P').filter(n => n.scrollWidth > n.clientWidth + 1).map(n => n.textContent));
    check(`${item.name}/${viewport.width}：手机全部文案完整可见`, boxes.length === 0, boxes);
  } else {
    const bad = await page.locator('#design-canvas>svg').evaluate(svg => {
      const root = svg.getBoundingClientRect();
      return [...svg.querySelectorAll('text')].filter(n => { const r = n.getBoundingClientRect(); return r.left < root.left - 1 || r.top < root.top - 1 || r.right > root.right + 1 || r.bottom > root.bottom + 1; }).map(n => n.textContent);
    });
    check(`${item.name}/${viewport.width}：真实字体文字都在画布内`, !bad.length, bad);
  }
  await page.screenshot({ path: path.join(output, `${item.name}-${viewport.width}.png`), fullPage: true });
  check(`${item.name}/${viewport.width}：全程离线且没有脚本错误`, !errors.length && !requests.length, { errors, requests });
  await context.close();
}
async function editableRoundtrip(first) {
  const before = first.files.svg, raw = await ws.readBlob('分层验收/assets/baby.png');
  const revised = await product('baby-revised', poster, { source_path: first.receipt.designPath, changes: [
    { id: 'title', text: '把每一次期待，写成温柔的诗' }, { id: 'section-3-value', text: '去散步' },
    { id: 'section-3-card', fill: '#F6E6D9' }
  ] });
  check('改字/卡片颜色仍保留所有矢量图标和源图', JSON.stringify(revised.design.assets) === JSON.stringify(first.design.assets) && digest(await (await ws.readBlob('分层验收/assets/baby.png')).arrayBuffer()) === digest(await raw.arrayBuffer()));
  check('改稿另存，最初SVG及源稿保持', revised.receipt.designPath !== first.receipt.designPath && Buffer.from(await (await ws.readBlob(first.receipt.files.find(f => f.format === 'svg').path)).arrayBuffer()).equals(before));
  await product('baby-revised-demo', demo, { source_path: revised.receipt.designPath });
  const source = first.receipt.designPath;
  const current = JSON.parse(await ws.readText(source)); current.assets[0].hash = 'f'.repeat(64);
  await ws.write('分层验收/tampered.design.json', JSON.stringify(current));
  await assert.rejects(() => demo.run({ source_path: '分层验收/tampered.design.json' }), error => error.code === 'DESIGN_ASSET_CHANGED');
  check('素材变化不能假装同源复用', true);
}
async function agentEntry() {
  let calls = 0, sent = false;
  const selected = createTools(ctx).filter(t => t.name === 'make_poster');
  const adapter = { async stream({ tools, system, onText }) {
    calls++;
    check('普通对话入口按任务加载分层协议', JSON.stringify(system).includes('make_poster.design') && tools.some(t => t.name === 'make_poster' && JSON.stringify(t).includes('sections')));
    if (!sent) { sent = true; return { text: '', toolCalls: [{ id: 'layered', name: 'make_poster', args: { ...newsInput, path: '分层验收/ordinary-entry.png' } }], stop: 'tool_use' }; }
    const text = '已生成PNG、SVG和PPTX；使用独立文字、图标和卡片。视觉模型尚未验收。';
    onText(text); return { text, toolCalls: [], stop: 'end_turn' };
  } };
  await runAgent({ adapter, model: 'fixture', tools: selected, userText: '设计一张新闻图文海报', history: [], context: { dynamic: '' }, emit: () => {}, quiet: true });
  check('普通主循环实际生成可复用分层源稿', calls >= 2 && await ws.exists('分层验收/ordinary-entry.design.json'));
}
async function officeExport(item) {
  const directory = path.join(output, 'office'); await fs.mkdir(directory, { recursive: true });
  execFileSync('soffice', ['-env:UserInstallation=file://' + path.join(output, 'office-profile'), '--headless', '--convert-to', 'pdf', '--outdir', directory, path.join(output, `${item.name}.pptx`)], { timeout: 60000, stdio: 'pipe' });
  const pdf = await fs.readFile(path.join(directory, `${item.name}.pdf`));
  const text = execFileSync('pdftotext', ['-layout', path.join(directory, `${item.name}.pdf`), '-'], { encoding: 'utf8' });
  const compact = value => value.replace(/\s/g, '');
  check(`${item.name}：真实Office转PDF且主标题未丢字`, pdf.subarray(0, 4).toString() === '%PDF' && compact(text).includes(compact(item.design.layers.find(n => n.id === 'title').text)));
  execFileSync('pdftoppm', ['-scale-to', '1440', '-singlefile', '-png', path.join(directory, `${item.name}.pdf`), path.join(directory, item.name)], { timeout: 60000 });
}
async function preciseValues() {
  const points = [{ label: '昨日', value: 12.345678901 }, { label: '今日', value: -0.000123456789 }];
  const next = [{ label: '昨日', value: 0.1234567890123 }, { label: '今日', value: -123.4567890123 }];
  const design = planLayerDesign({ title: '精确原值核验', width: 960, height: 540, design: { layout: 'free', layers: [
    { id: 'title', type: 'text', x: 40, y: 35, w: 880, h: 100, text: '精确原值核验', fontSize: 52 },
    { id: 'trend', type: 'chart', x: 60, y: 200, w: 820, h: 240, points }
  ], states: [{ label: '另一组原值', changes: [{ id: 'trend', points: next }] }] } });
  const context = await browser.newContext({ offline: true, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.setContent(await createLayeredHtml({ design, assets: new Map() }), { waitUntil: 'load' });
    await page.locator('#layer-trend').click();
    check('高精度业务原值在实际详情中逐位保留', JSON.stringify(await page.locator('#design-detail-copy dd').allTextContents()) === JSON.stringify(points.map(p => String(p.value))));
    await page.locator('#design-close').click();
    await page.locator('#design-state').selectOption('1');
    await page.locator('#layer-trend').click();
    check('快照中的高精度正负数不被像素舍入改变', JSON.stringify(await page.locator('#design-detail-copy dd').allTextContents()) === JSON.stringify(next.map(p => String(p.value))));
  } finally { await context.close(); }
}
try {
  browser = await chromium.launch({ headless: true });
  await makeAssets();
  const news = await product('editorial-poster', poster, newsInput);
  const baby = await product('baby-poster', poster, babyInput);
  const newsDemo = await product('editorial-demo', demo, { source_path: news.receipt.designPath });
  const babyDemo = await product('baby-demo', demo, { source_path: baby.receipt.designPath });
  const dashboard = await product('dashboard-4k', demo, dashboardInput);
  check('海报补Demo保留所有图层，PNG/SVG逐字节相同', news.files.png.equals(newsDemo.files.png) && news.files.svg.equals(newsDemo.files.svg) && baby.files.png.equals(babyDemo.files.png) && baby.files.svg.equals(babyDemo.files.svg));
  check('4K回执如实标识低于4K底图的放大', dashboard.receipt.width === 3840 && dashboard.receipt.assets[0].width === 1536 && dashboard.receipt.assets[0].upscaled);
  for (const item of [newsDemo, babyDemo, dashboard]) for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) await htmlInteractions(item, viewport);
  await editableRoundtrip(baby);
  const archive = await JSZip.loadAsync(dashboard.files.zip), source = JSON.parse(await archive.file('design.design.json').async('string'));
  check('ZIP实际包含全部五类文件和可重导入相对素材', ['png', 'svg', 'pptx', 'html'].every(ext => archive.file(`design.${ext}`)) && source.assets.every(a => archive.file(a.path)));
  await agentEntry();
  await preciseValues();
  for (const item of [news, baby, dashboard]) await officeExport(item);
  // 所有快照的文字/边界在编译与实际浏览器状态切换中验证，未将其声称为视觉模型已看过。
  for (const state of dashboard.design.states) check('快照设计仍可独立归一化和编译', composeLayeredSvg(applyDesignState(dashboard.design, state), new Map([['hero', { data: 'data:image/png;base64,' + (await fs.readFile(path.join(output, 'planet-asset.png'))).toString('base64') }]])).includes('3,210件'));
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', checks, products: products.map(({ name, receipt }) => ({ name, receipt })), limitations: ['模型为受控替身，未测试真实GPT/付费服务', '离线浏览器和Office验收，不是用户手机/Windows安装或WeChat真机', '视觉模型未配置，不称绝对无错字或视觉通过'] }, null, 2));
  console.log(`完成 ${checks.length} 项，产物 ${output}`);
} catch (error) {
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: error.message, stack: error.stack, checks }, null, 2));
  throw error;
} finally { await browser?.close(); await fs.rm(store, { recursive: true, force: true }); }
