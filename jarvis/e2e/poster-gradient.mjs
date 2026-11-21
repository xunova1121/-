/** 1080×1440真实渐变、中文墨迹、可编辑PPTX及LibreOffice；合成素材，不调用图片模型。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { createFileStore } from '../server/fileStore.mjs';
import { renderVisualScene } from '../server/visualSceneRaster.mjs';
import { renderOffice, officeRenderAvailable } from '../server/officeRender.mjs';
import { useBackend } from '../src/agent/store.js';
import * as ws from '../src/agent/workspace.js';
import { createPosterTool } from '../src/agent/posterTool.js';
import { composePosterLayout } from '../src/agent/posterComposition.js';
import { fixtureHtml, inspectImage } from './fixtures/poster-composition.mjs';
import { gradientBackgroundSvg, gradientSample, inspectGradient, inspectGradientPdf } from './fixtures/poster-gradient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'weiyang-poster-gradient'));
const store = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-gradient-store-'));
await fs.mkdir(output, { recursive: true });
await fs.rm(path.join(output, 'failure.json'), { force: true });
useBackend(createFileStore(store));
const checks = [];
const check = (label, pass, detail) => {
  checks.push({ label, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) });
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  assert.ok(pass, label + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
};
const saveJson = (file, value) => fs.writeFile(path.join(output, file), JSON.stringify(value, null, 2));
const imageUrl = value => `data:image/png;base64,${Buffer.from(value).toString('base64')}`;
const digest = value => createHash('sha256').update(value).digest('hex');
const layout = composePosterLayout(gradientSample);
const rows = layout.blocks.flatMap(block => block.rows);
const server = await createServer({
  root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'poster-gradient-fixture', configureServer(vite) {
    vite.middlewares.use('/__poster-gradient.html', (_req, res) => {
      res.setHeader('Content-Type', 'text/html;charset=utf-8');
      res.end(fixtureHtml);
    });
  } }]
});
let browser, modelCalls = 0;

async function screenshot(page, url, filename, description) {
  await page.evaluate(async ({ url, description }) => {
    const preview = document.querySelector('#preview');
    preview.src = url;
    await preview.decode();
    document.querySelector('#description').textContent = description;
  }, { url, description });
  await page.screenshot({ path: path.join(output, filename), fullPage: true });
}

async function verifyGradientPixels(page, label, url, mid = null) {
  const pixels = await page.evaluate(inspectGradient, {
    imageUrl: url, width: gradientSample.width, height: gradientSample.height,
    start: layout.panel.y, opacity: gradientSample.gradient_opacity, mid
  });
  await saveJson(`${label}-gradient-pixels.json`, pixels);
  check(`${label}：真实1080×1440画幅`, pixels.width === 1080 && pixels.height === 1440, pixels);
  check(`${label}：渐变上方保留原底图像素`, pixels.aboveChanges === 0, pixels.aboveChanges);
  check(`${label}：渐变起点与内部无硬色块接缝`, pixels.maxStep <= 3 && pixels.maxBrightening <= 1, pixels);
  check(`${label}：连续渐变至少100个实际颜色级`, pixels.colorLevels >= 100, pixels.colorLevels);
  check(`${label}：透明到0.85端点与逐像素插值正确`, pixels.maxFormulaError <= 5, pixels.maxFormulaError);
  return pixels;
}

async function verifyTextPixels(page, label, url, svg, reference) {
  const pixels = await page.evaluate(inspectImage, { imageUrl: url, svg, rows, width: 1080, height: 1440 });
  await saveJson(`${label}-text-pixels.json`, pixels);
  check(`${label}：每一行中文真实着墨`, pixels.rowPixels.every(row => row.ink > 40 && row.ink > row.referenceInk * 0.65), pixels.rowPixels);
  check(`${label}：全文字形没有大幅错位`, pixels.rowPixels.every((row, index) => reference
    ? Math.abs(row.bounds.y - reference.rowPixels[index].bounds.y) <= 12
    : row.mismatch < 0.4), pixels.rowPixels);
  check(`${label}：SVG全文不删不改`, pixels.textBounds.map(row => row.text).join('') === rows.map(row => row.text).join(''));
  check(`${label}：底图与渐变整体一致`, pixels.differentRatio < 0.035, pixels.differentRatio);
  return pixels;
}

async function createNodeProduct(page, background) {
  // 2026-11-12 复审：渐变先渲无字版（文字全透明）量真实像素对比度；成品（带字）仍只渲一次
  let renders = 0, measures = 0;
  const tool = createPosterTool({
    renderVisualScene: async (...args) => { if (String(args[0]).includes('<g opacity="0"><text')) measures++; else renders++; return renderVisualScene(...args); },
    renderPoster: async () => { throw new Error('渐变不得进入旧实色SVG渲染器'); },
    imageGen: async () => { modelCalls++; throw new Error('合成底图不应调用图片模型'); }
  });
  const input = { ...gradientSample, background_path: '底图/合成渐变验收.png', path: '海报/沉浸渐变.png' };
  const receipt = JSON.parse(await tool.run(input));
  await saveJson('node-receipt.json', receipt);
  check('Node工具真实交付PNG/SVG/PPTX且字体通过', receipt.status === 'complete' && receipt.fontCheck === 'passed' && receipt.files.length === 3, receipt);
  check('渐变只走受控视觉渲染器且未重复渲染', renders === 1);
  check('按真实像素量了对比度（无字版测量1～4次）且回执写明结果', measures >= 1 && measures <= 4 && ['passed', 'failed'].includes(receipt.gradient?.contrast), receipt.gradient);
  // 2026-11-12 复审：对比度改为按真实像素实测，结论必须带每块文字的实测数值；整体视觉仍未验收
  check('回执保留视觉未验收而非承诺底图对比', receipt.visual === 'not_checked' && receipt.gradient?.contrast === 'passed'
    && receipt.gradient.measured?.length >= 2 && receipt.gradient.measured.every(item => item.contrast >= item.minimum), receipt);
  const files = {};
  for (const file of receipt.files) {
    files[file.format] = await ws.readBlob(file.path);
    await fs.writeFile(path.join(output, `node.${file.format}`), new Uint8Array(await files[file.format].arrayBuffer()));
  }
  const design = JSON.parse(await ws.readText(receipt.designPath));
  await saveJson('node.poster.json', design);
  check('设计稿保存渐变、居中、透明度及底图指纹', design.options.text_style === 'gradient' && design.options.text_align === 'center' && design.options.gradient_opacity === 0.85 && design.backgroundHash === digest(background), design.options);
  const svg = await files.svg.text();
  const documentSvg = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const gradient = documentSvg.getElementsByTagName('linearGradient')[0];
  const stops = Array.from(gradient?.getElementsByTagName('stop') || []);
  const gradientRect = Array.from(documentSvg.getElementsByTagName('rect')).find(rect => rect.getAttribute('fill') === 'url(#poster-text-gradient)');
  // 2026-11-12 复审：实测对比不足时在标题高度多一个中间色标；仍须首尾为0→0.85、不透明度不递减、中间色标与回执一致
  const svgOpacity = stops.map(stop => Number(stop.getAttribute('stop-opacity')));
  const boosted = receipt.gradient?.boosted;
  check('SVG使用原生连续透明渐变', gradient?.getAttribute('y2') === '1' && stops.length === (boosted ? 3 : 2) && stops[0].getAttribute('stop-opacity') === '0' && stops.at(-1).getAttribute('stop-opacity') === '0.85'
    && svgOpacity.every((value, index) => !index || value >= svgOpacity[index - 1])
    && (!boosted || Number(stops[1].getAttribute('offset')) === boosted.offset && svgOpacity[1] === boosted.opacity), svgOpacity);
  check('默认渐变严格位于底部35%', Math.abs(layout.panel.y - 936) < 1e-8 && Math.abs(layout.panel.h - 504) < 1e-8 && layout.blocks.every(block => block.align === 'center'), layout.panel);
  check('实际SVG渐变区使用精确936起点和504像素高度', gradientRect?.getAttribute('x') === '0' && gradientRect.getAttribute('y') === '936' && gradientRect.getAttribute('width') === '1080' && gradientRect.getAttribute('height') === '504');
  const pixels = await verifyTextPixels(page, 'node', imageUrl(await files.png.arrayBuffer()), svg);
  await verifyGradientPixels(page, 'node', imageUrl(await files.png.arrayBuffer()), receipt.gradient?.boosted);
  await screenshot(page, imageUrl(await files.png.arrayBuffer()), 'node-screen.png', '1080×1440真实Node渐变PNG；中文程序排字，原创合成底图');
  return { input, files, svg, receipt, pixels };
}

async function verifyBrowserProduct(page, product, background) {
  const result = await page.evaluate(async ({ input, background }) => {
    const { createPosterTool } = await import('/src/agent/posterTool.js');
    const workspace = await import('/src/agent/workspace.js');
    await workspace.write(input.background_path, new Blob([Uint8Array.from(atob(background), char => char.charCodeAt(0))], { type: 'image/png' }));
    const receipt = JSON.parse(await createPosterTool().run({ ...input, path: '浏览器/沉浸渐变.png' }));
    const png = receipt.files.find(file => file.format === 'png'), svg = receipt.files.find(file => file.format === 'svg');
    if (!png || !svg) return { receipt };
    const bytes = new Uint8Array(await (await workspace.readBlob(png.path)).arrayBuffer());
    let binary = '';
    for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
    return { receipt, png: btoa(binary), svg: await workspace.readText(svg.path) };
  }, { input: product.input, background: background.toString('base64') });
  await saveJson('browser-receipt.json', result.receipt);
  check('浏览器真实渲染与字体检查通过', result.receipt.status === 'complete' && result.receipt.fontCheck === 'passed', result.receipt);
  check('浏览器与Node消费完全相同的SVG设计', result.svg === product.svg);
  const bytes = Buffer.from(result.png, 'base64');
  await fs.writeFile(path.join(output, 'browser.png'), bytes);
  await verifyGradientPixels(page, 'browser', imageUrl(bytes), result.receipt.gradient?.boosted);
  await verifyTextPixels(page, 'browser', imageUrl(bytes), product.svg);
  await screenshot(page, imageUrl(bytes), 'browser-screen.png', '1080×1440真实浏览器渐变PNG；同SVG设计，不是截图放大');
}

async function verifyOfficeProduct(page, product) {
  const zip = await JSZip.loadAsync(await product.files.pptx.arrayBuffer());
  const slide = new DOMParser().parseFromString(await zip.file('ppt/slides/slide1.xml').async('string'), 'application/xml');
  const shapes = Array.from(slide.getElementsByTagName('p:sp'));
  const gradient = shapes.find(shape => shape.getElementsByTagName('p:cNvPr')[0]?.getAttribute('name') === 'poster-text-gradient');
  const stops = Array.from(gradient?.getElementsByTagName('a:gs') || []);
  // 2026-11-12 复审：与SVG同一组色标（可能多一个标题高度的中间色标）
  const boosted = product.receipt.gradient?.boosted;
  const alphas = stops.map(stop => Number(stop.getElementsByTagName('a:alpha')[0]?.getAttribute('val')));
  check('PPTX渐变为原生透明度而非截图/硬色块', stops.length === (boosted ? 3 : 2) && stops[0].getAttribute('pos') === '0' && stops.at(-1).getAttribute('pos') === '100000' && alphas[0] === 0 && alphas.at(-1) === 85000
    && alphas.every((value, index) => !index || value >= alphas[index - 1])
    && (!boosted || Number(stops[1].getAttribute('pos')) === Math.round(boosted.offset * 100000) && alphas[1] === Math.round(boosted.opacity * 100000)), alphas);
  const textShapes = shapes.filter(shape => shape.getElementsByTagName('a:t').length);
  check('PPTX每行文字独立可编辑', textShapes.length === rows.length && textShapes.map(shape => Array.from(shape.getElementsByTagName('a:t')).map(node => node.textContent).join('')).join('') === rows.map(row => row.text).join(''));
  check('LibreOffice真实转换能力可用', await officeRenderAvailable());
  const rendered = await renderOffice(product.files.pptx, 'pptx');
  check('PPTX真实转换为PDF', rendered.available && rendered.blob?.size > 1000);
  const bytes = new Uint8Array(await rendered.blob.arrayBuffer());
  await fs.writeFile(path.join(output, 'office.pdf'), bytes);
  const result = await page.evaluate(inspectGradientPdf, { bytes: [...bytes], width: 1080 });
  await saveJson('office.json', { ...result, png: undefined });
  await fs.writeFile(path.join(output, 'office.png'), Buffer.from(result.png.split(',')[1], 'base64'));
  check('Office输出单页原画幅', result.pages === 1 && result.width === 1080 && result.height === 1440, result.points);
  for (const text of [gradientSample.title, gradientSample.subtitle, ...gradientSample.lines, gradientSample.footer])
    check(`Office保留可抽取全文：${text}`, result.text.replace(/\s/g, '').includes(text.replace(/\s/g, '')));
  await verifyGradientPixels(page, 'office', result.png, product.receipt.gradient?.boosted);
  await verifyTextPixels(page, 'office', result.png, product.svg, product.pixels);
  await screenshot(page, result.png, 'office-screen.png', '真实LibreOffice：原生透明渐变PPTX → PDF，全文可抽取');
}

try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const external = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https?:\/\//, route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.goto(`${base}/__poster-gradient.html`);
  const encoded = await page.evaluate(async svg => {
    const img = new Image();
    img.src = `data:image/svg+xml;base64,${btoa(svg)}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  }, gradientBackgroundSvg);
  const background = Buffer.from(encoded, 'base64');
  await fs.writeFile(path.join(output, 'synthetic-background.png'), background);
  await ws.write('底图/合成渐变验收.png', new Blob([background], { type: 'image/png' }));
  const product = await createNodeProduct(page, background);
  await verifyBrowserProduct(page, product, background);
  await verifyOfficeProduct(page, product);
  check('底图原字节保持且没有付费模型调用', digest(Buffer.from(await (await ws.readBlob('底图/合成渐变验收.png')).arrayBuffer())) === digest(background) && modelCalls === 0);
  check('没有外部请求或页面脚本异常', external.length === 0 && errors.length === 0, { external, errors });
  console.log(`沉浸渐变 ${checks.length}/${checks.length} 通过；合成底图，无收费模型；用户真机未测。产物：${output}`);
} catch (error) {
  await saveJson('failure.json', { message: error.message, stack: error.stack });
  console.error(error);
  process.exitCode = 1;
} finally {
  await saveJson('checks.json', { checks, passed: checks.filter(item => item.pass).length, total: checks.length, modelCalls, syntheticBackground: true, realDevice: false });
  await browser?.close();
  await server.close();
  useBackend(null);
  await fs.rm(store, { recursive: true, force: true });
}
